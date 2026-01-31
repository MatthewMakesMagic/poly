/**
 * Watchdog Integration Tests
 *
 * End-to-end tests for the watchdog process including:
 * - Full kill sequence
 * - Timing guarantees
 * - Process lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');
const killSwitchDir = path.join(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures');

describe('Watchdog Integration Tests', () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up any test files
    const filesToClean = [
      path.join(fixturesDir, 'test-main.pid'),
      path.join(fixturesDir, 'test-watchdog.pid'),
      path.join(fixturesDir, 'test-watchdog.log'),
    ];

    for (const file of filesToClean) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  describe('Watchdog CLI', () => {
    it('should display help with help command', async () => {
      const result = await runWatchdog(['help']);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Kill Switch Watchdog');
      expect(result.output).toContain('Commands:');
    });

    it('should show status', async () => {
      const result = await runWatchdog(['status']);
      // Status command should succeed even if nothing is running
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Kill Switch Watchdog Status');
    });
  });

  describe('Full Kill Sequence', () => {
    it('should kill a responsive child process via CLI', async () => {
      // Start a child process that handles SIGTERM
      const child = spawn('node', ['-e', `
        const fs = require('fs');
        const pidFile = '${fixturesDir}/test-main.pid';
        fs.writeFileSync(pidFile, process.pid.toString());

        process.on('SIGTERM', () => {
          fs.unlinkSync(pidFile);
          process.exit(0);
        });

        // Keep running
        setInterval(() => {}, 1000);
      `], {
        cwd: projectRoot,
        stdio: 'ignore',
        detached: true,
      });

      child.unref();

      // Wait for PID file to be written
      await waitForFile(path.join(fixturesDir, 'test-main.pid'), 2000);

      // Run kill command
      const result = await runKillCommand(path.join(fixturesDir, 'test-main.pid'));

      expect(result.success).toBe(true);
      // Process should be gone
      expect(isProcessRunning(child.pid)).toBe(false);
    }, 10000);

    it('should complete kill within 5 seconds for unresponsive process', async () => {
      // Start a child process that ignores SIGTERM
      const child = spawn('node', ['-e', `
        const fs = require('fs');
        const pidFile = '${fixturesDir}/test-main.pid';
        fs.writeFileSync(pidFile, process.pid.toString());

        process.on('SIGTERM', () => {
          // Ignore SIGTERM - simulate unresponsive process
        });

        // Keep running
        setInterval(() => {}, 1000);
      `], {
        cwd: projectRoot,
        stdio: 'ignore',
        detached: true,
      });

      child.unref();

      // Wait for PID file to be written
      await waitForFile(path.join(fixturesDir, 'test-main.pid'), 2000);

      const startTime = Date.now();

      // Run kill command
      const result = await runKillCommand(path.join(fixturesDir, 'test-main.pid'));
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000); // NFR2: < 5 seconds
      // Process should be gone
      expect(isProcessRunning(child.pid)).toBe(false);
    }, 10000);
  });
});

/**
 * Run the watchdog CLI with given arguments
 */
async function runWatchdog(args) {
  return new Promise((resolve) => {
    const watchdogPath = path.join(killSwitchDir, 'watchdog.js');
    let output = '';

    const proc = spawn('node', [watchdogPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env },
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ exitCode, output });
    });

    proc.on('error', (err) => {
      resolve({ exitCode: 1, output: err.message });
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      proc.kill();
      resolve({ exitCode: 1, output: 'Timeout' });
    }, 10000);
  });
}

/**
 * Run kill command programmatically
 */
async function runKillCommand(pidFilePath) {
  const { killMainProcess, readPidFile } = await import('../process-manager.js');

  const pid = readPidFile(pidFilePath);
  if (!pid) {
    return { success: false, message: 'PID file not found' };
  }

  const result = await killMainProcess(pid);
  return { success: result.success, method: result.method, durationMs: result.durationMs };
}

/**
 * Wait for a file to exist
 */
async function waitForFile(filePath, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`File ${filePath} not found within ${timeoutMs}ms`);
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
