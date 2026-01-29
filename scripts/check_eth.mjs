import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const r = await pool.query(`
    SELECT *
    FROM live_trades
    WHERE crypto = 'eth'
    AND timestamp > NOW() - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
    LIMIT 10
`);

console.log('');
console.log('ETH TRADES (last 30 minutes):');
console.log('═'.repeat(100));

for (const t of r.rows) {
    console.log(JSON.stringify(t, null, 2));
    console.log('');
}

await pool.end();
