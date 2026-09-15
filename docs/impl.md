# 实施文档 — Agent-Bridge 任务拆解

> 施工方按顺序逐个完成；每完成一个任务：跑通验收命令 → `git add -A && git commit -m "[bridge] T{n}: ..."` → 把 bridge.md 机器区 status 改为 `PENDING_REVIEW`。
> 依赖顺序即编号顺序，禁止跳号、禁止并行。

- [ ] T1: CLI 工程骨架
  - 内容：npm init + TypeScript/ESM 配置 + commander 入口（init/watch/once/status/resolve 五个命令占位，`--help` 可见）+ tsc 构建到 dist/
  - 验收: `npm run build` 成功且 `node dist/cli.js --help` 列出全部 5 个命令

- [ ] T2: 配置模块 (src/config.ts)
  - 内容：加载 .bridge.config.json → ${ENV} 插值 → zod 校验（tech.md §3.3）；缺 env 退出码 2
  - 验收: `npm test -- config` 通过（含：合法配置、缺 env、坏 JSON、非法 mode 四类用例）

- [ ] T3: 状态机模块 (src/state.ts)
  - 内容：bridge.md 双区解析、BridgeStateSchema 校验、原子写、合法迁移表（tech.md §5）、陈旧检测
  - 验收: `npm test -- state` 通过（覆盖 7 态、非法 YAML、非法迁移回滚、rename 原子写、陈旧判定）

- [ ] T4: 执行器与 git 模块 (src/executor.ts, src/gittool.ts)
  - 内容：tech.md §7/§8 全部行为（超时强杀、尾部 256KB 捕获、diff 截断降级、无新 commit 检测）
  - 验收: `npm test -- executor gittool` 通过；实测在临时 git 仓库构造 3 个 commit 验证 diff 正确

- [ ] T5: 审计日志 (src/logger.ts)
  - 内容：tech.md §13 日志格式 + state.json 读写（lastApprovedCommit/token 统计）
  - 验收: `npm test -- logger` 通过；日志文件名与字段符合 §13

- [ ] T6: 上下文组装 (src/context.ts)
  - 内容：tech.md §9 注入规则（施工不含 prd）+ 模板占位符替换 + {promptFile} 临时文件（§10）
  - 验收: `npm test -- context` 通过（断言施工 prompt 不含 prd 内容、review-request 含全部四件套）

- [ ] T7: watcher 主循环 + 验收管线干跑 (src/watcher.ts, src/pipeline.ts)
  - 内容：tech.md §6 主循环；管线到"生成 review-request.md"为止（监工接口 mock 为固定 approve）；`once --dry-run` 可用
  - 验收: 手写 bridge.md 为 PENDING_REVIEW，跑 `node dist/cli.js once` 后 impl.md 对应任务被打勾、状态前进、日志落盘

- [ ] T8: 监工 Mode API (src/supervisor/api.ts + types.ts)
  - 内容：Claude + OpenAI（含 baseURL）两 provider、指数退避重试、Verdict 校验、非法输出重问一次、token 统计
  - 验收: `npm test -- supervisor-api` 通过（mock fetch）；真实 API 各跑一次 `once`（需 env key），非法 JSON 响应触发重问

- [ ] T9: 监工 Mode CLI + Mode B (src/supervisor/cli.ts + watch.ts)
  - 内容：spawn 无头工具（promptFile）、verdict.json 轮询与原子消费归档、超时处理
  - 验收: `npm test -- supervisor-cli` 通过（用 node 脚本假扮监工 CLI 写 verdict.json）；`once` 全流程走通

- [ ] T10: 施工 Mode A + Mode B (src/builder/*)
  - 内容：Mode A spawn（promptFile 默认）+ Mode B 等待翻转 + timeoutMin 超时 ERROR
  - 验收: `npm test -- builder` 通过（假施工 CLI：收到 promptFile 后改 bridge.md 状态）；超时分支有单测

- [ ] T11: resolve/status 命令 + onMaxRetry=skip
  - 内容：resolve（含 --skip）、status 输出、skip 策略把 impl.md 任务标 `- [-]` 并前进
  - 验收: `npm test -- commands` 通过；构造 maxRetry=1 连续打回场景验证 human/skip 两种熔断

- [ ] T12: init 模板内容完整化
  - 内容：init 生成的 docs 四件套、agents 双角色卡、prompts 三模板内容与仓库根目录对应文件一致（以仓库根目录文件为源复制）
  - 验收: 临时目录跑 `init` 后文件齐全；`init` 重复执行不覆盖（无 --force）

- [ ] T13: 自证实验 + README
  - 内容：examples/todo-app 按 plan.md §8 跑通（5 任务/0 干预/≤15 轮/双恢复测试）；中英文 README（原理、接入矩阵、组合速查、安全警告、15 分钟上手）
  - 验收: 实验指标全部达标并记录进 README；新目录按 README 15 分钟跑通示例
