/**
 * Edge D Enriched Analysis + Edge H
 *
 * For every Edge D trade (buying cheap DOWN), captures all context variables
 * and profiles wins vs losses to find compounding filters.
 *
 * Also runs Edge H (buy UP when ref above strike).
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-dh-enriched.cjs
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

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

// ════════════════════════════════════════════════════════════════
// LOAD & ENRICH ALL WINDOWS
// ════════════════════════════════════════════════════════════════

async function loadEnrichedWindows() {
  const rows = await query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread,
           clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread,
           exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
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

  // Enrich each window with computed features at multiple time points
  for (const win of windows) {
    const sampleMap = {};
    for (const s of win.samples) {
      sampleMap[s.offset_ms] = s;
    }
    win.sampleMap = sampleMap;
    win.resolved = win.samples[0]?.resolved_direction;

    // Compute features at various offsets
    for (const s of win.samples) {
      const strike = s.strike_price ? parseFloat(s.strike_price) : null;
      const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      const ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
      const clClose = s.chainlink_at_close ? parseFloat(s.chainlink_at_close) : null;

      s._strike = strike;
      s._cl = cl;
      s._ref = ref;
      s._clClose = clClose;
      s._downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      s._downBid = s.clob_down_bid ? parseFloat(s.clob_down_bid) : null;
      s._downMid = s.clob_down_mid ? parseFloat(s.clob_down_mid) : null;
      s._downSpread = s.clob_down_spread ? parseFloat(s.clob_down_spread) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
      s._upBid = s.clob_up_bid ? parseFloat(s.clob_up_bid) : null;
      s._upMid = s.clob_up_mid ? parseFloat(s.clob_up_mid) : null;
      s._upSpread = s.clob_up_spread ? parseFloat(s.clob_up_spread) : null;

      // Derived features
      s._deficit = (strike != null && cl != null) ? strike - cl : null;
      s._refGap = (ref != null && strike != null) ? ref - strike : null;  // positive = ref above strike
      s._tokenSum = (s._downAsk != null && s._upAsk != null) ? s._downAsk + s._upAsk : null;

      // Exchange features
      const exPrices = [
        s.exchange_binance, s.exchange_coinbase, s.exchange_kraken,
        s.exchange_bybit, s.exchange_okx,
      ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));

      s._exCount = exPrices.length;
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
      s._exRange = exPrices.length >= 2 ? Math.max(...exPrices) - Math.min(...exPrices) : null;
      s._exMedianVsStrike = (s._exMedian != null && strike != null) ? s._exMedian - strike : null;
    }

    // Chainlink trajectory (need multiple offsets)
    const cl120 = sampleMap[120000]?._cl;
    const cl60 = sampleMap[60000]?._cl;
    const cl0 = sampleMap[0]?._cl;
    win.clDelta2to1 = (cl120 != null && cl60 != null) ? cl60 - cl120 : null;
    win.clDelta1to0 = (cl60 != null && cl0 != null) ? cl0 - cl60 : null;
    win.clDelta2to0 = (cl120 != null && cl0 != null) ? cl0 - cl120 : null;

    // CLOB drift (how DOWN mid changes in last 2 min)
    const downMid120 = sampleMap[120000]?._downMid;
    const downMid60 = sampleMap[60000]?._downMid;
    win.downMidDrift = (downMid120 != null && downMid60 != null) ? downMid60 - downMid120 : null;

    // UP mid drift
    const upMid120 = sampleMap[120000]?._upMid;
    const upMid60 = sampleMap[60000]?._upMid;
    win.upMidDrift = (upMid120 != null && upMid60 != null) ? upMid60 - upMid120 : null;
  }

  return windows;
}

// ════════════════════════════════════════════════════════════════
// EDGE D ENRICHED: Profile Wins vs Losses
// ════════════════════════════════════════════════════════════════

function runEdgeDEnriched(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE D ENRICHED: Win/Loss Feature Profiling');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Collect trades at 60s offset (1 min before close)
  const offset = 60000;
  const trades = [];

  for (const win of windows) {
    const s = win.sampleMap[offset];
    if (!s) continue;

    const ask = s._downAsk;
    if (ask == null || isNaN(ask) || ask <= 0 || ask >= 1) continue;
    if (ask >= 0.65) continue;  // same as default Edge D

    const fillPrice = ask + 0.005;
    const won = win.resolved === 'DOWN';
    const pnl = won ? (1.0 - fillPrice) : -fillPrice;

    trades.push({
      closeTime: win.closeTime,
      won,
      resolved: win.resolved,
      fillPrice,
      ask,
      pnl,
      // Context features at entry
      deficit: s._deficit,
      refGap: s._refGap,
      cl: s._cl,
      ref: s._ref,
      strike: s._strike,
      downMid: s._downMid,
      downSpread: s._downSpread,
      upAsk: s._upAsk,
      upMid: s._upMid,
      tokenSum: s._tokenSum,
      exMedian: s._exMedian,
      exRange: s._exRange,
      exMedianVsStrike: s._exMedianVsStrike,
      exCount: s._exCount,
      // Trajectory
      clDelta2to1: win.clDelta2to1,
      clDelta1to0: win.clDelta1to0,
      downMidDrift: win.downMidDrift,
      upMidDrift: win.upMidDrift,
    });
  }

  const wins = trades.filter(t => t.won);
  const losses = trades.filter(t => !t.won);

  console.log(`  Total trades: ${trades.length} (${wins.length} wins, ${losses.length} losses, ${pct(wins.length, trades.length)}% win rate)\n`);

  // ─── Feature Comparison: Wins vs Losses ───

  console.log('  ── Feature Means: Wins vs Losses ──\n');

  const features = [
    { name: 'DOWN ask (entry)', get: t => t.ask },
    { name: 'Deficit (strike-CL)', get: t => t.deficit },
    { name: 'Ref gap (ref-strike)', get: t => t.refGap },
    { name: 'CL delta 2m→1m', get: t => t.clDelta2to1 },
    { name: 'CL delta 1m→close', get: t => t.clDelta1to0 },
    { name: 'DOWN mid', get: t => t.downMid },
    { name: 'DOWN spread', get: t => t.downSpread },
    { name: 'UP ask', get: t => t.upAsk },
    { name: 'Token sum (UP+DOWN)', get: t => t.tokenSum },
    { name: 'Ex median vs strike', get: t => t.exMedianVsStrike },
    { name: 'Ex range (volatility)', get: t => t.exRange },
    { name: 'DOWN mid drift (2m)', get: t => t.downMidDrift },
  ];

  console.log('  Feature                │ Wins Mean    │ Losses Mean  │ Difference   │ Signal?');
  console.log('  ───────────────────────┼──────────────┼──────────────┼──────────────┼────────');

  for (const feat of features) {
    const winVals = wins.map(feat.get).filter(v => v != null && !isNaN(v));
    const lossVals = losses.map(feat.get).filter(v => v != null && !isNaN(v));

    if (winVals.length < 3 || lossVals.length < 3) {
      console.log(`  ${feat.name.padEnd(22)} │ insufficient data (${winVals.length}w/${lossVals.length}l)`);
      continue;
    }

    const winMean = winVals.reduce((s, v) => s + v, 0) / winVals.length;
    const lossMean = lossVals.reduce((s, v) => s + v, 0) / lossVals.length;
    const diff = winMean - lossMean;

    // Simple effect size: diff / pooled std
    const allVals = [...winVals, ...lossVals];
    const allMean = allVals.reduce((s, v) => s + v, 0) / allVals.length;
    const variance = allVals.reduce((s, v) => s + (v - allMean) ** 2, 0) / allVals.length;
    const std = Math.sqrt(variance);
    const effectSize = std > 0 ? Math.abs(diff / std) : 0;

    let signal = '';
    if (effectSize > 0.8) signal = '*** STRONG';
    else if (effectSize > 0.5) signal = '** MODERATE';
    else if (effectSize > 0.3) signal = '* WEAK';
    else signal = '  (noise)';

    const fmt = (v) => {
      if (Math.abs(v) >= 100) return ('$' + v.toFixed(0)).padStart(12);
      if (Math.abs(v) >= 1) return ('$' + v.toFixed(1)).padStart(12);
      return v.toFixed(4).padStart(12);
    };

    console.log(
      `  ${feat.name.padEnd(22)} │ ${fmt(winMean)} │ ${fmt(lossMean)} │ ${fmt(diff)} │ ${signal}`
    );
  }

  console.log();

  // ─── Bucketized Analysis: Find the best splits ───

  console.log('  ── Bucketized Win Rate by Feature ──\n');

  // For each feature, bucket trades and show win rate per bucket
  const bucketAnalyses = [
    {
      name: 'Deficit (strike - CL)',
      get: t => t.deficit,
      buckets: [
        { label: '< $40', test: v => v < 40 },
        { label: '$40-80', test: v => v >= 40 && v < 80 },
        { label: '$80-120', test: v => v >= 80 && v < 120 },
        { label: '$120-200', test: v => v >= 120 && v < 200 },
        { label: '> $200', test: v => v >= 200 },
      ],
    },
    {
      name: 'Ref gap (ref - strike)',
      get: t => t.refGap,
      buckets: [
        { label: '< -$100', test: v => v < -100 },
        { label: '-$100 to $0', test: v => v >= -100 && v < 0 },
        { label: '$0 to $100', test: v => v >= 0 && v < 100 },
        { label: '$100 to $300', test: v => v >= 100 && v < 300 },
        { label: '> $300', test: v => v >= 300 },
      ],
    },
    {
      name: 'DOWN ask price',
      get: t => t.ask,
      buckets: [
        { label: '< $0.02', test: v => v < 0.02 },
        { label: '$0.02-0.05', test: v => v >= 0.02 && v < 0.05 },
        { label: '$0.05-0.15', test: v => v >= 0.05 && v < 0.15 },
        { label: '$0.15-0.35', test: v => v >= 0.15 && v < 0.35 },
        { label: '$0.35-0.65', test: v => v >= 0.35 && v < 0.65 },
      ],
    },
    {
      name: 'CL delta (2min→1min)',
      get: t => t.clDelta2to1,
      buckets: [
        { label: '< -$50', test: v => v < -50 },
        { label: '-$50 to -$10', test: v => v >= -50 && v < -10 },
        { label: '±$10', test: v => v >= -10 && v <= 10 },
        { label: '+$10 to +$50', test: v => v > 10 && v <= 50 },
        { label: '> +$50', test: v => v > 50 },
      ],
    },
    {
      name: 'Token sum (UP+DOWN ask)',
      get: t => t.tokenSum,
      buckets: [
        { label: '< 0.50', test: v => v < 0.50 },
        { label: '0.50-0.80', test: v => v >= 0.50 && v < 0.80 },
        { label: '0.80-0.95', test: v => v >= 0.80 && v < 0.95 },
        { label: '0.95-1.05', test: v => v >= 0.95 && v < 1.05 },
        { label: '> 1.05', test: v => v >= 1.05 },
      ],
    },
    {
      name: 'Exchange range (cross-ex vol)',
      get: t => t.exRange,
      buckets: [
        { label: '< $20', test: v => v < 20 },
        { label: '$20-50', test: v => v >= 20 && v < 50 },
        { label: '$50-100', test: v => v >= 50 && v < 100 },
        { label: '$100-300', test: v => v >= 100 && v < 300 },
        { label: '> $300', test: v => v >= 300 },
      ],
    },
    {
      name: 'DOWN mid drift (2min)',
      get: t => t.downMidDrift,
      buckets: [
        { label: '< -0.10', test: v => v < -0.10 },
        { label: '-0.10 to -0.01', test: v => v >= -0.10 && v < -0.01 },
        { label: '±0.01', test: v => v >= -0.01 && v <= 0.01 },
        { label: '+0.01 to +0.10', test: v => v > 0.01 && v <= 0.10 },
        { label: '> +0.10', test: v => v > 0.10 },
      ],
    },
    {
      name: 'UP ask price',
      get: t => t.upAsk,
      buckets: [
        { label: '< $0.50', test: v => v < 0.50 },
        { label: '$0.50-0.80', test: v => v >= 0.50 && v < 0.80 },
        { label: '$0.80-0.95', test: v => v >= 0.80 && v < 0.95 },
        { label: '$0.95-1.00', test: v => v >= 0.95 && v <= 1.00 },
      ],
    },
  ];

  for (const analysis of bucketAnalyses) {
    console.log(`  ${analysis.name}:`);
    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  Bucket         │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade');
    console.log('  ──────────────────────────────────────────────────────────────────');

    for (const bucket of analysis.buckets) {
      const matching = trades.filter(t => {
        const val = analysis.get(t);
        return val != null && !isNaN(val) && bucket.test(val);
      });
      if (matching.length === 0) continue;

      const bucketWins = matching.filter(t => t.won).length;
      const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
      const winRate = bucketWins / matching.length;
      const ev = (winRate * (1 - avgEntry)) - ((1 - winRate) * avgEntry);

      const wrColor = winRate > 0.20 ? '\x1b[32m' : winRate < 0.05 ? '\x1b[31m' : '';
      const reset = wrColor ? '\x1b[0m' : '';

      console.log(
        `  ${bucket.label.padEnd(16)} │ ${String(matching.length).padStart(5)} │ ${String(bucketWins).padStart(4)} │ ${wrColor}${(winRate * 100).toFixed(1).padStart(6)}%${reset} │ ${avgEntry.toFixed(4).padStart(8)} │ $${ev.toFixed(4).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────\n');
  }

  // ─── Compound filter search ───
  console.log('  ── Compound Filter Search ──\n');
  console.log('  Testing combinations of filters to find high-win-rate subsets:\n');

  const filters = [
    { name: 'deficit>80', test: t => t.deficit != null && t.deficit > 80 },
    { name: 'deficit>120', test: t => t.deficit != null && t.deficit > 120 },
    { name: 'deficit>200', test: t => t.deficit != null && t.deficit > 200 },
    { name: 'refGap<100', test: t => t.refGap != null && Math.abs(t.refGap) < 100 },
    { name: 'refGap<50', test: t => t.refGap != null && Math.abs(t.refGap) < 50 },
    { name: 'ref<strike', test: t => t.refGap != null && t.refGap < 0 },
    { name: 'ref>strike', test: t => t.refGap != null && t.refGap > 0 },
    { name: 'clFalling', test: t => t.clDelta2to1 != null && t.clDelta2to1 < -10 },
    { name: 'clRising', test: t => t.clDelta2to1 != null && t.clDelta2to1 > 10 },
    { name: 'downAsk>0.05', test: t => t.ask > 0.05 },
    { name: 'downAsk>0.10', test: t => t.ask > 0.10 },
    { name: 'downAsk>0.20', test: t => t.ask > 0.20 },
    { name: 'downDrift>0', test: t => t.downMidDrift != null && t.downMidDrift > 0 },
    { name: 'downDrift>0.05', test: t => t.downMidDrift != null && t.downMidDrift > 0.05 },
    { name: 'upAsk<0.95', test: t => t.upAsk != null && t.upAsk < 0.95 },
    { name: 'upAsk<0.85', test: t => t.upAsk != null && t.upAsk < 0.85 },
    { name: 'tokenSum<0.95', test: t => t.tokenSum != null && t.tokenSum < 0.95 },
    { name: 'exRange>50', test: t => t.exRange != null && t.exRange > 50 },
    { name: 'exRange<50', test: t => t.exRange != null && t.exRange < 50 },
  ];

  // Test single filters
  const singleResults = [];
  for (const f of filters) {
    const matching = trades.filter(f.test);
    if (matching.length < 5) continue;
    const w = matching.filter(t => t.won).length;
    const wr = w / matching.length;
    const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = matching.reduce((s, t) => s + t.pnl, 0);
    singleResults.push({ name: f.name, count: matching.length, wins: w, winRate: wr, avgEntry, ev, totalPnl, test: f.test });
  }

  singleResults.sort((a, b) => b.winRate - a.winRate);

  console.log('  Single Filters (sorted by win rate):');
  console.log('  ────────────────────────────────────────────────────────────────────────');
  console.log('  Filter           │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade │ TotalPnL');
  console.log('  ────────────────────────────────────────────────────────────────────────');
  for (const r of singleResults) {
    const wrColor = r.winRate > 0.20 ? '\x1b[32m' : '';
    const reset = wrColor ? '\x1b[0m' : '';
    console.log(
      `  ${r.name.padEnd(18)} │ ${String(r.count).padStart(5)} │ ${String(r.wins).padStart(4)} │ ${wrColor}${(r.winRate * 100).toFixed(1).padStart(6)}%${reset} │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(8)}`
    );
  }
  console.log('  ────────────────────────────────────────────────────────────────────────\n');

  // Test pairs of filters
  console.log('  Top Filter Pairs (minimum 5 trades, sorted by win rate):');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');
  console.log('  Filter Pair                     │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade │ PnL');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  const pairResults = [];
  for (let i = 0; i < filters.length; i++) {
    for (let j = i + 1; j < filters.length; j++) {
      const matching = trades.filter(t => filters[i].test(t) && filters[j].test(t));
      if (matching.length < 5) continue;
      const w = matching.filter(t => t.won).length;
      const wr = w / matching.length;
      const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
      const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
      const totalPnl = matching.reduce((s, t) => s + t.pnl, 0);
      pairResults.push({
        name: `${filters[i].name} + ${filters[j].name}`,
        count: matching.length, wins: w, winRate: wr, avgEntry, ev, totalPnl,
      });
    }
  }

  pairResults.sort((a, b) => b.winRate - a.winRate);
  const topPairs = pairResults.slice(0, 25);
  for (const r of topPairs) {
    const wrColor = r.winRate > 0.25 ? '\x1b[32m' : '';
    const reset = wrColor ? '\x1b[0m' : '';
    console.log(
      `  ${r.name.padEnd(33)} │ ${String(r.count).padStart(5)} │ ${String(r.wins).padStart(4)} │ ${wrColor}${(r.winRate * 100).toFixed(1).padStart(6)}%${reset} │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');

  // Test triples
  console.log('  Top Filter Triples (minimum 5 trades, sorted by EV/trade):');
  console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  Filter Triple                                    │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade │ PnL');
  console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────');

  const tripleResults = [];
  for (let i = 0; i < filters.length; i++) {
    for (let j = i + 1; j < filters.length; j++) {
      for (let k = j + 1; k < filters.length; k++) {
        const matching = trades.filter(t => filters[i].test(t) && filters[j].test(t) && filters[k].test(t));
        if (matching.length < 5) continue;
        const w = matching.filter(t => t.won).length;
        const wr = w / matching.length;
        const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
        const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
        const totalPnl = matching.reduce((s, t) => s + t.pnl, 0);
        tripleResults.push({
          name: `${filters[i].name} + ${filters[j].name} + ${filters[k].name}`,
          count: matching.length, wins: w, winRate: wr, avgEntry, ev, totalPnl,
        });
      }
    }
  }

  tripleResults.sort((a, b) => b.ev - a.ev);
  const topTriples = tripleResults.slice(0, 20);
  for (const r of topTriples) {
    const wrColor = r.winRate > 0.25 ? '\x1b[32m' : '';
    const reset = wrColor ? '\x1b[0m' : '';
    console.log(
      `  ${r.name.padEnd(50)} │ ${String(r.count).padStart(5)} │ ${String(r.wins).padStart(4)} │ ${wrColor}${(r.winRate * 100).toFixed(1).padStart(6)}%${reset} │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
    );
  }
  console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────\n');

  return trades;
}

// ════════════════════════════════════════════════════════════════
// EDGE H: Buy UP when ref far above strike
// ════════════════════════════════════════════════════════════════

function runEdgeH(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE H: Ref Above Strike → Buy UP');
  console.log('═══════════════════════════════════════════════════════════\n');

  // First: diagnostic — bucket windows by ref-above-strike and show resolution
  const offset = 60000;

  console.log('  ── Diagnostic: Resolution by Ref-Above-Strike Bucket ──\n');

  const diagRows = [];
  for (const win of windows) {
    const s = win.sampleMap[offset];
    if (!s || s._ref == null || s._strike == null) continue;
    diagRows.push({
      refGap: s._refGap,
      resolved: win.resolved,
      upAsk: s._upAsk,
      downAsk: s._downAsk,
      deficit: s._deficit,
    });
  }

  const diagBuckets = [
    { label: 'ref < strike-300', test: v => v < -300 },
    { label: 'ref strike-300 to -100', test: v => v >= -300 && v < -100 },
    { label: 'ref strike-100 to 0', test: v => v >= -100 && v < 0 },
    { label: 'ref strike to +100', test: v => v >= 0 && v < 100 },
    { label: 'ref +100 to +200', test: v => v >= 100 && v < 200 },
    { label: 'ref +200 to +300', test: v => v >= 200 && v < 300 },
    { label: 'ref > strike+300', test: v => v >= 300 },
  ];

  console.log('  Bucket                │ Count │  UP │ DOWN │  UP%  │ Avg UP ask │ Avg DOWN ask');
  console.log('  ──────────────────────┼───────┼─────┼──────┼───────┼────────────┼────────────');

  for (const bucket of diagBuckets) {
    const matching = diagRows.filter(r => bucket.test(r.refGap));
    if (matching.length === 0) continue;
    const up = matching.filter(r => r.resolved === 'UP').length;
    const down = matching.filter(r => r.resolved === 'DOWN').length;
    const upAsks = matching.map(r => r.upAsk).filter(v => v != null && !isNaN(v) && v > 0);
    const downAsks = matching.map(r => r.downAsk).filter(v => v != null && !isNaN(v) && v > 0);
    const avgUpAsk = upAsks.length > 0 ? upAsks.reduce((s, v) => s + v, 0) / upAsks.length : null;
    const avgDownAsk = downAsks.length > 0 ? downAsks.reduce((s, v) => s + v, 0) / downAsks.length : null;

    console.log(
      `  ${bucket.label.padEnd(22)} │ ${String(matching.length).padStart(5)} │ ${String(up).padStart(3)} │ ${String(down).padStart(4)} │ ${pct(up, matching.length).padStart(5)}% │ ${avgUpAsk != null ? avgUpAsk.toFixed(3).padStart(10) : '       N/A'} │ ${avgDownAsk != null ? avgDownAsk.toFixed(3).padStart(10) : '       N/A'}`
    );
  }
  console.log('  ──────────────────────┼───────┼─────┼──────┼───────┼────────────┼────────────\n');

  // ─── Edge H Backtest ───
  console.log('  ── Edge H: Backtest + Sweep ──\n');

  const sweepGrid = {
    minRefAbove: [50, 100, 150, 200, 300],
    maxUpPrice: [0.50, 0.60, 0.65, 0.70, 0.80, 0.90],
    entryWindowMs: [60000, 120000, 180000],
  };

  const paramSets = [];
  for (const mra of sweepGrid.minRefAbove) {
    for (const mup of sweepGrid.maxUpPrice) {
      for (const ew of sweepGrid.entryWindowMs) {
        paramSets.push({ minRefAbove: mra, maxUpPrice: mup, entryWindowMs: ew, spreadBuffer: 0.005 });
      }
    }
  }

  const results = paramSets.map(params => {
    const targetOffset = params.entryWindowMs / 2;
    const trades = [];

    for (const win of windows) {
      const eligible = win.samples.filter(s => s.offset_ms <= params.entryWindowMs && s.offset_ms > 0);
      if (eligible.length === 0) continue;

      const sample = eligible.reduce((best, s) =>
        Math.abs(s.offset_ms - targetOffset) < Math.abs(best.offset_ms - targetOffset) ? s : best
      );

      if (sample._ref == null || sample._strike == null || sample._upAsk == null) continue;
      if (isNaN(sample._upAsk) || sample._upAsk <= 0 || sample._upAsk >= 1) continue;

      const refAbove = sample._refGap;
      if (refAbove < params.minRefAbove) continue;
      if (sample._upAsk >= params.maxUpPrice) continue;

      const fillPrice = sample._upAsk + params.spreadBuffer;
      if (fillPrice >= 1) continue;

      const won = win.resolved === 'UP';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({ fillPrice, won, pnl, upAsk: sample._upAsk, refAbove });
    }

    if (trades.length === 0) return null;

    const w = trades.filter(t => t.won).length;
    const wr = w / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    return { params, count: trades.length, wins: w, winRate: wr, avgEntry, ev, totalPnl, trades };
  }).filter(r => r != null && r.count >= 3);

  results.sort((a, b) => b.ev - a.ev);

  console.log(`  ${paramSets.length} configs tested, ${results.length} produced 3+ trades\n`);

  if (results.length > 0) {
    console.log('  Top 20 by EV/trade:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ MinRef │ MaxPx │ Window │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');

    const top = results.slice(0, 20);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ $${String(p.minRefAbove).padStart(4)} │ ${p.maxUpPrice.toFixed(2).padStart(5)} │ ${String((p.entryWindowMs / 1000) + 's').padStart(6)} │ ${String(r.count).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');

    // Best result detail
    const best = results[0];
    if (best.trades.length > 0) {
      console.log(`\n  Best config detail (${best.params.minRefAbove}/${best.params.maxUpPrice}/${best.params.entryWindowMs / 1000}s):`);
      console.log(`    Trades: ${best.count}, Wins: ${best.wins}, WR: ${(best.winRate * 100).toFixed(1)}%, EV: $${best.ev.toFixed(4)}, PnL: $${best.totalPnl.toFixed(2)}`);
    }
  }
  console.log();
}

// ─── Main ───

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Edge D Enriched + Edge H — Compounding Factor Search    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  console.log('  Loading and enriching windows...');
  const windows = await loadEnrichedWindows();
  console.log(`  Loaded ${windows.length} windows with full feature set\n`);

  runEdgeDEnriched(windows);
  runEdgeH(windows);

  const totalMs = Date.now() - t0;
  console.log(`  Total runtime: ${(totalMs / 1000).toFixed(1)}s\n`);

  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err);
  pool.end();
  process.exit(1);
});
