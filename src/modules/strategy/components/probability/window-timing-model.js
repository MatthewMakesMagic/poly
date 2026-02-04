/**
 * Window Timing Model - Black-Scholes N(d2) Probability Component
 *
 * Calculates probability of UP/DOWN outcomes using Black-Scholes model
 * with oracle price as the settlement truth (not UI price).
 *
 * Features:
 * - Black-Scholes N(d2) calculation for probability
 * - Realized volatility from oracle price history
 * - Per-asset volatility tracking (BTC, ETH, SOL, XRP)
 * - Volatility surprise detection
 * - Calibration tracking and alerting
 *
 * @module modules/strategy/components/probability/window-timing-model
 */

import { child } from '../../../logger/index.js';
import persistence from '../../../../persistence/index.js';
import { PolyError } from '../../../../types/errors.js';
import { SUPPORTED_SYMBOLS } from '../../../../clients/rtds/types.js';

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'window-timing-model',
  version: 1,
  type: 'probability',
  description: 'Black-Scholes N(d2) probability model using oracle price as settlement truth',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

/**
 * Window Timing Model Error Codes
 */
export const WindowTimingModelErrorCodes = {
  NOT_INITIALIZED: 'WINDOW_TIMING_MODEL_NOT_INITIALIZED',
  INVALID_SYMBOL: 'WINDOW_TIMING_MODEL_INVALID_SYMBOL',
  INVALID_INPUT: 'WINDOW_TIMING_MODEL_INVALID_INPUT',
  PERSISTENCE_ERROR: 'WINDOW_TIMING_MODEL_PERSISTENCE_ERROR',
  INSUFFICIENT_DATA: 'WINDOW_TIMING_MODEL_INSUFFICIENT_DATA',
};

/**
 * Window Timing Model Error Class
 */
export class WindowTimingModelError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'WindowTimingModelError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  volatility: {
    shortTermLookbackMs: 15 * 60 * 1000,     // 15 minutes
    longTermLookbackMs: 6 * 60 * 60 * 1000,  // 6 hours
    cacheExpiryMs: 60 * 1000,                // Recalculate every 60s
    surpriseThresholdHigh: 1.5,              // Vol ratio > 1.5 = surprise
    surpriseThresholdLow: 0.67,              // Vol ratio < 0.67 = surprise
    fallbackVol: 0.5,                        // Default vol if insufficient data
  },
  calibration: {
    alertThreshold: 0.15,                    // 15% calibration error
    minSampleSize: 100,                      // Min predictions before alerting
  },
  riskFreeRate: 0,                           // Negligible for short windows
};

// Module state
let log = null;
let initialized = false;
let config = null;

// Volatility cache: { symbol: { sigma, lastCalculated, dataPoints } }
let volatilityCache = {};

// Calibration alerts
let calibrationAlerts = [];

/**
 * Initialize the window timing model component
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.windowTimingModel] - Window timing model configuration
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'window-timing-model' });
  log.info('module_init_start');

  // Extract window timing model config
  const modelConfig = cfg.windowTimingModel || {};

  config = {
    volatility: {
      shortTermLookbackMs: modelConfig.volatility?.shortTermLookbackMs ?? DEFAULT_CONFIG.volatility.shortTermLookbackMs,
      longTermLookbackMs: modelConfig.volatility?.longTermLookbackMs ?? DEFAULT_CONFIG.volatility.longTermLookbackMs,
      cacheExpiryMs: modelConfig.volatility?.cacheExpiryMs ?? DEFAULT_CONFIG.volatility.cacheExpiryMs,
      surpriseThresholdHigh: modelConfig.volatility?.surpriseThresholdHigh ?? DEFAULT_CONFIG.volatility.surpriseThresholdHigh,
      surpriseThresholdLow: modelConfig.volatility?.surpriseThresholdLow ?? DEFAULT_CONFIG.volatility.surpriseThresholdLow,
      fallbackVol: modelConfig.volatility?.fallbackVol ?? DEFAULT_CONFIG.volatility.fallbackVol,
    },
    calibration: {
      alertThreshold: modelConfig.calibration?.alertThreshold ?? DEFAULT_CONFIG.calibration.alertThreshold,
      minSampleSize: modelConfig.calibration?.minSampleSize ?? DEFAULT_CONFIG.calibration.minSampleSize,
    },
    riskFreeRate: modelConfig.riskFreeRate ?? DEFAULT_CONFIG.riskFreeRate,
  };

  // Initialize volatility cache for all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    volatilityCache[symbol] = {
      sigma: null,
      lastCalculated: null,
      dataPoints: 0,
    };
  }

  initialized = true;
  log.info('window_timing_model_initialized', { config });
}

/**
 * Standard Normal CDF (Cumulative Distribution Function)
 * Uses Abramowitz and Stegun approximation (error < 7.5e-8)
 *
 * @param {number} x - Standard normal variable
 * @returns {number} Probability P(Z < x)
 */
