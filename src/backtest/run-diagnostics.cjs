/**
 * Strategy Workshop Diagnostics + Edge D Backtest
 *
 * Runs against pre-computed window_backtest_states (fast-track table):
 *   1. Which exchange tracks Chainlink closest?
 *   2. How much does Chainlink move in final 2 minutes?
 *   3. Edge D: Structural DOWN Base Rate backtest + sweep
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-diagnostics.cjs
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
  statement_timeout: 30000,
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// ─── Helpers ───

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

// ════════════════════════════════════════════════════════════════
// DIAGNOSTIC 1: Which exchange tracks Chainlink closest?
// ════════════════════════════════════════════════════════════════

async function diagnostic1() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC 1: Exchange → Chainlink Tracking Accuracy');
  console.log('═══════════════════════════════════════════════════════════\n');

  // At 1 min before close, how close is each feed to chainlink_at_close?
  const rows = await query(`
    SELECT
      exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
      polyref_price, chainlink_price, chainlink_at_close, strike_price, resolved_direction
    FROM window_backtest_states
    WHERE offset_ms = 60000
      AND chainlink_at_close IS NOT NULL
  `);

  console.log(`  Sample: ${rows.length} windows at offset_ms=60000 (1 min before close)\n`);

  // Feed-level error analysis
  const feeds = [
    { name: 'polyRef', key: 'polyref_price' },
    { name: 'binance', key: 'exchange_binance' },
    { name: 'coinbase', key: 'exchange_coinbase' },
    { name: 'kraken', key: 'exchange_kraken' },
    { name: 'bybit', key: 'exchange_bybit' },
    { name: 'okx', key: 'exchange_okx' },
  ];

  const feedStats = feeds.map(feed => {
    const errors = [];
    const absErrors = [];
    let available = 0;
    let correctDirection = 0;

    for (const row of rows) {
      const price = row[feed.key] ? parseFloat(row[feed.key]) : null;
      const clClose = parseFloat(row.chainlink_at_close);
      const strike = parseFloat(row.strike_price);
      if (price == null || isNaN(price)) continue;
      available++;

      const err = price - clClose;
      errors.push(err);
      absErrors.push(Math.abs(err));

      // Does this feed predict direction correctly?
      // If (price - deficit_estimate) > strike, predict UP, else DOWN
      // Use simple comparison: if price > strike and CL > strike → both agree
      const feedPrediction = (price - 80) > strike ? 'UP' : 'DOWN';
      if (feedPrediction === row.resolved_direction) correctDirection++;
    }

    return {
      name: feed.name,
      available,
      avgErr: errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : null,
      avgAbsErr: absErrors.length > 0 ? absErrors.reduce((s, e) => s + e, 0) / absErrors.length : null,
      medianAbsErr: median(absErrors),
      maxAbsErr: absErrors.length > 0 ? Math.max(...absErrors) : null,
      directionAccuracy: available > 0 ? correctDirection / available : 0,
      correctDirection,
    };
  });

  // Sort by median absolute error (closest to Chainlink)
  feedStats.sort((a, b) => (a.medianAbsErr || Infinity) - (b.medianAbsErr || Infinity));

  console.log('  Feed Tracking (sorted by median |error| from chainlink_at_close):');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log('  Feed       │ Avail │ Avg Error  │ Avg |Error| │ Med |Error| │ Max |Error| │ Dir Acc');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  for (const f of feedStats) {
    if (f.available === 0) {
      console.log(`  ${f.name.padEnd(10)} │ ${String(0).padStart(5)} │ no data`);
      continue;
    }
    console.log(
      `  ${f.name.padEnd(10)} │ ${String(f.available).padStart(5)} │ $${f.avgErr.toFixed(1).padStart(8)} │ $${f.avgAbsErr.toFixed(1).padStart(10)} │ $${f.medianAbsErr.toFixed(1).padStart(10)} │ $${f.maxAbsErr.toFixed(1).padStart(10)} │ ${(f.directionAccuracy * 100).toFixed(1).padStart(5)}%`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log('  Note: Dir Acc = direction prediction using feed_price - $80 vs strike\n');

  // Also: 5-exchange median vs polyRef
  let medianBetter = 0, polyRefBetter = 0, medianAvailable = 0;
  const medianErrors = [];
  const polyRefErrors = [];

  for (const row of rows) {
    const prices = [
      row.exchange_binance, row.exchange_coinbase, row.exchange_kraken,
      row.exchange_bybit, row.exchange_okx,
    ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));

    if (prices.length < 3) continue;
    medianAvailable++;

    const exMedian = median(prices);
    const clClose = parseFloat(row.chainlink_at_close);
    const polyRef = row.polyref_price ? parseFloat(row.polyref_price) : null;

    const medErr = Math.abs(exMedian - clClose);
    medianErrors.push(medErr);

    if (polyRef != null) {
      const prErr = Math.abs(polyRef - clClose);
      polyRefErrors.push(prErr);
      if (medErr < prErr) medianBetter++;
      else polyRefBetter++;
    }
  }

  console.log('  5-Exchange Median vs PolyRef (predicting chainlink_at_close):');
  console.log(`    Windows with 3+ exchanges: ${medianAvailable}`);
  console.log(`    Exchange median avg |error|: $${(medianErrors.reduce((s,e) => s+e, 0) / medianErrors.length).toFixed(1)}`);
  console.log(`    PolyRef avg |error|:         $${(polyRefErrors.reduce((s,e) => s+e, 0) / polyRefErrors.length).toFixed(1)}`);
  console.log(`    Median closer: ${medianBetter} windows (${pct(medianBetter, medianAvailable)}%)`);
  console.log(`    PolyRef closer: ${polyRefBetter} windows (${pct(polyRefBetter, medianAvailable)}%)`);
  console.log();

  return feedStats;
}

// ════════════════════════════════════════════════════════════════
// DIAGNOSTIC 2: Chainlink movement in final 2 minutes
// ════════════════════════════════════════════════════════════════

async function diagnostic2() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC 2: Chainlink Movement in Final 2 Minutes');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get chainlink at offsets 120000, 60000, and 0 for each window
  const rows = await query(`
    SELECT
      w120.window_close_time,
      w120.chainlink_price AS cl_2min,
      w60.chainlink_price AS cl_1min,
      w0.chainlink_price AS cl_close,
      w120.strike_price,
      w120.resolved_direction
    FROM window_backtest_states w120
    JOIN window_backtest_states w60
      ON w120.window_close_time = w60.window_close_time
      AND w120.symbol = w60.symbol
      AND w60.offset_ms = 60000
    JOIN window_backtest_states w0
      ON w120.window_close_time = w0.window_close_time
      AND w120.symbol = w0.symbol
      AND w0.offset_ms = 0
    WHERE w120.offset_ms = 120000
      AND w120.chainlink_price IS NOT NULL
      AND w60.chainlink_price IS NOT NULL
      AND w0.chainlink_price IS NOT NULL
  `);

  console.log(`  Sample: ${rows.length} windows with CL data at 2min/1min/close\n`);

  const deltas2to1 = []; // CL movement from 2min to 1min before close
  const deltas1to0 = []; // CL movement from 1min to close
  const deltas2to0 = []; // CL movement from 2min to close

  let clFalling = 0, clFallingDown = 0;
  let clRising = 0, clRisingUp = 0;
  let clFlat = 0;

  for (const row of rows) {
    const cl2 = parseFloat(row.cl_2min);
    const cl1 = parseFloat(row.cl_1min);
    const cl0 = parseFloat(row.cl_close);

    deltas2to1.push(cl1 - cl2);
    deltas1to0.push(cl0 - cl1);
    deltas2to0.push(cl0 - cl2);

    // Direction based on 2min → 1min movement
    const delta = cl1 - cl2;
    if (delta < -1) {
      clFalling++;
      if (row.resolved_direction === 'DOWN') clFallingDown++;
    } else if (delta > 1) {
      clRising++;
      if (row.resolved_direction === 'UP') clRisingUp++;
    } else {
      clFlat++;
    }
  }

  const abs2to1 = deltas2to1.map(Math.abs);
  const abs1to0 = deltas1to0.map(Math.abs);
  const abs2to0 = deltas2to0.map(Math.abs);

  console.log('  CL Price Movement Magnitude:');
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  Period        │ Avg |Δ| │ Median |Δ| │ P95 |Δ|  │ Max |Δ|');
  console.log('  ────────────────────────────────────────────────────────');

  const stats = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return {
      avg: arr.reduce((s, v) => s + v, 0) / arr.length,
      med: median(arr),
      p95,
      max: Math.max(...arr),
    };
  };

  const s21 = stats(abs2to1);
  const s10 = stats(abs1to0);
  const s20 = stats(abs2to0);

  console.log(`  2min → 1min   │ $${s21.avg.toFixed(1).padStart(6)} │ $${s21.med.toFixed(1).padStart(9)} │ $${s21.p95.toFixed(1).padStart(8)} │ $${s21.max.toFixed(1).padStart(7)}`);
  console.log(`  1min → close  │ $${s10.avg.toFixed(1).padStart(6)} │ $${s10.med.toFixed(1).padStart(9)} │ $${s10.p95.toFixed(1).padStart(8)} │ $${s10.max.toFixed(1).padStart(7)}`);
  console.log(`  2min → close  │ $${s20.avg.toFixed(1).padStart(6)} │ $${s20.med.toFixed(1).padStart(9)} │ $${s20.p95.toFixed(1).padStart(8)} │ $${s20.max.toFixed(1).padStart(7)}`);
  console.log('  ────────────────────────────────────────────────────────\n');

  console.log('  CL Direction vs Resolution (2min→1min movement, threshold ±$1):');
  console.log(`    CL Falling (< -$1):  ${clFalling} windows, ${clFallingDown} resolved DOWN (${pct(clFallingDown, clFalling)}%)`);
  console.log(`    CL Rising  (> +$1):  ${clRising} windows, ${clRisingUp} resolved UP (${pct(clRisingUp, clRising)}%)`);
  console.log(`    CL Flat    (±$1):    ${clFlat} windows`);
  console.log();

  // Bucketized analysis
  console.log('  CL Movement Buckets (2min→1min Δ) vs Resolution:');
  console.log('  ──────────────────────────────────────────────────────');
  console.log('  Bucket       │ Count │ DOWN │ UP   │ DOWN%');
  console.log('  ──────────────────────────────────────────────────────');

  const buckets = [
    { label: '< -$20', test: d => d < -20 },
    { label: '-$20 to -$10', test: d => d >= -20 && d < -10 },
    { label: '-$10 to -$1', test: d => d >= -10 && d < -1 },
    { label: '±$1 (flat)', test: d => d >= -1 && d <= 1 },
    { label: '+$1 to +$10', test: d => d > 1 && d <= 10 },
    { label: '+$10 to +$20', test: d => d > 10 && d <= 20 },
    { label: '> +$20', test: d => d > 20 },
  ];

  for (const bucket of buckets) {
    const matching = rows.filter((row, i) => bucket.test(deltas2to1[i]));
    const down = matching.filter(r => r.resolved_direction === 'DOWN').length;
    const up = matching.filter(r => r.resolved_direction === 'UP').length;
    console.log(
      `  ${bucket.label.padEnd(14)} │ ${String(matching.length).padStart(5)} │ ${String(down).padStart(4)} │ ${String(up).padStart(4)} │ ${pct(down, matching.length).padStart(5)}%`
    );
  }
  console.log('  ──────────────────────────────────────────────────────\n');

  return { avgDelta2to0: s20.avg, medDelta2to0: s20.med };
}

// ════════════════════════════════════════════════════════════════
// EDGE D: Structural DOWN Base Rate
// ════════════════════════════════════════════════════════════════

async function edgeD() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE D: Structural DOWN Base Rate Backtest');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Load all windows from fast-track
  const rows = await query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_down_mid,
           clob_up_bid, clob_up_ask, clob_up_mid,
           resolved_direction, chainlink_at_close
    FROM window_backtest_states
    ORDER BY window_close_time ASC, offset_ms DESC
  `);

  // Group by window
  const windowMap = new Map();
  for (const row of rows) {
    const key = row.window_close_time.toISOString();
    if (!windowMap.has(key)) {
      windowMap.set(key, { closeTime: row.window_close_time, symbol: row.symbol, samples: [] });
    }
    windowMap.get(key).samples.push(row);
  }
  const windows = Array.from(windowMap.values());

  const upCount = windows.filter(g => g.samples[0]?.resolved_direction === 'UP').length;
  const downCount = windows.filter(g => g.samples[0]?.resolved_direction === 'DOWN').length;

  console.log(`  Windows: ${windows.length} (UP=${upCount}, DOWN=${downCount}, ${pct(downCount, upCount + downCount)}% DOWN)\n`);

  // ─── First: What does DOWN actually cost? ───
  console.log('  ── DOWN Token Pricing Analysis ──\n');

  const asksByOffset = {};
  for (const win of windows) {
    for (const s of win.samples) {
      const ask = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      if (ask == null || isNaN(ask) || ask <= 0 || ask >= 1) continue;
      const off = s.offset_ms;
      if (!asksByOffset[off]) asksByOffset[off] = [];
      asksByOffset[off].push(ask);
    }
  }

  console.log('  DOWN Ask by Time-to-Close:');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  Offset    │ Samples │ Avg Ask │ Med Ask │ Min Ask │ Max Ask');
  console.log('  ──────────────────────────────────────────────────────────');

  const offsets = Object.keys(asksByOffset).map(Number).sort((a, b) => b - a);
  for (const off of offsets) {
    const asks = asksByOffset[off];
    const avg = asks.reduce((s, v) => s + v, 0) / asks.length;
    const med = median(asks);
    console.log(
      `  ${String(off / 1000).padStart(4)}s    │ ${String(asks.length).padStart(7)} │ ${avg.toFixed(3).padStart(7)} │ ${med.toFixed(3).padStart(7)} │ ${Math.min(...asks).toFixed(3).padStart(7)} │ ${Math.max(...asks).toFixed(3).padStart(7)}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────\n');

  // ─── Edge D Single Run ───
  console.log('  ── Edge D: Single Run (default params) ──\n');

  const defaultConfig = {
    entryWindowMs: 120000,
    maxPrice: 0.65,
    spreadBuffer: 0.005,
    positionSize: 1,
  };

  const result = runEdgeD(windows, defaultConfig, true);
  printEdgeDResult(result);

  // ─── Edge D Parameter Sweep ───
  console.log('\n  ── Edge D: Parameter Sweep ──\n');

  const sweepGrid = {
    entryWindowMs: [30000, 60000, 120000, 180000, 300000],
    maxPrice: [0.45, 0.50, 0.52, 0.55, 0.58, 0.60, 0.65, 0.70],
  };

  const paramSets = [];
  for (const ew of sweepGrid.entryWindowMs) {
    for (const mp of sweepGrid.maxPrice) {
      paramSets.push({ entryWindowMs: ew, maxPrice: mp, spreadBuffer: 0.005, positionSize: 1 });
    }
  }

  const t0 = Date.now();
  const sweepResults = paramSets.map(params => ({
    params,
    result: runEdgeD(windows, params, false),
  }));
  const sweepMs = Date.now() - t0;

  const withTrades = sweepResults
    .filter(s => s.result.stats.tradeCount > 0)
    .map(s => {
      const st = s.result.stats;
      const avgEntry = s.result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / st.tradeCount;
      const evPerTrade = (st.winRate * (1 - avgEntry)) - ((1 - st.winRate) * avgEntry);
      return { ...s, avgEntry, evPerTrade };
    })
    .sort((a, b) => b.evPerTrade - a.evPerTrade);

  console.log(`  ${paramSets.length} configs, sweep in ${sweepMs}ms`);
  console.log(`  ${withTrades.length}/${paramSets.length} produced trades\n`);

  if (withTrades.length > 0) {
    console.log('  Top 15 by EV/trade:');
    console.log('  ────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Window │ MaxPx │ Trades │ WinRate │ AvgEntry │ EV/Trade │ TotalPnL │ MaxDD');
    console.log('  ────────────────────────────────────────────────────────────────────────────────────');
    const top = withTrades.slice(0, 15);
    for (let i = 0; i < top.length; i++) {
      const s = top[i];
      const p = s.params;
      const st = s.result.stats;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String((p.entryWindowMs / 1000) + 's').padStart(6)} │ ${p.maxPrice.toFixed(2).padStart(5)} │ ${String(st.tradeCount).padStart(6)} │ ${(st.winRate * 100).toFixed(1).padStart(6)}% │ ${s.avgEntry.toFixed(4).padStart(8)} │ $${s.evPerTrade.toFixed(4).padStart(7)} │ $${st.totalPnl.toFixed(2).padStart(8)} │ ${(st.maxDrawdown * 100).toFixed(1).padStart(5)}%`
      );
    }
    console.log('  ────────────────────────────────────────────────────────────────────────────────────');

    // Bottom 5
    if (withTrades.length > 15) {
      console.log('\n  Bottom 5 by EV/trade:');
      console.log('  ────────────────────────────────────────────────────────────────────────────────────');
      const bottom = withTrades.slice(-5);
      const startRank = withTrades.length - 4;
      for (let i = 0; i < bottom.length; i++) {
        const s = bottom[i];
        const p = s.params;
        const st = s.result.stats;
        console.log(
          `  ${String(startRank + i).padStart(4)} │ ${String((p.entryWindowMs / 1000) + 's').padStart(6)} │ ${p.maxPrice.toFixed(2).padStart(5)} │ ${String(st.tradeCount).padStart(6)} │ ${(st.winRate * 100).toFixed(1).padStart(6)}% │ ${s.avgEntry.toFixed(4).padStart(8)} │ $${s.evPerTrade.toFixed(4).padStart(7)} │ $${st.totalPnl.toFixed(2).padStart(8)} │ ${(st.maxDrawdown * 100).toFixed(1).padStart(5)}%`
        );
      }
      console.log('  ────────────────────────────────────────────────────────────────────────────────────');
    }

    // Summary stats
    const allEVs = withTrades.map(s => s.evPerTrade);
    const profitable = withTrades.filter(s => s.evPerTrade > 0);
    console.log(`\n  Sweep Summary:`);
    console.log(`    Profitable configs: ${profitable.length}/${withTrades.length} (${pct(profitable.length, withTrades.length)}%)`);
    console.log(`    EV/trade range: $${Math.min(...allEVs).toFixed(4)} to $${Math.max(...allEVs).toFixed(4)}`);
    console.log(`    Median EV/trade: $${median(allEVs).toFixed(4)}`);
  }

  // ─── Critical verdict: does the market price the bias? ───
  console.log('\n  ── VERDICT: Does the market price the DOWN bias? ──\n');

  // Get average DOWN ask at 60s offset across all windows
  const asks60 = asksByOffset[60000] || [];
  const avgAsk60 = asks60.length > 0 ? asks60.reduce((s, v) => s + v, 0) / asks60.length : null;
  const medAsk60 = asks60.length > 0 ? median(asks60) : null;
  const downRate = downCount / (upCount + downCount);

  if (avgAsk60 != null) {
    const edge = downRate - avgAsk60;
    console.log(`    Observed DOWN rate:     ${(downRate * 100).toFixed(1)}%`);
    console.log(`    Avg DOWN ask (60s):     ${avgAsk60.toFixed(3)}`);
    console.log(`    Median DOWN ask (60s):  ${medAsk60.toFixed(3)}`);
    console.log(`    Raw edge (rate - ask):  ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}pp`);
    if (edge > 0.02) {
      console.log(`    → Market UNDER-PRICES the DOWN bias. Edge D is viable.`);
    } else if (edge > 0) {
      console.log(`    → Market partially prices bias. Edge D has thin edge — needs careful execution.`);
    } else {
      console.log(`    → Market ALREADY PRICES the DOWN bias (ask ≥ base rate). Edge D has no edge.`);
    }
  }
  console.log();
}

// ─── Edge D Engine ───

function runEdgeD(windowGroups, config, verbose = false) {
  const { entryWindowMs = 120000, maxPrice = 0.65, positionSize = 1, spreadBuffer = 0.005 } = config;

  const trades = [];
  const decisionLog = [];
  const reasonCounts = {};
  let signalsFired = 0;

  // For each window: find best sample within entry window, buy DOWN if cheap enough
  const targetOffset = entryWindowMs / 2;

  for (const group of windowGroups) {
    const eligible = group.samples.filter(s => s.offset_ms <= entryWindowMs && s.offset_ms > 0);
    if (eligible.length === 0) { reasonCounts['no_sample'] = (reasonCounts['no_sample'] || 0) + 1; continue; }

    const sample = eligible.reduce((best, s) =>
      Math.abs(s.offset_ms - targetOffset) < Math.abs(best.offset_ms - targetOffset) ? s : best
    );

    const ask = sample.clob_down_ask ? parseFloat(sample.clob_down_ask) : null;
    if (ask == null || isNaN(ask) || ask <= 0 || ask >= 1) {
      reasonCounts['no_clob_data'] = (reasonCounts['no_clob_data'] || 0) + 1;
      continue;
    }

    if (ask >= maxPrice) {
      reasonCounts[`down_expensive (${ask.toFixed(2)}≥${maxPrice})`] = (reasonCounts[`down_expensive (${ask.toFixed(2)}≥${maxPrice})`] || 0) + 1;
      continue;
    }

    signalsFired++;
    const fillPrice = ask + spreadBuffer;
    if (fillPrice >= 1) continue;

    const cost = fillPrice * positionSize;
    const resolved = sample.resolved_direction;
    const won = resolved === 'DOWN';
    const payout = won ? 1.00 * positionSize : 0.00;
    const pnl = payout - cost;

    trades.push({
      windowCloseTime: group.closeTime,
      symbol: group.symbol,
      entryPrice: fillPrice,
      ask,
      size: positionSize,
      cost,
      payout,
      pnl,
      resolved,
      won,
    });

    if (verbose) {
      const ts = new Date(group.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(3)}\x1b[0m`;
      decisionLog.push(
        `    ${et} | ${resolved.padEnd(4)} | ask=${ask.toFixed(3)} | fill=${fillPrice.toFixed(3)} | ${pnlStr}`
      );
    }
  }

  const stats = simulate(trades);
  return { trades, stats, decisionLog, signalsFired, windowsEvaluated: windowGroups.length, reasonCounts };
}

function simulate(trades, initialCapital = 100) {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;

  for (const t of trades) {
    capital -= t.cost;
    capital += t.payout;
    if (capital > peak) peak = capital;
    const dd = peak > 0 ? (peak - capital) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl: capital - initialCapital,
    returnPct: (capital - initialCapital) / initialCapital,
    maxDrawdown: maxDD,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    finalCapital: capital,
  };
}

function printEdgeDResult(result) {
  const s = result.stats;
  console.log(`  Config: entryWindow=${result.windowsEvaluated > 0 ? 'default' : 'N/A'}`);
  console.log(`  Windows evaluated:  ${result.windowsEvaluated}`);
  console.log(`  Signals fired:      ${result.signalsFired}`);
  console.log(`  Trades executed:    ${s.tradeCount}`);
  console.log(`  Wins:               ${s.winCount} (${(s.winRate * 100).toFixed(1)}%)`);
  console.log(`  Losses:             ${s.lossCount}`);
  console.log(`  Total P&L:          $${s.totalPnl.toFixed(2)}`);
  console.log(`  Return:             ${(s.returnPct * 100).toFixed(2)}%`);
  console.log(`  Max Drawdown:       ${(s.maxDrawdown * 100).toFixed(2)}%`);

  if (s.tradeCount > 0) {
    const avgEntry = result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / s.tradeCount;
    const evPerTrade = (s.winRate * (1 - avgEntry)) - ((1 - s.winRate) * avgEntry);
    console.log(`  Avg Entry Price:    ${avgEntry.toFixed(4)}`);
    console.log(`  EV/Trade:           $${evPerTrade.toFixed(4)}`);
  }

  if (Object.keys(result.reasonCounts).length > 0) {
    console.log('\n  Rejection reasons:');
    const sorted = Object.entries(result.reasonCounts).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`    ${reason}: ${count}`);
    }
  }

  if (result.decisionLog.length > 0) {
    console.log(`\n  Trade log (${result.decisionLog.length} trades):`);
    // Show first 20 and last 5 if too many
    if (result.decisionLog.length <= 30) {
      for (const line of result.decisionLog) console.log(line);
    } else {
      for (const line of result.decisionLog.slice(0, 20)) console.log(line);
      console.log(`    ... (${result.decisionLog.length - 25} more) ...`);
      for (const line of result.decisionLog.slice(-5)) console.log(line);
    }
  }
}

// ─── Main ───

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║   Strategy Workshop: Diagnostics + Edge D Backtest       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  await diagnostic1();
  await diagnostic2();
  await edgeD();

  const totalMs = Date.now() - t0;
  console.log(`\n  Total runtime: ${(totalMs / 1000).toFixed(1)}s\n`);

  await pool.end();
}

main().catch(err => {
  console.error('Diagnostics failed:', err);
  pool.end();
  process.exit(1);
});
