/**
 * Position Manager Business Logic
 *
 * Core position lifecycle management:
 * - Position creation with write-ahead logging
 * - Position tracking and price updates
 * - Database persistence
 */

import persistence from '../../persistence/index.js';
import * as writeAhead from '../../persistence/write-ahead.js';
import {
  PositionManagerError,
  PositionManagerErrorCodes,
  PositionStatus,
  Side,
} from './types.js';
import {
  cachePosition,
  getCachedPosition,
  updateCachedPosition,
  getCachedOpenPositions,
  loadPositionsIntoCache,
} from './state.js';

/**
 * Validate position parameters
 * @param {Object} params - Position parameters
 * @throws {PositionManagerError} If validation fails
 */
function validatePositionParams(params) {
  const { windowId, marketId, tokenId, side, size, entryPrice, strategyId } = params;

  const errors = [];

  if (!windowId || typeof windowId !== 'string') {
    errors.push('windowId is required and must be a string');
  }

  if (!marketId || typeof marketId !== 'string') {
    errors.push('marketId is required and must be a string');
  }

  if (!tokenId || typeof tokenId !== 'string') {
    errors.push('tokenId is required and must be a string');
  }

  if (!side || ![Side.LONG, Side.SHORT].includes(side)) {
    errors.push(`side must be '${Side.LONG}' or '${Side.SHORT}'`);
  }

  if (typeof size !== 'number' || size <= 0) {
    errors.push('size must be a positive number');
  }

  if (typeof entryPrice !== 'number' || entryPrice <= 0) {
    errors.push('entryPrice must be a positive number');
  }

  if (!strategyId || typeof strategyId !== 'string') {
    errors.push('strategyId is required and must be a string');
  }

  if (errors.length > 0) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.VALIDATION_FAILED,
      `Position validation failed: ${errors.join(', ')}`,
      { params, errors }
    );
  }
}

/**
 * Calculate unrealized P&L for a position
 * @param {Object} position - Position object
 * @returns {number} Unrealized P&L
 */
export function calculateUnrealizedPnl(position) {
  if (!position.current_price) return 0;
  const priceDiff = position.current_price - position.entry_price;
  const direction = position.side === Side.LONG ? 1 : -1;
  return priceDiff * position.size * direction;
}

/**
 * Add a new position with write-ahead logging
 *
 * @param {Object} params - Position parameters
 * @param {string} params.windowId - Window ID
 * @param {string} params.marketId - Market ID
 * @param {string} params.tokenId - Token ID
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.size - Position size
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.strategyId - Strategy ID
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Created position with id
 */
