/**
 * CCXT Pro WebSocket Client
 *
 * Manages WebSocket connections to 21 exchanges for real-time trade streams.
 * Normalizes trades and dispatches to subscribers via a pub/sub pattern.
 *
 * Each exchange gets ONE WebSocket connection (symbols multiplexed by CCXT).
 * Uses `newUpdates: true` to keep memory bounded.
 *
 * @module clients/ccxt-ws
 */

import ccxt from 'ccxt';
import { CcxtWsError, CcxtWsErrorCodes, DEFAULT_CONFIG } from './types.js';

// 21 exchanges — same list as src/clients/ccxt/index.js
const EXCHANGES = [
  'binance', 'coinbaseexchange', 'kraken', 'bybit', 'okx',
  'bitstamp', 'gemini', 'bitfinex', 'htx', 'gateio',
  'kucoin', 'mexc', 'cryptocom', 'bitget',
  'upbit', 'poloniex', 'whitebit', 'bingx', 'lbank', 'phemex', 'bitmart',
];

// Exchanges that use USD pairs (rest use USDT)
const USD_EXCHANGES = new Set(['coinbaseexchange', 'bitstamp', 'gemini', 'bitfinex']);

const USDT_SYMBOLS = {
  btc: 'BTC/USDT',
  eth: 'ETH/USDT',
  sol: 'SOL/USDT',
  xrp: 'XRP/USDT',
};

const USD_SYMBOLS = {
  btc: 'BTC/USD',
  eth: 'ETH/USD',
  sol: 'SOL/USD',
  xrp: 'XRP/USD',
};

/**
 * CcxtWsClient — real-time trade stream manager
 */
export class CcxtWsClient {
  /**
   * @param {Object} options
   * @param {Object} options.logger - Child logger instance
   * @param {string[]} [options.cryptos] - Cryptos to watch (default: all 4)
   */
  constructor({ logger, cryptos }) {
    this.log = logger;
    this.cryptos = cryptos || Object.keys(USDT_SYMBOLS);
    this.config = null;
    this.initialized = false;

    /** @type {Object<string, Object>} CCXT Pro exchange instances keyed by name */
    this.exchanges = {};

    /** Per-exchange per-symbol watch loop abort controllers */
    this.watchLoops = new Map(); // key: `${exchange}:${symbol}` → { running: true }

    /** Subscribers: Map<symbol, Set<callback>> */
    this.subscribers = new Map();
    for (const crypto of this.cryptos) {
      this.subscribers.set(crypto, new Set());
    }

    /** Per-exchange stats */
    this.exchangeStats = {};

    /** Per-exchange reconnect state */
    this.reconnectState = {};

    /** Stale monitoring interval */
    this.staleCheckInterval = null;
  }

  /**
   * Initialize the client with configuration and create exchange instances
   *
   * @param {Object} [config] - Optional config overrides
   */
  async initialize(config = {}) {
    this.log.info('ccxt_ws_initialize_start');

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create CCXT Pro instances for all exchanges
    for (const name of EXCHANGES) {
      try {
        if (!ccxt.pro[name]) {
          this.log.warn('ccxt_ws_exchange_not_in_pro', { exchange: name });
          continue;
        }

        this.exchanges[name] = new ccxt.pro[name]({
          newUpdates: true,
          enableRateLimit: true,
        });

        this.exchangeStats[name] = {
          tradesReceived: 0,
          errors: 0,
          lastTradeAt: null,
          connected: false,
        };

        this.reconnectState[name] = {
          attempts: 0,
          backoffMs: this.config.reconnectIntervalMs,
        };
      } catch (err) {
        this.log.warn('ccxt_ws_exchange_init_failed', {
          exchange: name,
          error: err.message,
        });
      }
    }

    this.initialized = true;

    this.log.info('ccxt_ws_initialize_complete', {
      exchanges: Object.keys(this.exchanges).length,
      cryptos: this.cryptos,
    });
  }

  /**
   * Start watching trades on all exchanges for all configured cryptos
   */
  async startWatching() {
    if (!this.initialized) {
      throw new CcxtWsError(
        CcxtWsErrorCodes.NOT_INITIALIZED,
        'Client not initialized. Call initialize() first.'
      );
    }

    this.log.info('ccxt_ws_start_watching', {
      exchanges: Object.keys(this.exchanges).length,
      cryptos: this.cryptos,
    });

    // Start watch loops for each exchange × symbol
    for (const exchangeName of Object.keys(this.exchanges)) {
      for (const crypto of this.cryptos) {
        this.startWatchLoop(exchangeName, crypto);
      }
    }

    // Start stale monitoring
    this.startStaleMonitoring();
  }

