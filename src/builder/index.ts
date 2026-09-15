/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 统一封装 runBuilder 入口，分发 Mode A CLI 与 Mode B Watch]
 */

import { BridgeConfig } from '../config.js';
import { runBuilderCli } from './cli.js';
import { waitForBuilderReview } from './watch.js';

export interface RunBuilderOptions {
  config: BridgeConfig;
  prompt: string;
  cwd?: string;
}

export async function runBuilder(
  options: RunBuilderOptions
): Promise<{ success: boolean; error?: string }> {
  const mode = options.config.builder.mode;
  if (mode === 'cli') {
    return await runBuilderCli({
      config: options.config,
      prompt: options.prompt,
      cwd: options.cwd,
    });
  } else {
    console.log('【Mode B 提示】：请确认 IDE 侧施工定时任务已注册（行动信号 = PENDING_DEV 或 IN_DEV）');
    return await waitForBuilderReview({
      timeoutMin: options.config.builder.timeoutMin,
      pollIntervalSec: options.config.pollIntervalSec,
      cwd: options.cwd,
    });
  }
}
