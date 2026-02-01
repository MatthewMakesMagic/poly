/**
 * Window Manager Types
 *
 * TEMP SOLUTION: This module wraps scripts/crypto-15min-tracker.js logic
 * to provide windows to the execution loop. A more robust solution should
 * use WebSocket subscriptions for real-time updates.
 */

/**
 * Window Manager error codes
 */
export const WindowManagerErrorCodes = {
  NOT_INITIALIZED: 'WINDOW_MANAGER_NOT_INITIALIZED',
  FETCH_FAILED: 'WINDOW_MANAGER_FETCH_FAILED',
  INVALID_CRYPTO: 'WINDOW_MANAGER_INVALID_CRYPTO',
};

/**
 * Window Manager error class
 */
export class WindowManagerError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'WindowManagerError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Supported cryptocurrencies for 15-min windows
 */
export const SUPPORTED_CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];

/**
 * API endpoints
 */
export const GAMMA_API = 'https://gamma-api.polymarket.com';
export const CLOB_API = 'https://clob.polymarket.com';
export const BINANCE_API = 'https://api.binance.com/api/v3';

/**
 * Window duration in seconds (15 minutes)
 */
export const WINDOW_DURATION_SECONDS = 900;

/**
 * Binance symbol mapping for supported cryptos
 */
export const BINANCE_SYMBOLS = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
};
