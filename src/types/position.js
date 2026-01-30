/**
 * Position type definitions for poly trading system
 *
 * Defines the structure of position data used throughout the system.
 */

/**
 * Position status values
 * @readonly
 * @enum {string}
 */
export const PositionStatus = {
  OPEN: 'open',
  CLOSED: 'closed',
  LIQUIDATED: 'liquidated',
};

/**
 * Position side values
 * @readonly
 * @enum {string}
 */
export const PositionSide = {
  LONG: 'long',
  SHORT: 'short',
};

/**
 * Create a new position object
 * @param {Object} params - Position parameters
 * @param {string} params.windowId - Trading window identifier
 * @param {string} params.marketId - Polymarket market identifier
 * @param {string} params.tokenId - YES or NO token identifier
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.size - Position size in tokens
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.strategyId - Strategy that opened this position
 * @returns {Object} Position object
 */
export function createPosition({
  windowId,
  marketId,
  tokenId,
  side,
  size,
  entryPrice,
  strategyId,
}) {
  return {
    id: null,  // Set by database
    window_id: windowId,
    market_id: marketId,
    token_id: tokenId,
    side,
    size,
    entry_price: entryPrice,
    current_price: entryPrice,
    status: PositionStatus.OPEN,
    strategy_id: strategyId,
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_price: null,
    pnl: null,
    exchange_verified_at: null,
  };
}

/**
 * Calculate unrealized P&L for a position
 * @param {Object} position - Position object
 * @returns {number} Unrealized P&L
 */
export function calculateUnrealizedPnl(position) {
  if (position.status !== PositionStatus.OPEN) {
    return position.pnl || 0;
  }

  const priceDiff = position.current_price - position.entry_price;
  const multiplier = position.side === PositionSide.LONG ? 1 : -1;

  return priceDiff * position.size * multiplier;
}

/**
 * Validate a position object has required fields
 * @param {Object} position - Position to validate
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
export function validatePosition(position) {
  const required = ['window_id', 'market_id', 'token_id', 'side', 'size', 'entry_price', 'strategy_id'];

  for (const field of required) {
    if (position[field] === undefined || position[field] === null) {
      throw new Error(`Position missing required field: ${field}`);
    }
  }

  if (!Object.values(PositionSide).includes(position.side)) {
    throw new Error(`Invalid position side: ${position.side}`);
  }

  if (position.size <= 0) {
    throw new Error('Position size must be positive');
  }

  return true;
}
