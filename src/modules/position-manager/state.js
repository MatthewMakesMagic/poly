/**
 * Position Manager State (V3 Stage 4: DB as single source of truth)
 *
 * All position queries go directly to PostgreSQL.
 * No in-memory cache.
 */

import persistence from '../../persistence/index.js';
import { PositionStatus } from './types.js';

/**
 * Last reconciliation result
 * @type {Object|null}
 */
let lastReconciliation = null;

/**
 * Get a position by ID from DB
 * @param {number} positionId - Position ID
 * @returns {Promise<Object|undefined>} Position object or undefined
 */
export async function getPosition(positionId) {
  return persistence.get('SELECT * FROM positions WHERE id = $1', [positionId]);
}

/**
 * Get open positions from DB
 * @returns {Promise<Object[]>} Array of open positions
 */
export async function getOpenPositions() {
  return persistence.all(
    'SELECT * FROM positions WHERE status = $1',
    [PositionStatus.OPEN]
  );
}

/**
 * Calculate total exposure across all open positions
 * @returns {Promise<number>} Total exposure
 */
export async function calculateTotalExposure() {
  const result = await persistence.get(
    `SELECT COALESCE(SUM(size * entry_price), 0) as total FROM positions WHERE status = $1`,
    [PositionStatus.OPEN]
  );
  return Number(result?.total || 0);
}

/**
 * Count open positions for a specific market
 * @param {string} marketId - Market ID
 * @returns {Promise<number>} Number of open positions in the market
 */
export async function countPositionsByMarket(marketId) {
  const result = await persistence.get(
    `SELECT COUNT(*) as count FROM positions WHERE status = $1 AND market_id = $2`,
    [PositionStatus.OPEN, marketId]
  );
  return Number(result?.count || 0);
}

/**
 * Get current state statistics from DB
 * @returns {Promise<Object>} State statistics
 */
export async function getStats() {
  const result = await persistence.get(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open') as open_count,
       COUNT(*) FILTER (WHERE status = 'closed') as closed_count,
       COUNT(*) as total_count,
       COALESCE(SUM(pnl) FILTER (WHERE status = 'closed'), 0) as total_pnl
     FROM positions`
  );

  return {
    positions: {
      open: Number(result?.open_count || 0),
      closed: Number(result?.closed_count || 0),
    },
    stats: {
      totalOpened: Number(result?.total_count || 0),
      totalClosed: Number(result?.closed_count || 0),
      totalPnl: Number(result?.total_pnl || 0),
    },
  };
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

/**
 * Clear state (for shutdown/testing)
 */
export function clearState() {
  lastReconciliation = null;
}
