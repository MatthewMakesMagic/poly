/**
 * Tick Logger Module
 *
 * Logs every tick from RTDS feeds to the database for offline analysis.
 * Implements batching for performance and configurable retention cleanup.
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/tick-logger
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';
import * as spotClient from '../../clients/spot/index.js';
import { SUPPORTED_CRYPTOS } from '../../clients/spot/types.js';
import { TickBuffer } from './buffer.js';
import { TickLoggerError, TickLoggerErrorCodes, DEFAULT_CONFIG, MS_PER_HOUR, MAX_STRING_LENGTH } from './types.js';

// Module state
let log = null;
let initialized = false;
let buffer = null;
let config = null;
let unsubscribers = [];
let cleanupIntervalId = null;

// Statistics
let stats = {
  ticksReceived: 0,
  ticksInserted: 0,
  batchesInserted: 0,
  ticksDropped: 0,
  lastFlushAt: null,
  lastCleanupAt: null,
  insertErrors: 0,
};

/**
 * Initialize the tick logger module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.tickLogger] - Tick logger configuration
 * @param {number} [cfg.tickLogger.batchSize=50] - Flush after N ticks
 * @param {number} [cfg.tickLogger.flushIntervalMs=100] - Flush every N ms
 * @param {number} [cfg.tickLogger.retentionDays=7] - Keep ticks for N days
 * @param {boolean} [cfg.tickLogger.cleanupOnInit=true] - Run cleanup on init
 * @param {number} [cfg.tickLogger.cleanupIntervalHours=6] - Run cleanup every N hours (0 to disable)
 * @param {number} [cfg.tickLogger.maxBufferSize=1000] - Max buffer before overflow
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'tick-logger' });
  log.info('module_init_start');

  // Extract tick logger config
  const tickLoggerConfig = cfg.tickLogger || {};
  config = {
    batchSize: tickLoggerConfig.batchSize ?? DEFAULT_CONFIG.batchSize,
    flushIntervalMs: tickLoggerConfig.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs,
    retentionDays: tickLoggerConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    cleanupOnInit: tickLoggerConfig.cleanupOnInit ?? DEFAULT_CONFIG.cleanupOnInit,
    cleanupIntervalHours: tickLoggerConfig.cleanupIntervalHours ?? DEFAULT_CONFIG.cleanupIntervalHours,
    maxBufferSize: tickLoggerConfig.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
  };

  // Create buffer
  buffer = new TickBuffer({
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxBufferSize: config.maxBufferSize,
    onFlush: batchInsert,
    onOverflow: handleOverflow,
  });

  // Subscribe to RTDS client for all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    const unsubscribe = rtdsClient.subscribe(symbol, (tick) => {
      handleTick(tick);
    });
    unsubscribers.push(unsubscribe);
  }

  // Subscribe to spot client for Pyth prices
  for (const crypto of SUPPORTED_CRYPTOS) {
    try {
      const unsubscribe = spotClient.subscribe(crypto, (price) => {
        handleTick({
          timestamp: price.timestamp,
          topic: 'crypto_prices_pyth',
          symbol: crypto,
          price: price.price,
          received_at: Date.now(),
        });
      });
      unsubscribers.push(unsubscribe);
    } catch (err) {
      // Spot client may not be initialized yet - log and continue
      log.warn('pyth_subscription_failed', { crypto, error: err.message });
    }
  }

  // Run initial cleanup if configured
  if (config.cleanupOnInit) {
    try {
      await cleanupOldTicks(config.retentionDays);
    } catch (err) {
      log.warn('cleanup_on_init_failed', { error: err.message });
    }
  }

  // Setup periodic cleanup if configured
  if (config.cleanupIntervalHours > 0) {
    const intervalMs = config.cleanupIntervalHours * MS_PER_HOUR;
    cleanupIntervalId = setInterval(async () => {
      try {
        await cleanupOldTicks(config.retentionDays);
      } catch (err) {
        log.warn('periodic_cleanup_failed', { error: err.message });
      }
    }, intervalMs);
    // Allow process to exit even if interval is running
    if (cleanupIntervalId.unref) {
      cleanupIntervalId.unref();
    }
  }

  initialized = true;
  log.info('tick_logger_initialized', { config });
}

/**
 * Validate tick data
 * @param {Object} tick - Tick to validate
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateTick(tick) {
  if (!tick) {
    return { valid: false, reason: 'tick_null' };
  }

  // Price must be a finite number
  if (typeof tick.price !== 'number' || !Number.isFinite(tick.price)) {
    return { valid: false, reason: 'invalid_price' };
  }

  // Symbol and topic must be non-empty strings
  if (typeof tick.symbol !== 'string' || tick.symbol.length === 0) {
    return { valid: false, reason: 'invalid_symbol' };
  }
  if (typeof tick.topic !== 'string' || tick.topic.length === 0) {
    return { valid: false, reason: 'invalid_topic' };
  }

  // Enforce max string lengths to prevent storage abuse
  if (tick.symbol.length > MAX_STRING_LENGTH || tick.topic.length > MAX_STRING_LENGTH) {
    return { valid: false, reason: 'string_too_long' };
  }

  return { valid: true };
}

/**
 * Handle incoming tick from RTDS
 * @param {Object} tick - Normalized tick { timestamp, topic, symbol, price }
 */