export async function addPosition(params, log) {
  const { windowId, marketId, tokenId, side, size, entryPrice, strategyId } = params;

  // 1. Validate parameters
  validatePositionParams(params);

  // 2. Log intent BEFORE any action
  const intentPayload = {
    windowId,
    marketId,
    tokenId,
    side,
    size,
    entryPrice,
    strategyId,
    requestedAt: new Date().toISOString(),
  };

  const intentId = writeAhead.logIntent(
    writeAhead.INTENT_TYPES.OPEN_POSITION,
    windowId,
    intentPayload
  );

  log.info('position_intent_logged', { intentId, windowId, marketId, tokenId, side, size });

  // 3. Mark intent as executing
  writeAhead.markExecuting(intentId);

  try {
    const openedAt = new Date().toISOString();

    // 4. Insert to database
    const result = persistence.run(
      `INSERT INTO positions (
        window_id, market_id, token_id, side, size, entry_price,
        current_price, status, strategy_id, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        windowId,
        marketId,
        tokenId,
        side,
        size,
        entryPrice,
        entryPrice, // current_price starts as entry_price
        PositionStatus.OPEN,
        strategyId,
        openedAt,
      ]
    );

    const positionId = Number(result.lastInsertRowid);

    // 5. Build position record
    const positionRecord = {
      id: positionId,
      window_id: windowId,
      market_id: marketId,
      token_id: tokenId,
      side,
      size,
      entry_price: entryPrice,
      current_price: entryPrice,
      status: PositionStatus.OPEN,
      strategy_id: strategyId,
      opened_at: openedAt,
      closed_at: null,
      close_price: null,
      pnl: null,
      exchange_verified_at: null,
    };

    // 6. Cache the position
    cachePosition(positionRecord);

    // 7. Mark intent completed
    writeAhead.markCompleted(intentId, { positionId });

    log.info('position_created', {
      positionId,
      windowId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
    });

    return positionRecord;
  } catch (err) {
    // Handle duplicate position error
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      writeAhead.markFailed(intentId, {
        code: PositionManagerErrorCodes.DUPLICATE_POSITION,
        message: 'Position already exists for this window/market/token combination',
      });

      throw new PositionManagerError(
        PositionManagerErrorCodes.DUPLICATE_POSITION,
        `Position already exists for window ${windowId}, market ${marketId}, token ${tokenId}`,
        { windowId, marketId, tokenId }
      );
    }

    // Mark intent as failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'UNKNOWN',
      message: err.message,
      context: err.context,
    });

    log.error('position_creation_failed', {
      intentId,
      error: err.message,
      code: err.code,
    });

    throw new PositionManagerError(
      PositionManagerErrorCodes.DATABASE_ERROR,
      `Position creation failed: ${err.message}`,
      {
        intentId,
        originalError: err.message,
        params,
      }
    );
  }
}

/**
 * Get a position by ID with unrealized P&L
 *
 * @param {number} positionId - Position ID
 * @returns {Object|undefined} Position with unrealized_pnl or undefined
 */
export function getPosition(positionId) {
  // Try cache first
  let position = getCachedPosition(positionId);

  if (!position) {
    // Fall back to database
    const dbPosition = persistence.get(
      'SELECT * FROM positions WHERE id = ?',
      [positionId]
    );

    if (dbPosition) {
      // Add to cache
      cachePosition(dbPosition);
      position = dbPosition;
    }
  }

  if (!position) {
    return undefined;
  }

  // Calculate and add unrealized P&L
  return {
    ...position,
    unrealized_pnl: calculateUnrealizedPnl(position),
  };
}

/**
 * Get all open positions
 *
 * @returns {Object[]} Array of open positions with unrealized_pnl
 */
export function getPositions() {
  // Sync cache from database to ensure consistency
  const dbPositions = persistence.all(
    'SELECT * FROM positions WHERE status = ?',
    [PositionStatus.OPEN]
  );

  // Update cache with database state
  loadPositionsIntoCache(dbPositions);

  // Return from cache with unrealized P&L
  return getCachedOpenPositions().map((position) => ({
    ...position,
    unrealized_pnl: calculateUnrealizedPnl(position),
  }));
}

/**
 * Update the current price for a position
 *
 * @param {number} positionId - Position ID
 * @param {number} newPrice - New current price
 * @param {Object} log - Logger instance
 * @returns {Object} Updated position with unrealized_pnl
 * @throws {PositionManagerError} If position not found
 */
export function updatePrice(positionId, newPrice, log) {
  const position = getCachedPosition(positionId);

  if (!position) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_FOUND,
      `Position not found: ${positionId}`,
      { positionId }
    );
  }

  // Update in cache (in-memory update, persisted periodically)
  const updated = updateCachedPosition(positionId, { current_price: newPrice });

  log.info('position_price_updated', {
    positionId,
    previousPrice: position.current_price,
    newPrice,
    unrealizedPnl: calculateUnrealizedPnl(updated),
  });

  return {
    ...updated,
    unrealized_pnl: calculateUnrealizedPnl(updated),
  };
}

/**
 * Load positions from database into cache on module init
 *
 * @param {Object} log - Logger instance
 */
export function loadPositionsFromDb(log) {
  // Load open positions into cache
  const openPositions = persistence.all(
    'SELECT * FROM positions WHERE status = ?',
    [PositionStatus.OPEN]
  );

  loadPositionsIntoCache(openPositions);
  log.info('positions_loaded_to_cache', { count: openPositions.length });
}
