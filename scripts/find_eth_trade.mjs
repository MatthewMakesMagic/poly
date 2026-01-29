import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Find ETH trades around 12:15-12:30 AM ET on Jan 29
const r = await pool.query(`
    SELECT
        timestamp,
        timestamp_et,
        type,
        strategy_name,
        crypto,
        side,
        price,
        price_requested,
        price_filled,
        pnl,
        reason,
        oracle_price,
        lag_ratio,
        edge_at_entry
    FROM live_trades
    WHERE crypto = 'eth'
    AND (
        timestamp_et LIKE '%12:1%'
        OR timestamp_et LIKE '%12:2%'
        OR timestamp_et LIKE '%12:3%'
        OR timestamp_et LIKE '1/29/2026%'
    )
    ORDER BY timestamp DESC
    LIMIT 20
`);

console.log('');
console.log('ETH TRADES around midnight ET (Jan 29):');
console.log('═'.repeat(100));

if (r.rows.length === 0) {
    console.log('  No ETH trades found in that window');
} else {
    for (const t of r.rows) {
        console.log('');
        console.log('  timestamp:       ' + t.timestamp);
        console.log('  timestamp_et:    ' + t.timestamp_et);
        console.log('  type:            ' + t.type);
        console.log('  strategy:        ' + t.strategy_name);
        console.log('  side:            ' + t.side);
        console.log('  price:           ' + t.price);
        console.log('  price_requested: ' + t.price_requested);
        console.log('  price_filled:    ' + t.price_filled);
        console.log('  pnl:             ' + t.pnl);
        console.log('  reason:          ' + t.reason);
        console.log('  oracle_price:    ' + t.oracle_price);
        console.log('  lag_ratio:       ' + t.lag_ratio);
        console.log('  edge_at_entry:   ' + t.edge_at_entry);
    }
}

await pool.end();
