/**
 * Staleness Detector Core Logic
 *
 * The StalenessDetector class implements the core staleness detection algorithm.
 * Staleness represents a trading opportunity when:
 * 1. Time staleness: Oracle hasn't updated for a while (>15s default)
 * 2. Price divergence: UI and Oracle prices differ meaningfully (>0.1%)
 * 3. Update unlikelihood: The divergence is below Chainlink's update threshold (~0.5%)
 *
 * @module modules/staleness-detector/detector
 */

import { DEFAULT_CONFIG, EventTypes } from './types.js';

/**
 * StalenessDetector class
 * Evaluates staleness conditions and calculates staleness scores.
 */
export class StalenessDetector {
  /**
   * @param {Object} options - Configuration options
   * @param {Object} options.config - Staleness detector configuration
   * @param {Object} options.logger - Logger instance
   */
  constructor({ config = {}, logger }) {
    this.config = {
      stalenessThresholdMs: config.stalenessThresholdMs ?? DEFAULT_CONFIG.stalenessThresholdMs,
      minDivergencePct: config.minDivergencePct ?? DEFAULT_CONFIG.minDivergencePct,
      chainlinkDeviationThresholdPct: config.chainlinkDeviationThresholdPct ?? DEFAULT_CONFIG.chainlinkDeviationThresholdPct,
      scoreThreshold: config.scoreThreshold ?? DEFAULT_CONFIG.scoreThreshold,
      evaluationIntervalMs: config.evaluationIntervalMs ?? DEFAULT_CONFIG.evaluationIntervalMs,
      maxSubscribers: config.maxSubscribers ?? DEFAULT_CONFIG.maxSubscribers,
    };

    this.log = logger;

    // Per-symbol staleness state
    // { [symbol]: { isStale, startedAt, score, evaluation, lastEventEmittedAt } }
    this.stalenessState = {};

    // Event subscribers
    this.subscribers = [];

    // Statistics
    this.stats = {
      stalenessEventsEmitted: 0,
      resolutionsDetected: 0,
      totalStaleDurationMs: 0,
      stalenessCount: 0,
    };
  }

  /**
   * Evaluate staleness for a symbol
   *
   * @param {string} symbol - Symbol to evaluate
   * @param {Object} oracleState - Oracle state { price, last_update_at }
   * @param {Object} divergence - Divergence data { ui_price, oracle_price, spread_pct }
   * @param {number|null} pNoUpdate - Probability of no update from predictor (optional)
   * @returns {Object} Evaluation result
   */
  evaluateStaleness(symbol, oracleState, divergence, pNoUpdate = null) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString(); // Cache ISO string for reuse
    // Guard against negative time (clock skew or future timestamps)
    const timeSinceUpdate = Math.max(0, now - oracleState.last_update_at);
    const absDivergencePct = Math.abs(divergence.spread_pct || 0);

    // Evaluate each condition
    const conditions = {
      time_stale: timeSinceUpdate > this.config.stalenessThresholdMs,
      has_divergence: absDivergencePct > this.config.minDivergencePct,
      update_unlikely: absDivergencePct < this.config.chainlinkDeviationThresholdPct,
    };

    // Calculate staleness (all conditions must be met)
    const isStale = conditions.time_stale &&
                    conditions.has_divergence &&
                    conditions.update_unlikely;

    // Calculate score
    const score = this.calculateScore({
      timeSinceUpdate,
      absDivergencePct,
      conditions,
      pNoUpdate,
    });

    const evaluation = {
      symbol,
      is_stale: isStale,
      score,
      conditions,
      inputs: {
        time_since_update_ms: timeSinceUpdate,
        ui_price: divergence.ui_price,
        oracle_price: divergence.oracle_price,
        divergence_pct: divergence.spread_pct,
        p_no_update: pNoUpdate,
      },
      evaluated_at: nowIso,
    };

    // Handle state transitions and emit events
    this.handleStateTransition(symbol, evaluation);

