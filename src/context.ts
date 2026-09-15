/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现施工提示词组装（严格不注入 prd.md，支持 {promptFile} 临时文件）; 2. 实现 review-request.md 验收材料组装（含四件套文档、当前任务、diff与Checks日志）]
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AssembleBuilderOptions {
  baseDir?: string;
  taskId: string;
  templatePath?: string;
  roleBuilderPath?: string;
  techPath?: string;
  implPath?: string;
  instructions?: string;
  hasUncommittedChanges?: boolean;
}

export interface AssembleReviewRequestOptions {
  baseDir?: string;
  taskId: string;
  round: number;
  roleSupervisorPath?: string;
  prdPath?: string;
  techPath?: string;
  testPath?: string;
  implPath?: string;
  diff: string;
  diffTruncated?: boolean;
  untrackedFiles?: string[];
  checksLog: string;
}

function readFileOrDefault(filePath: string, fallback: string = ''): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return fallback;
}

/**
 * 从 impl.md 中提取指定 taskId 的任务段落
 */
export function extractTaskSection(implContent: string, taskId: string): string {
  const normalized = implContent.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const startIndex = lines.findIndex((line) => {
    return (
      line.match(new RegExp(`^\\s*-\\s*\\[[ x\\-]\\]\\s*${taskId}:`, 'i')) ||
      line.match(new RegExp(`^\\s*-\\s*\\[[ x\\-]\\]\\s*T\\d+:.*${taskId}`, 'i'))
    );
  });

  if (startIndex === -1) {
    return `任务 ${taskId}: 详见任务清单`;
  }

  const resultLines: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // 若遇到下一个顶级任务项（- [ ]），则提取结束
    if (/^\s*-\s*\[[ x\-]\]\s*T\d+:/i.test(line)) {
      break;
    }
    resultLines.push(line);
  }

  return resultLines.join('\n').trim();
}

/**
 * 组装施工提示词（严格禁止注入 prd.md）
 */
export function assembleBuilderPrompt(options: AssembleBuilderOptions): string {
  const baseDir = options.baseDir ?? process.cwd();
  const templatePath = path.resolve(baseDir, options.templatePath ?? 'prompts/builder-cli.md');
  const rolePath = path.resolve(baseDir, options.roleBuilderPath ?? 'agents/builder.md');
  const techPath = path.resolve(baseDir, options.techPath ?? 'docs/tech.md');
  const implPath = path.resolve(baseDir, options.implPath ?? 'docs/impl.md');

  const templateContent = readFileOrDefault(templatePath, '{{ROLE_BUILDER}}\n{{DOCS_TECH}}\n{{TASK}}\n{{INSTRUCTIONS}}');
  const roleContent = readFileOrDefault(rolePath, '施工工程师角色规范');
  const techContent = readFileOrDefault(techPath, '技术文档与规范');
  const implContent = readFileOrDefault(implPath, '');
  const taskSection = extractTaskSection(implContent, options.taskId);

  let instructions = (options.instructions ?? '').trim();
  if (!instructions) {
    instructions = '（首轮无修改意见，请按任务与验收标准直接实现）';
  }
  if (options.hasUncommittedChanges) {
    instructions += '\n\n【注意】：工作区检测到上一轮遗留的未提交修改，请先评估改动质量（补完提交或清理丢弃），避免产生半成品代码。';
  }

  // 占位符替换
  let prompt = templateContent
    .replace(/\{\{ROLE_BUILDER\}\}/g, roleContent)
    .replace(/\{\{DOCS_TECH\}\}/g, techContent)
    .replace(/\{\{TASK\}\}/g, taskSection)
    .replace(/\{\{TASK_ID\}\}/g, options.taskId)
    .replace(/\{\{INSTRUCTIONS\}\}/g, instructions);

  return prompt;
}

/**
 * 组装监工验收材料 review-request.md
 */
export function assembleReviewRequest(options: AssembleReviewRequestOptions): string {
  const baseDir = options.baseDir ?? process.cwd();
  const rolePath = path.resolve(baseDir, options.roleSupervisorPath ?? 'agents/supervisor.md');
  const prdPath = path.resolve(baseDir, options.prdPath ?? 'docs/prd.md');
  const techPath = path.resolve(baseDir, options.techPath ?? 'docs/tech.md');
  const testPath = path.resolve(baseDir, options.testPath ?? 'docs/test.md');
  const implPath = path.resolve(baseDir, options.implPath ?? 'docs/impl.md');

  const roleContent = readFileOrDefault(rolePath);
  const prdContent = readFileOrDefault(prdPath);
  const techContent = readFileOrDefault(techPath);
  const testContent = readFileOrDefault(testPath);
  const implContent = readFileOrDefault(implPath);
  const taskSection = extractTaskSection(implContent, options.taskId);

  // Checks 日志截断至尾部 32KB
  const maxChecksBytes = 32 * 1024;
  let checksLog = options.checksLog;
  const checksBuffer = Buffer.from(checksLog, 'utf-8');
  if (checksBuffer.length > maxChecksBytes) {
    checksLog = `... [前序输出已截断，保留尾部 32KB]\n` + checksBuffer.subarray(checksBuffer.length - maxChecksBytes).toString('utf-8');
  }

  const untrackedText = options.untrackedFiles && options.untrackedFiles.length > 0
    ? options.untrackedFiles.map((f) => `- ${f}`).join('\n')
    : '无未跟踪文件';

  const diffSection = options.diffTruncated
    ? `> 注意：本次变更 Diff 超限，已降级为 stat 统计并对单个文件超 200 行部分截断\n\n\`\`\`diff\n${options.diff}\n\`\`\``
    : `\`\`\`diff\n${options.diff || '(无代码 diff)'}\n\`\`\``;

  return `# 验收申请 (Review Request): ${options.taskId} - Round ${options.round}

## 1. 监工角色规范与输出契约
${roleContent}

## 2. 待验收任务
- 任务 ID: ${options.taskId}
- 当前轮次: ${options.round}
- 任务要求与验收标准:
${taskSection}

## 3. 本地自动化校验结果 (Checks Output)
\`\`\`
${checksLog || '(无校验输出)'}
\`\`\`

## 4. 本轮代码变更 (Git Diff)
${diffSection}

### 未跟踪文件列表
${untrackedText}

## 5. 项目背景与技术依据
### 产品需求摘要 (PRD)
${prdContent}

### 技术规范 (Tech Spec)
${techContent}

### 测试规范 (Test Spec)
${testContent}
`.replace(/\r\n/g, '\n');
}

/**
 * 创建 {promptFile} 临时文件于 .bridge/tmp/
 */
export function createPromptFile(
  content: string,
  prefix: string = 'prompt',
  baseDir: string = process.cwd()
): string {
  const tmpDir = path.resolve(baseDir, '.bridge', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const fileName = `${prefix}-${Date.now()}-${process.pid}.txt`;
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 安全删除临时 prompt 文件
 */
export function removePromptFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // 忽略删除失败
  }
}
