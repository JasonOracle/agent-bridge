# Agent-Bridge

> **A zero-dependency framework for autonomous dual-agent collaboration.**

Agent-Bridge 是一个极简的、基于纯文件状态机的多智能体协作脚手架。它允许你通过一个轻量级的 Watchdog（看门狗），将两个独立运行的 AI 编程助手（如 Workbuddy 与 Antigravity IDE）无缝桥接，实现“施工方 (Builder)”与“监工方 (Supervisor)”的自动化流转与代码审查，全程**零人工干预**。

## 核心特性
- **零依赖**：只使用纯原生 Node.js，无需安装庞大的 npm 包，也不受限于任何特定的 Agent 框架。
- **工具无关**：只要 AI 工具能读写文件、能执行终端（Builder）或定时任务（Supervisor），就能接入。
- **强制约束**：七态严格状态机 + 原子写入，从根本上解决多智能体协作中常见的“状态冲突”、“互相覆盖”和“自己糊弄自己”的幻觉问题。
- **开箱即用**：自带预设的 Prompt Loop 和 Role Cards，一键下发指令。

## 快速开始

在任意空白或现有项目的根目录下，执行初始化命令：

```bash
npx agent-bridge init
```

执行后，你的目录下会生成一套桥接骨架文件，包括 `watchdog.cjs`、`prompts/` 循环指令、`agents/` 角色卡模板等。

### 工作流 (4步)

1. **写需求**：在生成的 `docs/prd.md` 和 `docs/impl.md` 中写下你的业务需求和拆解好的任务清单。
2. **启动 Watchdog**：在终端运行 `node watchdog.cjs`。看门狗会开始监控状态并在后台流转状态机。
3. **唤醒 Builder**：打开你的编程工具 A（例如 Cursor/Workbuddy），复制 `START_BUILDER.md` 里的文本发给它，它就会开始写代码并提 PR。
4. **唤醒 Supervisor**：打开你的编程工具 B（例如 Antigravity IDE），复制 `START_SUPERVISOR.md` 发给它，它会在后台注册定时任务，开始严格 review 提交的代码。

然后，你就可以去喝杯咖啡，回来验收了。

## License
MIT
