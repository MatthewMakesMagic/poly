/**
 * Circuit Breaker Types
 *
 * V3 Stage 5: Circuit Breaker + Verify-Before-Act
 */

import { PolyError } from '../../types/errors.js';

/**
 * Circuit breaker specific error
 */
export class CircuitBreakerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Circuit breaker states
 */
export const CBState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
};

/**
 * Reasons for tripping the circuit breaker
 */
export const TripReason = {
  STOP_LOSS_BLIND: 'STOP_LOSS_BLIND',
  TAKE_PROFIT_BLIND: 'TAKE_PROFIT_BLIND',
  POSITION_TRACKING_FAILED: 'POSITION_TRACKING_FAILED',
  VERIFICATION_RATE_LIMITED: 'VERIFICATION_RATE_LIMITED',
  DATA_CAPTURE_UNRECOVERABLE: 'DATA_CAPTURE_UNRECOVERABLE',
  SERIALIZATION_CONFLICT: 'SERIALIZATION_CONFLICT',
  MANUAL_TRIP: 'MANUAL_TRIP',
  STARTUP_RECONCILIATION_FAILED: 'STARTUP_RECONCILIATION_FAILED',
  ASSERTION_FAILURE: 'assertion_failure',
};

/**
 * Escalation stages for open circuit breaker
 */
export const EscalationStage = {
  MONITORING: 'monitoring',
  ALERT: 'alert',
  CANCEL_ORDERS: 'cancel_orders',
  SHUTDOWN: 'shutdown',
};

/**
 * Circuit breaker error codes
 */
export const CBErrorCodes = {
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_TRIP: 'CIRCUIT_BREAKER_TRIP',
  CIRCUIT_BREAKER_RESET_BLOCKED: 'CIRCUIT_BREAKER_RESET_BLOCKED',
  CB_NOT_INITIALIZED: 'CB_NOT_INITIALIZED',
  CB_QUERY_FAILED: 'CB_QUERY_FAILED',
};
