/**
 * Edge K: Contrarian — Buy UP in Decided Windows
 *
 * The analysis showed 0/55 DOWN wins in decided windows (DOWN ask < 0.15).
 * That means UP wins 55/55 = 100% in these windows! Can we exploit that
 * by buying UP tokens cheaply when they're available?
 *
 * Reality check: in decided windows, UP ask is typically $0.97+ (1 - 0.03).
 * So even with 100% win rate, the max profit per trade is ~$0.03 - fees.
 * Is there a sweet spot where UP is cheap enough to be profitable?
 *
 * Also tests: buying UP across ALL windows as a baseline.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-k-contrarian-up.cjs
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
  console.log('  EDGE K: Contrarian — Buy UP');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Diagnostic: UP token pricing in decided vs contested windows
  console.log('  ── UP Token Pricing by Window Type ──\n');

  for (const offset of [10000, 30000, 60000]) {
    console.log(`  At T-${offset / 1000}s:`);
    const decided = [], contested = [];
    for (const win of windows) {
      const s = win.sampleMap[offset];
      if (!s || s._upAsk == null || isNaN(s._upAsk) || s._upAsk <= 0 || s._upAsk >= 1) continue;
      if (s._downAsk != null && s._downAsk < 0.15) decided.push({ upAsk: s._upAsk, resolved: win.resolved });
      else if (s._downAsk != null && s._downAsk >= 0.15) contested.push({ upAsk: s._upAsk, resolved: win.resolved });
    }

    if (decided.length > 0) {
      const upRate = decided.filter(d => d.resolved === 'UP').length / decided.length;
      const avgAsk = decided.reduce((s, d) => s + d.upAsk, 0) / decided.length;
      const minAsk = Math.min(...decided.map(d => d.upAsk));
      const maxProfit = 1 - avgAsk - 0.005; // after spread
      console.log(`    Decided (DOWN<0.15): ${decided.length} windows, UP rate=${(upRate * 100).toFixed(1)}%, avg UP ask=${avgAsk.toFixed(4)}, min=${minAsk.toFixed(4)}, max profit/trade=$${maxProfit.toFixed(4)}`);
    }
    if (contested.length > 0) {
      const upRate = contested.filter(d => d.resolved === 'UP').length / contested.length;
      const avgAsk = contested.reduce((s, d) => s + d.upAsk, 0) / contested.length;
      console.log(`    Contested (DOWN≥0.15): ${contested.length} windows, UP rate=${(upRate * 100).toFixed(1)}%, avg UP ask=${avgAsk.toFixed(4)}`);
    }
    console.log();
  }

  // Strategy sweep: Buy UP with various filters
  const sweepGrid = {
    entryOffset: [10000, 30000, 60000, 120000],
    maxUpPrice: [0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.99],
    filter: ['NONE', 'DECIDED_ONLY', 'REF_ABOVE', 'DEFICIT_LOW', 'EX_ABOVE', 'COMBINED_SAFE'],
  };

  const paramSets = [];
  for (const eo of sweepGrid.entryOffset) {
    for (const mup of sweepGrid.maxUpPrice) {
      for (const f of sweepGrid.filter) {
        paramSets.push({ entryOffset: eo, maxUpPrice: mup, filter: f });
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
      if (!s || s._upAsk == null || isNaN(s._upAsk) || s._upAsk <= 0 || s._upAsk >= 1) continue;
      if (s._upAsk >= params.maxUpPrice) continue;

      // Filter
      let pass = false;
      switch (params.filter) {
        case 'NONE':
          pass = true;
          break;
        case 'DECIDED_ONLY':
          pass = s._downAsk != null && s._downAsk < 0.15;
          break;
        case 'REF_ABOVE':
          pass = s._ref != null && s._strike != null && s._ref > s._strike + 50;
          break;
        case 'DEFICIT_LOW':
          pass = s._deficit != null && s._deficit < 40;
          break;
        case 'EX_ABOVE':
          pass = s._exMedian != null && s._strike != null && s._exMedian > s._strike + 80;
          break;
        case 'COMBINED_SAFE':
          // All signals agree: ref above strike, deficit low, exchanges above
          pass = s._ref != null && s._strike != null && s._ref > s._strike + 100
              && s._deficit != null && s._deficit < 20
              && s._exMedian != null && s._exMedian > s._strike + 100;
          break;
      }
      if (!pass) continue;

      const fillPrice = s._upAsk + 0.005;
      if (fillPrice >= 1) continue;
      const won = win.resolved === 'UP';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({
        closeTime: win.closeTime, fillPrice, won, pnl, upAsk: s._upAsk,
        downAsk: s._downAsk, deficit: s._deficit, resolved: win.resolved,
      });
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
    console.log('  ────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ MaxUP  │ Filter         │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.entryOffset / 1000).padStart(4)}s │ ${p.maxUpPrice.toFixed(2).padStart(6)} │ ${p.filter.padEnd(14)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ────────────────────────────────────────────────────────────────────────────────────────');

    const best = allResults[0];
    console.log(`\n  BEST: offset=${best.params.entryOffset / 1000}s, maxUP=${best.params.maxUpPrice}, filter=${best.params.filter}`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);
  }

  // The key question
  console.log('  ── VERDICT: Can buying UP be profitable? ──\n');
  const bestEV = allResults.length > 0 ? allResults[0].ev : 0;
  if (bestEV > 0.01) {
    console.log(`  YES — best config shows $${bestEV.toFixed(4)}/trade EV`);
  } else if (bestEV > 0) {
    console.log(`  MARGINAL — best config shows $${bestEV.toFixed(4)}/trade EV (thin edge, likely noise)`);
  } else {
    console.log(`  NO — all configs show negative or zero EV. Market prices UP correctly.`);
  }
  console.log();
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  EDGE K: Contrarian — Buy UP in Decided Windows          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);
  runStrategy(windows);
  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Edge-K failed:', err); pool.end(); process.exit(1); });
