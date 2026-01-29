import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await pool.query(`
    SELECT 
        timestamp_et,
        type,
        strategy_name,
        crypto,
        side,
        price,
        reason
    FROM live_trades 
    WHERE crypto = 'xrp' 
    AND timestamp > NOW() - INTERVAL '2 hours'
    ORDER BY timestamp DESC
    LIMIT 15
`);
console.log('XRP TRADES (last 2 hours):');
console.log('─'.repeat(100));
for (const t of r.rows) {
    const time = (t.timestamp_et || '').padEnd(14);
    const type = (t.type || '').toUpperCase().padEnd(6);
    const strat = (t.strategy_name || '').slice(0,22).padEnd(22);
    const side = (t.side || '').toUpperCase().padEnd(4);
    const price = t.price ? t.price.toFixed(3) : 'N/A';
    const reason = (t.reason || '').slice(0,30);
    console.log(`${time} | ${type} | ${strat} | ${side} | $${price} | ${reason}`);
}
await pool.end();
