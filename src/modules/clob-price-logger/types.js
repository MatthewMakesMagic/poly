/**
 * CLOB Price Logger Types
 *
 * Error classes and configuration for the CLOB price logger module.
 *
 * @module modules/clob-price-logger/types
 */

export class ClobPriceLoggerError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ClobPriceLoggerError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const ClobPriceLoggerErrorCodes = {
  NOT_INITIALIZED: 'CPL_NOT_INITIALIZED',
  WS_CONNECTION_FAILED: 'CPL_WS_CONNECTION_FAILED',
  SNAPSHOT_FAILED: 'CPL_SNAPSHOT_FAILED',
  PERSISTENCE_ERROR: 'CPL_PERSISTENCE_ERROR',
};

export const DEFAULT_CONFIG = {
  /** Snapshot interval in milliseconds */
  snapshotIntervalMs: 1000,
  /** CLOB WebSocket URL */
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  /** CLOB REST URL for initial midpoint */
  restUrl: 'https://clob.polymarket.com',
  /** Initial reconnect delay */
  reconnectBaseMs: 1000,
  /** Maximum reconnect delay */
  reconnectMaxMs: 30000,
  /** Maximum active tokens to track */
  maxActiveTokens: 20,
  /** Window-manager poll interval for auto-discovery */
  discoveryIntervalMs: 5000,
  /** Batch size for database inserts */
  batchSize: 50,
  /** Max buffer before overflow */
  maxBufferSize: 500,
  /** Retention in days */
  retentionDays: 30,
  /** Cleanup interval in hours */
  cleanupIntervalHours: 6,
};
