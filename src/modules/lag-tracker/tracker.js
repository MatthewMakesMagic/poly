/**
 * Lag Tracker Core Logic
 *
 * Implements cross-correlation analysis between spot (Binance) and oracle (Chainlink)
 * price feeds to detect and track lag patterns.
 *
 * Key functions:
 * - PriceBuffer: Circular buffer for storing recent prices
 * - calculateCrossCorrelation: Pearson correlation at specified lag
 * - findOptimalLag: Find tau* with highest correlation
 * - calculatePValue: Statistical significance of correlation
 *
 * @module modules/lag-tracker/tracker
 */

import { MIN_SAMPLE_SIZE, TIMESTAMP_TOLERANCE_MS, MAX_PENDING_SIGNALS, FLOAT_EPSILON } from './types.js';

/**
 * Circular buffer for storing recent price data with timestamps
 * Uses a more efficient approach: periodic cleanup instead of per-add cleanup
 */
export class PriceBuffer {
  /**
   * @param {number} maxAgeMs - Maximum age of entries in milliseconds
   * @param {number} maxSize - Maximum number of entries
   */
  constructor(maxAgeMs = 60000, maxSize = 1000) {
    this.maxAgeMs = maxAgeMs;
    this.maxSize = maxSize;
    this.buffer = [];
    this.cleanupCounter = 0;
    this.cleanupInterval = 50; // Cleanup every N additions
  }

  /**
   * Add a price point with timestamp
   * @param {number} price - The price value
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {boolean} True if added, false if invalid
   */
  add(price, timestamp) {
    // Validate price: must be a positive finite number
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return false;
    }

    // Validate timestamp
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return false;
    }

    this.buffer.push({ price, timestamp });

    // Periodic cleanup instead of per-add (O(1) amortized vs O(n))
    this.cleanupCounter++;
    if (this.cleanupCounter >= this.cleanupInterval) {
      this._cleanup(timestamp);
      this.cleanupCounter = 0;
    }

    // Hard limit size (O(1) splice from start when over limit)
    if (this.buffer.length > this.maxSize) {
      // Remove oldest entries in one operation
      const removeCount = Math.max(1, Math.floor(this.maxSize * 0.1));
      this.buffer.splice(0, removeCount);
    }

    return true;
  }

  /**
   * Internal cleanup of old entries
   * @param {number} currentTimestamp - Current timestamp for cutoff calculation
   */
  _cleanup(currentTimestamp) {
    const cutoff = currentTimestamp - this.maxAgeMs;
    // Find first entry that's not expired using binary search
    let left = 0;
    let right = this.buffer.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (this.buffer[mid].timestamp < cutoff) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    // Remove expired entries in one splice
    if (left > 0) {
      this.buffer.splice(0, left);
    }
  }

  /**
   * Get all prices within a time range
   * @param {number} startMs - Start timestamp (inclusive)
   * @param {number} endMs - End timestamp (inclusive)
   * @returns {Array<{price: number, timestamp: number}>}
   */
  getRange(startMs, endMs) {
    return this.buffer.filter(p => p.timestamp >= startMs && p.timestamp <= endMs);
  }

  /**
   * Get all prices in the buffer
   * @returns {Array<{price: number, timestamp: number}>}
   */
  getAll() {
    return [...this.buffer];
  }

  /**
   * Find the price point closest to a target timestamp using binary search
   * @param {number} targetTimestamp - Target timestamp in milliseconds
   * @param {number} toleranceMs - Maximum allowed difference
   * @returns {{price: number, timestamp: number}|null}
   */
  findClosest(targetTimestamp, toleranceMs) {
    if (this.buffer.length === 0) {
      return null;
    }

    // Binary search for the closest timestamp
    let left = 0;
    let right = this.buffer.length - 1;

    // Handle edge cases
    if (targetTimestamp <= this.buffer[0].timestamp) {
      const diff = Math.abs(this.buffer[0].timestamp - targetTimestamp);
      return diff <= toleranceMs ? this.buffer[0] : null;
    }
    if (targetTimestamp >= this.buffer[right].timestamp) {
      const diff = Math.abs(this.buffer[right].timestamp - targetTimestamp);
      return diff <= toleranceMs ? this.buffer[right] : null;
    }

    // Binary search for closest
    while (left < right - 1) {
      const mid = (left + right) >>> 1;
      if (this.buffer[mid].timestamp <= targetTimestamp) {
        left = mid;
      } else {
        right = mid;
      }
    }

    // Compare left and right to find closest
    const leftDiff = Math.abs(this.buffer[left].timestamp - targetTimestamp);
    const rightDiff = Math.abs(this.buffer[right].timestamp - targetTimestamp);

    if (leftDiff <= rightDiff && leftDiff <= toleranceMs) {
      return this.buffer[left];
    } else if (rightDiff <= toleranceMs) {
      return this.buffer[right];
    }

    return null;
  }

  /**
   * Get the number of entries in the buffer
   * @returns {number}
   */
  get length() {
    return this.buffer.length;
  }

  /**
   * Clear all entries
   */
  clear() {
    this.buffer = [];
  }

  /**
   * Get the oldest timestamp in the buffer
   * @returns {number|null}
   */
  getOldestTimestamp() {
    if (this.buffer.length === 0) return null;
    return this.buffer[0].timestamp;
  }

  /**
   * Get the newest timestamp in the buffer
   * @returns {number|null}
   */
  getNewestTimestamp() {
    if (this.buffer.length === 0) return null;
    return this.buffer[this.buffer.length - 1].timestamp;
  }
}

