/**
 * Position Lifecycle State Machine
 *
 * Manages position lifecycle transitions:
 *   ENTRY -> MONITORING -> { STOP_TRIGGERED | TP_TRIGGERED | EXPIRY }
 *                           |                |                |
 *                           v                v                v
 *                        EXIT_PENDING    EXIT_PENDING     SETTLEMENT
 *                           |                |                |
 *                           v                v                v
 *                         CLOSED           CLOSED           CLOSED
 *
 * Rules:
 * - Once EXIT_PENDING, position is LOCKED (no further modifications)
 * - Every transition is logged with timestamp
 * - Invalid transitions throw PositionManagerError
 */

import persistence from '../../persistence/index.js';
import { PositionManagerError, PositionManagerErrorCodes } from './types.js';

/**
 * Lifecycle state constants
 */
export const LifecycleState = {
  ENTRY: 'ENTRY',
  MONITORING: 'MONITORING',
  STOP_TRIGGERED: 'STOP_TRIGGERED',
  TP_TRIGGERED: 'TP_TRIGGERED',
  EXPIRY: 'EXPIRY',
  EXIT_PENDING: 'EXIT_PENDING',
  SETTLEMENT: 'SETTLEMENT',
  CLOSED: 'CLOSED',
};

/**
 * Valid state transitions map.
 * Key = current state, Value = set of valid next states.
 */
const VALID_TRANSITIONS = {
  [LifecycleState.ENTRY]: new Set([LifecycleState.MONITORING]),
  [LifecycleState.MONITORING]: new Set([
    LifecycleState.STOP_TRIGGERED,
    LifecycleState.TP_TRIGGERED,
    LifecycleState.EXPIRY,
  ]),
  [LifecycleState.STOP_TRIGGERED]: new Set([LifecycleState.EXIT_PENDING]),
  [LifecycleState.TP_TRIGGERED]: new Set([LifecycleState.EXIT_PENDING]),
  [LifecycleState.EXPIRY]: new Set([LifecycleState.SETTLEMENT]),
  [LifecycleState.EXIT_PENDING]: new Set([LifecycleState.CLOSED]),
  [LifecycleState.SETTLEMENT]: new Set([LifecycleState.CLOSED]),
  [LifecycleState.CLOSED]: new Set(), // terminal state
};

/**
 * States where the position is locked (no modifications allowed)
 */
const LOCKED_STATES = new Set([
  LifecycleState.EXIT_PENDING,
  LifecycleState.SETTLEMENT,
  LifecycleState.CLOSED,
]);

/**
 * Check if a transition is valid
 *
 * @param {string} fromState - Current lifecycle state
 * @param {string} toState - Target lifecycle state
 * @returns {boolean}
 */
export function isValidTransition(fromState, toState) {
  const validTargets = VALID_TRANSITIONS[fromState];
  if (!validTargets) return false;
  return validTargets.has(toState);
}

/**
 * Check if a position is in a locked state (EXIT_PENDING, SETTLEMENT, CLOSED)
 *
 * @param {string} lifecycleState - Current lifecycle state
 * @returns {boolean}
 */
export function isLocked(lifecycleState) {
  return LOCKED_STATES.has(lifecycleState);
}

/**
 * Check if a position should be evaluated for exit conditions
 * Only MONITORING positions should be checked for stop-loss/take-profit/expiry
 *
 * @param {string} lifecycleState - Current lifecycle state
 * @returns {boolean}
 */
export function isMonitoring(lifecycleState) {
  return lifecycleState === LifecycleState.MONITORING;
}

/**
 * Transition a position to a new lifecycle state
 *
 * Validates the transition, updates the database, and logs the event.
 *
 * @param {number} positionId - Position ID
 * @param {string} toState - Target lifecycle state
 * @param {Object} log - Logger instance
 * @param {Object} [context] - Additional context for the log
 * @returns {Promise<Object>} Updated position row
 * @throws {PositionManagerError} If transition is invalid or position not found
 */
export async function transitionState(positionId, toState, log, context = {}) {
  // Get current position state
  const position = await persistence.get(
    'SELECT id, lifecycle_state, status FROM positions WHERE id = $1',
    [positionId]
  );

  if (!position) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_FOUND,
      `Position not found: ${positionId}`,
      { positionId, toState }
    );
  }

  const fromState = position.lifecycle_state || LifecycleState.ENTRY;

  // Validate transition
  if (!isValidTransition(fromState, toState)) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Invalid lifecycle transition: ${fromState} -> ${toState}`,
      { positionId, fromState, toState, ...context }
    );
  }

  // Perform update
  const updated = await persistence.get(
    'UPDATE positions SET lifecycle_state = $1 WHERE id = $2 RETURNING *',
    [toState, positionId]
  );

  if (!updated) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.DATABASE_ERROR,
      `Failed to update lifecycle state for position ${positionId}`,
      { positionId, fromState, toState }
    );
  }

  log.info('lifecycle_transition', {
    positionId,
    from: fromState,
    to: toState,
    timestamp: new Date().toISOString(),
    ...context,
  });

  return updated;
}

/**
 * Evaluate exit conditions for a position.
 *
 * Checks stop-loss, take-profit, and expiry in priority order.
 * Priority: stop-loss > take-profit > expiry
 *
 * Only evaluates positions in MONITORING state.
 *
 * @param {Object} position - Position object with lifecycle_state
 * @param {number} currentPrice - Current market price
 * @param {Object} modules - Module references
 * @param {Object} modules.stopLoss - Stop-loss module (with evaluate function)
 * @param {Object} modules.takeProfit - Take-profit module (with evaluate function)
 * @param {Object} modules.windowExpiry - Window-expiry module (with checkExpiry function)
 * @param {Object} [windowData] - Window resolution data for expiry check
 * @param {Object} [options] - Additional options
 * @returns {Object|null} Exit trigger result or null if no exit needed
 *   { trigger: 'STOP_LOSS'|'TAKE_PROFIT'|'EXPIRY', result: <module result>, lifecycleTarget: <state> }
 */
export function evaluateExit(position, currentPrice, modules, windowData = {}, options = {}) {
  const lifecycleState = position.lifecycle_state || LifecycleState.MONITORING;

  // Only evaluate MONITORING positions
  if (!isMonitoring(lifecycleState)) {
    return null;
  }

  // Priority 1: Stop-loss
  if (modules.stopLoss) {
    try {
      const slResult = modules.stopLoss.evaluate(position, currentPrice);
      if (slResult.triggered) {
        return {
          trigger: 'STOP_LOSS',
          result: slResult,
          lifecycleTarget: LifecycleState.STOP_TRIGGERED,
        };
      }
    } catch {
      // Stop-loss evaluation failed - continue to next check
    }
  }

  // Priority 2: Take-profit
  if (modules.takeProfit) {
    try {
      const tpResult = modules.takeProfit.evaluate(position, currentPrice);
      if (tpResult.triggered) {
        return {
          trigger: 'TAKE_PROFIT',
          result: tpResult,
          lifecycleTarget: LifecycleState.TP_TRIGGERED,
        };
      }
    } catch {
      // Take-profit evaluation failed - continue to next check
    }
  }

  // Priority 3: Window expiry
  if (modules.windowExpiry) {
    try {
      const expiryResult = modules.windowExpiry.checkExpiry(position, windowData, options);
      if (expiryResult.is_resolved) {
        return {
          trigger: 'EXPIRY',
          result: expiryResult,
          lifecycleTarget: LifecycleState.EXPIRY,
        };
      }
    } catch {
      // Window expiry evaluation failed
    }
  }

  return null;
}
