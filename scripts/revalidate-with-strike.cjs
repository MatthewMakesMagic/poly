const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 90000 });

async function run() {
  // First, get all BTC window_close_events with strikes
  console.log("=== ALL BTC WINDOW CLOSE EVENTS WITH STRIKES ===\n");
  
  const events = await pool.query(`
    SELECT 
      to_char(window_close_time AT TIME ZONE 'America/New_York', 'HH24:MI') AS close_et,
      window_close_time,
      strike_price,
      oracle_price_at_close,
      chainlink_price_at_close,
      binance_price_at_close,
      resolved_direction,
      window_id
    FROM window_close_events
    WHERE strike_price IS NOT NULL
    ORDER BY window_close_time DESC
    LIMIT 40
  `);
  
  console.log("Found " + events.rows.length + " events\n");
  console.log("CLOSE_ET  STRIKE         ORACLE_CLOSE    CL_CLOSE        BIN_CLOSE       CL_vs_STRIKE   RESOLVED   WINDOW_ID");
  console.log("-".repeat(140));
  
  for (const r of events.rows) {
    const strike = parseFloat(r.strike_price);
    const oClose = r.oracle_price_at_close ? parseFloat(r.oracle_price_at_close) : null;
    const clClose = r.chainlink_price_at_close ? parseFloat(r.chainlink_price_at_close) : null;
    const binClose = r.binance_price_at_close ? parseFloat(r.binance_price_at_close) : null;
    
    const clVsStrike = clClose ? (clClose - strike).toFixed(2) : "---";
    const computedDir = clClose ? (clClose > strike ? "UP" : "DOWN") : "---";
    
    console.log(
      String(r.close_et).padEnd(10) +
      ("$" + strike.toFixed(2)).padEnd(15) +
      (oClose ? "$" + oClose.toFixed(2) : "---").padEnd(16) +
      (clClose ? "$" + clClose.toFixed(2) : "---").padEnd(16) +
      (binClose ? "$" + binClose.toFixed(2) : "---").padEnd(16) +
      ("$" + clVsStrike).padEnd(15) +
      String(r.resolved_direction || computedDir).padEnd(11) +
      String(r.window_id || "---").substring(0, 40)
    );
  }

  // Now for each of the contested windows, reconstruct the final 30s using ACTUAL strike
  const contestedWindows = [];
  
  // Find windows near 07:30, 05:15, 06:15 ET
  for (const r of events.rows) {
    const closeET = r.close_et;
    if (['07:30', '05:15', '06:15', '07:15', '04:30', '03:00'].includes(closeET)) {
      contestedWindows.push({
        closeET,
        closeTime: r.window_close_time,
        strike: parseFloat(r.strike_price),
        windowId: r.window_id,
        clClose: r.chainlink_price_at_close ? parseFloat(r.chainlink_price_at_close) : null,
        resolved: r.resolved_direction,
      });
    }
  }
  
  console.log("\n\n=== CONTESTED WINDOWS: FINAL 30s vs ACTUAL STRIKE ===\n");
  
  for (const w of contestedWindows) {
    console.log("\n--- " + w.closeET + " ET (Strike: $" + w.strike.toFixed(2) + ", CL Close: $" + (w.clClose ? w.clClose.toFixed(2) : "---") + ", Resolved: " + (w.resolved || "---") + ") ---\n");
    
    const closeTime = new Date(w.closeTime);
    const start30s = new Date(closeTime.getTime() - 30 * 1000);
    
    // Get Chainlink price, Polymarket ref price, and CLOB mid per second
    const data = await pool.query(`
      WITH ref_prices AS (
        SELECT date_trunc('second', timestamp) AS sec,
          ROUND(AVG(price::numeric), 2) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      cl_prices AS (
        SELECT date_trunc('second', timestamp) AS sec,
          ROUND(AVG(price::numeric), 2) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      clob AS (
        SELECT date_trunc('second', timestamp) AS sec,
          ROUND(AVG(CASE WHEN symbol = 'btc-up' THEN mid_price END)::numeric, 4) AS up_mid
        FROM clob_price_snapshots
        WHERE symbol = 'btc-up' AND mid_price IS NOT NULL
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      )
      SELECT 
        to_char(r.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
        r.price AS ref_price,
        c.price AS cl_price,
        ROUND((c.price - $3)::numeric, 2) AS cl_vs_strike,
        CASE WHEN c.price > $3 THEN 'UP' ELSE 'DOWN' END AS cl_says,
        ROUND((r.price - $3)::numeric, 2) AS ref_vs_strike,
        CASE WHEN r.price > $3 THEN 'UP' ELSE 'DOWN' END AS ref_says,
        cb.up_mid AS clob_up_mid,
        CASE WHEN cb.up_mid > 0.5 THEN 'UP' ELSE 'DOWN' END AS clob_says
      FROM ref_prices r
      LEFT JOIN cl_prices c ON r.sec = c.sec
      LEFT JOIN clob cb ON r.sec = cb.sec
      ORDER BY r.sec
    `, [start30s.toISOString(), closeTime.toISOString(), w.strike]);
    
    console.log("TIME_ET    REF_PRICE   CL_PRICE    CL_vs_STRIKE  CL_SAYS  REF_vs_STRIKE  REF_SAYS  CLOB_UP   CLOB_SAYS");
    console.log("-".repeat(110));
    
    for (const r of data.rows) {
      const marker = (r.cl_says !== r.clob_says) ? " <<< DISAGREE" : "";
      console.log(
        String(r.time_et).padEnd(11) +
        String(r.ref_price).padEnd(12) +
        String(r.cl_price || "---").padEnd(12) +
        String(r.cl_vs_strike || "---").padEnd(14) +
        String(r.cl_says || "---").padEnd(9) +
        String(r.ref_vs_strike).padEnd(15) +
        String(r.ref_says).padEnd(10) +
        String(r.clob_up_mid || "---").padEnd(10) +
        String(r.clob_says || "---") +
        marker
      );
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
