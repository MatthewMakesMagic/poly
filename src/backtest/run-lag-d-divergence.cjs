/**
 * Lag Strategy D: Exchange-CL Divergence Snap-Back
 *
 * Core thesis: When exchange prices suddenly diverge from CL (because CL
 * lags by ~878ms), CL will snap toward exchanges. Near window close, if this
 * snap crosses the strike threshold, we can predict the settlement.
 *
 * The key insight: the SIZE and DIRECTION of the exchange-CL gap tells us
 * which way CL is heading. If exchanges just dropped and CL hasn't caught up,
 * CL will follow DOWN. If exchanges just spiked up, CL will follow UP.
 *
 * This is different from Lag-A (which uses exchange position vs strike) because
 * here we focus on the GAP BETWEEN exchange and CL, not their absolute position.
 * A large gap = recent movement = CL is about to move in that direction.
 *
 * Variants:
 *   1. Static gap: exchange_median - CL at single time point
 *   2. Gap velocity: how fast is the gap widening/closing?
 *   3. Gap + position: combine gap direction with position relative to strike
 *   4. Multi-exchange consensus: do all exchanges agree on direction?
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-lag-d-divergence.cjs
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

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function loadWindows() {
  const rows = await pool.query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_up_bid, clob_up_ask,
           exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
           resolved_direction, chainlink_at_close
    FROM window_backtest_states
    ORDER BY window_close_time ASC, offset_ms DESC
  `);

  const windowMap = new Map();
  for (const row of rows.rows) {
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
    for (const s of win.samples) {
      s._strike = s.strike_price ? parseFloat(s.strike_price) : null;
      s._cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      s._ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
      s._clClose = s.chainlink_at_close ? parseFloat(s.chainlink_at_close) : null;
      s._downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;

      const exPrices = [
        s.exchange_binance, s.exchange_coinbase, s.exchange_kraken,
        s.exchange_bybit, s.exchange_okx,
      ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));
      s._exCount = exPrices.length;
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
      s._exMin = exPrices.length >= 2 ? Math.min(...exPrices) : null;
      s._exMax = exPrices.length >= 2 ? Math.max(...exPrices) : null;
      s._exRange = exPrices.length >= 2 ? s._exMax - s._exMin : null;

      // The key metric: exchange-CL gap
      s._exClGap = (s._exMedian != null && s._cl != null) ? s._exMedian - s._cl : null;
      // PolyRef-CL gap (alternative)
      s._refClGap = (s._ref != null && s._cl != null) ? s._ref - s._cl : null;
    }
  }
  return windows;
}

// ─── Diagnostic: Exchange-CL Gap Distribution ───

function runDiagnostic(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC: Exchange-CL Gap Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Gap distribution at each offset
  const offsets = [10000, 20000, 30000, 60000, 120000];

  console.log('  Exchange-CL Gap (exchange_median - chainlink) at each offset:');
  console.log('  ─────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ Samples │ Avg Gap  │ Med Gap  │ Std Gap  │ P5 Gap   │ P95 Gap');
  console.log('  ─────────────────────────────────────────────────────────────────────');

  for (const offset of offsets) {
    const gaps = [];
    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._exClGap == null) continue;
      gaps.push(s._exClGap);
    }
    if (gaps.length === 0) continue;

    const sorted = [...gaps].sort((a, b) => a - b);
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const med = median(gaps);
    const variance = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / gaps.length;
    const std = Math.sqrt(variance);
    const p5 = sorted[Math.floor(gaps.length * 0.05)];
    const p95 = sorted[Math.floor(gaps.length * 0.95)];

    console.log(
      `  ${String(offset / 1000).padStart(4)}s  │ ${String(gaps.length).padStart(7)} │ $${avg.toFixed(1).padStart(7)} │ $${med.toFixed(1).padStart(7)} │ $${std.toFixed(1).padStart(7)} │ $${p5.toFixed(1).padStart(7)} │ $${p95.toFixed(1).padStart(7)}`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────────\n');

  // Does gap direction predict resolution?
  console.log('  Gap Direction vs Resolution (at each offset):');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ Gap > avg │ Res DOWN │ DOWN% │ Gap < avg │ Res DOWN │ DOWN%');
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  for (const offset of offsets) {
    const data = [];
    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._exClGap == null) continue;
      data.push({ gap: s._exClGap, resolved: win.resolved });
    }
    if (data.length === 0) continue;

    const avgGap = data.reduce((s, d) => s + d.gap, 0) / data.length;
    const above = data.filter(d => d.gap > avgGap);
    const below = data.filter(d => d.gap <= avgGap);
    const aboveDown = above.filter(d => d.resolved === 'DOWN').length;
    const belowDown = below.filter(d => d.resolved === 'DOWN').length;

    console.log(
      `  ${String(offset / 1000).padStart(4)}s  │ ${String(above.length).padStart(8)} │ ${String(aboveDown).padStart(8)} │ ${pct(aboveDown, above.length).padStart(5)}% │ ${String(below.length).padStart(8)} │ ${String(belowDown).padStart(8)} │ ${pct(belowDown, below.length).padStart(5)}%`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  // Gap CHANGE (velocity of divergence) — does widening gap predict resolution?
  console.log('\n  Gap Change (how fast exchange-CL gap is growing/shrinking):');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');
  console.log('  Period        │ Samples │ Gap Growing │ DOWN% │ Gap Shrinking │ DOWN%');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  const gapChangePeriods = [
    { name: '60s → 30s', from: 60000, to: 30000 },
    { name: '30s → 10s', from: 30000, to: 10000 },
    { name: '60s → 10s', from: 60000, to: 10000 },
    { name: '120s → 30s', from: 120000, to: 30000 },
  ];

  for (const period of gapChangePeriods) {
    const data = [];
    for (const win of windows) {
      const sFrom = win.sampleMap[period.from];
      const sTo = win.sampleMap[period.to];
      if (!sFrom || !sTo || sFrom._exClGap == null || sTo._exClGap == null) continue;
      const gapChange = sTo._exClGap - sFrom._exClGap; // positive = gap growing (ex pulling away from CL)
      data.push({ gapChange, resolved: win.resolved });
    }
    if (data.length === 0) continue;

    const growing = data.filter(d => d.gapChange > 0);
    const shrinking = data.filter(d => d.gapChange <= 0);
    const growDown = growing.filter(d => d.resolved === 'DOWN').length;
    const shrinkDown = shrinking.filter(d => d.resolved === 'DOWN').length;

    console.log(
      `  ${period.name.padEnd(15)} │ ${String(data.length).padStart(7)} │ ${String(growing.length).padStart(11)} │ ${pct(growDown, growing.length).padStart(5)}% │ ${String(shrinking.length).padStart(13)} │ ${pct(shrinkDown, shrinking.length).padStart(5)}%`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');

  // PolyRef-CL gap vs Exchange-CL gap comparison
  console.log('  PolyRef-CL Gap vs Exchange-CL Gap (which divergence is more predictive?):');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ ExGap > $80 → DOWN% │ RefGap > $80 → DOWN% │ ExGap samples │ RefGap samples');
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  for (const offset of [10000, 30000, 60000]) {
    let exAbove = 0, exAboveDown = 0, refAbove = 0, refAboveDown = 0;
    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s) continue;
      if (s._exClGap != null && s._exClGap > 80) {
        exAbove++;
        if (win.resolved === 'DOWN') exAboveDown++;
      }
      if (s._refClGap != null && s._refClGap > 80) {
        refAbove++;
        if (win.resolved === 'DOWN') refAboveDown++;
      }
    }
    console.log(
      `  ${String(offset / 1000).padStart(4)}s  │ ${pct(exAboveDown, exAbove).padStart(18)}% │ ${pct(refAboveDown, refAbove).padStart(19)}% │ ${String(exAbove).padStart(13)} │ ${String(refAbove).padStart(14)}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────\n');
}

// ─── Strategy: Divergence-based entry ───

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  LAG-D STRATEGY: Divergence Snap-Back Trading');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Strategy: When exchange-CL gap is large, CL will snap toward exchanges.
  // If CL is above strike but exchanges have dropped below → CL will follow down → buy DOWN
  // If CL is below strike but exchanges have risen above → CL will follow up → buy UP

  const sweepGrid = {
    lookbackOffset: [10000, 20000, 30000, 60000],
    gapSource: ['EXCHANGE', 'POLYREF'],        // which feed to compare against CL
    minGap: [40, 60, 80, 100, 120],           // min gap size to trigger
    maxTokenPrice: [0.50, 0.60, 0.70, 0.80],
    direction: ['DOWN_ONLY', 'UP_ONLY', 'BOTH'],
    // Strategy mode:
    // 'POSITION': gap > minGap AND feed predicts direction → buy direction token
    // 'SNAPBACK': large gap → CL will move toward feed → predict based on feed position vs strike
    mode: ['POSITION', 'SNAPBACK'],
  };

  const paramSets = [];
  for (const lo of sweepGrid.lookbackOffset) {
    for (const gs of sweepGrid.gapSource) {
      for (const mg of sweepGrid.minGap) {
        for (const mtp of sweepGrid.maxTokenPrice) {
          for (const dir of sweepGrid.direction) {
            for (const mode of sweepGrid.mode) {
              paramSets.push({ lookbackOffset: lo, gapSource: gs, minGap: mg, maxTokenPrice: mtp, direction: dir, mode });
            }
          }
        }
      }
    }
  }

  console.log(`  Sweeping ${paramSets.length} parameter combinations...\n`);

  const allResults = [];
  const t0 = Date.now();

  for (const params of paramSets) {
    const trades = [];

    for (const win of windows) {
      const s = win.sampleMap[params.lookbackOffset];
      if (!s || s._cl == null || s._strike == null) continue;

      let gap, feedPrice;
      if (params.gapSource === 'EXCHANGE') {
        if (s._exClGap == null) continue;
        gap = s._exClGap;         // exchange_median - CL (positive = exchange above CL)
        feedPrice = s._exMedian;
      } else {
        if (s._refClGap == null) continue;
        gap = s._refClGap;        // polyRef - CL
        feedPrice = s._ref;
      }

      if (Math.abs(gap) < params.minGap) continue;

      let prediction;
      if (params.mode === 'SNAPBACK') {
        // CL will snap toward feed. Predict based on WHERE feed is vs strike.
        prediction = feedPrice > s._strike ? 'UP' : 'DOWN';
      } else {
        // POSITION mode: if gap > 0 (feed above CL), CL will rise → UP
        // But also consider: the structural gap means exchange is ALWAYS above CL.
        // So we need to check if the gap is LARGER than structural (~80) → unusual movement
        prediction = gap > 0 ? 'UP' : 'DOWN';
        // Actually this doesn't work well because gap is always positive.
        // Let's use: is the gap GROWING (exchange moving away) → CL will follow
        // For POSITION mode, use feed vs strike instead
        prediction = feedPrice > s._strike ? 'UP' : 'DOWN';
      }

      if (params.direction === 'DOWN_ONLY' && prediction !== 'DOWN') continue;
      if (params.direction === 'UP_ONLY' && prediction !== 'UP') continue;

      let tokenAsk, won;
      if (prediction === 'DOWN') {
        tokenAsk = s._downAsk;
        won = win.resolved === 'DOWN';
      } else {
        tokenAsk = s._upAsk;
        won = win.resolved === 'UP';
      }

      if (tokenAsk == null || isNaN(tokenAsk) || tokenAsk <= 0 || tokenAsk >= 1) continue;
      if (tokenAsk >= params.maxTokenPrice) continue;

      const fillPrice = tokenAsk + 0.005;
      if (fillPrice >= 1) continue;
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({
        closeTime: win.closeTime, prediction, tokenAsk, fillPrice, won, pnl,
        gap, feedPrice, cl: s._cl, strike: s._strike, resolved: win.resolved,
      });
    }

    if (trades.length === 0) continue;

    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    let capital = 100, peak = 100, maxDD = 0;
    for (const t of trades) {
      capital -= t.fillPrice; capital += t.won ? 1.0 : 0;
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    allResults.push({ params, tradeCount: trades.length, wins, winRate: wr, avgEntry, ev, totalPnl, maxDD, trades });
  }

  const sweepMs = Date.now() - t0;
  allResults.sort((a, b) => b.ev - a.ev);

  const profitable = allResults.filter(r => r.ev > 0);
  console.log(`  Sweep: ${paramSets.length} configs in ${sweepMs}ms`);
  console.log(`  ${allResults.length}/${paramSets.length} produced trades, ${profitable.length} show +EV\n`);

  if (allResults.length > 0) {
    console.log('  Top 25 by EV/trade:');
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ Source  │ MinGap │ Mode     │ MaxPx │ Dir       │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.lookbackOffset / 1000).padStart(4)}s │ ${p.gapSource.padEnd(7)} │ $${String(p.minGap).padStart(4)} │ ${p.mode.padEnd(8)} │ ${p.maxTokenPrice.toFixed(2).padStart(5)} │ ${p.direction.padEnd(9)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

    // Best config trade log
    const best = allResults[0];
    console.log(`\n  BEST: offset=${best.params.lookbackOffset / 1000}s, source=${best.params.gapSource}, minGap=$${best.params.minGap}, mode=${best.params.mode}, maxPx=${best.params.maxTokenPrice}, dir=${best.params.direction}`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);

    if (best.trades.length <= 30) {
      console.log('  Trade log:');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(
          `    ${et} | ${t.prediction.padEnd(4)} | gap=$${t.gap.toFixed(0).padStart(5)} | feed=$${t.feedPrice.toFixed(0)} | cl=$${t.cl.toFixed(0)} | strike=$${t.strike.toFixed(0)} | ask=${t.tokenAsk.toFixed(3)} | ${t.resolved.padEnd(4)} | ${pnlStr}`
        );
      }
    }
  }

  // ─── Source comparison ───
  console.log('\n  ── Gap Source Comparison ──\n');
  for (const gs of ['EXCHANGE', 'POLYREF']) {
    const gsResults = allResults.filter(r => r.params.gapSource === gs);
    if (gsResults.length === 0) continue;
    const bestEV = gsResults[0].ev;
    const medEV = median(gsResults.map(r => r.ev));
    console.log(`  ${gs}: ${gsResults.length} configs, best EV=$${bestEV.toFixed(4)}, median EV=$${medEV?.toFixed(4)}`);
  }

  console.log('\n  ── Mode Comparison ──\n');
  for (const mode of ['POSITION', 'SNAPBACK']) {
    const mResults = allResults.filter(r => r.params.mode === mode);
    if (mResults.length === 0) continue;
    const bestEV = mResults[0].ev;
    const medEV = median(mResults.map(r => r.ev));
    console.log(`  ${mode}: ${mResults.length} configs, best EV=$${bestEV.toFixed(4)}, median EV=$${medEV?.toFixed(4)}`);
  }
  console.log();

  return allResults;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  LAG-D: Exchange-CL Divergence Snap-Back                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);

  runDiagnostic(windows);
  runStrategy(windows);

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Lag-D failed:', err); pool.end(); process.exit(1); });
