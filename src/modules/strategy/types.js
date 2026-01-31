/**
 * Strategy Module Type Definitions
 *
 * Error codes, constants, and type definitions for the strategy registry module.
 */

import { PolyError } from '../../types/index.js';

/**
 * Component types supported by the registry
 */
export const ComponentType = {
  PROBABILITY: 'probability',
  ENTRY: 'entry',
  EXIT: 'exit',
  SIZING: 'sizing',
};

/**
 * Type prefix mapping for version ID generation
 */
export const TypePrefix = {
  [ComponentType.PROBABILITY]: 'prob',
  [ComponentType.ENTRY]: 'entry',
  [ComponentType.EXIT]: 'exit',
  [ComponentType.SIZING]: 'sizing',
};

/**
 * Strategy error codes
 */
export const StrategyErrorCodes = {
  ALREADY_INITIALIZED: 'STRATEGY_ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'STRATEGY_NOT_INITIALIZED',
  INVALID_COMPONENT_TYPE: 'INVALID_COMPONENT_TYPE',
  COMPONENT_NOT_FOUND: 'COMPONENT_NOT_FOUND',
  STRATEGY_NOT_FOUND: 'STRATEGY_NOT_FOUND',
  DUPLICATE_VERSION_ID: 'DUPLICATE_VERSION_ID',
  INVALID_COMPONENT_INTERFACE: 'INVALID_COMPONENT_INTERFACE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  DATABASE_ERROR: 'STRATEGY_DATABASE_ERROR',
  DISCOVERY_ERROR: 'COMPONENT_DISCOVERY_ERROR',
};

/**
 * Custom error class for strategy module errors
 */
export class StrategyError extends PolyError {
  /**
   * @param {string} code - Error code from StrategyErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StrategyError';
  }
}
