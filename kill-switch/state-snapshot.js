/**
 * State Snapshot Module
 *
 * Handles reading and writing state snapshots for kill switch integration.
 * Provides atomic file writes and staleness detection.
 *
 * The snapshot captures the current system state for:
 * - Graceful shutdown documentation (forced_kill: false)
 * - Forced kill recovery (forced_kill: true, stale_warning if old)
 *
 * @module kill-switch/state-snapshot
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { WatchdogDefaults } from './types.js';
import { log, warn } from './logger.js';

/**
 * Current snapshot schema version
 * Increment when making breaking changes to the schema
 */
export const SNAPSHOT_VERSION = 1;

/**
 * Default stale threshold in milliseconds
 */
export const DEFAULT_STALE_THRESHOLD_MS = 5000;

/**
 * Write a state snapshot to file atomically
 *
 * Uses a temp file + rename pattern to ensure atomic writes.
 * This prevents corrupted state files if the process crashes mid-write.
 * Uses async I/O to avoid blocking the event loop (AC3 requirement).
 *
 * @param {Object} snapshot - State snapshot to write
 * @param {string} [filePath] - Path to state file (defaults to config path)
 * @returns {Promise<void>}
 */
export async function writeSnapshot(snapshot, filePath = WatchdogDefaults.STATE_FILE_PATH) {
  const tempFile = `${filePath}.tmp`;
  const dir = path.dirname(filePath);

  try {
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      await fsPromises.mkdir(dir, { recursive: true });
    }

    // Write to temp file first (atomic, non-blocking)
    await fsPromises.writeFile(tempFile, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Rename to final path (atomic on most filesystems)
    await fsPromises.rename(tempFile, filePath);

    log('state_snapshot_written', {
      path: filePath,
      version: snapshot.version,
      positions_count: snapshot.positions?.length || 0,
      orders_count: snapshot.orders?.length || 0,
    });
  } catch (err) {
    // Clean up temp file on error to prevent accumulation
    try {
      if (fs.existsSync(tempFile)) {
        await fsPromises.unlink(tempFile);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read a state snapshot from file
 *
 * Validates the snapshot schema before returning. Returns null for
 * invalid/incompatible snapshots with appropriate warnings.
 *
 * @param {string} [filePath] - Path to state file (defaults to config path)
 * @returns {Object|null} Parsed and validated snapshot or null if not found/invalid
 */
export function readSnapshot(filePath = WatchdogDefaults.STATE_FILE_PATH) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return null;
    }

    const snapshot = JSON.parse(content);

    // Validate required schema fields
    if (!snapshot || typeof snapshot !== 'object') {
      warn('state_snapshot_invalid_format', {
        path: filePath,
        reason: 'Not an object',
      });
      return null;
    }

    // Validate version compatibility
    if (snapshot.version !== SNAPSHOT_VERSION) {
      warn('state_snapshot_version_mismatch', {
        path: filePath,
        expected: SNAPSHOT_VERSION,
        actual: snapshot.version,
      });
      // Still return the snapshot for backwards compatibility, but log warning
    }

    // Validate required fields exist
    if (!snapshot.timestamp) {
      warn('state_snapshot_missing_timestamp', {
        path: filePath,
      });
      return null;
    }

    return snapshot;
  } catch (err) {
    warn('state_snapshot_read_failed', {
      path: filePath,
      error: err.message,
    });
    return null;
  }
}

/**
 * Check if a state snapshot is stale (older than threshold)
 *
 * @param {string} [filePath] - Path to state file (defaults to config path)
 * @param {number} [maxAgeMs] - Maximum age in milliseconds before considered stale
 * @returns {boolean} True if snapshot is stale or doesn't exist
 */
export function isSnapshotStale(filePath = WatchdogDefaults.STATE_FILE_PATH, maxAgeMs = DEFAULT_STALE_THRESHOLD_MS) {
  const snapshot = readSnapshot(filePath);

  if (!snapshot || !snapshot.timestamp) {
    return true;
  }

  const age = Date.now() - new Date(snapshot.timestamp).getTime();
  return age > maxAgeMs;
}

/**
 * Get the age of a snapshot in milliseconds
 *
 * @param {string} [filePath] - Path to state file
 * @returns {number|null} Age in milliseconds, or null if snapshot doesn't exist
 */
export function getSnapshotAge(filePath = WatchdogDefaults.STATE_FILE_PATH) {
  const snapshot = readSnapshot(filePath);

  if (!snapshot || !snapshot.timestamp) {
    return null;
  }

  return Date.now() - new Date(snapshot.timestamp).getTime();
}

/**
 * Build a state snapshot from orchestrator and module states
 *
 * @param {Object} orchestratorState - Current orchestrator state
 * @param {Object[]} positions - Array of open positions
 * @param {Object[]} orders - Array of open orders
 * @returns {Object} State snapshot ready for writing
 */
export function buildSnapshot(orchestratorState, positions, orders) {
  const positionsArray = positions || [];
  const ordersArray = orders || [];

  // Calculate total exposure: sum of (size * entry_price) for all positions
  const totalExposure = positionsArray.reduce((sum, pos) => {
    return sum + (pos.size || 0) * (pos.entry_price || 0);
  }, 0);

  return {
    version: SNAPSHOT_VERSION,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    forced_kill: false,
    stale_warning: false,
    orchestrator: {
      state: orchestratorState?.state || 'unknown',
      started_at: orchestratorState?.startedAt || null,
      error_count: orchestratorState?.errorCount || 0,
    },
    positions: positionsArray,
    orders: ordersArray,
    summary: {
      open_positions: positionsArray.length,
      open_orders: ordersArray.length,
      total_exposure: totalExposure,
    },
  };
}

/**
 * Mark a snapshot with forced kill flags
 *
 * Used by the watchdog after a forced kill to update the snapshot
 * with forced_kill=true and stale_warning if applicable.
 *
 * @param {Object} snapshot - Existing snapshot
 * @param {boolean} isStale - Whether the snapshot is stale
 * @returns {Object} Updated snapshot
 */
export function markAsForcedKill(snapshot, isStale = false) {
  return {
    ...snapshot,
    forced_kill: true,
    stale_warning: isStale,
  };
}
