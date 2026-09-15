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
    console.log('init 命令执行 (将在 T12 完整化):', options);
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
      const config = loadConfig(options.config);
      const { state } = readBridge();
      console.log('================= 状态总览 =================');
      console.log(`当前状态: ${state.status}`);
      console.log(`当前任务: ${state.task_id ?? '无'}`);
      console.log(`轮次: ${state.round}, 重试: ${state.retry}`);
      console.log(`更新时间: ${state.updated_at}`);
      console.log(`最新提交: ${state.last_commit ?? '无'}`);

      const implPath = path.resolve(process.cwd(), config.docs.impl);
      if (fs.existsSync(implPath)) {
        const implContent = fs.readFileSync(implPath, 'utf-8');
        const total = (implContent.match(/^\s*-\s*\[[ x\-]\]\s*T\d+:/gm) || []).length;
        const done = (implContent.match(/^\s*-\s*\[x\]\s*T\d+:/gm) || []).length;
        const skipped = (implContent.match(/^\s*-\s*\[\-\]\s*T\d+:/gm) || []).length;
        console.log(`\n任务进度: ${done}/${total} (已跳过: ${skipped})`);
      }

      const logsDir = getLogsDirPath();
      if (fs.existsSync(logsDir)) {
        const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith('.md')).reverse().slice(0, 5);
        console.log(`\n最近审计日志 (Top ${logFiles.length}):`);
        for (const log of logFiles) {
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
      const config = loadConfig(options.config);
      const { state, freeZone } = readBridge();
      if (state.status !== 'NEEDS_HUMAN') {
        console.warn(`[提示] 当前状态为 ${state.status}，非 NEEDS_HUMAN，无需 resolve。`);
        return;
      }

      if (options.skip && state.task_id) {
        console.log(`[resolve] 标记跳过任务 ${state.task_id}...`);
        const res = markTaskSkippedInImpl(path.resolve(process.cwd(), config.docs.impl), state.task_id);
        if (res.hasMoreTasks && res.nextTaskId) {
          writeBridge('bridge.md', {
            ...state,
            status: 'PENDING_DEV',
            task_id: res.nextTaskId,
            round: state.round + 1,
            retry: 0,
            updated_at: new Date().toISOString(),
          }, freeZone);
          console.log(`[resolve] 已前进至新任务 ${res.nextTaskId}`);
        } else {
          writeBridge('bridge.md', {
            ...state,
            status: 'COMPLETED',
            task_id: null,
            round: state.round + 1,
            retry: 0,
            updated_at: new Date().toISOString(),
          }, freeZone);
          console.log('[resolve] 所有任务已完成。');
        }
      } else {
        console.log(`[resolve] 恢复任务 ${state.task_id} 为 PENDING_DEV (retry 清零)...`);
        writeBridge('bridge.md', {
          ...state,
          status: 'PENDING_DEV',
          retry: 0,
          updated_at: new Date().toISOString(),
        }, freeZone);
      }
    } catch (err) {
      console.error('[resolve 失败]', err);
      process.exit(1);
    }
  });

program.parse(process.argv);
