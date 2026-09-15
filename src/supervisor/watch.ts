/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 verdict.json 轮询、3个tick容错读取与陈旧裁决过滤; 2. 校验通过后原子消费归档与重问机制]
 */

import fs from 'node:fs';
import path from 'node:path';
import { Verdict, VerdictSchema } from './types.js';

export interface PollVerdictOptions {
  verdictPath?: string;
  logsDir?: string;
  pollIntervalSec?: number;
  timeoutMin: number;
  expectedTaskId: string;
  currentRound: number;
  onReprompt?: (reason: string) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询收取 .bridge/verdict.json 并执行容错读取与原子归档
 */
export async function pollVerdict(options: PollVerdictOptions): Promise<Verdict> {
  const verdictPath = path.resolve(options.verdictPath ?? '.bridge/verdict.json');
  const logsDir = path.resolve(options.logsDir ?? '.bridge/logs');
  const intervalMs = (options.pollIntervalSec ?? 5) * 1000;
  const timeoutMs = options.timeoutMin * 60 * 1000;
  const startTime = Date.now();

  let graceTicks = 0;
  let hasReprompted = false;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(verdictPath)) {
      let content = '';
      try {
        content = fs.readFileSync(verdictPath, 'utf-8');
      } catch {
        // 读取冲突，宽限等待
        graceTicks++;
        if (graceTicks <= 3) {
          await sleep(intervalMs);
          continue;
        }
      }

      // 清除可能存在的 markdown 代码块包裹
      const trimmed = content.trim();
      const cleanJson = trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1').trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (err: unknown) {
        // 文件可能正在写入，宽限最多 3 个 tick
        graceTicks++;
        if (graceTicks <= 3) {
          await sleep(intervalMs);
          continue;
        }
        // 超过宽限期依然无法解析，触发非法判定
        const msg = err instanceof Error ? err.message : String(err);
        return await handleInvalidVerdict(`JSON 解析失败: ${msg}`, options, verdictPath, hasReprompted, () => {
          hasReprompted = true;
          graceTicks = 0;
        });
      }

      // Zod 结构校验
      const result = VerdictSchema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return await handleInvalidVerdict(`Verdict Schema 校验失败: ${issues}`, options, verdictPath, hasReprompted, () => {
          hasReprompted = true;
          graceTicks = 0;
        });
      }

      const verdict = result.data;

      // 陈旧判定：round 存在且 !== currentRound（上一轮迟到的裁决）
      if (verdict.round !== undefined && verdict.round !== options.currentRound) {
        // 不消费、不归档、继续等
        await sleep(intervalMs);
        continue;
      }

      // task_id 校验
      if (verdict.task_id !== options.expectedTaskId) {
        return await handleInvalidVerdict(
          `task_id 不匹配: 预期 ${options.expectedTaskId}，实际为 ${verdict.task_id}`,
          options,
          verdictPath,
          hasReprompted,
          () => {
            hasReprompted = true;
            graceTicks = 0;
          }
        );
      }

      // reject 时 next_instructions 必填
      if (verdict.verdict === 'reject' && !verdict.next_instructions.trim()) {
        return await handleInvalidVerdict(
          'Verdict 为 reject 时 next_instructions 必须提供具体指令',
          options,
          verdictPath,
          hasReprompted,
          () => {
            hasReprompted = true;
            graceTicks = 0;
          }
        );
      }

      // 校验全部通过，执行原子消费：rename 到 logs 目录
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const archiveTarget = path.join(
        logsDir,
        `verdict-${options.expectedTaskId}-r${options.currentRound}-${Date.now()}.json`
      );
      try {
        fs.renameSync(verdictPath, archiveTarget);
      } catch {
        fs.unlinkSync(verdictPath);
      }

      return verdict;
    }

    await sleep(intervalMs);
  }

  throw new Error(`监工裁决等待超时（>${options.timeoutMin}m）`);
}

async function handleInvalidVerdict(
  reason: string,
  options: PollVerdictOptions,
  verdictPath: string,
  hasReprompted: boolean,
  onReset: () => void
): Promise<Verdict> {
  // 删除当前非法文件以防重复读取
  try {
    if (fs.existsSync(verdictPath)) {
      fs.unlinkSync(verdictPath);
    }
  } catch {
    // 忽略
  }

  if (!hasReprompted && options.onReprompt) {
    onReset();
    await options.onReprompt(reason);
    // 重问后重新递归进入等待
    return pollVerdict({ ...options });
  }

  throw new Error(`监工输出非法裁决: ${reason}`);
}
