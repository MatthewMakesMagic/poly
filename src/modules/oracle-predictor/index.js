/**
 * Oracle Update Predictor Module
 *
 * Predicts the probability of an oracle update before window expiry using
 * empirical pattern analysis from historical oracle update data.
 *
 * Key Features:
 * - Empirical distribution calculation from historical patterns
 * - Prediction query interface with confidence intervals
 * - Prediction logging and outcome tracking for calibration
 * - Integration with oracle-tracker for oracle state
 * - Integration with divergence-tracker for current deviation (optional)
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/oracle-predictor
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as oracleTracker from '../oracle-tracker/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';
import { OracleUpdatePredictor } from './predictor.js';
import {
  OraclePredictorError,
  OraclePredictorErrorCodes,
  DEFAULT_CONFIG,
  CALIBRATION_BUCKETS,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let predictor = null;
let config = null;

// Statistics
let stats = {
  predictionsGenerated: 0,
  predictionsLogged: 0,
  outcomesRecorded: 0,
  calibrationChecks: 0,
};

/**
 * Initialize the oracle predictor module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.oraclePredictor] - Oracle predictor configuration
 * @param {number} [cfg.oraclePredictor.patternCacheExpiryMs=300000] - Pattern cache expiry (5 min)
 * @param {number} [cfg.oraclePredictor.minHistoricalUpdates=20] - Minimum updates for reliable prediction
 * @param {number} [cfg.oraclePredictor.confidenceLevel=0.95] - Confidence level for intervals
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'oracle-predictor' });
  log.info('module_init_start');

  // Extract oracle predictor config
  const oraclePredictorConfig = cfg.oraclePredictor || {};
  config = {
    patternCacheExpiryMs: oraclePredictorConfig.patternCacheExpiryMs ?? DEFAULT_CONFIG.patternCacheExpiryMs,
    minHistoricalUpdates: oraclePredictorConfig.minHistoricalUpdates ?? DEFAULT_CONFIG.minHistoricalUpdates,
    confidenceLevel: oraclePredictorConfig.confidenceLevel ?? DEFAULT_CONFIG.confidenceLevel,
    buckets: oraclePredictorConfig.buckets ?? DEFAULT_CONFIG.buckets,
  };

  // Create predictor instance
  predictor = new OracleUpdatePredictor({
    config,
    logger: log,
  });

  initialized = true;
  log.info('oracle_predictor_initialized', {
    config: {
      patternCacheExpiryMs: config.patternCacheExpiryMs,
      minHistoricalUpdates: config.minHistoricalUpdates,
    },
  });
}

/**
 * Get prediction for probability of oracle update before expiry
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {number} timeToExpiryMs - Time to window expiry in milliseconds
 * @returns {Object} Prediction result: { p_update, confidence, inputs_used }
 * @throws {OraclePredictorError} If not initialized, invalid symbol, or persistence error
 */
export function getPrediction(symbol, timeToExpiryMs) {
  ensureInitialized();

  // Validate symbol
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // Validate time to expiry
  if (typeof timeToExpiryMs !== 'number' || !Number.isFinite(timeToExpiryMs)) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_INPUT,
      `Invalid time to expiry: ${timeToExpiryMs}`,
      { timeToExpiryMs }
    );
  }

  // Get current oracle state
  const oracleState = getOracleState(symbol);
  const timeSinceLastUpdateMs = Date.now() - oracleState.last_update_at;

  // Validate timeSinceLastUpdateMs is a valid number
  if (!Number.isFinite(timeSinceLastUpdateMs) || timeSinceLastUpdateMs < 0) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_INPUT,
      `Invalid time since last update: ${timeSinceLastUpdateMs}`,
      { symbol, last_update_at: oracleState.last_update_at }
    );
  }

  // Get current deviation (best effort)
  const currentDeviationPct = getCurrentDeviation(symbol);

  // Get patterns (cached or fresh)
  const patterns = getOrCalculatePatterns(symbol);

  // Get prediction from predictor
  const prediction = predictor.getPrediction({
    symbol,
    timeToExpiryMs,
    timeSinceLastUpdateMs,
    currentDeviationPct,
    patterns,
  });

  stats.predictionsGenerated++;

  log.info('prediction_generated', {
    symbol,
    p_update: prediction.p_update,
    confidence: prediction.confidence,
    time_to_expiry_ms: timeToExpiryMs,
    time_since_last_update_ms: timeSinceLastUpdateMs,
  });

  return prediction;
}

