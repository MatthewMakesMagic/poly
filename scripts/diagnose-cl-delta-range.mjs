#!/usr/bin/env node

/**
 * Quick diagnostic: count unique windows per heatmap cell and simulate
 * strategies with both minDelta AND maxDelta constraints.
 */

import {
  loadWindowTickData,
  loadWindowsWithGroundTruth,
  getTickDateRange,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { createMarketState } from '../src/backtest/market-state.js';

const WINDOW_DURATION_MS = 5 * 60 * 1000;

function getGroundTruth(win) {
  if (win.gamma_resolved_direction) return win.gamma_resolved_direction.toUpperCase();
  if (win.onchain_resolved_direction) return win.onchain_resolved_direction.toUpperCase();
  if (win.resolved_direction) return win.resolved_direction.toUpperCase();
  const clClose = Number(win.chainlink_price_at_close);
  const clOpen = Number(win.oracle_price_at_open);
  if (clClose && clOpen) return clClose >= clOpen ? 'UP' : 'DOWN';
  return null;
}

function tagSources(data) {
  for (const tick of data.rtdsTicks) {
    if (tick.topic === 'crypto_prices_chainlink') tick.source = 'chainlink';
    else if (tick.topic === 'crypto_prices') tick.source = 'polyRef';
    else tick.source = `rtds_${tick.topic}`;
  }
  for (const snap of data.clobSnapshots) {
    snap.source = snap.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
  }
  for (const tick of data.exchangeTicks) {
    tick.source = `exchange_${tick.exchange}`;
  }
}

async function main() {
  console.log('=== CL Delta Range Analysis ===\n');

  const dateRange = await getTickDateRange();
  let windows = await loadWindowsWithGroundTruth({
    startDate: dateRange.earliest,
    endDate: dateRange.latest,
  });

  windows = windows.filter(w =>
    w.symbol?.toLowerCase() === 'btc' &&
    (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
      (w.chainlink_price_at_close && w.oracle_price_at_open))
  );

  console.log(`Windows: ${windows.length} BTC\n`);

  // Collect per-window signal data
  // For each window: { groundTruth, signals: [{ timeToCloseMs, clDelta, entryPrice, wouldWin }] }
  const perWindow = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    const groundTruth = getGroundTruth(win);
    if (!groundTruth) continue;

    const windowData = await loadWindowTickData({ window: win, windowDurationMs: WINDOW_DURATION_MS });
    precomputeTimestamps(windowData);
    tagSources(windowData);

    const all = [...windowData.rtdsTicks, ...windowData.clobSnapshots, ...windowData.exchangeTicks];
    all.sort((a, b) => a._ms - b._ms);

    const state = createMarketState();
    const closeMs = new Date(win.window_close_time).getTime();
    const openMs = closeMs - WINDOW_DURATION_MS;
    state.setWindow(win, new Date(openMs).toISOString());

    const clOpen = state.oraclePriceAtOpen || state.strike;
    if (clOpen == null) continue;

    const signals = [];

    for (const event of all) {
      if (event._ms < openMs || event._ms >= closeMs) continue;

      state.processEvent(event);
      state.updateTimeToClose(event.timestamp);

      const { chainlink, clobUp, clobDown, window: stWin } = state;
      if (!chainlink?.price || !clobUp || !clobDown || !stWin) continue;

      const timeToCloseMs = stWin.timeToCloseMs;
      if (timeToCloseMs == null || timeToCloseMs >= 65000) continue;

      const clAboveOpen = chainlink.price - clOpen;
      const clDir = clAboveOpen >= 0 ? 'UP' : 'DOWN';
      const clDelta = Math.abs(clAboveOpen);

      const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
      if (clobConfidence < 0.60 || clobConfidence >= 0.80) continue;
      const clobDir = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';
      if (clobDir === clDir) continue;

      let entryPrice;
      if (clDir === 'UP') entryPrice = clobUp.bestAsk;
      else entryPrice = clobDown.bestAsk;

      signals.push({
        timeToCloseMs,
        clDelta,
        entryPrice,
        priceOk: entryPrice <= 0.45,
        clDir,
        wouldWin: groundTruth === clDir,
      });
    }

    perWindow.push({ wi, groundTruth, signals, windowTime: win.window_close_time });

    if ((wi + 1) % 200 === 0) process.stdout.write(`\r  ${wi + 1}/${windows.length}...`);
  }
  console.log(`\r  ${windows.length}/${windows.length} done. ${perWindow.length} windows with GT.`);

  // ─── Count unique windows per heatmap cell ───
  console.log('\n=== UNIQUE WINDOWS PER HEATMAP CELL ===');
  console.log('(wins/total windows that have ANY qualifying tick in this cell)\n');

  const TIME_BUCKETS = [
    { label: 'T-60→50', min: 50000, max: 60000 },
    { label: 'T-50→40', min: 40000, max: 50000 },
    { label: 'T-40→30', min: 30000, max: 40000 },
    { label: 'T-30→20', min: 20000, max: 30000 },
    { label: 'T-20→10', min: 10000, max: 20000 },
    { label: 'T-10→5',  min: 5000,  max: 10000 },
    { label: 'T-5→0',   min: 0,     max: 5000 },
  ];

  const DELTA_BUCKETS = [
    { label: '$0-5',   min: 0,  max: 5 },
    { label: '$5-10',  min: 5,  max: 10 },
    { label: '$10-20', min: 10, max: 20 },
    { label: '$20-50', min: 20, max: 50 },
    { label: '$50+',   min: 50, max: Infinity },
  ];

  const header = 'Time\\Delta   | ' + DELTA_BUCKETS.map(d => d.label.padStart(10)).join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const tb of TIME_BUCKETS) {
    const cells = DELTA_BUCKETS.map(db => {
      // Count unique windows that have at least one qualifying tick in this cell
      let winWindows = 0, totalWindows = 0;

      for (const pw of perWindow) {
        const hasTickInCell = pw.signals.some(s =>
          s.timeToCloseMs >= tb.min && s.timeToCloseMs < tb.max &&
          s.clDelta >= db.min && s.clDelta < db.max &&
          s.priceOk
        );
        if (hasTickInCell) {
          totalWindows++;
          // Did this window resolve in CL's direction?
          // Use the first qualifying tick's clDir to determine
          const firstTick = pw.signals.find(s =>
            s.timeToCloseMs >= tb.min && s.timeToCloseMs < tb.max &&
            s.clDelta >= db.min && s.clDelta < db.max &&
            s.priceOk
          );
          if (firstTick.wouldWin) winWindows++;
        }
      }

      if (totalWindows === 0) return '     -    '.padStart(10);
      return `${winWindows}/${totalWindows}=${(winWindows / totalWindows * 100).toFixed(0)}%`.padStart(10);
    });
    console.log(`${tb.label.padEnd(12)} | ${cells.join(' | ')}`);
  }

  // ─── Simulate with delta RANGE constraints ───
  console.log('\n=== PER-WINDOW SIMULATION WITH DELTA RANGE ===');
  console.log('(First qualifying tick within time window AND delta range, price <= $0.45)\n');

  const configs = [
    // { entryMs, minDelta, maxDelta }
    { entryMs: 60000, minD: 5, maxD: 10, label: 'T-60, Δ$5-10' },
    { entryMs: 30000, minD: 5, maxD: 10, label: 'T-30, Δ$5-10' },
    { entryMs: 15000, minD: 5, maxD: 10, label: 'T-15, Δ$5-10' },
    { entryMs: 10000, minD: 5, maxD: 10, label: 'T-10, Δ$5-10' },
    { entryMs: 60000, minD: 5, maxD: 15, label: 'T-60, Δ$5-15' },
    { entryMs: 30000, minD: 5, maxD: 15, label: 'T-30, Δ$5-15' },
    { entryMs: 15000, minD: 5, maxD: 15, label: 'T-15, Δ$5-15' },
    { entryMs: 10000, minD: 5, maxD: 15, label: 'T-10, Δ$5-15' },
    { entryMs: 60000, minD: 3, maxD: 10, label: 'T-60, Δ$3-10' },
    { entryMs: 30000, minD: 3, maxD: 10, label: 'T-30, Δ$3-10' },
    { entryMs: 15000, minD: 3, maxD: 10, label: 'T-15, Δ$3-10' },
    { entryMs: 10000, minD: 3, maxD: 10, label: 'T-10, Δ$3-10' },
    { entryMs: 60000, minD: 0, maxD: 10, label: 'T-60, Δ$0-10' },
    { entryMs: 30000, minD: 0, maxD: 10, label: 'T-30, Δ$0-10' },
    { entryMs: 60000, minD: 0, maxD: Infinity, label: 'T-60, any Δ' },
    { entryMs: 30000, minD: 0, maxD: Infinity, label: 'T-30, any Δ' },
    { entryMs: 15000, minD: 0, maxD: Infinity, label: 'T-15, any Δ' },
    { entryMs: 10000, minD: 0, maxD: Infinity, label: 'T-10, any Δ' },
    // Last entry variants
    { entryMs: 60000, minD: 5, maxD: 10, label: 'LAST T-60,Δ$5-10', lastEntry: true },
    { entryMs: 30000, minD: 5, maxD: 10, label: 'LAST T-30,Δ$5-10', lastEntry: true },
    { entryMs: 15000, minD: 5, maxD: 10, label: 'LAST T-15,Δ$5-10', lastEntry: true },
    { entryMs: 10000, minD: 5, maxD: 10, label: 'LAST T-10,Δ$5-10', lastEntry: true },
  ];

  console.log('Config                 | Trades | Wins | WR%   | PnL$     | $/Trade  | AvgEntry | MedianT');
  console.log('-'.repeat(100));

  for (const cfg of configs) {
    let trades = 0, wins = 0, pnl = 0, totalEntry = 0;
    const entryTimes = [];

    for (const pw of perWindow) {
      const qualifying = pw.signals.filter(s =>
        s.timeToCloseMs < cfg.entryMs &&
        s.clDelta >= cfg.minD &&
        s.clDelta < cfg.maxD &&
        s.priceOk
      );
      if (qualifying.length === 0) continue;

      const sig = cfg.lastEntry ? qualifying[qualifying.length - 1] : qualifying[0];

      trades++;
      totalEntry += sig.entryPrice;
      entryTimes.push(sig.timeToCloseMs);
      if (sig.wouldWin) {
        wins++;
        pnl += (1 - sig.entryPrice) * 2;
      } else {
        pnl -= sig.entryPrice * 2;
      }
    }

    if (trades === 0) {
      console.log(`${cfg.label.padEnd(22)} |      0 |    0 |    -  |       -  |       -  |       -  |      -`);
      continue;
    }

    entryTimes.sort((a, b) => a - b);
    const medianT = entryTimes[Math.floor(entryTimes.length / 2)] / 1000;

    console.log(
      `${cfg.label.padEnd(22)} | ${String(trades).padStart(6)} | ${String(wins).padStart(4)} | ${(wins / trades * 100).toFixed(1).padStart(5)}% | $${pnl.toFixed(2).padStart(7)} | $${(pnl / trades).toFixed(3).padStart(7)} | $${(totalEntry / trades).toFixed(3).padStart(7)} | T-${medianT.toFixed(0)}s`
    );
  }

  // ─── Weekly breakdown for best config ───
  console.log('\n=== WEEKLY BREAKDOWN: LAST T-60, Δ$5-10 ===\n');

  const weeklyTrades = {};
  for (const pw of perWindow) {
    const qualifying = pw.signals.filter(s =>
      s.timeToCloseMs < 60000 &&
      s.clDelta >= 5 && s.clDelta < 10 &&
      s.priceOk
    );
    if (qualifying.length === 0) continue;
    const sig = qualifying[qualifying.length - 1]; // last entry

    const d = new Date(pw.windowTime);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const weekKey = weekStart.toISOString().slice(0, 10);

    if (!weeklyTrades[weekKey]) weeklyTrades[weekKey] = { trades: 0, wins: 0, pnl: 0 };
    weeklyTrades[weekKey].trades++;
    if (sig.wouldWin) {
      weeklyTrades[weekKey].wins++;
      weeklyTrades[weekKey].pnl += (1 - sig.entryPrice) * 2;
    } else {
      weeklyTrades[weekKey].pnl -= sig.entryPrice * 2;
    }
  }

  console.log('Week         | Trades | Wins | WR%   | PnL$');
  console.log('-'.repeat(55));
  for (const [week, data] of Object.entries(weeklyTrades).sort()) {
    console.log(
      `${week.padEnd(12)} | ${String(data.trades).padStart(6)} | ${String(data.wins).padStart(4)} | ${(data.wins / data.trades * 100).toFixed(1).padStart(5)}% | $${data.pnl.toFixed(2)}`
    );
  }

  closeSqlite();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  closeSqlite();
  process.exit(1);
});
