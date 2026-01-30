import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('POSITION CLEANUP VERIFICATION');
console.log('='.repeat(80));

// Check each window individually
const windows = await pool.query(`
    SELECT DISTINCT window_epoch 
    FROM live_trades 
    WHERE timestamp > NOW() - INTERVAL '6 hours'
    ORDER BY window_epoch DESC
`);

console.log('Checking last 6 hours of windows...\n');

let orphanedCount = 0;
for (const w of windows.rows) {
    const epoch = w.window_epoch;
    
    // Get entries for this window
    const entries = await pool.query(`
        SELECT crypto, strategy_name, side, COUNT(*) as cnt
        FROM live_trades
        WHERE window_epoch = $1 AND type = 'entry'
        GROUP BY crypto, strategy_name, side
    `, [epoch]);
    
    // Get exits for this window  
    const exits = await pool.query(`
        SELECT crypto, strategy_name, side, COUNT(*) as cnt
        FROM live_trades
        WHERE window_epoch = $1 AND type IN ('exit', 'abandoned')
        GROUP BY crypto, strategy_name, side
    `, [epoch]);
    
    // Create exit lookup
    const exitLookup = {};
    for (const e of exits.rows) {
        const key = e.crypto + '-' + e.strategy_name + '-' + e.side;
        exitLookup[key] = e.cnt;
    }
    
    // Check for orphaned entries
    for (const entry of entries.rows) {
        const key = entry.crypto + '-' + entry.strategy_name + '-' + entry.side;
        const exitCount = exitLookup[key] || 0;
        
        if (exitCount < entry.cnt) {
            const windowTime = new Date(epoch * 1000).toISOString();
            console.log('ORPHANED: ' + windowTime + ' | ' + entry.crypto + ' ' + entry.side + ' | ' + entry.strategy_name);
            console.log('   Entries: ' + entry.cnt + ', Exits: ' + exitCount);
            orphanedCount++;
        }
    }
}

if (orphanedCount === 0) {
    console.log('All positions have corresponding exits - cleanup working correctly!');
} else {
    console.log('\nFound ' + orphanedCount + ' orphaned position groups');
}

await pool.end();
