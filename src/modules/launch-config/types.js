/**
 * Launch Config Types
 *
 * Error types and constants for the launch-config module.
 *
 * @module modules/launch-config/types
 */

/**
 * Error codes for launch-config operations
 */
export const LaunchConfigErrorCodes = {
  MANIFEST_NOT_FOUND: 'MANIFEST_NOT_FOUND',
  INVALID_MANIFEST_SCHEMA: 'INVALID_MANIFEST_SCHEMA',
  UNKNOWN_STRATEGY: 'UNKNOWN_STRATEGY',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  ALREADY_INITIALIZED: 'ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  WRITE_FAILED: 'WRITE_FAILED',
};

/**
 * Custom error class for launch-config operations
 */
export class LaunchConfigError extends Error {
  /**
   * @param {string} code - Error code from LaunchConfigErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'LaunchConfigError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Known strategy definitions
 *
 * Each entry includes:
 * - name: Strategy identifier (used in launch.json)
 * - description: Human-readable description
 * - dependencies: Epic requirements for this strategy
 */
export const KNOWN_STRATEGIES = [
  {
    name: 'simple-threshold',
    description: '70% token price threshold entry',
    dependencies: ['Epic 3'],
  },
  {
    name: 'oracle-edge',
    description: 'Pure staleness fade',
    dependencies: ['Epic 7'],
  },
  {
    name: 'probability-model',
    description: 'Black-Scholes with oracle spot',
    dependencies: ['Epic 7'],
  },
  {
    name: 'lag-based',
    description: 'Cross-correlation signals',
    dependencies: ['Epic 7'],
  },
  {
    name: 'hybrid',
    description: 'Weighted combination',
    dependencies: ['Epic 7'],
  },
];

/**
 * Get array of known strategy names
 *
 * @returns {string[]} Array of valid strategy names
 */
export function getKnownStrategyNames() {
  return KNOWN_STRATEGIES.map((s) => s.name);
}

/**
 * Default values for launch manifest fields
 */
export const MANIFEST_DEFAULTS = {
  strategies: ['simple-threshold'],
  position_size_dollars: 10,
  max_exposure_dollars: 500,
  symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
  kill_switch_enabled: true,
};

/**
 * Maximum allowed values for safety limits
 */
export const MANIFEST_LIMITS = {
  maxPositionSizeDollars: 10000,
  maxExposureDollars: 100000,
  maxStrategies: 10,
  maxSymbols: 20,
};

/**
 * JSON Schema for launch manifest validation
 */
export const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['strategies', 'position_size_dollars', 'max_exposure_dollars', 'symbols', 'kill_switch_enabled'],
  properties: {
    strategies: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: MANIFEST_LIMITS.maxStrategies,
      description: 'Array of strategy names to activate',
    },
    position_size_dollars: {
      type: 'number',
      minimum: 1,
      maximum: MANIFEST_LIMITS.maxPositionSizeDollars,
      description: 'Base position size in dollars',
    },
    max_exposure_dollars: {
      type: 'number',
      minimum: 1,
      maximum: MANIFEST_LIMITS.maxExposureDollars,
      description: 'Maximum total exposure in dollars',
    },
    symbols: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: MANIFEST_LIMITS.maxSymbols,
      description: 'Array of trading symbols',
    },
    kill_switch_enabled: {
      type: 'boolean',
      description: 'Whether kill switch watchdog is enabled',
    },
  },
  additionalProperties: false,
};