/**
 * Error function (erf) approximation
 * Uses Horner's method for polynomial evaluation
 * @param {number} x - Input value
 * @returns {number} erf(x)
 */
function erf(x) {
  // Approximation constants
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return sign * y;
}

/**
 * Normal CDF (cumulative distribution function)
 * Phi(x) = 0.5 * (1 + erf(x / sqrt(2)))
 * @param {number} x - Input value
 * @returns {number} CDF value between 0 and 1
 */
export function normalCDF(x) {
  // Handle edge cases
  if (x > 8) return 1;
  if (x < -8) return 0;

  // Phi(x) = 0.5 * (1 + erf(x / sqrt(2)))
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/**
 * Calculate cross-correlation between two time series at a specified lag
 *
 * @param {Array<{price: number, timestamp: number}>} seriesA - Spot prices (leading series)
 * @param {Array<{price: number, timestamp: number}>} seriesB - Oracle prices (lagging series)
 * @param {number} tauMs - Lag offset in milliseconds (positive means A leads B)
 * @param {number} toleranceMs - Timestamp matching tolerance
 * @returns {{correlation: number, sampleSize: number}|null} Correlation result or null if insufficient data
 */
export function calculateCrossCorrelation(seriesA, seriesB, tauMs, toleranceMs = TIMESTAMP_TOLERANCE_MS) {
  // Align series: for each point in B, find corresponding point in A at time (t - tauMs)
  const alignedPairs = [];

  // Create a sorted index of seriesA timestamps for binary search
  // This avoids O(n²) complexity in the matching loop
  const sortedA = [...seriesA].sort((x, y) => x.timestamp - y.timestamp);

  for (const b of seriesB) {
    const targetTime = b.timestamp - tauMs;

    // Binary search for closest point in sorted A
    let left = 0;
    let right = sortedA.length - 1;
    let closest = null;
    let minDiff = Infinity;

    while (left <= right) {
      const mid = (left + right) >>> 1;
      const diff = Math.abs(sortedA[mid].timestamp - targetTime);

      if (diff < minDiff) {
        minDiff = diff;
        closest = sortedA[mid];
      }

      if (sortedA[mid].timestamp < targetTime) {
        left = mid + 1;
      } else if (sortedA[mid].timestamp > targetTime) {
        right = mid - 1;
      } else {
        break; // Exact match
      }
    }

    if (closest && minDiff <= toleranceMs) {
      alignedPairs.push({ a: closest.price, b: b.price });
    }
  }

  if (alignedPairs.length < MIN_SAMPLE_SIZE) {
    return null;
  }

  // Calculate Pearson correlation
  const n = alignedPairs.length;
  let sumA = 0;
  let sumB = 0;
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;

  for (const pair of alignedPairs) {
    sumA += pair.a;
    sumB += pair.b;
    sumAB += pair.a * pair.b;
    sumA2 += pair.a * pair.a;
    sumB2 += pair.b * pair.b;
  }

  const numerator = n * sumAB - sumA * sumB;
  const denominator = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));

  if (denominator === 0) return { correlation: 0, sampleSize: n };
  return { correlation: numerator / denominator, sampleSize: n };
}

