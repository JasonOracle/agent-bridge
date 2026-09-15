# 响应式双端协作协议 (Reactive Agent Collaboration Protocol)

本规范定义了任意两个 AI 工具（施工方/Builder 与 监工方/Supervisor）如何通过共享状态文件（`bridge.md`）进行零人工干预的自动化协作开发。

## 1. `bridge.md` 格式规范

`bridge.md` 是系统的核心状态存储文件。它分为严格的**机器区（YAML）**和**自由区（Markdown）**两部分。

### 1.1 机器区 YAML 字段定义

机器区必须位于文件的最开头，使用 YAML 格式包裹在 ` ```yaml ` 和 ` ``` ` 之中。

```yaml
status: PENDING_DEV
task_id: T1
round: 1
retry: 0
updated_at: 2026-09-15T14:30:00+08:00
last_commit: null
error: null
```

| 字段 | 类型 | 必填 | 描述 | 取值范围/约束 |
|---|---|---|---|---|
| `status` | string | 是 | 当前任务状态 | 详见第 2 节的 7 态定义 |
| `task_id` | string \| null | 是 | 当前处理的任务 ID | `T\d+` (如 T1, T2)；无任务时为 `null` |
| `round` | integer | 是 | 当前任务的审查轮次 | `>= 1`；每次 approve/reject 推进下一轮时重置或递增 |
| `retry` | integer | 是 | 错误或打回的重试次数 | `>= 0`；超过 `maxRetryPerTask` 将触发熔断 |
| `updated_at`| string | 是 | 状态最后更新时间 | 必须是符合 ISO 8601 的时间戳（含时区） |
| `last_commit`| string \| null | 是 | 施工方最后一次提交的 hash | 7 位短 hash，或 `null` |
| `error` | string \| null | 是 | 错误信息 | 无错误时为 `null` |

### 1.2 自由区结构

自由区紧跟在机器区之后。必须包含以下两个固定的一级/二级标题，以便解析和注入上下文：

```markdown
## 本轮指令
（初始化说明，或者明确的任务执行指令）

## 上轮评审摘要
（若发生 reject 打回，此处会包含 Supervisor 给出的明确修改意见）
```

### 1.3 原子写入规则

为了防止读写冲突（竞态条件），任何对 `bridge.md` 的修改必须满足**原子写入**：
1. 将新内容写入同一目录下的临时文件（如 `bridge.md.tmp`）。
2. 使用系统级别的重命名操作（如 `fs.renameSync` 或 `mv bridge.md.tmp bridge.md`）覆盖原文件。
3. **严禁**直接打开 `bridge.md` 截断覆盖。

---

## 2. 核心状态机（七态）

系统运行遵循严格的状态流转，由 Watchdog 充当仲裁者和推进者。

### 2.1 状态枚举与写入方

| 状态 | 写入方（谁负责将其写入） | 含义 |
|---|---|---|
| `PENDING_DEV` | **Watchdog**（初始化/下发新任务/打回重试） | 任务待开发。Builder 会在此状态被唤醒。 |
| `IN_DEV` | **Builder**（施工方 AI 工具） | 独占锁。Builder 确认开工时写入。 |
| `PENDING_REVIEW` | **Builder**（施工方 AI 工具） | 开发完成并提交代码后写入。 |
| `IN_REVIEW` | **Watchdog** | 独占锁。Watchdog 预组装完审查材料后写入。 |
| `NEEDS_HUMAN` | **Watchdog** | 熔断。重试超限或严重错误时写入。 |
| `ERROR` | **Watchdog** | 异常情况（如格式错误、非法迁移）。 |
| `COMPLETED` | **Watchdog** | 所有任务完成。 |

### 2.2 合法迁移路径表

```mermaid
graph TD
    PENDING_DEV -->|Builder 获取锁| IN_DEV
    IN_DEV -->|Builder 完成开发| PENDING_REVIEW
    PENDING_REVIEW -->|Watchdog 预组装完成| IN_REVIEW
    IN_REVIEW -->|Watchdog (Approve 新任务)| PENDING_DEV
    IN_REVIEW -->|Watchdog (Reject 打回)| PENDING_DEV
    IN_REVIEW -->|Watchdog (Approve 无任务)| COMPLETED
    IN_REVIEW -->|Watchdog (重试耗尽)| NEEDS_HUMAN
    IN_DEV -->|Watchdog (开发超时)| ERROR
    IN_REVIEW -->|Watchdog (审查超时)| ERROR
    ERROR -->|Watchdog (容灾重试)| PENDING_DEV
    ERROR -->|Watchdog (重试耗尽)| NEEDS_HUMAN
    NEEDS_HUMAN -->|人工干预恢复| PENDING_DEV
```

**严禁的非法迁移**：任何跳过中间状态的直接迁移（如 `PENDING_DEV → PENDING_REVIEW`，跳过 `IN_DEV`），或 AI 工具试图写入非自身权限的状态，将被 Watchdog 检测并回滚至 `ERROR`。

---

## 3. 两侧工具最低能力要求

本协议是“工具无关”的，但接入的 AI 工具必须具备以下最低能力：

