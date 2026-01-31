/**
 * Watchdog CLI Commands
 *
 * Implements the command handlers for the watchdog CLI:
 * - start: Start watching the main process
 * - stop: Stop the watchdog
 * - kill: Trigger kill sequence on main process
 * - status: Report main process and watchdog status
 * - help: Show usage information
 *
 * @module kill-switch/commands
 */

import fs from 'fs';
import {
  WatchdogError,
  WatchdogErrorCodes,
  WatchdogDefaults,
  ProcessStatus,
  KillMethod,
} from './types.js';
import {
  readPidFile,
  writePidFile,
  removePidFile,
  checkStalePidFile,
  isProcessRunning,
  getMainProcessStatus,
  killMainProcess,
} from './process-manager.js';
import {
  getState,
  getStateSummary,
  setWatchdogRunning,
  setWatchdogStopped,
  setMainProcessPid,
  setMainProcessStatus,
  recordHealthCheck,
  recordKillResult,
} from './state.js';
import { log, info, warn, error, configure as configureLogger } from './logger.js';
import {
  readSnapshot,
  writeSnapshot,
  isSnapshotStale,
  getSnapshotAge,
  markAsForcedKill,
} from './state-snapshot.js';

let healthCheckInterval = null;
let config = null;

/**
 * Initialize command handlers with configuration
 *
 * @param {Object} cfg - Configuration object
 * @param {number} [cfg.gracefulTimeoutMs=2000] - Graceful shutdown timeout
 * @param {string} [cfg.pidFilePath] - Path to main process PID file
 * @param {string} [cfg.logFilePath] - Path to watchdog log file
 */
export function initialize(cfg = {}) {
  config = {
    gracefulTimeoutMs: cfg.gracefulTimeoutMs || WatchdogDefaults.GRACEFUL_TIMEOUT_MS,
    pidFilePath: cfg.pidFilePath || WatchdogDefaults.PID_FILE_PATH,
    logFilePath: cfg.logFilePath || WatchdogDefaults.LOG_FILE_PATH,
    watchdogPidFile: cfg.watchdogPidFile || WatchdogDefaults.WATCHDOG_PID_FILE,
    stateFilePath: cfg.stateFilePath || WatchdogDefaults.STATE_FILE_PATH,
    stateStaleThresholdMs: cfg.stateStaleThresholdMs || WatchdogDefaults.STATE_STALE_THRESHOLD_MS,
  };

  configureLogger({ logFile: config.logFilePath });
}

/**
 * Start command - begin watching the main process
 *
 * @returns {Promise<Object>} Command result
 */
export async function startCommand() {
  if (!config) {
    initialize();
  }

  info('watchdog_start_command');

  // Check if watchdog is already running
  const watchdogPidCheck = checkStalePidFile(config.watchdogPidFile);
  if (watchdogPidCheck.exists && !watchdogPidCheck.isStale) {
    warn('watchdog_already_running', { pid: watchdogPidCheck.pid });
    return {
      success: false,
      code: WatchdogErrorCodes.WATCHDOG_ALREADY_RUNNING,
      message: `Watchdog already running (PID: ${watchdogPidCheck.pid})`,
    };
  }

  // Clean up stale watchdog PID file if exists
  if (watchdogPidCheck.isStale) {
    info('cleaning_stale_watchdog_pid', { pid: watchdogPidCheck.pid });
    removePidFile(config.watchdogPidFile);
  }

  // Write our PID file
  writePidFile(config.watchdogPidFile, process.pid);
  setWatchdogRunning(process.pid);

  // Check main process status
  const mainStatus = getMainProcessStatus(config.pidFilePath);
  setMainProcessPid(mainStatus.pid);
  setMainProcessStatus(mainStatus.status);

  // Start health check interval (check every 5 seconds)
  startHealthCheckInterval(5000);

  info('watchdog_started', {
    watchdogPid: process.pid,
    mainPid: mainStatus.pid,
    mainStatus: mainStatus.status,
  });

  return {
    success: true,
    message: 'Watchdog started',
    watchdogPid: process.pid,
    mainProcess: mainStatus,
  };
}

/**
 * Stop command - stop the watchdog gracefully
 *
 * @returns {Promise<Object>} Command result
 */
