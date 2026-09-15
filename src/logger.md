# 审计日志模块 (`logger.ts`)

### 💡 核心思想
管理 `.bridge/state.json` 权威内部状态（记录 `lastApprovedCommit`、累计 Token 消耗与启动时间）以及 `.bridge/logs/` 下的永久不可篡改审计日志。每轮验收均如实生成 `T{taskId}-r{round}-{verdict}.md`，开发异常生成 `dev-error.md`，完整记录原始 Verdict、全量未截断 Diff 与终端输出，作为复盘现场。

### 💻 使用示例
```ts
import { saveReviewAuditLog, updateLastApprovedCommit, addTokens } from './logger.js';

// 记录评审日志
saveReviewAuditLog({
  taskId: 'T1',
  round: 1,
  verdict: 'approve',
  diffFull: 'diff --git a/src/index.ts...',
  checksOutput: 'All tests passed',
  supervisorRawOutput: '{"verdict": "approve"}',
  parsedVerdict: { verdict: 'approve', taskId: 'T1' }
});

// 更新内部状态
updateLastApprovedCommit('a1b2c3d');
addTokens(1200, 300);
```
