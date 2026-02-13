/**
 * Lag Strategy B: PolyRef Leads CL to Settlement
 *
 * Core thesis: PolyRef has 96.1% direction accuracy for predicting CL settlement.
 * It's the BEST single predictor we have. CL lags polyRef by ~878ms (median).
 * At T-10s/T-30s, polyRef shows where CL is heading. If CLOB hasn't priced
 * this fully → edge.
 *
 * Key insight: PolyRef is Polymarket's composite reference price — the thing
 * CLOB market makers watch. So CLOB should already incorporate polyRef. The
 * edge (if any) is in the Chainlink-specific lag: polyRef predicts CL better
 * than CL predicts itself, and the CLOB may not fully account for the
 * structural CL-polyRef gap.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-lag-b-polyref-leads.cjs
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
    }
  }
  return windows;
}

// ─── Diagnostic: PolyRef direction accuracy at each offset ───

function runDiagnostic(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC: PolyRef Direction Prediction Accuracy');
  console.log('═══════════════════════════════════════════════════════════\n');

  const offsets = [0, 10000, 20000, 30000, 60000, 120000, 300000];

  console.log('  Raw prediction: polyRef > strike → UP, polyRef < strike → DOWN');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('  Offset   │ Windows │ Correct │ Accuracy │ Pred UP ok │ Pred DOWN ok');
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  for (const offset of offsets) {
    let total = 0, correct = 0, predUp = 0, predUpOk = 0, predDown = 0, predDownOk = 0;
    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._ref == null || s._strike == null) continue;
      total++;
      const prediction = s._ref > s._strike ? 'UP' : 'DOWN';
      if (prediction === 'UP') { predUp++; if (win.resolved === 'UP') { correct++; predUpOk++; } }
      else { predDown++; if (win.resolved === 'DOWN') { correct++; predDownOk++; } }
    }
    console.log(
      `  ${String(offset / 1000).padStart(4)}s    │ ${String(total).padStart(7)} │ ${String(correct).padStart(7)} │ ${pct(correct, total).padStart(6)}%  │ ${predUpOk}/${predUp} (${pct(predUpOk, predUp)}%)   │ ${predDownOk}/${predDown} (${pct(predDownOk, predDown)}%)`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  // With deficit adjustment: polyRef - deficit_estimate > strike → UP
  console.log('\n  Deficit-adjusted prediction: (polyRef - deficit_est) > strike → UP');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ Deficit │ Windows │ Correct │ Accuracy │ Pred DOWN ok');
  console.log('  ──────────────────────────────────────────────────────────────────────────');

  for (const offset of [10000, 30000, 60000]) {
    for (const deficitEst of [0, 40, 60, 80, 100, 120]) {
      let total = 0, correct = 0, predDown = 0, predDownOk = 0;
      for (const win of windows) {
        const s = win.sampleMap[offset];
        if (!s || s._ref == null || s._strike == null) continue;
        total++;
        // Adjust polyRef by estimated Chainlink deficit
        const adjustedRef = s._ref - deficitEst;
        const prediction = adjustedRef > s._strike ? 'UP' : 'DOWN';
        if (prediction === win.resolved) correct++;
        if (prediction === 'DOWN') { predDown++; if (win.resolved === 'DOWN') predDownOk++; }
      }
      console.log(
        `  ${String(offset / 1000).padStart(4)}s  │ $${String(deficitEst).padStart(5)} │ ${String(total).padStart(7)} │ ${String(correct).padStart(7)} │ ${pct(correct, total).padStart(6)}%  │ ${predDownOk}/${predDown} (${pct(predDownOk, predDown)}%)`
      );
    }
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────\n');
}

// ─── Strategy: PolyRef-based direction + CLOB entry ───

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  LAG-B STRATEGY: PolyRef Predicts Settlement → CLOB Entry');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Strategy variants:
  // 1. Raw: polyRef vs strike → buy predicted direction token
  // 2. Deficit-adjusted: (polyRef - deficit_est) vs strike
  // 3. Margin: only trade when polyRef is $X away from strike (high confidence)
  // 4. Contrarian: polyRef says UP but deficit makes DOWN likely — buy DOWN

  const sweepGrid = {
    lookbackOffset: [10000, 20000, 30000, 60000],
    deficitAdjust: [0, 60, 80, 100],          // subtract from polyRef to estimate CL
    marginBuffer: [0, 20, 50, 100],           // min distance from strike
    maxTokenPrice: [0.50, 0.60, 0.70, 0.80],
    direction: ['DOWN_ONLY', 'UP_ONLY', 'BOTH'],
  };

  const paramSets = [];
  for (const lo of sweepGrid.lookbackOffset) {
    for (const da of sweepGrid.deficitAdjust) {
      for (const mb of sweepGrid.marginBuffer) {
        for (const mtp of sweepGrid.maxTokenPrice) {
          for (const dir of sweepGrid.direction) {
            paramSets.push({ lookbackOffset: lo, deficitAdjust: da, marginBuffer: mb, maxTokenPrice: mtp, direction: dir });
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
      if (!s || s._ref == null || s._strike == null) continue;

      // Adjust polyRef by estimated deficit
      const adjustedRef = s._ref - params.deficitAdjust;
      const gap = adjustedRef - s._strike;
      if (Math.abs(gap) < params.marginBuffer) continue;

      const prediction = gap > 0 ? 'UP' : 'DOWN';

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

      trades.push({ closeTime: win.closeTime, prediction, tokenAsk, fillPrice, won, pnl, ref: s._ref, adjustedRef, strike: s._strike, gap, resolved: win.resolved, cl: s._cl });
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
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ DefAdj │ Margin │ MaxPx │ Dir       │ Trades │ WinRate │ AvgEntry │ EV/Trade │ TotPnL');
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.lookbackOffset / 1000).padStart(4)}s │ $${String(p.deficitAdjust).padStart(4)} │ $${String(p.marginBuffer).padStart(4)} │ ${p.maxTokenPrice.toFixed(2).padStart(5)} │ ${p.direction.padEnd(9)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');

    // Best config trade log
    const best = allResults[0];
    console.log(`\n  BEST: offset=${best.params.lookbackOffset / 1000}s, defAdj=$${best.params.deficitAdjust}, margin=$${best.params.marginBuffer}, maxPx=${best.params.maxTokenPrice}, dir=${best.params.direction}`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);

    if (best.trades.length <= 30) {
      console.log('  Trade log:');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(
          `    ${et} | ${t.prediction.padEnd(4)} | ref=$${t.ref.toFixed(0)} | adj=$${t.adjustedRef.toFixed(0)} | strike=$${t.strike.toFixed(0)} | ask=${t.tokenAsk.toFixed(3)} | ${t.resolved.padEnd(4)} | ${pnlStr}`
        );
      }
    }
  }

  // ─── Key question: Does deficit-adjusted polyRef beat raw polyRef? ───
  console.log('\n  ── Deficit Adjustment Impact ──\n');

  for (const da of [0, 60, 80, 100]) {
    const daResults = allResults.filter(r => r.params.deficitAdjust === da);
    if (daResults.length === 0) continue;
    const bestEV = daResults[0].ev;
    const medEV = median(daResults.map(r => r.ev));
    console.log(`  DeficitAdjust=$${da}: ${daResults.length} configs, best EV=$${bestEV.toFixed(4)}, median EV=$${medEV?.toFixed(4)}`);
  }
  console.log();

  return allResults;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  LAG-B: PolyRef Leads CL to Settlement                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);

  runDiagnostic(windows);
  runStrategy(windows);

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Lag-B failed:', err); pool.end(); process.exit(1); });
