/**
 * CL Settlement Arb — Instrument Breakdown
 * Which instruments (BTC, ETH, SOL) does the arb occur on?
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-cl-arb-by-instrument.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  CL SETTLEMENT ARB — INSTRUMENT BREAKDOWN                ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // First: what instruments do we have?
  const instruments = await pool.query(`
    SELECT symbol, COUNT(*) as cnt,
           SUM(CASE WHEN COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) = 'DOWN' THEN 1 ELSE 0 END) as down_cnt
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND chainlink_price_at_close IS NOT NULL
    GROUP BY symbol
    ORDER BY cnt DESC
  `);

  console.log('  ── Instruments in window_close_events ──\n');
  console.log('  Symbol                              │ Windows │ DOWN │ DOWN%');
  console.log('  ────────────────────────────────────────────────────────────');
  for (const r of instruments.rows) {
    console.log(`  ${r.symbol.padEnd(37)} │ ${String(r.cnt).padStart(7)} │ ${String(r.down_cnt).padStart(4)} │ ${pct(r.down_cnt, r.cnt)}%`);
  }
  console.log();

  // Also check what's in clob_price_snapshots
  const clobInstruments = await pool.query(`
    SELECT DISTINCT symbol FROM clob_price_snapshots ORDER BY symbol
  `);
  console.log('  ── CLOB instruments ──');
  for (const r of clobInstruments.rows) {
    console.log(`  ${r.symbol}`);
  }
  console.log();

  // Also check rtds_ticks topics
  const topics = await pool.query(`
    SELECT topic, COUNT(*) as cnt FROM rtds_ticks GROUP BY topic ORDER BY cnt DESC
  `);
  console.log('  ── RTDS topics ──');
  for (const r of topics.rows) {
    console.log(`  ${r.topic}: ${r.cnt} ticks`);
  }
  console.log();

  // Now: for each window, load CL tick data and check the arb signal
  // Group by instrument
  const allWindows = await pool.query(`
    SELECT window_close_time, symbol, strike_price, chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND chainlink_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  // For each window, check CL position at T-10s, T-5s, T-3s, T-2s
  // and CLOB state
  const results = {};

  let processed = 0;
  for (const win of allWindows.rows) {
    const closeTimeMs = new Date(win.window_close_time).getTime();
    const strike = parseFloat(win.strike_price);
    const resolved = win.resolved;

    // Determine instrument category
    const sym = (win.symbol || '').toUpperCase();
    let instrument = 'UNKNOWN';
    if (sym.includes('BTC') || sym.includes('BITCOIN')) instrument = 'BTC';
    else if (sym.includes('ETH') || sym.includes('ETHEREUM')) instrument = 'ETH';
    else if (sym.includes('SOL') || sym.includes('SOLANA')) instrument = 'SOL';
    else instrument = sym.substring(0, 20);

    if (!results[instrument]) {
      results[instrument] = {
        total: 0, down: 0, up: 0, withClob: 0,
        signalByOffset: {},
        arbByOffset: {},
      };
    }
    results[instrument].total++;
    if (resolved === 'DOWN') results[instrument].down++;
    else results[instrument].up++;

    // Load last 30s of CL + CLOB ticks
    const startTime = new Date(closeTimeMs - 120000);
    const windowEpoch = Math.floor(closeTimeMs / 1000) - 900;
    const [clRes, clobRes] = await Promise.all([
      pool.query(`
        SELECT timestamp, price FROM rtds_ticks
        WHERE timestamp >= $1 AND timestamp <= $2 AND topic = 'crypto_prices_chainlink'
        ORDER BY timestamp ASC
      `, [startTime, win.window_close_time]),
      pool.query(`
        SELECT timestamp, symbol, best_bid, best_ask FROM clob_price_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND window_epoch = $3
        ORDER BY timestamp ASC
      `, [startTime, win.window_close_time, windowEpoch]),
    ]);

    const clTicks = clRes.rows.map(r => ({ ts: new Date(r.timestamp).getTime(), price: parseFloat(r.price) }));
    const clobTicks = clobRes.rows.map(r => ({
      ts: new Date(r.timestamp).getTime(),
      isDown: r.symbol?.toLowerCase().includes('down'),
      ask: parseFloat(r.best_ask),
    }));

    if (clobTicks.length > 0) results[instrument].withClob++;

    // At each offset, find CL and CLOB DOWN ask
    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      const targetMs = closeTimeMs - (sec * 1000);

      // Latest CL
      let latestCL = null;
      for (let i = clTicks.length - 1; i >= 0; i--) {
        if (clTicks[i].ts <= targetMs) { latestCL = clTicks[i]; break; }
      }

      // Latest CLOB DOWN
      let latestDown = null;
      for (let i = clobTicks.length - 1; i >= 0; i--) {
        if (clobTicks[i].ts <= targetMs && clobTicks[i].isDown) { latestDown = clobTicks[i]; break; }
      }

      if (!latestCL) continue;

      const key = `T-${sec}s`;
      if (!results[instrument].signalByOffset[key]) {
        results[instrument].signalByOffset[key] = { clBelow: 0, clBelowDown: 0, clAbove: 0, clAboveUp: 0, total: 0 };
      }
      const sig = results[instrument].signalByOffset[key];
      sig.total++;

      if (latestCL.price < strike) {
        sig.clBelow++;
        if (resolved === 'DOWN') sig.clBelowDown++;
      } else {
        sig.clAbove++;
        if (resolved === 'UP') sig.clAboveUp++;
      }

      // Arb: CL < strike AND DOWN ask < 0.50
      if (latestCL.price < strike && latestDown && latestDown.ask > 0 && latestDown.ask < 0.50) {
        if (!results[instrument].arbByOffset[key]) {
          results[instrument].arbByOffset[key] = { trades: 0, wins: 0, totalPnl: 0, entries: [] };
        }
        const arb = results[instrument].arbByOffset[key];
        const fill = latestDown.ask + 0.005;
        const won = resolved === 'DOWN';
        const pnl = won ? (1.0 - fill) : -fill;
        arb.trades++;
        if (won) arb.wins++;
        arb.totalPnl += pnl;
        arb.entries.push({
          closeTime: win.window_close_time, strike, cl: latestCL.price,
          deficit: strike - latestCL.price, downAsk: latestDown.ask, won, pnl, resolved
        });
      }
    }

    processed++;
    if (processed % 30 === 0) process.stdout.write(`  Processed ${processed}/${allWindows.rows.length}...\r`);
  }
  console.log(`  Processed ${processed} windows                              \n`);

  // ═══════════════════════════════════════════════════════════
  // Report per instrument
  // ═══════════════════════════════════════════════════════════

  for (const [instrument, data] of Object.entries(results)) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ${instrument}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`  Windows: ${data.total} (DOWN=${data.down}, UP=${data.up}, ${pct(data.down, data.total)}% DOWN)`);
    console.log(`  With CLOB data: ${data.withClob}\n`);

    // Signal accuracy
    console.log('  ── CL < Strike Signal Accuracy ──');
    console.log('  Offset │ CL<Str │ →DOWN │ Acc%   │ CL>Str │ →UP │ Acc%');
    console.log('  ──────────────────────────────────────────────────────');
    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      const key = `T-${sec}s`;
      const sig = data.signalByOffset[key];
      if (!sig) continue;
      console.log(
        `  T-${String(sec).padStart(3)}s │ ${String(sig.clBelow).padStart(6)} │ ${String(sig.clBelowDown).padStart(5)} │ ${pct(sig.clBelowDown, sig.clBelow).padStart(5)}% │ ${String(sig.clAbove).padStart(6)} │ ${String(sig.clAboveUp).padStart(3)} │ ${pct(sig.clAboveUp, sig.clAbove).padStart(5)}%`
      );
    }
    console.log();

    // Arb opportunities
    const hasArb = Object.values(data.arbByOffset).some(a => a.trades > 0);
    if (hasArb) {
      console.log('  ── Arb: Buy DOWN when CL<strike + DN ask < $0.50 ──');
      console.log('  Offset │ Trades │ Wins │ Losses │ WinRate │ EV/trade │ PnL');
      console.log('  ──────────────────────────────────────────────────────────');
      for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
        const key = `T-${sec}s`;
        const arb = data.arbByOffset[key];
        if (!arb || arb.trades === 0) {
          console.log(`  T-${String(sec).padStart(3)}s │      0 │    - │      - │       - │        - │     -`);
          continue;
        }
        const losses = arb.trades - arb.wins;
        const wr = arb.wins / arb.trades;
        const ev = arb.totalPnl / arb.trades;
        console.log(
          `  T-${String(sec).padStart(3)}s │ ${String(arb.trades).padStart(6)} │ ${String(arb.wins).padStart(4)} │ ${String(losses).padStart(6)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ $${ev.toFixed(3).padStart(7)} │ $${arb.totalPnl.toFixed(2).padStart(5)}`
        );
      }
      console.log();

      // Show individual arb trades at T-10s
      const t10arb = data.arbByOffset['T-10s'];
      if (t10arb && t10arb.entries.length > 0) {
        console.log('  ── Individual Arb Trades at T-10s ──');
        console.log('  Time (ET)          │ Strike   │ CL       │ Deficit │ DN Ask │ Result │ PnL');
        console.log('  ────────────────────────────────────────────────────────────────────────────');
        for (const e of t10arb.entries) {
          const ts = new Date(e.closeTime);
          const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          console.log(
            `  ${et.padEnd(19)} │ $${e.strike.toFixed(0).padStart(7)} │ $${e.cl.toFixed(0).padStart(7)} │ $${e.deficit.toFixed(0).padStart(6)} │ $${e.downAsk.toFixed(3)} │ ${(e.won ? 'WIN ' : 'LOSS').padStart(4)}  │ $${e.pnl.toFixed(3).padStart(7)}`
          );
        }
        console.log();
      }

      // Show T-5s and T-3s trades too
      for (const checkSec of [5, 3, 2]) {
        const arbData = data.arbByOffset[`T-${checkSec}s`];
        if (arbData && arbData.entries.length > 0) {
          console.log(`  ── Individual Arb Trades at T-${checkSec}s ──`);
          console.log('  Time (ET)          │ Strike   │ CL       │ Deficit │ DN Ask │ Result │ PnL');
          console.log('  ────────────────────────────────────────────────────────────────────────────');
          for (const e of arbData.entries) {
            const ts = new Date(e.closeTime);
            const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            console.log(
              `  ${et.padEnd(19)} │ $${e.strike.toFixed(0).padStart(7)} │ $${e.cl.toFixed(0).padStart(7)} │ $${e.deficit.toFixed(0).padStart(6)} │ $${e.downAsk.toFixed(3)} │ ${(e.won ? 'WIN ' : 'LOSS').padStart(4)}  │ $${e.pnl.toFixed(3).padStart(7)}`
            );
          }
          console.log();
        }
      }
    } else {
      console.log('  No arb opportunities found for this instrument.\n');
    }
  }

  await pool.end();
}

main().catch(err => { console.error('Failed:', err); pool.end(); process.exit(1); });
