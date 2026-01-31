#!/usr/bin/env node
/**
 * Disable all live strategies except ExecutionTest
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  try {
    // Disable all strategies
    const disableResult = await pool.query(`
      UPDATE live_strategies SET enabled = false, disabled_at = NOW()
    `);
    console.log(`Disabled ${disableResult.rowCount} strategies`);

    // Enable only ExecutionTest (if it exists, otherwise insert)
    await pool.query(`
      INSERT INTO live_strategies (strategy_name, enabled, enabled_at)
      VALUES ('ExecutionTest', true, NOW())
      ON CONFLICT (strategy_name)
      DO UPDATE SET enabled = true, enabled_at = NOW()
    `);
    console.log('Enabled ExecutionTest strategy');

    // Show current state
    const result = await pool.query(`
      SELECT strategy_name, enabled FROM live_strategies WHERE enabled = true
    `);
    console.log('\nCurrently enabled strategies:');
    for (const row of result.rows) {
      console.log(`  ✓ ${row.strategy_name}`);
    }
    if (result.rows.length === 0) {
      console.log('  (none)');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
