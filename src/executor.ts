/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现命令执行器，支持超时强杀（SIGTERM + SIGKILL 兜底）; 2. 实现尾部 256KB 环形输出捕获与 Windows shell 兼容]
 */

import { execa, type Options as ExecaOptions } from 'execa';

export interface ExecutorOptions {
  cwd?: string;
  timeoutMs?: number;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutorResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 环形缓冲辅助类：保留最新的 maxBytes 字节输出
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private totalLength = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 256 * 1024) {
    this.maxBytes = maxBytes;
  }

  append(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(buf);
    this.totalLength += buf.length;

    // 当超出限制且第一个 chunk 移除后依然满足超限时，丢弃旧 chunk
    while (this.chunks.length > 1 && this.totalLength - this.chunks[0].length >= this.maxBytes) {
      this.totalLength -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  toString(encoding: BufferEncoding = 'utf-8'): string {
    const combined = Buffer.concat(this.chunks);
    if (combined.length <= this.maxBytes) {
      return combined.toString(encoding);
    }
    return combined.subarray(combined.length - this.maxBytes).toString(encoding);
  }
}

/**
 * 执行系统命令
 * - 默认 shell: false（Windows 下特定 checks 命令可通过 options.shell 开启）
 * - 超时到期先发 SIGTERM，5 秒未退出强杀 SIGKILL
 * - stdout/stderr 各保留尾部 256KB
 */
export async function run(
  cmd: string[],
  options: ExecutorOptions = {}
): Promise<ExecutorResult> {
  if (cmd.length === 0) {
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  }

  const [file, ...args] = cmd;
  const isWindows = process.platform === 'win32';
  const useShell = options.shell ?? false;

  const stdoutBuf = new TailBuffer(256 * 1024);
  const stderrBuf = new TailBuffer(256 * 1024);

  const execaOpts: ExecaOptions = {
    cwd: options.cwd ?? process.cwd(),
    shell: useShell,
    reject: false,
    env: options.env ?? process.env,
    buffer: false,
    ...(options.timeoutMs && options.timeoutMs > 0
      ? {
          timeout: options.timeoutMs,
          killSignal: 'SIGTERM',
          forceKillAfterDelay: 5000,
        }
      : {}),
  };

  let proc;
  if (useShell && isWindows) {
    // Windows 下启用 shell 时，若直接传 file 与 args 可能因空格或路径转义受限，整合成完整命令字符串
    const fullCmd = [file, ...args].join(' ');
    proc = execa(fullCmd, { ...execaOpts, shell: true });
  } else {
    proc = execa(file, args, execaOpts);
  }

  proc.stdout?.on('data', (chunk) => stdoutBuf.append(chunk));
  proc.stderr?.on('data', (chunk) => stderrBuf.append(chunk));

  const result = await proc;

  return {
    code: result.exitCode ?? (result.timedOut ? null : 1),
    stdout: stdoutBuf.toString(),
    stderr: stderrBuf.toString(),
    timedOut: Boolean(result.timedOut),
  };
}
