/**
 * CLOB Tracking Diagnostic
 *
 * For windows where BTC moved significantly from open:
 * Does the CLOB price track the oracle's position relative to open?
 * Or is it stuck near $0.50?
 *
 * If CL is $300 below open with 3 min left, DN ask should be $0.90+, not $0.50.
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== CLOB vs ORACLE TRACKING THROUGHOUT WINDOWS ===\n');

  // Find BTC windows with significant moves (using window_close_events for CL data)
  const windows = await pool.query(`
    SELECT
      w.window_id,
      w.strike_price,
      w.chainlink_price_at_close,
      w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch,
      w.oracle_price_60s_before,
      w.oracle_price_30s_before,
      w.oracle_price_10s_before,
      w.oracle_price_5s_before,
      w.oracle_price_1s_before
    FROM window_close_events w
    WHERE w.symbol = 'btc'
      AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  console.log(`Analyzing ${windows.rows.length} windows\n`);

  let problemWindows = 0;
  let totalTrackedWindows = 0;

  for (const win of windows.rows) {
    const windowOpenEpoch = win.close_epoch - 900;
    const windowOpenTime = new Date(windowOpenEpoch * 1000).toISOString();
    const windowCloseTime = win.window_close_time.toISOString();

    // Get CL@open
    const clOpenResult = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC LIMIT 1
    `, [windowOpenTime, windowCloseTime]);

    if (!clOpenResult.rows.length) continue;
    const clOpen = parseFloat(clOpenResult.rows[0].price);
    const clClose = parseFloat(win.chainlink_price_at_close);

    // Get CLOB snapshots throughout the window for btc-down and btc-up
    const clobData = await pool.query(`
      SELECT symbol, best_ask, best_bid, last_trade_price, timestamp,
             EXTRACT(EPOCH FROM timestamp)::bigint as ts_epoch
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < to_timestamp($1 + 900)
      ORDER BY timestamp ASC
    `, [windowOpenEpoch]);

    if (clobData.rows.length < 4) continue; // Need some data

    // Get CL ticks throughout the window
    const clTicks = await pool.query(`
      SELECT price, timestamp,
             EXTRACT(EPOCH FROM timestamp)::bigint as ts_epoch
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [windowOpenTime, windowCloseTime]);

    // Build timeline: at each CLOB snapshot, what was the CL position relative to open?
    const timeline = [];
    let lastCLPrice = clOpen;

    for (const snap of clobData.rows) {
      const snapTime = new Date(snap.timestamp);
      const timeToClose = (new Date(windowCloseTime) - snapTime) / 1000; // seconds

      // Find closest CL tick
      for (const cl of clTicks.rows) {
        if (new Date(cl.timestamp) <= snapTime) {
          lastCLPrice = parseFloat(cl.price);
        }
      }

      const clDelta = lastCLPrice - clOpen; // positive = above open

      timeline.push({
        timeToClose: timeToClose.toFixed(0),
        symbol: snap.symbol,
        ask: parseFloat(snap.best_ask),
        bid: parseFloat(snap.best_bid),
        lastTrade: snap.last_trade_price ? parseFloat(snap.last_trade_price) : null,
        clDelta,
        clPrice: lastCLPrice,
      });
    }

    // Group by timestamp to get paired UP/DOWN snapshots
    const paired = {};
    for (const t of timeline) {
      const key = t.timeToClose;
      if (!paired[key]) paired[key] = {};
      paired[key][t.symbol] = t;
    }

    // Check: are there cases where |clDelta| > $100 but DN ask is 0.40-0.60?
    let hasAnomaly = false;
    const anomalies = [];

    for (const [ttc, pair] of Object.entries(paired)) {
      const dn = pair['btc-down'];
      const up = pair['btc-up'];
      if (!dn && !up) continue;

      const clDelta = dn?.clDelta || up?.clDelta || 0;
      const dnAsk = dn?.ask;
      const upAsk = up?.ask;
      const ttcNum = parseInt(ttc);

      // Only look at mid-window (not first 2 min, not last 10s)
      if (ttcNum < 10 || ttcNum > 780) continue;

      // Anomaly: CL significantly below open but DN ask near 0.50
      if (clDelta < -100 && dnAsk !== null && dnAsk < 0.70 && dnAsk > 0.30) {
        hasAnomaly = true;
        anomalies.push({ ttc: ttcNum, clDelta, dnAsk, upAsk });
      }
      // Anomaly: CL significantly above open but UP ask near 0.50
      if (clDelta > 100 && upAsk !== null && upAsk < 0.70 && upAsk > 0.30) {
        hasAnomaly = true;
        anomalies.push({ ttc: ttcNum, clDelta, dnAsk, upAsk });
      }
    }

    totalTrackedWindows++;

    if (hasAnomaly) {
      problemWindows++;
      const margin = clClose - clOpen;
      console.log(`\nPROBLEM: ${win.window_id} (resolved ${margin >= 0 ? 'UP' : 'DOWN'}, margin=$${margin.toFixed(0)})`);
      console.log(`  CL@open=$${clOpen.toFixed(2)} CL@close=$${clClose.toFixed(2)}`);
      console.log(`  CLOB snapshots: ${clobData.rows.length} total`);

      for (const a of anomalies.slice(0, 5)) {
        console.log(`  T-${a.ttc}s: CL delta=$${a.clDelta.toFixed(0)} but DN ask=${a.dnAsk?.toFixed(3)||'-'} UP ask=${a.upAsk?.toFixed(3)||'-'}`);
      }

      // Show full timeline for this window
      const sortedTimes = Object.keys(paired).map(Number).sort((a, b) => b - a);
      console.log(`  --- FULL TIMELINE (${sortedTimes.length} points) ---`);
      for (const ttc of sortedTimes.slice(0, 20)) {
        const pair = paired[ttc.toString()];
        const dn = pair['btc-down'];
        const up = pair['btc-up'];
        const cl = dn?.clDelta || up?.clDelta || 0;
        console.log(`  T-${String(ttc).padStart(4)}s: CL Δ=$${cl.toFixed(0).padStart(6)} | DN ask=${dn?.ask?.toFixed(3)||'  -  '} bid=${dn?.bid?.toFixed(3)||'  -  '} | UP ask=${up?.ask?.toFixed(3)||'  -  '} bid=${up?.bid?.toFixed(3)||'  -  '}`);
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Windows with CLOB data: ${totalTrackedWindows}`);
  console.log(`Windows with pricing anomalies (CLOB near 0.50 when CL > $100 from open): ${problemWindows}`);

  // Also show a GOOD window for comparison — where CLOB properly tracks
  console.log('\n=== SAMPLE GOOD WINDOW (large move, CLOB tracks correctly) ===');
  // Find a window with large move and CLOB data
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
    if (move < 200) continue; // Need a big move

    const clobData = await pool.query(`
      SELECT symbol, best_ask, best_bid, timestamp
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < to_timestamp($1 + 900)
      ORDER BY timestamp ASC
    `, [windowOpenEpoch]);

    if (clobData.rows.length < 10) continue;

    // Get CL ticks
    const clTicks = await pool.query(`
      SELECT price, timestamp
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [windowOpenTime, windowCloseTime]);

    console.log(`\nWindow: ${win.window_id} (move=$${move.toFixed(0)}, ${clClose >= clOpen ? 'UP' : 'DOWN'})`);
    console.log(`CL@open=$${clOpen.toFixed(2)} CL@close=$${clClose.toFixed(2)}`);
    console.log(`CLOB snapshots: ${clobData.rows.length}`);

    // Show timeline
    let lastCL = clOpen;
    const paired = {};
    for (const snap of clobData.rows) {
      const ttc = ((new Date(windowCloseTime) - new Date(snap.timestamp)) / 1000).toFixed(0);
      for (const cl of clTicks.rows) {
        if (new Date(cl.timestamp) <= new Date(snap.timestamp)) lastCL = parseFloat(cl.price);
      }
      if (!paired[ttc]) paired[ttc] = {};
      paired[ttc][snap.symbol] = { ask: parseFloat(snap.best_ask), bid: parseFloat(snap.best_bid), clDelta: lastCL - clOpen };
    }

    const sortedTimes = Object.keys(paired).map(Number).sort((a, b) => b - a);
    for (const ttc of sortedTimes) {
      const p = paired[ttc.toString()];
      const dn = p['btc-down'];
      const up = p['btc-up'];
      const cl = dn?.clDelta || up?.clDelta || 0;
      console.log(`  T-${String(ttc).padStart(4)}s: CL Δ=$${cl.toFixed(0).padStart(6)} | DN ask=${dn?.ask?.toFixed(3)||'  -  '} bid=${dn?.bid?.toFixed(3)||'  -  '} | UP ask=${up?.ask?.toFixed(3)||'  -  '} bid=${up?.bid?.toFixed(3)||'  -  '}`);
    }

    break; // Just one example
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