export function normalCDF(x) {
  // Handle edge cases: NaN, Infinity
  if (Number.isNaN(x)) {
    return NaN;
  }
  if (x === Infinity) {
    return 1.0;
  }
  if (x === -Infinity) {
    return 0.0;
  }

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate Black-Scholes d2
 *
 * @param {number} S - Spot price (oracle price)
 * @param {number} K - Strike price (0.50 midpoint)
 * @param {number} T - Time to expiry in years
 * @param {number} sigma - Annualized volatility
 * @param {number} [r=0] - Risk-free rate
 * @returns {number} d2 value
 */
export function calculateD2(S, K, T, sigma, r = 0) {
  // Handle edge case: T <= 0 or sigma <= 0
  if (T <= 0 || sigma <= 0) {
    // Return deterministic: Infinity if S > K, -Infinity if S < K, 0 if S = K
    if (S > K) return Infinity;
    if (S < K) return -Infinity;
    return 0;
  }

  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  return d2;
}

/**
 * Calculate probability of UP/DOWN using Black-Scholes N(d2)
 *
 * @param {number} oraclePrice - Current oracle price (S)
 * @param {number} strike - Strike price (K) - typically 0.50 midpoint
 * @param {number} timeToExpiryMs - Time to expiry in milliseconds
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Object} Probability result
 */
export function calculateProbability(oraclePrice, strike, timeToExpiryMs, symbol) {
  ensureInitialized();

  // Validate inputs
  if (typeof oraclePrice !== 'number' || !Number.isFinite(oraclePrice) || oraclePrice <= 0) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid oracle price: ${oraclePrice}`,
      { oraclePrice }
    );
  }
  if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid strike: ${strike}`,
      { strike }
    );
  }
  if (typeof timeToExpiryMs !== 'number' || !Number.isFinite(timeToExpiryMs)) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid time to expiry: ${timeToExpiryMs}`,
      { timeToExpiryMs }
    );
  }
  // Validate symbol
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // Get volatility for symbol, scaled to window duration
  // Short windows use short-term vol, longer windows use long-term vol
  const sigma = getVolatilityForCalculation(symbol, timeToExpiryMs);

  // Convert time to years
  const T = timeToExpiryMs / (365.25 * 24 * 60 * 60 * 1000);

  // Edge case: T <= 0 (at or past expiry)
  if (T <= 0 || timeToExpiryMs <= 0) {
    const p_up = oraclePrice > strike ? 1.0 : (oraclePrice < strike ? 0.0 : 0.5);
    const result = {
      p_up,
      p_down: 1 - p_up,
      d2: oraclePrice > strike ? Infinity : (oraclePrice < strike ? -Infinity : 0),
      sigma_used: sigma,
      inputs: { S: oraclePrice, K: strike, T_years: 0, T_ms: timeToExpiryMs },
    };

    log.info('probability_calculated', {
      symbol,
      p_up: result.p_up,
      p_down: result.p_down,
      d2: result.d2,
      sigma: result.sigma_used,
      inputs: result.inputs,
      edge_case: 'expiry',
    });

    return result;
  }

  // Calculate d2 and probability
  const d2 = calculateD2(oraclePrice, strike, T, sigma, config.riskFreeRate);
  const p_up = normalCDF(d2);

  // Check for volatility surprise
  const volSurprise = detectVolatilitySurprise(symbol);

  const result = {
    p_up,
    p_down: 1 - p_up,
    d2,
    sigma_used: sigma,
    vol_surprise: volSurprise.isSurprise,
    inputs: { S: oraclePrice, K: strike, T_years: T, T_ms: timeToExpiryMs },
  };

  log.info('probability_calculated', {
    symbol,
    p_up: result.p_up,
    p_down: result.p_down,
    d2: result.d2,
    sigma: result.sigma_used,
    inputs: result.inputs,
    vol_surprise: volSurprise,
  });

  return result;
}

/**
 * Calculate realized volatility from oracle price history
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @param {number} [lookbackMs] - Lookback period in milliseconds
 * @returns {Promise<number|null>} Annualized volatility or null if insufficient data
 */
export async function calculateRealizedVolatility(symbol, lookbackMs = null) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  const lookback = lookbackMs ?? config.volatility.longTermLookbackMs;
  const lookbackSeconds = Math.floor(lookback / 1000);

  try {
    // Query oracle updates from oracle_updates table
    const updates = await persistence.all(
      `SELECT price, timestamp FROM oracle_updates
       WHERE symbol = $1 AND timestamp > NOW() - ($2 * INTERVAL '1 second')
       ORDER BY timestamp ASC`,
      [symbol, lookbackSeconds]
    );

    if (updates.length < 2) {
      return null; // Insufficient data
    }

    // Calculate log returns
    const logReturns = [];
    for (let i = 1; i < updates.length; i++) {
      const prevPrice = updates[i - 1].price;
      const currPrice = updates[i].price;
      if (prevPrice > 0 && currPrice > 0) {
        logReturns.push(Math.log(currPrice / prevPrice));
      }
    }

    if (logReturns.length < 2) {
      return null;
    }

    // Calculate standard deviation
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    // Annualize (estimate periods per year based on lookback)
    const avgIntervalMs = lookback / logReturns.length;
    const periodsPerYear = (365.25 * 24 * 60 * 60 * 1000) / avgIntervalMs;
    const annualizedVol = stdDev * Math.sqrt(periodsPerYear);

    log.info('volatility_calculated', {
      symbol,
      sigma: annualizedVol,
      lookback_ms: lookback,
      data_points: updates.length,
      log_returns: logReturns.length,
    });

    return annualizedVol;
  } catch (err) {
    log.error('volatility_calculation_failed', { symbol, error: err.message });
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.PERSISTENCE_ERROR,
      `Failed to calculate volatility for ${symbol}: ${err.message}`,
      { symbol, error: err.message }
    );
  }
}

/**
 * Get volatility for a symbol, using cache if valid
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @param {number} [windowDurationMs] - Window duration for scaling lookback
 * @returns {number} Volatility (cached or freshly calculated)
 */
export function getVolatility(symbol, windowDurationMs = null) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // Determine appropriate lookback based on window duration
  // Short windows (< 30 min) → use short-term vol
  // Longer windows → use long-term vol
  const useShortTerm = windowDurationMs && windowDurationMs < 30 * 60 * 1000;
  const lookbackMs = useShortTerm
    ? config.volatility.shortTermLookbackMs
    : config.volatility.longTermLookbackMs;

  const cacheKey = `${symbol}_${useShortTerm ? 'short' : 'long'}`;
  const cached = volatilityCache[symbol];
  const now = Date.now();

  // Check if cache is valid
  if (cached.sigma !== null && cached.lastCalculated !== null) {
    const age = now - new Date(cached.lastCalculated).getTime();
    if (age < config.volatility.cacheExpiryMs) {
      return cached.sigma;
    }
  }

  // V3 Stage 2: calculateRealizedVolatility is now async (uses PostgreSQL).
  // Since getVolatility is called synchronously from calculateProbability,
  // we fire-and-forget the async recalculation and use fallback for now.
  // The cache will be populated on the next call after the async completes.
  calculateRealizedVolatility(symbol, lookbackMs)
    .then((sigma) => {
      if (sigma !== null && typeof sigma === 'number') {
        volatilityCache[symbol] = {
          sigma,
          lastCalculated: new Date().toISOString(),
          dataPoints: sigma > 0 ? 100 : 0,
          lookbackMs,
        };

        log.debug('volatility_selected', {
          symbol,
          sigma,
          window_duration_ms: windowDurationMs,
          lookback_ms: lookbackMs,
          type: useShortTerm ? 'short_term' : 'long_term',
        });
      }
    })
    .catch((err) => {
      log.warn('volatility_async_update_failed', { symbol, error: err.message });
    });

  // Return fallback while async recalculation is in progress
  return config.volatility.fallbackVol;
}

/**
 * Get volatility for probability calculation (with fallback)
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @param {number} [windowDurationMs] - Window duration for scaling lookback
 * @returns {number} Volatility to use
 */
function getVolatilityForCalculation(symbol, windowDurationMs = null) {
  try {
    return getVolatility(symbol, windowDurationMs);
  } catch (err) {
    log.warn('volatility_fallback', {
      symbol,
      fallback: config.volatility.fallbackVol,
      error: err.message,
    });
    return config.volatility.fallbackVol;
  }
}

/**
 * Detect volatility surprise (short-term vs long-term divergence)
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Object} Surprise detection result
 */
export function detectVolatilitySurprise(symbol) {
  ensureInitialized();

  try {
    const shortTermVol = calculateRealizedVolatility(symbol, config.volatility.shortTermLookbackMs);
    const longTermVol = calculateRealizedVolatility(symbol, config.volatility.longTermLookbackMs);

    if (shortTermVol === null || longTermVol === null || longTermVol === 0) {
      return { isSurprise: false, ratio: null };
    }

    const ratio = shortTermVol / longTermVol;
    const isSurprise = ratio > config.volatility.surpriseThresholdHigh ||
                       ratio < config.volatility.surpriseThresholdLow;

    if (isSurprise) {
      log.warn('vol_surprise_detected', {
        symbol,
        short_term: shortTermVol,
        long_term: longTermVol,
        ratio,
      });
    }

    return {
      isSurprise,
      ratio,
      shortTermVol,
      longTermVol,
    };
  } catch (err) {
    // Log the error but return safe default - volatility surprise is non-critical
    log.error('volatility_surprise_detection_failed', {
      symbol,
      error: err.message,
      stack: err.stack,
    });
    return { isSurprise: false, ratio: null, error: err.message };
  }
}

/**
 * Assign prediction to a calibration bucket
 *
 * @param {number} p_up - Probability of UP
 * @returns {string} Bucket name
 */
export function assignBucket(p_up) {
  const buckets = [
    { name: '0-10%', min: 0.0, max: 0.1 },
    { name: '10-20%', min: 0.1, max: 0.2 },
    { name: '20-30%', min: 0.2, max: 0.3 },
    { name: '30-40%', min: 0.3, max: 0.4 },
    { name: '40-50%', min: 0.4, max: 0.5 },
    { name: '50-60%', min: 0.5, max: 0.6 },
    { name: '60-70%', min: 0.6, max: 0.7 },
    { name: '70-80%', min: 0.7, max: 0.8 },
    { name: '80-90%', min: 0.8, max: 0.9 },
    { name: '90-100%', min: 0.9, max: 1.0 },
  ];

  for (const bucket of buckets) {
    if (p_up >= bucket.min && p_up < bucket.max) {
      return bucket.name;
    }
  }
  return p_up >= 1.0 ? '90-100%' : '0-10%';
}

/**
 * Log a prediction for calibration tracking
 *
 * @param {Object} prediction - Prediction details
 * @param {string} prediction.symbol - Symbol
 * @param {string} prediction.windowId - Window ID
 * @param {number} prediction.p_up - Predicted probability of UP
 * @param {number} prediction.oraclePrice - Oracle price at prediction
 * @param {number} prediction.strike - Strike price
 * @param {number} prediction.timeToExpiryMs - Time to expiry
 * @param {number} prediction.sigma - Volatility used
 * @param {boolean} [prediction.volSurprise=false] - Volatility surprise flag
 * @returns {number} Inserted row ID
 */
export function logPrediction(prediction) {
  ensureInitialized();

  const {
    symbol,
    windowId,
    p_up,
    oraclePrice,
    strike,
    timeToExpiryMs,
    sigma,
    volSurprise = false,
  } = prediction;

  // Validate p_up is a valid probability
  if (typeof p_up !== 'number' || !Number.isFinite(p_up) || p_up < 0 || p_up > 1) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid p_up: ${p_up}. Must be a number between 0 and 1`,
      { p_up }
    );
  }

  // Validate windowId
  if (typeof windowId !== 'string' || windowId.length === 0 || windowId.length > 255) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid windowId: must be a non-empty string with max 255 characters`,
      { windowId }
    );
  }

  const bucket = assignBucket(p_up);
  const timestamp = new Date().toISOString();

  try {
    const result = persistence.run(
      `INSERT INTO probability_predictions
       (timestamp, symbol, window_id, predicted_p_up, bucket, oracle_price_at_prediction, strike, time_to_expiry_ms, sigma_used, vol_surprise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, symbol, windowId, p_up, bucket, oraclePrice, strike, timeToExpiryMs, sigma, volSurprise ? 1 : 0]
    );

    log.info('prediction_logged', {
      window_id: windowId,
      symbol,
      p_up,
      bucket,
    });

    return result.lastInsertRowid;
  } catch (err) {
    log.error('prediction_log_failed', { symbol, windowId, error: err.message });
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.PERSISTENCE_ERROR,
      `Failed to log prediction: ${err.message}`,
      { prediction, error: err.message }
    );
  }
}

