/**
 * Oracle Edge Signal Generator Class
 *
 * Evaluates windows for oracle edge conditions and generates entry signals
 * when all conditions are met. Uses data from staleness-detector and
 * divergence-tracker to make signal decisions.
 *
 * @module modules/oracle-edge-signal/generator
 */

import { SignalDirection, OracleEdgeSignalError, OracleEdgeSignalErrorCodes } from './types.js';

// Quality gate module reference (loaded dynamically)
let qualityGateModule = null;
let qualityGateLoadAttempted = false;

/**
 * Load quality gate module for signal blocking
 */
async function loadQualityGateModule(logger) {
  if (qualityGateLoadAttempted) {
    return qualityGateModule;
  }
  qualityGateLoadAttempted = true;

  try {
    qualityGateModule = await import('../quality-gate/index.js');
    if (logger) {
      logger.info('quality_gate_loaded');
    }
  } catch (err) {
    qualityGateModule = null;
    if (logger) {
      logger.debug('quality_gate_unavailable', { error: err.message });
    }
  }
  return qualityGateModule;
}

/**
 * OracleEdgeSignalGenerator class
 *
 * Evaluates trading windows for oracle edge entry conditions.
 * Generates signals when UI/Oracle divergence exists near expiry with stale oracle.
 */
export class OracleEdgeSignalGenerator {
  /**
   * Create a new OracleEdgeSignalGenerator
   *
   * @param {Object} options - Generator options
   * @param {Object} options.config - Configuration
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.stalenessDetector - Staleness detector module
   * @param {Object} options.divergenceTracker - Divergence tracker module
   */
  constructor({ config, logger, stalenessDetector, divergenceTracker }) {
    this.config = config;
    this.log = logger;
    this.stalenessDetector = stalenessDetector;
    this.divergenceTracker = divergenceTracker;
    this.subscribers = new Set();
    this.stats = {
      signals_generated: 0,
      evaluations_total: 0,
      signals_blocked_by_quality_gate: 0,
      signals_by_direction: {
        [SignalDirection.FADE_UP]: 0,
        [SignalDirection.FADE_DOWN]: 0,
      },
      signals_by_symbol: {},
      total_confidence: 0,
    };

    // Try to load quality gate module
    loadQualityGateModule(this.log);
  }

