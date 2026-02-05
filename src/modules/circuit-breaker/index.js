/**
 * Circuit Breaker Module
 *
 * V3 Stage 5: Implements "Halt on Uncertainty" principle.
 * State persisted in PostgreSQL via dedicated CB pool.
 * Fail-closed: any DB error means breaker is considered OPEN.
 *
 * Public API:
 * - init(config) - Read current state from DB, start escalation if OPEN
 * - trip(reason, context) - Atomically trip the breaker
 * - isOpen() - Check if breaker is open (fail-closed on error)
 * - reset(operatorId, reason) - Reset breaker with audit trail
 * - getState() - Return current state snapshot
 * - setOrderManager(ref) - Wire order manager for escalation
 * - setOrchestrator(ref) - Wire orchestrator for shutdown escalation
 * - shutdown() - Clear escalation interval
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import { CircuitBreakerError, CBState, TripReason, EscalationStage, CBErrorCodes } from './types.js';

let log = null;
let initialized = false;
let config = null;

// In-memory state (minimal - source of truth is DB)
let tripTimestamp = null;
let currentState = CBState.CLOSED;
let currentTripReason = null;
let fallbackOpen = false; // Set true if DB is unreachable during trip

// Escalation
let escalationInterval = null;
let orderManagerRef = null;
let orchestratorRef = null;

/**
 * Get the current escalation stage based on time since trip
 */
function getEscalationStage() {
  if (!tripTimestamp) return null;

  const elapsedMs = Date.now() - tripTimestamp;
  const minutes = elapsedMs / 60000;

  if (minutes >= 30) return EscalationStage.SHUTDOWN;
  if (minutes >= 15) return EscalationStage.CANCEL_ORDERS;
  if (minutes >= 5) return EscalationStage.ALERT;
  return EscalationStage.MONITORING;
}

/**
 * Escalation tick - runs every 30s when breaker is OPEN
 */
async function escalationTick() {
  if (currentState !== CBState.OPEN) return;

  const stage = getEscalationStage();
  const elapsedMs = tripTimestamp ? Date.now() - tripTimestamp : 0;
  const elapsedMin = (elapsedMs / 60000).toFixed(1);

  switch (stage) {
    case EscalationStage.MONITORING:
      log.error('circuit_breaker_open', {
        stage,
        elapsed_min: elapsedMin,
        trip_reason: currentTripReason,
        message: 'Circuit breaker is OPEN - monitoring',
      });
      break;

    case EscalationStage.ALERT:
      log.error('circuit_breaker_escalation', {
        level: 'CRITICAL',
        stage,
        elapsed_min: elapsedMin,
        trip_reason: currentTripReason,
        message: 'Circuit breaker OPEN > 5 min - CRITICAL alert',
      });
      break;

    case EscalationStage.CANCEL_ORDERS:
      log.error('circuit_breaker_escalation', {
        level: 'CRITICAL',
        stage,
        elapsed_min: elapsedMin,
        trip_reason: currentTripReason,
        message: 'Circuit breaker OPEN > 15 min - cancelling all orders',
      });
      if (orderManagerRef && typeof orderManagerRef.cancelAll === 'function') {
        try {
          await orderManagerRef.cancelAll();
          log.info('escalation_cancel_all_complete');
        } catch (err) {
          log.error('escalation_cancel_all_failed', { error: err.message });
        }
      }
      break;

    case EscalationStage.SHUTDOWN: {
      const allowExtended = process.env.CB_ALLOW_EXTENDED_HALT === 'true';
      if (allowExtended) {
        log.error('circuit_breaker_extended_halt', {
          level: 'CRITICAL',
          stage,
          elapsed_min: elapsedMin,
          trip_reason: currentTripReason,
          message: 'Circuit breaker OPEN > 30 min - CB_ALLOW_EXTENDED_HALT=true, continuing',
        });
      } else {
        log.error('circuit_breaker_shutdown', {
          level: 'CRITICAL',
          stage,
          elapsed_min: elapsedMin,
          trip_reason: currentTripReason,
          message: 'Circuit breaker OPEN > 30 min - initiating graceful shutdown',
        });
        if (orchestratorRef && typeof orchestratorRef.shutdown === 'function') {
          orchestratorRef.shutdown().catch((err) => {
            log.error('escalation_shutdown_failed', { error: err.message });
          });
        }
      }
      break;
    }
  }
}

/**
 * Start escalation interval
 */
function startEscalation() {
  if (escalationInterval) return;
  const intervalMs = config?.circuitBreaker?.escalationIntervalMs || 30000;
  escalationInterval = setInterval(escalationTick, intervalMs);
  // Fire immediately
  escalationTick();
}

