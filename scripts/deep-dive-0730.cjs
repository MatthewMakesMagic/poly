const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 60000 });

async function run() {
  const windowClose = '2026-02-06T12:30:00Z';
  const finalStart = '2026-02-06T12:29:00Z';
  
  // Query 1: Binance + Chainlink second-by-second with received_at
  const prices = await pool.query(`
    WITH binance AS (
      SELECT date_trunc('second', timestamp) AS sec,
        ROUND(AVG(price::numeric), 2) AS price,
        to_char(MIN(received_at), 'HH24:MI:SS.MS') AS rcv_at
      FROM rtds_ticks
      WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
      GROUP BY 1
    ),
    chainlink AS (
      SELECT date_trunc('second', timestamp) AS sec,
        ROUND(AVG(price::numeric), 2) AS price,
        to_char(MIN(received_at), 'HH24:MI:SS.MS') AS rcv_at
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
      GROUP BY 1
    )
    SELECT 
      to_char(b.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      b.price AS bin_price,
      c.price AS cl_price,
      ROUND((b.price - c.price)::numeric, 2) AS spread,
      b.price - LAG(b.price) OVER (ORDER BY b.sec) AS bin_move,
      c.price - LAG(c.price) OVER (ORDER BY c.sec) AS cl_move,
      b.rcv_at AS bin_rcv,
      c.rcv_at AS cl_rcv
    FROM binance b
    LEFT JOIN chainlink c ON b.sec = c.sec
    ORDER BY b.sec
  `, [finalStart, windowClose]);
  
  console.log("=== 07:30 ET WINDOW: FINAL 60 SECONDS — PRICE FEEDS ===\n");
  console.log("TIME_ET    BIN_PRICE   CL_PRICE   SPREAD   BIN_MOVE  CL_MOVE   BIN_RCV         CL_RCV");
  console.log("-".repeat(110));
  for (const r of prices.rows) {
    const bm = r.bin_move ? (r.bin_move > 0 ? "+" : "") + parseFloat(r.bin_move).toFixed(0) : "---";
    const cm = r.cl_move ? (r.cl_move > 0 ? "+" : "") + parseFloat(r.cl_move).toFixed(0) : "---";
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.bin_price).padEnd(12) +
      String(r.cl_price || "---").padEnd(11) +
      String(r.spread || "---").padEnd(9) +
      String(bm).padEnd(10) +
      String(cm).padEnd(10) +
      String(r.bin_rcv || "---").padEnd(16) +
      String(r.cl_rcv || "---")
    );
  }

  // Query 2: CLOB mid_price second-by-second
  const clob = await pool.query(`
    SELECT 
      to_char(date_trunc('second', timestamp) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(AVG(CASE WHEN symbol = 'btc-up' THEN mid_price END)::numeric, 4) AS up_mid,
      ROUND(AVG(CASE WHEN symbol = 'btc-down' THEN mid_price END)::numeric, 4) AS dn_mid,
      ROUND(AVG(CASE WHEN symbol = 'btc-up' THEN best_ask - best_bid END)::numeric, 4) AS up_spread,
      COUNT(*) AS snaps
    FROM clob_price_snapshots
    WHERE symbol IN ('btc-up', 'btc-down')
      AND mid_price IS NOT NULL
      AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
    GROUP BY 1
    ORDER BY 1
  `, [finalStart, windowClose]);
  
  console.log("\n\n=== 07:30 ET WINDOW: FINAL 60 SECONDS — CLOB ===\n");
  console.log("TIME_ET    UP_MID    DN_MID    UP_SPREAD  SNAPS");
  console.log("-".repeat(60));
  for (const r of clob.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.up_mid || "---").padEnd(10) +
      String(r.dn_mid || "---").padEnd(10) +
      String(r.up_spread || "---").padEnd(11) +
      r.snaps
    );
  }

  // Query 3: L2 order book depth
  const l2 = await pool.query(`
    SELECT
      to_char(date_trunc('second', timestamp) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(SUM(CASE WHEN symbol = 'btc-up' AND side = 'ask' THEN size ELSE 0 END)::numeric, 0) AS up_ask_depth,
      ROUND(SUM(CASE WHEN symbol = 'btc-up' AND side = 'bid' THEN size ELSE 0 END)::numeric, 0) AS up_bid_depth,
      ROUND(SUM(CASE WHEN symbol = 'btc-down' AND side = 'ask' THEN size ELSE 0 END)::numeric, 0) AS dn_ask_depth,
      ROUND(SUM(CASE WHEN symbol = 'btc-down' AND side = 'bid' THEN size ELSE 0 END)::numeric, 0) AS dn_bid_depth
    FROM order_book_levels
    WHERE symbol IN ('btc-up', 'btc-down')
      AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
    GROUP BY 1
    ORDER BY 1
  `, [finalStart, windowClose]);
  
  console.log("\n\n=== 07:30 ET WINDOW: FINAL 60 SECONDS — L2 DEPTH ===\n");
  console.log("TIME_ET    UP_ASK     UP_BID     DN_ASK     DN_BID");
  console.log("-".repeat(60));
  for (const r of l2.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.up_ask_depth).padEnd(11) +
      String(r.up_bid_depth).padEnd(11) +
      String(r.dn_ask_depth).padEnd(11) +
      r.dn_bid_depth
    );
  }

  // Query 4: The critical moment - what was BTC price doing at T-10 to T-0?
  const threshold = await pool.query(`
    WITH binance AS (
      SELECT date_trunc('second', timestamp) AS sec,
        AVG(price::numeric) AS price
      FROM rtds_ticks
      WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND $1::timestamptz
      GROUP BY 1
    ),
    window_open AS (
      SELECT AVG(price) AS open_price
      FROM binance
      WHERE sec BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND ($1::timestamptz - INTERVAL '14 minutes 50 seconds')
    )
    SELECT 
      to_char(b.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(b.price::numeric, 2) AS bin_price,
      ROUND(wo.open_price::numeric, 2) AS window_open_price,
      ROUND((b.price - wo.open_price)::numeric, 2) AS move_from_open,
      CASE WHEN b.price > wo.open_price THEN 'UP' ELSE 'DOWN' END AS direction
    FROM binance b, window_open wo
    WHERE b.sec BETWEEN ($1::timestamptz - INTERVAL '10 seconds') AND $1::timestamptz
    ORDER BY b.sec
  `, [windowClose]);
  
  console.log("\n\n=== 07:30 ET: THRESHOLD ANALYSIS (final 10s) ===\n");
  console.log("Is BTC above or below the window-open price? This determines UP/DOWN resolution.\n");
  console.log("TIME_ET    BIN_PRICE   OPEN_PRICE  MOVE      DIRECTION");
  console.log("-".repeat(65));
  for (const r of threshold.rows) {
    const marker = r.direction === 'UP' ? '  <-- UP' : '  <-- DOWN';
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.bin_price).padEnd(12) +
      String(r.window_open_price).padEnd(12) +
      String(r.move_from_open).padEnd(10) +
      r.direction + marker
    );
  }

  // Query 5: What did Chainlink show vs Binance at those same moments?
  const clThreshold = await pool.query(`
    WITH chainlink AS (
      SELECT date_trunc('second', timestamp) AS sec,
        AVG(price::numeric) AS price
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND $1::timestamptz
      GROUP BY 1
    ),
    cl_open AS (
      SELECT AVG(price) AS open_price
      FROM chainlink
      WHERE sec BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND ($1::timestamptz - INTERVAL '14 minutes 50 seconds')
    )
    SELECT 
      to_char(c.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(c.price::numeric, 2) AS cl_price,
      ROUND(co.open_price::numeric, 2) AS cl_open_price,
      ROUND((c.price - co.open_price)::numeric, 2) AS cl_move,
      CASE WHEN c.price > co.open_price THEN 'UP' ELSE 'DOWN' END AS cl_direction
    FROM chainlink c, cl_open co
    WHERE c.sec BETWEEN ($1::timestamptz - INTERVAL '10 seconds') AND $1::timestamptz
    ORDER BY c.sec
  `, [windowClose]);
  
  console.log("\n\n=== 07:30 ET: CHAINLINK THRESHOLD (final 10s) ===\n");
  console.log("What does the SETTLEMENT oracle say? This is what actually resolves the market.\n");
  console.log("TIME_ET    CL_PRICE    CL_OPEN     CL_MOVE   CL_DIRECTION");
  console.log("-".repeat(65));
  for (const r of clThreshold.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.cl_price).padEnd(12) +
      String(r.cl_open_price).padEnd(12) +
      String(r.cl_move).padEnd(10) +
      r.cl_direction
    );
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