/**
 * Calculate p-value for correlation significance
 *
 * Uses t-test: t = r * sqrt(n-2) / sqrt(1-r^2)
 * For large samples (n > 30), uses normal approximation
 *
 * @param {number} correlation - Correlation coefficient
 * @param {number} sampleSize - Number of samples
 * @returns {number} Two-tailed p-value
 */
export function calculatePValue(correlation, sampleSize) {
  const n = sampleSize;
  const r = correlation;

  if (n < 3) return 1;

  const r2 = r * r;
  // Handle perfect or near-perfect correlation (with floating point tolerance)
  if (r2 >= 1 - FLOAT_EPSILON) return 0;

  // t-statistic
  const t = r * Math.sqrt(n - 2) / Math.sqrt(1 - r2);

  // Degrees of freedom
  const df = n - 2;

  // For large samples, use normal approximation (two-tailed)
  if (df > 30) {
    return 2 * (1 - normalCDF(Math.abs(t)));
  }

  // For smaller samples, use t-distribution approximation
  return tDistributionPValue(Math.abs(t), df);
}

/**
 * Calculate p-value from t-distribution using approximation
 * @param {number} t - Absolute t-statistic
 * @param {number} df - Degrees of freedom
 * @returns {number} Two-tailed p-value
 */
function tDistributionPValue(t, df) {
  // For correlation testing, we use a simplified approximation
  // Based on approximation for Student's t CDF

  const x = df / (df + t * t);

  // Incomplete beta function approximation using series expansion
  const a = df / 2;
  const b = 0.5;

  // Use regularized incomplete beta function
  const betaIncomplete = incompleteBeta(a, b, x);

  // Return two-tailed p-value
  return betaIncomplete;
}

/**
 * Beta function approximation using log-gamma
 * @param {number} a - First parameter
 * @param {number} b - Second parameter
 * @returns {number}
 */
function beta(a, b) {
  return Math.exp(logGamma(a) + logGamma(b) - logGamma(a + b));
}

/**
 * Log-gamma function using Lanczos approximation
 * @param {number} z - Input value
 * @returns {number}
 */
function logGamma(z) {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Incomplete beta function approximation
 * Uses continued fraction for better convergence
 * @param {number} a - First parameter
 * @param {number} b - Second parameter
 * @param {number} x - Input value
 * @returns {number}
 */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry relation for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(b, a, 1 - x);
  }

  // Continued fraction using Lentz's algorithm
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m;

    // Even step
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

    // Odd step
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 1e-10) break;
  }

  return h * Math.pow(x, a) * Math.pow(1 - x, b) / (a * beta(a, b));
}

/**
 * Find the optimal lag (tau*) with highest absolute correlation
 *
 * @param {PriceBuffer} spotBuffer - Buffer of spot prices
 * @param {PriceBuffer} oracleBuffer - Buffer of oracle prices
 * @param {number[]} tauValues - Array of tau values to test (ms)
 * @param {number} toleranceMs - Timestamp matching tolerance
 * @returns {{tau_star_ms: number, correlation: number, p_value: number, significant: boolean, sample_size: number}|null}
 */