/**
 * Record actual outcome for a prediction
 *
 * @param {string} windowId - Window ID
 * @param {string} actualOutcome - 'up' or 'down'
 * @returns {Object} Update result
 */
export function recordOutcome(windowId, actualOutcome) {
  ensureInitialized();

  if (!['up', 'down'].includes(actualOutcome)) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.INVALID_INPUT,
      `Invalid outcome: ${actualOutcome}. Must be 'up' or 'down'`,
      { windowId, actualOutcome }
    );
  }

  try {
    // Get the prediction
    const prediction = persistence.get(
      'SELECT id, predicted_p_up FROM probability_predictions WHERE window_id = ?',
      [windowId]
    );

    if (!prediction) {
      return { updated: 0 };
    }

    // Determine if prediction was correct
    // If p_up >= 0.5, model predicted UP. If outcome is 'up', correct.
    // If p_up < 0.5, model predicted DOWN. If outcome is 'down', correct.
    const predictedUp = prediction.predicted_p_up >= 0.5;
    const actualUp = actualOutcome === 'up';
    const predictionCorrect = predictedUp === actualUp ? 1 : 0;

    const result = persistence.run(
      `UPDATE probability_predictions
       SET actual_outcome = ?, prediction_correct = ?, settled_at = ?
       WHERE window_id = ?`,
      [actualOutcome, predictionCorrect, new Date().toISOString(), windowId]
    );

    log.info('outcome_recorded', {
      window_id: windowId,
      actual_outcome: actualOutcome,
      prediction_correct: predictionCorrect === 1,
    });

    // Check calibration after recording
    checkCalibrationAlerts();

    return { updated: result.changes };
  } catch (err) {
    log.error('outcome_record_failed', { windowId, error: err.message });
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.PERSISTENCE_ERROR,
      `Failed to record outcome: ${err.message}`,
      { windowId, actualOutcome, error: err.message }
    );
  }
}

