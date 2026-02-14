/**
 * Probe data availability for all instruments.
 * Checks: VWAP snapshots, Chainlink coverage, window close events, CLOB prices.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');

async function main() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();

  // 1. VWAP snapshot coverage per symbol
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('1. VWAP SNAPSHOTS — per symbol coverage');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const vwapCoverage = await client.query(`
    SELECT symbol,
           COUNT(*) as total_rows,
           COUNT(chainlink_price) as cl_rows,
           COUNT(composite_vwap) as vwap_rows,
           MIN(timestamp) as first_ts,
           MAX(timestamp) as last_ts,
           ROUND(AVG(composite_vwap)::numeric, 2) as avg_vwap,
           ROUND(AVG(chainlink_price)::numeric, 2) as avg_cl,
           ROUND(AVG(vwap_cl_spread)::numeric, 2) as avg_spread,
           ROUND(AVG(exchange_count)::numeric, 1) as avg_exchanges
    FROM vwap_snapshots
    GROUP BY symbol
    ORDER BY symbol
  `);

  for (const r of vwapCoverage.rows) {
    const clPct = r.total_rows > 0 ? ((r.cl_rows / r.total_rows) * 100).toFixed(1) : '0';
    console.log(`${r.symbol.toUpperCase()}:`);
    console.log(`  Total snapshots:  ${Number(r.total_rows).toLocaleString()}`);
    console.log(`  With CL price:    ${Number(r.cl_rows).toLocaleString()} (${clPct}%)`);
    console.log(`  Avg exchanges:    ${r.avg_exchanges}`);
    console.log(`  Avg VWAP:         $${r.avg_vwap}`);
    console.log(`  Avg CL price:     ${r.avg_cl ? '$' + r.avg_cl : 'N/A'}`);
    console.log(`  Avg VWAP-CL gap:  ${r.avg_spread ? '$' + r.avg_spread : 'N/A'}`);
    console.log(`  Time range:       ${r.first_ts?.toISOString().slice(0, 19)}Z → ${r.last_ts?.toISOString().slice(0, 19)}Z`);
    console.log('');
  }

  // 2. Window close events per symbol
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('2. WINDOW CLOSE EVENTS — per symbol coverage');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const windowCoverage = await client.query(`
    SELECT symbol,
           COUNT(*) as total,
           COUNT(oracle_price_at_close) as has_oracle_close,
           COUNT(oracle_price_at_open) as has_oracle_open,
           COUNT(resolved_direction) as has_resolution,
           COUNT(onchain_resolved_direction) as has_onchain,
           COUNT(market_up_price_60s) as has_clob_60,
           COUNT(market_up_price_10s) as has_clob_10,
           MIN(window_close_time) as first_close,
           MAX(window_close_time) as last_close
    FROM window_close_events
    GROUP BY symbol
    ORDER BY symbol
  `);

  for (const r of windowCoverage.rows) {
    console.log(`${r.symbol.toUpperCase()}:`);
    console.log(`  Total windows:       ${r.total}`);
    console.log(`  With oracle@close:   ${r.has_oracle_close}`);
    console.log(`  With oracle@open:    ${r.has_oracle_open}`);
    console.log(`  With resolution:     ${r.has_resolution}`);
    console.log(`  With on-chain res:   ${r.has_onchain}`);
    console.log(`  With CLOB@T-60:      ${r.has_clob_60}`);
    console.log(`  With CLOB@T-10:      ${r.has_clob_10}`);
    console.log(`  Time range:          ${r.first_close?.toISOString().slice(0, 19)}Z → ${r.last_close?.toISOString().slice(0, 19)}Z`);
    console.log('');
  }

  // 3. For non-BTC: check if oracle prices come from Pyth (by checking if chainlink_price_at_close is null)
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('3. ORACLE SOURCE — CL vs Pyth per symbol');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const oracleSrc = await client.query(`
    SELECT symbol,
           COUNT(*) as total,
           COUNT(chainlink_price_at_close) as has_cl_close,
           COUNT(pyth_price_at_close) as has_pyth_close,
           COUNT(oracle_price_at_close) as has_oracle_close
    FROM window_close_events
    GROUP BY symbol
    ORDER BY symbol
  `);

  for (const r of oracleSrc.rows) {
    const clPct = r.total > 0 ? ((r.has_cl_close / r.total) * 100).toFixed(0) : '0';
    const pythPct = r.total > 0 ? ((r.has_pyth_close / r.total) * 100).toFixed(0) : '0';
    const oraclePct = r.total > 0 ? ((r.has_oracle_close / r.total) * 100).toFixed(0) : '0';
    console.log(`${r.symbol.toUpperCase()}: CL=${r.has_cl_close}/${r.total} (${clPct}%) | Pyth=${r.has_pyth_close}/${r.total} (${pythPct}%) | Oracle(either)=${r.has_oracle_close}/${r.total} (${oraclePct}%)`);
  }

  // 4. Sample prices for each instrument to understand scale
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('4. PRICE SCALE & VWAP DELTA DISTRIBUTION (last 24h)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    const priceRes = await client.query(`
      SELECT ROUND(AVG(composite_vwap)::numeric, 4) as avg_price,
             ROUND(STDDEV(composite_vwap)::numeric, 4) as stddev,
             ROUND(MIN(composite_vwap)::numeric, 4) as min_price,
             ROUND(MAX(composite_vwap)::numeric, 4) as max_price
      FROM vwap_snapshots
      WHERE symbol = $1
      AND timestamp >= NOW() - INTERVAL '48 hours'
    `, [sym]);

    if (priceRes.rows.length > 0 && priceRes.rows[0].avg_price) {
      const r = priceRes.rows[0];
      const avgP = parseFloat(r.avg_price);
      const pctRange = avgP > 0 ? (((parseFloat(r.max_price) - parseFloat(r.min_price)) / avgP) * 100).toFixed(2) : 0;
      // What does 0.11% of price look like? (BTC's $75 threshold equivalent)
      const btcEquivThreshold = (avgP * 0.0011).toFixed(4);
      console.log(`${sym.toUpperCase()} (avg ~$${avgP.toFixed(2)}):`);
      console.log(`  Range: $${r.min_price} → $${r.max_price} (${pctRange}% over 48h)`);
      console.log(`  StdDev: $${r.stddev}`);
      console.log(`  0.11% threshold (≈ BTC $75 equiv): $${btcEquivThreshold}`);
      console.log('');
    } else {
      console.log(`${sym.toUpperCase()}: NO DATA in last 48h\n`);
    }
  }

  // 5. Quick check: for non-BTC, can we compute resolution from vwap_snapshots CL prices?
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('5. CL PRICE IN VWAP_SNAPSHOTS — can we compute resolution?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    const clCheck = await client.query(`
      SELECT COUNT(*) as total,
             COUNT(chainlink_price) as with_cl,
             MIN(CASE WHEN chainlink_price IS NOT NULL THEN timestamp END) as first_cl,
             MAX(CASE WHEN chainlink_price IS NOT NULL THEN timestamp END) as last_cl
      FROM vwap_snapshots
      WHERE symbol = $1
      AND timestamp >= NOW() - INTERVAL '48 hours'
    `, [sym]);

    const r = clCheck.rows[0];
    const clPct = r.total > 0 ? ((r.with_cl / r.total) * 100).toFixed(1) : '0';
    console.log(`${sym.toUpperCase()}: ${r.with_cl}/${r.total} snapshots have CL price (${clPct}%)`);
    if (r.first_cl) {
      console.log(`  CL data range: ${r.first_cl.toISOString().slice(0, 19)}Z → ${r.last_cl.toISOString().slice(0, 19)}Z`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('6. CONCLUSION — which instruments can run the edge analysis?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // For each symbol, determine viability
  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    const vr = vwapCoverage.rows.find(r => r.symbol === sym);
    const wr = windowCoverage.rows.find(r => r.symbol === sym);
    const or = oracleSrc.rows.find(r => r.symbol === sym);

    if (!vr || !wr) {
      console.log(`${sym.toUpperCase()}: NO DATA AT ALL`);
      continue;
    }

    const issues = [];
    if (parseInt(vr.cl_rows) === 0) issues.push('No Chainlink prices in vwap_snapshots (can\'t compute CL@open for resolution)');
    if (parseInt(wr.has_oracle_close) === 0) issues.push('No oracle prices at close in window_close_events');
    if (parseInt(wr.has_clob_60) === 0) issues.push('No CLOB prices captured');
    if (parseInt(wr.total) < 10) issues.push(`Only ${wr.total} windows (need more data)`);

    if (issues.length === 0) {
      console.log(`${sym.toUpperCase()}: READY — ${wr.total} windows, CL data available`);
    } else {
      const hasPyth = parseInt(or?.has_pyth_close || 0) > 0;
      const hasOracleClose = parseInt(wr.has_oracle_close) > 0;
      console.log(`${sym.toUpperCase()}: ISSUES`);
      for (const i of issues) console.log(`  - ${i}`);
      if (hasPyth && hasOracleClose) {
        console.log(`  NOTE: Has Pyth data — could run analysis using Pyth as oracle proxy (unverified against on-chain resolution)`);
      }
    }
    console.log('');
  }

  await client.end();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
