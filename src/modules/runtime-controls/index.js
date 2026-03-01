/**
 * Runtime Controls Module
 *
 * DB-driven runtime controls for kill switch, trading mode, position limits,
 * and strategy/instrument filters. Replaces Railway env var dependency.
 *
 * Features:
 * - Cached reads (1s TTL) for low-latency access from execution loop
 * - 3-level kill switch: 'pause', 'flatten', 'emergency'
 * - Standard module interface: init(), getState(), shutdown()
 *
 * @module modules/runtime-controls
 */

import persistence from '../../persistence/index.js';
import { child } from '../logger/index.js';

// Module state
let log = null;
let initialized = false;

// Cache with 1s TTL
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 1000;

// Valid kill switch levels (ordered by severity)
const KILL_SWITCH_LEVELS = ['off', 'pause', 'flatten', 'emergency'];

/**
 * Initialize the runtime controls module
 *
 * @param {Object} _cfg - Configuration object (unused, controls live in DB)
 * @returns {Promise<void>}
 */
export async function init(_cfg) {
  if (initialized) return;

  log = child({ module: 'runtime-controls' });
  log.info('module_init_start');

  // Pre-warm cache
  await refreshCache();

  initialized = true;
  log.info('module_initialized', { controls: cache });
}

/**
 * Read a single control value from DB (cached 1s)
 *
 * @param {string} key - Control key
 * @returns {Promise<string|null>} Control value or null if not found
 */
export async function getControl(key) {
  const controls = await getAllControls();
  return controls[key] ?? null;
}

/**
 * Read all controls from DB (cached 1s)
 *
 * @returns {Promise<Object>} Map of key -> value
 */
export async function getAllControls() {
  if (cache && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cache;
  }
  return refreshCache();
}

/**
 * Update a single control value in DB
 *
 * @param {string} key - Control key
 * @param {string} value - New value
 * @returns {Promise<Object>} Updated control { key, value, updated_at }
 */
export async function updateControl(key, value) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('key must be a non-empty string');
  }
  if (typeof value !== 'string') {
    throw new Error('value must be a string');
  }

  // Validate kill switch values
  if (key === 'kill_switch' && !KILL_SWITCH_LEVELS.includes(value)) {
    throw new Error(
      `Invalid kill_switch value: '${value}'. Must be one of: ${KILL_SWITCH_LEVELS.join(', ')}`
    );
  }

  // Validate trading_mode values
  if (key === 'trading_mode' && !['PAPER', 'LIVE'].includes(value)) {
    throw new Error(`Invalid trading_mode value: '${value}'. Must be 'PAPER' or 'LIVE'`);
  }

  await persistence.run(
    `INSERT INTO runtime_controls (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );

  // Invalidate cache
  cache = null;
  cacheTimestamp = 0;

  if (log) {
    log.info('control_updated', { key, value });
  }

  return { key, value, updated_at: new Date().toISOString() };
}

/**
 * Check if the kill switch is active (any level above 'off')
 *
 * @returns {Promise<boolean>}
 */
export async function isKillSwitchActive() {
  const level = await getControl('kill_switch');
  return level !== null && level !== 'off';
}

/**
 * Get kill switch level
 *
 * @returns {Promise<string>} 'off' | 'pause' | 'flatten' | 'emergency'
 */
export async function getKillSwitchLevel() {
  return (await getControl('kill_switch')) || 'off';
}

/**
 * Get effective trading mode (DB value overrides env var)
 *
 * @returns {Promise<string>} 'PAPER' | 'LIVE'
 */
export async function getTradingMode() {
  return (await getControl('trading_mode')) || 'PAPER';
}

/**
 * Get current module state
 *
 * @returns {Object}
 */
export function getState() {
  return {
    initialized,
    cached: cache !== null,
    cacheAgeMs: cache ? Date.now() - cacheTimestamp : null,
    controls: cache || {},
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) log.info('module_shutdown');
  cache = null;
  cacheTimestamp = 0;
  initialized = false;
  log = null;
}

/**
 * Refresh cache from DB
 * @private
 */
async function refreshCache() {
  try {
    const rows = await persistence.all(
      'SELECT key, value FROM runtime_controls ORDER BY key'
    );
    cache = {};
    for (const row of rows) {
      cache[row.key] = row.value;
    }
    cacheTimestamp = Date.now();
    return cache;
  } catch (err) {
    if (log) {
      log.warn('cache_refresh_failed', { error: err.message });
    }
    // Return stale cache or empty object
    return cache || {};
  }
}

// Export constants for consumers
export { KILL_SWITCH_LEVELS };
