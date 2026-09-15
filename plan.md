# 🚀 Agent-Bridge (Meta-Agent 协同引擎)

这是一个为极客和开源社区准备的"元智能体架构师"命令行工具（CLI）。它的核心目标是打通各种异构的开发 Agent 工具（Claude Code、WorkBuddy、Cursor、Antigravity……），**指定任意一个当监工（验收方）、任意另一个当施工（开发方）**，实现完全无需人工干预的"左脚踩右脚"全自动开发循环。

## 核心设计理念

**"不要让大模型去写代码，让大模型去当架构师验收代码。"**

**"任意工具"的本质 = 通用 Agent 运行时 + 角色卡提示词 + 文件契约。** 监工和施工的差异不来自工具品牌，而来自三样东西：你分发给它的**角色卡**（`agents/*.md`）、注入给它的**文档上下文**（`docs/*.md`）、以及它遵守的**文件协议**。任何工具，只要能读写文本文件，就能接入任何一侧。

**关键架构决策：桥接器是唯一主驱动。** 两侧 Agent 都不需要自己轮询状态——agent-bridge 守护进程负责唤起施工方干活、收集产出、唤起监工验收、回写状态，全程无人值守。

---

## 1. 工作区布局（文档分发约定）

人类（或上游 Agent）开工前只需准备一个文件夹，放好分发好的文档，然后 `agent-bridge init && agent-bridge watch`：

```
your-project/
├── docs/                      # 📚 文档分发区（上下文注入源）
│   ├── prd.md                 # 产品文档：做什么、不做什么、边界
│   ├── tech.md                # 技术文档：技术栈、架构约束、目录约定
│   ├── impl.md                # 实施文档：任务拆解清单（带 ID + 验收标准，见 §2.3）
│   └── test.md                # 测试文档：测试策略、checks 命令说明
├── agents/                    # 🎭 角色卡（两侧 Agent 的灵魂）
│   ├── supervisor.md          # 监工角色卡：验收标准、评审风格、输出契约
│   └── builder.md             # 施工角色卡：开发规范、提交要求、协议动作
├── prompts/                   # 提示词模板（init 生成，可改）：builder-cli.md / builder-loop.md / supervisor-loop.md
├── bridge.md                  # 🌉 状态桥（桥接器生成维护，见 §2.1）
├── .bridge.config.json        # 配置（见 §4）
└── .bridge/                   # 运行时数据：日志、状态、评审请求/裁决
```

**文档注入规则**：监工每轮收到【prd + tech + test + 当前任务 + diff + 校验日志】；施工方每轮收到【tech + 当前任务 + 上轮打回意见】。prd 不注入施工方——防止它拿着宏观需求自由发挥，专注当牛马。角色卡永远注入对应方。

---

## 2. 协议规范 v1 (The Protocol)

### 2.1 状态桥接文件 (`bridge.md`)

项目根目录的共享文件，两个 AI 沟通的桥梁。**文件分两个区域**：

- **机器区**：文件顶部的 YAML fenced block，桥接器只解析这一块，字段齐全才视为合法状态；
- **自由区**：YAML 块之后的 markdown 正文，放监工的评审意见和对施工方的具体指令，供 AI（和人类）阅读。

````markdown
```yaml
status: PENDING_DEV
task_id: T3
round: 2
retry: 1
updated_at: 2026-09-15T14:30:00+08:00
last_commit: a1b2c3d
```

## 本轮指令
（监工写给施工方的具体修改要求，可以语气严厉）

## 上轮评审摘要
（最近一轮意见；完整历史在 .bridge/logs/，本区每轮覆盖）
````

**写入规则（防竞态，强制）**：任何写入方必须遵守「写入临时文件 → 原子 rename 覆盖」；bridge.md 不允许多方同时写。状态字段只有桥接器能写，施工方唯一被允许的动作是收工时把 `status` 翻转为 `PENDING_REVIEW`。

### 2.2 状态机（7 态）

