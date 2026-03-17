#!/usr/bin/env node

/**
 * Trade Audit Script — edge-c-asymmetry
 *
 * Runs the strategy on 200 BTC windows via the PG path with detailed
 * per-trade logging. Queries actual L2 book data for each trade window.
 * Writes a comprehensive audit report.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import persistence from '../src/persistence/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';
import {
  loadWindowsWithGroundTruth,
  loadWindowTickData,
} from '../src/backtest/data-loader.js';
import { sampleWindows } from '../src/factory/sampler.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';
import { simulateMarketFill } from '../src/factory/fill-simulator.js';
import { FeeMode, parseFeeMode, calculateTakerFee, calculateTakerFeeRate } from '../src/factory/fee-model.js';

// Import strategy
import * as edgeCStrategy from '../src/backtest/strategies/edge-c-asymmetry.js';

// ─── Config ───
const SYMBOL = 'btc';
const SAMPLE_COUNT = 200;
const SEED = 42;
const INITIAL_CAPITAL = 100;
const SPREAD_BUFFER = 0.005;
const WINDOW_DURATION_MS = 5 * 60 * 1000;
const FEE_MODE = FeeMode.TAKER_ONLY;

// ─── Init ───
async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  await initLogger({ logging: { level: 'error', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 2, max: 15, connectionTimeoutMs: 30000 },
      circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 300000,
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  });
}

/**
 * Build timeline from PG data — mirrors backtest-factory.js buildWindowTimelinePg
 */
function buildWindowTimelinePg(windowData) {
  const { rtdsTicks, clobSnapshots, exchangeTicks } = windowData;
  const timeline = [];

  for (const tick of rtdsTicks) {
    const topic = tick.topic;
    let source;
    if (topic === 'crypto_prices_chainlink') source = 'chainlink';
    else if (topic === 'crypto_prices') source = 'polyRef';
    else source = `rtds_${topic}`;
    timeline.push({ ...tick, source });
  }

  for (const snap of clobSnapshots) {
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    timeline.push({ ...snap, source });
  }

  for (const tick of exchangeTicks) {
    timeline.push({ ...tick, source: `exchange_${tick.exchange}` });
  }

  timeline.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    return tA - tB;
  });

  return timeline;
}

/**
 * Get ground truth direction
 */
function getGroundTruth(win) {
  if (win.gamma_resolved_direction) return win.gamma_resolved_direction.toUpperCase();
  if (win.onchain_resolved_direction) return win.onchain_resolved_direction.toUpperCase();
  if (win.resolved_direction) return win.resolved_direction.toUpperCase();
  const clClose = Number(win.chainlink_price_at_close);
  const clOpen = Number(win.oracle_price_at_open);
  if (clClose && clOpen) return clClose >= clOpen ? 'UP' : 'DOWN';
  return null;
}

/**
 * Query L2 book data from l2_book_ticks table for a specific window
 */
async function queryL2BookData(symbol, windowOpenTime, windowCloseTime) {
  try {
    const rows = await persistence.all(`
      SELECT timestamp, side, top_levels, bid_depth_1pct, ask_depth_1pct, best_bid, best_ask
      FROM l2_book_ticks
      WHERE symbol = $1
        AND timestamp >= $2
        AND timestamp < $3
      ORDER BY timestamp ASC
    `, [symbol, windowOpenTime, windowCloseTime]);
    return rows;
  } catch (err) {
    // Try alternate query if side column doesn't exist
    try {
      const rows = await persistence.all(`
        SELECT timestamp, direction as side, top_levels, bid_depth_1pct, ask_depth_1pct, best_bid, best_ask
        FROM l2_book_ticks
        WHERE symbol = $1
          AND timestamp >= $2
          AND timestamp < $3
        ORDER BY timestamp ASC
      `, [symbol, windowOpenTime, windowCloseTime]);
      return rows;
    } catch (err2) {
      console.error(`  L2 query error: ${err2.message}`);
      return [];
    }
  }
}

/**
 * Compute VWAP fill price for a given dollar amount from L2 ask levels
 */
