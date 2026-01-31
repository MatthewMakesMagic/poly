/**
 * Probability Component Template
 *
 * Standard interface for probability strategy components.
 * Probability components evaluate the likelihood of a successful trade.
 *
 * Copy this file to create a new probability component:
 *   cp _template.js my-probability.js
 *
 * Then update:
 * - metadata.name to your component name (kebab-case)
 * - metadata.version to 1
 * - metadata.description to describe your logic
 * - evaluate() to implement your probability calculation
 * - validateConfig() to validate your configuration
 */

/**
 * Component metadata - REQUIRED
 *
 * @property {string} name - Component name in kebab-case
 * @property {number} version - Semantic version number
 * @property {string} type - Must be 'probability'
 * @property {string} description - Human-readable description
 * @property {string} [author] - Component author
 * @property {string} [createdAt] - ISO date of creation
 */
export const metadata = {
  name: 'template',
  version: 1,
  type: 'probability',
  description: 'Template probability component for strategy composition',
  author: 'BMAD',
  createdAt: '2026-01-31',
};

/**
 * Evaluate the probability of a successful trade
 *
 * @param {Object} context - Market and strategy context
 * @param {number} context.spotPrice - Current spot price
 * @param {number} context.targetPrice - Target price for the window
 * @param {number} context.timeToExpiry - Time to window expiry (ms)
 * @param {Object} [context.marketData] - Additional market data
 * @param {Object} config - Component-specific configuration
 * @returns {Object} Probability result
 * @returns {number} result.probability - Probability value (0-1)
 * @returns {string} result.signal - Signal type ('entry', 'exit', 'hold')
 * @returns {Object} [result.details] - Additional calculation details
 */
export function evaluate(context, config) {
  // Template implementation - always returns neutral probability
  return {
    probability: 0.5,
    signal: 'hold',
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
