/**
 * Logger Module Tests
 *
 * Tests for the structured JSON logging module that ensures
 * complete, queryable logs with credential redaction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import the logger module
import * as logger from '../index.js';

describe('Logger Module', () => {
  let tempDir;
  let logDir;

  beforeEach(async () => {
    // Reset logger state before each test
    await logger.shutdown().catch(() => {});

    // Create temp directory for test logs
    tempDir = mkdtempSync(join(tmpdir(), 'poly-logger-test-'));
    logDir = join(tempDir, 'logs');
  });

  afterEach(async () => {
    // Shutdown logger
    await logger.shutdown().catch(() => {});

    // Remove temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Module Interface (AC3)', () => {
    it('exports init function', () => {
      expect(typeof logger.init).toBe('function');
    });

    it('exports info function', () => {
      expect(typeof logger.info).toBe('function');
    });

    it('exports warn function', () => {
      expect(typeof logger.warn).toBe('function');
    });

    it('exports error function', () => {
      expect(typeof logger.error).toBe('function');
    });

    it('exports child function', () => {
      expect(typeof logger.child).toBe('function');
    });

    it('exports getState function', () => {
      expect(typeof logger.getState).toBe('function');
    });

    it('exports shutdown function', () => {
      expect(typeof logger.shutdown).toBe('function');
    });
  });

  describe('init (AC3)', () => {
    it('initializes with default config', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
        },
      });

      const state = logger.getState();
      expect(state.initialized).toBe(true);
    });

    it('respects configured log level', async () => {
      await logger.init({
        logging: {
          level: 'warn',
          directory: logDir,
        },
      });

      const state = logger.getState();
      expect(state.config.level).toBe('warn');
    });

    it('creates logs directory if not exists', async () => {
      const newLogDir = join(tempDir, 'new-logs-dir');

      await logger.init({
        logging: {
          level: 'info',
          directory: newLogDir,
        },
      });

      expect(existsSync(newLogDir)).toBe(true);
    });
  });

  describe('info/warn/error (AC1, AC2)', () => {
    beforeEach(async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false, // Disable console for cleaner test output
        },
      });
    });

    it('info produces JSON with required fields', async () => {
      logger.info('test_event', { value: 1 });

      // Read the log file
      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.timestamp).toBeDefined();
      expect(entry.level).toBe('info');
      expect(entry.module).toBeDefined();
      expect(entry.event).toBe('test_event');
    });

    it('warn produces JSON with required fields', async () => {
      logger.warn('warning_event', { count: 5 });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.level).toBe('warn');
      expect(entry.event).toBe('warning_event');
      expect(entry.data.count).toBe(5);
    });

    it('error produces JSON with required fields', async () => {
      logger.error('error_event', { code: 'ERR' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.level).toBe('error');
      expect(entry.event).toBe('error_event');
    });

    it('timestamp is valid ISO 8601 format with milliseconds', async () => {
      logger.info('timestamp_test');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      // ISO 8601 format: 2026-01-30T10:15:30.123Z
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('level field matches method called', async () => {
      logger.info('info_test');
      logger.warn('warn_test');
      logger.error('error_test');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(JSON.parse(lines[0]).level).toBe('info');
      expect(JSON.parse(lines[1]).level).toBe('warn');
      expect(JSON.parse(lines[2]).level).toBe('error');
    });

    it('includes optional data and context', async () => {
      logger.info('data_test', { user: 'test' }, { session: 'abc123' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.user).toBe('test');
      expect(entry.context.session).toBe('abc123');
    });

    it('error method includes error object details', async () => {
      const err = new Error('Test error message');
      err.code = 'TEST_ERROR';

      logger.error('error_with_obj', { context: 'test' }, {}, err);

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.error).toBeDefined();
      expect(entry.error.message).toBe('Test error message');
      expect(entry.error.name).toBe('Error');
      expect(entry.error.stack).toBeDefined();
    });
  });

  describe('Log level filtering (AC5)', () => {
    it('info level logs all levels', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('info_msg');
      logger.warn('warn_msg');
      logger.error('error_msg');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(3);
    });

    it('warn level filters out info', async () => {
      await logger.init({
        logging: {
          level: 'warn',
          directory: logDir,
          console: false,
        },
      });

      logger.info('info_msg'); // Should be filtered
      logger.warn('warn_msg');
      logger.error('error_msg');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).level).toBe('warn');
      expect(JSON.parse(lines[1]).level).toBe('error');
    });

    it('error level filters out info and warn', async () => {
      await logger.init({
        logging: {
          level: 'error',
          directory: logDir,
          console: false,
        },
      });

      logger.info('info_msg'); // Should be filtered
      logger.warn('warn_msg'); // Should be filtered
      logger.error('error_msg');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).level).toBe('error');
    });
  });

  describe('Credential redaction (AC4)', () => {
    beforeEach(async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });
    });

    it('redacts fields containing "key"', async () => {
      logger.info('sensitive_test', { apiKey: 'secret123', normalField: 'visible' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.apiKey).toBe('[REDACTED]');
      expect(entry.data.normalField).toBe('visible');
    });

    it('redacts fields containing "secret"', async () => {
      logger.info('sensitive_test', { apiSecret: 'hidden', user: 'visible' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.apiSecret).toBe('[REDACTED]');
      expect(entry.data.user).toBe('visible');
    });

    it('redacts nested sensitive fields', async () => {
      logger.info('nested_test', {
        config: {
          api: {
            key: 'nested-secret',
            endpoint: 'visible',
          },
        },
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.config.api.key).toBe('[REDACTED]');
      expect(entry.data.config.api.endpoint).toBe('visible');
    });

    it('handles arrays with sensitive data', async () => {
      logger.info('array_test', {
        items: [
          { name: 'item1', token: 'secret1' },
          { name: 'item2', token: 'secret2' },
        ],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.items[0].name).toBe('item1');
      expect(entry.data.items[0].token).toBe('[REDACTED]');
      expect(entry.data.items[1].token).toBe('[REDACTED]');
    });
  });

  describe('Child logger (AC6)', () => {
    beforeEach(async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });
    });

    it('includes default fields in all logs', async () => {
      const log = logger.child({ module: 'position-manager' });
      log.info('position_opened', { window_id: 'w123' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.module).toBe('position-manager');
      expect(entry.event).toBe('position_opened');
      expect(entry.data.window_id).toBe('w123');
    });

    it('merges with per-log fields', async () => {
      const log = logger.child({ module: 'order-manager', strategy: 'spot-lag' });
      log.info('order_placed', { order_id: 'o456' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.module).toBe('order-manager');
      expect(entry.data.strategy).toBe('spot-lag');
      expect(entry.data.order_id).toBe('o456');
    });

    it('inherits parent configuration', async () => {
      // Parent logger is configured with warn level
      await logger.shutdown();
      await logger.init({
        logging: {
          level: 'warn',
          directory: logDir,
          console: false,
        },
      });

      const log = logger.child({ module: 'test-module' });
      log.info('filtered_event'); // Should be filtered
      log.warn('warn_event');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).event).toBe('warn_event');
    });

    it('supports nested children (child of child)', async () => {
      const parent = logger.child({ module: 'orchestrator' });
      const child = parent.child({ component: 'scheduler' });
      child.info('scheduled_task', { task_id: 't789' });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.module).toBe('orchestrator');
      expect(entry.data.component).toBe('scheduler');
      expect(entry.data.task_id).toBe('t789');
    });
  });

  describe('File output (AC7)', () => {
    beforeEach(async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });
    });

    it('writes newline-delimited JSON', async () => {
      logger.info('event1');
      logger.info('event2');
      logger.info('event3');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');

      // Each line should be valid JSON
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(3);
      lines.forEach((line) => {
        expect(() => JSON.parse(line)).not.toThrow();
      });
    });

    it('uses daily rotation filename', async () => {
      logger.info('test_event');

      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const expectedFile = join(logDir, `poly-${today}.log`);

      expect(existsSync(expectedFile)).toBe(true);
    });

    it('appends to existing file', async () => {
      logger.info('first_event');

      // Re-initialize without clearing file
      await logger.shutdown();
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('second_event');

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).event).toBe('first_event');
      expect(JSON.parse(lines[1]).event).toBe('second_event');
    });
  });

  describe('getState (AC3)', () => {
    it('returns config and stats', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('test1');
      logger.error('test2');

      const state = logger.getState();

      expect(state.initialized).toBe(true);
      expect(state.config.level).toBe('info');
      expect(state.config.directory).toBe(logDir);
      expect(state.stats.totalLogs).toBe(2);
      expect(state.stats.errorCount).toBe(1);
    });

    it('tracks total logs written', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      expect(logger.getState().stats.totalLogs).toBe(0);

      logger.info('event1');
      expect(logger.getState().stats.totalLogs).toBe(1);

      logger.info('event2');
      logger.warn('event3');
      expect(logger.getState().stats.totalLogs).toBe(3);
    });

    it('returns uninitialized state when not initialized', async () => {
      const state = logger.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBe(null);
    });
  });

  describe('shutdown (AC3)', () => {
    it('flushes pending writes', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('before_shutdown');
      await logger.shutdown();

      // File should still be readable after shutdown
      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');

      expect(content).toContain('before_shutdown');
    });

    it('closes file handle', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('test');
      await logger.shutdown();

      const state = logger.getState();
      expect(state.initialized).toBe(false);
    });

    it('resets state after shutdown', async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });

      logger.info('test');
      await logger.shutdown();

      const state = logger.getState();
      expect(state.stats.totalLogs).toBe(0);
    });

    it('can shutdown when not initialized', async () => {
      // Should not throw
      await expect(logger.shutdown()).resolves.not.toThrow();
    });
  });

  describe('Circular reference handling', () => {
    beforeEach(async () => {
      await logger.init({
        logging: {
          level: 'info',
          directory: logDir,
          console: false,
        },
      });
    });

    it('handles circular references gracefully', async () => {
      const circular = { name: 'test' };
      circular.self = circular;

      // Should not throw
      logger.info('circular_test', circular);

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `poly-${today}.log`);
      const content = readFileSync(logFile, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.data.name).toBe('test');
      expect(entry.data.self).toBe('[Circular]');
    });
  });
});
