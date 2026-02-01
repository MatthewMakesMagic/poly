/**
 * Quality Gate Evaluator Class
 *
 * Core logic for evaluating strategy quality and determining
 * when to disable a strategy due to poor performance.
 *
 * @module modules/quality-gate/evaluator
 */

import { QualityGateError, QualityGateErrorCodes, DisableReason, DEFAULT_CONFIG } from './types.js';

/**
 * QualityGateEvaluator class
 *
 * Evaluates strategy quality based on signal outcomes, feed health,
 * and pattern changes. Can disable strategies that fall below quality thresholds.
 */
export class QualityGateEvaluator {
  /**
   * Create a new QualityGateEvaluator
   *
   * @param {Object} options - Evaluator options
   * @param {Object} options.config - Configuration
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.db - Database module
   */
  constructor({ config, logger, db }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = logger;
    this.db = db;

    // State
    this.disabled = false;
    this.disabledAt = null;
    this.disableReason = null;
    this.disableContext = null;
    this.enabledAt = null;

    // Evaluation tracking
    this.evaluationCount = 0;
    this.lastEvaluation = null;
    this.evaluationInterval = null;

    // Feed health tracking
    this.lastOracleTickTime = Date.now();
    this.rtdsSubscription = null;

    // Event callbacks
    this.onDisable = null;
    this.onEnable = null;
  }

  /**
   * Calculate rolling accuracy over last N signals
   *
   * @param {number} [windowSize] - Number of signals to include
   * @returns {Promise<Object>} Rolling accuracy result
   */
  async calculateRollingAccuracy(windowSize = this.config.rollingWindowSize) {
    try {
      // Query signals with outcomes, ordered by most recent
      const result = this.db.get(`
        SELECT
          COUNT(*) as total,
          SUM(signal_correct) as wins,
          CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
        FROM (
          SELECT signal_correct
          FROM oracle_edge_signals
          WHERE settlement_outcome IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        )
      `, [windowSize]);

      if (!result || result.total === 0) {
        return {
          accuracy: null,
          signalsInWindow: 0,
          wins: 0,
          insufficientData: true,
        };
      }

      return {
        accuracy: result.accuracy,
        signalsInWindow: result.total,
        wins: result.wins || 0,
        insufficientData: result.total < this.config.minSignalsForEvaluation,
      };
    } catch (err) {
      this.log.error('rolling_accuracy_calculation_failed', {
        error: err.message,
        windowSize,
      });
      throw new QualityGateError(
        QualityGateErrorCodes.EVALUATION_ERROR,
        `Failed to calculate rolling accuracy: ${err.message}`,
        { originalError: err.message }
      );
    }
  }

  /**
   * Calculate accuracy grouped by various buckets
   *
   * @param {number} [windowSize] - Number of signals to include
   * @returns {Promise<Object>} Bucketed accuracy results
   */
  async calculateBucketedAccuracy(windowSize = this.config.rollingWindowSize) {
    try {
      // Overall accuracy
      const overall = await this.calculateRollingAccuracy(windowSize);

      // Accuracy by time to expiry bucket
      const byTime = this.db.all(`
        SELECT
          CASE
            WHEN time_to_expiry_ms <= 10000 THEN '0-10s'
            WHEN time_to_expiry_ms <= 20000 THEN '10-20s'
            ELSE '20-30s'
          END as bucket,
          COUNT(*) as signals,
          SUM(signal_correct) as wins,
          CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
        FROM (
          SELECT time_to_expiry_ms, signal_correct
          FROM oracle_edge_signals
          WHERE settlement_outcome IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        )
        GROUP BY bucket
      `, [windowSize]);

      // Accuracy by staleness bucket
      const byStaleness = this.db.all(`
        SELECT
          CASE
            WHEN oracle_staleness_ms < 30000 THEN '15-30s'
            WHEN oracle_staleness_ms < 60000 THEN '30-60s'
            ELSE '60s+'
          END as bucket,
          COUNT(*) as signals,
          SUM(signal_correct) as wins,
          CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
        FROM (
          SELECT oracle_staleness_ms, signal_correct
          FROM oracle_edge_signals
          WHERE settlement_outcome IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        )
        GROUP BY bucket
      `, [windowSize]);

      // Accuracy by spread bucket (using ui_price - market_token_price as proxy)
      const bySpread = this.db.all(`
        SELECT
          CASE
            WHEN ABS(ui_price - market_token_price) < 0.001 THEN '0-0.1%'
            WHEN ABS(ui_price - market_token_price) < 0.003 THEN '0.1-0.3%'
            ELSE '0.3%+'
          END as bucket,
          COUNT(*) as signals,
          SUM(signal_correct) as wins,
          CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
        FROM (
          SELECT ui_price, market_token_price, signal_correct
          FROM oracle_edge_signals
          WHERE settlement_outcome IS NOT NULL
            AND ui_price IS NOT NULL
            AND market_token_price IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        )
        GROUP BY bucket
      `, [windowSize]);

      // Transform arrays to objects keyed by bucket
      const transformBuckets = (rows) => {
        const result = {};
        for (const row of rows || []) {
          result[row.bucket] = row.accuracy;
        }
        return result;
      };

      return {
        overall: overall.accuracy,
        signalsInWindow: overall.signalsInWindow,
        by_time: transformBuckets(byTime),
        by_staleness: transformBuckets(byStaleness),
        by_spread: transformBuckets(bySpread),
      };
    } catch (err) {
      this.log.error('bucketed_accuracy_calculation_failed', {
        error: err.message,
        windowSize,
      });
      return {
        overall: null,
        signalsInWindow: 0,
        by_time: {},
        by_staleness: {},
        by_spread: {},
      };
    }
  }

