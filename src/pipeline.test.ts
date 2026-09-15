/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加流水线测试：测试任务打勾标记、跳过标记、验收半循环推进与日志留档]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  markTaskCompletedInImpl,
  markTaskSkippedInImpl,
  findNextPendingTask,
  runReviewHalf,
} from './pipeline.js';
import { readBridge, writeBridge, BridgeState } from './state.js';
import { BridgeConfig } from './config.js';
import { getLogsDirPath } from './logger.js';

describe('流水线编排模块 (src/pipeline.ts)', () => {
  let tmpDir: string;
  let implPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pipeline-test-'));

    // 初始化测试 git 仓库
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.name "Tester"', { cwd: tmpDir });
    execSync('git config user.email "tester@test.com"', { cwd: tmpDir });

    implPath = path.join(tmpDir, 'docs', 'impl.md');
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'prompts'), { recursive: true });

    const implContent = `# 任务清单
- [ ] T1: 初始任务
  - 验收: 命令可用
- [ ] T2: 第二个任务
  - 验收: 测试全绿
`;
    fs.writeFileSync(implPath, implContent, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'prd.md'), '# PRD', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'tech.md'), '# TECH', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'test.md'), '# TEST', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'supervisor.md'), '# SUPERVISOR', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'builder.md'), '# BUILDER', 'utf-8');

    // 初始提交
    execSync('git add -A && git commit -m "chore: init"', { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. 任务打勾与任务推进', () => {
    const res = markTaskCompletedInImpl(implPath, 'T1');
    expect(res.hasMoreTasks).toBe(true);
    expect(res.nextTaskId).toBe('T2');

    const content = fs.readFileSync(implPath, 'utf-8');
    expect(content).toContain('- [x] T1:');
    expect(content).toContain('- [ ] T2:');

    // 继续完成 T2
    const res2 = markTaskCompletedInImpl(implPath, 'T2');
    expect(res2.hasMoreTasks).toBe(false);
    expect(res2.nextTaskId).toBeNull();
  });

  it('2. 任务标记跳过 (- [-])', () => {
    const res = markTaskSkippedInImpl(implPath, 'T1');
    expect(res.hasMoreTasks).toBe(true);
    expect(res.nextTaskId).toBe('T2');

    const content = fs.readFileSync(implPath, 'utf-8');
    expect(content).toContain('- [-] T1:');
  });

  it('3. 完整走通验收半循环 (PENDING_REVIEW -> approve -> 任务打勾并下发新任务与日志落盘)', async () => {
    // 施工提交代码
    fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const a = 1;');
    execSync('git add -A && git commit -m "[bridge] T1: add feature"', { cwd: tmpDir });

    const bridgeFile = path.join(tmpDir, 'bridge.md');
    const initialState: BridgeState = {
      status: 'PENDING_REVIEW',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, initialState);

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: 'docs/prd.md', tech: 'docs/tech.md', impl: 'docs/impl.md', test: 'docs/test.md' },
      roles: { supervisor: 'agents/supervisor.md', builder: 'agents/builder.md' },
      checks: ['node -v'], // 简单的 checks 确保成功
      checkTimeoutMin: 1,
      pollIntervalSec: 1,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    await runReviewHalf({
      config,
      cwd: tmpDir,
      mockVerdict: {
        verdict: 'approve',
        task_id: 'T1',
        round: 1,
        summary: '单测模拟验收通过',
        issues: [],
        next_instructions: '',
      },
    });

    // 验证 bridge.md 状态已前进至 PENDING_DEV 且 task_id 为 T2
    const bridgeResult = readBridge(bridgeFile);
    expect(bridgeResult.state.status).toBe('PENDING_DEV');
    expect(bridgeResult.state.task_id).toBe('T2');
    expect(bridgeResult.state.round).toBe(2);

    // 验证 impl.md 中 T1 已打勾
    const implContent = fs.readFileSync(implPath, 'utf-8');
    expect(implContent).toContain('- [x] T1:');

    // 验证审计日志已落盘
    const logsDir = getLogsDirPath(tmpDir);
    expect(fs.existsSync(logsDir)).toBe(true);
    const files = fs.readdirSync(logsDir);
    expect(files.some((f) => f.includes('T1-r1-approve.md'))).toBe(true);
  });
});
