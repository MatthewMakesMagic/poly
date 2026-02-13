/**
 * CL Settlement Arb — Deep Dive on Surprise DOWN Windows
 *
 * The v2 found 5 windows at T-10s where CL < strike + CLOB thinks UP = 100% wins.
 * But we only had 10s resolution. This script goes tick-by-tick to understand:
 *   1. Exact second CL drops below strike
 *   2. How long it stays below
 *   3. CLOB state at each second after CL crosses
 *   4. How much time you'd have to place the trade
 *   5. FALSE POSITIVES: when CL dips below then bounces back (UP resolves)
 *
 * Also extends the search to ALL windows (not just fast-track) to find more samples.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-cl-arb-deep-dive.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  CL ARB DEEP DIVE — Tick-Level Surprise DOWN Analysis    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // Load ALL windows
  const windowsRes = await pool.query(`
    SELECT window_close_time, symbol, strike_price, chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND chainlink_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  const allWindows = windowsRes.rows;
  console.log(`  Total windows: ${allWindows.length}\n`);

  // ═══════════════════════════════════════════════════════════
  // For EACH window, load last 120s of CL + CLOB tick data
  // Build a second-by-second timeline
  // ═══════════════════════════════════════════════════════════

  const windowAnalyses = [];
  let processed = 0;

  for (const win of allWindows) {
    const closeTimeMs = new Date(win.window_close_time).getTime();
    const strike = parseFloat(win.strike_price);
    const resolved = win.resolved;
    const lookbackMs = 120000;
    const startTime = new Date(closeTimeMs - lookbackMs);

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

    if (clRes.rows.length === 0) { processed++; continue; }

    // Build CL timeline: for each second before close, what's the latest CL?
    const clTicks = clRes.rows.map(r => ({ ts: new Date(r.timestamp).getTime(), price: parseFloat(r.price) }));
    const clobTicks = clobRes.rows.map(r => ({
      ts: new Date(r.timestamp).getTime(),
      isDown: r.symbol?.toLowerCase().includes('down'),
      ask: parseFloat(r.best_ask),
      bid: parseFloat(r.best_bid),
    }));

    // For each second (120, 119, ... 1, 0), find latest CL tick and latest CLOB DOWN/UP
    const timeline = [];
    for (let secBefore = 120; secBefore >= 0; secBefore--) {
      const targetMs = closeTimeMs - (secBefore * 1000);

      // Latest CL tick at or before this second
      let latestCL = null;
      for (let i = clTicks.length - 1; i >= 0; i--) {
        if (clTicks[i].ts <= targetMs) { latestCL = clTicks[i]; break; }
      }

      // Latest CLOB DOWN tick at or before this second
      let latestDown = null, latestUp = null;
      for (let i = clobTicks.length - 1; i >= 0; i--) {
        if (clobTicks[i].ts <= targetMs) {
          if (clobTicks[i].isDown && !latestDown) latestDown = clobTicks[i];
          if (!clobTicks[i].isDown && !latestUp) latestUp = clobTicks[i];
          if (latestDown && latestUp) break;
        }
      }

      timeline.push({
        secBefore,
        cl: latestCL?.price,
        clTs: latestCL?.ts,
        downAsk: latestDown?.ask,
        downBid: latestDown?.bid,
        upAsk: latestUp?.ask,
        upBid: latestUp?.bid,
      });
    }

    // Find: first second where CL < strike (from T-120 forward)
    let firstBelowSec = null;
    let clStayedBelow = true;
    let lastAboveSec = null;
    let crossings = 0; // how many times CL crosses below

    let prevBelow = null;
    for (const t of timeline) {
      if (t.cl == null) continue;
      const below = t.cl < strike;
      if (prevBelow != null && !prevBelow && below) {
        crossings++;
        if (firstBelowSec == null) firstBelowSec = t.secBefore;
      }
      if (below && firstBelowSec != null && !below) {
        clStayedBelow = false;
      }
      if (!below) lastAboveSec = t.secBefore;
      prevBelow = below;
    }

    // Check: is CL below strike at various offsets?
    const clBelowAt = {};
    const clobStateAt = {};
    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      const t = timeline.find(t => t.secBefore === sec);
      if (t && t.cl != null) {
        clBelowAt[sec] = t.cl < strike;
        clobStateAt[sec] = { downAsk: t.downAsk, upAsk: t.upAsk, cl: t.cl, deficit: strike - t.cl };
      }
    }

    // Determine if this is a "surprise" window: CL < strike near close + CLOB thinks UP
    const isSurprise = resolved === 'DOWN' &&
      clobStateAt[10]?.downAsk != null && clobStateAt[10].downAsk < 0.50 &&
      clBelowAt[10] === true;

    // Also check broader: CL < strike + CLOB DOWN < 0.50 at ANY offset
    let surpriseAtSec = null;
    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      if (clBelowAt[sec] === true && clobStateAt[sec]?.downAsk != null && clobStateAt[sec].downAsk < 0.50) {
        surpriseAtSec = sec;
        break;
      }
    }

    // False positive check: CL < strike + CLOB thinks UP but resolves UP
    const isFalsePositive = resolved === 'UP' &&
      clobStateAt[10]?.downAsk != null && clobStateAt[10].downAsk < 0.50 &&
      clBelowAt[10] === true;

    let fpAtAnySec = null;
    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      if (resolved === 'UP' && clBelowAt[sec] === true && clobStateAt[sec]?.downAsk != null && clobStateAt[sec].downAsk < 0.50) {
        fpAtAnySec = sec;
        break;
      }
    }

    windowAnalyses.push({
      closeTime: win.window_close_time, strike, resolved,
      clAtClose: parseFloat(win.chainlink_price_at_close),
      firstBelowSec, crossings, lastAboveSec, clStayedBelow,
      clBelowAt, clobStateAt, timeline,
      isSurprise, surpriseAtSec, isFalsePositive, fpAtAnySec,
      hasClobData: clobTicks.length > 0,
    });

    processed++;
    if (processed % 30 === 0) process.stdout.write(`  Processed ${processed}/${allWindows.length}...\r`);
  }
  console.log(`  Processed ${processed} windows                              \n`);

  const withClob = windowAnalyses.filter(w => w.hasClobData);
  console.log(`  Windows with CLOB data: ${withClob.length}\n`);

  // ═══════════════════════════════════════════════════════════
  // PART 1: Signal accuracy at fine-grained offsets
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 1: CL < STRIKE SIGNAL ACCURACY (FINE-GRAINED)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('  ────────────────────────────────────────────────────────────────');
  console.log('  Offset │ CL<Str │ →DOWN │ Accuracy │ CL>Str │ →UP │ Accuracy');
  console.log('  ────────────────────────────────────────────────────────────────');

  for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
    let belowTotal = 0, belowDown = 0;
    let aboveTotal = 0, aboveUp = 0;

    for (const w of withClob) {
      const below = w.clBelowAt[sec];
      if (below === undefined) continue;
      if (below) {
        belowTotal++;
        if (w.resolved === 'DOWN') belowDown++;
      } else {
        aboveTotal++;
        if (w.resolved === 'UP') aboveUp++;
      }
    }

    console.log(
      `  T-${String(sec).padStart(3)}s │ ${String(belowTotal).padStart(6)} │ ${String(belowDown).padStart(5)} │ ${pct(belowDown, belowTotal).padStart(7)}% │ ${String(aboveTotal).padStart(6)} │ ${String(aboveUp).padStart(3)} │ ${pct(aboveUp, aboveTotal).padStart(7)}%`
    );
  }
  console.log('  ────────────────────────────────────────────────────────────────\n');

  // ═══════════════════════════════════════════════════════════
  // PART 2: SURPRISE DOWNS — Detailed Per-Window Analysis
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 2: SURPRISE DOWN WINDOWS (CL<strike + CLOB wrong)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const surprises = windowAnalyses.filter(w => w.surpriseAtSec != null && w.resolved === 'DOWN');
  const falsePositives = windowAnalyses.filter(w => w.fpAtAnySec != null);

  console.log(`  Surprise DOWN windows found: ${surprises.length}`);
  console.log(`  False positives (CL<strike + CLOB wrong, resolves UP): ${falsePositives.length}\n`);

  if (surprises.length > 0) {
    for (const s of surprises) {
      const ts = new Date(s.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

      console.log(`  ── ${et} (strike=$${s.strike.toFixed(0)}, CL@close=$${s.clAtClose.toFixed(0)}, resolved=${s.resolved}) ──`);
      console.log(`     Crossings: ${s.crossings}, First CL<strike at T-${s.firstBelowSec}s, Last CL>strike at T-${s.lastAboveSec ?? 'never'}s`);
      console.log();

      // Show second-by-second for last 30s
      console.log('     sec │ CL         │ CL vs Str │ DN Ask  │ UP Ask  │ Signal');
      console.log('     ────────────────────────────────────────────────────────────');

      for (const t of s.timeline) {
        if (t.secBefore > 30) continue;
        if (t.cl == null) continue;

        const clVsStrike = t.cl - s.strike;
        const signal = t.cl < s.strike ?
          (t.downAsk != null && t.downAsk < 0.50 ? '★ BUY DOWN' : 'CL below') :
          '';

        console.log(
          `     T-${String(t.secBefore).padStart(3)}s │ $${t.cl.toFixed(0).padStart(8)} │ ${clVsStrike >= 0 ? '+' : ''}$${clVsStrike.toFixed(0).padStart(6)} │ $${t.downAsk != null ? t.downAsk.toFixed(3) : '  -  '} │ $${t.upAsk != null ? t.upAsk.toFixed(3) : '  -  '} │ ${signal}`
        );
      }
      console.log();

      // Show PnL at different possible entry points
      console.log('     Entry timing analysis:');
      for (const sec of [30, 20, 15, 10, 5, 3, 2, 1]) {
        const st = s.clobStateAt[sec] || s.timeline.find(t => t.secBefore === sec);
        if (!st) continue;
        const downAsk = st.downAsk;
        const cl = st.cl || s.clBelowAt[sec]; // true/false
        if (downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;

        const below = s.clBelowAt[sec];
        const fill = downAsk + 0.005;
        const pnl = 1.0 - fill;

        if (below) {
          console.log(`       T-${String(sec).padStart(2)}s: CL below strike, DOWN ask=$${downAsk.toFixed(3)} → fill=$${fill.toFixed(3)} → PnL=$${pnl.toFixed(3)}`);
        }
      }
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PART 3: FALSE POSITIVES — CL dips below but resolves UP
  // ═══════════════════════════════════════════════════════════

  if (falsePositives.length > 0) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  PART 3: FALSE POSITIVES (CL<strike + CLOB wrong → UP)');
    console.log('═══════════════════════════════════════════════════════════\n');

    for (const fp of falsePositives) {
      const ts = new Date(fp.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

      console.log(`  ── ${et} (strike=$${fp.strike.toFixed(0)}, CL@close=$${fp.clAtClose.toFixed(0)}, resolved=${fp.resolved}) ──`);
      console.log(`     Crossings: ${fp.crossings}, First CL<strike at T-${fp.firstBelowSec}s, Last CL>strike at T-${fp.lastAboveSec ?? 'never'}s`);

      // Show last 30s
      console.log('     sec │ CL         │ CL vs Str │ DN Ask  │ UP Ask  │ Signal');
      console.log('     ────────────────────────────────────────────────────────────');

      for (const t of fp.timeline) {
        if (t.secBefore > 30) continue;
        if (t.cl == null) continue;
        const clVsStrike = t.cl - fp.strike;

        console.log(
          `     T-${String(t.secBefore).padStart(3)}s │ $${t.cl.toFixed(0).padStart(8)} │ ${clVsStrike >= 0 ? '+' : ''}$${clVsStrike.toFixed(0).padStart(6)} │ $${t.downAsk != null ? t.downAsk.toFixed(3) : '  -  '} │ $${t.upAsk != null ? t.upAsk.toFixed(3) : '  -  '} │ ${t.cl < fp.strike ? 'DANGER: FP!' : ''}`
        );
      }
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PART 4: OVERALL STRATEGY ASSESSMENT
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 4: STRATEGY ASSESSMENT');
  console.log('═══════════════════════════════════════════════════════════\n');

  // At each offset, count setups and PnL
  console.log('  Strategy: Buy DOWN when CL < strike AND DOWN ask < $0.50');
  console.log('  ─────────────────────────────────────────────────────────────────');
  console.log('  Entry  │ Setups │ Wins │ Losses │ WinRate │ Avg Entry │ EV │ PnL');
  console.log('  ─────────────────────────────────────────────────────────────────');

  for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
    const trades = [];
    for (const w of withClob) {
      const below = w.clBelowAt[sec];
      if (below !== true) continue;
      const st = w.clobStateAt[sec];
      if (!st || st.downAsk == null || isNaN(st.downAsk) || st.downAsk <= 0 || st.downAsk >= 0.50) continue;

      const fill = st.downAsk + 0.005;
      if (fill >= 1) continue;
      const won = w.resolved === 'DOWN';
      const pnl = won ? (1.0 - fill) : -fill;
      trades.push({ fill, won, pnl });
    }

    if (trades.length === 0) {
      console.log(`  T-${String(sec).padStart(3)}s │      0 │    - │      - │       - │         - │   - │     -`);
      continue;
    }
    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fill, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ev = totalPnl / trades.length;

    console.log(
      `  T-${String(sec).padStart(3)}s │ ${String(trades.length).padStart(6)} │ ${String(wins).padStart(4)} │ ${String(losses).padStart(6)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ $${avgEntry.toFixed(3).padStart(7)} │ $${ev.toFixed(2).padStart(4)} │ $${totalPnl.toFixed(2).padStart(5)}`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────\n');

  // Also try higher threshold
  console.log('  Strategy: Buy DOWN when CL < strike AND DOWN ask < $0.70');
  console.log('  ─────────────────────────────────────────────────────────────────');
  console.log('  Entry  │ Setups │ Wins │ Losses │ WinRate │ Avg Entry │ EV │ PnL');
  console.log('  ─────────────────────────────────────────────────────────────────');

  for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
    const trades = [];
    for (const w of withClob) {
      const below = w.clBelowAt[sec];
      if (below !== true) continue;
      const st = w.clobStateAt[sec];
      if (!st || st.downAsk == null || isNaN(st.downAsk) || st.downAsk <= 0 || st.downAsk >= 0.70) continue;

      const fill = st.downAsk + 0.005;
      if (fill >= 1) continue;
      const won = w.resolved === 'DOWN';
      const pnl = won ? (1.0 - fill) : -fill;
      trades.push({ fill, won, pnl });
    }

    if (trades.length === 0) {
      console.log(`  T-${String(sec).padStart(3)}s │      0 │    - │      - │       - │         - │   - │     -`);
      continue;
    }
    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fill, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ev = totalPnl / trades.length;

    console.log(
      `  T-${String(sec).padStart(3)}s │ ${String(trades.length).padStart(6)} │ ${String(wins).padStart(4)} │ ${String(losses).padStart(6)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ $${avgEntry.toFixed(3).padStart(7)} │ $${ev.toFixed(2).padStart(4)} │ $${totalPnl.toFixed(2).padStart(5)}`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────\n');

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('CL-Arb-Deep-Dive failed:', err); pool.end(); process.exit(1); });
