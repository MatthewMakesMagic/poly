/**
 * Order Manager Business Logic (V3 Stage 4: DB as single source of truth)
 *
 * Core order lifecycle management:
 * - Order placement with write-ahead logging
 * - Order status tracking
 * - Database persistence (no in-memory cache)
 */

import persistence from '../../persistence/index.js';
import * as writeAhead from '../../persistence/write-ahead.js';
import * as polymarketClient from '../../clients/polymarket/index.js';
import {
  OrderManagerError,
  OrderManagerErrorCodes,
  OrderStatus,
  Side,
  TradingMode,
  ValidStatusTransitions,
} from './types.js';
import {
  getOrder as getOrderFromDb,
  getOpenOrders as getOpenOrdersFromDb,
  getOrdersByWindow as getOrdersByWindowFromDb,
  recordOrderPlaced,
  recordStatusChange,
  recordLatency,
  recordCancelLatency,
  recordPartialFill,
} from './state.js';

/**
 * Validate order parameters
 * @param {Object} params - Order parameters
 * @throws {OrderManagerError} If validation fails
 */
// Hard cap on per-order dollar size. Defence-in-depth: even if position-sizer
// or strategy miscalculates, no single order can exceed this amount.
const MAX_ORDER_DOLLARS = 5;

function validateOrderParams(params) {
  const { tokenId, side, size, price, orderType, windowId, marketId } = params;

  const errors = [];

  if (!tokenId || typeof tokenId !== 'string') {
    errors.push('tokenId is required and must be a string');
  }

  if (!side || ![Side.BUY, Side.SELL].includes(side)) {
    errors.push(`side must be '${Side.BUY}' or '${Side.SELL}'`);
  }

  if (typeof size !== 'number' || size <= 0) {
    errors.push('size must be a positive number');
  }

  // Per-position dollar cap: reject orders exceeding MAX_ORDER_DOLLARS
  if (typeof size === 'number' && size > MAX_ORDER_DOLLARS) {
    errors.push(`size ${size} exceeds per-order cap of $${MAX_ORDER_DOLLARS}`);
  }

  // Price can be null for market orders, but if provided must be valid
  if (price !== null && price !== undefined) {
    if (typeof price !== 'number' || price < 0.01 || price > 0.99) {
      errors.push('price must be a number between 0.01 and 0.99');
    }
  }

  if (!orderType || typeof orderType !== 'string') {
    errors.push('orderType is required');
  }

  if (!windowId || typeof windowId !== 'string') {
    errors.push('windowId is required and must be a string');
  }

  if (!marketId || typeof marketId !== 'string') {
    errors.push('marketId is required and must be a string');
  }

  if (errors.length > 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      `Order validation failed: ${errors.join(', ')}`,
      { params, errors }
    );
  }
}

/**
 * Map Polymarket status to our internal status
 * @param {string} polymarketStatus - Status from Polymarket API
 * @param {boolean} isFoK - Whether order was Fill-or-Kill
 * @returns {string} Internal order status
 */
function mapPolymarketStatus(polymarketStatus, isImmediateOrder = false) {
  switch (polymarketStatus) {
    case 'live':
      return OrderStatus.OPEN;
    case 'matched':
      return OrderStatus.FILLED;
    case 'cancelled':
    case 'expired':
    case 'killed':
      // For immediate orders (FOK/IOC), unfilled = rejected
      return isImmediateOrder ? OrderStatus.REJECTED : OrderStatus.CANCELLED;
    default:
      // Unknown status: immediate orders treat as rejected, others as cancelled
      // Never silently map unknown statuses to OPEN
      return isImmediateOrder ? OrderStatus.REJECTED : OrderStatus.CANCELLED;
  }
}

// Phase 0.5: Maximum orders per window per instrument (hardcoded safety cap)
const MAX_ORDERS_PER_WINDOW_INSTRUMENT = 2;

// Phase 0.5: Order confirmation polling settings
const CONFIRMATION_POLL_INTERVAL_MS = 1000;
const CONFIRMATION_TIMEOUT_MS = 5000;

/**
 * Phase 0.5: Verify USDC balance before placing an order
 *
 * @param {number} requiredAmount - Dollar amount needed
 * @param {Object} log - Logger
 * @throws {OrderManagerError} If insufficient balance
 */
async function verifyBalance(requiredAmount, log) {
  try {
    const balance = await polymarketClient.getUSDCBalance();

    if (balance < requiredAmount) {
      log.error('insufficient_balance', {
        level: 'CRITICAL',
        required: requiredAmount,
        available: balance,
        shortfall: requiredAmount - balance,
      });

      throw new OrderManagerError(
        OrderManagerErrorCodes.INSUFFICIENT_BALANCE,
        `Insufficient USDC balance: need $${requiredAmount.toFixed(2)}, have $${balance.toFixed(2)}`,
        { required: requiredAmount, available: balance, orderSubmittedToExchange: false }
      );
    }

    log.info('balance_verified', {
      required: requiredAmount,
      available: balance,
      remaining_after: balance - requiredAmount,
    });
  } catch (err) {
    if (err instanceof OrderManagerError) throw err;

    // API call failed — log but don't block (fail-open for balance check)
    log.warn('balance_check_failed', {
      error: err.message,
      required: requiredAmount,
      message: 'Balance check failed — proceeding with order (fail-open)',
    });
  }
}

/**
 * Phase 0.5: Check hard cap on orders per window per instrument
 *
 * @param {string} windowId - Window ID
 * @param {string} tokenId - Token ID (instrument)
 * @param {Object} log - Logger
 * @throws {OrderManagerError} If cap exceeded
 */