export function findOptimalLag(spotBuffer, oracleBuffer, tauValues, toleranceMs = TIMESTAMP_TOLERANCE_MS) {
  const spotPrices = spotBuffer.getAll();
  const oraclePrices = oracleBuffer.getAll();

  if (spotPrices.length < MIN_SAMPLE_SIZE || oraclePrices.length < MIN_SAMPLE_SIZE) {
    return null;
  }

  let bestTau = null;
  let bestCorrelation = null;
  let bestPValue = 1;
  let bestSampleSize = 0;

  for (const tau of tauValues) {
    const result = calculateCrossCorrelation(spotPrices, oraclePrices, tau, toleranceMs);

    if (result !== null && (bestCorrelation === null || Math.abs(result.correlation) > Math.abs(bestCorrelation))) {
      bestTau = tau;
      bestCorrelation = result.correlation;
      bestSampleSize = result.sampleSize;
      bestPValue = calculatePValue(bestCorrelation, bestSampleSize);
    }
  }

  if (bestTau === null) {
    return null;
  }

  return {
    tau_star_ms: bestTau,
    correlation: bestCorrelation,
    p_value: bestPValue,
    significant: bestPValue < 0.05,
    sample_size: bestSampleSize,
  };
}

/**
 * Calculate variance of an array
 * @param {number[]} values - Array of numbers
 * @returns {number}
 */
function calculateVariance(values) {
  if (values.length === 0) return 0;

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSquares = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return sumSquares / values.length;
}

/**
 * LagTracker class for tracking lag between spot and oracle feeds
 */
export class LagTracker {
  /**
   * @param {Object} config - Configuration
   * @param {Object} config.logger - Logger instance
   */
  constructor(config) {
    this.config = config;
    this.log = config.logger;

    // Price buffers per symbol
    this.spotBuffers = {};
    this.oracleBuffers = {};

    // Stability tracking: history of tau* values per symbol
    this.tauHistory = {};

    // Signal tracking with memory limit
    this.signals = new Map();
    this.signalIdCounter = 0;
    this.signalStats = {
      total_generated: 0,
      total_correct: 0,
      total_outcomes: 0,
      signals_dropped: 0, // Track dropped signals for monitoring
    };

    // Analysis cache per symbol
    this.analysisCache = {};

    // Initialize buffers for symbols (will be populated on first tick)
    this.symbols = ['btc', 'eth', 'sol', 'xrp'];
    for (const symbol of this.symbols) {
      this.spotBuffers[symbol] = new PriceBuffer(
        config.bufferMaxAgeMs,
        config.bufferMaxSize
      );
      this.oracleBuffers[symbol] = new PriceBuffer(
        config.bufferMaxAgeMs,
        config.bufferMaxSize
      );
      this.tauHistory[symbol] = [];
      this.analysisCache[symbol] = null;
    }
  }

  /**
   * Handle incoming spot (Binance) tick
   * @param {Object} tick - { symbol, price, timestamp }
   */
  handleSpotTick(tick) {
    const { symbol, price, timestamp } = tick;

    if (!this.spotBuffers[symbol]) {
      if (this.log) {
        this.log.debug('unknown_symbol_spot', { symbol });
      }
      return;
    }

    // PriceBuffer.add() now validates price and returns false if invalid
    const added = this.spotBuffers[symbol].add(price, timestamp);
    if (!added && this.log) {
      this.log.debug('invalid_spot_tick', { symbol, price, timestamp });
    }
  }

  /**
   * Handle incoming oracle (Chainlink) tick
   * @param {Object} tick - { symbol, price, timestamp }
   */
  handleOracleTick(tick) {
    const { symbol, price, timestamp } = tick;

    if (!this.oracleBuffers[symbol]) {
      if (this.log) {
        this.log.debug('unknown_symbol_oracle', { symbol });
      }
      return;
    }

    // PriceBuffer.add() now validates price and returns false if invalid
    const added = this.oracleBuffers[symbol].add(price, timestamp);
    if (!added && this.log) {
      this.log.debug('invalid_oracle_tick', { symbol, price, timestamp });
    }
  }

