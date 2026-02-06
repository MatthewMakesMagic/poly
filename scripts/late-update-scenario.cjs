const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 60000 });

async function run() {
  const strike = 66414.94;
  
  // PART 1: Final 15 seconds of 07:30 window — ALL feeds at sub-second precision
  // Show received_at timestamps to understand exact arrival timing
  console.log("=== 07:30 ET: FINAL 15 SECONDS — EVERY TICK WITH received_at ===\n");
  console.log("Strike: $" + strike.toFixed(2) + "\n");
  console.log("For Chainlink to resolve UP, it needs a single tick ABOVE $" + strike.toFixed(2) + " at the close boundary.\n");
  
  const ticks = await pool.query(`
    SELECT 
      topic,
      to_char(timestamp AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      to_char(received_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS.MS') AS received_et,
      ROUND(price::numeric, 2) AS price,
      ROUND((price::numeric - $1), 2) AS vs_strike,
      CASE WHEN price::numeric > $1 THEN 'UP' ELSE 'DOWN' END AS vs_strike_dir
    FROM rtds_ticks
    WHERE symbol = 'btc'
      AND topic IN ('crypto_prices', 'crypto_prices_chainlink')
      AND timestamp BETWEEN '2026-02-06T12:29:45Z' AND '2026-02-06T12:30:01Z'
    ORDER BY received_at, timestamp
  `, [strike]);
  
  console.log("TOPIC                      TIME_ET    RECEIVED_ET        PRICE        vs_STRIKE     DIR");
  console.log("-".repeat(100));
  
  for (const r of ticks.rows) {
    const topicShort = r.topic === 'crypto_prices' ? 'polymarket_ref' : 'chainlink    ';
    const marker = r.topic === 'crypto_prices_chainlink' && parseFloat(r.vs_strike) > 0 ? " <<<< WOULD RESOLVE UP" : "";
    console.log(
      String(topicShort).padEnd(27) +
      String(r.time_et).padEnd(11) +
      String(r.received_et || "---").padEnd(19) +
      ("$" + r.price).padEnd(13) +
      (parseFloat(r.vs_strike) >= 0 ? "+" : "") + r.vs_strike + "".padEnd(14 - String(r.vs_strike).length) +
      r.vs_strike_dir +
      marker
    );
  }

  // PART 2: What was the MAXIMUM Chainlink tick in the final 30 seconds?
  console.log("\n\n=== CHAINLINK HIGH-WATER MARK (final 30s) ===\n");
  
  const maxCl = await pool.query(`
    SELECT 
      to_char(timestamp AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      to_char(received_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS.MS') AS received_et,
      ROUND(price::numeric, 2) AS price,
      ROUND((price::numeric - $1), 2) AS vs_strike
    FROM rtds_ticks
    WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
      AND timestamp BETWEEN '2026-02-06T12:29:30Z' AND '2026-02-06T12:30:01Z'
    ORDER BY price DESC
    LIMIT 5
  `, [strike]);
  
  console.log("Top 5 Chainlink ticks by price in final 30 seconds:");
  console.log("Strike to beat: $" + strike.toFixed(2) + "\n");
  for (const r of maxCl.rows) {
    console.log("  " + r.time_et + " (rcv " + (r.received_et || "---") + "): $" + r.price + " (vs strike: " + (parseFloat(r.vs_strike) >= 0 ? "+" : "") + r.vs_strike + ")");
  }

  // PART 3: What would Chainlink have needed?
  console.log("\n\n=== WHAT WOULD HAVE BEEN NEEDED? ===\n");
  
  // Chainlink's highest was ~66,323. Strike is 66,414.94. Gap is ~$92.
  // For a single Chainlink update to bridge that gap, the underlying spot would need to spike $92+
  // What was the biggest single-tick Chainlink move in the entire dataset?
  const bigMoves = await pool.query(`
    WITH cl_ticks AS (
      SELECT timestamp, price::numeric AS price,
        price::numeric - LAG(price::numeric) OVER (ORDER BY timestamp, received_at) AS move
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND received_at IS NOT NULL
      ORDER BY timestamp, received_at
    )
    SELECT 
      ROUND(MAX(ABS(move))::numeric, 2) AS biggest_single_tick_move,
      ROUND(MAX(move)::numeric, 2) AS biggest_up_move,
      ROUND(MIN(move)::numeric, 2) AS biggest_down_move,
      ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ABS(move)))::numeric, 2) AS p99_abs_move,
      ROUND((PERCENTILE_CONT(0.999) WITHIN GROUP (ORDER BY ABS(move)))::numeric, 2) AS p999_abs_move
    FROM cl_ticks
    WHERE move IS NOT NULL
  `);
  
  console.log("Chainlink single-tick move distribution (entire dataset):");
  console.table(bigMoves.rows);
  
  const deficit = (strike - 66323.65).toFixed(2);
  console.log("\nChainlink's best price in final 30s: $66,323.65");
  console.log("Strike: $" + strike.toFixed(2));
  console.log("Deficit to overcome: $" + deficit);
  console.log("\nCould a single Chainlink update have bridged $" + deficit + "?");
  if (bigMoves.rows[0]) {
    const biggest = parseFloat(bigMoves.rows[0].biggest_up_move);
    console.log("Biggest single Chainlink up-move in entire dataset: $" + biggest.toFixed(2));
    if (biggest >= parseFloat(deficit)) {
      console.log("YES — it's theoretically possible (but would be the biggest move in the dataset)");
    } else {
      console.log("NO — the biggest up-move ($" + biggest.toFixed(2) + ") is less than the deficit ($" + deficit + ")");
    }
  }

  // PART 4: The real question — what was the Polymarket ref doing?
  // If the ref was near the strike, CLOB participants might have been rational
  console.log("\n\n=== POLYMARKET REF vs STRIKE (final 15s) ===\n");
  console.log("Was the ref price near the strike? If so, CLOB participants were watching the WRONG instrument.\n");
  
  const refVsStrike = await pool.query(`
    SELECT 
      to_char(timestamp AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(price::numeric, 2) AS ref_price,
      ROUND((price::numeric - $1), 2) AS ref_vs_strike,
      CASE WHEN price::numeric > $1 THEN 'ABOVE' ELSE 'BELOW' END AS ref_position
    FROM rtds_ticks
    WHERE topic = 'crypto_prices' AND symbol = 'btc'
      AND timestamp BETWEEN '2026-02-06T12:29:45Z' AND '2026-02-06T12:30:01Z'
    ORDER BY timestamp
  `, [strike]);
  
  for (const r of refVsStrike.rows) {
    const marker = r.ref_position === 'ABOVE' ? " ← ref above strike (CLOB thinks UP)" : "";
    console.log(
      r.time_et + ": ref=$" + r.ref_price + 
      " (vs strike: " + (parseFloat(r.ref_vs_strike) >= 0 ? "+" : "") + r.ref_vs_strike + ") " + 
      r.ref_position + marker
    );
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
