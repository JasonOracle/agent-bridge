# 响应式双端协作协议 v2.0 —— 完整设计方案

> **目标**：实现任意两个 AI 工具（GUI IDE / CLI / API）通过一个共享状态文件（`bridge.md`）进行**零人工干预、零空转 Token** 的全自动协作开发工作流。
>
> 本文档是新项目的完整实施计划，Antigravity IDE 将根据此文档逐层开发三个核心交付物。

---

## 一、核心设计思想（Pinia 响应式仓库模式）

传统多 Agent 协作的失败根因：**试图让 AI 自己管理调度**。正确的类比是 Vue3 的 Pinia：

- `bridge.md` = **Pinia Store**（唯一共享状态源，两端工具都订阅它）
- 施工方（Builder）= 订阅 Store 的组件，**响应 `PENDING_DEV` 自动开工**
- 监工方（Supervisor）= 订阅 Store 的组件，**响应 `PENDING_REVIEW` 自动审查**
- **无中央调度者**：两侧通过文件状态自驱动，一旦启动，人走开即可

---

## 二、查漏补缺：已发现并修复的 15 处逻辑漏洞

### 漏洞 1：`IN_DEV` 中间状态缺失（竞态与幂等性缺口）

**问题**：原方案 Builder 循环直接从 `PENDING_DEV` 跳到 `PENDING_REVIEW`，缺少中间 `IN_DEV` 状态。若两个 Builder 工具同时运行，都会读到 `PENDING_DEV` 并同时开工，导致代码冲突。

**修复**：Builder **开始工作前必须先原子写入 `IN_DEV`**，这是一个独占锁信号。若另一个 Builder 读到 `IN_DEV`，则不得开工，等待或退出。`IN_REVIEW` 同理用于 Supervisor。

---

### 漏洞 2：监工循环的"孤儿问题"（定时器丢失）

**问题**：Supervisor 在审查过程中若发生错误、崩溃或超时，重新注册定时器的步骤被跳过，导致监工永久失联，施工方卡在 `PENDING_REVIEW` 无人消费。

**修复**：
1. `bridge.md` 加入 `supervisor_heartbeat` 字段，Supervisor 每次唤醒必须更新此时间戳。
2. 若 `PENDING_REVIEW` 停留时间超过 `supervisorTimeoutMin`（如 10 分钟）仍无裁决，系统将此状态视为陈旧，自动触发降级处理（转 `ERROR` 或 `NEEDS_HUMAN`）。
3. 这个超时检测由**一个极轻量的看门狗脚本（Watchdog）** 来做，而不依赖 AI 自己监控（AI 不能监控自己）。

---

### 漏洞 3：Builder 长对话上下文膨胀

**问题**：Builder 在一个长对话中循环执行多个任务，上下文窗口随每轮迭代膨胀，导致：后期任务的推理质量下降、Token 成本指数上升，甚至触发上下文长度上限截断。

**修复**：
1. 每个任务作为一个**独立的 AI 推理轮次（Turn）**，而不是同一对话的多次循环。
2. 正确模型：Builder 每次被唤醒时携带**最小必要上下文**（任务说明 + 技术规范 + 上轮打回意见），不携带历史对话记录。
3. Loop Prompt 的职责变为：**定义 Builder 的单次行为规范**，而"轮询与唤醒"的职责由 Watchdog 脚本承担（见漏洞 2 的修复）。

---

### 漏洞 4：Supervisor 上下文收集职责不清

**问题**：原方案让 Supervisor（IDE）自己去跑 `git diff`、收集构建日志。但大多数 GUI IDE 不擅长执行复杂 Shell 命令序列，且结果格式不可控。

**修复**：引入**预组装材料文件 `.bridge/review-request.md`**。

