/**
 * DivergenceTracker Class
 *
 * Core logic for tracking spread between UI and Oracle prices.
 * Calculates raw spread, percentage spread, and direction.
 * Detects threshold breaches and emits events.
 */

import { SUPPORTED_SYMBOLS, TOPICS } from '../../clients/rtds/types.js';
import { DEFAULT_CONFIG, Direction, BreachEventType } from './types.js';

/**
 * DivergenceTracker - tracks spread between UI and Oracle prices
 */
export class DivergenceTracker {
  /**
   * @param {Object} options
   * @param {Object} options.logger - Child logger instance
   * @param {number} [options.thresholdPct] - Threshold for breach detection
   * @param {number} [options.alignedThresholdPct] - Threshold for aligned detection
   */
  constructor(options = {}) {
    this.log = options.logger;
    this.thresholdPct = options.thresholdPct ?? DEFAULT_CONFIG.thresholdPct;
    this.alignedThresholdPct = options.alignedThresholdPct ?? DEFAULT_CONFIG.alignedThresholdPct;

    // Initialize price tracking for all supported symbols
    this.prices = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.prices[symbol] = {
        ui: null,
        oracle: null,
        spread: null,
      };
    }

    // Track breach state per symbol to avoid duplicate events
    this.breachState = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.breachState[symbol] = { breached: false };
    }

    // Subscription callbacks
    this.spreadSubscribers = new Map(); // symbol -> Set of callbacks
    this.breachSubscribers = new Set();

    // Statistics
    this.stats = {
      ticksProcessed: 0,
      breachesDetected: 0,
      lastBreachAt: null,
    };

    // Rate limiting for warning logs (30 second intervals per warning type)
    this.warningRateLimitMs = 30000;
    this.lastWarnings = {
      invalidSymbol: {},   // symbol -> timestamp
      invalidPrice: {},    // `${symbol}:${topic}` -> timestamp
      unknownTopic: {},    // topic -> timestamp
    };
  }

  /**
   * Check if a warning should be rate-limited
   * @param {string} type - Warning type key
   * @param {string} key - Unique key for this warning
   * @returns {boolean} True if warning should be suppressed
   */
  shouldRateLimitWarning(type, key) {
    const now = Date.now();
    const lastTime = this.lastWarnings[type]?.[key] || 0;
    if (now - lastTime < this.warningRateLimitMs) {
      return true;
    }
    this.lastWarnings[type][key] = now;
    return false;
  }

  /**
   * Update price from a tick
   * @param {string} symbol - Normalized symbol (btc, eth, sol, xrp)
   * @param {string} topic - Topic name (crypto_prices or crypto_prices_chainlink)
   * @param {number} price - The price value
   * @returns {Object|null} Updated spread data or null if not calculable
   */
  updatePrice(symbol, topic, price) {
    // Validate inputs
    if (!this.prices[symbol]) {
      if (!this.shouldRateLimitWarning('invalidSymbol', symbol)) {
        this.log?.warn('invalid_symbol_received', { symbol });
      }
      return null;
    }

    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      const key = `${symbol}:${topic}`;
      if (!this.shouldRateLimitWarning('invalidPrice', key)) {
        this.log?.warn('invalid_price_received', { symbol, topic, price, reason: price < 0 ? 'negative_price' : 'not_finite' });
      }
      return null;
    }

    // Only count valid ticks (moved after validation)
    this.stats.ticksProcessed++;

    // Update the appropriate price based on topic
    if (topic === TOPICS.CRYPTO_PRICES) {
      this.prices[symbol].ui = price;
    } else if (topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
      this.prices[symbol].oracle = price;
    } else {
      if (!this.shouldRateLimitWarning('unknownTopic', topic)) {
        this.log?.warn('unknown_topic_received', { symbol, topic });
      }
      return null;
    }

    // Calculate spread
    return this.calculateSpread(symbol);
  }

  /**
   * Calculate spread for a symbol
   * @param {string} symbol - Symbol to calculate spread for
   * @returns {Object|null} Spread data or null if not calculable
   */
  calculateSpread(symbol) {
    const priceData = this.prices[symbol];
    const { ui, oracle } = priceData;

    // Need both prices to calculate spread
    if (ui === null || oracle === null) {
      return null;
    }

    // Calculate raw spread and percentage
    const spread = ui - oracle;
    // Handle division by zero edge case
    const spreadPct = oracle !== 0 ? spread / oracle : 0;
    const direction = this.determineDirection(spreadPct);

    // Update stored spread data
    priceData.spread = {
      raw: spread,
      pct: spreadPct,
      direction,
      ui_price: ui,
      oracle_price: oracle,
      last_updated: new Date().toISOString(),
    };

    // Check for threshold breach
    this.checkBreachThreshold(symbol, spreadPct);

    // Notify spread subscribers
    this.notifySpreadSubscribers(symbol, priceData.spread);

    return priceData.spread;
  }

  /**
   * Determine spread direction
   * @param {number} spreadPct - Percentage spread
   * @returns {string} Direction constant
   */
  determineDirection(spreadPct) {
    if (Math.abs(spreadPct) < this.alignedThresholdPct) {
      return Direction.ALIGNED;
    }
    return spreadPct > 0 ? Direction.UI_LEADING : Direction.UI_LAGGING;
  }

  /**
   * Check if spread exceeds threshold and emit breach events
   * @param {string} symbol - Symbol to check
   * @param {number} spreadPct - Current percentage spread
   */
  checkBreachThreshold(symbol, spreadPct) {
    const absSpread = Math.abs(spreadPct);
    const wasBreached = this.breachState[symbol]?.breached || false;
    const isBreached = absSpread > this.thresholdPct;

    if (isBreached && !wasBreached) {
      // Breach started
      this.breachState[symbol] = {
        breached: true,
        breachStartedAt: new Date().toISOString(),
        spreadAtBreach: spreadPct,
      };

      this.stats.breachesDetected++;
      this.stats.lastBreachAt = new Date().toISOString();

      const breachEvent = {
        type: BreachEventType.STARTED,
        symbol,
        spread_pct: spreadPct,
        threshold_pct: this.thresholdPct,
        direction: this.prices[symbol].spread.direction,
        timestamp: this.breachState[symbol].breachStartedAt,
      };

      this.log?.warn('spread_breach_started', {
        symbol,
        spread_pct: spreadPct,
        threshold_pct: this.thresholdPct,
        direction: this.prices[symbol].spread.direction,
      });

      this.notifyBreachSubscribers(breachEvent);
    } else if (!isBreached && wasBreached) {
      // Breach ended
      const breachStartedAt = this.breachState[symbol].breachStartedAt;
      const breachDurationMs = Date.now() - new Date(breachStartedAt).getTime();

      const breachEvent = {
        type: BreachEventType.ENDED,
        symbol,
        spread_pct: spreadPct,
        threshold_pct: this.thresholdPct,
        breach_duration_ms: breachDurationMs,
        timestamp: new Date().toISOString(),
      };

      this.log?.info('spread_breach_ended', {
        symbol,
        spread_pct: spreadPct,
        breach_duration_ms: breachDurationMs,
      });

      this.breachState[symbol] = { breached: false };

      this.notifyBreachSubscribers(breachEvent);
    }
  }

  /**
   * Subscribe to spread updates for a symbol
   * @param {string} symbol - Symbol to subscribe to
   * @param {Function} callback - Callback invoked on spread update
   * @returns {Function} Unsubscribe function
   */
  subscribeToSpread(symbol, callback) {
    if (!this.spreadSubscribers.has(symbol)) {
      this.spreadSubscribers.set(symbol, new Set());
    }

    this.spreadSubscribers.get(symbol).add(callback);

    // Return unsubscribe function
    return () => {
      const subscribers = this.spreadSubscribers.get(symbol);
      if (subscribers) {
        subscribers.delete(callback);
      }
    };
  }

  /**
   * Subscribe to breach events
   * @param {Function} callback - Callback invoked on breach event
   * @returns {Function} Unsubscribe function
   */
  subscribeToBreaches(callback) {
    this.breachSubscribers.add(callback);

    // Return unsubscribe function
    return () => {
      this.breachSubscribers.delete(callback);
    };
  }

  /**
   * Notify spread subscribers for a symbol
   * @param {string} symbol - Symbol that updated
   * @param {Object} spreadData - Spread data to send
   */
  notifySpreadSubscribers(symbol, spreadData) {
    const subscribers = this.spreadSubscribers.get(symbol);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback({ symbol, ...spreadData });
        } catch (err) {
          this.log?.warn('spread_subscriber_error', {
            symbol,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Notify breach subscribers
   * @param {Object} breachEvent - Breach event data
   */
  notifyBreachSubscribers(breachEvent) {
    for (const callback of this.breachSubscribers) {
      try {
        callback(breachEvent);
      } catch (err) {
        this.log?.warn('breach_subscriber_error', {
          error: err.message,
        });
      }
    }
  }

  /**
   * Get current spread for a symbol
   * @param {string} symbol - Symbol to get spread for
   * @returns {Object|null} Spread data or null if not available
   */
  getSpread(symbol) {
    const priceData = this.prices[symbol];
    if (!priceData) {
      return null;
    }
    return priceData.spread;
  }

  /**
   * Get all spreads
   * @returns {Object} All spreads by symbol
   */
  getAllSpreads() {
    const result = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      result[symbol] = this.prices[symbol].spread;
    }
    return result;
  }

  /**
   * Get breach states
   * @returns {Object} Breach states by symbol (deep copy to prevent mutation)
   */
  getBreachStates() {
    const result = {};
    for (const symbol of Object.keys(this.breachState)) {
      result[symbol] = { ...this.breachState[symbol] };
    }
    return result;
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      ticks_processed: this.stats.ticksProcessed,
      breaches_detected: this.stats.breachesDetected,
      last_breach_at: this.stats.lastBreachAt,
    };
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      thresholdPct: this.thresholdPct,
      alignedThresholdPct: this.alignedThresholdPct,
    };
  }

  /**
   * Clear all subscriptions
   */
  clearSubscriptions() {
    this.spreadSubscribers.clear();
    this.breachSubscribers.clear();
  }

  /**
   * Reset state (primarily for testing)
   */
  reset() {
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.prices[symbol] = {
        ui: null,
        oracle: null,
        spread: null,
      };
      this.breachState[symbol] = { breached: false };
    }
    this.clearSubscriptions();
    this.stats = {
      ticksProcessed: 0,
      breachesDetected: 0,
      lastBreachAt: null,
    };
  }
}
