#!/usr/bin/env node
/**
 * Test compose engine integration directly.
 */

import { unpack } from 'msgpackr';
import pg from 'pg';
import { composeFromYaml } from '../src/factory/compose.js';
import { createMarketState } from '../src/backtest/market-state.js';
import { readFileSync } from 'fs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const yaml = readFileSync('src/factory/strategies/cheap-reversal-single.yaml', 'utf8');
  const strategy = await composeFromYaml(yaml);

  // Use a window we KNOW has trades (from verification above)
  const row = (await pool.query(`
    SELECT window_id, window_close_time, ground_truth, strike_price, oracle_price_at_open,
           chainlink_price_at_close, timeline
    FROM pg_timelines
    WHERE window_id = 'xrp-2026-03-15T18:45:00.000Z'
  `)).rows[0];

  if (!row) { console.error('Window not found'); await pool.end(); return; }

  const timeline = unpack(row.timeline);
  const state = createMarketState();
  const closeMs = new Date(row.window_close_time).getTime();
  const openMs = closeMs - 15 * 60 * 1000;

  state.setWindow({
    window_close_time: row.window_close_time instanceof Date ? row.window_close_time.toISOString() : row.window_close_time,
    symbol: 'xrp',
    strike_price: row.strike_price,
    oracle_price_at_open: row.oracle_price_at_open,
    resolved_direction: row.ground_truth,
    gamma_resolved_direction: row.ground_truth,
  }, new Date(openMs).toISOString());

  if (strategy.onWindowOpen) {
    strategy.onWindowOpen(state, strategy.defaults);
  }

  let evalCount = 0;
  let tradeCount = 0;
  let errorCount = 0;

  for (const event of timeline) {
    const eventMs = event._ms || new Date(event.timestamp).getTime();
    if (eventMs < openMs || eventMs >= closeMs) continue;

    state.processEvent(event);
    state.updateTimeToCloseMs(eventMs);

    try {
      const signals = strategy.evaluate(state, strategy.defaults);
      evalCount++;

      if (signals && signals.length > 0) {
        tradeCount++;
        if (tradeCount <= 3) {
          console.log(`Trade ${tradeCount}: ttc=${state.window.timeToCloseMs}ms, downAsk=${state.clobDown?.bestAsk}, signal:`, signals[0]);
        }
      }
    } catch (err) {
      errorCount++;
      if (errorCount <= 3) {
        console.log(`Error at ttc=${state.window?.timeToCloseMs}ms:`, err.message);
      }
    }
  }

  console.log(`\nEvaluations: ${evalCount}, Trades: ${tradeCount}, Errors: ${errorCount}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
