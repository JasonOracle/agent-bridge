/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 git commit 检测与 HEAD 获取; 2. 实现 diff 收集与超限（>maxKB）自动降级截断机制及未跟踪文件列举]
 */

import { run } from './executor.js';

export interface DiffResult {
  diff: string;
  truncated: boolean;
  untracked: string[];
}

/**
 * 获取当前仓库最新的 HEAD commit hash
 */
export async function getHeadCommit(cwd: string = process.cwd()): Promise<string | null> {
  const res = await run(['git', 'rev-parse', 'HEAD'], { cwd });
  if (res.code !== 0 || !res.stdout.trim()) {
    return null;
  }
  return res.stdout.trim();
}

/**
 * 判断自 ref 以来是否有新 commit
 */
export async function hasNewCommitSince(
  ref: string | null,
  cwd: string = process.cwd()
): Promise<boolean> {
  const currentHead = await getHeadCommit(cwd);
  if (!currentHead) return false;
  if (!ref) return true;
  return currentHead !== ref;
}

/**
 * 获取未跟踪文件列表
 */
export async function getUntrackedFiles(cwd: string = process.cwd()): Promise<string[]> {
  const res = await run(['git', 'status', '--porcelain'], { cwd });
  if (res.code !== 0) return [];
  const lines = res.stdout.split('\n');
  const untracked: string[] = [];
  for (const line of lines) {
    if (line.startsWith('?? ')) {
      untracked.push(line.slice(3).trim());
    }
  }
  return untracked;
}

/**
 * 收集 diff 并支持超限截断
 */
export async function collectDiff(
  ref: string | null,
  maxKB: number = 64,
  cwd: string = process.cwd()
): Promise<DiffResult> {
  const untracked = await getUntrackedFiles(cwd);
  const diffRange = ref ? `${ref}..HEAD` : 'HEAD';

  // 1. 获取全量 diff
  const fullDiffRes = await run(['git', 'diff', diffRange], { cwd });
  const fullDiff = fullDiffRes.stdout;
  const maxBytes = maxKB * 1024;

  if (Buffer.byteLength(fullDiff, 'utf-8') <= maxBytes) {
    return {
      diff: fullDiff,
      truncated: false,
      untracked,
    };
  }

  // 2. 超限降级：git diff --stat + 逐文件 diff 取前 200 行
  const statRes = await run(['git', 'diff', '--stat', diffRange], { cwd });
  const statSummary = statRes.stdout.trim();

  const filesRes = await run(['git', 'diff', '--name-only', diffRange], { cwd });
  const changedFiles = filesRes.stdout.split('\n').map((f) => f.trim()).filter(Boolean);

  const fileDiffs: string[] = [];
  for (const file of changedFiles) {
    const fileDiffRes = await run(['git', 'diff', diffRange, '--', file], { cwd });
    const fileLines = fileDiffRes.stdout.split('\n');
    if (fileLines.length > 200) {
      const truncatedLines = fileLines.slice(0, 200);
      truncatedLines.push('... [truncated]');
      fileDiffs.push(truncatedLines.join('\n'));
    } else {
      fileDiffs.push(fileDiffRes.stdout);
    }
  }

  const combinedDiff = `${statSummary}\n\n${fileDiffs.join('\n\n')}`.trim();

  return {
    diff: combinedDiff,
    truncated: true,
    untracked,
  };
}