  /**
   * Analyze lag for a symbol
   *
   * @param {string} symbol - Symbol to analyze
   * @param {number} [windowMs] - Optional window size (uses buffer max age if not specified)
   * @returns {Object|null} Analysis results or null if insufficient data
   */
  analyze(symbol, windowMs) {
    if (!this.spotBuffers[symbol] || !this.oracleBuffers[symbol]) {
      return null;
    }

    const result = findOptimalLag(
      this.spotBuffers[symbol],
      this.oracleBuffers[symbol],
      this.config.tauValues,
      TIMESTAMP_TOLERANCE_MS
    );

    if (result) {
      // Update tau history for stability tracking
      this.tauHistory[symbol].push(result.tau_star_ms);

      // Keep only last N samples
      if (this.tauHistory[symbol].length > this.config.stabilityWindowSize) {
        this.tauHistory[symbol].shift();
      }

      // Cache the result
      this.analysisCache[symbol] = {
        ...result,
        timestamp: Date.now(),
      };

      if (this.log) {
        this.log.info('lag_analysis_complete', {
          symbol,
          tau_star_ms: result.tau_star_ms,
          correlation: result.correlation,
          p_value: result.p_value,
          significant: result.significant,
          sample_size: result.sample_size,
        });
      }
    }

    return result;
  }

  /**
   * Get current lag signal for a symbol
   *
   * @param {string} symbol - Symbol to check
   * @returns {Object} Signal object with has_signal property
   */
  getLagSignal(symbol) {
    const spotBuffer = this.spotBuffers[symbol];
    const oracleBuffer = this.oracleBuffers[symbol];

    if (!spotBuffer || !oracleBuffer) {
      return { has_signal: false };
    }

    // Get recent spot movement
    const now = Date.now();
    const recentSpot = spotBuffer.getRange(now - 5000, now);

    if (recentSpot.length < 2) {
      return { has_signal: false };
    }

    // Calculate spot price movement with division-by-zero protection
    const spotStart = recentSpot[0].price;
    const spotEnd = recentSpot[recentSpot.length - 1].price;

    // Guard against division by zero or very small prices
    if (!spotStart || Math.abs(spotStart) < FLOAT_EPSILON) {
      return { has_signal: false };
    }

    const spotMove = (spotEnd - spotStart) / spotStart;

    // Guard against NaN/Infinity results
    if (!Number.isFinite(spotMove)) {
      return { has_signal: false };
    }

    // Check if move is significant
    if (Math.abs(spotMove) < this.config.minMoveMagnitude) {
      return { has_signal: false };
    }

    // Get latest oracle price
    const oraclePrices = oracleBuffer.getAll();
    if (oraclePrices.length === 0) {
      return { has_signal: false };
    }

    const latestOracle = oraclePrices[oraclePrices.length - 1];
    const oracleAge = now - latestOracle.timestamp;

    // Check if oracle is stale using configurable threshold
    const staleThreshold = this.config.staleThresholdMs || 2000;
    const oracleStale = oracleAge > staleThreshold;

    if (!oracleStale) {
      return { has_signal: false };
    }

    // Get lag analysis for confidence
    const analysis = this.analysisCache[symbol];

    if (!analysis || !analysis.significant) {
      return { has_signal: false };
    }

    if (Math.abs(analysis.correlation) < this.config.minCorrelation) {
      return { has_signal: false };
    }

    // Generate signal
    const predictedDirection = spotMove > 0 ? 'up' : 'down';
    const confidence = Math.abs(analysis.correlation);

    return {
      has_signal: true,
      direction: predictedDirection,
      tau_ms: analysis.tau_star_ms,
      correlation: analysis.correlation,
      confidence,
      spot_price: spotEnd,
      oracle_price: latestOracle.price,
      spot_move_magnitude: spotMove,
    };
  }

  /**
   * Get stability metrics for a symbol
   *
   * @param {string} symbol - Symbol to check
   * @returns {Object} Stability metrics
   */
  getStability(symbol) {
    const history = this.tauHistory[symbol] || [];

    if (history.length === 0) {
      return {
        stable: true,
        tau_history: [],
        variance: 0,
        samples: 0,
      };
    }

    const variance = calculateVariance(history);
    const stable = variance < this.config.stabilityThreshold;

    return {
      stable,
      tau_history: [...history],
      variance,
      samples: history.length,
    };
  }

