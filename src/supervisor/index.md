# 监工分发入口 (`supervisor/index.ts`)

### 💡 核心思想
对外提供统一的 `getVerdict()` 函数，彻底屏蔽底层监工模式差异：
- **`api`**：直接调用 Claude / OpenAI SDK。
- **`cli`**：spawn 本地命令行工具并传递 `{promptFile}`。
- **`watch`**：文件轮询等待外部 Agent 将裁决写入 `.bridge/verdict.json`。

### 💻 使用示例
```ts
import { getVerdict } from './supervisor/index.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const verdict = await getVerdict({
  config,
  requestMd: '# Review Request...',
  requestMdPath: '.bridge/review-request.md',
  expectedTaskId: 'T1',
  currentRound: 1
});
```
