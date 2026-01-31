/**
 * State Reconciler Module - Detect and report incomplete operations on restart
 *
 * Implements state reconciliation as defined in the Architecture Decision Document.
 * On restart: Check for incomplete intents → report for manual reconciliation
 *
 * Exports:
 * - init(config) - Initialize with configuration
 * - checkStartupState() - Run reconciliation checks, returns status object
 * - getIncompleteIntents() - Get list of incomplete intents
 * - markIntentReconciled(intentId, resolution) - Mark intent as manually reconciled
 * - detectDivergence(memoryState, dbState) - Detect state divergence
 * - getState() - Return module state
 * - shutdown() - Clean shutdown
 */

import * as logger from '../logger/index.js';
import { getIncompleteIntents as getIncompleteIntentsFromDb } from '../../persistence/write-ahead.js';
import persistence from '../../persistence/index.js';
import { detectDivergence as detectDivergenceLogic, buildReconciliationResult, formatDivergenceForLog } from './logic.js';
import { StateError, ErrorCodes } from '../../types/errors.js';

// Module state
let state = {
  initialized: false,
  config: null,
  lastReconciliation: null,
  stats: {
    totalChecks: 0,
    incompleteFound: 0,
    divergencesDetected: 0,
  },
};

// Child logger for this module
let log = null;

/**
 * Initialize the state reconciler module
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function init(config) {
  if (state.initialized) {
    // Already initialized - silently return (idempotent behavior)
    return;
  }

  state.config = config || {};
  log = logger.child({ module: 'state-reconciler' });

  state.initialized = true;
}

/**
 * Run startup reconciliation checks
 *
 * Queries for intents with status='executing' and reports them.
 * Does NOT automatically retry - manual reconciliation required.
 *
 * @returns {Promise<Object>} ReconciliationResult
 */
export async function checkStartupState() {
  if (!state.initialized) {
    throw new StateError(
      ErrorCodes.STATE_RECOVERY_FAILED,
      'State reconciler not initialized. Call init() first.',
      { module: 'state-reconciler' }
    );
  }

  const startTime = Date.now();

  // Query for incomplete intents (status='executing')
  const incompleteIntents = getIncompleteIntentsFromDb();

  // Build result object
  const result = buildReconciliationResult(incompleteIntents, startTime);

  // Update stats
  state.stats.totalChecks++;
  state.stats.incompleteFound += result.incompleteCount;

  if (result.clean) {
    // AC4: Clean startup logging
    log.info('reconciliation_complete', {
      clean: true,
      incomplete_count: 0,
      duration_ms: result.duration_ms,
      message: 'State reconciliation complete - no incomplete intents',
    });
  } else {
    // AC2: Log each incomplete intent as warning
    for (const intent of incompleteIntents) {
      log.warn('incomplete_intent_detected', {
        intent_id: intent.id,
        intent_type: intent.intent_type,
        window_id: intent.window_id,
        created_at: intent.created_at,
        payload: intent.payload,
      });
    }

    // AC3: Summary message indicating manual reconciliation required
    log.warn('reconciliation_requires_manual_action', {
      incomplete_count: result.incompleteCount,
      duration_ms: result.duration_ms,
      message: `${result.incompleteCount} incomplete intents found - manual reconciliation required`,
    });
  }

  // Store last reconciliation result
  state.lastReconciliation = result;

  return result;
}

/**
 * Get list of incomplete intents
 *
 * @returns {Promise<Array<Object>>} List of incomplete intents
 */
export async function getIncompleteIntents() {
  return getIncompleteIntentsFromDb();
}

/**
 * Mark an intent as manually reconciled
 *
 * Updates intent status to 'failed' with resolution details.
 * This allows operators to mark intents as handled after manual verification.
 *
 * @param {number} intentId - Intent ID to reconcile
 * @param {Object} resolution - Resolution details (action, result, notes)
 * @returns {Promise<void>}
 * @throws {StateError} If intent not found or not in 'executing' status
 */
export async function markIntentReconciled(intentId, resolution) {
  if (!state.initialized) {
    throw new StateError(
      ErrorCodes.STATE_RECOVERY_FAILED,
      'State reconciler not initialized. Call init() first.',
      { module: 'state-reconciler' }
    );
  }

  // Get the intent to validate it exists and is in 'executing' status
  const intent = persistence.get(
    'SELECT * FROM trade_intents WHERE id = ?',
    [intentId]
  );

  if (!intent) {
    throw new StateError(
      ErrorCodes.INTENT_INCOMPLETE,
      `Intent not found: ${intentId}`,
      { intentId }
    );
  }

  if (intent.status !== 'executing') {
    throw new StateError(
      ErrorCodes.INTENT_INCOMPLETE,
      `Intent ${intentId} is not in 'executing' status (current: ${intent.status})`,
      { intentId, currentStatus: intent.status }
    );
  }

  // Update intent to 'failed' with resolution
  const completedAt = new Date().toISOString();
  const resultJson = JSON.stringify({
    reconciled: true,
    resolution,
    reconciled_at: completedAt,
  });

  persistence.run(
    'UPDATE trade_intents SET status = ?, completed_at = ?, result = ? WHERE id = ?',
    ['failed', completedAt, resultJson, intentId]
  );

  // Log the reconciliation action
  log.info('intent_manually_reconciled', {
    intent_id: intentId,
    intent_type: intent.intent_type,
    window_id: intent.window_id,
    resolution,
    completed_at: completedAt,
  });
}

/**
 * Detect state divergence between memory and database
 *
 * Compares position states and logs any divergences found.
 *
 * @param {Array<Object>} memoryPositions - Positions from memory state
 * @param {Array<Object>} dbPositions - Positions from database
 * @returns {Promise<Array<Object>>} List of divergences found
 */
export async function detectDivergence(memoryPositions, dbPositions) {
  const divergences = detectDivergenceLogic(memoryPositions, dbPositions);

  // AC5: Log divergences with error level
  if (divergences.length > 0) {
    state.stats.divergencesDetected += divergences.length;

    for (const divergence of divergences) {
      const formattedDivergence = formatDivergenceForLog(divergence);

      log.error('state_divergence_detected', {
        type: divergence.type,
        position_id: divergence.position_id,
        field: divergence.field,
        memory_value: divergence.memory_value,
        db_value: divergence.db_value,
        memory_state: divergence.memory_state,
        db_state: divergence.db_state,
        actionable_message: formattedDivergence.actionable_message,
      });
    }
  }

  return divergences;
}

/**
 * Get current module state
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized: state.initialized,
    config: state.config ? { ...state.config } : null,
    lastReconciliation: state.lastReconciliation ? { ...state.lastReconciliation } : null,
    stats: { ...state.stats },
  };
}

/**
 * Gracefully shutdown the module
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (!state.initialized) {
    return;
  }

  // Reset state
  state = {
    initialized: false,
    config: null,
    lastReconciliation: null,
    stats: {
      totalChecks: 0,
      incompleteFound: 0,
      divergencesDetected: 0,
    },
  };
  log = null;
}

// Default export for module interface consistency
export default {
  init,
  checkStartupState,
  getIncompleteIntents,
  markIntentReconciled,
  detectDivergence,
  getState,
  shutdown,
};
