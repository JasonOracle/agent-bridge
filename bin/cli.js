#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cmd = process.argv[2];

if (cmd !== 'init') {
  console.log(`用法: npx agent-bridge init`);
  console.log(`说明: 在当前目录下初始化 Agent-Bridge 多智能体协作脚手架。`);
  process.exit(1);
}

const targetDir = process.cwd();
const templateDir = path.join(__dirname, '..', 'templates');

// 简单递归复制函数
function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest);
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

// 检查是否已经存在（防止覆盖用户的 bridge.md 或 watchdog.js）
if (fs.existsSync(path.join(targetDir, 'watchdog.js'))) {
  console.error('\x1b[31m[错误] 当前目录已存在 watchdog.js，为防止覆盖您的数据，初始化中止。\x1b[0m');
  process.exit(1);
}

console.log('正在初始化 Agent-Bridge 脚手架...\n');

// 1. 复制所有模板文件
copyRecursiveSync(templateDir, targetDir);

// 2. 生成空白业务文档占位符
const docsDir = path.join(targetDir, 'docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

const prdTemplate = `# 产品需求文档 (PRD)\n\n在此描述您的项目要做什么，目标受众是什么，核心功能点有哪些。\n\n## 1. 项目背景\n...\n\n## 2. 核心需求\n...`;
const techTemplate = `# 技术栈与架构 (Tech Spec)\n\n在此描述项目使用的具体技术、架构模式以及开发规范（供 Builder 参考）。\n\n## 1. 技术栈\n- 前端: \n- 后端: \n\n## 2. 代码规范\n...`;
const implTemplate = `# 实施计划 (Impl Plan)\n\n将需求拆解为可验证的独立任务。\n**注意**：任务必须带有复选框，并且包含明确的验收标准。\n\n- [ ] **T1**: 完成初始化项目搭建\n  - 输出: \n  - 验收: \n\n- [ ] **T2**: ...\n`;
const testTemplate = `# 测试规范 (Test Spec)\n\n在此定义项目的核心测试场景和验收底线（供 Supervisor 重点检查）。\n\n## 必测场景\n1. \n2. \n`;

const writeIfNotExists = (fileName, content) => {
  const filePath = path.join(docsDir, fileName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
};

writeIfNotExists('prd.md', prdTemplate);
writeIfNotExists('tech.md', techTemplate);
writeIfNotExists('impl.md', implTemplate);
writeIfNotExists('test.md', testTemplate);

// 3. 检查并初始化 Git 环境
const execSync = require('child_process').execSync;
let gitInitialized = false;
if (!fs.existsSync(path.join(targetDir, '.git'))) {
  try {
    execSync('git init', { stdio: 'ignore', cwd: targetDir });
    const gitignorePath = path.join(targetDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, 'node_modules\n.DS_Store\n.bridge/\n.env\n');
    }
    gitInitialized = true;
  } catch (e) {
    // 忽略未安装 Git 的错误
  }
}

console.log('\x1b[32m✅ Agent-Bridge 初始化成功！\x1b[0m\n');
if (gitInitialized) {
  console.log('\x1b[33m(已自动为你执行 git init 并生成 .gitignore)\x1b[0m\n');
}
console.log('📦 骨架文件已生成，请执行以下步骤开始协作：');
console.log('----------------------------------------------------');
console.log(' 1. 打开 \x1b[36mdocs/\x1b[0m 填写项目需求与任务拆解 (impl.md)。');
console.log(' 2. 在终端运行 \x1b[33mnode watchdog.js\x1b[0m 启动状态机。');
console.log(' 3. 将 \x1b[36mAGENT_START.md\x1b[0m 发送给你的干活助手 (Builder)。');
console.log(' 4. 将 \x1b[36mQUICK_START_SUPERVISOR.md\x1b[0m 发送给你的审查助手 (Supervisor)。');
console.log('----------------------------------------------------\n');
console.log('现在，您可以开始体验无缝的双端 AI 自动协作了！');
