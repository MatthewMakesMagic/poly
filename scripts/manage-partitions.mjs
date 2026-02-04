#!/usr/bin/env node
/**
 * Manual partition management script
 *
 * Usage: npm run db:manage-partitions
 *
 * Creates future partitions and drops expired ones for all
 * configured partitioned tables.
 */

import dotenv from 'dotenv';
dotenv.config();

import persistence from '../src/persistence/index.js';
import * as partitionManager from '../src/modules/partition-manager/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';

async function main() {
  try {
    // Initialize logger
    initLogger({ level: 'info' });

    // Initialize persistence
    await persistence.init({
      database: {
        url: process.env.DATABASE_URL,
        pool: { min: 1, max: 3 },
        queryTimeoutMs: 10000,
      },
    });

    // Initialize and run partition manager
    await partitionManager.init({
      partitionManager: {
        runOnStartup: false, // We'll run manually below
      },
    });

    console.log('Running partition management...');
    const results = await partitionManager.managePartitions();

    console.log(`\nResults:`);
    console.log(`  Partitions created: ${results.created}`);
    console.log(`  Partitions dropped: ${results.dropped}`);
    console.log(`  Errors: ${results.errors}`);

    await partitionManager.shutdown();
    await persistence.shutdown();

    process.exit(results.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Partition management failed:', err.message);
    process.exit(1);
  }
}

main();
