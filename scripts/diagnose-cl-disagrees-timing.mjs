#!/usr/bin/env node

/**
 * Diagnostic: CL Disagrees With CLOB — Timing & Delta Analysis
 *
 * For every BTC window, replays the timeline and records EVERY tick where
 * CL disagrees with CLOB (not just the first). Then bins by:
 *   - timeToCloseMs bucket (T-60, T-50, T-40, T-30, T-20, T-10, T-5)
 *   - CL delta bucket ($0-5, $5-10, $10-20, $20-50, $50+)
 *
 * This tells us WHERE the signal works: at what timing and delta.
 */

import {
  loadWindowTickData,
  loadWindowsWithGroundTruth,
  getTickDateRange,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { createMarketState } from '../src/backtest/market-state.js';

const MIN_CLOB_CONFIDENCE = 0.60;
const MAX_CLOB_CONFIDENCE = 0.80;
const MAX_ENTRY_PRICE = 0.45;
const ENTRY_WINDOW_MS = 60000;
const WINDOW_DURATION_MS = 5 * 60 * 1000;

// Time buckets (seconds before close)
const TIME_BUCKETS = [
  { label: 'T-60→50', min: 50000, max: 60000 },
  { label: 'T-50→40', min: 40000, max: 50000 },
  { label: 'T-40→30', min: 30000, max: 40000 },
  { label: 'T-30→20', min: 20000, max: 30000 },
  { label: 'T-20→10', min: 10000, max: 20000 },
  { label: 'T-10→5',  min: 5000,  max: 10000 },
  { label: 'T-5→0',   min: 0,     max: 5000 },
];

// CL delta buckets (dollars from CL@open)
const DELTA_BUCKETS = [
  { label: '$0-5',   min: 0,  max: 5 },
  { label: '$5-10',  min: 5,  max: 10 },
  { label: '$10-20', min: 10, max: 20 },
  { label: '$20-50', min: 20, max: 50 },
  { label: '$50+',   min: 50, max: Infinity },
];

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

function mergeTimeline(rtds, clob, exchange) {
  const all = [...rtds, ...clob, ...exchange];
  all.sort((a, b) => a._ms - b._ms);
  return all;
}

async function main() {
  console.log('=== CL Disagrees Timing & Delta Diagnostic ===\n');

  const dateRange = await getTickDateRange();
  let windows = await loadWindowsWithGroundTruth({
    startDate: dateRange.earliest,
    endDate: dateRange.latest,
  });

  // BTC only, with ground truth
  windows = windows.filter(w =>
    w.symbol?.toLowerCase() === 'btc' &&
    (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
      (w.chainlink_price_at_close && w.oracle_price_at_open))
  );

  console.log(`Windows: ${windows.length} BTC\n`);

  // Track: for each qualifying tick, record time bucket, delta bucket, win/loss
  // Also track "first qualifying per window" and "last qualifying per window"
  const allSignals = [];         // every qualifying tick
  const firstPerWindow = [];     // first qualifying tick per window
  const lastPerWindow = [];      // last qualifying tick per window (latest entry = closest to T-0)

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    const groundTruth = getGroundTruth(win);
    if (!groundTruth) continue;

    const windowData = await loadWindowTickData({ window: win, windowDurationMs: WINDOW_DURATION_MS });
    precomputeTimestamps(windowData);
    tagSources(windowData);
    const timeline = mergeTimeline(windowData.rtdsTicks, windowData.clobSnapshots, windowData.exchangeTicks);

    const state = createMarketState();
    const closeMs = new Date(win.window_close_time).getTime();
    const openMs = closeMs - WINDOW_DURATION_MS;
    state.setWindow(win, new Date(openMs).toISOString());

    const clOpen = state.oraclePriceAtOpen || state.strike;
    if (clOpen == null) continue;

    const windowSignals = [];

    for (const event of timeline) {
      const eventMs = event._ms;
      if (eventMs < openMs || eventMs >= closeMs) continue;

      state.processEvent(event);
      state.updateTimeToClose(event.timestamp);

      const { chainlink, clobUp, clobDown, window: stWin } = state;
      if (!chainlink?.price || !clobUp || !clobDown || !stWin) continue;

      const timeToCloseMs = stWin.timeToCloseMs;
      if (timeToCloseMs == null || timeToCloseMs >= ENTRY_WINDOW_MS) continue;

      // CL direction
      const clAboveOpen = chainlink.price - clOpen;
      const clDir = clAboveOpen >= 0 ? 'UP' : 'DOWN';
      const clDelta = Math.abs(clAboveOpen);

      // CLOB direction and confidence
      const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
      if (clobConfidence < MIN_CLOB_CONFIDENCE || clobConfidence >= MAX_CLOB_CONFIDENCE) continue;
      const clobDir = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';

      // Must disagree
      if (clobDir === clDir) continue;

      // Check price affordability
      let entryPrice;
      if (clDir === 'UP') {
        entryPrice = clobUp.bestAsk;
      } else {
        entryPrice = clobDown.bestAsk;
      }

      const priceOk = entryPrice <= MAX_ENTRY_PRICE;

      // Would this trade win?
      const wouldWin = groundTruth === clDir;

      windowSignals.push({
        timeToCloseMs,
        clDelta,
        entryPrice,
        priceOk,
        clDir,
        clobDir,
        clobConfidence,
        wouldWin,
        groundTruth,
      });
    }

    if (windowSignals.length > 0) {
      // All signals (even if price too high)
      for (const sig of windowSignals) {
        allSignals.push(sig);
      }
      firstPerWindow.push(windowSignals[0]);
      lastPerWindow.push(windowSignals[windowSignals.length - 1]);
    }

    if ((wi + 1) % 100 === 0) {
      process.stdout.write(`\r  Processed ${wi + 1}/${windows.length} windows...`);
    }
  }

  console.log(`\r  Processed ${windows.length}/${windows.length} windows.`);
  console.log(`\nTotal qualifying ticks: ${allSignals.length}`);
  console.log(`Windows with signal: ${firstPerWindow.length}`);

  // ─── Analysis 1: All ticks by time bucket ───
  console.log('\n=== ALL QUALIFYING TICKS BY TIME BUCKET ===');
  console.log('(Every tick where CL disagrees with CLOB 60-80%)\n');
  console.log('Time Bucket  | Total |  Wins | WR%   | AvgDelta | PriceOk | PriceOk WR%');
  console.log('-'.repeat(80));

  for (const tb of TIME_BUCKETS) {
    const inBucket = allSignals.filter(s => s.timeToCloseMs >= tb.min && s.timeToCloseMs < tb.max);
    const wins = inBucket.filter(s => s.wouldWin);
    const priceOk = inBucket.filter(s => s.priceOk);
    const priceOkWins = priceOk.filter(s => s.wouldWin);
    const avgDelta = inBucket.length > 0 ? inBucket.reduce((s, x) => s + x.clDelta, 0) / inBucket.length : 0;

    console.log(
      `${tb.label.padEnd(12)} | ${String(inBucket.length).padStart(5)} | ${String(wins.length).padStart(5)} | ${(inBucket.length > 0 ? (wins.length / inBucket.length * 100).toFixed(1) : '0.0').padStart(5)}% | $${avgDelta.toFixed(1).padStart(7)} | ${String(priceOk.length).padStart(7)} | ${(priceOk.length > 0 ? (priceOkWins.length / priceOk.length * 100).toFixed(1) : '0.0').padStart(5)}%`
    );
  }

  // ─── Analysis 2: All ticks by delta bucket ───
  console.log('\n=== ALL QUALIFYING TICKS BY CL DELTA BUCKET ===\n');
  console.log('Delta Bucket | Total |  Wins | WR%   | AvgT(s) | PriceOk | PriceOk WR%');
  console.log('-'.repeat(80));

  for (const db of DELTA_BUCKETS) {
    const inBucket = allSignals.filter(s => s.clDelta >= db.min && s.clDelta < db.max);
    const wins = inBucket.filter(s => s.wouldWin);
    const priceOk = inBucket.filter(s => s.priceOk);
    const priceOkWins = priceOk.filter(s => s.wouldWin);
    const avgT = inBucket.length > 0 ? inBucket.reduce((s, x) => s + x.timeToCloseMs, 0) / inBucket.length / 1000 : 0;

    console.log(
      `${db.label.padEnd(12)} | ${String(inBucket.length).padStart(5)} | ${String(wins.length).padStart(5)} | ${(inBucket.length > 0 ? (wins.length / inBucket.length * 100).toFixed(1) : '0.0').padStart(5)}% | ${avgT.toFixed(1).padStart(7)} | ${String(priceOk.length).padStart(7)} | ${(priceOk.length > 0 ? (priceOkWins.length / priceOk.length * 100).toFixed(1) : '0.0').padStart(5)}%`
    );
  }

  // ─── Analysis 3: 2D heatmap (time × delta) — WR for price-ok ticks only ───
  console.log('\n=== 2D HEATMAP: WR% (price-affordable ticks only) ===');
  console.log('Rows = time bucket, Cols = delta bucket\n');

  const header = 'Time\\Delta   | ' + DELTA_BUCKETS.map(d => d.label.padStart(8)).join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const tb of TIME_BUCKETS) {
    const cells = DELTA_BUCKETS.map(db => {
      const inCell = allSignals.filter(s =>
        s.timeToCloseMs >= tb.min && s.timeToCloseMs < tb.max &&
        s.clDelta >= db.min && s.clDelta < db.max &&
        s.priceOk
      );
      const wins = inCell.filter(s => s.wouldWin);
      if (inCell.length === 0) return '   -   '.padStart(8);
      return `${(wins.length / inCell.length * 100).toFixed(0)}%(${inCell.length})`.padStart(8);
    });
    console.log(`${tb.label.padEnd(12)} | ${cells.join(' | ')}`);
  }

  // ─── Analysis 4: First-entry vs last-entry per window ───
  console.log('\n=== FIRST vs LAST ENTRY PER WINDOW ===');
  console.log('(If strategy fired on first qualifying tick vs last qualifying tick)\n');

  const firstPriceOk = firstPerWindow.filter(s => s.priceOk);
  const firstWins = firstPriceOk.filter(s => s.wouldWin);
  const lastPriceOk = lastPerWindow.filter(s => s.priceOk);
  const lastWins = lastPriceOk.filter(s => s.wouldWin);

  const firstMedianT = firstPriceOk.length > 0
    ? firstPriceOk.map(s => s.timeToCloseMs).sort((a, b) => a - b)[Math.floor(firstPriceOk.length / 2)] / 1000
    : 0;
  const lastMedianT = lastPriceOk.length > 0
    ? lastPriceOk.map(s => s.timeToCloseMs).sort((a, b) => a - b)[Math.floor(lastPriceOk.length / 2)] / 1000
    : 0;
  const firstMedianDelta = firstPriceOk.length > 0
    ? firstPriceOk.map(s => s.clDelta).sort((a, b) => a - b)[Math.floor(firstPriceOk.length / 2)]
    : 0;
  const lastMedianDelta = lastPriceOk.length > 0
    ? lastPriceOk.map(s => s.clDelta).sort((a, b) => a - b)[Math.floor(lastPriceOk.length / 2)]
    : 0;

  console.log(`First-entry: ${firstPriceOk.length} trades, ${firstWins.length} wins (${(firstPriceOk.length > 0 ? firstWins.length / firstPriceOk.length * 100 : 0).toFixed(1)}% WR), median T-${firstMedianT.toFixed(0)}s, median Δ$${firstMedianDelta.toFixed(1)}`);
  console.log(`Last-entry:  ${lastPriceOk.length} trades, ${lastWins.length} wins (${(lastPriceOk.length > 0 ? lastWins.length / lastPriceOk.length * 100 : 0).toFixed(1)}% WR), median T-${lastMedianT.toFixed(0)}s, median Δ$${lastMedianDelta.toFixed(1)}`);

  // ─── Analysis 5: Simulated strategies with different entry windows ───
  console.log('\n=== SIMULATED STRATEGIES (first qualifying tick within window) ===\n');

  const entryWindows = [5000, 10000, 15000, 20000, 30000, 60000];
  const minDeltas = [0, 5, 10, 20];

  console.log('EntryWindow | MinDelta | Trades | Wins | WR%   | Est PnL$');
  console.log('-'.repeat(65));

  for (const ew of entryWindows) {
    for (const md of minDeltas) {
      // Simulate: per-window, fire on first qualifying tick within [0, ew) timeToClose and delta >= md
      let trades = 0, wins = 0, pnl = 0;

      for (let wi = 0; wi < windows.length; wi++) {
        const win = windows[wi];
        const gt = getGroundTruth(win);
        if (!gt) continue;

        // Find first qualifying signal in this window for these params
        const windowSigs = allSignals.filter(s => {
          // We don't have window index in allSignals, so we need another approach
          return false; // placeholder
        });
      }

      // Actually, we need to re-structure. Let me use the per-window data we collected.
      // Let me redo this with grouped signals.
    }
  }

  // Actually, let's group signals by window for proper simulation
  // We need to track which window each signal belongs to.
  // Let me redo the collection...

  // Re-run with window tracking
  console.log('(Re-running with per-window simulation...)\n');

  // Collect signals grouped by window
  const windowSignalsMap = new Map(); // windowIndex → signals[]
  let sigIdx = 0;

  // We already have allSignals but don't know which window they belong to.
  // Let me reconstruct from firstPerWindow/lastPerWindow counts.
  // Better: let's just replay again quickly with grouped data.

  const perWindowData = []; // { groundTruth, signals: [...] }

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    const groundTruth = getGroundTruth(win);
    if (!groundTruth) { perWindowData.push(null); continue; }

    const windowData = await loadWindowTickData({ window: win, windowDurationMs: WINDOW_DURATION_MS });
    precomputeTimestamps(windowData);
    tagSources(windowData);
    const timeline = mergeTimeline(windowData.rtdsTicks, windowData.clobSnapshots, windowData.exchangeTicks);

    const state = createMarketState();
    const closeMs = new Date(win.window_close_time).getTime();
    const openMs = closeMs - WINDOW_DURATION_MS;
    state.setWindow(win, new Date(openMs).toISOString());

    const clOpen = state.oraclePriceAtOpen || state.strike;
    if (clOpen == null) { perWindowData.push(null); continue; }

    const signals = [];

    for (const event of timeline) {
      const eventMs = event._ms;
      if (eventMs < openMs || eventMs >= closeMs) continue;

      state.processEvent(event);
      state.updateTimeToClose(event.timestamp);

      const { chainlink, clobUp, clobDown, window: stWin } = state;
      if (!chainlink?.price || !clobUp || !clobDown || !stWin) continue;

      const timeToCloseMs = stWin.timeToCloseMs;
      if (timeToCloseMs == null || timeToCloseMs >= 65000) continue; // wider range for analysis

      const clAboveOpen = chainlink.price - clOpen;
      const clDir = clAboveOpen >= 0 ? 'UP' : 'DOWN';
      const clDelta = Math.abs(clAboveOpen);

      const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
      if (clobConfidence < MIN_CLOB_CONFIDENCE || clobConfidence >= MAX_CLOB_CONFIDENCE) continue;
      const clobDir = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';
      if (clobDir === clDir) continue;

      let entryPrice;
      if (clDir === 'UP') entryPrice = clobUp.bestAsk;
      else entryPrice = clobDown.bestAsk;

      signals.push({
        timeToCloseMs,
        clDelta,
        entryPrice,
        priceOk: entryPrice <= MAX_ENTRY_PRICE,
        wouldWin: groundTruth === clDir,
      });
    }

    perWindowData.push({ groundTruth, signals });

    if ((wi + 1) % 200 === 0) {
      process.stdout.write(`\r  Pass 2: ${wi + 1}/${windows.length}...`);
    }
  }
  console.log(`\r  Pass 2: ${windows.length}/${windows.length} done.`);

  // Now simulate strategies
  console.log('\nEntryWindow | MinDelta | Trades | Wins | WR%   | Est PnL$  | AvgEntry');
  console.log('-'.repeat(75));

  for (const ew of entryWindows) {
    for (const md of minDeltas) {
      let trades = 0, wins = 0, pnl = 0, totalEntry = 0;

      for (const pwd of perWindowData) {
        if (!pwd) continue;
        // First qualifying signal within this entryWindow and minDelta
        const qualifying = pwd.signals.find(s =>
          s.timeToCloseMs < ew && s.clDelta >= md && s.priceOk
        );
        if (!qualifying) continue;

        trades++;
        totalEntry += qualifying.entryPrice;
        if (qualifying.wouldWin) {
          wins++;
          pnl += (1 - qualifying.entryPrice) * 2; // $2 capital, win payout
        } else {
          pnl -= qualifying.entryPrice * 2; // lose the cost
        }
      }

      if (trades === 0) continue;
      const wr = wins / trades * 100;
      const avgEntry = totalEntry / trades;
      console.log(
        `T-${(ew / 1000).toFixed(0).padStart(3)}s    | $${String(md).padStart(4)}     | ${String(trades).padStart(6)} | ${String(wins).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | $${pnl.toFixed(2).padStart(8)} | $${avgEntry.toFixed(3)}`
      );
    }
  }

  // ─── Analysis 6: Last qualifying tick (latest entry) simulation ───
  console.log('\n=== LAST-ENTRY SIMULATION (fire on LAST qualifying tick) ===\n');
  console.log('EntryWindow | MinDelta | Trades | Wins | WR%   | Est PnL$  | AvgEntry | MedianT');
  console.log('-'.repeat(85));

  for (const ew of entryWindows) {
    for (const md of minDeltas) {
      let trades = 0, wins = 0, pnl = 0, totalEntry = 0;
      const entryTimes = [];

      for (const pwd of perWindowData) {
        if (!pwd) continue;
        // LAST qualifying signal within this entryWindow and minDelta
        const qualifyingAll = pwd.signals.filter(s =>
          s.timeToCloseMs < ew && s.clDelta >= md && s.priceOk
        );
        if (qualifyingAll.length === 0) continue;
        const qualifying = qualifyingAll[qualifyingAll.length - 1];

        trades++;
        totalEntry += qualifying.entryPrice;
        entryTimes.push(qualifying.timeToCloseMs);
        if (qualifying.wouldWin) {
          wins++;
          pnl += (1 - qualifying.entryPrice) * 2;
        } else {
          pnl -= qualifying.entryPrice * 2;
        }
      }

      if (trades === 0) continue;
      const wr = wins / trades * 100;
      const avgEntry = totalEntry / trades;
      entryTimes.sort((a, b) => a - b);
      const medianT = entryTimes[Math.floor(entryTimes.length / 2)] / 1000;
      console.log(
        `T-${(ew / 1000).toFixed(0).padStart(3)}s    | $${String(md).padStart(4)}     | ${String(trades).padStart(6)} | ${String(wins).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | $${pnl.toFixed(2).padStart(8)} | $${avgEntry.toFixed(3)}  | T-${medianT.toFixed(0)}s`
      );
    }
  }

  closeSqlite();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  closeSqlite();
  process.exit(1);
});
