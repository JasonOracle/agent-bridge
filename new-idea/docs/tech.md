# 技术规范 (Tech Spec) — 响应式双端 AI 协作协议

## 1. 技术栈与依赖约束

### 1.1 `watchdog.js` 技术栈
- **运行时**：Node.js >= 18（使用原生 ESM，`"type": "module"`）
- **依赖**：**零第三方依赖**，仅使用 Node.js 内置模块：`node:fs`、`node:path`、`node:child_process`、`node:timers`
- **语言**：纯 JavaScript（不使用 TypeScript，降低用户使用门槛，无需 tsc 编译步骤）
- **文件大小目标**：单文件，≤ 300 行

### 1.2 `PROTOCOL.md` 和所有 Prompt 文件
- 纯 Markdown 文本，无代码依赖
- 不依赖任何特定 IDE 功能或 SDK

### 1.3 Antigravity Skills（Layer 3）
- 遵循 Antigravity IDE 的 Customization 规范（SKILL.md + YAML frontmatter）

---

## 2. 核心文件格式规范

### 2.1 `bridge.md` 格式

**唯一格式，不允许偏差**：

```
\`\`\`yaml
status: PENDING_DEV
task_id: T1
round: 1
retry: 0
updated_at: 2026-09-15T14:30:00+08:00
last_commit: null
error: null
\`\`\`

## 本轮指令
（Supervisor 写给 Builder 的具体指令，或初始化说明）

## 上轮评审摘要
（最近一轮意见；完整历史在 .bridge/logs/）
```

**机器区字段类型定义**（必须严格遵守）：
```typescript
interface BridgeState {
  status: 'PENDING_DEV' | 'IN_DEV' | 'PENDING_REVIEW' | 'IN_REVIEW' | 'NEEDS_HUMAN' | 'ERROR' | 'COMPLETED';
  task_id: string | null;       // 格式：T\d+（如 T1, T2）
  round: number;                // 整数，从 1 开始
  retry: number;                // 整数，从 0 开始
  updated_at: string;           // ISO 8601 格式（含时区）
  last_commit: string | null;   // git commit hash，短格式（7位）
  error: string | null;         // 错误描述，无错误时为 null
}
```

### 2.2 Verdict JSON 格式（Supervisor 审查输出）

Supervisor 的 Loop Prompt 必须指示 AI 输出以下格式（写入 `.bridge/verdict.json`，由 Watchdog 消费）：

```typescript
interface Verdict {
  verdict: 'approve' | 'reject';
  task_id: string;
  round: number;
  summary: string;              // 一句话总结，≤ 100 字
  issues: Array<{
    severity: 'blocker' | 'warning' | 'suggestion';
    desc: string;
  }>;
  next_instructions: string;    // approve 时为空字符串；reject 时为修改指令
}
```

### 2.3 `.bridge/review-request.md` 格式（Watchdog 预组装）

```markdown
# 审查请求 — {task_id} (Round {round})

## 任务说明
{从 impl.md 提取的当前任务段落，含验收标准}

## 验收规范（来自 docs/test.md）
{test.md 中与当前任务相关的测试标准}

## 代码变更 (git diff)
{git diff [lastApprovedCommit]..HEAD，超过 maxDiffKB 则截断并附文件名列表}

## 自动化校验日志
{checks 命令执行结果（pnpm build 等），含退出码}
```

### 2.4 `.bridge/internal-state.json` 格式

```typescript
interface InternalState {
  lastApprovedCommit: string | null;  // 上一个 approve 时的 commit hash
  startedAt: string;                  // Watchdog 启动时间
  currentTaskStartedAt: string | null;// 当前任务开始时间（用于超时检测）
}
```

### 2.5 `watchdog.config.json` 格式（可选，优先于内置默认值）

```json
{
  "pollIntervalSec": 5,
  "devTimeoutMin": 45,
  "reviewTimeoutMin": 10,
  "maxRetryPerTask": 5,
  "onError": "retry",
  "maxDiffKB": 64,
  "checks": ["pnpm build"],
  "builder": {
    "mode": "signal",
    "signalFile": ".bridge/signal-builder.txt"
  }
}
```

> `builder.mode` 有两种选项：
> - `"signal"`：写入信号文件，适用于 GUI IDE（如 Workbuddy）等待唤醒的场景
> - `"cli"`：直接 spawn CLI 子进程（适用于无头工具），需配置 `command` 和 `args`

---

## 3. 目录结构（完整）

```
project-root/
├── PROTOCOL.md                         ← [Layer 1] 协议规范（必须第一个完成）
├── watchdog.js                         ← [Layer 2] 看门狗脚本（纯 Node.js，零依赖）
├── prompts/
│   ├── builder-loop.md                 ← [Layer 2] Builder 单次行为规范 Prompt
│   └── supervisor-loop.md              ← [Layer 2] Supervisor 单次行为规范 Prompt
├── QUICK_START_BUILDER.md              ← [Layer 3] 任意工具的 Builder 快速启动卡
├── QUICK_START_SUPERVISOR.md           ← [Layer 3] 任意工具的 Supervisor 快速启动卡
├── skills/
│   └── agent-bridge-supervisor/        ← [Layer 3] Antigravity IDE Skill
│       └── SKILL.md
├── bridge.md                           ← 运行时状态机（用户 init 后生成）
└── .bridge/
    ├── review-request.md               ← Watchdog 每轮预组装（Supervisor 只读这里）
    ├── verdict.json                     ← Supervisor 写入，Watchdog 消费后删除
    ├── internal-state.json              ← Watchdog 内部状态持久化
    └── logs/
        └── review-T1-1.md              ← 格式: review-{taskId}-{round}.md
```

