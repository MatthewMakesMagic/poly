#!/usr/bin/env node
/**
 * FINDTHEGOLD Diagnostic Queries
 *
 * Runs the four core diagnostic queries (A-D) from docs/FINDTHEGOLD.md
 * against the database to validate data capture and analyze oracle patterns.
 *
 * Usage: node scripts/findthegold-diagnostics.js [query]
 *        query: a, b, c, d, or omit for all
 *
 * Requires DATABASE_URL environment variable.
 */

import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const QUERIES = {
  a: {
    title: 'Query A: Chainlink price change frequency (last 24h)',
    sql: `
      WITH chainlink_ticks AS (
        SELECT
          symbol,
          timestamp,
          price,
          LAG(price) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_price,
          LAG(timestamp) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_timestamp
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink'
          AND timestamp > NOW() - INTERVAL '24 hours'
      )
      SELECT
        symbol,
        COUNT(*) AS total_ticks,
        COUNT(*) FILTER (WHERE price != prev_price) AS price_changes,
        COUNT(*) FILTER (WHERE price = prev_price) AS identical_ticks,
        ROUND(100.0 * COUNT(*) FILTER (WHERE price = prev_price) / NULLIF(COUNT(*), 0), 2) AS pct_identical,
        ROUND(AVG(EXTRACT(EPOCH FROM (timestamp - prev_timestamp)))::numeric, 2) AS avg_tick_interval_sec
      FROM chainlink_ticks
      WHERE prev_price IS NOT NULL
      GROUP BY symbol
      ORDER BY symbol;
    `,
  },
  b: {
    title: 'Query B: Time between real price changes (last 7d)',
    sql: `
      WITH changes AS (
        SELECT
          symbol,
          timestamp,
          price,
          LAG(price) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_price,
          LAG(timestamp) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_ts
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink'
          AND timestamp > NOW() - INTERVAL '7 days'
      )
      SELECT
        symbol,
        COUNT(*) AS num_changes,
        ROUND(AVG(EXTRACT(EPOCH FROM (timestamp - prev_ts)))::numeric, 2) AS avg_sec_between_changes,
        ROUND(MIN(EXTRACT(EPOCH FROM (timestamp - prev_ts)))::numeric, 2) AS min_sec,
        ROUND(MAX(EXTRACT(EPOCH FROM (timestamp - prev_ts)))::numeric, 2) AS max_sec,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (timestamp - prev_ts)))::numeric, 2) AS median_sec,
        ROUND(AVG(ABS((price - prev_price) / NULLIF(prev_price, 0)) * 100)::numeric, 6) AS avg_change_pct
      FROM changes
      WHERE price != prev_price AND prev_price IS NOT NULL
      GROUP BY symbol;
    `,
  },
  c: {
    title: 'Query C: Binance vs Chainlink spread (last 24h, BTC)',
    sql: `
      WITH binance AS (
        SELECT symbol, timestamp, price AS binance_price
        FROM rtds_ticks
        WHERE topic = 'crypto_prices'
          AND timestamp > NOW() - INTERVAL '24 hours'
      ),
      chainlink AS (
        SELECT symbol, timestamp, price AS chainlink_price
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink'
          AND timestamp > NOW() - INTERVAL '24 hours'
      )
      SELECT
        b.symbol,
        DATE_TRUNC('minute', b.timestamp) AS minute,
        ROUND(AVG(b.binance_price)::numeric, 2) AS avg_binance,
        ROUND(AVG(c.chainlink_price)::numeric, 2) AS avg_chainlink,
        ROUND(AVG(b.binance_price - c.chainlink_price)::numeric, 2) AS avg_spread,
        ROUND(AVG(ABS(b.binance_price - c.chainlink_price) / NULLIF(c.chainlink_price, 0) * 100)::numeric, 6) AS avg_spread_pct
      FROM binance b
      JOIN chainlink c ON b.symbol = c.symbol
        AND DATE_TRUNC('second', b.timestamp) = DATE_TRUNC('second', c.timestamp)
      WHERE b.symbol = 'btc'
      GROUP BY b.symbol, DATE_TRUNC('minute', b.timestamp)
      ORDER BY minute DESC
      LIMIT 60;
    `,
  },
  d: {
    title: 'Query D: Oracle update frequency distribution (last 7d)',
    sql: `
      SELECT
        symbol,
        COUNT(*) AS total_updates,
        ROUND((AVG(time_since_previous_ms) / 1000)::numeric, 2) AS avg_sec_between,
        ROUND((MIN(time_since_previous_ms) / 1000)::numeric, 2) AS min_sec,
        ROUND((MAX(time_since_previous_ms) / 1000)::numeric, 2) AS max_sec,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_since_previous_ms) / 1000)::numeric, 2) AS median_sec,
        ROUND(AVG(ABS(deviation_from_previous_pct))::numeric, 6) AS avg_deviation_pct,
        ROUND(MAX(ABS(deviation_from_previous_pct))::numeric, 6) AS max_deviation_pct
      FROM oracle_updates
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY symbol
      ORDER BY symbol;
    `,
  },
};

