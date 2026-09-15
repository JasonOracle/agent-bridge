# 项目初始化模块 (`init.ts`)

### 💡 核心思想
负责通过 `agent-bridge init` 快速搭建协作骨架：
1. **生成材料四件套**：`docs/prd.md`, `docs/tech.md`, `docs/impl.md`, `docs/test.md`。
2. **生成角色规范与提示词模板**：`agents/` 双角色卡及 `prompts/` 三大循环模板。
3. **安全覆盖保护**：已有文件默认跳过（skip），需显式传递 `--force` 才会强制覆盖。
4. **防泄露安全配置**：自动在 `.gitignore` 中追加 `.bridge/` 与 `.bridge.config.json`，杜绝密钥及过程日志误提交。

### 💻 使用示例
```ts
import { runInit } from './init.js';

// 初始化当前目录
const res = runInit({ force: false });
console.log(`创建文件: ${res.created.length} 个，跳过: ${res.skipped.length} 个`);
```
