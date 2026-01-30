import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get trades with impossible entry prices
const r = await pool.query(`
    SELECT id, timestamp_et, crypto, side, price, size, tx_hash,
           price_requested, price_filled, fill_details
    FROM live_trades
    WHERE price > 1.0
    AND type = 'entry'
    ORDER BY timestamp DESC
    LIMIT 10
`);

console.log('TRADES WITH IMPOSSIBLE ENTRY PRICES (> $1.00):');
console.log('='.repeat(120));

for (const row of r.rows) {
    console.log('');
    console.log('Trade #' + row.id + ' | ' + row.timestamp_et);
    console.log('  Crypto: ' + row.crypto?.toUpperCase() + ' | Side: ' + row.side?.toUpperCase());
    console.log('  Entry price: $' + row.price?.toFixed(4) + ' | Size: $' + row.size?.toFixed(2));
    console.log('  Price requested: $' + (row.price_requested?.toFixed(4) || 'N/A'));
    console.log('  Price filled: $' + (row.price_filled?.toFixed(4) || 'N/A'));
    console.log('  Fill details: ' + (row.fill_details || 'N/A'));
    console.log('  TX hash: ' + (row.tx_hash || 'N/A'));
}

await pool.end();
