# 状态机模块 (`state.ts`)

### 💡 核心思想
管理项目的核心协同协议文件 `bridge.md`。将文件严格划分为机器可读的 YAML 块和供人类/AI 阅读的自由区。任何对 `bridge.md` 的写入均遵循“临时文件落盘 -> `fs.renameSync` 原子替换”机制，杜绝并发竞争或半写入损坏。Watcher 每个 Tick 均进行迁移合法性与陈旧超时校验，非法篡改状态时强制回滚并报警。

### 💻 使用示例
```ts
import { readBridge, writeBridge, isStaleState, isValidTransition } from './state.js';

// 读取状态
const { state, freeZone } = readBridge('bridge.md');

// 校验迁移合法性
if (isValidTransition(state.status, 'IN_DEV')) {
  // 原子更新状态
  writeBridge('bridge.md', {
    ...state,
    status: 'IN_DEV',
    updated_at: new Date().toISOString()
  }, freeZone);
}
```
