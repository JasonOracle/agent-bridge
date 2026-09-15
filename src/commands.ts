/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 抽取 status 与 resolve 命令的核心执行逻辑以支持可测试性; 2. 支持 resolve --skip 自动标记跳过并下发下一任务]
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { readBridge, writeBridge, BridgeState } from './state.js';
import { markTaskSkippedInImpl, findNextPendingTask } from './pipeline.js';
import { getLogsDirPath } from './logger.js';

export interface StatusResult {
  state: BridgeState;
  progress: {
    total: number;
    done: number;
    skipped: number;
  };
  recentLogs: string[];
}

export function getStatus(configPath?: string, cwd: string = process.cwd()): StatusResult {
  const config = loadConfig(configPath, process.env);
  const bridgeFile = path.join(cwd, 'bridge.md');
  const { state } = readBridge(bridgeFile);

  let total = 0;
  let done = 0;
  let skipped = 0;

  const implPath = path.resolve(cwd, config.docs.impl);
  if (fs.existsSync(implPath)) {
    const implContent = fs.readFileSync(implPath, 'utf-8');
    total = (implContent.match(/^\s*-\s*\[[ x\-]\]\s*T\d+:/gm) || []).length;
    done = (implContent.match(/^\s*-\s*\[x\]\s*T\d+:/gm) || []).length;
    skipped = (implContent.match(/^\s*-\s*\[\-\]\s*T\d+:/gm) || []).length;
  }

  const logsDir = getLogsDirPath(cwd);
  let recentLogs: string[] = [];
  if (fs.existsSync(logsDir)) {
    recentLogs = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.md'))
      .reverse()
      .slice(0, 5);
  }

  return {
    state,
    progress: { total, done, skipped },
    recentLogs,
  };
}

export function resolveNeedsHuman(options: {
  configPath?: string;
  skip?: boolean;
  cwd?: string;
}): BridgeState {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(options.configPath, process.env);
  const bridgeFile = path.join(cwd, 'bridge.md');
  const { state, freeZone } = readBridge(bridgeFile);

  if (state.status !== 'NEEDS_HUMAN') {
    throw new Error(`当前状态为 ${state.status}，非 NEEDS_HUMAN，不可执行 resolve`);
  }

  if (options.skip && state.task_id) {
    const res = markTaskSkippedInImpl(path.resolve(cwd, config.docs.impl), state.task_id);
    if (res.hasMoreTasks && res.nextTaskId) {
      const nextState: BridgeState = {
        ...state,
        status: 'PENDING_DEV',
        task_id: res.nextTaskId,
        round: state.round + 1,
        retry: 0,
        updated_at: new Date().toISOString(),
        error: undefined,
      };
      writeBridge(bridgeFile, nextState, freeZone);
      return nextState;
    } else {
      const completedState: BridgeState = {
        ...state,
        status: 'COMPLETED',
        task_id: null,
        round: state.round + 1,
        retry: 0,
        updated_at: new Date().toISOString(),
        error: undefined,
      };
      writeBridge(bridgeFile, completedState, freeZone);
      return completedState;
    }
  } else {
    const recoveredState: BridgeState = {
      ...state,
      status: 'PENDING_DEV',
      retry: 0,
      updated_at: new Date().toISOString(),
      error: undefined,
    };
    writeBridge(bridgeFile, recoveredState, freeZone);
    return recoveredState;
  }
}