function handleTick(tick) {
  stats.ticksReceived++;

  // Validate tick structure
  const validation = validateTick(tick);
  if (!validation.valid) {
    log.warn('invalid_tick_received', {
      reason: validation.reason,
      symbol: tick?.symbol,
      topic: tick?.topic,
      price: tick?.price,
    });
    return;
  }

  // Parse timestamp with fallback to current time
  let timestamp;
  try {
    const parsedDate = new Date(tick.timestamp);
    if (Number.isNaN(parsedDate.getTime())) {
      timestamp = new Date().toISOString();
    } else {
      timestamp = parsedDate.toISOString();
    }
  } catch {
    timestamp = new Date().toISOString();
  }

  // Format tick for database
  const dbTick = {
    timestamp,
    topic: tick.topic,
    symbol: tick.symbol,
    price: tick.price,
    raw_payload: JSON.stringify(tick),
    received_at: tick.received_at ? new Date(tick.received_at).toISOString() : null,
  };

  buffer.add(dbTick);
}

/**
 * Handle buffer overflow
 * @param {Object} info - Overflow info { dropped, bufferSize }
 */
function handleOverflow(info) {
  stats.ticksDropped += info.dropped;
  log.warn('buffer_overflow', { dropped: info.dropped, buffer_size: info.bufferSize });
}

// Dead-letter queue for failed inserts (retry once on next flush)
let deadLetterQueue = [];

/**
 * Batch insert ticks to database
 *
 * V3 Philosophy: Uses async PostgreSQL transaction API.
 * Called by buffer.flush() as fire-and-forget (Promise not awaited).
 *
 * @param {Object[]} ticks - Array of ticks to insert
 * @returns {Promise<void>}
 */
