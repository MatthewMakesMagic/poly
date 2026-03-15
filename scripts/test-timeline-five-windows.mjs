#!/usr/bin/env node
/**
 * Test: Build 5 BTC timeline windows using the actual timeline-builder pipeline.
 * Verifies ALL data sources are present in each.
 */

import pg from 'pg';
import config from '../config/index.js';
import persistence from '../src/persistence/index.js';
import { buildSingleWindow } from '../src/factory/timeline-builder.js';
import { ensurePgTimelineTable, insertPgTimelineIfNotExists } from '../src/factory/pg-timeline-store.js';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  // Initialize persistence with a longer timeout for safety
  const modifiedConfig = {
    ...config,
    database: {
      ...config.database,
      queryTimeoutMs: 30000, // 30s instead of 10s
    },
  };
  await persistence.init(modifiedConfig);
  await ensurePgTimelineTable();

  // Use raw client to find uncached windows
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  });
  await client.connect();

  // Find 5 uncached windows after Feb 25
  const winResult = await client.query(`
    SELECT w.window_close_time, w.symbol, w.strike_price,
           w.chainlink_price_at_close, w.oracle_price_at_open,
           w.resolved_direction, w.onchain_resolved_direction
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.window_close_time > '2026-02-25'
      AND NOT EXISTS (SELECT 1 FROM pg_timelines p WHERE p.window_id = 'btc-' || w.window_close_time::text)
    ORDER BY w.window_close_time
    LIMIT 5
  `);
  await client.end();

  console.log(`Found ${winResult.rows.length} uncached windows to build\n`);

  const results = [];

  for (const win of winResult.rows) {
    const t = Date.now();
    try {
      const row = await buildSingleWindow('btc', win);
      if (!row) {
        console.log(`  SKIP (no ground truth): ${win.window_close_time}`);
        continue;
      }

      // Parse quality
      const q = typeof row.data_quality === 'string' ? JSON.parse(row.data_quality) : row.data_quality;

      // Write to pg_timelines
      await insertPgTimelineIfNotExists(row);

      const elapsed = Date.now() - t;
      const allPresent = q.rtds_count > 0 && q.clob_count > 0 && q.exchange_count > 0 && q.l2_count > 0 && q.coingecko_count > 0;

      console.log(`  ${row.window_id}: ${row.event_count} events | rtds:${q.rtds_count} clob:${q.clob_count} exch:${q.exchange_count} l2:${q.l2_count} cg:${q.coingecko_count} | ${elapsed}ms | ${allPresent ? 'ALL SOURCES' : 'MISSING SOURCES'}`);

      results.push({ windowId: row.window_id, quality: q, allPresent, elapsed });
    } catch (err) {
      console.error(`  ERROR ${win.window_close_time}: ${err.message}`);
    }
  }

  console.log('\n=== Summary ===');
  const allGood = results.every(r => r.allPresent);
  console.log(`  Built: ${results.length} windows`);
  console.log(`  All sources present in all: ${allGood ? 'YES' : 'NO'}`);

  if (!allGood) {
    for (const r of results) {
      if (!r.allPresent) {
        console.log(`  MISSING in ${r.windowId}: rtds=${r.quality.rtds_count} clob=${r.quality.clob_count} exch=${r.quality.exchange_count} l2=${r.quality.l2_count} cg=${r.quality.coingecko_count}`);
      }
    }
  }

  await persistence.shutdown();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
