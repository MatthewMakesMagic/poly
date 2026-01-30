import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Check the orphaned windows
const orphanedWindows = [
    { epoch: 1769669100, crypto: 'btc', side: 'up', strategy: 'LagProb_RightSide' },
    { epoch: 1769667600, crypto: 'sol', side: 'up', strategy: 'PureProb_Conservative' },
];

for (const ow of orphanedWindows) {
    console.log('\n' + '='.repeat(80));
    console.log('Window: ' + new Date(ow.epoch * 1000).toISOString() + ' | ' + ow.crypto + ' ' + ow.side + ' | ' + ow.strategy);
    console.log('='.repeat(80));

    const r = await pool.query(`
        SELECT id, timestamp_et, type, side, price, pnl, reason
        FROM live_trades
        WHERE window_epoch = $1
        AND crypto = $2
        AND strategy_name = $3
        ORDER BY timestamp
    `, [ow.epoch, ow.crypto, ow.strategy]);

    if (r.rows.length === 0) {
        console.log('No trades found for this window/crypto/strategy combo');
    } else {
        for (const row of r.rows) {
            const pnl = row.pnl !== null ? '$' + row.pnl.toFixed(2) : 'N/A';
            console.log('#' + row.id + ' ' + row.type.padEnd(10) + ' | ' + (row.side || '?').padEnd(4) + ' | $' + (row.price?.toFixed(3) || '?') + ' | pnl: ' + pnl + ' | ' + (row.reason || ''));
        }
    }
}

// Also check what the actual orphan query found
console.log('\n' + '='.repeat(80));
console.log('RAW QUERY - Entries with no exits in 06:45 window:');
console.log('='.repeat(80));

const entries = await pool.query(`
    SELECT e.id, e.timestamp_et, e.crypto, e.side, e.strategy_name
    FROM live_trades e
    WHERE e.type = 'entry'
    AND e.timestamp > NOW() - INTERVAL '6 hours'
    AND NOT EXISTS (
        SELECT 1 FROM live_trades x
        WHERE x.window_epoch = e.window_epoch
        AND x.crypto = e.crypto
        AND x.strategy_name = e.strategy_name
        AND x.side = e.side
        AND x.type IN ('exit', 'abandoned')
    )
    ORDER BY e.timestamp DESC
`);

console.log('Found ' + entries.rows.length + ' entries without exits:');
for (const row of entries.rows) {
    console.log('#' + row.id + ' ' + row.timestamp_et + ' | ' + row.crypto + ' ' + row.side + ' | ' + row.strategy_name);
}

await pool.end();
