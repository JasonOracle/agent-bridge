/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现监工 Mode CLI 的 spawn 无头调用与 {promptFile} 传参; 2. 进程退出后复用 watch 逻辑消费 verdict.json]
 */

import path from 'node:path';
import fs from 'node:fs';
import { BridgeConfig } from '../config.js';
import { run } from '../executor.js';
import { createPromptFile, removePromptFile } from '../context.js';
import { pollVerdict } from './watch.js';
import { Verdict } from './types.js';

export interface SupervisorCliOptions {
  config: BridgeConfig;
  requestMdPath: string;
  expectedTaskId: string;
  currentRound: number;
  cwd?: string;
}

export async function runSupervisorCli(options: SupervisorCliOptions): Promise<Verdict> {
  const cwd = options.cwd ?? process.cwd();
  const cliConfig = options.config.supervisor.cli;
  if (!cliConfig || !cliConfig.command) {
    throw new Error('未配置 supervisor.cli.command');
  }

  const promptContent = `你是自动化流水线中的监工（CTO）。
请仔细审查评审材料文件：${options.requestMdPath}
并按照 Verdict Schema 规范，将最终评审 JSON 写入 .bridge/verdict.json 文件中。不要输出任何解释说明。`;

  const promptFile = createPromptFile(promptContent, 'supervisor-prompt', cwd);

  try {
    const rawArgs = cliConfig.args ?? ['-p', '{promptFile}'];
    const args = rawArgs.map((arg) => {
      if (arg === '{promptFile}') return promptFile;
      if (arg === '{prompt}') return promptContent;
      return arg;
    });

    const timeoutMs = options.config.supervisor.timeoutMin * 60 * 1000;
    const res = await run([cliConfig.command, ...args], {
      cwd,
      timeoutMs,
      shell: process.platform === 'win32',
    });

    if (res.timedOut) {
      throw new Error(`监工 CLI 进程执行超时（>${options.config.supervisor.timeoutMin}m）被强制终止`);
    }

    // 进程退出后，调用 pollVerdict 获取并消费 verdict.json
    return await pollVerdict({
      verdictPath: path.resolve(cwd, '.bridge/verdict.json'),
      logsDir: path.resolve(cwd, '.bridge/logs'),
      pollIntervalSec: 1,
      timeoutMin: 1, // 进程已退出，等待 verdict.json 落盘的短暂超时
      expectedTaskId: options.expectedTaskId,
      currentRound: options.currentRound,
      onReprompt: (reason) => {
        // 重问时把错误原因追加进 review-request.md
        const reqPath = path.resolve(cwd, options.requestMdPath);
        if (fs.existsSync(reqPath)) {
          fs.appendFileSync(
            reqPath,
            `\n\n【系统纠错重问】：上一轮 verdict.json 校验失败: ${reason}。请重新修正并写回！\n`,
            'utf-8'
          );
        }
      },
    });
  } finally {
    removePromptFile(promptFile);
  }
}
