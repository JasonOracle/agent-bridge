/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加监工 Mode CLI 与 Mode B 契约单测：使用假监工 node 脚本验证 spawn、落盘与原子消费]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSupervisorCli } from './cli.js';
import { pollVerdict } from './watch.js';
import { BridgeConfig } from '../config.js';

describe('监工 Mode CLI 与 Mode B 轮询 (src/supervisor/cli.ts & watch.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sup-cli-test-'));
    fs.mkdirSync(path.join(tmpDir, '.bridge'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. runSupervisorCli：通过 node 脚本假扮监工 CLI 写入 verdict.json 并成功消费', async () => {
    const fakeCliScript = path.join(tmpDir, 'fake-supervisor.cjs');
    const scriptContent = `
const fs = require('fs');
const path = require('path');
const verdictPath = path.resolve('.bridge', 'verdict.json');
const verdict = {
  verdict: 'approve',
  task_id: 'T1',
  round: 1,
  summary: '假监工脚本审查通过',
  issues: [],
  next_instructions: ''
};
fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2), 'utf-8');
`;
    fs.writeFileSync(fakeCliScript, scriptContent, 'utf-8');

    const config: BridgeConfig = {
      supervisor: {
        mode: 'cli',
        timeoutMin: 1,
        maxTokens: 8192,
        cli: {
          command: 'node',
          args: [fakeCliScript, '-p', '{promptFile}'],
        },
      },
      builder: { mode: 'watch', timeoutMin: 45 },
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

    const verdict = await runSupervisorCli({
      config,
      requestMdPath: '.bridge/review-request.md',
      expectedTaskId: 'T1',
      currentRound: 1,
      cwd: tmpDir,
    });

    expect(verdict.verdict).toBe('approve');
    expect(verdict.task_id).toBe('T1');
    expect(verdict.summary).toContain('假监工脚本审查通过');

    // 验证 .bridge/verdict.json 已被原子移动归档，原路径不再存在
    expect(fs.existsSync(path.join(tmpDir, '.bridge', 'verdict.json'))).toBe(false);
  });

  it('2. pollVerdict：过滤上一轮迟到的陈旧裁决 (round 不匹配)', async () => {
    const verdictPath = path.join(tmpDir, '.bridge', 'verdict.json');
    const staleVerdict = {
      verdict: 'approve',
      task_id: 'T1',
      round: 1, // 当前实际是 round 2
      summary: '上一轮迟到的裁决',
      issues: [],
      next_instructions: '',
    };
    fs.writeFileSync(verdictPath, JSON.stringify(staleVerdict), 'utf-8');

    // 延迟 200ms 后由外部覆盖写入 round=2 的裁决
    setTimeout(() => {
      const freshVerdict = {
        ...staleVerdict,
        round: 2,
        summary: '本轮最新裁决',
      };
      fs.writeFileSync(verdictPath, JSON.stringify(freshVerdict), 'utf-8');
    }, 200);

    const verdict = await pollVerdict({
      verdictPath,
      logsDir: path.join(tmpDir, '.bridge', 'logs'),
      pollIntervalSec: 0.1,
      timeoutMin: 0.1,
      expectedTaskId: 'T1',
      currentRound: 2,
    });

    expect(verdict.round).toBe(2);
    expect(verdict.summary).toBe('本轮最新裁决');
  });
});
