/**
 * Virtual Position Manager
 *
 * Manages virtual (paper trading) positions for PAPER mode.
 * Enables stop-loss and take-profit evaluation without real positions.
 *
 * Virtual positions are created when paper_mode_signal is generated and
 * tracked in memory. The stop-loss and take-profit modules can evaluate
 * these positions to simulate real trading behavior.
 *
 * @module modules/virtual-position-manager
 */

import { child } from '../logger/index.js';

// Module state
let log = null;
let config = null;
let initialized = false;

// In-memory virtual position store
// Map of positionId -> position object
const virtualPositions = new Map();

// High-water marks for trailing stop (separate from take-profit module's tracking)
// This allows virtual positions to have their own HWM tracking
const highWaterMarks = new Map();

// Position ID counter
let nextPositionId = 1;

/**
 * Initialize the virtual position manager
 *
 * @param {Object} cfg - Configuration object
 * @returns {Promise<void>}
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  log = child({ module: 'virtual-position-manager' });
  config = cfg;

  log.info('module_init_start');

  // Clear any existing state
  virtualPositions.clear();
  highWaterMarks.clear();
  nextPositionId = 1;

  initialized = true;
  log.info('module_initialized');
}

/**
 * Create a virtual position from a paper mode signal
 *
 * @param {Object} signal - The paper mode signal
 * @param {string} signal.window_id - Window ID
 * @param {string} [signal.token_id] - Token ID
 * @param {string} [signal.market_id] - Market ID
 * @param {string} signal.direction - 'long' (or 'short')
 * @param {string} [signal.side] - 'UP' or 'DOWN'
 * @param {number} signal.market_price - Entry price (token price at signal time)
 * @param {number} signal.confidence - Model probability
 * @param {number} signal.edge - Edge at entry
 * @param {string} [signal.strategy_id] - Strategy identifier
 * @param {number} [signal.size] - Position size (defaults to config or 1)
 * @param {string} [signal.symbol] - Crypto symbol (btc, eth, etc.)
 * @returns {Object} Created virtual position
 */
export function createVirtualPosition(signal) {
  ensureInitialized();

  const positionId = `vp-${nextPositionId++}`;
  const now = new Date().toISOString();

  const position = {
    id: positionId,
    type: 'virtual',
    window_id: signal.window_id,
    token_id: signal.token_id,
    market_id: signal.market_id,
    side: signal.direction || 'long',
    token_side: signal.side || 'UP',  // UP or DOWN token
    size: signal.size || config?.strategy?.sizing?.baseSizeDollars || 2,
    entry_price: signal.market_price,
    current_price: signal.market_price,
    confidence: signal.confidence,
    edge_at_entry: signal.edge,
    strategy_id: signal.strategy_id || 'default',
    symbol: signal.symbol,
    status: 'open',
    created_at: now,
    updated_at: now,
    // Track P&L
    unrealized_pnl: 0,
    unrealized_pnl_pct: 0,
    // Track peak for trailing stop
    peak_price: signal.market_price,
    peak_pnl_pct: 0,
  };

  virtualPositions.set(positionId, position);

  // Initialize high-water mark tracking
  highWaterMarks.set(positionId, {
    highWaterMark: signal.market_price,
    trailingActive: false,
    activatedAt: null,
  });

  log.info('virtual_position_created', {
    position_id: positionId,
    window_id: signal.window_id,
    side: position.side,
    token_side: position.token_side,
    entry_price: position.entry_price,
    size: position.size,
    symbol: position.symbol,
    edge_at_entry: position.edge_at_entry,
  });

  return position;
}

/**
 * Get all open virtual positions
 *
 * @returns {Object[]} Array of open virtual positions
 */
export function getPositions() {
  ensureInitialized();
  return Array.from(virtualPositions.values()).filter(p => p.status === 'open');
}

/**
 * Get a single virtual position by ID
 *
 * @param {string} positionId - Position ID
 * @returns {Object|undefined} Position or undefined
 */
export function getPosition(positionId) {
  ensureInitialized();
  return virtualPositions.get(positionId);
}

/**
 * Get all virtual positions (including closed)
 *
 * @returns {Object[]} Array of all virtual positions
 */
export function getAllPositions() {
  ensureInitialized();
  return Array.from(virtualPositions.values());
}

/**
 * Update the current price for a virtual position
 *
 * @param {string} positionId - Position ID
 * @param {number} newPrice - New current price
 * @returns {Object} Updated position
 */
export function updatePrice(positionId, newPrice) {
  ensureInitialized();

  const position = virtualPositions.get(positionId);
  if (!position) {
    log.warn('virtual_position_not_found', { position_id: positionId });
    return null;
  }

  if (position.status !== 'open') {
    return position;  // Don't update closed positions
  }

  const previousPrice = position.current_price;
  position.current_price = newPrice;
  position.updated_at = new Date().toISOString();

  // Calculate unrealized P&L
  // For long positions: profit when price rises
  const priceMove = position.side === 'long'
    ? newPrice - position.entry_price
    : position.entry_price - newPrice;

  position.unrealized_pnl = position.size * priceMove;
  position.unrealized_pnl_pct = priceMove / position.entry_price;

  // Update peak tracking for trailing stop
  if (position.side === 'long' && newPrice > position.peak_price) {
    position.peak_price = newPrice;
    position.peak_pnl_pct = position.unrealized_pnl_pct;

    // Update high-water mark
    const hwm = highWaterMarks.get(positionId);
    if (hwm) {
      hwm.highWaterMark = newPrice;
    }
  } else if (position.side === 'short' && newPrice < position.peak_price) {
    position.peak_price = newPrice;
    position.peak_pnl_pct = position.unrealized_pnl_pct;

    // Update high-water mark (for short, lower is better)
    const hwm = highWaterMarks.get(positionId);
    if (hwm) {
      hwm.highWaterMark = newPrice;
    }
  }

  return position;
}

