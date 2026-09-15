/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 watcher 主循环与 tick 状态机驱动; 2. 实现 once 命令单步执行与 dry-run 支持; 3. 处理陈旧状态检测与错误恢复策略]
 */

import path from 'node:path';
import { BridgeConfig } from './config.js';
import { readBridge, writeBridge, isStaleState, rollbackInvalidTransition, BridgeState } from './state.js';
import { runDevHalf, runReviewHalf } from './pipeline.js';

export interface WatcherOptions {
  config: BridgeConfig;
  cwd?: string;
  dryRun?: boolean;
  maxTicks?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单次执行一个半循环 (once 命令)
 */
export async function executeOnce(options: WatcherOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const bridgeFile = 'bridge.md';
  const { state } = readBridge(path.join(cwd, bridgeFile));

  switch (state.status) {
    case 'PENDING_DEV':
    case 'IN_DEV':
      console.log(`[once] 当前状态 ${state.status}，执行开发半循环...`);
      await runDevHalf({ config: options.config, dryRun: options.dryRun, cwd });
      break;

    case 'PENDING_REVIEW':
    case 'IN_REVIEW':
      console.log(`[once] 当前状态 ${state.status}，执行验收半循环...`);
      await runReviewHalf({ config: options.config, dryRun: options.dryRun, cwd });
      break;

    case 'ERROR': {
      console.log(`[once] 当前状态为 ERROR: ${state.error ?? '未知错误'}`);
      handleErrorState(state, options.config, cwd);
      break;
    }

    case 'NEEDS_HUMAN':
      console.log('[once] 当前状态为 NEEDS_HUMAN，需要人工介入处理后执行 resolve 命令。');
      break;

    case 'COMPLETED':
      console.log('[once] 全部任务已完成。');
      break;
  }
}

/**
 * 处理 ERROR 状态按 onError 恢复策略
 */
function handleErrorState(state: BridgeState, config: BridgeConfig, cwd: string): void {
  const nextRetry = state.retry + 1;
  const bridgeFile = path.join(cwd, 'bridge.md');

  if (config.onError === 'retry' && nextRetry < config.maxRetryPerTask) {
    console.log(`[ERROR 恢复] 按 onError=retry 策略，重试计数+1 (${nextRetry})，回退到 PENDING_DEV`);
    writeBridge(bridgeFile, {
      ...state,
      status: 'PENDING_DEV',
      retry: nextRetry,
      updated_at: new Date().toISOString(),
    });
  } else {
    console.log(`[ERROR 熔断] onError=${config.onError} 或已达重试上限，转为 NEEDS_HUMAN`);
    writeBridge(bridgeFile, {
      ...state,
      status: 'NEEDS_HUMAN',
      retry: nextRetry,
      updated_at: new Date().toISOString(),
    });
  }
}

/**
 * 启动 Watcher 守护主循环
 */
export async function startWatcher(options: WatcherOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const bridgeFile = path.join(cwd, 'bridge.md');
  let lastKnownState: BridgeState | null = null;
  let tickCount = 0;

  console.log(`[Watcher] 守护进程启动，轮询间隔: ${options.config.pollIntervalSec}s...`);

  while (true) {
    if (options.maxTicks && tickCount >= options.maxTicks) {
      break;
    }
    tickCount++;

    const { state, freeZone } = readBridge(bridgeFile);

    // 迁移合法性校验与非法回滚
    if (lastKnownState && state.status !== lastKnownState.status) {
      const checkedState = rollbackInvalidTransition(bridgeFile, state, lastKnownState, freeZone);
      if (checkedState.status === 'ERROR') {
        lastKnownState = checkedState;
        await sleep(options.config.pollIntervalSec * 1000);
        continue;
      }
    }
    lastKnownState = state;

    // 陈旧状态断点续跑检测
    const timeoutMin = state.status === 'IN_DEV' ? options.config.builder.timeoutMin : options.config.supervisor.timeoutMin;
    if (isStaleState(state, timeoutMin, options.config.staleThresholdMin)) {
      console.warn(`[Watcher] 检测到陈旧状态 ${state.status} (超时)，准备重新执行该阶段...`);
      if (state.status === 'IN_DEV') {
        await runDevHalf({ config: options.config, dryRun: options.dryRun, cwd });
      } else if (state.status === 'IN_REVIEW') {
        await runReviewHalf({ config: options.config, dryRun: options.dryRun, cwd });
      }
      await sleep(options.config.pollIntervalSec * 1000);
      continue;
    }

    switch (state.status) {
      case 'PENDING_DEV':
        await runDevHalf({ config: options.config, dryRun: options.dryRun, cwd });
        break;

      case 'IN_DEV':
        // watch 模式等待施工方翻转状态，cli 模式已在 runDevHalf 中等待
        break;

      case 'PENDING_REVIEW':
        await runReviewHalf({ config: options.config, dryRun: options.dryRun, cwd });
        break;

      case 'IN_REVIEW':
        // 等待监工裁决
        break;

      case 'ERROR':
        handleErrorState(state, options.config, cwd);
        break;

      case 'NEEDS_HUMAN':
      case 'COMPLETED':
        // 挂起休眠
        break;
    }

    await sleep(options.config.pollIntervalSec * 1000);
  }
}
