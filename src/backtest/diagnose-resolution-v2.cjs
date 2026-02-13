/**
 * Resolution Diagnostic V2
 *
 * Now that we know the formula is CL@close >= CL@open:
 * 1. How often does the CLOB price at T-2s predict the correct resolution?
 * 2. Is there EVER a case where CL@T-2s disagrees with CL@close direction?
 * 3. What does the "arb opportunity" look like with correct resolution?
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== RESOLUTION V2: CL@close vs CL@open ANALYSIS ===\n');

  const windows = await pool.query(`
    SELECT
      w.window_id,
      w.symbol,
      w.strike_price,
      w.chainlink_price_at_close,
      w.resolved_direction,
      w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch,
      w.oracle_price_1s_before,
      w.oracle_price_5s_before,
      w.oracle_price_10s_before,
      w.oracle_price_30s_before,
      w.oracle_price_60s_before,
      w.market_up_price_1s,
      w.market_up_price_5s,
      w.market_up_price_10s,
      w.market_down_price_1s,
      w.market_down_price_5s,
      w.market_down_price_10s
    FROM window_close_events w
    WHERE w.symbol = 'btc'
      AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  console.log(`Found ${windows.rows.length} BTC windows\n`);

  const intervals = [
    { label: 'T-60s', field: 'oracle_price_60s_before' },
    { label: 'T-30s', field: 'oracle_price_30s_before' },
    { label: 'T-10s', field: 'oracle_price_10s_before' },
    { label: 'T-5s',  field: 'oracle_price_5s_before' },
    { label: 'T-1s',  field: 'oracle_price_1s_before' },
  ];

  // For each window, compute correct resolution and check oracle at each interval
  const stats = {};
  for (const iv of intervals) {
    stats[iv.label] = { total: 0, correct: 0, flips: 0 };
  }

  let totalWindows = 0;
  let windowsWithClob = 0;
  let clobCorrectAt10s = 0;
  let clobCorrectAt5s = 0;
  let clobCorrectAt1s = 0;

  const detailedResults = [];

  for (const win of windows.rows) {
    const windowOpenEpoch = win.close_epoch - 900;
    const windowOpenTime = new Date(windowOpenEpoch * 1000).toISOString();
    const windowCloseTime = win.window_close_time.toISOString();

    // CL@open
    const clOpenResult = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC LIMIT 1
    `, [windowOpenTime, windowCloseTime]);

    if (!clOpenResult.rows.length) continue;

    const clOpen = parseFloat(clOpenResult.rows[0].price);
    const clClose = parseFloat(win.chainlink_price_at_close);
    const correctResolution = clClose >= clOpen ? 'UP' : 'DOWN';

    totalWindows++;

    // Check oracle signal at each interval
    for (const iv of intervals) {
      const oraclePrice = win[iv.field] ? parseFloat(win[iv.field]) : null;
      if (oraclePrice === null) continue;

      stats[iv.label].total++;
      const signalDirection = oraclePrice >= clOpen ? 'UP' : 'DOWN';
      if (signalDirection === correctResolution) {
        stats[iv.label].correct++;
      }
      // Check if direction flipped between this interval and close
      if (signalDirection !== correctResolution) {
        stats[iv.label].flips++;
      }
    }

    // Check CLOB prices near close
    const preClob = await pool.query(`
      SELECT symbol, best_ask, best_bid, last_trade_price, timestamp
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < $2::timestamptz
        AND timestamp > ($2::timestamptz - interval '15 seconds')
      ORDER BY timestamp DESC
    `, [windowOpenEpoch, windowCloseTime]);

    let dnAsk10 = null, upAsk10 = null;
    for (const row of preClob.rows) {
      const age = (new Date(windowCloseTime) - new Date(row.timestamp)) / 1000;
      if (row.symbol === 'btc-down' && dnAsk10 === null) dnAsk10 = parseFloat(row.best_ask);
      if (row.symbol === 'btc-up' && upAsk10 === null) upAsk10 = parseFloat(row.best_ask);
    }

    if (dnAsk10 !== null || upAsk10 !== null) {
      windowsWithClob++;
      // CLOB thinks UP if UP price > 0.5 (i.e., DN ask < 0.5)
      const clobDirection = (dnAsk10 !== null && dnAsk10 < 0.5) ? 'UP' :
                           (upAsk10 !== null && upAsk10 > 0.5) ? 'DOWN' :
                           (dnAsk10 !== null ? (dnAsk10 < 0.5 ? 'UP' : 'DOWN') : 'UP');
      if (clobDirection === correctResolution) clobCorrectAt10s++;
    }

    // Collect for detailed view
    const strike = parseFloat(win.strike_price || 0);
    const clT2 = win.oracle_price_5s_before ? parseFloat(win.oracle_price_5s_before) : null;
    const clT10 = win.oracle_price_10s_before ? parseFloat(win.oracle_price_10s_before) : null;

    detailedResults.push({
      window: win.window_id,
      clOpen,
      clClose,
      strike,
      correctResolution,
      clT10,
      clT2: clT2,
      signalT10: clT10 ? (clT10 >= clOpen ? 'UP' : 'DOWN') : null,
      signalT2: clT2 ? (clT2 >= clOpen ? 'UP' : 'DOWN') : null,
      dnAsk: dnAsk10,
      upAsk: upAsk10,
      margin: clClose - clOpen,
    });
  }

  // Oracle accuracy at each interval
  console.log('=== ORACLE SIGNAL ACCURACY (CL@T vs CL@open → predicts resolution) ===');
  for (const iv of intervals) {
    const s = stats[iv.label];
    if (s.total > 0) {
      console.log(`  ${iv.label}: ${s.correct}/${s.total} correct (${(s.correct/s.total*100).toFixed(1)}%) | ${s.flips} flips (direction changed after signal)`);
    }
  }

  // CLOB accuracy
  console.log(`\n=== CLOB PREDICTION ACCURACY ===`);
  console.log(`  CLOB (last 10s) agrees with resolution: ${clobCorrectAt10s}/${windowsWithClob} (${windowsWithClob > 0 ? (clobCorrectAt10s/windowsWithClob*100).toFixed(1) : 0}%)`);

  // Margin analysis — how close are these?
  console.log(`\n=== MARGIN ANALYSIS (CL@close - CL@open) ===`);
  const margins = detailedResults.map(r => r.margin);
  const absMargins = margins.map(m => Math.abs(m));
  absMargins.sort((a, b) => a - b);
  console.log(`  Median absolute margin: $${absMargins[Math.floor(absMargins.length/2)].toFixed(2)}`);
  console.log(`  <$10 margin (razor-thin): ${absMargins.filter(m => m < 10).length}/${absMargins.length} (${(absMargins.filter(m => m < 10).length/absMargins.length*100).toFixed(1)}%)`);
  console.log(`  <$50 margin: ${absMargins.filter(m => m < 50).length}/${absMargins.length} (${(absMargins.filter(m => m < 50).length/absMargins.length*100).toFixed(1)}%)`);
  console.log(`  <$100 margin: ${absMargins.filter(m => m < 100).length}/${absMargins.length} (${(absMargins.filter(m => m < 100).length/absMargins.length*100).toFixed(1)}%)`);

  // Cases where oracle signal at T-5s FLIPPED before close
  console.log('\n=== FLIPS: Signal at T-5s disagrees with final resolution ===');
  const flips = detailedResults.filter(r => r.signalT2 !== null && r.signalT2 !== r.correctResolution);
  console.log(`${flips.length} flips out of ${detailedResults.filter(r => r.signalT2).length} windows with T-5s data`);
  for (const f of flips.slice(0, 10)) {
    console.log(`  ${f.window}: CL@open=$${f.clOpen.toFixed(2)} CL@T5=$${f.clT2.toFixed(2)} CL@close=$${f.clClose.toFixed(2)} margin=$${f.margin.toFixed(2)}`);
    console.log(`    Signal@T5=${f.signalT2} Actual=${f.correctResolution} | DN ask=${f.dnAsk?.toFixed(3)||'-'} UP ask=${f.upAsk?.toFixed(3)||'-'}`);
  }

  // What does the "arb" look like now?
  console.log('\n=== SETTLEMENT ARB REASSESSMENT ===');
  console.log('Looking for: CL@T-5s significantly below CL@open (strong DOWN signal)');
  console.log('In these cases, what does the CLOB DN token cost?');
  const strongDownSignals = detailedResults.filter(r =>
    r.clT2 !== null && r.clT2 < r.clOpen - 30 && // CL dropped > $30 from open
    r.correctResolution === 'DOWN' // Actually resolved DOWN
  );
  console.log(`\nStrong DOWN signal (CL dropped >$30 from open, resolved DOWN): ${strongDownSignals.length}`);
  for (const s of strongDownSignals.slice(0, 15)) {
    const deficit = s.clT2 - s.clOpen;
    console.log(`  ${s.window}: CL deficit=$${deficit.toFixed(0)} | DN ask=${s.dnAsk?.toFixed(3)||'-'} UP ask=${s.upAsk?.toFixed(3)||'-'} | margin=$${s.margin.toFixed(0)}`);
  }

  const strongUpSignals = detailedResults.filter(r =>
    r.clT2 !== null && r.clT2 > r.clOpen + 30 &&
    r.correctResolution === 'UP'
  );
  console.log(`\nStrong UP signal (CL rose >$30 from open, resolved UP): ${strongUpSignals.length}`);
  for (const s of strongUpSignals.slice(0, 15)) {
    const surplus = s.clT2 - s.clOpen;
    console.log(`  ${s.window}: CL surplus=$${surplus.toFixed(0)} | DN ask=${s.dnAsk?.toFixed(3)||'-'} UP ask=${s.upAsk?.toFixed(3)||'-'} | margin=$${s.margin.toFixed(0)}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