  /**
   * Check if accuracy is below threshold
   *
   * @param {number} rollingAccuracy - Current rolling accuracy
   * @param {number} [minAccuracy] - Minimum accuracy threshold
   * @returns {Object} Threshold check result
   */
  checkAccuracyThreshold(rollingAccuracy, minAccuracy = this.config.minAccuracyThreshold) {
    if (rollingAccuracy === null || rollingAccuracy === undefined) {
      return {
        breached: false,
        accuracy: null,
        threshold: minAccuracy,
        deficit: null,
        reason: 'insufficient_data',
      };
    }

    const breached = rollingAccuracy < minAccuracy;
    return {
      breached,
      accuracy: rollingAccuracy,
      threshold: minAccuracy,
      deficit: breached ? minAccuracy - rollingAccuracy : 0,
    };
  }

  /**
   * Check feed health (oracle availability)
   *
   * @returns {Object} Feed health status
   */
  checkFeedHealth() {
    const ageMs = Date.now() - this.lastOracleTickTime;
    const healthy = ageMs <= this.config.feedUnavailableThresholdMs;

    return {
      healthy,
      oracleAvailable: healthy,
      lastOracleTickAgeMs: ageMs,
      threshold: this.config.feedUnavailableThresholdMs,
      reason: healthy ? null : 'feed_unavailable',
    };
  }

  /**
   * Update last oracle tick time (called on feed tick)
   */
  updateOracleTick() {
    this.lastOracleTickTime = Date.now();
  }

  /**
   * Check for pattern changes in oracle updates
   *
   * @param {string} [symbol] - Symbol to check (default: ETH)
   * @returns {Promise<Object>} Pattern health status
   */
  async checkPatternChange(symbol = 'ETH') {
    // Validate symbol to prevent unexpected input
    const validSymbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'MATIC', 'AVAX', 'LINK'];
    const normalizedSymbol = String(symbol).toUpperCase().trim();
    if (!validSymbols.includes(normalizedSymbol)) {
      this.log.warn('invalid_symbol_for_pattern_check', { symbol, validSymbols });
      return {
        healthy: true,
        updateFrequencyRatio: 1.0,
        spreadBehaviorZScore: 0,
        reason: null,
        skipped: true,
        skipReason: 'invalid_symbol',
      };
    }

