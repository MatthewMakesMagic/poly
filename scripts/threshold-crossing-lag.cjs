const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 90000 });

async function run() {
  const now = new Date();
  const latestClose = new Date(Math.floor(now.getTime() / (15*60*1000)) * (15*60*1000));
  
  console.log("=== THRESHOLD CROSSING LAG ANALYSIS ===\n");
  console.log("For each window: when did Binance vs Chainlink cross the open price?\n");
  console.log("A positive lag = Binance crossed FIRST (our edge).\n");
  
  const results = [];
  
  for (let i = 20; i >= 1; i--) {
    const close = new Date(latestClose.getTime() - i * 15 * 60 * 1000);
    const open = new Date(close.getTime() - 15 * 60 * 1000);
    
    try {
      const crossing = await pool.query(`
        WITH binance AS (
          SELECT date_trunc('second', timestamp) AS sec,
            AVG(price::numeric) AS price
          FROM rtds_ticks
          WHERE topic = 'crypto_prices' AND symbol = 'btc'
            AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
          GROUP BY 1
        ),
        chainlink AS (
          SELECT date_trunc('second', timestamp) AS sec,
            AVG(price::numeric) AS price
          FROM rtds_ticks
          WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
            AND timestamp BETWEEN $1::timestamptz AND $2::timestamptz
          GROUP BY 1
        ),
        bin_open AS (
          SELECT AVG(price) AS op FROM binance 
          WHERE sec BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '10 seconds')
        ),
        cl_open AS (
          SELECT AVG(price) AS op FROM chainlink 
          WHERE sec BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '10 seconds')
        ),
        bin_crossings AS (
          SELECT sec, 
            CASE WHEN price > (SELECT op FROM bin_open) THEN 'UP' ELSE 'DOWN' END AS dir,
            LAG(CASE WHEN price > (SELECT op FROM bin_open) THEN 'UP' ELSE 'DOWN' END) OVER (ORDER BY sec) AS prev_dir
          FROM binance
        ),
        cl_crossings AS (
          SELECT sec,
            CASE WHEN price > (SELECT op FROM cl_open) THEN 'UP' ELSE 'DOWN' END AS dir,
            LAG(CASE WHEN price > (SELECT op FROM cl_open) THEN 'UP' ELSE 'DOWN' END) OVER (ORDER BY sec) AS prev_dir
          FROM chainlink
        ),
        bin_crosses AS (
          SELECT sec, dir, prev_dir || '->' || dir AS crossing FROM bin_crossings 
          WHERE dir != prev_dir AND prev_dir IS NOT NULL
        ),
        cl_crosses AS (
          SELECT sec, dir, prev_dir || '->' || dir AS crossing FROM cl_crossings 
          WHERE dir != prev_dir AND prev_dir IS NOT NULL
        )
        SELECT 
          (SELECT COUNT(*) FROM bin_crosses) AS bin_cross_count,
          (SELECT COUNT(*) FROM cl_crosses) AS cl_cross_count,
          (SELECT dir FROM bin_crossings WHERE sec = (SELECT MAX(sec) FROM binance)) AS bin_final_dir,
          (SELECT dir FROM cl_crossings WHERE sec = (SELECT MAX(sec) FROM chainlink)) AS cl_final_dir,
          (SELECT to_char(MAX(sec) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') FROM bin_crosses) AS bin_last_cross_et,
          (SELECT to_char(MAX(sec) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') FROM cl_crosses) AS cl_last_cross_et,
          (SELECT crossing FROM bin_crosses ORDER BY sec DESC LIMIT 1) AS bin_last_crossing,
          (SELECT crossing FROM cl_crosses ORDER BY sec DESC LIMIT 1) AS cl_last_crossing,
          EXTRACT(EPOCH FROM (
            (SELECT MAX(sec) FROM cl_crosses) - (SELECT MAX(sec) FROM bin_crosses)
          )) AS last_cross_lag_seconds
      `, [open.toISOString(), close.toISOString()]);
      
      const r = crossing.rows[0];
      const closeET = new Date(close.getTime() - 5*60*60*1000).toISOString().substr(11,5);
      
      results.push({
        close_et: closeET,
        bin_crosses: parseInt(r.bin_cross_count),
        cl_crosses: parseInt(r.cl_cross_count),
        bin_final: r.bin_final_dir,
        cl_final: r.cl_final_dir,
        bin_last_cross: r.bin_last_cross_et || "none",
        cl_last_cross: r.cl_last_cross_et || "none",
        bin_crossing: r.bin_last_crossing || "---",
        cl_crossing: r.cl_last_crossing || "---",
        lag_s: r.last_cross_lag_seconds != null ? parseFloat(r.last_cross_lag_seconds) : null,
        contested: parseInt(r.bin_cross_count) > 2 || parseInt(r.cl_cross_count) > 2
      });
    } catch (e) {
      console.error("Error on window " + close.toISOString() + ": " + e.message);
    }
  }
  
  // Display
  console.log("CLOSE_ET  BIN_X  CL_X  BIN_FINAL  CL_FINAL  BIN_LAST_CROSS  CL_LAST_CROSS  LAST_CROSS_DIR     LAG(s)  CONTESTED");
  console.log("-".repeat(120));
  
  for (const r of results) {
    const lag = r.lag_s != null ? r.lag_s.toFixed(0) + "s" : "---";
    console.log(
      String(r.close_et).padEnd(10) +
      String(r.bin_crosses).padEnd(7) +
      String(r.cl_crosses).padEnd(6) +
      String(r.bin_final).padEnd(11) +
      String(r.cl_final).padEnd(10) +
      String(r.bin_last_cross).padEnd(16) +
      String(r.cl_last_cross).padEnd(15) +
      String(r.bin_crossing).padEnd(19) +
      String(lag).padEnd(8) +
      (r.contested ? "YES" : "no")
    );
  }
  
  // Summary
  const contested = results.filter(r => r.contested);
  const withLag = results.filter(r => r.lag_s != null && r.lag_s > 0);
  const disagree = results.filter(r => r.bin_final !== r.cl_final);
  
  console.log("\n\n=== SUMMARY ===\n");
  console.log("Total windows: " + results.length);
  console.log("Contested (>2 crossings): " + contested.length + " (" + (contested.length/results.length*100).toFixed(0) + "%)");
  console.log("Binance crossed last BEFORE Chainlink: " + withLag.length);
  console.log("Binance/Chainlink DISAGREE on final direction: " + disagree.length);
  
  if (disagree.length > 0) {
    console.log("\n!!! DISAGREEMENT WINDOWS (Binance says one thing, Chainlink says another at close) !!!");
    for (const d of disagree) {
      console.log("  " + d.close_et + " ET: Binance=" + d.bin_final + " Chainlink=" + d.cl_final);
    }
  }
  
  if (withLag.length > 0) {
    console.log("\nWindows where Binance crossed threshold BEFORE Chainlink:");
    for (const w of withLag) {
      console.log("  " + w.close_et + " ET: Binance at " + w.bin_last_cross + ", Chainlink at " + w.cl_last_cross + " (lag: " + w.lag_s.toFixed(0) + "s)");
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