/**
 * Get calibration statistics
 *
 * @returns {Object} Calibration stats
 */
export function getCalibration() {
  ensureInitialized();

  try {
    // Get total predictions
    const totalResult = persistence.get(
      'SELECT COUNT(*) as count FROM probability_predictions'
    );

    // Get bucket-level stats (only for settled predictions)
    const bucketStats = persistence.all(
      `SELECT
        bucket,
        COUNT(*) as count,
        SUM(CASE WHEN prediction_correct = 1 THEN 1 ELSE 0 END) as hits
       FROM probability_predictions
       WHERE actual_outcome IS NOT NULL
       GROUP BY bucket`
    );

    const buckets = {};
    let totalCalibrationError = 0;
    let bucketsWithData = 0;

    for (const stat of bucketStats) {
      const hitRate = stat.count > 0 ? stat.hits / stat.count : 0;

      // Calculate expected rate from bucket midpoint
      const bucketMatch = stat.bucket.match(/(\d+)-(\d+)%/);
      let expectedRate = 0.5;
      if (bucketMatch) {
        const low = parseInt(bucketMatch[1], 10) / 100;
        const high = parseInt(bucketMatch[2], 10) / 100;
        expectedRate = (low + high) / 2;
      }

      const error = Math.abs(expectedRate - hitRate);

      buckets[stat.bucket] = {
        count: stat.count,
        hits: stat.hits,
        hit_rate: hitRate,
        expected_rate: expectedRate,
        error,
      };

      if (stat.count >= config.calibration.minSampleSize) {
        totalCalibrationError += error;
        bucketsWithData++;
      }
    }

    const avgCalibrationError = bucketsWithData > 0 ? totalCalibrationError / bucketsWithData : 0;

    return {
      total_predictions: totalResult?.count || 0,
      buckets,
      avg_calibration_error: avgCalibrationError,
      alerts: [...calibrationAlerts],
    };
  } catch (err) {
    log.error('calibration_fetch_failed', { error: err.message });
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.PERSISTENCE_ERROR,
      `Failed to get calibration: ${err.message}`,
      { error: err.message }
    );
  }
}

