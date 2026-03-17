/**
 * Debug script: Compare raw timeline CLOB events vs MarketState processing
 *
 * Loads a window from pg_timelines, prints all clobDown events,
 * then replays through MarketState to see what state.clobDown shows.
 */

import { unpack } from 'msgpackr';
import pg from 'pg';
import { createMarketState } from '../src/backtest/market-state.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Step 1: Find an XRP window with cheap DOWN tokens
  console.log('=== Step 1: Finding XRP windows with cheap DOWN prices in raw CLOB data ===\n');

  // First check what schema versions exist
  const schemaCheck = await pool.query(`
    SELECT schema_version, COUNT(*) as cnt
    FROM pg_timelines
    WHERE symbol = 'xrp'
    GROUP BY schema_version
  `);
  console.log('Schema versions for XRP:', schemaCheck.rows);

  // Load a few windows (try all schema versions)
  const windowRows = await pool.query(`
    SELECT window_id, window_close_time, ground_truth, strike_price, oracle_price_at_open,
           chainlink_price_at_close, timeline, event_count, schema_version
    FROM pg_timelines
    WHERE symbol = 'xrp'
    ORDER BY window_close_time DESC
    LIMIT 20
  `);

  console.log(`Found ${windowRows.rows.length} XRP windows\n`);

  // For each window, scan for cheap clobDown events
  let targetWindow = null;
  let targetTimeline = null;

  for (const row of windowRows.rows) {
    const timeline = unpack(row.timeline);
    const clobDownEvents = timeline.filter(e => e.source === 'clobDown');

    if (clobDownEvents.length === 0) continue;

    // Find min bestAsk
    let minAsk = Infinity;
    for (const e of clobDownEvents) {
      const ask = parseFloat(e.best_ask || e.bestAsk || 999);
      if (ask < minAsk) minAsk = ask;
    }

    console.log(`Window ${row.window_id} (v${row.schema_version}): ${clobDownEvents.length} clobDown events, min bestAsk = $${minAsk.toFixed(4)}, ground_truth = ${row.ground_truth}`);

    if (minAsk < 0.20 && !targetWindow) {
      targetWindow = row;
      targetTimeline = timeline;
    }
  }

  if (!targetWindow) {
    console.log('\nNo XRP window found with DOWN < $0.20. Trying BTC...');
    const btcRows = await pool.query(`
      SELECT window_id, window_close_time, ground_truth, strike_price, oracle_price_at_open,
             chainlink_price_at_close, timeline, event_count, schema_version
      FROM pg_timelines
      WHERE symbol = 'btc'
      ORDER BY window_close_time DESC
      LIMIT 50
    `);

    for (const row of btcRows.rows) {
      const timeline = unpack(row.timeline);
      const clobDownEvents = timeline.filter(e => e.source === 'clobDown');
      if (clobDownEvents.length === 0) continue;

      let minAsk = Infinity;
      for (const e of clobDownEvents) {
        const ask = parseFloat(e.best_ask || e.bestAsk || 999);
        if (ask < minAsk) minAsk = ask;
      }

      if (minAsk < 0.25) {
        console.log(`  BTC Window ${row.window_id} (v${row.schema_version}): ${clobDownEvents.length} clobDown events, min bestAsk = $${minAsk.toFixed(4)}`);
        if (!targetWindow) {
          targetWindow = row;
          targetTimeline = timeline;
        }
      }
    }
  }

  // If still no window found, just pick any window with clobDown data
  if (!targetWindow) {
    console.log('\nNo cheap window found. Using first window with clobDown data...');
    for (const row of windowRows.rows) {
      const timeline = unpack(row.timeline);
      const clobDownEvents = timeline.filter(e => e.source === 'clobDown');
      if (clobDownEvents.length > 0) {
        targetWindow = row;
        targetTimeline = timeline;
        break;
      }
    }
  }

  if (!targetWindow) {
    console.log('ERROR: No window with clobDown events found!');
    await pool.end();
    return;
  }

  console.log(`\n=== Step 2: Inspecting window ${targetWindow.window_id} ===\n`);
  console.log(`  Schema version: ${targetWindow.schema_version}`);
  console.log(`  Close time: ${targetWindow.window_close_time}`);
  console.log(`  Ground truth: ${targetWindow.ground_truth}`);
  console.log(`  Strike: ${targetWindow.strike_price}`);
  console.log(`  Oracle at open: ${targetWindow.oracle_price_at_open}`);
  console.log(`  Total events: ${targetTimeline.length}`);

  // Print source distribution
  const sourceCounts = {};
  for (const e of targetTimeline) {
    sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
  }
  console.log('\n  Source distribution:', sourceCounts);

  // Print ALL clobDown events with field details
  const clobDownEvents = targetTimeline.filter(e => e.source === 'clobDown');
  console.log(`\n=== Step 3: All ${clobDownEvents.length} clobDown events ===\n`);

  for (let i = 0; i < Math.min(clobDownEvents.length, 20); i++) {
    const e = clobDownEvents[i];
    console.log(`  Event ${i}:`, JSON.stringify(e, null, 2));
  }
  if (clobDownEvents.length > 20) {
    console.log(`  ... (${clobDownEvents.length - 20} more events)`);
  }

  // Print field names present on first clobDown event
  if (clobDownEvents.length > 0) {
    console.log('\n  Field names on first clobDown event:', Object.keys(clobDownEvents[0]));
    console.log('  Has best_ask?', 'best_ask' in clobDownEvents[0]);
    console.log('  Has bestAsk?', 'bestAsk' in clobDownEvents[0]);
    console.log('  Has best_bid?', 'best_bid' in clobDownEvents[0]);
    console.log('  Has bestBid?', 'bestBid' in clobDownEvents[0]);
    console.log('  Has mid_price?', 'mid_price' in clobDownEvents[0]);
    console.log('  Has mid?', 'mid' in clobDownEvents[0]);
  }

  // Also check l2Down events
  const l2DownEvents = targetTimeline.filter(e => e.source === 'l2Down');
  console.log(`\n=== l2Down events: ${l2DownEvents.length} ===`);
  if (l2DownEvents.length > 0) {
    console.log('  First l2Down event:', JSON.stringify(l2DownEvents[0], null, 2));
    console.log('  Field names on first l2Down event:', Object.keys(l2DownEvents[0]));
  }

  // Step 4: Replay through MarketState and compare
  console.log(`\n=== Step 4: Replaying through MarketState ===\n`);

  const state = createMarketState();
  state.setWindow({
    window_close_time: targetWindow.window_close_time,
    symbol: 'xrp',
    strike_price: targetWindow.strike_price,
    oracle_price_at_open: targetWindow.oracle_price_at_open,
    resolved_direction: targetWindow.ground_truth,
  }, new Date(new Date(targetWindow.window_close_time).getTime() - 15 * 60 * 1000).toISOString());

  let clobDownEventIdx = 0;
  let minBestAskRaw = Infinity;
  let minBestAskState = Infinity;
  let clobDownNullCount = 0;
  let clobDownSetCount = 0;

  for (const event of targetTimeline) {
    state.processEvent(event);

    if (event.source === 'clobDown') {
      clobDownEventIdx++;
      const rawAsk = parseFloat(event.best_ask || event.bestAsk || 999);
      const stateAsk = state.clobDown?.bestAsk || null;

      if (rawAsk < minBestAskRaw) minBestAskRaw = rawAsk;
      if (stateAsk && stateAsk < minBestAskState) minBestAskState = stateAsk;

      if (!stateAsk) clobDownNullCount++;
      else clobDownSetCount++;

      if (clobDownEventIdx <= 10 || rawAsk < 0.25) {
        console.log(`  clobDown event ${clobDownEventIdx}:`);
        console.log(`    Raw event.best_ask = ${event.best_ask}, event.bestAsk = ${event.bestAsk}`);
        console.log(`    parseFloat(event.best_bid) = ${parseFloat(event.best_bid)}`);
        console.log(`    parseFloat(event.best_ask) = ${parseFloat(event.best_ask)}`);
        console.log(`    state.clobDown.bestAsk = ${stateAsk}`);
        console.log(`    state.clobDown.bestBid = ${state.clobDown?.bestBid || 'null'}`);
        console.log(`    state.clobDown.mid = ${state.clobDown?.mid || 'null'}`);
        console.log(`    Match? ${rawAsk === stateAsk ? 'YES' : 'NO -- MISMATCH!'}`);
      }
    }
  }

  console.log(`\n=== Step 5: Summary ===`);
  console.log(`  Total clobDown events: ${clobDownEventIdx}`);
  console.log(`  Min raw bestAsk: $${minBestAskRaw.toFixed(4)}`);
  console.log(`  Min state bestAsk: $${minBestAskState === Infinity ? 'NEVER SET' : minBestAskState.toFixed(4)}`);
  console.log(`  state.clobDown.bestAsk was null for ${clobDownNullCount} events`);
  console.log(`  state.clobDown.bestAsk was set for ${clobDownSetCount} events`);

  if (minBestAskRaw < 0.25 && (minBestAskState === Infinity || minBestAskState >= 0.25)) {
    console.log(`\n  *** BUG CONFIRMED: Raw events have bestAsk < $0.25 but MarketState never shows it! ***`);
  } else if (minBestAskState === minBestAskRaw) {
    console.log(`\n  State matches raw data — bug may be elsewhere (timeline trimmer? mid_price filter?)`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
