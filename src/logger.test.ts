/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加审计日志模块单测：测试 state.json 内部状态读写、token 累加与各类日志文件名及字段规范]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readInternalState,
  writeInternalState,
  addTokens,
  updateLastApprovedCommit,
  saveReviewAuditLog,
  saveDevErrorLog,
} from './logger.js';

describe('审计日志模块 (src/logger.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-logger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. state.json 读写与默认状态初始化', () => {
    const state = readInternalState(tmpDir);
    expect(state.lastApprovedCommit).toBeNull();
    expect(state.totalTokens.input).toBe(0);
    expect(state.totalTokens.output).toBe(0);
    expect(state.startedAt).toBeDefined();

    updateLastApprovedCommit('commit_123456', tmpDir);
    const updated = readInternalState(tmpDir);
    expect(updated.lastApprovedCommit).toBe('commit_123456');

    addTokens(100, 200, tmpDir);
    const afterTokens = readInternalState(tmpDir);
    expect(afterTokens.totalTokens.input).toBe(100);
    expect(afterTokens.totalTokens.output).toBe(200);
  });

  it('2. saveReviewAuditLog 按照规范生成 T{taskId}-r{round}-{verdict}.md', () => {
    const logPath = saveReviewAuditLog(
      {
        taskId: 'T2',
        round: 3,
        verdict: 'approve',
        diffFull: 'diff --git a/file b/file\n+code',
        checksOutput: 'PASS src/test.ts',
        supervisorRawOutput: '{"verdict":"approve","task_id":"T2"}',
        parsedVerdict: { verdict: 'approve', task_id: 'T2' },
      },
      tmpDir
    );

    expect(path.basename(logPath)).toBe('T2-r3-approve.md');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('T2');
    expect(content).toContain('Round 3');
    expect(content).toContain('APPROVE');
    expect(content).toContain('diff --git a/file b/file');
    expect(content).toContain('PASS src/test.ts');
  });

  it('3. saveDevErrorLog 按照规范生成 T{id}-r{round}-dev-error.md', () => {
    const logPath = saveDevErrorLog(
      {
        taskId: 'T1',
        round: 1,
        error: 'Child process timed out after 45m',
      },
      tmpDir
    );

    expect(path.basename(logPath)).toBe('T1-r1-dev-error.md');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('T1');
    expect(content).toContain('Child process timed out');
  });
});
