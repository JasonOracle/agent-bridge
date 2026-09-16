# 协议规范 (Protocol Specification)

为了保证完全解耦，Agent-Bridge 所有的通信均依赖于项目根目录下的特定文件结构。任何支持读写本地文件的脚本或 Agent，只要遵循本协议，即可无缝接入本协作网络。

## 1. 核心状态机 (`bridge.md`)

`bridge.md` 是整个系统的心脏。它必须位于项目的根目录下。
它的结构由顶部的 **YAML Frontmatter** 与下方的 **Markdown 内容** 组成。

### 1.1 YAML 数据规范

每个字段都严格定义了当前的流水线状态：

```yaml
status: PENDING_DEV      # 当前状态，见下方七态说明
task_id: T1              # 对应 docs/impl.md 中的任务 ID
round: 1                 # 当前处于第几次迭代（被打回则递增）
retry: 0                 # 重试次数（预防 API 崩溃死循环用）
updated_at: 2026-09-16T12:00:00.000Z # 最后修改时间
last_commit: abc1234     # 与该状态绑定的 Git Commit Hash
error: null              # 如果发生系统级错误，记录于此
```

### 1.2 七态说明 (State Definitions)

- `PENDING_DEV`：施工方可获取控制权，准备开始开发。
- `IN_DEV`：施工方正在开发中，独占锁定工作区。
- `PENDING_REVIEW`：施工方开发完成，等待监工方审查。
- `IN_REVIEW`：监工方正在审查代码，独占锁定工作区。
- `REJECTED`：审查未通过。施工方在下一个 Tick 被唤醒进行修复。
- `APPROVED`：审查通过，当前 `task_id` 完成，进入下个任务的 `PENDING_DEV`。
- `COMPLETED`：所有任务完成，守护进程自动关闭。

## 2. 审查裁决文件 (`verdict.json`)

当监工方完成审查后，它必须在 `.bridge/verdict.json` 中写入裁决结果。看门狗会读取此文件进行状态翻转。

```json
{
  "verdict": "approve", // 只能是 "approve" 或 "reject"
  "issues": [
    // 如果 reject，这里必须填入详尽的打回原因，供 Builder 阅读
    "Line 45: Missing TypeScript type definition.",
    "Failed to pass 'npm run test'."
  ],
  "task_id": "T1",
  "round": 1
}
```

## 3. 防碰撞目录 (`.bridge/`)

系统会自动在项目下生成 `.bridge/` 隐藏目录，用于存放临时信号文件：
- `.bridge/builder.pid`：施工方的进程存活探针。
- `.bridge/watchdog.lock`：防止启动多个看门狗进程。
