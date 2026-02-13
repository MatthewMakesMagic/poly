/**
 * Backfill Pyth Oracle Data for ETH/SOL/XRP Windows
 *
 * The window_close_events table has 226 ETH, SOL, XRP windows
 * with strike prices and CLOB data but no oracle/resolution data.
 * Pyth ticks exist for all instruments. This script backfills:
 *   - oracle_price_* (60s, 30s, 10s, 5s, 1s, at_close)
 *   - pyth_price_at_close
 *   - resolved_direction (pyth vs strike)
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/backfill-pyth-oracle.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

// Use a dedicated client so SET persists across queries (PgBouncer transaction pooling)
let writeClient = null;
async function getWriteClient() {
  if (!writeClient) {
    writeClient = await pool.connect();
    await writeClient.query('SET default_transaction_read_only = off');
  }
  return writeClient;
}

async function writeQuery(text, params) {
  const client = await getWriteClient();
  return client.query(text, params);
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  BACKFILL PYTH ORACLE DATA                               ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Get all windows that need backfill (have strike but no oracle)
  const windows = await pool.query(`
    SELECT id, window_id, symbol, window_close_time, strike_price,
           oracle_price_at_close, pyth_price_at_close, resolved_direction
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND strike_price > 0
      AND oracle_price_at_close IS NULL
    ORDER BY window_close_time ASC
  `);

  console.log(`  Windows to backfill: ${windows.rows.length}\n`);

  // Also backfill BTC windows that have CL but no Pyth
  const btcWindows = await pool.query(`
    SELECT id, window_id, symbol, window_close_time, strike_price,
           oracle_price_at_close, pyth_price_at_close, chainlink_price_at_close
    FROM window_close_events
    WHERE symbol = 'btc' AND pyth_price_at_close IS NULL
    ORDER BY window_close_time ASC
  `);

  console.log(`  BTC windows needing Pyth backfill: ${btcWindows.rows.length}\n`);

  const offsets = [
    { ms: 60000, col: 'oracle_price_60s_before' },
    { ms: 30000, col: 'oracle_price_30s_before' },
    { ms: 10000, col: 'oracle_price_10s_before' },
    { ms: 5000,  col: 'oracle_price_5s_before' },
    { ms: 1000,  col: 'oracle_price_1s_before' },
  ];

  let updated = 0;
  let failed = 0;

  // Map RTDS symbol names to window_close_events symbols
  const symbolMap = {
    'btc': 'btc',
    'eth': 'eth',
    'sol': 'sol',
    'xrp': 'xrp',
  };

  for (const win of windows.rows) {
    const closeTimeMs = new Date(win.window_close_time).getTime();
    const strike = parseFloat(win.strike_price);
    const rtdsSymbol = symbolMap[win.symbol];

    if (!rtdsSymbol) {
      console.log(`  Skipping unknown symbol: ${win.symbol}`);
      failed++;
      continue;
    }

    // Get Pyth price at close (nearest tick within 2s)
    const atClose = await pool.query(`
      SELECT price, timestamp FROM rtds_ticks
      WHERE topic = 'crypto_prices_pyth' AND symbol = $1
        AND timestamp >= $2::timestamptz - interval '2 seconds'
        AND timestamp <= $2::timestamptz + interval '2 seconds'
      ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $2::timestamptz))) ASC
      LIMIT 1
    `, [rtdsSymbol, win.window_close_time]);

    if (atClose.rows.length === 0) {
      failed++;
      continue;
    }

    const pythAtClose = parseFloat(atClose.rows[0].price);
    const resolved = pythAtClose > strike ? 'UP' : 'DOWN';

    // Get oracle prices at each offset
    const oraclePrices = {};
    for (const offset of offsets) {
      const targetTime = new Date(closeTimeMs - offset.ms);
      const tick = await pool.query(`
        SELECT price FROM rtds_ticks
        WHERE topic = 'crypto_prices_pyth' AND symbol = $1
          AND timestamp >= $2::timestamptz - interval '2 seconds'
          AND timestamp <= $2::timestamptz + interval '2 seconds'
        ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $2::timestamptz))) ASC
        LIMIT 1
      `, [rtdsSymbol, targetTime]);

      if (tick.rows.length > 0) {
        oraclePrices[offset.col] = parseFloat(tick.rows[0].price);
      }
    }

    // Update the window (use write client to bypass read-only)
    await writeQuery(`
      UPDATE window_close_events SET
        oracle_price_60s_before = COALESCE($2, oracle_price_60s_before),
        oracle_price_30s_before = COALESCE($3, oracle_price_30s_before),
        oracle_price_10s_before = COALESCE($4, oracle_price_10s_before),
        oracle_price_5s_before = COALESCE($5, oracle_price_5s_before),
        oracle_price_1s_before = COALESCE($6, oracle_price_1s_before),
        oracle_price_at_close = COALESCE($7, oracle_price_at_close),
        pyth_price_at_close = $8,
        resolved_direction = COALESCE($9, resolved_direction),
        updated_at = NOW()
      WHERE id = $1
    `, [
      win.id,
      oraclePrices['oracle_price_60s_before'] ?? null,
      oraclePrices['oracle_price_30s_before'] ?? null,
      oraclePrices['oracle_price_10s_before'] ?? null,
      oraclePrices['oracle_price_5s_before'] ?? null,
      oraclePrices['oracle_price_1s_before'] ?? null,
      pythAtClose,
      pythAtClose,
      resolved,
    ]);

    updated++;
    if (updated % 30 === 0) process.stdout.write(`  Updated ${updated}/${windows.rows.length}...\r`);
  }

  console.log(`  Updated ${updated} windows (${failed} failed — no Pyth data)                 \n`);

  // Also backfill Pyth for BTC windows (just pyth_price_at_close, don't overwrite oracle)
  let btcUpdated = 0;
  for (const win of btcWindows.rows) {
    const rtdsSymbol = 'btc';
    const atClose = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_pyth' AND symbol = $1
        AND timestamp >= $2::timestamptz - interval '2 seconds'
        AND timestamp <= $2::timestamptz + interval '2 seconds'
      ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $2::timestamptz))) ASC
      LIMIT 1
    `, [rtdsSymbol, win.window_close_time]);

    if (atClose.rows.length > 0) {
      await writeQuery(`
        UPDATE window_close_events SET pyth_price_at_close = $2, updated_at = NOW()
        WHERE id = $1
      `, [win.id, parseFloat(atClose.rows[0].price)]);
      btcUpdated++;
    }
  }

  console.log(`  BTC Pyth backfill: ${btcUpdated} updated\n`);

  // Verify
  const verify = await pool.query(`
    SELECT symbol, COUNT(*) as total,
           SUM(CASE WHEN oracle_price_at_close IS NOT NULL THEN 1 ELSE 0 END) as has_oracle,
           SUM(CASE WHEN pyth_price_at_close IS NOT NULL THEN 1 ELSE 0 END) as has_pyth,
           SUM(CASE WHEN resolved_direction IS NOT NULL THEN 1 ELSE 0 END) as has_resolution,
           SUM(CASE WHEN resolved_direction = 'DOWN' THEN 1 ELSE 0 END) as down_cnt,
           SUM(CASE WHEN resolved_direction = 'UP' THEN 1 ELSE 0 END) as up_cnt
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND strike_price > 0
    GROUP BY symbol ORDER BY symbol
  `);

  console.log('  ── Post-Backfill Status ──');
  console.log('  Symbol │ Total │ Oracle │ Pyth │ Resolved │ DOWN │ UP │ DOWN%');
  console.log('  ────────────────────────────────────────────────────────────────');
  for (const r of verify.rows) {
    const downPct = r.has_resolution > 0 ? (r.down_cnt / r.has_resolution * 100).toFixed(1) : '-';
    console.log(`  ${r.symbol.padEnd(6)} │ ${String(r.total).padStart(5)} │ ${String(r.has_oracle).padStart(6)} │ ${String(r.has_pyth).padStart(4)} │ ${String(r.has_resolution).padStart(8)} │ ${String(r.down_cnt).padStart(4)} │ ${String(r.up_cnt).padStart(2)} │ ${downPct}%`);
  }
  console.log();

  if (writeClient) writeClient.release();
  await pool.end();
}

main().catch(err => { console.error('Backfill failed:', err); if (writeClient) writeClient.release(); pool.end(); process.exit(1); });
