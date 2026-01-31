/**
 * Watchdog State Management
 *
 * Tracks the current state of the watchdog and monitored process.
 * This module is independent of the main process state management.
 *
 * @module kill-switch/state
 */

import { ProcessStatus } from './types.js';

/**
 * Internal watchdog state
 */
let state = createInitialState();

/**
 * Create the initial watchdog state
 * @returns {Object} Initial state object
 */
function createInitialState() {
  return {
    watchdog: {
      startedAt: null,
      running: false,
      pid: null,
    },
    mainProcess: {
      pid: null,
      status: ProcessStatus.UNKNOWN,
      lastChecked: null,
      lastStatusChange: null,
      statusHistory: [],
    },
    lastKill: null,
    healthChecks: {
      total: 0,
      successful: 0,
      failed: 0,
    },
  };
}

/**
 * Get current watchdog state
 * @returns {Object} Current state
 */
export function getState() {
  return { ...state };
}

/**
 * Set watchdog as running
 * @param {number} pid - Watchdog process ID
 */
export function setWatchdogRunning(pid) {
  state.watchdog = {
    startedAt: new Date().toISOString(),
    running: true,
    pid,
  };
}

/**
 * Set watchdog as stopped
 */
export function setWatchdogStopped() {
  state.watchdog.running = false;
}

/**
 * Update main process PID
 * @param {number|null} pid - Main process PID or null if not found
 */
export function setMainProcessPid(pid) {
  state.mainProcess.pid = pid;
}

/**
 * Update main process status
 * @param {string} status - Status from ProcessStatus
 */
export function setMainProcessStatus(status) {
  const now = new Date().toISOString();
  const previousStatus = state.mainProcess.status;

  if (previousStatus !== status) {
    state.mainProcess.statusHistory.push({
      from: previousStatus,
      to: status,
      timestamp: now,
    });
    state.mainProcess.lastStatusChange = now;

    // Keep only last 10 status changes
    if (state.mainProcess.statusHistory.length > 10) {
      state.mainProcess.statusHistory.shift();
    }
  }

  state.mainProcess.status = status;
  state.mainProcess.lastChecked = now;
}

/**
 * Record a health check result
 * @param {boolean} success - Whether the health check succeeded
 */
export function recordHealthCheck(success) {
  state.healthChecks.total++;
  if (success) {
    state.healthChecks.successful++;
  } else {
    state.healthChecks.failed++;
  }
}

/**
 * Record a kill operation result
 * @param {Object} result - Kill result object
 */
export function recordKillResult(result) {
  state.lastKill = {
    ...result,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
}

/**
 * Get a summary of the current state for display
 * @returns {Object} State summary
 */
export function getStateSummary() {
  const uptime = state.watchdog.startedAt
    ? Date.now() - new Date(state.watchdog.startedAt).getTime()
    : 0;

  return {
    watchdog: {
      running: state.watchdog.running,
      pid: state.watchdog.pid,
      uptime: uptime > 0 ? formatDuration(uptime) : null,
    },
    mainProcess: {
      pid: state.mainProcess.pid,
      status: state.mainProcess.status,
      lastChecked: state.mainProcess.lastChecked,
    },
    healthChecks: { ...state.healthChecks },
    lastKill: state.lastKill,
  };
}

/**
 * Format duration in human-readable format
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