/**
 * Get analyzed patterns for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Object|null} Pattern analysis or null if insufficient data
 * @throws {OraclePredictorError} If not initialized or invalid symbol
 */
export function getPatterns(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  return getOrCalculatePatterns(symbol);
}

/**
 * Log a prediction for calibration tracking
 *
 * @param {Object} prediction - Prediction to log
 * @param {string} prediction.symbol - Symbol
 * @param {string} [prediction.windowId] - Optional window ID
 * @param {number} prediction.timeToExpiryMs - Time to expiry
 * @param {number} prediction.timeSinceLastUpdateMs - Time since last update
 * @param {number} prediction.currentDeviationPct - Current deviation
 * @param {number} prediction.predictedPUpdate - Predicted probability
 * @param {Object} prediction.confidence - Confidence interval { low, high }
 * @param {string} prediction.bucket - Condition bucket used
 * @returns {number} Inserted row ID
 * @throws {OraclePredictorError} If persistence fails
 */
export function logPrediction(prediction) {
  ensureInitialized();

  const {
    symbol,
    windowId = null,
    timeToExpiryMs,
    timeSinceLastUpdateMs,
    currentDeviationPct,
    predictedPUpdate,
    confidence,
    bucket,
  } = prediction;

  // Validate required fields
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}`,
      { symbol }
    );
  }

  if (typeof predictedPUpdate !== 'number' || !Number.isFinite(predictedPUpdate) ||
      predictedPUpdate < 0 || predictedPUpdate > 1) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_INPUT,
      `Invalid predicted probability: ${predictedPUpdate}`,
      { predictedPUpdate }
    );
  }

  // Assign calibration bucket
  const calibrationBucket = predictor.assignCalibrationBucket(predictedPUpdate);
  const timestamp = new Date().toISOString();

  try {
    const result = persistence.run(
      `INSERT INTO oracle_update_predictions
       (timestamp, symbol, window_id, time_to_expiry_ms, time_since_last_update_ms,
        current_deviation_pct, predicted_p_update, confidence_low, confidence_high, bucket, inputs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        timestamp,
        symbol,
        windowId,
        timeToExpiryMs,
        timeSinceLastUpdateMs,
        currentDeviationPct,
        predictedPUpdate,
        confidence?.low ?? null,
        confidence?.high ?? null,
        calibrationBucket,
        JSON.stringify({ bucket, confidence }),
      ]
    );

    stats.predictionsLogged++;

    log.info('prediction_logged', {
      prediction_id: result.lastInsertRowid,
      symbol,
      p_update: predictedPUpdate,
      bucket: calibrationBucket,
    });

    return result.lastInsertRowid;
  } catch (err) {
    log.error('prediction_log_failed', { symbol, error: err.message });
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.PERSISTENCE_ERROR,
      `Failed to log prediction: ${err.message}`,
      { prediction, error: err.message }
    );
  }
}

/**
 * Record actual outcome for a prediction
 *
 * @param {string} windowId - Window ID
 * @param {boolean} updateOccurred - Whether an oracle update occurred before expiry
 * @returns {Object} Update result { updated, predictionCorrect }
 * @throws {OraclePredictorError} If persistence fails
 */
