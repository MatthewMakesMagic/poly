/**
 * CCXT WebSocket Client Types
 *
 * @module clients/ccxt-ws/types
 */

export class CcxtWsError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'CcxtWsError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const CcxtWsErrorCodes = {
  NOT_INITIALIZED: 'CCXT_WS_NOT_INITIALIZED',
  CONNECTION_FAILED: 'CCXT_WS_CONNECTION_FAILED',
  WATCH_FAILED: 'CCXT_WS_WATCH_FAILED',
  EXCHANGE_ERROR: 'CCXT_WS_EXCHANGE_ERROR',
};

export const DEFAULT_CONFIG = {
  /** Initial reconnect delay (ms) */
  reconnectIntervalMs: 1000,
  /** Max reconnect delay cap (ms) */
  maxReconnectIntervalMs: 30000,
  /** Warn if no trades for this duration (ms) */
  staleThresholdMs: 30000,
  /** Stale check interval (ms) */
  staleCheckIntervalMs: 10000,
};
