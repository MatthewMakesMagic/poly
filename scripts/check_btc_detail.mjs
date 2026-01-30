import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Check what columns exist in ticks table
const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'ticks'
    ORDER BY ordinal_position
`);
console.log('TICKS TABLE COLUMNS:');
console.log(cols.rows.map(r => r.column_name).join(', '));

// Get the window epoch
const windowQ = await pool.query(`
    SELECT DISTINCT window_epoch 
    FROM live_trades 
    WHERE crypto = 'btc' 
    AND timestamp > NOW() - INTERVAL '2 hours'
    ORDER BY window_epoch DESC
    LIMIT 1
`);
const windowEpoch = windowQ.rows[0]?.window_epoch;
console.log('\nWindow epoch:', windowEpoch);

// Get strike from live_trades
const strike = await pool.query(`
    SELECT price_to_beat FROM live_trades 
    WHERE crypto = 'btc' AND window_epoch = $1 AND type = 'entry' LIMIT 1
`, [windowEpoch]);
const strikePrice = strike.rows[0]?.price_to_beat;
console.log('Strike price:', strikePrice);

// Get ticks during this window
const ticks = await pool.query(`
    SELECT timestamp, crypto, spot_price, up_mid 
    FROM ticks 
    WHERE crypto = 'btc' 
    AND window_epoch = $1
    ORDER BY timestamp
`, [windowEpoch]);

console.log('\nSPOT PRICE vs STRIKE DURING WINDOW:');
const minPrice = Math.min(...ticks.rows.map(t => t.spot_price || 0).filter(p => p > 0));
const maxPrice = Math.max(...ticks.rows.map(t => t.spot_price || 0));
console.log('Strike:', strikePrice);
console.log('Min spot:', minPrice.toFixed(2), minPrice > strikePrice ? '(ABOVE)' : '(BELOW)');
console.log('Max spot:', maxPrice.toFixed(2), maxPrice > strikePrice ? '(ABOVE)' : '(BELOW)');
console.log('Total ticks:', ticks.rows.length);

// Sample ticks
console.log('\nTICKS SAMPLE (first 5, middle 5, last 5):');
const samples = [
    ...ticks.rows.slice(0, 5),
    ...ticks.rows.slice(Math.floor(ticks.rows.length/2) - 2, Math.floor(ticks.rows.length/2) + 3),
    ...ticks.rows.slice(-5)
];
for (const t of samples) {
    const aboveBelow = t.spot_price > strikePrice ? 'ABOVE' : 'BELOW';
    console.log(new Date(t.timestamp).toISOString().split('T')[1].split('.')[0] + ' | Spot: $' + t.spot_price?.toFixed(2) + ' (' + aboveBelow + ') | UP mid: ' + (t.up_mid * 100).toFixed(1) + '%');
}

await pool.end();