export function recordOutcome(windowId, updateOccurred) {
  ensureInitialized();

  if (typeof windowId !== 'string' || windowId.length === 0) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_INPUT,
      'Invalid windowId: must be a non-empty string',
      { windowId }
    );
  }

  if (typeof updateOccurred !== 'boolean') {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INVALID_INPUT,
      'Invalid updateOccurred: must be a boolean',
      { updateOccurred }
    );
  }

  try {
    // Get the prediction
    const prediction = persistence.get(
      'SELECT id, predicted_p_update FROM oracle_update_predictions WHERE window_id = ?',
      [windowId]
    );

    if (!prediction) {
      return { updated: 0, predictionCorrect: null };
    }

    // Determine outcome (1 = update occurred, 0 = no update)
    const actualOutcome = updateOccurred ? 1 : 0;

    // Update the prediction record
    const result = persistence.run(
      `UPDATE oracle_update_predictions
       SET actual_outcome = ?, settled_at = ?
       WHERE window_id = ?`,
      [actualOutcome, new Date().toISOString(), windowId]
    );

    stats.outcomesRecorded++;

    // Determine if prediction was "correct" for calibration
    // If p_update >= 0.5, model predicted update likely. If update occurred, correct.
    const predictedUpdateLikely = prediction.predicted_p_update >= 0.5;
    const predictionCorrect = predictedUpdateLikely === updateOccurred;

    log.info('outcome_recorded', {
      prediction_id: prediction.id,
      window_id: windowId,
      actual_outcome: updateOccurred,
      predicted_p_update: prediction.predicted_p_update,
      prediction_correct: predictionCorrect,
    });

    return { updated: result.changes, predictionCorrect };
  } catch (err) {
    log.error('outcome_record_failed', { windowId, error: err.message });
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.PERSISTENCE_ERROR,
      `Failed to record outcome: ${err.message}`,
      { windowId, updateOccurred, error: err.message }
    );
  }
}

/**
 * Get calibration statistics
 *
 * @returns {Object} Calibration stats by bucket
 * @throws {OraclePredictorError} If persistence fails
 */
export function getCalibration() {
  ensureInitialized();

  try {
    // Get total predictions
    const totalResult = persistence.get(
      'SELECT COUNT(*) as count FROM oracle_update_predictions'
    );

    // Get settled predictions count
    const settledResult = persistence.get(
      'SELECT COUNT(*) as count FROM oracle_update_predictions WHERE actual_outcome IS NOT NULL'
    );

    // Get bucket-level stats (only for settled predictions)
    const bucketStats = persistence.all(
      `SELECT
        bucket,
        COUNT(*) as count,
        SUM(actual_outcome) as updates_occurred,
        AVG(predicted_p_update) as avg_predicted
       FROM oracle_update_predictions
       WHERE actual_outcome IS NOT NULL
       GROUP BY bucket`
    );

    const buckets = {};
    let totalCalibrationError = 0;
    let bucketsWithData = 0;

    for (const stat of bucketStats) {
      const actualRate = stat.count > 0 ? stat.updates_occurred / stat.count : 0;

      // Calculate expected rate from bucket midpoint
      const bucketMatch = stat.bucket.match(/(\d+)-(\d+)%/);
      let expectedRate = 0.5;
      if (bucketMatch) {
        const low = parseInt(bucketMatch[1], 10) / 100;
        const high = parseInt(bucketMatch[2], 10) / 100;
        expectedRate = (low + high) / 2;
      }

      const error = Math.abs(expectedRate - actualRate);

      buckets[stat.bucket] = {
        count: stat.count,
        updates_occurred: stat.updates_occurred,
        actual_rate: actualRate,
        avg_predicted: stat.avg_predicted,
        expected_rate: expectedRate,
        error,
      };

      if (stat.count >= 10) { // Need at least 10 samples for meaningful calibration
        totalCalibrationError += error;
        bucketsWithData++;
      }
    }

    const avgCalibrationError = bucketsWithData > 0 ? totalCalibrationError / bucketsWithData : 0;

    stats.calibrationChecks++;

    return {
      total_predictions: totalResult?.count || 0,
      settled_predictions: settledResult?.count || 0,
      buckets,
      avg_error: avgCalibrationError,
    };
  } catch (err) {
    log.error('calibration_fetch_failed', { error: err.message });
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.PERSISTENCE_ERROR,
      `Failed to get calibration: ${err.message}`,
      { error: err.message }
    );
  }
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized || !predictor) {
    return {
      initialized: false,
      patterns: {},
      calibration: {},
      stats: {},
      config: null,
    };
  }

  // Build patterns state
  const patternsState = {};
  for (const symbol of SUPPORTED_SYMBOLS) {
    const cached = predictor.patternCache[symbol];
    if (cached && cached.patterns) {
      patternsState[symbol] = {
        totalUpdates: cached.patterns.totalUpdates,
        avgUpdateIntervalMs: cached.patterns.avgUpdateIntervalMs,
        analyzedAt: cached.patterns.analyzedAt,
        bucketCount: Object.keys(cached.patterns.buckets).length,
      };
    } else {
      patternsState[symbol] = null;
    }
  }

  // Get calibration (with error handling)
  let calibrationState = {};
  try {
    calibrationState = getCalibration();
  } catch (err) {
    calibrationState = { total_predictions: 0, buckets: {}, avg_error: 0, error: err.message };
  }

  return {
    initialized: true,
    patterns: patternsState,
    calibration: calibrationState,
    stats: { ...stats },
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

  // Clear predictor cache
  if (predictor) {
    predictor.clearCache();
    predictor = null;
  }

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    predictionsGenerated: 0,
    predictionsLogged: 0,
    outcomesRecorded: 0,
    calibrationChecks: 0,
  };
}

