/**
 * Polymarket API Client Module
 *
 * Public interface for Polymarket trading operations.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Wraps existing production-tested clients with:
 * - Consistent error handling (PolymarketError)
 * - Rate limiting with exponential backoff
 * - Credential security (never logs credentials)
 * - Response validation
 *
 * @module clients/polymarket
 */

import { child } from '../../modules/logger/index.js';
import { WrappedPolymarketClient } from './client.js';
import {
  PolymarketError,
  PolymarketErrorCodes,
  Side,
  OrderType,
} from './types.js';

// Module state
let client = null;
let log = null;
let config = null;

/**
 * Initialize the Polymarket client module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} cfg.polymarket - Polymarket-specific configuration
 * @param {string} cfg.polymarket.apiKey - API key from environment/config
 * @param {string} cfg.polymarket.apiSecret - API secret from environment/config
 * @param {string} cfg.polymarket.passphrase - Passphrase from environment/config
 * @param {string} cfg.polymarket.privateKey - Private key from environment/config
 * @param {string} [cfg.polymarket.funder] - Funder address (optional, defaults to wallet)
 * @returns {Promise<void>}
 * @throws {PolymarketError} If credentials are missing or initialization fails
 */
export async function init(cfg) {
  // Create child logger for this module
  log = child({ module: 'polymarket-client' });

  log.info('module_init_start');

  // Extract polymarket config - credentials MUST come from config, not env directly
  const polyConfig = cfg.polymarket || {};

  // Validate we have the required config section
  if (!cfg.polymarket) {
    throw new PolymarketError(
      PolymarketErrorCodes.AUTH_FAILED,
      'Missing polymarket configuration section',
      { hasPolymarketConfig: false }
    );
  }

  config = polyConfig;

  // Create and initialize wrapped client
  client = new WrappedPolymarketClient({ logger: log });

  await client.initialize({
    apiKey: polyConfig.apiKey,
    apiSecret: polyConfig.apiSecret,
    passphrase: polyConfig.passphrase,
    privateKey: polyConfig.privateKey,
    funder: polyConfig.funder,
  });

  log.info('module_initialized', {
    address: client.wallet?.address,
    funder: client.funder,
  });
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including connection status, stats, and rate limit info
 */
export function getState() {
  if (!client) {
    return {
      initialized: false,
      address: null,
      funder: null,
      ready: false,
      stats: { requests: 0, errors: 0, rateLimitHits: 0 },
      rateLimit: { remainingMs: 0, lastRequestTime: 0 },
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

  config = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RE-EXPORTED CLIENT OPERATIONS
// All operations are wrapped with error handling and rate limiting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get order book for a token
 *
 * @param {string} tokenId - Token ID
 * @returns {Promise<Object>} Order book with bids and asks
 * @throws {PolymarketError} On API error
 */
export async function getOrderBook(tokenId) {
  ensureInitialized();
  return client.getOrderBook(tokenId);
}

/**
 * Get best prices for a token
 *
 * @param {string} tokenId - Token ID
 * @returns {Promise<Object>} { bid, ask, spread, midpoint }
 * @throws {PolymarketError} On API error
 */
export async function getBestPrices(tokenId) {
  ensureInitialized();
  return client.getBestPrices(tokenId);
}

/**
 * Get balance for a conditional token (in shares)
 *
 * @param {string} tokenId - Token ID
 * @returns {Promise<number>} Balance in shares
 */
export async function getBalance(tokenId) {
  ensureInitialized();
  return client.getBalance(tokenId);
}

/**
 * Get USDC balance
 *
 * @returns {Promise<number>} USDC balance
 */
export async function getUSDCBalance() {
  ensureInitialized();
  return client.getUSDCBalance();
}

/**
 * Get all open orders
 *
 * @returns {Promise<Array>} Array of open orders
 */
export async function getOpenOrders() {
  ensureInitialized();
  return client.getOpenOrders();
}

/**
 * Place a buy order
 *
 * @param {string} tokenId - Token to buy
 * @param {number} dollars - Dollar amount to spend
 * @param {number} price - Price per share (0.01-0.99)
 * @param {string} [orderType='GTC'] - Order type (GTC, FOK, IOC)
 * @returns {Promise<Object>} Order result
 * @throws {PolymarketError} On invalid parameters or API error
 */
export async function buy(tokenId, dollars, price, orderType = 'GTC') {
  ensureInitialized();
  return client.buy(tokenId, dollars, price, orderType);
}

/**
 * Place a sell order
 *
 * @param {string} tokenId - Token to sell
 * @param {number} shares - Number of shares to sell
 * @param {number} price - Price per share (0.01-0.99)
 * @param {string} [orderType='GTC'] - Order type (GTC, FOK, IOC)
 * @returns {Promise<Object>} Order result
 * @throws {PolymarketError} On invalid parameters or API error
 */
export async function sell(tokenId, shares, price, orderType = 'GTC') {
  ensureInitialized();
  return client.sell(tokenId, shares, price, orderType);
}

/**
 * Cancel an order
 *
 * @param {string} orderId - Order ID to cancel
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelOrder(orderId) {
  ensureInitialized();
  return client.cancelOrder(orderId);
}

/**
 * Cancel all orders
 *
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelAll() {
  ensureInitialized();
  return client.cancelAll();
}

/**
 * Internal: Ensure client is initialized
 * @throws {PolymarketError} If not initialized
 */
function ensureInitialized() {
  if (!client || !client.ready) {
    throw new PolymarketError(
      PolymarketErrorCodes.NOT_INITIALIZED,
      'Polymarket client not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export { PolymarketError, PolymarketErrorCodes, Side, OrderType };
