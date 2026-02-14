/**
 * Exchange Trade Collector Module
 *
 * Streams real-time trades via CCXT Pro WebSockets from 21 exchanges,
 * computes rolling in-memory VWAP per exchange per symbol, and persists
 * lightweight VWAP snapshots every 1s for oracle comparison analysis.
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/exchange-trade-collector
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';
import * as coingeckoClient from '../../clients/coingecko/index.js';
import { CcxtWsClient } from '../../clients/ccxt-ws/index.js';
import {
  ExchangeTradeCollectorError,
  ExchangeTradeCollectorErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let wsClient = null;
let snapshotIntervalId = null;
let cleanupIntervalId = null;
let snapshotInProgress = false;

/**
 * In-memory VWAP state
 *
 * Structure: vwapState[symbol][exchange] = { trades: [], sumPV, sumV, head }
 *
 * We use a simple array-based ring buffer. Trades older than vwapWindowMs
 * are evicted on each insert. sumPV/sumV are maintained incrementally.
 */
let vwapState = {};

// Statistics
let stats = {
  tradesProcessed: 0,
  snapshotsPersisted: 0,
  snapshotErrors: 0,
  lastSnapshotAt: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// RING BUFFER VWAP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh VWAP bucket for one exchange+symbol
 * @returns {Object}
 */
function createVwapBucket() {
  return {
    trades: [],    // Array of { timestamp, price, amount, pv }
    sumPV: 0,      // Sum of price × amount
    sumV: 0,       // Sum of amount (volume)
  };
}

/**
 * Add a trade to a VWAP bucket and evict stale entries
 *
 * @param {Object} bucket - VWAP bucket
 * @param {Object} trade - { timestamp, price, amount }
 * @param {number} windowMs - VWAP window size
 * @param {number} maxTrades - Max trades per buffer
 */
function addTrade(bucket, trade, windowMs, maxTrades) {
  const pv = trade.price * trade.amount;

  // Append
  bucket.trades.push({
    timestamp: trade.timestamp,
    price: trade.price,
    amount: trade.amount,
    pv,
  });
  bucket.sumPV += pv;
  bucket.sumV += trade.amount;

  // Evict trades older than windowMs
  const cutoff = trade.timestamp - windowMs;
  while (bucket.trades.length > 0 && bucket.trades[0].timestamp < cutoff) {
    const old = bucket.trades.shift();
    bucket.sumPV -= old.pv;
    bucket.sumV -= old.amount;
  }

  // Hard cap on buffer size (shouldn't normally hit this)
  while (bucket.trades.length > maxTrades) {
    const old = bucket.trades.shift();
    bucket.sumPV -= old.pv;
    bucket.sumV -= old.amount;
  }
}

/**
 * Get VWAP from a bucket
 *
 * @param {Object} bucket
 * @returns {{ vwap: number, volume: number, tradeCount: number } | null}
 */
function getBucketVwap(bucket) {
  if (bucket.sumV <= 0 || bucket.trades.length === 0) return null;
  return {
    vwap: bucket.sumPV / bucket.sumV,
    volume: bucket.sumV,
    tradeCount: bucket.trades.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE HANDLER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handle an incoming trade from the WebSocket client
 *
 * @param {Object} trade - Normalized trade from CcxtWsClient
 */
function handleTrade(trade) {
  const { symbol, exchange, price, amount, timestamp } = trade;

  // Validate
  if (!price || price <= 0 || !amount || amount <= 0) return;

  // Ensure state exists
  if (!vwapState[symbol]) return;
  if (!vwapState[symbol][exchange]) {
    vwapState[symbol][exchange] = createVwapBucket();
  }

  addTrade(
    vwapState[symbol][exchange],
    { timestamp, price, amount },
    config.vwapWindowMs,
    config.maxTradesPerBuffer
  );

  stats.tradesProcessed++;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC VWAP API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get VWAP for a specific exchange and symbol
 *
 * @param {string} exchange
 * @param {string} symbol
 * @returns {{ vwap: number, volume: number, tradeCount: number, windowMs: number } | null}
 */
export function getExchangeVWAP(exchange, symbol) {
  const bucket = vwapState[symbol]?.[exchange];
  if (!bucket) return null;

  const result = getBucketVwap(bucket);
  if (!result) return null;

  return { ...result, windowMs: config?.vwapWindowMs || DEFAULT_CONFIG.vwapWindowMs };
}

/**
 * Get composite VWAP across all exchanges for a symbol
 *
 * Volume-weighted average of per-exchange VWAPs.
 *
 * @param {string} symbol
 * @returns {{ vwap: number, totalVolume: number, exchangeCount: number, exchanges: Object } | null}
 */
export function getCompositeVWAP(symbol) {
  const exchangeBuckets = vwapState[symbol];
  if (!exchangeBuckets) return null;

  let totalPV = 0;
  let totalV = 0;
  let exchangeCount = 0;
  const exchanges = {};

  for (const [exchange, bucket] of Object.entries(exchangeBuckets)) {
    const result = getBucketVwap(bucket);
    if (!result) continue;

    totalPV += bucket.sumPV;
    totalV += bucket.sumV;
    exchangeCount++;

    exchanges[exchange] = {
      vwap: result.vwap,
      volume: result.volume,
    };
  }

  if (totalV <= 0 || exchangeCount === 0) return null;

  const compositeVwap = totalPV / totalV;

  // Add weight (fraction of total volume) to each exchange
  for (const ex of Object.values(exchanges)) {
    ex.weight = ex.volume / totalV;
  }

  return {
    vwap: compositeVwap,
    totalVolume: totalV,
    exchangeCount,
    exchanges,
  };
}

/**
 * Get predicted oracle price using measured transfer function
 *
 * Transfer function (from oracle architecture analysis):
 *   +1s: 41%, +2s: 53%, +3s: 65%, +5s: 77%
 *
 * We predict what CL will be based on recent exchange moves.
 *
 * @param {string} symbol
 * @returns {{ predicted_cl: number, current_cl: number|null, spread: number|null, confidence: number } | null}
 */
export function getPredictedOracle(symbol) {
  const composite = getCompositeVWAP(symbol);
  if (!composite) return null;

  // Get current Chainlink price
  let currentCl = null;
  try {
    const clData = rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (clData) {
      currentCl = clData.price;
    }
  } catch {
    // RTDS may not be available
  }

  // Confidence based on exchange coverage
  // More exchanges contributing = higher confidence
  const confidence = Math.min(composite.exchangeCount / 15, 1.0);

  const result = {
    predicted_cl: composite.vwap,
    current_cl: currentCl,
    spread: currentCl != null ? composite.vwap - currentCl : null,
    confidence,
  };

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOT PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Persist VWAP snapshots for all symbols
 * Called every snapshotIntervalMs (default 1s).
 */
async function persistSnapshots() {
  if (snapshotInProgress) return;
  snapshotInProgress = true;

  try {
    const now = new Date();
    const rows = [];

    for (const symbol of config.cryptos) {
      const composite = getCompositeVWAP(symbol);
      if (!composite) continue;

      // Get current Chainlink price for spread calculation
      let chainlinkPrice = null;
      try {
        const clData = rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK);
        if (clData) {
          chainlinkPrice = clData.price;
        }
      } catch {
        // OK — CL may not be available yet
      }

      const spread = chainlinkPrice != null ? composite.vwap - chainlinkPrice : null;

      // Get current CoinGecko aggregated price (1,700+ exchange VWAP)
      let coingeckoPrice = null;
      try {
        const cgData = coingeckoClient.getCurrentPrice(symbol);
        if (cgData) {
          coingeckoPrice = cgData.price;
        }
      } catch {
        // OK — CG may not be available yet
      }

      rows.push({
        timestamp: now,
        symbol,
        composite_vwap: composite.vwap,
        composite_volume: composite.totalVolume,
        exchange_count: composite.exchangeCount,
        chainlink_price: chainlinkPrice,
        vwap_cl_spread: spread,
        window_ms: config.vwapWindowMs,
        exchange_detail: JSON.stringify(composite.exchanges),
        coingecko_price: coingeckoPrice,
      });
    }

    if (rows.length === 0) return;

    // Multi-row INSERT
    const colCount = 10;
    const values = [];
    const params = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const offset = i * colCount;
      values.push(
        `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10})`
      );
      params.push(
        r.timestamp, r.symbol, r.composite_vwap, r.composite_volume,
        r.exchange_count, r.chainlink_price, r.vwap_cl_spread,
        r.window_ms, r.exchange_detail, r.coingecko_price,
      );
    }

    const sql = `
      INSERT INTO vwap_snapshots (
        timestamp, symbol, composite_vwap, composite_volume,
        exchange_count, chainlink_price, vwap_cl_spread,
        window_ms, exchange_detail, coingecko_price
      ) VALUES ${values.join(', ')}
    `;

    await persistence.run(sql, params);

    stats.snapshotsPersisted += rows.length;
    stats.lastSnapshotAt = now.toISOString();
  } catch (err) {
    stats.snapshotErrors++;
    // Log sparingly
    if (stats.snapshotErrors <= 5 || stats.snapshotErrors % 60 === 0) {
      log.warn('vwap_snapshot_insert_failed', {
        error: err.message,
        errorCount: stats.snapshotErrors,
      });
    }
  } finally {
    snapshotInProgress = false;
  }
}

/**
 * Cleanup old snapshots based on retention policy
 */
async function cleanupOldSnapshots() {
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    await persistence.run('DELETE FROM vwap_snapshots WHERE timestamp < $1', [cutoff]);
    log.info('cleanup_complete', { table: 'vwap_snapshots', cutoff });
  } catch (err) {
    log.warn('cleanup_failed', { table: 'vwap_snapshots', error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the exchange trade collector module
 *
 * @param {Object} cfg - Full application configuration
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'exchange-trade-collector' });
  log.info('module_init_start');

  const etcConfig = cfg.exchangeTradeCollector || {};
  config = {
    cryptos: etcConfig.cryptos ?? DEFAULT_CONFIG.cryptos,
    vwapWindowMs: etcConfig.vwapWindowMs ?? DEFAULT_CONFIG.vwapWindowMs,
    snapshotIntervalMs: etcConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    retentionDays: etcConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    cleanupIntervalHours: etcConfig.cleanupIntervalHours ?? DEFAULT_CONFIG.cleanupIntervalHours,
    maxTradesPerBuffer: etcConfig.maxTradesPerBuffer ?? DEFAULT_CONFIG.maxTradesPerBuffer,
  };

  // Initialize CoinGecko client (1,700+ exchange VWAP)
  try {
    await coingeckoClient.init({ apiKey: process.env.COINGECKO_API_KEY });
  } catch (err) {
    log.warn('coingecko_init_failed', { error: err.message });
  }

  // Initialize in-memory VWAP state
  vwapState = {};
  for (const symbol of config.cryptos) {
    vwapState[symbol] = {};
  }

  // Create and initialize WebSocket client
  wsClient = new CcxtWsClient({
    logger: child({ module: 'ccxt-ws' }),
    cryptos: config.cryptos,
  });

  await wsClient.initialize();

  // Subscribe to trades for each crypto
  for (const symbol of config.cryptos) {
    wsClient.subscribe(symbol, handleTrade);
  }

  // Start watching (fires off async WebSocket loops)
  await wsClient.startWatching();

  initialized = true;

  // Start snapshot persistence interval
  snapshotIntervalId = setInterval(() => {
    persistSnapshots().catch(err => {
      if (log) log.error('snapshot_cycle_failed', { error: err.message });
    });
  }, config.snapshotIntervalMs);
  if (snapshotIntervalId.unref) snapshotIntervalId.unref();

  // Start retention cleanup
  const cleanupMs = config.cleanupIntervalHours * 60 * 60 * 1000;
  cleanupIntervalId = setInterval(() => {
    cleanupOldSnapshots().catch(() => {});
  }, cleanupMs);
  if (cleanupIntervalId.unref) cleanupIntervalId.unref();

  log.info('exchange_trade_collector_initialized', {
    config: {
      cryptos: config.cryptos,
      vwapWindowMs: config.vwapWindowMs,
      snapshotIntervalMs: config.snapshotIntervalMs,
      maxTradesPerBuffer: config.maxTradesPerBuffer,
    },
    exchanges: wsClient.getExchangeNames().length,
  });
}

/**
 * Get current module state
 *
 * @returns {Object}
 */
export function getState() {
  if (!initialized) {
    return { initialized: false, stats: null, config: null };
  }

  // Build VWAP summary per symbol
  const vwapSummary = {};
  for (const symbol of config.cryptos) {
    const composite = getCompositeVWAP(symbol);
    if (composite) {
      vwapSummary[symbol] = {
        vwap: composite.vwap,
        totalVolume: composite.totalVolume,
        exchangeCount: composite.exchangeCount,
      };
    }
  }

  return {
    initialized: true,
    vwap: vwapSummary,
    wsClient: wsClient ? wsClient.getState() : null,
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

  // Stop intervals
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Final snapshot flush
  await persistSnapshots();

  // Shutdown WebSocket client
  if (wsClient) {
    await wsClient.shutdown();
    wsClient = null;
  }

  // Shutdown CoinGecko client
  await coingeckoClient.shutdown();

  // Clear state
  vwapState = {};
  stats = {
    tradesProcessed: 0,
    snapshotsPersisted: 0,
    snapshotErrors: 0,
    lastSnapshotAt: null,
  };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
  config = null;
}

export { ExchangeTradeCollectorError, ExchangeTradeCollectorErrorCodes };
