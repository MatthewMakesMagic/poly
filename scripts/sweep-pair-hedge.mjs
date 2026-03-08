#!/usr/bin/env node

/**
 * Pair-Hedge Sweep
 *
 * Tests 5 hedge-mode variations of the pair-hedge MM strategy.
 * Computes standard metrics + pair-specific: hedges, pairs, avg pair cost,
 * paired P&L vs unpaired P&L.
 */

import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { gzipSync, gunzipSync } from 'zlib';
import {
  loadWindowTickData,
  loadWindowsWithGroundTruth,
  getTickDateRange,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const SYMBOL = 'btc';
const WINDOW_LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const START_DATE = process.argv.find(a => a.startsWith('--start-date='))?.split('=')[1] || null;
const WINDOW_DURATION_MS = 15 * 60 * 1000;
const INITIAL_CAPITAL = 10000;
const CACHE_PATH = resolve(process.cwd(), 'data', 'timeline-cache.sqlite');

// ── Timeline Cache ──

let cacheDb = null;

function getCacheDb() {
  if (cacheDb) return cacheDb;
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  cacheDb = new Database(CACHE_PATH);
  cacheDb.pragma('journal_mode = WAL');
  cacheDb.pragma('cache_size = -64000');
  cacheDb.exec(`CREATE TABLE IF NOT EXISTS timeline_cache (
    window_key TEXT PRIMARY KEY, timeline BLOB NOT NULL
  )`);
  return cacheDb;
}

function closeCacheDb() { if (cacheDb) { cacheDb.close(); cacheDb = null; } }

function windowCacheKey(win) {
  const ct = win.window_close_time instanceof Date
    ? win.window_close_time.toISOString() : win.window_close_time;
  return `${SYMBOL}:${ct}`;
}

function getCachedTimeline(win) {
  const row = getCacheDb().prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?').get(windowCacheKey(win));
  if (!row) return null;
  return JSON.parse(gunzipSync(row.timeline).toString());
}

function setCachedTimeline(win, timeline) {
  getCacheDb().prepare('INSERT OR REPLACE INTO timeline_cache (window_key, timeline) VALUES (?, ?)').run(windowCacheKey(win), gzipSync(JSON.stringify(timeline)));
}

// ── Source Tagging + Merge ──

function tagSources(data) {
  for (const tick of data.rtdsTicks) {
    const t = tick.topic;
    tick.source = t === 'crypto_prices_chainlink' ? 'chainlink' : t === 'crypto_prices' ? 'polyRef' : `rtds_${t}`;
  }
  for (const snap of data.clobSnapshots) snap.source = snap.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
  for (const tick of data.exchangeTicks) tick.source = `exchange_${tick.exchange}`;
  if (data.coingeckoTicks) for (const tick of data.coingeckoTicks) tick.source = 'coingecko';
  if (data.l2BookTicks) for (const tick of data.l2BookTicks) tick.source = tick.direction === 'down' ? 'l2Down' : 'l2Up';
}

function merge2(a, b) {
  const r = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) r[k++] = a[i]._ms <= b[j]._ms ? a[i++] : b[j++];
  while (i < a.length) r[k++] = a[i++];
  while (j < b.length) r[k++] = b[j++];
  return r;
}

async function loadTimeline(win) {
  const cached = getCachedTimeline(win);
  if (cached) {
    // Verify cache has L2 data (needed for passive fills)
    const hasL2 = cached.some(t => t.source === 'l2Up' || t.source === 'l2Down');
    if (hasL2) return cached;
    // Fall through to reload with L2 data
  }
  const data = await loadWindowTickData({ window: win, windowDurationMs: WINDOW_DURATION_MS });
  precomputeTimestamps(data);
  tagSources(data);
  let tl = merge2(data.rtdsTicks, data.clobSnapshots);
  tl = merge2(tl, data.exchangeTicks);
  if (data.coingeckoTicks?.length) tl = merge2(tl, data.coingeckoTicks);
  if (data.l2BookTicks?.length) tl = merge2(tl, data.l2BookTicks);
  setCachedTimeline(win, tl);
  return tl;
}

// ── Pair Metrics from Trades ──

