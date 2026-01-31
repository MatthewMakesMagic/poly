/**
 * Sizing Component Template
 *
 * Standard interface for position sizing strategy components.
 * Sizing components determine the position size based on risk, liquidity, and account limits.
 *
 * Copy this file to create a new sizing component:
 *   cp _template.js my-sizing.js
 *
 * Then update:
 * - metadata.name to your component name (kebab-case)
 * - metadata.version to 1
 * - metadata.description to describe your logic
 * - evaluate() to implement your sizing logic
 * - validateConfig() to validate your configuration
 */

/**
 * Component metadata - REQUIRED
 *
 * @property {string} name - Component name in kebab-case
 * @property {number} version - Semantic version number
 * @property {string} type - Must be 'sizing'
 * @property {string} description - Human-readable description
 * @property {string} [author] - Component author
 * @property {string} [createdAt] - ISO date of creation
 */
export const metadata = {
  name: 'template',
  version: 1,
  type: 'sizing',
  description: 'Template sizing component for strategy composition',
  author: 'BMAD',
  createdAt: '2026-01-31',
};

/**
 * Evaluate position size
 *
 * @param {Object} context - Market and account context
 * @param {number} context.spotPrice - Current spot price
 * @param {number} context.probability - Calculated probability from probability component
 * @param {number} context.accountBalance - Available account balance
 * @param {number} context.maxPositionSize - Maximum allowed position size
 * @param {number} context.availableLiquidity - Available liquidity at current price
 * @param {number} [context.currentExposure] - Current total exposure
 * @param {Object} [context.marketData] - Additional market data (bid, ask, depth)
 * @param {Object} config - Component-specific configuration
 * @returns {Object} Sizing evaluation result
 * @returns {number} result.size - Recommended position size
 * @returns {number} result.maxSize - Maximum safe position size given liquidity
 * @returns {boolean} result.liquidityOk - Whether liquidity is sufficient
 * @returns {Object} [result.details] - Additional calculation details
 */
export function evaluate(context, config) {
  // Template implementation - returns minimum safe size
  const defaultSize = Math.min(
    context.maxPositionSize || 100,
    context.availableLiquidity || 100
  ) * 0.1; // 10% of max

  return {
    size: defaultSize,
    maxSize: context.maxPositionSize || 100,
    liquidityOk: true,
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
