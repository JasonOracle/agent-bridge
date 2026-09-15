/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现配置加载、${ENV} 环境变量插值与按模式 zod 校验; 2. 缺失环境变量或配置错误抛出 exitCode=2 的 ConfigError]
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export class ConfigError extends Error {
  exitCode: number = 2;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// 基础模式校验枚举
export const SupervisorModeSchema = z.enum(['api', 'cli', 'watch']);
export const BuilderModeSchema = z.enum(['cli', 'watch']);
export const OnMaxRetrySchema = z.enum(['human', 'skip']);
export const OnErrorSchema = z.enum(['retry', 'human']);

export const BaseConfigSchema = z.object({
  supervisor: z.object({
    mode: SupervisorModeSchema,
    provider: z.enum(['claude', 'openai']).optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    maxTokens: z.number().int().positive().default(8192),
    timeoutMin: z.number().positive().default(20),
    cli: z.object({
      command: z.string(),
      args: z.array(z.string()).default([]),
    }).optional(),
  }),
  builder: z.object({
    mode: BuilderModeSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    timeoutMin: z.number().positive().default(45),
  }),
  docs: z.object({
    prd: z.string().default('docs/prd.md'),
    tech: z.string().default('docs/tech.md'),
    impl: z.string().default('docs/impl.md'),
    test: z.string().default('docs/test.md'),
  }).default({
    prd: 'docs/prd.md',
    tech: 'docs/tech.md',
    impl: 'docs/impl.md',
    test: 'docs/test.md',
  }),
  roles: z.object({
    supervisor: z.string().default('agents/supervisor.md'),
    builder: z.string().default('agents/builder.md'),
  }).default({
    supervisor: 'agents/supervisor.md',
    builder: 'agents/builder.md',
  }),
  checks: z.array(z.string()).default(['npm run build', 'npm test']),
  checkTimeoutMin: z.number().positive().default(10),
  pollIntervalSec: z.number().positive().default(5),
  maxRetryPerTask: z.number().int().min(1).default(5),
  onMaxRetry: OnMaxRetrySchema.default('human'),
  onError: OnErrorSchema.default('retry'),
  maxDiffKB: z.number().positive().default(64),
  staleThresholdMin: z.number().min(0).default(0),
});

export type BridgeConfig = z.infer<typeof BaseConfigSchema>;

/**
 * 递归替换字符串中的 ${VAR_NAME}
 */
function interpolateString(
  val: string,
  env: Record<string, string | undefined>
): string {
  const regex = /\$\{([A-Za-z0-9_]+)\}/g;
  return val.replace(regex, (_, varName) => {
    const envVal = env[varName];
    if (envVal === undefined) {
      throw new ConfigError(`缺少环境变量: ${varName}`);
    }
    return envVal;
  });
}

function interpolateValue(
  value: unknown,
  env: Record<string, string | undefined>
): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, env));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, env);
    }
    return result;
  }
  return value;
}

/**
 * 加载并校验配置
 */
export function loadConfig(
  configPath: string = '.bridge.config.json',
  customEnv?: Record<string, string | undefined>
): BridgeConfig {
  const env = customEnv ?? process.env;
  const resolvedPath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`配置文件不存在: ${configPath}`);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`读取配置文件失败: ${msg}`);
  }

  let rawJson: Record<string, unknown>;
  try {
    rawJson = JSON.parse(rawContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`配置文件 JSON 解析失败: ${msg}`);
  }

  if (typeof rawJson !== 'object' || rawJson === null || Array.isArray(rawJson)) {
    throw new ConfigError('配置文件内容必须为 JSON 对象');
  }

  // 先基础检验 mode 是否合法
  const supObj = rawJson.supervisor as Record<string, unknown> | undefined;
  const bldObj = rawJson.builder as Record<string, unknown> | undefined;

  const supervisorMode = supObj?.mode;
  const builderMode = bldObj?.mode;

  const parsedSupervisorMode = SupervisorModeSchema.safeParse(supervisorMode);
  if (!parsedSupervisorMode.success) {
    throw new ConfigError(`supervisor.mode 非法: ${String(supervisorMode)}`);
  }

  const parsedBuilderMode = BuilderModeSchema.safeParse(builderMode);
  if (!parsedBuilderMode.success) {
    throw new ConfigError(`builder.mode 非法: ${String(builderMode)}`);
  }

  // 按模式有选择地对必需字段进行环境变量插值
  const processedJson: Record<string, unknown> = { ...rawJson };

  // supervisor 模式插值
  const processedSup = { ...supObj };
  if (parsedSupervisorMode.data === 'api') {
    if (processedSup.apiKey !== undefined) {
      processedSup.apiKey = interpolateValue(processedSup.apiKey, env);
    }
    if (processedSup.baseURL !== undefined) {
      processedSup.baseURL = interpolateValue(processedSup.baseURL, env);
    }
    if (processedSup.model !== undefined) {
      processedSup.model = interpolateValue(processedSup.model, env);
    }
  } else if (parsedSupervisorMode.data === 'cli') {
    if (processedSup.cli !== undefined) {
      processedSup.cli = interpolateValue(processedSup.cli, env) as typeof processedSup.cli;
    }
  }
  processedJson.supervisor = processedSup;

  // builder 模式插值
  const processedBld = { ...bldObj };
  if (parsedBuilderMode.data === 'cli') {
    if (processedBld.command !== undefined) {
      processedBld.command = interpolateValue(processedBld.command, env) as string;
    }
    if (processedBld.args !== undefined) {
      processedBld.args = interpolateValue(processedBld.args, env) as string[];
    }
  }
  processedJson.builder = processedBld;

  // 其余通用字段插值（docs, roles, checks 等）
  for (const key of Object.keys(processedJson)) {
    if (key !== 'supervisor' && key !== 'builder') {
      processedJson[key] = interpolateValue(processedJson[key], env);
    }
  }

  // Zod 整体校验与默认值应用
  const parseResult = BaseConfigSchema.safeParse(processedJson);
  if (!parseResult.success) {
    const issueMsgs = parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`配置格式校验失败: ${issueMsgs}`);
  }

  const config = parseResult.data;

  // 按模式进一步校验必填项
  if (config.supervisor.mode === 'api') {
    if (!config.supervisor.provider) {
      throw new ConfigError('supervisor.mode 为 api 时必须指定 supervisor.provider (claude | openai)');
    }
    if (!config.supervisor.apiKey) {
      throw new ConfigError('supervisor.mode 为 api 时必须指定 supervisor.apiKey');
    }
    if (!config.supervisor.model) {
      throw new ConfigError('supervisor.mode 为 api 时必须指定 supervisor.model');
    }
  } else if (config.supervisor.mode === 'cli') {
    if (!config.supervisor.cli || !config.supervisor.cli.command) {
      throw new ConfigError('supervisor.mode 为 cli 时必须配置 supervisor.cli.command');
    }
  }

  if (config.builder.mode === 'cli') {
    if (!config.builder.command) {
      throw new ConfigError('builder.mode 为 cli 时必须配置 builder.command');
    }
  }

  return config;
}