看门狗脚本（或 `agent-bridge watch`）在将状态切换为 `PENDING_REVIEW` 之前，自动执行：
- `git diff [lastApprovedCommit]..HEAD`（截断至 64KB）
- 运行 `checks` 命令（`pnpm build`）并收集日志
- 将以上内容 + 任务说明 + 验收标准组装进 `.bridge/review-request.md`

Supervisor 只需读取这一个文件即可完成审查，**零 Shell 依赖**。

---

### 漏洞 5：Builder 必须 git commit 才能被审查

**问题**：原方案未明确要求 Builder 在翻转状态前提交代码。若没有 commit，Supervisor 拿不到 diff，且现有 `agent-bridge` 代码（`hasNewCommitSince`）会直接拒绝并打回。

**修复**：在 `builder-loop.md` 中强制规定：
> 完成编码和测试后，必须执行 `git add -A && git commit -m "[bridge] T{task_id}: {简短描述}"` **之后**才能翻转状态为 `PENDING_REVIEW`。

---

### 漏洞 6：COMPLETED 状态由谁写入

**问题**：原方案未明确 `COMPLETED` 状态的写入时机和写入者。

**修复**：由 **Supervisor 在 approve 时负责检查**。Supervisor approve 后：
1. 调用 `findNextPendingTask` 检查 `impl.md` 是否还有未完成的 `- [ ]` 任务。
2. 若有，写入下一任务的 `PENDING_DEV`。
3. 若无，写入 `COMPLETED`，并在自由区写入终审总结，停止注册新定时器。

---

### 漏洞 7：`impl.md` 打勾权限边界不清

**问题**：原方案允许 Supervisor 写 `impl.md`，但这给了 Supervisor 给自己放水的机会（可以乱打勾）。

**修复**：严格遵循现有 `agent-bridge` 的权限划分：
- **Supervisor 只写 `bridge.md` 自由区（审查意见）和机器区（状态、任务 ID）**。
- **`impl.md` 的 `[x]` 打勾由看门狗脚本/`agent-bridge` 在 approve 后自动执行**，非 AI 写入。
- **Builder 严禁修改 `impl.md`**（防止自我验收）。

---

### 漏洞 8：初始化启动序列未定义

**问题**：原方案没有明确"第一次启动"的操作顺序，用户不知道先启动哪个工具。

**修复**：定义标准启动序列（见第五节）。

---

### 漏洞 9：工具最低能力要求未规范

**问题**：不同工具有不同的能力边界。若 Builder 工具不支持执行终端命令，就无法 `git commit`；若 Supervisor 工具不支持定时器，就无法实现永续巡逻。

**修复**：在 `PROTOCOL.md` 中明确定义两侧工具的**最低能力要求矩阵**（见第三节）。

---

### 漏洞 10：看门狗缺位导致整体降级为人工驱动

**问题**：原方案将 Builder 的"轮询等待"和 Supervisor 的"定时重注册"全部放在 AI 对话中。但 AI 对话不是可靠的守护进程，一旦 AI 崩溃、上下文满、网络超时，整个循环就断链。

**修复**：**引入一个极轻量的看门狗脚本（`watchdog.js`）作为 Layer 2 的必要组成部分**。它只做三件事：
1. 每 N 秒读取 `bridge.md` 状态（轻量文件 I/O，不调用 LLM）
2. 检测到 `PENDING_DEV` → 发送唤醒信号给 Builder 工具（若是 CLI 则 spawn 子进程）
3. 检测到超时陈旧状态 → 转 `NEEDS_HUMAN` 并告警

---

### 漏洞 11：多工具同时接入的权限隔离

**问题**：同时运行 Workbuddy + `agent-bridge watch` CLI，两者都可能响应 `PENDING_DEV`，导致双 Builder 竞争。

**修复**：`PROTOCOL.md` 规定：**任何时刻系统内只允许一个活跃的 Builder 和一个活跃的 Supervisor**。`IN_DEV` 和 `IN_REVIEW` 状态即为隐式独占锁。Builder 在开工前必须先尝试 CAS（Compare-And-Swap）写入 `IN_DEV`；若当前已是 `IN_DEV`（非自己写入），则退出本次循环。