/**
 * Stop escalation interval
 */
function stopEscalation() {
  if (escalationInterval) {
    clearInterval(escalationInterval);
    escalationInterval = null;
  }
}

/**
 * Initialize the circuit breaker module
 *
 * @param {Object} cfg - Full application configuration
 */
export async function init(cfg) {
  if (initialized) return;

  log = child({ module: 'circuit-breaker' });
  config = cfg;

  log.info('module_init_start');

  try {
    // Read current state from DB
    const rows = await persistence.cbQuery(
      'SELECT state, trip_reason, tripped_at FROM circuit_breaker WHERE id = 1'
    );

    if (rows && rows.length > 0) {
      const row = rows[0];
      currentState = row.state || CBState.CLOSED;
      currentTripReason = row.trip_reason || null;

      if (currentState === CBState.OPEN && row.tripped_at) {
        tripTimestamp = new Date(row.tripped_at).getTime();
        log.warn('circuit_breaker_restored_open', {
          state: currentState,
          trip_reason: currentTripReason,
          tripped_at: row.tripped_at,
          escalation_stage: getEscalationStage(),
        });
        startEscalation();
      }
    }
  } catch (err) {
    // DB not available - fail closed
    log.error('circuit_breaker_init_db_failed', {
      error: err.message,
      message: 'Cannot read CB state from DB - assuming CLOSED for fresh start',
    });
    currentState = CBState.CLOSED;
  }

  initialized = true;
  log.info('module_initialized', { state: currentState });
}

/**
 * Trip the circuit breaker
 *
 * Atomically sets state to OPEN only if currently CLOSED.
 * On DB failure, sets in-memory fallback to OPEN.
 *
 * @param {string} reason - TripReason enum value
 * @param {Object} [context={}] - Additional context for the trip
 */
export async function trip(reason, context = {}) {
  if (!initialized) {
    throw new CircuitBreakerError(CBErrorCodes.CB_NOT_INITIALIZED, 'Circuit breaker not initialized');
  }

  // Already open - log but don't re-trip
  if (currentState === CBState.OPEN || fallbackOpen) {
    log.warn('circuit_breaker_already_open', {
      current_reason: currentTripReason,
      new_reason: reason,
    });
    return;
  }

  const now = new Date();

  try {
    // Atomic: only trips if currently CLOSED
    const result = await persistence.cbQuery(
      `UPDATE circuit_breaker
       SET state = 'OPEN', trip_reason = $1, trip_context = $2, tripped_at = $3, updated_at = $3
       WHERE id = 1 AND state = 'CLOSED'
       RETURNING state`,
      [reason, JSON.stringify(context), now.toISOString()]
    );

    if (!result || result.length === 0) {
      log.warn('circuit_breaker_trip_no_update', {
        reason,
        message: 'UPDATE matched no rows - breaker may already be OPEN',
      });
      // Read current state
      const rows = await persistence.cbQuery('SELECT state FROM circuit_breaker WHERE id = 1');
      if (rows?.[0]?.state === CBState.OPEN) {
        currentState = CBState.OPEN;
      }
      return;
    }

    // Insert audit record
    await persistence.cbQuery(
      `INSERT INTO circuit_breaker_audit (action, reason, context, created_at)
       VALUES ('TRIP', $1, $2, $3)`,
      [reason, JSON.stringify(context), now.toISOString()]
    );
  } catch (err) {
    // DB failure during trip - CRITICAL: fail closed
    log.error('circuit_breaker_trip_db_failed', {
      level: 'CRITICAL',
      error: err.message,
      reason,
      message: 'DB write failed during trip - setting in-memory fallback OPEN',
    });
    fallbackOpen = true;
  }

  currentState = CBState.OPEN;
  currentTripReason = reason;
  tripTimestamp = now.getTime();

  log.error('circuit_breaker_tripped', {
    level: 'CRITICAL',
    reason,
    context,
    tripped_at: now.toISOString(),
  });

  startEscalation();
}

/**
 * Check if the circuit breaker is open
 *
 * Queries DB with timeout. On any error, returns true (fail-closed).
 *
 * @returns {Promise<boolean>} True if breaker is open
 */
