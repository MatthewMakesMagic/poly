/**
 * VWAP Edge Analysis: Contested Windows (Batch Version)
 *
 * Bulk-loads VWAP snapshots and window events, processes in memory.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');

async function main() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  console.log('Connected to DB');

  // 1. Bulk load all BTC windows in VWAP range
  const windowsRes = await client.query(`
    SELECT window_id, window_close_time, strike_price,
           oracle_price_at_close,
           oracle_price_60s_before, oracle_price_30s_before, oracle_price_10s_before,
           oracle_price_5s_before, oracle_price_1s_before,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s
    FROM window_close_events
    WHERE symbol = 'btc'
    AND window_close_time >= '2026-02-12T02:11:00Z'
    AND window_close_time <= '2026-02-13T10:22:00Z'
    ORDER BY window_close_time
  `);
  console.log(`Loaded ${windowsRes.rows.length} windows`);

  // 2. Bulk load ALL BTC VWAP snapshots in the range (with some buffer for opens)
  console.log('Loading VWAP snapshots (this may take a moment)...');
  const vwapRes = await client.query(`
    SELECT timestamp, composite_vwap, chainlink_price
    FROM vwap_snapshots
    WHERE symbol = 'btc'
    AND timestamp >= '2026-02-12T01:50:00Z'
    AND timestamp <= '2026-02-13T10:25:00Z'
    ORDER BY timestamp
  `);
  console.log(`Loaded ${vwapRes.rows.length} VWAP snapshots`);

  // Build a time-indexed array for fast lookup
  const vwapData = vwapRes.rows.map(r => ({
    ts: r.timestamp.getTime(),
    vwap: parseFloat(r.composite_vwap),
    cl: r.chainlink_price ? parseFloat(r.chainlink_price) : null,
  }));

  // Binary search for nearest snapshot to a given timestamp
  function findNearest(targetMs, maxDeltaMs = 5000) {
    let lo = 0, hi = vwapData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vwapData[mid].ts < targetMs) lo = mid + 1;
      else hi = mid;
    }
    // Check lo and lo-1 for closest
    let best = lo;
    if (lo > 0 && Math.abs(vwapData[lo - 1].ts - targetMs) < Math.abs(vwapData[lo].ts - targetMs)) {
      best = lo - 1;
    }
    if (Math.abs(vwapData[best].ts - targetMs) > maxDeltaMs) return null;
    return vwapData[best];
  }

  // Find nearest with non-null CL
  function findNearestWithCL(targetMs, maxDeltaMs = 5000) {
    let lo = 0, hi = vwapData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vwapData[mid].ts < targetMs) lo = mid + 1;
      else hi = mid;
    }
    // Search outward from lo for one with CL
    for (let radius = 0; radius < 10; radius++) {
      for (const idx of [lo - radius, lo + radius]) {
        if (idx >= 0 && idx < vwapData.length && vwapData[idx].cl !== null) {
          if (Math.abs(vwapData[idx].ts - targetMs) <= maxDeltaMs) {
            return vwapData[idx];
          }
        }
      }
    }
    return null;
  }

  // 3. Process each window
  const results = [];

  for (const w of windowsRes.rows) {
    const closeMs = w.window_close_time.getTime();
    const openMs = closeMs - 900000; // 15 min

    const atOpen = findNearestWithCL(openMs);
    const atClose = findNearestWithCL(closeMs);
    if (!atOpen || !atClose) continue;

    const clOpenPrice = atOpen.cl;
    const clClosePrice = atClose.cl;
    const vwapOpen = atOpen.vwap;
    const resolution = clClosePrice >= clOpenPrice ? 'up' : 'down';

    // Trajectory at T-60, T-30, T-10, T-5
    const trajectory = {};
    for (const offset of [60, 30, 10, 5]) {
      const snap = findNearest(closeMs - offset * 1000, 3000);
      if (snap) {
        trajectory[offset] = {
          vwap: snap.vwap,
          cl: snap.cl,
          vwapDir: snap.vwap >= vwapOpen ? 'up' : 'down',
          clDir: snap.cl !== null ? (snap.cl >= clOpenPrice ? 'up' : 'down') : '?',
          vwapDelta: snap.vwap - vwapOpen,
        };
      }
    }

    const up60 = parseFloat(w.market_up_price_60s || 0);
    const up30 = parseFloat(w.market_up_price_30s || 0);
    const up10 = parseFloat(w.market_up_price_10s || 0);
    const up5 = parseFloat(w.market_up_price_5s || 0);
    const up1 = parseFloat(w.market_up_price_1s || 0);

    results.push({
      window: w.window_id,
      close: w.window_close_time.toISOString().slice(11, 19),
      clDiff: clClosePrice - clOpenPrice,
      resolution,
      vwapOpen,
      up60, up30, up10, up5, up1,
      trajectory,
    });
  }

  console.log(`\nProcessed ${results.length} windows with full data\n`);

  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 1: Bet with VWAP when it disagrees with CLOB
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('STRATEGY 1: VWAP disagrees with CLOB → bet with VWAP');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const entryT of [60, 30, 10, 5]) {
    let bets = 0, wins = 0, pnl = 0;
    const details = [];

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
      if (won) {
        wins++;
        pnl += (1.0 - entryPrice);
      } else {
        pnl -= entryPrice;
      }

      details.push({
        close: r.close,
        clDiff: r.clDiff.toFixed(0),
        resolution: r.resolution,
        clobDir,
        vwapDir,
        clobUp: clobUp.toFixed(3),
        entryPrice: entryPrice.toFixed(3),
        won,
        tradePnL: won ? (1 - entryPrice).toFixed(3) : (-entryPrice).toFixed(3),
      });
    }

    console.log(`--- Entry at T-${entryT}s ---`);
    console.log(`Trades: ${bets} | Wins: ${wins}/${bets} (${bets > 0 ? ((wins / bets) * 100).toFixed(1) : 0}%) | PnL: ${pnl.toFixed(3)} | Avg PnL/trade: ${bets > 0 ? (pnl / bets).toFixed(3) : 'N/A'}`);

    if (details.length <= 40) {
      console.log('  Close    | CL diff | Res  | CLOB  | VWAP  | ClobUP | Entry | Won | PnL');
      for (const d of details) {
        console.log(`  ${d.close} | ${d.clDiff.padStart(7)} | ${d.resolution.padEnd(4)} | ${d.clobDir.padEnd(5)} | ${d.vwapDir.padEnd(5)} | ${d.clobUp} | ${d.entryPrice} | ${d.won ? 'YES' : 'NO '} | ${d.tradePnL}`);
      }
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 2: Strong VWAP signal + CLOB disagreement
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('STRATEGY 2: Strong VWAP signal (delta threshold) vs CLOB @T-60');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of [25, 50, 75, 100, 150]) {
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

    console.log(`VWAP delta > $${String(threshold).padStart(3)}: ${wins}/${bets} wins (${bets > 0 ? ((wins / bets) * 100).toFixed(1) : 0}%), PnL: ${pnl.toFixed(3)}, Avg: ${bets > 0 ? (pnl / bets).toFixed(3) : 'N/A'}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 3: VWAP predicts CL reversal
  // ═══════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STRATEGY 3: VWAP predicts CL reversal at T-60');
  console.log('(VWAP dir != CL current dir at T-60, bet with VWAP)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  {
    let bets = 0, wins = 0, pnl = 0;
    const details = [];

    for (const r of results) {
      const t60 = r.trajectory[60];
      if (!t60 || t60.cl === null) continue;

      if (t60.clDir === t60.vwapDir) continue;

      bets++;
      const entryPrice = t60.vwapDir === 'up' ? r.up60 : (1 - r.up60);
      const won = t60.vwapDir === r.resolution;
      if (won) { wins++; pnl += (1 - entryPrice); }
      else { pnl -= entryPrice; }

      details.push({
        close: r.close, clDiff: r.clDiff.toFixed(0), resolution: r.resolution,
        clDir: t60.clDir, vwapDir: t60.vwapDir, clobUp: r.up60.toFixed(3),
        entryPrice: entryPrice.toFixed(3), won,
      });
    }

    console.log(`Trades: ${bets} | Wins: ${wins}/${bets} (${bets > 0 ? ((wins / bets) * 100).toFixed(1) : 0}%) | PnL: ${pnl.toFixed(3)}`);
    if (details.length <= 30) {
      console.log('  Close    | CL Diff | Res  | CL@60 | VWAP  | CLOB UP | Entry | Won');
      for (const d of details) {
        console.log(`  ${d.close} | ${d.clDiff.padStart(7)} | ${d.resolution.padEnd(4)} | ${d.clDir.padEnd(5)} | ${d.vwapDir.padEnd(5)} | ${d.clobUp.padStart(7)} | ${d.entryPrice} | ${d.won ? 'YES' : 'NO'}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 4: T-10 entry, VWAP disagrees, CLOB not extreme
  // ═══════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STRATEGY 4: T-10s entry, VWAP disagrees, CLOB not extreme (<0.80)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  {
    let bets = 0, wins = 0, pnl = 0;
    const details = [];

    for (const r of results) {
      const t10 = r.trajectory[10];
      if (!t10) continue;

      const clobDir = r.up10 >= 0.5 ? 'up' : 'down';
      if (t10.vwapDir === clobDir) continue;

      const maxClob = Math.max(r.up10, 1 - r.up10);
      if (maxClob >= 0.80) continue;

      bets++;
      const entryPrice = t10.vwapDir === 'up' ? r.up10 : (1 - r.up10);
      const won = t10.vwapDir === r.resolution;
      if (won) { wins++; pnl += (1 - entryPrice); }
      else { pnl -= entryPrice; }

      details.push({
        close: r.close, clDiff: r.clDiff.toFixed(0), resolution: r.resolution,
        vwapDir: t10.vwapDir, clobUp: r.up10.toFixed(3),
        entryPrice: entryPrice.toFixed(3), won,
        tradePnL: won ? (1 - entryPrice).toFixed(3) : (-entryPrice).toFixed(3),
      });
    }

    console.log(`Trades: ${bets} | Wins: ${wins}/${bets} (${bets > 0 ? ((wins / bets) * 100).toFixed(1) : 0}%) | PnL: ${pnl.toFixed(3)} | Avg: ${bets > 0 ? (pnl / bets).toFixed(3) : 'N/A'}`);
    if (details.length > 0) {
      console.log('  Close    | CL Diff | Res  | VWAP  | CLOB UP | Entry | Won | PnL');
      for (const d of details) {
        console.log(`  ${d.close} | ${d.clDiff.padStart(7)} | ${d.resolution.padEnd(4)} | ${d.vwapDir.padEnd(5)} | ${d.clobUp.padStart(7)} | ${d.entryPrice} | ${d.won ? 'YES' : 'NO '} | ${d.tradePnL}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BASELINE: Direction accuracy and agree/disagree breakdown
  // ═══════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('BASELINE: Direction accuracy comparison');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const entryT of [60, 30, 10, 5]) {
    let correct = 0, total = 0;
    for (const r of results) {
      const t = r.trajectory[entryT];
      if (!t) continue;
      total++;
      if (t.vwapDir === r.resolution) correct++;
    }
    console.log(`VWAP@T-${String(entryT).padStart(2)}s: ${correct}/${total} (${((correct / total) * 100).toFixed(1)}%)`);
  }

  console.log('');
  for (const [t, field] of [[60, 'up60'], [30, 'up30'], [10, 'up10'], [5, 'up5'], [1, 'up1']]) {
    let correct = 0;
    for (const r of results) {
      const clobDir = r[field] >= 0.5 ? 'up' : 'down';
      if (clobDir === r.resolution) correct++;
    }
    console.log(`CLOB@T-${String(t).padStart(2)}s: ${correct}/${results.length} (${((correct / results.length) * 100).toFixed(1)}%)`);
  }

  // KEY: When they agree vs disagree
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('KEY: When VWAP and CLOB agree vs disagree');
  console.log('═══════════════════════════════════════════════════════════════\n');

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

    console.log(`--- T-${entryT}s ---`);
    console.log(`  Agree (${agreeTotal}): ${agreeCorrect}/${agreeTotal} correct (${agreeTotal > 0 ? ((agreeCorrect / agreeTotal) * 100).toFixed(1) : 0}%)`);
    console.log(`  Disagree (${disagreeTotal}):`);
    console.log(`    VWAP correct: ${disagreeVwapCorrect}/${disagreeTotal} (${disagreeTotal > 0 ? ((disagreeVwapCorrect / disagreeTotal) * 100).toFixed(1) : 0}%)`);
    console.log(`    CLOB correct: ${disagreeClobCorrect}/${disagreeTotal} (${disagreeTotal > 0 ? ((disagreeClobCorrect / disagreeTotal) * 100).toFixed(1) : 0}%)`);
    console.log('');
  }

  await client.end();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
