# 产品需求文档 (PRD) — 响应式双端 AI 协作协议

## 1. 产品背景与问题定义

### 1.1 要解决的核心问题
现有多 Agent 协作框架（包括当前 `agent-bridge`）在 **GUI IDE 场景**下存在以下无法回避的缺陷：
1. **监工方（Supervisor）必须死循环轮询状态文件**，导致 AI 对话界面长期锁死在 `Working...`，Token 无意义空转消耗。
2. **施工方（Builder）完成一个任务后停下来等待**，若监工响应迟滞，整个流水线卡死，人类不得不切屏手动传话。
3. **无中央守护进程时，两侧工具互相不知对方状态**，协作依赖人类充当"血肉路由器"。

### 1.2 不解决的问题（Non-Goals，防止范围蔓延）
- **不**开发新的 AI 模型或 LLM API
- **不**替代现有 `agent-bridge watch` CLI 的 Mode A（CLI 驱动）场景，本系统与其兼容共存
- **不**做 Web UI 或可视化仪表板
- **不**依赖 MCP、WebSocket 或任何私有实时通信协议
- **不**做多项目并行管理，每个项目目录独立运行一套

---

## 2. 核心产品理念

**Pinia 响应式仓库模式（Reactive Store Pattern）**

借鉴 Vue3 Pinia 的设计思想：
- `bridge.md` = 共享状态仓库（Store）
- Builder 工具 = 订阅 `PENDING_DEV` 变化的组件，自动开工
- Supervisor 工具 = 订阅 `PENDING_REVIEW` 变化的组件，自动审查
- `watchdog.js` = Store 的调度中心，负责检测变更并通知两侧组件，本身**不调用任何 LLM**

---

## 3. 用户与使用场景

### 3.1 主要用户
- 使用 GUI AI 编程工具（如 Workbuddy、Cursor、Antigravity IDE）的独立开发者
- 希望实现"AI 全自动开发"但不想搭建复杂 DevOps 管道的用户

### 3.2 核心使用场景
**场景 A（目标场景）**：用户准备好文档后，给两个 AI 工具各发一次启动指令，然后人走开，等待 `COMPLETED`。

**场景 B（兼容场景）**：只使用看门狗 + Builder（CLI 工具），Supervisor 使用 API 直调，完全无人值守。

---

## 4. 功能需求（按优先级）

### P0 必须实现
| 功能 | 描述 | 验收标准 |
|---|---|---|
| 状态机驱动 | `bridge.md` 作为共享状态，支持全部 7 种状态的合法流转 | 任何非法迁移被检测并回滚至 `ERROR` |
| 看门狗守护 | `watchdog.js` 纯文件 I/O 驱动，不调用 LLM | CPU 占用 < 1%，内存 < 30MB，7×24 不崩溃 |
| 审查材料预组装 | Watchdog 在切换到审查阶段前自动收集 git diff + 构建日志 | Supervisor 只需读一个文件即可完成完整审查 |
| Builder Loop Prompt | 定义 Builder 单次行为规范 | 任意支持文件读写和终端命令的 AI 工具均可接入 |
| Supervisor Loop Prompt | 定义 Supervisor 单次行为规范 | 任意支持文件读写和定时器的 AI 工具均可接入 |
| 协议规范文档 | 独立的 `PROTOCOL.md`，工具无关 | 开发者读完后可独立实现兼容接入，无需查看其他文件 |

### P1 应该实现
| 功能 | 描述 |
|---|---|
| 快速启动卡 | `QUICK_START_BUILDER.md` + `QUICK_START_SUPERVISOR.md`（5 行内，任意工具粘贴即用）|
| Antigravity Skills | 封装成一键激活的 IDE Skill |
| 超时容灾 | 陈旧状态自动转 `NEEDS_HUMAN` 并终端告警 |

### P2 未来可做
| 功能 | 描述 |
|---|---|
| `fs.watch` 事件增强 | 在 `setInterval` 基础上叠加 `fs.watch`，降低状态感知延迟至毫秒级 |
| MCP Server | 将 `bridge.md` 状态封装为 MCP 工具，推送事件而非轮询 |

---

## 5. 关键约束（硬性红线，不可妥协）

1. **`impl.md` 打勾只能由程序化逻辑执行**，AI 不得直接修改（防止 AI 给自己放水）
2. **任一时刻系统内只允许一个活跃 Builder 和一个活跃 Supervisor**（通过 `IN_DEV`/`IN_REVIEW` 状态作为独占锁）
3. **Builder 必须在 git commit 后才能翻转 `PENDING_REVIEW`**（无 commit 则 Supervisor 无 diff 可审查）
4. **Watchdog 不得调用任何 LLM API**（它是纯基础设施，必须极度轻量可靠）
5. **全部交付物工具无关**：不依赖特定 IDE、不依赖特定 LLM 品牌、不依赖任何私有 SDK
