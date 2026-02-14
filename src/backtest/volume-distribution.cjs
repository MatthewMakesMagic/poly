/**
 * Check volume distribution per exchange per instrument.
 * Uses exchange_detail JSONB from vwap_snapshots.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');

async function main() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();

  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    // Sample ~100 recent snapshots to get volume distribution
    const res = await client.query(`
      SELECT exchange_detail
      FROM vwap_snapshots
      WHERE symbol = $1
      AND exchange_detail IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 100
    `, [sym]);

    if (res.rows.length === 0) {
      console.log(`${sym.toUpperCase()}: NO DATA\n`);
      continue;
    }

    // Aggregate volume per exchange across samples
    const exchVolume = {};
    const exchCount = {};
    let totalVol = 0;

    for (const row of res.rows) {
      const detail = typeof row.exchange_detail === 'string'
        ? JSON.parse(row.exchange_detail)
        : row.exchange_detail;

      for (const [exch, data] of Object.entries(detail)) {
        const vol = data.volume || data.totalVolume || 0;
        exchVolume[exch] = (exchVolume[exch] || 0) + vol;
        exchCount[exch] = (exchCount[exch] || 0) + 1;
        totalVol += vol;
      }
    }

    // Sort by volume descending
    const sorted = Object.entries(exchVolume)
      .sort((a, b) => b[1] - a[1]);

    console.log(`${'═'.repeat(70)}`);
    console.log(`${sym.toUpperCase()} — Volume Distribution (last 100 snapshots, ~100 seconds)`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`Exchange             │ Volume (${sym.toUpperCase()})    │ % of Total │ Present In`);
    console.log(`─────────────────────┼──────────────────┼────────────┼──────────`);

    let cumPct = 0;
    for (const [exch, vol] of sorted) {
      const pct = (vol / totalVol * 100);
      cumPct += pct;
      const avgVol = vol / res.rows.length;
      console.log(
        `${exch.padEnd(20)} │ ${avgVol.toFixed(4).padStart(16)} │ ${pct.toFixed(1).padStart(8)}%  │ ${exchCount[exch]}/${res.rows.length}`
      );
    }

    console.log(`─────────────────────┼──────────────────┼────────────┼──────────`);
    console.log(`TOTAL (${sorted.length} exchanges)`.padEnd(21) + `│ ${(totalVol / res.rows.length).toFixed(4).padStart(16)} │    100.0%  │`);

    // Show concentration: top 3 exchanges
    const top3Pct = sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0) / totalVol * 100;
    const top5Pct = sorted.slice(0, 5).reduce((s, [, v]) => s + v, 0) / totalVol * 100;
    console.log(`\nConcentration: Top 3 = ${top3Pct.toFixed(1)}% | Top 5 = ${top5Pct.toFixed(1)}%`);

    // Show exchanges with < 1% volume
    const negligible = sorted.filter(([, v]) => v / totalVol < 0.01);
    console.log(`Negligible (<1%): ${negligible.length} exchanges: ${negligible.map(([e]) => e).join(', ')}`);
    console.log('');
  }

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
