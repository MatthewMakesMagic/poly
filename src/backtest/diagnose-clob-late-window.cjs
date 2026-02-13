/**
 * CLOB Late-Window Tracking
 *
 * Focused check: when CL is significantly away from open in the FINAL minutes,
 * does the CLOB reflect this? Sample every 30s through the window.
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== CLOB LATE-WINDOW TRACKING ===\n');

  const windows = await pool.query(`
    SELECT
      w.window_id, w.chainlink_price_at_close, w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 100
  `);

  // Pick 5 windows with big moves for deep trace
  const candidates = [];

  for (const win of windows.rows) {
    const windowOpenEpoch = win.close_epoch - 900;
    const windowOpenTime = new Date(windowOpenEpoch * 1000).toISOString();
    const windowCloseTime = win.window_close_time.toISOString();

    const clOpenResult = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC LIMIT 1
    `, [windowOpenTime, windowCloseTime]);

    if (!clOpenResult.rows.length) continue;
    const clOpen = parseFloat(clOpenResult.rows[0].price);
    const clClose = parseFloat(win.chainlink_price_at_close);
    const move = Math.abs(clClose - clOpen);
    if (move > 200) candidates.push({ ...win, clOpen, clClose, move, windowOpenEpoch, windowOpenTime, windowCloseTime });
  }

  candidates.sort((a, b) => b.move - a.move);
  console.log(`Found ${candidates.length} windows with >$200 move. Showing top 5:\n`);

  for (const win of candidates.slice(0, 5)) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`WINDOW: ${win.window_id} | Move: $${win.move.toFixed(0)} ${win.clClose >= win.clOpen ? 'UP' : 'DOWN'}`);
    console.log(`CL@open=$${win.clOpen.toFixed(2)} CL@close=$${win.clClose.toFixed(2)}`);
    console.log(`${'='.repeat(80)}`);

    // Get CL ticks throughout window (every tick)
    const clTicks = await pool.query(`
      SELECT price, timestamp, EXTRACT(EPOCH FROM timestamp)::numeric as ts_epoch
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [win.windowOpenTime, win.windowCloseTime]);

    // Get ALL CLOB snapshots for this window
    const clobSnaps = await pool.query(`
      SELECT symbol, best_ask, best_bid, last_trade_price, timestamp,
             EXTRACT(EPOCH FROM timestamp)::numeric as ts_epoch
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < to_timestamp($1 + 900)
      ORDER BY timestamp ASC
    `, [win.windowOpenEpoch]);

    // Sample at key intervals: every 60s from T-900 to T-0, then every 10s for last 60s
    const closeEpoch = win.close_epoch;
    const sampleTimes = [];
    for (let t = 900; t > 60; t -= 60) sampleTimes.push(t); // Every 60s
    for (let t = 60; t >= 0; t -= 10) sampleTimes.push(t); // Every 10s for final 60s

    console.log('\nTime  | CL Price    | CL vs Open | DN ask  | DN bid  | UP ask  | UP bid  | Notes');
    console.log('-'.repeat(95));

    for (const ttc of sampleTimes) {
      const targetEpoch = closeEpoch - ttc;
      const targetTime = new Date(targetEpoch * 1000);

      // Find closest CL tick at or before this time
      let closestCL = null;
      for (const cl of clTicks.rows) {
        if (parseFloat(cl.ts_epoch) <= targetEpoch) closestCL = parseFloat(cl.price);
        else break;
      }

      // Find closest CLOB snap at or before this time (within 5s)
      let dnAsk = null, dnBid = null, upAsk = null, upBid = null;
      for (let i = clobSnaps.rows.length - 1; i >= 0; i--) {
        const snap = clobSnaps.rows[i];
        const snapEpoch = parseFloat(snap.ts_epoch);
        if (snapEpoch <= targetEpoch && targetEpoch - snapEpoch < 5) {
          if (snap.symbol === 'btc-down') {
            dnAsk = parseFloat(snap.best_ask);
            dnBid = parseFloat(snap.best_bid);
          } else if (snap.symbol === 'btc-up') {
            upAsk = parseFloat(snap.best_ask);
            upBid = parseFloat(snap.best_bid);
          }
          // If we have both, stop looking
          if (dnAsk !== null && upAsk !== null) break;
        }
        if (snapEpoch < targetEpoch - 5) break;
      }

      const clDelta = closestCL ? closestCL - win.clOpen : null;
      const notes = [];
      if (ttc === 900) notes.push('WINDOW OPEN');
      if (ttc === 0) notes.push('WINDOW CLOSE');
      if (clDelta !== null && Math.abs(clDelta) > 200) notes.push(`BIG MOVE`);

      // Highlight if CLOB near 0.50 despite large CL move
      if (clDelta !== null && Math.abs(clDelta) > 200 && dnAsk !== null && dnAsk > 0.35 && dnAsk < 0.65) {
        notes.push('*** CLOB NEAR 0.50 ***');
      }

      const ttcStr = `T-${String(ttc).padStart(3)}s`;
      const clStr = closestCL ? `$${closestCL.toFixed(0)}` : '    -';
      const deltaStr = clDelta !== null ? `$${clDelta >= 0 ? '+' : ''}${clDelta.toFixed(0)}` : '   -';
      const dna = dnAsk !== null ? dnAsk.toFixed(3) : '  -  ';
      const dnb = dnBid !== null ? dnBid.toFixed(3) : '  -  ';
      const upa = upAsk !== null ? upAsk.toFixed(3) : '  -  ';
      const upb = upBid !== null ? upBid.toFixed(3) : '  -  ';

      console.log(`${ttcStr} | ${clStr.padStart(11)} | ${deltaStr.padStart(10)} | ${dna.padStart(7)} | ${dnb.padStart(7)} | ${upa.padStart(7)} | ${upb.padStart(7)} | ${notes.join(', ')}`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
