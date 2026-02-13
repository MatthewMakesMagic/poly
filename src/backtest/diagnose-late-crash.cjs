/**
 * Late-Window Crash Hypothesis Test
 *
 * Focused: final 60s only. Does the oracle flip direction while
 * the CLOB is still priced high for the other side? If so, what's
 * the liquidity available to trade against?
 *
 * Window-active filter: timestamp >= window_open AND < window_close
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== LATE-WINDOW CRASH HYPOTHESIS (final 60s) ===\n');

  const windows = await pool.query(`
    SELECT
      w.window_id, w.chainlink_price_at_close, w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  console.log(`Scanning ${windows.rows.length} windows...\n`);

  const crashes = [];
  let totalWithClob = 0;

  for (const win of windows.rows) {
    const openEpoch = win.close_epoch - 900;
    const openTime = new Date(openEpoch * 1000).toISOString();
    const closeTime = win.window_close_time.toISOString();

    // CL@open (one query)
    const clO = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC LIMIT 1
    `, [openTime, closeTime]);
    if (!clO.rows.length) continue;
    const clOpen = parseFloat(clO.rows[0].price);
    const clClose = parseFloat(win.chainlink_price_at_close);
    const resolution = clClose >= clOpen ? 'UP' : 'DOWN';

    // CL ticks: final 60s only
    const clTicks = await pool.query(`
      SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= ($1::timestamptz - interval '60 seconds')
        AND timestamp <= $1::timestamptz
      ORDER BY timestamp ASC
    `, [closeTime]);

    // CLOB: final 60s, ACTIVE WINDOW ONLY, include sizes
    const clob = await pool.query(`
      SELECT symbol, best_ask, best_bid, ask_size_top, bid_size_top,
             last_trade_price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < to_timestamp($1 + 900)
        AND timestamp >= ($2::timestamptz - interval '60 seconds')
        AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [openEpoch, closeTime]);

    if (clob.rows.length < 2) continue;
    totalWithClob++;

    // Build CL direction timeline
    const clDirs = clTicks.rows.map(t => ({
      ttc: (win.close_epoch - parseFloat(t.ep)).toFixed(1),
      price: parseFloat(t.price),
      dir: parseFloat(t.price) >= clOpen ? 'UP' : 'DOWN',
      delta: parseFloat(t.price) - clOpen,
    }));

    // Find direction flips in CL
    let lastFlip = null;
    for (let i = 1; i < clDirs.length; i++) {
      if (clDirs[i].dir !== clDirs[i-1].dir) {
        lastFlip = { ttc: clDirs[i].ttc, from: clDirs[i-1].dir, to: clDirs[i].dir };
      }
    }

    // Build CLOB state at key moments (pair UP/DOWN by nearest second)
    const clobByTime = {};
    for (const snap of clob.rows) {
      const ttc = Math.round(win.close_epoch - parseFloat(snap.ep));
      if (!clobByTime[ttc]) clobByTime[ttc] = {};
      const side = snap.symbol === 'btc-down' ? 'dn' : 'up';
      clobByTime[ttc][side + 'Ask'] = parseFloat(snap.best_ask);
      clobByTime[ttc][side + 'Bid'] = parseFloat(snap.best_bid);
      clobByTime[ttc][side + 'AskSz'] = parseFloat(snap.ask_size_top) || 0;
      clobByTime[ttc][side + 'BidSz'] = parseFloat(snap.bid_size_top) || 0;
      clobByTime[ttc][side + 'Last'] = snap.last_trade_price ? parseFloat(snap.last_trade_price) : null;
    }

    // Peak CLOB confidence (using bid = what you can sell at)
    let peakUp = 0, peakDn = 0;
    for (const [ttc, c] of Object.entries(clobByTime)) {
      if (c.upBid && c.upBid > peakUp) peakUp = c.upBid;
      if (c.dnBid && c.dnBid > peakDn) peakDn = c.dnBid;
    }
    const peakDir = peakUp > peakDn ? 'UP' : 'DOWN';
    const peakConf = Math.max(peakUp, peakDn);

    // CRASH: CLOB was ≥80% one way, resolved opposite
    // OR: oracle flipped in final 30s
    const isCrash = peakConf >= 0.80 && peakDir !== resolution;
    const hasFlip = lastFlip !== null && parseFloat(lastFlip.ttc) <= 30;

    if (isCrash || hasFlip) {
      crashes.push({
        window: win.window_id,
        clOpen, clClose, resolution,
        margin: clClose - clOpen,
        peakDir, peakConf,
        lastFlip,
        clDirs,
        clobByTime,
        isCrash,
      });
    }
  }

  // Report
  console.log(`Windows with CLOB data (final 60s): ${totalWithClob}`);
  console.log(`Events found (crash or oracle flip <30s): ${crashes.length}\n`);

  for (const ev of crashes) {
    const tag = ev.isCrash ? '*** CRASH ***' : 'FLIP';
    console.log(`${'='.repeat(90)}`);
    console.log(`${tag} ${ev.window} | Resolved ${ev.resolution} (margin $${ev.margin.toFixed(2)})`);
    console.log(`CL@open=$${ev.clOpen.toFixed(2)} CL@close=$${ev.clClose.toFixed(2)}`);
    console.log(`Peak CLOB: ${ev.peakDir} at ${ev.peakConf.toFixed(3)}`);
    if (ev.lastFlip) {
      console.log(`Oracle flip: ${ev.lastFlip.from}→${ev.lastFlip.to} at T-${ev.lastFlip.ttc}s`);
    }

    // Oracle ticks final 30s
    console.log(`\n  ORACLE (final 30s):`);
    const late = ev.clDirs.filter(t => parseFloat(t.ttc) <= 30);
    for (const t of late) {
      console.log(`    T-${t.ttc.padStart(5)}s: $${t.price.toFixed(2)} (${t.dir}) Δ=$${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)}`);
    }

    // CLOB final 30s with liquidity
    console.log(`\n  CLOB + LIQUIDITY (final 30s):`);
    const keys = Object.keys(ev.clobByTime).map(Number).filter(k => k <= 30 && k >= 0).sort((a,b) => b - a);
    for (const ttc of keys) {
      const c = ev.clobByTime[ttc];
      const dn = c.dnAsk !== undefined
        ? `DN ask=${(c.dnAsk||0).toFixed(3)} (${(c.dnAskSz||0).toFixed(0)} shares) bid=${(c.dnBid||0).toFixed(3)} (${(c.dnBidSz||0).toFixed(0)})`
        : '';
      const up = c.upAsk !== undefined
        ? `UP ask=${(c.upAsk||0).toFixed(3)} (${(c.upAskSz||0).toFixed(0)} shares) bid=${(c.upBid||0).toFixed(3)} (${(c.upBidSz||0).toFixed(0)})`
        : '';
      console.log(`    T-${String(ttc).padStart(3)}s: ${dn}  ${up}`);
    }
    console.log();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
