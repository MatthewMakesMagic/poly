import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get the 15 most recent trades
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
    LIMIT 15
`);

console.log('');
console.log('15 MOST RECENT TRADES:');
console.log('═'.repeat(100));

for (const t of r.rows) {
    const ts = t.timestamp ? new Date(t.timestamp).toISOString() : 'N/A';
    const et = t.timestamp_et || 'N/A';
    const type = (t.type || '').toUpperCase().padEnd(10);
    const strat = (t.strategy_name || '').slice(0, 22).padEnd(22);
    const crypto = (t.crypto || '').toUpperCase().padEnd(4);
    const side = (t.side || '').toUpperCase().padEnd(4);
    const price = t.price !== null ? t.price.toFixed(3) : 'N/A';
    const pnl = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '';
    const reason = (t.reason || '').slice(0, 25);

    console.log('  ' + ts);
    console.log('    ET: ' + et + ' | ' + type + ' | ' + strat + ' | ' + crypto + ' ' + side + ' @ ' + price + ' | ' + pnl + ' | ' + reason);
    console.log('');
}

await pool.end();
