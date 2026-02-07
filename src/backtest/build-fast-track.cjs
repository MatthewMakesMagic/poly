/**
 * Build Fast-Track Backtest Table
 *
 * Creates and populates `window_backtest_states` — a pre-computed table
 * of market state snapshots at 10s intervals for each window.
 *
 * This enables ~1s backtests instead of 30s+ per run.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/build-fast-track.cjs
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Run: export $(grep DATABASE_URL .env.local | xargs)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function exec(sql, params = []) {
  await pool.query(sql, params);
}

// ─── Schema ───

async function createTable() {
  await exec(`
    CREATE TABLE IF NOT EXISTS window_backtest_states (
      id SERIAL PRIMARY KEY,
      window_close_time TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      offset_ms INTEGER NOT NULL,          -- ms before window close (300000 = 5min, 0 = at close)

      -- Oracle tier
      strike_price NUMERIC,
      chainlink_price NUMERIC,
      chainlink_ts TIMESTAMPTZ,

      -- Reference tier
      polyref_price NUMERIC,
      polyref_ts TIMESTAMPTZ,

      -- CLOB tier
      clob_down_bid NUMERIC,
      clob_down_ask NUMERIC,
      clob_down_mid NUMERIC,
      clob_down_spread NUMERIC,
      clob_down_ts TIMESTAMPTZ,

      clob_up_bid NUMERIC,
      clob_up_ask NUMERIC,
      clob_up_mid NUMERIC,
      clob_up_spread NUMERIC,
      clob_up_ts TIMESTAMPTZ,

      -- Exchange tier (top 5)
      exchange_binance NUMERIC,
      exchange_coinbase NUMERIC,
      exchange_kraken NUMERIC,
      exchange_bybit NUMERIC,
      exchange_okx NUMERIC,

      -- Resolution (denormalized for fast access)
      resolved_direction VARCHAR(4),
      chainlink_at_close NUMERIC,

      created_at TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE(window_close_time, symbol, offset_ms)
    )
  `);

  // Index for fast backtest queries
  await exec(`
    CREATE INDEX IF NOT EXISTS idx_wbs_window_offset
    ON window_backtest_states(window_close_time, offset_ms)
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_wbs_symbol_window
    ON window_backtest_states(symbol, window_close_time, offset_ms)
  `);

  console.log('  Table window_backtest_states created/verified');
}

// ─── State Queries ───

async function getChainlinkAt(timestamp) {
  return queryOne(`
    SELECT price, timestamp FROM rtds_ticks
    WHERE topic = 'crypto_prices_chainlink' AND timestamp <= $1
    ORDER BY timestamp DESC LIMIT 1
  `, [timestamp]);
}

async function getPolyRefAt(timestamp) {
  return queryOne(`
    SELECT price, timestamp FROM rtds_ticks
    WHERE topic = 'crypto_prices' AND timestamp <= $1
    ORDER BY timestamp DESC LIMIT 1
  `, [timestamp]);
}

async function getClobAt(symbol, timestamp) {
  return queryOne(`
    SELECT best_bid, best_ask, mid_price, spread, timestamp
    FROM clob_price_snapshots
    WHERE symbol = $1 AND timestamp <= $2
    ORDER BY timestamp DESC LIMIT 1
  `, [symbol, timestamp]);
}

async function getExchangeAt(exchange, timestamp) {
  return queryOne(`
    SELECT price FROM exchange_ticks
    WHERE exchange = $1 AND timestamp <= $2
    ORDER BY timestamp DESC LIMIT 1
  `, [exchange, timestamp]);
}

// ─── Population ───

async function populateWindow(win, sampleIntervalMs = 10000) {
  const closeMs = new Date(win.window_close_time).getTime();
  const windowDurationMs = 300000; // 5 min
  const strike = parseFloat(win.strike_price);
  const symbol = win.symbol;

  // Generate offsets: 300000, 290000, ..., 10000, 0
  const offsets = [];
  for (let offset = windowDurationMs; offset >= 0; offset -= sampleIntervalMs) {
    offsets.push(offset);
  }

  const rows = [];

  for (const offset of offsets) {
    const sampleTime = new Date(closeMs - offset).toISOString();

    // Parallel fetch all state at this point
    const [chainlink, polyRef, clobDown, clobUp, binance, coinbase, kraken, bybit, okx] =
      await Promise.all([
        getChainlinkAt(sampleTime),
        getPolyRefAt(sampleTime),
        getClobAt(`${symbol}-down`, sampleTime),
        getClobAt(`${symbol}-up`, sampleTime),
        getExchangeAt('binance', sampleTime),
        getExchangeAt('coinbaseexchange', sampleTime),
        getExchangeAt('kraken', sampleTime),
        getExchangeAt('bybit', sampleTime),
        getExchangeAt('okx', sampleTime),
      ]);

    rows.push({
      window_close_time: win.window_close_time,
      symbol,
      offset_ms: offset,
      strike_price: strike,
      chainlink_price: chainlink ? parseFloat(chainlink.price) : null,
      chainlink_ts: chainlink?.timestamp || null,
      polyref_price: polyRef ? parseFloat(polyRef.price) : null,
      polyref_ts: polyRef?.timestamp || null,
      clob_down_bid: clobDown ? parseFloat(clobDown.best_bid) : null,
      clob_down_ask: clobDown ? parseFloat(clobDown.best_ask) : null,
      clob_down_mid: clobDown ? parseFloat(clobDown.mid_price) : null,
      clob_down_spread: clobDown ? parseFloat(clobDown.spread) : null,
      clob_down_ts: clobDown?.timestamp || null,
      clob_up_bid: clobUp ? parseFloat(clobUp.best_bid) : null,
      clob_up_ask: clobUp ? parseFloat(clobUp.best_ask) : null,
      clob_up_mid: clobUp ? parseFloat(clobUp.mid_price) : null,
      clob_up_spread: clobUp ? parseFloat(clobUp.spread) : null,
      clob_up_ts: clobUp?.timestamp || null,
      exchange_binance: binance ? parseFloat(binance.price) : null,
      exchange_coinbase: coinbase ? parseFloat(coinbase.price) : null,
      exchange_kraken: kraken ? parseFloat(kraken.price) : null,
      exchange_bybit: bybit ? parseFloat(bybit.price) : null,
      exchange_okx: okx ? parseFloat(okx.price) : null,
      resolved_direction: win.resolved_direction,
      chainlink_at_close: parseFloat(win.chainlink_price_at_close),
    });
  }

  // Insert rows individually (simple, fast with indexes)
  for (const row of rows) {
    await exec(`
      INSERT INTO window_backtest_states (
        window_close_time, symbol, offset_ms, strike_price,
        chainlink_price, chainlink_ts, polyref_price, polyref_ts,
        clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread, clob_down_ts,
        clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread, clob_up_ts,
        exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
        resolved_direction, chainlink_at_close
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
      ) ON CONFLICT (window_close_time, symbol, offset_ms) DO UPDATE SET
        chainlink_price = EXCLUDED.chainlink_price,
        polyref_price = EXCLUDED.polyref_price,
        clob_down_bid = EXCLUDED.clob_down_bid,
        clob_down_ask = EXCLUDED.clob_down_ask,
        clob_up_bid = EXCLUDED.clob_up_bid,
        clob_up_ask = EXCLUDED.clob_up_ask,
        exchange_binance = EXCLUDED.exchange_binance,
        exchange_coinbase = EXCLUDED.exchange_coinbase,
        exchange_kraken = EXCLUDED.exchange_kraken,
        exchange_bybit = EXCLUDED.exchange_bybit,
        exchange_okx = EXCLUDED.exchange_okx,
        resolved_direction = EXCLUDED.resolved_direction,
        chainlink_at_close = EXCLUDED.chainlink_at_close
    `, [
      row.window_close_time, row.symbol, row.offset_ms, row.strike_price,
      row.chainlink_price, row.chainlink_ts, row.polyref_price, row.polyref_ts,
      row.clob_down_bid, row.clob_down_ask, row.clob_down_mid, row.clob_down_spread, row.clob_down_ts,
      row.clob_up_bid, row.clob_up_ask, row.clob_up_mid, row.clob_up_spread, row.clob_up_ts,
      row.exchange_binance, row.exchange_coinbase, row.exchange_kraken, row.exchange_bybit, row.exchange_okx,
      row.resolved_direction, row.chainlink_at_close,
    ]);
  }

  return rows.length;
}

// ─── Main ───

async function main() {
  console.log('\n=== Build Fast-Track Backtest Table ===\n');

  // Create table
  console.log('1. Creating table...');
  await createTable();

  // Load windows
  console.log('\n2. Loading windows...');
  const windows = await query(`
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved_direction
    FROM window_close_events
    WHERE chainlink_price_at_close IS NOT NULL
      AND strike_price IS NOT NULL
    ORDER BY window_close_time ASC
  `);
  console.log(`  Found ${windows.length} windows with resolution data`);

  // Check what's already populated
  const existing = await queryOne(`SELECT COUNT(DISTINCT window_close_time) as count FROM window_backtest_states`);
  const existingCount = parseInt(existing?.count || '0');
  console.log(`  Already populated: ${existingCount} windows`);

  // Populate
  console.log('\n3. Populating states (31 samples per window, 10s intervals)...');
  const t0 = Date.now();
  let totalRows = 0;

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const rows = await populateWindow(win);
    totalRows += rows;

    if ((i + 1) % 10 === 0 || i === windows.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const perWindow = ((Date.now() - t0) / (i + 1) / 1000).toFixed(1);
      const eta = (perWindow * (windows.length - i - 1)).toFixed(0);
      process.stdout.write(`  ${i + 1}/${windows.length} windows | ${totalRows} rows | ${elapsed}s elapsed | ~${eta}s remaining\r`);
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`\n\n  Done: ${totalRows} rows in ${(totalMs/1000).toFixed(1)}s (${(totalMs/windows.length/1000).toFixed(1)}s/window)`);

  // Verify
  console.log('\n4. Verification...');
  const stats = await queryOne(`
    SELECT
      COUNT(*) as total_rows,
      COUNT(DISTINCT window_close_time) as windows,
      COUNT(DISTINCT offset_ms) as offsets,
      COUNT(*) FILTER (WHERE chainlink_price IS NOT NULL) as has_chainlink,
      COUNT(*) FILTER (WHERE polyref_price IS NOT NULL) as has_polyref,
      COUNT(*) FILTER (WHERE clob_down_ask IS NOT NULL) as has_clob_down,
      COUNT(*) FILTER (WHERE clob_up_ask IS NOT NULL) as has_clob_up,
      pg_size_pretty(pg_total_relation_size('window_backtest_states')) as table_size
    FROM window_backtest_states
  `);

  console.log(`  Total rows:     ${stats.total_rows}`);
  console.log(`  Windows:        ${stats.windows}`);
  console.log(`  Offsets/window: ${stats.offsets}`);
  console.log(`  Has chainlink:  ${stats.has_chainlink} (${(stats.has_chainlink/stats.total_rows*100).toFixed(1)}%)`);
  console.log(`  Has polyRef:    ${stats.has_polyref} (${(stats.has_polyref/stats.total_rows*100).toFixed(1)}%)`);
  console.log(`  Has CLOB down:  ${stats.has_clob_down} (${(stats.has_clob_down/stats.total_rows*100).toFixed(1)}%)`);
  console.log(`  Has CLOB up:    ${stats.has_clob_up} (${(stats.has_clob_up/stats.total_rows*100).toFixed(1)}%)`);
  console.log(`  Table size:     ${stats.table_size}`);

  // Sample check: compare a state with what we'd get from live query
  console.log('\n5. Cross-check: fast-track vs live query...');
  const sampleState = await queryOne(`
    SELECT * FROM window_backtest_states
    WHERE clob_down_ask IS NOT NULL AND chainlink_price IS NOT NULL
    ORDER BY window_close_time DESC, offset_ms
    LIMIT 1
  `);

  if (sampleState) {
    const sampleTime = new Date(
      new Date(sampleState.window_close_time).getTime() - sampleState.offset_ms
    ).toISOString();

    const [liveCL, liveRef, liveClobDown] = await Promise.all([
      getChainlinkAt(sampleTime),
      getPolyRefAt(sampleTime),
      getClobAt(`${sampleState.symbol}-down`, sampleTime),
    ]);

    console.log(`  Window: ${sampleState.window_close_time}, offset: ${sampleState.offset_ms}ms`);
    console.log(`  Chainlink — fast-track: $${sampleState.chainlink_price}, live: $${liveCL?.price || 'null'} ${sampleState.chainlink_price == liveCL?.price ? '✓' : '✗'}`);
    console.log(`  PolyRef   — fast-track: $${sampleState.polyref_price}, live: $${liveRef?.price || 'null'} ${sampleState.polyref_price == liveRef?.price ? '✓' : '✗'}`);
    console.log(`  CLOB down — fast-track: ${sampleState.clob_down_ask}, live: ${liveClobDown?.best_ask || 'null'} ${sampleState.clob_down_ask == liveClobDown?.best_ask ? '✓' : '✗'}`);
  }

  console.log('\n=== Fast-Track Build Complete ===\n');
  await pool.end();
}

main().catch(err => {
  console.error('Build failed:', err);
  pool.end();
  process.exit(1);
});
