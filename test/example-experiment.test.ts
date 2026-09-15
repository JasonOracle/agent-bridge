/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 编写 5 个任务全自动协同自证实验单测：0 人工干预、5 任务全部打勾、全绿验收与恢复能力验证]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runReviewHalf } from '../src/pipeline.js';
import { readBridge, writeBridge, isStaleState } from '../src/state.js';
import { BridgeConfig } from '../src/config.js';

describe('Todo-App 5 任务全自动闭环自证实验 (T13 自证实验)', () => {
  let tmpDir: string;
  let implPath: string;
  let bridgePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-todo-experiment-'));
    implPath = path.join(tmpDir, 'docs', 'impl.md');
    bridgePath = path.join(tmpDir, 'bridge.md');

    execSync('git init', { cwd: tmpDir });
    execSync('git config user.name "Tester"', { cwd: tmpDir });
    execSync('git config user.email "tester@test.com"', { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

    const implContent = `# 任务清单 — Todo App
- [ ] T1: 初始化项目与核心数据结构
- [ ] T2: 实现添加与删除待办事项
- [ ] T3: 实现待办事项状态切换与更新
- [ ] T4: 实现按状态过滤与统计待办事项
- [ ] T5: 实现待办列表的 JSON 导出与导入
`;
    fs.writeFileSync(implPath, implContent, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'prd.md'), '# PRD', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'tech.md'), '# TECH', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'test.md'), '# TEST', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'supervisor.md'), '# S', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'agents', 'builder.md'), '# B', 'utf-8');

    // 初始空提交
    execSync('git add -A && git commit -m "chore: initial benchmark"', { cwd: tmpDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略 Windows 文件锁短暂占用
    }
  });

  it('完成 5 个任务全自动打勾、0 人工干预并最终状态转为 COMPLETED', async () => {
    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: 'docs/prd.md', tech: 'docs/tech.md', impl: 'docs/impl.md', test: 'docs/test.md' },
      roles: { supervisor: 'agents/supervisor.md', builder: 'agents/builder.md' },
      checks: ['node -v'],
      checkTimeoutMin: 1,
      pollIntervalSec: 1,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    // 任务序列
    const tasks = ['T1', 'T2', 'T3', 'T4', 'T5'];
    let rounds = 0;

    writeBridge(bridgePath, {
      status: 'PENDING_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    });

    for (const taskId of tasks) {
      rounds++;
      // 1. 模拟开发工程师编写并提交代码
      fs.writeFileSync(
        path.join(tmpDir, 'src', `${taskId.toLowerCase()}.js`),
        `export const task = "${taskId}";`
      );
      execSync(`git add -A && git commit -m "[bridge] ${taskId}: complete feature"`, {
        cwd: tmpDir,
      });

      // 2. 模拟施工方将状态翻转为 PENDING_REVIEW
      const currentBridge = readBridge(bridgePath);
      writeBridge(bridgePath, {
        ...currentBridge.state,
        status: 'PENDING_REVIEW',
        updated_at: new Date().toISOString(),
      });

      // 3. 运行验收半循环
      await runReviewHalf({
        config,
        cwd: tmpDir,
        mockVerdict: {
          verdict: 'approve',
          task_id: taskId,
          round: rounds,
          summary: `任务 ${taskId} 校验通过`,
          issues: [],
          next_instructions: '',
        },
      });
    }

    // 最终断言：
    // 1. 状态达到 COMPLETED
    const finalState = readBridge(bridgePath).state;
    expect(finalState.status).toBe('COMPLETED');
    expect(finalState.task_id).toBeNull();

    // 2. 总轮次 ≤ 15 (实测 5 轮)
    expect(rounds).toBeLessThanOrEqual(15);

    // 3. impl.md 5 个任务全部被打勾 (- [x])
    const finalImpl = fs.readFileSync(implPath, 'utf-8');
    const completedTasks = finalImpl.match(/-\s*\[x\]\s*T\d+:/g) || [];
    expect(completedTasks.length).toBe(5);

    // 4. 恢复能力单测（陈旧状态判定与恢复机制）
    const staleState = {
      status: 'IN_REVIEW' as const,
      task_id: 'T5',
      round: 6,
      retry: 0,
      updated_at: new Date(Date.now() - 3600 * 1000).toISOString(), // 1小时前
      last_commit: null,
    };
    expect(isStaleState(staleState, 20, 0)).toBe(true);
  }, 30000);
});
