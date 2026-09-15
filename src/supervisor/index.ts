/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 统一封装 getVerdict 入口，按照 api | cli | watch 三种模式进行分发调度]
 */

import path from 'node:path';
import fs from 'node:fs';
import { BridgeConfig } from '../config.js';
import { Verdict } from './types.js';
import { reviewWithApi } from './api.js';
import { runSupervisorCli } from './cli.js';
import { pollVerdict } from './watch.js';

export interface GetVerdictOptions {
  config: BridgeConfig;
  requestMd: string;
  requestMdPath: string;
  expectedTaskId: string;
  currentRound: number;
  cwd?: string;
}

export async function getVerdict(options: GetVerdictOptions): Promise<Verdict> {
  const mode = options.config.supervisor.mode;
  const cwd = options.cwd ?? process.cwd();

  switch (mode) {
    case 'api':
      return await reviewWithApi({
        config: options.config,
        requestMd: options.requestMd,
        expectedTaskId: options.expectedTaskId,
        currentRound: options.currentRound,
        baseDir: cwd,
      });

    case 'cli':
      return await runSupervisorCli({
        config: options.config,
        requestMdPath: options.requestMdPath,
        expectedTaskId: options.expectedTaskId,
        currentRound: options.currentRound,
        cwd,
      });

    case 'watch':
      return await pollVerdict({
        verdictPath: path.resolve(cwd, '.bridge/verdict.json'),
        logsDir: path.resolve(cwd, '.bridge/logs'),
        pollIntervalSec: options.config.pollIntervalSec,
        timeoutMin: options.config.supervisor.timeoutMin,
        expectedTaskId: options.expectedTaskId,
        currentRound: options.currentRound,
        onReprompt: (reason) => {
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
  }
}
