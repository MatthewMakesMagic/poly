/**
 * Oracle Pattern Tracker Module
 *
 * Tracks Chainlink oracle update patterns to learn:
 * - Average update frequency per symbol
 * - Deviation thresholds that trigger updates
 * - Update patterns by volatility level
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/oracle-tracker
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS, TOPICS } from '../../clients/rtds/types.js';
import { OraclePatternTracker } from './tracker.js';
import {
  OracleTrackerError,
  OracleTrackerErrorCodes,
  DEFAULT_CONFIG,
  VOLATILITY_BUCKETS,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let tracker = null;
let config = null;
let unsubscribers = [];
let flushIntervalId = null;

// Buffer for batch inserts
let updateBuffer = [];

// Statistics
let stats = {
  updatesDetected: 0,
  updatesInserted: 0,
  batchesInserted: 0,
  insertErrors: 0,
  lastFlushAt: null,
};

/**
 * Initialize the oracle tracker module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.oracleTracker] - Oracle tracker configuration
 * @param {number} [cfg.oracleTracker.bufferSize=10] - Flush after N records
 * @param {number} [cfg.oracleTracker.flushIntervalMs=1000] - Flush every N ms
 * @param {number} [cfg.oracleTracker.minDeviationForUpdate=0.0001] - Minimum deviation (0.01%)
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Defensive cleanup
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Create child logger
  log = child({ module: 'oracle-tracker' });
  log.info('module_init_start');

  // Extract oracle tracker config
  const oracleTrackerConfig = cfg.oracleTracker || {};
  config = {
    bufferSize: oracleTrackerConfig.bufferSize ?? DEFAULT_CONFIG.bufferSize,
    flushIntervalMs: oracleTrackerConfig.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs,
    minDeviationForUpdate: oracleTrackerConfig.minDeviationForUpdate ?? DEFAULT_CONFIG.minDeviationForUpdate,
    maxBufferSize: oracleTrackerConfig.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
  };

  // Create tracker instance
  tracker = new OraclePatternTracker({
    minDeviationForUpdate: config.minDeviationForUpdate,
    logger: log,
  });

  // Subscribe to RTDS client for all symbols, filter for oracle topic only
  for (const symbol of SUPPORTED_SYMBOLS) {
    const unsubscribe = rtdsClient.subscribe(symbol, (tick) => {
      // ONLY process oracle (Chainlink) ticks
      if (tick.topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
        handleOracleTick(tick);
      }
    });
    unsubscribers.push(unsubscribe);
  }

  // Setup flush interval
  // V3: flushBuffer is async, fire-and-forget with error logging
  if (config.flushIntervalMs > 0) {
    flushIntervalId = setInterval(() => {
      flushBuffer().catch(err => {
        log.error('interval_flush_failed', { error: err.message });
      });
    }, config.flushIntervalMs);

    // Allow process to exit even if interval is running
    if (flushIntervalId.unref) {
      flushIntervalId.unref();
    }
  }

  initialized = true;
  log.info('oracle_tracker_initialized', {
    config: {
      bufferSize: config.bufferSize,
      flushIntervalMs: config.flushIntervalMs,
      minDeviationForUpdate: config.minDeviationForUpdate,
    },
  });
}

/**
 * Handle incoming oracle tick
 *
 * V3: Calls async flushBuffer as fire-and-forget.
 *
 * @param {Object} tick - Normalized tick { timestamp, topic, symbol, price }
 */
function handleOracleTick(tick) {
  const updateRecord = tracker.handleOracleTick(tick);

  if (updateRecord) {
    stats.updatesDetected++;

    // Add to buffer
    if (updateBuffer.length >= config.maxBufferSize) {
      // Overflow - drop oldest
      updateBuffer.shift();
      log.warn('buffer_overflow', { buffer_size: config.maxBufferSize });
    }
    updateBuffer.push(updateRecord);

    log.debug('oracle_update_detected', {
      symbol: updateRecord.symbol,
      price: updateRecord.price,
      deviation_pct: updateRecord.deviation_from_previous_pct,
      time_since_previous_ms: updateRecord.time_since_previous_ms,
    });

    // V3: flushBuffer is async, fire-and-forget with error logging
    if (updateBuffer.length >= config.bufferSize) {
      flushBuffer().catch(err => {
        log.error('tick_triggered_flush_failed', { error: err.message });
      });
    }
  }
}

/**
 * Flush buffered update records to database
 *
 * V3 Philosophy: Uses async PostgreSQL transaction API.
 *
 * @returns {Promise<void>}
 */
