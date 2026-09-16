# 贡献指南 (Contributing to Agent-Bridge)

非常感谢你考虑为 Agent-Bridge 做出贡献！本项目致力于打造最极简、无依赖的多 Agent 协作底层框架，任何帮助（无论是提交 Issue 还是 Pull Request）我们都非常欢迎。

## 1. 我们需要什么贡献？

- **新工具适配经验**：提供在各种新出的 AI 编程工具上的配置/引导 Prompt 最佳实践。
- **Agent 角色卡 (Role Cards) 模板**：提供不同业务场景的模板（如：针对 Rust 重构的专精审查卡片、Python 爬虫开发卡片等）。
- **Watchdog 脚本增强**：跨平台（Linux/macOS/Windows）的死锁预防、进程唤醒增强、终端兼容性修复。
- **文档纠错与翻译**：完善中英文文档，或者补充更易懂的接入教程。

## 2. 核心架构约束（PR 提交红线）

Agent-Bridge 之所以轻量且泛用，是因为它死守了以下几条核心规则。在提交 PR 前，请确保你的代码没有破坏这些规则：

1. **绝对零依赖**：禁止在核心代码（如 `watchdog.cjs`, `agent-wait.cjs`）中引入任何 npm 三方库（如 `axios`, `chalk`, `commander` 等）。必须 100% 依赖 Node.js 原生 API 解决。
2. **纯文件通信**：禁止引入 RPC、Socket 或 HTTP 服务作为核心通信协议。Agent 间的互锁必须仅依赖读取本地的 `.bridge` 或 `bridge.md` 物理文件实现。
3. **保持逻辑透明**：Watchdog 代码不得过度面向对象抽象，必须保持极简的、线性的轮询状态机代码风格，方便各个使用者拿过去后能秒懂并随意魔改。

## 3. 提交 PR 流程

1. **Fork 本仓库** 到你的个人 GitHub 账号下。
2. **克隆代码** 到本地：
   ```bash
   git clone https://github.com/YourUsername/agent-bridge.git
   ```
3. 创建新的功能分支 (`git checkout -b feature/amazing-feature`)。
4. 做出你的修改并测试。
5. 提交你的修改 (`git commit -m 'feat: Add amazing feature'`)。
6. 推送分支到远端 (`git push origin feature/amazing-feature`)。
7. 在 GitHub 上向原仓库提交 **Pull Request**。

## 4. 提交信息的规范 (Commit Guidelines)

我们遵循标准的 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) 规范：

- `feat:` 新功能或新增模板
- `fix:` 修复 Bug
- `docs:` 文档变更
- `chore:` 杂项整理或脚手架更新
- `refactor:` 代码重构

## 5. 报告问题 (Bug Reports & Issues)

如果在运行中遇到框架级别的死锁或逻辑漏洞，请通过 GitHub Issue 提交报告。报告应包含：
1. 涉及的 Agent 客户端环境（如 Cursor / Antigravity CLI 等）。
2. Node.js 环境版本与系统架构。
3. Watchdog 崩毁时的终端日志原文。
4. 可稳定复现该问题的最简流程。

---
*感谢你的加入，让我们一起构建真正无人干预的自治代码车间！*
