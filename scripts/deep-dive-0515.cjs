const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 60000 });

async function run() {
  const windowClose = '2026-02-06T10:15:00Z';
  const finalStart = '2026-02-06T10:14:00Z';
  const windowOpen = '2026-02-06T10:00:00Z';
  
  // Query 1: Binance + Chainlink second-by-second final 60s
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
  
  console.log("=== 05:15 ET WINDOW: FINAL 60 SECONDS — PRICE FEEDS ===\n");
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

  // Query 2: CLOB second-by-second
  const clob = await pool.query(`
    SELECT 
      to_char(date_trunc('second', timestamp) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(AVG(CASE WHEN symbol = 'btc-up' THEN mid_price END)::numeric, 4) AS up_mid,
      ROUND(AVG(CASE WHEN symbol = 'btc-down' THEN mid_price END)::numeric, 4) AS dn_mid,
      ROUND(AVG(CASE WHEN symbol = 'btc-up' THEN best_ask - best_bid END)::numeric, 4) AS up_spread
    FROM clob_price_snapshots
    WHERE symbol IN ('btc-up', 'btc-down')
      AND mid_price IS NOT NULL
      AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
    GROUP BY 1
    ORDER BY 1
  `, [finalStart, windowClose]);
  
  console.log("\n\n=== 05:15 ET WINDOW: FINAL 60 SECONDS — CLOB ===\n");
  console.log("TIME_ET    UP_MID    DN_MID    UP_SPREAD");
  console.log("-".repeat(45));
  for (const r of clob.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.up_mid || "---").padEnd(10) +
      String(r.dn_mid || "---").padEnd(10) +
      String(r.up_spread || "---")
    );
  }

  // Query 3: Threshold analysis - was BTC crossing the open price?
  const threshold = await pool.query(`
    WITH binance AS (
      SELECT date_trunc('second', timestamp) AS sec,
        AVG(price::numeric) AS price
      FROM rtds_ticks
      WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
      GROUP BY 1
    ),
    window_open AS (
      SELECT AVG(price) AS open_price
      FROM (
        SELECT AVG(price::numeric) AS price
        FROM rtds_ticks
        WHERE topic = 'crypto_prices' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '10 seconds')
      ) sub
    ),
    chainlink AS (
      SELECT date_trunc('second', timestamp) AS sec,
        AVG(price::numeric) AS price
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
      GROUP BY 1
    ),
    cl_open AS (
      SELECT AVG(price) AS open_price
      FROM (
        SELECT AVG(price::numeric) AS price
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '10 seconds')
      ) sub
    )
    SELECT 
      to_char(b.sec AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(b.price::numeric, 2) AS bin_price,
      ROUND(wo.open_price::numeric, 2) AS bin_open,
      ROUND((b.price - wo.open_price)::numeric, 2) AS bin_vs_open,
      CASE WHEN b.price > wo.open_price THEN 'UP' ELSE 'DOWN' END AS bin_dir,
      ROUND(c.price::numeric, 2) AS cl_price,
      ROUND(co.open_price::numeric, 2) AS cl_open,
      ROUND((c.price - co.open_price)::numeric, 2) AS cl_vs_open,
      CASE WHEN c.price > co.open_price THEN 'UP' ELSE 'DOWN' END AS cl_dir
    FROM binance b
    CROSS JOIN window_open wo
    CROSS JOIN cl_open co
    LEFT JOIN chainlink c ON c.sec = b.sec
    WHERE b.sec BETWEEN ($2::timestamptz - INTERVAL '30 seconds') AND $2::timestamptz
    ORDER BY b.sec
  `, [windowOpen, windowClose]);
  
  console.log("\n\n=== 05:15 ET: THRESHOLD ANALYSIS (final 30s) ===\n");
  console.log("Did BTC cross the window-open price? Binance vs Chainlink direction.\n");
  console.log("TIME_ET    BIN_PRICE  BIN_OPEN  BIN_VS    BIN_DIR  CL_PRICE  CL_OPEN   CL_VS     CL_DIR");
  console.log("-".repeat(100));
  for (const r of threshold.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.bin_price).padEnd(11) +
      String(r.bin_open).padEnd(10) +
      String(r.bin_vs_open).padEnd(10) +
      String(r.bin_dir).padEnd(9) +
      String(r.cl_price || "---").padEnd(10) +
      String(r.cl_open || "---").padEnd(10) +
      String(r.cl_vs_open || "---").padEnd(10) +
      String(r.cl_dir || "---")
    );
  }

  // Query 4: L2 depth final 60s (column is "size" not "quantity")
  const l2 = await pool.query(`
    SELECT
      to_char(date_trunc('second', timestamp) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS time_et,
      ROUND(SUM(CASE WHEN symbol = 'btc-up' AND side = 'ask' THEN size ELSE 0 END)::numeric, 0) AS up_ask,
      ROUND(SUM(CASE WHEN symbol = 'btc-up' AND side = 'bid' THEN size ELSE 0 END)::numeric, 0) AS up_bid
    FROM order_book_levels
    WHERE symbol = 'btc-up'
      AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
    GROUP BY 1
    ORDER BY 1
  `, [finalStart, windowClose]);
  
  console.log("\n\n=== 05:15 ET: L2 DEPTH (final 60s) ===\n");
  console.log("TIME_ET    UP_ASK     UP_BID");
  console.log("-".repeat(35));
  for (const r of l2.rows) {
    console.log(
      String(r.time_et).padEnd(11) +
      String(r.up_ask).padEnd(11) +
      r.up_bid
    );
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
