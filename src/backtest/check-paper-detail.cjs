const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const r = await pool.query(`
    SELECT variant_label, vwap_delta_threshold, signal_offset_sec,
           entry_side, sim_entry_price, vwap_delta, won, net_pnl,
           position_size_dollars, clob_up_price, resolved_direction, window_id
    FROM paper_trades_v2
    WHERE symbol = 'btc' AND resolved_direction IS NOT NULL
    ORDER BY created_at DESC LIMIT 400
  `);

  // Group by timing + variant
  const grid = {};
  for (const t of r.rows) {
    const timing = t.signal_offset_sec + 's';
    const label = t.variant_label;
    const k = timing + '|' + label;
    if (!grid[k]) {
      grid[k] = {
        timing, label,
        thresh: parseFloat(t.vwap_delta_threshold),
        size: parseFloat(t.position_size_dollars),
        wins: 0, total: 0, pnl: 0,
        entries: [], deltas: [],
        upCount: 0, downCount: 0
      };
    }
    grid[k].total++;
    if (t.won) grid[k].wins++;
    grid[k].pnl += t.net_pnl ? parseFloat(t.net_pnl) : 0;
    grid[k].entries.push(parseFloat(t.sim_entry_price));
    grid[k].deltas.push(Math.abs(parseFloat(t.vwap_delta)));
    if (t.entry_side === 'up') grid[k].upCount++;
    else grid[k].downCount++;
  }

  console.log('PAPER TRADER — FULL VARIATION GRID (last 400 settled trades, 14 windows)');
  console.log();
  console.log('Timing   Label         Thresh  $Size  Trades Wins  Rate     PnL         AvgEntry AvgDelta   UP/DN');
  console.log('-'.repeat(110));

  const sorted = Object.values(grid).sort((a, b) => {
    if (parseInt(a.timing) !== parseInt(b.timing)) return parseInt(a.timing) - parseInt(b.timing);
    return a.thresh - b.thresh || a.size - b.size;
  });

  for (const g of sorted) {
    const avgEntry = g.entries.reduce((s, e) => s + e, 0) / g.entries.length;
    const avgDelta = g.deltas.reduce((s, e) => s + e, 0) / g.deltas.length;
    const marker = g.pnl > 0 ? ' +' : '';
    console.log(
      ('T-' + g.timing).padEnd(9) +
      g.label.padEnd(14) +
      ('$' + g.thresh).padEnd(8) +
      ('$' + g.size).padEnd(7) +
      String(g.total).padEnd(7) +
      String(g.wins).padEnd(6) +
      ((g.wins / g.total * 100).toFixed(0) + '%').padEnd(9) +
      ('$' + g.pnl.toFixed(0)).padStart(7).padEnd(12) +
      ('$' + avgEntry.toFixed(3)).padEnd(9) +
      ('$' + avgDelta.toFixed(0)).padEnd(11) +
      g.upCount + 'up/' + g.downCount + 'dn' + marker
    );
  }

  // T-120s inverse analysis
  console.log('\n\nT-120s INVERSE — what if we bet WITH CLOB when VWAP disagrees?');
  const t120 = r.rows.filter(t => t.signal_offset_sec === 120);
  // Deduplicate by window (just need one trade per window to know direction/resolution)
  const seen = new Set();
  const windows120 = [];
  for (const t of t120) {
    if (seen.has(t.window_id)) continue;
    seen.add(t.window_id);
    windows120.push(t);
  }

  let invWins = 0, invPnl = 0;
  console.log('  Window                     CLOB@120  ClobDir  Resolved  InvEntry  InvResult  InvPnL');
  for (const t of windows120) {
    const clobUp = parseFloat(t.clob_up_price);
    const clobDir = clobUp >= 0.5 ? 'up' : 'down';
    const clobRight = clobDir === t.resolved_direction;
    const entryPrice = clobDir === 'up' ? clobUp : (1 - clobUp);
    let pnl;
    if (clobRight) { invWins++; pnl = 1 - entryPrice; }
    else { pnl = -entryPrice; }
    invPnl += pnl;
    console.log('  ' + t.window_id.padEnd(27) +
      ('$' + clobUp.toFixed(3)).padEnd(10) +
      clobDir.padEnd(9) +
      t.resolved_direction.padEnd(10) +
      ('$' + entryPrice.toFixed(3)).padEnd(10) +
      (clobRight ? 'WIN' : 'LOSS').padEnd(11) +
      (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(3));
  }
  console.log('\n  Inverse total: ' + invWins + '/' + windows120.length +
    ' (' + (invWins / windows120.length * 100).toFixed(1) + '%) PnL: $' + invPnl.toFixed(3) +
    ' avg: $' + (invPnl / windows120.length).toFixed(3) + '/trade');

  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