/**
 * Check for calibration alerts
 */
function checkCalibrationAlerts() {
  try {
    const calibration = getCalibration();

    // Clear old alerts
    calibrationAlerts = [];

    for (const [bucket, stats] of Object.entries(calibration.buckets)) {
      if (stats.count >= config.calibration.minSampleSize &&
          stats.error > config.calibration.alertThreshold) {
        const alert = {
          bucket,
          predicted_midpoint: stats.expected_rate,
          actual_hit_rate: stats.hit_rate,
          error: stats.error,
          sample_size: stats.count,
          timestamp: new Date().toISOString(),
        };

        calibrationAlerts.push(alert);

        log.warn('calibration_alert', alert);
      }
    }
  } catch (err) {
    // Log error but don't throw - calibration alerting is non-critical
    log.error('calibration_alert_check_failed', {
      error: err.message,
      stack: err.stack,
    });
  }
}

/**
 * Evaluate probability (standard component interface)
 *
 * Story 7-14: Updated to use correct price inputs
 * - oracle_price (or spotPrice): Crypto dollar price for Black-Scholes S
 * - reference_price (or targetPrice): Strike price from market question for Black-Scholes K
 * - market_price: Token price (0-1) for edge calculation (passed through)
 *
 * @param {Object} context - Market and strategy context
 * @param {number} context.oracle_price - Crypto dollar price (e.g., $95,000)
 * @param {number} context.reference_price - Strike price from market (e.g., $94,500)
 * @param {number} context.market_price - Token price (0-1) for edge calculation
 * @param {number} context.timeToExpiry - Time to expiry in ms
 * @param {string} context.symbol - Cryptocurrency symbol (lowercase)
 * @param {Object} config - Component configuration (unused, uses module config)
 * @returns {Object} Evaluation result with probability and market_price for edge calc
 */
