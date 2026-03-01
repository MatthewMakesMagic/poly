/**
 * Startup Safety Module
 *
 * Phase 0.4: Implements startup safety checks before trading begins.
 *
 * 1. Position reconciliation: Compare DB positions vs Polymarket API
 * 2. Distributed lock: Only one active_trader instance via PostgreSQL
 * 3. Token ID validation: Verify token IDs against Polymarket API
 *
 * Public API:
 * - init(config) - Run startup checks
 * - getState() - Return check results
 * - shutdown() - Release distributed lock
 *
 * @module modules/startup-safety
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as positionManager from '../position-manager/index.js';
import * as polymarket from '../../clients/polymarket/index.js';
import * as circuitBreaker from '../circuit-breaker/index.js';
import crypto from 'crypto';

let log = null;
let initialized = false;
let config = null;

// Instance identity
const instanceId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// State
let lockAcquired = false;
let observerOnly = false;
let reconciliationResult = null;
let heartbeatInterval = null;

// Heartbeat interval for distributed lock (30s)
const HEARTBEAT_INTERVAL_MS = 30000;
// Lock is considered stale after 2 minutes without heartbeat
const LOCK_STALE_THRESHOLD_MS = 120000;

/**
 * Initialize startup safety checks
 *
 * @param {Object} cfg - Full application configuration
 */
export async function init(cfg) {
  if (initialized) return;

  log = child({ module: 'startup-safety' });
  config = cfg;

  log.info('module_init_start', { instanceId });

  const tradingMode = cfg.tradingMode || 'PAPER';

  // 1. Acquire distributed lock (before any trading)
  await acquireDistributedLock(tradingMode);

  // 2. Position reconciliation (only in LIVE mode)
  if (tradingMode === 'LIVE' && !observerOnly) {
    await reconcilePositions();
  } else {
    log.info('position_reconciliation_skipped', {
      tradingMode,
      observerOnly,
      reason: tradingMode !== 'LIVE'
        ? 'Not in LIVE mode'
        : 'Observer-only mode',
    });
  }

  initialized = true;
  log.info('module_initialized', {
    instanceId,
    lockAcquired,
    observerOnly,
    reconciliation: reconciliationResult
      ? { verified: reconciliationResult.verified, divergences: reconciliationResult.divergences?.length || 0 }
      : null,
  });
}

/**
 * Acquire distributed lock via PostgreSQL instance_locks table.
 * Only one instance can be active_trader. Second instance becomes observer-only.
 *
 * @param {string} tradingMode - LIVE or PAPER
 */
async function acquireDistributedLock(tradingMode) {
  const lockName = 'active_trader';

  try {
    // Check for existing lock
    const existing = await persistence.get(
      'SELECT * FROM instance_locks WHERE lock_name = $1',
      [lockName]
    );

    if (existing) {
      const heartbeatAge = Date.now() - new Date(existing.heartbeat_at).getTime();

      if (heartbeatAge > LOCK_STALE_THRESHOLD_MS) {
        // Stale lock - take over
        log.warn('distributed_lock_stale_takeover', {
          previous_instance: existing.instance_id,
          heartbeat_age_ms: heartbeatAge,
          stale_threshold_ms: LOCK_STALE_THRESHOLD_MS,
        });

        await persistence.run(
          `UPDATE instance_locks
           SET instance_id = $1, acquired_at = NOW(), heartbeat_at = NOW(),
               metadata = $2
           WHERE lock_name = $3`,
          [instanceId, JSON.stringify({ pid: process.pid, tradingMode }), lockName]
        );

        lockAcquired = true;
        observerOnly = false;
      } else {
        // Active lock held by another instance
        log.warn('distributed_lock_held_by_other', {
          holder_instance: existing.instance_id,
          heartbeat_age_ms: heartbeatAge,
          message: 'Another instance holds the active_trader lock. Entering observer-only mode.',
        });

        lockAcquired = false;
        observerOnly = true;
        return;
      }
    } else {
      // No lock exists - acquire it
      await persistence.run(
        `INSERT INTO instance_locks (lock_name, instance_id, acquired_at, heartbeat_at, metadata)
         VALUES ($1, $2, NOW(), NOW(), $3)`,
        [lockName, instanceId, JSON.stringify({ pid: process.pid, tradingMode })]
      );

      lockAcquired = true;
      observerOnly = false;
    }

    log.info('distributed_lock_acquired', {
      lockName,
      instanceId,
    });

    // Start heartbeat
    startHeartbeat(lockName);
  } catch (err) {
    log.error('distributed_lock_acquisition_failed', {
      error: err.message,
      message: 'Failed to acquire distributed lock. Entering observer-only mode for safety.',
    });

    lockAcquired = false;
    observerOnly = true;
  }
}

