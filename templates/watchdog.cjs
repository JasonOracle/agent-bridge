const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BRIDGE_FILE = path.join(__dirname, 'bridge.md');
const CONFIG_FILE = path.join(__dirname, 'watchdog.config.json');
const BRIDGE_DIR = path.join(__dirname, '.bridge');
const IMPL_FILE = path.join(__dirname, 'docs', 'impl.md');
const REVIEW_REQUEST_FILE = path.join(BRIDGE_DIR, 'review-request.md');
const VERDICT_FILE = path.join(BRIDGE_DIR, 'verdict.json');
const INTERNAL_STATE_FILE = path.join(BRIDGE_DIR, 'internal-state.json');
const LOGS_DIR = path.join(BRIDGE_DIR, 'logs');
const SIGNAL_FILE = path.join(BRIDGE_DIR, 'signal-builder.txt');

// Default config
let config = {
  devTimeoutMin: 45,
  reviewTimeoutMin: 10,
  maxRetryPerTask: 5,
  maxDiffKB: 64,
  builder: { mode: "signal" },
  checks: []
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) {
    console.error('[Watchdog] 解析 watchdog.config.json 失败，使用默认配置', e.message);
  }
}

// Ensure directories
if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR);
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
if (!fs.existsSync(INTERNAL_STATE_FILE)) {
  fs.writeFileSync(INTERNAL_STATE_FILE, JSON.stringify({ lastApprovedCommit: null }, null, 2));
}

let isTickRunning = false;
let lastKnownStatus = null;

function parseBridge() {
  if (!fs.existsSync(BRIDGE_FILE)) return null;
  const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
  const yamlMatch = content.match(/^```yaml\n([\s\S]*?)\n```/);
  if (!yamlMatch) return null;
  
  const yamlStr = yamlMatch[1];
  const state = {};
  yamlStr.split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx > -1) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if (val === 'null') val = null;
      else if (!isNaN(Number(val))) val = Number(val);
      state[key] = val;
    }
  });
  
  return { state, content };
}

function writeBridge(newStateOverrides, freeTextOverride = null) {
  const parsed = parseBridge();
  if (!parsed) return;
  let { state, content } = parsed;
  
  state = { ...state, ...newStateOverrides };
  state.updated_at = new Date().toISOString();
  
  let newYaml = '```yaml\n';
  for (const [k, v] of Object.entries(state)) {
    newYaml += `${k}: ${v === null ? 'null' : v}\n`;
  }
  newYaml += '```';
  
  let newContent = content.replace(/^```yaml\n[\s\S]*?\n```/, newYaml);
  if (freeTextOverride) {
    const freeTextStart = newContent.indexOf('## 本轮指令');
    if (freeTextStart > -1) {
      newContent = newContent.slice(0, freeTextStart) + freeTextOverride;
    } else {
      newContent += '\n\n' + freeTextOverride;
    }
  }
  
  const tmpFile = BRIDGE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, newContent);
  fs.renameSync(tmpFile, BRIDGE_FILE);
}

function getInternalState() {
  try {
    return JSON.parse(fs.readFileSync(INTERNAL_STATE_FILE, 'utf8'));
  } catch {
    return { lastApprovedCommit: null };
  }
}

function saveInternalState(state) {
  fs.writeFileSync(INTERNAL_STATE_FILE, JSON.stringify(state, null, 2));
}

function getNextTask() {
  if (!fs.existsSync(IMPL_FILE)) return null;
  const impl = fs.readFileSync(IMPL_FILE, 'utf8');
  const match = impl.match(/^[\-\*\+]\s*\[\s\](?:.*?)(T\d+)/m);
  return match ? match[1] : null;
}

function markTaskCompleted(taskId) {
  if (!fs.existsSync(IMPL_FILE)) return;
  let impl = fs.readFileSync(IMPL_FILE, 'utf8');
  const regex = new RegExp(`^([\\-\\*\+]\\s*\\[\\s\\])(.*?${taskId})`, 'm');
  impl = impl.replace(regex, (match, p1, p2) => match.replace(p1, p1[0] + ' [x]'));
  fs.writeFileSync(IMPL_FILE, impl);
}

function getCurrentCommit() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return null;
  }
}

function getTaskDescription(taskId) {
  if (!fs.existsSync(IMPL_FILE)) return '';
  const impl = fs.readFileSync(IMPL_FILE, 'utf8');
  const regex = new RegExp(`^[\\-\\*\+]\\s*\\[[x ]\\].*?${taskId}.*?(?:\\n[^]*?)?(?=\\n^[\\-\\*\+]\\s*\\[[x ]\\]|$)`, 'gm');
  const match = regex.exec(impl);
  return match ? match[0].trim() : '';
}