| 状态 | 写入方 | 含义 |
|---|---|---|
| `PENDING_DEV` | 桥接器 | 等待开发：新任务已下发 |
| `IN_DEV` | 桥接器 | 开发进行中（唤起施工方前置位，兼作崩溃恢复标记） |
| `PENDING_REVIEW` | 施工方 | 开发收工，等待验收 |
| `IN_REVIEW` | 桥接器 | 验收管线执行中（崩溃恢复标记） |
| `NEEDS_HUMAN` | 桥接器 | 熔断态：重试耗尽或异常无法自愈（见 §2.5，**不是常规路径**） |
| `ERROR` | 桥接器 | 超时/子进程异常退出（记录日志后按配置自动重试或熔断） |
| `COMPLETED` | 桥接器 | 全剧终：任务清单全部完成 |

**正常循环**：`PENDING_DEV → IN_DEV → PENDING_REVIEW → IN_REVIEW → PENDING_DEV（下一任务）→ … → COMPLETED`

**打回循环**：`IN_REVIEW → PENDING_DEV（同任务，retry+1）`。`retry >= max_retry` 时按 `onMaxRetry` 策略处理，**绝不无限循环烧钱**。

**超时兜底**：
- `IN_DEV` 停留超过 `devTimeoutMin`（默认 45 分钟）→ 杀子进程，记 ERROR，按 `onError` 策略处理（`retry`：retry+1 重试，仍受 max_retry 熔断约束；`human`：转 NEEDS_HUMAN）；
- `IN_REVIEW` 中断（如桥接器崩溃重启）→ 启动时检测到陈旧 `IN_*` 状态（updated_at 超过阈值），自动重新执行该阶段，实现断点续跑。

### 2.3 实施文档 (`docs/impl.md`)

任务清单必须带**任务 ID 和验收标准**，供监工按 ID 引用、桥接器机械打勾：

```markdown
- [x] T1: 初始化 CLI 工程
  - 验收: `agent-bridge --help` 正常输出命令列表
- [ ] T2: 实现状态机解析模块
  - 验收: `npm test -- state` 全部通过
```

打勾规则：监工 verdict=approve 且 task_id 匹配时，桥接器把对应行 `- [ ]` 改为 `- [x]`；不允许监工直接改 impl.md（防止它给自己放水）。

### 2.4 审计日志

`.bridge/logs/` 追加式留档，每轮生成 `T{任务ID}-r{轮次}-{verdict}.md`，内含完整 diff 摘要、终端日志、监工原始输出。`.bridge/state.json` 记录 `lastApprovedCommit` 等内部状态。bridge.md 自由区只保留最近一轮，历史全靠日志——**调试"AI 吵架"的第一现场**。

### 2.5 "全自动"与熔断器的关系

正常路径**零人工干预**，这是设计承诺。`NEEDS_HUMAN` 不是流程的一环，而是保险丝——通过 `onMaxRetry` 配置熔断行为：

- `"human"`（默认）：停下来等人。适合关键项目；
- `"skip"`：放弃当前任务（impl.md 标记 `- [-]` 跳过），继续后续任务，全程不停机。适合"先跑完再说"的实验场景。最终 `COMPLETED` 时日志汇总所有被跳过的任务。

---

## 3. 桥接引擎运转逻辑

`agent-bridge watch` 启动守护进程，采用**定时轮询**（默认 5 秒，不用 inotify——Windows/Docker 挂载卷下文件监听不可靠，轮询简单可控）。

### 3.1 开发半循环（状态 = PENDING_DEV）
1. 置位 `IN_DEV`，组装施工提示词（builder 角色卡 + tech 文档 + 当前任务 + 上轮打回意见 + 协议动作要求）；
2. 唤起施工方（Mode A/B，见 §3.3），等待收工或超时；
3. 检查状态：已被翻转为 `PENDING_REVIEW` → 进入验收半循环；否则按超时/失败处理。

