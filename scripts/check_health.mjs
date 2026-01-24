/**
 * Check collector health and identify gaps
 * 
 * Run: node scripts/check_health.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    console.log('═'.repeat(70));
    console.log('  COLLECTOR HEALTH CHECK');
    console.log('═'.repeat(70));
    console.log();
    
    // Check latest health ping
    const healthPing = await pool.query(`
        SELECT value, updated_at 
        FROM system_state 
        WHERE key = 'collector_health'
    `);
    
    if (healthPing.rows.length > 0) {
        const health = JSON.parse(healthPing.rows[0].value);
        const age = (Date.now() - new Date(health.timestamp).getTime()) / 1000;
        
        console.log('LATEST HEALTH PING:');
        console.log('-'.repeat(50));
        console.log(`  Timestamp:  ${health.timestamp}`);
        console.log(`  Age:        ${age.toFixed(0)} seconds ago`);
        console.log(`  Uptime:     ${(health.uptime / 60).toFixed(1)} minutes`);
        console.log(`  Memory:     ${health.memory?.toFixed(1) || '?'} MB`);
        console.log(`  Ticks:      ${health.ticks}`);
        console.log(`  Errors:     ${health.errors}`);
        console.log(`  Reconnects: ${health.reconnects}`);
        
        if (age > 120) {
            console.log(`\n  ⚠️  STALE HEALTH PING (${age.toFixed(0)}s old) - Collector may be down!`);
        } else {
            console.log(`\n  ✅ Collector appears healthy`);
        }
    } else {
        console.log('  No health pings yet (feature just deployed)');
    }
    
    console.log();
    
    // Check recent tick activity
    const tickActivity = await pool.query(`
        SELECT 
            DATE_TRUNC('hour', to_timestamp(timestamp_ms/1000)) as hour,
            COUNT(*) as ticks
        FROM ticks
        WHERE timestamp_ms > (EXTRACT(EPOCH FROM NOW() - INTERVAL '6 hours') * 1000)
        GROUP BY hour
        ORDER BY hour DESC
    `);
    
    console.log('TICK ACTIVITY (last 6 hours):');
    console.log('-'.repeat(50));
    
    for (const row of tickActivity.rows) {
        const hourStr = new Date(row.hour).toISOString().substr(11, 5);
        const bar = '█'.repeat(Math.min(50, Math.floor(row.ticks / 300)));
        console.log(`  ${hourStr} UTC | ${String(row.ticks).padStart(6)} | ${bar}`);
    }
    
    // Find gaps in last 24 hours
    console.log();
    console.log('GAPS > 5 MINUTES (last 24h):');
    console.log('-'.repeat(50));
    
    const minutes = await pool.query(`
        SELECT DATE_TRUNC('minute', to_timestamp(timestamp_ms/1000)) as minute
        FROM ticks
        WHERE timestamp_ms > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)
        GROUP BY minute
        ORDER BY minute
    `);
    
    let lastMinute = null;
    let gaps = [];
    
    for (const row of minutes.rows) {
        const thisMinute = new Date(row.minute);
        if (lastMinute) {
            const gap = (thisMinute - lastMinute) / 1000 / 60;
            if (gap > 5) {
                gaps.push({ from: lastMinute, to: thisMinute, minutes: gap });
            }
        }
        lastMinute = thisMinute;
    }
    
    if (gaps.length === 0) {
        console.log('  ✅ No significant gaps found!');
    } else {
        for (const g of gaps) {
            const fromStr = g.from.toISOString().substr(11, 8);
            const toStr = g.to.toISOString().substr(11, 8);
            console.log(`  ⚠️  ${fromStr} → ${toStr} (${g.minutes.toFixed(0)} min gap)`);
        }
        console.log(`\n  Total: ${gaps.length} gaps, ${gaps.reduce((sum, g) => sum + g.minutes, 0).toFixed(0)} minutes lost`);
    }
    
    // Check current tick rate
    console.log();
    console.log('CURRENT STATUS:');
    console.log('-'.repeat(50));
    
    const latestTick = await pool.query(`
        SELECT MAX(timestamp_ms) as latest FROM ticks
    `);
    
    const tickAge = (Date.now() - parseInt(latestTick.rows[0].latest)) / 1000;
    console.log(`  Latest tick: ${tickAge.toFixed(0)} seconds ago`);
    
    if (tickAge > 60) {
        console.log(`  ⚠️  No ticks for ${tickAge.toFixed(0)}s - Collector may be down!`);
    } else {
        console.log(`  ✅ Collector is active`);
    }
    
    await pool.end();
}

main().catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
});