### 3.1 Builder（施工方）最低要求
- **文件读取**：必须能读取 `bridge.md`（状态指令）和 `docs/`（需求技术规范）。
- **文件写入**：必须能原子修改 `bridge.md` 的状态，且能正常修改代码文件。
- **终端命令执行**：必须能执行本地构建、测试验证，以及最重要的——能执行 `git add` 和 `git commit`。
- **LLM 推理**：能根据规范进行编码。

### 3.2 Supervisor（监工方）最低要求
- **文件读取**：必须能读取 `.bridge/review-request.md`。
- **文件写入**：必须能将审查结果写入 `.bridge/verdict.json`。
- **定时器/Schedule**：必须能自注册周期性的唤醒任务（Cron），以便在被唤醒时检查状态。
- **LLM 推理**：能基于 diff 和错误日志执行深度 Review。
- *注：Supervisor 不需要具备终端执行能力，因为相关材料已由 Watchdog 预组装。*

### 3.3 工具接入形态
- **GUI IDE（如 Workbuddy / Cursor）**：可通过读取 Watchdog 释放的信号文件（`signal-builder.txt`）或由用户粘贴 Prompt 来开工。
- **CLI 工具（如 Claude Code / Aider）**：可由 Watchdog 直接作为子进程（spawn）拉起并传入参数。
- **API 直调**：可作为独立脚本定时调用 LLM 接口消费状态。

---

## 4. 目录与数据交换格式规范

### 4.1 `.bridge/` 目录结构
Watchdog 运行时产生的所有临时与流转数据均存放在 `.bridge/` 目录下（建议加入 `.gitignore`）。

```
.bridge/
├── review-request.md     # Watchdog 组装的审查请求（Supervisor 的唯一输入）
├── verdict.json          # Supervisor 输出的裁决结果（Watchdog 的输入）
├── signal-builder.txt    # GUI 模式下通知 Builder 开工的信号文件
├── internal-state.json   # Watchdog 内部持久化状态
└── logs/                 # 历史审查意见归档
    └── review-T1-1.md
```

### 4.2 `review-request.md` 模板
Watchdog 在 `PENDING_REVIEW` 转 `IN_REVIEW` 时生成此文件：

```markdown
# 审查请求 — {task_id} (Round {round})

## 任务说明
（从 `docs/impl.md` 提取的当前任务验收标准）

## 代码变更 (git diff)
（`git diff [lastApprovedCommit]..HEAD`，超 64KB 截断并列出文件）

## 自动化校验日志
（终端 checks 命令输出与 exit code）
```

### 4.3 `verdict.json` Schema
Supervisor 完成审查后，必须原子写入以下格式的 JSON，Watchdog 消费后会立刻删除它：

```json
{
  "verdict": "approve", // 或 "reject"
  "task_id": "T1",
  "round": 1,
  "summary": "一句话审查结论",
  "issues": [
    {
      "severity": "blocker", // "blocker" | "warning" | "suggestion"
      "desc": "问题详细描述"
    }
  ],
  "next_instructions": "reject 时的明确修改指示；approve 时留空"
}
```
**约束**：若存在 `severity: "blocker"` 的 issue，`verdict` 必须为 `"reject"`。

### 4.4 `internal-state.json` 格式
```json
{
  "lastApprovedCommit": "abcdef1",
  "startedAt": "2026-09-15T12:00:00Z",
  "currentTaskStartedAt": "2026-09-15T13:00:00Z"
}
```

---

## 5. 错误处理与熔断策略

### 5.1 超时容灾
Watchdog 定期检查 `bridge.md` 的 `updated_at` 字段：
- **开发超时**：若状态停留在 `IN_DEV` 超过 `devTimeoutMin`（默认 45 分钟），Watchdog 强行将状态写入 `ERROR`，`error` 字段注明"Builder 开发超时"。
- **审查超时**：若状态停留在 `IN_REVIEW` 超过 `reviewTimeoutMin`（默认 10 分钟），Watchdog 强行将状态写入 `ERROR`，`error` 字段注明"Supervisor 审查超时"。

### 5.2 自动重试与重试耗尽
当系统进入 `ERROR`，或 Supervisor 输出 `reject` 裁决时：
- Watchdog 会使 `retry` 计数器 +1。
- 若 `retry <= maxRetryPerTask`（默认 5），Watchdog 将状态切回 `PENDING_DEV`，让 Builder 重新工作。
- 若 `retry > maxRetryPerTask`，触发系统熔断。

### 5.3 熔断（`NEEDS_HUMAN`）
当满足以下条件时，Watchdog 将状态切为 `NEEDS_HUMAN` 并通过终端发出醒目告警音：
1. 重试耗尽。
2. Watchdog 自身发生不可恢复的解析错误。

**人工干预恢复步骤**：
1. 人类开发者阅读 `bridge.md` 的 `error` 和 `.bridge/logs/` 的历史意见。
2. 人类手动修复代码或状态。
3. 人工修改 `bridge.md`，将状态改为 `PENDING_DEV` 并重置 `retry` 为 `0`。
4. Watchdog 检测到新状态，系统恢复自动运转。
