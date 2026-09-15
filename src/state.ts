/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 bridge.md 双区解析、BridgeStateSchema 校验与原子写入; 2. 实现状态机合法迁移判定、回滚与陈旧状态检测]
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export class BridgeParseError extends Error {
  exitCode: number = 3;
  constructor(message: string) {
    super(message);
    this.name = 'BridgeParseError';
  }
}

export class BridgeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTransitionError';
  }
}

export const BridgeStatusSchema = z.enum([
  'PENDING_DEV',
  'IN_DEV',
  'PENDING_REVIEW',
  'IN_REVIEW',
  'NEEDS_HUMAN',
  'ERROR',
  'COMPLETED',
]);

export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;

export const BridgeStateSchema = z.object({
  status: BridgeStatusSchema,
  task_id: z.string().regex(/^T\d+$/).nullable(),
  round: z.number().int().min(1),
  retry: z.number().int().min(0),
  updated_at: z.preprocess(
    (val) => (val instanceof Date ? val.toISOString() : typeof val === 'string' ? val : ''),
    z.string().min(1)
  ),
  last_commit: z.string().nullable(),
  error: z.string().optional(),
});

export type BridgeState = z.infer<typeof BridgeStateSchema>;

export interface ParsedBridge {
  state: BridgeState;
  freeZone: string;
}

// 合法状态迁移映射表 (from -> allowed to[])
export const VALID_TRANSITIONS: Record<BridgeStatus, BridgeStatus[]> = {
  PENDING_DEV: ['IN_DEV', 'PENDING_REVIEW', 'ERROR'],
  IN_DEV: ['PENDING_REVIEW', 'ERROR', 'IN_DEV'],
  PENDING_REVIEW: ['IN_REVIEW', 'ERROR'],
  IN_REVIEW: ['PENDING_DEV', 'COMPLETED', 'NEEDS_HUMAN', 'ERROR', 'IN_REVIEW'],
  ERROR: ['PENDING_DEV', 'NEEDS_HUMAN'],
  NEEDS_HUMAN: ['PENDING_DEV'],
  COMPLETED: [],
};

/**
 * 校验状态迁移是否合法
 */
export function isValidTransition(from: BridgeStatus, to: BridgeStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * 解析 bridge.md 文本内容
 */
export function parseBridgeContent(content: string): ParsedBridge {
  const normalized = content.replace(/\r\n/g, '\n');
  const yamlMatch = normalized.match(/^```yaml\n([\s\S]*?)\n```/);
  if (!yamlMatch) {
    throw new BridgeParseError('未在 bridge.md 头部找到有效的 yaml 机器区代码块');
  }

  const rawYaml = yamlMatch[1];
  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(rawYaml);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BridgeParseError(`bridge.md 机器区 YAML 语法解析失败: ${msg}`);
  }

  const parseResult = BridgeStateSchema.safeParse(parsedYaml);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new BridgeParseError(`bridge.md 机器区字段校验失败: ${issues}`);
  }

  // 机器区之后的内容为自由区
  const blockEndIndex = yamlMatch[0].length;
  const freeZone = normalized.slice(blockEndIndex).trimStart();

  return {
    state: parseResult.data,
    freeZone,
  };
}

/**
 * 序列化状态与自由区
 */
export function serializeBridge(state: BridgeState, freeZone: string = ''): string {
  // 生成干净的 YAML 块
  const yamlString = yaml.dump(state, {
    lineWidth: -1,
    noRefs: true,
  }).trim();

  const cleanFreeZone = freeZone ? `\n\n${freeZone.trim()}\n` : '\n';
  return `\`\`\`yaml\n${yamlString}\n\`\`\`${cleanFreeZone}`.replace(/\r\n/g, '\n');
}

/**
 * 从文件读取 bridge.md
 */
export function readBridge(filePath: string = 'bridge.md'): ParsedBridge {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new BridgeParseError(`状态文件不存在: ${filePath}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  return parseBridgeContent(content);
}

/**
 * 原子写入 bridge.md（写入临时文件后 rename 覆盖）
 */
export function writeBridge(
  filePath: string = 'bridge.md',
  state: BridgeState,
  freeZone: string = ''
): void {
  const resolved = path.resolve(process.cwd(), filePath);
  const dir = path.dirname(resolved);
  const content = serializeBridge(state, freeZone);

  // 写入临时文件: bridge.md.tmp.<pid>.<random>
  const tmpPath = path.join(dir, `${path.basename(resolved)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, resolved);
}

/**
 * 检测 IN_DEV 或 IN_REVIEW 是否陈旧
 */
export function isStaleState(
  state: BridgeState,
  timeoutMin: number,
  staleThresholdMin: number = 0,
  now: Date = new Date()
): boolean {
  if (state.status !== 'IN_DEV' && state.status !== 'IN_REVIEW') {
    return false;
  }

  const effectiveThresholdMin = staleThresholdMin > 0 ? staleThresholdMin : timeoutMin + 5;
  const thresholdMs = effectiveThresholdMin * 60 * 1000;
  const updatedAtTime = new Date(state.updated_at).getTime();

  if (Number.isNaN(updatedAtTime)) {
    return true;
  }

  return now.getTime() - updatedAtTime > thresholdMs;
}

/**
 * 非法迁移回滚并记录错误
 */
export function rollbackInvalidTransition(
  filePath: string,
  currentState: BridgeState,
  lastKnownState: BridgeState,
  freeZone: string
): BridgeState {
  if (!isValidTransition(lastKnownState.status, currentState.status)) {
    const rolledBackState: BridgeState = {
      ...lastKnownState,
      status: 'ERROR',
      error: `检测到非法状态迁移: ${lastKnownState.status} -> ${currentState.status}，已自动回滚`,
      updated_at: new Date().toISOString(),
    };
    writeBridge(filePath, rolledBackState, freeZone);
    return rolledBackState;
  }
  return currentState;
}
