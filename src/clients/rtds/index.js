/**
 * RTDS (Real Time Data Socket) Client Module
 *
 * Public interface for real-time price data from Polymarket's WebSocket feed.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Provides:
 * - Binance-sourced prices (crypto_prices topic) - what the UI shows
 * - Chainlink oracle prices (crypto_prices_chainlink topic) - settlement source
 *
 * @module clients/rtds
 */

import { child } from '../../modules/logger/index.js';
import { RTDSClient } from './client.js';
import {
  RTDSError,
  RTDSErrorCodes,
  SUPPORTED_SYMBOLS,
  TOPICS,
} from './types.js';

// Module state
let client = null;
let log = null;

/**
 * Initialize the RTDS client module
 *
 * @param {Object} config - Configuration object
 * @param {Object} [config.rtds] - RTDS client configuration
 * @param {string} [config.rtds.url] - WebSocket URL (default: wss://ws-live-data.polymarket.com)
 * @param {number} [config.rtds.reconnectIntervalMs] - Initial reconnect delay (default: 1000)
 * @param {number} [config.rtds.maxReconnectIntervalMs] - Max reconnect delay (default: 30000)
 * @param {number} [config.rtds.staleThresholdMs] - Stale data warning threshold (default: 5000)
 * @param {string[]} [config.rtds.symbols] - Symbols to track (default: ['btc', 'eth', 'sol', 'xrp'])
 * @returns {Promise<void>}
 */
export async function init(config = {}) {
  // Create child logger for this module
  log = child({ module: 'rtds-client' });

  log.info('module_init_start');

  // Extract rtds config
  const rtdsConfig = config.rtds || {};

  // Create and initialize client
  client = new RTDSClient({ logger: log });
  await client.initialize(rtdsConfig);

  log.info('module_initialized', {
    connected: client.connectionState === 'connected',
  });
}

/**
 * Get current price for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {string} [topic] - Optional topic filter (crypto_prices or crypto_prices_chainlink)
 * @returns {Object|null} Price data: { price, timestamp, staleness_ms } or null if unavailable
 * @throws {RTDSError} If not initialized or invalid symbol/topic
 */
export function getCurrentPrice(symbol, topic) {
  ensureInitialized();
  return client.getCurrentPrice(symbol, topic);
}

/**
 * Subscribe to price updates for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Function} callback - Callback invoked on each tick: (tick) => void
 *   tick format: { timestamp, topic, symbol, price }
 * @returns {Function} Unsubscribe function - call to stop receiving updates
 * @throws {RTDSError} If not initialized or invalid symbol
 */
export function subscribe(symbol, callback) {
  ensureInitialized();
  return client.subscribe(symbol, callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including:
 *   - initialized: boolean
 *   - connected: boolean
 *   - connectionState: string
 *   - subscribedTopics: string[]
 *   - prices: { [symbol]: { [topic]: { price, timestamp, staleness_ms } } }
 *   - stats: { ticks_received, errors, reconnects, last_tick_at }
 */
export function getState() {
  if (!client) {
    return {
      initialized: false,
      connected: false,
      connectionState: 'disconnected',
      subscribedTopics: [],
      prices: {},
      stats: { ticks_received: 0, errors: 0, reconnects: 0, last_tick_at: null },
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
 * @throws {RTDSError} If not initialized
 */
function ensureInitialized() {
  if (!client || !client.initialized) {
    throw new RTDSError(
      RTDSErrorCodes.NOT_INITIALIZED,
      'RTDS client not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export { RTDSError, RTDSErrorCodes, SUPPORTED_SYMBOLS, TOPICS };
