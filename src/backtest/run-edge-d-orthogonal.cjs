/**
 * Edge D Orthogonal Factor Analysis
 *
 * Strips out redundant filters (UP ask ≈ 1 - DOWN ask) and tests
 * only genuinely independent signals for compounding.
 *
 * Independent axes:
 *   1. Market uncertainty (DOWN ask level) — single axis, not two
 *   2. Chainlink deficit (strike - CL) — structural bias magnitude
 *   3. CL trajectory (delta over last 2 min) — momentum
 *   4. Exchange cross-spread (range across 5 exchanges) — disagreement
 *   5. DOWN mid drift (2min change in CLOB mid) — informed flow signal
 *   6. Ref-to-strike gap — where price is vs resolution threshold
 *
 * Note: #1 and #6 are correlated (contested windows have DOWN > 0.15 AND ref near strike)
 * but not identical. A window can have DOWN at 0.30 with ref $200 above strike if
 * it just crossed. Need to test.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-d-orthogonal.cjs
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
// LOAD AND ENRICH
// ════════════════════════════════════════════════════════════════

async function loadWindows() {
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

  const windowMap = new Map();
  for (const row of rows) {
    const key = row.window_close_time.toISOString();
    if (!windowMap.has(key)) {
      windowMap.set(key, { closeTime: row.window_close_time, symbol: row.symbol, samples: [], sampleMap: {} });
    }
    const win = windowMap.get(key);
    win.samples.push(row);
    win.sampleMap[row.offset_ms] = row;
  }

  const windows = Array.from(windowMap.values());

  for (const win of windows) {
    win.resolved = win.samples[0]?.resolved_direction;

    // Parse all numeric fields per sample
    for (const s of win.samples) {
      s._strike = s.strike_price ? parseFloat(s.strike_price) : null;
      s._cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      s._ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
      s._clClose = s.chainlink_at_close ? parseFloat(s.chainlink_at_close) : null;
      s._downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      s._downBid = s.clob_down_bid ? parseFloat(s.clob_down_bid) : null;
      s._downMid = s.clob_down_mid ? parseFloat(s.clob_down_mid) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;

      s._deficit = (s._strike != null && s._cl != null) ? s._strike - s._cl : null;
      s._refGap = (s._ref != null && s._strike != null) ? s._ref - s._strike : null;

      const exPrices = [
        s.exchange_binance, s.exchange_coinbase, s.exchange_kraken,
        s.exchange_bybit, s.exchange_okx,
      ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));
      s._exCount = exPrices.length;
      s._exRange = exPrices.length >= 2 ? Math.max(...exPrices) - Math.min(...exPrices) : null;
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
    }

    // Trajectory features (need pairs of offsets)
    const cl120 = win.sampleMap[120000]?._cl;
    const cl60 = win.sampleMap[60000]?._cl;
    const cl30 = win.sampleMap[30000]?._cl;
    const cl0 = win.sampleMap[0]?._cl;
    win.clDelta_2to1 = (cl120 != null && cl60 != null) ? cl60 - cl120 : null;
    win.clDelta_1to0 = (cl60 != null && cl0 != null) ? cl0 - cl60 : null;

    // CLOB drift
    const dm180 = win.sampleMap[180000]?._downMid;
    const dm120 = win.sampleMap[120000]?._downMid;
    const dm60 = win.sampleMap[60000]?._downMid;
    win.downDrift_3to1 = (dm180 != null && dm60 != null) ? dm60 - dm180 : null;
    win.downDrift_2to1 = (dm120 != null && dm60 != null) ? dm60 - dm120 : null;
  }

  return windows;
}

// ════════════════════════════════════════════════════════════════
// ANALYSIS 1: Correlation matrix between factors
// ════════════════════════════════════════════════════════════════

function correlationAnalysis(trades) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 1: Factor Correlation Check');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('  Confirming which "independent" factors are actually correlated.\n');

  const factors = [
    { name: 'DOWN ask', get: t => t.downAsk },
    { name: 'UP ask', get: t => t.upAsk },
    { name: 'Deficit', get: t => t.deficit },
    { name: 'Ref gap', get: t => t.refGap },
    { name: 'CL delta', get: t => t.clDelta },
    { name: 'Ex range', get: t => t.exRange },
    { name: 'DOWN drift', get: t => t.downDrift },
  ];

  // Pearson correlation between each pair
  console.log('  Pearson r correlation matrix (closer to ±1 = redundant):');
  console.log('  ' + ''.padEnd(12) + factors.map(f => f.name.padStart(10)).join(''));
  console.log('  ' + '─'.repeat(12 + factors.length * 10));

  for (const row of factors) {
    let line = '  ' + row.name.padEnd(12);
    for (const col of factors) {
      const pairs = trades.filter(t => {
        const a = row.get(t);
        const b = col.get(t);
        return a != null && !isNaN(a) && b != null && !isNaN(b);
      });
      if (pairs.length < 10) {
        line += '       N/A';
        continue;
      }
      const xs = pairs.map(row.get);
      const ys = pairs.map(col.get);
      const r = pearson(xs, ys);
      const rStr = r.toFixed(2);
      // Color: >0.7 or <-0.7 = red (redundant)
      const color = Math.abs(r) > 0.7 ? '\x1b[31m' : Math.abs(r) > 0.4 ? '\x1b[33m' : '';
      const reset = color ? '\x1b[0m' : '';
      line += `${color}${rStr.padStart(10)}${reset}`;
    }
    console.log(line);
  }
  console.log();
  console.log('  Red (|r|>0.7) = redundant, Yellow (|r|>0.4) = correlated, White = independent');
  console.log();
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

// ════════════════════════════════════════════════════════════════
// ANALYSIS 2: Truly orthogonal filters
// ════════════════════════════════════════════════════════════════

function orthogonalAnalysis(trades) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 2: Orthogonal Factor Win Rates');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Axis 1: Market uncertainty (DOWN ask level) — THE primary axis
  // Since UP ≈ 1 - DOWN, only use DOWN ask
  console.log('  AXIS 1: Market Uncertainty (DOWN ask = market\'s implied P(DOWN))');
  console.log('  This is the PRIMARY signal. How much does the market think DOWN will win?');
  console.log('  ──────────────────────────────────────────────────────────────────');
  console.log('  DOWN ask     │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade │ Market wrong?');
  console.log('  ──────────────────────────────────────────────────────────────────');

  const axis1Buckets = [
    { label: '< 0.02 (mkt: 98% UP)', range: [0, 0.02] },
    { label: '0.02-0.05 (95-98% UP)', range: [0.02, 0.05] },
    { label: '0.05-0.15 (85-95% UP)', range: [0.05, 0.15] },
    { label: '0.15-0.30 (70-85% UP)', range: [0.15, 0.30] },
    { label: '0.30-0.50 (contested)', range: [0.30, 0.50] },
    { label: '0.50-0.65 (mkt: DOWN)', range: [0.50, 0.65] },
  ];

  for (const b of axis1Buckets) {
    const matching = trades.filter(t => t.downAsk >= b.range[0] && t.downAsk < b.range[1]);
    if (matching.length === 0) continue;
    const w = matching.filter(t => t.won).length;
    const wr = w / matching.length;
    const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const mktWrong = wr > (avgEntry - 0.005) ? 'YES — edge' : 'NO — mkt correct';
    console.log(
      `  ${b.label.padEnd(25)} │ ${String(matching.length).padStart(5)} │ ${String(w).padStart(4)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ ${avgEntry.toFixed(4).padStart(8)} │ $${ev.toFixed(4).padStart(7)} │ ${mktWrong}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────\n');

  // Now: WITHIN the contested zone (DOWN > 0.15), what adds information?
  const contested = trades.filter(t => t.downAsk >= 0.15);
  const decidedUP = trades.filter(t => t.downAsk < 0.15);

  console.log(`  Contested windows (DOWN ask ≥ 0.15): ${contested.length} trades, ${contested.filter(t => t.won).length} wins (${pct(contested.filter(t => t.won).length, contested.length)}%)`);
  console.log(`  Decided-UP windows (DOWN ask < 0.15): ${decidedUP.length} trades, ${decidedUP.filter(t => t.won).length} wins (${pct(decidedUP.filter(t => t.won).length, decidedUP.length)}%)\n`);

  if (contested.length < 5) {
    console.log('  ⚠ Too few contested windows to analyze further.\n');
    return;
  }

  // Within contested: what's the independent info from each axis?
  console.log('  ── Within CONTESTED windows (DOWN ≥ 0.15): What adds info? ──\n');

  const axes = [
    {
      name: 'AXIS 2: Deficit (strike - CL)',
      get: t => t.deficit,
      buckets: [
        { label: 'Deficit < $40', range: [-Infinity, 40] },
        { label: 'Deficit $40-80', range: [40, 80] },
        { label: 'Deficit $80-120', range: [80, 120] },
        { label: 'Deficit > $120', range: [120, Infinity] },
      ],
    },
    {
      name: 'AXIS 3: CL Trajectory (2min→1min)',
      get: t => t.clDelta,
      buckets: [
        { label: 'CL falling > $20', range: [-Infinity, -20] },
        { label: 'CL falling $1-20', range: [-20, -1] },
        { label: 'CL flat (±$1)', range: [-1, 1] },
        { label: 'CL rising $1-20', range: [1, 20] },
        { label: 'CL rising > $20', range: [20, Infinity] },
      ],
    },
    {
      name: 'AXIS 4: Exchange Range (cross-exchange disagreement)',
      get: t => t.exRange,
      buckets: [
        { label: 'Range < $30', range: [0, 30] },
        { label: 'Range $30-80', range: [30, 80] },
        { label: 'Range $80-200', range: [80, 200] },
        { label: 'Range > $200', range: [200, Infinity] },
      ],
    },
    {
      name: 'AXIS 5: DOWN Mid Drift (3min→1min)',
      get: t => t.downDrift,
      buckets: [
        { label: 'Drift < -0.05', range: [-Infinity, -0.05] },
        { label: 'Drift -0.05 to 0', range: [-0.05, 0] },
        { label: 'Drift 0 to +0.05', range: [0, 0.05] },
        { label: 'Drift > +0.05', range: [0.05, Infinity] },
      ],
    },
    {
      name: 'AXIS 6: Ref Gap (ref - strike)',
      get: t => t.refGap,
      buckets: [
        { label: 'Ref below strike', range: [-Infinity, 0] },
        { label: 'Ref $0-50 above', range: [0, 50] },
        { label: 'Ref $50-100 above', range: [50, 100] },
        { label: 'Ref > $100 above', range: [100, Infinity] },
      ],
    },
  ];

  for (const axis of axes) {
    console.log(`  ${axis.name}:`);
    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  Bucket              │ Count │ Wins │ WinRate │ AvgEntry │ EV/Trade');
    console.log('  ──────────────────────────────────────────────────────────────────');

    for (const b of axis.buckets) {
      const matching = contested.filter(t => {
        const v = axis.get(t);
        return v != null && !isNaN(v) && v >= b.range[0] && v < b.range[1];
      });
      if (matching.length === 0) continue;
      const w = matching.filter(t => t.won).length;
      const wr = w / matching.length;
      const avgEntry = matching.reduce((s, t) => s + t.fillPrice, 0) / matching.length;
      const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
      console.log(
        `  ${b.label.padEnd(22)} │ ${String(matching.length).padStart(5)} │ ${String(w).padStart(4)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ ${avgEntry.toFixed(4).padStart(8)} │ $${ev.toFixed(4).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────\n');
  }

  // ─── Within decided-UP windows: is there ANYTHING that predicts the 6.5% wins? ───
  console.log('  ── Within DECIDED-UP windows (DOWN < 0.15): Any signal at all? ──\n');

  if (decidedUP.length >= 10) {
    for (const axis of axes) {
      const matching = decidedUP.filter(t => {
        const v = axis.get(t);
        return v != null && !isNaN(v);
      });
      if (matching.length < 5) continue;

      const winVals = matching.filter(t => t.won).map(axis.get);
      const lossVals = matching.filter(t => !t.won).map(axis.get);

      if (winVals.length === 0) {
        console.log(`  ${axis.name}: 0 wins — no signal possible`);
        continue;
      }

      const winMean = winVals.reduce((s, v) => s + v, 0) / winVals.length;
      const lossMean = lossVals.reduce((s, v) => s + v, 0) / lossVals.length;
      console.log(`  ${axis.name}:`);
      console.log(`    Wins (${winVals.length}):   mean=${winMean.toFixed(1)}, median=${median(winVals)?.toFixed(1)}`);
      console.log(`    Losses (${lossVals.length}): mean=${lossMean.toFixed(1)}, median=${median(lossVals)?.toFixed(1)}`);
    }
  }
  console.log();
}

// ════════════════════════════════════════════════════════════════
// ANALYSIS 3: All 207 windows — full picture
// ════════════════════════════════════════════════════════════════

function fullWindowAnalysis(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 3: All 207 Windows — Resolution by Market State');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Use offset 60000 for analysis
  const windowData = [];
  for (const win of windows) {
    const s = win.sampleMap[60000];
    if (!s) continue;

    windowData.push({
      closeTime: win.closeTime,
      resolved: win.resolved,
      downAsk: s._downAsk,
      upAsk: s._upAsk,
      deficit: s._deficit,
      refGap: s._refGap,
      clDelta: win.clDelta_2to1,
      exRange: s._exRange,
      downDrift: win.downDrift_2to1,
      hasClob: s._downAsk != null && !isNaN(s._downAsk) && s._downAsk > 0,
    });
  }

  // First: how many windows have CLOB data?
  const withClob = windowData.filter(w => w.hasClob);
  const withoutClob = windowData.filter(w => !w.hasClob);

  console.log(`  Total windows: ${windowData.length}`);
  console.log(`  With CLOB data at 60s: ${withClob.length} (${pct(withClob.length, windowData.length)}%)`);
  console.log(`  Without CLOB data:     ${withoutClob.length}\n`);

  // Resolution in windows WITH CLOB data
  const clobDown = withClob.filter(w => w.resolved === 'DOWN').length;
  const clobUp = withClob.filter(w => w.resolved === 'UP').length;
  console.log(`  With CLOB: DOWN=${clobDown} (${pct(clobDown, withClob.length)}%), UP=${clobUp} (${pct(clobUp, withClob.length)}%)`);

  // Resolution in windows WITHOUT CLOB data
  const noClobDown = withoutClob.filter(w => w.resolved === 'DOWN').length;
  const noClobUp = withoutClob.filter(w => w.resolved === 'UP').length;
  console.log(`  No CLOB:   DOWN=${noClobDown} (${pct(noClobDown, withoutClob.length)}%), UP=${noClobUp} (${pct(noClobUp, withoutClob.length)}%)\n`);

  // 2D heatmap: DOWN ask bucket vs Deficit bucket → resolution rate
  console.log('  ── 2D Heatmap: DOWN Ask × Deficit → DOWN Resolution % ──\n');

  const downAskBuckets = [
    { label: '< 0.05', range: [0, 0.05] },
    { label: '0.05-0.15', range: [0.05, 0.15] },
    { label: '0.15-0.35', range: [0.15, 0.35] },
    { label: '0.35-0.65', range: [0.35, 0.65] },
    { label: '> 0.65', range: [0.65, 1.01] },
  ];

  const defBuckets = [
    { label: 'def<0', range: [-Infinity, 0] },
    { label: '0-40', range: [0, 40] },
    { label: '40-80', range: [40, 80] },
    { label: '80-120', range: [80, 120] },
    { label: '>120', range: [120, Infinity] },
  ];

  // Header
  let header = '  DOWN ask \\ Deficit │';
  for (const db of defBuckets) header += db.label.padStart(10) + ' │';
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));

  for (const ab of downAskBuckets) {
    let line = `  ${ab.label.padEnd(19)} │`;
    for (const db of defBuckets) {
      const matching = withClob.filter(w =>
        w.downAsk >= ab.range[0] && w.downAsk < ab.range[1] &&
        w.deficit != null && w.deficit >= db.range[0] && w.deficit < db.range[1]
      );
      if (matching.length === 0) {
        line += '        - │';
        continue;
      }
      const downRes = matching.filter(w => w.resolved === 'DOWN').length;
      const wr = downRes / matching.length;
      const wrStr = `${(wr * 100).toFixed(0)}%`;
      const countStr = `(${matching.length})`;
      const color = wr > 0.6 ? '\x1b[32m' : wr < 0.2 ? '\x1b[31m' : '';
      const reset = color ? '\x1b[0m' : '';
      line += `${color}${(wrStr + ' ' + countStr).padStart(10)}${reset} │`;
    }
    console.log(line);
  }
  console.log('  ' + '─'.repeat(header.length - 2));
  console.log('  Green = >60% DOWN, Red = <20% DOWN. (n) = sample size.\n');

  // Second heatmap: DOWN ask × CL trajectory
  console.log('  ── 2D Heatmap: DOWN Ask × CL Trajectory → DOWN % ──\n');

  const clBuckets = [
    { label: 'fall>$20', range: [-Infinity, -20] },
    { label: 'fall$1-20', range: [-20, -1] },
    { label: 'flat±$1', range: [-1, 1] },
    { label: 'rise$1-20', range: [1, 20] },
    { label: 'rise>$20', range: [20, Infinity] },
  ];

  let header2 = '  DOWN ask \\ CL traj │';
  for (const cb of clBuckets) header2 += cb.label.padStart(11) + ' │';
  console.log(header2);
  console.log('  ' + '─'.repeat(header2.length - 2));

  for (const ab of downAskBuckets) {
    let line = `  ${ab.label.padEnd(19)} │`;
    for (const cb of clBuckets) {
      const matching = withClob.filter(w =>
        w.downAsk >= ab.range[0] && w.downAsk < ab.range[1] &&
        w.clDelta != null && w.clDelta >= cb.range[0] && w.clDelta < cb.range[1]
      );
      if (matching.length === 0) {
        line += '         - │';
        continue;
      }
      const downRes = matching.filter(w => w.resolved === 'DOWN').length;
      const wr = downRes / matching.length;
      const wrStr = `${(wr * 100).toFixed(0)}%`;
      const countStr = `(${matching.length})`;
      const color = wr > 0.6 ? '\x1b[32m' : wr < 0.2 ? '\x1b[31m' : '';
      const reset = color ? '\x1b[0m' : '';
      line += `${color}${(wrStr + ' ' + countStr).padStart(11)}${reset} │`;
    }
    console.log(line);
  }
  console.log('  ' + '─'.repeat(header2.length - 2));
  console.log('  Green = >60% DOWN, Red = <20% DOWN.\n');

  // Third heatmap: DOWN ask × DOWN drift
  console.log('  ── 2D Heatmap: DOWN Ask × DOWN Mid Drift (2min) → DOWN % ──\n');

  const driftBuckets = [
    { label: 'drift<-0.05', range: [-Infinity, -0.05] },
    { label: '-0.05 to 0', range: [-0.05, 0] },
    { label: '0 to +0.05', range: [0, 0.05] },
    { label: 'drift>+0.05', range: [0.05, Infinity] },
  ];

  let header3 = '  DOWN ask \\ drift   │';
  for (const db of driftBuckets) header3 += db.label.padStart(13) + ' │';
  console.log(header3);
  console.log('  ' + '─'.repeat(header3.length - 2));

  for (const ab of downAskBuckets) {
    let line = `  ${ab.label.padEnd(19)} │`;
    for (const db of driftBuckets) {
      const matching = withClob.filter(w =>
        w.downAsk >= ab.range[0] && w.downAsk < ab.range[1] &&
        w.downDrift != null && w.downDrift >= db.range[0] && w.downDrift < db.range[1]
      );
      if (matching.length === 0) {
        line += '           - │';
        continue;
      }
      const downRes = matching.filter(w => w.resolved === 'DOWN').length;
      const wr = downRes / matching.length;
      const wrStr = `${(wr * 100).toFixed(0)}%`;
      const countStr = `(${matching.length})`;
      const color = wr > 0.6 ? '\x1b[32m' : wr < 0.2 ? '\x1b[31m' : '';
      const reset = color ? '\x1b[0m' : '';
      line += `${color}${(wrStr + ' ' + countStr).padStart(13)}${reset} │`;
    }
    console.log(line);
  }
  console.log('  ' + '─'.repeat(header3.length - 2));
  console.log('  Green = >60% DOWN, Red = <20% DOWN.\n');

  return windowData;
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Edge D: Orthogonal Factor Analysis                      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);

  // Build trade list at 60s offset
  const trades = [];
  for (const win of windows) {
    const s = win.sampleMap[60000];
    if (!s) continue;
    const ask = s._downAsk;
    if (ask == null || isNaN(ask) || ask <= 0 || ask >= 1) continue;
    if (ask >= 0.65) continue;

    trades.push({
      won: win.resolved === 'DOWN',
      downAsk: ask,
      upAsk: s._upAsk,
      fillPrice: ask + 0.005,
      deficit: s._deficit,
      refGap: s._refGap,
      clDelta: win.clDelta_2to1,
      exRange: s._exRange,
      downDrift: win.downDrift_2to1,
    });
  }

  correlationAnalysis(trades);
  orthogonalAnalysis(trades);
  fullWindowAnalysis(windows);

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err);
  pool.end();
  process.exit(1);
});
