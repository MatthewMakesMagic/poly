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

// Export empty object to make this a proper ES module
export default {};
