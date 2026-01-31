/**
 * Exit Component Template
 *
 * Standard interface for exit strategy components.
 * Exit components determine when to exit a position (stop-loss, take-profit, expiry).
 *
 * Copy this file to create a new exit component:
 *   cp _template.js my-exit.js
 *
 * Then update:
 * - metadata.name to your component name (kebab-case)
 * - metadata.version to 1
 * - metadata.description to describe your logic
 * - evaluate() to implement your exit logic
 * - validateConfig() to validate your configuration
 */

/**
 * Component metadata - REQUIRED
 *
 * @property {string} name - Component name in kebab-case
 * @property {number} version - Semantic version number
 * @property {string} type - Must be 'exit'
 * @property {string} description - Human-readable description
 * @property {string} [author] - Component author
 * @property {string} [createdAt] - ISO date of creation
 */
export const metadata = {
  name: 'template',
  version: 1,
  type: 'exit',
  description: 'Template exit component for strategy composition',
  author: 'BMAD',
  createdAt: '2026-01-31',
};

/**
 * Evaluate exit conditions
 *
 * @param {Object} context - Market and position context
 * @param {number} context.spotPrice - Current spot price
 * @param {number} context.entryPrice - Position entry price
 * @param {number} context.positionSize - Current position size
 * @param {string} context.side - Position side ('long' or 'short')
 * @param {number} context.unrealizedPnl - Unrealized profit/loss
 * @param {number} context.timeToExpiry - Time to window expiry (ms)
 * @param {Object} [context.marketData] - Additional market data
 * @param {Object} config - Component-specific configuration
 * @returns {Object} Exit evaluation result
 * @returns {boolean} result.shouldExit - Whether to exit the position
 * @returns {string} result.reason - Exit reason ('stop_loss', 'take_profit', 'window_expiry', 'manual')
 * @returns {number} [result.targetPrice] - Target exit price
 * @returns {Object} [result.details] - Additional calculation details
 */
export function evaluate(context, config) {
  // Template implementation - never exits
  return {
    shouldExit: false,
    reason: 'hold',
    details: {
      reason: 'Template component - implement your logic',
    },
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result
 * @returns {boolean} result.valid - Whether config is valid
 * @returns {string[]} [result.errors] - Validation error messages
 */
export function validateConfig(config) {
  // Template accepts any config
  return { valid: true };
}
