/**
 * Typed error classes for poly trading system
 *
 * All errors include:
 * - code: Machine-readable error code (UPPER_SNAKE_CASE)
 * - message: Human-readable description
 * - context: Additional context for debugging
 */

/**
 * Base error class for all poly errors
 */
export class PolyError extends Error {
  /**
   * @param {string} code - Error code (e.g., 'POSITION_LIMIT_EXCEEDED')
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to structured log format
   * @returns {Object} Structured error object
   */
  toLogFormat() {
    return {
      error_code: this.code,
      error_message: this.message,
      error_context: this.context,
      error_timestamp: this.timestamp,
      error_stack: this.stack,
    };
  }
}

/**
 * Position-related errors
 */
export class PositionError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Order-related errors
 */
export class OrderError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Configuration errors
 */
export class ConfigError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * State/persistence errors
 */
export class StateError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * API/integration errors
 */
export class ApiError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Safety/risk limit errors
 */
export class SafetyError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Persistence/database errors
 */
export class PersistenceError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

/**
 * Intent/write-ahead logging errors
 */
export class IntentError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

// Common error codes
export const ErrorCodes = {
  // Position errors
  POSITION_LIMIT_EXCEEDED: 'POSITION_LIMIT_EXCEEDED',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  POSITION_ALREADY_CLOSED: 'POSITION_ALREADY_CLOSED',
  POSITION_RECONCILIATION_FAILED: 'POSITION_RECONCILIATION_FAILED',

  // Order errors
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_TIMEOUT: 'ORDER_TIMEOUT',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',

  // Config errors
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_MISSING: 'CONFIG_MISSING',
  CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',

  // State errors
  STATE_DIVERGENCE: 'STATE_DIVERGENCE',
  STATE_RECOVERY_FAILED: 'STATE_RECOVERY_FAILED',
  INTENT_INCOMPLETE: 'INTENT_INCOMPLETE',
  DATABASE_ERROR: 'DATABASE_ERROR',

  // API errors
  API_CONNECTION_FAILED: 'API_CONNECTION_FAILED',
  API_RATE_LIMITED: 'API_RATE_LIMITED',
  API_RESPONSE_INVALID: 'API_RESPONSE_INVALID',
  API_TIMEOUT: 'API_TIMEOUT',

  // Safety errors
  EXPOSURE_LIMIT_EXCEEDED: 'EXPOSURE_LIMIT_EXCEEDED',
  DRAWDOWN_LIMIT_EXCEEDED: 'DRAWDOWN_LIMIT_EXCEEDED',
  KILL_SWITCH_ACTIVATED: 'KILL_SWITCH_ACTIVATED',

  // Persistence/database errors
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  DB_SCHEMA_ERROR: 'DB_SCHEMA_ERROR',
  DB_NOT_INITIALIZED: 'DB_NOT_INITIALIZED',
  DB_MIGRATION_FAILED: 'DB_MIGRATION_FAILED',

  // Intent/write-ahead logging errors
  INVALID_INTENT_TYPE: 'INVALID_INTENT_TYPE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  INTENT_NOT_FOUND: 'INTENT_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',

  // Circuit breaker errors (V3 Stage 5)
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_TRIP: 'CIRCUIT_BREAKER_TRIP',
  CIRCUIT_BREAKER_RESET_BLOCKED: 'CIRCUIT_BREAKER_RESET_BLOCKED',
  POSITION_VERIFICATION_FAILED: 'POSITION_VERIFICATION_FAILED',
  HALT_ON_UNCERTAINTY: 'HALT_ON_UNCERTAINTY',
};