async function flushBuffer() {
  if (updateBuffer.length === 0) {
    return;
  }

  // Copy records for insertion, but don't remove from buffer yet
  const records = [...updateBuffer];
  const startTime = Date.now();

  try {
    const insertSQL = `
      INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    // V3: Use async transaction with client object
    await persistence.transaction(async (client) => {
      for (const record of records) {
        await client.run(insertSQL, [
          record.timestamp,
          record.symbol,
          record.price,
          record.previous_price,
          record.deviation_from_previous_pct,
          record.time_since_previous_ms,
        ]);
      }
    });

    // Only remove from buffer AFTER successful insertion
    updateBuffer.splice(0, records.length);

    const durationMs = Date.now() - startTime;
    stats.updatesInserted += records.length;
    stats.batchesInserted++;
    stats.lastFlushAt = new Date().toISOString();

    log.debug('buffer_flushed', { record_count: records.length, duration_ms: durationMs });
  } catch (err) {
    stats.insertErrors++;
    log.error('persistence_failed', { error: err.message, record_count: records.length });
    // Records remain in buffer for retry on next flush cycle
  }
}

/**
 * Get pattern statistics for a symbol
 * Uses efficient database aggregation to avoid loading all rows into memory.
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @returns {Promise<Object>} Statistics object
 * @throws {OracleTrackerError} If not initialized or invalid symbol
 */
export async function getStats(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  try {
    // V3: Await async persistence.get()
    const aggResult = await persistence.get(
      `SELECT
        COUNT(*) as count,
        AVG(time_since_previous_ms) as avg_ms,
        AVG(ABS(deviation_from_previous_pct)) as mean_pct,
        MIN(ABS(deviation_from_previous_pct)) as min_pct,
        MAX(ABS(deviation_from_previous_pct)) as max_pct
      FROM oracle_updates WHERE symbol = $1`,
      [symbol]
    );

    const updateCount = aggResult?.count || 0;

    // Calculate deviation threshold using efficient method
    let deviationThreshold = null;
    if (updateCount > 0) {
      // V3: Await async persistence.get()
      const medianResult = await persistence.get(
        `SELECT ABS(deviation_from_previous_pct) as median_pct
         FROM oracle_updates
         WHERE symbol = $1
         ORDER BY ABS(deviation_from_previous_pct)
         LIMIT 1 OFFSET $2`,
        [symbol, Math.floor(updateCount / 2)]
      );

      deviationThreshold = {
        median_pct: medianResult?.median_pct ?? aggResult.mean_pct,
        mean_pct: aggResult.mean_pct,
        min_pct: aggResult.min_pct,
        max_pct: aggResult.max_pct,
        sample_size: updateCount,
      };
    }

    // V3: Await async getUpdatesByVolatility()
    const updatesByVolatility = await getUpdatesByVolatility(symbol);

    // Calculate frequency stats
    const avgMs = aggResult?.avg_ms || null;
    const updateFrequency = avgMs ? {
      avg_ms: avgMs,
      avg_seconds: avgMs / 1000,
      updates_per_minute: avgMs > 0 ? 60000 / avgMs : null,
    } : null;

    return {
      symbol,
      update_count: updateCount,
      avg_update_frequency: updateFrequency,
      deviation_threshold: deviationThreshold,
      update_frequency_by_volatility: updatesByVolatility,
    };
  } catch (err) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.PERSISTENCE_ERROR,
      `Failed to get stats for ${symbol}: ${err.message}`,
      { symbol, error: err.message }
    );
  }
}

/**
 * Get updates grouped by volatility bucket
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Promise<Object>} Volatility buckets with counts and avg intervals
 */
async function getUpdatesByVolatility(symbol) {
  // V3: Await async persistence.all()
  const updates = await persistence.all(
    'SELECT ABS(deviation_from_previous_pct) as abs_deviation, time_since_previous_ms FROM oracle_updates WHERE symbol = $1',
    [symbol]
  );

  const buckets = {
    small: { count: 0, total_interval_ms: 0, avg_interval_ms: 0 },
    medium: { count: 0, total_interval_ms: 0, avg_interval_ms: 0 },
    large: { count: 0, total_interval_ms: 0, avg_interval_ms: 0 },
    extreme: { count: 0, total_interval_ms: 0, avg_interval_ms: 0 },
  };

  for (const update of updates) {
    const absDeviation = update.abs_deviation;
    let bucketName = null;

    for (const [name, range] of Object.entries(VOLATILITY_BUCKETS)) {
      if (absDeviation >= range.min && absDeviation < range.max) {
        bucketName = name;
        break;
      }
    }

    if (bucketName) {
      buckets[bucketName].count++;
      buckets[bucketName].total_interval_ms += update.time_since_previous_ms || 0;
    }
  }

  // Calculate averages
  for (const bucket of Object.values(buckets)) {
    if (bucket.count > 0) {
      bucket.avg_interval_ms = bucket.total_interval_ms / bucket.count;
    }
    delete bucket.total_interval_ms; // Remove intermediate value
  }

  return buckets;
}

/**
 * Get average update frequency for a symbol
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Promise<Object|null>} Frequency stats or null if no data
 */
export async function getAverageUpdateFrequency(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // V3: Await async persistence.get()
  const result = await persistence.get(
    'SELECT AVG(time_since_previous_ms) as avg_ms FROM oracle_updates WHERE symbol = $1',
    [symbol]
  );

  if (!result || result.avg_ms === null) {
    return null;
  }

  // Handle zero avg_ms to avoid division by zero (Infinity)
  const updatesPerMinute = result.avg_ms > 0 ? 60000 / result.avg_ms : null;

  return {
    avg_ms: result.avg_ms,
    avg_seconds: result.avg_ms / 1000,
    updates_per_minute: updatesPerMinute,
  };
}

/**
 * Get deviation threshold statistics for a symbol
 * Uses database aggregation for efficiency with large datasets.
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Promise<Object|null>} Deviation stats or null if no data
 */
export async function getDeviationThreshold(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // V3: Await async persistence.get()
  const aggResult = await persistence.get(
    `SELECT
      COUNT(*) as sample_size,
      AVG(ABS(deviation_from_previous_pct)) as mean_pct,
      MIN(ABS(deviation_from_previous_pct)) as min_pct,
      MAX(ABS(deviation_from_previous_pct)) as max_pct
    FROM oracle_updates WHERE symbol = $1`,
    [symbol]
  );

  if (!aggResult || aggResult.sample_size === 0) {
    return null;
  }

  // V3: Await async persistence.get()
  const medianResult = await persistence.get(
    `SELECT ABS(deviation_from_previous_pct) as median_pct
     FROM oracle_updates
     WHERE symbol = $1
     ORDER BY ABS(deviation_from_previous_pct)
     LIMIT 1 OFFSET $2`,
    [symbol, Math.floor(aggResult.sample_size / 2)]
  );

  return {
    median_pct: medianResult?.median_pct ?? aggResult.mean_pct,
    mean_pct: aggResult.mean_pct,
    min_pct: aggResult.min_pct,
    max_pct: aggResult.max_pct,
    sample_size: aggResult.sample_size,
  };
}

/**
 * Get recent update records for a symbol
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @param {number} [limit=100] - Maximum records to return (1-10000)
 * @returns {Promise<Object[]>} Array of recent update records
 */
export async function getRecentUpdates(symbol, limit = 100) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // Validate and clamp limit to reasonable bounds
  const validatedLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 100)));

  // V3: Await async persistence.all()
  return persistence.all(
    'SELECT * FROM oracle_updates WHERE symbol = $1 ORDER BY timestamp DESC LIMIT $2',
    [symbol, validatedLimit]
  );
}

/**
 * Get current module state (synchronous, in-memory only)
 *
 * V3 Philosophy: getState() returns fast in-memory state only.
 * Use getStats(symbol) for database queries.
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized || !tracker) {
    return {
      initialized: false,
      tracking: {},
      buffer: { pending_records: 0 },
      config: null,
    };
  }

  // Get tracking state from tracker (in-memory)
  const trackingStates = tracker.getAllTrackingStates();

  // V3: Don't query database in getState() - use getStats(symbol) for DB queries
  return {
    initialized: true,
    tracking: trackingStates,
    buffer: {
      pending_records: updateBuffer.length,
    },
    module_stats: {
      updates_detected: stats.updatesDetected,
      updates_inserted: stats.updatesInserted,
      batches_inserted: stats.batchesInserted,
      insert_errors: stats.insertErrors,
      last_flush_at: stats.lastFlushAt,
    },
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully
 *
 * V3 Philosophy: Properly await async flushBuffer().
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Clear flush interval
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Unsubscribe from RTDS
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors
    }
  }
  unsubscribers = [];

  // V3: Await async flushBuffer()
  if (updateBuffer.length > 0) {
    await flushBuffer();
  }

  // Clear tracker
  if (tracker) {
    tracker = null;
  }

  updateBuffer = [];

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    updatesDetected: 0,
    updatesInserted: 0,
    batchesInserted: 0,
    insertErrors: 0,
    lastFlushAt: null,
  };
}

/**
 * Internal: Ensure module is initialized
 * @throws {OracleTrackerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new OracleTrackerError(
      OracleTrackerErrorCodes.NOT_INITIALIZED,
      'Oracle tracker not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { OracleTrackerError, OracleTrackerErrorCodes };
