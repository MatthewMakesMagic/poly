/**
 * Probability-Model LIVE Orders Analysis
 *
 * Analyzes the actual probability-model strategy orders from the orders table,
 * cross-referenced with window_close_events for resolution data.
 * Also analyzes paper_trades_v2 through the lens of the BS model parameters.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function fmt(n, d=2) { return n == null ? 'N/A' : Number(n).toFixed(d); }
function pad(s, w) { return String(s).padEnd(w); }

async function run() {
  console.log('='.repeat(100));
  console.log('PROBABILITY-MODEL (BLACK-SCHOLES) — LIVE ORDERS DEEP ANALYSIS');
  console.log('='.repeat(100));

  // ===== 1. All live orders =====
  console.log('\n--- 1. ALL PROBABILITY-MODEL LIVE ORDERS ---');
  const orders = await pool.query(`
    SELECT o.*,
           o.submitted_at AT TIME ZONE 'America/New_York' as submitted_et
    FROM orders o
    WHERE o.strategy_id = 'probability-model'
    ORDER BY o.submitted_at
  `);

  console.log('Total probability-model orders: ' + orders.rows.length);

  for (const o of orders.rows) {
    const fillInfo = o.status === 'filled' ? ' FILLED@' + fmt(o.avg_fill_price,3) : ' STATUS=' + o.status;
    console.log('  ' + (o.submitted_at?.toISOString()?.slice(0,19) || '?') +
      ' ' + pad(o.symbol || '?', 5) + pad(o.side_token || '?', 6) +
      ' price=$' + fmt(o.price,3) + fillInfo +
      ' edge=' + fmt(o.original_edge,4) + ' prob=' + fmt(o.original_model_probability,4) +
      ' window=' + (o.window_id || '?'));
  }

  // ===== 2. Match orders to window close events =====
  console.log('\n--- 2. ORDER OUTCOMES (from window_close_events) ---');
  for (const o of orders.rows) {
    if (!o.window_id) continue;
    const wce = await pool.query(`
      SELECT resolved_direction, onchain_resolved_direction, strike_price,
             oracle_price_at_close, oracle_price_at_open,
             market_up_price_60s, market_up_price_30s, market_up_price_10s,
             market_up_price_1s
      FROM window_close_events
      WHERE window_id = $1
      LIMIT 1
    `, [o.window_id]);

    if (wce.rows.length > 0) {
      const w = wce.rows[0];
      const resolution = w.onchain_resolved_direction || w.resolved_direction || '?';
      const sideToken = o.side_token || '?';
      const won = (sideToken === 'UP' && resolution.toUpperCase() === 'UP') ||
                  (sideToken === 'DOWN' && resolution.toUpperCase() === 'DOWN');
      const entryPrice = parseFloat(o.avg_fill_price || o.price || 0);
      const pnl = won ? (1 - entryPrice) * parseFloat(o.size || 0) : -entryPrice * parseFloat(o.size || 0);
      const pnlPct = won ? ((1 - entryPrice) / entryPrice * 100) : -100;

      console.log('  Window: ' + o.window_id);
      console.log('    Order: ' + o.symbol + ' ' + sideToken + ' @ $' + fmt(entryPrice,3) +
        ' | Status: ' + o.status + ' | Edge: ' + fmt(o.original_edge,4) + ' | Prob: ' + fmt(o.original_model_probability,4));
      console.log('    Resolution: ' + resolution +
        ' | Oracle open: $' + fmt(w.oracle_price_at_open) + ' close: $' + fmt(w.oracle_price_at_close) +
        ' | Strike: $' + fmt(w.strike_price));
      console.log('    RESULT: ' + (o.status === 'filled' ? (won ? 'WIN' : 'LOSS') : 'NOT FILLED ('+o.status+')') +
        (o.status === 'filled' ? ' | PnL: $' + fmt(pnl) + ' (' + fmt(pnlPct,0) + '%)' : ''));
      console.log('    CLOB prices: T-60=$' + fmt(w.market_up_price_60s,3) +
        ' T-30=$' + fmt(w.market_up_price_30s,3) + ' T-10=$' + fmt(w.market_up_price_10s,3) +
        ' T-1=$' + fmt(w.market_up_price_1s,3));
      console.log('');
    } else {
      console.log('  Window: ' + o.window_id + ' — No WCE found (window may not have closed yet)');
    }
  }

  // ===== 3. Simulate the probability-model on historical data =====
  console.log('\n--- 3. SIMULATED PROBABILITY-MODEL ON HISTORICAL WINDOWS ---');
  console.log('Using window_close_events to simulate BS model edge decisions\n');

  // Get all resolved windows with good data
  const windows = await pool.query(`
    SELECT w.*,
           w.created_at AT TIME ZONE 'America/New_York' as created_et,
           EXTRACT(EPOCH FROM w.created_at) as epoch
    FROM window_close_events w
    WHERE w.resolved_direction IS NOT NULL
      AND w.oracle_price_at_open IS NOT NULL
      AND w.oracle_price_at_close IS NOT NULL
      AND w.strike_price IS NOT NULL
      AND w.market_up_price_60s IS NOT NULL
    ORDER BY w.created_at
  `);

  console.log('Windows with complete data: ' + windows.rows.length);

  // Simulate Black-Scholes N(d2) for each window
  // Using the same formula as window-timing-model.js
  function normalCDF(x) {
    if (x === Infinity) return 1.0;
    if (x === -Infinity) return 0.0;
    const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-absX * absX);
    return 0.5 * (1.0 + sign * y);
  }

  function calculateBS(S, K, T_ms, sigma) {
    const T = T_ms / (365.25 * 24 * 60 * 60 * 1000);
    if (T <= 0 || sigma <= 0) {
      return S > K ? 1.0 : (S < K ? 0.0 : 0.5);
    }
    const sqrtT = Math.sqrt(T);
    const d2 = (Math.log(S / K) + (-sigma * sigma / 2) * T) / (sigma * sqrtT);
    return normalCDF(d2);
  }

  const sigma = 0.5; // Default fallback volatility from the model
  const results = [];

  // For each window, calculate at various time offsets using oracle prices
  for (const w of windows.rows) {
    const oracleOpen = parseFloat(w.oracle_price_at_open);
    const oracleClose = parseFloat(w.oracle_price_at_close);
    const strike = parseFloat(w.strike_price);
    const resolution = (w.onchain_resolved_direction || w.resolved_direction || '').toUpperCase();

    if (!resolution || !oracleOpen || !strike) continue;

    // Use oracle prices at different offsets
    // oracle_price_60s_before is available
    const oracleT60 = parseFloat(w.oracle_price_60s_before || w.oracle_price_at_close);
    const oracleT30 = parseFloat(w.oracle_price_30s_before || w.oracle_price_at_close);

    // Market (CLOB) prices
    const clobUp60 = parseFloat(w.market_up_price_60s || 0.5);
    const clobUp30 = parseFloat(w.market_up_price_30s || 0.5);
    const clobUp10 = parseFloat(w.market_up_price_10s || 0.5);

    // Calculate BS probability at T-60s
    const p_up_60 = calculateBS(oracleT60, strike, 60000, sigma);
    const edge_up_60 = p_up_60 - clobUp60;
    const edge_down_60 = -edge_up_60; // (1-p_up) - (1-clobUp) = clobUp - p_up

    // Determine which side to bet
    let entrySide = null;
    let edge = 0;
    let entryPrice = 0;

    if (edge_up_60 >= 0.10 && edge_up_60 <= 0.50) {
      entrySide = 'UP';
      edge = edge_up_60;
      entryPrice = clobUp60;
    } else if (edge_down_60 >= 0.10 && edge_down_60 <= 0.50) {
      entrySide = 'DOWN';
      edge = edge_down_60;
      entryPrice = 1 - clobUp60;
    }

    if (entrySide) {
      const won = entrySide === resolution;
      const posSize = 2; // $2 position
      const shares = posSize / entryPrice;
      const pnl = won ? shares * (1 - entryPrice) : -posSize;
      const roi = won ? ((1 - entryPrice) / entryPrice * 100) : -100;

      results.push({
        windowId: w.window_id,
        symbol: w.symbol || (w.window_id || '').split('-')[0],
        entrySide,
        edge: edge,
        entryPrice,
        p_up: p_up_60,
        clobUp: clobUp60,
        oraclePrice: oracleT60,
        strike,
        resolution,
        won,
        pnl,
        roi,
        shares,
        posSize,
        time: w.created_at,
        oracleOpen,
        oracleClose,
        oracleMove: oracleClose - oracleOpen,
        conviction: Math.abs(clobUp60 - 0.5),
      });
    }
  }

  console.log('Simulated trades (edge 0.10-0.50 at T-60): ' + results.length);
  if (results.length === 0) {
    console.log('No simulated trades matched criteria.');
    await pool.end();
    return;
  }

  // ===== 4. Overall Performance =====
  console.log('\n--- 4. SIMULATED OVERALL PERFORMANCE ---');
  const wins = results.filter(r => r.won);
  const losses = results.filter(r => !r.won);
  const totalPnl = results.reduce((s,r) => s + r.pnl, 0);
  const avgPnl = totalPnl / results.length;
  const avgWinPnl = wins.length > 0 ? wins.reduce((s,r) => s+r.pnl, 0) / wins.length : 0;
  const avgLossPnl = losses.length > 0 ? losses.reduce((s,r) => s+r.pnl, 0) / losses.length : 0;

  console.log('  Total trades:     ' + results.length);
  console.log('  Wins:             ' + wins.length + ' (' + (wins.length/results.length*100).toFixed(1) + '%)');
  console.log('  Losses:           ' + losses.length);
  console.log('  Total PnL:        $' + totalPnl.toFixed(2));
  console.log('  Avg PnL/trade:    $' + avgPnl.toFixed(4));
  console.log('  Avg WIN PnL:      $' + avgWinPnl.toFixed(4) + ' (' + (wins.length > 0 ? (avgWinPnl/2*100).toFixed(0) : '?') + '% ROI)');
  console.log('  Avg LOSS PnL:     $' + avgLossPnl.toFixed(4));
  console.log('  Win/Loss ratio:   ' + (wins.length > 0 ? (avgWinPnl / Math.abs(avgLossPnl)).toFixed(2) : 'N/A') + ':1');

  // ===== 5. By Symbol =====
  console.log('\n--- 5. BY SYMBOL ---');
  const bySymbol = {};
  for (const r of results) {
    const k = r.symbol;
    if (!bySymbol[k]) bySymbol[k] = { wins: 0, total: 0, pnl: 0, winPnls: [], lossPnls: [], entries: [] };
    bySymbol[k].total++;
    bySymbol[k].pnl += r.pnl;
    bySymbol[k].entries.push(r.entryPrice);
    if (r.won) { bySymbol[k].wins++; bySymbol[k].winPnls.push(r.pnl); }
    else { bySymbol[k].lossPnls.push(r.pnl); }
  }

  console.log('  ' + pad('Symbol', 8) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('AvgEntry', 10) + pad('AvgWin$', 10) + pad('AvgLoss$', 10) + 'EV/trade');

  for (const [k, v] of Object.entries(bySymbol).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const avgEntry = v.entries.reduce((s,e) => s+e, 0) / v.entries.length;
    const avgWin = v.winPnls.length > 0 ? v.winPnls.reduce((s,e) => s+e, 0) / v.winPnls.length : 0;
    const avgLoss = v.lossPnls.length > 0 ? v.lossPnls.reduce((s,e) => s+e, 0) / v.lossPnls.length : 0;
    const winRate = v.wins / v.total;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    console.log('  ' + pad(k, 8) + pad(v.total, 6) + pad(v.wins, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+v.pnl.toFixed(2), 12) +
      pad('$'+avgEntry.toFixed(3), 10) + pad('$'+avgWin.toFixed(2), 10) +
      pad('$'+avgLoss.toFixed(2), 10) + '$'+ev.toFixed(4));
  }

  // ===== 6. By Entry Price Bucket =====
  console.log('\n--- 6. BY ENTRY PRICE BUCKET ---');
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
  ];

  console.log('  ' + pad('Bucket', 14) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgWin$', 10) + pad('AvgLoss$', 10) + pad('TotalPnL', 12) + pad('EV/trade', 10) +
    pad('ROI%win', 10) + 'ROI%EV');

  for (const b of entryBuckets) {
    const bucket = results.filter(r => r.entryPrice >= b.min && r.entryPrice < b.max);
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(r => r.won);
    const bLosses = bucket.filter(r => !r.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
    const avgEntry = bucket.reduce((s,r) => s+r.entryPrice, 0) / bucket.length;
    const roiWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.roi, 0) / bWins.length : 0;
    const roiEv = avgEntry > 0 ? (ev / 2 * 100) : 0; // EV as % of $2 position

    console.log('  ' + pad(b.label, 14) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgWin.toFixed(2), 10) +
      pad('$'+avgLoss.toFixed(2), 10) + pad('$'+totalPnlB.toFixed(2), 12) +
      pad('$'+ev.toFixed(4), 10) + pad(roiWin.toFixed(0)+'%', 10) + (roiEv).toFixed(1) + '%');
  }

  // ===== 7. By Side =====
  console.log('\n--- 7. BY SIDE ---');
  for (const side of ['UP', 'DOWN']) {
    const bucket = results.filter(r => r.entrySide === side);
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(r => r.won);
    const bLosses = bucket.filter(r => !r.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
    const avgEntry = bucket.reduce((s,r) => s+r.entryPrice, 0) / bucket.length;
    console.log('  ' + side + ': N=' + bucket.length + ' Wins=' + bWins.length +
      ' (' + (winRate*100).toFixed(1) + '%) AvgEntry=$' + avgEntry.toFixed(3) +
      ' AvgWin=$' + avgWin.toFixed(2) + ' AvgLoss=$' + avgLoss.toFixed(2) +
      ' EV=$' + ev.toFixed(4) + ' TotalPnL=$' + totalPnlB.toFixed(2));
  }

  // ===== 8. By Edge Size =====
  console.log('\n--- 8. BY EDGE SIZE ---');
  const edgeBuckets = [
    { label: '0.10-0.15', min: 0.10, max: 0.15 },
    { label: '0.15-0.20', min: 0.15, max: 0.20 },
    { label: '0.20-0.25', min: 0.20, max: 0.25 },
    { label: '0.25-0.30', min: 0.25, max: 0.30 },
    { label: '0.30-0.40', min: 0.30, max: 0.40 },
    { label: '0.40-0.50', min: 0.40, max: 0.50 },
  ];

  console.log('  ' + pad('Edge', 14) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgEntry', 10) + pad('TotalPnL', 12) + pad('EV/trade', 10));

  for (const b of edgeBuckets) {
    const bucket = results.filter(r => r.edge >= b.min && r.edge < b.max);
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(r => r.won);
    const bLosses = bucket.filter(r => !r.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
    const avgEntry = bucket.reduce((s,r) => s+r.entryPrice, 0) / bucket.length;
    console.log('  ' + pad(b.label, 14) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgEntry.toFixed(3), 10) +
      pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
  }

  // ===== 9. Entry Price x Side Interaction =====
  console.log('\n--- 9. ENTRY PRICE x SIDE ---');
  const priceSideBuckets = [
    { label: 'Cheap ($0-0.20)', min: 0, max: 0.20 },
    { label: 'Low ($0.20-0.40)', min: 0.20, max: 0.40 },
    { label: 'Mid ($0.40-0.60)', min: 0.40, max: 0.60 },
    { label: 'High ($0.60-0.80)', min: 0.60, max: 0.80 },
    { label: 'Expensive ($0.80+)', min: 0.80, max: 1.00 },
  ];

  console.log('  ' + pad('Price x Side', 30) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgWin$', 10) + pad('AvgLoss$', 10) + pad('EV', 10) + pad('TotalPnL', 12));

  for (const b of priceSideBuckets) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = results.filter(r => r.entryPrice >= b.min && r.entryPrice < b.max && r.entrySide === side);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(r => r.won);
      const bLosses = bucket.filter(r => !r.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
      console.log('  ' + pad(b.label + ' ' + side, 30) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgWin.toFixed(2), 10) +
        pad('$'+avgLoss.toFixed(2), 10) + pad('$'+ev.toFixed(4), 10) + '$'+totalPnlB.toFixed(2));
    }
  }

  // ===== 10. By CLOB Conviction =====
  console.log('\n--- 10. BY CLOB CONVICTION ---');
  const convBuckets = [
    { label: '0.00-0.05 (center)', min: 0, max: 0.05 },
    { label: '0.05-0.10 (near)', min: 0.05, max: 0.10 },
    { label: '0.10-0.20 (lean)', min: 0.10, max: 0.20 },
    { label: '0.20-0.30 (tilted)', min: 0.20, max: 0.30 },
    { label: '0.30-0.40 (strong)', min: 0.30, max: 0.40 },
    { label: '0.40+ (decided)', min: 0.40, max: 0.60 },
  ];

  console.log('  ' + pad('Conviction', 25) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('AvgEntry', 10) + pad('TotalPnL', 12) + pad('EV', 10));

  for (const b of convBuckets) {
    const bucket = results.filter(r => r.conviction >= b.min && r.conviction < b.max);
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(r => r.won);
    const bLosses = bucket.filter(r => !r.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
    const avgEntry = bucket.reduce((s,r) => s+r.entryPrice, 0) / bucket.length;
    console.log('  ' + pad(b.label, 25) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+avgEntry.toFixed(3), 10) +
      pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
  }

  // ===== 11. Symbol x Side =====
  console.log('\n--- 11. SYMBOL x SIDE ---');
  console.log('  ' + pad('Symbol x Side', 16) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('EV', 10));

  const syms = [...new Set(results.map(r => r.symbol))].sort();
  for (const sym of syms) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = results.filter(r => r.symbol === sym && r.entrySide === side);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(r => r.won);
      const bLosses = bucket.filter(r => !r.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
      console.log('  ' + pad(sym + ' ' + side, 16) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
    }
  }

  // ===== 12. Big Winners =====
  console.log('\n--- 12. BIG WINNERS (PnL > $5) ---');
  const bigWinners = results.filter(r => r.pnl > 5).sort((a,b) => b.pnl - a.pnl);
  console.log('  Count: ' + bigWinners.length + ' / ' + results.length);
  const bigWinTotal = bigWinners.reduce((s,r) => s+r.pnl, 0);
  console.log('  Total PnL: $' + bigWinTotal.toFixed(2) + (totalPnl !== 0 ? ' (' + (bigWinTotal/Math.abs(totalPnl)*100).toFixed(1) + '% of |total|)' : ''));

  console.log('\n  ' + pad('PnL$', 10) + pad('Entry$', 8) + pad('Side', 6) + pad('Sym', 6) +
    pad('Edge', 8) + pad('p_up', 8) + pad('CLOBup', 8) + pad('Resol', 6) + pad('ROI%', 10) + 'Window');
  for (const r of bigWinners.slice(0, 25)) {
    console.log('  ' + pad('$'+r.pnl.toFixed(2), 10) + pad('$'+r.entryPrice.toFixed(3), 8) +
      pad(r.entrySide, 6) + pad(r.symbol, 6) + pad(r.edge.toFixed(3), 8) +
      pad(r.p_up.toFixed(3), 8) + pad(r.clobUp.toFixed(3), 8) +
      pad(r.resolution, 6) + pad(r.roi.toFixed(0)+'%', 10) + r.windowId);
  }

  // Common traits
  if (bigWinners.length > 0) {
    console.log('\n  Big winner patterns:');
    const bwSides = {};
    const bwSyms = {};
    for (const r of bigWinners) {
      bwSides[r.entrySide] = (bwSides[r.entrySide]||0) + 1;
      bwSyms[r.symbol] = (bwSyms[r.symbol]||0) + 1;
    }
    console.log('    Side dist: ' + JSON.stringify(bwSides));
    console.log('    Symbol dist: ' + JSON.stringify(bwSyms));
    console.log('    Avg entry: $' + (bigWinners.reduce((s,r) => s+r.entryPrice, 0)/bigWinners.length).toFixed(3));
    console.log('    Avg edge: ' + (bigWinners.reduce((s,r) => s+r.edge, 0)/bigWinners.length).toFixed(3));
    console.log('    Avg conviction: ' + (bigWinners.reduce((s,r) => s+r.conviction, 0)/bigWinners.length).toFixed(3));
  }

  // ===== 13. Symbol x Entry Price =====
  console.log('\n--- 13. SYMBOL x ENTRY PRICE ---');
  console.log('  ' + pad('Sym x Price', 22) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('EV', 10));

  const priceRanges = [
    { label: '$0-0.20', min: 0, max: 0.20 },
    { label: '$0.20-0.40', min: 0.20, max: 0.40 },
    { label: '$0.40-0.60', min: 0.40, max: 0.60 },
    { label: '$0.60-0.80', min: 0.60, max: 0.80 },
    { label: '$0.80+', min: 0.80, max: 1.00 },
  ];

  for (const sym of syms) {
    for (const b of priceRanges) {
      const bucket = results.filter(r => r.symbol === sym && r.entryPrice >= b.min && r.entryPrice < b.max);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(r => r.won);
      const bLosses = bucket.filter(r => !r.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
      console.log('  ' + pad(sym + ' ' + b.label, 22) + pad(bucket.length, 6) + pad(bWins.length, 6) +
        pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) + '$'+ev.toFixed(4));
    }
  }

  // ===== 14. Oracle Move Analysis =====
  console.log('\n--- 14. BY ORACLE MOVE SIZE ---');
  const moveBuckets = [
    { label: '|move| < $10', min: 0, max: 10 },
    { label: '$10-$25', min: 10, max: 25 },
    { label: '$25-$50', min: 25, max: 50 },
    { label: '$50-$100', min: 50, max: 100 },
    { label: '$100-$200', min: 100, max: 200 },
    { label: '$200+', min: 200, max: Infinity },
  ];

  console.log('  ' + pad('OracleMove', 16) + pad('N', 6) + pad('Wins', 6) + pad('Rate', 8) +
    pad('TotalPnL', 12) + pad('EV', 10) + pad('AvgEntry', 10));

  for (const b of moveBuckets) {
    const bucket = results.filter(r => {
      const move = Math.abs(r.oracleMove);
      return move >= b.min && move < b.max;
    });
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(r => r.won);
    const bLosses = bucket.filter(r => !r.won);
    const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
    const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
    const winRate = bWins.length / bucket.length;
    const ev = winRate * avgWin + (1-winRate) * avgLoss;
    const totalPnlB = bucket.reduce((s,r) => s+r.pnl, 0);
    const avgEntry = bucket.reduce((s,r) => s+r.entryPrice, 0) / bucket.length;
    console.log('  ' + pad(b.label, 16) + pad(bucket.length, 6) + pad(bWins.length, 6) +
      pad((winRate*100).toFixed(1)+'%', 8) + pad('$'+totalPnlB.toFixed(2), 12) +
      pad('$'+ev.toFixed(4), 10) + '$'+avgEntry.toFixed(3));
  }

  // ===== 15. P(UP) model accuracy =====
  console.log('\n--- 15. MODEL PROBABILITY CALIBRATION ---');
  const pupBuckets = [
    { label: 'p_up 0.00-0.10', min: 0, max: 0.10 },
    { label: 'p_up 0.10-0.20', min: 0.10, max: 0.20 },
    { label: 'p_up 0.20-0.30', min: 0.20, max: 0.30 },
    { label: 'p_up 0.30-0.40', min: 0.30, max: 0.40 },
    { label: 'p_up 0.40-0.50', min: 0.40, max: 0.50 },
    { label: 'p_up 0.50-0.60', min: 0.50, max: 0.60 },
    { label: 'p_up 0.60-0.70', min: 0.60, max: 0.70 },
    { label: 'p_up 0.70-0.80', min: 0.70, max: 0.80 },
    { label: 'p_up 0.80-0.90', min: 0.80, max: 0.90 },
    { label: 'p_up 0.90-1.00', min: 0.90, max: 1.00 },
  ];

  // Use all windows (not just the ones with edge) for calibration
  console.log('  (Calculated on ALL windows, not just traded ones)');
  console.log('  ' + pad('P(UP) Bucket', 18) + pad('N', 6) + pad('ActualUP', 10) + pad('ActualRate', 12) +
    pad('Expected', 10) + 'CalibError');

  for (const b of pupBuckets) {
    const windowsInBucket = [];
    for (const w of windows.rows) {
      const oracleT60 = parseFloat(w.oracle_price_60s_before || w.oracle_price_at_close);
      const strike = parseFloat(w.strike_price || 0);
      if (!strike) continue;
      const p_up = calculateBS(oracleT60, strike, 60000, sigma);
      if (p_up >= b.min && p_up < b.max) {
        const res = (w.onchain_resolved_direction || w.resolved_direction || '').toUpperCase();
        windowsInBucket.push({ p_up, resolved: res === 'UP' });
      }
    }
    if (windowsInBucket.length === 0) continue;
    const actualUp = windowsInBucket.filter(w => w.resolved).length;
    const actualRate = actualUp / windowsInBucket.length;
    const expected = (b.min + b.max) / 2;
    const calibError = Math.abs(actualRate - expected);
    console.log('  ' + pad(b.label, 18) + pad(windowsInBucket.length, 6) +
      pad(actualUp, 10) + pad((actualRate*100).toFixed(1)+'%', 12) +
      pad((expected*100).toFixed(0)+'%', 10) + (calibError*100).toFixed(1) + '%');
  }

  // ===== FINAL SUMMARY =====
  console.log('\n' + '='.repeat(100));
  console.log('FINAL SUMMARY — PROBABILITY MODEL (BS EDGE 0.10-0.50) SIMULATED ON ' + windows.rows.length + ' WINDOWS');
  console.log('='.repeat(100));
  console.log('');
  console.log('  Trades fired: ' + results.length + ' / ' + windows.rows.length + ' windows (' +
    (results.length/windows.rows.length*100).toFixed(1) + '% fire rate)');
  console.log('  Win rate: ' + (wins.length/results.length*100).toFixed(1) + '%');
  console.log('  Total PnL: $' + totalPnl.toFixed(2) + ' ($2 position size)');
  console.log('  EV per trade: $' + avgPnl.toFixed(4));
  console.log('  Avg WIN: $' + avgWinPnl.toFixed(2) + ' | Avg LOSS: $' + avgLossPnl.toFixed(2));
  console.log('  Payoff ratio: ' + (avgWinPnl / Math.abs(avgLossPnl)).toFixed(2) + ':1');
  console.log('');

  // Best and worst segments
  const segments = [];
  for (const sym of syms) {
    for (const side of ['UP', 'DOWN']) {
      const bucket = results.filter(r => r.symbol === sym && r.entrySide === side);
      if (bucket.length < 3) continue;
      const bWins = bucket.filter(r => r.won);
      const bLosses = bucket.filter(r => !r.won);
      const avgWin = bWins.length > 0 ? bWins.reduce((s,r) => s+r.pnl, 0) / bWins.length : 0;
      const avgLoss = bLosses.length > 0 ? bLosses.reduce((s,r) => s+r.pnl, 0) / bLosses.length : 0;
      const winRate = bWins.length / bucket.length;
      const ev = winRate * avgWin + (1-winRate) * avgLoss;
      segments.push({ key: sym + ' ' + side, n: bucket.length, winRate, ev, totalPnl: bucket.reduce((s,r) => s+r.pnl, 0) });
    }
  }
  segments.sort((a,b) => b.ev - a.ev);

  console.log('  BEST segments by EV:');
  for (const s of segments.slice(0, 5)) {
    console.log('    ' + pad(s.key, 16) + 'N=' + pad(s.n, 5) + 'WR=' + pad((s.winRate*100).toFixed(1)+'%', 8) +
      'EV=$' + pad(s.ev.toFixed(4), 10) + 'PnL=$' + s.totalPnl.toFixed(2));
  }
  console.log('  WORST segments by EV:');
  for (const s of segments.slice(-5)) {
    console.log('    ' + pad(s.key, 16) + 'N=' + pad(s.n, 5) + 'WR=' + pad((s.winRate*100).toFixed(1)+'%', 8) +
      'EV=$' + pad(s.ev.toFixed(4), 10) + 'PnL=$' + s.totalPnl.toFixed(2));
  }
  console.log('');

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
