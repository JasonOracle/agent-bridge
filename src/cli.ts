#!/usr/bin/env node
/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 接入 config/watcher/state 模块; 2. 实现 once, watch, status, resolve 实际业务分发]
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { readBridge, writeBridge } from './state.js';
import { executeOnce, startWatcher } from './watcher.js';
import { markTaskSkippedInImpl } from './pipeline.js';
import { getLogsDirPath } from './logger.js';

const program = new Command();

program
  .name('agent-bridge')
  .description('Meta-Agent 协同引擎 CLI')
  .version('0.1.0');

program
  .command('init')
  .description('生成项目模板与目录骨架')
  .option('-f, --force', '强制覆盖已存在文件', false)
  .action(async (options) => {
    try {
      const { runInit } = await import('./init.js');
      const res = runInit({ force: options.force });
      console.log('=============== 初始化完成 ===============');
      console.log(`新建/更新文件 (${res.created.length}):`);
      for (const f of res.created) {
        console.log(`  + ${f}`);
      }
      if (res.skipped.length > 0) {
        console.log(`跳过已存在文件 (${res.skipped.length}, 加 --force 可覆盖):`);
        for (const f of res.skipped) {
          console.log(`  - ${f}`);
        }
      }
      console.log('==========================================');
    } catch (err: any) {
      console.error('[init 失败]', err?.message ?? err);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('启动守护进程主循环')
  .option('-c, --config <path>', '指定配置文件路径', '.bridge.config.json')
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      await startWatcher({ config });
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[配置错误] ${err.message}`);
        process.exit(err.exitCode);
      }
      console.error('[运行异常]', err);
      process.exit(1);
    }
  });

program
  .command('once')
  .description('只执行当前状态对应的一个半循环后退出')
  .option('-c, --config <path>', '指定配置文件路径', '.bridge.config.json')
  .option('--dry-run', '仅打印将发送的 prompt 或请求，不执行具体外部调用', false)
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      await executeOnce({ config, dryRun: options.dryRun });
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[配置错误] ${err.message}`);
        process.exit(err.exitCode);
      }
      console.error('[运行异常]', err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('打印当前 bridge.md 状态、impl.md 完成度及最近审计日志摘要')
  .option('-c, --config <path>', '指定配置文件路径', '.bridge.config.json')
  .action(async (options) => {
    try {
      const { getStatus } = await import('./commands.js');
      const res = getStatus(options.config);
      console.log('================= 状态总览 =================');
      console.log(`当前状态: ${res.state.status}`);
      console.log(`当前任务: ${res.state.task_id ?? '无'}`);
      console.log(`轮次: ${res.state.round}, 重试: ${res.state.retry}`);
      console.log(`更新时间: ${res.state.updated_at}`);
      console.log(`最新提交: ${res.state.last_commit ?? '无'}`);
      console.log(`\n任务进度: ${res.progress.done}/${res.progress.total} (已跳过: ${res.progress.skipped})`);
      if (res.recentLogs.length > 0) {
        console.log(`\n最近审计日志 (Top ${res.recentLogs.length}):`);
        for (const log of res.recentLogs) {
          console.log(`  - ${log}`);
        }
      }
      console.log('============================================');
    } catch (err) {
      console.error('[查看状态失败]', err);
      process.exit(1);
    }
  });

program
  .command('resolve')
  .description('从 NEEDS_HUMAN 状态恢复为 PENDING_DEV')
  .option('-c, --config <path>', '指定配置文件路径', '.bridge.config.json')
  .option('--skip', '标记跳过当前任务', false)
  .action(async (options) => {
    try {
      const { resolveNeedsHuman } = await import('./commands.js');
      const nextState = resolveNeedsHuman({
        configPath: options.config,
        skip: options.skip,
      });
      console.log(`[resolve 成功] 状态已更新为 ${nextState.status}, 任务: ${nextState.task_id ?? '全部完成'}`);
    } catch (err: any) {
      console.error('[resolve 失败]', err?.message ?? err);
      process.exit(1);
    }
  });

program.parse(process.argv);
