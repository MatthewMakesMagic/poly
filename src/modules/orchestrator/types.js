/**
 * Orchestrator Module Type Definitions
 *
 * Error classes, codes, and type definitions for the orchestrator module.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Orchestrator-specific error class
 */
export class OrchestratorError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OrchestratorError';
  }
}

/**
 * Orchestrator error codes
 */
export const OrchestratorErrorCodes = {
  NOT_INITIALIZED: 'ORCHESTRATOR_NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'ORCHESTRATOR_ALREADY_INITIALIZED',
  MODULE_INIT_FAILED: 'MODULE_INIT_FAILED',
  MODULE_INIT_TIMEOUT: 'MODULE_INIT_TIMEOUT',
  MODULE_SHUTDOWN_FAILED: 'MODULE_SHUTDOWN_FAILED',
  MODULE_SHUTDOWN_TIMEOUT: 'MODULE_SHUTDOWN_TIMEOUT',
  LOOP_ERROR: 'EXECUTION_LOOP_ERROR',
  FATAL_ERROR: 'ORCHESTRATOR_FATAL_ERROR',
  INVALID_STATE: 'ORCHESTRATOR_INVALID_STATE',
};

/**
 * Error categories for classification
 */
export const ErrorCategory = {
  RECOVERABLE: 'recoverable', // Retry with backoff
  FATAL: 'fatal', // Trigger shutdown
};

/**
 * Error codes that are considered fatal (require shutdown)
 */
const FATAL_ERROR_CODES = [
  'AUTH_FAILED',
  'DATABASE_CORRUPTED',
  'CONFIG_INVALID',
  'PERSISTENCE_INIT_FAILED',
  'DB_CONNECTION_FAILED',
  'DB_SCHEMA_ERROR',
  'CREDENTIALS_MISSING',
  OrchestratorErrorCodes.FATAL_ERROR,
];

/**
 * Error codes that are recoverable (can retry)
 */
const RECOVERABLE_ERROR_CODES = [
  'API_TIMEOUT',
  'RATE_LIMIT',
  'API_RATE_LIMITED',
  'CONNECTION_LOST',
  'SPOT_DISCONNECTED',
  'API_CONNECTION_FAILED',
  'NOT_INITIALIZED',
];

/**
 * Categorize an error as recoverable or fatal
 *
 * @param {Error} error - Error to categorize
 * @returns {string} ErrorCategory.RECOVERABLE or ErrorCategory.FATAL
 */
export function categorizeError(error) {
  const code = error.code || '';

  if (FATAL_ERROR_CODES.includes(code)) {
    return ErrorCategory.FATAL;
  }

  if (RECOVERABLE_ERROR_CODES.includes(code)) {
    return ErrorCategory.RECOVERABLE;
  }

  // Default: treat unknown errors as recoverable to avoid unnecessary shutdowns
  return ErrorCategory.RECOVERABLE;
}

/**
 * Orchestrator state values
 */
export const OrchestratorState = {
  STOPPED: 'stopped',
  INITIALIZING: 'initializing',
  INITIALIZED: 'initialized',
  RUNNING: 'running',
  PAUSED: 'paused',
  SHUTTING_DOWN: 'shutting_down',
  ERROR: 'error',
};

/**
 * Execution loop state values
 */
export const LoopState = {
  STOPPED: 'stopped',
  RUNNING: 'running',
  PAUSED: 'paused',
};
