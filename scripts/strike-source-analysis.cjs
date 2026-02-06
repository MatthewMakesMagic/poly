const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 90000 });

async function run() {
  // PART 0: What tables and columns do we have for window close events?
  console.log("=== PART 0: SCHEMA DISCOVERY ===\n");
  
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND (table_name LIKE '%window%' OR table_name LIKE '%close%' OR table_name LIKE '%signal%' OR table_name LIKE '%oracle_edge%')
    ORDER BY table_name
  `);
  console.log("Relevant tables:");
  for (const t of tables.rows) console.log("  " + t.table_name);
  
  // Get columns for each
  for (const t of tables.rows) {
    const cols = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = $1 ORDER BY ordinal_position
    `, [t.table_name]);
    console.log("\n" + t.table_name + ":");
    for (const c of cols.rows) console.log("  " + c.column_name + " (" + c.data_type + ")");
  }

  // PART 1: Pull actual window close events with strike prices
  console.log("\n\n=== PART 1: ACTUAL STRIKE PRICES FROM window_close_events ===\n");
  
  const events = await pool.query(`
    SELECT * FROM window_close_events 
    WHERE symbol = 'btc'
    ORDER BY window_close_time DESC 
    LIMIT 30
  `);
  
  if (events.rows.length === 0) {
    console.log("No BTC events found. Trying without filter...");
    const allEvents = await pool.query(`
      SELECT * FROM window_close_events ORDER BY window_close_time DESC LIMIT 10
    `);
    console.log("Total events: " + allEvents.rows.length);
    if (allEvents.rows.length > 0) {
      console.log("Sample row keys: " + Object.keys(allEvents.rows[0]).join(", "));
      console.log("Sample row:");
      console.log(JSON.stringify(allEvents.rows[0], null, 2));
    }
  } else {
    console.log("Found " + events.rows.length + " BTC window close events\n");
    
    // Show first few full rows to understand the data
    console.log("Sample row keys: " + Object.keys(events.rows[0]).join(", "));
    console.log("\nFirst 3 events:");
    for (let i = 0; i < Math.min(3, events.rows.length); i++) {
      console.log(JSON.stringify(events.rows[i], null, 2));
    }
  }

  // PART 2: Pull oracle_edge_signals with strike prices
  console.log("\n\n=== PART 2: ORACLE EDGE SIGNALS ===\n");
  
  const signals = await pool.query(`
    SELECT * FROM oracle_edge_signals 
    ORDER BY created_at DESC 
    LIMIT 10
  `).catch(e => { console.log("oracle_edge_signals error: " + e.message); return { rows: [] }; });
  
  if (signals.rows.length > 0) {
    console.log("Found " + signals.rows.length + " signals");
    console.log("Keys: " + Object.keys(signals.rows[0]).join(", "));
    console.log("\nFirst 3:");
    for (let i = 0; i < Math.min(3, signals.rows.length); i++) {
      console.log(JSON.stringify(signals.rows[i], null, 2));
    }
  }

  // PART 3: Now the key analysis - compare strike to Binance and Chainlink opens
  console.log("\n\n=== PART 3: STRIKE vs BINANCE vs CHAINLINK OPEN PRICES ===\n");
  
  // Get the strike prices and window times
  const strikes = await pool.query(`
    SELECT 
      window_close_time,
      strike_price,
      oracle_price_at_close,
      binance_price_at_close,
      chainlink_price_at_close,
      resolved_direction,
      symbol
    FROM window_close_events 
    WHERE strike_price IS NOT NULL
    AND symbol = 'btc'
    ORDER BY window_close_time DESC 
    LIMIT 25
  `).catch(async (e) => {
    console.log("First query failed: " + e.message);
    return { rows: [] };
  });
  
  if (strikes.rows.length === 0) {
    console.log("No strike data found in window_close_events. Trying oracle_edge_signals...");
    
    const altStrikes = await pool.query(`
      SELECT * FROM oracle_edge_signals 
      WHERE strike IS NOT NULL
      ORDER BY created_at DESC LIMIT 25
    `).catch(e => { console.log("Also failed: " + e.message); return { rows: [] }; });
    
    if (altStrikes.rows.length > 0) {
      console.log("Found " + altStrikes.rows.length + " rows with strikes from oracle_edge_signals");
      for (const r of altStrikes.rows.slice(0, 3)) {
        console.log(JSON.stringify(r, null, 2));
      }
    }
  } else {
    console.log("CLOSE_ET         STRIKE        ORACLE_CLOSE  BINANCE_CLOSE CHAINLINK_CLOSE RESOLVED  SYMBOL");
    console.log("-".repeat(110));
    
    for (const r of strikes.rows) {
      const closeET = new Date(new Date(r.window_close_time).getTime() - 5*60*60*1000)
        .toISOString().substr(11, 8);
      console.log(
        String(closeET).padEnd(17) +
        String(r.strike_price).padEnd(14) +
        String(r.oracle_price_at_close || "---").padEnd(14) +
        String(r.binance_price_at_close || "---").padEnd(14) +
        String(r.chainlink_price_at_close || "---").padEnd(16) +
        String(r.resolved_direction || "---").padEnd(10) +
        String(r.symbol || "---")
      );
    }

    // Now compare each strike to Binance and Chainlink prices at window open
    console.log("\n\n=== PART 4: WHICH INSTRUMENT MATCHES THE STRIKE? ===\n");
    console.log("CLOSE_ET    STRIKE         BIN_OPEN       CL_OPEN        BIN_DIFF    CL_DIFF     CLOSEST");
    console.log("-".repeat(110));
    
    for (const r of strikes.rows) {
      const closeTime = new Date(r.window_close_time);
      const openTime = new Date(closeTime.getTime() - 15 * 60 * 1000);
      
      // Get Binance and Chainlink prices at window open
      const binOpen = await pool.query(`
        SELECT ROUND(AVG(price::numeric), 2) AS p 
        FROM rtds_ticks 
        WHERE topic = 'crypto_prices' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      `, [openTime.toISOString()]);
      
      const clOpen = await pool.query(`
        SELECT ROUND(AVG(price::numeric), 2) AS p 
        FROM rtds_ticks 
        WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '5 seconds')
      `, [openTime.toISOString()]);
      
      const strike = parseFloat(r.strike_price);
      const bp = binOpen.rows[0]?.p ? parseFloat(binOpen.rows[0].p) : null;
      const cp = clOpen.rows[0]?.p ? parseFloat(clOpen.rows[0].p) : null;
      
      const closeET = new Date(closeTime.getTime() - 5*60*60*1000).toISOString().substr(11, 8);
      
      const binDiff = bp ? (strike - bp).toFixed(2) : "---";
      const clDiff = cp ? (strike - cp).toFixed(2) : "---";
      
      let closest = "---";
      if (bp && cp) {
        const binAbs = Math.abs(strike - bp);
        const clAbs = Math.abs(strike - cp);
        if (binAbs < clAbs) closest = "BINANCE (by $" + (clAbs - binAbs).toFixed(2) + ")";
        else if (clAbs < binAbs) closest = "CHAINLINK (by $" + (binAbs - clAbs).toFixed(2) + ")";
        else closest = "TIED";
      }
      
      console.log(
        String(closeET).padEnd(12) +
        ("$" + strike.toFixed(2)).padEnd(15) +
        (bp ? "$" + bp.toFixed(2) : "---").padEnd(15) +
        (cp ? "$" + cp.toFixed(2) : "---").padEnd(15) +
        ("$" + binDiff).padEnd(12) +
        ("$" + clDiff).padEnd(12) +
        closest
      );
    }
  }

  // PART 5: Summary statistics
  console.log("\n\n=== PART 5: RESOLUTION VERIFICATION ===\n");
  console.log("Verify: does oracle_price_at_close > strike match resolved_direction?\n");
  
  const verify = await pool.query(`
    SELECT 
      resolved_direction,
      CASE WHEN oracle_price_at_close > strike_price THEN 'up' ELSE 'down' END AS computed_dir,
      CASE WHEN resolved_direction = (CASE WHEN oracle_price_at_close > strike_price THEN 'up' ELSE 'down' END) THEN 'MATCH' ELSE 'MISMATCH' END AS check,
      COUNT(*) AS cnt
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND oracle_price_at_close IS NOT NULL AND resolved_direction IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 3, 1
  `).catch(e => { console.log("Verify query failed: " + e.message); return { rows: [] }; });
  
  if (verify.rows.length > 0) {
    console.table(verify.rows);
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
