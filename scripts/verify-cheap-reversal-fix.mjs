#!/usr/bin/env node
/**
 * Verify cheap-reversal fix: load windows from pg_timelines via the fixed path,
 * replay through MarketState + cheap-reversal signal, confirm trades fire.
 */

import { unpack } from 'msgpackr';
import pg from 'pg';
import { createMarketState } from '../src/backtest/market-state.js';
import { create as createCheapReversal } from '../src/factory/signals/cheap-reversal.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Load 50 XRP windows with schema_version = 2 (the fixed version)
  const windowRows = await pool.query(`
    SELECT window_id, window_close_time, ground_truth, strike_price, oracle_price_at_open,
           chainlink_price_at_close, timeline, event_count, schema_version
    FROM pg_timelines
    WHERE symbol = 'xrp' AND schema_version = 2
    ORDER BY window_close_time DESC
    LIMIT 50
  `);

  console.log(`Loaded ${windowRows.rows.length} XRP windows (schema_version=2)\n`);

  const signalBlock = createCheapReversal({
    maxPrice: 0.25,
    proximityPct: 0.15,
    minExchanges: 3,
  });
  // create() now returns { evaluate, reset } matching compose engine contract
  const signal = signalBlock.evaluate;

  let totalTrades = 0;
  let windowsWithTrades = 0;
  let windowsWithCheapDown = 0;

  for (const row of windowRows.rows) {
    const timeline = unpack(row.timeline);
    const state = createMarketState();

    const closeTime = row.window_close_time instanceof Date
      ? row.window_close_time.toISOString()
      : row.window_close_time;
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 15 * 60 * 1000;

    state.setWindow({
      window_close_time: closeTime,
      symbol: 'xrp',
      strike_price: row.strike_price,
      oracle_price_at_open: row.oracle_price_at_open,
      resolved_direction: row.ground_truth,
    }, new Date(openMs).toISOString());

    let windowTrades = 0;
    let minDownAsk = Infinity;
    let tradeReason = null;

    for (const event of timeline) {
      const eventMs = event._ms || new Date(event.timestamp).getTime();
      if (eventMs < openMs || eventMs >= closeMs) continue;

      state.processEvent(event);
      state.updateTimeToCloseMs(eventMs);

      // Track min clobDown bestAsk
      if (state.clobDown?.bestAsk && state.clobDown.bestAsk < minDownAsk) {
        minDownAsk = state.clobDown.bestAsk;
      }

      // Only evaluate in last 60s (matching entryWindowMs=60000 from strategy YAML)
      if (state.window?.timeToCloseMs > 60000) continue;

      const result = signal(state, {
        maxPrice: 0.25,
        proximityPct: 0.15,
        minExchanges: 3,
      });

      if (result.direction) {
        windowTrades++;
        if (!tradeReason) tradeReason = result.reason;
      }
    }

    if (minDownAsk < 0.25) windowsWithCheapDown++;
    if (windowTrades > 0) {
      windowsWithTrades++;
      totalTrades += windowTrades;
    }
  }

  console.log('=== Results ===');
  console.log(`Windows evaluated: ${windowRows.rows.length}`);
  console.log(`Windows with DOWN < $0.25: ${windowsWithCheapDown}`);
  console.log(`Windows with trades: ${windowsWithTrades}`);
  console.log(`Total trade signals: ${totalTrades}`);

  if (totalTrades > 0) {
    console.log('\n*** FIX VERIFIED: Trades are firing! ***');
  } else {
    console.log('\n*** WARNING: Still 0 trades. Need further investigation. ***');
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
