const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 90000 });

async function run() {
  // PART 1: What exchanges do we have in exchange_ticks?
  console.log("=== PART 1: EXCHANGE TICKS INVENTORY ===\n");
  
  const exchanges = await pool.query(`
    SELECT exchange, symbol, COUNT(*) AS ticks, 
      MIN(timestamp) AS earliest, MAX(timestamp) AS latest
    FROM exchange_ticks
    WHERE symbol ILIKE '%btc%'
    GROUP BY exchange, symbol
    ORDER BY exchange, symbol
  `);
  console.table(exchanges.rows);

  // PART 2: Side-by-side comparison - RTDS crypto_prices vs actual Binance exchange ticks
  // Pick a recent 60-second window where we have both
  console.log("\n\n=== PART 2: RTDS 'crypto_prices' vs ACTUAL BINANCE EXCHANGE TICKS ===\n");
  console.log("Are they the same price? Or different?\n");
  
  // Find a recent period where we have both
  const overlap = await pool.query(`
    SELECT MAX(e.timestamp) AS latest_exchange
    FROM exchange_ticks e 
    WHERE e.exchange = 'binance' AND e.symbol ILIKE '%btc%'
  `);
  
  if (overlap.rows[0]?.latest_exchange) {
    const endTime = new Date(overlap.rows[0].latest_exchange);
    const startTime = new Date(endTime.getTime() - 60 * 1000);
    
    console.log("Comparing period: " + startTime.toISOString() + " to " + endTime.toISOString());
    
    const comparison = await pool.query(`
      WITH rtds AS (
        SELECT date_trunc('second', timestamp) AS sec,
          ROUND(AVG(price::numeric), 2) AS rtds_price
        FROM rtds_ticks 
        WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      binance_actual AS (
        SELECT date_trunc('second', timestamp) AS sec,
          ROUND(AVG(price::numeric), 2) AS binance_price
        FROM exchange_ticks
        WHERE exchange = 'binance' AND symbol ILIKE '%btc%'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      )
      SELECT 
        to_char(r.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
        r.rtds_price AS rtds_crypto_prices,
        b.binance_price AS actual_binance,
        ROUND((r.rtds_price - b.binance_price)::numeric, 2) AS difference
      FROM rtds r
      LEFT JOIN binance_actual b ON r.sec = b.sec
      ORDER BY r.sec
      LIMIT 30
    `, [startTime.toISOString(), endTime.toISOString()]);
    
    console.log("\nTIME_ET    RTDS_CRYPTO_PRICES  ACTUAL_BINANCE  DIFFERENCE");
    console.log("-".repeat(65));
    for (const r of comparison.rows) {
      console.log(
        String(r.time_et).padEnd(11) +
        String(r.rtds_crypto_prices).padEnd(20) +
        String(r.actual_binance || "---").padEnd(16) +
        String(r.difference || "---")
      );
    }
    
    // Summary stats
    const diffStats = await pool.query(`
      WITH rtds AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      binance_actual AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM exchange_ticks WHERE exchange = 'binance' AND symbol ILIKE '%btc%'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      )
      SELECT 
        COUNT(*) AS paired_seconds,
        ROUND(AVG(ABS(r.price - b.price))::numeric, 2) AS avg_abs_diff,
        ROUND(MAX(ABS(r.price - b.price))::numeric, 2) AS max_abs_diff,
        ROUND(AVG(r.price - b.price)::numeric, 2) AS avg_signed_diff,
        ROUND(STDDEV(r.price - b.price)::numeric, 2) AS stddev_diff
      FROM rtds r JOIN binance_actual b ON r.sec = b.sec
    `, [startTime.toISOString(), endTime.toISOString()]);
    
    console.log("\nSummary: RTDS crypto_prices vs actual Binance exchange ticks:");
    console.table(diffStats.rows);
  } else {
    console.log("No Binance exchange ticks found!");
  }

  // PART 3: Compare RTDS crypto_prices vs RTDS crypto_prices_chainlink vs all exchanges
  // at a single point in time to see where each sits
  console.log("\n\n=== PART 3: ALL FEEDS COMPARISON (recent 60s) ===\n");
  
  const recentComparison = await pool.query(`
    WITH recent_rtds_cp AS (
      SELECT ROUND(AVG(price::numeric), 2) AS price
      FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
      AND timestamp > NOW() - INTERVAL '60 seconds'
    ),
    recent_rtds_cl AS (
      SELECT ROUND(AVG(price::numeric), 2) AS price
      FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
      AND timestamp > NOW() - INTERVAL '60 seconds'
    ),
    recent_exchanges AS (
      SELECT exchange, ROUND(AVG(price::numeric), 2) AS price
      FROM exchange_ticks WHERE symbol ILIKE '%btc%'
      AND timestamp > NOW() - INTERVAL '60 seconds'
      GROUP BY exchange
    )
    SELECT 'RTDS crypto_prices' AS source, price FROM recent_rtds_cp WHERE price IS NOT NULL
    UNION ALL
    SELECT 'RTDS crypto_prices_chainlink' AS source, price FROM recent_rtds_cl WHERE price IS NOT NULL
    UNION ALL
    SELECT 'Exchange: ' || exchange AS source, price FROM recent_exchanges
    ORDER BY price DESC
  `);
  
  console.log("Current BTC prices from all sources:");
  console.table(recentComparison.rows);

  // PART 4: Now the critical question - compare strike to RTDS crypto_prices at window OPEN
  console.log("\n\n=== PART 4: STRIKE vs ALL FEEDS AT WINDOW OPEN ===\n");
  console.log("Comparing strike to every feed at the moment the window opened.\n");
  
  const strikes = await pool.query(`
    SELECT window_close_time, strike_price
    FROM window_close_events 
    WHERE strike_price IS NOT NULL
    ORDER BY window_close_time DESC 
    LIMIT 20
  `);
  
  console.log("CLOSE_ET    STRIKE         RTDS_CP_OPEN    RTDS_CL_OPEN    CP_DIFF     CL_DIFF     CLOSEST");
  console.log("-".repeat(110));
  
  let cpCloser = 0, clCloser = 0;
  
  for (const s of strikes.rows) {
    const closeTime = new Date(s.window_close_time);
    const openTime = new Date(closeTime.getTime() - 15 * 60 * 1000);
    const strike = parseFloat(s.strike_price);
    
    // RTDS crypto_prices at window open
    const cpOpen = await pool.query(`
      SELECT ROUND(AVG(price::numeric), 2) AS p
      FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
      AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
    `, [openTime.toISOString()]);
    
    // RTDS crypto_prices_chainlink at window open
    const clOpen = await pool.query(`
      SELECT ROUND(AVG(price::numeric), 2) AS p
      FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
      AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
    `, [openTime.toISOString()]);
    
    const cp = cpOpen.rows[0]?.p ? parseFloat(cpOpen.rows[0].p) : null;
    const cl = clOpen.rows[0]?.p ? parseFloat(clOpen.rows[0].p) : null;
    
    const cpDiff = cp ? (strike - cp).toFixed(2) : "---";
    const clDiff = cl ? (strike - cl).toFixed(2) : "---";
    
    let closest = "---";
    if (cp && cl) {
      const cpAbs = Math.abs(strike - cp);
      const clAbs = Math.abs(strike - cl);
      if (cpAbs < clAbs) { closest = "RTDS_CP (by $" + (clAbs - cpAbs).toFixed(2) + ")"; cpCloser++; }
      else { closest = "RTDS_CL (by $" + (cpAbs - clAbs).toFixed(2) + ")"; clCloser++; }
    }
    
    const closeET = new Date(closeTime.getTime() - 5*60*60*1000).toISOString().substr(11, 5);
    
    console.log(
      String(closeET).padEnd(12) +
      ("$" + strike.toFixed(2)).padEnd(15) +
      (cp ? "$" + cp.toFixed(2) : "---").padEnd(16) +
      (cl ? "$" + cl.toFixed(2) : "---").padEnd(16) +
      ("$" + cpDiff).padEnd(12) +
      ("$" + clDiff).padEnd(12) +
      closest
    );
  }
  
  console.log("\n\nRTDS crypto_prices closer: " + cpCloser + " / " + (cpCloser + clCloser));
  console.log("RTDS crypto_prices_chainlink closer: " + clCloser + " / " + (cpCloser + clCloser));

  // PART 5: Is RTDS crypto_prices actually Binance, or something else?
  // Compare to all exchanges side by side at window opens
  console.log("\n\n=== PART 5: RTDS crypto_prices vs EACH EXCHANGE AT WINDOW OPENS ===\n");
  
  // Take 5 recent windows
  for (const s of strikes.rows.slice(0, 5)) {
    const closeTime = new Date(s.window_close_time);
    const openTime = new Date(closeTime.getTime() - 15 * 60 * 1000);
    const strike = parseFloat(s.strike_price);
    
    const closeET = new Date(closeTime.getTime() - 5*60*60*1000).toISOString().substr(11, 5);
    
    console.log("\nWindow close " + closeET + " ET (strike=$" + strike.toFixed(2) + "):");
    
    const allFeeds = await pool.query(`
      WITH rtds_cp AS (
        SELECT 'RTDS crypto_prices' AS source, ROUND(AVG(price::numeric), 2) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      ),
      rtds_cl AS (
        SELECT 'RTDS chainlink' AS source, ROUND(AVG(price::numeric), 2) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      ),
      exchanges AS (
        SELECT 'Exchange: ' || exchange AS source, ROUND(AVG(price::numeric), 2) AS price
        FROM exchange_ticks WHERE symbol ILIKE '%btc%'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
        GROUP BY exchange
      ),
      pyth AS (
        SELECT 'Pyth' AS source, ROUND(AVG(price::numeric), 2) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices_pyth' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      )
      SELECT source, price, ROUND((price - $2)::numeric, 2) AS diff_from_strike,
        ROUND(ABS(price - $2)::numeric, 2) AS abs_diff
      FROM (
        SELECT * FROM rtds_cp WHERE price IS NOT NULL
        UNION ALL SELECT * FROM rtds_cl WHERE price IS NOT NULL
        UNION ALL SELECT * FROM exchanges WHERE price IS NOT NULL
        UNION ALL SELECT * FROM pyth WHERE price IS NOT NULL
      ) all_sources
      ORDER BY abs_diff ASC
    `, [openTime.toISOString(), strike]);
    
    if (allFeeds.rows.length > 0) {
      for (const f of allFeeds.rows) {
        const marker = parseFloat(f.abs_diff) < 5 ? " <<<< CLOSEST" : "";
        console.log("  " + String(f.source).padEnd(30) + "$" + String(f.price).padEnd(12) + "diff: $" + f.diff_from_strike + marker);
      }
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
