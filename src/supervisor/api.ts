/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 Claude 与 OpenAI 两大 Provider 的 API 监工审查; 2. 支持 baseURL、指数退避（429/5xx）、Token 统计与非法输出重问一次机制]
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { BridgeConfig } from '../config.js';
import { addTokens } from '../logger.js';
import { Verdict, VerdictSchema } from './types.js';

export interface ApiReviewOptions {
  requestMd: string;
  config: BridgeConfig;
  expectedTaskId: string;
  currentRound: number;
  systemPrompt?: string;
  fetch?: typeof fetch;
  baseDir?: string;
}

function cleanJsonResponse(raw: string): string {
  const trimmed = raw.trim();
  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return trimmed;
}

function parseAndValidateVerdict(rawText: string, expectedTaskId: string): Verdict {
  const cleaned = cleanJsonResponse(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON 解析失败: ${msg}`);
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Verdict 结构校验失败: ${issues}`);
  }

  const data = result.data;
  if (data.task_id !== expectedTaskId) {
    throw new Error(`task_id 不匹配: 预期 ${expectedTaskId}，实际得到 ${data.task_id}`);
  }

  if (data.verdict === 'reject' && !data.next_instructions.trim()) {
    throw new Error('Verdict 为 reject 时，next_instructions 必须提供具体修改意见，不能为空');
  }

  return data;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callProviderWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let attempt = 0;
  let delay = 1000;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const status = err?.status ?? err?.statusCode;
      const isRetryable = status === 429 || (status >= 500 && status < 600);

      if (attempt > maxRetries || !isRetryable) {
        throw err;
      }

      await sleep(delay);
      delay *= 2;
    }
  }
}

export async function reviewWithApi(options: ApiReviewOptions): Promise<Verdict> {
  const { config, requestMd, expectedTaskId, currentRound, fetch: customFetch, baseDir } = options;
  const provider = config.supervisor.provider ?? 'claude';
  const systemPrompt = options.systemPrompt ?? '你是本项目的架构师（CTO）。请根据评审材料，严格输出纯 JSON 格式的 Verdict 裁决。严禁输出任何 markdown 代码块包裹以外的废话。';

  let rawOutput = '';
  let inputTokens = 0;
  let outputTokens = 0;

  const doCall = async (userPrompt: string) => {
    if (provider === 'claude') {
      const client = new Anthropic({
        apiKey: config.supervisor.apiKey ?? '',
        fetch: customFetch as any,
      });

      const response = await callProviderWithRetry(() =>
        client.messages.create({
          model: config.supervisor.model ?? 'claude-sonnet-4-5',
          max_tokens: config.supervisor.maxTokens ?? 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        })
      );

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      const content = response.content[0];
      return content.type === 'text' ? content.text : '';
    } else {
      const client = new OpenAI({
        apiKey: config.supervisor.apiKey ?? '',
        baseURL: config.supervisor.baseURL,
        fetch: customFetch as any,
      });

      const response = await callProviderWithRetry(() =>
        client.chat.completions.create({
          model: config.supervisor.model ?? 'gpt-4o',
          max_tokens: config.supervisor.maxTokens ?? 8192,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        })
      );

      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;
      return response.choices[0]?.message?.content ?? '';
    }
  };

  // 第一次调用
  rawOutput = await doCall(requestMd);

  try {
    const verdict = parseAndValidateVerdict(rawOutput, expectedTaskId);
    verdict.round = currentRound;
    addTokens(inputTokens, outputTokens, baseDir);
    return verdict;
  } catch (firstErr: any) {
    // 触发重问一次机制
    const reprompt = `${requestMd}\n\n【系统纠错重问】：你上一轮输出未能通过格式校验，错误原因：${firstErr.message}。原始返回：${rawOutput.slice(0, 300)}。请严格按照 JSON Schema 修正并重新输出合法纯 JSON！`;
    rawOutput = await doCall(reprompt);

    const verdict = parseAndValidateVerdict(rawOutput, expectedTaskId);
    verdict.round = currentRound;
    addTokens(inputTokens, outputTokens, baseDir);
    return verdict;
  }
}
