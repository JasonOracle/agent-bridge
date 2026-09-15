# 配置模块 (`config.ts`)

### 💡 核心思想
负责读取 `.bridge.config.json`，完成环境变量插值（`${VAR_NAME}` 语法）并执行强类型 Zod 校验。采用**按模式校验（Mode-aware Validation）**策略：仅当模式被激活时，才对其专属依赖参数（如 API Key、CLI command）进行严格校验和环境变量插值，避免未使用模式缺少环境变量时误报退出。若出现任何缺失或格式错误，统一抛出带有 `exitCode = 2` 的 `ConfigError`。

### 💻 使用示例
```ts
import { loadConfig, ConfigError } from './config.js';

try {
  const config = loadConfig('.bridge.config.json');
  console.log(`监工模式: ${config.supervisor.mode}, 轮询间隔: ${config.pollIntervalSec}s`);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(err.exitCode); // 2
  }
}
```