async function batchInsert(ticks) {
  if (ticks.length === 0) {
    return;
  }

  // Prepend any ticks from dead-letter queue (retry failed inserts once)
  const retryTicks = deadLetterQueue.splice(0, deadLetterQueue.length);
  const allTicks = retryTicks.concat(ticks);

  const startTime = Date.now();

  try {
    const insertSQL = `
      INSERT INTO rtds_ticks (timestamp, topic, symbol, price, raw_payload, received_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    // V3: Use async transaction with client object
    await persistence.transaction(async (client) => {
      for (const tick of allTicks) {
        await client.run(insertSQL, [
          tick.timestamp,
          tick.topic,
          tick.symbol,
          tick.price,
          tick.raw_payload,
          tick.received_at,
        ]);
      }
    });

    const durationMs = Date.now() - startTime;
    stats.ticksInserted += allTicks.length;
    stats.batchesInserted++;
    stats.lastFlushAt = new Date().toISOString();

    log.info('batch_inserted', { tick_count: allTicks.length, duration_ms: durationMs, retried: retryTicks.length });
  } catch (err) {
    stats.insertErrors++;
    log.error('insert_failed', { error: err.message, tick_count: allTicks.length });

    // Queue new ticks for retry (but don't re-retry ticks that already failed once)
    // This prevents infinite retry loops while giving ticks one more chance
    if (ticks.length > 0 && deadLetterQueue.length < config.maxBufferSize) {
      const spaceAvailable = config.maxBufferSize - deadLetterQueue.length;
      const ticksToRetry = ticks.slice(0, spaceAvailable);
      deadLetterQueue.push(...ticksToRetry);
      log.warn('ticks_queued_for_retry', { count: ticksToRetry.length, dropped: ticks.length - ticksToRetry.length });
    }
  }
}

/**
 * Manual tick insertion (for testing)
 * @param {Object} tick - Tick to log { timestamp, topic, symbol, price, raw_payload? }
 */
export function logTick(tick) {
  ensureInitialized();

  // Increment stats for manual inserts too
  stats.ticksReceived++;

  // Validate tick
  const validation = validateTick(tick);
  if (!validation.valid) {
    log.warn('invalid_tick_logged', {
      reason: validation.reason,
      symbol: tick?.symbol,
      topic: tick?.topic,
      price: tick?.price,
    });
    return;
  }

  // Parse timestamp with fallback to current time
  let timestamp;
  try {
    const parsedDate = new Date(tick.timestamp);
    if (Number.isNaN(parsedDate.getTime())) {
      timestamp = new Date().toISOString();
    } else {
      timestamp = parsedDate.toISOString();
    }
  } catch {
    timestamp = new Date().toISOString();
  }

  // Format tick for database
  const dbTick = {
    timestamp,
    topic: tick.topic,
    symbol: tick.symbol,
    price: tick.price,
    raw_payload: tick.raw_payload || JSON.stringify(tick),
    received_at: tick.received_at ? new Date(tick.received_at).toISOString() : null,
  };

  buffer.add(dbTick);
}

/**
 * Force buffer flush
 * @returns {Promise<void>}
 */
export async function flush() {
  ensureInitialized();
  buffer.flush();
}

/**
 * Cleanup old ticks based on retention policy
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 *
 * @param {number} [retentionDays] - Days to retain (uses config if not specified)
 * @returns {Promise<number>} Number of rows deleted
 */
export async function cleanupOldTicks(retentionDays) {
  // Note: This can be called before init() for standalone cleanup operations
  // It uses persistence module directly which has its own init check
  const days = retentionDays ?? config?.retentionDays ?? DEFAULT_CONFIG.retentionDays;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffISO = cutoffDate.toISOString();

  try {
    // V3: Await async persistence.run()
    const result = await persistence.run(
      'DELETE FROM rtds_ticks WHERE timestamp < $1',
      [cutoffISO]
    );

    stats.lastCleanupAt = new Date().toISOString();

    if (log) {
      log.info('cleanup_complete', {
        deleted_rows: result.changes,
        cutoff_date: cutoffISO,
        retention_days: days,
      });
    }

    return result.changes;
  } catch (err) {
    if (log) {
      log.error('cleanup_failed', { error: err.message, cutoff_date: cutoffISO });
    }
    throw new TickLoggerError(
      TickLoggerErrorCodes.CLEANUP_FAILED,
      `Failed to cleanup old ticks: ${err.message}`,
      { cutoffDate: cutoffISO, retentionDays: days }
    );
  }
}

/**
 * Get current module state
 * @returns {Object} Module state
 */
export function getState() {
  if (!initialized) {
    return {
      initialized: false,
      buffer: { size: 0, oldest_tick_age_ms: 0 },
      stats: {
        ticks_received: 0,
        ticks_inserted: 0,
        batches_inserted: 0,
        ticks_dropped: 0,
        last_flush_at: null,
        last_cleanup_at: null,
      },
      config: null,
    };
  }

  const bufferState = buffer.getState();

  return {
    initialized: true,
    buffer: {
      size: bufferState.size,
      oldest_tick_age_ms: bufferState.oldestTickAgeMs,
      dead_letter_queue_size: deadLetterQueue.length,
    },
    stats: {
      ticks_received: stats.ticksReceived,
      ticks_inserted: stats.ticksInserted,
      batches_inserted: stats.batchesInserted,
      ticks_dropped: stats.ticksDropped,
      insert_errors: stats.insertErrors,
      last_flush_at: stats.lastFlushAt,
      last_cleanup_at: stats.lastCleanupAt,
    },
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Clear cleanup interval
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
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

  // Flush remaining ticks
  if (buffer) {
    buffer.flush();
    buffer = null;
  }

  // Clear dead-letter queue
  deadLetterQueue = [];

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    ticksReceived: 0,
    ticksInserted: 0,
    batchesInserted: 0,
    ticksDropped: 0,
    lastFlushAt: null,
    lastCleanupAt: null,
    insertErrors: 0,
  };
}

/**
 * Internal: Ensure module is initialized
 * @throws {TickLoggerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new TickLoggerError(
      TickLoggerErrorCodes.NOT_INITIALIZED,
      'Tick logger not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { TickLoggerError, TickLoggerErrorCodes };
