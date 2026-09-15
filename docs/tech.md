# 技术文档 — Agent-Bridge

> 本文档是实现的**唯一权威依据**。凡本文与 plan.md 冲突，以本文为准。模块、函数、字段未在本文出现的，不要发明；本文写死的，不要更改。

## 1. 技术栈
- Node.js ≥ 18，TypeScript 5.x，ESM（`"type": "module"`），编译目标 ES2022。
- 依赖（保持极简，不新增）：
  - `commander` — CLI 框架
  - `zod` — 配置/状态/裁决的 Schema 校验
  - `js-yaml` — bridge.md 机器区解析
  - `execa` — 子进程执行（超时强杀、输出捕获）
  - `@anthropic-ai/sdk`、`openai` — 监工 Mode API
  - `vitest` — 测试
- 包管理：npm。构建：`tsc` 输出到 `dist/`，bin 入口 `dist/cli.js`。

## 2. 源码目录结构
```
src/
├── cli.ts                 # commander 入口，只做参数解析与分发
├── config.ts              # 配置加载 + ${ENV} 插值 + zod 校验
├── state.ts               # bridge.md 解析/原子写入/状态机迁移/陈旧检测
├── watcher.ts             # watch 主循环（轮询调度）
├── pipeline.ts            # 开发半循环 + 验收半循环编排
├── executor.ts            # 子进程执行器（spawn/超时/输出捕获）
├── gittool.ts             # git 操作（commit 检测、diff 收集与截断）
├── context.ts             # 文档/角色卡加载与提示词组装
├── logger.ts              # .bridge/logs/ 审计留档 + state.json 读写
├── supervisor/
│   ├── types.ts           # Verdict zod schema + 类型
│   ├── index.ts           # getVerdict(request) 按 mode 分发
│   ├── api.ts             # Mode API（claude/openai provider）
│   ├── cli.ts             # Mode CLI（spawn 无头工具）
│   └── watch.ts           # Mode B（轮询 verdict.json）
└── builder/
    ├── index.ts           # runBuilder(prompt) 按 mode 分发
    ├── cli.ts             # Mode A spawn
    └── watch.ts           # Mode B（不 spawn，仅等待状态翻转或超时）
```

## 3. 核心数据结构（zod schema，字段名不可改）

### 3.1 BridgeState（bridge.md 机器区）
```ts
const BridgeStateSchema = z.object({
  status: z.enum(['PENDING_DEV','IN_DEV','PENDING_REVIEW','IN_REVIEW','NEEDS_HUMAN','ERROR','COMPLETED']),
  task_id: z.string().regex(/^T\d+$/).nullable(),   // COMPLETED 前必有值
  round: z.number().int().min(1),
  retry: z.number().int().min(0),
  updated_at: z.string(),                            // ISO 8601，本地时区偏移
  last_commit: z.string().nullable(),                // 展示镜像，见 §3.4 权属说明
  error: z.string().optional(),                      // status=ERROR 时的原因
});
```

### 3.2 Verdict（监工裁决，verdict.json 与 API 输出共用）
```ts
const VerdictSchema = z.object({
  verdict: z.enum(['approve','reject']),
  task_id: z.string(),
  round: z.number().int().optional(),                // 监工照抄 review-request 中的 round
  summary: z.string(),
  issues: z.array(z.object({
    severity: z.enum(['blocker','major','minor']),
    desc: z.string(),
    file: z.string().optional(),
  })).default([]),
  next_instructions: z.string().default(''),
});
// 非法判定：JSON 解析失败（过了 §11 宽限期仍失败）/ zod 校验失败 / task_id !== 当前任务
//          / verdict=reject 但 next_instructions 为空
// 陈旧判定：round 存在且 !== 当前 round → 不消费、不归档、继续等（上一轮迟到的裁决）
```

