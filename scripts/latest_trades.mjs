import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get the 10 most recent trades, period
const r = await pool.query(`
    SELECT
        timestamp,
        timestamp_et,
        type,
        strategy_name,
        crypto,
        side,
        price,
        pnl,
        reason
    FROM live_trades
    ORDER BY timestamp DESC
    LIMIT 10
`);

console.log('');
console.log('10 MOST RECENT TRADES (sorted by timestamp DESC):');
console.log('═'.repeat(100));

for (const t of r.rows) {
    console.log('  timestamp:    ' + t.timestamp);
    console.log('  timestamp_et: ' + t.timestamp_et);
    console.log('  type:         ' + t.type);
    console.log('  strategy:     ' + t.strategy_name);
    console.log('  crypto/side:  ' + t.crypto + ' ' + t.side);
    console.log('  price:        ' + t.price);
    console.log('  pnl:          ' + t.pnl);
    console.log('  reason:       ' + t.reason);
    console.log('  ---');
}

await pool.end();
