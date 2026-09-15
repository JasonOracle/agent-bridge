/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现任务清单 impl.md 标记完成与跳过逻辑; 2. 实现 checks 本地自动化校验执行; 3. 实现开发半循环与验收半循环编排及 Verdict 回写]
 */

import fs from 'node:fs';
import path from 'node:path';
import { BridgeConfig } from './config.js';
import { readBridge, writeBridge, BridgeState } from './state.js';
import { run } from './executor.js';
import { collectDiff, getHeadCommit, hasNewCommitSince } from './gittool.js';
import { assembleBuilderPrompt, assembleReviewRequest, createPromptFile, removePromptFile } from './context.js';
import {
  readInternalState,
  updateLastApprovedCommit,
  saveReviewAuditLog,
  saveDevErrorLog,
} from './logger.js';
import { Verdict } from './supervisor/types.js';
import { getVerdict } from './supervisor/index.js';

export interface TaskProgressionResult {
  hasMoreTasks: boolean;
  nextTaskId: string | null;
}

/**
 * 将 impl.md 中指定 taskId 标记为完成 (- [x]) 并找出下一个任务
 */
export function markTaskCompletedInImpl(implPath: string, taskId: string): TaskProgressionResult {
  const resolved = path.resolve(process.cwd(), implPath);
  if (!fs.existsSync(resolved)) {
    return { hasMoreTasks: false, nextTaskId: null };
  }

  const content = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n');
  const taskRegex = new RegExp(`^(\\s*-\\s*\\[)[ \\-](\\]\\s*${taskId}:)`, 'm');
  const updatedContent = content.replace(taskRegex, '$1x$2');
  fs.writeFileSync(resolved, updatedContent, 'utf-8');

  return findNextPendingTask(updatedContent);
}

/**
 * 将 impl.md 中指定 taskId 标记为跳过 (- [-]) 并找出下一个任务
 */
export function markTaskSkippedInImpl(implPath: string, taskId: string): TaskProgressionResult {
  const resolved = path.resolve(process.cwd(), implPath);
  if (!fs.existsSync(resolved)) {
    return { hasMoreTasks: false, nextTaskId: null };
  }

  const content = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n');
  const taskRegex = new RegExp(`^(\\s*-\\s*\\[)[ x](\\]\\s*${taskId}:)`, 'm');
  const updatedContent = content.replace(taskRegex, '$1-$2');
  fs.writeFileSync(resolved, updatedContent, 'utf-8');

  return findNextPendingTask(updatedContent);
}

/**
 * 寻找 impl.md 中下一个未完成的任务 ID
 */
export function findNextPendingTask(content: string): TaskProgressionResult {
  const match = content.match(/^\s*-\s*\[\s*\]\s*(T\d+):/m);
  if (match) {
    return {
      hasMoreTasks: true,
      nextTaskId: match[1],
    };
  }
  return {
    hasMoreTasks: false,
    nextTaskId: null,
  };
}

/**
 * 运行本地自动化校验（Checks）
 */
export async function runChecks(
  checks: string[],
  timeoutMin: number,
  cwd: string = process.cwd()
): Promise<{ success: boolean; output: string }> {
  let allSuccess = true;
  const logs: string[] = [];

  for (const checkCmd of checks) {
    logs.push(`\n$ ${checkCmd}`);
    const timeoutMs = timeoutMin * 60 * 1000;
    // 使用 shell 执行 npm 等脚本命令
    const cmdTokens = checkCmd.trim().split(/\s+/);
    const res = await run(cmdTokens, {
      cwd,
      timeoutMs,
      shell: true,
    });

    if (res.stdout) logs.push(res.stdout);
    if (res.stderr) logs.push(res.stderr);

    if (res.timedOut) {
      allSuccess = false;
      logs.push(`[ERROR] 命令执行超时（>${timeoutMin}m）已强杀`);
      break;
    }

    if (res.code !== 0) {
      allSuccess = false;
      logs.push(`[FAILED] 进程以非零状态码退出: ${res.code}`);
      break;
    }
  }

  return {
    success: allSuccess,
    output: logs.join('\n').trim(),
  };
}

export interface PipelineOptions {
  config: BridgeConfig;
  dryRun?: boolean;
  mockVerdict?: Verdict;
  cwd?: string;
}

/**
 * 执行验收半循环 (PENDING_REVIEW -> IN_REVIEW -> ...)
 */
