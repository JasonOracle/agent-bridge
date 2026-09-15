/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 定义监工 Verdict 及 Issues 的 Zod Schema 与类型声明]
 */

import { z } from 'zod';

export const VerdictIssueSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  desc: z.string(),
  file: z.string().optional(),
});

export const VerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  task_id: z.string(),
  round: z.number().int().optional(),
  summary: z.string(),
  issues: z.array(VerdictIssueSchema).default([]),
  next_instructions: z.string().default(''),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type VerdictIssue = z.infer<typeof VerdictIssueSchema>;