function computePairMetrics(trades) {
  // Separate passive (natural) entries from hedge entries, per side
  let natUpTokens = 0, natDownTokens = 0, natUpCost = 0, natDownCost = 0;
  let hedgeUpTokens = 0, hedgeDownTokens = 0, hedgeUpCost = 0, hedgeDownCost = 0;
  let hedgeCount = 0, passiveCount = 0;
  let sellCloseCount = 0, sellClosePnl = 0;

  for (const t of trades) {
    if (t.exitReason && t.exitReason !== 'resolution') {
      sellCloseCount++;
      sellClosePnl += t.pnl;
      continue;
    }
    const isUp = !t.token.toLowerCase().includes('down');
    const isHedge = t.reason?.startsWith('hedge:');
    if (isUp) {
      if (isHedge) { hedgeUpTokens += t.size; hedgeUpCost += t.cost; hedgeCount++; }
      else { natUpTokens += t.size; natUpCost += t.cost; passiveCount++; }
    } else {
      if (isHedge) { hedgeDownTokens += t.size; hedgeDownCost += t.cost; hedgeCount++; }
      else { natDownTokens += t.size; natDownCost += t.cost; passiveCount++; }
    }
  }

  // Natural pairs: pair natural UP with natural DOWN
  const naturalPaired = Math.min(natUpTokens, natDownTokens);
  const natUpAvg = natUpTokens > 0 ? natUpCost / natUpTokens : 0;
  const natDownAvg = natDownTokens > 0 ? natDownCost / natDownTokens : 0;
  const naturalPairCost = naturalPaired > 0 ? natUpAvg + natDownAvg : 0;
  const naturalPairPnl = naturalPaired * (1.00 - naturalPairCost);

  // Excess natural tokens need pairing with hedge tokens on opposite side
  const excessNatUp = natUpTokens - naturalPaired;
  const excessNatDown = natDownTokens - naturalPaired;

  let hedgePaired = 0, hedgePairCost = 0, hedgePairPnl = 0;
  if (excessNatUp > 0 && hedgeDownTokens > 0) {
    hedgePaired = Math.min(excessNatUp, hedgeDownTokens);
    const hedgeDownAvg = hedgeDownCost / hedgeDownTokens;
    hedgePairCost = natUpAvg + hedgeDownAvg;
    hedgePairPnl = hedgePaired * (1.00 - hedgePairCost);
  } else if (excessNatDown > 0 && hedgeUpTokens > 0) {
    hedgePaired = Math.min(excessNatDown, hedgeUpTokens);
    const hedgeUpAvg = hedgeUpCost / hedgeUpTokens;
    hedgePairCost = hedgeUpAvg + natDownAvg;
    hedgePairPnl = hedgePaired * (1.00 - hedgePairCost);
  }

  const totalPaired = naturalPaired + hedgePaired;
  const totalUpTokens = natUpTokens + hedgeUpTokens;
  const totalDownTokens = natDownTokens + hedgeDownTokens;
  const unpairedTokens = Math.abs(totalUpTokens - totalDownTokens);
  const pairedPnl = naturalPairPnl + hedgePairPnl;
  const avgPairCost = totalPaired > 0
    ? (naturalPaired * naturalPairCost + hedgePaired * hedgePairCost) / totalPaired : 0;

  return {
    pairedTokens: totalPaired, unpairedTokens, avgPairCost, pairedPnl,
    hedgeCount, passiveCount, sellCloseCount, sellClosePnl,
    // Breakdown
    naturalPaired, naturalPairCost, naturalPairPnl,
    hedgePaired, hedgePairCost, hedgePairPnl,
  };
}

// ── Main ──