/**
 * Update prices for all open positions based on spot prices
 *
 * @param {Object} spotPrices - Map of symbol -> price data
 * @param {Object} marketPrices - Map of window_id -> token price (0-1)
 * @returns {number} Number of positions updated
 */
export function updateAllPrices(spotPrices, marketPrices = {}) {
  ensureInitialized();

  let updated = 0;
  const positions = getPositions();

  for (const position of positions) {
    // Try to get market price for this window
    let newPrice = null;

    // First try direct market price (token price)
    if (marketPrices[position.window_id]) {
      newPrice = marketPrices[position.window_id];
    }
    // Fall back to using entry price (no update available)
    // In real implementation, we'd fetch from Polymarket API

    if (newPrice !== null) {
      updatePrice(position.id, newPrice);
      updated++;
    }
  }

  return updated;
}

/**
 * Close a virtual position
 *
 * @param {string} positionId - Position ID
 * @param {Object} params - Close parameters
 * @param {number} [params.closePrice] - Price at close
 * @param {string} [params.reason] - Reason for close (stop_loss, take_profit, manual, expiry)
 * @returns {Object} Closed position with final P&L
 */
export function closePosition(positionId, params = {}) {
  ensureInitialized();

  const position = virtualPositions.get(positionId);
  if (!position) {
    log.warn('virtual_position_not_found_for_close', { position_id: positionId });
    return null;
  }

  if (position.status !== 'open') {
    log.warn('virtual_position_already_closed', { position_id: positionId });
    return position;
  }

  const closePrice = params.closePrice || position.current_price;
  const reason = params.reason || 'manual';
  const now = new Date().toISOString();

  // Calculate final P&L
  const priceMove = position.side === 'long'
    ? closePrice - position.entry_price
    : position.entry_price - closePrice;

  const realizedPnl = position.size * priceMove;
  const realizedPnlPct = priceMove / position.entry_price;

  // Update position to closed
  position.status = 'closed';
  position.close_price = closePrice;
  position.close_reason = reason;
  position.closed_at = now;
  position.updated_at = now;
  position.realized_pnl = realizedPnl;
  position.realized_pnl_pct = realizedPnlPct;

  // Clean up high-water mark tracking
  highWaterMarks.delete(positionId);

  log.info('virtual_position_closed', {
    position_id: positionId,
    window_id: position.window_id,
    side: position.side,
    token_side: position.token_side,
    entry_price: position.entry_price,
    close_price: closePrice,
    reason,
    realized_pnl: realizedPnl,
    realized_pnl_pct: (realizedPnlPct * 100).toFixed(2) + '%',
    peak_pnl_pct: (position.peak_pnl_pct * 100).toFixed(2) + '%',
    held_duration_ms: new Date(now) - new Date(position.created_at),
  });

  return position;
}

/**
 * Get high-water mark data for a position (for trailing stop)
 *
 * @param {string} positionId - Position ID
 * @returns {Object|null} High-water mark data
 */
export function getHighWaterMark(positionId) {
  return highWaterMarks.get(positionId) || null;
}

/**
 * Activate trailing stop for a position
 *
 * @param {string} positionId - Position ID
 * @param {number} activationPrice - Price at activation
 */
export function activateTrailing(positionId, activationPrice) {
  const hwm = highWaterMarks.get(positionId);
  if (hwm && !hwm.trailingActive) {
    hwm.trailingActive = true;
    hwm.activatedAt = new Date().toISOString();
    hwm.activationPrice = activationPrice;

    log.info('virtual_trailing_activated', {
      position_id: positionId,
      activation_price: activationPrice,
      high_water_mark: hwm.highWaterMark,
    });
  }
}

/**
 * Check if position has trailing stop active
 *
 * @param {string} positionId - Position ID
 * @returns {boolean} Whether trailing is active
 */
export function isTrailingActive(positionId) {
  const hwm = highWaterMarks.get(positionId);
  return hwm?.trailingActive || false;
}

/**
 * Get module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  const positions = Array.from(virtualPositions.values());
  const openPositions = positions.filter(p => p.status === 'open');
  const closedPositions = positions.filter(p => p.status === 'closed');

  // Calculate aggregate stats
  const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
  const totalRealizedPnl = closedPositions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);

  return {
    initialized,
    stats: {
      total_positions: positions.length,
      open_positions: openPositions.length,
      closed_positions: closedPositions.length,
      total_unrealized_pnl: totalUnrealizedPnl,
      total_realized_pnl: totalRealizedPnl,
      next_position_id: nextPositionId,
    },
    positions: {
      open: openPositions,
      closed: closedPositions,
    },
  };
}

/**
 * Shutdown the module
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start', {
      open_positions: getPositions().length,
    });
  }

  // Log final state before clearing
  const state = getState();
  if (log) {
    log.info('virtual_positions_final_summary', {
      total_realized_pnl: state.stats.total_realized_pnl,
      total_unrealized_pnl: state.stats.total_unrealized_pnl,
      closed_positions: state.stats.closed_positions,
      open_positions_abandoned: state.stats.open_positions,
    });
  }

  // Clear state
  virtualPositions.clear();
  highWaterMarks.clear();
  nextPositionId = 1;
  config = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {Error} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new Error('Virtual position manager not initialized. Call init() first.');
  }
}

/**
 * Export for testing
 */
export const _internals = {
  virtualPositions,
  highWaterMarks,
};