export async function stopCommand() {
  if (!config) {
    initialize();
  }

  info('watchdog_stop_command');

  // Stop health check interval
  stopHealthCheckInterval();

  // Remove watchdog PID file
  removePidFile(config.watchdogPidFile);
  setWatchdogStopped();

  info('watchdog_stopped');

  return {
    success: true,
    message: 'Watchdog stopped',
  };
}

/**
 * Kill command - trigger the kill sequence on the main process
 *
 * This is the critical safety function that can forcibly terminate
 * the main process within 5 seconds (NFR2).
 *
 * @returns {Promise<Object>} Command result with kill details
 */
export async function killCommand() {
  if (!config) {
    initialize();
  }

  info('watchdog_kill_command');

  // Read main process PID
  const pid = readPidFile(config.pidFilePath);

  if (pid === null) {
    warn('kill_no_pid_file');
    return {
      success: false,
      code: WatchdogErrorCodes.PID_FILE_NOT_FOUND,
      message: 'Main process PID file not found. Is the main process running?',
    };
  }

  // Check if process is actually running
  if (!isProcessRunning(pid)) {
    info('kill_process_not_running', { pid });

    // Clean up stale PID file
    removePidFile(config.pidFilePath);

    return {
      success: true,
      method: KillMethod.ALREADY_STOPPED,
      message: `Main process (PID: ${pid}) is not running. Cleaned up stale PID file.`,
      pid,
    };
  }

  // Execute the kill sequence
  info('kill_sequence_starting', { pid, gracefulTimeoutMs: config.gracefulTimeoutMs });

  const result = await killMainProcess(pid, {
    gracefulTimeoutMs: config.gracefulTimeoutMs,
  });

  recordKillResult(result);

  // Clean up PID file on successful kill
  if (result.success) {
    removePidFile(config.pidFilePath);
    setMainProcessStatus(ProcessStatus.STOPPED);
  }

  // Read and process state snapshot after kill
  let stateSnapshot = null;
  let snapshotSummary = null;

  try {
    stateSnapshot = readSnapshot(config.stateFilePath);

    if (stateSnapshot) {
      const staleThreshold = config.stateStaleThresholdMs;
      const snapshotStale = isSnapshotStale(config.stateFilePath, staleThreshold);
      const snapshotAgeMs = getSnapshotAge(config.stateFilePath);

      // If forced kill, update the snapshot with forced_kill flag
      if (result.method === KillMethod.FORCE) {
        stateSnapshot = markAsForcedKill(stateSnapshot, snapshotStale);

        // Re-write the snapshot with updated flags
        try {
          await writeSnapshot(stateSnapshot, config.stateFilePath);
        } catch (writeErr) {
          warn('state_snapshot_update_failed', { error: writeErr.message });
        }

        if (snapshotStale) {
          warn('state_snapshot_stale_warning', {
            age_ms: snapshotAgeMs,
            threshold_ms: staleThreshold,
            message: 'State snapshot from last known - verify with exchange',
          });
        }
      }

      // Build summary for logging
      snapshotSummary = {
        forced_kill: stateSnapshot.forced_kill,
        stale_warning: stateSnapshot.stale_warning,
        open_positions: stateSnapshot.summary?.open_positions || 0,
        open_orders: stateSnapshot.summary?.open_orders || 0,
        total_exposure: stateSnapshot.summary?.total_exposure || 0,
        snapshot_age_ms: snapshotAgeMs,
      };

      info('kill_complete_state_summary', snapshotSummary);
    } else {
      info('kill_complete_no_state', {
        message: 'No state snapshot available - manual exchange verification required',
      });
    }
  } catch (snapshotErr) {
    warn('state_snapshot_processing_failed', {
      error: snapshotErr.message,
      message: 'Failed to process state snapshot - manual exchange verification required',
    });
  }

  const methodDescriptions = {
    [KillMethod.GRACEFUL]: 'Graceful shutdown (SIGTERM)',
    [KillMethod.FORCE]: 'Forced kill (SIGKILL) - main process was unresponsive',
    [KillMethod.ALREADY_STOPPED]: 'Process was already stopped',
    [KillMethod.FAILED]: 'Kill failed - process may still be running',
  };

  info('kill_sequence_complete', result);

  return {
    success: result.success,
    method: result.method,
    message: methodDescriptions[result.method] || 'Unknown',
    pid: result.pid,
    durationMs: result.durationMs,
    gracefulSent: result.gracefulSent,
    forceSent: result.forceSent,
    stateSnapshot: snapshotSummary,
  };
}

