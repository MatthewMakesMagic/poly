/**
 * Paper Trader V2 Types
 *
 * Type definitions, error classes, and configuration defaults for the
 * VWAP edge paper trading system.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Paper trader error codes
 */
export const PaperTraderErrorCodes = {
  NOT_INITIALIZED: 'PAPER_TRADER_NOT_INITIALIZED',
  SIGNAL_EVAL_FAILED: 'PAPER_TRADER_SIGNAL_EVAL_FAILED',
  FILL_SIM_FAILED: 'PAPER_TRADER_FILL_SIM_FAILED',
  SETTLEMENT_FAILED: 'PAPER_TRADER_SETTLEMENT_FAILED',
  DATABASE_ERROR: 'PAPER_TRADER_DATABASE_ERROR',
};

/**
 * Paper trader error class
 */
export class PaperTraderError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PaperTraderError';
  }
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  positionSizeDollars: 100,
  vwapDeltaThreshold: 75,
  snapshotIntervalMs: 5000,
  scanIntervalMs: 10000,
  feeRate: 0.0,
  cryptos: ['btc'],
  signalTimeBeforeCloseMs: 60000,    // T-60s: evaluate signal
  settlementDelayAfterCloseMs: 65000, // T+65s: check settlement
  latencyProbeTimeBeforeCloseMs: 90000, // T-90s: baseline latency probe
};

/**
 * Window duration in seconds (15 minutes)
 */
export const WINDOW_DURATION_SECONDS = 900;
