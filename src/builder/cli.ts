/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现施工 Mode A 的 spawn 执行与 {promptFile} 传参; 2. 检查子进程退出后 bridge.md 是否正确翻转为 PENDING_REVIEW]
 */

import path from 'node:path';
import { BridgeConfig } from '../config.js';
import { run } from '../executor.js';
import { createPromptFile, removePromptFile } from '../context.js';
import { readBridge } from '../state.js';
import { saveDevErrorLog } from '../logger.js';

export interface BuilderCliOptions {
  config: BridgeConfig;
  prompt: string;
  cwd?: string;
}

export async function runBuilderCli(
  options: BuilderCliOptions
): Promise<{ success: boolean; error?: string }> {
  const cwd = options.cwd ?? process.cwd();
  const builderConfig = options.config.builder;

  if (!builderConfig.command) {
    throw new Error('未配置 builder.command');
  }

  const promptFile = createPromptFile(options.prompt, 'builder-prompt', cwd);

  try {
    const rawArgs = builderConfig.args ?? ['-p', '{promptFile}'];
    const args = rawArgs.map((arg) => {
      if (arg === '{promptFile}') return promptFile;
      if (arg === '{prompt}') return options.prompt;
      return arg;
    });

    const timeoutMs = builderConfig.timeoutMin * 60 * 1000;
    const res = await run([builderConfig.command, ...args], {
      cwd,
      timeoutMs,
      shell: false,
    });

    const bridgeFile = path.join(cwd, 'bridge.md');
    const { state } = readBridge(bridgeFile);

    if (res.timedOut) {
      const errorMsg = `施工 CLI 执行超时（>${builderConfig.timeoutMin}m）被强制终止`;
      if (state.task_id) {
        saveDevErrorLog(
          {
            taskId: state.task_id,
            round: state.round,
            error: errorMsg,
          },
          cwd
        );
      }
      return { success: false, error: errorMsg };
    }

    if (state.status === 'PENDING_REVIEW') {
      return { success: true };
    }

    const unFlippedMsg = `施工 CLI 退出（code: ${res.code}），但未将 bridge.md 翻转为 PENDING_REVIEW（当前仍为 ${state.status}）`;
    if (state.task_id) {
      saveDevErrorLog(
        {
          taskId: state.task_id,
          round: state.round,
          error: unFlippedMsg,
        },
        cwd
      );
    }
    return { success: false, error: unFlippedMsg };
  } finally {
    removePromptFile(promptFile);
  }
}
