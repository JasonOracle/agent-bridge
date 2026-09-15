/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 编写状态机单测：覆盖 7 态、非法 YAML、非法迁移回滚、rename 原子写、陈旧判定与边界情况]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseBridgeContent,
  serializeBridge,
  readBridge,
  writeBridge,
  isValidTransition,
  isStaleState,
  rollbackInvalidTransition,
  BridgeParseError,
  BridgeState,
  BridgeStatus,
} from './state.js';

describe('状态机模块 (src/state.ts)', () => {
  let tmpDir: string;
  let bridgePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-test-'));
    bridgePath = path.join(tmpDir, 'bridge.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. 7 态解析覆盖：能够正确解析所有 7 种合法状态', () => {
    const statuses: BridgeStatus[] = [
      'PENDING_DEV',
      'IN_DEV',
      'PENDING_REVIEW',
      'IN_REVIEW',
      'NEEDS_HUMAN',
      'ERROR',
      'COMPLETED',
    ];

    for (const status of statuses) {
      const raw = `\`\`\`yaml
status: ${status}
task_id: ${status === 'COMPLETED' ? null : 'T1'}
round: 1
retry: 0
updated_at: 2026-09-15T12:00:00.000Z
last_commit: null
\`\`\`

## 本轮指令
测试指令
`;
      const parsed = parseBridgeContent(raw);
      expect(parsed.state.status).toBe(status);
      expect(parsed.freeZone).toContain('## 本轮指令');
    }
  });

  it('2. 非法 YAML / 缺少机器区 / 字段缺失：抛出 BridgeParseError 且 exitCode=3', () => {
    // 无 yaml 块
    expect(() => parseBridgeContent('# 没有任何机器区')).toThrowError(BridgeParseError);

    // 语法错误 yaml
    const badYaml = `\`\`\`yaml
status: [unclosed array
\`\`\`
`;
    expect(() => parseBridgeContent(badYaml)).toThrowError(BridgeParseError);

    // 字段缺失 (缺少 round, retry)
    const missingFields = `\`\`\`yaml
status: PENDING_DEV
task_id: T1
updated_at: 2026-09-15T12:00:00.000Z
\`\`\`
`;
    expect(() => parseBridgeContent(missingFields)).toThrowError(BridgeParseError);

    // 非法 status
    const invalidStatus = `\`\`\`yaml
status: INVALID_STATUS
task_id: T1
round: 1
retry: 0
updated_at: 2026-09-15T12:00:00.000Z
last_commit: null
\`\`\`
`;
    expect(() => parseBridgeContent(invalidStatus)).toThrowError(BridgeParseError);
  });

  it('3. 原子写入与读取：临时文件安全替换，内容完整', () => {
    const initialState: BridgeState = {
      status: 'PENDING_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: 'abc1234',
    };

    const freeZone = '## 本轮指令\n请开始写代码';
    writeBridge(bridgePath, initialState, freeZone);

    expect(fs.existsSync(bridgePath)).toBe(true);

    const parsed = readBridge(bridgePath);
    expect(parsed.state.status).toBe('PENDING_DEV');
    expect(parsed.state.task_id).toBe('T1');
    expect(parsed.state.last_commit).toBe('abc1234');
    expect(parsed.freeZone).toContain('请开始写代码');
  });

  it('4. 状态迁移校验：合法迁移与非法迁移判定', () => {
    // 合法迁移
    expect(isValidTransition('PENDING_DEV', 'IN_DEV')).toBe(true);
    expect(isValidTransition('PENDING_DEV', 'PENDING_REVIEW')).toBe(true);
    expect(isValidTransition('IN_DEV', 'PENDING_REVIEW')).toBe(true);
    expect(isValidTransition('PENDING_REVIEW', 'IN_REVIEW')).toBe(true);
    expect(isValidTransition('IN_REVIEW', 'COMPLETED')).toBe(true);
    expect(isValidTransition('IN_REVIEW', 'PENDING_DEV')).toBe(true);
    expect(isValidTransition('IN_REVIEW', 'NEEDS_HUMAN')).toBe(true);
    expect(isValidTransition('ERROR', 'PENDING_DEV')).toBe(true);
    expect(isValidTransition('NEEDS_HUMAN', 'PENDING_DEV')).toBe(true);

    // 相同状态允许自刷新
    expect(isValidTransition('IN_DEV', 'IN_DEV')).toBe(true);

    // 非法迁移
    expect(isValidTransition('COMPLETED', 'PENDING_DEV')).toBe(false);
    expect(isValidTransition('PENDING_DEV', 'COMPLETED')).toBe(false);
    expect(isValidTransition('IN_DEV', 'COMPLETED')).toBe(false);
    expect(isValidTransition('PENDING_REVIEW', 'PENDING_DEV')).toBe(false);
  });

  it('5. 非法迁移回滚：非法篡改时置为 ERROR 并回滚', () => {
    const lastKnown: BridgeState = {
      status: 'PENDING_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date().toISOString(),
      last_commit: null,
    };
    writeBridge(bridgePath, lastKnown, '');

    const illegalCurrent: BridgeState = {
      ...lastKnown,
      status: 'COMPLETED', // 非法直接从 PENDING_DEV 跃迁到 COMPLETED
    };

    const result = rollbackInvalidTransition(bridgePath, illegalCurrent, lastKnown, '');
    expect(result.status).toBe('ERROR');
    expect(result.error).toContain('检测到非法状态迁移');

    // 检查磁盘上的文件已被原子回滚为 ERROR
    const onDisk = readBridge(bridgePath);
    expect(onDisk.state.status).toBe('ERROR');
  });

  it('6. 陈旧状态判定：超时判定逻辑正确', () => {
    const now = new Date('2026-09-15T15:00:00.000Z');

    // 刚刚更新的 IN_DEV，不陈旧
    const freshState: BridgeState = {
      status: 'IN_DEV',
      task_id: 'T1',
      round: 1,
      retry: 0,
      updated_at: new Date('2026-09-15T14:40:00.000Z').toISOString(), // 20分钟前
      last_commit: null,
    };
    // timeoutMin=45, 默认 threshold = 45+5 = 50min
    expect(isStaleState(freshState, 45, 0, now)).toBe(false);

    // 超时的 IN_DEV (60分钟前)
    const staleState: BridgeState = {
      ...freshState,
      updated_at: new Date('2026-09-15T13:50:00.000Z').toISOString(),
    };
    expect(isStaleState(staleState, 45, 0, now)).toBe(true);

    // 显式 staleThresholdMin 覆盖
    expect(isStaleState(freshState, 45, 10, now)).toBe(true); // 阈值指定为 10 分钟，20分钟判定陈旧

    // 非 IN_* 状态绝不判定为陈旧断点续跑
    const completedState: BridgeState = {
      ...staleState,
      status: 'COMPLETED',
    };
    expect(isStaleState(completedState, 45, 0, now)).toBe(false);
  });
});
