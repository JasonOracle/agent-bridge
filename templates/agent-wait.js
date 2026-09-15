/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 底层
 * 修改内容：初始化 Node 版本的 Agent 轮询阻塞脚本，解决终端挂起与跨平台编码问题。
 */

const fs = require('fs');
const path = require('path');

const bridgeFile = path.join(__dirname, 'bridge.md');

function readBridgeStatus() {
  try {
    if (!fs.existsSync(bridgeFile)) {
      return null;
    }
    const content = fs.readFileSync(bridgeFile, 'utf8');
    const match = content.match(/status:\s*(\w+)/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

console.log('🔄 Agent Waiter 已启动，正在静默监控 bridge.md 的状态...');

const timer = setInterval(() => {
  const status = readBridgeStatus();
  
  if (status === 'PENDING_DEV') {
    clearInterval(timer);
    console.log('\n[✅ 任务就绪] 发现新任务 (PENDING_DEV)！请立即读取 bridge.md 并开始开发！');
    process.exit(0);
  } else if (status === 'COMPLETED') {
    clearInterval(timer);
    console.log('\n[🎉 工程结束] 所有任务已完成 (COMPLETED)！自动下班！');
    process.exit(0);
  }
  // 如果是 IN_REVIEW 或 IN_DEV，则纯静默死等，绝不向终端输出废话污染 Agent 上下文。
}, 2000);