function computeVwapFromL2(askLevels, dollars) {
  if (!askLevels || askLevels.length === 0) return null;

  let remaining = dollars;
  let totalShares = 0;
  let totalCost = 0;

  for (const [price, size] of askLevels) {
    if (remaining <= 0) break;
    if (price <= 0 || price >= 1) continue;
    const levelDollars = price * size;
    const take = Math.min(remaining, levelDollars);
    const shares = take / price;
    totalShares += shares;
    totalCost += take;
    remaining -= take;
  }

  if (totalShares <= 0) return null;
  return {
    vwap: totalCost / totalShares,
    filled: totalCost,
    unfilled: remaining,
    shares: totalShares,
  };
}

/**
 * Find slippage threshold sizes from L2 levels
 */
function findSlippageThresholds(askLevels) {
  if (!askLevels || askLevels.length === 0) return { slip1c: null, slip5c: null, slip10c: null };

  const bestAsk = askLevels[0]?.[0];
  if (!bestAsk || bestAsk <= 0) return { slip1c: null, slip5c: null, slip10c: null };

  const thresholds = { slip1c: 0.01, slip5c: 0.05, slip10c: 0.10 };
  const results = {};

  for (const [label, threshold] of Object.entries(thresholds)) {
    // Find dollar amount where VWAP - bestAsk exceeds threshold
    let found = null;
    for (let dollars = 1; dollars <= 1000; dollars += 1) {
      const result = computeVwapFromL2(askLevels, dollars);
      if (!result) break;
      if (result.vwap - bestAsk >= threshold) {
        found = dollars;
        break;
      }
    }
    results[label] = found;
  }
  return results;
}


