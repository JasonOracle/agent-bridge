/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 新建 cli 命令行的冒烟与帮助参数单测]
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('CLI 入口骨架测试', () => {
  it('node dist/cli.js --help 能够正常输出并列出全部 5 个命令', () => {
    const cliPath = path.resolve(__dirname, '../dist/cli.js');
    const output = execSync(`node "${cliPath}" --help`, { encoding: 'utf-8' });

    expect(output).toContain('init');
    expect(output).toContain('watch');
    expect(output).toContain('once');
    expect(output).toContain('status');
    expect(output).toContain('resolve');
  });
});