export async function runReviewHalf(options: PipelineOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const bridgeFile = 'bridge.md';
  const { state, freeZone } = readBridge(path.join(cwd, bridgeFile));

  if (!state.task_id) {
    return;
  }

  const internalState = readInternalState(cwd);
  const headCommit = await getHeadCommit(cwd);

  // 1. 检查是否有新提交
  const hasNew = await hasNewCommitSince(internalState.lastApprovedCommit, cwd);
  if (!hasNew) {
    // 无新 commit，直接打回
    const rejectVerdict: Verdict = {
      verdict: 'reject',
      task_id: state.task_id,
      round: state.round,
      summary: '未检测到任何代码提交',
      issues: [{ severity: 'blocker', desc: '工作区代码未提交至 git' }],
      next_instructions: '请按规范完成本任务代码实现，并使用 git commit 提交，message 需包含 [bridge] 前缀。',
    };

    saveReviewAuditLog(
      {
        taskId: state.task_id,
        round: state.round,
        verdict: 'reject',
        diffFull: '(无新增 commit)',
        checksOutput: '(跳过 checks 校验)',
        supervisorRawOutput: JSON.stringify(rejectVerdict, null, 2),
        parsedVerdict: rejectVerdict,
      },
      cwd
    );

    const nextRetry = state.retry + 1;
    if (nextRetry >= options.config.maxRetryPerTask && options.config.onMaxRetry === 'human') {
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          ...state,
          status: 'NEEDS_HUMAN',
          retry: nextRetry,
          updated_at: new Date().toISOString(),
          error: '连续多次未提交代码，触发人工干预熔断',
        },
        `## 本轮指令\n${rejectVerdict.next_instructions}`
      );
    } else {
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          ...state,
          status: 'PENDING_DEV',
          retry: nextRetry,
          updated_at: new Date().toISOString(),
        },
        `## 本轮指令\n${rejectVerdict.next_instructions}`
      );
    }
    return;
  }

  // 2. 收集 diff
  const diffResult = await collectDiff(internalState.lastApprovedCommit, options.config.maxDiffKB, cwd);

  // 3. 执行 checks 校验
  const checksRes = await runChecks(options.config.checks, options.config.checkTimeoutMin, cwd);

  // 4. 组装 review-request.md
  const reviewRequestMd = assembleReviewRequest({
    baseDir: cwd,
    taskId: state.task_id,
    round: state.round,
    roleSupervisorPath: options.config.roles.supervisor,
    prdPath: options.config.docs.prd,
    techPath: options.config.docs.tech,
    testPath: options.config.docs.test,
    implPath: options.config.docs.impl,
    diff: diffResult.diff,
    diffTruncated: diffResult.truncated,
    untrackedFiles: diffResult.untracked,
    checksLog: checksRes.output,
  });

  // 原子写盘 .bridge/review-request.md
  const reviewRequestPath = path.resolve(cwd, '.bridge', 'review-request.md');
  const reviewRequestDir = path.dirname(reviewRequestPath);
  if (!fs.existsSync(reviewRequestDir)) {
    fs.mkdirSync(reviewRequestDir, { recursive: true });
  }
  const tmpReviewPath = `${reviewRequestPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpReviewPath, reviewRequestMd, 'utf-8');
  fs.renameSync(tmpReviewPath, reviewRequestPath);

  if (options.dryRun) {
    console.log('[dry-run] 生成的 review-request.md 内容预览:\n', reviewRequestMd.slice(0, 500), '\n...');
    return;
  }

  // 5. 翻转为 IN_REVIEW
  writeBridge(
    path.join(cwd, bridgeFile),
    {
      ...state,
      status: 'IN_REVIEW',
      updated_at: new Date().toISOString(),
    },
    freeZone
  );

  // 6. 获取裁决结果
  const verdict: Verdict = options.mockVerdict ?? (await getVerdict({
    config: options.config,
    requestMd: reviewRequestMd,
    requestMdPath: '.bridge/review-request.md',
    expectedTaskId: state.task_id,
    currentRound: state.round,
    cwd,
  }));

  // 7. 回写裁决
  if (verdict.verdict === 'approve') {
    const progression = markTaskCompletedInImpl(path.resolve(cwd, options.config.docs.impl), state.task_id);
    updateLastApprovedCommit(headCommit, cwd);

    saveReviewAuditLog(
      {
        taskId: state.task_id,
        round: state.round,
        verdict: 'approve',
        diffFull: diffResult.diff,
        checksOutput: checksRes.output,
        supervisorRawOutput: JSON.stringify(verdict, null, 2),
        parsedVerdict: verdict,
      },
      cwd
    );

    if (progression.hasMoreTasks && progression.nextTaskId) {
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          status: 'PENDING_DEV',
          task_id: progression.nextTaskId,
          round: state.round + 1,
          retry: 0,
          updated_at: new Date().toISOString(),
          last_commit: headCommit,
        },
        '## 本轮指令\n（新任务已下发，请开始实现）'
      );
    } else {
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          status: 'COMPLETED',
          task_id: null,
          round: state.round + 1,
          retry: 0,
          updated_at: new Date().toISOString(),
          last_commit: headCommit,
        },
        '## 恭喜\n全部任务清单已全部验收通过！'
      );
    }
  } else {
    // Reject
    saveReviewAuditLog(
      {
        taskId: state.task_id,
        round: state.round,
        verdict: 'reject',
        diffFull: diffResult.diff,
        checksOutput: checksRes.output,
        supervisorRawOutput: JSON.stringify(verdict, null, 2),
        parsedVerdict: verdict,
      },
      cwd
    );

    const nextRetry = state.retry + 1;
    if (nextRetry >= options.config.maxRetryPerTask) {
      if (options.config.onMaxRetry === 'human') {
        writeBridge(
          path.join(cwd, bridgeFile),
          {
            ...state,
            status: 'NEEDS_HUMAN',
            retry: nextRetry,
            updated_at: new Date().toISOString(),
            error: `任务 ${state.task_id} 连续重试 ${nextRetry} 次未通过，已熔断`,
          },
          `## 本轮指令\n${verdict.next_instructions}`
        );
      } else {
        // onMaxRetry = skip
        const progression = markTaskSkippedInImpl(path.resolve(cwd, options.config.docs.impl), state.task_id);
        if (progression.hasMoreTasks && progression.nextTaskId) {
          writeBridge(
            path.join(cwd, bridgeFile),
            {
              status: 'PENDING_DEV',
              task_id: progression.nextTaskId,
              round: state.round + 1,
              retry: 0,
              updated_at: new Date().toISOString(),
              last_commit: headCommit,
            },
            '## 本轮指令\n（上一任务已跳过，进入下一任务）'
          );
        } else {
          writeBridge(
            path.join(cwd, bridgeFile),
            {
              status: 'COMPLETED',
              task_id: null,
              round: state.round + 1,
              retry: 0,
              updated_at: new Date().toISOString(),
              last_commit: headCommit,
            },
            '## 项目完成'
          );
        }
      }
    } else {
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          ...state,
          status: 'PENDING_DEV',
          retry: nextRetry,
          updated_at: new Date().toISOString(),
        },
        `## 本轮指令\n${verdict.next_instructions}`
      );
    }
  }
}

