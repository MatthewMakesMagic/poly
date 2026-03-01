/**
 * Comprehensive Probability-Model (Black-Scholes Edge) Strategy Analysis
 *
 * Queries paper_trades_v2 and orders tables for all probability-model related data.
 * Runs multi-dimensional performance analytics.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function fmt(n, d=2) { return n == null ? 'N/A' : Number(n).toFixed(d); }
function pct(n, d=1) { return n == null ? 'N/A' : (Number(n)*100).toFixed(d) + '%'; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

async function run() {
  console.log('='.repeat(100));
  console.log('PROBABILITY-MODEL (BLACK-SCHOLES EDGE) STRATEGY — COMPREHENSIVE ANALYSIS');
  console.log('='.repeat(100));
  console.log('');

  // ===== PART 0: Schema Discovery =====
  console.log('--- PART 0: DATA DISCOVERY ---');

  // What signal_type values exist?
  const signalTypes = await pool.query(`
    SELECT signal_type, COUNT(*) as cnt,
           COUNT(*) FILTER (WHERE resolved_direction IS NOT NULL) as settled
    FROM paper_trades_v2
    GROUP BY signal_type
    ORDER BY cnt DESC
  `);
  console.log('\nSignal types in paper_trades_v2:');
  for (const r of signalTypes.rows) {
    console.log('  ' + pad(r.signal_type || 'null', 30) + ' total=' + pad(r.cnt, 8) + ' settled=' + r.settled);
  }

  // What strategy_metadata keys exist?
  const metaKeys = await pool.query(`
    SELECT DISTINCT jsonb_object_keys(strategy_metadata) as k
    FROM paper_trades_v2
    WHERE strategy_metadata IS NOT NULL
    LIMIT 50
  `);
  console.log('\nstrategy_metadata keys: ' + metaKeys.rows.map(r => r.k).join(', '));

  // Check strategy_metadata for probability-model related fields
  const metaSample = await pool.query(`
    SELECT strategy_metadata, signal_type, variant_label, sim_entry_price, entry_side, won, net_pnl
    FROM paper_trades_v2
    WHERE strategy_metadata IS NOT NULL
      AND resolved_direction IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\nSample metadata rows:');
  for (const r of metaSample.rows) {
    console.log('  signal_type=' + r.signal_type + ' variant=' + r.variant_label +
      ' entry=' + fmt(r.sim_entry_price,3) + ' side=' + r.entry_side + ' won=' + r.won +
      ' pnl=' + fmt(r.net_pnl) + ' meta=' + JSON.stringify(r.strategy_metadata));
  }

  // Check orders table for probability-model
  const orderStrategies = await pool.query(`
    SELECT strategy_id, COUNT(*) as cnt,
           COUNT(*) FILTER (WHERE status = 'filled') as filled,
           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
    FROM orders
    WHERE strategy_id IS NOT NULL
    GROUP BY strategy_id
    ORDER BY cnt DESC
  `);
  console.log('\nOrders by strategy_id:');
  for (const r of orderStrategies.rows) {
    console.log('  ' + pad(r.strategy_id || 'null', 25) + ' total=' + pad(r.cnt, 6) +
      ' filled=' + pad(r.filled, 6) + ' cancelled=' + r.cancelled);
  }

  // Check orders with probability-model
  const probOrders = await pool.query(`
    SELECT o.*,
           EXTRACT(EPOCH FROM o.submitted_at) as submitted_epoch
    FROM orders o
    WHERE o.strategy_id ILIKE '%prob%' OR o.strategy_id ILIKE '%model%'
       OR o.strategy_id ILIKE '%black%' OR o.strategy_id ILIKE '%edge%'
    ORDER BY o.submitted_at DESC
    LIMIT 20
  `);
  if (probOrders.rows.length > 0) {
    console.log('\nProbability-model orders (last 20):');
    for (const r of probOrders.rows) {
      console.log('  ' + r.order_id?.slice(0,12) + ' ' + r.strategy_id + ' ' + r.symbol +
        ' ' + r.side_token + ' status=' + r.status + ' price=' + fmt(r.price,3) +
        ' edge=' + fmt(r.original_edge,3) + ' prob=' + fmt(r.original_model_probability,3));
    }
  }

  // Sample all orders regardless of strategy
  const allOrders = await pool.query(`
    SELECT strategy_id, symbol, side_token, status, price, avg_fill_price,
           original_edge, original_model_probability, submitted_at
    FROM orders
    ORDER BY submitted_at DESC
    LIMIT 30
  `);
  console.log('\nLast 30 orders (all strategies):');
  for (const r of allOrders.rows) {
    console.log('  ' + (r.submitted_at?.toISOString()?.slice(0,19) || '?') +
      ' ' + pad(r.strategy_id || '?', 22) + ' ' + pad(r.symbol || '?', 5) +
      ' ' + pad(r.side_token || '?', 5) + ' ' + pad(r.status, 10) +
      ' p=' + fmt(r.price,3) + ' fill=' + fmt(r.avg_fill_price,3) +
      ' edge=' + fmt(r.original_edge,3) + ' prob=' + fmt(r.original_model_probability,3));
  }

  // ===== PART 1: ALL SETTLED TRADES FROM paper_trades_v2 =====
  console.log('\n' + '='.repeat(100));
  console.log('PART 1: ALL SETTLED PAPER TRADES');
  console.log('='.repeat(100));

  const allTrades = await pool.query(`
    SELECT *,
           EXTRACT(EPOCH FROM signal_time) as signal_epoch,
           EXTRACT(EPOCH FROM settlement_time) as settle_epoch,
           strategy_metadata->>'model_p_up' as model_p_up,
           strategy_metadata->>'edge' as bs_edge,
           strategy_metadata->>'sigma' as sigma,
           strategy_metadata->>'d2' as d2,
           strategy_metadata->>'model_side' as model_side,
           strategy_metadata->>'oracle_price' as oracle_price_meta,
           strategy_metadata->>'strike_price' as strike_price_meta,
           strategy_metadata->>'time_to_expiry_ms' as tte_ms
    FROM paper_trades_v2
    WHERE resolved_direction IS NOT NULL
    ORDER BY created_at
  `);

  console.log('Total settled trades: ' + allTrades.rows.length);

  if (allTrades.rows.length === 0) {
    console.log('No settled trades found. Exiting.');
    await pool.end();
    return;
  }

  // Date range
  const firstDate = allTrades.rows[0].created_at?.toISOString()?.slice(0,19);
  const lastDate = allTrades.rows[allTrades.rows.length-1].created_at?.toISOString()?.slice(0,19);
  console.log('Date range: ' + firstDate + ' to ' + lastDate);

  // Unique windows
  const windowIds = [...new Set(allTrades.rows.map(t => t.window_id))];
  console.log('Unique windows: ' + windowIds.length);

  // ===== ANALYSIS A: Overall Performance =====
  console.log('\n--- A. OVERALL PERFORMANCE ---');
  const wins = allTrades.rows.filter(t => t.won);
  const losses = allTrades.rows.filter(t => !t.won);
  const totalPnl = allTrades.rows.reduce((s, t) => s + (t.net_pnl ? parseFloat(t.net_pnl) : 0), 0);
  const avgPnl = totalPnl / allTrades.rows.length;

  // Median PnL
  const pnlValues = allTrades.rows.map(t => parseFloat(t.net_pnl || 0)).sort((a,b) => a-b);
  const medianPnl = pnlValues[Math.floor(pnlValues.length/2)];

  const avgWinPnl = wins.length > 0 ? wins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / wins.length : 0;
  const avgLossPnl = losses.length > 0 ? losses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / losses.length : 0;

  console.log('  Total trades:     ' + allTrades.rows.length);
  console.log('  Wins:             ' + wins.length + ' (' + (wins.length/allTrades.rows.length*100).toFixed(1) + '%)');
  console.log('  Losses:           ' + losses.length + ' (' + (losses.length/allTrades.rows.length*100).toFixed(1) + '%)');
  console.log('  Total PnL:        $' + totalPnl.toFixed(2));
  console.log('  Avg PnL/trade:    $' + avgPnl.toFixed(4));
  console.log('  Median PnL:       $' + medianPnl.toFixed(4));
  console.log('  Avg WIN PnL:      $' + avgWinPnl.toFixed(4));
  console.log('  Avg LOSS PnL:     $' + avgLossPnl.toFixed(4));
  console.log('  Win/Loss ratio:   ' + (avgWinPnl / Math.abs(avgLossPnl)).toFixed(2) + ':1');

  // ===== ANALYSIS B: By Symbol =====
  console.log('\n--- B. BY SYMBOL ---');
  const bySymbol = {};
  for (const t of allTrades.rows) {
    const k = t.symbol || 'unknown';
    if (!bySymbol[k]) bySymbol[k] = { wins: 0, total: 0, pnl: 0, entries: [], winPnls: [], lossPnls: [] };
    bySymbol[k].total++;
    const pnl = parseFloat(t.net_pnl || 0);
    bySymbol[k].pnl += pnl;
    bySymbol[k].entries.push(parseFloat(t.sim_entry_price || 0));
    if (t.won) { bySymbol[k].wins++; bySymbol[k].winPnls.push(pnl); }
    else { bySymbol[k].lossPnls.push(pnl); }
  }
  console.log('  ' + pad('Symbol', 8) + pad('N', 7) + pad('Wins', 7) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgPnL', 10) + pad('AvgEntry', 10) + pad('AvgWin', 10) + pad('AvgLoss', 10) + 'EV');
  for (const [k, v] of Object.entries(bySymbol).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const avgEntry = v.entries.reduce((s,e) => s+e, 0) / v.entries.length;
    const avgWin = v.winPnls.length > 0 ? v.winPnls.reduce((s,e) => s+e, 0) / v.winPnls.length : 0;
    const avgLoss = v.lossPnls.length > 0 ? v.lossPnls.reduce((s,e) => s+e, 0) / v.lossPnls.length : 0;
    const winRate = v.wins / v.total;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    console.log('  ' + pad(k, 8) + pad(v.total, 7) + pad(v.wins, 7) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+v.pnl.toFixed(2), 12) +
      pad('$'+ev.toFixed(4), 10) + pad('$'+avgEntry.toFixed(3), 10) +
      pad('$'+avgWin.toFixed(4), 10) + pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
  }

  // ===== ANALYSIS C: By Entry Price Bucket =====
  console.log('\n--- C. BY ENTRY PRICE BUCKET (CRITICAL) ---');
  const entryBuckets = [
    { label: '$0.00-0.10', min: 0, max: 0.10 },
    { label: '$0.10-0.20', min: 0.10, max: 0.20 },
    { label: '$0.20-0.30', min: 0.20, max: 0.30 },
    { label: '$0.30-0.40', min: 0.30, max: 0.40 },
    { label: '$0.40-0.50', min: 0.40, max: 0.50 },
    { label: '$0.50-0.60', min: 0.50, max: 0.60 },
    { label: '$0.60-0.70', min: 0.60, max: 0.70 },
    { label: '$0.70-0.80', min: 0.70, max: 0.80 },
    { label: '$0.80-0.95', min: 0.80, max: 0.95 },
    { label: '$0.95-1.00', min: 0.95, max: 1.00 },
  ];

  console.log('  ' + pad('Bucket', 14) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgWin$', 10) + pad('AvgLoss$', 10) + pad('TotalPnL', 12) + pad('EV/trade', 10) +
    pad('ROI%', 10) + 'MaxPayoff');

  for (const b of entryBuckets) {
    const bucket = allTrades.rows.filter(t => {
      const ep = parseFloat(t.sim_entry_price || 0);
      return ep >= b.min && ep < b.max;
    });
    if (bucket.length === 0) continue;

    const bWins = bucket.filter(t => t.won);
    const bLosses = bucket.filter(t => !t.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
    const avgEntry = bucket.reduce((s,t) => s + parseFloat(t.sim_entry_price||0), 0) / bucket.length;
    const roi = avgEntry > 0 ? (ev / avgEntry * 100) : 0;
    const maxPayoff = bWins.length > 0 ? Math.max(...bWins.map(t => parseFloat(t.net_pnl||0))) : 0;

    console.log('  ' + pad(b.label, 14) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgWin.toFixed(3), 10) +
      pad('$'+avgLoss.toFixed(3), 10) + pad('$'+totalPnlB.toFixed(2), 12) +
      pad('$'+ev.toFixed(4), 10) + pad(roi.toFixed(1)+'%', 10) + '$'+maxPayoff.toFixed(2));
  }

  // ===== ANALYSIS D: By Side (UP vs DOWN) =====
  console.log('\n--- D. BY SIDE (UP vs DOWN) ---');
  const bySide = {};
  for (const t of allTrades.rows) {
    const k = t.entry_side || 'unknown';
    if (!bySide[k]) bySide[k] = { wins: 0, total: 0, pnl: 0, entries: [], winPnls: [], lossPnls: [] };
    bySide[k].total++;
    const pnl = parseFloat(t.net_pnl || 0);
    bySide[k].pnl += pnl;
    bySide[k].entries.push(parseFloat(t.sim_entry_price || 0));
    if (t.won) { bySide[k].wins++; bySide[k].winPnls.push(pnl); }
    else { bySide[k].lossPnls.push(pnl); }
  }
  console.log('  ' + pad('Side', 8) + pad('N', 7) + pad('Wins', 7) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgEntry', 10) + pad('AvgWin', 10) + pad('AvgLoss', 10) + 'EV');
  for (const [k, v] of Object.entries(bySide)) {
    const avgEntry = v.entries.reduce((s,e) => s+e, 0) / v.entries.length;
    const avgWin = v.winPnls.length > 0 ? v.winPnls.reduce((s,e) => s+e, 0) / v.winPnls.length : 0;
    const avgLoss = v.lossPnls.length > 0 ? v.lossPnls.reduce((s,e) => s+e, 0) / v.lossPnls.length : 0;
    const winRate = v.wins / v.total;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    console.log('  ' + pad(k, 8) + pad(v.total, 7) + pad(v.wins, 7) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+v.pnl.toFixed(2), 12) +
      pad('$'+avgEntry.toFixed(3), 10) + pad('$'+avgWin.toFixed(4), 10) +
      pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
  }

  // ===== ANALYSIS E: Entry Price x Side Interaction =====
  console.log('\n--- E. ENTRY PRICE x SIDE INTERACTION ---');
  const priceSideBuckets = [
    { label: 'Cheap ($0-0.30)', min: 0, max: 0.30 },
    { label: 'Medium ($0.30-0.50)', min: 0.30, max: 0.50 },
    { label: 'Fair ($0.50-0.70)', min: 0.50, max: 0.70 },
    { label: 'Expensive ($0.70-1.0)', min: 0.70, max: 1.00 },
  ];

  console.log('  ' + pad('Price x Side', 35) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgWin$', 10) + pad('AvgLoss$', 10) + pad('EV', 10) + 'TotalPnL');

  for (const b of priceSideBuckets) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = allTrades.rows.filter(t => {
        const ep = parseFloat(t.sim_entry_price || 0);
        return ep >= b.min && ep < b.max && (t.entry_side || '').toUpperCase() === side;
      });
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      console.log('  ' + pad(b.label + ' ' + side, 35) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgWin.toFixed(3), 10) +
        pad('$'+avgLoss.toFixed(3), 10) + pad('$'+ev.toFixed(4), 10) + '$'+totalPnlB.toFixed(2));
    }
  }

  // ===== ANALYSIS F: Symbol x Side =====
  console.log('\n--- F. SYMBOL x SIDE ---');
  console.log('  ' + pad('Symbol x Side', 18) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV');
  const symbols = [...new Set(allTrades.rows.map(t => t.symbol))].sort();
  for (const sym of symbols) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = allTrades.rows.filter(t => t.symbol === sym && (t.entry_side||'').toUpperCase() === side);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      console.log('  ' + pad(sym + ' ' + side, 18) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
        pad('$'+avgWin.toFixed(4), 10) + pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
    }
  }

  // ===== ANALYSIS G: By CLOB Conviction =====
  console.log('\n--- G. BY CLOB CONVICTION (|clob_up_price - 0.50|) ---');
  const convBuckets = [
    { label: '0.00-0.05 (dead center)', min: 0, max: 0.05 },
    { label: '0.05-0.10 (near fair)', min: 0.05, max: 0.10 },
    { label: '0.10-0.15 (mild lean)', min: 0.10, max: 0.15 },
    { label: '0.15-0.20 (moderate)', min: 0.15, max: 0.20 },
    { label: '0.20-0.30 (leaning)', min: 0.20, max: 0.30 },
    { label: '0.30-0.40 (strong)', min: 0.30, max: 0.40 },
    { label: '0.40+ (decided)', min: 0.40, max: 1.0 },
  ];

  console.log('  ' + pad('Conviction', 30) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV');

  for (const b of convBuckets) {
    const bucket = allTrades.rows.filter(t => {
      const conv = Math.abs(parseFloat(t.clob_up_price || 0.5) - 0.5);
      return conv >= b.min && conv < b.max;
    });
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(t => t.won);
    const bLosses = bucket.filter(t => !t.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
    console.log('  ' + pad(b.label, 30) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
      pad('$'+avgWin.toFixed(4), 10) + pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
  }

  // ===== ANALYSIS H: By Signal Timing =====
  console.log('\n--- H. BY SIGNAL TIMING ---');
  const byTiming = {};
  for (const t of allTrades.rows) {
    const k = t.signal_offset_sec || 0;
    if (!byTiming[k]) byTiming[k] = { wins: 0, total: 0, pnl: 0, winPnls: [], lossPnls: [] };
    byTiming[k].total++;
    const pnl = parseFloat(t.net_pnl || 0);
    byTiming[k].pnl += pnl;
    if (t.won) { byTiming[k].wins++; byTiming[k].winPnls.push(pnl); }
    else { byTiming[k].lossPnls.push(pnl); }
  }
  console.log('  ' + pad('Timing', 10) + pad('N', 7) + pad('Wins', 7) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV');
  for (const [k, v] of Object.entries(byTiming).sort((a,b) => parseInt(b[0]) - parseInt(a[0]))) {
    const avgWin = v.winPnls.length > 0 ? v.winPnls.reduce((s,e) => s+e, 0) / v.winPnls.length : 0;
    const avgLoss = v.lossPnls.length > 0 ? v.lossPnls.reduce((s,e) => s+e, 0) / v.lossPnls.length : 0;
    const winRate = v.wins / v.total;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    console.log('  ' + pad('T-'+k+'s', 10) + pad(v.total, 7) + pad(v.wins, 7) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+v.pnl.toFixed(2), 12) +
      pad('$'+avgWin.toFixed(4), 10) + pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
  }

  // ===== ANALYSIS I: Big Winners =====
  console.log('\n--- I. BIG WINNERS (net_pnl > $1.00) ---');
  const bigWinners = allTrades.rows
    .filter(t => parseFloat(t.net_pnl || 0) > 1.0)
    .sort((a,b) => parseFloat(b.net_pnl) - parseFloat(a.net_pnl));

  console.log('  Count: ' + bigWinners.length + ' / ' + allTrades.rows.length + ' (' + (bigWinners.length/allTrades.rows.length*100).toFixed(1) + '%)');
  const bigWinTotal = bigWinners.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
  console.log('  Total PnL from big winners: $' + bigWinTotal.toFixed(2) + ' (' + (bigWinTotal/totalPnl*100).toFixed(1) + '% of all PnL)');

  console.log('\n  ' + pad('PnL', 10) + pad('Entry$', 8) + pad('Side', 6) + pad('Symbol', 8) +
    pad('T-sec', 6) + pad('CLOB_UP', 8) + pad('Variant', 16) + pad('VwapDelta', 12) + 'Window');
  for (const t of bigWinners.slice(0, 30)) {
    console.log('  ' + pad('$'+fmt(t.net_pnl), 10) + pad('$'+fmt(t.sim_entry_price,3), 8) +
      pad(t.entry_side || '?', 6) + pad(t.symbol || '?', 8) + pad(t.signal_offset_sec || '?', 6) +
      pad('$'+fmt(t.clob_up_price,3), 8) + pad(t.variant_label || '?', 16) +
      pad(fmt(t.vwap_delta,1), 12) + (t.window_id || '?'));
  }

  // Common patterns among big winners
  if (bigWinners.length > 0) {
    console.log('\n  Big winner patterns:');
    const bwSides = {};
    const bwSymbols = {};
    const bwTimings = {};
    for (const t of bigWinners) {
      const s = t.entry_side || '?'; bwSides[s] = (bwSides[s]||0) + 1;
      const sym = t.symbol || '?'; bwSymbols[sym] = (bwSymbols[sym]||0) + 1;
      const tm = t.signal_offset_sec || '?'; bwTimings[tm] = (bwTimings[tm]||0) + 1;
    }
    console.log('    Side: ' + JSON.stringify(bwSides));
    console.log('    Symbol: ' + JSON.stringify(bwSymbols));
    console.log('    Timing: ' + JSON.stringify(bwTimings));
    const avgBigEntry = bigWinners.reduce((s,t) => s + parseFloat(t.sim_entry_price||0), 0) / bigWinners.length;
    console.log('    Avg entry price: $' + avgBigEntry.toFixed(3));
    const avgBigClob = bigWinners.reduce((s,t) => s + Math.abs(parseFloat(t.clob_up_price||0.5) - 0.5), 0) / bigWinners.length;
    console.log('    Avg CLOB conviction: ' + avgBigClob.toFixed(3));
  }

  // ===== ANALYSIS J: Big Losers =====
  console.log('\n--- J. BIG LOSERS (net_pnl < -$1.50) ---');
  const bigLosers = allTrades.rows
    .filter(t => parseFloat(t.net_pnl || 0) < -1.50)
    .sort((a,b) => parseFloat(a.net_pnl) - parseFloat(b.net_pnl));

  console.log('  Count: ' + bigLosers.length + ' / ' + allTrades.rows.length);
  if (bigLosers.length > 0) {
    const bigLossTotal = bigLosers.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
    console.log('  Total PnL from big losers: $' + bigLossTotal.toFixed(2));

    console.log('\n  ' + pad('PnL', 10) + pad('Entry$', 8) + pad('Side', 6) + pad('Symbol', 8) +
      pad('T-sec', 6) + pad('CLOB_UP', 8) + pad('Variant', 16) + pad('VwapDelta', 12) + 'Window');
    for (const t of bigLosers.slice(0, 30)) {
      console.log('  ' + pad('$'+fmt(t.net_pnl), 10) + pad('$'+fmt(t.sim_entry_price,3), 8) +
        pad(t.entry_side || '?', 6) + pad(t.symbol || '?', 8) + pad(t.signal_offset_sec || '?', 6) +
        pad('$'+fmt(t.clob_up_price,3), 8) + pad(t.variant_label || '?', 16) +
        pad(fmt(t.vwap_delta,1), 12) + (t.window_id || '?'));
    }
  }

  // ===== ANALYSIS K: PnL Distribution =====
  console.log('\n--- K. PnL DISTRIBUTION ---');
  const pnlBuckets = [
    { label: '< -$3.00', min: -Infinity, max: -3 },
    { label: '-$3.00 to -$2.00', min: -3, max: -2 },
    { label: '-$2.00 to -$1.50', min: -2, max: -1.5 },
    { label: '-$1.50 to -$1.00', min: -1.5, max: -1 },
    { label: '-$1.00 to -$0.50', min: -1, max: -0.5 },
    { label: '-$0.50 to $0.00', min: -0.5, max: 0 },
    { label: '$0.00 to $0.50', min: 0, max: 0.5 },
    { label: '$0.50 to $1.00', min: 0.5, max: 1 },
    { label: '$1.00 to $2.00', min: 1, max: 2 },
    { label: '$2.00 to $5.00', min: 2, max: 5 },
    { label: '$5.00 to $10.00', min: 5, max: 10 },
    { label: '> $10.00', min: 10, max: Infinity },
  ];

  console.log('  ' + pad('PnL Range', 22) + pad('Count', 8) + pad('%', 8) + pad('CumPnL', 12) + 'Bar');
  for (const b of pnlBuckets) {
    const count = pnlValues.filter(p => p >= b.min && p < b.max).length;
    if (count === 0) continue;
    const cumPnl = pnlValues.filter(p => p >= b.min && p < b.max).reduce((s,p) => s+p, 0);
    const bar = '#'.repeat(Math.min(60, Math.round(count / allTrades.rows.length * 200)));
    console.log('  ' + pad(b.label, 22) + pad(count, 8) + pad((count/allTrades.rows.length*100).toFixed(1)+'%', 8) +
      pad('$'+cumPnl.toFixed(2), 12) + bar);
  }

  // Percentiles
  console.log('\n  Percentiles:');
  for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99]) {
    const idx = Math.floor(pnlValues.length * p / 100);
    console.log('    P' + p + ': $' + pnlValues[Math.min(idx, pnlValues.length-1)].toFixed(4));
  }

  // ===== ANALYSIS L: By VWAP Delta Magnitude =====
  console.log('\n--- L. BY VWAP DELTA MAGNITUDE ---');
  const vwapBuckets = [
    { label: '|delta| < 0.05%', min: 0, max: 0.0005 },
    { label: '0.05-0.08%', min: 0.0005, max: 0.0008 },
    { label: '0.08-0.12%', min: 0.0008, max: 0.0012 },
    { label: '0.12-0.20%', min: 0.0012, max: 0.002 },
    { label: '0.20%+', min: 0.002, max: Infinity },
  ];

  // First check what vwap_delta looks like
  const sampleDeltas = allTrades.rows.slice(0, 10).map(t => parseFloat(t.vwap_delta || 0));
  console.log('  Sample vwap_delta values: ' + sampleDeltas.join(', '));

  // vwap_delta might be in dollars or in percent - need to check
  const allDeltas = allTrades.rows.map(t => parseFloat(t.vwap_delta || 0)).filter(d => !isNaN(d));
  if (allDeltas.length > 0) {
    const deltaMin = Math.min(...allDeltas);
    const deltaMax = Math.max(...allDeltas);
    const deltaAvg = allDeltas.reduce((s,d) => s+d, 0) / allDeltas.length;
    console.log('  Delta range: ' + deltaMin.toFixed(4) + ' to ' + deltaMax.toFixed(4) + ' avg=' + deltaAvg.toFixed(4));

    // Auto-detect: if values > 1, they're probably dollar values
    const isDollar = Math.abs(deltaMax) > 1;
    console.log('  Detected delta unit: ' + (isDollar ? 'DOLLAR' : 'PERCENTAGE'));

    if (isDollar) {
      // Use dollar-based buckets
      const dollarBuckets = [
        { label: '|delta| < $25', min: 0, max: 25 },
        { label: '$25-$50', min: 25, max: 50 },
        { label: '$50-$75', min: 50, max: 75 },
        { label: '$75-$100', min: 75, max: 100 },
        { label: '$100-$200', min: 100, max: 200 },
        { label: '$200+', min: 200, max: Infinity },
      ];

      console.log('\n  ' + pad('Delta Bucket', 20) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
        pad('TotalPnL', 12) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV');

      for (const b of dollarBuckets) {
        const bucket = allTrades.rows.filter(t => {
          const d = Math.abs(parseFloat(t.vwap_delta || 0));
          return d >= b.min && d < b.max;
        });
        if (bucket.length === 0) continue;
        const bWins = bucket.filter(t => t.won);
        const bLosses = bucket.filter(t => !t.won);
        const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
        const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
        const winRate = bWins.length / bucket.length;
        const ev = winRate * avgWin + (1-winRate) * avgLoss;
        const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
        console.log('  ' + pad(b.label, 20) + pad(bucket.length, 6) + pad(bWins.length, 6) +
          pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
          pad('$'+avgWin.toFixed(4), 10) + pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
      }
    } else {
      // Use percentage-based buckets
      console.log('\n  ' + pad('Delta Bucket', 20) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
        pad('TotalPnL', 12) + 'EV');
      for (const b of vwapBuckets) {
        const bucket = allTrades.rows.filter(t => {
          const d = Math.abs(parseFloat(t.vwap_delta || 0));
          return d >= b.min && d < b.max;
        });
        if (bucket.length === 0) continue;
        const bWins = bucket.filter(t => t.won);
        const bLosses = bucket.filter(t => !t.won);
        const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
        const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
        const winRate = bWins.length / bucket.length;
        const ev = winRate * avgWin + (1-winRate) * avgLoss;
        const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
        console.log('  ' + pad(b.label, 20) + pad(bucket.length, 6) + pad(bWins.length, 6) +
          pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
      }
    }
  }

  // ===== ANALYSIS M: ROI for Cheap Entries =====
  console.log('\n--- M. RETURN ON INVESTMENT FOR CHEAP ENTRIES ($0.02-$0.30) ---');
  const cheapTrades = allTrades.rows.filter(t => {
    const ep = parseFloat(t.sim_entry_price || 0);
    return ep >= 0.02 && ep < 0.30;
  });

  if (cheapTrades.length > 0) {
    const cheapWins = cheapTrades.filter(t => t.won);
    const cheapLosses = cheapTrades.filter(t => !t.won);

    console.log('  Cheap entry trades: ' + cheapTrades.length);
    console.log('  Win rate: ' + (cheapWins.length/cheapTrades.length*100).toFixed(1) + '%');

    if (cheapWins.length > 0) {
      const winROIs = cheapWins.map(t => {
        const ep = parseFloat(t.sim_entry_price);
        const pnl = parseFloat(t.net_pnl);
        return { entry: ep, pnl, roi: (pnl/ep*100) };
      }).sort((a,b) => b.roi - a.roi);

      console.log('\n  Winning cheap entries (sorted by ROI):');
      console.log('  ' + pad('Entry$', 10) + pad('PnL$', 10) + pad('ROI%', 12) + pad('Side', 6) + pad('Symbol', 8) + 'Window');
      for (const w of winROIs.slice(0, 20)) {
        const t = cheapWins.find(t => parseFloat(t.sim_entry_price) === w.entry && parseFloat(t.net_pnl) === w.pnl);
        console.log('  ' + pad('$'+w.entry.toFixed(3), 10) + pad('$'+w.pnl.toFixed(3), 10) +
          pad(w.roi.toFixed(0) + '%', 12) + pad(t?.entry_side || '?', 6) + pad(t?.symbol || '?', 8) + (t?.window_id || '?'));
      }

      const avgWinROI = winROIs.reduce((s,w) => s+w.roi, 0) / winROIs.length;
      console.log('\n  Avg winning ROI: ' + avgWinROI.toFixed(0) + '%');
    }

    if (cheapLosses.length > 0) {
      console.log('  Avg losing entry: $' + (cheapLosses.reduce((s,t) => s+parseFloat(t.sim_entry_price||0), 0) / cheapLosses.length).toFixed(3));
      console.log('  Avg loss: $' + (cheapLosses.reduce((s,t) => s+parseFloat(t.net_pnl||0), 0) / cheapLosses.length).toFixed(3));
    }
  }

  // ===== ANALYSIS N: Expected Value by Key Dimensions =====
  console.log('\n--- N. EXPECTED VALUE SUMMARY (KEY METRIC) ---');
  console.log('  EV = (win_rate * avg_win) + (loss_rate * avg_loss)');
  console.log('  Positive EV = profitable strategy segment\n');

  // Collect EVs from all dimensions
  const evSummary = [];

  // By variant
  for (const t of allTrades.rows) {
    const k = t.variant_label || 'unknown';
    let entry = evSummary.find(e => e.dim === 'variant' && e.key === k);
    if (!entry) { entry = { dim: 'variant', key: k, wins: 0, total: 0, winPnls: [], lossPnls: [] }; evSummary.push(entry); }
    entry.total++;
    const pnl = parseFloat(t.net_pnl || 0);
    if (t.won) { entry.wins++; entry.winPnls.push(pnl); }
    else { entry.lossPnls.push(pnl); }
  }

  console.log('  ' + pad('Dimension', 12) + pad('Key', 25) + pad('N', 6) + pad('WinRate', 8) +
    pad('AvgWin$', 10) + pad('AvgLoss$', 10) + pad('EV/trade', 10) + pad('TotalEV', 10) + 'Grade');

  for (const entry of evSummary.sort((a,b) => {
    const evA = (a.wins/a.total) * (a.winPnls.length > 0 ? a.winPnls.reduce((s,p) => s+p,0)/a.winPnls.length : 0) +
                (1-a.wins/a.total) * (a.lossPnls.length > 0 ? a.lossPnls.reduce((s,p) => s+p,0)/a.lossPnls.length : 0);
    const evB = (b.wins/b.total) * (b.winPnls.length > 0 ? b.winPnls.reduce((s,p) => s+p,0)/b.winPnls.length : 0) +
                (1-b.wins/b.total) * (b.lossPnls.length > 0 ? b.lossPnls.reduce((s,p) => s+p,0)/b.lossPnls.length : 0);
    return evB - evA;
  })) {
    const winRate = entry.wins / entry.total;
    const avgWin = entry.winPnls.length > 0 ? entry.winPnls.reduce((s,p) => s+p,0) / entry.winPnls.length : 0;
    const avgLoss = entry.lossPnls.length > 0 ? entry.lossPnls.reduce((s,p) => s+p,0) / entry.lossPnls.length : 0;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalEv = ev * entry.total;
    const grade = ev > 0.10 ? 'A+' : ev > 0.05 ? 'A' : ev > 0.02 ? 'B' : ev > 0 ? 'C' : ev > -0.02 ? 'D' : 'F';
    console.log('  ' + pad(entry.dim, 12) + pad(entry.key, 25) + pad(entry.total, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgWin.toFixed(4), 10) +
      pad('$'+avgLoss.toFixed(4), 10) + pad('$'+ev.toFixed(4), 10) + pad('$'+totalEv.toFixed(2), 10) + grade);
  }

  // ===== ANALYSIS O: Symbol x Entry Price =====
  console.log('\n--- O. SYMBOL x ENTRY PRICE ---');
  const entryRanges = [
    { label: '$0-0.20', min: 0, max: 0.20 },
    { label: '$0.20-0.40', min: 0.20, max: 0.40 },
    { label: '$0.40-0.60', min: 0.40, max: 0.60 },
    { label: '$0.60-0.80', min: 0.60, max: 0.80 },
    { label: '$0.80+', min: 0.80, max: 1.00 },
  ];

  console.log('  ' + pad('Symbol x Entry', 22) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('EV', 10));

  for (const sym of symbols) {
    for (const b of entryRanges) {
      const bucket = allTrades.rows.filter(t => {
        const ep = parseFloat(t.sim_entry_price || 0);
        return t.symbol === sym && ep >= b.min && ep < b.max;
      });
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      console.log('  ' + pad(sym + ' ' + b.label, 22) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
    }
  }

  // ===== ANALYSIS P: Strategy Metadata (BS Edge, model_p_up, sigma) =====
  console.log('\n--- P. BLACK-SCHOLES MODEL METADATA ANALYSIS ---');
  const withMeta = allTrades.rows.filter(t => t.model_p_up || t.bs_edge);
  console.log('  Trades with BS metadata: ' + withMeta.length + ' / ' + allTrades.rows.length);

  if (withMeta.length > 0) {
    // By model edge bucket
    console.log('\n  BY MODEL EDGE SIZE:');
    const edgeBuckets = [
      { label: 'edge 0.00-0.10', min: 0, max: 0.10 },
      { label: 'edge 0.10-0.20', min: 0.10, max: 0.20 },
      { label: 'edge 0.20-0.30', min: 0.20, max: 0.30 },
      { label: 'edge 0.30-0.40', min: 0.30, max: 0.40 },
      { label: 'edge 0.40-0.50', min: 0.40, max: 0.50 },
      { label: 'edge 0.50+', min: 0.50, max: 1.0 },
    ];

    console.log('  ' + pad('Edge Bucket', 18) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
      pad('TotalPnL', 12) + pad('AvgEntry', 10) + 'EV');

    for (const b of edgeBuckets) {
      const bucket = withMeta.filter(t => {
        const e = Math.abs(parseFloat(t.bs_edge || 0));
        return e >= b.min && e < b.max;
      });
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      const avgEntry = bucket.reduce((s,t) => s + parseFloat(t.sim_entry_price||0), 0) / bucket.length;
      console.log('  ' + pad(b.label, 18) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
        pad('$'+avgEntry.toFixed(3), 10) + '$'+ev.toFixed(4));
    }

    // By model_p_up
    console.log('\n  BY MODEL P(UP):');
    const pupBuckets = [
      { label: 'p_up 0.00-0.20', min: 0, max: 0.20 },
      { label: 'p_up 0.20-0.40', min: 0.20, max: 0.40 },
      { label: 'p_up 0.40-0.60', min: 0.40, max: 0.60 },
      { label: 'p_up 0.60-0.80', min: 0.60, max: 0.80 },
      { label: 'p_up 0.80-1.00', min: 0.80, max: 1.00 },
    ];

    console.log('  ' + pad('P(UP) Bucket', 18) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
      pad('TotalPnL', 12) + pad('AvgEdge', 10) + 'EV');

    for (const b of pupBuckets) {
      const bucket = withMeta.filter(t => {
        const p = parseFloat(t.model_p_up || 0.5);
        return p >= b.min && p < b.max;
      });
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      const avgEdge = bucket.reduce((s,t) => s + Math.abs(parseFloat(t.bs_edge||0)), 0) / bucket.length;
      console.log('  ' + pad(b.label, 18) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
        pad(avgEdge.toFixed(3), 10) + '$'+ev.toFixed(4));
    }
  }

  // ===== ANALYSIS Q: Variant (strategy combination) breakdown =====
  console.log('\n--- Q. BY VARIANT LABEL ---');
  const byVariant = {};
  for (const t of allTrades.rows) {
    const k = t.variant_label || 'unknown';
    if (!byVariant[k]) byVariant[k] = { wins: 0, total: 0, pnl: 0, winPnls: [], lossPnls: [], entries: [] };
    byVariant[k].total++;
    const pnl = parseFloat(t.net_pnl || 0);
    byVariant[k].pnl += pnl;
    byVariant[k].entries.push(parseFloat(t.sim_entry_price || 0));
    if (t.won) { byVariant[k].wins++; byVariant[k].winPnls.push(pnl); }
    else { byVariant[k].lossPnls.push(pnl); }
  }

  console.log('  ' + pad('Variant', 20) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgEntry', 10) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV');

  for (const [k, v] of Object.entries(byVariant).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const avgEntry = v.entries.reduce((s,e) => s+e, 0) / v.entries.length;
    const avgWin = v.winPnls.length > 0 ? v.winPnls.reduce((s,e) => s+e, 0) / v.winPnls.length : 0;
    const avgLoss = v.lossPnls.length > 0 ? v.lossPnls.reduce((s,e) => s+e, 0) / v.lossPnls.length : 0;
    const winRate = v.wins / v.total;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    console.log('  ' + pad(k, 20) + pad(v.total, 6) + pad(v.wins, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+v.pnl.toFixed(2), 12) +
      pad('$'+avgEntry.toFixed(3), 10) + pad('$'+avgWin.toFixed(4), 10) +
      pad('$'+avgLoss.toFixed(4), 10) + '$'+ev.toFixed(4));
  }

  // ===== ANALYSIS R: Timing x Side =====
  console.log('\n--- R. TIMING x SIDE ---');
  console.log('  ' + pad('Timing x Side', 18) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + 'EV');

  const timings = [...new Set(allTrades.rows.map(t => t.signal_offset_sec || 0))].sort((a,b) => b-a);
  for (const tm of timings) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = allTrades.rows.filter(t =>
        (t.signal_offset_sec || 0) == tm && (t.entry_side || '').toUpperCase() === side);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(t => t.won);
      const bLosses = bucket.filter(t => !t.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,t) => s + parseFloat(t.net_pnl||0), 0);
      console.log('  ' + pad('T-'+tm+'s '+side, 18) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
    }
  }

  // ===== ANALYSIS S: Live Orders Analysis =====
  console.log('\n--- S. LIVE ORDERS ANALYSIS ---');
  const liveOrders = await pool.query(`
    SELECT o.*,
           EXTRACT(EPOCH FROM o.submitted_at) as submitted_epoch
    FROM orders o
    ORDER BY o.submitted_at DESC
    LIMIT 200
  `);

  if (liveOrders.rows.length > 0) {
    console.log('  Total orders (last 200): ' + liveOrders.rows.length);

    // By strategy
    const ordersByStrat = {};
    for (const o of liveOrders.rows) {
      const k = o.strategy_id || 'unknown';
      if (!ordersByStrat[k]) ordersByStrat[k] = { total: 0, filled: 0, cancelled: 0, rejected: 0, edges: [], probs: [] };
      ordersByStrat[k].total++;
      if (o.status === 'filled') ordersByStrat[k].filled++;
      if (o.status === 'cancelled') ordersByStrat[k].cancelled++;
      if (o.status === 'rejected') ordersByStrat[k].rejected++;
      if (o.original_edge) ordersByStrat[k].edges.push(parseFloat(o.original_edge));
      if (o.original_model_probability) ordersByStrat[k].probs.push(parseFloat(o.original_model_probability));
    }

    for (const [k, v] of Object.entries(ordersByStrat)) {
      console.log('  Strategy: ' + k);
      console.log('    Total: ' + v.total + ' | Filled: ' + v.filled + ' | Cancelled: ' + v.cancelled + ' | Rejected: ' + v.rejected);
      if (v.edges.length > 0) {
        const avgEdge = v.edges.reduce((s,e) => s+e, 0) / v.edges.length;
        console.log('    Avg edge: ' + avgEdge.toFixed(4) + ' | Edge range: ' +
          Math.min(...v.edges).toFixed(4) + ' to ' + Math.max(...v.edges).toFixed(4));
      }
      if (v.probs.length > 0) {
        const avgProb = v.probs.reduce((s,e) => s+e, 0) / v.probs.length;
        console.log('    Avg model prob: ' + avgProb.toFixed(4));
      }
    }

    // Filled orders with edge/probability
    const filledWithEdge = liveOrders.rows.filter(o => o.status === 'filled' && o.original_edge);
    if (filledWithEdge.length > 0) {
      console.log('\n  Filled orders with edge data: ' + filledWithEdge.length);
      console.log('  ' + pad('Symbol', 6) + pad('Side', 6) + pad('Price', 8) + pad('FillPx', 8) +
        pad('Edge', 8) + pad('Prob', 8) + pad('Strategy', 20) + 'Time');
      for (const o of filledWithEdge.slice(0, 30)) {
        console.log('  ' + pad(o.symbol || '?', 6) + pad(o.side_token || '?', 6) +
          pad('$'+fmt(o.price,3), 8) + pad('$'+fmt(o.avg_fill_price,3), 8) +
          pad(fmt(o.original_edge,3), 8) + pad(fmt(o.original_model_probability,3), 8) +
          pad(o.strategy_id || '?', 20) + (o.submitted_at?.toISOString()?.slice(0,19) || '?'));
      }
    }
  }

  // ===== ANALYSIS T: Paper trades with live_order_status =====
  console.log('\n--- T. PAPER TRADES WITH LIVE ORDER STATUS ---');
  const livePaper = await pool.query(`
    SELECT live_order_status, COUNT(*) as cnt,
           COUNT(*) FILTER (WHERE won = true) as wins,
           SUM(net_pnl::numeric) as total_pnl
    FROM paper_trades_v2
    WHERE resolved_direction IS NOT NULL
    GROUP BY live_order_status
    ORDER BY cnt DESC
  `);
  for (const r of livePaper.rows) {
    console.log('  ' + pad(r.live_order_status || 'null', 15) + ' count=' + pad(r.cnt, 8) +
      ' wins=' + pad(r.wins, 6) + ' PnL=$' + fmt(r.total_pnl));
  }

  // ===== ANALYSIS U: Window Close Events Match =====
  console.log('\n--- U. WINDOW CLOSE EVENTS MATCH ---');
  const wceCount = await pool.query(`
    SELECT COUNT(*) as cnt,
           COUNT(*) FILTER (WHERE resolved_direction IS NOT NULL) as resolved,
           COUNT(*) FILTER (WHERE onchain_resolved_direction IS NOT NULL) as onchain
    FROM window_close_events
  `);
  console.log('  Total WCE: ' + wceCount.rows[0].cnt +
    ' | Resolved: ' + wceCount.rows[0].resolved +
    ' | On-chain: ' + wceCount.rows[0].onchain);

  // ===== FINAL SUMMARY =====
  console.log('\n' + '='.repeat(100));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(100));
  console.log('');
  console.log('Total settled trades: ' + allTrades.rows.length);
  console.log('Win rate: ' + (wins.length/allTrades.rows.length*100).toFixed(1) + '%');
  console.log('Total PnL: $' + totalPnl.toFixed(2));
  console.log('EV per trade: $' + avgPnl.toFixed(4));
  console.log('Win/Loss ratio: ' + (avgWinPnl / Math.abs(avgLossPnl)).toFixed(2) + ':1');
  console.log('Median PnL: $' + medianPnl.toFixed(4));
  console.log('');

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
