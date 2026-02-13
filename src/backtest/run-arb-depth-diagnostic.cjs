/**
 * Token identity verification: are btc-up and btc-down labels correct?
 * Check resolved windows where we KNOW which token paid $1.
 * If btc-down's price goes to $0.999 when market resolves UP, labels are INVERTED.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

async function main() {
  // Get some resolved windows
  const wRes = await pool.query(`
    SELECT window_close_time, symbol, strike_price, chainlink_price_at_close,
           EXTRACT(EPOCH FROM window_close_time)::bigint as epoch,
           CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END as resolved
    FROM window_close_events
    WHERE symbol = 'btc' AND strike_price IS NOT NULL AND strike_price > 0
    ORDER BY window_close_time DESC
    LIMIT 60
  `);

  console.log('\n  TOKEN IDENTITY VERIFICATION — checking post-resolution prices\n');
  console.log('  Close (ET)         │ Resolved │ btc-up last snap    │ btc-down last snap  │ LABELS');
  console.log('  ' + '─'.repeat(95));

  for (const w of wRes.rows) {
    const ep = parseInt(w.epoch);
    const closeMs = ep * 1000;
    const resolved = w.resolved;

    // Get the LAST snapshot for each token in this window (after close = resolved price)
    const upR = await pool.query(`
      SELECT best_ask, best_bid, last_trade_price, timestamp, token_id
      FROM clob_price_snapshots
      WHERE symbol = 'btc-up' AND window_epoch = $1
      ORDER BY timestamp DESC LIMIT 1
    `, [ep]);

    const dnR = await pool.query(`
      SELECT best_ask, best_bid, last_trade_price, timestamp, token_id
      FROM clob_price_snapshots
      WHERE symbol = 'btc-down' AND window_epoch = $1
      ORDER BY timestamp DESC LIMIT 1
    `, [ep]);

    const et = new Date(w.window_close_time).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    const upAsk = upR.rows[0]?.best_ask != null ? parseFloat(upR.rows[0].best_ask).toFixed(3) : '-';
    const upBid = upR.rows[0]?.best_bid != null ? parseFloat(upR.rows[0].best_bid).toFixed(3) : '-';
    const upLtp = upR.rows[0]?.last_trade_price != null ? parseFloat(upR.rows[0].last_trade_price).toFixed(3) : '-';
    const dnAsk = dnR.rows[0]?.best_ask != null ? parseFloat(dnR.rows[0].best_ask).toFixed(3) : '-';
    const dnBid = dnR.rows[0]?.best_bid != null ? parseFloat(dnR.rows[0].best_bid).toFixed(3) : '-';
    const dnLtp = dnR.rows[0]?.last_trade_price != null ? parseFloat(dnR.rows[0].last_trade_price).toFixed(3) : '-';

    // Determine if labels match: if resolved UP, btc-up should have high price, btc-down low price
    let labelCheck = '?';
    const upVal = parseFloat(upLtp) || parseFloat(upAsk) || 0;
    const dnVal = parseFloat(dnLtp) || parseFloat(dnAsk) || 0;

    if (resolved === 'UP') {
      if (upVal > 0.7 && dnVal < 0.3) labelCheck = 'CORRECT';
      else if (dnVal > 0.7 && upVal < 0.3) labelCheck = 'INVERTED <<<';
      else labelCheck = `UP:${upVal.toFixed(2)} DN:${dnVal.toFixed(2)}`;
    } else {
      if (dnVal > 0.7 && upVal < 0.3) labelCheck = 'CORRECT';
      else if (upVal > 0.7 && dnVal < 0.3) labelCheck = 'INVERTED <<<';
      else labelCheck = `UP:${upVal.toFixed(2)} DN:${dnVal.toFixed(2)}`;
    }

    console.log(`  ${et.padEnd(20)} │ ${resolved.padEnd(8)} │ A:${upAsk} B:${upBid} L:${upLtp} │ A:${dnAsk} B:${dnBid} L:${dnLtp} │ ${labelCheck}`);
  }

  // Also: look at ONE specific resolved window and show the token_ids
  console.log('\n\n  TOKEN IDs for first few windows:');
  console.log('  ' + '─'.repeat(80));

  for (const w of wRes.rows.slice(0, 5)) {
    const ep = parseInt(w.epoch);
    const upTid = await pool.query(`SELECT DISTINCT token_id FROM clob_price_snapshots WHERE symbol = 'btc-up' AND window_epoch = $1`, [ep]);
    const dnTid = await pool.query(`SELECT DISTINCT token_id FROM clob_price_snapshots WHERE symbol = 'btc-down' AND window_epoch = $1`, [ep]);

    const et = new Date(w.window_close_time).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    console.log(`  ${et}: UP token=${upTid.rows[0]?.token_id?.slice(0, 20) || '-'}...  DN token=${dnTid.rows[0]?.token_id?.slice(0, 20) || '-'}...`);
  }

  // Cross-reference: check the Gamma API convention by looking at outcomePrices
  // If outcomePrices[0] tracks with the UP token behavior, labels are correct
  console.log('\n\n  PRICE AT T-2s vs RESOLUTION (btc-down token):');
  console.log('  ' + '─'.repeat(60));
  console.log('  If DN ask > 0.6 correlates with UP resolution → LABELS ARE INVERTED');
  console.log('  If DN ask > 0.6 correlates with DOWN resolution → LABELS ARE CORRECT\n');

  let upAndHigh = 0, upAndLow = 0, dnAndHigh = 0, dnAndLow = 0;
  for (const w of wRes.rows) {
    const ep = parseInt(w.epoch);
    const entryTime = new Date(ep * 1000 - 2000);
    const cR = await pool.query(`
      SELECT best_ask FROM clob_price_snapshots
      WHERE symbol = 'btc-down' AND window_epoch = $1 AND timestamp <= $2
      ORDER BY timestamp DESC LIMIT 1
    `, [ep, entryTime]);
    if (cR.rows.length === 0) continue;
    const ask = parseFloat(cR.rows[0].best_ask);
    if (isNaN(ask)) continue;

    if (w.resolved === 'UP' && ask > 0.55) upAndHigh++;
    if (w.resolved === 'UP' && ask <= 0.55) upAndLow++;
    if (w.resolved === 'DOWN' && ask > 0.55) dnAndHigh++;
    if (w.resolved === 'DOWN' && ask <= 0.55) dnAndLow++;
  }

  console.log(`  Resolved UP  + DN ask > $0.55: ${upAndHigh}`);
  console.log(`  Resolved UP  + DN ask ≤ $0.55: ${upAndLow}`);
  console.log(`  Resolved DOWN + DN ask > $0.55: ${dnAndHigh}`);
  console.log(`  Resolved DOWN + DN ask ≤ $0.55: ${dnAndLow}`);
  console.log(`\n  If ${upAndHigh} >> ${dnAndHigh} → btc-down is actually the UP token (INVERTED)`);
  console.log(`  If ${dnAndHigh} >> ${upAndHigh} → btc-down is correctly the DOWN token`);

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
