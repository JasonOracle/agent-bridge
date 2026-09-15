# Git 模块 (`gittool.ts`)

### 💡 核心思想
专门负责获取代码提交变更与 Diff 数据。当施工方提交的代码差异未超过 `maxDiffKB` 时，提取完整 diff；若 diff 过大（例如生成了大型构建文件或依赖变更），自动降级为 `--stat` 统计概览 + 每个文件前 200 行 diff 并标注 `[truncated]`，防止大模型上下文超限。此外负责检测未提交代码与未跟踪文件。

### 💻 使用示例
```ts
import { getHeadCommit, collectDiff, hasNewCommitSince } from './gittool.js';

const lastCommit = 'a1b2c3d';
if (await hasNewCommitSince(lastCommit)) {
  const { diff, truncated, untracked } = await collectDiff(lastCommit, 64);
  console.log(`Diff 大小: ${diff.length}, 是否被截断: ${truncated}`);
}
```
