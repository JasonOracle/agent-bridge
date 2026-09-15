/**
 * [变更日志]
 * 修改时间：2026-09-15
 * AI模型：Gemini 系列
 * 修改内容：[1. 增加配置模块四类核心验收测试：合法配置、缺 env、坏 JSON、非法 mode]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, ConfigError } from './config.js';

describe('配置模块 (src/config.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. 合法配置：正确解析并填充默认值', () => {
    const configPath = path.join(tmpDir, '.bridge.config.json');
    const validConfig = {
      supervisor: {
        mode: 'watch',
      },
      builder: {
        mode: 'watch',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(validConfig, null, 2), 'utf-8');

    const config = loadConfig(configPath, {});
    expect(config.supervisor.mode).toBe('watch');
    expect(config.builder.mode).toBe('watch');
    expect(config.pollIntervalSec).toBe(5);
    expect(config.checkTimeoutMin).toBe(10);
    expect(config.maxRetryPerTask).toBe(5);
    expect(config.onMaxRetry).toBe('human');
    expect(config.onError).toBe('retry');
    expect(config.maxDiffKB).toBe(64);
    expect(config.staleThresholdMin).toBe(0);
  });

  it('2. 缺 env：当启用模式依赖的环境变量缺失时，报出具体变量名并具有 exitCode=2', () => {
    const configPath = path.join(tmpDir, '.bridge.config.json');
    const apiConfig = {
      supervisor: {
        mode: 'api',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        apiKey: '${ANTHROPIC_API_KEY}',
      },
      builder: {
        mode: 'watch',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(apiConfig, null, 2), 'utf-8');

    try {
      loadConfig(configPath, {}); // 传入空 env，不含 ANTHROPIC_API_KEY
      expect.fail('应抛出 ConfigError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      const confErr = err as ConfigError;
      expect(confErr.exitCode).toBe(2);
      expect(confErr.message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('3. 坏 JSON：文件内容格式错误时抛出异常', () => {
    const configPath = path.join(tmpDir, '.bridge.config.json');
    fs.writeFileSync(configPath, '{ invalid json: true, ', 'utf-8');

    expect(() => loadConfig(configPath, {})).toThrowError(ConfigError);
    try {
      loadConfig(configPath, {});
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).exitCode).toBe(2);
    }
  });

  it('4. 非法 mode：supervisor.mode 或 builder.mode 非法时抛出错误', () => {
    const configPath = path.join(tmpDir, '.bridge.config.json');
    const invalidModeConfig = {
      supervisor: {
        mode: 'invalid_mode',
      },
      builder: {
        mode: 'watch',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(invalidModeConfig, null, 2), 'utf-8');

    expect(() => loadConfig(configPath, {})).toThrowError(/supervisor.mode 非法/);
  });

  it('5. 模式感知：mode=watch 时不强求未启用模式的 API Key 环境变量', () => {
    const configPath = path.join(tmpDir, '.bridge.config.json');
    const watchConfigWithUnusedKey = {
      supervisor: {
        mode: 'watch',
        apiKey: '${UNSET_API_KEY}', // 未启用 api 模式，应不强制插值与校验
      },
      builder: {
        mode: 'watch',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(watchConfigWithUnusedKey, null, 2), 'utf-8');

    const config = loadConfig(configPath, {});
    expect(config.supervisor.mode).toBe('watch');
  });

  it('6. 配置文件不存在时报错', () => {
    const configPath = path.join(tmpDir, 'non-existent.json');
    expect(() => loadConfig(configPath, {})).toThrowError(/配置文件不存在/);
  });
});
