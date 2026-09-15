# 流水线编排模块 (`pipeline.ts`)

### 💡 核心思想
管理“开发半循环”与“验收半循环”的核心控制流：
1. **验收半循环**：检查自上一批准 commit 以来是否有新增提交（无新 commit 直接打回未提交代码）；执行 `checks` 本地自动化命令；组装 `review-request.md` 并原子写盘后翻转为 `IN_REVIEW`；根据 Verdict 裁决更新 `impl.md` 进度、`lastApprovedCommit` 与状态流转。
2. **开发半循环**：置位 `IN_DEV`；根据模式唤起 CLI（Mode A）或等待 IDE 定时会话（Mode B）。

### 💻 使用示例
```ts
import { runReviewHalf, runDevHalf } from './pipeline.js';
import { loadConfig } from './config.js';

const config = loadConfig();

// 单步执行验收半循环
await runReviewHalf({ config });

// 单步执行开发半循环
await runDevHalf({ config });
```