### 3.2 验收半循环（状态 = PENDING_REVIEW）
1. **收集上下文**：`git diff <lastApprovedCommit>..HEAD`（施工方被要求每轮提交 commit，message 前缀 `[bridge]`；无新 commit 直接打回"未提交代码"）。diff 超过 `maxDiffKB`（默认 64KB）时降级为 `--stat` 全量 + 逐文件头部截断。
2. **本地自动化校验**：顺序执行 `checks` 配置的命令（来自 docs/test.md 的约定，如 `npm run build`、`npm test`），捕获 stdout/stderr，单条超时 `checkTimeoutMin`（默认 10 分钟）。
3. **生成评审请求**：把【prd + tech + test 摘要 + 当前任务 + diff + 校验日志】落盘为 `.bridge/review-request.md`，附输出契约说明。
4. **监工裁决**（Mode API/CLI/B，见 §3.3）：获得符合 §5 Schema 的 verdict。
5. **状态回写**：
   - **通过**：impl.md 对应任务打勾，更新 `lastApprovedCommit`；还有任务 → 下发下一任务置 `PENDING_DEV`；全部完成 → `COMPLETED`；
   - **打回**：修改意见写入 bridge.md 自由区，`retry+1`，置 `PENDING_DEV`；超限 → 按 `onMaxRetry` 熔断。

### 3.3 双方接入矩阵（任意工具 × 任意工具）

| 角色 | 模式 | 机制 | 适用 |
|---|---|---|---|
| **施工方** | Mode A · CLI 驱动（推荐） | 桥接器 spawn 无头 CLI（如 `claude -p "{prompt}"`），每轮新进程，超时可杀 | Claude Code、cursor-agent 等有 headless 模式的工具 |
| **施工方** | Mode B · 定时任务驱动（IDE 型） | 把 `prompts/builder-loop.md` 注册为 IDE 的**定时任务**（如每 5 分钟）：每 tick 独立会话醒来 → 读 bridge.md → 是 `PENDING_DEV` 就干活、提交、翻状态；否则直接退出 | WorkBuddy、Antigravity 等支持定时任务/长会话的 IDE |
| **监工方** | Mode API（内置，低延迟） | 桥接器直接调 Claude/OpenAI 兼容 API，JSON 输出最可靠 | 追求稳定快速的常规场景 |
| **监工方** | Mode CLI（任意 headless 工具） | 桥接器 spawn 无头 CLI，提示词要求它**读 `.bridge/review-request.md`，把裁决 JSON 写入 `.bridge/verdict.json`** | 想用某个具体 CLI 工具当监工的场景 |
| **监工方** | Mode B · 定时任务驱动（IDE 型） | 把 `prompts/supervisor-loop.md` 注册为 IDE 定时任务：每 tick 醒来 → 读 bridge.md → 是 `PENDING_REVIEW` 就读 review-request.md 评审、写 verdict.json；否则直接退出 | Antigravity、WorkBuddy 等支持定时任务的 IDE |

**关键设计一：监工走文件契约而非 stdout 解析。** 评审材料落盘给它读、裁决落盘收回来——大 diff 不会爆命令行参数长度，输出格式校验统一走 verdict.json 的 Schema 检查。这回归了本项目的原点理念：**任何一方只要能读写文件，就能接入。**

**关键设计二：Mode B 一律用「定时任务 tick」而非「长会话死循环」。** 每个 tick 是独立会话，醒来读状态文件决定"干活还是继续睡"，循环状态全在 bridge.md 里。好处：IDE 会话崩溃/被关闭不影响循环（下个 tick 自动接续），天然断点续跑；代价：乒乓延迟 ≈ tick 间隔（建议 3–5 分钟，远小于 `timeoutMin`）。两侧 tick 无需同步——状态机已经解耦，各看各的状态位，永远不会撞车。