async function checkWindowOrderCap(windowId, tokenId, log) {
  try {
    const result = await persistence.get(
      `SELECT COUNT(*) as count FROM orders
       WHERE window_id = $1 AND token_id = $2
       AND status NOT IN ($3, $4)`,
      [windowId, tokenId, OrderStatus.REJECTED, OrderStatus.CANCELLED]
    );

    const orderCount = Number(result?.count || 0);

    if (orderCount >= MAX_ORDERS_PER_WINDOW_INSTRUMENT) {
      log.warn('window_order_cap_exceeded', {
        windowId,
        tokenId,
        existingOrders: orderCount,
        cap: MAX_ORDERS_PER_WINDOW_INSTRUMENT,
      });

      throw new OrderManagerError(
        OrderManagerErrorCodes.WINDOW_ORDER_CAP_EXCEEDED,
        `Max ${MAX_ORDERS_PER_WINDOW_INSTRUMENT} orders per window per instrument. Already have ${orderCount}.`,
        { windowId, tokenId, existingOrders: orderCount, cap: MAX_ORDERS_PER_WINDOW_INSTRUMENT, orderSubmittedToExchange: false }
      );
    }

    log.debug('window_order_cap_ok', {
      windowId,
      tokenId,
      existingOrders: orderCount,
      cap: MAX_ORDERS_PER_WINDOW_INSTRUMENT,
    });
  } catch (err) {
    if (err instanceof OrderManagerError) throw err;

    // DB query failed — log but don't block
    log.warn('window_order_cap_check_failed', {
      error: err.message,
      message: 'Cap check failed — proceeding with order',
    });
  }
}

/**
 * Phase 0.5: Poll for order fill confirmation
 *
 * For non-IOC orders, polls the Polymarket API to confirm fill status.
 * If no confirmation within timeout, marks order as UNKNOWN.
 *
 * @param {string} orderId - Order ID to confirm
 * @param {string} currentStatus - Current order status from placement
 * @param {Object} log - Logger
 * @returns {Promise<Object|null>} Confirmed order data or null
 */
