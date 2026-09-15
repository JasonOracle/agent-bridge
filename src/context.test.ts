/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加上下文组装单测：严格断言施工提示词不含 PRD 内容，断言 review-request 含四件套文档、diff 与日志，测试临时文件创建与回收]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assembleBuilderPrompt,
  assembleReviewRequest,
  createPromptFile,
  removePromptFile,
  extractTaskSection,
} from './context.js';

describe('上下文组装模块 (src/context.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-context-test-'));

    // 准备模拟文档
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'prompts'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'docs/prd.md'),
      '# 产品需求文档 PRD\n用户体验至上，这是一个极具创新性的绝密产品需求句子。'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs/tech.md'),
      '# 技术规范 TECH\n使用 TypeScript 和 Node.js 进行开发。'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs/test.md'),
      '# 测试规范 TEST\n使用 vitest 进行单元测试。'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs/impl.md'),
      '# 任务清单\n- [ ] T1: 初始化工程\n  - 验收: 命令可用\n- [ ] T2: 核心功能\n  - 验收: 测试通过\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'agents/builder.md'),
      '# 施工方规范\n严禁修改文档。'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'agents/supervisor.md'),
      '# 监工规范\n只看证据下结论。'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'prompts/builder-cli.md'),
      '{{ROLE_BUILDER}}\n{{DOCS_TECH}}\n{{TASK}}\n{{INSTRUCTIONS}}'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. 施工提示词：严格断言不含 prd.md 的任何句子，包含 tech 与对应 task', () => {
    const prompt = assembleBuilderPrompt({
      baseDir: tmpDir,
      taskId: 'T2',
      instructions: '请修改状态机',
    });

    // 核心红线：施工提示词绝不包含 PRD 内容
    expect(prompt).not.toContain('产品需求文档 PRD');
    expect(prompt).not.toContain('绝密产品需求句子');

    // 必须包含技术规范、角色与任务
    expect(prompt).toContain('使用 TypeScript 和 Node.js 进行开发');
    expect(prompt).toContain('严禁修改文档');
    expect(prompt).toContain('T2: 核心功能');
    expect(prompt).toContain('请修改状态机');
  });

  it('2. 验收材料 review-request.md：包含四件套文档(PRD/Tech/Test/Impl)、diff 与 checks 日志', () => {
    const reviewMd = assembleReviewRequest({
      baseDir: tmpDir,
      taskId: 'T1',
      round: 2,
      diff: '+const a = 1;',
      checksLog: 'PASS src/cli.test.ts',
      untrackedFiles: ['newfile.ts'],
    });

    expect(reviewMd).toContain('绝密产品需求句子'); // 监工必须包含 PRD
    expect(reviewMd).toContain('使用 TypeScript 和 Node.js 进行开发'); // Tech
    expect(reviewMd).toContain('使用 vitest 进行单元测试'); // Test
    expect(reviewMd).toContain('T1: 初始化工程'); // Task section
    expect(reviewMd).toContain('+const a = 1;'); // Diff
    expect(reviewMd).toContain('PASS src/cli.test.ts'); // Checks log
    expect(reviewMd).toContain('newfile.ts'); // Untracked files
  });

  it('3. extractTaskSection：准确提取单个任务段落', () => {
    const content = `- [ ] T1: 任务一
  - 详情一
- [ ] T2: 任务二
  - 详情二
- [ ] T3: 任务三`;

    const t2 = extractTaskSection(content, 'T2');
    expect(t2).toContain('T2: 任务二');
    expect(t2).toContain('- 详情二');
    expect(t2).not.toContain('T1: 任务一');
    expect(t2).not.toContain('T3: 任务三');
  });

  it('4. createPromptFile & removePromptFile：临时文件安全落盘与清理', () => {
    const content = 'Hello Prompt Content';
    const filePath = createPromptFile(content, 'test-prompt', tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);

    removePromptFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
