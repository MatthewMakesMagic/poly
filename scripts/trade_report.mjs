import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get the BTC UP entry around 39-42c in the 1:45-2AM window
const r = await pool.query(`
    SELECT *
    FROM live_trades
    WHERE crypto = 'btc'
    AND type = 'entry'
    AND timestamp > NOW() - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
`);

console.log('');
console.log('='.repeat(80));
console.log('  COMPREHENSIVE TRADE REPORT: BTC ENTRIES (last 30 min)');
console.log('='.repeat(80));

for (const t of r.rows) {
    console.log('');
    console.log('-'.repeat(80));
    console.log(`TRADE ID: ${t.id}`);
    console.log(`TIME (ET): ${t.timestamp_et}`);
    console.log('-'.repeat(80));

    console.log(`Strategy: ${t.strategy_name}`);
    console.log(`Side: ${(t.side || '').toUpperCase()}`);
    console.log(`Reason: ${t.reason}`);
    console.log('');

    console.log('PRICES:');
    console.log(`  Entry Price: ${t.price ? '$' + t.price.toFixed(3) : 'N/A'}`);
    console.log(`  Price Requested: ${t.price_requested ? '$' + t.price_requested.toFixed(3) : 'N/A'}`);
    console.log(`  Price Filled: ${t.price_filled ? '$' + t.price_filled.toFixed(3) : 'N/A'}`);
    console.log(`  Position Size: $${t.size?.toFixed(2) || 'N/A'}`);
    console.log('');

    console.log('MARKET CONDITIONS:');
    console.log(`  Spot Price: $${t.spot_price?.toFixed(2) || 'N/A'}`);
    console.log(`  Price to Beat: $${t.price_to_beat?.toFixed(2) || 'N/A'}`);
    console.log(`  Time Remaining: ${t.time_remaining?.toFixed(0) || 'N/A'}s`);
    console.log('');

    console.log('LAG ANALYTICS:');
    console.log(`  Oracle Price: $${t.oracle_price?.toFixed(2) || 'N/A'}`);
    console.log(`  Oracle Source: ${t.oracle_source || 'N/A'}`);
    console.log(`  Chainlink Staleness: ${t.chainlink_staleness || 'N/A'}s`);
    console.log(`  Lag Ratio: ${t.lag_ratio?.toFixed(3) || 'N/A'}`);
    console.log('');

    console.log('PROBABILITY EDGE:');
    console.log(`  BS (Fair) Prob: ${t.bs_prob ? (t.bs_prob * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Market Prob: ${t.market_prob ? (t.market_prob * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Edge at Entry: ${t.edge_at_entry ? (t.edge_at_entry * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log('');

    console.log('FILL DETAILS:');
    if (t.fill_details) {
        try {
            const fd = JSON.parse(t.fill_details);
            console.log(`  Source: ${fd.source || 'N/A'}`);
            if (fd.invalidExtracted) {
                console.log(`  Invalid Extracted: ${fd.invalidExtracted}`);
            }
        } catch (e) {
            console.log(`  Raw: ${t.fill_details}`);
        }
    } else {
        console.log('  (no fill details)');
    }
    console.log(`TX Hash: ${t.tx_hash || 'N/A'}`);
    console.log('');
}

await pool.end();
