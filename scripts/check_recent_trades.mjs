import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get trades from last 2 hours
const r = await pool.query(`
    SELECT
        timestamp_et,
        type,
        strategy_name,
        crypto,
        side,
        price,
        pnl,
        reason
    FROM live_trades
    WHERE timestamp > NOW() - INTERVAL '2 hours'
    ORDER BY timestamp DESC
    LIMIT 30
`);

console.log('');
console.log('TRADES IN LAST 2 HOURS:');
console.log('═'.repeat(100));

if (r.rows.length === 0) {
    console.log('  No trades found in last 2 hours');
} else {
    for (const t of r.rows) {
        const time = (t.timestamp_et || '').slice(0, 20).padEnd(20);
        const type = (t.type || '').toUpperCase().padEnd(8);
        const strat = (t.strategy_name || '').slice(0, 20).padEnd(20);
        const crypto = (t.crypto || '').toUpperCase().padEnd(4);
        const side = (t.side || '').toUpperCase().padEnd(4);
        const price = t.price ? '$' + t.price.toFixed(3) : 'N/A';
        const pnl = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) : '';
        const reason = (t.reason || '').slice(0, 25);
        console.log('  ' + time + ' | ' + type + ' | ' + strat + ' | ' + crypto + ' ' + side + ' @ ' + price.padEnd(7) + ' | ' + pnl.padEnd(8) + ' | ' + reason);
    }
}

// Summary
const summary = await pool.query(`
    SELECT
        COUNT(*) FILTER (WHERE type = 'entry') as entries,
        COUNT(*) FILTER (WHERE type = 'exit') as exits,
        SUM(pnl) FILTER (WHERE pnl IS NOT NULL) as total_pnl
    FROM live_trades
    WHERE timestamp > NOW() - INTERVAL '2 hours'
`);

console.log('');
console.log('SUMMARY:');
console.log('  Entries: ' + summary.rows[0].entries + ' | Exits: ' + summary.rows[0].exits + ' | Total P&L: $' + (parseFloat(summary.rows[0].total_pnl) || 0).toFixed(2));
console.log('');

await pool.end();
