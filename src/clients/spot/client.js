/**
 * Spot Price Client Core Implementation
 *
 * Manages real-time price feeds with:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Exponential backoff for reconnection
 * - Consecutive error tracking and source disabling
 * - Subscriber notification pattern
 */

import axios from 'axios';
import {
  SpotClientError,
  SpotClientErrorCodes,
  SUPPORTED_CRYPTOS,
  PYTH_PRICE_IDS,
  DEFAULT_CONFIG,
} from './types.js';
import { normalizePrice, isValidPrice } from './normalizer.js';

/**
 * SpotClient class - handles price fetching and subscriptions
 */
export class SpotClient {
  /**
   * @param {Object} options
   * @param {Object} options.logger - Child logger instance
   */
  constructor({ logger }) {
    this.log = logger;
    this.config = null;
    this.initialized = false;
    this.connected = false;
    this.disabled = false;

    // Price storage
    this.prices = {};
    this.lastUpdate = {};

    // Error tracking
    this.consecutiveErrors = 0;
    this.totalErrors = 0;
    this.reconnectAttempts = 0;

    // Subscribers
    this.subscribers = new Map(); // crypto -> Set<callback>

    // Polling
    this.pollingInterval = null;
    this.reconnectTimeout = null;

    // Stats
    this.stats = {
      requests: 0,
      errors: 0,
      reconnects: 0,
      priceUpdates: 0,
    };
  }

