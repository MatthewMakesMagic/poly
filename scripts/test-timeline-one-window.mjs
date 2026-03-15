#!/usr/bin/env node
/**
 * Test: Build ONE complete BTC timeline window with all 5 data sources.
 * Uses raw pg.Client with 60s timeout to bypass persistence module limits.
 * Writes result to pg_timelines and verifies.
 */

import pg from 'pg';
import { pack } from 'msgpackr';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const WINDOW_DURATION_MS = 15 * 60 * 1000;

function toISOString(ts) {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}

function makeWindowId(symbol, closeTime) {
  return `${symbol}-${toISOString(closeTime)}`;
}

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  });
  await client.connect();
  console.log('Connected to PG with 60s timeout\n');

  // Step 1: Pick a window after Feb 25 that is NOT already cached
  const winResult = await client.query(`
    SELECT w.window_close_time, w.symbol, w.strike_price,
           w.chainlink_price_at_close, w.oracle_price_at_open,
           w.resolved_direction, w.onchain_resolved_direction
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.window_close_time > '2026-02-25'
      AND NOT EXISTS (SELECT 1 FROM pg_timelines p WHERE p.window_id = 'btc-' || w.window_close_time::text)
    ORDER BY w.window_close_time
    LIMIT 1
  `);

  if (winResult.rows.length === 0) {
    console.log('No uncached windows found after Feb 25!');
    await client.end();
    return;
  }

  const win = winResult.rows[0];
  const closeTime = toISOString(win.window_close_time);
  const closeMs = new Date(closeTime).getTime();
  const openMs = closeMs - WINDOW_DURATION_MS;
  const openTime = new Date(openMs).toISOString();
  const windowId = makeWindowId('btc', closeTime);
  const groundTruth = win.onchain_resolved_direction || win.resolved_direction;

  console.log(`Window: ${windowId}`);
  console.log(`Open:   ${openTime}`);
  console.log(`Close:  ${closeTime}`);
  console.log(`Ground: ${groundTruth}`);
  console.log(`Strike: ${win.strike_price}`);
  console.log('');

  // Step 2: Load all 5 data sources with raw queries
  let t;

  // RTDS
  t = Date.now();
  const rtdsResult = await client.query(`
    SELECT timestamp, topic, symbol, price, received_at
    FROM rtds_ticks
    WHERE timestamp >= $1 AND timestamp <= $2
      AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
    ORDER BY timestamp ASC
  `, [openTime, closeTime]);
  const rtdsTicks = rtdsResult.rows;
  console.log(`RTDS ticks:     ${rtdsTicks.length} rows (${Date.now() - t}ms)`);

  // CLOB
  t = Date.now();
  const clobResult = await client.query(`
    SELECT timestamp, symbol, token_id, best_bid, best_ask,
           mid_price, spread, bid_size_top, ask_size_top, window_epoch
    FROM clob_price_snapshots
    WHERE timestamp >= $1 AND timestamp <= $2
      AND symbol LIKE $3
    ORDER BY timestamp ASC
  `, [openTime, closeTime, 'btc%']);
  const clobSnapshots = clobResult.rows;
  console.log(`CLOB snapshots: ${clobSnapshots.length} rows (${Date.now() - t}ms)`);

  // Exchange
  t = Date.now();
  const exchResult = await client.query(`
    SELECT timestamp, exchange, symbol, price, bid, ask
    FROM exchange_ticks
    WHERE timestamp >= $1 AND timestamp <= $2
      AND symbol = $3
    ORDER BY timestamp ASC
  `, [openTime, closeTime, 'btc']);
  const exchangeTicks = exchResult.rows;
  console.log(`Exchange ticks: ${exchangeTicks.length} rows (${Date.now() - t}ms)`);

  // L2
  t = Date.now();
  const l2Result = await client.query(`
    SELECT timestamp, token_id, symbol, event_type,
           best_bid, best_ask, mid_price, spread,
           bid_depth_1pct, ask_depth_1pct, top_levels
    FROM l2_book_ticks
    WHERE timestamp >= $1 AND timestamp <= $2
      AND symbol LIKE $3
    ORDER BY timestamp ASC
  `, [openTime, closeTime, 'btc%']);
  const l2BookTicks = l2Result.rows;
  console.log(`L2 book ticks:  ${l2BookTicks.length} rows (${Date.now() - t}ms)`);

  // CoinGecko from vwap_snapshots
  t = Date.now();
  const cgResult = await client.query(`
    SELECT DISTINCT ON (date_trunc('minute', timestamp) +
           (EXTRACT(second FROM timestamp)::int / 10 * 10) * interval '1 second')
      timestamp, symbol, coingecko_price as price
    FROM vwap_snapshots
    WHERE timestamp >= $1 AND timestamp <= $2
      AND symbol = $3
      AND coingecko_price IS NOT NULL
    ORDER BY date_trunc('minute', timestamp) +
             (EXTRACT(second FROM timestamp)::int / 10 * 10) * interval '1 second',
             timestamp ASC
  `, [openTime, closeTime, 'btc']);
  const coingeckoTicks = cgResult.rows;
  console.log(`CoinGecko:      ${coingeckoTicks.length} rows (${Date.now() - t}ms)`);
  console.log('');

  // Step 3: Build merged timeline (same logic as timeline-builder.js)
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

  // L2 book ticks
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

  // CoinGecko
  for (const tick of coingeckoTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    events.push({ source: 'coingecko', timestamp: ts, price: parseFloat(tick.price), _ms: ms });
  }

  events.sort((a, b) => a._ms - b._ms);

  // Step 4: Compute quality
  const sourceCounts = {};
  for (const e of events) {
    const key = e.source.startsWith('exchange_') ? 'exchange' :
                e.source === 'chainlink' || e.source === 'polyRef' ? 'rtds' :
                e.source === 'clobUp' || e.source === 'clobDown' ? 'clob' :
                e.source === 'l2Up' || e.source === 'l2Down' ? 'l2' :
                e.source === 'coingecko' ? 'coingecko' : 'other';
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }

  const quality = {
    rtds_count: sourceCounts.rtds || 0,
    clob_count: sourceCounts.clob || 0,
    exchange_count: sourceCounts.exchange || 0,
    l2_count: sourceCounts.l2 || 0,
    coingecko_count: sourceCounts.coingecko || 0,
    event_count: events.length,
    flags: [],
  };

  console.log('=== Timeline Quality ===');
  console.log(`  Total events:  ${events.length}`);
  console.log(`  RTDS:          ${quality.rtds_count}`);
  console.log(`  CLOB:          ${quality.clob_count}`);
  console.log(`  Exchange:      ${quality.exchange_count}`);
  console.log(`  L2:            ${quality.l2_count}`);
  console.log(`  CoinGecko:     ${quality.coingecko_count}`);
  console.log('');

  // Step 5: Serialize and write to pg_timelines
  const blob = pack(events);
  console.log(`Serialized timeline: ${blob.length} bytes`);

  await client.query(`
    INSERT INTO pg_timelines (window_id, symbol, window_close_time, window_open_time,
      ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
      timeline, event_count, data_quality, schema_version, built_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, NOW())
    ON CONFLICT (window_id) DO UPDATE SET
      timeline = EXCLUDED.timeline,
      event_count = EXCLUDED.event_count,
      data_quality = EXCLUDED.data_quality,
      built_at = EXCLUDED.built_at
  `, [
    windowId,
    'btc',
    closeTime,
    openTime,
    groundTruth,
    win.strike_price != null ? parseFloat(win.strike_price) : null,
    win.oracle_price_at_open != null ? parseFloat(win.oracle_price_at_open) : null,
    win.chainlink_price_at_close != null ? parseFloat(win.chainlink_price_at_close) : null,
    blob,
    events.length,
    JSON.stringify(quality),
  ]);
  console.log(`Wrote to pg_timelines: ${windowId}`);

  // Step 6: Read back and verify
  const verify = await client.query(`
    SELECT window_id, event_count, data_quality
    FROM pg_timelines WHERE window_id = $1
  `, [windowId]);
  const v = verify.rows[0];
  const vq = typeof v.data_quality === 'string' ? JSON.parse(v.data_quality) : v.data_quality;

  console.log('\n=== Verification ===');
  console.log(`  Window ID:     ${v.window_id}`);
  console.log(`  Event Count:   ${v.event_count}`);
  console.log(`  RTDS:          ${vq.rtds_count}`);
  console.log(`  CLOB:          ${vq.clob_count}`);
  console.log(`  Exchange:      ${vq.exchange_count}`);
  console.log(`  L2:            ${vq.l2_count}`);
  console.log(`  CoinGecko:     ${vq.coingecko_count}`);

  const allPresent = vq.rtds_count > 0 && vq.clob_count > 0 && vq.exchange_count > 0 && vq.l2_count > 0 && vq.coingecko_count > 0;
  console.log(`\n  ALL SOURCES PRESENT: ${allPresent ? 'YES' : 'NO'}`);

  await client.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
