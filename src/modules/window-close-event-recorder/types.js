/**
 * Window Close Event Recorder Types
 *
 * Type definitions and constants for the window close event recorder module.
 * This module captures price data around Polymarket window closes to analyze
 * oracle resolution patterns for Edge 2 (Resolution prediction).
 *
 * V3 Philosophy Implementation - Stage 3: Data Capture Running
 */

import { PolyError } from '../../types/errors.js';

/**
 * Window Close Event Recorder error codes
 */
export const WindowCloseEventRecorderErrorCodes = {
  NOT_INITIALIZED: 'WINDOW_CLOSE_EVENT_RECORDER_NOT_INITIALIZED',
  CAPTURE_FAILED: 'WINDOW_CLOSE_EVENT_RECORDER_CAPTURE_FAILED',
  DATABASE_ERROR: 'WINDOW_CLOSE_EVENT_RECORDER_DATABASE_ERROR',
  RESOLUTION_TIMEOUT: 'WINDOW_CLOSE_EVENT_RECORDER_RESOLUTION_TIMEOUT',
};

/**
 * Window Close Event Recorder error class
 */
export class WindowCloseEventRecorderError extends PolyError {
  /**
   * @param {string} code - Error code from WindowCloseEventRecorderErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'WindowCloseEventRecorderError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  // Start capture this many ms before window close
  captureStartBeforeCloseMs: 90000, // 90 seconds (buffer for timer drift)

  // Intervals before close to capture prices (in ms)
  captureIntervalsMs: [60000, 30000, 10000, 5000, 1000],

  // Resolution retry settings
  resolutionFirstAttemptDelayMs: 1000, // First attempt 1s after close
  resolutionRetryIntervalMs: 10000, // Retry every 10s
  resolutionMaxWaitMs: 60000, // Give up after 60s

  // Surprise threshold - only flag if market consensus > this
  surpriseThresholdConfidence: 0.95,

  // Max sample rate (samples per second)
  maxSampleRatePerSecond: 10,
};

/**
 * Window duration in seconds (15 minutes)
 */
export const WINDOW_DURATION_SECONDS = 900;

/**
 * Window duration in milliseconds
 */
export const WINDOW_DURATION_MS = WINDOW_DURATION_SECONDS * 1000;

/**
 * Supported cryptos
 */
export const SUPPORTED_CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];

/**
 * Price feed sources
 */
export const PRICE_SOURCES = {
  BINANCE: 'binance',
  CHAINLINK: 'chainlink',
  PYTH: 'pyth',
  POLYMARKET_BINANCE: 'polymarket_binance',
};

/**
 * Capture state for a single window
 * @typedef {Object} WindowCaptureState
 * @property {string} windowId - Window identifier
 * @property {string} symbol - Crypto symbol
 * @property {number} closeTimeMs - Expected close time in ms since epoch
 * @property {number} strikePrice - Strike price for this window
 * @property {Object} oraclePrices - Oracle prices at intervals { 60s, 30s, 10s, 5s, 1s, close }
 * @property {Object} feedPricesAtClose - All feed prices at close
 * @property {Object} marketUpPrices - UP token prices at intervals
 * @property {Object} marketDownPrices - DOWN token prices at intervals
 * @property {boolean} captureStarted - Whether capture has started
 * @property {boolean} captureComplete - Whether capture is complete
 * @property {string|null} resolvedDirection - 'up' or 'down' or null if not resolved
 */