### 3.3 Config（.bridge.config.json）
字段与 plan.md §4 一致，zod 校验 + 以下默认值：
`pollIntervalSec=5, checkTimeoutMin=10, maxRetryPerTask=5, onMaxRetry='human', onError='retry', maxDiffKB=64, builder.timeoutMin=45, supervisor.timeoutMin=20, staleThresholdMin=0`。
- `supervisor.mode ∈ api|cli|watch`，`builder.mode ∈ cli|watch`。
- `onError`：ERROR 状态的恢复策略——`'retry'`（默认，retry+1 后回 PENDING_DEV，仍受 maxRetryPerTask 熔断约束）或 `'human'`（转 NEEDS_HUMAN）。
- `supervisor.timeoutMin`：三种监工模式共用的裁决超时（api 整体超时/cli 进程+产出超时/watch 等 verdict.json 超时）。`supervisor.cli.timeoutMin` 废弃，统一用这个。
- `staleThresholdMin`：默认 `0` = 自动取「当前阶段 timeoutMin + 5」；>0 时用显式值覆盖。
- **按模式校验**（重要）：只有被启用的模式所必需的字段才校验。例如 `mode=watch` 时 `apiKey`/`provider`/`model` 不校验、对应 `${ENV}` 缺失不报错；`builder.mode=watch` 时 `builder.command/args` 不校验。

### 3.4 内部状态（.bridge/state.json）
```jsonc
{ "lastApprovedCommit": "a1b2c3d", "totalTokens": { "input": 0, "output": 0 }, "startedAt": "..." }
```
- **`lastApprovedCommit` 的唯一权威存储是 state.json**。bridge.md 机器区的 `last_commit` 只是每次状态回写时同步过去的展示镜像（方便人和 AI 读），代码逻辑一律以 state.json 为准。
- 首次运行 `lastApprovedCommit` 取当前 `HEAD`；仓库无 commit 时取 null，diff 用 `git diff HEAD` 并对未跟踪文件列清单。

## 4. bridge.md 解析与写入（state.ts）
- **解析**：正则提取文件**第一个** ```` ```yaml ```` fenced block，`js-yaml` 解析后过 BridgeStateSchema。找不到块 / YAML 语法错 / 校验失败 → 抛 `BridgeParseError`（调用方转 ERROR 状态处理，不重试）。
- **自由区**：`## 本轮指令` 与 `## 上轮评审摘要` 两个小节，解析器不读，仅供 AI/人类。
- **原子写（强制）**：序列化 = YAML 块 + 自由区 → 写同目录 `bridge.md.tmp.<pid>` → `fs.renameSync` 覆盖。禁止直接 writeFile 覆盖 bridge.md。review-request.md、verdict.json 归档等桥接器侧写入同样遵守。
- **状态迁移合法性**：只允许 §5 状态机表中列出的迁移；非法迁移抛错（防 AI 乱改 status 造成混乱——例如施工方只能 `IN_DEV|PENDING_DEV → PENDING_REVIEW`，但本工具无法阻止 AI 直接编辑文件，所以 watcher 每 tick 校验：若发现迁移非法，记 ERROR 并把状态回滚到迁移前值）。
- **陈旧检测**：`status ∈ {IN_DEV, IN_REVIEW}` 且 `now - updated_at > staleThresholdMin`（见 §3.3）→ 视为上次执行中断，重新执行该阶段（断点续跑）。

## 5. 状态机（唯一合法迁移表）与行动信号
| 当前 | 事件 | 下一状态 |
|---|---|---|
| PENDING_DEV | watcher 开始开发半循环 | IN_DEV |
| PENDING_DEV 或 IN_DEV | 施工方收工翻状态（由 watcher 轮询发现） | PENDING_REVIEW |
| IN_DEV | 超时/子进程失败 | ERROR → 按 onError 处理 |
| PENDING_REVIEW | watcher 开始验收半循环 | IN_REVIEW |
| IN_REVIEW | verdict=approve，仍有任务 | PENDING_DEV（task_id 前进，retry=0，round+1） |
| IN_REVIEW | verdict=approve，任务全完 | COMPLETED |
| IN_REVIEW | verdict=reject，retry+1 < maxRetryPerTask | PENDING_DEV（retry+1） |
| IN_REVIEW | verdict=reject，retry+1 ≥ maxRetryPerTask | onMaxRetry=human→NEEDS_HUMAN；skip→任务标 `- [-]`，PENDING_DEV 下一任务 |
| ERROR | onError=retry 且 retry+1 < maxRetryPerTask | PENDING_DEV（retry+1） |
| ERROR | onError=human 或 retry 超限 | NEEDS_HUMAN |
| NEEDS_HUMAN | 用户跑 `resolve` | PENDING_DEV（retry=0） |
| 任意 | `updated_at` 陈旧（IN_* 态） | 重跑对应半循环 |

