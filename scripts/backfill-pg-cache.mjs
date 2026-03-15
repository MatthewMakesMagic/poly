#!/usr/bin/env node
/**
 * Backfill PG Timeline Cache
 *
 * Reads all resolved windows from window_close_events in PostgreSQL,
 * builds timelines using the same pipeline as timeline-builder.js,
 * and writes them to the pg_timelines table.
 *
 * Usage:
 *   node scripts/backfill-pg-cache.mjs --symbol=btc
 *   node scripts/backfill-pg-cache.mjs --symbol=all
 *   node scripts/backfill-pg-cache.mjs --symbol=btc --since=2026-02-22
 *
 * Designed to run ON Railway where PG queries are fast.
 */

import { parseArgs } from 'node:util';
import pg from 'pg';
import { pack } from 'msgpackr';

// ── Argument Parsing ──────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'all' },
    since: { type: 'string', default: '' },
    'batch-size': { type: 'string', default: '10' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

const SYMBOL = args.symbol.toLowerCase();
const SINCE = args.since || null;
const BATCH_CONCURRENCY = parseInt(args['batch-size'], 10) || 10;
const DRY_RUN = args['dry-run'];

// ── PG Connection ─────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=no-verify')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
});

// ── Constants ─────────────────────────────────────────────────────────

const WINDOW_DURATION_MS = 15 * 60 * 1000;

// ── Timeline Builder Logic (reused from timeline-builder.js) ──────────

function toISOString(ts) {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}

function makeWindowId(symbol, closeTime) {
  const iso = toISOString(closeTime);
  return `${symbol}-${iso}`;
}

function resolveGroundTruth(windowEvent) {
  return (
    windowEvent.gamma_resolved_direction ||
    windowEvent.onchain_resolved_direction ||
    windowEvent.resolved_direction ||
    null
  );
}

