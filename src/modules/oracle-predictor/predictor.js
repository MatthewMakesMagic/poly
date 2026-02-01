/**
 * Oracle Update Predictor
 *
 * Core logic for predicting the probability of an oracle update before window expiry.
 * Uses empirical pattern analysis from historical oracle update data.
 *
 * Key Algorithm:
 * 1. Get current oracle state (time since last update, current deviation)
 * 2. Match current conditions to historical bucket
 * 3. Calculate base probability from empirical distribution
 * 4. Adjust for time remaining using exponential model
 * 5. Calculate confidence interval using Wilson score
 */

import { DEFAULT_CONFIG, CALIBRATION_BUCKETS } from './types.js';

/**
 * OracleUpdatePredictor - Predicts oracle update probability
 */
export class OracleUpdatePredictor {
  /**
   * @param {Object} options - Predictor configuration
   * @param {Object} [options.config] - Configuration from DEFAULT_CONFIG
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
      buckets: {
        ...DEFAULT_CONFIG.buckets,
        ...(options.config?.buckets || {}),
      },
    };
    this.logger = options.logger || null;

    // Pattern cache: { symbol: { patterns, lastCalculated } }
    this.patternCache = {};
  }

  /**
   * Get prediction for probability of oracle update before expiry
   *
   * @param {Object} params - Prediction parameters
   * @param {string} params.symbol - Cryptocurrency symbol
   * @param {number} params.timeToExpiryMs - Time to window expiry in milliseconds
   * @param {number} params.timeSinceLastUpdateMs - Time since last oracle update in milliseconds
   * @param {number} params.currentDeviationPct - Current deviation from last oracle price (absolute)
   * @param {Object} params.patterns - Pre-analyzed patterns for the symbol
   * @returns {Object} Prediction result
   */
  getPrediction(params) {
    const {
      symbol,
      timeToExpiryMs,
      timeSinceLastUpdateMs,
      currentDeviationPct,
      patterns,
    } = params;

    // Handle edge case: T = 0 or negative
    if (timeToExpiryMs <= 0) {
      return {
        p_update: 0,
        confidence: { low: 0, high: 0 },
        inputs_used: {
          symbol,
          time_to_expiry_ms: timeToExpiryMs,
          time_since_last_update_ms: timeSinceLastUpdateMs,
          current_deviation_pct: currentDeviationPct,
          bucket: 'N/A',
          avg_update_interval_ms: 0,
          bucket_update_rate: 0,
          bucket_sample_size: 0,
        },
        edge_case: 'expiry',
      };
    }

    // Handle insufficient pattern data
    if (!patterns || patterns.totalUpdates < this.config.minHistoricalUpdates) {
      const defaultP = 0.5; // Unknown - 50/50
      return {
        p_update: defaultP,
        confidence: { low: 0, high: 1 },
        inputs_used: {
          symbol,
          time_to_expiry_ms: timeToExpiryMs,
          time_since_last_update_ms: timeSinceLastUpdateMs,
          current_deviation_pct: currentDeviationPct,
          bucket: 'insufficient_data',
          avg_update_interval_ms: patterns?.avgUpdateIntervalMs || 0,
          bucket_update_rate: defaultP,
          bucket_sample_size: patterns?.totalUpdates || 0,
        },
        edge_case: 'insufficient_data',
      };
    }

    // Find matching bucket
    const bucket = this.findBucket(timeSinceLastUpdateMs, currentDeviationPct, patterns);

    // Calculate base probability from empirical data
    const baseProb = bucket.total > 0 ? bucket.updateRate : 0.5;

    // Adjust for time remaining using exponential model
    // P(at least one update in T) ≈ 1 - e^(-T/avgInterval)
    // Simplified: 1 - (1 - baseRate)^(T/avgInterval)
    const avgInterval = patterns.avgUpdateIntervalMs;
    let pUpdate;

    if (!Number.isFinite(avgInterval) || avgInterval <= 0) {
      // No valid interval data - use base probability directly
      pUpdate = baseProb;
    } else {
      // Use exponential approximation for more accurate probability
      // P(at least one update) = 1 - P(no update in T)
      // P(no update in T) ≈ e^(-lambda * T) where lambda = 1/avgInterval
      const lambdaT = timeToExpiryMs / avgInterval;

      // Guard against Infinity/NaN from extreme values
      if (!Number.isFinite(lambdaT)) {
        pUpdate = lambdaT > 0 ? 1 : baseProb; // Very large lambdaT means near-certain update
      } else {
        pUpdate = 1 - Math.exp(-lambdaT * baseProb);
      }

      // Clamp to valid probability range
      pUpdate = Math.max(0, Math.min(1, pUpdate));
    }

    // Calculate confidence interval using Wilson score
    const confidence = this.wilsonConfidence(
      bucket.updates,
      bucket.total,
      this.config.confidenceLevel
    );

    return {
      p_update: pUpdate,
      confidence,
      inputs_used: {
        symbol,
        time_to_expiry_ms: timeToExpiryMs,
        time_since_last_update_ms: timeSinceLastUpdateMs,
        current_deviation_pct: currentDeviationPct,
        bucket: bucket.name,
        avg_update_interval_ms: avgInterval,
        bucket_update_rate: baseProb,
        bucket_sample_size: bucket.total,
      },
    };
  }

