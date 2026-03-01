const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    // Check 10 recent BTC snapshots for volume distribution
    const r = await p.query("SELECT exchange_detail FROM vwap_snapshots WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 10", ["btc"]);

    const avgWeights = {};
    for (const row of r.rows) {
      const ed = typeof row.exchange_detail === 'string' ? JSON.parse(row.exchange_detail) : row.exchange_detail;
      for (const [ex, data] of Object.entries(ed)) {
        if (!avgWeights[ex]) avgWeights[ex] = { totalWeight: 0, count: 0 };
        avgWeights[ex].totalWeight += data.weight;
        avgWeights[ex].count++;
      }
    }

    const sorted = Object.entries(avgWeights)
      .map(([ex, d]) => ({ ex, avgWeight: d.totalWeight / d.count }))
      .sort((a, b) => b.avgWeight - a.avgWeight);

    console.log('BTC AVG VOLUME WEIGHT (10 recent snapshots):');
    for (const s of sorted) {
      console.log('  ' + s.ex.padEnd(20) + (s.avgWeight * 100).toFixed(2) + '%');
    }

    // ETH
    const r2 = await p.query("SELECT exchange_detail FROM vwap_snapshots WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 5", ["eth"]);
    const ethWeights = {};
    for (const row of r2.rows) {
      const ed = typeof row.exchange_detail === 'string' ? JSON.parse(row.exchange_detail) : row.exchange_detail;
      for (const [ex, data] of Object.entries(ed)) {
        if (!ethWeights[ex]) ethWeights[ex] = { totalWeight: 0, count: 0 };
        ethWeights[ex].totalWeight += data.weight;
        ethWeights[ex].count++;
      }
    }
    const ethSorted = Object.entries(ethWeights)
      .map(([ex, d]) => ({ ex, avgWeight: d.totalWeight / d.count }))
      .sort((a, b) => b.avgWeight - a.avgWeight);

    console.log('\nETH AVG VOLUME WEIGHT (5 recent):');
    for (const s of ethSorted.slice(0, 8)) {
      console.log('  ' + s.ex.padEnd(20) + (s.avgWeight * 100).toFixed(2) + '%');
    }

    // Check window_close_events columns for CLOB trajectory data
    const r3 = await p.query(`
      SELECT market_up_price_60s, market_up_price_30s, market_up_price_10s,
             market_up_price_5s, market_up_price_1s,
             oracle_price_at_open, oracle_price_at_close,
             strike_price, resolved_direction, onchain_resolved_direction
      FROM window_close_events
      WHERE symbol = $1 AND onchain_resolved_direction IS NOT NULL
      ORDER BY window_close_time DESC LIMIT 3
    `, ["btc"]);
    console.log('\nSample window_close_events (BTC):');
    for (const row of r3.rows) {
      console.log('  CLOB@60s:', row.market_up_price_60s, '30s:', row.market_up_price_30s,
        '10s:', row.market_up_price_10s, '5s:', row.market_up_price_5s, '1s:', row.market_up_price_1s);
      console.log('  Oracle open:', row.oracle_price_at_open, 'close:', row.oracle_price_at_close,
        'res:', row.resolved_direction, 'onchain:', row.onchain_resolved_direction);
    }

    await p.end();
  } catch(e) { console.error(e.message); await p.end(); }
})();
