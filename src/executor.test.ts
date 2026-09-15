/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加执行器单测：正常执行、超时强杀、环形缓冲截断测试]
 */

import { describe, it, expect } from 'vitest';
import { run, TailBuffer } from './executor.js';

describe('执行器模块 (src/executor.ts)', () => {
  it('1. 正常执行：捕获退出码与 stdout/stderr', async () => {
    const res = await run(['node', '-e', 'console.log("hello"); console.error("world");']);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.stderr.trim()).toBe('world');
    expect(res.timedOut).toBe(false);
  });

  it('2. 超时强杀：达到 timeoutMs 时子进程被终止并标记 timedOut', async () => {
    const start = Date.now();
    const res = await run(['node', '-e', 'setInterval(() => {}, 1000);'], {
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;

    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(4000); // 确认没有挂起
  });

  it('3. TailBuffer 环形缓冲：输出超出限制时只保留尾部', () => {
    const buf = new TailBuffer(100); // 限制 100 字节
    const bigString1 = 'A'.repeat(80);
    const bigString2 = 'B'.repeat(80);

    buf.append(bigString1);
    buf.append(bigString2);

    const out = buf.toString();
    expect(out.length).toBe(100);
    expect(out.endsWith('B'.repeat(80))).toBe(true);
    expect(out.startsWith('A'.repeat(20))).toBe(true);
  });

  it('4. Windows / 跨平台 Shell 兼容执行', async () => {
    const res = await run(['node', '-v'], { shell: true });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\./);
  });
});
