/**
 * CLOB WebSocket Client
 *
 * Streams real-time L2 order book data from Polymarket's CLOB WebSocket.
 * Follows the RTDS client pattern for connection lifecycle and reconnection.
 *
 * Protocol (from btc-quad-stream.js):
 * - URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Subscribe: { type: 'market', assets_ids: [tokenId] }
 * - event_type: 'book' — full snapshot, rebuild bids/asks
 * - event_type: 'price_change' — incremental deltas via changes array
 * - event_type: 'last_trade_price' — track last trade
 */

import WebSocket from 'ws';
import {
  ClobWsError,
  ClobWsErrorCodes,
  ConnectionState,
  DEFAULT_CONFIG,
} from './types.js';

/**
 * ClobWsClient class - manages WebSocket connection to Polymarket CLOB
 */
export class ClobWsClient {
  /**
   * @param {Object} options
   * @param {Object} options.logger - Child logger instance
   */
  constructor({ logger }) {
    this.log = logger;
    this.config = null;
    this.initialized = false;
    this.connectionState = ConnectionState.DISCONNECTED;
    this.ws = null;

    // Order books: Map<tokenId, { bids: Map<price, size>, asks: Map<price, size>, lastTradePrice }>
    this.books = new Map();

    // Token metadata: Map<tokenId, { symbol }>
    this.tokenMeta = new Map();

    // Subscribers: Map<tokenId, Set<callback>>
    this.subscribers = new Map();

    // Set of token IDs we want subscribed
    this.subscribedTokens = new Set();

    // Reconnection state
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;

    // Stats
    this.stats = {
      bookSnapshots: 0,
      priceChanges: 0,
      lastTradeUpdates: 0,
      errors: 0,
      reconnects: 0,
      lastMessageAt: null,
    };

    // Stale data monitoring
    this.staleCheckInterval = null;
    this.lastStaleWarning = {};
  }

  /**
   * Initialize the client with configuration
   *
   * @param {Object} config - Configuration options
   * @returns {Promise<void>}
   */
  async initialize(config = {}) {
    this.log.info('clob_ws_initialize_start');

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.initialized = true;
    this.log.info('clob_ws_initialize_complete', {
      url: this.config.url,
    });

    // Start connection in background
    this.connect().catch((err) => {
      this.log.warn('clob_ws_initial_connect_failed', {
        error: err.message,
        will_retry: true,
      });
    });
  }

  /**
   * Connect to the WebSocket server
   *
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.connectionState === ConnectionState.CONNECTED) {
        resolve();
        return;
      }

      this.connectionState = ConnectionState.CONNECTING;
      this.log.info('clob_ws_connecting', { url: this.config.url });

      try {
        this.ws = new WebSocket(this.config.url);
      } catch (err) {
        this.log.error('clob_ws_create_failed', { error: err.message });
        this.connectionState = ConnectionState.DISCONNECTED;
        this.scheduleReconnect();
        reject(new ClobWsError(
          ClobWsErrorCodes.CONNECTION_FAILED,
          `Failed to create WebSocket: ${err.message}`,
          { url: this.config.url }
        ));
        return;
      }

      const connectionTimeout = setTimeout(() => {
        if (this.connectionState === ConnectionState.CONNECTING) {
          this.log.error('clob_ws_connection_timeout', {
            timeout_ms: this.config.connectionTimeoutMs,
          });
          this.ws.terminate();
          this.connectionState = ConnectionState.DISCONNECTED;
          this.scheduleReconnect();
          reject(new ClobWsError(
            ClobWsErrorCodes.CONNECTION_FAILED,
            'Connection timeout',
            { timeout_ms: this.config.connectionTimeoutMs }
          ));
        }
      }, this.config.connectionTimeoutMs);

      this.ws.on('open', () => {
        clearTimeout(connectionTimeout);
        this.connectionState = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        this.log.info('clob_ws_connected');

        // Re-subscribe to all tokens
        this.sendSubscriptions();

        // Start stale data monitoring
        this.startStaleMonitoring();

        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectionTimeout);
        this.stats.errors++;
        this.log.error('clob_ws_error', { error: err.message });
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        const wasConnected = this.connectionState === ConnectionState.CONNECTED;
        this.connectionState = ConnectionState.DISCONNECTED;
        this.log.warn('clob_ws_disconnected', {
          code,
          reason: reason?.toString() || 'unknown',
          was_connected: wasConnected,
        });

        this.stopStaleMonitoring();

        if (this.initialized) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Send subscription messages for all tracked tokens
   */
  sendSubscriptions() {
    if (!this.ws || this.connectionState !== ConnectionState.CONNECTED) {
      return;
    }

    if (this.subscribedTokens.size === 0) {
      return;
    }

    const assetsIds = [...this.subscribedTokens];
    const message = JSON.stringify({
      type: 'market',
      assets_ids: assetsIds,
    });

    this.ws.send(message);
    this.log.info('clob_ws_subscribed', {
      token_count: assetsIds.length,
      tokens: assetsIds.map(t => t.substring(0, 16) + '...'),
    });
  }