function assembleReviewRequest(state) {
  console.log(`[Watchdog] 组装审查材料 for ${state.task_id}...`);
  const internal = getInternalState();
  let diffOut = '';
  try {
    if (internal.lastApprovedCommit) {
      diffOut = execSync(`git diff ${internal.lastApprovedCommit}..HEAD`, { stdio: 'pipe' }).toString();
    } else {
      diffOut = execSync('git log -p -1', { stdio: 'pipe' }).toString();
    }
  } catch (e) {
    const errText = e.stderr ? e.stderr.toString() : e.message;
    diffOut = `[Watchdog 警告] 获取 diff 失败。原因：\n1. 可能是 Builder 忘记了执行 git commit，导致没有新的提交。\n2. 可能是当前为初始空仓库（没有 HEAD）。\n\n系统错误信息：\n${errText}`;
  }

  if (diffOut.length > config.maxDiffKB * 1024) {
    let stat = '';
    try {
      if (internal.lastApprovedCommit) {
        stat = execSync(`git diff --name-only ${internal.lastApprovedCommit}..HEAD`).toString();
      } else {
        stat = execSync('git show --name-only -1 --format=""').toString();
      }
    } catch {}
    diffOut = `[警告] Diff 超过 ${config.maxDiffKB}KB，已截断。\n\n变更的文件：\n${stat}\n\n` + diffOut.slice(0, config.maxDiffKB * 1024) + '\n... (truncated)';
  }

  let checksOut = '';
  for (const cmd of config.checks) {
    checksOut += `\n$ ${cmd}\n`;
    try {
      checksOut += execSync(cmd, { stdio: 'pipe' }).toString();
      checksOut += `\n[PASS]\n`;
    } catch (e) {
      checksOut += e.stdout ? e.stdout.toString() : '';
      checksOut += e.stderr ? e.stderr.toString() : '';
      checksOut += `\n[FAIL: exit code ${e.status}]\n`;
    }
  }

  const reqContent = `# 审查请求 — ${state.task_id} (Round ${state.round})\n\n## 任务说明\n${getTaskDescription(state.task_id)}\n\n## 代码变更 (git diff)\n\`\`\`diff\n${diffOut}\n\`\`\`\n\n## 自动化校验日志\n\`\`\`\n${checksOut || '未配置 checks 命令'}\n\`\`\`\n`;
  fs.writeFileSync(REVIEW_REQUEST_FILE, reqContent);
  
  writeBridge({ status: 'IN_REVIEW' });
  console.log('[Watchdog] 已切至 IN_REVIEW');
}

function consumeVerdict(state) {
  if (!fs.existsSync(VERDICT_FILE)) return;
  let rawContent = fs.readFileSync(VERDICT_FILE, 'utf8');
  rawContent = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let verdict;
  try {
    verdict = JSON.parse(rawContent);
  } catch (e) {
    console.error('[Watchdog] 解析 Verdict 失败，已触发兜底熔断机制以阻断死循环:', e.message);
    verdict = {
      verdict: 'reject',
      task_id: state.task_id,
      round: state.round,
      summary: 'Supervisor 返回的 verdict 格式严重损坏 (JSON解析失败)',
      issues: [{ severity: 'blocker', desc: `JSON 格式错误：${e.message}。\n原文内容片段：${rawContent.slice(0, 100)}...` }],
      next_instructions: '系统自动拦截：Supervisor 生成了非法的 JSON 文件。请 Supervisor 仔细检查你的输出格式，必须是纯 JSON，不要有任何多余的解释文本或 Markdown 标记。'
    };
  }

  try {
    console.log(`[Watchdog] 收到 Verdict: ${verdict.verdict}`);
    
    const logFile = path.join(LOGS_DIR, `review-${state.task_id}-${state.round}.md`);
    fs.writeFileSync(logFile, JSON.stringify(verdict, null, 2));
    
    if (verdict.verdict === 'approve') {
      const currentCommit = getCurrentCommit();
      const internal = getInternalState();
      internal.lastApprovedCommit = currentCommit || internal.lastApprovedCommit;
      saveInternalState(internal);
      
      markTaskCompleted(state.task_id);
      
      const nextTask = getNextTask();
      if (nextTask) {
        writeBridge({ status: 'PENDING_DEV', task_id: nextTask, round: 1, retry: 0, error: null }, `## 本轮指令\n请开始执行任务 ${nextTask}\n\n## 上轮评审摘要\n前置任务已完成。`);
      } else {
        writeBridge({ status: 'COMPLETED', task_id: null, error: null });
        console.log('[Watchdog] 全部任务完成，正常退出。');
        process.exit(0);
      }
    } else {
      if (state.retry + 1 > config.maxRetryPerTask) {
        writeBridge({ status: 'NEEDS_HUMAN', error: '重试次数耗尽' });
        console.error('\n\x1b[31m[Watchdog Alert] 重试耗尽，进入 NEEDS_HUMAN，请人工介入！\x1b[0m\n');
      } else {
        writeBridge({ status: 'PENDING_DEV', retry: state.retry + 1, round: state.round + 1 }, `## 本轮指令\n请修复打回的问题。\n\n## 上轮评审摘要\n${verdict.summary}\n\n具体问题：\n${(verdict.issues || []).map(i => `- [${i.severity}] ${i.desc}`).join('\n')}\n\n修改指示：\n${verdict.next_instructions}`);
      }
    }
    
    fs.unlinkSync(VERDICT_FILE);
  } catch (e) {
    console.error('[Watchdog] 处理 Verdict 状态流转时发生严重异常:', e.message);
    fs.unlinkSync(VERDICT_FILE);
  }
}

