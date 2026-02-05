/**
 * RTDS Client Core Implementation
 *
 * Manages WebSocket connection to Polymarket's Real Time Data Socket for:
 * - Binance-sourced prices (crypto_prices topic)
 * - Chainlink oracle prices (crypto_prices_chainlink topic)
 *
 * Features:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Exponential backoff for reconnection
 * - Subscriber notification pattern
 * - Message parsing and normalization
 */

import WebSocket from 'ws';
import {
  RTDSError,
  RTDSErrorCodes,
  SUPPORTED_SYMBOLS,
  TOPICS,
  SYMBOL_MAPPING,
  REVERSE_SYMBOL_MAPPING,
  DEFAULT_CONFIG,
  ConnectionState,
} from './types.js';

// Allowed WebSocket URL hosts for security
const ALLOWED_HOSTS = ['ws-live-data.polymarket.com'];

/**
 * RTDSClient class - handles WebSocket connection and price subscriptions
 */
export class RTDSClient {
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

    // Price storage: { symbol: { topic: { price, timestamp, staleness_ms } } }
    this.prices = {};

    // Subscribers: Map<symbol, Set<callback>>
    this.subscribers = new Map();

    // Reconnection state
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;

    // Stats tracking
    this.stats = {
      ticks_received: 0,
      messages_received: 0,
      messages_unrecognized: 0,
      errors: 0,
      reconnects: 0,
      last_tick_at: null,
    };

    // Stale data monitoring
    this.staleCheckInterval = null;

