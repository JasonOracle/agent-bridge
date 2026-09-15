# 执行器组件 (`executor.ts`)

### 💡 核心思想
基于 `execa` 封装的安全子进程执行器。针对长时间或可能挂起的 Agent CLI，内置两阶段超时机制（首先发送 `SIGTERM`，超时 5 秒未退出则强制 `SIGKILL`）。针对海量终端日志输出，通过 `TailBuffer` 环形缓冲仅保留最新尾部 256KB 内容，既防爆内存又保留完整的故障现场日志。

### 💻 使用示例
```ts
import { run } from './executor.js';

// 执行常规命令（带超时控制）
const res = await run(['npm', 'test'], {
  timeoutMs: 30000,
  shell: process.platform === 'win32'
});

if (res.timedOut) {
  console.error('命令执行超时并被强杀');
} else {
  console.log(`退出码: ${res.code}, stdout: ${res.stdout}`);
}
```
