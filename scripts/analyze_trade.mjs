import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get the most recent BTC DOWN entries
const r = await pool.query(`
    SELECT *
    FROM live_trades
    WHERE crypto = 'btc'
    AND type = 'entry'
    AND timestamp > NOW() - INTERVAL '1 hour'
    ORDER BY timestamp DESC
    LIMIT 5
`);

console.log('');
console.log('='.repeat(80));
console.log('RIGOROUS TRADE ANALYSIS: BTC DOWN ENTRIES');
console.log('='.repeat(80));

for (const t of r.rows) {
    console.log('');
    console.log('TRADE ID:', t.id);
    console.log('TIME (ET):', t.timestamp_et);
    console.log('Strategy:', t.strategy_name);
    console.log('Side:', t.side?.toUpperCase());
    console.log('');
    console.log('POSITION SIZING:');
    console.log('  Size (requested):', t.size ? '$' + t.size.toFixed(2) : 'N/A');
    console.log('  Price:', t.price ? '$' + t.price.toFixed(3) : 'N/A');
    console.log('  Implied shares:', t.price && t.size ? (t.size / t.price).toFixed(2) : 'N/A');
    console.log('');
    console.log('MARKET CONDITIONS:');
    console.log('  Spot Price:', t.spot_price ? '$' + t.spot_price.toFixed(2) : 'N/A');
    console.log('  Price to Beat:', t.price_to_beat ? '$' + t.price_to_beat.toFixed(2) : 'N/A');
    console.log('  Time Remaining:', t.time_remaining ? t.time_remaining.toFixed(0) + 's' : 'N/A');
    console.log('');
    console.log('ORACLE DATA:');
    console.log('  Oracle Price:', t.oracle_price ? '$' + t.oracle_price.toFixed(2) : 'N/A');
    console.log('  Oracle Source:', t.oracle_source || 'N/A');
    console.log('  Pyth Price:', t.pyth_price ? '$' + t.pyth_price.toFixed(2) : 'N/A');
    console.log('  Chainlink Price:', t.chainlink_price ? '$' + t.chainlink_price.toFixed(2) : 'N/A');
    console.log('  Chainlink Staleness:', t.chainlink_staleness ? t.chainlink_staleness + 's' : 'N/A');
    console.log('');
    console.log('EDGE ANALYSIS:');
    console.log('  BS Prob:', t.bs_prob ? (t.bs_prob * 100).toFixed(1) + '%' : 'N/A');
    console.log('  Market Prob:', t.market_prob ? (t.market_prob * 100).toFixed(1) + '%' : 'N/A');
    console.log('  Edge at Entry:', t.edge_at_entry ? (t.edge_at_entry * 100).toFixed(1) + '%' : 'N/A');
    console.log('  Lag Ratio:', t.lag_ratio?.toFixed(3) || 'N/A');
    console.log('');
    console.log('FILL DETAILS:');
    console.log('  Price Requested:', t.price_requested ? '$' + t.price_requested.toFixed(3) : 'N/A');
    console.log('  Price Filled:', t.price_filled ? '$' + t.price_filled.toFixed(3) : 'N/A');
    if (t.fill_details) {
        try {
            const fd = JSON.parse(t.fill_details);
            console.log('  Fill Source:', fd.source || 'N/A');
        } catch (e) {}
    }
    console.log('  TX Hash:', t.tx_hash || 'N/A');
    console.log('-'.repeat(80));
}

await pool.end();
