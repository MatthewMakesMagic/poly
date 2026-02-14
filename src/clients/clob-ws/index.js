/**
 * CLOB WebSocket Client Module
 *
 * Public interface for real-time L2 order book data from Polymarket's CLOB WebSocket.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module clients/clob-ws
 */

import { child } from '../../modules/logger/index.js';
import { ClobWsClient } from './client.js';
import {
  ClobWsError,
  ClobWsErrorCodes,
  ConnectionState,
} from './types.js';

// Module state
let client = null;
let log = null;

/**
 * Initialize the CLOB WS client module
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function init(config = {}) {
  log = child({ module: 'clob-ws' });
  log.info('module_init_start');

  const wsConfig = config.clobWs || {};

  client = new ClobWsClient({ logger: log });
  await client.initialize(wsConfig);

  log.info('clob_ws_module_initialized');
}

/**
 * Subscribe to a token's order book
 *
 * @param {string} tokenId - Token ID
 * @param {string} symbol - Symbol label
 */
export function subscribeToken(tokenId, symbol) {
  ensureInitialized();
  client.subscribeToken(tokenId, symbol);
}

/**
 * Unsubscribe from a token
 *
 * @param {string} tokenId - Token ID
 */
export function unsubscribeToken(tokenId) {
  ensureInitialized();
  client.unsubscribeToken(tokenId);
}

/**
 * Get order book for a token
 *
 * @param {string} tokenId - Token ID
 * @returns {Object|null} Book with bids, asks, bestBid, bestAsk, mid, spread
 */
export function getBook(tokenId) {
  ensureInitialized();
  return client.getBook(tokenId);
}

/**
 * Get serializable book snapshot for DB persistence
 *
 * @param {string} tokenId - Token ID
 * @returns {Object|null} Snapshot with depth metrics
 */
export function getBookSnapshot(tokenId) {
  ensureInitialized();
  return client.getBookSnapshot(tokenId);
}

/**
 * Subscribe to book change events
 *
 * @param {string} tokenId - Token ID
 * @param {Function} callback - Called on updates
 * @returns {Function} Unsubscribe function
 */
export function subscribe(tokenId, callback) {
  ensureInitialized();
  return client.subscribe(tokenId, callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Client state
 */
export function getState() {
  if (!client) {
    return {
      initialized: false,
      connected: false,
      connectionState: 'disconnected',
      subscribedTokens: 0,
      books: {},
      stats: { bookSnapshots: 0, priceChanges: 0, errors: 0, reconnects: 0 },
    };
  }
  return client.getState();
}

/**
 * Shutdown the module
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

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
 * Get the underlying client instance (for direct access in paper-trader)
 *
 * @returns {ClobWsClient|null}
 */
export function getClient() {
  return client;
}

function ensureInitialized() {
  if (!client || !client.initialized) {
    throw new ClobWsError(
      ClobWsErrorCodes.NOT_INITIALIZED,
      'CLOB WS client not initialized. Call init() first.'
    );
  }
}

export { ClobWsError, ClobWsErrorCodes, ConnectionState };