async function pollForConfirmation(orderId, currentStatus, log) {
  // If already in a terminal state (filled, rejected, cancelled), skip polling
  const terminalStates = [OrderStatus.FILLED, OrderStatus.REJECTED, OrderStatus.CANCELLED, OrderStatus.EXPIRED];
  if (terminalStates.includes(currentStatus)) {
    return null; // No polling needed
  }

  const startTime = Date.now();
  let lastStatus = currentStatus;

  while (Date.now() - startTime < CONFIRMATION_TIMEOUT_MS) {
    try {
      const exchangeOrder = await polymarketClient.getOrder(orderId);

      if (!exchangeOrder) {
        log.warn('confirmation_poll_order_not_found', { orderId });
        await sleep(CONFIRMATION_POLL_INTERVAL_MS);
        continue;
      }

      const exchangeStatus = exchangeOrder.status;

      if (exchangeStatus === 'matched') {
        log.info('order_confirmed_filled', {
          orderId,
          pollingDurationMs: Date.now() - startTime,
        });
        return { status: OrderStatus.FILLED, exchangeOrder };
      }

      if (exchangeStatus === 'cancelled' || exchangeStatus === 'expired' || exchangeStatus === 'killed') {
        log.info('order_confirmed_terminal', {
          orderId,
          exchangeStatus,
          pollingDurationMs: Date.now() - startTime,
        });
        return { status: exchangeStatus === 'cancelled' || exchangeStatus === 'killed'
          ? OrderStatus.CANCELLED : OrderStatus.EXPIRED, exchangeOrder };
      }

      lastStatus = exchangeStatus;
    } catch (err) {
      log.warn('confirmation_poll_error', {
        orderId,
        error: err.message,
        elapsedMs: Date.now() - startTime,
      });
    }

    await sleep(CONFIRMATION_POLL_INTERVAL_MS);
  }

  // Timeout — mark as UNKNOWN
  log.error('order_confirmation_timeout', {
    level: 'CRITICAL',
    orderId,
    lastKnownStatus: lastStatus,
    timeoutMs: CONFIRMATION_TIMEOUT_MS,
    message: 'Order confirmation timed out. Marking as UNKNOWN to block re-entry.',
  });

  return { status: OrderStatus.UNKNOWN, exchangeOrder: null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase 0.7: Unified execute entry point.
 *
 * Routes signal to the correct fill source based on mode, then returns a
 * uniform result that downstream code (PositionManager, StopLoss, TakeProfit,
 * Settlement) can consume identically.
 *
 * @param {Object} signal - Trading signal
 * @param {string} signal.tokenId - Token to trade
 * @param {string} signal.side - 'buy' or 'sell'
 * @param {number} signal.size - Dollar amount (buy) or shares (sell)
 * @param {number} signal.price - Limit price
 * @param {string} signal.orderType - Order type (GTC, FOK, IOC)
 * @param {string} signal.windowId - Window ID
 * @param {string} signal.marketId - Market ID
 * @param {Object} [signal.signalContext] - Signal context metadata
 * @param {string} mode - Trading mode: LIVE, PAPER, DRY_RUN
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Uniform order result
 */
export async function execute(signal, mode, log) {
  switch (mode) {
    case TradingMode.LIVE:
      return placeOrder(signal, log, {});
    case TradingMode.DRY_RUN:
      return placeDryRunOrder(signal, log);
    case TradingMode.PAPER:
      return placePaperOrder(signal, log);
    default:
      throw new OrderManagerError(
        OrderManagerErrorCodes.VALIDATION_FAILED,
        `Unknown trading mode: ${mode}. Must be LIVE, PAPER, or DRY_RUN.`,
        { mode }
      );
  }
}

/**
 * Phase 0.7: Place a paper order — simulated fill using CLOB best prices.
 *
 * Identical validation to live, but fills are simulated locally.
 * Persists to orders table with mode='PAPER' and a synthetic order ID.
 * Unlike DRY_RUN, PAPER orders are meant to be tracked through the full
 * position lifecycle (stop-loss, take-profit, settlement).
 *
 * @param {Object} params - Same as placeOrder
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Synthetic order result matching live placeOrder shape
 */
export async function placePaperOrder(params, log) {
  const { tokenId, side, size, price, orderType, windowId, marketId, signalContext } = params;

  // 1. Validate parameters — identical to live
  validateOrderParams(params);

  // 1c. Hard cap check
  await checkWindowOrderCap(windowId, tokenId, log);

  // 2. Log intent
  const intentPayload = {
    tokenId, side, size, price, orderType, windowId, marketId,
    mode: 'PAPER',
    requestedAt: new Date().toISOString(),
  };

  const intentId = await writeAhead.logIntent(
    writeAhead.INTENT_TYPES.PLACE_ORDER,
    windowId,
    intentPayload
  );

  log.info('paper_order_payload', {
    intentId, tokenId, side, size, price, orderType, windowId, marketId,
    signalContext,
    message: 'PAPER: Simulated order using CLOB best prices',
  });

  writeAhead.markExecuting(intentId);

  const startTime = Date.now();
  const orderSubmittedAt = new Date().toISOString();

  try {
    // 3. Fetch CLOB best bid/ask for realistic fill simulation
    let orderBookSnapshot = null;
    let simulatedFillPrice = price; // fallback

    try {
      const bestPrices = await polymarketClient.getBestPrices(tokenId);
      orderBookSnapshot = {
        bid: bestPrices.bid,
        ask: bestPrices.ask,
        spread: bestPrices.spread,
        midpoint: bestPrices.midpoint,
        capturedAt: new Date().toISOString(),
      };

      // Simulate realistic fill: ask for buys, bid for sells
      if (side === Side.BUY && bestPrices.ask != null) {
        simulatedFillPrice = bestPrices.ask;
      } else if (side === Side.SELL && bestPrices.bid != null) {
        simulatedFillPrice = bestPrices.bid;
      }

      log.info('paper_book_snapshot', {
        tokenId, bid: bestPrices.bid, ask: bestPrices.ask,
        spread: bestPrices.spread, simulatedFillPrice,
      });
    } catch (bookErr) {
      log.warn('paper_book_fetch_failed', {
        tokenId, error: bookErr.message,
        message: 'Using requested price as fill price',
      });
    }

    // 4. Generate synthetic order ID
    const syntheticOrderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orderAckedAt = new Date().toISOString();
    const latencyMs = Date.now() - startTime;
    recordLatency(latencyMs);

    // 5. Simulate immediate fill
    const status = OrderStatus.FILLED;
    const orderFilledAt = orderAckedAt;

    const actualFilledSize = side === Side.BUY
      ? (simulatedFillPrice > 0 ? size / simulatedFillPrice : size)
      : size;
    const actualFillPrice = simulatedFillPrice;

    // 6. Persist order record with mode='PAPER'
    const orderRecord = {
      order_id: syntheticOrderId,
      intent_id: intentId,
      position_id: null,
      window_id: windowId,
      market_id: marketId,
      token_id: tokenId,
      side,
      order_type: orderType,
      price,
      size,
      filled_size: actualFilledSize,
      avg_fill_price: actualFillPrice,
      fee_amount: 0,
      status,
      submitted_at: orderSubmittedAt,
      latency_ms: latencyMs,
      filled_at: orderFilledAt,
      cancelled_at: null,
      error_message: null,
      original_edge: signalContext?.edge ?? null,
      original_model_probability: signalContext?.modelProbability ?? null,
      symbol: signalContext?.symbol ?? null,
      strategy_id: signalContext?.strategyId ?? null,
      side_token: signalContext?.sideToken ?? null,
    };

    let dbWriteFailed = false;
    try {
      await persistence.run(
        `INSERT INTO orders (
          order_id, intent_id, position_id, window_id, market_id, token_id,
          side, order_type, price, size, filled_size, avg_fill_price,
          status, submitted_at, latency_ms, filled_at, cancelled_at, error_message,
          original_edge, original_model_probability, symbol, strategy_id, side_token,
          fee_amount, mode, order_book_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
        [
          orderRecord.order_id, orderRecord.intent_id, orderRecord.position_id,
          orderRecord.window_id, orderRecord.market_id, orderRecord.token_id,
          orderRecord.side, orderRecord.order_type, orderRecord.price,
          orderRecord.size, orderRecord.filled_size, orderRecord.avg_fill_price,
          orderRecord.status, orderRecord.submitted_at, orderRecord.latency_ms,
          orderRecord.filled_at, orderRecord.cancelled_at, orderRecord.error_message,
          orderRecord.original_edge, orderRecord.original_model_probability,
          orderRecord.symbol, orderRecord.strategy_id, orderRecord.side_token,
          orderRecord.fee_amount,
          'PAPER',
          orderBookSnapshot ? JSON.stringify(orderBookSnapshot) : null,
        ]
      );
    } catch (dbErr) {
      dbWriteFailed = true;
      log.error('paper_order_db_insert_failed', {
        orderId: syntheticOrderId, error: dbErr.message,
      });
    }

    // 7. Record stats and mark intent completed
    recordOrderPlaced();

    writeAhead.markCompleted(intentId, {
      orderId: syntheticOrderId, status, latencyMs, mode: 'PAPER',
    });

    log.info('paper_order_filled', {
      orderId: syntheticOrderId, status, latencyMs, side, size,
      simulatedFillPrice: actualFillPrice,
      simulatedFilledSize: actualFilledSize,
      orderBookSnapshot,
    });

    // 8. Return result matching live placeOrder shape
    return {
      orderId: syntheticOrderId,
      status,
      latencyMs,
      intentId,
      orderSubmittedToExchange: false,
      dbWriteFailed,
      fillPrice: actualFillPrice,
      filledSize: actualFilledSize,
      fillCost: size,
      feeAmount: 0,
      mode: 'PAPER',
      orderBookSnapshot,
      timestamps: {
        orderSubmittedAt, orderAckedAt, orderFilledAt,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    writeAhead.markFailed(intentId, {
      code: err.code || 'UNKNOWN', message: err.message, latencyMs, mode: 'PAPER',
    });

    log.error('paper_order_failed', {
      intentId, error: err.message, code: err.code, latencyMs,
    });

    throw new OrderManagerError(
      OrderManagerErrorCodes.SUBMISSION_FAILED,
      `Paper order failed: ${err.message}`,
      { intentId, originalError: err.message, code: err.code, orderSubmittedToExchange: false, params }
    );
  }
}

/**
 * Phase 0.6: Place a dry-run order — full code path except the final POST to Polymarket.
 *
 * - Validates params identically to live
 * - Logs the full order payload that WOULD have been sent
 * - Fetches CLOB best bid/ask for realistic fill simulation
 * - Simulates immediate fill: bid for buys, ask for sells
 * - Records order book snapshot at decision time
 * - Persists to DB with mode='DRY_RUN' and a synthetic order ID
 * - Full write-ahead logging, same as live
 *
 * @param {Object} params - Same as placeOrder
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Synthetic order result matching live placeOrder shape
 */
export async function placeDryRunOrder(params, log) {
  const { tokenId, side, size, price, orderType, windowId, marketId, signalContext } = params;

  // 1. Validate parameters — identical to live
  validateOrderParams(params);

  // 1c. Hard cap check — still enforce in dry-run
  await checkWindowOrderCap(windowId, tokenId, log);

  // 2. Log the full order payload that WOULD have been sent
  const intentPayload = {
    tokenId,
    side,
    size,
    price,
    orderType,
    windowId,
    marketId,
    mode: 'DRY_RUN',
    requestedAt: new Date().toISOString(),
  };

  const intentId = await writeAhead.logIntent(
    writeAhead.INTENT_TYPES.PLACE_ORDER,
    windowId,
    intentPayload
  );

  log.info('dry_run_order_payload', {
    intentId,
    tokenId,
    side,
    size,
    price,
    orderType,
    windowId,
    marketId,
    signalContext,
    message: 'DRY_RUN: Full order payload that would have been sent to Polymarket',
  });

  writeAhead.markExecuting(intentId);

  const startTime = Date.now();
  const orderSubmittedAt = new Date().toISOString();

  try {
    // 3. Fetch CLOB best bid/ask for realistic fill simulation
    let orderBookSnapshot = null;
    let simulatedFillPrice = price; // fallback to requested price

    try {
      const bestPrices = await polymarketClient.getBestPrices(tokenId);
      orderBookSnapshot = {
        bid: bestPrices.bid,
        ask: bestPrices.ask,
        spread: bestPrices.spread,
        midpoint: bestPrices.midpoint,
        capturedAt: new Date().toISOString(),
      };

      // Simulate realistic fill: bid for buys, ask for sells
      if (side === Side.BUY && bestPrices.ask != null) {
        simulatedFillPrice = bestPrices.ask;
      } else if (side === Side.SELL && bestPrices.bid != null) {
        simulatedFillPrice = bestPrices.bid;
      }

      log.info('dry_run_book_snapshot', {
        tokenId,
        bid: bestPrices.bid,
        ask: bestPrices.ask,
        spread: bestPrices.spread,
        simulatedFillPrice,
      });
    } catch (bookErr) {
      log.warn('dry_run_book_fetch_failed', {
        tokenId,
        error: bookErr.message,
        message: 'Using requested price as fill price — CLOB unavailable',
      });
    }

    // 4. Generate synthetic order ID
    const syntheticOrderId = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orderAckedAt = new Date().toISOString();
    const latencyMs = Date.now() - startTime;
    recordLatency(latencyMs);

    // 5. Simulate immediate fill
    const status = OrderStatus.FILLED;
    const orderFilledAt = orderAckedAt;

    // Simulated fill amounts
    const actualFilledSize = side === Side.BUY
      ? (simulatedFillPrice > 0 ? size / simulatedFillPrice : size)
      : size;
    const actualFillPrice = simulatedFillPrice;

    // 6. Build and persist order record
    const orderRecord = {
      order_id: syntheticOrderId,
      intent_id: intentId,
      position_id: null,
      window_id: windowId,
      market_id: marketId,
      token_id: tokenId,
      side,
      order_type: orderType,
      price,
      size,
      filled_size: actualFilledSize,
      avg_fill_price: actualFillPrice,
      fee_amount: 0,
      status,
      submitted_at: orderSubmittedAt,
      latency_ms: latencyMs,
      filled_at: orderFilledAt,
      cancelled_at: null,
      error_message: null,
      original_edge: signalContext?.edge ?? null,
      original_model_probability: signalContext?.modelProbability ?? null,
      symbol: signalContext?.symbol ?? null,
      strategy_id: signalContext?.strategyId ?? null,
      side_token: signalContext?.sideToken ?? null,
    };

    let dbWriteFailed = false;
    try {
      await persistence.run(
        `INSERT INTO orders (
          order_id, intent_id, position_id, window_id, market_id, token_id,
          side, order_type, price, size, filled_size, avg_fill_price,
          status, submitted_at, latency_ms, filled_at, cancelled_at, error_message,
          original_edge, original_model_probability, symbol, strategy_id, side_token,
          fee_amount, mode, order_book_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
        [
          orderRecord.order_id,
          orderRecord.intent_id,
          orderRecord.position_id,
          orderRecord.window_id,
          orderRecord.market_id,
          orderRecord.token_id,
          orderRecord.side,
          orderRecord.order_type,
          orderRecord.price,
          orderRecord.size,
          orderRecord.filled_size,
          orderRecord.avg_fill_price,
          orderRecord.status,
          orderRecord.submitted_at,
          orderRecord.latency_ms,
          orderRecord.filled_at,
          orderRecord.cancelled_at,
          orderRecord.error_message,
          orderRecord.original_edge,
          orderRecord.original_model_probability,
          orderRecord.symbol,
          orderRecord.strategy_id,
          orderRecord.side_token,
          orderRecord.fee_amount,
          'DRY_RUN',
          orderBookSnapshot ? JSON.stringify(orderBookSnapshot) : null,
        ]
      );
    } catch (dbErr) {
      dbWriteFailed = true;
      log.error('dry_run_order_db_insert_failed', {
        orderId: syntheticOrderId,
        error: dbErr.message,
      });
    }

    // 7. Record stats and mark intent completed
    recordOrderPlaced();

    writeAhead.markCompleted(intentId, {
      orderId: syntheticOrderId,
      status,
      latencyMs,
      mode: 'DRY_RUN',
    });

    log.info('dry_run_order_filled', {
      orderId: syntheticOrderId,
      status,
      latencyMs,
      side,
      size,
      simulatedFillPrice: actualFillPrice,
      simulatedFilledSize: actualFilledSize,
      orderBookSnapshot,
    });

    // 8. Return result matching live placeOrder shape
    return {
      orderId: syntheticOrderId,
      status,
      latencyMs,
      intentId,
      orderSubmittedToExchange: false, // CRITICAL: no money left the account
      dbWriteFailed,
      fillPrice: actualFillPrice,
      filledSize: actualFilledSize,
      fillCost: size,
      feeAmount: 0,
      mode: 'DRY_RUN',
      orderBookSnapshot,
      timestamps: {
        orderSubmittedAt,
        orderAckedAt,
        orderFilledAt,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    writeAhead.markFailed(intentId, {
      code: err.code || 'UNKNOWN',
      message: err.message,
      latencyMs,
      mode: 'DRY_RUN',
    });

    log.error('dry_run_order_failed', {
      intentId,
      error: err.message,
      code: err.code,
      latencyMs,
    });

    throw new OrderManagerError(
      OrderManagerErrorCodes.SUBMISSION_FAILED,
      `Dry-run order failed: ${err.message}`,
      {
        intentId,
        originalError: err.message,
        code: err.code,
        orderSubmittedToExchange: false,
        params,
      }
    );
  }
}

/**
 * Place an order with write-ahead logging
 *
 * Flow:
 * 1. Validate parameters
 * 1b. Phase 0.5: Verify USDC balance (buy orders)
 * 1c. Phase 0.5: Check window/instrument order cap
 * 2. Log intent BEFORE API call
 * 3. Mark intent as executing
 * 4. Call Polymarket API
 * 5. Record latency and persist order
 * 5b. Phase 0.5: Poll for confirmation (non-IOC GTC orders)
 * 6. Mark intent completed/failed
 *
 * @param {Object} params - Order parameters
 * @param {string} params.tokenId - Token to trade
 * @param {string} params.side - 'buy' or 'sell'
 * @param {number} params.size - Size to trade
 * @param {number} params.price - Limit price (0.01-0.99)
 * @param {string} params.orderType - Order type (GTC, FOK, IOC)
 * @param {string} params.windowId - Window ID for tracking
 * @param {string} params.marketId - Market ID
 * @param {Object} [params.signalContext] - Signal context for stale order detection
 * @param {number} [params.signalContext.edge] - Edge at time of signal
 * @param {number} [params.signalContext.modelProbability] - Model probability at signal
 * @param {string} [params.signalContext.symbol] - Crypto symbol (btc, eth, sol, xrp)
 * @param {string} [params.signalContext.strategyId] - Strategy that generated signal
 * @param {string} [params.signalContext.sideToken] - Token side (UP or DOWN)
 * @param {Object} log - Logger instance
 * @param {Object} [options] - Options
 * @param {string} [options.mode] - Trading mode (LIVE, DRY_RUN). If DRY_RUN, routes to placeDryRunOrder.
 * @returns {Promise<Object>} Order result with orderId, status, latencyMs
 */
export async function placeOrder(params, log, options = {}) {
  // Phase 0.6: Route to dry-run path if mode is DRY_RUN
  if (options.mode === 'DRY_RUN') {
    return placeDryRunOrder(params, log);
  }

  const { tokenId, side, size, price, orderType, windowId, marketId, signalContext } = params;

  // 1. Validate parameters
  validateOrderParams(params);

  // 1b. Phase 0.5: Balance verification (buy orders only)
  if (side === Side.BUY) {
    await verifyBalance(size, log);
  }

  // 1c. Phase 0.5: Hard cap check — max orders per window per instrument
  await checkWindowOrderCap(windowId, tokenId, log);

  // 2. Log intent BEFORE API call
  const intentPayload = {
    tokenId,
    side,
    size,
    price,
    orderType,
    windowId,
    marketId,
    requestedAt: new Date().toISOString(),
  };

  const intentId = await writeAhead.logIntent(
    writeAhead.INTENT_TYPES.PLACE_ORDER,
    windowId,
    intentPayload
  );

  log.info('order_intent_logged', { intentId, tokenId, side, size, price, orderType });

  // 3. Mark intent as executing
  writeAhead.markExecuting(intentId);

  // 4. Record start time for latency and capture orderSubmittedAt BEFORE API call
  const startTime = Date.now();
  const orderSubmittedAt = new Date().toISOString();

  try {
    // 5. Call Polymarket API based on side
    let result;
    if (side === Side.BUY) {
      // For buy orders, size is in dollars
      result = await polymarketClient.buy(tokenId, size, price, orderType);
    } else {
      // For sell orders, size is in shares
      result = await polymarketClient.sell(tokenId, size, price, orderType);
    }

    // 6. Capture orderAckedAt AFTER API response (exchange acknowledged receipt)
    const orderAckedAt = new Date().toISOString();

    // 7. Calculate latency
    const latencyMs = Date.now() - startTime;
    recordLatency(latencyMs);

    // 7.5 Validate order_id — must never be null/undefined
    if (!result.orderId) {
      const noIdErr = new OrderManagerError(
        OrderManagerErrorCodes.VALIDATION_FAILED,
        'Exchange returned no order_id — refusing to persist',
        { result, params }
      );
      writeAhead.markFailed(intentId, {
        code: 'MISSING_ORDER_ID',
        message: noIdErr.message,
      });
      throw noIdErr;
    }

    // 8. Determine order status from API response
    const isImmediateOrder = orderType === 'FOK' || orderType === 'IOC';
    let status = mapPolymarketStatus(result.status, isImmediateOrder);

    // 8b. Phase 0.5: For non-immediate orders (GTC) that are OPEN, poll for confirmation
    let confirmedFillData = null;
    if (!isImmediateOrder && status === OrderStatus.OPEN && result.orderId) {
      const confirmation = await pollForConfirmation(result.orderId, status, log);
      if (confirmation) {
        status = confirmation.status;
        if (confirmation.exchangeOrder) {
          confirmedFillData = confirmation.exchangeOrder;
        }
      }
    }

    // 9. Capture orderFilledAt if order was immediately filled
    const orderFilledAt = status === OrderStatus.FILLED ? orderAckedAt : null;

    // 9b. Phase 0.5: Extract actual fill amounts from exchange (not requested amounts)
    // Priority: confirmed poll data > initial result data > requested values
    let actualFilledSize = 0;
    let actualFillPrice = null;
    let feeAmount = 0;

    if (status === OrderStatus.FILLED) {
      // Use actual fill data from exchange
      actualFilledSize = result.shares ?? result.cost ?? size;
      actualFillPrice = result.priceFilled ?? price;

      // Phase 0.5: Extract fee from raw order result
      if (result.raw) {
        const rawFee = result.raw.fee || result.raw.takerFee || result.raw.makerFee || 0;
        feeAmount = typeof rawFee === 'string' ? parseFloat(rawFee) / 1_000_000 : rawFee;
      }

      // Override with confirmed data if available (from polling)
      if (confirmedFillData) {
        if (confirmedFillData.size_matched != null) {
          actualFilledSize = parseFloat(confirmedFillData.size_matched);
        }
        if (confirmedFillData.price != null) {
          const parsed = parseFloat(confirmedFillData.price);
          if (parsed >= 0.01 && parsed <= 0.99) {
            actualFillPrice = parsed;
          }
        }
        if (confirmedFillData.fee != null) {
          const parsedFee = parseFloat(confirmedFillData.fee);
          if (!isNaN(parsedFee)) {
            feeAmount = parsedFee;
          }
        }
      }

      log.info('fill_data_captured', {
        orderId: result.orderId,
        actualFilledSize,
        actualFillPrice,
        feeAmount,
        source: confirmedFillData ? 'confirmation_poll' : 'initial_response',
      });
    }

    // 10. Build order record
    const orderRecord = {
      order_id: result.orderId,
      intent_id: intentId,
      position_id: null, // Will be set by position manager
      window_id: windowId,
      market_id: marketId,
      token_id: tokenId,
      side,
      order_type: orderType,
      price,
      size,
      filled_size: actualFilledSize,
      avg_fill_price: actualFillPrice,
      fee_amount: feeAmount,
      status,
      submitted_at: orderSubmittedAt,
      latency_ms: latencyMs,
      filled_at: orderFilledAt,
      cancelled_at: null,
      error_message: status === OrderStatus.UNKNOWN
        ? 'Order confirmation timed out — status unknown'
        : null,
      // Signal context for stale order detection
      original_edge: signalContext?.edge ?? null,
      original_model_probability: signalContext?.modelProbability ?? null,
      symbol: signalContext?.symbol ?? null,
      strategy_id: signalContext?.strategyId ?? null,
      side_token: signalContext?.sideToken ?? null,
    };

    // 11. Insert order into database
    // CRITICAL: API call already succeeded — DB failure must NOT cause re-entry
    let dbWriteFailed = false;
    try {
      const insertResult = await persistence.run(
        `INSERT INTO orders (
          order_id, intent_id, position_id, window_id, market_id, token_id,
          side, order_type, price, size, filled_size, avg_fill_price,
          status, submitted_at, latency_ms, filled_at, cancelled_at, error_message,
          original_edge, original_model_probability, symbol, strategy_id, side_token,
          fee_amount
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          orderRecord.order_id,
          orderRecord.intent_id,
          orderRecord.position_id,
          orderRecord.window_id,
          orderRecord.market_id,
          orderRecord.token_id,
          orderRecord.side,
          orderRecord.order_type,
          orderRecord.price,
          orderRecord.size,
          orderRecord.filled_size,
          orderRecord.avg_fill_price,
          orderRecord.status,
          orderRecord.submitted_at,
          orderRecord.latency_ms,
          orderRecord.filled_at,
          orderRecord.cancelled_at,
          orderRecord.error_message,
          orderRecord.original_edge,
          orderRecord.original_model_probability,
          orderRecord.symbol,
          orderRecord.strategy_id,
          orderRecord.side_token,
          orderRecord.fee_amount,
        ]
      );

      if (!insertResult || insertResult.changes !== 1) {
        dbWriteFailed = true;
        log.error('order_db_insert_failed', {
          orderId: result.orderId,
          reason: 'insert returned no changes',
        });
      }
    } catch (dbErr) {
      dbWriteFailed = true;
      log.error('order_db_insert_failed', {
        orderId: result.orderId,
        error: dbErr.message,
        message: 'CRITICAL: Order succeeded on exchange but DB write failed — returning success to prevent re-entry',
      });
    }

    // 12. Record stats for the new order placement
    recordOrderPlaced();

    // 13. Mark intent completed
    writeAhead.markCompleted(intentId, {
      orderId: result.orderId,
      status,
      latencyMs,
    });

    log.info('order_placed', {
      orderId: result.orderId,
      status,
      latencyMs,
      side,
      size,
      price,
      feeAmount,
    });

    // 14. Return result with timestamps and fill data
    return {
      orderId: result.orderId,
      status,
      latencyMs,
      intentId,
      orderSubmittedToExchange: true, // CRITICAL: caller must know money may have left the account
      dbWriteFailed,
      // Phase 0.5: Actual fill data from exchange (not request values)
      fillPrice: actualFillPrice,
      filledSize: actualFilledSize || result.shares || null,
      fillCost: result.cost ?? null,
      feeAmount,
      timestamps: {
        orderSubmittedAt,
        orderAckedAt,
        orderFilledAt,
      },
    };
  } catch (err) {
    // Calculate latency even on failure
    const latencyMs = Date.now() - startTime;

    // ALWAYS mark intent as failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'UNKNOWN',
      message: err.message,
      context: err.context,
      latencyMs,
    });

    log.error('order_placement_failed', {
      intentId,
      error: err.message,
      code: err.code,
      latencyMs,
    });

    // Re-throw with additional context
    // orderSubmittedToExchange: false — this catch only fires when the API call itself fails,
    // meaning the order never reached the exchange. Caller uses this to decide release vs confirm.
    throw new OrderManagerError(
      OrderManagerErrorCodes.SUBMISSION_FAILED,
      `Order submission failed: ${err.message}`,
      {
        intentId,
        originalError: err.message,
        code: err.code,
        orderSubmittedToExchange: false,
        params,
      }
    );
  }
}

/**
 * Update order status with validation
 *
 * @param {string} orderId - Order ID
 * @param {string} newStatus - New status
 * @param {Object} [updates={}] - Additional fields to update
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Updated order
 */
export async function updateOrderStatus(orderId, newStatus, updates = {}, log) {
  // Get current order from DB
  const order = await getOrderFromDb(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // Validate status transition
  const allowedTransitions = ValidStatusTransitions[order.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Invalid status transition: ${order.status} → ${newStatus}`,
      { orderId, currentStatus: order.status, newStatus, allowedTransitions }
    );
  }

  // Build update object
  const updateFields = {
    status: newStatus,
    ...updates,
  };

  // Set timestamps based on status
  if (newStatus === OrderStatus.FILLED && !updateFields.filled_at) {
    updateFields.filled_at = new Date().toISOString();
  }
  if (newStatus === OrderStatus.CANCELLED && !updateFields.cancelled_at) {
    updateFields.cancelled_at = new Date().toISOString();
  }

  // Whitelist of allowed column names to prevent SQL injection
  const ALLOWED_COLUMNS = new Set([
    'status', 'filled_size', 'avg_fill_price', 'filled_at',
    'cancelled_at', 'error_message', 'position_id', 'fee_amount',
  ]);

  // Validate all column names against whitelist
  const invalidColumns = Object.keys(updateFields).filter(
    (key) => !ALLOWED_COLUMNS.has(key)
  );
  if (invalidColumns.length > 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      `Invalid update columns: ${invalidColumns.join(', ')}`,
      { invalidColumns, allowedColumns: [...ALLOWED_COLUMNS] }
    );
  }

  // Update database - column names are now validated against whitelist
  const keys = Object.keys(updateFields);
  const setClauses = keys
    .map((key, i) => `${key} = $${i + 1}`)
    .join(', ');
  const values = [...Object.values(updateFields), orderId];

  const updateResult = await persistence.run(
    `UPDATE orders SET ${setClauses} WHERE order_id = $${keys.length + 1}`,
    values
  );

  // Verify database update succeeded
  if (!updateResult || updateResult.changes !== 1) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.DATABASE_ERROR,
      'Failed to update order in database',
      { orderId, updateResult }
    );
  }

  // Record status change in stats
  recordStatusChange(newStatus);

  // Update intent if this is a terminal state
  if (order.intent_id) {
    if (
      [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REJECTED].includes(
        newStatus
      )
    ) {
      try {
        writeAhead.markCompleted(order.intent_id, {
          orderId,
          finalStatus: newStatus,
          ...updateFields,
        });
      } catch {
        // Intent may already be completed - that's OK
      }
    }
  }

  log.info('order_status_updated', {
    orderId,
    previousStatus: order.status,
    newStatus,
    ...updates,
  });

  // Return the updated order from DB
  return getOrderFromDb(orderId);
}

/**
 * Get a single order by ID (direct DB query)
 *
 * @param {string} orderId - Order ID
 * @returns {Promise<Object|undefined>} Order or undefined
 */
export async function getOrder(orderId) {
  return getOrderFromDb(orderId);
}

/**
 * Get all open orders (direct DB query)
 *
 * @returns {Promise<Object[]>} Array of open orders
 */
export async function getOpenOrders() {
  return getOpenOrdersFromDb();
}

/**
 * Get orders by window ID (direct DB query)
 *
 * @param {string} windowId - Window ID
 * @returns {Promise<Object[]>} Array of orders
 */
export async function getOrdersByWindow(windowId) {
  return getOrdersByWindowFromDb(windowId);
}

/**
 * Cancel an open order with write-ahead logging
 *
 * Flow:
 * 1. Validate order exists and is in cancellable state
 * 2. Log intent BEFORE API call
 * 3. Mark intent as executing
 * 4. Call Polymarket API
 * 5. Record latency and update order status
 * 6. Mark intent completed/failed
 *
 * @param {string} orderId - Order ID to cancel
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Cancel result { orderId, latencyMs, intentId }
 * @throws {OrderManagerError} If order not found, invalid state, or API error
 */
export async function cancelOrder(orderId, log) {
  // 0. Validate orderId parameter
  if (!orderId || typeof orderId !== 'string') {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'orderId is required and must be a string',
      { orderId }
    );
  }

  // 1. Get order from DB and validate it exists
  const order = await getOrderFromDb(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // 2. Validate order is in a cancellable state
  const cancellableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!cancellableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_CANCEL_STATE,
      `Cannot cancel order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // 3. Log intent BEFORE API call
  const intentId = await writeAhead.logIntent(
    writeAhead.INTENT_TYPES.CANCEL_ORDER,
    order.window_id,
    { orderId, orderStatus: order.status, requestedAt: new Date().toISOString() }
  );

  log.info('cancel_intent_logged', { intentId, orderId, currentStatus: order.status });

  // 4. Mark as executing
  writeAhead.markExecuting(intentId);

  // 5. Record start time for latency
  const startTime = Date.now();

  try {
    // 6. Call Polymarket API
    await polymarketClient.cancelOrder(orderId);

    // 7. Calculate latency
    const latencyMs = Date.now() - startTime;
    recordCancelLatency(latencyMs);

    // 8. Update order status
    await updateOrderStatus(orderId, OrderStatus.CANCELLED, {
      cancelled_at: new Date().toISOString(),
    }, log);

    // 9. Mark intent completed
    writeAhead.markCompleted(intentId, { orderId, latencyMs });

    log.info('order_cancelled', { orderId, latencyMs, intentId });

    return { orderId, latencyMs, intentId };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    // Record latency even on failure for monitoring
    recordCancelLatency(latencyMs);

    // ALWAYS mark failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'CANCEL_FAILED',
      message: err.message,
      latencyMs,
    });

    log.error('order_cancel_failed', {
      orderId,
      error: err.message,
      code: err.code,
      latencyMs,
    });

    throw new OrderManagerError(
      OrderManagerErrorCodes.CANCEL_FAILED,
      `Cancel order failed: ${err.message}`,
      { orderId, originalError: err.message, intentId }
    );
  }
}

/**
 * Cancel all open orders. Used by circuit breaker escalation.
 *
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Results { cancelled: string[], failed: { orderId, error }[] }
 */
export async function cancelAll(log) {
  const openOrders = await getOpenOrders();
  const cancelled = [];
  const failed = [];

  for (const order of openOrders) {
    try {
      await cancelOrder(order.order_id, log);
      cancelled.push(order.order_id);
    } catch (err) {
      failed.push({ orderId: order.order_id, error: err.message });
    }
  }

  log.info('cancel_all_complete', {
    total: openOrders.length,
    cancelled: cancelled.length,
    failed: failed.length,
  });

  return { cancelled, failed };
}

/**
 * Handle a partial fill event for an order
 *
 * Updates filled_size, avg_fill_price, and status based on fill progression.
 *
 * @param {string} orderId - Order ID
 * @param {number} fillSize - Size of this fill
 * @param {number} fillPrice - Price of this fill
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Updated order
 * @throws {OrderManagerError} If order not found or invalid state
 */
export async function handlePartialFill(orderId, fillSize, fillPrice, log) {
  // 0. Validate input parameters
  if (!orderId || typeof orderId !== 'string') {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'orderId is required and must be a string',
      { orderId }
    );
  }

  if (typeof fillSize !== 'number' || fillSize <= 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'fillSize must be a positive number',
      { fillSize }
    );
  }

  if (typeof fillPrice !== 'number' || fillPrice < 0.01 || fillPrice > 0.99) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'fillPrice must be a number between 0.01 and 0.99',
      { fillPrice }
    );
  }

  // 1. Get order from DB and validate it exists
  const order = await getOrderFromDb(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // 2. Validate order is in a fillable state
  const fillableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!fillableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Cannot fill order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // 3. Calculate new cumulative filled size
  const previousFilledSize = order.filled_size || 0;
  const previousAvgPrice = order.avg_fill_price || fillPrice;
  const newFilledSize = previousFilledSize + fillSize;

  // 4. Calculate weighted average price
  // (previousSize * previousPrice + newSize * newPrice) / totalSize
  // Round to 8 decimal places to avoid floating-point precision issues
  const rawAvgPrice =
    previousFilledSize > 0
      ? (previousFilledSize * previousAvgPrice + fillSize * fillPrice) / newFilledSize
      : fillPrice;
  const newAvgPrice = Math.round(rawAvgPrice * 1e8) / 1e8;

  // 5. Determine new status
  const isFullyFilled = newFilledSize >= order.size;
  const newStatus = isFullyFilled ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;

  // 6. Build updates
  const updates = {
    filled_size: newFilledSize,
    avg_fill_price: newAvgPrice,
  };

  if (isFullyFilled) {
    updates.filled_at = new Date().toISOString();
  }

  // 7. Update order (uses existing updateOrderStatus which handles DB)
  await updateOrderStatus(orderId, newStatus, updates, log);

  // 8. Update stats for partial fills
  if (newStatus === OrderStatus.PARTIALLY_FILLED) {
    recordPartialFill();
  }

  log.info('partial_fill_processed', {
    orderId,
    fillSize,
    fillPrice,
    newFilledSize,
    newAvgPrice,
    newStatus,
  });

  return await getOrderFromDb(orderId);
}

/**
 * Get all partially filled orders (direct DB query)
 *
 * @returns {Promise<Object[]>} Array of partially filled orders
 */
export async function getPartiallyFilledOrders() {
  return persistence.all(
    'SELECT * FROM orders WHERE status = $1',
    [OrderStatus.PARTIALLY_FILLED]
  );
}
