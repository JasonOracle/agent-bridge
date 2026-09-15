/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加 git 模块单测：在真实临时仓库构造 3 个 commit 验证 HEAD、commit 检测、diff 收集与超限截断]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  getHeadCommit,
  hasNewCommitSince,
  collectDiff,
  getUntrackedFiles,
} from './gittool.js';

describe('Git 模块 (src/gittool.ts)', () => {
  let tmpRepo: string;
  let commit1: string;
  let commit2: string;
  let commit3: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-git-test-'));

    // 初始化临时仓库并配置作者
    execSync('git init', { cwd: tmpRepo });
    execSync('git config user.name "Tester"', { cwd: tmpRepo });
    execSync('git config user.email "tester@test.com"', { cwd: tmpRepo });

    // Commit 1
    fs.writeFileSync(path.join(tmpRepo, 'file1.txt'), 'Hello 1\n');
    execSync('git add -A && git commit -m "commit 1"', { cwd: tmpRepo });
    commit1 = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim();

    // Commit 2
    fs.writeFileSync(path.join(tmpRepo, 'file2.txt'), 'Hello 2\n');
    execSync('git add -A && git commit -m "commit 2"', { cwd: tmpRepo });
    commit2 = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim();

    // Commit 3
    fs.writeFileSync(path.join(tmpRepo, 'file3.txt'), 'Hello 3\n');
    execSync('git add -A && git commit -m "commit 3"', { cwd: tmpRepo });
    commit3 = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim();
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('1. getHeadCommit 准确返回最新的 commit3', async () => {
    const head = await getHeadCommit(tmpRepo);
    expect(head).toBe(commit3);
  });

  it('2. hasNewCommitSince 准确判断是否有新提交', async () => {
    // 相比 commit1 有新提交
    expect(await hasNewCommitSince(commit1, tmpRepo)).toBe(true);
    // 相比 commit2 有新提交
    expect(await hasNewCommitSince(commit2, tmpRepo)).toBe(true);
    // 相比 commit3 无新提交
    expect(await hasNewCommitSince(commit3, tmpRepo)).toBe(false);
  });

  it('3. collectDiff 小于阈值时不截断', async () => {
    const res = await collectDiff(commit2, 64, tmpRepo);
    expect(res.truncated).toBe(false);
    expect(res.diff).toContain('file3.txt');
    expect(res.diff).toContain('+Hello 3');
  });

  it('4. collectDiff 超出阈值时降级为 stat 并截断', async () => {
    // 构造一个大于 250 行且超过限制的修改
    const longContent = Array.from({ length: 300 }, (_, i) => `line ${i}: ${'x'.repeat(100)}`).join('\n');
    fs.writeFileSync(path.join(tmpRepo, 'big.txt'), longContent);
    execSync('git add -A && git commit -m "big commit"', { cwd: tmpRepo });

    // 设置 maxKB 为 1KB，确保必定触发超限截断
    const res = await collectDiff(commit3, 1, tmpRepo);
    expect(res.truncated).toBe(true);
    expect(res.diff).toContain('... [truncated]');
    expect(res.diff).toContain('big.txt');
  });

  it('5. 能够正确识别未跟踪文件', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'untracked.txt'), 'new file');
    const untracked = await getUntrackedFiles(tmpRepo);
    expect(untracked).toContain('untracked.txt');

    const diffRes = await collectDiff(commit3, 64, tmpRepo);
    expect(diffRes.untracked).toContain('untracked.txt');
  });
});
