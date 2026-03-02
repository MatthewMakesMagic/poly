const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Get ALL mismatches across all symbols
  const r = await pool.query(`
    SELECT window_id, symbol, resolved_direction, onchain_resolved_direction,
      oracle_price_at_close::numeric as cl_close, oracle_price_at_open::numeric as cl_open,
      ABS(oracle_price_at_close::numeric - oracle_price_at_open::numeric) as cl_move,
      condition_id,
      EXTRACT(EPOCH FROM window_close_time)::bigint as epoch
    FROM window_close_events
    WHERE onchain_resolved_direction IS NOT NULL
      AND resolved_direction IS NOT NULL
      AND onchain_resolved_direction != resolved_direction
    ORDER BY symbol, ABS(oracle_price_at_close::numeric - oracle_price_at_open::numeric) DESC
  `);

  console.log(`Cross-checking ALL ${r.rows.length} mismatches against Gamma API...\n`);

  const stats = { gammaAgreesSelf: 0, gammaAgreesOnchain: 0, gammaDisagreesBoth: 0, gammaNoData: 0 };
  const bySymbol = {};

  for (const row of r.rows) {
    const slug = `${row.symbol}-updown-15m-${row.epoch}`;
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    const data = await res.json();

    let gammaDir = '?';
    if (data.length && data[0].outcomePrices) {
      const p = JSON.parse(data[0].outcomePrices);
      gammaDir = p[0] === '1' ? 'up' : 'down';
    }

    const agreesWithSelf = gammaDir === row.resolved_direction;
    const agreesWithOnchain = gammaDir === row.onchain_resolved_direction;

    let flag;
    if (gammaDir === '?') { flag = 'NO-DATA'; stats.gammaNoData++; }
    else if (agreesWithSelf && !agreesWithOnchain) { flag = 'ONCHAIN-WRONG'; stats.gammaAgreesSelf++; }
    else if (agreesWithOnchain && !agreesWithSelf) { flag = 'RTDS-WRONG'; stats.gammaAgreesOnchain++; }
    else { flag = 'CONFUSING'; stats.gammaDisagreesBoth++; }

    if (!bySymbol[row.symbol]) bySymbol[row.symbol] = { onchainWrong: 0, rtdsWrong: 0, total: 0 };
    bySymbol[row.symbol].total++;
    if (flag === 'ONCHAIN-WRONG') bySymbol[row.symbol].onchainWrong++;
    if (flag === 'RTDS-WRONG') bySymbol[row.symbol].rtdsWrong++;

    console.log(`  ${row.symbol} CL=$${parseFloat(row.cl_move).toFixed(2).padStart(7)} | self=${row.resolved_direction.padEnd(4)} onchain=${row.onchain_resolved_direction.padEnd(4)} gamma=${gammaDir.padEnd(4)} → ${flag}`);

    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`
=== SUMMARY ===
Gamma agrees with RTDS self-resolution (onchain check was wrong): ${stats.gammaAgreesSelf}
Gamma agrees with onchain (our RTDS was wrong):                   ${stats.gammaAgreesOnchain}
Gamma disagrees with both:                                        ${stats.gammaDisagreesBoth}
No Gamma data:                                                    ${stats.gammaNoData}
Total mismatches checked:                                         ${r.rows.length}

=== BY SYMBOL ===`);
  for (const [sym, s] of Object.entries(bySymbol)) {
    console.log(`  ${sym}: ${s.total} mismatches — ${s.onchainWrong} onchain-wrong, ${s.rtdsWrong} rtds-wrong`);
  }

  // Now check: how many UNVERIFIED windows can we backfill?
  const unverified = await pool.query(`
    SELECT symbol, COUNT(*) as cnt
    FROM window_close_events
    WHERE onchain_resolved_direction IS NULL
    GROUP BY symbol ORDER BY symbol
  `);
  console.log('\n=== UNVERIFIED WINDOWS (can be backfilled via Gamma outcomePrices) ===');
  unverified.rows.forEach(r => console.log(`  ${r.symbol}: ${r.cnt} windows`));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
