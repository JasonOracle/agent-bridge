/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 实现 init 命令生成目录骨架、docs 四件套、agents 角色卡、prompts 模板与初始配置文件; 2. 支持 --force 覆盖保护与 .gitignore 自动追加]
 */

import fs from 'node:fs';
import path from 'node:path';

export interface InitOptions {
  cwd?: string;
  force?: boolean;
}

export interface InitResult {
  created: string[];
  skipped: string[];
}

export const DEFAULT_CONFIG = `{
  "supervisor": {
    "mode": "watch",
    "provider": "claude",
    "model": "claude-sonnet-4-5",
    "apiKey": "\${ANTHROPIC_API_KEY}",
    "maxTokens": 8192,
    "timeoutMin": 20,
    "cli": {
      "command": "claude",
      "args": ["-p", "{promptFile}"]
    }
  },
  "builder": {
    "mode": "watch",
    "command": "claude",
    "args": ["-p", "{promptFile}"],
    "timeoutMin": 45
  },
  "docs": {
    "prd": "docs/prd.md",
    "tech": "docs/tech.md",
    "impl": "docs/impl.md",
    "test": "docs/test.md"
  },
  "roles": {
    "supervisor": "agents/supervisor.md",
    "builder": "agents/builder.md"
  },
  "checks": ["npm run build", "npm test"],
  "checkTimeoutMin": 10,
  "pollIntervalSec": 5,
  "maxRetryPerTask": 5,
  "onMaxRetry": "human",
  "onError": "retry",
  "maxDiffKB": 64
}
`;

export function getInitialBridgeMd(now: Date = new Date()): string {
  return `\`\`\`yaml
status: PENDING_DEV
task_id: T1
round: 1
retry: 0
updated_at: ${now.toISOString()}
last_commit: null
\`\`\`

## 本轮指令
（首轮开发：施工方直接读 docs/impl.md 的 T1 开工。）

## 上轮评审摘要
（暂无）
`;
}

export function runInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd();
  const force = options.force ?? false;

  const created: string[] = [];
  const skipped: string[] = [];

  // 获取源目录文件模板（若在 agent-bridge 本身仓库中优先读取当前模板；若独立运行提供内联保障）
  const readSourceOrFallback = (relPath: string, fallback: string): string => {
    const localPath = path.resolve(process.cwd(), relPath);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath, 'utf-8');
    }
    return fallback;
  };

  const filesToGenerate: Record<string, string> = {
    '.bridge.config.json': DEFAULT_CONFIG,
    'bridge.md': getInitialBridgeMd(),
    'docs/prd.md': readSourceOrFallback('docs/prd.md', '# 产品需求文档 (PRD)\n\n## 目标\n'),
    'docs/tech.md': readSourceOrFallback('docs/tech.md', '# 技术规范 (Tech Spec)\n\n## 技术栈\n'),
    'docs/impl.md': readSourceOrFallback(
      'docs/impl.md',
      '# 任务清单 (Impl Plan)\n\n- [ ] T1: 初始化项目\n  - 验收: 命令运行成功\n'
    ),
    'docs/test.md': readSourceOrFallback('docs/test.md', '# 测试规范 (Test Spec)\n\n## 必测场景\n'),
    'agents/supervisor.md': readSourceOrFallback(
      'agents/supervisor.md',
      '# 监工角色卡（Supervisor）\n\n你是本项目的架构师（CTO）。只看证据下结论。\n'
    ),
    'agents/builder.md': readSourceOrFallback(
      'agents/builder.md',
      '# 施工角色卡（Builder）\n\n你是本项目的开发工程师。按任务清单实现并翻转状态。\n'
    ),
    'prompts/builder-cli.md': readSourceOrFallback(
      'prompts/builder-cli.md',
      '# 施工 Mode A 提示词模板\n{{ROLE_BUILDER}}\n{{DOCS_TECH}}\n{{TASK}}\n{{INSTRUCTIONS}}\n'
    ),
    'prompts/builder-loop.md': readSourceOrFallback(
      'prompts/builder-loop.md',
      '# 施工 Mode B 循环提示词模板\n'
    ),
    'prompts/supervisor-loop.md': readSourceOrFallback(
      'prompts/supervisor-loop.md',
      '# 监工 Mode B 循环提示词模板\n'
    ),
  };

  for (const [relPath, content] of Object.entries(filesToGenerate)) {
    const targetPath = path.join(cwd, relPath);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(targetPath) && !force) {
      skipped.push(relPath);
    } else {
      fs.writeFileSync(targetPath, content.replace(/\r\n/g, '\n'), 'utf-8');
      created.push(relPath);
    }
  }

  // 处理 .gitignore 追加
  const gitignorePath = path.join(cwd, '.gitignore');
  const ignoresToAdd = ['.bridge/', '.bridge.config.json'];
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const lines = gitignoreContent.split('\n').map((l) => l.trim());
  const toAppend: string[] = [];
  for (const ignore of ignoresToAdd) {
    if (!lines.includes(ignore)) {
      toAppend.push(ignore);
    }
  }

  if (toAppend.length > 0) {
    const separator = gitignoreContent.endsWith('\n') || !gitignoreContent ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${separator}${toAppend.join('\n')}\n`, 'utf-8');
    if (!created.includes('.gitignore')) {
      created.push('.gitignore (已追加规则)');
    }
  }

  return { created, skipped };
}