---

### 漏洞 12：打回时上下文注入不完整

**问题**：任务被 reject 打回后，Builder 应获得上轮打回意见，但原方案未明确这部分内容的传递路径。

**修复**：`bridge.md` 自由区的「本轮指令」和「上轮评审摘要」即为打回上下文。Builder 每次被唤醒必须完整读取 `bridge.md` 自由区（而不仅是机器区）作为修改依据。

---

### 漏洞 13：Supervisor 审查时的 Token 精算

**问题**：原方案未对 Supervisor 每次唤醒的 Token 使用量进行约束，若 diff 极大，单次审查会消耗大量 Token。

**修复**：
1. diff 截断：`maxDiffKB`（默认 64KB）限制，超出部分用文件名列表替代。
2. 审查上下文已经由 `.bridge/review-request.md` 预组装，Supervisor 只需读取一个文件，不做额外文件遍历。
3. Supervisor 的 loop prompt 必须约束输出格式为**结构化 JSON Verdict**，避免大段无效文本输出。

---

### 漏洞 14：自由区覆盖导致历史意见丢失

**问题**：`bridge.md` 自由区每轮覆盖，若用户想回溯历史，无法查看。

**修复**：完整审查历史归档到 `.bridge/logs/review-{taskId}-{round}.md`，`bridge.md` 自由区只保留最近一轮（可读性优先），审计需求走日志目录。

---

### 漏洞 15：Layer 3 Skills 仅覆盖 Antigravity，Workbuddy 侧无对应增强

**问题**：Layer 3 Skills 只为 Antigravity Supervisor 提供增强，Builder 侧（Workbuddy）无对应的一键启动能力。

**修复**：Layer 3 增加面向**任意工具**的标准化「快速启动卡」（`QUICK_START_BUILDER.md` + `QUICK_START_SUPERVISOR.md`）——这是最小化的启动指令，用户复制粘贴进任何工具即可一键启动，与 Skills 平行存在。

---

## 三、最低能力要求矩阵（工具选型红线）

| 能力 | Builder（施工方）要求 | Supervisor（监工方）要求 |
|---|---|---|
| **文件读取** | ✅ 必须（读 `bridge.md`、`docs/`） | ✅ 必须（读 `.bridge/review-request.md`） |
| **文件写入** | ✅ 必须（写 `bridge.md` 状态翻转） | ✅ 必须（写 `bridge.md` 裁决） |
| **终端命令执行** | ✅ 必须（`git commit`、`pnpm build`）| ❌ 不需要（由看门狗预组装） |
| **定时器 / Schedule** | ❌ 不需要（由看门狗唤醒） | ✅ 必须（自注册周期性巡逻）|
| **代码编辑** | ✅ 必须 | ❌ 不需要 |
| **LLM 推理** | ✅ 必须 | ✅ 必须 |

---

## 四、完整七态状态机（严格遵循）

```
PENDING_DEV ──→ IN_DEV ──→ PENDING_REVIEW ──→ IN_REVIEW ──→ PENDING_DEV（下一任务）
                                                          └──→ COMPLETED（最后一个任务）
                                                          └──→ NEEDS_HUMAN（重试耗尽）
任何状态 ──→ ERROR ──→ PENDING_DEV（按 onError 恢复）或 NEEDS_HUMAN
```

| 状态 | 写入方 | 含义 |
|---|---|---|
| `PENDING_DEV` | **Watchdog**（初始化/approve 后推进/恢复） | 等待开发 |
| `IN_DEV` | **Builder**（开工前获取独占锁） | 开发进行中（防多 Builder 竞争） |
| `PENDING_REVIEW` | **Builder**（完成编码+commit 后） | 等待验收 |
| `IN_REVIEW` | **Watchdog**（预组装材料完成后切入） | 审查进行中 |
| `NEEDS_HUMAN` | **Watchdog**（超时/重试耗尽） | 熔断，需人工介入 |
| `ERROR` | **Watchdog**（异常捕获） | 自动重试或人工干预 |
| `COMPLETED` | **Watchdog**（消费 approve verdict 且无剩余任务后） | 全部完成 |