export function evaluate(context, componentConfig) {
  // Story 7-14: Use new field names with fallback to legacy names
  const oraclePrice = context.oracle_price || context.spotPrice;
  const referencePrice = context.reference_price || context.targetPrice;
  const { timeToExpiry, symbol, market_price } = context;

  // Validate we have the required inputs
  if (!oraclePrice || !referencePrice) {
    log.warn('probability_eval_missing_inputs', {
      oracle_price: oraclePrice,
      reference_price: referencePrice,
      symbol,
    });
    return {
      probability: null,
      signal: 'hold',
      error: 'Missing oracle_price or reference_price',
    };
  }

  const result = calculateProbability(oraclePrice, referencePrice, timeToExpiry, symbol);

  // Story 7-16: Don't determine signal here - let edge calculation do it
  // Just return the probability and market_price for edge calculation
  // Legacy signal logic kept for backwards compatibility but should not be used
  let signal = 'hold';
  if (result.p_up > 0.7) {
    signal = 'entry';  // Legacy - edge calculation should override this
  } else if (result.p_up < 0.3) {
    signal = 'exit';
  }

  return {
    probability: result.p_up,
    market_price,  // Pass through for edge calculation
    signal,
    details: {
      p_up: result.p_up,
      p_down: result.p_down,
      d2: result.d2,
      sigma_used: result.sigma_used,
      vol_surprise: result.vol_surprise,
      oracle_price: oraclePrice,
      reference_price: referencePrice,
    },
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} cfg - Configuration to validate
 * @returns {Object} Validation result
 */
export function validateConfig(cfg) {
  const errors = [];

  if (cfg.volatility) {
    if (cfg.volatility.shortTermLookbackMs !== undefined &&
        (typeof cfg.volatility.shortTermLookbackMs !== 'number' || cfg.volatility.shortTermLookbackMs <= 0)) {
      errors.push('volatility.shortTermLookbackMs must be a positive number');
    }
    if (cfg.volatility.longTermLookbackMs !== undefined &&
        (typeof cfg.volatility.longTermLookbackMs !== 'number' || cfg.volatility.longTermLookbackMs <= 0)) {
      errors.push('volatility.longTermLookbackMs must be a positive number');
    }
    if (cfg.volatility.fallbackVol !== undefined &&
        (typeof cfg.volatility.fallbackVol !== 'number' || cfg.volatility.fallbackVol <= 0)) {
      errors.push('volatility.fallbackVol must be a positive number');
    }
  }

  if (cfg.calibration) {
    if (cfg.calibration.alertThreshold !== undefined &&
        (typeof cfg.calibration.alertThreshold !== 'number' || cfg.calibration.alertThreshold < 0 || cfg.calibration.alertThreshold > 1)) {
      errors.push('calibration.alertThreshold must be a number between 0 and 1');
    }
    if (cfg.calibration.minSampleSize !== undefined &&
        (typeof cfg.calibration.minSampleSize !== 'number' || cfg.calibration.minSampleSize < 1)) {
      errors.push('calibration.minSampleSize must be a positive integer');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized) {
    return {
      initialized: false,
      volatility: {},
      calibration: {},
      config: null,
    };
  }

  // Build volatility state
  const volatilityState = {};
  for (const symbol of SUPPORTED_SYMBOLS) {
    const cached = volatilityCache[symbol];
    volatilityState[symbol] = {
      current: cached.sigma,
      lastCalculated: cached.lastCalculated,
      dataPoints: cached.dataPoints,
    };
  }

  let calibrationState = {};
  let calibrationError = null;
  try {
    calibrationState = getCalibration();
  } catch (err) {
    calibrationError = err.message;
    calibrationState = { total_predictions: 0, buckets: {}, alerts: [], error: calibrationError };
    log.error('calibration_state_fetch_failed', { error: err.message });
  }

  return {
    initialized: true,
    volatility: volatilityState,
    calibration: calibrationState,
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Clear caches
  volatilityCache = {};
  calibrationAlerts = [];

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {WindowTimingModelError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new WindowTimingModelError(
      WindowTimingModelErrorCodes.NOT_INITIALIZED,
      'Window timing model not initialized. Call init() first.'
    );
  }
}

// Default export for component registration
export default {
  metadata,
  init,
  evaluate,
  validateConfig,
  calculateProbability,
  getVolatility,
  getCalibration,
  logPrediction,
  recordOutcome,
  getState,
  shutdown,
};