  /**
   * Analyze historical update patterns for a symbol
   *
   * @param {Array} updates - Array of update records from oracle_updates table
   * @param {string} symbol - Symbol being analyzed
   * @returns {Object|null} Pattern analysis or null if insufficient data
   */
  analyzePatterns(updates, symbol) {
    if (!updates || updates.length < this.config.minHistoricalUpdates) {
      return null;
    }

    // Validate bucket configuration
    const timeBuckets = this.config.buckets?.timeSinceLast;
    const devBuckets = this.config.buckets?.deviation;
    if (!Array.isArray(timeBuckets) || timeBuckets.length === 0 ||
        !Array.isArray(devBuckets) || devBuckets.length === 0) {
      return null;
    }

    // Calculate average update interval
    let totalInterval = 0;
    let intervalCount = 0;
    for (const update of updates) {
      if (update.time_since_previous_ms !== null && update.time_since_previous_ms > 0) {
        totalInterval += update.time_since_previous_ms;
        intervalCount++;
      }
    }
    const avgInterval = intervalCount > 0 ? totalInterval / intervalCount : 0;

    // Build 2D bucket matrix: time_since_last x deviation
    const bucketMatrix = {};

    for (const timeBucket of this.config.buckets.timeSinceLast) {
      for (const devBucket of this.config.buckets.deviation) {
        const key = `${timeBucket.name}:${devBucket.name}`;
        bucketMatrix[key] = {
          name: key,
          timeBucket: timeBucket.name,
          deviationBucket: devBucket.name,
          updates: 0,
          total: 0,
          updateRate: 0,
        };
      }
    }

    // Count updates per bucket
    // For each update, determine what bucket conditions existed
    for (const update of updates) {
      const timeSincePrev = update.time_since_previous_ms || 0;
      const deviation = Math.abs(update.deviation_from_previous_pct || 0);

      const timeBucket = this.findTimeBucket(timeSincePrev);
      const devBucket = this.findDeviationBucket(deviation);

      if (timeBucket && devBucket) {
        const key = `${timeBucket.name}:${devBucket.name}`;
        if (bucketMatrix[key]) {
          bucketMatrix[key].updates++;
          bucketMatrix[key].total++;
        }
      }
    }

    // Calculate update rates
    for (const bucket of Object.values(bucketMatrix)) {
      bucket.updateRate = bucket.total > 0 ? bucket.updates / bucket.total : 0;
    }

    return {
      symbol,
      totalUpdates: updates.length,
      avgUpdateIntervalMs: avgInterval,
      buckets: bucketMatrix,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Find matching bucket for current conditions
   *
   * @param {number} timeSinceLastUpdateMs - Time since last update in ms
   * @param {number} currentDeviationPct - Current deviation (absolute)
   * @param {Object} patterns - Analyzed patterns
   * @returns {Object} Matching bucket with stats
   */
  findBucket(timeSinceLastUpdateMs, currentDeviationPct, patterns) {
    const timeBucket = this.findTimeBucket(timeSinceLastUpdateMs);
    const devBucket = this.findDeviationBucket(currentDeviationPct);

    if (!timeBucket || !devBucket) {
      return {
        name: 'unknown',
        updates: 0,
        total: 0,
        updateRate: 0.5,
      };
    }

    const key = `${timeBucket.name}:${devBucket.name}`;
    const bucket = patterns.buckets[key];

    if (!bucket || bucket.total === 0) {
      // Fall back to time bucket only if specific bucket has no data
      const timeOnlyBuckets = Object.values(patterns.buckets).filter(
        b => b.timeBucket === timeBucket.name
      );
      const totalUpdates = timeOnlyBuckets.reduce((sum, b) => sum + b.updates, 0);
      const totalSamples = timeOnlyBuckets.reduce((sum, b) => sum + b.total, 0);

      return {
        name: `${timeBucket.name}:fallback`,
        updates: totalUpdates,
        total: totalSamples,
        updateRate: totalSamples > 0 ? totalUpdates / totalSamples : 0.5,
      };
    }

    return bucket;
  }

  /**
   * Find time bucket for a given time since last update
   *
   * @param {number} timeSinceLastMs - Time in milliseconds
   * @returns {Object|null} Matching time bucket
   */
  findTimeBucket(timeSinceLastMs) {
    for (const bucket of this.config.buckets.timeSinceLast) {
      if (timeSinceLastMs >= bucket.min && timeSinceLastMs < bucket.max) {
        return bucket;
      }
    }
    // Default to last bucket for very large values
    return this.config.buckets.timeSinceLast[this.config.buckets.timeSinceLast.length - 1];
  }

  /**
   * Find deviation bucket for a given deviation
   *
   * @param {number} deviationPct - Deviation percentage (absolute)
   * @returns {Object|null} Matching deviation bucket
   */
  findDeviationBucket(deviationPct) {
    const absDeviation = Math.abs(deviationPct);
    for (const bucket of this.config.buckets.deviation) {
      if (absDeviation >= bucket.min && absDeviation < bucket.max) {
        return bucket;
      }
    }
    // Default to last bucket for extreme values
    return this.config.buckets.deviation[this.config.buckets.deviation.length - 1];
  }

  /**
   * Wilson score confidence interval for binomial proportion
   *
   * @param {number} successes - Number of successes
   * @param {number} total - Total trials
   * @param {number} [confidenceLevel=0.95] - Confidence level
   * @returns {Object} { low, high } confidence interval
   */
  wilsonConfidence(successes, total, confidenceLevel = 0.95) {
    if (total === 0) {
      return { low: 0, high: 1 };
    }

    const p = successes / total;
    const z = this.getZScore(confidenceLevel);
    const n = total;

    const denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator;
    const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;

    return {
      low: Math.max(0, center - spread),
      high: Math.min(1, center + spread),
    };
  }

  /**
   * Get z-score for confidence level
   *
   * @param {number} confidenceLevel - Confidence level (0.90, 0.95, 0.99)
   * @returns {number} z-score
   */
  getZScore(confidenceLevel) {
    const zScores = {
      0.90: 1.645,
      0.95: 1.96,
      0.99: 2.576,
    };
    return zScores[confidenceLevel] || 1.96;
  }

  /**
   * Assign prediction to a calibration bucket
   *
   * @param {number} pUpdate - Probability of update
   * @returns {string} Bucket name
   */
  assignCalibrationBucket(pUpdate) {
    for (const bucket of CALIBRATION_BUCKETS) {
      if (pUpdate >= bucket.min && pUpdate < bucket.max) {
        return bucket.name;
      }
    }
    return pUpdate >= 1.0 ? '90-100%' : '0-10%';
  }

  /**
   * Check if pattern cache is valid
   *
   * @param {string} symbol - Symbol to check
   * @returns {boolean} True if cache is valid
   */
  isCacheValid(symbol) {
    const cached = this.patternCache[symbol];
    if (!cached || !cached.lastCalculated) {
      return false;
    }

    const age = Date.now() - new Date(cached.lastCalculated).getTime();
    return age < this.config.patternCacheExpiryMs;
  }

  /**
   * Update pattern cache
   *
   * @param {string} symbol - Symbol to cache
   * @param {Object} patterns - Analyzed patterns
   */
  updateCache(symbol, patterns) {
    this.patternCache[symbol] = {
      patterns,
      lastCalculated: new Date().toISOString(),
    };
  }

  /**
   * Get cached patterns
   *
   * @param {string} symbol - Symbol to retrieve
   * @returns {Object|null} Cached patterns or null
   */
  getCachedPatterns(symbol) {
    const cached = this.patternCache[symbol];
    return cached ? cached.patterns : null;
  }

  /**
   * Clear pattern cache
   */
  clearCache() {
    this.patternCache = {};
  }
}
