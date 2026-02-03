/**
 * Write-Ahead Logging Module
 *
 * Implements the write-ahead logging pattern for crash recovery.
 * Every state-changing operation logs intent BEFORE execution.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 * All operations are now async.
 *
 * Flow:
 * 1. logIntent() - Create pending intent before action
 * 2. markExecuting() - Mark as executing when action starts
 * 3. markCompleted() or markFailed() - Record outcome
 *
 * On restart: getIncompleteIntents() returns intents with status='executing'
 * that need reconciliation.
 */

import persistence from './index.js';
import { IntentError, ErrorCodes } from '../types/errors.js';

/**
 * Valid intent types
 * @type {Object}
 */
export const INTENT_TYPES = {
  OPEN_POSITION: 'open_position',
  CLOSE_POSITION: 'close_position',
  PLACE_ORDER: 'place_order',
  CANCEL_ORDER: 'cancel_order',
};

/**
 * Valid intent statuses
 * @type {Object}
 */
export const INTENT_STATUS = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// Set of valid intent types for validation
const VALID_INTENT_TYPES = new Set(Object.values(INTENT_TYPES));

/**
 * Valid status transitions map
 *
 * Defines which status transitions are allowed:
 * - pending → executing (operation starting)
 * - executing → completed (success) or failed (error)
 * - completed/failed are terminal states (no further transitions)
 *
 * @type {Object.<string, string[]>}
 */
const VALID_TRANSITIONS = {
  [INTENT_STATUS.PENDING]: [INTENT_STATUS.EXECUTING],
  [INTENT_STATUS.EXECUTING]: [INTENT_STATUS.COMPLETED, INTENT_STATUS.FAILED],
  [INTENT_STATUS.COMPLETED]: [], // Terminal state
  [INTENT_STATUS.FAILED]: [], // Terminal state
};

/**
 * Validate intent type
 * @param {string} type - Intent type to validate
 * @throws {IntentError} If type is invalid
 */
function validateIntentType(type) {
  if (!VALID_INTENT_TYPES.has(type)) {
    const error = new IntentError(
      ErrorCodes.INVALID_INTENT_TYPE,
      `Invalid intent type: ${type}. Must be one of: ${[...VALID_INTENT_TYPES].join(', ')}`,
      { providedType: type, validTypes: [...VALID_INTENT_TYPES] }
    );
    console.error(`[write-ahead] ${error.code}: ${error.message}`, error.context);
    throw error;
  }
}

/**
 * Validate window ID is provided and not empty
 * @param {string} windowId - Window ID to validate
 * @throws {IntentError} If windowId is invalid
 */
function validateWindowId(windowId) {
  if (windowId === null || windowId === undefined || windowId === '') {
    const error = new IntentError(
      ErrorCodes.INVALID_PAYLOAD,
      `Invalid window ID: ${windowId}. Window ID is required and cannot be empty.`,
      { providedWindowId: windowId }
    );
    console.error(`[write-ahead] ${error.code}: ${error.message}`, error.context);
    throw error;
  }
}

/**
 * Safely serialize payload to JSON
 * @param {any} payload - Payload to serialize
 * @returns {string} JSON string
 * @throws {IntentError} If payload cannot be serialized
 */
function serializePayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (err) {
    const error = new IntentError(
      ErrorCodes.INVALID_PAYLOAD,
      `Failed to serialize payload to JSON: ${err.message}`,
      { payload: typeof payload, error: err.message }
    );
    console.error(`[write-ahead] ${error.code}: ${error.message}`, error.context);
    throw error;
  }
}

/**
 * Safely parse JSON, returning null on failure
 * @param {string|null} json - JSON string to parse
 * @returns {any|null} Parsed object or null
 */
function safeParseJson(json) {
  if (json === null || json === undefined) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    // Log warning for corrupted JSON - this indicates data integrity issues
    console.warn(`[write-ahead] Failed to parse JSON from database: ${err.message}`, {
      jsonPreview: typeof json === 'string' ? json.substring(0, 100) : json,
    });
    return null;
  }
}

/**
 * Get intent by ID and validate it exists
 * @param {number} intentId - Intent ID
 * @returns {Promise<Object>} Intent record
 * @throws {IntentError} If intent not found
 */
async function getIntentOrThrow(intentId) {
  const intent = await persistence.get(
    'SELECT * FROM trade_intents WHERE id = $1',
    [intentId]
  );

  if (!intent) {
    const error = new IntentError(
      ErrorCodes.INTENT_NOT_FOUND,
      `Intent not found: ${intentId}`,
      { intentId }
    );
    console.error(`[write-ahead] ${error.code}: ${error.message}`, error.context);
    throw error;
  }

  return intent;
}

/**
 * Validate status transition is allowed
 * @param {string} currentStatus - Current intent status
 * @param {string} targetStatus - Target status
 * @throws {IntentError} If transition is not allowed
 */