  /**
   * Initialize the client with configuration
   *
   * @param {Object} config - Configuration options
   * @returns {Promise<void>}
   */
  async initialize(config = {}) {
    this.log.info('client_initialize_start');

    // Merge with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Validate config
    if (!this.config.hermesUrl) {
      throw new SpotClientError(
        SpotClientErrorCodes.NOT_INITIALIZED,
        'Missing hermesUrl in configuration'
      );
    }

    // Validate URL format
    try {
      new URL(this.config.hermesUrl);
    } catch {
      throw new SpotClientError(
        SpotClientErrorCodes.CONNECTION_FAILED,
        `Invalid hermesUrl format: ${this.config.hermesUrl}`,
        { hermesUrl: this.config.hermesUrl }
      );
    }

    // Initialize price storage for all supported cryptos
    for (const crypto of SUPPORTED_CRYPTOS) {
      this.prices[crypto] = null;
      this.lastUpdate[crypto] = null;
      this.subscribers.set(crypto, new Set());
    }

    this.initialized = true;
    this.log.info('client_initialize_complete', {
      hermesUrl: this.config.hermesUrl,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    // Start connection
    await this.connect();
  }

  /**
   * Connect to the price source
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.disabled) {
      this.log.warn('client_connect_skipped', { reason: 'source_disabled' });
      return;
    }

    this.log.info('client_connect_start');

    try {
      // Test connection with a price fetch
      await this.fetchPrices();

      this.connected = true;
      this.consecutiveErrors = 0;
      this.reconnectAttempts = 0;

      this.log.info('client_connected');

      // Start polling
      this.startPolling();
    } catch (err) {
      this.log.error('client_connect_failed', { error: err.message });
      this.connected = false;

      // Schedule reconnection
      this.scheduleReconnect();
    }
  }

  /**
   * Start periodic price polling
   */
  startPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.log.info('polling_start', { intervalMs: this.config.pollIntervalMs });

    this.pollingInterval = setInterval(async () => {
      if (this.disabled || !this.initialized) {
        this.stopPolling();
        return;
      }

      try {
        await this.fetchPrices();
      } catch (err) {
        // Primary error handling is done in fetchPrices via handleError
        // Log here in case of unexpected errors that escape the handler
        this.log.warn('polling_fetch_error', { error: err.message });
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.log.info('polling_stopped');
    }
  }

  /**
   * Fetch prices from Pyth
   *
   * @returns {Promise<Object>} Fetched prices
   */
  async fetchPrices() {
    if (this.disabled) {
      return null;
    }

    const ids = Object.values(PYTH_PRICE_IDS);
    const url = `${this.config.hermesUrl}/v2/updates/price/latest?${ids.map((id) => `ids[]=${id}`).join('&')}`;

    try {
      this.stats.requests++;

      const response = await axios.get(url, {
        timeout: this.config.requestTimeoutMs,
      });

      const now = Date.now();

      if (response.data?.parsed) {
        for (const update of response.data.parsed) {
          const crypto = Object.keys(PYTH_PRICE_IDS).find(
            (k) => PYTH_PRICE_IDS[k] === '0x' + update.id
          );

          if (crypto && update.price) {
            const normalized = normalizePrice(update.price, 'pyth');

            if (isValidPrice(normalized.price, crypto)) {
              this.prices[crypto] = normalized;
              this.lastUpdate[crypto] = now;
              this.stats.priceUpdates++;

              // Notify subscribers
              this.notifySubscribers(crypto, normalized);
            }
          }
        }
      }

      // Reset consecutive errors on success
      this.consecutiveErrors = 0;
      this.connected = true;

      return this.prices;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  /**
   * Handle fetch errors
   *
   * @param {Error} err - The error that occurred
   */
  handleError(err) {
    this.totalErrors++;
    this.stats.errors++;
    this.consecutiveErrors++;

    this.log.warn('fetch_error', {
      error: err.message,
      consecutiveErrors: this.consecutiveErrors,
    });

    // Check if we should disable the source
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      this.log.error('spot_source_disabled', {
        consecutiveErrors: this.consecutiveErrors,
        threshold: this.config.maxConsecutiveErrors,
      });
      this.disabled = true;
      this.connected = false;
      this.stopPolling();
      return;
    }

    // Handle disconnect
    if (this.connected) {
      this.connected = false;
      this.log.warn('spot_feed_disconnected', {
        consecutiveErrors: this.consecutiveErrors,
      });
      this.stopPolling();
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  scheduleReconnect() {
    if (this.disabled || this.reconnectTimeout) {
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempts),
      this.config.reconnectMaxMs
    );

    this.log.info('spot_reconnect_scheduled', {
      attempt: this.reconnectAttempts + 1,
      delayMs: delay,
    });

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      // Check if shutdown was called during the delay
      if (!this.initialized) {
        this.log.info('reconnect_cancelled', { reason: 'client_shutdown' });
        return;
      }

      this.reconnectAttempts++;
      this.stats.reconnects++;

      try {
        await this.connect();

        if (this.connected) {
          this.log.info('spot_feed_reconnected');
        }
      } catch (err) {
        this.log.warn('spot_reconnect_failed', { error: err.message });
        // connect() will schedule another reconnect if needed
      }
    }, delay);
  }

  /**
   * Get current price for a cryptocurrency
   *
   * @param {string} crypto - Cryptocurrency symbol (btc, eth, sol, xrp)
   * @returns {Object|null} Normalized price or null if unavailable
   */
  getCurrentPrice(crypto) {
    const normalizedCrypto = crypto.toLowerCase();

    if (!SUPPORTED_CRYPTOS.includes(normalizedCrypto)) {
      throw new SpotClientError(
        SpotClientErrorCodes.INVALID_CRYPTO,
        `Unsupported cryptocurrency: ${crypto}`,
        { crypto, supported: SUPPORTED_CRYPTOS }
      );
    }

    const price = this.prices[normalizedCrypto];

    if (!price) {
      return null;
    }

    // Recalculate staleness
    const now = Date.now();
    const timestamp = price.timestamp instanceof Date ? price.timestamp.getTime() : price.timestamp;
    const staleness = Math.floor((now - timestamp) / 1000);

    // Check for stale price and emit warning
    if (staleness > this.config.staleThresholdMs / 1000) {
      this.log.warn('spot_price_stale', {
        crypto: normalizedCrypto,
        staleness,
        thresholdSeconds: this.config.staleThresholdMs / 1000,
      });
    }

    return {
      ...price,
      staleness,
    };
  }

  /**
   * Subscribe to price updates for a cryptocurrency
   *
   * @param {string} crypto - Cryptocurrency symbol
   * @param {Function} callback - Callback function (price) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(crypto, callback) {
    const normalizedCrypto = crypto.toLowerCase();

    if (!SUPPORTED_CRYPTOS.includes(normalizedCrypto)) {
      throw new SpotClientError(
        SpotClientErrorCodes.INVALID_CRYPTO,
        `Unsupported cryptocurrency: ${crypto}`,
        { crypto, supported: SUPPORTED_CRYPTOS }
      );
    }

    if (typeof callback !== 'function') {
      throw new SpotClientError(
        SpotClientErrorCodes.SUBSCRIPTION_ERROR,
        'Callback must be a function'
      );
    }

    const subscribers = this.subscribers.get(normalizedCrypto);
    subscribers.add(callback);

    this.log.info('subscriber_added', {
      crypto: normalizedCrypto,
      subscriberCount: subscribers.size,
    });

    // Return unsubscribe function
    return () => {
      subscribers.delete(callback);
      this.log.info('subscriber_removed', {
        crypto: normalizedCrypto,
        subscriberCount: subscribers.size,
      });
    };
  }

  /**
   * Notify subscribers of a price update
   *
   * @param {string} crypto - Cryptocurrency symbol
   * @param {Object} price - Normalized price
   */
  notifySubscribers(crypto, price) {
    const callbacks = this.subscribers.get(crypto);

    if (callbacks && callbacks.size > 0) {
      for (const cb of callbacks) {
        try {
          cb(price);
        } catch (err) {
          this.log.error('subscriber_callback_error', {
            crypto,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Get current client state
   *
   * @returns {Object} State snapshot
   */
  getState() {
    const prices = {};
    const lastUpdate = {};

    for (const crypto of SUPPORTED_CRYPTOS) {
      const price = this.prices[crypto];
      if (price) {
        const now = Date.now();
        const timestamp = price.timestamp instanceof Date ? price.timestamp.getTime() : price.timestamp;
        prices[crypto] = {
          price: price.price,
          timestamp: price.timestamp,
          source: price.source,
          staleness: Math.floor((now - timestamp) / 1000),
        };
      }
      lastUpdate[crypto] = this.lastUpdate[crypto];
    }

    return {
      initialized: this.initialized,
      connected: this.connected,
      disabled: this.disabled,
      prices,
      lastUpdate,
      consecutiveErrors: this.consecutiveErrors,
      reconnectAttempts: this.reconnectAttempts,
      stats: { ...this.stats },
      subscriberCounts: Object.fromEntries(
        Array.from(this.subscribers.entries()).map(([k, v]) => [k, v.size])
      ),
    };
  }

  /**
   * Shutdown the client gracefully
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.log.info('client_shutdown_start');

    // Stop polling
    this.stopPolling();

    // Clear reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Clear subscribers
    for (const subscribers of this.subscribers.values()) {
      subscribers.clear();
    }

    this.connected = false;
    this.initialized = false;

    this.log.info('client_shutdown_complete');
  }
}