**行动信号（watch/Mode B 的时序契约，必须遵守）**：
- 施工 tick 的开工信号 = `PENDING_DEV` **或** `IN_DEV`（两者都是"轮到施工"，watcher 置 IN_DEV 只是计时标记，不代表别人在干）；
- 监工 tick 的评审信号 = `PENDING_REVIEW` **或** `IN_REVIEW`；
- **顺序保证**：验收半循环先把 review-request.md 原子写盘，**再**翻 IN_REVIEW——监工看到 IN_REVIEW 时材料必然完整；若 tick 撞见 PENDING_REVIEW 且 review-request.md 尚不存在/未更新，等下个 tick。

## 6. watcher 主循环（伪代码）
```
loop:
  state = readBridge()                    // 含陈旧检测与迁移合法性校验
  switch state.status:
    PENDING_DEV:  await runDevHalf()
      // 置 IN_DEV；builder.mode=cli → 组装 prompt + spawn + 等退出/超时
      //             builder.mode=watch → 不 spawn，回到循环等施工 tick 收工翻状态
    IN_DEV:       // cli 模式: 检查子进程结果与状态翻转；watch 模式: 检查是否已翻 PENDING_REVIEW
                  // 超时 → ERROR
    PENDING_REVIEW: await runReviewHalf()
      // 收集 diff → 跑 checks → 原子写 review-request.md → 置 IN_REVIEW → 等裁决 → 回写
    IN_REVIEW:    // 等 verdict（三模式各自的等待逻辑，见 §11）；超时 → ERROR
    ERROR:        按 onError 转 PENDING_DEV 或 NEEDS_HUMAN
    NEEDS_HUMAN / COMPLETED: sleep(pollIntervalSec)
```

## 7. 执行器（executor.ts）
- `run(cmd: string[], opts): {code, stdout, stderr, timedOut}`，基于 execa，`shell: false`。
- 超时：到点先发 SIGTERM，5 秒不死发 SIGKILL（Windows 上 execa 已处理 taskkill）。
- 输出捕获：stdout/stderr 各保留**尾部 256KB**（ring buffer），防止日志爆内存。
- checks 命令（如 `npm run build`）在 Windows 必须走 shell：此类命令单独用 `shell: true` 执行。

## 8. git 模块（gittool.ts）
- `getHeadCommit()` / `hasNewCommitSince(ref)`。
- `collectDiff(ref, maxKB)`：
  1. `git diff <ref>..HEAD` 全文；≤ maxKB 直接返回；
  2. 超限时降级：`git diff --stat <ref>..HEAD` 全量 + 逐文件 `git diff <ref>..HEAD -- <file>` 各取前 200 行，标注 `... [truncated]`；
  3. 未跟踪文件附 `git status --porcelain` 清单。
- 无新 commit（`HEAD === lastApprovedCommit`）→ 管线直接产出打回结论"未提交代码"，不调监工。

## 9. 上下文组装（context.ts）
- **施工提示词** = builder 角色卡 + docs/tech.md + 当前任务段落（impl.md 中该 task_id 的行与其子行）+ bridge.md 自由区"本轮指令" + 协议动作要求（来自 prompts/builder-cli.md 或 builder-loop.md 模板）。**不注入 prd.md。**
- **review-request.md** = supervisor 角色卡 + docs/prd.md + tech.md + test.md 摘要 + 当前任务段落（含 task_id 与当前 round）+ diff（截断后）+ checks 日志（尾部各 32KB）+ 输出契约（Verdict JSON Schema 说明）。
- 模板占位符：`{{TASK}}` `{{INSTRUCTIONS}}` `{{DOCS_TECH}}` 等，简单字符串替换，不引入模板引擎。

## 10. 命令行长度陷阱（重要）
Windows 命令行上限约 8191 字符，提示词经常超限。因此：
- builder Mode A / supervisor Mode CLI 的 args 支持两个占位符：`{prompt}`（直接内联）与 **`{promptFile}`（写临时文件传路径，推荐默认）**。
- 临时文件放 `.bridge/tmp/`，用后即删。

## 11. 监工三模式实现
- **api.ts**：`review(requestMd) → Verdict`。把 requestMd 作为 user message，system 为 supervisor 角色卡。OpenAI 兼容 provider 支持 `baseURL` 配置（DeepSeek/通义）。失败重试：429/5xx 指数退避（1s/2s/4s，最多 3 次）。整体耗时受 `supervisor.timeoutMin` 约束。token 用量累加进 state.json。
- **cli.ts**：spawn 配置的 CLI（promptFile 模式），要求其读 `.bridge/review-request.md` 并写 `.bridge/verdict.json`；进程退出后走 watch.ts 同一套收取逻辑。
- **watch.ts**：轮询 `.bridge/verdict.json` 出现（间隔 pollIntervalSec，超时 `supervisor.timeoutMin`）。
  - **容错读取（重要）**：verdict.json 由外部 AI 直接写入、不保证原子性。JSON 解析失败时**先等下一 tick 重读，最多宽限 3 个 tick**；仍失败才按"非法输出"处理。防止读到写了一半的文件就误判。
  - 校验通过后**原子消费**（rename 到 logs 目录归档）。zod 校验 + task_id 匹配 + round 陈旧判定（§3.2）。
