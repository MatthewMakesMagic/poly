const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const trades = await pool.query(`
    SELECT window_id, symbol, variant_label, signal_offset_sec,
           entry_side, sim_entry_price, vwap_delta,
           vwap_direction, clob_direction, won, net_pnl, gross_pnl,
           position_size_dollars, vwap_delta_threshold, created_at,
           resolved_direction, clob_up_price, vwap_price, chainlink_price
    FROM paper_trades_v2
    WHERE symbol = 'btc'
      AND resolved_direction IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 400
  `);

  if (trades.rows.length === 0) {
    console.log('No settled paper trades found.');
    await pool.end();
    return;
  }

  const windowIds = [...new Set(trades.rows.map(t => t.window_id))];
  console.log('Recent settled BTC paper trades: ' + trades.rows.length + ' across ' + windowIds.length + ' windows');
  console.log('Period: ' + trades.rows[trades.rows.length-1].created_at?.toISOString().slice(0,19) +
    ' to ' + trades.rows[0].created_at?.toISOString().slice(0,19));

  const wins = trades.rows.filter(t => t.won).length;
  const totalPnl = trades.rows.reduce((s, t) => s + (t.net_pnl ? parseFloat(t.net_pnl) : 0), 0);
  console.log('\nOverall: ' + wins + '/' + trades.rows.length + ' (' +
    (wins/trades.rows.length*100).toFixed(1) + '%) PnL: $' + totalPnl.toFixed(2));

  // By variation
  console.log('\n--- BY VARIATION ---');
  const byVar = {};
  for (const t of trades.rows) {
    const k = t.variant_label || 'unknown';
    if (!byVar[k]) byVar[k] = { wins: 0, total: 0, pnl: 0 };
    byVar[k].total++;
    if (t.won) byVar[k].wins++;
    byVar[k].pnl += t.net_pnl ? parseFloat(t.net_pnl) : 0;
  }
  console.log('  ' + 'Variation'.padEnd(14) + 'Trades'.padEnd(8) + 'Wins'.padEnd(6) + 'Rate'.padEnd(8) + 'PnL');
  for (const [k, v] of Object.entries(byVar).sort((a,b) => b[1].pnl - a[1].pnl)) {
    console.log('  ' + k.padEnd(14) + String(v.total).padEnd(8) + String(v.wins).padEnd(6) +
      (v.wins/v.total*100).toFixed(1).padStart(5) + '%  $' + v.pnl.toFixed(2));
  }

  // By signal offset
  console.log('\n--- BY SIGNAL TIME ---');
  const byTime = {};
  for (const t of trades.rows) {
    const k = t.signal_offset_sec + 's';
    if (!byTime[k]) byTime[k] = { wins: 0, total: 0, pnl: 0 };
    byTime[k].total++;
    if (t.won) byTime[k].wins++;
    byTime[k].pnl += t.net_pnl ? parseFloat(t.net_pnl) : 0;
  }
  console.log('  ' + 'Timing'.padEnd(12) + 'Trades'.padEnd(8) + 'Wins'.padEnd(6) + 'Rate'.padEnd(8) + 'PnL');
  for (const [k, v] of Object.entries(byTime).sort((a,b) => parseInt(a) - parseInt(b))) {
    console.log('  ' + ('T-'+k).padEnd(12) + String(v.total).padEnd(8) + String(v.wins).padEnd(6) +
      (v.wins/v.total*100).toFixed(1).padStart(5) + '%  $' + v.pnl.toFixed(2));
  }

  // By entry side
  console.log('\n--- BY ENTRY SIDE ---');
  const bySide = {};
  for (const t of trades.rows) {
    const k = t.entry_side || 'unknown';
    if (!bySide[k]) bySide[k] = { wins: 0, total: 0, pnl: 0 };
    bySide[k].total++;
    if (t.won) bySide[k].wins++;
    bySide[k].pnl += t.net_pnl ? parseFloat(t.net_pnl) : 0;
  }
  for (const [k, v] of Object.entries(bySide)) {
    console.log('  ' + k.padEnd(8) + String(v.total).padEnd(8) + String(v.wins).padEnd(6) +
      (v.wins/v.total*100).toFixed(1) + '%  PnL: $' + v.pnl.toFixed(2));
  }

  // Last 20 windows with trade detail
  console.log('\n--- LAST 20 WINDOWS (most recent first) ---');
  const recentWindows = windowIds.slice(0, 20);
  for (const wid of recentWindows) {
    const wTrades = trades.rows.filter(t => t.window_id === wid);
    const wWins = wTrades.filter(t => t.won).length;
    const wPnl = wTrades.reduce((s, t) => s + (t.net_pnl ? parseFloat(t.net_pnl) : 0), 0);
    const sides = [...new Set(wTrades.map(t => t.entry_side))].join('/');
    const timings = [...new Set(wTrades.map(t => t.signal_offset_sec))].sort((a,b) => b-a).map(s => s+'s').join(',');
    const sample = wTrades[0];
    const vd = sample.vwap_delta ? '$' + parseFloat(sample.vwap_delta).toFixed(1) : '?';
    const ep = sample.sim_entry_price ? '$' + parseFloat(sample.sim_entry_price).toFixed(3) : '?';
    const res = sample.resolved_direction || '?';
    console.log('  ' + wid.padEnd(26) + ' ' + wWins + '/' + wTrades.length + ' wins' +
      '  PnL:' + ('$' + wPnl.toFixed(2)).padStart(9) +
      '  side=' + sides.padEnd(6) +
      '  res=' + res.padEnd(5) +
      '  vwap_d=' + vd.padEnd(10) +
      '  entry=' + ep +
      '  @' + timings);
  }

  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
