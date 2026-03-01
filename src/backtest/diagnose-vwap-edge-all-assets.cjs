/**
 * VWAP Edge Analysis — All Assets (BTC, ETH, SOL, XRP)
 *
 * Batch-optimized: loads all vwap_snapshots once per asset, then does in-memory lookups.
 *
 * For each asset:
 * 1. Load resolved windows from window_close_events (CL resolution + CLOB prices)
 * 2. Bulk-load vwap_snapshots for relevant time ranges
 * 3. Test VWAP-vs-CLOB disagreement strategy at all variations
 * 4. Measure CoinGecko accuracy as oracle proxy
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-vwap-edge-all-assets.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DELTA_THRESHOLDS_PCT = [0.0, 0.035, 0.07, 0.1, 0.14, 0.21];
const ENTRY_TIMINGS = [
  { label: 'T-60s',  offsetFromClose: 60,  clobKey: 'clobUp60' },
  { label: 'T-30s',  offsetFromClose: 30,  clobKey: 'clobUp30' },
  { label: 'T-10s',  offsetFromClose: 10,  clobKey: 'clobUp10' },
  { label: 'T-5s',   offsetFromClose: 5,   clobKey: 'clobUp5' },
];

async function analyzeAsset(symbol) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${symbol.toUpperCase()} — VWAP EDGE ANALYSIS`);
  console.log(`${'='.repeat(80)}`);

  // 1. Load all resolved windows
  const windows = await pool.query(`
    SELECT window_id, symbol, window_close_time,
           oracle_price_at_open, oracle_price_at_close,
           resolved_direction, onchain_resolved_direction,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s,
           strike_price
    FROM window_close_events
    WHERE symbol = $1
      AND oracle_price_at_open IS NOT NULL
      AND oracle_price_at_close IS NOT NULL
      AND resolved_direction IS NOT NULL
    ORDER BY window_close_time ASC
  `, [symbol]);

  console.log(`Loaded ${windows.rows.length} resolved windows`);
  if (windows.rows.length === 0) return null;

  // Parse epochs
  const parseEpoch = (windowId) => parseInt(windowId.split('-').pop());
  const windowEpochs = windows.rows.map(w => parseEpoch(w.window_id));
  const minEpoch = Math.min(...windowEpochs);
  const maxEpoch = Math.max(...windowEpochs) + 900;

  // 2. Bulk-load vwap_snapshots for the entire date range
  console.log(`Loading vwap_snapshots for ${symbol} (epoch ${minEpoch} to ${maxEpoch})...`);
  const snapshots = await pool.query(`
    SELECT EXTRACT(EPOCH FROM timestamp)::int as epoch_sec,
           composite_vwap, coingecko_price, chainlink_price
    FROM vwap_snapshots
    WHERE symbol = $1
      AND timestamp >= to_timestamp($2::numeric)
      AND timestamp <= to_timestamp($3::numeric)
    ORDER BY timestamp ASC
  `, [symbol, minEpoch - 30, maxEpoch + 30]);

  console.log(`Loaded ${snapshots.rows.length} snapshots`);

  // Build lookup index: epoch_sec -> { vwap, cg, cl }
  const snapIndex = new Map();
  for (const s of snapshots.rows) {
    snapIndex.set(s.epoch_sec, {
      vwap: parseFloat(s.composite_vwap),
      cg: s.coingecko_price ? parseFloat(s.coingecko_price) : null,
      cl: s.chainlink_price ? parseFloat(s.chainlink_price) : null,
    });
  }

  // Lookup helpers
  function getSnap(targetEpoch, maxDrift) {
    // Check exact first, then widen
    for (let d = 0; d <= (maxDrift || 5); d++) {
      if (snapIndex.has(targetEpoch + d)) return snapIndex.get(targetEpoch + d);
      if (d > 0 && snapIndex.has(targetEpoch - d)) return snapIndex.get(targetEpoch - d);
    }
    return null;
  }

  function getSnapWithCg(targetEpoch) {
    // Find nearest snap with non-null CoinGecko within ±15s
    for (let d = 0; d <= 15; d++) {
      const s = snapIndex.get(targetEpoch + d);
      if (s && s.cg !== null) return s;
      if (d > 0) {
        const s2 = snapIndex.get(targetEpoch - d);
        if (s2 && s2.cg !== null) return s2;
      }
    }
    return null;
  }

  // 3. Process each window
  const windowData = [];
  let skipped = 0;

  for (const w of windows.rows) {
    const openEpoch = parseEpoch(w.window_id);
    const closeEpoch = openEpoch + 900;

    const atOpen = getSnap(openEpoch);
    if (!atOpen) { skipped++; continue; }

    const cgAtOpen = getSnapWithCg(openEpoch);
    const cgAtClose = getSnapWithCg(closeEpoch);

    const signals = {};
    for (const timing of ENTRY_TIMINGS) {
      const signalEpoch = closeEpoch - timing.offsetFromClose;
      const snap = getSnap(signalEpoch);
      if (snap) signals[timing.label] = snap;
    }

    const clOpen = parseFloat(w.oracle_price_at_open);
    const clClose = parseFloat(w.oracle_price_at_close);
    const clMove = clClose - clOpen;
    const clMovePct = (clMove / clOpen) * 100;

    windowData.push({
      windowId: w.window_id,
      openEpoch,
      clOpen, clClose, clMove, clMovePct,
      clResolution: clClose >= clOpen ? 'up' : 'down',
      onchainResolution: w.onchain_resolved_direction?.toLowerCase() || null,
      cgResolution: (cgAtOpen?.cg && cgAtClose?.cg) ? (cgAtClose.cg >= cgAtOpen.cg ? 'up' : 'down') : null,
      cgAtOpen: cgAtOpen?.cg, cgAtClose: cgAtClose?.cg,
      vwapAtOpen: atOpen.vwap,
      signals,
      clobUp60: w.market_up_price_60s ? parseFloat(w.market_up_price_60s) : null,
      clobUp30: w.market_up_price_30s ? parseFloat(w.market_up_price_30s) : null,
      clobUp10: w.market_up_price_10s ? parseFloat(w.market_up_price_10s) : null,
      clobUp5: w.market_up_price_5s ? parseFloat(w.market_up_price_5s) : null,
    });
  }

  console.log(`Processed ${windowData.length} windows (${skipped} skipped — no VWAP data)`);
  if (windowData.length === 0) return null;

  // Resolution function — prefer on-chain
  const useOnchain = windowData.filter(w => w.onchainResolution).length;
  const resMode = useOnchain > windowData.length * 0.5 ? 'onchain' : 'cl';
  console.log(`Using ${resMode === 'onchain' ? 'on-chain' : 'CL-based'} resolution (${useOnchain} on-chain available)`);
  const getRes = (w) => resMode === 'onchain' && w.onchainResolution ? w.onchainResolution : w.clResolution;

  // ─── CoinGecko Oracle Proxy Accuracy ───
  const cgTestable = windowData.filter(w => w.cgResolution);
  if (cgTestable.length > 0) {
    let cgCorrect = 0;
    for (const w of cgTestable) {
      if (w.cgResolution === getRes(w)) cgCorrect++;
    }
    console.log(`\nCoinGecko as oracle proxy: ${cgCorrect}/${cgTestable.length} (${(cgCorrect/cgTestable.length*100).toFixed(1)}%)`);
  }

  // ─── Oracle Move Distribution ───
  const absMoves = windowData.map(w => Math.abs(w.clMovePct)).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.floor(arr.length * p)] || 0;
  console.log(`\nOracle move distribution (% of price):`);
  console.log(`  25th: ${pct(absMoves, 0.25).toFixed(4)}%  50th: ${pct(absMoves, 0.50).toFixed(4)}%  75th: ${pct(absMoves, 0.75).toFixed(4)}%  90th: ${pct(absMoves, 0.90).toFixed(4)}%`);

  const upCount = windowData.filter(w => getRes(w) === 'up').length;
  console.log(`  UP: ${upCount} (${(upCount/windowData.length*100).toFixed(1)}%)  DOWN: ${windowData.length - upCount} (${((windowData.length - upCount)/windowData.length*100).toFixed(1)}%)`);

  // ─── Baseline Accuracy ───
  console.log(`\nBaseline accuracy (signal predicts resolution):`);
  console.log(`  ${'Signal'.padEnd(10)} ${'T-60s'.padEnd(14)} ${'T-30s'.padEnd(14)} ${'T-10s'.padEnd(14)} ${'T-5s'.padEnd(14)}`);

  // VWAP accuracy
  let vwapLine = '  VWAP      ';
  for (const timing of ENTRY_TIMINGS) {
    let correct = 0, total = 0;
    for (const w of windowData) {
      const sig = w.signals[timing.label];
      if (!sig) continue;
      total++;
      const vwapDir = (sig.vwap - w.vwapAtOpen) >= 0 ? 'up' : 'down';
      if (vwapDir === getRes(w)) correct++;
    }
    vwapLine += `${correct}/${total} ${(correct/total*100).toFixed(1)}%  `;
  }
  console.log(vwapLine);

  // CLOB accuracy
  let clobLine = '  CLOB      ';
  for (const timing of ENTRY_TIMINGS) {
    let correct = 0, total = 0;
    for (const w of windowData) {
      const clobUp = w[timing.clobKey];
      if (clobUp == null) continue;
      total++;
      const clobDir = clobUp >= 0.5 ? 'up' : 'down';
      if (clobDir === getRes(w)) correct++;
    }
    clobLine += `${correct}/${total} ${(correct/total*100).toFixed(1)}%  `;
  }
  console.log(clobLine);

  // ─── Strategy Matrix ───
  console.log(`\n${'─'.repeat(80)}`);
  console.log('STRATEGY: VWAP disagrees with CLOB → bet with VWAP');
  console.log(`${'─'.repeat(80)}`);

  const results = [];

  for (const timing of ENTRY_TIMINGS) {
    for (const threshPct of DELTA_THRESHOLDS_PCT) {
      let trades = 0, wins = 0, totalPnl = 0, totalEntry = 0;
      const tradeDetails = [];

      for (const w of windowData) {
        const sig = w.signals[timing.label];
        if (!sig) continue;
        const clobUp = w[timing.clobKey];
        if (clobUp == null) continue;

        const vwapDelta = sig.vwap - w.vwapAtOpen;
        const vwapDeltaPct = Math.abs(vwapDelta / w.vwapAtOpen) * 100;
        const vwapDir = vwapDelta >= 0 ? 'up' : 'down';
        const clobDir = clobUp >= 0.5 ? 'up' : 'down';

        if (vwapDir === clobDir) continue;
        if (vwapDeltaPct < threshPct) continue;

        const entryPrice = vwapDir === 'up' ? clobUp : (1 - clobUp);
        const res = getRes(w);
        const won = vwapDir === res;

        trades++;
        if (won) { wins++; totalPnl += (1 - entryPrice); }
        else { totalPnl -= entryPrice; }
        totalEntry += entryPrice;

        tradeDetails.push({
          window: w.windowId,
          vwapDeltaPct: vwapDeltaPct.toFixed(3),
          clMovePct: w.clMovePct.toFixed(3),
          entry: entryPrice.toFixed(3),
          won,
        });
      }

      results.push({
        timing: timing.label,
        threshPct,
        trades,
        wins,
        winRate: trades > 0 ? (wins / trades * 100) : 0,
        totalPnl,
        avgPnl: trades > 0 ? totalPnl / trades : 0,
        avgEntry: trades > 0 ? totalEntry / trades : 0,
        details: tradeDetails,
      });
    }
  }

  // Print table
  console.log(`\n  ${'Timing'.padEnd(8)} ${'Thresh%'.padEnd(9)} ${'Trades'.padEnd(7)} ${'Wins'.padEnd(6)} ${'WinRate'.padEnd(9)} ${'TotalPnL'.padEnd(10)} ${'AvgPnL'.padEnd(9)} ${'AvgEntry'.padEnd(9)}`);
  console.log(`  ${'─'.repeat(75)}`);

  for (const r of results) {
    if (r.trades === 0) continue;
    const marker = r.winRate >= 80 ? ' ★' : r.winRate >= 70 ? ' ·' : '';
    console.log(`  ${r.timing.padEnd(8)} ${(r.threshPct.toFixed(3) + '%').padEnd(9)} ${String(r.trades).padEnd(7)} ${String(r.wins).padEnd(6)} ${(r.winRate.toFixed(1) + '%').padEnd(9)} ${('$' + r.totalPnl.toFixed(3)).padEnd(10)} ${('$' + r.avgPnl.toFixed(3)).padEnd(9)} ${('$' + r.avgEntry.toFixed(3)).padEnd(9)}${marker}`);
  }

  // Top configs
  const profitable = results.filter(r => r.avgPnl > 0 && r.trades >= 3);
  if (profitable.length > 0) {
    profitable.sort((a, b) => b.avgPnl - a.avgPnl);
    const avgPrice = windowData.reduce((s, w) => s + w.clOpen, 0) / windowData.length;
    console.log(`\n  TOP CONFIGS (profitable, n≥3):`);
    for (const r of profitable.slice(0, 5)) {
      const absThresh = '$' + (r.threshPct / 100 * avgPrice).toFixed(2);
      console.log(`    ${r.timing} thresh=${r.threshPct.toFixed(3)}% (${absThresh}): ${r.wins}/${r.trades} (${r.winRate.toFixed(1)}%) avg=$${r.avgPnl.toFixed(3)}/trade`);
    }
  } else {
    console.log(`\n  No profitable configs with n≥3.`);
  }

  // Disagreement frequency
  console.log(`\n  Disagreement frequency (no threshold):`);
  for (const timing of ENTRY_TIMINGS) {
    let disagree = 0, total = 0;
    for (const w of windowData) {
      const sig = w.signals[timing.label];
      if (!sig || w[timing.clobKey] == null) continue;
      total++;
      const vwapDir = (sig.vwap - w.vwapAtOpen) >= 0 ? 'up' : 'down';
      const clobDir = w[timing.clobKey] >= 0.5 ? 'up' : 'down';
      if (vwapDir !== clobDir) disagree++;
    }
    if (total > 0) console.log(`    ${timing.label}: ${disagree}/${total} (${(disagree/total*100).toFixed(1)}%)`);
  }

  return { symbol, windowCount: windowData.length, results };
}

async function main() {
  console.log('VWAP EDGE ANALYSIS — ALL ASSETS');
  console.log(`Run: ${new Date().toISOString()}`);
  console.log('Strategy: When VWAP direction disagrees with CLOB, bet with VWAP');
  console.log('Thresholds (% of price): ' + DELTA_THRESHOLDS_PCT.map(t => t.toFixed(3) + '%').join(', '));

  const allResults = {};

  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    try {
      const result = await analyzeAsset(sym);
      if (result) allResults[sym] = result;
    } catch (err) {
      console.error(`\nERROR on ${sym}: ${err.message}`);
      console.error(err.stack);
    }
  }

  // ─── Cross-Asset Comparison ───
  console.log(`\n${'='.repeat(80)}`);
  console.log('  CROSS-ASSET COMPARISON — BEST CONFIGS');
  console.log(`${'='.repeat(80)}`);

  for (const [sym, data] of Object.entries(allResults)) {
    const profitable = (data.results || []).filter(r => r.avgPnl > 0 && r.trades >= 3);
    if (profitable.length > 0) {
      profitable.sort((a, b) => b.avgPnl - a.avgPnl);
      const best = profitable[0];
      console.log(`  ${sym.toUpperCase().padEnd(4)} best: ${best.timing} @ ${best.threshPct.toFixed(3)}% → ${best.wins}/${best.trades} (${best.winRate.toFixed(1)}%) avg=$${best.avgPnl.toFixed(3)}/trade, total=$${best.totalPnl.toFixed(3)}`);
    } else {
      console.log(`  ${sym.toUpperCase().padEnd(4)} : No profitable config (n≥3)`);
    }
  }

  // Volume-weighted opportunity
  console.log(`\n  Opportunity summary (best profitable config per timing per asset):`);
  console.log(`  ${'Asset'.padEnd(6)} ${'Timing'.padEnd(8)} ${'Thresh'.padEnd(8)} ${'Rate'.padEnd(8)} ${'Trades'.padEnd(8)} ${'$/trade'.padEnd(8)} ${'Total$'.padEnd(8)}`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const [sym, data] of Object.entries(allResults)) {
    for (const timing of ENTRY_TIMINGS) {
      const forTiming = (data.results || []).filter(r => r.timing === timing.label && r.avgPnl > 0 && r.trades >= 2);
      if (forTiming.length > 0) {
        forTiming.sort((a, b) => b.avgPnl - a.avgPnl);
        const b = forTiming[0];
        console.log(`  ${sym.toUpperCase().padEnd(6)} ${b.timing.padEnd(8)} ${(b.threshPct.toFixed(3)+'%').padEnd(8)} ${(b.winRate.toFixed(0)+'%').padEnd(8)} ${String(b.trades).padEnd(8)} ${('$'+b.avgPnl.toFixed(3)).padEnd(8)} ${('$'+b.totalPnl.toFixed(3)).padEnd(8)}`);
      }
    }
  }

  await pool.end();
  console.log('\n\nDone.');
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
