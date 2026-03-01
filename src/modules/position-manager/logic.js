/**
 * Position Manager Business Logic (V3 Stage 4: DB as single source of truth)
 *
 * Core position lifecycle management:
 * - Position creation with write-ahead logging
 * - Position tracking and price updates
 * - All reads go directly to PostgreSQL (no in-memory cache)
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
  getPosition as getPositionFromDb,
  getOpenPositions,
  calculateTotalExposure,
  countPositionsByMarket,
  setLastReconciliation,
} from './state.js';
import { LifecycleState } from './lifecycle.js';
import * as safety from '../safety/index.js';

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
 * Now async because calculateTotalExposure and countPositionsByMarket query the DB.
 *
 * @param {Object} params - Position parameters
 * @param {number} params.size - Position size
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.marketId - Market ID
 * @param {Object} riskConfig - Risk configuration
 * @param {number} riskConfig.maxPositionSize - Maximum size per single position
 * @param {number} riskConfig.maxExposure - Maximum total exposure
 * @param {number} riskConfig.positionLimitPerMarket - Maximum positions per market
 * @returns {Promise<{ allowed: boolean, reason?: string, limit?: string }>}
 */
export async function checkLimits(params, riskConfig) {
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
  const currentExposure = await calculateTotalExposure();
  const newPositionExposure = size * entryPrice;
  const newTotalExposure = currentExposure + newPositionExposure;
  if (newTotalExposure > maxExposure) {
    return {
      allowed: false,
      reason: `Total exposure would be ${newTotalExposure.toFixed(2)}, exceeding maximum ${maxExposure}`,
      limit: 'maxExposure',
    };
  }

  // Check 3: Positions per market limit (null/undefined = no limit)
  if (positionLimitPerMarket != null && positionLimitPerMarket > 0) {
    const marketPositions = await countPositionsByMarket(marketId);
    if (marketPositions >= positionLimitPerMarket) {
      return {
        allowed: false,
        reason: `Market ${marketId} already has ${marketPositions} positions, limit is ${positionLimitPerMarket}`,
        limit: 'positionLimitPerMarket',
      };
    }
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
  const { windowId, marketId, tokenId, side, size, entryPrice, strategyId, orderId, mode } = params;

  // 1. Validate parameters
  validatePositionParams(params);

  // 2. Check limits if riskConfig provided
  if (riskConfig) {
    const limitCheck = await checkLimits(params, riskConfig);
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

  const intentId = await writeAhead.logIntent(
    writeAhead.INTENT_TYPES.OPEN_POSITION,
    windowId,
    intentPayload
  );

  log.info('position_intent_logged', { intentId, windowId, marketId, tokenId, side, size });

  // 4. Mark intent as executing
  writeAhead.markExecuting(intentId);

  try {
    const openedAt = new Date().toISOString();

    // 5. Insert to database using PostgreSQL parameterized queries
    //    lifecycle_state starts as MONITORING (ENTRY is transient)
    const result = await persistence.runReturningId(
      `INSERT INTO positions (
        window_id, market_id, token_id, side, size, entry_price,
        current_price, status, strategy_id, opened_at, order_id, mode, lifecycle_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
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
        orderId || null,
        mode || 'LIVE',
        LifecycleState.MONITORING,
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
      mode: mode || 'LIVE',
      lifecycle_state: LifecycleState.MONITORING,
    };

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
    if (err.message && (err.message.includes('UNIQUE constraint failed') || err.message.includes('duplicate key value'))) {
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
 * Now async - queries DB directly via state.
 *
 * @param {number} positionId - Position ID
 * @returns {Promise<Object|undefined>} Position with unrealized_pnl or undefined
 */
export async function getPosition(positionId) {
  const position = await getPositionFromDb(positionId);

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
 * Now async - queries DB directly via state.
 *
 * @param {string} [mode] - Optional mode filter (LIVE, PAPER, DRY_RUN). If omitted, returns all.
 * @returns {Promise<Object[]>} Array of open positions with unrealized_pnl
 */
export async function getPositions(mode) {
  const openPositions = await getOpenPositions(mode);
  return openPositions.map((position) => ({
    ...position,
    unrealized_pnl: calculateUnrealizedPnl(position),
  }));
}

/**
 * Update the current price for a position
 * Now async - reads from DB and writes update back.
 *
 * @param {number} positionId - Position ID
 * @param {number} newPrice - New current price (must be a non-negative number)
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Updated position with unrealized_pnl
 * @throws {PositionManagerError} If position not found or price invalid
 */
export async function updatePrice(positionId, newPrice, log) {
  // Validate newPrice
  if (typeof newPrice !== 'number' || newPrice < 0 || !Number.isFinite(newPrice)) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.VALIDATION_FAILED,
      `Invalid price: ${newPrice}. Price must be a non-negative finite number.`,
      { positionId, newPrice }
    );
  }

  // Update in DB and get the updated row back
  const updated = await persistence.get(
    `UPDATE positions SET current_price = $1 WHERE id = $2 RETURNING *`,
    [newPrice, positionId]
  );

  if (!updated) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_FOUND,
      `Position not found: ${positionId}`,
      { positionId }
    );
  }

  log.info('position_price_updated', {
    positionId,
    previousPrice: updated.current_price !== newPrice ? updated.current_price : undefined,
    newPrice,
    unrealizedPnl: calculateUnrealizedPnl(updated),
  });

  return {
    ...updated,
    unrealized_pnl: calculateUnrealizedPnl(updated),
  };
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

  // Get position from DB
  const position = await getPositionFromDb(positionId);

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

  const intentId = await writeAhead.logIntent(
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

    // Determine close price with explicit null/undefined handling
    // closePrice parameter takes precedence, then fall back to current_price
    let actualClosePrice;
    if (closePrice !== undefined && closePrice !== null) {
      actualClosePrice = closePrice;
    } else if (position.current_price !== undefined && position.current_price !== null) {
      actualClosePrice = position.current_price;
    } else {
      throw new PositionManagerError(
        PositionManagerErrorCodes.VALIDATION_FAILED,
        'Cannot close position: no close price available and current_price is not set',
        { positionId, closePrice, currentPrice: position.current_price }
      );
    }

    // Validate close price is a valid non-negative number
    if (typeof actualClosePrice !== 'number' || actualClosePrice < 0 || !Number.isFinite(actualClosePrice)) {
      throw new PositionManagerError(
        PositionManagerErrorCodes.VALIDATION_FAILED,
        `Invalid close price: ${actualClosePrice}. Price must be a non-negative finite number.`,
        { positionId, actualClosePrice }
      );
    }

    // Calculate P&L
    const priceDiff = actualClosePrice - position.entry_price;
    const direction = position.side === Side.LONG ? 1 : -1;
    const pnl = priceDiff * position.size * direction;

    // 3. Update database (also set lifecycle_state to CLOSED)
    const updateResult = await persistence.run(
      `UPDATE positions
       SET status = $1, close_price = $2, closed_at = $3, pnl = $4, lifecycle_state = $5
       WHERE id = $6`,
      [PositionStatus.CLOSED, actualClosePrice, closedAt, pnl, LifecycleState.CLOSED, positionId]
    );

    // Verify the database update succeeded
    if (updateResult.changes === 0) {
      throw new PositionManagerError(
        PositionManagerErrorCodes.DATABASE_ERROR,
        `Failed to update position in database: no rows affected`,
        { positionId, updateResult }
      );
    }

    // Build closed position for return value
    const closedPosition = {
      ...position,
      status: PositionStatus.CLOSED,
      close_price: actualClosePrice,
      closed_at: closedAt,
      pnl,
      lifecycle_state: LifecycleState.CLOSED,
    };

    // 4. Mark intent completed
    writeAhead.markCompleted(intentId, { positionId, closePrice: actualClosePrice, pnl });

    log.info('position_closed', {
      positionId,
      closePrice: actualClosePrice,
      pnl,
      emergency,
    });

    // 5. Notify safety module about realized P&L (fire-and-forget)
    try {
      safety.recordRealizedPnl(pnl);
    } catch (err) {
      // Don't block position close - log and continue
      log.warn('safety_pnl_record_failed', { error: err.message, pnl, positionId });
    }

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
  // Validate polymarketClient parameter
  if (!polymarketClient) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.VALIDATION_FAILED,
      'reconcile() requires a polymarketClient parameter',
      { polymarketClient }
    );
  }
  if (typeof polymarketClient.getBalance !== 'function') {
    throw new PositionManagerError(
      PositionManagerErrorCodes.VALIDATION_FAILED,
      'polymarketClient must have a getBalance() method',
      { hasGetBalance: typeof polymarketClient.getBalance }
    );
  }

  // Query database directly for open positions
  const openPositions = await persistence.all(
    'SELECT * FROM positions WHERE status = $1',
    [PositionStatus.OPEN]
  );

  const divergences = [];
  let verified = 0;
  const now = new Date().toISOString();

  log.info('reconciliation_started', { positionCount: openPositions.length });

  for (const position of openPositions) {
    try {
      // Query exchange for token balance
      const exchangeBalance = await polymarketClient.getBalance(position.token_id);

      // Compare with tolerance for floating point precision
      // Use relative tolerance (0.01% of position size) for large positions,
      // with a minimum absolute tolerance of 0.0001 for small positions
      const relativeTolerance = position.size * 0.0001; // 0.01% of position size
      const tolerance = Math.max(relativeTolerance, 0.0001);
      if (Math.abs(exchangeBalance - position.size) < tolerance) {
        // Match - update verification timestamp
        await persistence.run(
          'UPDATE positions SET exchange_verified_at = $1 WHERE id = $2',
          [now, position.id]
        );
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
