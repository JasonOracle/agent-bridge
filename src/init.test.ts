/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加 init 命令单测：测试在临时目录生成完整骨架、防覆盖跳过与 --force 强制覆盖]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from './init.js';

describe('项目初始化命令 (src/init.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. 首次在空目录执行 init：文件齐全生成且 .gitignore 自动追加规则', () => {
    const res = runInit({ cwd: tmpDir, force: false });

    expect(res.created).toContain('docs/prd.md');
    expect(res.created).toContain('docs/tech.md');
    expect(res.created).toContain('docs/impl.md');
    expect(res.created).toContain('docs/test.md');
    expect(res.created).toContain('agents/supervisor.md');
    expect(res.created).toContain('agents/builder.md');
    expect(res.created).toContain('prompts/builder-cli.md');
    expect(res.created).toContain('bridge.md');
    expect(res.created).toContain('.bridge.config.json');

    // 检查磁盘真实文件
    expect(fs.existsSync(path.join(tmpDir, 'docs/prd.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'bridge.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.bridge.config.json'))).toBe(true);

    // 检查 .gitignore 追加
    const gitignoreContent = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignoreContent).toContain('.bridge/');
    expect(gitignoreContent).toContain('.bridge.config.json');
  });

  it('2. 重复执行 init：未加 --force 时默认跳过已存在文件', () => {
    // 第一次
    runInit({ cwd: tmpDir, force: false });

    // 修改一个文件以作标记
    fs.writeFileSync(path.join(tmpDir, 'bridge.md'), '# Human Custom Bridge');

    // 第二次执行（不带 force）
    const secondRes = runInit({ cwd: tmpDir, force: false });

    expect(secondRes.skipped).toContain('bridge.md');
    expect(secondRes.skipped).toContain('docs/prd.md');
    expect(secondRes.skipped).toContain('.bridge.config.json');

    // 确认内容未被覆盖
    expect(fs.readFileSync(path.join(tmpDir, 'bridge.md'), 'utf-8')).toBe('# Human Custom Bridge');
  });

  it('3. 使用 --force 执行 init：强制覆盖已存在文件', () => {
    runInit({ cwd: tmpDir, force: false });
    fs.writeFileSync(path.join(tmpDir, 'bridge.md'), '# Human Custom Bridge');

    // 带 force: true 覆盖
    const forceRes = runInit({ cwd: tmpDir, force: true });
    expect(forceRes.created).toContain('bridge.md');
    expect(fs.readFileSync(path.join(tmpDir, 'bridge.md'), 'utf-8')).not.toBe('# Human Custom Bridge');
  });
});
