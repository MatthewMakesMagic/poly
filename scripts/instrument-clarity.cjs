const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 90000 });

async function run() {
  const now = new Date();
  const latestClose = new Date(Math.floor(now.getTime() / (15*60*1000)) * (15*60*1000));
  
  // PART 1: For each of the last 20 windows, show the open prices, close prices,
  // spread at open, spread at close, and whether the spread shift was enough to
  // cause a directional disagreement
  
  console.log("=== PART 1: INSTRUMENT-LEVEL WINDOW ANALYSIS ===\n");
  console.log("For each window: what did EACH feed say about UP/DOWN?\n");
  console.log("CLOSE_ET  BIN_OPEN    CL_OPEN     OFFSET_OPEN  BIN_CLOSE   CL_CLOSE    OFFSET_CL   BIN_DIR  CL_DIR   MATCH  BIN_MARGIN  CL_MARGIN");
  console.log("-".repeat(140));
  
  let disagreements = 0;
  let narrowMargins = 0;
  const allResults = [];
  
  for (let i = 20; i >= 1; i--) {
    const close = new Date(latestClose.getTime() - i * 15 * 60 * 1000);
    const open = new Date(close.getTime() - 15 * 60 * 1000);
    
    const r = await pool.query(`
      WITH binance AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      chainlink AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      bin_open AS (
        SELECT AVG(price) AS p FROM binance WHERE sec BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      ),
      cl_open AS (
        SELECT AVG(price) AS p FROM chainlink WHERE sec BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      ),
      bin_close AS (
        SELECT AVG(price) AS p FROM binance WHERE sec BETWEEN ($2::timestamptz - INTERVAL '3 seconds') AND $2::timestamptz
      ),
      cl_close AS (
        SELECT AVG(price) AS p FROM chainlink WHERE sec BETWEEN ($2::timestamptz - INTERVAL '3 seconds') AND $2::timestamptz
      )
      SELECT
        ROUND(bo.p::numeric, 2) AS bin_open,
        ROUND(co.p::numeric, 2) AS cl_open,
        ROUND((bo.p - co.p)::numeric, 2) AS offset_open,
        ROUND(bc.p::numeric, 2) AS bin_close,
        ROUND(cc.p::numeric, 2) AS cl_close,
        ROUND((bc.p - cc.p)::numeric, 2) AS offset_close,
        CASE WHEN bc.p > bo.p THEN 'UP' ELSE 'DOWN' END AS bin_dir,
        CASE WHEN cc.p > co.p THEN 'UP' ELSE 'DOWN' END AS cl_dir,
        ROUND((bc.p - bo.p)::numeric, 2) AS bin_margin,
        ROUND((cc.p - co.p)::numeric, 2) AS cl_margin
      FROM bin_open bo, cl_open co, bin_close bc, cl_close cc
    `, [open.toISOString(), close.toISOString()]);
    
    const row = r.rows[0];
    if (!row) continue;
    
    const closeET = new Date(close.getTime() - 5*60*60*1000).toISOString().substr(11,5);
    const match = row.bin_dir === row.cl_dir ? "YES" : "NO <<<";
    if (row.bin_dir !== row.cl_dir) disagreements++;
    if (Math.abs(parseFloat(row.cl_margin)) < 50) narrowMargins++;
    
    allResults.push({ closeET, ...row });
    
    console.log(
      String(closeET).padEnd(10) +
      String(row.bin_open).padEnd(12) +
      String(row.cl_open).padEnd(12) +
      String(row.offset_open).padEnd(13) +
      String(row.bin_close).padEnd(12) +
      String(row.cl_close).padEnd(12) +
      String(row.offset_close).padEnd(12) +
      String(row.bin_dir).padEnd(9) +
      String(row.cl_dir).padEnd(9) +
      String(match).padEnd(7) +
      ("$" + row.bin_margin).padEnd(12) +
      "$" + row.cl_margin
    );
  }

  console.log("\n\nDisagreements (Binance says UP, Chainlink says DOWN or vice versa): " + disagreements);
  console.log("Windows where Chainlink margin was < $50 (near-threshold): " + narrowMargins);

  // PART 2: How stable is the offset WITHIN a single window?
  // If offset drifts significantly, a Binance crossing doesn't predict a Chainlink crossing
  
  console.log("\n\n=== PART 2: OFFSET STABILITY WITHIN WINDOWS ===\n");
  console.log("How much does the Binance-Chainlink offset change during a window?\n");
  
  console.log("CLOSE_ET  OFFSET_OPEN  OFFSET_CLOSE  OFFSET_MIN  OFFSET_MAX  OFFSET_RANGE  OFFSET_STDDEV");
  console.log("-".repeat(100));
  
  for (let i = 20; i >= 1; i--) {
    const close = new Date(latestClose.getTime() - i * 15 * 60 * 1000);
    const open = new Date(close.getTime() - 15 * 60 * 1000);
    
    const r = await pool.query(`
      WITH binance AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      chainlink AS (
        SELECT date_trunc('second', timestamp) AS sec, AVG(price::numeric) AS price
        FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
        GROUP BY 1
      ),
      spreads AS (
        SELECT b.sec, (b.price - c.price) AS spread
        FROM binance b JOIN chainlink c ON b.sec = c.sec
      )
      SELECT
        ROUND(MIN(spread)::numeric, 2) AS min_offset,
        ROUND(MAX(spread)::numeric, 2) AS max_offset,
        ROUND((MAX(spread) - MIN(spread))::numeric, 2) AS offset_range,
        ROUND(STDDEV(spread)::numeric, 2) AS offset_stddev,
        ROUND((SELECT spread FROM spreads ORDER BY sec LIMIT 1)::numeric, 2) AS offset_open,
        ROUND((SELECT spread FROM spreads ORDER BY sec DESC LIMIT 1)::numeric, 2) AS offset_close
      FROM spreads
    `, [open.toISOString(), close.toISOString()]);
    
    const row = r.rows[0];
    if (!row) continue;
    const closeET = new Date(close.getTime() - 5*60*60*1000).toISOString().substr(11,5);
    
    console.log(
      String(closeET).padEnd(10) +
      ("$" + row.offset_open).padEnd(13) +
      ("$" + row.offset_close).padEnd(14) +
      ("$" + row.min_offset).padEnd(12) +
      ("$" + row.max_offset).padEnd(12) +
      ("$" + row.offset_range).padEnd(14) +
      "$" + row.offset_stddev
    );
  }

  // PART 3: The key question - in windows where the Chainlink margin was < $50,
  // did the offset shift change the outcome?
  console.log("\n\n=== PART 3: DANGEROUS ZONE — WINDOWS WHERE CL MARGIN < $50 ===\n");
  console.log("These are windows where the offset drift COULD flip the result.\n");
  
  for (const r of allResults) {
    if (Math.abs(parseFloat(r.cl_margin)) < 50) {
      console.log(
        r.closeET + " ET: " +
        "CL margin=$" + r.cl_margin + 
        " | BIN margin=$" + r.bin_margin +
        " | Offset open=$" + r.offset_open +
        " | Offset close=$" + r.offset_close +
        " | Offset shift=$" + (parseFloat(r.offset_close) - parseFloat(r.offset_open)).toFixed(2) +
        " | Both say " + r.cl_dir
      );
    }
  }

  // PART 4: Could the offset shift ever flip the result?
  // i.e. Binance says UP by $X, but the offset shifted by > $X so Chainlink says DOWN
  console.log("\n\n=== PART 4: OFFSET SHIFT vs MARGIN ===\n");
  console.log("If offset_shift > |margin|, the offset drift alone could flip the result.\n");
  
  for (const r of allResults) {
    const offsetShift = Math.abs(parseFloat(r.offset_close) - parseFloat(r.offset_open));
    const binMarginAbs = Math.abs(parseFloat(r.bin_margin));
    const clMarginAbs = Math.abs(parseFloat(r.cl_margin));
    
    if (offsetShift > clMarginAbs * 0.5) {  // offset shift is >50% of the margin
      console.log(
        r.closeET + " ET: " +
        "CL margin=$" + r.cl_margin +
        " | Offset shift=$" + offsetShift.toFixed(2) +
        " | Shift/Margin=" + (offsetShift / clMarginAbs * 100).toFixed(0) + "%" +
        " | RISK: " + (offsetShift > clMarginAbs ? "COULD FLIP" : "significant noise")
      );
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
