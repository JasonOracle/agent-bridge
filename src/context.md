# 上下文组装模块 (`context.ts`)

### 💡 核心思想
严格遵守角色权限边界进行 Prompt 拼装：
1. **施工提示词**：注入技术规范（`tech.md`）、任务说明（`impl.md`）和本轮指令，**严禁注入产品需求（`prd.md`）**，防止施工方自作聪明越权改动产品定义。
2. **验收申请材料 (`review-request.md`)**：为监工聚合 PRD、Tech、Test 文档四件套、当前任务段落、截断后 Diff、Checks 终端日志以及严格的 JSON 输出契约。
3. **命令行长度规避**：针对 Windows 8191 字符上限，提供 `{promptFile}` 临时文件自动写入（`.bridge/tmp/`）与回收机制。

### 💻 使用示例
```ts
import { assembleBuilderPrompt, assembleReviewRequest, createPromptFile, removePromptFile } from './context.js';

// 组装施工提示词并写入临时文件
const builderPrompt = assembleBuilderPrompt({ taskId: 'T2' });
const promptFilePath = createPromptFile(builderPrompt);

// 组装监工验收材料
const reviewMd = assembleReviewRequest({
  taskId: 'T2',
  round: 1,
  diff: '+console.log("hello")',
  checksLog: 'Tests passed'
});

// 使用完毕后清理
removePromptFile(promptFilePath);
```
