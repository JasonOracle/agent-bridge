# 产品文档 (PRD) — Agent-Bridge

## 1. 一句话定位
Agent-Bridge 是一个 Node.js CLI 工具，充当"元智能体调度器"：通过文件系统协议，让**任意一个开发 Agent 工具当监工（验收方）、任意另一个当施工（开发方）**，全自动乒乓式完成项目开发，全程无需人工干预。

## 2. 目标用户与场景
- **极客/独立开发者**：手头有多个 AI 编码工具订阅（Claude Code、Codex、WorkBuddy、Antigravity、Trae……），想让它们 7×24 自动协作干活。
- **开源社区**：想要一个比 AutoGen/MetaGPT 轻量、不锁定特定模型生态的多 Agent 编排方案。

典型场景：用户在文件夹里放好需求文档，指定 Antigravity 当监工、WorkBuddy 当施工，然后去睡觉；醒来时项目已按任务清单开发完毕并通过验收。

## 3. 核心原则（不可妥协）
1. **大模型当架构师验收代码，不当码农**——监工只 Review，施工只写码。
2. **文件系统是唯一总线**——两侧 Agent 之间、Agent 与桥接器之间，全部通过文件契约通信（bridge.md / .bridge/*.md / verdict.json）。不引入消息队列、数据库、网络服务。
3. **品牌无感**——接入新工具不改代码，只改配置（command/args）或换提示词模板。
4. **全自动是承诺，熔断是底线**——正常路径零人工；异常路径有重试上限和熔断状态，绝不无限循环烧钱。
5. **Windows 一等公民**——开发环境和目标用户大量在 Windows，不用 inotify、小心命令行长度限制和路径分隔符。

## 4. 功能范围（In Scope）
- 状态机协议：bridge.md 双区文件（YAML 机器区 + markdown 自由区），7 态（PENDING_DEV / IN_DEV / PENDING_REVIEW / IN_REVIEW / NEEDS_HUMAN / ERROR / COMPLETED）。
- 守护进程 `watch`：定时轮询（默认 5s）驱动两个半循环。
- 施工接入：Mode A（spawn 无头 CLI）、Mode B（IDE 定时任务/长会话提示词）。
- 监工接入：Mode API（Claude/OpenAI 兼容）、Mode CLI（spawn 无头 CLI）、Mode B（IDE 定时任务）。
- 验收管线：git diff 收集（含截断降级）→ checks 执行 → review-request.md 生成 → 监工裁决（verdict JSON Schema）→ 状态回写（打勾/打回/熔断）。
- 审计：`.bridge/logs/` 每轮留档；`.bridge/state.json` 内部状态。
- CLI 命令：`init` / `watch` / `once` / `status` / `resolve`。
- 熔断策略：`onMaxRetry: human | skip`。

## 5. 非目标（Out of Scope，v1 不做）
- 多施工并行、多项目复用同一守护进程。
- Web UI / 图形界面。
- 云端部署、远程 Agent 编排。
- 自动安装/管理第三方 Agent 工具本体。
- 监工直接修改代码（监工只能评审，禁止动手——这是协议红线）。

## 6. 成功度量
- 自证实验：examples/todo-app（5 任务）全自动跑通，人工干预 0 次，总轮次 ≤ 15，杀进程/重启桥接器各自愈一次。
- 开发者体验：新机器 clone 后 15 分钟内跑通示例（README 实测）。

## 7. 术语表
| 术语 | 含义 |
|---|---|
| 桥接器 | agent-bridge 本体（守护进程） |
| 监工 / supervisor | 验收方 Agent |
| 施工 / builder | 开发方 Agent |
| tick | 一次轮询周期；也指 IDE 定时任务的一次唤醒 |
| 半循环 | 开发半循环（PENDING_DEV→PENDING_REVIEW）/ 验收半循环（PENDING_REVIEW→回写） |
| 角色卡 | agents/*.md，定义某侧 Agent 行为规范的提示词文档 |