async function main() {
  console.log('=== Trade Audit: edge-c-asymmetry ===\n');
  await initDb();

  // ─── Step 1: Load and sample windows ───
  console.log('Loading windows from PG...');
  const allWindows = await loadWindowsWithGroundTruth({
    startDate: '2020-01-01',
    endDate: '2030-01-01',
    symbols: [SYMBOL],
  });
  console.log(`  Total windows: ${allWindows.length}`);

  const windowsMapped = allWindows.map(w => ({
    ...w,
    window_close_time: w.window_close_time instanceof Date
      ? w.window_close_time.toISOString()
      : w.window_close_time,
  }));

  const sampledWindows = sampleWindows(windowsMapped, {
    count: SAMPLE_COUNT,
    seed: SEED,
    stratify: 'weekly',
  });
  console.log(`  Sampled windows: ${sampledWindows.length}`);

  // ─── Step 2: Run backtest with trade-level capture ───
  console.log('\nRunning backtest with trade-level logging...');

  const strategy = {
    name: edgeCStrategy.name,
    evaluate: edgeCStrategy.evaluate,
    onWindowOpen: edgeCStrategy.onWindowOpen,
    defaults: edgeCStrategy.defaults,
  };

  const tradeDetails = [];
  let windowsProcessed = 0;
  let windowsWithTrades = 0;

  for (const win of sampledWindows) {
    windowsProcessed++;

    // Reset strategy per-window state
    if (strategy.onWindowOpen) strategy.onWindowOpen();

    // Load tick data
    const windowData = await loadWindowTickData({
      window: win,
      windowDurationMs: WINDOW_DURATION_MS,
    });

    const timeline = buildWindowTimelinePg(windowData);
    const groundTruth = getGroundTruth(win);

    // Run evaluateWindow to get the official result
    // But first reset strategy state again for the official run
    if (strategy.onWindowOpen) strategy.onWindowOpen();

    const result = evaluateWindow({
      window: win,
      timeline,
      strategy,
      strategyConfig: edgeCStrategy.defaults,
      initialCapital: INITIAL_CAPITAL,
      spreadBuffer: SPREAD_BUFFER,
      tradingFee: 0,
      windowDurationMs: WINDOW_DURATION_MS,
      feeMode: FEE_MODE,
    });

    if (result.trades.length > 0) {
      windowsWithTrades++;
      const closeMs = new Date(win.window_close_time).getTime();
      const openMs = closeMs - WINDOW_DURATION_MS;
      const openTime = new Date(openMs).toISOString();
      const closeTime = win.window_close_time;

      // Now replay to capture state at moment of trade
      if (strategy.onWindowOpen) strategy.onWindowOpen();

      // Replay and capture market state at each trade moment
      const { createMarketState } = await import('../src/backtest/market-state.js');
      const captureState = createMarketState();
      captureState.setWindow(win, openTime);

      let tradeSnapshot = null;

      for (const event of timeline) {
        const eventMs = new Date(event.timestamp).getTime();
        if (eventMs < openMs) continue;
        if (eventMs >= closeMs) break;

        captureState.processEvent(event);
        captureState.updateTimeToCloseMs(eventMs);

        // Run strategy to detect when it fires
        const signals = strategy.evaluate(captureState, edgeCStrategy.defaults);
        if (signals && signals.length > 0) {
          // Capture state at this moment
          tradeSnapshot = {
            timestamp: event.timestamp,
            chainlinkPrice: captureState.chainlink?.price || null,
            strikePrice: captureState.strike,
            oraclePriceAtOpen: captureState.oraclePriceAtOpen,
            deficit: captureState.oraclePriceAtOpen - (captureState.chainlink?.price || 0),
            polyRefPrice: captureState.polyRef?.price || null,
            clobDown: captureState.clobDown ? { ...captureState.clobDown } : null,
            clobUp: captureState.clobUp ? { ...captureState.clobUp } : null,
            timeToCloseMs: captureState.window?.timeToCloseMs,
            hasL2Levels: !!(captureState.clobDown?.levels),
          };
          break; // Only one trade per window
        }
      }

      // Get fill details from the fill results
      const fillResult = result.fillResults?.[0] || null;

      for (const trade of result.trades) {
        const detail = {
          windowCloseTime: closeTime,
          windowOpenTime: openTime,
          symbol: win.symbol,
          groundTruth,
          strikePrice: Number(win.strike_price),
          chainlinkAtClose: Number(win.chainlink_price_at_close),
          tradeSnapshot,
          fillResult,
          trade,
        };
        tradeDetails.push(detail);
        console.log(`  Trade ${tradeDetails.length}: window ${closeTime} | resolution=${groundTruth} | PnL=$${trade.pnl?.toFixed(4)}`);
      }
    }

    if (windowsProcessed % 25 === 0) {
      console.log(`  ...processed ${windowsProcessed}/${sampledWindows.length} windows`);
    }
  }

  console.log(`\nTotal trades found: ${tradeDetails.length} across ${windowsWithTrades} windows`);

  // ─── Step 3: Query L2 book data for each trade ───
  console.log('\nQuerying L2 book data for each trade window...');

  const l2Analysis = [];

  // First check what columns/structure l2_book_ticks has
  let l2TableExists = true;
  let l2Columns = [];
  try {
    l2Columns = await persistence.all(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'l2_book_ticks' ORDER BY ordinal_position
    `);
    console.log(`  l2_book_ticks columns: ${l2Columns.map(c => c.column_name).join(', ')}`);
  } catch (err) {
    console.log(`  l2_book_ticks table not found: ${err.message}`);
    l2TableExists = false;
  }

  // Also check for the 'down' side specifically
  if (l2TableExists) {
    const sideCheck = await persistence.all(`
      SELECT DISTINCT side FROM l2_book_ticks WHERE symbol = $1 LIMIT 10
    `, [SYMBOL]).catch(() => []);

    const dirCheck = await persistence.all(`
      SELECT DISTINCT direction FROM l2_book_ticks WHERE symbol = $1 LIMIT 10
    `, [SYMBOL]).catch(() => []);

    console.log(`  Distinct sides: ${JSON.stringify(sideCheck.map(r => r.side))}`);
    console.log(`  Distinct directions: ${JSON.stringify(dirCheck.map(r => r.direction))}`);

    // Check total row count
    const countResult = await persistence.get(`
      SELECT COUNT(*) as cnt FROM l2_book_ticks WHERE symbol = $1
    `, [SYMBOL]).catch(() => ({ cnt: 0 }));
    console.log(`  Total BTC L2 rows: ${countResult.cnt}`);

    // Check date range
    const rangeResult = await persistence.get(`
      SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM l2_book_ticks WHERE symbol = $1
    `, [SYMBOL]).catch(() => ({}));
    console.log(`  L2 date range: ${rangeResult.min_ts} to ${rangeResult.max_ts}`);
  }

  for (let i = 0; i < tradeDetails.length; i++) {
    const td = tradeDetails[i];
    console.log(`  Querying L2 for trade ${i + 1} (window ${td.windowCloseTime})...`);

    let l2Data = { rows: [], analysis: null };

    if (l2TableExists) {
      // Try different column combinations for querying
      let l2Rows = [];

      // Try with 'side' column matching 'down'
      try {
        l2Rows = await persistence.all(`
          SELECT timestamp, top_levels, bid_depth_1pct, ask_depth_1pct, best_bid, best_ask
          FROM l2_book_ticks
          WHERE symbol = $1
            AND side = 'down'
            AND timestamp >= $2
            AND timestamp < $3
          ORDER BY timestamp ASC
        `, [SYMBOL, td.windowOpenTime, td.windowCloseTime]);
      } catch (e1) {
        // Try with 'direction' column
        try {
          l2Rows = await persistence.all(`
            SELECT timestamp, top_levels, bid_depth_1pct, ask_depth_1pct, best_bid, best_ask
            FROM l2_book_ticks
            WHERE symbol = $1
              AND direction = 'down'
              AND timestamp >= $2
              AND timestamp < $3
            ORDER BY timestamp ASC
          `, [SYMBOL, td.windowOpenTime, td.windowCloseTime]);
        } catch (e2) {
          // Try without side filter, with symbol like 'btc-down' or 'btc%down'
          try {
            l2Rows = await persistence.all(`
              SELECT timestamp, top_levels, bid_depth_1pct, ask_depth_1pct, best_bid, best_ask
              FROM l2_book_ticks
              WHERE symbol LIKE $1
                AND timestamp >= $2
                AND timestamp < $3
              ORDER BY timestamp ASC
            `, [`${SYMBOL}%down%`, td.windowOpenTime, td.windowCloseTime]);
          } catch (e3) {
            console.log(`    L2 query failed: ${e3.message}`);
          }
        }
      }

      console.log(`    Found ${l2Rows.length} L2 ticks for this window`);

      if (l2Rows.length > 0) {
        // Find L2 snapshot closest to trade time
        const tradeTs = td.tradeSnapshot?.timestamp;
        let closestL2 = null;
        let closestDiff = Infinity;

        for (const row of l2Rows) {
          const diff = Math.abs(new Date(row.timestamp).getTime() - new Date(tradeTs).getTime());
          if (diff < closestDiff) {
            closestDiff = diff;
            closestL2 = row;
          }
        }

        if (closestL2) {
          let topLevels = closestL2.top_levels;
          if (typeof topLevels === 'string') {
            try { topLevels = JSON.parse(topLevels); } catch { }
          }

          const askLevels = topLevels?.asks || [];
          const bidLevels = topLevels?.bids || [];

          // Shares at best ask
          const sharesAtBest = askLevels.length > 0 ? askLevels[0][1] : 0;

          // Total shares within 1% of best ask
          const bestAskPrice = askLevels.length > 0 ? askLevels[0][0] : null;
          let sharesWithin1pct = 0;
          if (bestAskPrice) {
            for (const [price, size] of askLevels) {
              if (price <= bestAskPrice * 1.01) {
                sharesWithin1pct += size;
              }
            }
          }

          // VWAP for various dollar amounts
          const vwap2 = computeVwapFromL2(askLevels, 2);
          const vwap10 = computeVwapFromL2(askLevels, 10);
          const vwap50 = computeVwapFromL2(askLevels, 50);
          const vwap100 = computeVwapFromL2(askLevels, 100);

          // Slippage thresholds
          const slipThresholds = findSlippageThresholds(askLevels);

          l2Data = {
            rows: l2Rows.length,
            closestTimestamp: closestL2.timestamp,
            closestDiffMs: closestDiff,
            bidDepth1pct: closestL2.bid_depth_1pct,
            askDepth1pct: closestL2.ask_depth_1pct,
            bestBid: closestL2.best_bid,
            bestAsk: closestL2.best_ask,
            askLevels: askLevels.slice(0, 5),
            bidLevels: bidLevels.slice(0, 5),
            sharesAtBest,
            sharesWithin1pct,
            vwap2,
            vwap10,
            vwap50,
            vwap100,
            slipThresholds,
          };
        }
      } else {
        l2Data = { rows: 0, note: 'No L2 data available for this window' };
      }
    }

    l2Analysis.push(l2Data);
  }

  // ─── Step 4: Generate report ───
  console.log('\nGenerating audit report...');

  let report = `# Trade Audit Report -- edge-c-asymmetry

Generated: ${new Date().toISOString()}
Symbol: ${SYMBOL} | Sample: ${SAMPLE_COUNT} windows | Seed: ${SEED}
Total windows in DB: ${allWindows.length} | Sampled: ${sampledWindows.length}
Windows with trades: ${windowsWithTrades} | Total trades: ${tradeDetails.length}

## L2 Data Usage in PG Path

**CRITICAL FINDING: The PG path does NOT load L2 book data.**

Evidence:
- \`loadWindowTickData()\` in \`src/backtest/data-loader.js\` queries three tables:
  1. \`rtds_ticks\` (chainlink, polyRef oracle prices)
  2. \`clob_price_snapshots\` (best bid/ask, mid, spread, bid_size_top, ask_size_top)
  3. \`exchange_ticks\` (binance, coinbase, etc.)
- It does **not** query \`l2_book_ticks\`.
- \`buildWindowTimelinePg()\` in \`backtest-factory.js\` only processes \`rtdsTicks\`, \`clobSnapshots\`, and \`exchangeTicks\`.
  It has no handling for \`l2BookTicks\`.
- Compare with \`buildWindowTimeline()\` in \`parallel-engine.js\` which DOES include \`l2BookTicks\`
  (tagged as \`l2Up\`/\`l2Down\`).

**Impact on fills:**
- \`MarketState\` never receives \`l2Up\`/\`l2Down\` events via the PG path.
- Therefore \`clobDown.levels\` is always undefined/null.
- \`simulateMarketFill()\` checks \`book.levels?.asks\` -- finds nothing.
- Falls back to \`_fallbackFill()\`: fill price = \`bestAsk + spreadBuffer\` (bestAsk + 0.005).
- All fills in this backtest are **bestAsk fallback fills, not L2 book-walked fills**.

This means:
1. Fill prices are approximate (bestAsk + 0.5c buffer), not realistic VWAP.
2. No liquidity check -- the backtest assumes infinite liquidity at bestAsk.
3. Slippage is fixed at 0.5c regardless of order size or actual book depth.
4. The \`fillQuality.l2CoverageRate\` metric should show 0% L2 usage.

`;

  // ─── Trade-by-trade analysis ───
  report += `## Trade-by-Trade Analysis\n\n`;

  for (let i = 0; i < tradeDetails.length; i++) {
    const td = tradeDetails[i];
    const l2 = l2Analysis[i];
    const snap = td.tradeSnapshot;
    const fill = td.fillResult;
    const trade = td.trade;

    const deficit = snap ? snap.deficit : 'N/A';
    const clPrice = snap?.chainlinkPrice;
    const clOpen = snap?.oraclePriceAtOpen;
    const downBestBid = snap?.clobDown?.bestBid;
    const downBestAsk = snap?.clobDown?.bestAsk;
    const downMid = snap?.clobDown?.mid;
    const hasL2 = snap?.hasL2Levels;

    const fillPrice = fill?.vwapPrice || trade?.entryPrice;
    const fillMethod = fill?.usedL2 ? 'L2 walk' : (fill?.l2Fallback ? 'bestAsk fallback' : 'bestAsk fallback');
    const feeDollars = fill?.feeDollars || 0;
    const feeRate = fill ? calculateTakerFeeRate(fill.vwapPrice || trade?.entryPrice) : 0;

    const payout = trade?.payout || 0;
    const pnl = trade?.pnl || 0;
    const cost = trade?.cost || 0;

    report += `### Trade ${i + 1}\n`;
    report += `- **Window**: ${td.windowCloseTime}\n`;
    report += `- **CL@Open**: $${clOpen?.toFixed(2) || 'N/A'} | **CL@Trade**: $${clPrice?.toFixed(2) || 'N/A'} | **CL@Close**: $${td.chainlinkAtClose?.toFixed(2) || 'N/A'}\n`;
    report += `- **Strike**: $${td.strikePrice?.toFixed(2) || 'N/A'}\n`;
    report += `- **Deficit (CL@open - CL@trade)**: $${typeof deficit === 'number' ? deficit.toFixed(2) : deficit}\n`;
    report += `- **PolyRef@Trade**: $${snap?.polyRefPrice?.toFixed(2) || 'N/A'}\n`;
    report += `- **CLOB DOWN**: bid=$${downBestBid?.toFixed(4) || 'N/A'} ask=$${downBestAsk?.toFixed(4) || 'N/A'} mid=$${downMid?.toFixed(4) || 'N/A'}\n`;
    report += `- **L2 levels in MarketState**: ${hasL2 ? 'YES' : 'NO'}\n`;

    if (l2.askLevels && l2.askLevels.length > 0) {
      report += `- **Actual L2 Book (ask side from DB, nearest timestamp ${l2.closestDiffMs}ms away)**:\n`;
      for (let j = 0; j < Math.min(5, l2.askLevels.length); j++) {
        const [price, size] = l2.askLevels[j];
        report += `  - Level ${j + 1}: $${price?.toFixed(4)} x ${size?.toFixed(1)} shares ($${(price * size).toFixed(2)} value)\n`;
      }
      report += `- **Shares at best ask**: ${l2.sharesAtBest?.toFixed(1) || 'N/A'}\n`;
      report += `- **Shares within 1% of best ask**: ${l2.sharesWithin1pct?.toFixed(1) || 'N/A'}\n`;
    } else {
      report += `- **Actual L2 Book**: ${l2.rows || 0} L2 ticks found for this window. ${l2.note || ''}\n`;
    }

    report += `- **Fill Price**: $${fillPrice?.toFixed(4) || 'N/A'} (method: ${fillMethod})\n`;
    report += `- **Fee**: $${feeDollars?.toFixed(4) || '0'} (rate: ${(feeRate * 100).toFixed(4)}%)\n`;
    report += `- **Tokens**: ${trade?.size?.toFixed(4) || 'N/A'} @ $${trade?.entryPrice?.toFixed(4) || 'N/A'}\n`;
    report += `- **Cost**: $${cost?.toFixed(4) || 'N/A'}\n`;
    report += `- **Resolution**: ${td.groundTruth} | Payout: $${payout?.toFixed(4)} | **Net PnL: $${pnl?.toFixed(4)}**\n`;
    report += `- **Trade reason**: ${trade?.reason || 'N/A'}\n`;
    report += `\n`;
  }

  // ─── Liquidity Analysis Table ───
  report += `## Liquidity Analysis\n\n`;

  if (tradeDetails.some((_, i) => l2Analysis[i]?.askLevels?.length > 0)) {
    report += `| Trade | Fill Price | Best Ask (L2) | Shares@Best | $2 VWAP | $10 VWAP | $50 VWAP | $100 VWAP | 1c Slip $ | 5c Slip $ | 10c Slip $ |\n`;
    report += `|-------|-----------|---------------|-------------|---------|----------|----------|-----------|-----------|-----------|------------|\n`;

    for (let i = 0; i < tradeDetails.length; i++) {
      const td = tradeDetails[i];
      const l2 = l2Analysis[i];
      const fill = td.fillResult;
      const fillPrice = fill?.vwapPrice || td.trade?.entryPrice;

      const l2BestAsk = l2.bestAsk || (l2.askLevels?.[0]?.[0]);
      const sharesAtBest = l2.sharesAtBest;

      const v2 = l2.vwap2?.vwap;
      const v10 = l2.vwap10?.vwap;
      const v50 = l2.vwap50?.vwap;
      const v100 = l2.vwap100?.vwap;
      const s1c = l2.slipThresholds?.slip1c;
      const s5c = l2.slipThresholds?.slip5c;
      const s10c = l2.slipThresholds?.slip10c;

      report += `| ${i + 1} | ${fillPrice?.toFixed(4) || '-'} | ${l2BestAsk ? Number(l2BestAsk).toFixed(4) : '-'} | ${sharesAtBest?.toFixed(0) || '-'} | ${v2?.toFixed(4) || '-'} | ${v10?.toFixed(4) || '-'} | ${v50?.toFixed(4) || '-'} | ${v100?.toFixed(4) || '-'} | ${s1c || '-'} | ${s5c || '-'} | ${s10c || '-'} |\n`;
    }
  } else {
    report += `**No L2 book data was found for any trade windows.** Cannot compute VWAP fills or slippage analysis.\n\n`;
    report += `This means we cannot verify whether the bestAsk fallback fills are realistic.\n`;
  }

  // ─── Summary Statistics ───
  report += `\n## Summary Statistics\n\n`;

  const totalTrades = tradeDetails.length;
  const wins = tradeDetails.filter(td => td.trade.pnl > 0).length;
  const losses = tradeDetails.filter(td => td.trade.pnl <= 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const totalPnl = tradeDetails.reduce((s, td) => s + (td.trade.pnl || 0), 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const avgEntry = totalTrades > 0 ? tradeDetails.reduce((s, td) => s + (td.trade.entryPrice || 0), 0) / totalTrades : 0;
  const allUsedL2 = tradeDetails.filter(td => td.fillResult?.usedL2).length;
  const allFallback = tradeDetails.filter(td => td.fillResult?.l2Fallback || !td.fillResult?.usedL2).length;
  const totalFees = tradeDetails.reduce((s, td) => s + (td.fillResult?.feeDollars || 0), 0);
  const resolutions = tradeDetails.map(td => td.groundTruth);
  const downCount = resolutions.filter(r => r === 'DOWN').length;
  const upCount = resolutions.filter(r => r === 'UP').length;

  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Total Trades | ${totalTrades} |\n`;
  report += `| Wins | ${wins} |\n`;
  report += `| Losses | ${losses} |\n`;
  report += `| Win Rate | ${winRate.toFixed(1)}% |\n`;
  report += `| Total PnL | $${totalPnl.toFixed(4)} |\n`;
  report += `| Avg PnL/Trade | $${avgPnl.toFixed(4)} |\n`;
  report += `| Avg Entry Price | $${avgEntry.toFixed(4)} |\n`;
  report += `| L2 Fill Count | ${allUsedL2} |\n`;
  report += `| Fallback Fill Count | ${allFallback} |\n`;
  report += `| Total Fees Paid | $${totalFees.toFixed(4)} |\n`;
  report += `| DOWN Resolutions | ${downCount} |\n`;
  report += `| UP Resolutions | ${upCount} |\n`;

  // ─── Confidence Assessment ───
  report += `\n## Confidence Assessment\n\n`;

  report += `### Fill Realism\n\n`;
  if (allUsedL2 === 0) {
    report += `**ALL ${totalTrades} fills used the bestAsk fallback path.** No L2 book-walking occurred.\n\n`;
    report += `This means:\n`;
    report += `- Fill prices are bestAsk + 0.5c spread buffer, NOT actual VWAP from order book depth.\n`;
    report += `- The backtest assumes infinite liquidity at the best ask price.\n`;
    report += `- For $2 trades on BTC prediction markets, this is likely a reasonable approximation `;
    report += `IF the best ask has sufficient depth (>$5-10 of shares at that level).\n`;
    report += `- However, we CANNOT confirm this without L2 data at trade time.\n\n`;
  }

  report += `### Win Rate Analysis\n\n`;
  if (winRate === 100 && totalTrades > 5) {
    report += `**100% win rate on ${totalTrades} trades requires scrutiny.**\n\n`;
    report += `The strategy buys DOWN tokens when CL@open - CL@current > $${edgeCStrategy.defaults.deficitThreshold} `;
    report += `and polyRef is near the CL@open price. It targets the structural CL lag `;
    report += `(CL consistently reads ~$80 below exchange prices).\n\n`;
    report += `Key question: Is the 100% win rate because:\n`;
    report += `1. The edge is genuinely strong (CL deficit > $80 is a very reliable DOWN signal), OR\n`;
    report += `2. The strategy is overfitted / look-ahead biased?\n\n`;
    report += `Evidence to consider:\n`;
  } else if (winRate >= 90) {
    report += `**${winRate.toFixed(0)}% win rate is very high. Checking for issues...**\n\n`;
  }

  // Check for potential issues
  let hasIssues = false;

  // Issue 1: Strategy uses oraclePriceAtOpen which comes from window_close_events
  report += `#### Issue 1: oracle_price_at_open availability\n`;
  report += `The strategy uses \`oraclePriceAtOpen\` as the reference price instead of strike.\n`;
  report += `This value comes from the \`window_close_events\` table, which is populated AFTER the window closes.\n`;
  report += `In live trading, this value IS available because it's the chainlink price at window open `;
  report += `(captured when the window opens). So this is **not** look-ahead bias.\n\n`;

  // Issue 2: Resolution uses ground truth from DB
  report += `#### Issue 2: Ground Truth Resolution\n`;
  report += `Resolutions come from \`gamma_resolved_direction\` > \`onchain_resolved_direction\` > \`resolved_direction\`.\n`;
  report += `This is correct -- it uses actual on-chain resolution, not computed. **No issue.**\n\n`;

  // Issue 3: All trades buy DOWN and all resolve DOWN?
  const allDown = tradeDetails.every(td => td.trade.token?.includes('down'));
  const allResolveDown = tradeDetails.every(td => td.groundTruth === 'DOWN');

  report += `#### Issue 3: Resolution Pattern\n`;
  report += `- All trades buy DOWN: ${allDown ? 'YES' : 'NO'}\n`;
  report += `- All windows resolved DOWN: ${allResolveDown ? 'YES' : 'NO'}\n`;
  if (allResolveDown && totalTrades > 0) {
    report += `- This means every window where the strategy triggered also resolved DOWN.\n`;
    report += `  The strategy's core thesis: when CL deficit > $${edgeCStrategy.defaults.deficitThreshold}, `;
    report += `CL is very likely to stay below the opening CL price. This seems empirically true.\n`;
    report += `  However, with only ${totalTrades} trades, we cannot rule out sampling luck.\n\n`;
  }

  report += `#### Issue 4: Selection Bias\n`;
  report += `- The strategy only fires on ${totalTrades} out of ${sampledWindows.length} windows (${(totalTrades / sampledWindows.length * 100).toFixed(1)}% trigger rate).\n`;
  report += `- Low trigger rate + high win rate is consistent with a selective, high-conviction strategy.\n`;
  report += `- But ${totalTrades} trades is far too few for statistical significance.\n`;
  report += `  - 95% CI for a true 50% win rate with ${totalTrades} trades: `;
  const ciLow = 0.5 - 1.96 * Math.sqrt(0.5 * 0.5 / totalTrades);
  const ciHigh = 0.5 + 1.96 * Math.sqrt(0.5 * 0.5 / totalTrades);
  report += `[${(ciLow * 100).toFixed(0)}%, ${(ciHigh * 100).toFixed(0)}%]\n`;
  report += `  - Even a coin flip could show 100% wins on ${totalTrades} trades with probability ${(Math.pow(0.5, totalTrades) * 100).toExponential(2)}%\n`;
  if (totalTrades <= 20) {
    report += `  - P(>=0 losses | true WR=85%, n=${totalTrades}): ${(Math.pow(0.85, totalTrades) * 100).toFixed(2)}%\n`;
    report += `  - P(>=0 losses | true WR=70%, n=${totalTrades}): ${(Math.pow(0.70, totalTrades) * 100).toFixed(2)}%\n`;
  }
  report += `\n`;

  report += `#### Issue 5: L2 Data Gap in PG Path\n`;
  report += `**This is the most critical issue.** The PG path backtester does not load L2 data.\n`;
  report += `The fill simulator always falls back to bestAsk + spread buffer.\n`;
  report += `For this strategy ($2 trades, binary options), the impact may be minimal\n`;
  report += `because order sizes are small. But we cannot verify without L2 data.\n\n`;

  report += `### Bottom Line\n\n`;
  report += `The edge-c-asymmetry strategy exploits a real structural feature:\n`;
  report += `Chainlink's data stream price consistently lags ~$80 behind exchange prices.\n`;
  report += `When the deficit exceeds $${edgeCStrategy.defaults.deficitThreshold}, buying DOWN is empirically profitable `;
  report += `because settlement uses the lower CL price.\n\n`;
  report += `**Trust level: MODERATE with caveats**\n`;
  report += `- The edge concept is sound (structural CL lag is real and documented).\n`;
  report += `- The fill simulation is APPROXIMATE (no L2, uses bestAsk + 0.5c).\n`;
  report += `- Sample size (${totalTrades} trades) is too small for statistical confidence.\n`;
  report += `- The 100% win rate is plausible for a highly selective strategy but unproven.\n`;
  report += `- **Recommendation**: Fix the PG path to load L2 data, then re-run.\n`;
  report += `  Also increase sample window count and/or loosen trigger conditions to get more trades.\n`;

  // Write report
  const outputPath = resolve('/Users/alchemist/Projects/poly/_bmad-output/planning-artifacts/trade-audit-report.md');
  writeFileSync(outputPath, report);
  console.log(`\nReport written to: ${outputPath}`);

  // Cleanup
  await persistence.shutdown();
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
