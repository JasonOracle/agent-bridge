# 命令行指南 (CLI Usage)

Agent-Bridge 提供了一个极简的命令行工具，用于一键将协议脚手架注入到任意本地项目中。

## 安装与运行

推荐通过 `npx` 直接运行，保持始终使用最新版本：

```bash
npx agent-bridge init
```

*如果在全局安装，也可以执行 `agent-bridge init`。*

## 命令说明

### `init`
在当前工作目录下初始化 Agent-Bridge 骨架环境。
该命令是幂等的（多次执行不会破坏已有核心业务代码，但会覆盖桥接模板文件）。

**生成的文件树清单**：
- `watchdog.cjs`：看门狗后台守护脚本（直接使用 `node watchdog.cjs` 启动）。
- `agent-wait.cjs`：供 Agent 调用的强制挂起阻塞脚本。
- `bridge.md`：核心状态机文件（默认初始化为 `PENDING_DEV / T1`）。
- `START_BUILDER.md`：给施工方 Agent 的唤醒提示词。
- `START_SUPERVISOR.md`：给监工方 Agent 的唤醒提示词。
- `docs/prd.md`：产品需求文档模板。
- `docs/impl.md`：技术实现与任务拆分清单模板。

## 高级用法

初始化完成后，所有的行为将脱离 CLI 工具本身。
你无需再次执行 `npx agent-bridge`，系统的后续运转完全依赖于运行目录下的 `node watchdog.cjs`，这意味着你可以**随意魔改**生成的 `watchdog.cjs` 和 `agent-wait.cjs`，无需顾虑破坏全局包结构。
