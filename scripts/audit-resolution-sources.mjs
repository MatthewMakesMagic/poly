/**
 * Audit resolution sources: compare gamma_resolved_direction (ground truth)
 * vs resolved_direction (RTDS) vs onchain_resolved_direction.
 *
 * Reports per-source error rates against Gamma truth, broken down by symbol.
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(import.meta.dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  let val = trimmed.slice(eqIdx + 1);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

async function main() {
  // Fetch all windows with gamma truth
  const { rows } = await pool.query(`
    SELECT
      id, window_id, symbol,
      gamma_resolved_direction,
      resolved_direction,
      onchain_resolved_direction,
      oracle_price_at_open::numeric as cl_open,
      oracle_price_at_close::numeric as cl_close,
      strike_price::numeric as strike
    FROM window_close_events
    ORDER BY symbol, window_close_time
  `);

  console.log(`Total windows: ${rows.length}`);
  const gammaResolved = rows.filter(r => r.gamma_resolved_direction && r.gamma_resolved_direction !== 'UNRESOLVED');
  console.log(`Gamma-resolved windows (ground truth): ${gammaResolved.length}`);
  console.log(`Gamma UNRESOLVED: ${rows.filter(r => r.gamma_resolved_direction === 'UNRESOLVED').length}`);
  console.log(`Gamma NULL (no backfill): ${rows.filter(r => !r.gamma_resolved_direction).length}`);

  // --- RTDS vs Gamma ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('SOURCE 1: RTDS resolved_direction vs Gamma (ground truth)');
  console.log('='.repeat(70));

  const rtdsStats = { total: 0, match: 0, mismatch: 0, missing: 0, bySymbol: {} };

  for (const r of gammaResolved) {
    if (!rtdsStats.bySymbol[r.symbol]) {
      rtdsStats.bySymbol[r.symbol] = { total: 0, match: 0, mismatch: 0, missing: 0, mismatches: [] };
    }
    const s = rtdsStats.bySymbol[r.symbol];
    rtdsStats.total++;
    s.total++;

    if (!r.resolved_direction) {
      rtdsStats.missing++;
      s.missing++;
    } else if (r.resolved_direction === r.gamma_resolved_direction) {
      rtdsStats.match++;
      s.match++;
    } else {
      rtdsStats.mismatch++;
      s.mismatch++;
      s.mismatches.push({
        window_id: r.window_id,
        rtds: r.resolved_direction,
        gamma: r.gamma_resolved_direction,
        cl_open: r.cl_open,
        cl_close: r.cl_close,
      });
    }
  }

  const rtdsAccuracy = rtdsStats.total > 0 ? ((rtdsStats.match / (rtdsStats.total - rtdsStats.missing)) * 100).toFixed(2) : 'N/A';
  console.log(`  Compared:  ${rtdsStats.total - rtdsStats.missing} (${rtdsStats.missing} missing RTDS direction)`);
  console.log(`  Match:     ${rtdsStats.match}`);
  console.log(`  Mismatch:  ${rtdsStats.mismatch}`);
  console.log(`  Accuracy:  ${rtdsAccuracy}%`);
  console.log(`  Error rate: ${rtdsStats.total > 0 ? ((rtdsStats.mismatch / (rtdsStats.total - rtdsStats.missing)) * 100).toFixed(2) : 'N/A'}%`);

  console.log('\n  --- By Symbol ---');
  for (const [sym, s] of Object.entries(rtdsStats.bySymbol).sort()) {
    const compared = s.total - s.missing;
    const acc = compared > 0 ? ((s.match / compared) * 100).toFixed(2) : 'N/A';
    const errRate = compared > 0 ? ((s.mismatch / compared) * 100).toFixed(2) : 'N/A';
    console.log(`  ${sym.toUpperCase()}: ${compared} compared, ${s.match} match, ${s.mismatch} mismatch (${acc}% accuracy, ${errRate}% error), ${s.missing} missing`);
  }

  // --- Onchain vs Gamma ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('SOURCE 2: Onchain resolved_direction vs Gamma (ground truth)');
  console.log('='.repeat(70));

  const onchainStats = { total: 0, match: 0, mismatch: 0, missing: 0, bySymbol: {} };

  for (const r of gammaResolved) {
    if (!onchainStats.bySymbol[r.symbol]) {
      onchainStats.bySymbol[r.symbol] = { total: 0, match: 0, mismatch: 0, missing: 0, mismatches: [] };
    }
    const s = onchainStats.bySymbol[r.symbol];
    onchainStats.total++;
    s.total++;

    if (!r.onchain_resolved_direction) {
      onchainStats.missing++;
      s.missing++;
    } else if (r.onchain_resolved_direction === r.gamma_resolved_direction) {
      onchainStats.match++;
      s.match++;
    } else {
      onchainStats.mismatch++;
      s.mismatch++;
      s.mismatches.push({
        window_id: r.window_id,
        onchain: r.onchain_resolved_direction,
        gamma: r.gamma_resolved_direction,
        cl_open: r.cl_open,
        cl_close: r.cl_close,
      });
    }
  }

  const onchainAccuracy = onchainStats.total > 0 ? ((onchainStats.match / (onchainStats.total - onchainStats.missing)) * 100).toFixed(2) : 'N/A';
  console.log(`  Compared:  ${onchainStats.total - onchainStats.missing} (${onchainStats.missing} missing onchain direction)`);
  console.log(`  Match:     ${onchainStats.match}`);
  console.log(`  Mismatch:  ${onchainStats.mismatch}`);
  console.log(`  Accuracy:  ${onchainAccuracy}%`);
  console.log(`  Error rate: ${onchainStats.total > 0 ? ((onchainStats.mismatch / (onchainStats.total - onchainStats.missing)) * 100).toFixed(2) : 'N/A'}%`);

  console.log('\n  --- By Symbol ---');
  for (const [sym, s] of Object.entries(onchainStats.bySymbol).sort()) {
    const compared = s.total - s.missing;
    const acc = compared > 0 ? ((s.match / compared) * 100).toFixed(2) : 'N/A';
    const errRate = compared > 0 ? ((s.mismatch / compared) * 100).toFixed(2) : 'N/A';
    console.log(`  ${sym.toUpperCase()}: ${compared} compared, ${s.match} match, ${s.mismatch} mismatch (${acc}% accuracy, ${errRate}% error), ${s.missing} missing`);
  }

  // --- Coverage comparison ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('COVERAGE SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Gamma ground truth:  ${gammaResolved.length}/${rows.length} windows resolved`);
  console.log(`  RTDS coverage:       ${rtdsStats.total - rtdsStats.missing}/${gammaResolved.length} (${((rtdsStats.total - rtdsStats.missing) / gammaResolved.length * 100).toFixed(1)}%)`);
  console.log(`  Onchain coverage:    ${onchainStats.total - onchainStats.missing}/${gammaResolved.length} (${((onchainStats.total - onchainStats.missing) / gammaResolved.length * 100).toFixed(1)}%)`);

  // --- Show RTDS mismatches ---
  if (rtdsStats.mismatch > 0) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`RTDS MISMATCHES (${rtdsStats.mismatch} total)`);
    console.log('='.repeat(70));
    for (const [sym, s] of Object.entries(rtdsStats.bySymbol).sort()) {
      if (s.mismatches.length === 0) continue;
      console.log(`\n  ${sym.toUpperCase()} (${s.mismatches.length} mismatches):`);
      for (const m of s.mismatches.slice(0, 20)) {
        const move = m.cl_close !== null && m.cl_open !== null
          ? (parseFloat(m.cl_close) - parseFloat(m.cl_open)).toFixed(2)
          : '?';
        console.log(`    ${m.window_id}: RTDS=${m.rtds} Gamma=${m.gamma} CL_move=$${move}`);
      }
      if (s.mismatches.length > 20) {
        console.log(`    ... and ${s.mismatches.length - 20} more`);
      }
    }
  }

  // --- Show Onchain mismatches ---
  if (onchainStats.mismatch > 0) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`ONCHAIN MISMATCHES (${onchainStats.mismatch} total)`);
    console.log('='.repeat(70));
    for (const [sym, s] of Object.entries(onchainStats.bySymbol).sort()) {
      if (s.mismatches.length === 0) continue;
      console.log(`\n  ${sym.toUpperCase()} (${s.mismatches.length} mismatches):`);
      for (const m of s.mismatches.slice(0, 20)) {
        const move = m.cl_close !== null && m.cl_open !== null
          ? (parseFloat(m.cl_close) - parseFloat(m.cl_open)).toFixed(2)
          : '?';
        console.log(`    ${m.window_id}: Onchain=${m.onchain} Gamma=${m.gamma} CL_move=$${move}`);
      }
      if (s.mismatches.length > 20) {
        console.log(`    ... and ${s.mismatches.length - 20} more`);
      }
    }
  }

  // --- Cross-comparison: where RTDS and Onchain both exist but disagree with each other ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('THREE-WAY COMPARISON (windows with all 3 sources)');
  console.log('='.repeat(70));

  const threeWay = gammaResolved.filter(r => r.resolved_direction && r.onchain_resolved_direction);
  let allAgree = 0, rtdsWrongOnly = 0, onchainWrongOnly = 0, bothWrong = 0, bothDisagreeGamma = 0;

  for (const r of threeWay) {
    const rtdsOk = r.resolved_direction === r.gamma_resolved_direction;
    const onchainOk = r.onchain_resolved_direction === r.gamma_resolved_direction;
    if (rtdsOk && onchainOk) allAgree++;
    else if (!rtdsOk && onchainOk) rtdsWrongOnly++;
    else if (rtdsOk && !onchainOk) onchainWrongOnly++;
    else bothWrong++;
  }

  console.log(`  Windows with all 3: ${threeWay.length}`);
  console.log(`  All agree:          ${allAgree} (${(allAgree/threeWay.length*100).toFixed(2)}%)`);
  console.log(`  RTDS wrong only:    ${rtdsWrongOnly}`);
  console.log(`  Onchain wrong only: ${onchainWrongOnly}`);
  console.log(`  Both wrong:         ${bothWrong}`);

  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