function validateTransition(currentStatus, targetStatus) {
  const allowedTargets = VALID_TRANSITIONS[currentStatus] || [];

  if (!allowedTargets.includes(targetStatus)) {
    const error = new IntentError(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      `Invalid status transition: ${currentStatus} → ${targetStatus}. Allowed transitions: ${allowedTargets.join(', ') || 'none (terminal state)'}`,
      { currentStatus, targetStatus, allowedTransitions: allowedTargets }
    );
    console.error(`[write-ahead] ${error.code}: ${error.message}`, error.context);
    throw error;
  }
}

/**
 * Log a new intent before executing an operation
 *
 * @param {string} type - Intent type (one of INTENT_TYPES)
 * @param {string} windowId - The 15-minute window ID (required, cannot be empty)
 * @param {Object} payload - Intent details (will be JSON serialized)
 * @returns {Promise<number>} The intent ID (for tracking through lifecycle)
 * @throws {IntentError} If type/windowId is invalid or payload cannot be serialized
 */
export async function logIntent(type, windowId, payload) {
  // Validate intent type
  validateIntentType(type);

  // Validate window ID
  validateWindowId(windowId);

  // Serialize payload
  const payloadJson = serializePayload(payload);

  // Generate timestamp
  const createdAt = new Date().toISOString();

  // Insert with status='pending' and get the ID back
  const result = await persistence.runReturningId(
    `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [type, windowId, payloadJson, INTENT_STATUS.PENDING, createdAt]
  );

  return result.lastInsertRowid;
}

/**
 * Mark intent as executing (operation starting)
 *
 * @param {number} intentId - The intent ID from logIntent
 * @returns {Promise<void>}
 * @throws {IntentError} If intent not found or invalid transition
 */
export async function markExecuting(intentId) {
  const intent = await getIntentOrThrow(intentId);
  validateTransition(intent.status, INTENT_STATUS.EXECUTING);

  await persistence.run(
    'UPDATE trade_intents SET status = $1 WHERE id = $2',
    [INTENT_STATUS.EXECUTING, intentId]
  );
}

/**
 * Mark intent as completed (operation succeeded)
 *
 * @param {number} intentId - The intent ID
 * @param {Object} result - Success result details
 * @returns {Promise<void>}
 * @throws {IntentError} If intent not found, invalid transition, or result can't be serialized
 */
export async function markCompleted(intentId, result) {
  const intent = await getIntentOrThrow(intentId);
  validateTransition(intent.status, INTENT_STATUS.COMPLETED);

  const resultJson = serializePayload(result);
  const completedAt = new Date().toISOString();

  await persistence.run(
    'UPDATE trade_intents SET status = $1, completed_at = $2, result = $3 WHERE id = $4',
    [INTENT_STATUS.COMPLETED, completedAt, resultJson, intentId]
  );
}

/**
 * Mark intent as failed (operation failed)
 *
 * @param {number} intentId - The intent ID
 * @param {Object} error - Error details (code, message, context)
 * @returns {Promise<void>}
 * @throws {IntentError} If intent not found, invalid transition, or error can't be serialized
 */
export async function markFailed(intentId, error) {
  const intent = await getIntentOrThrow(intentId);
  validateTransition(intent.status, INTENT_STATUS.FAILED);

  const errorJson = serializePayload(error);
  const completedAt = new Date().toISOString();

  await persistence.run(
    'UPDATE trade_intents SET status = $1, completed_at = $2, result = $3 WHERE id = $4',
    [INTENT_STATUS.FAILED, completedAt, errorJson, intentId]
  );
}

/**
 * Get all intents with status='executing' (for crash recovery)
 *
 * @returns {Promise<Array<Object>>} Intents that were executing when crash occurred
 */
export async function getIncompleteIntents() {
  const intents = await persistence.all(
    'SELECT * FROM trade_intents WHERE status = $1',
    [INTENT_STATUS.EXECUTING]
  );

  // Deserialize JSON fields
  return intents.map((intent) => ({
    ...intent,
    payload: safeParseJson(intent.payload),
    result: safeParseJson(intent.result),
  }));
}

/**
 * Get a single intent by ID
 *
 * @param {number} intentId - The intent ID
 * @returns {Promise<Object|undefined>} The intent record with parsed JSON, or undefined if not found
 */
export async function getIntent(intentId) {
  const intent = await persistence.get(
    'SELECT * FROM trade_intents WHERE id = $1',
    [intentId]
  );

  if (!intent) {
    return undefined;
  }

  // Deserialize JSON fields
  return {
    ...intent,
    payload: safeParseJson(intent.payload),
    result: safeParseJson(intent.result),
  };
}

// Default export for module interface consistency
export default {
  logIntent,
  markExecuting,
  markCompleted,
  markFailed,
  getIncompleteIntents,
  getIntent,
  INTENT_TYPES,
  INTENT_STATUS,
};
