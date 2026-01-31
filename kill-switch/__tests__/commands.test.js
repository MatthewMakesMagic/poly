/**
 * Watchdog Commands Tests
 *
 * Tests for the CLI command handlers including:
 * - start command
 * - stop command
 * - kill command
 * - status command
 * - help command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initialize,
  startCommand,
  stopCommand,
  killCommand,
  statusCommand,
  helpCommand,
  executeCommand,
} from '../commands.js';
import { WatchdogErrorCodes, ProcessStatus, KillMethod } from '../types.js';
import { resetState } from '../state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const testPidFile = path.join(fixturesDir, 'test-main.pid');
const testWatchdogPidFile = path.join(fixturesDir, 'test-watchdog.pid');
const testLogFile = path.join(fixturesDir, 'test-watchdog.log');

describe('Watchdog Commands', () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // Reset state
    resetState();

    // Initialize with test paths
    initialize({
      gracefulTimeoutMs: 500,
      pidFilePath: testPidFile,
      watchdogPidFile: testWatchdogPidFile,
      logFilePath: testLogFile,
    });
  });

  afterEach(() => {
    // Clean up test files
    [testPidFile, testWatchdogPidFile, testLogFile].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });

  describe('executeCommand', () => {
    it('should execute help command', async () => {
      const result = await executeCommand('help');
      expect(result.success).toBe(true);
      expect(result.command).toBe('help');
    });

    it('should return error for unknown command', async () => {
      const result = await executeCommand('unknown');
      expect(result.success).toBe(false);
      expect(result.code).toBe(WatchdogErrorCodes.INVALID_COMMAND);
    });
  });

  describe('statusCommand', () => {
    it('should return status when no processes are running', async () => {
      const result = await statusCommand();

      expect(result.watchdog.running).toBe(false);
      expect(result.mainProcess.status).toBe(ProcessStatus.UNKNOWN);
    });

    it('should include config information', async () => {
      const result = await statusCommand();

      expect(result.config).toBeDefined();
      expect(result.config.gracefulTimeoutMs).toBe(500);
    });

    it('should detect when main process PID file exists but is stale', async () => {
      // Write a stale PID file
      fs.writeFileSync(testPidFile, '99999999', 'utf-8');

      const result = await statusCommand();

      expect(result.mainProcess.status).toBe(ProcessStatus.STOPPED);
      expect(result.mainProcess.pid).toBe(99999999);
    });
  });

  describe('killCommand', () => {
    it('should return error when PID file not found', async () => {
      const result = await killCommand();

      expect(result.success).toBe(false);
      expect(result.code).toBe(WatchdogErrorCodes.PID_FILE_NOT_FOUND);
    });

    it('should return success for already stopped process', async () => {
      // Write a stale PID file
      fs.writeFileSync(testPidFile, '99999999', 'utf-8');

      const result = await killCommand();

      expect(result.success).toBe(true);
      expect(result.method).toBe(KillMethod.ALREADY_STOPPED);
    });

    it('should clean up PID file after successful kill', async () => {
      // Write a stale PID file
      fs.writeFileSync(testPidFile, '99999999', 'utf-8');

      await killCommand();

      expect(fs.existsSync(testPidFile)).toBe(false);
    });
  });

  describe('startCommand', () => {
    it('should start successfully when not already running', async () => {
      const result = await startCommand();

      expect(result.success).toBe(true);
      expect(result.watchdogPid).toBe(process.pid);
    });

    it('should write watchdog PID file', async () => {
      await startCommand();

      expect(fs.existsSync(testWatchdogPidFile)).toBe(true);
      const content = fs.readFileSync(testWatchdogPidFile, 'utf-8').trim();
      expect(content).toBe(process.pid.toString());
    });

    it('should detect already running watchdog', async () => {
      // Start once
      await startCommand();

      // Try to start again
      const result = await startCommand();

      expect(result.success).toBe(false);
      expect(result.code).toBe(WatchdogErrorCodes.WATCHDOG_ALREADY_RUNNING);
    });
  });

  describe('stopCommand', () => {
    it('should stop and clean up', async () => {
      // Start first
      await startCommand();
      expect(fs.existsSync(testWatchdogPidFile)).toBe(true);

      // Then stop
      const result = await stopCommand();

      expect(result.success).toBe(true);
      expect(fs.existsSync(testWatchdogPidFile)).toBe(false);
    });
  });

  describe('helpCommand', () => {
    it('should return success', () => {
      const result = helpCommand();
      expect(result.success).toBe(true);
      expect(result.command).toBe('help');
    });
  });
});
