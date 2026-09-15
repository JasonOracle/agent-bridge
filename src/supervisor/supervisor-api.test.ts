/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加监工 API 模块单测：Mock HTTP 请求测试 Claude/OpenAI Provider、非法输出重问机制与 Token 统计]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewWithApi } from './api.js';
import { BridgeConfig } from '../config.js';
import { readInternalState } from '../logger.js';

describe('监工 Mode API 模块 (src/supervisor/api.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-api-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. OpenAI Provider：正常通过裁决并统计 Token', async () => {
    const mockVerdict = {
      verdict: 'approve',
      task_id: 'T1',
      summary: '代码规范，测试全绿',
      issues: [],
      next_instructions: '',
    };

    const customFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(mockVerdict),
              },
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 50,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const config: BridgeConfig = {
      supervisor: {
        mode: 'api',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        maxTokens: 4096,
        timeoutMin: 5,
      },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 5,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    const verdict = await reviewWithApi({
      config,
      requestMd: 'test request',
      expectedTaskId: 'T1',
      currentRound: 1,
      fetch: customFetch,
      baseDir: tmpDir,
    });

    expect(verdict.verdict).toBe('approve');
    expect(verdict.task_id).toBe('T1');
    expect(verdict.summary).toContain('代码规范');

    // 检查 Token 统计累加至 state.json
    const state = readInternalState(tmpDir);
    expect(state.totalTokens.input).toBe(150);
    expect(state.totalTokens.output).toBe(50);
  });

  it('2. 非法 JSON 输出触发重问一次机制并成功解析', async () => {
    let callCount = 0;
    const validVerdict = {
      verdict: 'reject',
      task_id: 'T2',
      summary: '缺少异常处理',
      issues: [{ severity: 'major', desc: '缺少 try/catch' }],
      next_instructions: '请在 src/index.ts 第 15 行补充异常捕获',
    };

    const customFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // 第一次返回破坏性格式的错误内容
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '这不是合法的 json 内容' } }],
            usage: { prompt_tokens: 50, completion_tokens: 20 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        // 重问时返回规范格式
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(validVerdict) } }],
            usage: { prompt_tokens: 100, completion_tokens: 60 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    };

    const config: BridgeConfig = {
      supervisor: {
        mode: 'api',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        maxTokens: 4096,
        timeoutMin: 5,
      },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 5,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    const verdict = await reviewWithApi({
      config,
      requestMd: 'test request',
      expectedTaskId: 'T2',
      currentRound: 2,
      fetch: customFetch,
      baseDir: tmpDir,
    });

    expect(callCount).toBe(2); // 验证确已触发第二次重问
    expect(verdict.verdict).toBe('reject');
    expect(verdict.next_instructions).toContain('补充异常捕获');
  });

  it('3. 两次均输出非法内容时最终抛出错误', async () => {
    const customFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '永远无效的输出' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const config: BridgeConfig = {
      supervisor: {
        mode: 'api',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        maxTokens: 4096,
        timeoutMin: 5,
      },
      builder: { mode: 'watch', timeoutMin: 45 },
      docs: { prd: '', tech: '', impl: '', test: '' },
      roles: { supervisor: '', builder: '' },
      checks: [],
      checkTimeoutMin: 5,
      pollIntervalSec: 5,
      maxRetryPerTask: 3,
      onMaxRetry: 'human',
      onError: 'retry',
      maxDiffKB: 64,
      staleThresholdMin: 0,
    };

    await expect(
      reviewWithApi({
        config,
        requestMd: 'test request',
        expectedTaskId: 'T1',
        currentRound: 1,
        fetch: customFetch,
        baseDir: tmpDir,
      })
    ).rejects.toThrowError(/JSON 解析失败/);
  });
});
