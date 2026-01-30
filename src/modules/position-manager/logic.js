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
  calculateTotalExposure,
  countPositionsByMarket,
  setLastReconciliation,
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
 * Check if a new position would exceed configured limits
 *
 * @param {Object} params - Position parameters
 * @param {number} params.size - Position size
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.marketId - Market ID
 * @param {Object} riskConfig - Risk configuration
 * @param {number} riskConfig.maxPositionSize - Maximum size per single position
 * @param {number} riskConfig.maxExposure - Maximum total exposure
 * @param {number} riskConfig.positionLimitPerMarket - Maximum positions per market
 * @returns {{ allowed: boolean, reason?: string, limit?: string }}
 */
export function checkLimits(params, riskConfig) {
  const { size, entryPrice, marketId } = params;
  const { maxPositionSize, maxExposure, positionLimitPerMarket } = riskConfig;

  // Check 1: Position size limit
  if (size > maxPositionSize) {
    return {
      allowed: false,
      reason: `Position size ${size} exceeds maximum ${maxPositionSize}`,
      limit: 'maxPositionSize',
    };
  }

  // Check 2: Total exposure limit
  const currentExposure = calculateTotalExposure();
  const newPositionExposure = size * entryPrice;
  const newTotalExposure = currentExposure + newPositionExposure;
  if (newTotalExposure > maxExposure) {
    return {
      allowed: false,
      reason: `Total exposure would be ${newTotalExposure.toFixed(2)}, exceeding maximum ${maxExposure}`,
      limit: 'maxExposure',
    };
  }

  // Check 3: Positions per market limit
  const marketPositions = countPositionsByMarket(marketId);
  if (marketPositions >= positionLimitPerMarket) {
    return {
      allowed: false,
      reason: `Market ${marketId} already has ${marketPositions} positions, limit is ${positionLimitPerMarket}`,
      limit: 'positionLimitPerMarket',
    };
  }

  return { allowed: true };
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
 * @param {Object} [riskConfig] - Optional risk configuration for limit checking
 * @returns {Promise<Object>} Created position with id
 */
export async function addPosition(params, log, riskConfig = null) {
  const { windowId, marketId, tokenId, side, size, entryPrice, strategyId } = params;

  // 1. Validate parameters
  validatePositionParams(params);

  // 2. Check limits if riskConfig provided
  if (riskConfig) {
    const limitCheck = checkLimits(params, riskConfig);
    if (!limitCheck.allowed) {
      throw new PositionManagerError(
        PositionManagerErrorCodes.POSITION_LIMIT_EXCEEDED,
        limitCheck.reason,
        {
          limit: limitCheck.limit,
          params: { size, entryPrice, marketId },
        }
      );
    }
  }

  // 3. Log intent BEFORE any action
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

  // 4. Mark intent as executing
  writeAhead.markExecuting(intentId);

  try {
    const openedAt = new Date().toISOString();

    // 5. Insert to database
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

    // 6. Build position record
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

    // 7. Cache the position
    cachePosition(positionRecord);

    // 8. Mark intent completed
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

/**
 * Close a position with write-ahead logging
 *
 * @param {number} positionId - Position ID
 * @param {Object} params - Close parameters
 * @param {boolean} [params.emergency=false] - Use market order for emergency close
 * @param {number} [params.closePrice] - Override close price (optional)
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Closed position with pnl
 * @throws {PositionManagerError} If position not found or invalid status
 */
export async function closePosition(positionId, params, log) {
  const { emergency = false, closePrice } = params;
  const position = getCachedPosition(positionId);

  // Validate position exists
  if (!position) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_FOUND,
      `Position not found: ${positionId}`,
      { positionId }
    );
  }

  // Validate position is open
  if (position.status !== PositionStatus.OPEN) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Cannot close position with status: ${position.status}`,
      { positionId, currentStatus: position.status }
    );
  }

  // 1. Log intent BEFORE any action
  const intentPayload = {
    positionId,
    windowId: position.window_id,
    marketId: position.market_id,
    tokenId: position.token_id,
    size: position.size,
    entryPrice: position.entry_price,
    emergency,
    requestedAt: new Date().toISOString(),
  };

  const intentId = writeAhead.logIntent(
    writeAhead.INTENT_TYPES.CLOSE_POSITION,
    position.window_id,
    intentPayload
  );

  if (emergency) {
    log.warn('position_emergency_close_started', { intentId, positionId });
  } else {
    log.info('position_close_started', { intentId, positionId });
  }

  // 2. Mark intent as executing
  writeAhead.markExecuting(intentId);

  try {
    const closedAt = new Date().toISOString();
    const actualClosePrice = closePrice || position.current_price;

    // Calculate P&L
    const priceDiff = actualClosePrice - position.entry_price;
    const direction = position.side === Side.LONG ? 1 : -1;
    const pnl = priceDiff * position.size * direction;

    // 3. Update database
    persistence.run(
      `UPDATE positions
       SET status = ?, close_price = ?, closed_at = ?, pnl = ?
       WHERE id = ?`,
      [PositionStatus.CLOSED, actualClosePrice, closedAt, pnl, positionId]
    );

    // 4. Update cache
    const closedPosition = {
      ...position,
      status: PositionStatus.CLOSED,
      close_price: actualClosePrice,
      closed_at: closedAt,
      pnl,
    };
    updateCachedPosition(positionId, closedPosition);

    // 5. Mark intent completed
    writeAhead.markCompleted(intentId, { positionId, closePrice: actualClosePrice, pnl });

    log.info('position_closed', {
      positionId,
      closePrice: actualClosePrice,
      pnl,
      emergency,
    });

    return closedPosition;
  } catch (err) {
    writeAhead.markFailed(intentId, {
      code: err.code || PositionManagerErrorCodes.CLOSE_FAILED,
      message: err.message,
    });

    log.error('position_close_failed', {
      intentId,
      positionId,
      error: err.message,
    });

    throw new PositionManagerError(
      PositionManagerErrorCodes.CLOSE_FAILED,
      `Failed to close position: ${err.message}`,
      { positionId, intentId, originalError: err.message }
    );
  }
}

/**
 * Reconcile local position state with exchange
 *
 * Compares local database positions with exchange balances and reports
 * divergences. Updates exchange_verified_at for matching positions.
 *
 * @param {Object} polymarketClient - Initialized Polymarket client with getBalance()
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Reconciliation result
 */
export async function reconcile(polymarketClient, log) {
  const openPositions = getPositions();
  const divergences = [];
  let verified = 0;
  const now = new Date().toISOString();

  log.info('reconciliation_started', { positionCount: openPositions.length });

  for (const position of openPositions) {
    try {
      // Query exchange for token balance
      const exchangeBalance = await polymarketClient.getBalance(position.token_id);

      // Compare with tolerance for floating point precision
      if (Math.abs(exchangeBalance - position.size) < 0.0001) {
        // Match - update verification timestamp
        persistence.run(
          'UPDATE positions SET exchange_verified_at = ? WHERE id = ?',
          [now, position.id]
        );
        updateCachedPosition(position.id, { exchange_verified_at: now });
        verified++;
      } else {
        // Divergence detected
        const divergenceType = exchangeBalance === 0 ? 'MISSING_ON_EXCHANGE' : 'SIZE_MISMATCH';
        const divergence = {
          positionId: position.id,
          tokenId: position.token_id,
          windowId: position.window_id,
          localState: {
            size: position.size,
            status: position.status,
          },
          exchangeState: {
            balance: exchangeBalance,
          },
          type: divergenceType,
        };
        divergences.push(divergence);

        log.warn('reconciliation_divergence', {
          positionId: position.id,
          localSize: position.size,
          exchangeBalance,
          type: divergenceType,
        });
      }
    } catch (err) {
      log.error('reconciliation_error', {
        positionId: position.id,
        tokenId: position.token_id,
        error: err.message,
      });
      divergences.push({
        positionId: position.id,
        tokenId: position.token_id,
        type: 'API_ERROR',
        error: err.message,
      });
    }
  }

  const result = {
    verified,
    divergences,
    timestamp: now,
    success: divergences.length === 0,
  };

  // Store last reconciliation result
  setLastReconciliation(result);

  log.info('reconciliation_completed', {
    verified,
    divergenceCount: divergences.length,
  });

  return result;
}
