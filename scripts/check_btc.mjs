import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const r = await pool.query(`
    SELECT
        timestamp_et,
        type,
        strategy_name,
        side,
        price,
        size,
        pnl,
        reason
    FROM live_trades
    WHERE crypto = 'btc'
    AND timestamp > NOW() - INTERVAL '20 minutes'
    ORDER BY timestamp DESC
`);

console.log('');
console.log('BTC TRADES (last 20 minutes):');
console.log('═'.repeat(100));

for (const t of r.rows) {
    const et = t.timestamp_et || 'N/A';
    const type = (t.type || '').toUpperCase().padEnd(10);
    const side = (t.side || '').toUpperCase().padEnd(5);
    const price = t.price !== null ? t.price.toFixed(3) : 'N/A';
    const size = t.size !== null ? '$' + t.size.toFixed(2) : 'N/A';
    const pnl = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '';
    const reason = t.reason || '';
    console.log(`${et} | ${type} | ${side} @ ${price} | size=${size} | pnl=${pnl} | ${reason}`);
}

await pool.end();
