/**
 * Entry Component Template
 *
 * Standard interface for entry strategy components.
 * Entry components determine when to enter a position.
 *
 * Copy this file to create a new entry component:
 *   cp _template.js my-entry.js
 *
 * Then update:
 * - metadata.name to your component name (kebab-case)
 * - metadata.version to 1
 * - metadata.description to describe your logic
 * - evaluate() to implement your entry logic
 * - validateConfig() to validate your configuration
 */

/**
 * Component metadata - REQUIRED
 *
 * @property {string} name - Component name in kebab-case
 * @property {number} version - Semantic version number
 * @property {string} type - Must be 'entry'
 * @property {string} description - Human-readable description
 * @property {string} [author] - Component author
 * @property {string} [createdAt] - ISO date of creation
 */
export const metadata = {
  name: 'template',
  version: 1,
  type: 'entry',
  description: 'Template entry component for strategy composition',
  author: 'BMAD',
  createdAt: '2026-01-31',
};

/**
 * Evaluate entry conditions
 *
 * @param {Object} context - Market and strategy context
 * @param {number} context.spotPrice - Current spot price
 * @param {number} context.targetPrice - Target price for the window
 * @param {number} context.probability - Calculated probability from probability component
 * @param {number} context.timeToExpiry - Time to window expiry (ms)
 * @param {Object} [context.marketData] - Additional market data (bid, ask, spread)
 * @param {Object} config - Component-specific configuration
 * @returns {Object} Entry evaluation result
 * @returns {boolean} result.shouldEnter - Whether to enter the position
 * @returns {string} result.side - Position side ('long' or 'short')
 * @returns {number} [result.targetPrice] - Target entry price
 * @returns {Object} [result.details] - Additional calculation details
 */
export function evaluate(context, config) {
  // Template implementation - never enters
  return {
    shouldEnter: false,
    side: 'long',
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