---

## 4. `watchdog.js` 模块职责详解

### 4.1 主循环逻辑（伪代码）

```javascript
// 双保险：setInterval + fs.watch
const POLL_INTERVAL_MS = 5000; // 默认 5 秒轮询
let lastStatus = null;

function tick() {
  const { state } = readBridge('bridge.md');

  if (state.status === lastStatus) return; // 状态未变，静默跳过
  lastStatus = state.status;

  switch (state.status) {
    case 'PENDING_DEV':
      notifyBuilder(state); // 通知/唤醒 Builder
      break;
    case 'PENDING_REVIEW':
      assembleReviewRequest(state); // 预组装审查材料
      // Supervisor 通过自己的定时器检测，Watchdog 不主动唤醒
      break;
    case 'IN_DEV':
      checkDevTimeout(state); // 检测开发超时
      break;
    case 'IN_REVIEW':
      checkReviewTimeout(state); // 检测审查超时
      consumeVerdictIfExists(state); // 消费 verdict.json
      break;
    case 'NEEDS_HUMAN':
      alertHuman(state); // 终端输出告警
      process.exit(1);
      break;
    case 'COMPLETED':
      console.log('[Watchdog] 🎉 全部任务完成！');
      process.exit(0);
  }
}

setInterval(tick, POLL_INTERVAL_MS);
fs.watch('bridge.md', tick); // 事件驱动辅助
```

### 4.2 `notifyBuilder` 实现策略

| Builder 工具类型 | 通知方式 |
|---|---|
| CLI 工具（如 Claude Code）| `child_process.spawn(builderCommand, args)` |
| GUI IDE（如 Workbuddy）| 写入 `.bridge/signal-builder.txt`（内容为任务指令），IDE 侧检测此文件后读取并开工 |

### 4.3 `assembleReviewRequest` 流程
1. 运行 `git diff {lastApprovedCommit}..HEAD`，截断至 `maxDiffKB`（默认 64KB）
2. 运行 `checks` 数组中的命令（如 `pnpm build`），记录 stdout/stderr 和退出码
3. 拼装 `.bridge/review-request.md`（见 2.3 节格式）
4. 将 `bridge.md` 状态从 `PENDING_REVIEW` 切换到 `IN_REVIEW`（Watchdog 写，不是 AI）

### 4.4 超时检测参数
- `devTimeoutMin`：Builder 开发超时（默认 45 分钟），`IN_DEV` 停留超过此值 → `ERROR`
- `reviewTimeoutMin`：Supervisor 审查超时（默认 10 分钟），`IN_REVIEW` 停留超过此值 → `ERROR`
- `maxRetryPerTask`：单任务最大重试次数（默认 5），超出 → `NEEDS_HUMAN`

---

## 5. Loop Prompt 设计约束

### 5.1 `builder-loop.md` 必须包含
- Builder 读取文件清单：`bridge.md`（含自由区）、`docs/tech.md`、当前任务的 `impl.md` 段落
- Builder **禁止**读取：`docs/prd.md`（防止自由发挥）
- Builder 开工前必须原子写入 `IN_DEV` 状态（独占锁）
- Builder 完成后必须先 `git add -A && git commit -m "[bridge] T{n}: {描述}"` 再写 `PENDING_REVIEW`
- Builder **禁止修改** `impl.md`、`docs/*`、`agents/*`

### 5.2 `supervisor-loop.md` 必须包含
- Supervisor 读取来源：**仅** `.bridge/review-request.md`（不自己去收集 diff）
- Supervisor 输出：写入 `.bridge/verdict.json`（标准 JSON，不是 Markdown）
- Supervisor **严禁直接写入 `bridge.md`**（包括 `PENDING_DEV`、`IN_REVIEW`、`COMPLETED`），这些均由 Watchdog 根据 `verdict.json` 自动处理
- Supervisor 完成后：**必须立刻重新注册下一次定时唤醒**（除非读到的 status 为 COMPLETED/NEEDS_HUMAN）
- Supervisor **严禁修改** `impl.md`

---

## 6. 合法状态迁移表（代码实现必须遵守）

```
PENDING_DEV   → IN_DEV（Builder 开始写代码前写入）
IN_DEV        → PENDING_REVIEW（Builder 完成 commit 后写入）
IN_DEV        → ERROR（超时或异常，Watchdog 写入）
PENDING_REVIEW→ IN_REVIEW（Watchdog 收集完 diff + 构建日志后写入）
IN_REVIEW     → PENDING_DEV（Watchdog 消费 reject verdict 后写入）
IN_REVIEW     → COMPLETED（Watchdog 消费 approve verdict 且无剩余任务后写入）
IN_REVIEW     → ERROR（Supervisor 超时，Watchdog 写入）
ERROR         → PENDING_DEV（按 onError=retry 策略，Watchdog 写入）
ERROR         → NEEDS_HUMAN（重试耗尽，Watchdog 写入）
NEEDS_HUMAN   → PENDING_DEV（人工 resolve 后，Watchdog 写入）
```

**关键写入方划分（严格执行）**：
- **Builder（AI）只写**：`IN_DEV`、`PENDING_REVIEW`
- **Supervisor（AI）只写**：`.bridge/verdict.json`（裁决结果）
- **Watchdog（程序）写入其余所有状态**：`IN_REVIEW`、`PENDING_DEV`、`COMPLETED`、`ERROR`、`NEEDS_HUMAN`

**严禁的非法迁移**：任何跳过中间状态的直接迁移（如 `PENDING_DEV → PENDING_REVIEW` 跳过 `IN_DEV`）将被 Watchdog 检测并回满至 `ERROR`。
