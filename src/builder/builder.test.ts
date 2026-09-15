/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加施工模块单测：假 CLI 收到 promptFile 后改状态、未翻转失败检测与超时强杀分支单测]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runBuilder } from './index.js';
import { BridgeConfig } from '../config.js';
import { writeBridge, readBridge, BridgeState } from '../state.js';

describe('施工 Mode A + Mode B 模块 (src/builder/*)', () => {
  let tmpDir: string;
  let bridgeFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-builder-test-'));
    bridgeFile = path.join(tmpDir, 'bridge.md');

    const initialState: BridgeState = {
      status: 'IN_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgeFile, initialState);
  });

  afterEach(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略短暂的文件锁
    }
  });

  it('1. 假 CLI 收到 promptFile 后翻转状态为 PENDING_REVIEW 成功', async () => {
    const fakeScript = path.join(tmpDir, 'fake-builder-success.cjs');
    const scriptCode = `
const fs = require('fs');
const path = require('path');

const bridgePath = path.resolve(process.cwd(), 'bridge.md');
const content = fs.readFileSync(bridgePath, 'utf-8');
const updated = content.replace('status: IN_DEV', 'status: PENDING_REVIEW');
fs.writeFileSync(bridgePath, updated, 'utf-8');
`;
    fs.writeFileSync(fakeScript, scriptCode, 'utf-8');

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: {
        mode: 'cli',
        command: 'node',
        args: [fakeScript, '-p', '{promptFile}'],
        timeoutMin: 1,
      },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 1,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    const res = await runBuilder({
      config,
      prompt: '请写代码',
      cwd: tmpDir,
    });

    expect(res.success).toBe(true);
    const { state } = readBridge(bridgeFile);
    expect(state.status).toBe('PENDING_REVIEW');
  });

  it('2. 施工 CLI 退出但未翻转状态时报错', async () => {
    const fakeScript = path.join(tmpDir, 'fake-builder-noflip.cjs');
    // 该脚本什么都不改直接退出
    fs.writeFileSync(fakeScript, 'console.log("No op");', 'utf-8');

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: {
        mode: 'cli',
        command: 'node',
        args: [fakeScript, '-p', '{promptFile}'],
        timeoutMin: 1,
      },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 1,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    const res = await runBuilder({
      config,
      prompt: '请写代码',
      cwd: tmpDir,
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('未将 bridge.md 翻转为 PENDING_REVIEW');
  });

  it('3. 施工 CLI 超时分支测试', async () => {
    const fakeScript = path.join(tmpDir, 'fake-builder-hang.cjs');
    fs.writeFileSync(fakeScript, 'setInterval(() => {}, 1000);', 'utf-8');

    const config: BridgeConfig = {
      supervisor: { mode: 'watch', timeoutMin: 20, maxTokens: 8192 },
      builder: {
        mode: 'cli',
        command: 'node',
        args: [fakeScript],
        timeoutMin: 0.005, // 约 300ms 超时
      },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 1,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    const res = await runBuilder({
      config,
      prompt: '挂起测试',
      cwd: tmpDir,
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('超时');
  }, 10000);
});
