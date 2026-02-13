/**
 * Detailed trade-by-trade breakdown — LEAN version
 * No exchange_detail JSONB, no CLOB snapshots table, fast.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');

async function main() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  const t0 = Date.now();

  const [windowsRes, vwapRes] = await Promise.all([
    client.query(`
      SELECT window_id, window_close_time,
             market_up_price_60s, market_up_price_30s, market_up_price_10s,
             market_up_price_5s, market_up_price_1s
      FROM window_close_events
      WHERE symbol = 'btc'
      AND window_close_time >= '2026-02-12T02:11:00Z'
      AND window_close_time <= '2026-02-13T10:22:00Z'
      ORDER BY window_close_time
    `),
    client.query(`
      SELECT timestamp, composite_vwap, chainlink_price
      FROM vwap_snapshots
      WHERE symbol = 'btc'
      AND chainlink_price IS NOT NULL
      AND timestamp >= '2026-02-12T01:50:00Z'
      AND timestamp <= '2026-02-13T10:25:00Z'
      ORDER BY timestamp
    `)
  ]);
  await client.end();
  console.log(`Loaded ${windowsRes.rows.length} windows + ${vwapRes.rows.length} snaps in ${Date.now()-t0}ms\n`);

  // Index by epoch second
  const idx = new Map();
  for (const v of vwapRes.rows) {
    const e = Math.round(v.timestamp.getTime() / 1000);
    if (!idx.has(e)) idx.set(e, { vwap: parseFloat(v.composite_vwap), cl: parseFloat(v.chainlink_price) });
  }
  function snap(ms) {
    const e = Math.round(ms / 1000);
    for (let d = 0; d <= 3; d++) {
      if (idx.has(e+d)) return idx.get(e+d);
      if (d && idx.has(e-d)) return idx.get(e-d);
    }
    return null;
  }

  const trades = [];
  for (const w of windowsRes.rows) {
    const closeMs = w.window_close_time.getTime();
    const openMs = closeMs - 900000;
    const o = snap(openMs), c = snap(closeMs);
    if (!o || !c) continue;

    const res = c.cl >= o.cl ? 'UP' : 'DOWN';
    const vwapOpen = o.vwap;

    const s60 = snap(closeMs - 60000);
    if (!s60) continue;
    const vwapDir = s60.vwap >= vwapOpen ? 'UP' : 'DOWN';
    const up60 = parseFloat(w.market_up_price_60s || 0);
    const clobDir = up60 >= 0.5 ? 'UP' : 'DOWN';
    if (vwapDir === clobDir) continue;

    const up30 = parseFloat(w.market_up_price_30s || 0);
    const up10 = parseFloat(w.market_up_price_10s || 0);
    const up5 = parseFloat(w.market_up_price_5s || 0);
    const up1 = parseFloat(w.market_up_price_1s || 0);
    const entry = vwapDir === 'UP' ? up60 : (1 - up60);
    const won = vwapDir === res;
    const pnl = won ? (1 - entry) : -entry;

    // Build price timeline
    const offsets = [300, 180, 120, 60, 30, 10, 5, 0];
    const timeline = [];
    for (const off of offsets) {
      const s = snap(closeMs - off * 1000);
      if (!s) continue;
      timeline.push({
        label: off === 0 ? 'CLOSE' : `T-${off}s`,
        vwapD: s.vwap - vwapOpen,
        clD: s.cl - o.cl,
        vDir: s.vwap >= vwapOpen ? 'UP' : 'DN',
        cDir: s.cl >= o.cl ? 'UP' : 'DN',
      });
    }

    trades.push({
      id: w.window_id,
      openUTC: new Date(openMs).toISOString().slice(0,19)+'Z',
      closeUTC: w.window_close_time.toISOString().slice(0,19)+'Z',
      entryUTC: new Date(closeMs - 60000).toISOString().slice(0,19)+'Z',
      clOpen: o.cl, clClose: c.cl, clDiff: c.cl - o.cl,
      vwapOpen: o.vwap, vwapClose: c.vwap, vwapAt60: s60.vwap,
      clAt60: s60.cl,
      res, vwapDir, clobDir,
      up60, up30, up10, up5, up1,
      entry, won, pnl,
      timeline,
    });
  }

  // Print
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const tag = t.won ? 'WIN' : 'LOSS';
    console.log(`${'─'.repeat(80)}`);
    console.log(`TRADE #${i+1}/${trades.length}: ${tag}  │  ${t.id}`);
    console.log(`${'─'.repeat(80)}`);
    console.log(`  Window:  ${t.openUTC} → ${t.closeUTC}  (15 min)`);
    console.log(`  Entry:   ${t.entryUTC}  (T-60s before close)`);
    console.log(`  Resolve: ${t.closeUTC}`);
    console.log('');
    console.log(`  Chainlink Oracle:`);
    console.log(`    @open   $${t.clOpen.toFixed(2)}`);
    console.log(`    @T-60s  $${t.clAt60.toFixed(2)}  (${(t.clAt60-t.clOpen)>=0?'+':''}$${(t.clAt60-t.clOpen).toFixed(2)} from open)`);
    console.log(`    @close  $${t.clClose.toFixed(2)}  (${t.clDiff>=0?'+':''}$${t.clDiff.toFixed(2)} from open)`);
    console.log(`    Resolution: ${t.res}`);
    console.log('');
    console.log(`  Our VWAP (21 exchanges):`);
    console.log(`    @open   $${t.vwapOpen.toFixed(2)}`);
    console.log(`    @T-60s  $${t.vwapAt60.toFixed(2)}  (${(t.vwapAt60-t.vwapOpen)>=0?'+':''}$${(t.vwapAt60-t.vwapOpen).toFixed(2)} → says ${t.vwapDir})`);
    console.log(`    @close  $${t.vwapClose.toFixed(2)}`);
    console.log('');
    console.log(`  CLOB (UP token price):`);
    console.log(`    @T-60s  $${t.up60.toFixed(4)}  → CLOB says ${t.clobDir}`);
    console.log(`    @T-30s  $${t.up30.toFixed(4)}`);
    console.log(`    @T-10s  $${t.up10.toFixed(4)}`);
    console.log(`    @T-5s   $${t.up5.toFixed(4)}`);
    console.log(`    @T-1s   $${t.up1.toFixed(4)}`);
    console.log('');
    console.log(`  TRADE MECHANICS:`);
    console.log(`    Disagreement: VWAP=${t.vwapDir}  CLOB=${t.clobDir}  → we bet ${t.vwapDir}`);
    console.log(`    Buy ${t.vwapDir} token at $${t.entry.toFixed(4)} (the cheap side)`);
    console.log(`    Resolution: ${t.res} → ${tag}`);
    console.log(`    PnL: ${t.pnl>=0?'+':''}$${t.pnl.toFixed(4)}`);
    console.log('');
    console.log('  Price trajectory (deltas from window open):');
    console.log('    Time    │  VWAP Δ     │ Dir │  CL Δ       │ Dir');
    console.log('    ────────┼─────────────┼─────┼─────────────┼────');
    for (const p of t.timeline) {
      console.log(`    ${p.label.padEnd(7)} │ ${(p.vwapD>=0?'+':'')+('$'+Math.round(p.vwapD)).padStart(6)} │ ${p.vDir}  │ ${(p.clD>=0?'+':'')+('$'+Math.round(p.clD)).padStart(6)} │ ${p.cDir}`);
    }
    console.log('');
  }

  // Summary
  console.log(`${'═'.repeat(80)}`);
  console.log('SUMMARY');
  console.log(`${'═'.repeat(80)}`);
  const W = trades.filter(t=>t.won), L = trades.filter(t=>!t.won);
  const totPnL = trades.reduce((s,t)=>s+t.pnl,0);
  console.log(`Trades: ${trades.length}  Wins: ${W.length} (${((W.length/trades.length)*100).toFixed(1)}%)  Losses: ${L.length}`);
  console.log(`Total PnL: +$${totPnL.toFixed(3)}  Avg/trade: +$${(totPnL/trades.length).toFixed(3)}`);
  console.log(`Avg win:  +$${(W.reduce((s,t)=>s+t.pnl,0)/W.length).toFixed(3)} (entry $${(W.reduce((s,t)=>s+t.entry,0)/W.length).toFixed(3)})`);
  console.log(`Avg loss: -$${(L.reduce((s,t)=>s+Math.abs(t.pnl),0)/L.length).toFixed(3)} (entry $${(L.reduce((s,t)=>s+t.entry,0)/L.length).toFixed(3)})`);
  console.log(`Win |CL|: avg $${(W.reduce((s,t)=>s+Math.abs(t.clDiff),0)/W.length).toFixed(0)}   Loss |CL|: avg $${(L.reduce((s,t)=>s+Math.abs(t.clDiff),0)/L.length).toFixed(0)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
