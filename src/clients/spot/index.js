/**
 * Spot Price Client Module
 *
 * Public interface for real-time spot price data.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Wraps Pyth Network price feeds with:
 * - Consistent error handling (SpotClientError)
 * - Automatic reconnection with exponential backoff
 * - Price normalization to consistent format
 * - Subscription pattern for real-time updates
 *
 * @module clients/spot
 */

import { child } from '../../modules/logger/index.js';
import { SpotClient } from './client.js';
import {
  SpotClientError,
  SpotClientErrorCodes,
  SUPPORTED_CRYPTOS,
} from './types.js';

// Module state
let client = null;
let log = null;

/**
 * Initialize the spot client module
 *
 * @param {Object} config - Configuration object
 * @param {Object} [config.spot] - Spot client configuration
 * @param {string} [config.spot.hermesUrl] - Pyth Hermes URL
 * @param {number} [config.spot.pollIntervalMs] - Polling interval (default: 1000)
 * @param {number} [config.spot.staleThresholdMs] - Staleness threshold (default: 10000)
 * @param {number} [config.spot.maxConsecutiveErrors] - Max errors before disable (default: 10)
 * @returns {Promise<void>}
 */
export async function init(config = {}) {
  // Create child logger for this module
  log = child({ module: 'spot-client' });

  log.info('module_init_start');

  // Extract spot config
  const spotConfig = config.spot || {};

  // Create and initialize client
  client = new SpotClient({ logger: log });
  await client.initialize(spotConfig);

  log.info('module_initialized', {
    connected: client.connected,
  });
}

/**
 * Get current price for a cryptocurrency
 *
 * @param {string} crypto - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @returns {Object|null} Normalized price: { price, timestamp, source, staleness, raw }
 * @throws {SpotClientError} If not initialized or invalid crypto
 */
export function getCurrentPrice(crypto) {
  ensureInitialized();
  return client.getCurrentPrice(crypto);
}

/**
 * Subscribe to price updates for a cryptocurrency
 *
 * @param {string} crypto - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Function} callback - Callback invoked on each price update: (price) => void
 * @returns {Function} Unsubscribe function - call to stop receiving updates
 * @throws {SpotClientError} If not initialized or invalid crypto
 */
export function subscribe(crypto, callback) {
  ensureInitialized();
  return client.subscribe(crypto, callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including:
 *   - initialized: boolean
 *   - connected: boolean
 *   - disabled: boolean
 *   - prices: { [crypto]: { price, timestamp, source, staleness } }
 *   - consecutiveErrors: number
 *   - stats: { requests, errors, reconnects, priceUpdates }
 */
export function getState() {
  if (!client) {
    return {
      initialized: false,
      connected: false,
      disabled: false,
      prices: {},
      lastUpdate: {},
      consecutiveErrors: 0,
      reconnectAttempts: 0,
      stats: { requests: 0, errors: 0, reconnects: 0, priceUpdates: 0 },
      subscriberCounts: {},
    };
  }

  return client.getState();
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

  if (client) {
    await client.shutdown();
    client = null;
  }

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure client is initialized
 * @throws {SpotClientError} If not initialized
 */
function ensureInitialized() {
  if (!client || !client.initialized) {
    throw new SpotClientError(
      SpotClientErrorCodes.NOT_INITIALIZED,
      'Spot client not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export { SpotClientError, SpotClientErrorCodes, SUPPORTED_CRYPTOS };