async function main() {
  const t0 = Date.now();
  console.log('=== Pair-Hedge Sweep ===\n');

  // Load strategy
  const stratMod = await import(pathToFileURL(resolve(process.cwd(), 'src/backtest/strategies/mm-cs-pair-hedge.js')).href);
  const strategy = {
    name: stratMod.name,
    evaluate: stratMod.evaluate,
    onWindowOpen: stratMod.onWindowOpen,
    onPassiveFill: stratMod.onPassiveFill,
    onAggressiveFill: stratMod.onAggressiveFill,
    onSell: stratMod.onSell,
    usesPassiveOrders: stratMod.usesPassiveOrders,
    defaults: stratMod.defaults,
    variations: stratMod.variations,
  };

  // Build combos
  const combos = strategy.variations.map((v, i) => {
    const config = { ...strategy.defaults, ...v };
    const keys = Object.keys(v);
    const label = keys.map(k => `${k}=${v[k]}`).join(', ');
    return { config, label: `V${i + 1}: ${label}`, variation: v };
  });

  console.log(`Variations: ${combos.length}`);
  for (const c of combos) console.log(`  ${c.label}`);

  // Load windows
  const dateRange = await getTickDateRange();
  let allWindows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
  allWindows = allWindows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );
  let windows = allWindows.filter(w => w.symbol?.toLowerCase() === SYMBOL);

  // Optional start date filter (useful for L2 data which starts Feb 22)
  if (START_DATE) {
    const startMs = new Date(START_DATE).getTime();
    windows = windows.filter(w => new Date(w.window_close_time).getTime() >= startMs);
  }

  if (WINDOW_LIMIT > 0) windows = windows.slice(0, WINDOW_LIMIT);
  console.log(`\nWindows: ${windows.length} (${SYMBOL.toUpperCase()})\n`);

  // Per-combo: array of per-window results
  const comboWindowResults = combos.map(() => []);

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    const timeline = await loadTimeline(win);

    for (let ci = 0; ci < combos.length; ci++) {
      const result = evaluateWindow({
        window: win,
        timeline,
        strategy,
        strategyConfig: combos[ci].config,
        initialCapital: INITIAL_CAPITAL,
        spreadBuffer: 0.005,
        tradingFee: 0,
        windowDurationMs: WINDOW_DURATION_MS,
      });
      comboWindowResults[ci].push(result);
    }

    if ((wi + 1) % 20 === 0 || wi === windows.length - 1) {
      const pct = ((wi + 1) / windows.length * 100).toFixed(0);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`\r  Window ${wi + 1}/${windows.length} (${pct}%) — ${elapsed}s elapsed    `);
    }
  }
  console.log('\n');

  closeSqlite();
  closeCacheDb();

  // ── Aggregate + Analyze ──

  function r(v, d) { return v == null || !Number.isFinite(v) ? 0 : Math.round(v * 10 ** d) / 10 ** d; }

  const results = [];
  for (let ci = 0; ci < combos.length; ci++) {
    const wr = comboWindowResults[ci];
    let totalPnl = 0, totalTrades = 0, totalWins = 0;
    let winningWindows = 0, activeWindows = 0;
    const allTrades = [];

    // Pair metrics accumulators
    let totalPairedTokens = 0, totalUnpairedTokens = 0;
    let totalHedges = 0, totalPassiveFills = 0;
    let pairCostSum = 0, pairCostCount = 0;
    let totalPairedPnl = 0;
    let totalSellCloses = 0, totalSellClosePnl = 0;
    // Breakdown accumulators
    let totalNatPaired = 0, totalNatPairPnl = 0, natPCSum = 0, natPCCount = 0;
    let totalHedgePaired = 0, totalHedgePairPnl = 0, hedgePCSum = 0, hedgePCCount = 0;

    for (const res of wr) {
      totalPnl += res.pnl;
      totalTrades += res.tradesInWindow;
      if (res.tradesInWindow > 0) activeWindows++;
      if (res.pnl > 0) winningWindows++;

      for (const t of res.trades) {
        allTrades.push(t);
        if (t.pnl > 0) totalWins++;
      }

      // Per-window pair metrics
      const pm = computePairMetrics(res.trades);
      totalPairedTokens += pm.pairedTokens;
      totalUnpairedTokens += pm.unpairedTokens;
      totalHedges += pm.hedgeCount;
      totalPassiveFills += pm.passiveCount;
      totalPairedPnl += pm.pairedPnl;
      totalSellCloses += pm.sellCloseCount;
      totalSellClosePnl += pm.sellClosePnl;
      if (pm.pairedTokens > 0) {
        pairCostSum += pm.avgPairCost * pm.pairedTokens;
        pairCostCount += pm.pairedTokens;
      }
      // Breakdown
      totalNatPaired += pm.naturalPaired;
      totalNatPairPnl += pm.naturalPairPnl;
      if (pm.naturalPaired > 0) { natPCSum += pm.naturalPairCost * pm.naturalPaired; natPCCount += pm.naturalPaired; }
      totalHedgePaired += pm.hedgePaired;
      totalHedgePairPnl += pm.hedgePairPnl;
      if (pm.hedgePaired > 0) { hedgePCSum += pm.hedgePairCost * pm.hedgePaired; hedgePCCount += pm.hedgePaired; }
    }

    const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const winTrades = allTrades.filter(t => t.pnl > 0);
    const lossTrades = allTrades.filter(t => t.pnl <= 0);
    const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
    const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;

    // Drawdown
    let running = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxDD = 0;
    for (const res of wr.sort((a, b) => new Date(a.windowCloseTime) - new Date(b.windowCloseTime))) {
      running += res.pnl;
      if (running > peak) peak = running;
      const dd = peak > 0 ? (peak - running) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    const avgPairCost = pairCostCount > 0 ? pairCostSum / pairCostCount : 0;
    const unpairedPnl = totalPnl - totalPairedPnl;

    results.push({
      label: combos[ci].label,
      variation: combos[ci].variation,
      totalPnl: r(totalPnl, 2),
      totalTrades,
      totalWins,
      winRate: r(totalWins / Math.max(1, totalTrades) * 100, 1),
      pf: r(pf, 3),
      avgWin: r(avgWin, 4),
      avgLoss: r(avgLoss, 4),
      maxDD: r(maxDD * 100, 2),
      winningWindows,
      activeWindows,
      grossProfit: r(grossProfit, 2),
      grossLoss: r(grossLoss, 2),
      finalCapital: r(running, 2),
      // Pair-specific
      hedges: totalHedges,
      passiveFills: totalPassiveFills,
      pairedTokens: r(totalPairedTokens, 2),
      unpairedTokens: r(totalUnpairedTokens, 2),
      avgPairCost: r(avgPairCost, 4),
      pairedPnl: r(totalPairedPnl, 2),
      unpairedPnl: r(unpairedPnl, 2),
      sellCloses: totalSellCloses,
      sellClosePnl: r(totalSellClosePnl, 2),
      // Breakdown
      naturalPaired: r(totalNatPaired, 2),
      naturalPairCost: natPCCount > 0 ? r(natPCSum / natPCCount, 4) : 0,
      naturalPairPnl: r(totalNatPairPnl, 2),
      hedgePaired: r(totalHedgePaired, 2),
      hedgePairCost: hedgePCCount > 0 ? r(hedgePCSum / hedgePCCount, 4) : 0,
      hedgePairPnl: r(totalHedgePairPnl, 2),
    });
  }

  // ── Print Results ──

  const W = 185;
  console.log('='.repeat(W));
  console.log(`PAIR-HEDGE SWEEP — ${combos.length} variations × ${windows.length} windows (BTC)`);
  console.log(`Time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('='.repeat(W));
  console.log('');

  // Main table
  const header =
    '#'.padStart(2) + ' | ' +
    'Variation'.padEnd(55) + ' | ' +
    'PnL $'.padStart(10) + ' | ' +
    'Trades'.padStart(7) + ' | ' +
    'WR%'.padStart(6) + ' | ' +
    'PF'.padStart(6) + ' | ' +
    'Hedges'.padStart(7) + ' | ' +
    'Pairs'.padStart(8) + ' | ' +
    'AvgPC'.padStart(7) + ' | ' +
    'PairPnL'.padStart(9) + ' | ' +
    'UnprPnL'.padStart(9) + ' | ' +
    'WinWin'.padStart(7) + ' | ' +
    'MaxDD%'.padStart(7);
  console.log(header);
  console.log('-'.repeat(W));

  for (let i = 0; i < results.length; i++) {
    const x = results[i];
    const pnlStr = (x.totalPnl >= 0 ? '+' : '') + '$' + x.totalPnl;
    const pairPnlStr = (x.pairedPnl >= 0 ? '+' : '') + '$' + x.pairedPnl;
    const unprPnlStr = (x.unpairedPnl >= 0 ? '+' : '') + '$' + x.unpairedPnl;
    console.log(
      String(i + 1).padStart(2) + ' | ' +
      x.label.padEnd(55).slice(0, 55) + ' | ' +
      pnlStr.padStart(10) + ' | ' +
      String(x.totalTrades).padStart(7) + ' | ' +
      (x.winRate + '%').padStart(6) + ' | ' +
      String(x.pf).padStart(6) + ' | ' +
      String(x.hedges).padStart(7) + ' | ' +
      String(x.pairedTokens).padStart(8) + ' | ' +
      ('$' + x.avgPairCost).padStart(7) + ' | ' +
      pairPnlStr.padStart(9) + ' | ' +
      unprPnlStr.padStart(9) + ' | ' +
      String(x.winningWindows).padStart(7) + ' | ' +
      (x.maxDD + '%').padStart(7)
    );
  }
  console.log('='.repeat(W));

  // ── Detailed per-variation breakdown ──

  console.log('\n=== DETAILED BREAKDOWN ===\n');

  for (const x of results) {
    console.log(`--- ${x.label} ---`);
    console.log(`  PnL: $${x.totalPnl}  |  Final Capital: $${x.finalCapital}  |  Max DD: ${x.maxDD}%`);
    console.log(`  Trades: ${x.totalTrades}  |  Wins: ${x.totalWins}  |  Win Rate: ${x.winRate}%  |  Profit Factor: ${x.pf}`);
    console.log(`  Avg Win: $${x.avgWin}  |  Avg Loss: $${x.avgLoss}`);
    console.log(`  Gross Profit: $${x.grossProfit}  |  Gross Loss: $${x.grossLoss}`);
    console.log(`  Windows: ${x.activeWindows} active / ${windows.length - x.activeWindows} inactive  |  Winning: ${x.winningWindows}`);
    console.log(`  --- Pair Metrics ---`);
    console.log(`  Passive Fills: ${x.passiveFills}  |  Aggressive Hedges: ${x.hedges}`);
    console.log(`  Natural Pairs: ${x.naturalPaired}  |  Cost: $${x.naturalPairCost}  |  PnL: $${x.naturalPairPnl}`);
    console.log(`  Hedge Pairs:   ${x.hedgePaired}  |  Cost: $${x.hedgePairCost}  |  PnL: $${x.hedgePairPnl}`);
    console.log(`  Total Paired:  ${x.pairedTokens}  |  Avg Cost: $${x.avgPairCost}  |  Total Pair PnL: $${x.pairedPnl}`);
    console.log(`  Unpaired Tokens: ${x.unpairedTokens}  |  Unpaired PnL: $${x.unpairedPnl}`);
    if (x.sellCloses > 0) {
      console.log(`  Sell-to-Close: ${x.sellCloses} positions  |  Sell PnL: $${x.sellClosePnl}`);
    }
    console.log('');
  }

  // BS null diagnostics
  if (stratMod.getBsNullReasons) {
    const r = stratMod.getBsNullReasons();
    console.log('=== BS FAIR VALUE DIAGNOSTICS ===');
    console.log(`  OK (returned value): ${r.ok.toLocaleString()}`);
    console.log(`  NULL — no CL spot:   ${r.noSpot.toLocaleString()}`);
    console.log(`  NULL — no CL@open:   ${r.noClOpen.toLocaleString()}`);
    console.log(`  NULL — expired:      ${r.expired.toLocaleString()}`);
    console.log(`  NULL — few samples:  ${r.fewSamples.toLocaleString()} (need ${strategy.defaults.minVolSamples}+)`);
    console.log(`  NULL — few returns:  ${r.fewReturns.toLocaleString()} (need 5+ after gap filter)`);
    console.log(`  NULL — zero time:    ${r.zeroTime.toLocaleString()}`);
    console.log(`  NULL — zero vol:     ${r.zeroVol.toLocaleString()}`);
    const total = r.ok + r.noSpot + r.noClOpen + r.expired + r.fewSamples + r.fewReturns + r.zeroTime + r.zeroVol;
    const nullPct = total > 0 ? ((total - r.ok) / total * 100).toFixed(1) : 0;
    console.log(`  Total calls: ${total.toLocaleString()} — ${nullPct}% returned null`);
    console.log('');
  }

  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message, err.stack); process.exit(1); });
