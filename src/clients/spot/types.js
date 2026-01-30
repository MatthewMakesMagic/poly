/**
 * Spot Client Types
 *
 * Type definitions and error classes for the spot price client module.
 * Extends PolyError from src/types/errors.js for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Spot client error codes
 */
export const SpotClientErrorCodes = {
  NOT_INITIALIZED: 'SPOT_CLIENT_NOT_INITIALIZED',
  FETCH_FAILED: 'SPOT_PRICE_FETCH_FAILED',
  SOURCE_DISABLED: 'SPOT_SOURCE_DISABLED',
  SUBSCRIPTION_ERROR: 'SPOT_SUBSCRIPTION_ERROR',
  STALE_PRICE: 'SPOT_PRICE_STALE',
  INVALID_CRYPTO: 'SPOT_INVALID_CRYPTO',
  CONNECTION_FAILED: 'SPOT_CONNECTION_FAILED',
};

/**
 * Spot client error class
 * Extends PolyError for consistent error handling across the system.
 */
export class SpotClientError extends PolyError {
  /**
   * @param {string} code - Error code from SpotClientErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'SpotClientError';
  }
}

/**
 * Supported cryptocurrency symbols
 */
export const SUPPORTED_CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];

/**
 * Pyth Price Feed IDs
 * Source: Pyth Network documentation
 */
export const PYTH_PRICE_IDS = {
  btc: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  eth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  sol: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  xrp: '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
};

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  hermesUrl: 'https://hermes.pyth.network',
  pollIntervalMs: 1000,
  staleThresholdMs: 10000,
  maxConsecutiveErrors: 10,
  reconnectBaseMs: 5000,
  reconnectMaxMs: 60000,
  requestTimeoutMs: 5000,
};

/**
 * Normalized price structure
 * @typedef {Object} NormalizedPrice
 * @property {number} price - The price value
 * @property {Date} timestamp - When the price was published
 * @property {string} source - Price source name (e.g., 'pyth')
 * @property {number} staleness - Seconds since last update
 * @property {Object} raw - Raw price data from source (for debugging)
 */

/**
 * Client state structure
 * @typedef {Object} SpotClientState
 * @property {boolean} initialized - Whether client is initialized
 * @property {boolean} connected - Whether client is connected to price source
 * @property {Object} prices - Current prices by crypto symbol
 * @property {Object} lastUpdate - Last update timestamps by crypto
 * @property {number} consecutiveErrors - Count of consecutive errors
 * @property {boolean} disabled - Whether source is disabled due to errors
 * @property {Object} stats - Request statistics
 */
