/**
 * Type definitions for State Reconciler Module
 *
 * @typedef {Object} IncompleteIntent
 * @property {number} id - Intent ID
 * @property {string} intent_type - Type of operation
 * @property {string} window_id - Trading window
 * @property {Object} payload - Intent details (parsed JSON)
 * @property {string} created_at - When intent was created
 */

/**
 * @typedef {Object} ReconciliationResult
 * @property {boolean} clean - True if no issues found
 * @property {number} incompleteCount - Number of incomplete intents
 * @property {IncompleteIntent[]} incompleteIntents - Details of each
 * @property {string} timestamp - When reconciliation ran
 * @property {number} duration_ms - How long the check took
 */

/**
 * @typedef {Object} Divergence
 * @property {string} type - Type of divergence (MEMORY_ONLY, DB_ONLY, STATE_MISMATCH)
 * @property {string|number} position_id - Position identifier
 * @property {string} [field] - Field that differs (for STATE_MISMATCH)
 * @property {*} [memory_value] - Value in memory
 * @property {*} [db_value] - Value in database
 * @property {Object|null} memory_state - Full memory state (for MEMORY_ONLY/DB_ONLY)
 * @property {Object|null} db_state - Full database state (for MEMORY_ONLY/DB_ONLY)
 */

/**
 * @typedef {Object} ReconcilerStats
 * @property {number} totalChecks - Total reconciliation checks performed
 * @property {number} incompleteFound - Total incomplete intents found across all checks
 * @property {number} divergencesDetected - Total divergences detected
 */

/**
 * @typedef {Object} ReconcilerState
 * @property {Object|null} config - Module configuration
 * @property {ReconciliationResult|null} lastReconciliation - Last reconciliation result
 * @property {ReconcilerStats} stats - Running statistics
 * @property {boolean} initialized - Whether module is initialized
 */

/**
 * Divergence type constants
 * @type {Object}
 */
export const DIVERGENCE_TYPES = {
  MEMORY_ONLY: 'MEMORY_ONLY',
  DB_ONLY: 'DB_ONLY',
  STATE_MISMATCH: 'STATE_MISMATCH',
};

/**
 * Log event names used by the state reconciler
 * @type {Object}
 */
export const LOG_EVENTS = {
  RECONCILIATION_COMPLETE: 'reconciliation_complete',
  INCOMPLETE_INTENT_DETECTED: 'incomplete_intent_detected',
  RECONCILIATION_REQUIRES_MANUAL_ACTION: 'reconciliation_requires_manual_action',
  STATE_DIVERGENCE_DETECTED: 'state_divergence_detected',
  INTENT_MANUALLY_RECONCILED: 'intent_manually_reconciled',
};

/**
 * NFR3 performance requirement: reconciliation must complete within this time
 * @type {number}
 */
export const MAX_RECONCILIATION_TIME_MS = 10000;

// Default export for backward compatibility
export default {
  DIVERGENCE_TYPES,
  LOG_EVENTS,
  MAX_RECONCILIATION_TIME_MS,
};