**行动信号（时序契约，防止 tick 与桥接器互相错过）**：桥接器会在半循环开始时把 `PENDING_DEV→IN_DEV`、`PENDING_REVIEW→IN_REVIEW`，IDE tick 几乎永远撞不见 `PENDING_*` 瞬间。因此约定：施工 tick 的开工信号 = `PENDING_DEV` **或** `IN_DEV`；监工 tick 的评审信号 = `PENDING_REVIEW` **或** `IN_REVIEW`。且桥接器保证"先原子写好 review-request.md、再翻 IN_REVIEW"，监工看到 IN_REVIEW 时评审材料必然完整。

**典型拓扑（零 CLI 依赖的全 IDE 形态）**：Antigravity 开项目文件夹 + 注册监工定时任务，WorkBuddy 开同一文件夹 + 注册施工定时任务，终端跑 `agent-bridge watch` 做状态机与校验。一次性 setup 后全程无人值守。

**组合示例速查（任意混搭，协议对品牌无感）**：

| 监工 × 施工 | 监工模式 | 施工模式 |
|---|---|---|
| Claude Code CLI × MiMo CLI | Mode CLI | Mode A |
| Codex CLI × CodeBuddy | Mode CLI | Mode B |
| Antigravity × WorkBuddy | Mode B | Mode B |
| Claude Code CLI × Trae | Mode CLI | Mode B |
| WorkBuddy × Antigravity（角色互换亦可） | Mode B | Mode B |

单个工具的准入门槛（满足其一即可接入任一侧）：① 有无头 CLI 模式（走 spawn）；② IDE 支持定时任务（走 Mode B tick）；③ 能保持长会话（Mode B 退化方案，不推荐）。具体命令行参数以各工具实际能力为准，`command`/`args` 全配置化。

**极限形态（无守护进程，仅演示用）**：也可以不跑 `agent-bridge watch`，让监工侧定时任务兼任轮询、diff 收集、checks 执行与状态回写。零安装但失去超时强杀/原子写/精确重试计数等代码级保障，可靠性押在 IDE Agent 忠实执行协议上——README 中标注为 demo 模式，不推荐长项目使用。

Mode CLI 监工需要工具支持无头模式；两侧 Mode B 需要 IDE 支持定时任务（或人工保持长会话，退化方案）。纯 GUI 且两者都不支持的工具无法接入（记为已知限制）。

---

## 4. 配置文件标准 (`.bridge.config.json`)

```jsonc
{
  "supervisor": {                     // 监工（验收方）：任意工具
    "mode": "api",                    // api | cli | watch（watch=Mode B 定时任务）
    "provider": "claude",             // mode=api 时：claude | openai
    "model": "claude-sonnet-4-5",
    "apiKey": "${ANTHROPIC_API_KEY}", // 强制环境变量插值，禁止明文 key
    "maxTokens": 8192,
    "timeoutMin": 20,                 // 三种监工模式共用的裁决超时
    "cli": {                          // mode=cli 时：换成任意开发工具
      "command": "claude",
      "args": ["-p", "{prompt}"]
    }
  },
  "builder": {                        // 施工方：任意工具
    "mode": "cli",                    // cli | watch（=Mode B）
    "command": "claude",
    "args": ["-p", "{prompt}"],
    "timeoutMin": 45
  },
  "docs": {                           // 文档分发区映射
    "prd": "docs/prd.md",
    "tech": "docs/tech.md",
    "impl": "docs/impl.md",
    "test": "docs/test.md"
  },
  "roles": {                          // 角色卡映射
    "supervisor": "agents/supervisor.md",
    "builder": "agents/builder.md"
  },
  "checks": ["npm run build", "npm test"],
  "checkTimeoutMin": 10,
  "pollIntervalSec": 5,
  "maxRetryPerTask": 5,
  "onMaxRetry": "human",              // human | skip（见 §2.5）
  "onError": "retry",                 // retry | human（ERROR 态恢复策略，仍受 maxRetry 约束）
  "maxDiffKB": 64
}
```

