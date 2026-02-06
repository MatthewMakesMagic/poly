const pg = require("pg");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 60000,
  ssl: { rejectUnauthorized: false },
});

// Generate last 20 completed 15-min windows
const now = new Date();
const latestClose = new Date(Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000));
const windows = [];
for (let i = 20; i >= 1; i--) {
  windows.push(new Date(latestClose.getTime() - i * 15 * 60 * 1000).toISOString());
}

function toET(isoStr) {
  return new Date(isoStr).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

async function query1_finalSeconds() {
  console.log("\n" + "=".repeat(80));
  console.log("QUERY 1: CLOB mid_price in final 30s before close (last 5 windows)");
  console.log("=".repeat(80));

  const recentWindows = windows.slice(-5);

  for (const closeTime of recentWindows) {
    const sql = `
      SELECT
        EXTRACT(EPOCH FROM $1::timestamptz - c.timestamp)::int AS secs_before_close,
        ROUND(c.mid_price::numeric, 4) AS mid,
        ROUND((c.mid_price - FIRST_VALUE(c.mid_price) OVER (ORDER BY c.timestamp))::numeric, 4) AS delta_from_30s
      FROM clob_price_snapshots c
      WHERE c.symbol = 'btc-up'
        AND c.mid_price IS NOT NULL
        AND c.timestamp BETWEEN ($1::timestamptz - INTERVAL '30 seconds') AND $1::timestamptz
      ORDER BY c.timestamp
    `;
    const res = await pool.query(sql, [closeTime]);
    const closeET = toET(closeTime);
    console.log(`\n  Window close: ${closeET} ET  (${closeTime})`);
    if (res.rows.length === 0) {
      console.log("    (no data)");
    } else {
      console.table(res.rows.map(r => ({
        secs_before: r.secs_before_close,
        mid_price: parseFloat(r.mid),
        delta: parseFloat(r.delta_from_30s),
      })));
    }
  }
}

async function query2_perWindowSummary() {
  console.log("\n" + "=".repeat(80));
  console.log("QUERY 2: Per-window summary of final-30s behavior (last 20 windows)");
  console.log("=".repeat(80));

  const results = [];

  for (const closeTime of windows) {
    const sql = `
      WITH snaps AS (
        SELECT
          c.timestamp,
          c.mid_price,
          EXTRACT(EPOCH FROM $1::timestamptz - c.timestamp) AS secs_before
        FROM clob_price_snapshots c
        WHERE c.symbol = 'btc-up'
          AND c.mid_price IS NOT NULL
          AND c.timestamp BETWEEN ($1::timestamptz - INTERVAL '30 seconds') AND $1::timestamptz
      )
      SELECT
        (SELECT ROUND(mid_price::numeric, 4) FROM snaps WHERE secs_before BETWEEN 29 AND 31 ORDER BY secs_before LIMIT 1) AS price_30s,
        (SELECT ROUND(mid_price::numeric, 4) FROM snaps WHERE secs_before BETWEEN 9 AND 11 ORDER BY secs_before LIMIT 1) AS price_10s,
        (SELECT ROUND(mid_price::numeric, 4) FROM snaps WHERE secs_before BETWEEN 2 AND 4 ORDER BY secs_before LIMIT 1) AS price_3s,
        (SELECT ROUND(mid_price::numeric, 4) FROM snaps WHERE secs_before BETWEEN 0 AND 1 ORDER BY ABS(secs_before) LIMIT 1) AS price_close,
        ROUND(MAX(mid_price)::numeric, 4) AS max_mid,
        ROUND(MIN(mid_price)::numeric, 4) AS min_mid,
        ROUND((MAX(mid_price) - MIN(mid_price))::numeric, 4) AS range_30s,
        COUNT(*) AS snap_count
      FROM snaps
    `;
    const res = await pool.query(sql, [closeTime]);
    const row = res.rows[0];
    if (row && row.snap_count > 0) {
      const p3 = parseFloat(row.price_3s);
      const pC = parseFloat(row.price_close);
      const flip = (p3 && pC) ? ((p3 >= 0.5) !== (pC >= 0.5)) : null;
      results.push({
        close_et: toET(closeTime),
        price_30s: row.price_30s ? parseFloat(row.price_30s) : null,
        price_10s: row.price_10s ? parseFloat(row.price_10s) : null,
        price_3s: row.price_3s ? parseFloat(row.price_3s) : null,
        price_close: row.price_close ? parseFloat(row.price_close) : null,
        max_mid: parseFloat(row.max_mid),
        min_mid: parseFloat(row.min_mid),
        range_30s: parseFloat(row.range_30s),
        snaps: parseInt(row.snap_count),
        flip: flip ? "YES" : "no",
      });
    } else {
      results.push({
        close_et: toET(closeTime),
        price_30s: null, price_10s: null, price_3s: null, price_close: null,
        max_mid: null, min_mid: null, range_30s: null, snaps: 0, flip: "-",
      });
    }
  }

  console.log("");
  console.table(results);
}

async function query3_chainlinkLag() {
  console.log("\n" + "=".repeat(80));
  console.log("QUERY 3: Chainlink lag vs Binance in final 10s / 60s / rest of window");
  console.log("=".repeat(80));

  // Build a UNION of window boundaries
  const windowClauses = windows.map((w, i) => `SELECT $${i + 1}::timestamptz AS close_time`).join(" UNION ALL ");
  const params = windows;

  const sql = `
    WITH win AS (${windowClauses}),
    paired AS (
      SELECT
        w.close_time,
        b.sec,
        EXTRACT(EPOCH FROM w.close_time - b.sec) AS secs_before_close,
        c.avg_rcv_ms - b.avg_rcv_ms AS lag_ms
      FROM win w
      CROSS JOIN LATERAL (
        SELECT date_trunc('second', timestamp) AS sec,
          AVG(EXTRACT(EPOCH FROM received_at)::numeric * 1000) AS avg_rcv_ms
        FROM rtds_ticks
        WHERE topic = 'crypto_prices' AND symbol = 'btc' AND received_at IS NOT NULL
          AND timestamp BETWEEN (w.close_time - INTERVAL '15 minutes') AND w.close_time
        GROUP BY 1
      ) b
      JOIN LATERAL (
        SELECT AVG(EXTRACT(EPOCH FROM received_at)::numeric * 1000) AS avg_rcv_ms
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc' AND received_at IS NOT NULL
          AND date_trunc('second', timestamp) = b.sec
      ) c ON true
    )
    SELECT
      CASE
        WHEN secs_before_close <= 10 THEN 'final_10s'
        WHEN secs_before_close <= 60 THEN 'final_60s'
        ELSE 'rest_of_window'
      END AS period,
      COUNT(*) AS seconds,
      ROUND(AVG(lag_ms)::numeric, 1) AS avg_lag_ms,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lag_ms))::numeric, 1) AS median_ms,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lag_ms))::numeric, 1) AS p95_ms,
      ROUND(MAX(lag_ms)::numeric, 1) AS max_ms
    FROM paired
    GROUP BY 1
    ORDER BY MIN(secs_before_close)
  `;

  try {
    const res = await pool.query({ text: sql, values: params, statement_timeout: 120000 });
    if (res.rows.length === 0) {
      console.log("\n  (no paired Binance/Chainlink data found in these windows)");
    } else {
      console.log("");
      console.table(res.rows.map(r => ({
        period: r.period,
        seconds: parseInt(r.seconds),
        avg_lag_ms: parseFloat(r.avg_lag_ms),
        median_ms: parseFloat(r.median_ms),
        p95_ms: parseFloat(r.p95_ms),
        max_ms: parseFloat(r.max_ms),
      })));
    }
  } catch (err) {
    console.error("  Query 3 error (may timeout on large data):", err.message);
    console.log("  Falling back to simpler per-window approach...");

    // Fallback: just look at the last 5 windows to reduce load
    const fallbackWindows = windows.slice(-5);
    const allRows = [];
    for (const closeTime of fallbackWindows) {
      const fbSql = `
        WITH b_ticks AS (
          SELECT date_trunc('second', timestamp) AS sec,
            AVG(EXTRACT(EPOCH FROM received_at)::numeric * 1000) AS avg_rcv_ms
          FROM rtds_ticks
          WHERE topic = 'crypto_prices' AND symbol = 'btc' AND received_at IS NOT NULL
            AND timestamp BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND $1::timestamptz
          GROUP BY 1
        ),
        c_ticks AS (
          SELECT date_trunc('second', timestamp) AS sec,
            AVG(EXTRACT(EPOCH FROM received_at)::numeric * 1000) AS avg_rcv_ms
          FROM rtds_ticks
          WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc' AND received_at IS NOT NULL
            AND timestamp BETWEEN ($1::timestamptz - INTERVAL '15 minutes') AND $1::timestamptz
          GROUP BY 1
        ),
        paired AS (
          SELECT
            b.sec,
            EXTRACT(EPOCH FROM $1::timestamptz - b.sec) AS secs_before_close,
            c.avg_rcv_ms - b.avg_rcv_ms AS lag_ms
          FROM b_ticks b
          JOIN c_ticks c ON c.sec = b.sec
        )
        SELECT
          CASE
            WHEN secs_before_close <= 10 THEN 'final_10s'
            WHEN secs_before_close <= 60 THEN 'final_60s'
            ELSE 'rest_of_window'
          END AS period,
          COUNT(*) AS seconds,
          ROUND(AVG(lag_ms)::numeric, 1) AS avg_lag_ms,
          ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lag_ms))::numeric, 1) AS median_ms,
          ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lag_ms))::numeric, 1) AS p95_ms,
          ROUND(MAX(lag_ms)::numeric, 1) AS max_ms
        FROM paired
        GROUP BY 1
        ORDER BY MIN(secs_before_close)
      `;
      try {
        const fbRes = await pool.query(fbSql, [closeTime]);
        fbRes.rows.forEach(r => allRows.push({ ...r, window: toET(closeTime) }));
      } catch (e2) {
        console.error(`    Window ${toET(closeTime)}: ${e2.message}`);
      }
    }
    if (allRows.length > 0) {
      console.log("\n  Fallback results (last 5 windows individually):");
      console.table(allRows.map(r => ({
        window: r.window,
        period: r.period,
        seconds: parseInt(r.seconds),
        avg_lag_ms: parseFloat(r.avg_lag_ms),
        median_ms: parseFloat(r.median_ms),
        p95_ms: parseFloat(r.p95_ms),
        max_ms: parseFloat(r.max_ms),
      })));
    }
  }
}

async function main() {
  console.log("Final-Seconds Analysis");
  console.log(`Now (UTC): ${now.toISOString()}`);
  console.log(`Latest completed 15-min window close: ${latestClose.toISOString()} (${toET(latestClose.toISOString())} ET)`);
  console.log(`Analyzing ${windows.length} windows from ${toET(windows[0])} to ${toET(windows[windows.length - 1])} ET`);

  try {
    await query1_finalSeconds();
    await query2_perWindowSummary();
    await query3_chainlinkLag();
  } catch (err) {
    console.error("Fatal error:", err);
  } finally {
    await pool.end();
  }
}

main();
