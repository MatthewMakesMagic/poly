/**
 * Process Manager Tests
 *
 * Tests for the process management functions including:
 * - PID file operations
 * - Process signal sending
 * - Kill sequence execution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fork, spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  isProcessRunning,
  sendGracefulShutdown,
  sendForceKill,
  waitForProcessExit,
  killMainProcess,
  readPidFile,
  writePidFile,
  removePidFile,
  checkStalePidFile,
  getMainProcessStatus,
} from '../process-manager.js';
import { ProcessStatus, KillMethod, WatchdogDefaults } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const testPidFile = path.join(fixturesDir, 'test.pid');

describe('Process Manager', () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test PID file
    if (fs.existsSync(testPidFile)) {
      fs.unlinkSync(testPidFile);
    }
  });

  describe('PID File Operations', () => {
    describe('writePidFile', () => {
      it('should write PID to file', () => {
        writePidFile(testPidFile, 12345);
        expect(fs.existsSync(testPidFile)).toBe(true);
        const content = fs.readFileSync(testPidFile, 'utf-8').trim();
        expect(content).toBe('12345');
      });

      it('should create directory if not exists', () => {
        const nestedPath = path.join(fixturesDir, 'nested', 'dir', 'test.pid');
        writePidFile(nestedPath, 99999);
        expect(fs.existsSync(nestedPath)).toBe(true);
        // Clean up
        fs.unlinkSync(nestedPath);
        fs.rmdirSync(path.dirname(nestedPath));
        fs.rmdirSync(path.join(fixturesDir, 'nested'));
      });
    });

    describe('readPidFile', () => {
      it('should return null for non-existent file', () => {
        const result = readPidFile('/nonexistent/path/file.pid');
        expect(result).toBeNull();
      });

      it('should read valid PID from file', () => {
        fs.writeFileSync(testPidFile, '54321', 'utf-8');
        const result = readPidFile(testPidFile);
        expect(result).toBe(54321);
      });

      it('should return null for invalid PID content', () => {
        fs.writeFileSync(testPidFile, 'not-a-number', 'utf-8');
        const result = readPidFile(testPidFile);
        expect(result).toBeNull();
      });

      it('should handle whitespace around PID', () => {
        fs.writeFileSync(testPidFile, '  12345  \n', 'utf-8');
        const result = readPidFile(testPidFile);
        expect(result).toBe(12345);
      });
    });

    describe('removePidFile', () => {
      it('should remove existing file', () => {
        fs.writeFileSync(testPidFile, '12345', 'utf-8');
        const result = removePidFile(testPidFile);
        expect(result).toBe(true);
        expect(fs.existsSync(testPidFile)).toBe(false);
      });

      it('should return true for non-existent file', () => {
        const result = removePidFile('/nonexistent/path/file.pid');
        expect(result).toBe(true);
      });
    });

    describe('checkStalePidFile', () => {
      it('should return exists:false for non-existent file', () => {
        const result = checkStalePidFile('/nonexistent/path/file.pid');
        expect(result.exists).toBe(false);
        expect(result.isStale).toBe(false);
        expect(result.pid).toBeNull();
      });

      it('should detect stale PID (process not running)', () => {
        // Write a PID that definitely doesn't exist
        fs.writeFileSync(testPidFile, '99999999', 'utf-8');
        const result = checkStalePidFile(testPidFile);
        expect(result.exists).toBe(true);
        expect(result.isStale).toBe(true);
        expect(result.pid).toBe(99999999);
      });

      it('should detect current process as running', () => {
        // Write our own PID - we know we're running
        fs.writeFileSync(testPidFile, process.pid.toString(), 'utf-8');
        const result = checkStalePidFile(testPidFile);
        expect(result.exists).toBe(true);
        expect(result.isStale).toBe(false);
        expect(result.pid).toBe(process.pid);
      });
    });
  });

  describe('Process Status Checking', () => {
    describe('isProcessRunning', () => {
      it('should return true for current process', () => {
        expect(isProcessRunning(process.pid)).toBe(true);
      });

      it('should return false for non-existent process', () => {
        expect(isProcessRunning(99999999)).toBe(false);
      });

      it('should return false for invalid PID', () => {
        expect(isProcessRunning(null)).toBe(false);
        expect(isProcessRunning(undefined)).toBe(false);
        expect(isProcessRunning(-1)).toBe(false);
        expect(isProcessRunning(0)).toBe(false);
      });
    });

    describe('getMainProcessStatus', () => {
      it('should return UNKNOWN when PID file does not exist', () => {
        const result = getMainProcessStatus('/nonexistent/path/main.pid');
        expect(result.status).toBe(ProcessStatus.UNKNOWN);
        expect(result.pid).toBeNull();
      });

      it('should return STOPPED for stale PID file', () => {
        fs.writeFileSync(testPidFile, '99999999', 'utf-8');
        const result = getMainProcessStatus(testPidFile);
        expect(result.status).toBe(ProcessStatus.STOPPED);
        expect(result.pid).toBe(99999999);
      });

      it('should return RUNNING for running process', () => {
        fs.writeFileSync(testPidFile, process.pid.toString(), 'utf-8');
        const result = getMainProcessStatus(testPidFile);
        expect(result.status).toBe(ProcessStatus.RUNNING);
        expect(result.pid).toBe(process.pid);
      });
    });
  });

  describe('Signal Sending', () => {
    describe('sendGracefulShutdown', () => {
      it('should return true for non-existent process (ESRCH)', () => {
        // This returns true because the process is "already gone"
        const result = sendGracefulShutdown(99999999);
        expect(result).toBe(true);
      });
    });

    describe('sendForceKill', () => {
      it('should return true for non-existent process (ESRCH)', () => {
        const result = sendForceKill(99999999);
        expect(result).toBe(true);
      });
    });
  });

  describe('waitForProcessExit', () => {
    it('should return true immediately for non-existent process', async () => {
      const startTime = Date.now();
      const result = await waitForProcessExit(99999999, 5000);
      const duration = Date.now() - startTime;

      expect(result).toBe(true);
      expect(duration).toBeLessThan(200); // Should be very fast
    });

    it('should timeout for running process', async () => {
      const startTime = Date.now();
      const result = await waitForProcessExit(process.pid, 200);
      const duration = Date.now() - startTime;

      expect(result).toBe(false);
      expect(duration).toBeGreaterThanOrEqual(180); // Should take ~200ms
      expect(duration).toBeLessThan(500); // But not too long
    });
  });

  describe('Kill Sequence', () => {
    describe('killMainProcess', () => {
      it('should return already_stopped for non-existent process', async () => {
        const result = await killMainProcess(99999999);

        expect(result.success).toBe(true);
        expect(result.method).toBe(KillMethod.ALREADY_STOPPED);
        expect(result.pid).toBe(99999999);
        expect(result.durationMs).toBeLessThan(100);
      });

      it('should include timing information', async () => {
        const result = await killMainProcess(99999999);

        expect(result.startedAt).toBeDefined();
        expect(result.completedAt).toBeDefined();
        expect(result.durationMs).toBeDefined();
        expect(typeof result.durationMs).toBe('number');
      });
    });
  });
});

describe('Kill Sequence Integration Tests', () => {
  // These tests spawn actual child processes to test the kill sequence

  it('should gracefully kill a responsive process', async () => {
    // Spawn a process that handles SIGTERM
    const child = spawn('node', ['-e', `
      process.on('SIGTERM', () => {
        console.log('Received SIGTERM, exiting gracefully');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await killMainProcess(child.pid);

    expect(result.success).toBe(true);
    expect(result.method).toBe(KillMethod.GRACEFUL);
    expect(result.gracefulSent).toBe(true);
    expect(result.forceSent).toBe(false);
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('should force kill an unresponsive process', async () => {
    // Spawn a process that ignores SIGTERM
    const child = spawn('node', ['-e', `
      process.on('SIGTERM', () => {
        console.log('Ignoring SIGTERM');
        // Don't exit - simulate unresponsive process
      });
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 100));

    const startTime = Date.now();
    const result = await killMainProcess(child.pid, { gracefulTimeoutMs: 500 });
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.method).toBe(KillMethod.FORCE);
    expect(result.gracefulSent).toBe(true);
    expect(result.forceSent).toBe(true);
    // Should be around gracefulTimeoutMs + small buffer
    expect(duration).toBeGreaterThan(400);
    expect(duration).toBeLessThan(2000);
  });

  it('should complete kill sequence within 5 seconds (NFR2)', async () => {
    // Spawn a process that ignores SIGTERM
    const child = spawn('node', ['-e', `
      process.on('SIGTERM', () => {
        // Ignore SIGTERM
      });
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });

    await new Promise(resolve => setTimeout(resolve, 100));

    const startTime = Date.now();
    const result = await killMainProcess(child.pid);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(duration).toBeLessThan(5000); // NFR2: < 5 seconds
  });
});
