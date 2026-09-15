/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现施工 Mode B 的等待状态翻转逻辑; 2. 超时未翻转返回失败]
 */

import path from 'node:path';
import { readBridge } from '../state.js';

export interface BuilderWatchOptions {
  timeoutMin: number;
  pollIntervalSec?: number;
  cwd?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBuilderReview(
  options: BuilderWatchOptions
): Promise<{ success: boolean; error?: string }> {
  const cwd = options.cwd ?? process.cwd();
  const bridgeFile = path.join(cwd, 'bridge.md');
  const intervalMs = (options.pollIntervalSec ?? 5) * 1000;
  const timeoutMs = options.timeoutMin * 60 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const { state } = readBridge(bridgeFile);
    if (state.status === 'PENDING_REVIEW') {
      return { success: true };
    }
    await sleep(intervalMs);
  }

  return {
    success: false,
    error: `等待 IDE 施工方收工超时（>${options.timeoutMin}m），未检测到 PENDING_REVIEW 翻转`,
  };
}