- **重问机制（三模式共用）**：裁决非法 → 把错误原因追加进 review-request.md 末尾，重问**一次**（watch 模式下体现为等下一个 tick 时监工看到追加内容后重写 verdict.json）；再非法 → ERROR 按 onError 处理。

## 12. 施工两模式实现
- **cli.ts（Mode A）**：组装提示词 → 写 promptFile → spawn → 等退出/超时 → 检查 bridge.md 是否翻转为 PENDING_REVIEW（翻转即成功；未翻转按失败处理）。
- **watch.ts（Mode B）**：不 spawn 任何进程；首次进入时在终端打印一次提示"请确认 IDE 侧施工定时任务已注册（行动信号 = PENDING_DEV 或 IN_DEV）"，随后依赖轮询等施工 tick 收工翻状态；`builder.timeoutMin` 超时按 ERROR 处理。
- 半成品处理：进入开发半循环时若检测到工作区有未提交改动，在提示词/日志中标注"存在上轮残留"，交给施工 AI 按 builder-loop.md 的指引自行决断（补完或放弃）。

## 13. 日志（logger.ts）
每轮验收生成 `.bridge/logs/T{taskId}-r{round}-{approve|reject|error}.md`，含：时间戳、diff 全文（不截断，截断只影响发给监工的版本）、checks 完整输出、监工原始输出、最终 Verdict。开发轮次超时/崩溃也生成 `T{id}-r{round}-dev-error.md`。

## 14. 环境变量插值（config.ts）
加载 JSON 后递归遍历字符串值，`${VAR_NAME}` 替换为 `process.env.VAR_NAME`；变量不存在 → 启动即报错退出（exit code 2），并指出缺失变量名。**不**支持默认值语法、不嵌套。
**例外（与 §3.3 按模式校验呼应）**：只对启用模式必需的字段做插值；未启用模式的配置段整体跳过插值与校验（mode=watch 时不强求 ANTHROPIC_API_KEY 存在）。

## 15. CLI 命令规格
| 命令 | 行为 | 关键 flag |
|---|---|---|
| `init` | 生成目录骨架：docs/(四件套模板) agents/(双角色卡) prompts/(三模板) bridge.md(初始 PENDING_DEV/T1) .bridge.config.json；.gitignore 追加 `.bridge/` 与 `.bridge.config.json` | `--force` 覆盖已存在文件（默认 skip 并提示） |
| `watch` | 启动守护进程（§6 主循环） | `--config <path>` |
| `once` | 只执行当前状态对应的一个半循环后退出（调试主力） | `--dry-run` 打印将发送的 prompt/请求，不起进程不调 API |
| `status` | 打印当前 bridge.md 状态、impl.md 完成度、最近 5 条日志摘要 | — |
| `resolve` | NEEDS_HUMAN → PENDING_DEV（retry 清零），可 `--skip` 标记跳过当前任务 | `--skip` |

退出码：0 成功；1 运行期错误；2 配置/环境错误；3 状态文件非法。

## 16. 错误处理矩阵
| 场景 | 处理 |
|---|---|
| bridge.md 解析失败 | ERROR 状态 + 日志，不自动重试（防止覆盖人工修复） |
| checks 命令失败（非零退出） | 不算 ERROR——这是正常验收素材，日志交给监工判断 |
| 监工 API/CLI/verdict 异常 | 重问一次 → 再失败 ERROR → onError 逻辑 |
| git 命令失败（非 git 仓库等） | ERROR + 明确错误信息 |
| 配置文件缺失/启用模式校验失败/必需 env 缺失 | 启动即退出 code 2 |

## 17. 跨平台注意事项
- 所有路径拼接用 `path.join`，禁止字符串拼 `/`。
- 文件读写统一 UTF-8、`\n` 换行（写入前 `replace(/\r\n/g,'\n')`）。
- 单测必须在 Windows 实跑（CI 加 windows-latest）。
