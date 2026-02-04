/**
 * Partition Manager Types
 *
 * @module modules/partition-manager/types
 */

export class PartitionManagerError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'PartitionManagerError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export const PartitionManagerErrorCodes = {
  NOT_INITIALIZED: 'PARTITION_NOT_INITIALIZED',
  CREATION_FAILED: 'PARTITION_CREATION_FAILED',
  CLEANUP_FAILED: 'PARTITION_CLEANUP_FAILED',
};

export const DEFAULT_CONFIG = {
  /** Number of days ahead to create partitions */
  createAheadDays: 7,
  /** Number of days to retain before dropping partitions */
  retentionDays: 7,
  /** Cron schedule for partition management (daily at 00:05 UTC) */
  cronSchedule: '5 0 * * *',
  /** Run partition management on startup */
  runOnStartup: true,
  /** Tables to partition */
  partitionedTables: ['price_ticks'],
};
