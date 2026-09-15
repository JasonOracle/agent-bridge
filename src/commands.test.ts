/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加 status/resolve 命令单测; 2. 构造 maxRetry=1 验证 human 与 skip 两种熔断策略]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { getStatus, resolveNeedsHuman } from './commands.js';
import { writeBridge, readBridge, BridgeState } from './state.js';
import { runReviewHalf } from './pipeline.js';
import { BridgeConfig } from './config.js';

describe('命令与熔断策略 (src/commands.ts)', () => {
  let tmpDir: string;
  let bridgeFile: string;
  let implFile: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cmds-test-'));
    bridgeFile = path.join(tmpDir, 'bridge.md');
    implFile = path.join(tmpDir, 'docs', 'impl.md');
    configFile = path.join(tmpDir, '.bridge.config.json');

    execSync('git init', { cwd: tmpDir });
    execSync('git config user.name "Tester"', { cwd: tmpDir });
    execSync('git config user.email "tester@test.com"', { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'prompts'), { recursive: true });

    const implContent = `# 任务列表
- [ ] T1: 第一个任务
- [ ] T2: 第二个任务
`;
    fs.writeFileSync(implFile, implContent, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'prd.md'), '# PRD', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'tech.md'), '# TECH', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'test.md'), '# TEST', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'supervisor.md'), '# S', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'builder.md'), '# B', 'utf-8');

    // 初始空提交
    execSync('git add -A && git commit -m "chore: init"', { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. getStatus：正确返回状态、任务完成度及日志列表', () => {
    const state: BridgeState = {
      status: 'PENDING_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, state);

    const config = {
      supervisor: { mode: 'watch' },
      builder: { mode: 'watch' },
      docs: { impl: 'docs/impl.md' },
    };
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf-8');

    const status = getStatus(configFile, tmpDir);
    expect(status.state.status).toBe('PENDING_DEV');
    expect(status.progress.total).toBe(2);
    expect(status.progress.done).toBe(0);
    expect(status.progress.skipped).toBe(0);
  });

  it('2. resolveNeedsHuman：普通恢复重试清零，--skip 标记跳过并前进', () => {
    const humanState: BridgeState = {
      status: 'NEEDS_HUMAN',
      task_id: 'T1',
      round: 2,
      retry: 5,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, humanState);

    const config = {
      supervisor: { mode: 'watch' },
      builder: { mode: 'watch' },
      docs: { impl: 'docs/impl.md' },
    };
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf-8');

    // 1. 普通恢复
    const recovered = resolveNeedsHuman({ configPath: configFile, skip: false, cwd: tmpDir });
    expect(recovered.status).toBe('PENDING_DEV');
    expect(recovered.retry).toBe(0);

    // 将状态重新置为 NEEDS_HUMAN 测试 --skip
    writeBridge(bridgeFile, humanState);
    const skippedState = resolveNeedsHuman({ configPath: configFile, skip: true, cwd: tmpDir });
    expect(skippedState.status).toBe('PENDING_DEV');
    expect(skippedState.task_id).toBe('T2'); // 前进到 T2

    const implContent = fs.readFileSync(implFile, 'utf-8');
    expect(implContent).toContain('- [-] T1:'); // 标记为跳过
  });

  it('3. 熔断机制：maxRetry=1 时打回，onMaxRetry=human 停在 NEEDS_HUMAN', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'bad code');
    execSync('git add -A && git commit -m "[bridge] T1: bad code"', { cwd: tmpDir });

    const state: BridgeState = {
      status: 'PENDING_REVIEW',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, state);

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: 'docs/prd.md', tech: 'docs/tech.md', impl: 'docs/impl.md', test: 'docs/test.md' },
      roles: { supervisor: 'agents/supervisor.md', builder: 'agents/builder.md' },
      checks: ['node -v'],
      checkTimeoutMin: 1,
      pollIntervalSec: 1,
      maxRetryPerTask: 1, // 最多 1 次重试
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    // 模拟监工打回
    await runReviewHalf({
      config,
      cwd: tmpDir,
      mockVerdict: {
        verdict: 'reject',
        task_id: 'T1',
        round: 1,
        summary: '格式不达标',
        issues: [{ severity: 'blocker', desc: '不合格' }],
        next_instructions: '请重构',
      },
    });

    const { state: finalState } = readBridge(bridgeFile);
    expect(finalState.status).toBe('NEEDS_HUMAN');
    expect(finalState.retry).toBe(1);
  });

  it('4. 熔断机制：maxRetry=1 时打回，onMaxRetry=skip 标记跳过并前进到 T2', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code2.ts'), 'bad code');
    execSync('git add -A && git commit -m "[bridge] T1: bad code 2"', { cwd: tmpDir });

    const state: BridgeState = {
      status: 'PENDING_REVIEW',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, state);

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: 'docs/prd.md', tech: 'docs/tech.md', impl: 'docs/impl.md', test: 'docs/test.md' },
      roles: { supervisor: 'agents/supervisor.md', builder: 'agents/builder.md' },
      checks: ['node -v'],
      checkTimeoutMin: 1,
      pollIntervalSec: 1,
      maxRetryPerTask: 1,
      onMaxRetry: 'skip', // 超限自动跳过
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    await runReviewHalf({
      config,
      cwd: tmpDir,
      mockVerdict: {
        verdict: 'reject',
        task_id: 'T1',
        round: 1,
        summary: '严重错误',
        issues: [{ severity: 'blocker', desc: '致命问题' }],
        next_instructions: '放弃',
      },
    });

    const { state: finalState } = readBridge(bridgeFile);
    expect(finalState.status).toBe('PENDING_DEV');
    expect(finalState.task_id).toBe('T2');

    const implContent = fs.readFileSync(implFile, 'utf-8');
    expect(implContent).toContain('- [-] T1:'); // 任务 1 被标记跳过
  });
});
