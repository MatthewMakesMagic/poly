/**
 * Partition Manager Module
 *
 * Manages PostgreSQL table partitions for high-volume data tables.
 * Creates future partitions ahead of time and drops old ones
 * based on configurable retention policy.
 *
 * V3 Philosophy Implementation - Phase 5: Data Capture Infrastructure
 *
 * Uses node-cron (not pg_cron) for reliability on Railway.
 * Schedule: startup + daily at 00:05 UTC.
 *
 * Public interface:
 * - init(config) - Initialize and optionally run partition management
 * - getState() - Get current state
 * - shutdown() - Stop cron and cleanup
 * - managePartitions() - Manually trigger partition management
 *
 * @module modules/partition-manager
 */

import cron from 'node-cron';
import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import {
  PartitionManagerError,
  PartitionManagerErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let cronTask = null;

// Statistics
let stats = {
  partitionsCreated: 0,
  partitionsDropped: 0,
  lastRunAt: null,
  lastRunDurationMs: null,
  errors: 0,
};

/**
 * Format a date as YYYYMMDD for partition naming
 *
 * @param {Date} date
 * @returns {string}
 */
function formatPartitionDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Format a date as YYYY-MM-DD for SQL range values
 *
 * @param {Date} date
 * @returns {string}
 */
function formatSQLDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Create a partition for a specific table and date
 *
 * @param {string} tableName - Parent table name
 * @param {Date} date - Date for the partition
 * @returns {Promise<boolean>} True if created, false if already existed
 */
async function createPartition(tableName, date) {
  const dateSuffix = formatPartitionDate(date);
  const partitionName = `${tableName}_${dateSuffix}`;
  const rangeStart = formatSQLDate(date);

  const nextDay = new Date(date);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const rangeEnd = formatSQLDate(nextDay);

  try {
    await persistence.exec(`
      CREATE TABLE IF NOT EXISTS ${partitionName}
      PARTITION OF ${tableName}
      FOR VALUES FROM ('${rangeStart}') TO ('${rangeEnd}');
    `);

    log.debug('partition_created', {
      table: tableName,
      partition: partitionName,
      range_start: rangeStart,
      range_end: rangeEnd,
    });

    return true;
  } catch (err) {
    // 42P07 = duplicate_table - partition already exists, that's fine
    if (err.code === '42P07') {
      return false;
    }
    log.error('partition_creation_failed', {
      table: tableName,
      partition: partitionName,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Drop a partition for a specific table and date
 *
 * @param {string} tableName - Parent table name
 * @param {Date} date - Date for the partition to drop
 * @returns {Promise<boolean>} True if dropped, false if didn't exist
 */
async function dropPartition(tableName, date) {
  const dateSuffix = formatPartitionDate(date);
  const partitionName = `${tableName}_${dateSuffix}`;

  try {
    // Check if partition exists before dropping
    const exists = await persistence.get(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [partitionName]
    );

    if (!exists) {
      return false;
    }

    await persistence.exec(`DROP TABLE IF EXISTS ${partitionName};`);

    log.info('partition_dropped', {
      table: tableName,
      partition: partitionName,
    });

    return true;
  } catch (err) {
    log.error('partition_drop_failed', {
      table: tableName,
      partition: partitionName,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Run partition management for all configured tables
 *
 * Creates future partitions and drops expired ones.
 *
 * @returns {Promise<Object>} Results { created, dropped, errors }
 */
export async function managePartitions() {
  if (!initialized) {
    throw new PartitionManagerError(
      PartitionManagerErrorCodes.NOT_INITIALIZED,
      'Partition manager not initialized'
    );
  }

  const startTime = Date.now();
  const results = { created: 0, dropped: 0, errors: 0 };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const tableName of config.partitionedTables) {
    // Create partitions for today + N days ahead
    for (let i = 0; i <= config.createAheadDays; i++) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() + i);

      try {
        const created = await createPartition(tableName, date);
        if (created) {
          results.created++;
          stats.partitionsCreated++;
        }
      } catch {
        results.errors++;
        stats.errors++;
      }
    }

    // Drop partitions older than retention period
    for (let i = config.retentionDays + 1; i <= config.retentionDays + 7; i++) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - i);

      try {
        const dropped = await dropPartition(tableName, date);
        if (dropped) {
          results.dropped++;
          stats.partitionsDropped++;
        }
      } catch {
        results.errors++;
        stats.errors++;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  stats.lastRunAt = new Date().toISOString();
  stats.lastRunDurationMs = durationMs;

  log.info('partition_management_complete', {
    created: results.created,
    dropped: results.dropped,
    errors: results.errors,
    duration_ms: durationMs,
  });

  return results;
}

/**
 * Initialize the partition manager module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.partitionManager] - Partition manager config
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'partition-manager' });
  log.info('module_init_start');

  const pmConfig = cfg.partitionManager || {};
  config = {
    createAheadDays: pmConfig.createAheadDays ?? DEFAULT_CONFIG.createAheadDays,
    retentionDays: pmConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    cronSchedule: pmConfig.cronSchedule ?? DEFAULT_CONFIG.cronSchedule,
    runOnStartup: pmConfig.runOnStartup ?? DEFAULT_CONFIG.runOnStartup,
    partitionedTables: pmConfig.partitionedTables ?? DEFAULT_CONFIG.partitionedTables,
  };

  initialized = true;

  // Run on startup if configured
  if (config.runOnStartup) {
    try {
      await managePartitions();
    } catch (err) {
      log.error('startup_partition_management_failed', {
        error: err.message,
      });
      // Don't fail init - partitions can be created later
    }
  }

  // Schedule cron job
  cronTask = cron.schedule(config.cronSchedule, async () => {
    try {
      await managePartitions();
    } catch (err) {
      log.error('cron_partition_management_failed', {
        error: err.message,
      });
    }
  }, {
    timezone: 'UTC',
  });

  log.info('partition_manager_initialized', {
    config: {
      createAheadDays: config.createAheadDays,
      retentionDays: config.retentionDays,
      cronSchedule: config.cronSchedule,
      tables: config.partitionedTables,
    },
  });
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
      stats: null,
      config: null,
    };
  }

  return {
    initialized: true,
    stats: { ...stats },
    config: { ...config },
    cronRunning: cronTask !== null,
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

  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    partitionsCreated: 0,
    partitionsDropped: 0,
    lastRunAt: null,
    lastRunDurationMs: null,
    errors: 0,
  };
}

export { PartitionManagerError, PartitionManagerErrorCodes };