`agent-bridge init` 生成此文件 + 目录骨架（docs/agents/prompts 模板）+ bridge.md，并在 `.gitignore` 自动追加 `.bridge/`（`init --force` 可覆盖）。

---

## 5. 监工裁决契约

无论监工是 API 还是 CLI 工具，裁决 Schema 统一。`agents/supervisor.md` 角色卡核心三条：
1. 你是 CTO，不是客服。**只看证据下结论**（diff + 终端日志 + 分发文档），禁止客套话；
2. 必须输出**合法 JSON**（禁止 markdown 包裹），Schema 如下；
3. 打回时 `next_instructions` 必须具体可执行（改哪个文件、改什么行为），禁止"再优化一下"这类废话。

```jsonc
{
  "verdict": "approve | reject",
  "task_id": "T3",                 // 必须与当前验收任务一致，否则视为非法输出
  "summary": "一句话结论",
  "issues": [{ "severity": "blocker|major|minor", "desc": "...", "file": "src/x.ts" }],
  "next_instructions": "reject 时必填：给施工方的具体指令"
}
```

- Mode API：从响应中解析 JSON；
- Mode CLI：轮询 `.bridge/verdict.json` 出现并校验 Schema；
- 解析失败 / task_id 不匹配 / 超时未产出 → 自动重问一次（附错误原因），再失败记 ERROR 按熔断策略处理。

---

## 6. 实施阶段计划

### 阶段 1：脚手架与引擎核心
**交付物**
- `commander` + `typescript` 初始化 CLI 工程；命令面：`init`（生成目录骨架与全部模板）/ `watch` / `once`（单轮执行，调试主力）/ `status` / `resolve`（人工处理完 NEEDS_HUMAN 后恢复循环）
- 配置模块：加载 `.bridge.config.json` + 环境变量插值 + zod 校验
- 状态机模块：bridge.md 双区解析、YAML 校验、原子写入、陈旧状态检测
- 执行器模块：子进程 spawn/超时强杀/输出捕获；git 模块：commit 检测与 diff 收集（含截断降级）
- 轮询守护循环 + `.bridge/logs/` 审计留档
- 文档/角色卡加载器：按 §1 注入规则组装两侧上下文

**DoD（验收标准）**：手写 bridge.md 翻转状态，`once` 模式能完整跑通"收集 diff → 跑 checks → 生成 review-request.md"干跑流程（监工调用可先 mock）；状态机模块单测覆盖全部 7 态迁移。

### 阶段 2：监工适配层 (Supervisor Layer)
**交付物**
- Mode API：Provider 抽象接口（`review(request) → Verdict`）+ Claude Provider（`@anthropic-ai/sdk`）+ OpenAI Provider（`openai` SDK，兼容 DeepSeek/通义等衍生端点的 baseURL 配置）
- Mode CLI：spawn 任意工具 CLI + `.bridge/verdict.json` 文件契约轮询与 Schema 校验
- 统一的非法输出重问机制（两种模式共用）+ API 调用重试（指数退避，限流感知）+ token 用量统计（写入审计日志）
- 施工提示词组装器（`prompts/builder-cli.md` / `prompts/builder-loop.md`）+ 监工定时任务模板（`prompts/supervisor-loop.md`，含 review-request.md 读取与 verdict.json 写入契约）

**DoD**：Mode API 与 Mode CLI 各跑一次真实 `once` 全流程；构造非法 JSON/缺失 verdict.json 验证重问；`--dry-run` 可打印完整 prompt 不发请求不起进程。

### 阶段 3：发布与开源准备
**交付物**
- 中英文双语 `README.md`：原理图、"任意工具 vs 任意工具"接入矩阵、四种组合的配置示例、安全警告（见 §7）
- `examples/todo-app/` 完整示例（含 docs/agents 全套模板）
- **终极本地自证实验**（见 §8）

**DoD**：自证实验达标；README 通过"新机器 15 分钟跑通示例"测试。

---

## 7. 安全与已知限制（README 必须显著标注）

