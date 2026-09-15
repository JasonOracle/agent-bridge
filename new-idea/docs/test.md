# 测试规范 (Test Spec) — 响应式双端 AI 协作协议

> 本文件定义所有交付物的验收测试场景。
> **所有测试必须手动可复现**，不依赖任何测试框架（无 Jest/Vitest）。

---

## Layer 1 测试：`PROTOCOL.md` 合规性

### TC-1：`bridge.md` 格式合法性校验
**测试方法**：手动创建一个 `bridge.md`，读取并验证格式。
```
验证点：
✅ YAML 机器区字段全部存在（status / task_id / round / retry / updated_at / last_commit / error）
✅ status 值只能为 7 种枚举之一
✅ task_id 格式为 T\d+（如 T1, T2）或 null
✅ round 为正整数，retry 为非负整数
✅ updated_at 为合法 ISO 8601 字符串
✅ 自由区包含 "## 本轮指令" 和 "## 上轮评审摘要" 两个标题
```

### TC-2：非法状态迁移拒绝
**测试方法**：直接编辑 `bridge.md`，将 status 从 `IN_DEV` 强制改为 `PENDING_DEV`（这是一个非法回退）。
```
预期结果：
✅ Watchdog 在下一个 tick 中检测到状态从 IN_DEV 跳跃至 PENDING_DEV（非法迁移）
✅ 自动将 bridge.md 回满至 ERROR， error 字段写入说明
✅ 终端输出非法迁移告警日志
```

### TC-3：`verdict.json` Schema 校验
**测试方法**：手动创建一个缺少 `task_id` 字段的 `verdict.json`。
```
预期结果：Watchdog 拒绝消费此文件，保持 IN_REVIEW 状态，终端输出 Verdict 格式错误警告
```

---

## Layer 2 测试：`watchdog.js` 功能验证

### TC-4：基础状态检测（快速验证）
**测试方法**：
1. 初始化 `bridge.md`（status: `PENDING_DEV`, task_id: T1）
2. 启动 `node watchdog.js`
3. 观察终端输出

```
预期结果：
✅ 终端打印 "[Watchdog] 检测到 PENDING_DEV (T1)，准备唤醒 Builder..."
✅ 5 秒内有响应（无需实际接入 Builder，有日志即可）
```

### TC-5：审查材料预组装完整性
**测试方法**：
1. 确保项目有至少一个 git commit
2. 手动将 `bridge.md` 设为 `PENDING_REVIEW`（task_id: T1）
3. 等待 Watchdog 响应

```
预期结果：
✅ 5 秒内生成 .bridge/review-request.md
✅ 文件包含 "## 任务说明" 章节
✅ 文件包含 "## 代码变更 (git diff)" 章节（即使无变化也要有此章节）
✅ 文件包含 "## 自动化校验日志" 章节
✅ bridge.md 状态从 PENDING_REVIEW 切换到 IN_REVIEW（**由 Watchdog 写入，非 Supervisor**）
```

### TC-5a：GUI Builder 信号文件生成
**测试方法**：
1. `watchdog.config.json` 中设置 `builder.mode: "signal"`
2. 将 `bridge.md` 设为 `PENDING_DEV`（task_id: T1）
3. 等待 Watchdog 响应

```
预期结果：
✅ 5 秒内生成 .bridge/signal-builder.txt
✅ signal-builder.txt 内容包含任务 ID（T1）和启动指引
✅ Builder 工具（GUI）可通过检测此文件存在来判断是否被唤醒
```

### TC-6：Approve 分支任务推进
**测试方法**：
1. 初始化 `bridge.md`（status: `IN_REVIEW`, task_id: T1, last_commit: 任意 hash）
2. 初始化 `impl.md`，包含 T1 和 T2 两个任务
3. 手动创建 `.bridge/verdict.json`，内容为 approve 裁决
4. 等待 Watchdog 消费

```
预期结果：
✅ impl.md 中 T1 的 "- [ ]" 变为 "- [x]"
✅ bridge.md 状态切换为 PENDING_DEV（task_id: T2）
✅ .bridge/verdict.json 被删除
✅ bridge.md 自由区写入 "下一任务：T2"
```

### TC-7：Reject 分支打回逻辑
**测试方法**：
1. 初始化 `bridge.md`（status: `IN_REVIEW`, task_id: T1, retry: 0）
2. 手动创建 `.bridge/verdict.json`，内容为 reject 裁决（含 next_instructions）
3. 等待 Watchdog 消费

```
预期结果：
✅ impl.md 中 T1 的 checkbox 保持未勾选
✅ bridge.md 状态切换为 PENDING_DEV（task_id: T1, retry: 1）
✅ bridge.md 自由区包含打回意见（来自 next_instructions）
✅ .bridge/verdict.json 被删除
```