  /**
   * Create a new signal record
   *
   * @param {string} symbol - Symbol
   * @param {Object} signalData - Signal data
   * @returns {number} Signal ID
   */
  createSignal(symbol, signalData) {
    // Enforce memory limit: drop oldest signals if at capacity
    if (this.signals.size >= MAX_PENDING_SIGNALS) {
      // Find and remove oldest signal (lowest ID)
      const oldestId = Math.min(...this.signals.keys());
      this.signals.delete(oldestId);
      this.signalStats.signals_dropped++;

      if (this.log) {
        this.log.warn('signal_dropped_memory_limit', {
          dropped_id: oldestId,
          limit: MAX_PENDING_SIGNALS,
        });
      }
    }

    const signalId = ++this.signalIdCounter;

    this.signals.set(signalId, {
      id: signalId,
      symbol,
      timestamp: new Date().toISOString(),
      ...signalData,
      outcome_direction: null,
      prediction_correct: null,
      pnl: null,
    });

    this.signalStats.total_generated++;

    if (this.log) {
      this.log.info('lag_signal_generated', {
        signal_id: signalId,
        symbol,
        direction: signalData.direction,
        tau_ms: signalData.tau_ms,
        correlation: signalData.correlation,
        spot_price: signalData.spot_price,
        oracle_price: signalData.oracle_price,
        move_magnitude: signalData.spot_move_magnitude,
      });
    }

    return signalId;
  }

  /**
   * Record the outcome of a signal
   *
   * @param {number} signalId - Signal ID
   * @param {Object} outcome - { outcome_direction, pnl }
   */
  recordOutcome(signalId, outcome) {
    const signal = this.signals.get(signalId);

    if (!signal) {
      if (this.log) {
        this.log.warn('signal_not_found', { signal_id: signalId });
      }
      return;
    }

    signal.outcome_direction = outcome.outcome_direction;
    signal.pnl = outcome.pnl;
    signal.prediction_correct = signal.direction === outcome.outcome_direction ? 1 : 0;

    this.signalStats.total_outcomes++;
    if (signal.prediction_correct) {
      this.signalStats.total_correct++;
    }

    if (this.log) {
      this.log.info('lag_signal_outcome', {
        signal_id: signalId,
        predicted: signal.direction,
        actual: outcome.outcome_direction,
        correct: signal.prediction_correct === 1,
        pnl: outcome.pnl,
      });
    }
  }

  /**
   * Get accuracy statistics
   *
   * @returns {Object} Accuracy stats
   */
  getAccuracyStats() {
    const { total_generated, total_correct, total_outcomes } = this.signalStats;

    return {
      total_signals: total_generated,
      total_outcomes,
      total_correct,
      accuracy: total_outcomes > 0 ? total_correct / total_outcomes : 0,
    };
  }

  /**
   * Get all pending signals (not yet persisted)
   *
   * @returns {Array} Array of signal objects
   */
  getPendingSignals() {
    return Array.from(this.signals.values());
  }

  /**
   * Clear persisted signals
   *
   * @param {number[]} signalIds - IDs of signals that have been persisted
   */
  clearPersistedSignals(signalIds) {
    for (const id of signalIds) {
      this.signals.delete(id);
    }
  }

  /**
   * Get current state
   *
   * @returns {Object} Current tracker state
   */
  getState() {
    const buffers = {};
    const analysis = {};
    const stability = {};

    for (const symbol of this.symbols) {
      const spotBuffer = this.spotBuffers[symbol];
      const oracleBuffer = this.oracleBuffers[symbol];
      const now = Date.now();

      buffers[symbol] = {
        spot_count: spotBuffer.length,
        oracle_count: oracleBuffer.length,
        oldest_ms: spotBuffer.getOldestTimestamp()
          ? now - spotBuffer.getOldestTimestamp()
          : null,
        newest_ms: spotBuffer.getNewestTimestamp()
          ? now - spotBuffer.getNewestTimestamp()
          : null,
      };

      analysis[symbol] = this.analysisCache[symbol];
      stability[symbol] = this.getStability(symbol);
    }

    return {
      buffers,
      analysis,
      stability,
      signals: {
        pending_count: this.signals.size,
        ...this.signalStats,
      },
    };
  }
}
