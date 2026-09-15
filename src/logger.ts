/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 .bridge/state.json 内部状态管理与 token 统计; 2. 实现 .bridge/logs/ 审计日志与开发异常日志记录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const InternalStateSchema = z.object({
  lastApprovedCommit: z.string().nullable(),
  totalTokens: z.object({
    input: z.number().int().min(0),
    output: z.number().int().min(0),
  }).default({ input: 0, output: 0 }),
  startedAt: z.string(),
});

export type InternalState = z.infer<typeof InternalStateSchema>;

export interface ReviewLogParams {
  taskId: string;
  round: number;
  verdict: 'approve' | 'reject' | 'error';
  timestamp?: string;
  diffFull: string;
  checksOutput: string;
  supervisorRawOutput: string;
  parsedVerdict: unknown;
}

export interface DevErrorLogParams {
  taskId: string;
  round: number;
  error: string;
  timestamp?: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 获取 .bridge 内部状态路径
 */
export function getStateFilePath(baseDir: string = process.cwd()): string {
  return path.resolve(baseDir, '.bridge', 'state.json');
}

/**
 * 获取 logs 目录
 */
export function getLogsDirPath(baseDir: string = process.cwd()): string {
  return path.resolve(baseDir, '.bridge', 'logs');
}

/**
 * 读取或初始化 .bridge/state.json
 */
export function readInternalState(baseDir: string = process.cwd()): InternalState {
  const filePath = getStateFilePath(baseDir);
  if (!fs.existsSync(filePath)) {
    const initialState: InternalState = {
      lastApprovedCommit: null,
      totalTokens: { input: 0, output: 0 },
      startedAt: new Date().toISOString(),
    };
    writeInternalState(initialState, baseDir);
    return initialState;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    return InternalStateSchema.parse(json);
  } catch {
    const fallback: InternalState = {
      lastApprovedCommit: null,
      totalTokens: { input: 0, output: 0 },
      startedAt: new Date().toISOString(),
    };
    writeInternalState(fallback, baseDir);
    return fallback;
  }
}

/**
 * 原子写入 .bridge/state.json
 */
export function writeInternalState(state: InternalState, baseDir: string = process.cwd()): void {
  const filePath = getStateFilePath(baseDir);
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const content = JSON.stringify(state, null, 2);
  const tmpPath = path.join(dir, `state.json.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * 累加 token 消耗
 */
export function addTokens(
  inputTokens: number,
  outputTokens: number,
  baseDir: string = process.cwd()
): InternalState {
  const current = readInternalState(baseDir);
  current.totalTokens.input += inputTokens;
  current.totalTokens.output += outputTokens;
  writeInternalState(current, baseDir);
  return current;
}

/**
 * 更新 lastApprovedCommit
 */
export function updateLastApprovedCommit(
  commit: string | null,
  baseDir: string = process.cwd()
): InternalState {
  const current = readInternalState(baseDir);
  current.lastApprovedCommit = commit;
  writeInternalState(current, baseDir);
  return current;
}

/**
 * 生成并保存评审审计日志: T{taskId}-r{round}-{verdict}.md
 */
export function saveReviewAuditLog(
  params: ReviewLogParams,
  baseDir: string = process.cwd()
): string {
  const logsDir = getLogsDirPath(baseDir);
  ensureDir(logsDir);

  const cleanTaskId = params.taskId.startsWith('T') ? params.taskId.slice(1) : params.taskId;
  const fileName = `T${cleanTaskId}-r${params.round}-${params.verdict}.md`;
  const filePath = path.join(logsDir, fileName);
  const timestamp = params.timestamp ?? new Date().toISOString();

  const content = `# 审计日志: T${params.taskId} - Round ${params.round} - ${params.verdict.toUpperCase()}

- 时间戳: ${timestamp}
- 任务 ID: ${params.taskId}
- 轮次: ${params.round}
- 裁决结论: ${params.verdict}

## 1. 最终 Verdict
\`\`\`json
${JSON.stringify(params.parsedVerdict, null, 2)}
\`\`\`

## 2. 监工原始输出
${params.supervisorRawOutput}

## 3. 本地 Checks 执行输出
\`\`\`
${params.checksOutput}
\`\`\`

## 4. 全量 Diff (未截断)
\`\`\`diff
${params.diffFull}
\`\`\`
`.replace(/\r\n/g, '\n');

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 生成并保存开发轮次异常日志: T{id}-r{round}-dev-error.md
 */
export function saveDevErrorLog(
  params: DevErrorLogParams,
  baseDir: string = process.cwd()
): string {
  const logsDir = getLogsDirPath(baseDir);
  ensureDir(logsDir);

  const cleanTaskId = params.taskId.startsWith('T') ? params.taskId.slice(1) : params.taskId;
  const fileName = `T${cleanTaskId}-r${params.round}-dev-error.md`;
  const filePath = path.join(logsDir, fileName);
  const timestamp = params.timestamp ?? new Date().toISOString();

  const content = `# 开发异常日志: T${params.taskId} - Round ${params.round}

- 时间戳: ${timestamp}
- 任务 ID: ${params.taskId}
- 轮次: ${params.round}

## 异常详情
\`\`\`
${params.error}
\`\`\`
`.replace(/\r\n/g, '\n');

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