1. **供应链风险**：桥接器会自动执行施工 AI 刚写的测试代码，等同自动执行未审查代码。强烈建议在容器/VM 内运行，生产环境禁用。
2. **API 成本**：死循环虽有 max_retry 熔断，仍建议配置消费告警；审计日志记录每轮 token 用量便于核算。
3. **密钥管理**：配置强制 `${ENV_VAR}` 插值；`init` 生成的 .gitignore 含 `.bridge/` 与配置文件。
4. **Git 污染**：施工方的 `[bridge]` 提交会进入历史，建议实验用独立分支，`COMPLETED` 后由人类 squash。
5. **已知限制**：纯 GUI、无 headless 也不接受长会话提示词的工具无法接入；Mode CLI 监工的裁决可靠性依赖该工具的指令遵循能力（verdict.json 校验兜底）。

---

## 8. 自证实验设计（阶段 3 核心）

**对照设置——真·异构乒乓（全 IDE 形态）**
1. 新建 `examples/todo-app/`，按 §1 布局放好 docs 四件套 + agents 双角色卡（5 个任务的 impl.md）；
2. **监工**：Antigravity IDE 打开该项目文件夹，注册定时任务注入 `prompts/supervisor-loop.md`（Mode B）——证明"任意 IDE 工具"能当监工；
3. **施工**：WorkBuddy 打开同一文件夹，注册定时任务注入 `prompts/builder-loop.md`（Mode B）——证明 IDE 型工具能当施工；
4. 终端跑 `agent-bridge watch` 做状态机/校验/熔断；人类全程不按任何按钮。

**成功度量（预先定义，不许事后找补）**
- 5 个任务全部打勾，最终 `checks` 全绿；
- 人工干预次数 = 0（NEEDS_HUMAN 出现即实验失败，需复盘；`onMaxRetry` 实验时设为 `human` 以便观测）；
- 总轮次 ≤ 15（平均每任务打回 ≤ 2 次），墙钟时间、token 总消耗记录进 README；
- **恢复测试**：中途强杀施工方进程一次、重启桥接器一次，系统均能自愈续跑；
- **对照组**：同任务用 Mode API 监工 + Mode A 施工（双 Claude headless）再跑一遍，对比"全 IDE 定时任务形态"与"全 CLI 形态"的轮次/延迟/成本差异，数据写进 README——这本身就是最好的传播素材。

---

## 10. 分发形态决策

**判断标准：主循环（守护进程）归谁管。** watch 需要长驻、spawn 子进程、执行 shell、杀超时进程——只有独立进程能承担，因此主体形态没有候选竞争。

- **v1 主体：npm CLI**（`npm i -g agent-bridge`）。零摩擦开源分发，与"品牌无感、任意终端可用"定位契合。prompts/agents 模板随包分发，init 时落地。
- **v1.x 辅料：Skill 接入包**。prompts/ 与 agents/ 模板本质已是 skill 素材，打包发布到各平台 skill 市场，让任意 Agent 一键学会"如何当监工/施工"。零开发成本，纯传播放大器。**Skill 依附会话生命周期、无法驱动外部工具，不能承担主体。**
- **v2 增强：MCP server**（`agent-bridge mcp` 子命令）。把 get_state/submit_verdict/flip_status 暴露为事务性工具调用，解决 Mode B 依赖 AI 手改 YAML 的脆弱性。文件协议仍是最大公约数兜底，MCP 只做高级接口。
- **v2 配套：Docker 镜像**（回应 §7 供应链风险：整套循环跑容器里）+ TUI 监控面板（看 AI 乒乓，geek 向传播素材）。
- **明确不做：IDE 插件**（N 倍维护 + 品牌锁定，违背立项原则）；桌面 GUI 缓议（TUI 拿 80% 效果）。

---

## 附：开发交接说明（给 Antigravity 的开工指引）