> **注意**：Supervisor（AI 工具）只写两个东西：`IN_REVIEW`（开始审查前的独占锁）和 `.bridge/verdict.json`（裁决结果）。所有其他状态迁移均由 Watchdog 程序化执行，**严禁 AI 直接写入 `PENDING_DEV`、`COMPLETED` 或 `NEEDS_HUMAN`**。

---

## 五、标准启动序列（解决漏洞 8）

```
Step 1 [人工，一次性]
  用 Antigravity IDE 准备所有文档：
  docs/prd.md / tech.md / impl.md / test.md
  agents/builder.md / supervisor.md

Step 2 [人工，一次性]
  在项目目录执行：
  $ agent-bridge init   （初始化 bridge.md 和目录结构）

Step 3 [人工，一次性]
  启动看门狗：
  $ node watchdog.js    （或 agent-bridge watch）

Step 4 [人工，一次性]
  给 Supervisor 工具发送快速启动卡（QUICK_START_SUPERVISOR.md 内容）
  → Supervisor 注册第一个定时任务，进入永续巡逻模式

Step 5 [人工，一次性]
  给 Builder 工具发送快速启动卡（QUICK_START_BUILDER.md 内容）
  → Builder 等待看门狗唤醒，准备就绪

Step 6 [全自动，人走开 ☕]
  看门狗检测 PENDING_DEV → 唤醒/通知 Builder 开工
  Builder 开工 → 完成 → git commit → 翻转 PENDING_REVIEW
  看门狗收集 diff + 构建日志 → 预组装 .bridge/review-request.md
  Supervisor 定时唤醒 → 读取 review-request.md → 审查 → 写裁决
  看门狗消费裁决 → 打勾 impl.md → 下发下一任务
  循环直到 COMPLETED
```

---

## 六、三层交付物（开发任务清单）

### Layer 1：`PROTOCOL.md` 协议规范（P0，必须最先完成）

这是整套方案的**地基**，一旦确定不可随意更改。

- [ ] **T1**：定义 `bridge.md` 完整格式规范（机器区字段、自由区结构、原子写规则）
- [ ] **T2**：定义 7 态状态机及合法迁移路径表
- [ ] **T3**：定义两侧工具最低能力要求矩阵
- [ ] **T4**：定义 `.bridge/` 目录结构（`review-request.md`、`logs/`、`internal-state.json`）
- [ ] **T5**：定义 git commit 格式要求（`[bridge]` 前缀）与 `impl.md` 任务格式规范
- [ ] **T6**：定义错误处理与熔断策略（`maxRetryPerTask`、`NEEDS_HUMAN` 触发条件）
- 验收：`PROTOCOL.md` 自洽，任何工具读完后能独立实现兼容的接入

### Layer 2：Loop Prompt 文件 + Watchdog 脚本（P0，核心驱动力）

- [ ] **T7**：编写 `prompts/builder-loop.md`
  - 内容：Builder 单次行为规范（读状态 → 写 `IN_DEV` → 开发 → git commit → 写 `PENDING_REVIEW`）
  - 明确：读取文件清单（`bridge.md` 自由区 + `docs/tech.md` + 当前任务段落）
  - 明确：**禁止修改 `impl.md`，禁止跨任务边界**
- [ ] **T8**：编写 `prompts/supervisor-loop.md`
  - 内容：Supervisor 单次行为规范（写 `IN_REVIEW` → 读 `review-request.md` → 审查 → 输出结构化 JSON Verdict → 写裁决）
  - 明确：唤醒后**必须重新注册下一次定时器**（除非 `COMPLETED`/`NEEDS_HUMAN`）
  - 明确：Verdict JSON 结构（`verdict`、`task_id`、`summary`、`issues`、`next_instructions`）
