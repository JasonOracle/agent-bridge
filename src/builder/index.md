# 施工分发入口 (`builder/index.ts`)

### 💡 核心思想
管理底层施工 Agent（开发工程师）的唤起与流转契约：
- **`cli`（Mode A）**：由桥接器主动 spawn 无头开发工具（如 Claude Code CLI），通过 `{promptFile}` 避免命令行长度超限；进程结束后校验 `bridge.md` 是否成功翻转至 `PENDING_REVIEW`。
- **`watch`（Mode B）**：适用于 IDE 场景（WorkBuddy、Antigravity），桥接器不主动 spawn，而是等待 IDE 侧定时任务执行并翻转状态。
若发生超时或未翻转，均记入错误并触发重试机制。

### 💻 使用示例
```ts
import { runBuilder } from './builder/index.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const res = await runBuilder({
  config,
  prompt: '请实现 T1 任务'
});

if (!res.success) {
  console.error(`施工失败: ${res.error}`);
}
```
