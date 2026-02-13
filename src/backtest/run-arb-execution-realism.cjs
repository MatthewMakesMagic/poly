/**
 * Settlement Arb — Execution Depth at T-10s and T-2s, all instruments
 * BTC uses Chainlink, ETH/SOL use Pyth for oracle signal
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

async function main() {
  const wRes = await pool.query(`
    SELECT window_close_time, symbol, strike_price, resolved_direction
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND strike_price > 0
      AND resolved_direction IS NOT NULL
      AND symbol IN ('btc', 'eth', 'sol')
    ORDER BY symbol, window_close_time
  `);
  console.log(`\n  ${wRes.rows.length} resolved windows total\n`);

  for (const secBefore of [10, 2]) {
    console.log(`${'═'.repeat(95)}`);
    console.log(`  T-${secBefore}s ENTRY — CLOB DEPTH ON SETTLING WINDOW'S DOWN TOKEN`);
    console.log(`${'═'.repeat(95)}`);

    for (const inst of ['btc', 'eth', 'sol']) {
      const instWins = wRes.rows.filter(r => r.symbol === inst);
      if (instWins.length === 0) continue;

      const oracleTopic = inst === 'btc' ? 'crypto_prices_chainlink' : 'crypto_prices_pyth';
      const trades = [];

      for (const w of instWins) {
        const closeMs = new Date(w.window_close_time).getTime();
        const epoch = Math.round(closeMs / 1000);
        const entryTime = new Date(closeMs - secBefore * 1000);
        const strike = parseFloat(w.strike_price);

        // Oracle at entry
        const oR = await pool.query(`
          SELECT price FROM rtds_ticks
          WHERE topic = $1 AND symbol = $2 AND timestamp <= $3
          ORDER BY timestamp DESC LIMIT 1
        `, [oracleTopic, inst, entryTime]);
        if (oR.rows.length === 0) continue;
        const oracle = parseFloat(oR.rows[0].price);
        if (oracle >= strike) continue;

        // CLOB at entry (correct window)
        const cR = await pool.query(`
          SELECT best_ask, ask_size_top, best_bid, bid_size_top
          FROM clob_price_snapshots
          WHERE symbol = $1 AND window_epoch = $2 AND timestamp <= $3
            AND timestamp >= to_timestamp($2)
          ORDER BY timestamp DESC LIMIT 1
        `, [`${inst}-down`, epoch, entryTime]);
        if (cR.rows.length === 0) continue;

        const ask = cR.rows[0].best_ask != null ? parseFloat(cR.rows[0].best_ask) : null;
        const askSz = cR.rows[0].ask_size_top != null ? parseFloat(cR.rows[0].ask_size_top) : null;
        const bidSz = cR.rows[0].bid_size_top != null ? parseFloat(cR.rows[0].bid_size_top) : null;
        if (ask == null || isNaN(ask)) continue;

        const won = w.resolved_direction.toUpperCase() === 'DOWN';
        trades.push({
          time: w.window_close_time, ask, askSz, bidSz, won,
          deficit: strike - oracle, strike, oracle
        });
      }

      if (trades.length === 0) {
        console.log(`\n  ── ${inst.toUpperCase()} │ 0 arb windows ──`);
        continue;
      }

      const wins = trades.filter(t => t.won).length;
      const sizes = trades.map(t => t.askSz).filter(s => s != null).sort((a, b) => a - b);
      const asks = trades.map(t => t.ask).sort((a, b) => a - b);
      const med = arr => arr[Math.floor(arr.length / 2)];
      const totalDol = trades.reduce((s, t) => s + (t.ask || 0) * (t.askSz || 0), 0);

      console.log(`\n  ── ${inst.toUpperCase()} │ ${trades.length} trades │ ${wins}W ${trades.length - wins}L │ ${(wins/trades.length*100).toFixed(0)}% win rate ──`);
      console.log(`  DN Ask:  Min $${asks[0].toFixed(3)}  Med $${med(asks).toFixed(3)}  Max $${asks[asks.length-1].toFixed(3)}`);
      if (sizes.length) console.log(`  L1 Size: Min ${sizes[0].toFixed(0)}  Med ${med(sizes).toFixed(0)}  Max ${sizes[sizes.length-1].toFixed(0)} tokens`);
      console.log(`  Total $ across all: $${totalDol.toFixed(0)}   Avg $/trade: $${(totalDol/trades.length).toFixed(0)}`);

      console.log(`\n  Time (ET)           │ DN Ask │ Ask Sz │ Bid Sz │  $@L1  │ Deficit │ Res`);
      console.log(`  ${'─'.repeat(80)}`);
      for (const t of trades) {
        const et = new Date(t.time).toLocaleString('en-US', {
          timeZone: 'America/New_York', month: 'short', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
        const dol = (t.ask && t.askSz) ? '$' + (t.ask * t.askSz).toFixed(0) : '-';
        console.log(`  ${et.padEnd(21)} │ $${t.ask.toFixed(3)} │ ${(t.askSz||0).toFixed(0).padStart(6)} │ ${(t.bidSz||0).toFixed(0).padStart(6)} │ ${dol.padStart(6)} │ $${t.deficit.toFixed(0).padStart(5)} │ ${t.won ? 'WIN ' : 'LOSS'}`);
      }
    }
    console.log();
  }
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
