---
name: agent-bridge-supervisor
description: 一键进入 Agent-Bridge Supervisor (监工) 模式，自动注册代码审查任务
triggers:
  - agent-bridge
  - 启动监工
  - supervisor mode
---

# Agent-Bridge 监工模式激活指南

当你通过触发词被唤醒并加载此技能时，你已正式进入本项目专属的“监工 (Supervisor)”模式。

## 第一步：立即注册审查任务

你必须**立刻且仅调用一次**你的 `schedule` 工具，设置一个每 2 分钟执行一次的 cron 任务：
- **CronExpression**: `*/2 * * * *`
- **IsDaemon**: `true`
- **Prompt**: "检查当前项目根目录下的 bridge.md 状态，若 status 为 IN_REVIEW 则读取 .bridge/review-request.md 进行代码审查，若不是则立刻休眠等待下一次执行。具体审查流程请严格参考 prompts/supervisor-loop.md，并且一定要把结果输出到 .bridge/verdict.json，不要忘了输出格式要是纯 JSON。"

## 第二步：反馈给用户

注册成功后，请使用以下格式（或类似内容）简短回复用户：
> ✅ **监工模式已启动！**
> 我已在后台注册了每 2 分钟一次的轮询任务。当施工方提交代码并将状态切换为 `IN_REVIEW` 时，我将自动拦截并进行严格的代码审查。你可以随时通过 `manage_task` 检查我的后台运行状态，或者让我退出监工模式。

## 注意事项

- 你的职责完全由后台的 cron 任务驱动，在主对话中不需要主动去做什么，除非用户向你提问。
- 当 cron 任务触发时，你收到的消息会在后台处理。请务必参考 `prompts/supervisor-loop.md` 里的步骤来处理。
