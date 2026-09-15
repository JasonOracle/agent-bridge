# 辅助命令模块 (`commands.ts`)

### 💡 核心思想
承载 `status` 与 `resolve` 命令的核心业务逻辑：
1. **`getStatus`**：统计输出当前的 `bridge.md` 状态机指针、`impl.md` 任务完成度（已完成/跳过/总数）以及最近 5 条评审日志。
2. **`resolveNeedsHuman`**：当系统陷入人工熔断状态 `NEEDS_HUMAN` 时，人工介入修复后恢复为 `PENDING_DEV` 并清零重试计数；或通过 `--skip` 将当前任务标记为 `- [-]` 跳过并前进到下一任务。

### 💻 使用示例
```ts
import { getStatus, resolveNeedsHuman } from './commands.js';

// 查看状态
const status = getStatus();
console.log(`当前进度: ${status.progress.done}/${status.progress.total}`);

// 人工恢复
resolveNeedsHuman({ skip: false });
```
