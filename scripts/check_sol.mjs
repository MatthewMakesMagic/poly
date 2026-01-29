import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get SOL trades from last hour
const r = await pool.query(`
    SELECT
        timestamp,
        timestamp_et,
        type,
        strategy_name,
        side,
        price,
        size,
        pnl,
        reason
    FROM live_trades
    WHERE crypto = 'sol'
    AND timestamp > NOW() - INTERVAL '2 hours'
    ORDER BY timestamp DESC
    LIMIT 20
`);

console.log('');
console.log('SOL TRADES (last 2 hours):');
console.log('═'.repeat(100));

if (r.rows.length === 0) {
    console.log('  No SOL trades found');
} else {
    for (const t of r.rows) {
        const et = t.timestamp_et || 'N/A';
        const type = (t.type || '').toUpperCase().padEnd(10);
        const strat = (t.strategy_name || '').slice(0, 22).padEnd(22);
        const side = (t.side || '').toUpperCase().padEnd(4);
        const price = t.price !== null ? t.price.toFixed(3) : 'N/A';
        const size = t.size !== null ? t.size.toFixed(2) : 'N/A';
        const pnl = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '';
        const reason = (t.reason || '').slice(0, 20);
        console.log('  ' + et);
        console.log('    ' + type + ' | ' + strat + ' | ' + side + ' @ $' + price + ' | size=$' + size + ' | pnl=' + pnl + ' | ' + reason);
        console.log('');
    }
}

await pool.end();