/**
 * Internal: Get oracle state from oracle-tracker
 *
 * @param {string} symbol - Symbol to query
 * @returns {Object} Oracle state { last_price, last_update_at, updates_recorded }
 * @throws {OraclePredictorError} If oracle data not available
 */
function getOracleState(symbol) {
  try {
    const state = oracleTracker.getState();
    const tracking = state.tracking[symbol];

    if (!tracking || tracking.last_update_at === null) {
      throw new OraclePredictorError(
        OraclePredictorErrorCodes.INSUFFICIENT_DATA,
        `No oracle data available for ${symbol}`,
        { symbol }
      );
    }

    return {
      last_price: tracking.last_price,
      last_update_at: new Date(tracking.last_update_at).getTime(),
      updates_recorded: tracking.updates_recorded,
    };
  } catch (err) {
    if (err instanceof OraclePredictorError) {
      throw err;
    }
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INSUFFICIENT_DATA,
      `Failed to get oracle state for ${symbol}: ${err.message}`,
      { symbol, error: err.message }
    );
  }
}

/**
 * Internal: Get current deviation from divergence-tracker (optional)
 *
 * @param {string} symbol - Symbol to query
 * @returns {number} Absolute deviation percentage
 */
async function getCurrentDeviationAsync(symbol) {
  try {
    // Try to import divergence-tracker dynamically to avoid hard dependency
    const divergenceTracker = await import('../divergence-tracker/index.js');
    const state = divergenceTracker.getState();
    const symbolState = state.spreads?.[symbol];

    if (symbolState && symbolState.pct !== null) {
      return Math.abs(symbolState.pct);
    }
  } catch {
    // Divergence tracker not available, use fallback
  }
  return null;
}

/**
 * Internal: Get current deviation (sync wrapper with fallback)
 *
 * @param {string} symbol - Symbol to query
 * @returns {number} Absolute deviation percentage
 */
function getCurrentDeviation(symbol) {
  // Note: We can't use async import in sync context, so we rely on fallback

  // Fallback: estimate deviation from recent oracle update
  try {
    const latestUpdate = persistence.get(
      'SELECT deviation_from_previous_pct FROM oracle_updates WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1',
      [symbol]
    );
    return Math.abs(latestUpdate?.deviation_from_previous_pct || 0);
  } catch {
    return 0;
  }
}

/**
 * Internal: Get or calculate patterns for a symbol
 *
 * @param {string} symbol - Symbol to analyze
 * @returns {Object|null} Patterns or null if insufficient data
 */
function getOrCalculatePatterns(symbol) {
  // Check cache
  if (predictor.isCacheValid(symbol)) {
    return predictor.getCachedPatterns(symbol);
  }

  // Query historical updates
  try {
    const updates = persistence.all(
      `SELECT timestamp, price, previous_price, deviation_from_previous_pct, time_since_previous_ms
       FROM oracle_updates
       WHERE symbol = ?
       ORDER BY timestamp ASC`,
      [symbol]
    );

    const patterns = predictor.analyzePatterns(updates, symbol);

    if (patterns) {
      predictor.updateCache(symbol, patterns);
      log.info('patterns_analyzed', {
        symbol,
        total_updates: patterns.totalUpdates,
        avg_interval_ms: patterns.avgUpdateIntervalMs,
        bucket_count: Object.keys(patterns.buckets).length,
      });
    } else {
      log.warn('insufficient_historical_data', {
        symbol,
        updates_found: updates.length,
        min_required: config.minHistoricalUpdates,
      });
    }

    return patterns;
  } catch (err) {
    log.error('pattern_analysis_failed', { symbol, error: err.message });
    return null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {OraclePredictorError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.NOT_INITIALIZED,
      'Oracle predictor not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { OraclePredictorError, OraclePredictorErrorCodes };