  /**
   * Start a single watchTrades loop for one exchange + symbol.
   * Runs indefinitely until stopped or exchange errors out.
   *
   * @param {string} exchangeName
   * @param {string} crypto
   * @private
   */
  startWatchLoop(exchangeName, crypto) {
    const key = `${exchangeName}:${crypto}`;
    const loopState = { running: true };
    this.watchLoops.set(key, loopState);

    const exchange = this.exchanges[exchangeName];
    const symbolMap = USD_EXCHANGES.has(exchangeName) ? USD_SYMBOLS : USDT_SYMBOLS;
    const ccxtSymbol = symbolMap[crypto];

    if (!ccxtSymbol) return;

    const runLoop = async () => {
      while (loopState.running) {
        try {
          const trades = await exchange.watchTrades(ccxtSymbol);

          // Reset reconnect state on success
          const rs = this.reconnectState[exchangeName];
          if (rs) {
            rs.attempts = 0;
            rs.backoffMs = this.config.reconnectIntervalMs;
          }

          const stats = this.exchangeStats[exchangeName];
          if (stats && !stats.connected) {
            stats.connected = true;
          }

          // Process each trade
          for (const trade of trades) {
            const normalized = {
              timestamp: trade.timestamp || Date.now(),
              received_at: Date.now(),
              exchange: exchangeName,
              symbol: crypto,
              side: trade.side || null,
              price: trade.price,
              amount: trade.amount,
              cost: trade.cost || (trade.price * trade.amount),
            };

            if (stats) {
              stats.tradesReceived++;
              stats.lastTradeAt = normalized.received_at;
            }

            // Notify subscribers
            this.notifySubscribers(crypto, normalized);
          }
        } catch (err) {
          if (!loopState.running) break;

          const stats = this.exchangeStats[exchangeName];
          if (stats) {
            stats.errors++;
            stats.connected = false;
          }

          // Log errors sparingly
          const errorCount = stats?.errors || 0;
          if (errorCount <= 3 || errorCount % 60 === 0) {
            this.log.warn('ccxt_ws_watch_error', {
              exchange: exchangeName,
              symbol: crypto,
              error: err.message,
              errorCount,
            });
          }

          // Exponential backoff before retry
          const rs = this.reconnectState[exchangeName];
          if (rs) {
            const delay = Math.min(rs.backoffMs, this.config.maxReconnectIntervalMs);
            await this.sleep(delay);
            rs.backoffMs = Math.min(rs.backoffMs * 2, this.config.maxReconnectIntervalMs);
            rs.attempts++;
          } else {
            await this.sleep(this.config.reconnectIntervalMs);
          }
        }
      }
    };

    // Fire and forget — errors handled inside the loop
    runLoop().catch(err => {
      this.log.error('ccxt_ws_loop_fatal', {
        exchange: exchangeName,
        symbol: crypto,
        error: err.message,
      });
    });
  }

  /**
   * Notify subscribers for a given symbol
   *
   * @param {string} symbol
   * @param {Object} trade - Normalized trade
   * @private
   */
  notifySubscribers(symbol, trade) {
    const callbacks = this.subscribers.get(symbol);
    if (!callbacks || callbacks.size === 0) return;

    for (const cb of callbacks) {
      try {
        cb(trade);
      } catch (err) {
        this.log.error('ccxt_ws_subscriber_error', {
          symbol,
          error: err.message,
        });
      }
    }
  }

  /**
   * Subscribe to trade events for a symbol
   *
   * @param {string} symbol - Crypto symbol (btc, eth, sol, xrp)
   * @param {Function} callback - (trade) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(symbol, callback) {
    const normalized = symbol.toLowerCase();
    if (!this.subscribers.has(normalized)) {
      throw new CcxtWsError(
        CcxtWsErrorCodes.WATCH_FAILED,
        `Unsupported symbol: ${symbol}`,
        { symbol, supported: this.cryptos }
      );
    }

    if (typeof callback !== 'function') {
      throw new CcxtWsError(
        CcxtWsErrorCodes.WATCH_FAILED,
        'Callback must be a function'
      );
    }

    this.subscribers.get(normalized).add(callback);

    return () => {
      this.subscribers.get(normalized)?.delete(callback);
    };
  }

  /**
   * Start stale monitoring — warn if exchanges go quiet
   * @private
   */
  startStaleMonitoring() {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
    }

    this.staleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [name, stats] of Object.entries(this.exchangeStats)) {
        if (stats.lastTradeAt && (now - stats.lastTradeAt) > this.config.staleThresholdMs) {
          this.log.warn('ccxt_ws_exchange_stale', {
            exchange: name,
            lastTradeMs: now - stats.lastTradeAt,
            threshold: this.config.staleThresholdMs,
          });
        }
      }
    }, this.config.staleCheckIntervalMs);

    if (this.staleCheckInterval.unref) {
      this.staleCheckInterval.unref();
    }
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return {
      initialized: this.initialized,
      exchanges: Object.entries(this.exchangeStats).map(([name, stats]) => ({
        name,
        ...stats,
      })),
      activeLoops: this.watchLoops.size,
      cryptos: this.cryptos,
    };
  }

  /**
   * Get list of exchange names
   * @returns {string[]}
   */
  getExchangeNames() {
    return Object.keys(this.exchanges);
  }

  /**
   * Shutdown — close all connections
   */
  async shutdown() {
    this.log.info('ccxt_ws_shutdown_start');

    this.initialized = false;

    // Stop stale monitoring
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }

    // Stop all watch loops
    for (const [key, loopState] of this.watchLoops) {
      loopState.running = false;
    }
    this.watchLoops.clear();

    // Close all exchange connections
    const closePromises = Object.entries(this.exchanges).map(async ([name, exchange]) => {
      try {
        if (typeof exchange.close === 'function') {
          await exchange.close();
        }
      } catch (err) {
        this.log.warn('ccxt_ws_exchange_close_error', {
          exchange: name,
          error: err.message,
        });
      }
    });

    await Promise.allSettled(closePromises);

    // Clear subscribers
    for (const callbacks of this.subscribers.values()) {
      callbacks.clear();
    }

    this.exchanges = {};
    this.exchangeStats = {};
    this.reconnectState = {};

    this.log.info('ccxt_ws_shutdown_complete');
  }

  /**
   * @private
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
