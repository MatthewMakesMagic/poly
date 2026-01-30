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
 */
export function cachePosition(position) {
  positionCache.set(position.id, { ...position });
  stats.totalOpened++;
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
 * @param {number} positionId - Position ID
 * @param {Object} updates - Fields to update
 * @returns {Object|undefined} Updated position or undefined if not found
 */
export function updateCachedPosition(positionId, updates) {
  const position = positionCache.get(positionId);
  if (!position) {
    return undefined;
  }

  const updated = { ...position, ...updates };
  positionCache.set(positionId, updated);

  // Update stats based on status change
  if (updates.status === PositionStatus.CLOSED && position.status !== PositionStatus.CLOSED) {
    stats.totalClosed++;
    if (updates.pnl !== undefined) {
      stats.totalPnl += updates.pnl;
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
 * @param {Object[]} positions - Array of positions from database
 */
export function loadPositionsIntoCache(positions) {
  for (const position of positions) {
    positionCache.set(position.id, { ...position });
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
