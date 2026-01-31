/**
 * Process Manager
 *
 * Handles process signaling, status checking, and the kill sequence.
 * This is the core logic for terminating the main process.
 *
 * @module kill-switch/process-manager
 */

import fs from 'fs';
import path from 'path';
import {
  WatchdogError,
  WatchdogErrorCodes,
  ProcessStatus,
  KillMethod,
  WatchdogDefaults,
} from './types.js';
import { log } from './logger.js';

/**
 * Check if a process is running by PID
 *
 * Uses signal 0 which doesn't actually send a signal but checks if process exists.
 *
 * @param {number} pid - Process ID to check
 * @returns {boolean} True if process is running
 */
export function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) {
    return false;
  }

  try {
    // Signal 0 = check existence only, doesn't actually signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // ESRCH = No such process
      return false;
    }
    if (err.code === 'EPERM') {
      // EPERM = Process exists but we don't have permission
      // This shouldn't happen for our own processes, but process exists
      return true;
    }
    // Other errors - treat as not running
    return false;
  }
}

/**
 * Send graceful shutdown signal (SIGTERM) to a process
 *
 * @param {number} pid - Process ID to signal
 * @returns {boolean} True if signal was sent successfully
 */
export function sendGracefulShutdown(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    log('signal_sent', { pid, signal: 'SIGTERM', type: 'graceful' });
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process already gone - that's fine
      log('signal_skipped', { pid, signal: 'SIGTERM', reason: 'process_not_found' });
      return true;
    }
    log('signal_failed', { pid, signal: 'SIGTERM', error: err.message, code: err.code });
    return false;
  }
}

/**
 * Send force kill signal (SIGKILL) to a process
 *
 * @param {number} pid - Process ID to kill
 * @returns {boolean} True if signal was sent successfully
 */
export function sendForceKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    log('signal_sent', { pid, signal: 'SIGKILL', type: 'force' });
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process already gone - that's fine
      log('signal_skipped', { pid, signal: 'SIGKILL', reason: 'process_not_found' });
      return true;
    }
    log('signal_failed', { pid, signal: 'SIGKILL', error: err.message, code: err.code });
    return false;
  }
}

/**
 * Wait for a process to exit within a timeout
 *
 * Polls the process status at regular intervals until it exits or times out.
 *
 * @param {number} pid - Process ID to wait for
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<boolean>} True if process exited, false if timeout
 */
export async function waitForProcessExit(pid, timeoutMs) {
  const startTime = Date.now();
  const pollInterval = WatchdogDefaults.POLL_INTERVAL_MS;

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(pollInterval);
  }

  return false;
}

/**
 * Execute the kill sequence on the main process
 *
 * Implements the 2-phase kill:
 * 1. Send SIGTERM (graceful shutdown)
 * 2. Wait for graceful timeout
 * 3. If still running, send SIGKILL (force kill)
 *
 * Guaranteed to complete within 5 seconds (NFR2).
 *
 * @param {number} pid - Process ID to kill
 * @param {Object} [options={}] - Kill options
 * @param {number} [options.gracefulTimeoutMs=2000] - Timeout for graceful shutdown
 * @returns {Promise<Object>} Kill result object
 */