本仓库已按 §1 布局自备全套文档：`docs/`（prd/tech/impl/test 四件套）、`agents/`（双角色卡）、`prompts/`（三模板）、`bridge.md`（初始 PENDING_DEV/T1）、`.bridge.config.json`。

**自举（bootstrap）策略——注意先有鸡还是先有蛋**：开发 agent-bridge 本体时桥接器尚不存在，无法自己调度自己。分两阶段：
1. **阶段 A（T1–T7，半自动）**：Antigravity 直接按 `docs/impl.md` 顺序开发（读 builder 角色卡+tech.md，无需定时任务）。每完成一个任务，由监工方（WorkBuddy 定时任务注入 `prompts/supervisor-loop.md`，或人工）评审；因守护进程不存在，**状态回写由监工侧代办**（读完 verdict 后手动/由监工 Agent 翻转 bridge.md 并打勾，即 §3.3 的"极限形态"，过渡性质可接受）。
2. **阶段 B（T8–T13，全自动）**：T7 完成后 `once/watch` 骨架可用（监工还是 mock），可先用于联调；**T9 完成（监工三模式落地）后立即切换为标准形态**——终端跑 `node dist/cli.js watch`，监工 tick 退出"降级代办"回到纯评审，两侧恢复"定时任务只干活、桥接器管状态"的正常分工。这本身就是对产品的第一次实战检验。

**Antigravity 开工指令（完整版，贴进会话即可）：**

> 你是本项目的施工方。开工前按顺序完整阅读：
> 1. `agents/builder.md` —— 你的角色卡与红线；
> 2. `docs/tech.md` —— 实现的唯一权威依据（写了的照做，没写的不要发明）；
> 3. `docs/impl.md` —— 任务清单 T1–T13（顺序执行，禁止跳号）；
> 4. `docs/test.md` —— 测试要求。
>
> 然后执行：
> 0. 先 `git init` 并提交首个 commit（`chore: 导入设计文档`）——后续所有验收以 commit diff 为基准；
> 1. 从 T1 开始开发；
> 2. 每完成一个任务：`npm run build` 和 `npm test` 全绿 → `git add -A && git commit -m "[bridge] T{n}: 简短说明"` → 把 `bridge.md` 机器区 `status` 改为 `PENDING_REVIEW`、`updated_at` 改为当前 ISO 时间（其余字段不动）→ **停下来等验收，不要自行开始下一个任务**；
> 3. 被打回时：读 bridge.md 自由区"本轮指令"逐条修改，改完重新提交、再次翻 `PENDING_REVIEW`。
>
> 纪律：不改 `docs/` 下任何文档；一次只做一个任务；checks 不绿不许提交；不硬编码任何密钥。

阶段 A（T1–T7）验收方：WorkBuddy 定时任务注入 `prompts/supervisor-loop.md`（会自动走降级分支代办状态回写），或人工验收后代翻状态。T9 完成后按阶段 B 切标准形态。

---

## 9. 风险登记

| 风险 | 缓解 |
|---|---|
| 监工与施工"鸡同鸭讲"循环打回 | max_retry + onMaxRetry 熔断；打回意见强制具体化 |
| 底层 CLI 无头模式行为漂移（升级后参数变化） | command/args 全配置化；版本探测 smoke test |
| Mode CLI/B 监工不写 verdict.json 或格式乱 | Schema 校验 + 重问一次 + ERROR 熔断；角色卡中强调文件契约 |
| IDE 定时任务不触发/频率漂移（IDE 重启后任务丢失等） | `devTimeoutMin`/陈旧状态检测兜底；README 提供 setup 检查清单 |
| Mode B 的 IDE Agent 擅自改写 YAML 机器区 | 解析失败即 ERROR；提示词中明确"只改 status 字段" |
| diff/上下文超 token | review-request.md 落盘读取（Mode CLI 天然免疫）；maxDiffKB 截断降级 |
| Windows 路径/换行兼容 | 阶段 1 单测在 Windows 实跑，不用 inotify |
