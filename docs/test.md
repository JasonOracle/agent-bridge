# 测试文档 — Agent-Bridge

## 1. 测试策略
- **框架**：vitest（`npm test`）。测试文件与源码同目录，`*.test.ts`。
- **分层**：
  - 单元测试：config / state / logger / context / gittool / executor（mock 子进程与文件系统边界用真实临时目录，不用内存 mock——文件协议是本项目核心，必须真读写）；
  - 契约测试：用 node 写的"假 Agent CLI"脚本（`test/fakes/`），模拟施工 CLI（改 bridge.md 状态）与监工 CLI（写 verdict.json），验证 spawn 类模式的真实进程交互；
  - 集成测试：`once` 命令全流程在临时 git 仓库中跑通。
- **不 mock 的部分**：文件系统、git（用临时仓库）、子进程（用 fakes）。**可 mock 的部分**：Anthropic/OpenAI HTTP 请求（mock fetch）。

## 2. checks 命令（写进 .bridge.config.json，监工验收时执行）
```json
"checks": ["npm run build", "npm test"]
```
即每个任务提交前必须：TypeScript 编译零错误 + 全部测试通过。

## 3. 覆盖率与质量要求
- `src/state.ts` 行覆盖率 ≥ 90%（状态机是命门）；
- 其余模块关键分支（超时、非法输入、重问）必须有对应用例；
- `npm run lint`（tsc --noEmit）零错误。

## 4. 必测场景清单（监工 Review 时逐项核对）
1. bridge.md：缺 YAML 块 / YAML 语法错 / 字段缺失 / 非法 status / 非法迁移回滚 / 原子写（读到一半崩溃不留坏文件）
2. 配置：缺 env 变量退出码 2 且报变量名；非法 mode 报错
3. executor：超时进程被强杀；stdout 超 256KB 只留尾部；Windows 下 `npm run build` 走 shell 成功
4. gittool：diff ≤64KB 原文返回；>64KB 降级 stat+截断并带 `[truncated]` 标记；无新 commit 返回空
5. context：施工 prompt 断言**不含** prd.md 的任何句子；review-request.md 含四件套+diff+日志
6. supervisor：非法 JSON / task_id 不匹配 / reject 无 next_instructions → 重问一次 → 再非法转 ERROR；verdict.json 迟到超时
7. builder：假 CLI 翻状态成功；超时未翻转 → ERROR 且 retry+1
8. 熔断：maxRetryPerTask=1 时 reject → human 模式停 NEEDS_HUMAN；skip 模式标 `- [-]` 前进
9. 恢复：IN_REVIEW 状态写入后杀掉进程，重启 watch → 自动重跑验收（陈旧检测）
10. 跨平台：全部测试在 Windows 通过；路径无硬编码 `/` 或 `\`

## 5. CI（可后置到 T13）
GitHub Actions 矩阵：windows-latest + ubuntu-latest，跑 `npm ci && npm run build && npm test`。
