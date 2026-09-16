# 实战案例 (Examples)

Agent-Bridge 的最大魅力在于**工具无关**。你可以将任何市面上顺手的 AI 工具组合起来，打造属于你自己的自动化代码车间。

以下列举两种最典型的实战搭配。

## 场景 1：黄金搭档 (Cursor + Antigravity IDE)

这是当前最推荐的高效搭配。利用 Cursor 极其强大的局部代码修改能力，加上 Antigravity 作为极度客观的终端判官。

- **Builder (施工方)** = Cursor (通过 Agent 模式)
- **Supervisor (监工方)** = Antigravity IDE (通过 Codex CLI)

### 操作步骤
1. 在项目根目录执行 `npx agent-bridge init`。
2. 填好 `docs/prd.md`，写明需求。
3. 打开 Windows Terminal/iTerm，执行 `node watchdog.cjs`。
4. 打开 Antigravity IDE，向其发送 `START_SUPERVISOR.md` 中的内容。它会主动设置心跳检测脚本并退居后台。
5. 打开 Cursor Composer (Agent 模式)，向其发送 `START_BUILDER.md` 的内容。
6. 放开双手。Cursor 会开始修改代码，完成后调用 `agent-wait.cjs` 挂起；Watchdog 切状态；Antigravity 启动终端跑测试、查 Git Diff 并在出错时直接打回给 Cursor。

## 场景 2：开源替代 (Workbuddy + Claude CLI)

如果你没有 Cursor，使用免费的开源工具链同样可以建立无尽的重构车间。

- **Builder (施工方)** = Workbuddy (或其他能在 IDE 中写代码的插件)
- **Supervisor (监工方)** = 一个纯 CLI 封装的 Claude/GPT 脚本

### 应对“工具超时”的进阶技巧
在实战中，某些 AI 工具存在“最大命令执行超时（如 120秒）”机制。当监工审查极慢时，Builder 可能会提前结束挂起退回空闲状态。
为了解决这个问题，在生成的 `START_BUILDER.md` 提示词中，我们强烈要求了：**“如果 agent-wait 返回超时，你必须立刻重新调用该命令，绝不允许停止思考”。**