- [ ] **T9**：编写 `watchdog.js`（极轻量 Node.js 脚本，约 150 行）
  - 功能 1：每 N 秒轮询 `bridge.md`（`fs.watch` + `setInterval` 双保险）
  - 功能 2：检测 `PENDING_DEV` → 唤醒 Builder（CLI spawn 或写入信号文件）
  - 功能 3：检测超时陈旧状态 → 转 `NEEDS_HUMAN` 告警
  - 功能 4：检测 `PENDING_REVIEW` → 运行 checks + 收集 diff → 组装 `.bridge/review-request.md`
  - **不调用任何 LLM**，纯文件 I/O 与子进程管理
- 验收：Builder + Supervisor 各持一个 Prompt 文件，Watchdog 在后台运行，完整跑通一个任务的完整 Dev→Review→Approve→Next 闭环

### Layer 3：Skills + 快速启动卡（P1，易用性增强）

- [ ] **T10**：编写 `QUICK_START_BUILDER.md`（任意 Builder 工具的最小启动指令，5 行内）
- [ ] **T11**：编写 `QUICK_START_SUPERVISOR.md`（任意 Supervisor 工具的最小启动指令，5 行内）
- [ ] **T12**：封装 Antigravity IDE Skill（`skills/agent-bridge-supervisor/SKILL.md`）
  - 激活命令：`/agent-bridge-supervisor`
  - 内容：自动加载 `supervisor-loop.md` 并注册第一个定时任务
- 验收：用户在 Antigravity 输入 `/agent-bridge-supervisor` 一键启动监工模式，无需手动粘贴 Prompt

---

## 七、目录结构（新项目）

```
your-project/
│
│  ── ① 核心交付物（本项目开发完成后产出）──────────────────────────
├── PROTOCOL.md                    ← [Layer 1] 协议规范（工具无关）
├── watchdog.js                    ← [Layer 2] 看门狗脚本（极轻量守护进程）
├── watchdog.config.json           ← [Layer 2] Watchdog 运行参数（用户按需修改）
├── prompts/
│   ├── builder-loop.md            ← [Layer 2] Builder 单次行为规范
│   └── supervisor-loop.md         ← [Layer 2] Supervisor 单次行为规范
├── QUICK_START_BUILDER.md         ← [Layer 3] 任意工具的 Builder 快速启动卡
├── QUICK_START_SUPERVISOR.md      ← [Layer 3] 任意工具的 Supervisor 快速启动卡
├── skills/
│   └── agent-bridge-supervisor/   ← [Layer 3] Antigravity IDE 专属 Skill
│       └── SKILL.md
│
│  ── ② 模板文件（已提供，用户必须按项目实际情况定制后使用）──────────
├── agents/
│   ├── builder.md                 ← Builder 角色卡模板（定制：技术栈、代码规范）
│   └── supervisor.md              ← Supervisor 角色卡模板（定制：验收标准）
│
│  ── ③ 运行时文件（用户自己准备 docs/，其余由 init/watchdog 生成）──
├── docs/                          ← 用户准备（prd / tech / impl / test）
├── bridge.md                      ← watchdog 初始化生成
└── .bridge/                       ← watchdog 运行时生成（建议加入 .gitignore）
    ├── review-request.md
    ├── verdict.json
    ├── signal-builder.txt
    ├── internal-state.json
    └── logs/
```

---

## 八、核心原则总结

> **协议是地基。Prompt 是固件。Watchdog 是心跳。工具是可插拔的执行单元。**
>
> 任何能读写文件 + 执行 LLM 推理的工具，拿到 `PROTOCOL.md` + 对应 Loop Prompt + Watchdog，即可零配置接入任意一侧。
>
> 不依赖特定 IDE、不依赖特定 LLM 品牌、不依赖 MCP 或任何私有协议。
