/**
 * Exchange Feed Collector Module
 *
 * Polls multiple cryptocurrency exchanges at 1s intervals for BTC, ETH, SOL, XRP
 * prices and persists to the exchange_ticks table for cross-correlation analysis.
 *
 * Uses CCXT for unified exchange API access.
 * Handles individual exchange errors gracefully (continues with others).
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/exchange-feed-collector
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as ccxtClient from '../../clients/ccxt/index.js';
import {
  ExchangeFeedCollectorError,
  ExchangeFeedCollectorErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let pollIntervalId = null;
let flushIntervalId = null;
let cleanupIntervalId = null;
let pollInProgress = false;

/** Buffer for pending tick inserts */
let tickBuffer = [];

// Per-exchange error counters
let exchangeErrors = {};

// Statistics
let stats = {
  pollCycles: 0,
  ticksCaptured: 0,
  ticksInserted: 0,
  insertErrors: 0,
  exchangeErrors: 0,
  lastPollAt: null,
};

/**
 * Poll all exchanges for all cryptos
 */
async function pollExchanges() {
  if (pollInProgress) return;
  pollInProgress = true;

  try {
    stats.pollCycles++;
    const now = new Date().toISOString();
    const exchanges = ccxtClient.getExchanges();
    const cryptos = ccxtClient.getCryptos();

    const promises = [];

    for (const exchange of exchanges) {
      for (const crypto of cryptos) {
        promises.push(
          ccxtClient.fetchTicker(exchange, crypto)
            .then(ticker => {
              if (ticker && ticker.price != null) {
                tickBuffer.push({
                  timestamp: now,
                  exchange,
                  symbol: crypto,
                  price: ticker.price,
                  bid: ticker.bid,
                  ask: ticker.ask,
                  volume_24h: ticker.volume24h,
                });
                stats.ticksCaptured++;

                // Reset error counter on success
                const key = `${exchange}-${crypto}`;
                if (exchangeErrors[key]) {
                  exchangeErrors[key] = 0;
                }
              }
            })
            .catch(err => {
              const key = `${exchange}-${crypto}`;
              exchangeErrors[key] = (exchangeErrors[key] || 0) + 1;
              stats.exchangeErrors++;

              // Only log periodically to avoid spam
              if (exchangeErrors[key] <= 3 || exchangeErrors[key] % 60 === 0) {
                log.warn('exchange_poll_failed', {
                  exchange,
                  crypto,
                  error: err.message,
                  consecutiveErrors: exchangeErrors[key],
                });
              }
            })
        );
      }
    }

    await Promise.allSettled(promises);
    stats.lastPollAt = now;

    // Flush buffer if it reaches batch size
    if (tickBuffer.length >= config.batchSize) {
      await flushBuffer();
    }
  } finally {
    pollInProgress = false;
  }
}

/**
 * Flush tick buffer to database
 */
async function flushBuffer() {
  if (tickBuffer.length === 0) return;

  const batch = tickBuffer.splice(0, tickBuffer.length);

  try {
    const colCount = 7;
    const values = [];
    const params = [];
    batch.forEach((tick, i) => {
      const offset = i * colCount;
      values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7})`);
      params.push(
        tick.timestamp, tick.exchange, tick.symbol,
        tick.price, tick.bid, tick.ask, tick.volume_24h,
      );
    });

    const insertSQL = `
      INSERT INTO exchange_ticks (
        timestamp, exchange, symbol, price, bid, ask, volume_24h
      ) VALUES ${values.join(', ')}
    `;

    await persistence.run(insertSQL, params);

    stats.ticksInserted += batch.length;
  } catch (err) {
    stats.insertErrors++;
    log.error('exchange_tick_insert_failed', {
      error: err.message,
      count: batch.length,
    });

    // Re-queue if buffer has space
    if (tickBuffer.length + batch.length <= config.maxBufferSize) {
      tickBuffer.push(...batch);
    }
  }
}

/**
 * Cleanup old ticks based on retention policy
 */
async function cleanupOldTicks(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    await persistence.run('DELETE FROM exchange_ticks WHERE timestamp < $1', [cutoff]);
    log.info('cleanup_complete', { table: 'exchange_ticks', cutoff });
  } catch (err) {
    log.warn('cleanup_failed', { error: err.message });
  }
}

/**
 * Initialize the exchange feed collector module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.exchangeFeedCollector] - Module config
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'exchange-feed-collector' });
  log.info('module_init_start');

  const efcConfig = cfg.exchangeFeedCollector || {};
  config = {
    pollIntervalMs: efcConfig.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
    batchSize: efcConfig.batchSize ?? DEFAULT_CONFIG.batchSize,
    maxBufferSize: efcConfig.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
    retentionDays: efcConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
  };

  // Initialize CCXT client
  await ccxtClient.init();

  initialized = true;

  // Start polling interval
  pollIntervalId = setInterval(() => {
    pollExchanges().catch(err => {
      if (log) log.error('poll_cycle_failed', { error: err.message });
    });
  }, config.pollIntervalMs);
  if (pollIntervalId.unref) pollIntervalId.unref();

  // Periodic buffer flush (every 5s, in case batchSize not reached)
  flushIntervalId = setInterval(() => {
    flushBuffer().catch(err => {
      if (log) log.error('periodic_flush_failed', { error: err.message });
    });
  }, 5000);
  if (flushIntervalId.unref) flushIntervalId.unref();

  // Start retention cleanup (every 6 hours)
  const cleanupMs = 6 * 60 * 60 * 1000;
  cleanupIntervalId = setInterval(() => {
    cleanupOldTicks(config.retentionDays).catch(() => {});
  }, cleanupMs);
  if (cleanupIntervalId.unref) cleanupIntervalId.unref();

  log.info('exchange_feed_collector_initialized', {
    config: {
      pollIntervalMs: config.pollIntervalMs,
      exchanges: ccxtClient.getExchanges(),
      cryptos: ccxtClient.getCryptos(),
    },
  });
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized) {
    return {
      initialized: false,
      stats: null,
      config: null,
    };
  }

  return {
    initialized: true,
    bufferSize: tickBuffer.length,
    exchangeErrors: { ...exchangeErrors },
    stats: { ...stats },
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  initialized = false;

  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }

  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Final flush
  await flushBuffer();

  // Shutdown CCXT client
  await ccxtClient.shutdown();

  tickBuffer = [];
  exchangeErrors = {};
  stats = {
    pollCycles: 0,
    ticksCaptured: 0,
    ticksInserted: 0,
    insertErrors: 0,
    exchangeErrors: 0,
    lastPollAt: null,
  };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  config = null;
}

export { ExchangeFeedCollectorError, ExchangeFeedCollectorErrorCodes };
