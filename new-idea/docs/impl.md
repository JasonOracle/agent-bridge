# 实施计划 (Impl Plan) — 响应式双端 AI 协作协议

> 每个任务必须完成**验收标准**后才能标记为 `[x]` 并推进下一个任务。
> 严格按 Layer 1 → Layer 2 → Layer 3 顺序执行，不可并行跨层。

---

## Layer 1：协议规范（必须最先完成）

- [ ] **T1**: 创建 `PROTOCOL.md` — `bridge.md` 格式规范
  - 输出：完整的机器区 YAML 字段定义（含类型、取值范围、必填/可选）
  - 输出：自由区结构定义（`## 本轮指令` 和 `## 上轮评审摘要` 两个固定标题）
  - 输出：原子写入规则（临时文件 → rename 覆盖，禁止直接 overwrite）
  - 验收：根据此规范能手写一个合法的 `bridge.md`，无歧义

- [ ] **T2**: 补全 `PROTOCOL.md` — 七态状态机
  - 输出：完整状态枚举定义
  - 输出：合法迁移路径表（从每个状态出发，允许迁移到哪些状态）
  - 输出：每个状态的写入方（Builder / Supervisor / Watchdog，且只有这三方）
  - 验收：给定任意非法迁移能明确判断为违规

- [ ] **T3**: 补全 `PROTOCOL.md` — 两侧工具最低能力要求
  - 输出：Builder 最低能力矩阵表（文件读写 / 终端命令 / LLM 推理）
  - 输出：Supervisor 最低能力矩阵表（文件读写 / 定时器 / LLM 推理）
  - 输出：不同工具形态的接入方式说明（CLI / GUI IDE / API 直调）
  - 验收：开发者读完后可自行判断手头工具是否满足接入要求

- [ ] **T4**: 补全 `PROTOCOL.md` — `.bridge/` 目录与文件规范
  - 输出：`review-request.md` 完整格式模板（含各字段来源说明）
  - 输出：`verdict.json` 完整 Schema（含每个字段含义与约束）
  - 输出：`internal-state.json` 格式定义
  - 输出：`logs/` 命名规则（`review-{taskId}-{round}.md`）
  - 验收：开发者读完后可独立实现 Watchdog 的文件操作部分

- [ ] **T5**: 补全 `PROTOCOL.md` — 错误处理与熔断策略
  - 输出：`maxRetryPerTask` 语义（超出后强制进入 `NEEDS_HUMAN`）
  - 输出：超时时间参数（`devTimeoutMin` 和 `reviewTimeoutMin`）含义与默认值
  - 输出：`NEEDS_HUMAN` 触发条件完整列表
  - 输出：从 `NEEDS_HUMAN` 恢复的操作步骤（人工干预后如何 resolve）
  - 验收：`PROTOCOL.md` 独立可读，无需参考其他文件即可理解完整工作流

---

## Layer 2：核心驱动力（看门狗 + Loop Prompt）

- [ ] **T6**: 编写 `watchdog.js` —— 主循环与状态检测
  - 实现 `tick()` 函数：读取 `bridge.md`，按状态分支分发
  - 实现 `watchdog.config.json` 加载（文件不存在则使用内置默认值）
  - 实现 `setInterval` 定时轮询（默认 5 秒）
  - 实现 `fs.watch('bridge.md', tick)` 事件驱动（降低感知延迟）
  - 实现进程退出处理：`COMPLETED` 正常退出（code 0），`NEEDS_HUMAN` 错误退出（code 1）
  - 实现非法状态迁移检测与自动回满至 `ERROR`
  - 验收：启动 `node watchdog.js`，手动改 `bridge.md` 状态，终端输出正确的分发日志

- [ ] **T7**: 编写 `watchdog.js` —— 审查材料预组装（`assembleReviewRequest`）
  - 实现：读取 `internal-state.json` 中的 `lastApprovedCommit`
    - 若 `lastApprovedCommit` 为 `null`（首个任务），则 diff 范围为 `git diff HEAD`（由于首次无 approved，展示未提交到暂存/最近提交的变动，或直接用 `git show` 等适合呈现首个变更的方式，建议 `git log -p -1` 等）
    - 若 `lastApprovedCommit` 有具体 hash，则 diff 范围为 `git diff {lastApprovedCommit}..HEAD`
  - 实现：超过 `maxDiffKB`（64KB）则截断，末尾附变更文件名列表
  - 实现：串行执行 `checks` 数组中的命令，记录 stdout/stderr 和退出码
  - 实现：将以上内容 + 任务说明拼装写入 `.bridge/review-request.md`
  - 实现：写入完成后将 `bridge.md` 状态从 `PENDING_REVIEW` 切换到 `IN_REVIEW`（同时更新 `updated_at`）
  - 验收：手动将 `bridge.md` 设为 `PENDING_REVIEW`，Watchdog 能在 5 秒内生成 `review-request.md`

