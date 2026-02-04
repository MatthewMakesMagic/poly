#!/usr/bin/env node
/**
 * Replay failed batch inserts
 *
 * Usage: npm run data:replay-batches
 *
 * Queries the failed_batches table for unprocessed rows,
 * re-inserts their data, and marks them as replayed.
 */

import dotenv from 'dotenv';
dotenv.config();

import persistence from '../src/persistence/index.js';
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
        queryTimeoutMs: 30000,
      },
    });

    // Get unprocessed failed batches
    const failedBatches = await persistence.all(
      `SELECT id, batch_data, error_message, retry_count
       FROM failed_batches
       WHERE replayed_at IS NULL
       ORDER BY created_at ASC`
    );

    console.log(`Found ${failedBatches.length} unprocessed failed batches`);

    let replayed = 0;
    let errors = 0;

    for (const batch of failedBatches) {
      try {
        const ticks = batch.batch_data;

        if (!Array.isArray(ticks) || ticks.length === 0) {
          console.log(`  Batch ${batch.id}: empty or invalid data, marking replayed`);
          await persistence.run(
            'UPDATE failed_batches SET replayed_at = NOW() WHERE id = $1',
            [batch.id]
          );
          continue;
        }

        // Re-insert ticks
        await persistence.transaction(async (client) => {
          for (const tick of ticks) {
            await client.run(
              `INSERT INTO rtds_ticks (timestamp, topic, symbol, price, raw_payload)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT DO NOTHING`,
              [tick.timestamp, tick.topic, tick.symbol, tick.price, tick.raw_payload]
            );
          }
        });

        // Mark as replayed
        await persistence.run(
          'UPDATE failed_batches SET replayed_at = NOW(), retry_count = retry_count + 1 WHERE id = $1',
          [batch.id]
        );

        console.log(`  Batch ${batch.id}: replayed ${ticks.length} ticks`);
        replayed++;
      } catch (err) {
        console.error(`  Batch ${batch.id}: replay failed - ${err.message}`);
        await persistence.run(
          'UPDATE failed_batches SET retry_count = retry_count + 1 WHERE id = $1',
          [batch.id]
        );
        errors++;
      }
    }

    // Cleanup old replayed batches
    const cleaned = await persistence.run(
      `DELETE FROM failed_batches WHERE replayed_at < NOW() - INTERVAL '7 days'`
    );

    console.log(`\nResults:`);
    console.log(`  Replayed: ${replayed}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Cleaned up: ${cleaned.changes} old batches`);

    await persistence.shutdown();
    process.exit(errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Batch replay failed:', err.message);
    process.exit(1);
  }
}

main();