  /**
   * Subscribe to a token's order book updates
   *
   * @param {string} tokenId - Token ID to subscribe to
   * @param {string} symbol - Symbol label (for logging)
   */
  subscribeToken(tokenId, symbol) {
    if (!tokenId) return;

    // Initialize book if not exists
    if (!this.books.has(tokenId)) {
      this.books.set(tokenId, {
        bids: new Map(),
        asks: new Map(),
        lastTradePrice: null,
        lastUpdateAt: null,
      });
    }

    this.tokenMeta.set(tokenId, { symbol });

    if (!this.subscribers.has(tokenId)) {
      this.subscribers.set(tokenId, new Set());
    }

    const wasSubscribed = this.subscribedTokens.has(tokenId);
    this.subscribedTokens.add(tokenId);

    // If already connected and this is a new token, re-send subscriptions
    if (!wasSubscribed && this.connectionState === ConnectionState.CONNECTED) {
      this.sendSubscriptions();
    }

    this.log.info('clob_ws_token_subscribed', {
      token_id: tokenId.substring(0, 16) + '...',
      symbol,
    });
  }

  /**
   * Unsubscribe from a token
   *
   * @param {string} tokenId - Token ID to unsubscribe
   */
  unsubscribeToken(tokenId) {
    this.subscribedTokens.delete(tokenId);
    this.books.delete(tokenId);
    this.tokenMeta.delete(tokenId);
    const subs = this.subscribers.get(tokenId);
    if (subs) {
      subs.clear();
      this.subscribers.delete(tokenId);
    }
  }

  /**
   * Subscribe to book change events for a token
   *
   * @param {string} tokenId - Token ID
   * @param {Function} callback - Called on book updates
   * @returns {Function} Unsubscribe function
   */
  subscribe(tokenId, callback) {
    if (!this.subscribers.has(tokenId)) {
      this.subscribers.set(tokenId, new Set());
    }

    this.subscribers.get(tokenId).add(callback);

    return () => {
      const subs = this.subscribers.get(tokenId);
      if (subs) {
        subs.delete(callback);
      }
    };
  }