    // Track last stale warning time per symbol/topic to prevent log spam
    this.lastStaleWarning = {};
  }

  /**
   * Initialize the client with configuration
   *
   * @param {Object} config - Configuration options
   * @returns {Promise<void>}
   */
  async initialize(config = {}) {
    this.log.info('rtds_client_initialize_start');

    // Merge with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Validate WebSocket URL for security
    this.validateUrl(this.config.url);

    // Initialize price storage for all supported symbols
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.prices[symbol] = {
        [TOPICS.CRYPTO_PRICES]: null,
        [TOPICS.CRYPTO_PRICES_CHAINLINK]: null,
      };
      this.subscribers.set(symbol, new Set());
    }

    this.initialized = true;
    this.log.info('rtds_client_initialize_complete', {
      url: this.config.url,
      symbols: this.config.symbols,
    });

    // Start connection in background - don't block orchestrator init
    // Reconnection logic handles failures automatically
    this.connect().catch((err) => {
      this.log.warn('rtds_initial_connect_failed', {
        error: err.message,
        will_retry: true,
      });
    });
  }

  /**
   * Validate WebSocket URL for security
   *
   * @param {string} url - URL to validate
   * @throws {RTDSError} If URL is invalid or not allowed
   */
  validateUrl(url) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new RTDSError(
        RTDSErrorCodes.CONNECTION_FAILED,
        `Invalid WebSocket URL format: ${url}`,
        { url }
      );
    }

    // Validate protocol
    if (parsedUrl.protocol !== 'wss:' && parsedUrl.protocol !== 'ws:') {
      throw new RTDSError(
        RTDSErrorCodes.CONNECTION_FAILED,
        `Invalid WebSocket protocol: ${parsedUrl.protocol}`,
        { url, protocol: parsedUrl.protocol }
      );
    }

    // Validate host is in allowed list
    if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
      throw new RTDSError(
        RTDSErrorCodes.CONNECTION_FAILED,
        `WebSocket host not allowed: ${parsedUrl.hostname}`,
        { url, hostname: parsedUrl.hostname, allowed: ALLOWED_HOSTS }
      );
    }
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
      this.log.info('rtds_connecting', { url: this.config.url });

      try {
        this.ws = new WebSocket(this.config.url);
      } catch (err) {
        this.log.error('rtds_websocket_create_failed', { error: err.message });
        this.connectionState = ConnectionState.DISCONNECTED;
        this.scheduleReconnect();
        reject(new RTDSError(
          RTDSErrorCodes.CONNECTION_FAILED,
          `Failed to create WebSocket: ${err.message}`,
          { url: this.config.url }
        ));
        return;
      }

      // Connection timeout
      const connectionTimeout = setTimeout(() => {
        if (this.connectionState === ConnectionState.CONNECTING) {
          this.log.error('rtds_connection_timeout', {
            timeout_ms: this.config.connectionTimeoutMs,
          });
          this.ws.terminate();
          this.connectionState = ConnectionState.DISCONNECTED;
          this.scheduleReconnect();
          reject(new RTDSError(
            RTDSErrorCodes.CONNECTION_FAILED,
            'Connection timeout',
            { timeout_ms: this.config.connectionTimeoutMs }
          ));
        }
      }, this.config.connectionTimeoutMs);

      this.ws.on('open', () => {
        clearTimeout(connectionTimeout);
        this.connectionState = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        this.log.info('rtds_connected', { url: this.config.url });
        console.log(`[RTDS_DIAG] Connected to ${this.config.url}`);

        // Subscribe to topics
        this.subscribeToTopics();

        // Start stale data monitoring
        this.startStaleMonitoring();

        resolve();
      });

      this.ws.on('message', (data) => {
        // Diagnostic: log first 3 raw messages directly to console (bypass logger)
        if ((this.stats.messages_received || 0) < 3) {
          const raw = data.toString().substring(0, 300);
          console.log(`[RTDS_DIAG] msg #${(this.stats.messages_received || 0) + 1}: ${raw}`);
        }
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectionTimeout);
        this.stats.errors++;
        console.log(`[RTDS_DIAG] WebSocket error: ${err.message}`);
        this.log.error('rtds_websocket_error', { error: err.message });
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[RTDS_DIAG] WebSocket closed: code=${code}, reason=${reason?.toString() || 'unknown'}`);
        clearTimeout(connectionTimeout);
        const wasConnected = this.connectionState === ConnectionState.CONNECTED;
        this.connectionState = ConnectionState.DISCONNECTED;
        this.log.warn('rtds_disconnected', {
          code,
          reason: reason?.toString() || 'unknown',
          was_connected: wasConnected,
        });

        // Stop stale monitoring
        this.stopStaleMonitoring();

        // Schedule reconnection if we were initialized
        if (this.initialized) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Subscribe to crypto price topics
   *
   * Uses Polymarket's RTDS subscription format:
   * { action: "subscribe", subscriptions: [{ topic, type, filters }] }
   *
   * Each symbol requires its own subscription entry with a JSON filter.
   */
  subscribeToTopics() {
    if (!this.ws || this.connectionState !== ConnectionState.CONNECTED) {
      return;
    }

    // Build subscription entries for all symbols across both topics
    const subscriptions = [];

    // Binance prices (crypto_prices)
    for (const symbol of Object.values(SYMBOL_MAPPING.binance)) {
      subscriptions.push({
        topic: TOPICS.CRYPTO_PRICES,
        type: '*',
        filters: JSON.stringify({ symbol }),
      });
    }

    // Chainlink prices (crypto_prices_chainlink)
    for (const symbol of Object.values(SYMBOL_MAPPING.chainlink)) {
      subscriptions.push({
        topic: TOPICS.CRYPTO_PRICES_CHAINLINK,
        type: '*',
        filters: JSON.stringify({ symbol }),
      });
    }

    const message = JSON.stringify({
      action: 'subscribe',
      subscriptions,
    });

    this.ws.send(message);
    console.log(`[RTDS_DIAG] Sent subscription: ${message}`);
    this.log.info('rtds_subscribed', {
      subscription_count: subscriptions.length,
      topics: [TOPICS.CRYPTO_PRICES, TOPICS.CRYPTO_PRICES_CHAINLINK],
      symbols: [...Object.values(SYMBOL_MAPPING.binance), ...Object.values(SYMBOL_MAPPING.chainlink)],
    });
  }

  /**
   * Handle incoming WebSocket message
   *
   * @param {Buffer|string} data - Raw message data
   */
  handleMessage(data) {
    try {
      // Security: Check message size before parsing
      const messageSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      if (messageSize > this.config.maxMessageSizeBytes) {
        this.stats.errors++;
        this.log.warn('rtds_message_too_large', {
          size: messageSize,
          max: this.config.maxMessageSizeBytes,
        });
        return;
      }

      const raw = data.toString();
      const message = JSON.parse(raw);

      // Diagnostic: track all messages received
      this.stats.messages_received++;

      // Polymarket RTDS message format: { topic, type, timestamp, payload, connection_id }
      // Payload for crypto_prices: { symbol, timestamp, value }
      if (message.payload) {
        this.handlePriceMessage(message);
      } else if (message.type === 'error') {
        this.log.error('rtds_server_error', { error: message.message || message.payload });
        this.stats.errors++;
      } else {
        // Log unrecognized message types for debugging
        this.stats.messages_unrecognized++;
        // Log first 10 unrecognized messages, then every 100th
        if (this.stats.messages_unrecognized <= 10 || this.stats.messages_unrecognized % 100 === 0) {
          this.log.warn('rtds_message_unrecognized', {
            type: message.type,
            keys: Object.keys(message),
            sample: raw.substring(0, 500),
            count: this.stats.messages_unrecognized,
          });
        }
      }
    } catch (err) {
      this.stats.errors++;
      this.log.warn('rtds_parse_error', {
        error: err.message,
        data: data.toString().substring(0, 200),
      });
    }
  }

  /**
   * Handle Polymarket RTDS price message
   *
   * Polymarket format: { topic, type, timestamp, payload: { symbol, timestamp, value }, connection_id }
   *
   * @param {Object} message - Parsed RTDS message with payload
   */
  handlePriceMessage(message) {
    const { topic, payload } = message;

    // Validate topic
    if (!topic || !Object.values(TOPICS).includes(topic)) {
      this.log.warn('rtds_invalid_topic_in_message', {
        topic: topic,
        validTopics: Object.values(TOPICS),
      });
      return;
    }

    // Payload contains { symbol, timestamp, value }
    const rawSymbol = payload.symbol || payload.s;
    if (!rawSymbol) return;

    // Map to normalized symbol (case-insensitive lookup)
    const normalizedSymbol = REVERSE_SYMBOL_MAPPING[rawSymbol] || REVERSE_SYMBOL_MAPPING[rawSymbol.toLowerCase()];
    if (!normalizedSymbol || !SUPPORTED_SYMBOLS.includes(normalizedSymbol)) {
      return;
    }

    const price = parseFloat(payload.value ?? payload.price ?? payload.p);
    if (isNaN(price) || price <= 0) return;

    const timestamp = payload.timestamp || message.timestamp || Date.now();

    // Defensive check: ensure symbol exists in price storage
    if (!this.prices[normalizedSymbol]) {
      this.log.warn('rtds_unknown_symbol_in_tick', { symbol: normalizedSymbol });
      return;
    }

    // Update stored price
    this.prices[normalizedSymbol][topic] = {
      price: price,
      timestamp: timestamp,
      staleness_ms: 0,
    };

    this.stats.ticks_received++;
    this.stats.last_tick_at = new Date().toISOString();

    // Log first few ticks for diagnostics
    if (this.stats.ticks_received <= 5) {
      this.log.info('rtds_tick_received', {
        symbol: normalizedSymbol,
        topic: topic,
        price: price,
        tick_number: this.stats.ticks_received,
      });
    }

    // Notify subscribers
    const tick = { timestamp, topic, symbol: normalizedSymbol, price };
    this.notifySubscribers(normalizedSymbol, tick);
  }

  /**
   * Handle price update message (legacy format)
   *
   * @param {Object} message - Parsed price update message
   */
  handlePriceUpdate(message) {
    const topic = message.topic;
    const prices = message.prices || [message];

    // Validate topic is present and valid
    if (!topic || !Object.values(TOPICS).includes(topic)) {
      this.log.warn('rtds_invalid_topic_in_message', {
        topic: topic,
        validTopics: Object.values(TOPICS),
      });
      return;
    }

    for (const priceData of prices) {
      try {
        const tick = this.normalizePrice(priceData, topic);
        if (tick) {
          // Defensive check: ensure symbol exists in price storage
          if (!this.prices[tick.symbol]) {
            this.log.warn('rtds_unknown_symbol_in_tick', { symbol: tick.symbol });
            continue;
          }

          // Update stored price
          this.prices[tick.symbol][tick.topic] = {
            price: tick.price,
            timestamp: tick.timestamp,
            staleness_ms: 0,
          };

          this.stats.ticks_received++;
          this.stats.last_tick_at = new Date().toISOString();

          // Log first few ticks for diagnostics
          if (this.stats.ticks_received <= 5) {
            this.log.info('rtds_tick_received', {
              symbol: tick.symbol,
              topic: tick.topic,
              price: tick.price,
              tick_number: this.stats.ticks_received,
            });
          }

          // Notify subscribers
          this.notifySubscribers(tick.symbol, tick);
        }
      } catch (err) {
        this.log.warn('rtds_tick_processing_error', {
          error: err.message,
          data: JSON.stringify(priceData).substring(0, 100),
        });
      }
    }
  }

  /**
   * Normalize price data to standard format
   *
   * @param {Object} data - Raw price data
   * @param {string} topic - Topic the price came from
   * @returns {Object|null} Normalized tick or null if invalid
   */
  normalizePrice(data, topic) {
    // Extract raw symbol
    const rawSymbol = data.symbol || data.s;
    if (!rawSymbol) {
      return null;
    }

    // Map to normalized symbol
    const normalizedSymbol = REVERSE_SYMBOL_MAPPING[rawSymbol.toLowerCase()];
    if (!normalizedSymbol || !SUPPORTED_SYMBOLS.includes(normalizedSymbol)) {
      return null;
    }

    // Extract price
    const price = parseFloat(data.price || data.p);
    if (isNaN(price) || price <= 0) {
      return null;
    }

    // Extract timestamp (use current time if not provided)
    const rawTimestamp = data.timestamp || data.t || Date.now();
    let timestamp;

    if (typeof rawTimestamp === 'number') {
      timestamp = rawTimestamp;
    } else {
      timestamp = Date.parse(rawTimestamp);
      // Check for invalid date string
      if (isNaN(timestamp)) {
        timestamp = Date.now();
        this.log.warn('rtds_invalid_timestamp_format', {
          rawTimestamp,
          symbol: normalizedSymbol,
        });
      }
    }

    return {
      timestamp,
      topic: topic,
      symbol: normalizedSymbol,
      price: price,
    };
  }

  /**
   * Notify subscribers of a price update
   *
   * @param {string} symbol - Symbol that was updated
   * @param {Object} tick - Normalized tick data
   */
  notifySubscribers(symbol, tick) {
    const callbacks = this.subscribers.get(symbol);

    if (callbacks && callbacks.size > 0) {
      for (const cb of callbacks) {
        try {
          cb(tick);
        } catch (err) {
          this.log.error('rtds_subscriber_callback_error', {
            symbol,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Subscribe to price updates for a symbol
   *
   * @param {string} symbol - Symbol to subscribe to (btc, eth, sol, xrp)
   * @param {Function} callback - Callback invoked on each tick: (tick) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(symbol, callback) {
    const normalizedSymbol = symbol.toLowerCase();

    if (!SUPPORTED_SYMBOLS.includes(normalizedSymbol)) {
      throw new RTDSError(
        RTDSErrorCodes.INVALID_SYMBOL,
        `Unsupported symbol: ${symbol}`,
        { symbol, supported: SUPPORTED_SYMBOLS }
      );
    }

    if (typeof callback !== 'function') {
      throw new RTDSError(
        RTDSErrorCodes.SUBSCRIPTION_FAILED,
        'Callback must be a function'
      );
    }

    const subscribers = this.subscribers.get(normalizedSymbol);
    subscribers.add(callback);

    this.log.info('rtds_subscriber_added', {
      symbol: normalizedSymbol,
      subscriber_count: subscribers.size,
    });

    // Return unsubscribe function
    return () => {
      subscribers.delete(callback);
      this.log.info('rtds_subscriber_removed', {
        symbol: normalizedSymbol,
        subscriber_count: subscribers.size,
      });
    };
  }

  /**
   * Get current price for a symbol and topic
   *
   * @param {string} symbol - Symbol (btc, eth, sol, xrp)
   * @param {string} topic - Topic (crypto_prices or crypto_prices_chainlink)
   * @returns {Object|null} Price data or null if not available
   */
  getCurrentPrice(symbol, topic) {
    const normalizedSymbol = symbol.toLowerCase();

    if (!SUPPORTED_SYMBOLS.includes(normalizedSymbol)) {
      throw new RTDSError(
        RTDSErrorCodes.INVALID_SYMBOL,
        `Unsupported symbol: ${symbol}`,
        { symbol, supported: SUPPORTED_SYMBOLS }
      );
    }

    if (topic && !Object.values(TOPICS).includes(topic)) {
      throw new RTDSError(
        RTDSErrorCodes.INVALID_TOPIC,
        `Unsupported topic: ${topic}`,
        { topic, supported: Object.values(TOPICS) }
      );
    }

    const symbolPrices = this.prices[normalizedSymbol];
    if (!symbolPrices) {
      return null;
    }

    // If topic specified, return that topic's price
    if (topic) {
      const priceData = symbolPrices[topic];
      if (!priceData) {
        return null;
      }

      // Calculate current staleness
      const now = Date.now();
      return {
        ...priceData,
        staleness_ms: now - priceData.timestamp,
      };
    }

    // Return all topics for symbol
    const result = {};
    for (const [t, priceData] of Object.entries(symbolPrices)) {
      if (priceData) {
        const now = Date.now();
        result[t] = {
          ...priceData,
          staleness_ms: now - priceData.timestamp,
        };
      }
    }
    return Object.keys(result).length > 0 ? result : null;
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

    this.log.info('rtds_reconnect_scheduled', {
      attempt: this.reconnectAttempts + 1,
      delay_ms: delay,
    });

    // Check for stale data warning
    if (delay >= this.config.staleThresholdMs) {
      this.log.warn('rtds_stale_data_warning', {
        reconnect_delay_ms: delay,
        stale_threshold_ms: this.config.staleThresholdMs,
      });
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      if (!this.initialized) {
        this.log.info('rtds_reconnect_cancelled', { reason: 'client_shutdown' });
        return;
      }

      this.reconnectAttempts++;
      this.stats.reconnects++;

      try {
        await this.connect();
        if (this.connectionState === ConnectionState.CONNECTED) {
          this.log.info('rtds_reconnected');
        }
      } catch (err) {
        this.log.warn('rtds_reconnect_failed', { error: err.message });
        // connect() will schedule another reconnect if needed
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

    // Reset stale warning timestamps
    this.lastStaleWarning = {};

    // Diagnostic: log connection status every 30 seconds
    this._diagCounter = 0;

    this.staleCheckInterval = setInterval(() => {
      const now = Date.now();

      // Periodic diagnostic (every 30s for first 5 min)
      this._diagCounter++;
      if (this._diagCounter % 30 === 0 && this._diagCounter <= 300) {
        console.log(`[RTDS_DIAG] status: connected=${this.connectionState}, ws_state=${this.ws?.readyState}, msgs=${this.stats.messages_received}, ticks=${this.stats.ticks_received}, unrecognized=${this.stats.messages_unrecognized}, errors=${this.stats.errors}`);
      }

      for (const symbol of SUPPORTED_SYMBOLS) {
        for (const topic of Object.values(TOPICS)) {
          const priceData = this.prices[symbol][topic];
          if (priceData && priceData.timestamp) {
            const staleness = now - priceData.timestamp;
            priceData.staleness_ms = staleness;

            if (staleness > this.config.staleThresholdMs) {
              // Rate limit stale warnings to prevent log spam
              const warningKey = `${symbol}:${topic}`;
              const lastWarning = this.lastStaleWarning[warningKey] || 0;

              if (now - lastWarning >= this.config.staleWarningIntervalMs) {
                this.log.warn('rtds_price_stale', {
                  symbol,
                  topic,
                  staleness_ms: staleness,
                  threshold_ms: this.config.staleThresholdMs,
                });
                this.lastStaleWarning[warningKey] = now;
              }
            }
          }
        }
      }
    }, 1000); // Check every second
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
   * Get current client state
   *
   * @returns {Object} State snapshot
   */
  getState() {
    const prices = {};

    for (const symbol of SUPPORTED_SYMBOLS) {
      prices[symbol] = {};
      for (const topic of Object.values(TOPICS)) {
        const priceData = this.prices[symbol][topic];
        if (priceData) {
          const now = Date.now();
          prices[symbol][topic] = {
            price: priceData.price,
            timestamp: priceData.timestamp,
            staleness_ms: now - priceData.timestamp,
          };
        }
      }
    }

    return {
      initialized: this.initialized,
      connected: this.connectionState === ConnectionState.CONNECTED,
      connectionState: this.connectionState,
      subscribedTopics: Object.values(TOPICS),
      prices,
      stats: { ...this.stats },
    };
  }

  /**
   * Shutdown the client gracefully
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.log.info('rtds_client_shutdown_start');

    this.initialized = false;

    // Stop stale monitoring
    this.stopStaleMonitoring();

    // Clear reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client shutdown');
      }
      this.ws = null;
    }

    // Clear subscribers
    for (const subscribers of this.subscribers.values()) {
      subscribers.clear();
    }

    this.connectionState = ConnectionState.DISCONNECTED;
    this.log.info('rtds_client_shutdown_complete');
  }
}