// Also add data capture status queries
const DATA_STATUS = {
  title: 'Data Capture Status (counts in last hour)',
  sql: `
    SELECT 'rtds_ticks (all)' AS source, COUNT(*) AS count FROM rtds_ticks WHERE timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'rtds_ticks (pyth)' AS source, COUNT(*) AS count FROM rtds_ticks WHERE topic = 'crypto_prices_pyth' AND timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'clob_price_snapshots' AS source, COUNT(*) AS count FROM clob_price_snapshots WHERE timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'order_book_levels' AS source, COUNT(*) AS count FROM order_book_levels WHERE timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'exchange_ticks' AS source, COUNT(*) AS count FROM exchange_ticks WHERE timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'oracle_updates' AS source, COUNT(*) AS count FROM oracle_updates WHERE timestamp > NOW() - INTERVAL '1 hour'
    UNION ALL
    SELECT 'order_book_snapshots' AS source, COUNT(*) AS count FROM order_book_snapshots WHERE timestamp > NOW() - INTERVAL '1 hour';
  `,
};

function formatTable(rows) {
  if (!rows || rows.length === 0) {
    console.log('  (no data)\n');
    return;
  }

  const columns = Object.keys(rows[0]);
  const widths = columns.map(col => {
    const values = rows.map(r => String(r[col] ?? 'null'));
    return Math.max(col.length, ...values.map(v => v.length));
  });

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  // Rows
  for (const row of rows) {
    const line = columns.map((col, i) => String(row[col] ?? 'null').padEnd(widths[i])).join('  ');
    console.log(`  ${line}`);
  }
  console.log('');
}

async function runQuery(key, query) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${query.title}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    const result = await pool.query(query.sql);
    formatTable(result.rows);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    if (err.message.includes('does not exist')) {
      console.log('  (Table may not exist yet - run migrations first)\n');
    }
    console.log('');
  }
}

async function main() {
  const selectedQuery = process.argv[2]?.toLowerCase();

  console.log('\n');
  console.log('  FINDTHEGOLD Diagnostic Queries');
  console.log('  ' + '='.repeat(40));
  console.log(`  Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@').substring(0, 60)}...`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);

  // Always show data capture status first
  await runQuery('status', DATA_STATUS);

  if (selectedQuery) {
    if (QUERIES[selectedQuery]) {
      await runQuery(selectedQuery, QUERIES[selectedQuery]);
    } else {
      console.error(`\n  Unknown query: ${selectedQuery}. Available: a, b, c, d`);
    }
  } else {
    // Run all queries
    for (const [key, query] of Object.entries(QUERIES)) {
      await runQuery(key, query);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
}).finally(() => {
  pool.end().catch(() => {});
});
