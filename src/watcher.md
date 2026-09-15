# 守护调度模块 (`watcher.ts`)

### 💡 核心思想
作为 Agent-Bridge 架构的唯一主驱动中枢，负责执行守护主循环（Watch Loop）或单步调度（Once Command）。主循环通过基于固定时间间隔（默认 5s）的文件轮询，驱动状态机推进。Watcher 具备自愈能力：检测中断遗留的陈旧 `IN_*` 状态并自动断点续跑；检测非法状态篡改并安全回滚；按 `onError` 策略进行自动重试或人工熔断。

### 💻 使用示例
```ts
import { startWatcher, executeOnce } from './watcher.js';
import { loadConfig } from './config.js';

const config = loadConfig();

// 单步调试运行当前状态对应半循环
await executeOnce({ config, dryRun: true });

// 启动守护进程
await startWatcher({ config });
```