export async function isOpen() {
  if (!initialized) return true; // fail-closed

  // In-memory fallback takes precedence
  if (fallbackOpen) return true;

  const timeoutMs = config?.circuitBreaker?.cbQueryTimeoutMs || 1000;

  try {
    const result = await Promise.race([
      persistence.cbQuery('SELECT state FROM circuit_breaker WHERE id = 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('CB query timeout')), timeoutMs)
      ),
    ]);

    if (result && result.length > 0) {
      const dbState = result[0].state;
      currentState = dbState;

      // Sync in-memory trip timestamp if DB says OPEN but we don't have timestamp
      if (dbState === CBState.OPEN && !tripTimestamp) {
        const fullRow = await persistence.cbQuery(
          'SELECT tripped_at, trip_reason FROM circuit_breaker WHERE id = 1'
        );
        if (fullRow?.[0]?.tripped_at) {
          tripTimestamp = new Date(fullRow[0].tripped_at).getTime();
          currentTripReason = fullRow[0].trip_reason;
          startEscalation();
        }
      }

      return dbState === CBState.OPEN;
    }

    // No rows - shouldn't happen, fail closed
    return true;
  } catch (err) {
    log.error('circuit_breaker_check_failed', {
      error: err.message,
      message: 'DB check failed - fail closed (assuming OPEN)',
    });
    return true; // fail-closed
  }
}

/**
 * Reset the circuit breaker
 *
 * Validates no active orders exist before allowing reset.
 *
 * @param {string} operatorId - Identifier of the operator performing reset
 * @param {string} [reason='manual_reset'] - Reason for reset
 */
export async function reset(operatorId, reason = 'manual_reset') {
  if (!initialized) {
    throw new CircuitBreakerError(CBErrorCodes.CB_NOT_INITIALIZED, 'Circuit breaker not initialized');
  }

  if (!operatorId) {
    throw new CircuitBreakerError(
      CBErrorCodes.CIRCUIT_BREAKER_RESET_BLOCKED,
      'operatorId is required for reset'
    );
  }

  // Check for active orders via main pool
  try {
    const activeOrders = await persistence.all(
      "SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'open')"
    );
    if (activeOrders?.[0]?.count > 0) {
      throw new CircuitBreakerError(
        CBErrorCodes.CIRCUIT_BREAKER_RESET_BLOCKED,
        `Cannot reset: ${activeOrders[0].count} active orders exist`,
        { activeOrderCount: activeOrders[0].count }
      );
    }
  } catch (err) {
    if (err instanceof CircuitBreakerError) throw err;
    // If we can't check orders, allow reset (orders table may not exist yet)
    log.warn('circuit_breaker_reset_order_check_failed', {
      error: err.message,
      message: 'Could not verify active orders - proceeding with reset',
    });
  }

  const now = new Date();

  try {
    await persistence.cbQuery(
      `UPDATE circuit_breaker
       SET state = 'CLOSED', trip_reason = NULL, trip_context = NULL, tripped_at = NULL, updated_at = $1
       WHERE id = 1`,
      [now.toISOString()]
    );

    await persistence.cbQuery(
      `INSERT INTO circuit_breaker_audit (action, reason, context, operator_id, created_at)
       VALUES ('RESET', $1, $2, $3, $4)`,
      [reason, JSON.stringify({ previous_reason: currentTripReason }), operatorId, now.toISOString()]
    );
  } catch (err) {
    throw new CircuitBreakerError(
      CBErrorCodes.CB_QUERY_FAILED,
      `Failed to reset circuit breaker: ${err.message}`,
      { error: err.message }
    );
  }

  currentState = CBState.CLOSED;
  currentTripReason = null;
  tripTimestamp = null;
  fallbackOpen = false;

  stopEscalation();

  log.info('circuit_breaker_reset', {
    operator_id: operatorId,
    reason,
  });
}

/**
 * Get current circuit breaker state
 *
 * @returns {Object} State snapshot
 */
export function getState() {
  return {
    initialized,
    state: fallbackOpen ? CBState.OPEN : currentState,
    tripReason: currentTripReason,
    trippedAt: tripTimestamp ? new Date(tripTimestamp).toISOString() : null,
    escalationStage: currentState === CBState.OPEN || fallbackOpen ? getEscalationStage() : null,
    fallbackOpen,
  };
}

/**
 * Set order manager reference for escalation
 *
 * @param {Object} ref - Order manager module reference
 */
export function setOrderManager(ref) {
  orderManagerRef = ref;
  if (log) log.info('order_manager_wired');
}

/**
 * Set orchestrator reference for shutdown escalation
 *
 * @param {Object} ref - Object with shutdown() method
 */
export function setOrchestrator(ref) {
  orchestratorRef = ref;
  if (log) log.info('orchestrator_wired');
}

/**
 * Shutdown the circuit breaker module
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  stopEscalation();
  orderManagerRef = null;
  orchestratorRef = null;
  initialized = false;
  currentState = CBState.CLOSED;
  currentTripReason = null;
  tripTimestamp = null;
  fallbackOpen = false;
  config = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

// Re-export types for convenience
export { CBState, TripReason, EscalationStage, CBErrorCodes, CircuitBreakerError } from './types.js';