    try {
      // Check if oracle_updates table exists
      const tableExists = this.db.get(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='oracle_updates'
      `);

      if (!tableExists) {
        return {
          healthy: true,
          updateFrequencyRatio: 1.0,
          spreadBehaviorZScore: 0,
          reason: null,
          skipped: true,
          skipReason: 'oracle_updates_table_not_found',
        };
      }

      // Recent update frequency (last hour)
      const recentStats = this.db.get(`
        SELECT
          COUNT(*) as count,
          AVG(time_since_previous_ms) as avg_interval
        FROM oracle_updates
        WHERE timestamp > datetime('now', '-1 hour')
        AND symbol = ?
      `, [normalizedSymbol]);

      // Historical update frequency (last 24 hours excluding recent)
      const historicalStats = this.db.get(`
        SELECT
          COUNT(*) as count,
          AVG(time_since_previous_ms) as avg_interval
        FROM oracle_updates
        WHERE timestamp > datetime('now', '-24 hour')
        AND timestamp < datetime('now', '-1 hour')
        AND symbol = ?
      `, [normalizedSymbol]);

      // Skip if insufficient data
      if (!recentStats || !historicalStats ||
          recentStats.count < 10 || historicalStats.count < 100) {
        return {
          healthy: true,
          updateFrequencyRatio: 1.0,
          spreadBehaviorZScore: 0,
          reason: null,
          skipped: true,
          skipReason: 'insufficient_pattern_data',
        };
      }

      // Calculate frequency ratio (recent vs historical)
      // Higher ratio = more frequent updates recently
      const recentFreq = recentStats.count / 1; // per hour
      const historicalFreq = historicalStats.count / 23; // per hour (23 hours)
      const frequencyRatio = recentFreq / historicalFreq;

      // Check if ratio exceeds threshold
      const frequencyChanged = frequencyRatio > this.config.patternChangeThreshold ||
                               frequencyRatio < (1 / this.config.patternChangeThreshold);

      // For spread behavior, we'd need to calculate std dev
      // Simplified: just check if interval changed significantly
      const intervalRatio = (recentStats.avg_interval || 1) / (historicalStats.avg_interval || 1);
      const spreadBehaviorChanged = intervalRatio > this.config.spreadBehaviorStdDev ||
                                    intervalRatio < (1 / this.config.spreadBehaviorStdDev);

      return {
        healthy: !frequencyChanged && !spreadBehaviorChanged,
        updateFrequencyRatio: frequencyRatio,
        spreadBehaviorZScore: intervalRatio,
        reason: frequencyChanged ? 'pattern_change_detected' :
                spreadBehaviorChanged ? 'spread_behavior_change' : null,
      };
    } catch (err) {
      this.log.warn('pattern_change_check_failed', { error: err.message, symbol });
      return {
        healthy: true,
        updateFrequencyRatio: 1.0,
        spreadBehaviorZScore: 0,
        reason: null,
        error: err.message,
      };
    }
  }

  /**
   * Disable the strategy
   *
   * @param {string} reason - DisableReason value
   * @param {Object} [context] - Additional context
   */
  disableStrategy(reason, context = {}) {
    if (this.disabled) {
      this.log.debug('strategy_already_disabled', {
        existing_reason: this.disableReason,
        new_reason: reason,
      });
      return;
    }

    // Validate reason
    const validReasons = Object.values(DisableReason);
    if (!validReasons.includes(reason)) {
      throw new QualityGateError(
        QualityGateErrorCodes.INVALID_REASON,
        `Invalid disable reason: ${reason}`,
        { validReasons }
      );
    }

    this.disabled = true;
    this.disabledAt = new Date().toISOString();
    this.disableReason = reason;
    this.disableContext = context;

    this.log.warn('quality_gate_triggered', {
      reason,
      accuracy: context.accuracy,
      threshold: context.threshold,
      signalsInWindow: context.signalsInWindow,
      context,
    });

    // Notify listeners
    if (this.onDisable) {
      try {
        this.onDisable({ reason, context, disabledAt: this.disabledAt });
      } catch (err) {
        this.log.error('disable_callback_error', { error: err.message });
      }
    }
  }

  /**
   * Enable the strategy (manual re-enable)
   *
   * @param {string} userReason - Reason for re-enabling
   */
  enableStrategy(userReason) {
    if (!this.disabled) {
      throw new QualityGateError(
        QualityGateErrorCodes.NOT_DISABLED,
        'Strategy is not disabled'
      );
    }

    if (!userReason || typeof userReason !== 'string' || userReason.trim().length === 0) {
      throw new QualityGateError(
        QualityGateErrorCodes.INVALID_REASON,
        'userReason is required to re-enable strategy'
      );
    }

    const previousDisableReason = this.disableReason;
    const disabledDuration = Date.now() - new Date(this.disabledAt).getTime();

    this.log.info('quality_gate_reenabled', {
      userReason,
      previousDisableReason,
      disabledDurationMs: disabledDuration,
    });

    this.disabled = false;
    this.disabledAt = null;
    this.disableReason = null;
    this.disableContext = null;
    this.enabledAt = new Date().toISOString();

    // Reset evaluation count for fresh start
    this.evaluationCount = 0;

    // Notify listeners
    if (this.onEnable) {
      try {
        this.onEnable({ userReason, enabledAt: this.enabledAt });
      } catch (err) {
        this.log.error('enable_callback_error', { error: err.message });
      }
    }
  }

  /**
   * Run a full evaluation cycle
   *
   * @returns {Promise<Object>} Evaluation result
   */
  async evaluate() {
    this.evaluationCount++;

    // Skip if already disabled
    if (this.disabled) {
      this.log.debug('evaluation_skipped_disabled');
      return {
        skipped: true,
        reason: 'already_disabled',
        disabled: true,
        disableReason: this.disableReason,
      };
    }

    try {
      // 1. Calculate rolling accuracy
      const rollingResult = await this.calculateRollingAccuracy();

      // 2. Check accuracy threshold (only if sufficient data)
      let thresholdResult = { breached: false };
      if (!rollingResult.insufficientData) {
        thresholdResult = this.checkAccuracyThreshold(rollingResult.accuracy);

        if (thresholdResult.breached) {
          this.disableStrategy(DisableReason.ACCURACY_BELOW_THRESHOLD, {
            accuracy: thresholdResult.accuracy,
            threshold: thresholdResult.threshold,
            deficit: thresholdResult.deficit,
            signalsInWindow: rollingResult.signalsInWindow,
          });
        }
      }

      // 3. Check feed health
      const feedHealth = this.checkFeedHealth();
      if (!feedHealth.healthy && !this.disabled) {
        this.disableStrategy(DisableReason.FEED_UNAVAILABLE, {
          lastOracleTickAgeMs: feedHealth.lastOracleTickAgeMs,
          threshold: feedHealth.threshold,
        });
      }

      // 4. Check pattern changes (every Nth evaluation to reduce overhead)
      let patternHealth = { healthy: true, skipped: true };
      if (this.evaluationCount % this.config.patternCheckFrequency === 0) {
        patternHealth = await this.checkPatternChange();
        if (!patternHealth.healthy && !this.disabled) {
          const reason = patternHealth.reason === 'spread_behavior_change'
            ? DisableReason.SPREAD_BEHAVIOR_CHANGE
            : DisableReason.PATTERN_CHANGE_DETECTED;

          this.disableStrategy(reason, {
            updateFrequencyRatio: patternHealth.updateFrequencyRatio,
            spreadBehaviorZScore: patternHealth.spreadBehaviorZScore,
          });
        }
      }

      // Store last evaluation
      this.lastEvaluation = {
        timestamp: new Date().toISOString(),
        rollingAccuracy: rollingResult.accuracy,
        signalsInWindow: rollingResult.signalsInWindow,
        insufficientData: rollingResult.insufficientData,
        thresholdBreached: thresholdResult.breached,
        feedHealth: {
          oracleAvailable: feedHealth.healthy,
          lastOracleTickAgeMs: feedHealth.lastOracleTickAgeMs,
        },
        patternHealth: {
          updateFrequencyRatio: patternHealth.updateFrequencyRatio || 1.0,
          spreadBehaviorZScore: patternHealth.spreadBehaviorZScore || 0,
          skipped: patternHealth.skipped,
        },
      };

      this.log.info('quality_gate_evaluation', {
        evaluationCount: this.evaluationCount,
        rollingAccuracy: rollingResult.accuracy,
        signalsInWindow: rollingResult.signalsInWindow,
        thresholdBreached: thresholdResult.breached,
        feedHealthy: feedHealth.healthy,
        disabled: this.disabled,
      });

      return {
        skipped: false,
        disabled: this.disabled,
        disableReason: this.disableReason,
        ...this.lastEvaluation,
      };
    } catch (err) {
      this.log.error('evaluation_failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Start periodic evaluation
   *
   * @param {number} [intervalMs] - Evaluation interval
   */
  startPeriodicEvaluation(intervalMs = this.config.evaluationIntervalMs) {
    if (this.evaluationInterval) {
      this.log.warn('periodic_evaluation_already_running');
      return;
    }

    this.log.info('periodic_evaluation_starting', { intervalMs });

    this.evaluationInterval = setInterval(async () => {
      try {
        await this.evaluate();
      } catch (err) {
        this.log.error('periodic_evaluation_error', { error: err.message });
      }
    }, intervalMs);

    // Don't block process exit
    if (this.evaluationInterval.unref) {
      this.evaluationInterval.unref();
    }
  }

  /**
   * Stop periodic evaluation
   */
  stopPeriodicEvaluation() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
      this.log.info('periodic_evaluation_stopped');
    }
  }

  /**
   * Check if strategy should allow signals
   *
   * @returns {boolean} True if signals should be allowed
   */
  shouldAllowSignal() {
    return !this.disabled;
  }

  /**
   * Get current state
   *
   * @returns {Object} Current evaluator state
   */
  getState() {
    return {
      disabled: this.disabled,
      disabledAt: this.disabledAt,
      disableReason: this.disableReason,
      disableContext: this.disableContext,
      enabledAt: this.enabledAt,
      lastEvaluation: this.lastEvaluation,
      evaluationCount: this.evaluationCount,
      config: { ...this.config },
    };
  }

  /**
   * Set disable callback
   *
   * @param {Function} callback - Called when strategy is disabled
   */
  setOnDisable(callback) {
    this.onDisable = callback;
  }

  /**
   * Set enable callback
   *
   * @param {Function} callback - Called when strategy is re-enabled
   */
  setOnEnable(callback) {
    this.onEnable = callback;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.stopPeriodicEvaluation();
    this.onDisable = null;
    this.onEnable = null;
  }
}
