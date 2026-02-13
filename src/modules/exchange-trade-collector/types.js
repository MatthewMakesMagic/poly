/**
 * Exchange Trade Collector Types
 *
 * @module modules/exchange-trade-collector/types
 */

export class ExchangeTradeCollectorError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ExchangeTradeCollectorError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const ExchangeTradeCollectorErrorCodes = {
  NOT_INITIALIZED: 'ETC_NOT_INITIALIZED',
  VWAP_ERROR: 'ETC_VWAP_ERROR',
  PERSISTENCE_ERROR: 'ETC_PERSISTENCE_ERROR',
};

export const DEFAULT_CONFIG = {
  /** Cryptos to track */
  cryptos: ['btc', 'eth', 'sol', 'xrp'],
  /** VWAP rolling window in ms (matches oracle ~8s 90% capture) */
  vwapWindowMs: 10000,
  /** Persist VWAP snapshot every N ms */
  snapshotIntervalMs: 1000,
  /** Data retention in days */
  retentionDays: 30,
  /** Cleanup interval in hours */
  cleanupIntervalHours: 6,
  /** Ring buffer size per exchange per symbol */
  maxTradesPerBuffer: 5000,
};