/**
 * 执行开发半循环 (PENDING_DEV -> IN_DEV -> ...)
 */
export async function runDevHalf(options: PipelineOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const bridgeFile = 'bridge.md';
  const { state, freeZone } = readBridge(path.join(cwd, bridgeFile));

  if (!state.task_id) {
    return;
  }

  // 1. 置位 IN_DEV
  writeBridge(
    path.join(cwd, bridgeFile),
    {
      ...state,
      status: 'IN_DEV',
      updated_at: new Date().toISOString(),
    },
    freeZone
  );

  // 2. 组装提示词
  const prompt = assembleBuilderPrompt({
    baseDir: cwd,
    taskId: state.task_id,
    instructions: freeZone,
    roleBuilderPath: options.config.roles.builder,
    techPath: options.config.docs.tech,
    implPath: options.config.docs.impl,
  });

  if (options.dryRun) {
    console.log('[dry-run] 组装的施工提示词:\n', prompt.slice(0, 500), '\n...');
    return;
  }

  // 3. 检查 builder 模式
  if (options.config.builder.mode === 'watch') {
    console.log('【Mode B 提示】：请确认 IDE 侧施工定时任务已注册（行动信号 = PENDING_DEV 或 IN_DEV）');
    return;
  }

  // Mode A: spawn CLI
  const promptFile = createPromptFile(prompt, 'builder-prompt', cwd);
  try {
    const rawArgs = options.config.builder.args ?? ['-p', '{promptFile}'];
    const args = rawArgs.map((arg) => {
      if (arg === '{promptFile}') return promptFile;
      if (arg === '{prompt}') return prompt;
      return arg;
    });

    const command = options.config.builder.command!;
    const timeoutMs = options.config.builder.timeoutMin * 60 * 1000;
    const res = await run([command, ...args], {
      cwd,
      timeoutMs,
      shell: process.platform === 'win32',
    });

    if (res.timedOut) {
      saveDevErrorLog(
        {
          taskId: state.task_id,
          round: state.round,
          error: `施工 CLI 执行超时（>${options.config.builder.timeoutMin}m）被强制终止`,
        },
        cwd
      );
      writeBridge(
        path.join(cwd, bridgeFile),
        {
          ...state,
          status: 'ERROR',
          updated_at: new Date().toISOString(),
          error: '施工 CLI 超时',
        },
        freeZone
      );
    }
  } finally {
    removePromptFile(promptFile);
  }
}
