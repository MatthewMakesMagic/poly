/**
 * RTDS Types Unit Tests
 *
 * Tests for error classes, symbol mapping, and constants.
 */

import { describe, it, expect } from 'vitest';
import {
  RTDSError,
  RTDSErrorCodes,
  SUPPORTED_SYMBOLS,
  TOPICS,
  SYMBOL_MAPPING,
  REVERSE_SYMBOL_MAPPING,
  DEFAULT_CONFIG,
  ConnectionState,
} from '../types.js';

describe('RTDSError', () => {
  it('should create error with code, message, and context', () => {
    const error = new RTDSError(
      RTDSErrorCodes.CONNECTION_FAILED,
      'Connection timeout',
      { url: 'wss://test.com' }
    );

    expect(error.name).toBe('RTDSError');
    expect(error.code).toBe('RTDS_CONNECTION_FAILED');
    expect(error.message).toBe('Connection timeout');
    expect(error.context).toEqual({ url: 'wss://test.com' });
    expect(error.timestamp).toBeDefined();
  });

  it('should extend Error', () => {
    const error = new RTDSError(RTDSErrorCodes.PARSE_ERROR, 'Parse failed');
    expect(error instanceof Error).toBe(true);
  });

  it('should provide toLogFormat method', () => {
    const error = new RTDSError(
      RTDSErrorCodes.STALE_DATA,
      'Data is stale',
      { staleness_ms: 10000 }
    );

    const logFormat = error.toLogFormat();
    expect(logFormat.error_code).toBe('RTDS_STALE_DATA');
    expect(logFormat.error_message).toBe('Data is stale');
    expect(logFormat.error_context).toEqual({ staleness_ms: 10000 });
    expect(logFormat.error_timestamp).toBeDefined();
    expect(logFormat.error_stack).toBeDefined();
  });
});

describe('RTDSErrorCodes', () => {
  it('should have all required error codes', () => {
    expect(RTDSErrorCodes.NOT_INITIALIZED).toBe('RTDS_NOT_INITIALIZED');
    expect(RTDSErrorCodes.CONNECTION_FAILED).toBe('RTDS_CONNECTION_FAILED');
    expect(RTDSErrorCodes.SUBSCRIPTION_FAILED).toBe('RTDS_SUBSCRIPTION_FAILED');
    expect(RTDSErrorCodes.PARSE_ERROR).toBe('RTDS_PARSE_ERROR');
    expect(RTDSErrorCodes.STALE_DATA).toBe('RTDS_STALE_DATA');
    expect(RTDSErrorCodes.INVALID_SYMBOL).toBe('RTDS_INVALID_SYMBOL');
    expect(RTDSErrorCodes.INVALID_TOPIC).toBe('RTDS_INVALID_TOPIC');
  });
});

describe('SUPPORTED_SYMBOLS', () => {
  it('should contain btc, eth, sol, xrp', () => {
    expect(SUPPORTED_SYMBOLS).toContain('btc');
    expect(SUPPORTED_SYMBOLS).toContain('eth');
    expect(SUPPORTED_SYMBOLS).toContain('sol');
    expect(SUPPORTED_SYMBOLS).toContain('xrp');
    expect(SUPPORTED_SYMBOLS).toHaveLength(4);
  });
});

describe('TOPICS', () => {
  it('should have crypto_prices and crypto_prices_chainlink', () => {
    expect(TOPICS.CRYPTO_PRICES).toBe('crypto_prices');
    expect(TOPICS.CRYPTO_PRICES_CHAINLINK).toBe('crypto_prices_chainlink');
  });
});

describe('SYMBOL_MAPPING', () => {
  it('should map normalized symbols to Binance format', () => {
    expect(SYMBOL_MAPPING.binance.btc).toBe('btcusdt');
    expect(SYMBOL_MAPPING.binance.eth).toBe('ethusdt');
    expect(SYMBOL_MAPPING.binance.sol).toBe('solusd');
    expect(SYMBOL_MAPPING.binance.xrp).toBe('xrpusdt');
  });

  it('should map normalized symbols to Chainlink format', () => {
    expect(SYMBOL_MAPPING.chainlink.btc).toBe('btc/usd');
    expect(SYMBOL_MAPPING.chainlink.eth).toBe('eth/usd');
    expect(SYMBOL_MAPPING.chainlink.sol).toBe('sol/usd');
    expect(SYMBOL_MAPPING.chainlink.xrp).toBe('xrp/usd');
  });
});

describe('REVERSE_SYMBOL_MAPPING', () => {
  it('should map Binance symbols to normalized format', () => {
    expect(REVERSE_SYMBOL_MAPPING.btcusdt).toBe('btc');
    expect(REVERSE_SYMBOL_MAPPING.ethusdt).toBe('eth');
    expect(REVERSE_SYMBOL_MAPPING.solusd).toBe('sol');
    expect(REVERSE_SYMBOL_MAPPING.xrpusdt).toBe('xrp');
  });

  it('should map Chainlink symbols to normalized format', () => {
    expect(REVERSE_SYMBOL_MAPPING['btc/usd']).toBe('btc');
    expect(REVERSE_SYMBOL_MAPPING['eth/usd']).toBe('eth');
    expect(REVERSE_SYMBOL_MAPPING['sol/usd']).toBe('sol');
    expect(REVERSE_SYMBOL_MAPPING['xrp/usd']).toBe('xrp');
  });
});

describe('DEFAULT_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_CONFIG.url).toBe('wss://ws-live-data.polymarket.com');
    expect(DEFAULT_CONFIG.reconnectIntervalMs).toBe(1000);
    expect(DEFAULT_CONFIG.maxReconnectIntervalMs).toBe(30000);
    expect(DEFAULT_CONFIG.staleThresholdMs).toBe(5000);
    expect(DEFAULT_CONFIG.symbols).toEqual(['btc', 'eth', 'sol', 'xrp']);
    expect(DEFAULT_CONFIG.connectionTimeoutMs).toBe(10000);
  });
});

describe('ConnectionState', () => {
  it('should have all connection states', () => {
    expect(ConnectionState.DISCONNECTED).toBe('disconnected');
    expect(ConnectionState.CONNECTING).toBe('connecting');
    expect(ConnectionState.CONNECTED).toBe('connected');
    expect(ConnectionState.RECONNECTING).toBe('reconnecting');
  });
});