- [ ] **T8**: 编写 `watchdog.js` — Verdict 消费与任务推进
  - 实现：`IN_REVIEW` 状态下轮询检测 `.bridge/verdict.json` 是否存在
  - 实现 approve 分支：
    - 更新 `internal-state.json` 的 `lastApprovedCommit` 为当前 HEAD commit hash
    - 在 `impl.md` 中将当前 `task_id` 的 `- [ ]` 改为 `- [x]`
    - 读取下一个待完成任务（`- [ ]`），若存在则写入 `PENDING_DEV`（含新 `task_id`，`round+1`，`retry=0`，`updated_at` 更新）
    - 若不存在则写入 `COMPLETED`（`task_id=null`，`updated_at` 更新）
    - 将审查日志归档到 `.bridge/logs/review-{taskId}-{round}.md`
    - 删除 `.bridge/verdict.json`
  - 实现 reject 分支：
    - `retry+1`，检查是否超过 `maxRetryPerTask`
    - 未超出则写 `PENDING_DEV`（同 `task_id`，`retry+1`，`round+1`，自由区写入打回意见）
    - 超出则写 `NEEDS_HUMAN`
    - 将审查日志归档到 `.bridge/logs/review-{taskId}-{round}.md`
    - 删除 `.bridge/verdict.json`
  - 验收：手动创建一个 approve 的 `verdict.json`，`impl.md` 对应任务被打勾，状态正确推进

- [ ] **T9**: 编写 `watchdog.js` — 超时检测与容灾
  - 实现：`IN_DEV` 停留超过 `devTimeoutMin`（默认 45 分钟）→ 写 `ERROR`
  - 实现：`IN_REVIEW` 停留超过 `reviewTimeoutMin`（默认 10 分钟）→ 写 `ERROR`
  - 实现：`ERROR` 状态处理：`retry < maxRetryPerTask` 则写 `PENDING_DEV`，否则写 `NEEDS_HUMAN`
  - 实现：`NEEDS_HUMAN` 时在终端打印醒目告警（含任务 ID、轮次、错误原因）
  - 验收：手动将 `updated_at` 改为 2 小时前并设 `IN_DEV`，Watchdog 自动转 `ERROR` 并处理

- [ ] **T10**: 编写 `prompts/builder-loop.md`
  - 格式要求：Markdown，清晰分节，无歧义
  - 必须包含的内容（参考 tech.md §5.1）：
    - Step 0：读取 `agents/builder.md` 角色卡全文（作为行为指引）
    - Step 1：读取 `bridge.md` 机器区（获取 task_id）+ 自由区（含上轮打回意见）
    - Step 2：读取 `docs/tech.md`（技术规范）
    - Step 3：从 `docs/impl.md` 提取当前 `task_id` 的任务段落
    - Step 4：**原子写入 `IN_DEV`**（包含具体的写入格式：修改 status，更新 updated_at），成功后才开始编码
    - Step 5：实现代码，跑本地测试
    - Step 6：`git add -A && git commit -m "[bridge] T{n}: {描述}"`
    - Step 7：**原子写入 `PENDING_REVIEW`**（修改 status，更新 updated_at 和 last_commit），然后停止等待 Watchdog 唤醒下一次
  - 验收：Workbuddy 粘贴此 Prompt 后，能在无人干预下完成一个完整任务的 Dev 半循环

- [ ] **T11**: 编写 `prompts/supervisor-loop.md`
  - 格式要求：Markdown，清晰分节，无歧义
  - 必须包含的内容（参考 tech.md §5.2）：
    - Step 0：被唤醒后先读取 `bridge.md` 状态，若状态**不是 `IN_REVIEW`**则静默退出（重注册定时器）
    - Step 1：读取 `.bridge/review-request.md`（全文），不得自行执行 git/shell 命令
    - Step 2：根据 `agents/supervisor.md` 角色卡进行代码审查
    - Step 3：输出结构化 Verdict 并写入 `.bridge/verdict.json`（JSON 格式，参考 tech.md §2.2）
    - Step 4：**无论结果如何，立即重新注册下一次定时唤醒**（Cron：`*/2 * * * *`）
  - 严格禁止事项：
    - **禁止直接写入 `bridge.md`**（状态切换全部由 Watchdog 处理）
    - **禁止修改 `impl.md`**
  - 验收：Antigravity 粘贴此 Prompt 并注册定时器后，能在无人干预下完成一个完整的 Review 半循环

---

## Layer 3：易用性增强

- [ ] **T12**: 编写 `QUICK_START_BUILDER.md`
  - 目标：5 行内，任意 AI 工具粘贴即可启动 Builder 模式
  - 内容：一句话说明角色，指向 `prompts/builder-loop.md` 和 `bridge.md`
  - 验收：把此卡片内容粘贴进 Workbuddy，一句话让它理解自己是 Builder 并知道下一步操作

- [ ] **T13**: 编写 `QUICK_START_SUPERVISOR.md`
  - 目标：5 行内，任意 AI 工具粘贴即可启动 Supervisor 模式
  - 内容：一句话说明角色，指向 `prompts/supervisor-loop.md`，明确第一步是注册定时任务
  - 验收：把此卡片内容粘贴进 Antigravity，一句话让它注册定时器并进入监工模式

- [ ] **T14**: 创建 `skills/agent-bridge-supervisor/SKILL.md`（Antigravity IDE 专属）
  - YAML frontmatter 包含：`name: agent-bridge-supervisor`、`description`、`triggers` 激活关键词（如 `agent-bridge`, `启动监工`）
  - 内容：加载 `supervisor-loop.md` 并自动注册第一个定时任务的完整指令
  - 验收：在 Antigravity IDE 中输入激活关键词，无需粘贴任何 Prompt 即可一键进入监工模式
