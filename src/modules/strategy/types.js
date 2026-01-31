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
  // Story 6.2: Strategy Composition error codes
  COMPONENT_EXECUTION_FAILED: 'COMPONENT_EXECUTION_FAILED',
  INVALID_COMPONENT_OUTPUT: 'INVALID_COMPONENT_OUTPUT',
  STRATEGY_VALIDATION_FAILED: 'STRATEGY_VALIDATION_FAILED',
  CONFIG_VALIDATION_FAILED: 'CONFIG_VALIDATION_FAILED',
  // Story 6.3: Strategy Forking error codes
  FORK_PARENT_NOT_FOUND: 'FORK_PARENT_NOT_FOUND',
  FORK_PARENT_INACTIVE: 'FORK_PARENT_INACTIVE',
  INVALID_FORK_MODIFICATION: 'INVALID_FORK_MODIFICATION',
  // Story 6.4: Central Component Updates error codes
  COMPONENT_VERSION_EXISTS: 'COMPONENT_VERSION_EXISTS',
  UPGRADE_VALIDATION_FAILED: 'UPGRADE_VALIDATION_FAILED',
  COMPONENT_UPGRADE_FAILED: 'COMPONENT_UPGRADE_FAILED',
  // Story 6.5: Strategy Configuration error codes
  CONFIG_UPDATE_FAILED: 'CONFIG_UPDATE_FAILED',
  CONFIG_MERGE_FAILED: 'CONFIG_MERGE_FAILED',
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