export async function killMainProcess(pid, options = {}) {
  const gracefulTimeoutMs = options.gracefulTimeoutMs || WatchdogDefaults.GRACEFUL_TIMEOUT_MS;
  const startTime = Date.now();

  const result = {
    pid,
    startedAt: new Date().toISOString(),
    gracefulSent: false,
    forceSent: false,
    completedAt: null,
    durationMs: 0,
    method: null,
    success: false,
  };

  // Step 1: Check if process exists
  if (!isProcessRunning(pid)) {
    result.method = KillMethod.ALREADY_STOPPED;
    result.success = true;
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - startTime;
    log('kill_already_stopped', { pid, durationMs: result.durationMs });
    return result;
  }

  // Step 2: Send graceful shutdown (SIGTERM)
  log('kill_graceful_start', { pid, gracefulTimeoutMs });
  const gracefulSent = sendGracefulShutdown(pid);
  result.gracefulSent = gracefulSent;

  if (!gracefulSent) {
    // If we couldn't send SIGTERM, try SIGKILL directly
    log('kill_graceful_failed_trying_force', { pid });
  }

  // Step 3: Wait for graceful exit
  const exited = await waitForProcessExit(pid, gracefulTimeoutMs);

  if (exited) {
    result.method = KillMethod.GRACEFUL;
    result.success = true;
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - startTime;
    log('kill_graceful_success', { pid, durationMs: result.durationMs });
    return result;
  }

  // Step 4: Force kill (SIGKILL) if graceful failed
  log('kill_force_start', { pid, reason: 'graceful_timeout' });
  const forceSent = sendForceKill(pid);
  result.forceSent = forceSent;

  // Step 5: Verify process is dead (brief wait for SIGKILL to take effect)
  await sleep(100);

  if (!isProcessRunning(pid)) {
    result.method = KillMethod.FORCE;
    result.success = true;
    log('kill_force_success', { pid, durationMs: Date.now() - startTime });
  } else {
    result.method = KillMethod.FAILED;
    result.success = false;
    log('kill_failed', { pid, reason: 'process_still_running' });
  }

  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - startTime;

  return result;
}

/**
 * Read the main process PID from the PID file
 *
 * @param {string} [pidFilePath] - Path to PID file
 * @returns {number|null} PID if found and valid, null otherwise
 */
export function readPidFile(pidFilePath = WatchdogDefaults.PID_FILE_PATH) {
  try {
    if (!fs.existsSync(pidFilePath)) {
      return null;
    }

    const content = fs.readFileSync(pidFilePath, 'utf-8').trim();
    const pid = parseInt(content, 10);

    if (isNaN(pid) || pid <= 0) {
      log('pid_file_invalid', { path: pidFilePath, content });
      return null;
    }

    return pid;
  } catch (err) {
    log('pid_file_read_error', { path: pidFilePath, error: err.message });
    return null;
  }
}

/**
 * Write a PID to a file
 *
 * @param {string} pidFilePath - Path to PID file
 * @param {number} pid - Process ID to write
 */
export function writePidFile(pidFilePath, pid) {
  const dir = path.dirname(pidFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(pidFilePath, pid.toString(), 'utf-8');
  log('pid_file_written', { path: pidFilePath, pid });
}

/**
 * Remove a PID file
 *
 * @param {string} pidFilePath - Path to PID file
 * @returns {boolean} True if removed or didn't exist
 */
export function removePidFile(pidFilePath) {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
      log('pid_file_removed', { path: pidFilePath });
    }
    return true;
  } catch (err) {
    log('pid_file_remove_error', { path: pidFilePath, error: err.message });
    return false;
  }
}

/**
 * Check if a PID file is stale (process doesn't exist)
 *
 * @param {string} [pidFilePath] - Path to PID file
 * @returns {Object} Result with isStale boolean and pid if found
 */
export function checkStalePidFile(pidFilePath = WatchdogDefaults.PID_FILE_PATH) {
  const pid = readPidFile(pidFilePath);

  if (pid === null) {
    return { exists: false, isStale: false, pid: null };
  }

  const isStale = !isProcessRunning(pid);

  if (isStale) {
    log('pid_file_stale', { path: pidFilePath, pid });
  }

  return { exists: true, isStale, pid };
}

/**
 * Get the current status of the main process
 *
 * @param {string} [pidFilePath] - Path to PID file
 * @returns {Object} Process status information
 */
export function getMainProcessStatus(pidFilePath = WatchdogDefaults.PID_FILE_PATH) {
  const pidCheck = checkStalePidFile(pidFilePath);

  if (!pidCheck.exists) {
    return {
      status: ProcessStatus.UNKNOWN,
      pid: null,
      message: 'PID file not found',
    };
  }

  if (pidCheck.isStale) {
    return {
      status: ProcessStatus.STOPPED,
      pid: pidCheck.pid,
      message: 'Process not running (stale PID file)',
    };
  }

  return {
    status: ProcessStatus.RUNNING,
    pid: pidCheck.pid,
    message: 'Process is running',
  };
}

/**
 * Sleep utility
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
