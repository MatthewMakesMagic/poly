/**
 * CLOB WebSocket Client Types
 *
 * Type definitions and constants for the Polymarket CLOB WebSocket client.
 */

import { PolyError } from '../../types/errors.js';

/**
 * CLOB WS error codes
 */
export const ClobWsErrorCodes = {
  NOT_INITIALIZED: 'CLOB_WS_NOT_INITIALIZED',
  CONNECTION_FAILED: 'CLOB_WS_CONNECTION_FAILED',
  SUBSCRIPTION_FAILED: 'CLOB_WS_SUBSCRIPTION_FAILED',
  PARSE_ERROR: 'CLOB_WS_PARSE_ERROR',
};

/**
 * CLOB WS error class
 */
export class ClobWsError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'ClobWsError';
  }
}

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
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  reconnectIntervalMs: 1000,
  maxReconnectIntervalMs: 30000,
  connectionTimeoutMs: 10000,
  staleThresholdMs: 10000,
  staleWarningIntervalMs: 30000,
  maxMessageSizeBytes: 5 * 1024 * 1024, // 5MB for full book snapshots
};
