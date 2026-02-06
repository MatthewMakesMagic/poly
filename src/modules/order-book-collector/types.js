/**
 * Order Book Collector Types
 *
 * @module modules/order-book-collector/types
 */

export class OrderBookCollectorError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'OrderBookCollectorError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const OrderBookCollectorErrorCodes = {
  NOT_INITIALIZED: 'OBC_NOT_INITIALIZED',
  SNAPSHOT_FAILED: 'OBC_SNAPSHOT_FAILED',
  PERSISTENCE_ERROR: 'OBC_PERSISTENCE_ERROR',
};

export const DEFAULT_CONFIG = {
  /** Snapshot interval in milliseconds (default: 1 second for FINDTHEGOLD data capture) */
  snapshotIntervalMs: 1000,
  /** Depth percentage thresholds for liquidity calculation */
  depthThresholds: [0.01, 0.05], // 1% and 5%
  /** Maximum number of active token IDs to track */
  maxActiveTokens: 20,
  /** Whether to log each snapshot */
  verboseLogging: false,
};