/**
 * Status command - report current status of watchdog and main process
 *
 * @returns {Promise<Object>} Status information
 */
export async function statusCommand() {
  if (!config) {
    initialize();
  }

  // Get main process status
  const mainStatus = getMainProcessStatus(config.pidFilePath);

  // Check if watchdog is running
  const watchdogPidCheck = checkStalePidFile(config.watchdogPidFile);
  const watchdogRunning = watchdogPidCheck.exists && !watchdogPidCheck.isStale;

  // Get state summary
  const stateSummary = getStateSummary();

  const status = {
    success: true, // Status check always succeeds
    watchdog: {
      running: watchdogRunning,
      pid: watchdogRunning ? watchdogPidCheck.pid : null,
      ...stateSummary.watchdog,
    },
    mainProcess: {
      // mainStatus takes precedence (live check) over stateSummary (cached)
      ...stateSummary.mainProcess,
      ...mainStatus,
    },
    healthChecks: stateSummary.healthChecks,
    lastKill: stateSummary.lastKill,
    config: {
      gracefulTimeoutMs: config.gracefulTimeoutMs,
      pidFilePath: config.pidFilePath,
    },
  };

  info('status_checked', {
    watchdogRunning,
    mainStatus: mainStatus.status,
  });

  return status;
}

/**
 * Help command - show usage information
 *
 * @returns {Object} Help text
 */
export function helpCommand() {
  const help = `
Kill Switch Watchdog - Safety process for poly trading system

Usage: node kill-switch/watchdog.js <command>

Commands:
  start     Start watching the main process
  stop      Stop the watchdog
  kill      Trigger kill sequence on main process
  status    Show status of main process and watchdog
  help      Show this help message

Examples:
  node kill-switch/watchdog.js start    # Start the watchdog
  node kill-switch/watchdog.js kill     # Trigger kill sequence
  node kill-switch/watchdog.js status   # Check current status

Kill Sequence:
  1. Send SIGTERM (graceful shutdown)
  2. Wait up to 2 seconds for graceful exit
  3. If still running, send SIGKILL (force kill)
  4. Total time guaranteed < 5 seconds

Files:
  PID file:  ${WatchdogDefaults.PID_FILE_PATH}
  Log file:  ${WatchdogDefaults.LOG_FILE_PATH}
  State:     ${WatchdogDefaults.STATE_FILE_PATH}
`.trim();

  console.log(help);

  return {
    success: true,
    command: 'help',
  };
}

/**
 * Start the health check interval
 *
 * @param {number} intervalMs - Check interval in milliseconds
 * @private
 */
function startHealthCheckInterval(intervalMs) {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(() => {
    performHealthCheck();
  }, intervalMs);

  // Perform immediate check
  performHealthCheck();
}

/**
 * Stop the health check interval
 *
 * @private
 */
function stopHealthCheckInterval() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Perform a single health check
 *
 * @private
 */
function performHealthCheck() {
  const mainStatus = getMainProcessStatus(config.pidFilePath);

  const previousStatus = getState().mainProcess.status;

  setMainProcessPid(mainStatus.pid);
  setMainProcessStatus(mainStatus.status);

  const success = mainStatus.status === ProcessStatus.RUNNING;
  recordHealthCheck(success);

  // Log status changes
  if (previousStatus !== mainStatus.status) {
    info('main_process_status_changed', {
      from: previousStatus,
      to: mainStatus.status,
      pid: mainStatus.pid,
    });
  }
}

/**
 * Execute a command by name
 *
 * @param {string} command - Command name
 * @returns {Promise<Object>} Command result
 */
export async function executeCommand(command) {
  switch (command) {
    case 'start':
      return startCommand();
    case 'stop':
      return stopCommand();
    case 'kill':
      return killCommand();
    case 'status':
      return statusCommand();
    case 'help':
      return helpCommand();
    default:
      error('invalid_command', { command });
      return {
        success: false,
        code: WatchdogErrorCodes.INVALID_COMMAND,
        message: `Unknown command: ${command}. Use 'help' to see available commands.`,
      };
  }
}
