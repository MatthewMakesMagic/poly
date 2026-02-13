/**
 * Edge J: Late Entry (Maximum Information)
 *
 * Enter at the LATEST possible moment (10-30s before close) when we have
 * maximum information about where CL will settle. The trade-off: CLOB
 * prices are more efficient at this point, so edge may be thinner.
 *
 * Tests whether the information advantage of late entry outweighs the
 * market efficiency that comes with it.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-j-late-entry.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });

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
      s._deficit = (s._strike != null && s._cl != null) ? s._strike - s._cl : null;

      const exPrices = [
        s.exchange_binance, s.exchange_coinbase, s.exchange_kraken,
        s.exchange_bybit, s.exchange_okx,
      ].map(p => p ? parseFloat(p) : null).filter(p => p != null && !isNaN(p));
      s._exMedian = exPrices.length >= 3 ? median(exPrices) : null;
    }
  }
  return windows;
}

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE J: Late Entry — Maximum Information');
  console.log('═══════════════════════════════════════════════════════════\n');

  // First: diagnostic — how efficient are CLOB prices at different offsets?
  console.log('  ── CLOB Efficiency by Time to Close ──\n');
  console.log('  How well does DOWN ask at time T predict actual resolution?');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Offset │ With CLOB │ Avg DOWN ask │ Actual DOWN% │ Mismatch');
  console.log('  ─────────────────────────────────────────────────────────────');

  for (const offset of [10000, 20000, 30000, 60000, 120000, 300000]) {
    let total = 0;
    const asks = [];
    let downCount = 0;

    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._downAsk == null || isNaN(s._downAsk) || s._downAsk <= 0) continue;
      total++;
      asks.push(s._downAsk);
      if (win.resolved === 'DOWN') downCount++;
    }

    if (total === 0) continue;
    const avgAsk = asks.reduce((s, a) => s + a, 0) / asks.length;
    const downRate = downCount / total;
    const mismatch = downRate - avgAsk; // positive = market under-prices DOWN

    console.log(
      `  ${String(offset / 1000).padStart(4)}s  │ ${String(total).padStart(9)} │ ${avgAsk.toFixed(4).padStart(12)} │ ${pct(downCount, total).padStart(12)}% │ ${mismatch >= 0 ? '+' : ''}${(mismatch * 100).toFixed(1)}pp`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────\n');

  // Strategy sweep: at late offsets, buy DOWN using various filters
  const sweepGrid = {
    entryOffset: [10000, 20000, 30000],        // LATE entry only
    signal: ['CLOB_CONTESTED', 'DEFICIT', 'EXCHANGE_PRED', 'CL_BELOW_STRIKE', 'COMBINED'],
    maxDownPrice: [0.40, 0.50, 0.60, 0.70, 0.80],
    minDownPrice: [0, 0.10, 0.15, 0.20],       // contested threshold
  };

  const paramSets = [];
  for (const eo of sweepGrid.entryOffset) {
    for (const sig of sweepGrid.signal) {
      for (const mdp of sweepGrid.maxDownPrice) {
        for (const minp of sweepGrid.minDownPrice) {
          if (minp >= mdp) continue;
          paramSets.push({ entryOffset: eo, signal: sig, maxDownPrice: mdp, minDownPrice: minp });
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
      const s = win.sampleMap[params.entryOffset];
      if (!s || s._downAsk == null || isNaN(s._downAsk) || s._downAsk <= 0) continue;
      if (s._downAsk < params.minDownPrice || s._downAsk >= params.maxDownPrice) continue;

      // Signal-specific filters
      let pass = false;
      switch (params.signal) {
        case 'CLOB_CONTESTED':
          pass = true; // just the price filter
          break;
        case 'DEFICIT':
          pass = s._deficit != null && s._deficit > 80;
          break;
        case 'EXCHANGE_PRED':
          pass = s._exMedian != null && s._strike != null && s._exMedian < s._strike;
          break;
        case 'CL_BELOW_STRIKE':
          pass = s._cl != null && s._strike != null && s._cl < s._strike;
          break;
        case 'COMBINED':
          pass = s._deficit != null && s._deficit > 60 && s._exMedian != null && s._strike != null && s._exMedian < s._strike + 50;
          break;
      }
      if (!pass) continue;

      const fillPrice = s._downAsk + 0.005;
      if (fillPrice >= 1) continue;
      const won = win.resolved === 'DOWN';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({ closeTime: win.closeTime, fillPrice, won, pnl, downAsk: s._downAsk, resolved: win.resolved });
    }

    if (trades.length === 0) continue;

    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    allResults.push({ params, tradeCount: trades.length, wins, winRate: wr, avgEntry, ev, totalPnl, trades });
  }

  const sweepMs = Date.now() - t0;
  allResults.sort((a, b) => b.ev - a.ev);

  const profitable = allResults.filter(r => r.ev > 0);
  console.log(`  Sweep: ${paramSets.length} configs in ${sweepMs}ms`);
  console.log(`  ${allResults.length}/${paramSets.length} produced trades, ${profitable.length} show +EV\n`);

  if (allResults.length > 0) {
    console.log('  Top 25 by EV/trade:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ Signal         │ MinPx │ MaxPx │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.entryOffset / 1000).padStart(4)}s │ ${p.signal.padEnd(14)} │ ${p.minDownPrice.toFixed(2).padStart(5)} │ ${p.maxDownPrice.toFixed(2).padStart(5)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');

    const best = allResults[0];
    console.log(`\n  BEST: offset=${best.params.entryOffset / 1000}s, signal=${best.params.signal}, price=[${best.params.minDownPrice},${best.params.maxDownPrice})`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);

    if (best.trades.length <= 30) {
      console.log('  Trade log:');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(`    ${et} | ask=${t.downAsk.toFixed(3)} | ${t.resolved.padEnd(4)} | ${pnlStr}`);
      }
    }
  }

  // Offset comparison
  console.log('\n  ── Entry Timing Comparison ──\n');
  for (const offset of [10000, 20000, 30000]) {
    const oResults = allResults.filter(r => r.params.entryOffset === offset);
    if (oResults.length === 0) continue;
    const bestEV = oResults[0].ev;
    const medEV = median(oResults.map(r => r.ev));
    console.log(`  ${offset / 1000}s before close: ${oResults.length} configs, best EV=$${bestEV.toFixed(4)}, median EV=$${medEV?.toFixed(4)}`);
  }
  console.log();
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  EDGE J: Late Entry — Maximum Information                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);
  runStrategy(windows);
  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Edge-J failed:', err); pool.end(); process.exit(1); });