  /**
   * Evaluate a window for oracle edge signal
   *
   * @param {Object} windowData - Window from window-manager
   * @param {string} windowData.window_id - Unique window identifier
   * @param {string} windowData.crypto - Symbol (btc, eth, sol, xrp)
   * @param {number} windowData.time_remaining_ms - Time until expiry
   * @param {number} windowData.market_price - Market token price (0-1)
   * @param {string} windowData.token_id_up - UP token identifier
   * @param {string} windowData.token_id_down - DOWN token identifier
   * @returns {Object|null} Signal object or null if no signal
   */
  evaluateWindow(windowData) {
    this.stats.evaluations_total++;

    // Check quality gate before generating signals (Story 7-9)
    if (qualityGateModule && typeof qualityGateModule.shouldAllowSignal === 'function') {
      try {
        if (!qualityGateModule.shouldAllowSignal()) {
          this.stats.signals_blocked_by_quality_gate++;
          this.log.debug('signal_blocked_by_quality_gate', {
            window_id: windowData?.window_id,
          });
          return null;
        }
      } catch (err) {
        // Quality gate not initialized or errored - allow signals but log
        this.log.debug('quality_gate_check_failed', {
          error: err.message,
          window_id: windowData?.window_id,
        });
      }
    }

    // Validate window data
    if (!windowData || !windowData.window_id) {
      this.log.debug('window_evaluated_no_signal', {
        reason: 'invalid_window_data',
      });
      return null;
    }

    const {
      window_id,
      crypto,
      time_remaining_ms,
      market_price,
      token_id_up,
      token_id_down,
    } = windowData;

    const symbol = crypto;

    // Validate required fields and types
    if (typeof time_remaining_ms !== 'number' || !Number.isFinite(time_remaining_ms)) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'invalid_time_remaining',
        time_remaining_ms,
      });
      return null;
    }

    if (typeof market_price !== 'number' || !Number.isFinite(market_price) ||
        market_price < 0 || market_price > 1) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'invalid_market_price',
        market_price,
      });
      return null;
    }

    // Validate token IDs are present
    if (!token_id_up || !token_id_down) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'missing_token_ids',
        token_id_up: !!token_id_up,
        token_id_down: !!token_id_down,
      });
      return null;
    }

    // Condition 1: Time to expiry check (reject expired windows or too early)
    if (time_remaining_ms <= 0 || time_remaining_ms > this.config.maxTimeThresholdMs) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: time_remaining_ms <= 0 ? 'window_expired' : 'too_early',
        time_remaining_ms,
        max_threshold: this.config.maxTimeThresholdMs,
      });
      return null;
    }

    // Get staleness evaluation
    const staleness = this.getStalenessData(symbol);
    if (!staleness) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'staleness_data_unavailable',
        symbol,
      });
      return null;
    }

    // Condition 2: Oracle staleness check
    const stalenessMs = staleness.inputs?.time_since_update_ms || 0;
    if (stalenessMs < this.config.minStalenessMs) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'oracle_not_stale',
        staleness_ms: stalenessMs,
        min_required: this.config.minStalenessMs,
      });
      return null;
    }

    // Get divergence data
    const divergence = this.getDivergenceData(symbol);
    if (!divergence || divergence.ui_price === null) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'divergence_data_unavailable',
        symbol,
      });
      return null;
    }

    const { ui_price, oracle_price, spread_pct } = divergence;

    // Validate oracle_price is present and valid
    if (oracle_price === null || oracle_price === undefined ||
        typeof oracle_price !== 'number' || !Number.isFinite(oracle_price)) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'invalid_oracle_price',
        oracle_price,
      });
      return null;
    }

    const strike = 0.5; // Binary market midpoint

    // Condition 3: Clear direction from UI
    const uiVsStrike = Math.abs(ui_price - strike);
    if (uiVsStrike < this.config.strikeThreshold) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'unclear_direction',
        ui_vs_strike: uiVsStrike,
        threshold: this.config.strikeThreshold,
      });
      return null;
    }

    // Condition 4: Divergence within Chainlink threshold (oracle won't update)
    if (Math.abs(spread_pct) >= this.config.chainlinkDeviationThresholdPct) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'divergence_too_large',
        spread_pct,
        max_threshold: this.config.chainlinkDeviationThresholdPct,
      });
      return null;
    }

    // Condition 5: Market conviction check
    if (market_price > (1 - this.config.confidenceThreshold) &&
        market_price < this.config.confidenceThreshold) {
      this.log.debug('window_evaluated_no_signal', {
        window_id,
        reason: 'insufficient_conviction',
        market_price,
        threshold: this.config.confidenceThreshold,
      });
      return null;
    }

    // All conditions passed! Generate signal
    const direction = this.determineDirection(ui_price, oracle_price, strike);
    const confidence = this.calculateConfidence({
      stalenessMs,
      spreadPct: spread_pct,
      timeRemainingMs: time_remaining_ms,
      marketPrice: market_price,
    });

    const signal = {
      window_id,
      symbol,
      direction,
      confidence,
      token_id: direction === SignalDirection.FADE_UP ? token_id_down : token_id_up,
      side: 'buy',
      inputs: {
        time_remaining_ms,
        market_price,
        ui_price,
        oracle_price,
        oracle_staleness_ms: stalenessMs,
        spread_pct,
        strike,
        staleness_score: staleness.score,
      },
      generated_at: new Date().toISOString(),
    };

    // Update stats
    this.stats.signals_generated++;
    this.stats.signals_by_direction[direction]++;
    this.stats.signals_by_symbol[symbol] = (this.stats.signals_by_symbol[symbol] || 0) + 1;
    this.stats.total_confidence += confidence;

    // Notify subscribers
    this.notifySubscribers(signal);

    // Log signal generation
    this.log.info('signal_generated', {
      window_id,
      symbol,
      direction,
      confidence,
      inputs: signal.inputs,
    });

    return signal;
  }

  /**
   * Evaluate multiple windows for signals
   *
   * @param {Object[]} windows - Array of window data objects
   * @returns {Object[]} Array of generated signals (empty if none)
   */
  evaluateAllWindows(windows) {
    if (!Array.isArray(windows)) {
      return [];
    }

    const signals = [];
    for (const window of windows) {
      const signal = this.evaluateWindow(window);
      if (signal) {
        signals.push(signal);
      }
    }
    return signals;
  }

  /**
   * Determine signal direction based on UI vs strike
   *
   * @param {number} uiPrice - Current UI (Binance) price
   * @param {number} oraclePrice - Current Oracle (Chainlink) price
   * @param {number} strike - Strike price (0.5 for binary markets)
   * @returns {string} SignalDirection.FADE_UP or SignalDirection.FADE_DOWN
   */
  determineDirection(uiPrice, oraclePrice, strike) {
    // UI shows UP (price > strike), we FADE by betting DOWN
    if (uiPrice > strike) {
      return SignalDirection.FADE_UP;
    }
    // UI shows DOWN (price < strike), we FADE by betting UP
    return SignalDirection.FADE_DOWN;
  }

  /**
   * Calculate confidence score (0-1)
   *
   * @param {Object} inputs - Calculation inputs
   * @param {number} inputs.stalenessMs - Oracle staleness in ms
   * @param {number} inputs.spreadPct - UI/Oracle spread percentage
   * @param {number} inputs.timeRemainingMs - Time until expiry in ms
   * @param {number} inputs.marketPrice - Market token price
   * @returns {number} Confidence score 0-1
   */
  calculateConfidence({ stalenessMs, spreadPct, timeRemainingMs, marketPrice }) {
    // Defensive: ensure all inputs are valid numbers
    const safeStalenessMs = Number.isFinite(stalenessMs) ? stalenessMs : 0;
    const safeSpreadPct = Number.isFinite(spreadPct) ? spreadPct : 0;
    const safeTimeRemainingMs = Number.isFinite(timeRemainingMs) ? timeRemainingMs : 0;
    const safeMaxThreshold = this.config.maxTimeThresholdMs > 0
      ? this.config.maxTimeThresholdMs
      : 30000; // Fallback to default

    // Component 1: Staleness confidence (0-0.40)
    // More stale = higher confidence oracle won't update
    const stalenessRatio = Math.min(Math.max(safeStalenessMs / 60000, 0), 1);
    const stalenessScore = 0.20 + 0.20 * stalenessRatio;

    // Component 2: Divergence confidence (0-0.30)
    // Larger divergence = bigger potential edge
    const absSpread = Math.abs(safeSpreadPct);
    const divergenceScore = Math.min(absSpread / 0.005, 1) * 0.30;

    // Component 3: Time confidence (0-0.30)
    // Less time = more confident oracle won't update before expiry
    const timeRatio = Math.min(Math.max(safeTimeRemainingMs / safeMaxThreshold, 0), 1);
    const timeScore = 0.30 * (1 - timeRatio);

    return Math.min(1, Math.max(0, stalenessScore + divergenceScore + timeScore));
  }

  /**
   * Get staleness data from staleness-detector
   *
   * @param {string} symbol - Symbol to query
   * @returns {Object|null} Staleness evaluation or null
   */
  getStalenessData(symbol) {
    if (!this.stalenessDetector) {
      return null;
    }

    try {
      return this.stalenessDetector.getStaleness(symbol);
    } catch (err) {
      this.log.warn('staleness_data_unavailable', {
        symbol,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Get divergence data from divergence-tracker
   *
   * @param {string} symbol - Symbol to query
   * @returns {Object|null} Divergence data or null
   */
  getDivergenceData(symbol) {
    if (!this.divergenceTracker) {
      return null;
    }

    try {
      const spread = this.divergenceTracker.getSpread(symbol);
      if (!spread) {
        return null;
      }
      return {
        ui_price: spread.ui_price,
        oracle_price: spread.oracle_price,
        spread_pct: spread.pct || 0,
      };
    } catch (err) {
      this.log.warn('divergence_data_unavailable', {
        symbol,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Subscribe to signal events
   *
   * @param {Function} callback - Callback invoked on signal generation
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new OracleEdgeSignalError(
        OracleEdgeSignalErrorCodes.SUBSCRIPTION_FAILED,
        'Callback must be a function'
      );
    }

    this.subscribers.add(callback);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of a signal
   *
   * @param {Object} signal - Signal to broadcast
   */
  notifySubscribers(signal) {
    for (const callback of this.subscribers) {
      try {
        callback(signal);
      } catch (err) {
        this.log.error('subscriber_callback_error', {
          error: err.message,
          signal_id: signal.window_id,
        });
      }
    }
  }

  /**
   * Clear all subscriptions
   */
  clearSubscriptions() {
    this.subscribers.clear();
  }

  /**
   * Get generator statistics
   *
   * @returns {Object} Statistics object
   */
  getStats() {
    const avgConfidence = this.stats.signals_generated > 0
      ? this.stats.total_confidence / this.stats.signals_generated
      : 0;

    return {
      signals_generated: this.stats.signals_generated,
      evaluations_total: this.stats.evaluations_total,
      signals_blocked_by_quality_gate: this.stats.signals_blocked_by_quality_gate,
      signals_by_direction: { ...this.stats.signals_by_direction },
      signals_by_symbol: { ...this.stats.signals_by_symbol },
      avg_confidence: avgConfidence,
    };
  }
}