### TC-8：最终任务完成（COMPLETED）
**测试方法**：
1. `impl.md` 中只有 T1 一个任务（`- [ ]`）
2. 手动创建 approve 的 `verdict.json`（task_id: T1）
3. 等待 Watchdog 消费

```
预期结果：
✅ impl.md 中 T1 被打勾
✅ bridge.md 状态切换为 COMPLETED
✅ 终端打印 "[Watchdog] 🎉 全部任务完成！"
✅ Watchdog 进程正常退出（exit code 0）
```

### TC-9：重试耗尽熔断（NEEDS_HUMAN）
**测试方法**：
1. 初始化 `bridge.md`（status: `IN_REVIEW`, task_id: T1, retry: 4，maxRetryPerTask 默认 5）
2. 手动创建 reject 的 `verdict.json`
3. 等待 Watchdog 消费

```
预期结果：
✅ bridge.md 状态切换为 NEEDS_HUMAN（retry: 5）
✅ 终端打印醒目的告警（含任务 ID 和原因）
✅ Watchdog 进程以 exit code 1 退出
```

### TC-10：开发超时容灾
**测试方法**：
1. 手动将 `bridge.md` 设为 `IN_DEV`，`updated_at` 设为 3 小时前
2. `devTimeoutMin` 默认 45 分钟
3. 启动 Watchdog

```
预期结果：
✅ Watchdog 检测到 IN_DEV 超时
✅ bridge.md 切换为 ERROR（含 error 字段说明）
✅ 后续按 onError 策略处理（retry 则写 PENDING_DEV）
```

### TC-11：审查超时容灾
**测试方法**：
1. 手动将 `bridge.md` 设为 `IN_REVIEW`，`updated_at` 设为 20 分钟前
2. `reviewTimeoutMin` 默认 10 分钟
3. 启动 Watchdog

```
预期结果：
✅ Watchdog 检测到 IN_REVIEW 超时
✅ bridge.md 切换为 ERROR（含 error 字段说明）
```

---

## Layer 2 测试：Loop Prompt 行为验证

### TC-12：Builder Prompt 文件读取完整性
**测试方法**：阅读 `prompts/builder-loop.md`，逐条检查。
```
验证清单（人工阅读）：
✅ 明确列出了 Builder 需要读取的文件：bridge.md、docs/tech.md、impl.md 当前任务段落
✅ 明确禁止读取 docs/prd.md
✅ 明确了 IN_DEV 状态写入时机（开工前）
✅ 明确了 git commit 格式（[bridge] 前缀）
✅ 明确了 PENDING_REVIEW 写入条件（git commit 成功后）
✅ 明确禁止修改 impl.md 和 docs/* 目录
```

### TC-13：Supervisor Prompt 行为约束完整性
**测试方法**：阅读 `prompts/supervisor-loop.md`，逐条检查。
```
验证清单（人工阅读）：
✅ 明确了唤醒后先检查 status，非 IN_REVIEW 则静默退出
✅ 明确了读取来源：仅 .bridge/review-request.md，不自行执行 shell 命令
✅ 明确了 verdict.json 的输出位置和格式
✅ 明确了重注册定时器的必须性（审查完立即执行）
✅ 明确**禁止直接写入 bridge.md**（包括 IN_REVIEW、PENDING_DEV 等任何状态）
✅ 明确禁止修改 impl.md
```

---

## Layer 3 测试：易用性验证

### TC-14：快速启动卡最小化验证
**测试方法**：将 `QUICK_START_BUILDER.md` 内容粘贴进任意 AI 工具（如 ChatGPT），观察其响应。
```
预期结果：
✅ AI 理解自己是 Builder 角色
✅ AI 知道下一步要做什么（读取 builder-loop.md）
✅ 启动卡本身字数 ≤ 100 字
```

### TC-15：Antigravity Skill 一键激活验证
**测试方法**：在 Antigravity IDE 中激活 `agent-bridge-supervisor` Skill。
```
预期结果：
✅ Antigravity 自动加载 supervisor-loop.md 内容
✅ Antigravity 自动注册一个 2 分钟周期的定时任务
✅ 整个过程无需用户手动粘贴任何 Prompt
```

---

## 端到端集成测试（最终验收）

### TC-16：完整双端零触控闭环（真实运行）
**测试方法**：
1. 新建测试项目，准备包含 2 个任务（T1、T2）的 `impl.md`
2. 启动 `node watchdog.js`
3. 给 Builder 工具发送快速启动卡
4. 给 Supervisor 工具发送快速启动卡并注册定时任务
5. 计时等待

```
预期结果：
✅ T1 完成开发（有 git commit）→ Watchdog 组装 review-request.md → Supervisor 审查 → approve
✅ T1 在 impl.md 被打勾，T2 自动开始开发，全程无人工干预
✅ T2 完成 → Supervisor 审查 → approve → bridge.md 切换为 COMPLETED
✅ 全程 Supervisor 在等待期间无 Token 空转
✅ 全程人工干预次数：0
```
