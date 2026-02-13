/**
 * Lag Strategy C: CL Velocity Extrapolation
 *
 * Core thesis: Chainlink moves with measurable velocity. By computing its
 * rate of change from T-60s → T-30s → T-10s, we can extrapolate where it
 * will land at T=0 (close). If projected CL crosses the strike threshold
 * differently than current CL suggests → early signal.
 *
 * This exploits the fact that CL moves $50-70/min on average in the final
 * 2 minutes. If we can predict the DIRECTION of that movement, we know
 * the settlement before it happens.
 *
 * Variants:
 *   1. Linear extrapolation from 2 sample points
 *   2. Weighted extrapolation (recent velocity counts more)
 *   3. Exchange-informed velocity (use exchange momentum as CL predictor)
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-lag-c-velocity-extrap.cjs
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
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
    }
  }
  return windows;
}

// ─── Diagnostic: Velocity prediction accuracy ───

function runDiagnostic(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC: CL Velocity Extrapolation Accuracy');
  console.log('═══════════════════════════════════════════════════════════\n');

  // For each window, compute CL velocity from two sample points, extrapolate to close
  const configs = [
    { name: '120s→60s, extrap to 0s', from: 120000, to: 60000 },
    { name: '60s→30s, extrap to 0s', from: 60000, to: 30000 },
    { name: '30s→10s, extrap to 0s', from: 30000, to: 10000 },
    { name: '60s→10s, extrap to 0s', from: 60000, to: 10000 },
    { name: '120s→10s, extrap to 0s', from: 120000, to: 10000 },
  ];

  console.log('  Linear extrapolation: CL_projected = CL_at_T2 + velocity * remaining_time');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');
  console.log('  Velocity Window   │ Samples │ Avg |Error| │ Med |Error| │ Dir Correct │ Dir Acc');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  for (const cfg of configs) {
    const errors = [];
    let dirCorrect = 0, dirTotal = 0;

    for (const win of windows) {
      const sFrom = win.sampleMap[cfg.from];
      const sTo = win.sampleMap[cfg.to];
      const sClose = win.sampleMap[0];
      if (!sFrom || !sTo || !sClose) continue;
      if (sFrom._cl == null || sTo._cl == null || sClose._cl == null || sFrom._strike == null) continue;

      // Velocity: $/ms
      const dt = cfg.from - cfg.to; // ms between samples
      const velocity = (sTo._cl - sFrom._cl) / dt; // $/ms

      // Extrapolate from the later sample to close
      const remaining = cfg.to; // ms remaining from T2 to close
      const projected = sTo._cl + velocity * remaining;
      const actual = sClose._cl;

      errors.push(Math.abs(projected - actual));

      // Direction prediction: does projected CL cross strike the same way as actual?
      const projDirection = projected > sFrom._strike ? 'UP' : 'DOWN';
      dirTotal++;
      if (projDirection === win.resolved) dirCorrect++;
    }

    if (errors.length === 0) continue;
    const avgErr = errors.reduce((s, e) => s + e, 0) / errors.length;
    const medErr = median(errors);

    console.log(
      `  ${cfg.name.padEnd(25)} │ ${String(errors.length).padStart(7)} │ $${avgErr.toFixed(1).padStart(10)} │ $${medErr.toFixed(1).padStart(10)} │ ${String(dirCorrect).padStart(8)}/${dirTotal} │ ${pct(dirCorrect, dirTotal).padStart(5)}%`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  // Exchange-informed velocity: use exchange median velocity instead of CL velocity
  console.log('\n  Exchange-informed extrapolation: use exchange median velocity to predict CL');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');
  console.log('  Velocity Window   │ Samples │ Avg |Error| │ Med |Error| │ Dir Correct │ Dir Acc');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  for (const cfg of configs) {
    const errors = [];
    let dirCorrect = 0, dirTotal = 0;

    for (const win of windows) {
      const sFrom = win.sampleMap[cfg.from];
      const sTo = win.sampleMap[cfg.to];
      const sClose = win.sampleMap[0];
      if (!sFrom || !sTo || !sClose) continue;
      if (sFrom._exMedian == null || sTo._exMedian == null || sTo._cl == null || sClose._cl == null || sFrom._strike == null) continue;

      // Use exchange median velocity
      const dt = cfg.from - cfg.to;
      const exVelocity = (sTo._exMedian - sFrom._exMedian) / dt;

      // Apply exchange velocity to CL position (CL will follow exchanges)
      const remaining = cfg.to;
      const projected = sTo._cl + exVelocity * remaining;
      const actual = sClose._cl;

      errors.push(Math.abs(projected - actual));

      const projDirection = projected > sFrom._strike ? 'UP' : 'DOWN';
      dirTotal++;
      if (projDirection === win.resolved) dirCorrect++;
    }

    if (errors.length === 0) continue;
    const avgErr = errors.reduce((s, e) => s + e, 0) / errors.length;
    const medErr = median(errors);

    console.log(
      `  ${('ex:' + cfg.name).padEnd(25)} │ ${String(errors.length).padStart(7)} │ $${avgErr.toFixed(1).padStart(10)} │ $${medErr.toFixed(1).padStart(10)} │ ${String(dirCorrect).padStart(8)}/${dirTotal} │ ${pct(dirCorrect, dirTotal).padStart(5)}%`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');
}

// ─── Strategy: Velocity-based entry ───

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  LAG-C STRATEGY: Velocity Extrapolation → CLOB Entry');
  console.log('═══════════════════════════════════════════════════════════\n');

  const sweepGrid = {
    velocityFrom: [120000, 60000, 30000],
    velocityTo: [60000, 30000, 10000],
    velocitySource: ['CL', 'EXCHANGE'],       // use CL or exchange median velocity
    confidenceMargin: [0, 20, 50, 100],       // projected must be $X from strike
    maxTokenPrice: [0.50, 0.60, 0.70, 0.80],
    direction: ['DOWN_ONLY', 'BOTH'],
  };

  // Generate valid pairs (from > to)
  const paramSets = [];
  for (const vf of sweepGrid.velocityFrom) {
    for (const vt of sweepGrid.velocityTo) {
      if (vf <= vt) continue;
      for (const vs of sweepGrid.velocitySource) {
        for (const cm of sweepGrid.confidenceMargin) {
          for (const mtp of sweepGrid.maxTokenPrice) {
            for (const dir of sweepGrid.direction) {
              paramSets.push({ velocityFrom: vf, velocityTo: vt, velocitySource: vs, confidenceMargin: cm, maxTokenPrice: mtp, direction: dir });
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
      const sFrom = win.sampleMap[params.velocityFrom];
      const sTo = win.sampleMap[params.velocityTo];
      if (!sFrom || !sTo || sFrom._strike == null) continue;

      let velocity;
      const dt = params.velocityFrom - params.velocityTo;

      if (params.velocitySource === 'CL') {
        if (sFrom._cl == null || sTo._cl == null) continue;
        velocity = (sTo._cl - sFrom._cl) / dt;
      } else {
        if (sFrom._exMedian == null || sTo._exMedian == null) continue;
        velocity = (sTo._exMedian - sFrom._exMedian) / dt;
      }

      // Extrapolate CL to close
      const clAtTo = sTo._cl;
      if (clAtTo == null) continue;
      const remaining = params.velocityTo; // ms from velocity end point to close
      const projected = clAtTo + velocity * remaining;

      const gap = projected - sFrom._strike;
      if (Math.abs(gap) < params.confidenceMargin) continue;

      const prediction = gap > 0 ? 'UP' : 'DOWN';
      if (params.direction === 'DOWN_ONLY' && prediction !== 'DOWN') continue;

      // Entry: buy token at the lookback offset (velocityTo timestamp)
      let tokenAsk, won;
      if (prediction === 'DOWN') {
        tokenAsk = sTo._downAsk;
        won = win.resolved === 'DOWN';
      } else {
        tokenAsk = sTo._upAsk;
        won = win.resolved === 'UP';
      }

      if (tokenAsk == null || isNaN(tokenAsk) || tokenAsk <= 0 || tokenAsk >= 1) continue;
      if (tokenAsk >= params.maxTokenPrice) continue;

      const fillPrice = tokenAsk + 0.005;
      if (fillPrice >= 1) continue;
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({
        closeTime: win.closeTime, prediction, tokenAsk, fillPrice, won, pnl,
        projected, strike: sFrom._strike, gap, velocity: velocity * 1000, // $/sec
        resolved: win.resolved,
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
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ VelFrom │ VelTo │ Source  │ Margin │ MaxPx │ Dir       │ Trades │ WinRate │ AvgEntry │ EV/Trade');
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.velocityFrom / 1000).padStart(5)}s │ ${String(p.velocityTo / 1000).padStart(3)}s  │ ${p.velocitySource.padEnd(7)} │ $${String(p.confidenceMargin).padStart(4)} │ ${p.maxTokenPrice.toFixed(2).padStart(5)} │ ${p.direction.padEnd(9)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)}`
      );
    }
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────');

    // Best config trade log
    const best = allResults[0];
    console.log(`\n  BEST: velFrom=${best.params.velocityFrom / 1000}s, velTo=${best.params.velocityTo / 1000}s, source=${best.params.velocitySource}, margin=$${best.params.confidenceMargin}, maxPx=${best.params.maxTokenPrice}, dir=${best.params.direction}`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);

    if (best.trades.length <= 30) {
      console.log('  Trade log:');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(
          `    ${et} | ${t.prediction.padEnd(4)} | proj=$${t.projected.toFixed(0)} | strike=$${t.strike.toFixed(0)} | vel=$${t.velocity.toFixed(1)}/s | ask=${t.tokenAsk.toFixed(3)} | ${t.resolved.padEnd(4)} | ${pnlStr}`
        );
      }
    }
  }

  // ─── CL vs Exchange velocity comparison ───
  console.log('\n  ── Velocity Source Comparison ──\n');
  for (const vs of ['CL', 'EXCHANGE']) {
    const vsResults = allResults.filter(r => r.params.velocitySource === vs);
    if (vsResults.length === 0) continue;
    const bestEV = vsResults[0].ev;
    const medEV = median(vsResults.map(r => r.ev));
    console.log(`  ${vs}: ${vsResults.length} configs, best EV=$${bestEV.toFixed(4)}, median EV=$${medEV?.toFixed(4)}`);
  }
  console.log();

  return allResults;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  LAG-C: CL Velocity Extrapolation                        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);

  runDiagnostic(windows);
  runStrategy(windows);

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Lag-C failed:', err); pool.end(); process.exit(1); });