    return evaluation;
  }

  /**
   * Calculate staleness score (0-1)
   *
   * Score components:
   * - Time staleness (0-0.35): How far past threshold
   * - Divergence magnitude (0-0.35): How much divergence exists
   * - Update unlikelihood (0-0.30): How unlikely oracle update is
   *
   * @param {Object} inputs - Score calculation inputs
   * @returns {number} Staleness score (0-1)
   */
  calculateScore({ timeSinceUpdate, absDivergencePct, conditions, pNoUpdate }) {
    // No divergence = not stale
    if (!conditions.has_divergence) {
      return 0;
    }

    // Component 1: Time staleness (0-0.35)
    // Score increases as time exceeds threshold
    const timeRatio = Math.min(timeSinceUpdate / this.config.stalenessThresholdMs, 3);
    let timeScore = 0;
    if (conditions.time_stale) {
      // Base score of 0.15 when threshold crossed, up to 0.35 at 3x threshold
      timeScore = Math.min(0.35, 0.15 + 0.20 * ((timeRatio - 1) / 2));
    }

    // Component 2: Divergence magnitude (0-0.35)
    // Score based on how much divergence relative to thresholds
    const divergenceRange = this.config.chainlinkDeviationThresholdPct - this.config.minDivergencePct;
    let divergenceScore = 0;
    // Guard against division by zero or near-zero (floating point safety)
    if (conditions.has_divergence && divergenceRange > 1e-10) {
      const divergencePosition = (absDivergencePct - this.config.minDivergencePct) / divergenceRange;
      // Base score of 0.15 when has divergence, up to 0.35 at max position
      divergenceScore = Math.min(0.35, 0.15 + 0.20 * Math.min(divergencePosition, 1));
    }

    // Component 3: Update unlikelihood (0-0.30)
    // Score based on how far below chainlink threshold
    let unlikelinessScore = 0;
    if (conditions.update_unlikely) {
      const unlikelinessRatio = 1 - (absDivergencePct / this.config.chainlinkDeviationThresholdPct);
      // Base score of 0.15 when update unlikely, up to 0.30 at max unlikeliness
      unlikelinessScore = Math.min(0.30, 0.15 + 0.15 * unlikelinessRatio);
    }

    // Optional: Factor in predictor probability
    let predictorBonus = 0;
    if (pNoUpdate !== null && pNoUpdate > 0.5) {
      // Add small bonus if predictor also thinks update is unlikely
      predictorBonus = Math.min(0.05, (pNoUpdate - 0.5) * 0.1);
    }

    const totalScore = Math.min(1, timeScore + divergenceScore + unlikelinessScore + predictorBonus);
    return Math.round(totalScore * 1000) / 1000; // Round to 3 decimal places
  }

  /**
   * Handle state transitions and emit events
   *
   * @param {string} symbol - Symbol being evaluated
   * @param {Object} evaluation - Current evaluation result
   */
  handleStateTransition(symbol, evaluation) {
    const prevState = this.stalenessState[symbol] || { isStale: false };
    const now = Date.now();

    if (evaluation.is_stale && !prevState.isStale) {
      // Transition: Not stale → Stale
      const transitionIso = new Date(now).toISOString();
      this.stalenessState[symbol] = {
        isStale: true,
        startedAt: transitionIso,
        startedAtMs: now,
        score: evaluation.score,
        evaluation,
        lastEventEmittedAt: now,
      };

      // Emit staleness_detected event if score exceeds threshold
      if (evaluation.score >= this.config.scoreThreshold) {
        this.emitEvent({
          type: EventTypes.STALENESS_DETECTED,
          symbol,
          score: evaluation.score,
          timestamp: transitionIso,
          inputs: evaluation.inputs,
        });
        this.stats.stalenessEventsEmitted++;
      }

      this.stats.stalenessCount++;

    } else if (!evaluation.is_stale && prevState.isStale) {
      // Transition: Stale → Not stale (resolved)
      const stalenessDurationMs = now - prevState.startedAtMs;
      const resolutionIso = new Date(now).toISOString();

      // Emit staleness_resolved event
      this.emitEvent({
        type: EventTypes.STALENESS_RESOLVED,
        symbol,
        staleness_duration_ms: stalenessDurationMs,
        price_at_resolution: evaluation.inputs.oracle_price,
        timestamp: resolutionIso,
      });

      this.stats.resolutionsDetected++;
      this.stats.totalStaleDurationMs += stalenessDurationMs;

      // Clear staleness state
      this.stalenessState[symbol] = {
        isStale: false,
        startedAt: null,
        startedAtMs: null,
        score: evaluation.score,
        evaluation,
        lastEventEmittedAt: null,
      };

    } else if (evaluation.is_stale && prevState.isStale) {
      // Still stale - update score
      this.stalenessState[symbol] = {
        ...prevState,
        score: evaluation.score,
        evaluation,
      };
    } else {
      // Not stale and wasn't stale - just update evaluation
      this.stalenessState[symbol] = {
        isStale: false,
        startedAt: null,
        startedAtMs: null,
        score: evaluation.score,
        evaluation,
        lastEventEmittedAt: null,
      };
    }
  }

  /**
   * Emit an event to all subscribers
   *
   * @param {Object} event - Event to emit
   */
  emitEvent(event) {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        if (this.log) {
          this.log.error('subscriber_error', {
            event_type: event.type,
            symbol: event.symbol,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Subscribe to staleness events
   *
   * @param {Function} callback - Callback to invoke on events
   * @returns {Function} Unsubscribe function
   * @throws {Error} If max subscribers exceeded
   */
  subscribe(callback) {
    const maxSubscribers = this.config.maxSubscribers ?? 100;
    if (this.subscribers.length >= maxSubscribers) {
      if (this.log) {
        this.log.warn('max_subscribers_exceeded', {
          current: this.subscribers.length,
          max: maxSubscribers,
        });
      }
      throw new Error(`Max subscribers (${maxSubscribers}) exceeded`);
    }
    this.subscribers.push(callback);
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index > -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /**
   * Get staleness state for a symbol
   *
   * @param {string} symbol - Symbol to query
   * @returns {Object|null} Staleness state or null
   */
  getSymbolState(symbol) {
    const state = this.stalenessState[symbol];
    if (!state) {
      return null;
    }

    const durationMs = state.isStale && state.startedAtMs
      ? Date.now() - state.startedAtMs
      : null;

    return {
      is_stale: state.isStale,
      score: state.score,
      started_at: state.startedAt,
      duration_ms: durationMs,
      conditions: state.evaluation?.conditions || null,
    };
  }

  /**
   * Get all staleness states
   *
   * @returns {Object} Staleness states by symbol
   */
  getAllStates() {
    const states = {};
    for (const symbol of Object.keys(this.stalenessState)) {
      states[symbol] = this.getSymbolState(symbol);
    }
    return states;
  }

  /**
   * Get statistics
   *
   * @returns {Object} Statistics
   */
  getStats() {
    const avgDurationMs = this.stats.stalenessCount > 0
      ? this.stats.totalStaleDurationMs / this.stats.stalenessCount
      : 0;

    return {
      staleness_events_emitted: this.stats.stalenessEventsEmitted,
      resolutions_detected: this.stats.resolutionsDetected,
      avg_staleness_duration_ms: Math.round(avgDurationMs),
    };
  }

  /**
   * Clear all subscribers
   */
  clearSubscriptions() {
    this.subscribers = [];
  }

  /**
   * Reset state
   */
  reset() {
    this.stalenessState = {};
    this.subscribers = [];
    this.stats = {
      stalenessEventsEmitted: 0,
      resolutionsDetected: 0,
      totalStaleDurationMs: 0,
      stalenessCount: 0,
    };
  }
}