  /**
   * Handle incoming WebSocket message
   *
   * @param {Buffer|string} data - Raw message data
   */
  handleMessage(data) {
    try {
      const messageSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      if (messageSize > this.config.maxMessageSizeBytes) {
        this.stats.errors++;
        this.log.warn('clob_ws_message_too_large', {
          size: messageSize,
          max: this.config.maxMessageSizeBytes,
        });
        return;
      }

      const raw = data.toString();
      const msg = JSON.parse(raw);
      const now = Date.now();

      this.stats.lastMessageAt = new Date(now).toISOString();

      // Determine which token this message is for
      const assetId = msg.asset_id;

      switch (msg.event_type) {
        case 'book':
          this.handleBookSnapshot(assetId, msg, now);
          break;
        case 'price_change':
          this.handlePriceChange(assetId, msg, now);
          break;
        case 'last_trade_price':
          this.handleLastTrade(assetId, msg, now);
          break;
        default:
          // Ignore other event types (tick_size, etc.)
          break;
      }
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors <= 5 || this.stats.errors % 100 === 0) {
        this.log.warn('clob_ws_parse_error', {
          error: err.message,
          data: data.toString().substring(0, 200),
          error_count: this.stats.errors,
        });
      }
    }
  }

  /**
   * Handle full book snapshot (event_type: 'book')
   *
   * @param {string} assetId - Asset/token ID
   * @param {Object} msg - Message payload
   * @param {number} now - Current timestamp
   */
  handleBookSnapshot(assetId, msg, now) {
    // Find which book this belongs to
    // The CLOB WS may send book updates for any subscribed asset
    const book = this.findOrCreateBook(assetId);
    if (!book) return;

    book.bids.clear();
    book.asks.clear();

    for (const b of (msg.bids || [])) {
      const size = parseFloat(b.size);
      if (size > 0) {
        book.bids.set(b.price, size);
      }
    }

    for (const a of (msg.asks || [])) {
      const size = parseFloat(a.size);
      if (size > 0) {
        book.asks.set(a.price, size);
      }
    }

    book.lastUpdateAt = now;
    this.stats.bookSnapshots++;

    // Log first few snapshots
    if (this.stats.bookSnapshots <= 3) {
      const meta = this.tokenMeta.get(assetId);
      this.log.info('clob_ws_book_snapshot', {
        asset_id: assetId?.substring(0, 16) + '...',
        symbol: meta?.symbol,
        bids: book.bids.size,
        asks: book.asks.size,
      });
    }

    this.notifySubscribers(assetId, 'book');
  }

  /**
   * Handle incremental price change (event_type: 'price_change')
   *
   * @param {string} assetId - Asset/token ID
   * @param {Object} msg - Message payload
   * @param {number} now - Current timestamp
   */
  handlePriceChange(assetId, msg, now) {
    const book = this.findOrCreateBook(assetId);
    if (!book) return;

    if (msg.changes) {
      for (const change of msg.changes) {
        const side = change.side === 'BUY' ? book.bids : book.asks;
        const size = parseFloat(change.size);
        if (size === 0) {
          side.delete(change.price);
        } else {
          side.set(change.price, size);
        }
      }
    } else if (msg.price) {
      // Some price_change events have a direct price, not incremental
      // Ignore these for book building; they don't provide depth info
    }

    book.lastUpdateAt = now;
    this.stats.priceChanges++;

    this.notifySubscribers(assetId, 'price_change');
  }

  /**
   * Handle last trade price (event_type: 'last_trade_price')
   *
   * @param {string} assetId - Asset/token ID
   * @param {Object} msg - Message payload
   * @param {number} now - Current timestamp
   */
  handleLastTrade(assetId, msg, now) {
    const book = this.findOrCreateBook(assetId);
    if (!book) return;

    if (msg.price) {
      book.lastTradePrice = parseFloat(msg.price);
    }
    book.lastUpdateAt = now;
    this.stats.lastTradeUpdates++;
  }

  /**
   * Find or create a book for an asset ID
   *
   * @param {string} assetId - Asset/token ID
   * @returns {Object|null} Book object or null
   */
  findOrCreateBook(assetId) {
    if (!assetId) return null;

    if (this.books.has(assetId)) {
      return this.books.get(assetId);
    }

    // If this token is in our subscribed set, create it
    if (this.subscribedTokens.has(assetId)) {
      const book = {
        bids: new Map(),
        asks: new Map(),
        lastTradePrice: null,
        lastUpdateAt: null,
      };
      this.books.set(assetId, book);
      return book;
    }

    return null;
  }

  /**
   * Get order book for a token
   *
   * @param {string} tokenId - Token ID
   * @returns {Object|null} { bids: [[price, size]...], asks: [[price, size]...], bestBid, bestAsk, mid, spread }
   */
  getBook(tokenId) {
    const book = this.books.get(tokenId);
    if (!book) return null;

    // Sort bids descending (highest first), asks ascending (lowest first)
    const bids = [...book.bids.entries()]
      .map(([p, s]) => [parseFloat(p), s])
      .sort((a, b) => b[0] - a[0]);

    const asks = [...book.asks.entries()]
      .map(([p, s]) => [parseFloat(p), s])
      .sort((a, b) => a[0] - b[0]);

    const bestBid = bids.length > 0 ? bids[0][0] : null;
    const bestAsk = asks.length > 0 ? asks[0][0] : null;
    const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2 : null;
    const spread = (bestBid != null && bestAsk != null) ? bestAsk - bestBid : null;

    return {
      bids,
      asks,
      bestBid,
      bestAsk,
      mid,
      spread,
      lastTradePrice: book.lastTradePrice,
      lastUpdateAt: book.lastUpdateAt,
    };
  }

  /**
   * Get a serializable book snapshot for DB persistence
   *
   * @param {string} tokenId - Token ID
   * @returns {Object|null} Snapshot with computed depth metrics
   */
  getBookSnapshot(tokenId) {
    const book = this.getBook(tokenId);
    if (!book) return null;

    // Calculate 1% depth (dollar value within 1% of best price)
    let bidDepth1pct = 0;
    let askDepth1pct = 0;

    if (book.bestBid != null) {
      const bidThreshold = book.bestBid * 0.99;
      for (const [price, size] of book.bids) {
        if (price >= bidThreshold) {
          bidDepth1pct += price * size;
        }
      }
    }

    if (book.bestAsk != null) {
      const askThreshold = book.bestAsk * 1.01;
      for (const [price, size] of book.asks) {
        if (price <= askThreshold) {
          askDepth1pct += price * size;
        }
      }
    }

    return {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      mid: book.mid,
      spread: book.spread,
      bidDepth1pct,
      askDepth1pct,
      bids: book.bids,
      asks: book.asks,
      lastTradePrice: book.lastTradePrice,
      lastUpdateAt: book.lastUpdateAt,
    };
  }

  /**
   * Notify subscribers of a book update
   *
   * @param {string} tokenId - Token ID
   * @param {string} eventType - Event type
   */
  notifySubscribers(tokenId, eventType) {
    const callbacks = this.subscribers.get(tokenId);
    if (callbacks && callbacks.size > 0) {
      const book = this.getBook(tokenId);
      for (const cb of callbacks) {
        try {
          cb({ tokenId, eventType, book });
        } catch (err) {
          this.log.error('clob_ws_subscriber_error', {
            token_id: tokenId?.substring(0, 16),
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectTimeout || !this.initialized) {
      return;
    }

    this.connectionState = ConnectionState.RECONNECTING;

    const delay = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectIntervalMs
    );

    this.log.info('clob_ws_reconnect_scheduled', {
      attempt: this.reconnectAttempts + 1,
      delay_ms: delay,
    });

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      if (!this.initialized) return;

      this.reconnectAttempts++;
      this.stats.reconnects++;

      try {
        await this.connect();
      } catch (err) {
        this.log.warn('clob_ws_reconnect_failed', { error: err.message });
      }
    }, delay);
  }

  /**
   * Start stale data monitoring
   */
  startStaleMonitoring() {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
    }
    this.lastStaleWarning = {};

    this.staleCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [tokenId, book] of this.books) {
        if (book.lastUpdateAt) {
          const staleness = now - book.lastUpdateAt;
          if (staleness > this.config.staleThresholdMs) {
            const lastWarning = this.lastStaleWarning[tokenId] || 0;
            if (now - lastWarning >= this.config.staleWarningIntervalMs) {
              const meta = this.tokenMeta.get(tokenId);
              this.log.warn('clob_ws_book_stale', {
                token_id: tokenId?.substring(0, 16) + '...',
                symbol: meta?.symbol,
                staleness_ms: staleness,
              });
              this.lastStaleWarning[tokenId] = now;
            }
          }
        }
      }
    }, 5000);
  }

  /**
   * Stop stale data monitoring
   */
  stopStaleMonitoring() {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
  }

  /**
   * Get client state
   *
   * @returns {Object} State snapshot
   */
  getState() {
    const bookSummaries = {};
    for (const [tokenId, book] of this.books) {
      const meta = this.tokenMeta.get(tokenId);
      const bk = this.getBook(tokenId);
      bookSummaries[tokenId.substring(0, 16)] = {
        symbol: meta?.symbol,
        bids: book.bids.size,
        asks: book.asks.size,
        bestBid: bk?.bestBid,
        bestAsk: bk?.bestAsk,
        mid: bk?.mid,
        spread: bk?.spread,
        lastUpdateAt: book.lastUpdateAt ? new Date(book.lastUpdateAt).toISOString() : null,
      };
    }

    return {
      initialized: this.initialized,
      connected: this.connectionState === ConnectionState.CONNECTED,
      connectionState: this.connectionState,
      subscribedTokens: this.subscribedTokens.size,
      books: bookSummaries,
      stats: { ...this.stats },
    };
  }

  /**
   * Shutdown the client gracefully
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.log.info('clob_ws_shutdown_start');

    this.initialized = false;

    this.stopStaleMonitoring();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client shutdown');
      }
      this.ws = null;
    }

    // Clear all state
    for (const subs of this.subscribers.values()) {
      subs.clear();
    }
    this.subscribers.clear();
    this.books.clear();
    this.tokenMeta.clear();
    this.subscribedTokens.clear();

    this.connectionState = ConnectionState.DISCONNECTED;
    this.log.info('clob_ws_shutdown_complete');
  }
}
