/**
 * Exchange Feed Collector Types
 *
 * @module modules/exchange-feed-collector/types
 */

export class ExchangeFeedCollectorError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ExchangeFeedCollectorError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const ExchangeFeedCollectorErrorCodes = {
  NOT_INITIALIZED: 'EFC_NOT_INITIALIZED',
  POLL_FAILED: 'EFC_POLL_FAILED',
  PERSISTENCE_ERROR: 'EFC_PERSISTENCE_ERROR',
};

export const DEFAULT_CONFIG = {
  /** Polling interval in milliseconds */
  pollIntervalMs: 1000,
  /** Batch size for database inserts (21 exchanges × 4 cryptos = 84 ticks/cycle) */
  batchSize: 200,
  /** Max buffer before overflow */
  maxBufferSize: 5000,
  /** Retention in days */
  retentionDays: 30,
};
