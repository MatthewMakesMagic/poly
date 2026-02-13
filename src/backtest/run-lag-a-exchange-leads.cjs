/**
 * Lag Strategy A: Exchange Leads CL to Settlement
 *
 * Core thesis: Exchange prices at T-Xs before close LEAD where CL will settle.
 * CL lags exchanges by ~878ms. At 10-30s before close, exchange median shows
 * the "true" price that CL hasn't reached yet. If exchange median predicts
 * resolution direction and CLOB hasn't fully priced it → edge.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-lag-a-exchange-leads.cjs
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

// ─── Load & Enrich ───

async function loadWindows() {
  const rows = await pool.query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_down_mid,
           clob_up_bid, clob_up_ask, clob_up_mid,
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
      s._downBid = s.clob_down_bid ? parseFloat(s.clob_down_bid) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
      s._upBid = s.clob_up_bid ? parseFloat(s.clob_up_bid) : null;

      const exPrices = [
        s.exchange_binance, s.exchange_coinbase, s.exchange_kraken,
        s.exchange_bybit, s.exchange_okx,
      ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));
      s._exCount = exPrices.length;
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
      s._exMin = exPrices.length >= 2 ? Math.min(...exPrices) : null;
      s._exMax = exPrices.length >= 2 ? Math.max(...exPrices) : null;
    }
  }

  return windows;
}

// ─── Diagnostics: How well does exchange median predict settlement? ───

function runDiagnostic(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC: Exchange Median Direction Prediction');
  console.log('═══════════════════════════════════════════════════════════\n');

  const offsets = [10000, 20000, 30000, 60000, 120000, 300000];

  console.log('  At each offset, does exchange_median > strike predict UP settlement?');
  console.log('  ─────────────────────────────────────────────────────────────────────');
  console.log('  Offset   │ Windows │ Correct │ Accuracy │ Pred UP ok │ Pred DOWN ok');
  console.log('  ─────────────────────────────────────────────────────────────────────');

  for (const offset of offsets) {
    let total = 0, correct = 0, predUp = 0, predUpOk = 0, predDown = 0, predDownOk = 0;

    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._exMedian == null || s._strike == null) continue;

      total++;
      const prediction = s._exMedian > s._strike ? 'UP' : 'DOWN';

      if (prediction === 'UP') {
        predUp++;
        if (win.resolved === 'UP') { correct++; predUpOk++; }
      } else {
        predDown++;
        if (win.resolved === 'DOWN') { correct++; predDownOk++; }
      }
    }

    console.log(
      `  ${String(offset / 1000).padStart(4)}s    │ ${String(total).padStart(7)} │ ${String(correct).padStart(7)} │ ${pct(correct, total).padStart(6)}%  │ ${predUpOk}/${predUp} (${pct(predUpOk, predUp)}%)   │ ${predDownOk}/${predDown} (${pct(predDownOk, predDown)}%)`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────────');

  // Same but with margin buffer
  console.log('\n  With margin buffer (only trade when exchange median is $X away from strike):');
  console.log('  ──────────────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ Margin │ Eligible │ Correct │ Accuracy │ Pred UP ok │ Pred DOWN ok');
  console.log('  ──────────────────────────────────────────────────────────────────────────────');

  for (const offset of [10000, 20000, 30000, 60000]) {
    for (const margin of [0, 20, 50, 80, 100, 150]) {
      let total = 0, correct = 0, predUp = 0, predUpOk = 0, predDown = 0, predDownOk = 0;

      for (const win of windows) {
        const s = win.sampleMap[offset];
        if (!s || s._exMedian == null || s._strike == null) continue;

        const gap = s._exMedian - s._strike;
        if (Math.abs(gap) < margin) continue; // skip if too close to strike

        total++;
        const prediction = gap > 0 ? 'UP' : 'DOWN';

        if (prediction === 'UP') {
          predUp++;
          if (win.resolved === 'UP') { correct++; predUpOk++; }
        } else {
          predDown++;
          if (win.resolved === 'DOWN') { correct++; predDownOk++; }
        }
      }

      if (total === 0) continue;
      console.log(
        `  ${String(offset / 1000).padStart(4)}s  │ $${String(margin).padStart(4)} │ ${String(total).padStart(8)} │ ${String(correct).padStart(7)} │ ${pct(correct, total).padStart(6)}%  │ ${predUpOk}/${predUp} (${pct(predUpOk, predUp)}%)   │ ${predDownOk}/${predDown} (${pct(predDownOk, predDown)}%)`
      );
    }
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────\n');
}

// ─── Strategy: Buy predicted direction from CLOB ───

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  LAG-A STRATEGY: Buy Predicted Direction from CLOB');
  console.log('═══════════════════════════════════════════════════════════\n');

  const sweepGrid = {
    lookbackOffset: [10000, 20000, 30000, 60000],
    marginBuffer: [0, 20, 50, 80, 100],
    maxTokenPrice: [0.50, 0.60, 0.70, 0.80, 0.90],
    direction: ['DOWN_ONLY', 'UP_ONLY', 'BOTH'],
  };

  const paramSets = [];
  for (const lo of sweepGrid.lookbackOffset) {
    for (const mb of sweepGrid.marginBuffer) {
      for (const mtp of sweepGrid.maxTokenPrice) {
        for (const dir of sweepGrid.direction) {
          paramSets.push({ lookbackOffset: lo, marginBuffer: mb, maxTokenPrice: mtp, direction: dir });
        }
      }
    }
  }

  console.log(`  Sweeping ${paramSets.length} parameter combinations...\n`);

  const allResults = [];

  for (const params of paramSets) {
    const trades = [];

    for (const win of windows) {
      const s = win.sampleMap[params.lookbackOffset];
      if (!s || s._exMedian == null || s._strike == null) continue;

      const gap = s._exMedian - s._strike;
      if (Math.abs(gap) < params.marginBuffer) continue;

      const prediction = gap > 0 ? 'UP' : 'DOWN';

      // Decide what to buy
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
        closeTime: win.closeTime,
        prediction,
        tokenAsk,
        fillPrice,
        won,
        pnl,
        exMedian: s._exMedian,
        strike: s._strike,
        gap,
        resolved: win.resolved,
      });
    }

    if (trades.length === 0) continue;

    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    // Max drawdown
    let capital = 100, peak = 100, maxDD = 0;
    for (const t of trades) {
      capital -= t.fillPrice;
      capital += t.won ? 1.0 : 0;
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    allResults.push({
      params,
      tradeCount: trades.length,
      wins,
      winRate: wr,
      avgEntry,
      ev,
      totalPnl,
      maxDD,
      trades,
    });
  }

  // Sort by EV/trade
  allResults.sort((a, b) => b.ev - a.ev);

  const profitable = allResults.filter(r => r.ev > 0);
  console.log(`  ${allResults.length}/${paramSets.length} configs produced trades`);
  console.log(`  ${profitable.length}/${allResults.length} configs show positive EV\n`);

  if (allResults.length > 0) {
    console.log('  Top 25 by EV/trade:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ Margin │ MaxPx │ Direction │ Trades │ WinRate │ AvgEntry │ EV/Trade │ TotPnL │ MaxDD');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.lookbackOffset / 1000).padStart(4)}s │ $${String(p.marginBuffer).padStart(4)} │ ${p.maxTokenPrice.toFixed(2).padStart(5)} │ ${p.direction.padEnd(9)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)} │ ${(r.maxDD * 100).toFixed(1).padStart(5)}%`
      );
    }

    // Bottom 5
    if (allResults.length > 25) {
      console.log('  ...');
      const bottom = allResults.slice(-5);
      for (let i = 0; i < bottom.length; i++) {
        const r = bottom[i];
        const p = r.params;
        console.log(
          `  ${String(allResults.length - 4 + i).padStart(4)} │ ${String(p.lookbackOffset / 1000).padStart(4)}s │ $${String(p.marginBuffer).padStart(4)} │ ${p.maxTokenPrice.toFixed(2).padStart(5)} │ ${p.direction.padEnd(9)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)} │ ${(r.maxDD * 100).toFixed(1).padStart(5)}%`
        );
      }
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');

    // Best config detail
    const best = allResults[0];
    console.log(`\n  BEST CONFIG: offset=${best.params.lookbackOffset / 1000}s, margin=$${best.params.marginBuffer}, maxPx=${best.params.maxTokenPrice}, dir=${best.params.direction}`);
    console.log(`    Trades: ${best.tradeCount}, Wins: ${best.wins}, WR: ${(best.winRate * 100).toFixed(1)}%, EV/trade: $${best.ev.toFixed(4)}, PnL: $${best.totalPnl.toFixed(2)}\n`);

    // Trade log for best config
    if (best.trades.length <= 30) {
      console.log('  Trade log (best config):');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(
          `    ${et} | pred=${t.prediction.padEnd(4)} | exMed=$${t.exMedian.toFixed(0)} | strike=$${t.strike.toFixed(0)} | gap=$${t.gap.toFixed(0).padStart(5)} | ask=${t.tokenAsk.toFixed(3)} | ${t.resolved.padEnd(4)} | ${pnlStr}`
        );
      }
    }
  }

  // ─── Direction-specific analysis ───
  console.log('\n  ── Direction Breakdown ──\n');

  for (const dir of ['DOWN_ONLY', 'UP_ONLY', 'BOTH']) {
    const dirResults = allResults.filter(r => r.params.direction === dir);
    if (dirResults.length === 0) continue;
    const bestDir = dirResults[0];
    const medianEV = median(dirResults.map(r => r.ev));
    console.log(`  ${dir}: ${dirResults.length} configs, best EV=$${bestDir.ev.toFixed(4)}, median EV=$${medianEV?.toFixed(4)}, best WR=${(bestDir.winRate * 100).toFixed(1)}%`);
  }
  console.log();

  return allResults;
}

// ─── Main ───

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  LAG-A: Exchange Leads CL to Settlement                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);

  runDiagnostic(windows);
  runStrategy(windows);

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => {
  console.error('Lag-A failed:', err);
  pool.end();
  process.exit(1);
});
