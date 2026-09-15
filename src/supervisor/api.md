# 监工 API 模块 (`supervisor/api.ts`)

### 💡 核心思想
负责对接 Anthropic（Claude）与 OpenAI 兼容端点（含 DeepSeek、通义千问等自定义 `baseURL`）。将 `review-request.md` 全文投喂大模型，强制按照 Verdict JSON Schema 给出严谨裁决。内置 429/5xx 指数退避重试（最多 3 次）。若首轮返回非法 JSON、task_id 不匹配或 reject 时缺失具体修改意见，启动**重问机制（Reprompt）**追加纠错提示重问一次，并将 Token 消耗如实累加至 `state.json`。

### 💻 使用示例
```ts
import { reviewWithApi } from './supervisor/api.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const verdict = await reviewWithApi({
  config,
  requestMd: '# Review Request...',
  expectedTaskId: 'T1',
  currentRound: 1
});

console.log(`裁决结果: ${verdict.verdict}, 说明: ${verdict.summary}`);
```
