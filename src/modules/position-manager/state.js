/**
 * Position Manager State
 *
 * In-memory position tracking for fast access.
 * Synchronized with database for persistence.
 */

import { PositionStatus } from './types.js';

/**
 * In-memory position cache
 * Key: position id (number), Value: position object
 * @type {Map<number, Object>}
 */
const positionCache = new Map();

/**
 * Module statistics
 */
const stats = {
  totalOpened: 0,
  totalClosed: 0,
  totalPnl: 0,
};

/**
 * Last reconciliation result
 * @type {Object|null}
 */
let lastReconciliation = null;

/**
 * Add a position to the cache
 * @param {Object} position - Position object
 * @param {boolean} [isNew=true] - Whether this is a newly opened position (affects stats)
 */
export function cachePosition(position, isNew = true) {
  positionCache.set(position.id, { ...position });
  // Only increment totalOpened for new positions, not when loading from DB
  if (isNew && position.status === PositionStatus.OPEN) {
    stats.totalOpened++;
  }
}

/**
 * Get a position from the cache
 * @param {number} positionId - Position ID
 * @returns {Object|undefined} Position object or undefined
 */
export function getCachedPosition(positionId) {
  const position = positionCache.get(positionId);
  return position ? { ...position } : undefined;
}

/**
 * Update a position in the cache
 * Only specified fields in updates are applied - full position objects should not be passed.
 * @param {number} positionId - Position ID
 * @param {Object} updates - Specific fields to update (not a full position object)
 * @returns {Object|undefined} Updated position or undefined if not found
 */
export function updateCachedPosition(positionId, updates) {
  const position = positionCache.get(positionId);
  if (!position) {
    return undefined;
  }

  // Only apply known position fields to avoid corrupting the cached position
  const allowedFields = [
    'current_price',
    'status',
    'closed_at',
    'close_price',
    'pnl',
    'exchange_verified_at',
  ];

  const safeUpdates = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      safeUpdates[field] = updates[field];
    }
  }

  const updated = { ...position, ...safeUpdates };
  positionCache.set(positionId, updated);

  // Update stats based on status change
  if (safeUpdates.status === PositionStatus.CLOSED && position.status !== PositionStatus.CLOSED) {
    stats.totalClosed++;
    if (safeUpdates.pnl !== undefined) {
      stats.totalPnl += safeUpdates.pnl;
    }
  }

  return { ...updated };
}

/**
 * Get all cached positions matching a filter
 * @param {Function} [filterFn] - Filter function
 * @returns {Object[]} Array of matching positions
 */
export function getCachedPositions(filterFn) {
  const positions = [];
  for (const position of positionCache.values()) {
    if (!filterFn || filterFn(position)) {
      positions.push({ ...position });
    }
  }
  return positions;
}

/**
 * Get open positions from cache
 * @returns {Object[]} Array of open positions
 */
export function getCachedOpenPositions() {
  return getCachedPositions((position) => position.status === PositionStatus.OPEN);
}

/**
 * Get current state statistics
 * @returns {Object} State statistics
 */
export function getStats() {
  const openCount = getCachedOpenPositions().length;
  const closedCount = getCachedPositions(
    (p) => p.status === PositionStatus.CLOSED
  ).length;

  return {
    positions: {
      open: openCount,
      closed: closedCount,
    },
    stats: {
      totalOpened: stats.totalOpened,
      totalClosed: stats.totalClosed,
      totalPnl: stats.totalPnl,
    },
  };
}

/**
 * Clear all cached positions
 * Used during shutdown or testing
 */
export function clearCache() {
  positionCache.clear();
  stats.totalOpened = 0;
  stats.totalClosed = 0;
  stats.totalPnl = 0;
  lastReconciliation = null;
}

/**
 * Load positions into cache from database
 * Positions loaded this way are not counted as "new" for stats
 * @param {Object[]} positions - Array of positions from database
 */
export function loadPositionsIntoCache(positions) {
  for (const position of positions) {
    // Use cachePosition with isNew=false to avoid incrementing stats
    cachePosition(position, false);
  }
}

/**
 * Calculate total exposure across all open positions
 * Exposure is the sum of (size * entry_price) for all open positions
 * @returns {number} Total exposure
 */
export function calculateTotalExposure() {
  let totalExposure = 0;
  for (const position of positionCache.values()) {
    if (position.status === PositionStatus.OPEN) {
      totalExposure += position.size * position.entry_price;
    }
  }
  return totalExposure;
}

/**
 * Count open positions for a specific market
 * @param {string} marketId - Market ID
 * @returns {number} Number of open positions in the market
 */
export function countPositionsByMarket(marketId) {
  let count = 0;
  for (const position of positionCache.values()) {
    if (position.status === PositionStatus.OPEN && position.market_id === marketId) {
      count++;
    }
  }
  return count;
}

/**
 * Set the last reconciliation result
 * @param {Object} result - Reconciliation result
 */
export function setLastReconciliation(result) {
  lastReconciliation = result ? { ...result } : null;
}

/**
 * Get the last reconciliation result
 * @returns {Object|null} Last reconciliation result
 */
export function getLastReconciliation() {
  return lastReconciliation ? { ...lastReconciliation } : null;
}