function mergeTimeline({ rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks, openMs, closeMs }) {
  const events = [];

  for (const tick of rtdsTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    const source = tick.topic === 'crypto_prices_chainlink' ? 'chainlink' : 'polyRef';
    events.push({ source, timestamp: ts, price: parseFloat(tick.price), _ms: ms });
  }

  for (const snap of clobSnapshots) {
    const ts = toISOString(snap.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    const mid = parseFloat(snap.mid_price || 0);
    if (mid < 0.05 || mid > 0.95) continue;
    events.push({
      source, timestamp: ts,
      best_bid: parseFloat(snap.best_bid), best_ask: parseFloat(snap.best_ask),
      mid_price: parseFloat(snap.mid_price), spread: parseFloat(snap.spread),
      bid_size_top: parseFloat(snap.bid_size_top || 0), ask_size_top: parseFloat(snap.ask_size_top || 0),
      _ms: ms,
    });
  }

  for (const tick of exchangeTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    events.push({
      source: `exchange_${tick.exchange}`, timestamp: ts,
      price: parseFloat(tick.price),
      bid: tick.bid != null ? parseFloat(tick.bid) : null,
      ask: tick.ask != null ? parseFloat(tick.ask) : null,
      _ms: ms,
    });
  }

  if (l2BookTicks) {
    const tokenDirMap = new Map();
    for (const snap of clobSnapshots) {
      if (snap.token_id && !tokenDirMap.has(snap.token_id)) {
        tokenDirMap.set(snap.token_id, snap.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      }
    }
    for (const tick of l2BookTicks) {
      const ts = toISOString(tick.timestamp);
      const ms = new Date(ts).getTime();
      if (ms < openMs || ms >= closeMs) continue;
      const direction = tokenDirMap.get(tick.token_id) ||
        (tick.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      const source = direction === 'down' ? 'l2Down' : 'l2Up';
      events.push({
        source, timestamp: ts,
        best_bid: parseFloat(tick.best_bid), best_ask: parseFloat(tick.best_ask),
        mid_price: parseFloat(tick.mid_price), spread: parseFloat(tick.spread || 0),
        bid_depth_1pct: parseFloat(tick.bid_depth_1pct || 0), ask_depth_1pct: parseFloat(tick.ask_depth_1pct || 0),
        top_levels: tick.top_levels || null,
        _ms: ms,
      });
    }
  }

  if (coingeckoTicks) {
    for (const tick of coingeckoTicks) {
      const ts = toISOString(tick.timestamp);
      const ms = new Date(ts).getTime();
      if (ms < openMs || ms >= closeMs) continue;
      events.push({ source: 'coingecko', timestamp: ts, price: parseFloat(tick.price), _ms: ms });
    }
  }

  events.sort((a, b) => a._ms - b._ms);
  return events;
}

// ── Validation (simplified from timeline-validator.js) ────────────────

function validateWindow({ timeline, rtdsCount, clobCount, exchangeCount, l2Count, coingeckoCount = 0 }) {
  const flags = [];
  if (timeline.length < 10) {
    flags.push({ type: 'incomplete', message: `Only ${timeline.length} events` });
  }
  return {
    rtds_count: rtdsCount,
    clob_count: clobCount,
    exchange_count: exchangeCount,
    l2_count: l2Count,
    coingecko_count: coingeckoCount,
    event_count: timeline.length,
    flags,
  };
}

// ── PG Queries ────────────────────────────────────────────────────────

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function getAvailableSymbols() {
  const rows = await query('SELECT DISTINCT symbol FROM window_close_events ORDER BY symbol');
  return rows.map(r => r.symbol);
}

async function loadWindows(symbol, sinceDate) {
  // Check for gamma column
  let hasGamma = false;
  try {
    const col = await queryOne(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'window_close_events' AND column_name = 'gamma_resolved_direction'
    `);
    hasGamma = !!col;
  } catch { /* ignore */ }

  let sql = `
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close, oracle_price_at_open,
           resolved_direction, onchain_resolved_direction
           ${hasGamma ? ', gamma_resolved_direction' : ''}
    FROM window_close_events
    WHERE symbol = $1
  `;
  const params = [symbol];

  if (sinceDate) {
    sql += ` AND window_close_time >= $2`;
    params.push(sinceDate);
  }

  sql += ' ORDER BY window_close_time ASC';
  return query(sql, params);
}

async function getExistingWindowIds(symbol) {
  try {
    const rows = await query(
      'SELECT window_id FROM pg_timelines WHERE symbol = $1',
      [symbol]
    );
    return new Set(rows.map(r => r.window_id));
  } catch {
    // Table may not exist yet
    return new Set();
  }
}

async function loadWindowTickData(symbol, openTime, closeTime) {
  const [rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks] = await Promise.all([
    query(`
      SELECT timestamp, topic, symbol, price, received_at
      FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
      ORDER BY timestamp ASC
    `, [openTime, closeTime]),

    query(`
      SELECT timestamp, symbol, token_id, best_bid, best_ask,
             mid_price, spread, bid_size_top, ask_size_top, window_epoch
      FROM clob_price_snapshots
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]),

    query(`
      SELECT timestamp, exchange, symbol, price, bid, ask
      FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]),

    query(`
      SELECT timestamp, token_id, symbol, event_type,
             best_bid, best_ask, mid_price, spread,
             bid_depth_1pct, ask_depth_1pct, top_levels
      FROM l2_book_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]).catch(() => []),

    query(`
      SELECT timestamp, symbol, price
      FROM coingecko_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]).catch(() => []),
  ]);

  return { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks };
}

// ── Build Single Window ───────────────────────────────────────────────

async function buildSingleWindow(symbol, windowEvent) {
  const groundTruth = resolveGroundTruth(windowEvent);
  if (!groundTruth) return null;

  const closeTime = toISOString(windowEvent.window_close_time);
  const closeMs = new Date(closeTime).getTime();
  const openMs = closeMs - WINDOW_DURATION_MS;
  const openTime = new Date(openMs).toISOString();
  const windowId = makeWindowId(symbol, closeTime);

  const { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks } =
    await loadWindowTickData(symbol, openTime, closeTime);

  const timeline = mergeTimeline({
    rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks,
    openMs, closeMs,
  });

  const quality = validateWindow({
    timeline,
    rtdsCount: rtdsTicks.length,
    clobCount: clobSnapshots.length,
    exchangeCount: exchangeTicks.length,
    l2Count: l2BookTicks.length,
    coingeckoCount: coingeckoTicks.length,
  });

  if (timeline.length === 0) return null;

  const blob = pack(timeline);

  return {
    window_id: windowId,
    symbol,
    window_close_time: closeTime,
    window_open_time: openTime,
    ground_truth: groundTruth,
    strike_price: windowEvent.strike_price != null ? parseFloat(windowEvent.strike_price) : null,
    oracle_price_at_open: windowEvent.oracle_price_at_open != null ? parseFloat(windowEvent.oracle_price_at_open) : null,
    chainlink_price_at_close: windowEvent.chainlink_price_at_close != null ? parseFloat(windowEvent.chainlink_price_at_close) : null,
    timeline: blob,
    event_count: timeline.length,
    data_quality: JSON.stringify(quality),
  };
}

// ── PG Write ──────────────────────────────────────────────────────────

async function writeToPgTimelines(row) {
  await pool.query(`
    INSERT INTO pg_timelines (window_id, symbol, window_close_time, window_open_time, ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close, timeline, event_count, data_quality, schema_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
    ON CONFLICT (window_id) DO NOTHING
  `, [
    row.window_id,
    row.symbol,
    row.window_close_time,
    row.window_open_time,
    row.ground_truth,
    row.strike_price,
    row.oracle_price_at_open,
    row.chainlink_price_at_close,
    row.timeline,
    row.event_count,
    row.data_quality,
  ]);
}

// ── Batch Processing ──────────────────────────────────────────────────

async function processWindowBatch(symbol, windowBatch) {
  const results = await Promise.allSettled(
    windowBatch.map(async (win) => {
      const row = await buildSingleWindow(symbol, win);
      if (!row) return { status: 'skipped' };
      if (!DRY_RUN) {
        await writeToPgTimelines(row);
      }
      return { status: 'inserted', eventCount: row.event_count };
    })
  );

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      errors++;
    } else if (r.value.status === 'skipped') {
      skipped++;
    } else {
      inserted++;
    }
  }
  return { inserted, skipped, errors };
}

// ── Main ──────────────────────────────────────────────────────────────

async function backfillSymbol(symbol) {
  const startTime = Date.now();
  console.log(`\n[backfill] Building timelines for ${symbol}...`);

  const windows = await loadWindows(symbol, SINCE);
  console.log(`[backfill] ${symbol}: ${windows.length} windows from PG`);

  if (windows.length === 0) return;

  // Filter already-cached windows
  const existingIds = await getExistingWindowIds(symbol);
  const newWindows = windows.filter(w => {
    const windowId = makeWindowId(symbol, toISOString(w.window_close_time));
    return !existingIds.has(windowId);
  });

  console.log(`[backfill] ${symbol}: ${newWindows.length} new windows (${existingIds.size} already cached)`);

  if (newWindows.length === 0) return;

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Process in concurrent batches of BATCH_CONCURRENCY
  for (let i = 0; i < newWindows.length; i += BATCH_CONCURRENCY) {
    const batch = newWindows.slice(i, i + BATCH_CONCURRENCY);
    const { inserted, skipped, errors } = await processWindowBatch(symbol, batch);

    totalInserted += inserted;
    totalSkipped += skipped;
    totalErrors += errors;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const processed = Math.min(i + BATCH_CONCURRENCY, newWindows.length);
    console.log(
      `[backfill] ${symbol}: ${processed}/${newWindows.length} windows processed ` +
      `(${totalInserted} inserted, ${totalSkipped} skipped, ${totalErrors} errors) — ${elapsed}s elapsed`
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[backfill] ${symbol}: DONE. ` +
    `${totalInserted} inserted, ${totalSkipped} skipped, ${totalErrors} errors. ` +
    `Total: ${elapsed}s`
  );
}

async function main() {
  console.log(`[backfill] PG Timeline Cache Backfill`);
  console.log(`[backfill] Symbol: ${SYMBOL}, Since: ${SINCE || 'all time'}, Batch concurrency: ${BATCH_CONCURRENCY}`);
  if (DRY_RUN) console.log(`[backfill] DRY RUN — no writes will be made`);

  const startTime = Date.now();

  try {
    // Ensure pg_timelines table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pg_timelines (
        window_id TEXT NOT NULL PRIMARY KEY,
        symbol TEXT NOT NULL,
        window_close_time TIMESTAMPTZ NOT NULL,
        window_open_time TIMESTAMPTZ NOT NULL,
        ground_truth TEXT,
        strike_price DOUBLE PRECISION,
        oracle_price_at_open DOUBLE PRECISION,
        chainlink_price_at_close DOUBLE PRECISION,
        timeline BYTEA NOT NULL,
        event_count INTEGER NOT NULL,
        data_quality JSONB,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pg_timelines_symbol ON pg_timelines(symbol)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pg_timelines_close ON pg_timelines(window_close_time)');

    if (SYMBOL === 'all') {
      const symbols = await getAvailableSymbols();
      console.log(`[backfill] Available symbols: ${symbols.join(', ')}`);
      for (const sym of symbols) {
        await backfillSymbol(sym);
      }
    } else {
      await backfillSymbol(SYMBOL);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[backfill] All done in ${totalElapsed}s`);
  } catch (err) {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