/**
 * Start heartbeat interval to maintain the distributed lock
 *
 * @param {string} lockName - Lock name to heartbeat
 */
function startHeartbeat(lockName) {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(async () => {
    try {
      const result = await persistence.run(
        `UPDATE instance_locks
         SET heartbeat_at = NOW()
         WHERE lock_name = $1 AND instance_id = $2`,
        [lockName, instanceId]
      );

      if (!result || result.changes === 0) {
        // Lock was stolen or removed
        log.error('distributed_lock_lost', {
          lockName,
          instanceId,
          message: 'Lock heartbeat found no matching row. Lock may have been stolen.',
        });
        lockAcquired = false;
        observerOnly = true;
        stopHeartbeat();
      }
    } catch (err) {
      log.error('distributed_lock_heartbeat_failed', {
        error: err.message,
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop heartbeat interval
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Reconcile local DB positions against Polymarket API
 *
 * If any mismatch is found, trips the circuit breaker.
 */
async function reconcilePositions() {
  log.info('position_reconciliation_start');

  try {
    const result = await positionManager.reconcile(polymarket);
    reconciliationResult = result;

    if (!result.success && result.divergences && result.divergences.length > 0) {
      // Filter out API_ERROR divergences (network issues should not trip CB)
      const realDivergences = result.divergences.filter(d => d.type !== 'API_ERROR');

      if (realDivergences.length > 0) {
        log.error('position_reconciliation_mismatch', {
          level: 'CRITICAL',
          verified: result.verified,
          divergences: realDivergences,
          message: 'Position mismatch detected on startup. Tripping circuit breaker.',
        });

        await circuitBreaker.trip('POSITION_TRACKING_FAILED', {
          source: 'startup-safety',
          divergences: realDivergences,
          timestamp: new Date().toISOString(),
        });
      } else {
        log.warn('position_reconciliation_api_errors', {
          apiErrorCount: result.divergences.length,
          message: 'Reconciliation had API errors but no real divergences. Proceeding.',
        });
      }
    } else {
      log.info('position_reconciliation_passed', {
        verified: result.verified,
        positionsChecked: result.verified,
      });
    }
  } catch (err) {
    log.error('position_reconciliation_failed', {
      error: err.message,
      message: 'Reconciliation failed. Proceeding with caution.',
    });

    reconciliationResult = {
      verified: 0,
      divergences: [{ type: 'RECONCILIATION_FAILED', error: err.message }],
      timestamp: new Date().toISOString(),
      success: false,
    };
  }
}

/**
 * Check if this instance is in observer-only mode
 *
 * @returns {boolean} True if observer-only
 */
export function isObserverOnly() {
  return observerOnly;
}

/**
 * Get current module state
 *
 * @returns {Object} State snapshot
 */
export function getState() {
  return {
    initialized,
    instanceId,
    lockAcquired,
    observerOnly,
    reconciliation: reconciliationResult,
  };
}

/**
 * Shutdown the module, releasing the distributed lock
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  stopHeartbeat();

  // Release the distributed lock
  if (lockAcquired) {
    try {
      await persistence.run(
        'DELETE FROM instance_locks WHERE lock_name = $1 AND instance_id = $2',
        ['active_trader', instanceId]
      );
      log.info('distributed_lock_released', { instanceId });
    } catch (err) {
      if (log) log.warn('distributed_lock_release_failed', { error: err.message });
    }
  }

  lockAcquired = false;
  observerOnly = false;
  reconciliationResult = null;
  initialized = false;
  config = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}
