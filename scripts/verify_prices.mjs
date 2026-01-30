import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Check trades after the sanity check fix was deployed (Jan 29 06:10 UTC = Jan 29 13:10 +0700)
const r = await pool.query(`
    SELECT id, timestamp_et, crypto, side, price, price_requested, price_filled, fill_details
    FROM live_trades
    WHERE type = 'entry'
    AND timestamp > '2026-01-29 06:30:00+00'  -- After the fix
    ORDER BY timestamp DESC
`);

console.log('TRADES AFTER SANITY CHECK FIX:');
console.log('Total trades:', r.rows.length);

const badPrices = r.rows.filter(row => row.price > 1.0);
console.log('Trades with price > $1:', badPrices.length);

if (badPrices.length > 0) {
    console.log('\nBAD PRICES FOUND:');
    for (const row of badPrices) {
        console.log('#' + row.id + ' | ' + row.crypto + ' | price: $' + row.price?.toFixed(4));
    }
} else {
    console.log('\n✅ All prices are valid (< $1.00)');
}

// Show some recent valid trades
console.log('\nRecent valid trades (sample):');
for (const row of r.rows.slice(0, 5)) {
    const fd = typeof row.fill_details === 'string' ? row.fill_details : JSON.stringify(row.fill_details);
    console.log('#' + row.id + ' | ' + row.crypto + ' | price: $' + (row.price?.toFixed(4) || 'N/A') + ' | ' + (fd?.substring(0, 50) || 'N/A') + '...');
}

await pool.end();
