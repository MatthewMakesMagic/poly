const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:LGSICZgeqGhoqrvfnytwlfAikpFDuXvt@tramway.proxy.rlwy.net:17187/railway',
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // Get latest CLOB prices for all active UP tokens
  const res = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (symbol)
        symbol, best_bid, best_ask, mid_price, spread, last_trade_price, timestamp, window_epoch
      FROM clob_price_snapshots
      WHERE symbol LIKE '%-up'
        AND timestamp > NOW() - INTERVAL '5 minutes'
      ORDER BY symbol, timestamp DESC
    )
    SELECT * FROM latest ORDER BY symbol
  `);

  console.log('=== LIVE EDGE CHECK ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Model probabilities from latest Railway logs (09:07 UTC):
  const modelProbs = {
    'btc-up': 0.828,
    'eth-up': 0.528,
    'sol-up': 0.829,
    'xrp-up': 0.263
  };

  console.log('Symbol | CLOB mid | Model p_up | Best edge | Dir  | Status');
  console.log('-------|----------|------------|-----------|------|-------');

  for (const row of res.rows) {
    const market = parseFloat(row.mid_price || row.best_ask || row.best_bid);
    const pUp = modelProbs[row.symbol];
    if (pUp !== undefined) {
      const edgeUp = pUp - market;
      const edgeDown = -edgeUp;
      const bestEdge = Math.max(edgeUp, edgeDown);
      const bestDir = edgeUp > edgeDown ? 'UP' : 'DOWN';
      const status = bestEdge >= 0.25 ? '*** WOULD FIRE ***' : `need ${((0.25 - bestEdge)*100).toFixed(1)}% more`;
      const sym = row.symbol.replace('-up','').toUpperCase().padEnd(4);
      console.log(`${sym}   | ${market.toFixed(3).padStart(8)} | ${pUp.toFixed(3).padStart(10)} | ${(bestEdge * 100).toFixed(1).padStart(8)}% | ${bestDir.padEnd(4)} | ${status}`);
    }
  }

  // Also get recent trade history
  console.log('\n=== RECENT ORDERS (last 24h) ===');
  const orders = await pool.query(`
    SELECT id, symbol, side, size, price, avg_fill_price, status, order_type, created_at
    FROM orders
    WHERE created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  if (orders.rows.length > 0) {
    console.table(orders.rows);
  } else {
    console.log('No orders in last 24 hours');
  }

  // Check what windows are active
  console.log('\n=== ACTIVE WINDOWS ===');
  const windows = await pool.query(`
    SELECT symbol, window_epoch,
           to_timestamp(window_epoch) as opens_at,
           to_timestamp(window_epoch + 900) as closes_at,
           ROUND(EXTRACT(EPOCH FROM (to_timestamp(window_epoch + 900) - NOW()))) as secs_remaining
    FROM active_windows
    WHERE to_timestamp(window_epoch + 900) > NOW()
    ORDER BY symbol, window_epoch
  `);
  if (windows.rows.length > 0) {
    console.table(windows.rows);
  } else {
    // Try checking what the system sees
    const recent = await pool.query(`
      SELECT symbol, window_epoch,
             to_timestamp(window_epoch) as opens_at,
             to_timestamp(window_epoch + 900) as closes_at
      FROM active_windows
      ORDER BY window_epoch DESC
      LIMIT 8
    `);
    console.log('Latest windows (may be expired):');
    console.table(recent.rows);
  }

  await pool.end();
})();
