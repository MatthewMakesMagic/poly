/**
 * RTDS Client Types
 *
 * Type definitions and error classes for the RTDS (Real Time Data Socket) client module.
 * Extends PolyError from src/types/errors.js for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * RTDS client error codes
 */
export const RTDSErrorCodes = {
  NOT_INITIALIZED: 'RTDS_NOT_INITIALIZED',
  CONNECTION_FAILED: 'RTDS_CONNECTION_FAILED',
  SUBSCRIPTION_FAILED: 'RTDS_SUBSCRIPTION_FAILED',
  PARSE_ERROR: 'RTDS_PARSE_ERROR',
  STALE_DATA: 'RTDS_STALE_DATA',
  INVALID_SYMBOL: 'RTDS_INVALID_SYMBOL',
  INVALID_TOPIC: 'RTDS_INVALID_TOPIC',
};

/**
 * RTDS client error class
 * Extends PolyError for consistent error handling across the system.
 */
export class RTDSError extends PolyError {
  /**
   * @param {string} code - Error code from RTDSErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'RTDSError';
  }
}

/**
 * Supported cryptocurrency symbols (normalized to lowercase)
 */
export const SUPPORTED_SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];

/**
 * RTDS Topics
 */
export const TOPICS = {
  CRYPTO_PRICES: 'crypto_prices',           // Binance-sourced prices (UI feed)
  CRYPTO_PRICES_CHAINLINK: 'crypto_prices_chainlink',  // Chainlink oracle prices
};

/**
 * Symbol mapping between topics
 * Binance topic uses formats like 'btcusdt', 'ethusdt', 'solusd'
 * Chainlink topic uses formats like 'btc/usd', 'eth/usd', 'sol/usd'
 */
export const SYMBOL_MAPPING = {
  // Binance topic symbols (crypto_prices)
  binance: {
    btc: 'btcusdt',
    eth: 'ethusdt',
    sol: 'solusd',
    xrp: 'xrpusdt',
  },
  // Chainlink topic symbols (crypto_prices_chainlink)
  chainlink: {
    btc: 'btc/usd',
    eth: 'eth/usd',
    sol: 'sol/usd',
    xrp: 'xrp/usd',
  },
};

/**
 * Reverse mapping: from raw symbol to normalized symbol
 */
export const REVERSE_SYMBOL_MAPPING = {
  // Binance symbols
  btcusdt: 'btc',
  ethusdt: 'eth',
  solusd: 'sol',
  xrpusdt: 'xrp',
  // Chainlink symbols
  'btc/usd': 'btc',
  'eth/usd': 'eth',
  'sol/usd': 'sol',
  'xrp/usd': 'xrp',
};

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  url: 'wss://ws-live-data.polymarket.com',
  reconnectIntervalMs: 1000,      // Initial reconnect delay
  maxReconnectIntervalMs: 30000,  // Max reconnect delay (30s)
  staleThresholdMs: 5000,         // Warn if no data for 5s
  symbols: ['btc', 'eth', 'sol', 'xrp'],
  connectionTimeoutMs: 10000,     // Connection timeout
  maxMessageSizeBytes: 1024 * 1024, // 1MB max message size
  staleWarningIntervalMs: 30000,  // Only warn about stale data every 30s per symbol/topic
};

/**
 * Connection states
 */
export const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
};

/**
 * Normalized tick structure
 * @typedef {Object} NormalizedTick
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {string} topic - Topic name (crypto_prices or crypto_prices_chainlink)
 * @property {string} symbol - Normalized symbol (btc, eth, sol, xrp)
 * @property {number} price - The price value
 */

/**
 * Client state structure
 * @typedef {Object} RTDSClientState
 * @property {boolean} initialized - Whether client is initialized
 * @property {boolean} connected - Whether WebSocket is connected
 * @property {string[]} subscribedTopics - List of subscribed topics
 * @property {Object} prices - Current prices by symbol and topic
 * @property {Object} stats - Tick statistics
 */
