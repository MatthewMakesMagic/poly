/**
 * Multi-Instrument VWAP Edge Analysis
 *
 * Runs the same edge strategies from REALEDGEMAYBE.md across BTC, ETH, SOL, XRP.
 * Uses on-chain CTF resolution as ground truth for all instruments.
 * VWAP direction from 21-exchange composite (vwap_snapshots).
 * CLOB direction from Polymarket market prices (window_close_events).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');

async function analyzeSymbol(client, symbol) {
  const SYM = symbol.toUpperCase();

  // Load windows with on-chain resolution + CLOB prices
  const windowsRes = await client.query(`
    SELECT window_id, window_close_time,
           onchain_resolved_direction,
           oracle_price_at_close, oracle_price_at_open,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s
    FROM window_close_events
    WHERE symbol = $1
    AND onchain_resolved_direction IS NOT NULL
    AND market_up_price_60s IS NOT NULL
    ORDER BY window_close_time
  `, [symbol]);

  if (windowsRes.rows.length < 10) {
    console.log(`\n${SYM}: Only ${windowsRes.rows.length} usable windows — skipping\n`);
    return null;
  }

  // Load VWAP snapshots
  const firstClose = windowsRes.rows[0].window_close_time;
  const lastClose = windowsRes.rows[windowsRes.rows.length - 1].window_close_time;
  const bufferMs = 900000 + 60000; // 15min + 1min buffer
  const startTs = new Date(firstClose.getTime() - bufferMs).toISOString();
  const endTs = new Date(lastClose.getTime() + 60000).toISOString();

  const vwapRes = await client.query(`
    SELECT timestamp, composite_vwap
    FROM vwap_snapshots
    WHERE symbol = $1
    AND timestamp >= $2
    AND timestamp <= $3
    ORDER BY timestamp
  `, [symbol, startTs, endTs]);

  if (vwapRes.rows.length < 100) {
    console.log(`\n${SYM}: Only ${vwapRes.rows.length} VWAP snapshots — skipping\n`);
    return null;
  }

  // Build time-indexed VWAP array
  const vwapData = vwapRes.rows.map(r => ({
    ts: r.timestamp.getTime(),
    vwap: parseFloat(r.composite_vwap),
  }));

  function findNearest(targetMs, maxDeltaMs = 5000) {
    let lo = 0, hi = vwapData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vwapData[mid].ts < targetMs) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(vwapData[lo - 1].ts - targetMs) < Math.abs(vwapData[lo].ts - targetMs)) {
      best = lo - 1;
    }
    if (Math.abs(vwapData[best].ts - targetMs) > maxDeltaMs) return null;
    return vwapData[best];
  }

  // Compute average price for threshold scaling
  const avgPrice = vwapData.reduce((s, d) => s + d.vwap, 0) / vwapData.length;

  // Process each window
  const results = [];
  for (const w of windowsRes.rows) {
    const closeMs = w.window_close_time.getTime();
    const openMs = closeMs - 900000;

    const atOpen = findNearest(openMs);
    if (!atOpen) continue;

    const resolution = w.onchain_resolved_direction;
    const vwapOpen = atOpen.vwap;

    // Trajectory at T-60, T-30, T-10, T-5
    const trajectory = {};
    for (const offset of [60, 30, 10, 5]) {
      const snap = findNearest(closeMs - offset * 1000, 3000);
      if (snap) {
        trajectory[offset] = {
          vwap: snap.vwap,
          vwapDir: snap.vwap >= vwapOpen ? 'up' : 'down',
          vwapDelta: snap.vwap - vwapOpen,
        };
      }
    }

    const up60 = parseFloat(w.market_up_price_60s || 0);
    const up30 = parseFloat(w.market_up_price_30s || 0);
    const up10 = parseFloat(w.market_up_price_10s || 0);
    const up5 = parseFloat(w.market_up_price_5s || 0);

    results.push({
      window: w.window_id,
      close: w.window_close_time.toISOString().slice(11, 19),
      resolution,
      vwapOpen,
      up60, up30, up10, up5,
      trajectory,
    });
  }

  return { symbol, SYM, results, avgPrice, windowCount: windowsRes.rows.length, vwapCount: vwapRes.rows.length };
}

function runStrategies(data) {
  const { symbol, SYM, results, avgPrice } = data;

  console.log(`\n${'█'.repeat(70)}`);
  console.log(`█  ${SYM} — ${results.length} windows | avg price ~$${avgPrice.toFixed(2)}`);
  console.log(`${'█'.repeat(70)}`);

  // ── BASELINE ──
  console.log('\n── BASELINE: Direction Accuracy ──\n');
  console.log('Signal       │ T-60s         │ T-30s         │ T-10s         │ T-5s');
  console.log('─────────────┼───────────────┼───────────────┼───────────────┼──────────────');

  // VWAP accuracy
  const vwapAcc = {};
  for (const entryT of [60, 30, 10, 5]) {
    let correct = 0, total = 0;
    for (const r of results) {
      const t = r.trajectory[entryT];
      if (!t) continue;
      total++;
      if (t.vwapDir === r.resolution) correct++;
    }
    vwapAcc[entryT] = { correct, total };
  }
  const vLine = Object.entries(vwapAcc).map(([t, v]) =>
    `${v.correct}/${v.total} ${((v.correct / v.total) * 100).toFixed(1)}%`
  );
  console.log(`VWAP dir     │ ${vLine.map(s => s.padEnd(13)).join(' │ ')}`);

  // CLOB accuracy
  const clobAcc = {};
  for (const [t, field] of [[60, 'up60'], [30, 'up30'], [10, 'up10'], [5, 'up5']]) {
    let correct = 0;
    for (const r of results) {
      const clobDir = r[field] >= 0.5 ? 'up' : 'down';
      if (clobDir === r.resolution) correct++;
    }
    clobAcc[t] = { correct, total: results.length };
  }
  const cLine = Object.entries(clobAcc).map(([t, v]) =>
    `${v.correct}/${v.total} ${((v.correct / v.total) * 100).toFixed(1)}%`
  );
  console.log(`CLOB dir     │ ${cLine.map(s => s.padEnd(13)).join(' │ ')}`);

  // ── STRATEGY 1 ──
  console.log('\n── STRATEGY 1: Bet with VWAP when it disagrees with CLOB ──\n');
  console.log('Entry Time │ Disagreements │ VWAP Wins        │ Total PnL │ Avg PnL/Trade');
  console.log('───────────┼───────────────┼──────────────────┼───────────┼──────────────');

  const s1Details = {};

  for (const entryT of [60, 30, 10, 5]) {
    let bets = 0, wins = 0, pnl = 0;
    const trades = [];

    for (const r of results) {
      const t = r.trajectory[entryT];
      if (!t) continue;

      const clobUp = entryT === 60 ? r.up60 : entryT === 30 ? r.up30 : entryT === 10 ? r.up10 : r.up5;
      const clobDir = clobUp >= 0.5 ? 'up' : 'down';
      const vwapDir = t.vwapDir;

      if (vwapDir === clobDir) continue;

      bets++;
      const entryPrice = vwapDir === 'up' ? clobUp : (1 - clobUp);
      const won = vwapDir === r.resolution;
      if (won) { wins++; pnl += (1 - entryPrice); }
      else { pnl -= entryPrice; }

      trades.push({
        close: r.close, window: r.window, resolution: r.resolution,
        clobDir, vwapDir, clobUp: clobUp.toFixed(3),
        entryPrice: entryPrice.toFixed(3), won,
        tradePnL: won ? (1 - entryPrice).toFixed(3) : (-entryPrice).toFixed(3),
        vwapDelta: t.vwapDelta,
      });
    }

    const winPct = bets > 0 ? ((wins / bets) * 100).toFixed(1) : 'N/A';
    console.log(`T-${String(entryT).padStart(2)}s      │ ${String(bets).padStart(3)} / ${results.length}     │ ${String(wins)}/${bets} (${winPct}%)`.padEnd(55) + `│ ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3).padStart(6)} │ ${bets > 0 ? (pnl >= 0 ? '+' : '') + '$' + (pnl / bets).toFixed(3) : 'N/A'}`);

    if (entryT === 60) s1Details[symbol] = trades;
  }

  // ── STRATEGY 2: Strong VWAP signal ──
  console.log('\n── STRATEGY 2: Strong VWAP signal + CLOB Disagreement @T-60 ──\n');

  // Use proportional thresholds based on price
  // BTC thresholds: $25, $50, $75, $100, $150
  // These represent ~0.037%, 0.075%, 0.112%, 0.150%, 0.225% of BTC price ($67K)
  const pctThresholds = [0.00037, 0.00075, 0.00112, 0.0015, 0.00225];
  const absThresholds = pctThresholds.map(p => avgPrice * p);

  console.log('VWAP Δ Threshold │ Trades │ Win Rate          │ Total PnL │ Avg PnL/Trade');
  console.log('─────────────────┼────────┼───────────────────┼───────────┼──────────────');

  for (let i = 0; i < absThresholds.length; i++) {
    const threshold = absThresholds[i];
    const btcEquiv = [25, 50, 75, 100, 150][i];
    let bets = 0, wins = 0, pnl = 0;

    for (const r of results) {
      const t60 = r.trajectory[60];
      if (!t60) continue;

      if (Math.abs(t60.vwapDelta) < threshold) continue;
      const vwapDir = t60.vwapDelta >= 0 ? 'up' : 'down';
      const clobDir = r.up60 >= 0.5 ? 'up' : 'down';
      if (vwapDir === clobDir) continue;

      bets++;
      const entryPrice = vwapDir === 'up' ? r.up60 : (1 - r.up60);
      const won = vwapDir === r.resolution;
      if (won) { wins++; pnl += (1 - entryPrice); }
      else { pnl -= entryPrice; }
    }

    const threshLabel = `> $${threshold.toFixed(symbol === 'xrp' ? 4 : symbol === 'sol' ? 2 : symbol === 'eth' ? 1 : 0)} (≈BTC $${btcEquiv})`;
    const winPct = bets > 0 ? ((wins / bets) * 100).toFixed(1) : 'N/A';
    console.log(`${threshLabel.padEnd(17)}│ ${String(bets).padStart(5)}  │ ${wins}/${bets} (${winPct}%)`.padEnd(55) + `│ ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3).padStart(6)} │ ${bets > 0 ? (pnl >= 0 ? '+' : '') + '$' + (pnl / bets).toFixed(3) : 'N/A'}`);
  }

  // ── STRATEGY 3: VWAP predicts reversal ──
  // Skip — we showed this doesn't work for BTC and it requires CL data we don't have for non-BTC

  // ── AGREE vs DISAGREE breakdown ──
  console.log('\n── When VWAP and CLOB Agree vs Disagree ──\n');
  for (const entryT of [60, 30, 10]) {
    let agreeCorrect = 0, agreeTotal = 0;
    let disagreeVwapCorrect = 0, disagreeClobCorrect = 0, disagreeTotal = 0;

    for (const r of results) {
      const t = r.trajectory[entryT];
      if (!t) continue;

      const clobUp = entryT === 60 ? r.up60 : entryT === 30 ? r.up30 : r.up10;
      const clobDir = clobUp >= 0.5 ? 'up' : 'down';

      if (t.vwapDir === clobDir) {
        agreeTotal++;
        if (t.vwapDir === r.resolution) agreeCorrect++;
      } else {
        disagreeTotal++;
        if (t.vwapDir === r.resolution) disagreeVwapCorrect++;
        if (clobDir === r.resolution) disagreeClobCorrect++;
      }
    }

    console.log(`T-${entryT}s: Agree ${agreeCorrect}/${agreeTotal} (${agreeTotal > 0 ? ((agreeCorrect / agreeTotal) * 100).toFixed(1) : 0}%) | Disagree: VWAP wins ${disagreeVwapCorrect}/${disagreeTotal} (${disagreeTotal > 0 ? ((disagreeVwapCorrect / disagreeTotal) * 100).toFixed(1) : 0}%), CLOB wins ${disagreeClobCorrect}/${disagreeTotal}`);
  }

  // ── All T-60 disagreement trades ──
  const trades60 = s1Details[symbol] || [];
  if (trades60.length > 0 && trades60.length <= 50) {
    console.log('\n── All Disagreement Trades @T-60 ──\n');
    console.log('# │ Close    │ Res  │ CLOB  │ VWAP  │ CLOB UP │ Entry │ VWAP Δ         │ Won │ PnL');
    console.log('──┼──────────┼──────┼───────┼───────┼─────────┼───────┼────────────────┼─────┼───────');
    for (let i = 0; i < trades60.length; i++) {
      const d = trades60[i];
      const deltaStr = (d.vwapDelta >= 0 ? '+' : '') + (symbol === 'xrp' ? d.vwapDelta.toFixed(4) : symbol === 'sol' ? d.vwapDelta.toFixed(2) : d.vwapDelta.toFixed(1));
      console.log(`${String(i + 1).padStart(2)}│ ${d.close} │ ${d.resolution.padEnd(4)} │ ${d.clobDir.padEnd(5)} │ ${d.vwapDir.padEnd(5)} │ ${d.clobUp.padStart(7)} │ ${d.entryPrice} │ ${deltaStr.padStart(14)} │ ${d.won ? 'YES' : 'NO '} │ ${d.tradePnL}`);
    }

    const totalWins = trades60.filter(t => t.won).length;
    const totalPnl = trades60.reduce((s, t) => s + parseFloat(t.tradePnL), 0);
    console.log(`\nTotals: ${totalWins}/${trades60.length} wins. Net PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(3)} on ${trades60.length} $1 bets.`);
  }

  return {
    symbol: SYM,
    windows: results.length,
    avgPrice,
    vwapAcc60: vwapAcc[60],
    clobAcc60: clobAcc[60],
    s1_60: (() => {
      const trades = s1Details[symbol] || [];
      const wins = trades.filter(t => t.won).length;
      const pnl = trades.reduce((s, t) => s + parseFloat(t.tradePnL), 0);
      return { trades: trades.length, wins, pnl };
    })(),
  };
}

async function main() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();

  const summaries = [];

  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    const data = await analyzeSymbol(client, sym);
    if (data) {
      const summary = runStrategies(data);
      summaries.push(summary);
    }
  }

  // ── CROSS-INSTRUMENT COMPARISON ──
  console.log(`\n\n${'█'.repeat(70)}`);
  console.log('█  CROSS-INSTRUMENT COMPARISON');
  console.log(`${'█'.repeat(70)}\n`);

  console.log('Instrument │ Windows │ Avg Price    │ VWAP Acc@60  │ CLOB Acc@60  │ S1 Trades │ S1 Win%   │ S1 PnL');
  console.log('───────────┼─────────┼──────────────┼──────────────┼──────────────┼───────────┼───────────┼────────');

  for (const s of summaries) {
    const vPct = ((s.vwapAcc60.correct / s.vwapAcc60.total) * 100).toFixed(1);
    const cPct = ((s.clobAcc60.correct / s.clobAcc60.total) * 100).toFixed(1);
    const s1WinPct = s.s1_60.trades > 0 ? ((s.s1_60.wins / s.s1_60.trades) * 100).toFixed(1) : 'N/A';
    console.log(
      `${s.symbol.padEnd(10)} │ ${String(s.windows).padStart(7)} │ $${s.avgPrice.toFixed(2).padStart(10)} │ ${vPct.padStart(5)}%       │ ${cPct.padStart(5)}%       │ ${String(s.s1_60.trades).padStart(9)} │ ${s1WinPct.padStart(5)}%    │ ${s.s1_60.pnl >= 0 ? '+' : ''}$${s.s1_60.pnl.toFixed(3)}`
    );
  }

  console.log('\nKey: S1 = Strategy 1 (bet VWAP when it disagrees with CLOB @ T-60s)');
  console.log('Resolution source: on-chain CTF payouts (ground truth)\n');

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