function checkTimeoutsAndTransitions(state) {
  const updated = new Date(state.updated_at);
  const now = new Date();
  const diffMin = (now - updated) / 60000;

  if (state.status === 'IN_DEV' && diffMin > config.devTimeoutMin) {
    writeBridge({ status: 'ERROR', error: `Builder 开发超时（>${config.devTimeoutMin}分钟）` });
    return true;
  }
  
  if (state.status === 'IN_REVIEW' && diffMin > config.reviewTimeoutMin) {
    writeBridge({ status: 'ERROR', error: `Supervisor 审查超时（>${config.reviewTimeoutMin}分钟）` });
    return true;
  }

  // Illegal transitions check
  if (lastKnownStatus && lastKnownStatus !== state.status) {
    const valid = {
      'PENDING_DEV': ['IN_DEV'],
      'IN_DEV': ['PENDING_REVIEW', 'ERROR'],
      'PENDING_REVIEW': ['IN_REVIEW'],
      'IN_REVIEW': ['PENDING_DEV', 'COMPLETED', 'NEEDS_HUMAN', 'ERROR'],
      'ERROR': ['PENDING_DEV', 'NEEDS_HUMAN'],
      'NEEDS_HUMAN': ['PENDING_DEV']
    };
    if (!valid[lastKnownStatus] || !valid[lastKnownStatus].includes(state.status)) {
      writeBridge({ status: 'ERROR', error: `非法状态迁移: ${lastKnownStatus} -> ${state.status}` });
      return true;
    }
  }
  
  if (state.status === 'ERROR') {
    if (state.retry < config.maxRetryPerTask) {
      writeBridge({ status: 'PENDING_DEV', retry: state.retry + 1 }, `## 本轮指令\n系统容灾恢复重试。\n\n## 上轮评审摘要\n发生异常：${state.error}`);
    } else {
      writeBridge({ status: 'NEEDS_HUMAN', error: `异常次数过多：${state.error}` });
      console.error('\n\x1b[31m[Watchdog Alert] 异常次数耗尽，进入 NEEDS_HUMAN，请人工介入！\x1b[0m\n');
      process.exit(1); // Exit if Needs Human triggered by error loop
    }
    return true;
  }
  return false;
}

function tick() {
  if (isTickRunning) return;
  isTickRunning = true;
  
  try {
    const parsed = parseBridge();
    if (!parsed) return;
    const { state } = parsed;
    
    if (checkTimeoutsAndTransitions(state)) {
      lastKnownStatus = parseBridge().state.status;
      return;
    }
    
    lastKnownStatus = state.status;
    
    if (state.status === 'PENDING_DEV') {
      if (config.builder.mode === 'signal') {
        fs.writeFileSync(SIGNAL_FILE, `Builder 唤醒信号：任务 ${state.task_id}。请读取 bridge.md 开工。`);
      }
      console.log(`[Watchdog] 检测到 PENDING_DEV (${state.task_id})，准备唤醒 Builder...`);
    } else if (state.status === 'PENDING_REVIEW') {
      assembleReviewRequest(state);
    } else if (state.status === 'IN_REVIEW') {
      consumeVerdict(state);
    } else if (state.status === 'COMPLETED') {
      console.log('[Watchdog] 任务已全部完成');
      process.exit(0);
    } else if (state.status === 'NEEDS_HUMAN') {
      console.error('\n\x1b[31m[Watchdog Alert] 当前状态为 NEEDS_HUMAN，请人工处理后将状态改为 PENDING_DEV！\x1b[0m\n');
      process.exit(1);
    }
  } catch (e) {
    console.error('[Watchdog Error]', e);
  } finally {
    isTickRunning = false;
  }
}

// Ensure bridge.md exists for init
if (!fs.existsSync(BRIDGE_FILE)) {
  const nextTask = getNextTask();
  const initYaml = `\`\`\`yaml
status: PENDING_DEV
task_id: ${nextTask}
round: 1
retry: 0
updated_at: ${new Date().toISOString()}
last_commit: null
error: null
\`\`\``;
  const initContent = `${initYaml}\n\n## 本轮指令\n请开始执行任务 ${nextTask}\n\n## 上轮评审摘要\n无`;
  fs.writeFileSync(BRIDGE_FILE, initContent);
}

// Start loop
setInterval(tick, 5000);
fs.watch(BRIDGE_FILE, (eventType) => {
  if (eventType === 'change') tick();
});
console.log('[Watchdog] 已启动，正在监控 bridge.md...');
tick();
