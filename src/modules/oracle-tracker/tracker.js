/**
 * Oracle Pattern Tracker
 *
 * Core logic for detecting and tracking oracle price updates.
 * Tracks previous prices per symbol and creates update records
 * only when meaningful price changes occur.
 */

import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * OraclePatternTracker - Detects oracle price updates
 */
export class OraclePatternTracker {
  /**
   * @param {Object} options - Tracker configuration
   * @param {number} [options.minDeviationForUpdate=0.0001] - Minimum deviation to count as update
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.minDeviationForUpdate = options.minDeviationForUpdate ?? DEFAULT_CONFIG.minDeviationForUpdate;
    this.logger = options.logger || null;

    // Track previous price per symbol - dynamically built from SUPPORTED_SYMBOLS
    // Format: { btc: { price: 95000, timestamp: 1706745600000 }, ... }
    this.previousPrices = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.previousPrices[symbol] = { price: null, timestamp: null };
    }

    // Track update counts per symbol
    this.updateCounts = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.updateCounts[symbol] = 0;
    }
  }

  /**
   * Handle an incoming oracle tick and detect if it's an update
   *
   * @param {Object} tick - Normalized tick { timestamp, topic, symbol, price }
   * @returns {Object|null} Update record if price changed, null otherwise
   */
  handleOracleTick(tick) {
    // Validate tick - reject null, missing symbol, non-finite prices, or zero/negative prices
    if (!tick || !tick.symbol || typeof tick.price !== 'number' || !Number.isFinite(tick.price) || tick.price <= 0) {
      return null;
    }

    const symbol = tick.symbol;
    const prev = this.previousPrices[symbol];

    // Skip unknown symbols
    if (!prev) {
      return null;
    }

    // Get timestamp - accept both number and Date
    let tickTimestamp;
    if (typeof tick.timestamp === 'number') {
      tickTimestamp = tick.timestamp;
    } else if (tick.timestamp instanceof Date) {
      tickTimestamp = tick.timestamp.getTime();
    } else {
      tickTimestamp = Date.now();
    }

    // First tick for this symbol - store but don't create update record
    if (prev.price === null) {
      this.previousPrices[symbol] = {
        price: tick.price,
        timestamp: tickTimestamp,
      };
      return null;
    }

    // Calculate deviation (prev.price is guaranteed > 0 since we reject zero prices on entry)
    const deviationPct = (tick.price - prev.price) / prev.price;

    // Only create update record if deviation exceeds minimum threshold
    if (Math.abs(deviationPct) < this.minDeviationForUpdate) {
      return null; // No meaningful update
    }

    // Calculate time since previous update
    const timeSincePreviousMs = tickTimestamp - prev.timestamp;

    // Reject out-of-order ticks (negative time difference)
    // This can happen with network delays or clock skew
    if (timeSincePreviousMs < 0) {
      if (this.logger) {
        this.logger.warn('out_of_order_tick', {
          symbol,
          tick_timestamp: tickTimestamp,
          prev_timestamp: prev.timestamp,
          time_diff_ms: timeSincePreviousMs,
        });
      }
      return null;
    }

    // Create update record
    const updateRecord = {
      timestamp: new Date(tickTimestamp).toISOString(),
      symbol: symbol,
      price: tick.price,
      previous_price: prev.price,
      deviation_from_previous_pct: deviationPct,
      time_since_previous_ms: timeSincePreviousMs,
    };

    // Update previous price
    this.previousPrices[symbol] = {
      price: tick.price,
      timestamp: tickTimestamp,
    };

    // Increment update count
    this.updateCounts[symbol]++;

    return updateRecord;
  }

  /**
   * Get current tracking state for a symbol
   *
   * @param {string} symbol - Cryptocurrency symbol
   * @returns {Object|null} Tracking state or null if unknown symbol
   */
  getTrackingState(symbol) {
    const prev = this.previousPrices[symbol];
    if (!prev) {
      return null;
    }

    return {
      last_price: prev.price,
      last_update_at: prev.timestamp ? new Date(prev.timestamp).toISOString() : null,
      updates_recorded: this.updateCounts[symbol] || 0,
    };
  }

  /**
   * Get tracking state for all symbols
   *
   * @returns {Object} Tracking state keyed by symbol
   */
  getAllTrackingStates() {
    const states = {};
    for (const symbol of Object.keys(this.previousPrices)) {
      states[symbol] = this.getTrackingState(symbol);
    }
    return states;
  }

  /**
   * Reset tracking state
   */
  reset() {
    for (const symbol of Object.keys(this.previousPrices)) {
      this.previousPrices[symbol] = { price: null, timestamp: null };
      this.updateCounts[symbol] = 0;
    }
  }
}
