/**
 * Resolution Diagnostic
 *
 * Cross-references our computed resolution (CL@close > strike) against:
 * 1. Post-resolution CLOB token prices (which token went to ~$1?)
 * 2. CL@open (first Chainlink tick in window) vs CL@close
 * 3. The strike parsed from question text vs CL@open
 *
 * Goal: determine if our resolution formula is wrong for ~50% of windows.
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== RESOLUTION DIAGNOSTIC ===\n');

  // Get windows with strike + CL data (BTC only since CL only broadcasts BTC)
  const windows = await pool.query(`
    SELECT
      w.window_id,
      w.symbol,
      w.strike_price,
      w.chainlink_price_at_close,
      w.resolved_direction,
      w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc'
      AND w.strike_price IS NOT NULL
      AND w.strike_price > 0
      AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  console.log(`Found ${windows.rows.length} BTC windows with strike + CL data\n`);

  let total = 0;
  let withPostClob = 0;
  let ourCorrect = 0;
  let altCorrect = 0;
  let disagreements = [];

  const results = [];

  for (const win of windows.rows) {
    const windowOpenEpoch = win.close_epoch - 900;
    const windowOpenTime = new Date(windowOpenEpoch * 1000).toISOString();
    const windowCloseTime = win.window_close_time.toISOString();

    // CL@open: first chainlink tick after window opens
    const clOpenResult = await pool.query(`
      SELECT price, timestamp
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink'
        AND symbol = 'btc'
        AND timestamp >= $1::timestamptz
        AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC
      LIMIT 1
    `, [windowOpenTime, windowCloseTime]);

    // CL@close: last chainlink tick before/at window close
    const clCloseResult = await pool.query(`
      SELECT price, timestamp
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink'
        AND symbol = 'btc'
        AND timestamp <= $1::timestamptz
        AND timestamp >= $2::timestamptz
      ORDER BY timestamp DESC
      LIMIT 1
    `, [windowCloseTime, windowOpenTime]);

    if (!clOpenResult.rows.length || !clCloseResult.rows.length) continue;

    const clOpen = parseFloat(clOpenResult.rows[0].price);
    const clClose = parseFloat(clCloseResult.rows[0].price);
    const strike = parseFloat(win.strike_price);

    // Our formula: CL@close > strike
    const ourResolution = clClose > strike ? 'UP' : 'DOWN';
    // Alt formula: CL@close >= CL@open
    const altResolution = clClose >= clOpen ? 'UP' : 'DOWN';

    // Get post-resolution CLOB prices using window_epoch
    // After window closes, the settling window's tokens should show resolution
    const postDown = await pool.query(`
      SELECT best_ask, best_bid, last_trade_price, timestamp
      FROM clob_price_snapshots
      WHERE symbol = 'btc-down'
        AND window_epoch = $1
        AND timestamp > $2::timestamptz
      ORDER BY timestamp ASC
      LIMIT 3
    `, [windowOpenEpoch, windowCloseTime]);

    const postUp = await pool.query(`
      SELECT best_ask, best_bid, last_trade_price, timestamp
      FROM clob_price_snapshots
      WHERE symbol = 'btc-up'
        AND window_epoch = $1
        AND timestamp > $2::timestamptz
      ORDER BY timestamp ASC
      LIMIT 3
    `, [windowOpenEpoch, windowCloseTime]);

    // Also check pre-close CLOB to see what market expected
    const preClob = await pool.query(`
      SELECT symbol, best_ask, best_bid, last_trade_price, timestamp
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp < $2::timestamptz
        AND timestamp > ($2::timestamptz - interval '10 seconds')
      ORDER BY symbol, timestamp DESC
    `, [windowOpenEpoch, windowCloseTime]);

    let actualResolution = null;
    let postDownPrice = null;
    let postUpPrice = null;
    let preDownAsk = null;
    let preUpAsk = null;

    if (postDown.rows.length > 0) {
      postDownPrice = parseFloat(postDown.rows[0].last_trade_price || postDown.rows[0].best_ask);
    }
    if (postUp.rows.length > 0) {
      postUpPrice = parseFloat(postUp.rows[0].last_trade_price || postUp.rows[0].best_ask);
    }

    for (const row of preClob.rows) {
      if (row.symbol === 'btc-down') preDownAsk = parseFloat(row.best_ask);
      if (row.symbol === 'btc-up') preUpAsk = parseFloat(row.best_ask);
    }

    // Determine actual resolution from post-close prices
    if (postDownPrice !== null && postUpPrice !== null) {
      if (postDownPrice > 0.8) actualResolution = 'DOWN';
      else if (postUpPrice > 0.8) actualResolution = 'UP';
      else if (postDownPrice < 0.2) actualResolution = 'UP';
      else if (postUpPrice < 0.2) actualResolution = 'DOWN';
    } else if (postDownPrice !== null) {
      if (postDownPrice > 0.8) actualResolution = 'DOWN';
      else if (postDownPrice < 0.2) actualResolution = 'UP';
    } else if (postUpPrice !== null) {
      if (postUpPrice > 0.8) actualResolution = 'UP';
      else if (postUpPrice < 0.2) actualResolution = 'DOWN';
    }

    total++;

    const result = {
      window: win.window_id,
      strike,
      clOpen,
      clClose,
      strikeDelta: strike - clOpen,
      clDelta: clClose - clOpen,
      ourResolution,
      altResolution,
      actualResolution: actualResolution || '???',
      preDownAsk,
      preUpAsk,
      postDown: postDownPrice,
      postUp: postUpPrice,
    };

    if (actualResolution) {
      withPostClob++;
      if (ourResolution === actualResolution) ourCorrect++;
      if (altResolution === actualResolution) altCorrect++;
      if (ourResolution !== altResolution) {
        disagreements.push(result);
      }
    }

    results.push(result);
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Total windows with CL data: ${total}`);
  console.log(`Windows with post-resolution CLOB (ground truth): ${withPostClob}`);
  if (withPostClob > 0) {
    console.log(`Our formula (CL>strike) correct: ${ourCorrect}/${withPostClob} (${(ourCorrect/withPostClob*100).toFixed(1)}%)`);
    console.log(`Alt formula (CL_close>=CL_open) correct: ${altCorrect}/${withPostClob} (${(altCorrect/withPostClob*100).toFixed(1)}%)`);
  }

  // Strike vs CL@open relationship
  console.log('\n=== STRIKE vs CL@OPEN ===');
  const deltas = results.map(r => r.strikeDelta);
  const avg = deltas.reduce((a,b) => a+b, 0) / deltas.length;
  console.log(`Strike - CL@open: avg=$${avg.toFixed(2)} (strike is ${avg > 0 ? 'ABOVE' : 'BELOW'} CL@open)`);
  console.log(`Range: $${Math.min(...deltas).toFixed(2)} to $${Math.max(...deltas).toFixed(2)}`);

  // Disagreement details
  if (disagreements.length > 0) {
    console.log(`\n=== ${disagreements.length} DISAGREEMENTS (our vs alt formula differ) ===`);
    for (const d of disagreements) {
      console.log(`${d.window}:`);
      console.log(`  Strike=$${d.strike.toFixed(2)} CL@open=$${d.clOpen.toFixed(2)} CL@close=$${d.clClose.toFixed(2)}`);
      console.log(`  Strike-CL@open=$${d.strikeDelta.toFixed(2)} | CL move=$${d.clDelta.toFixed(2)}`);
      console.log(`  Our(CL>strike)=${d.ourResolution} Alt(CL>=CL_open)=${d.altResolution} Actual=${d.actualResolution}`);
      console.log(`  Pre-close: UP ask=${d.preUpAsk?.toFixed(3)||'-'} DOWN ask=${d.preDownAsk?.toFixed(3)||'-'}`);
      console.log(`  Post-close: UP=${d.postUp?.toFixed(3)||'-'} DOWN=${d.postDown?.toFixed(3)||'-'}`);
    }
  }

  // Full table (recent windows with ground truth)
  const withGT = results.filter(r => r.actualResolution !== '???');
  console.log(`\n=== WINDOWS WITH GROUND TRUTH (${withGT.length}) ===`);
  console.log('Window                    | Strike  | CL@open | CL@close| Str-CLop | CL move | Our  | Alt  | Actual | preDnAsk | preUpAsk | postDn  | postUp');
  console.log('-'.repeat(155));
  for (const r of withGT.slice(0, 60)) {
    const w = r.window.padEnd(25);
    const s = r.strike.toFixed(0).padStart(7);
    const co = r.clOpen.toFixed(0).padStart(7);
    const cc = r.clClose.toFixed(0).padStart(7);
    const sd = r.strikeDelta.toFixed(0).padStart(8);
    const cd = r.clDelta.toFixed(0).padStart(7);
    const or_ = r.ourResolution.padStart(4);
    const ar_ = r.altResolution.padStart(4);
    const act = r.actualResolution.padStart(6);
    const pda = r.preDownAsk !== null ? r.preDownAsk.toFixed(3).padStart(8) : '       -';
    const pua = r.preUpAsk !== null ? r.preUpAsk.toFixed(3).padStart(8) : '       -';
    const pd = r.postDown !== null ? r.postDown.toFixed(3).padStart(7) : '      -';
    const pu = r.postUp !== null ? r.postUp.toFixed(3).padStart(7) : '      -';
    const ourOk = r.ourResolution === r.actualResolution ? ' ' : '!';
    const altOk = r.altResolution === r.actualResolution ? ' ' : '!';
    console.log(`${w} | $${s} | $${co} | $${cc} | $${sd} | $${cd} | ${or_}${ourOk}| ${ar_}${altOk}| ${act} | ${pda} | ${pua} | ${pd} | ${pu}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
