/**
 * Safety Module
 *
 * Public interface for safety controls including drawdown tracking and limit enforcement.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Track daily realized and unrealized P&L
 * - Calculate current and maximum drawdown
 * - Maintain trade statistics (count, wins, losses)
 * - Enforce drawdown limits with auto-stop (Story 4.4)
 * - Manual reset for auto-stop recovery
 *
 * @module modules/safety
 */

import { child } from '../logger/index.js';
import { SafetyError, SafetyErrorCodes } from './types.js';
import {
  setConfig,
  clearCache,
  getStateSnapshot,
  isAutoStopped as checkAutoStopped,
  loadAutoStopState,
  clearAutoStopState,
} from './state.js';
import {
  getOrCreateTodayRecord,
  recordRealizedPnl as recordPnl,
  updateUnrealizedPnl as updateUnrealized,
  getDrawdownStatus as getStatus,
  isCacheStale,
  checkDrawdownLimit as checkLimit,
  resetAutoStop as doResetAutoStop,
} from './drawdown.js';

// Module state
let log = null;
let initialized = false;
let orderManagerRef = null;

/**
 * Initialize the safety module
 *
 * Creates or loads today's daily performance record and sets up
 * the module for tracking drawdown throughout the trading day.
 * Also loads any persisted auto-stop state from previous session.
 *
 * @param {Object} config - Configuration object
 * @param {Object} config.safety - Safety-specific configuration
 * @param {number} config.safety.startingCapital - Starting capital for the day
 * @param {number} [config.safety.drawdownWarningPct] - Warning threshold (default: 0.03)
 * @param {Object} config.risk - Risk configuration
 * @param {number} config.risk.dailyDrawdownLimit - Daily drawdown limit (default: 0.05)
 * @returns {Promise<void>}
 */
export async function init(config) {
  if (initialized) {
    throw new SafetyError(
      SafetyErrorCodes.ALREADY_INITIALIZED,
      'Safety module already initialized',
      {}
    );
  }

  // Create child logger for this module
  log = child({ module: 'safety' });
  log.info('module_init_start');

  // Store configuration
  setConfig(config);

  // Initialize today's record (creates if doesn't exist)
  getOrCreateTodayRecord(log);

  // Load persisted auto-stop state from database (if exists and current day)
  const persistedState = await loadAutoStopState(log);
  if (persistedState && persistedState.autoStopped) {
    log.warn('auto_stop_restored', {
      event: 'auto_stop_active_on_startup',
      reason: persistedState.autoStopReason,
      stoppedAt: persistedState.autoStoppedAt,
    });
  }

  initialized = true;
  log.info('module_initialized', {
    autoStopped: checkAutoStopped(),
  });
}

/**
 * Set reference to order manager for auto-stop order cancellation
 *
 * @param {Object} orderManager - Order manager module reference
 */
export function setOrderManager(orderManager) {
  orderManagerRef = orderManager;
}

/**
 * Record realized P&L from a closed position
 *
 * Should be called when a position closes to update daily performance.
 * This is typically called by the position manager after a position close.
 *
 * @param {number} pnl - Realized P&L amount (positive for profit, negative for loss)
 * @returns {Object} Updated daily performance record
 * @throws {SafetyError} If module not initialized or invalid amount
 */
export function recordRealizedPnl(pnl) {
  ensureInitialized();
  return recordPnl(pnl, log);
}

/**
 * Update unrealized P&L from open positions
 *
 * Should be called periodically by the orchestrator to update
 * the total unrealized P&L from all open positions.
 *
 * @param {number} unrealizedPnl - Total unrealized P&L across all positions
 * @returns {Object} Updated daily performance record
 * @throws {SafetyError} If module not initialized or invalid amount
 */
export function updateUnrealizedPnl(unrealizedPnl) {
  ensureInitialized();
  return updateUnrealized(unrealizedPnl, log);
}

/**
 * Get current drawdown status
 *
 * Returns comprehensive drawdown information for risk assessment.
 * Can be called frequently as it reads from cache.
 *
 * @returns {Object} Drawdown status including:
 *   - initialized: boolean
 *   - date: string (YYYY-MM-DD)
 *   - starting_balance: number
 *   - current_balance: number
 *   - effective_balance: number (current + unrealized)
 *   - realized_pnl: number
 *   - unrealized_pnl: number
 *   - drawdown_pct: number (realized drawdown)
 *   - max_drawdown_pct: number (worst drawdown today)
 *   - total_drawdown_pct: number (including unrealized)
 *   - trades_count: number
 *   - wins: number
 *   - losses: number
 *   - updated_at: string (ISO timestamp)
 */
export function getDrawdownStatus() {
  ensureInitialized();

  // Refresh cache if date changed (midnight rollover)
  if (isCacheStale()) {
    getOrCreateTodayRecord(log);
    // Also clear auto-stop on new day
    clearAutoStopState();
  }

  return getStatus();
}

/**
 * Check drawdown limit and trigger auto-stop if breached
 *
 * Should be called by the orchestrator before evaluating entry signals.
 * If the limit is breached, auto-stop is triggered automatically.
 *
 * @returns {Object} Drawdown limit status:
 *   - breached: boolean (true if limit exceeded)
 *   - current: number (current total drawdown percentage)
 *   - limit: number (configured limit percentage)
 *   - autoStopped: boolean (true if auto-stop is active)
 */
export function checkDrawdownLimit() {
  ensureInitialized();

  // Refresh cache if date changed (midnight rollover)
  if (isCacheStale()) {
    getOrCreateTodayRecord(log);
    // Also clear auto-stop on new day
    clearAutoStopState();
  }

  return checkLimit(log, orderManagerRef);
}

/**
 * Check if auto-stop is currently active
 *
 * Fast check that reads from in-memory state.
 *
 * @returns {boolean} True if auto-stop is active
 */
export function isAutoStopped() {
  return checkAutoStopped();
}

/**
 * Reset auto-stop state (manual resume)
 *
 * Requires explicit confirmation to prevent accidental reset.
 * System does NOT auto-resume - this is the only way to resume.
 *
 * @param {Object} [options={}] - Reset options
 * @param {boolean} options.confirm - Must be true to confirm reset
 * @throws {SafetyError} If confirm is not true
 */
export async function resetAutoStop(options = {}) {
  ensureInitialized();
  await doResetAutoStop(options, log);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including initialization status, drawdown info, and auto-stop status
 */
export function getState() {
  const stateSnapshot = getStateSnapshot();
  const drawdown = initialized ? getStatus() : null;

  return {
    initialized,
    ...stateSnapshot,
    drawdown,
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Clear the cache
  clearCache();

  // Clear order manager reference
  orderManagerRef = null;

  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {SafetyError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new SafetyError(
      SafetyErrorCodes.NOT_INITIALIZED,
      'Safety module not initialized. Call init() first.',
      {}
    );
  }
}

// Re-export types and constants
export { SafetyError, SafetyErrorCodes } from './types.js';
