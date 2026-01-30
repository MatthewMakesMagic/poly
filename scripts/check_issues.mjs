import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('='.repeat(80));
console.log('1. POSITION SIZE CHECK');
console.log('='.repeat(80));

const sizes = await pool.query(`
    SELECT size, COUNT(*) as count, MIN(timestamp_et) as first, MAX(timestamp_et) as last
    FROM live_trades
    WHERE type = 'entry'
    AND timestamp > NOW() - INTERVAL '12 hours'
    GROUP BY size
    ORDER BY size
`);

console.log('Entry sizes in last 12 hours:');
for (const row of sizes.rows) {
    console.log('  $' + row.size?.toFixed(2) + ': ' + row.count + ' trades (from ' + row.first + ' to ' + row.last + ')');
}

// Check most recent trades
const recent = await pool.query(`
    SELECT id, timestamp_et, crypto, size, strategy_name
    FROM live_trades
    WHERE type = 'entry'
    AND timestamp > NOW() - INTERVAL '2 hours'
    ORDER BY timestamp DESC
    LIMIT 10
`);

console.log('\nMost recent 10 entries:');
for (const row of recent.rows) {
    console.log('  #' + row.id + ' | ' + row.timestamp_et + ' | ' + row.crypto + ' | $' + row.size?.toFixed(2) + ' | ' + row.strategy_name);
}

console.log('\n' + '='.repeat(80));
console.log('2. POSITION CLEANUP CHECK - Do positions persist across windows?');
console.log('='.repeat(80));

// Check if there are entries in one window with exits in the NEXT window (bad)
const crossWindow = await pool.query(`
    WITH entries AS (
        SELECT window_epoch, crypto, strategy_name, COUNT(*) as entry_count
        FROM live_trades
        WHERE type = 'entry'
        AND timestamp > NOW() - INTERVAL '12 hours'
        GROUP BY window_epoch, crypto, strategy_name
    ),
    exits AS (
        SELECT window_epoch, crypto, strategy_name, COUNT(*) as exit_count
        FROM live_trades
        WHERE type IN ('exit', 'abandoned')
        AND timestamp > NOW() - INTERVAL '12 hours'
        GROUP BY window_epoch, crypto, strategy_name
    )
    SELECT e.window_epoch, e.crypto, e.strategy_name, e.entry_count, COALESCE(x.exit_count, 0) as exit_count,
           CASE WHEN x.exit_count IS NULL THEN 'NO EXIT' 
                WHEN x.exit_count < e.entry_count THEN 'PARTIAL EXIT'
                ELSE 'OK' END as status
    FROM entries e
    LEFT JOIN exits x ON e.window_epoch = x.window_epoch AND e.crypto = x.crypto AND e.strategy_name = x.strategy_name
    ORDER BY e.window_epoch DESC
    LIMIT 20
`);

console.log('Recent windows (entry/exit match):');
let noExitCount = 0;
for (const row of crossWindow.rows) {
    const windowTime = new Date(row.window_epoch * 1000).toISOString();
    const flag = row.status !== 'OK' ? ' ⚠️' : '';
    console.log('  ' + windowTime + ' | ' + row.crypto + ' | ' + row.strategy_name?.substring(0, 15) + ' | entries: ' + row.entry_count + ' exits: ' + row.exit_count + ' | ' + row.status + flag);
    if (row.status === 'NO EXIT') noExitCount++;
}

console.log('\nPositions with NO EXIT in last 12h:', noExitCount);

// Check for any positions that span multiple windows
const spanCheck = await pool.query(`
    SELECT DISTINCT e.crypto, e.window_epoch as entry_window, x.window_epoch as exit_window
    FROM live_trades e
    JOIN live_trades x ON e.crypto = x.crypto AND e.strategy_name = x.strategy_name
    WHERE e.type = 'entry'
    AND x.type IN ('exit', 'abandoned')
    AND e.window_epoch != x.window_epoch
    AND e.timestamp > NOW() - INTERVAL '12 hours'
    LIMIT 10
`);

if (spanCheck.rows.length > 0) {
    console.log('\n⚠️ CROSS-WINDOW POSITIONS FOUND:');
    for (const row of spanCheck.rows) {
        console.log('  ' + row.crypto + ': entry window ' + row.entry_window + ', exit window ' + row.exit_window);
    }
} else {
    console.log('\n✅ No cross-window positions detected');
}

await pool.end();
