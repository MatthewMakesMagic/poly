import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function check() {
    console.log('═'.repeat(80));
    console.log('  FULL DATABASE STATUS');
    console.log('═'.repeat(80));
    
    // Trades
    const trades = await pool.query("SELECT COUNT(*) as total, COUNT(CASE WHEN mode = 'paper' THEN 1 END) as paper, COUNT(CASE WHEN mode = 'live' THEN 1 END) as live FROM trades");
    console.log('\n📊 TRADES TABLE:');
    console.log('   Total:', trades.rows[0].total, '| Paper:', trades.rows[0].paper, '| Live:', trades.rows[0].live);
    
    // Recent paper trades (if any)
    const recentPaper = await pool.query("SELECT strategy, crypto, timestamp_ms, side, realized_pnl FROM trades WHERE mode = 'paper' ORDER BY timestamp_ms DESC LIMIT 10");
    if (recentPaper.rows.length > 0) {
        console.log('\n   Most recent paper trades:');
        for (const r of recentPaper.rows) {
            console.log('   ', new Date(parseInt(r.timestamp_ms)).toISOString(), r.crypto, r.side, r.strategy, 'PnL:', r.realized_pnl);
        }
    } else {
        console.log('\n   No paper trades in database');
    }
    
    // Windows
    const windows = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END) as resolved FROM windows');
    console.log('\n📊 WINDOWS TABLE:');
    console.log('   Total:', windows.rows[0].total, '| Resolved:', windows.rows[0].resolved);
    
    // Recent resolved windows
    const recentWindows = await pool.query('SELECT crypto, epoch, outcome, start_price, end_price FROM windows WHERE outcome IS NOT NULL ORDER BY epoch DESC LIMIT 10');
    if (recentWindows.rows.length > 0) {
        console.log('\n   Most recent resolved windows:');
        for (const r of recentWindows.rows) {
            const delta = r.start_price > 0 ? ((r.end_price - r.start_price) / r.start_price * 100).toFixed(3) : '0';
            console.log('   ', new Date(r.epoch * 1000).toISOString(), r.crypto, r.outcome, 'Δ:', delta + '%');
        }
    } else {
        console.log('\n   No resolved windows yet');
    }
    
    // Ticks summary
    const ticks = await pool.query('SELECT COUNT(*) as total, COUNT(chainlink_price) as with_chainlink, MIN(timestamp_ms) as first, MAX(timestamp_ms) as last FROM ticks');
    console.log('\n📊 TICKS TABLE:');
    console.log('   Total:', ticks.rows[0].total, '| With Chainlink:', ticks.rows[0].with_chainlink);
    if (ticks.rows[0].first) {
        console.log('   Range:', new Date(parseInt(ticks.rows[0].first)).toISOString(), 'to', new Date(parseInt(ticks.rows[0].last)).toISOString());
    }
    
    // Check Chainlink data specifically
    const chainlink = await pool.query('SELECT crypto, COUNT(*) as ticks, AVG(ABS(price_divergence_pct)) as avg_div FROM ticks WHERE chainlink_price IS NOT NULL GROUP BY crypto');
    if (chainlink.rows.length > 0) {
        console.log('\n📊 CHAINLINK DATA BY CRYPTO:');
        for (const r of chainlink.rows) {
            console.log('   ', r.crypto.toUpperCase() + ':', r.ticks, 'ticks, avg divergence:', parseFloat(r.avg_div || 0).toFixed(4) + '%');
        }
    } else {
        console.log('\n   ⚠️ No Chainlink price data in database');
    }
    
    // Positions
    const positions = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN is_open = 1 THEN 1 END) as open FROM positions');
    console.log('\n📊 POSITIONS TABLE:');
    console.log('   Total:', positions.rows[0].total, '| Open:', positions.rows[0].open);
    
    // Open positions details
    const openPos = await pool.query('SELECT * FROM positions WHERE is_open = 1');
    if (openPos.rows.length > 0) {
        console.log('\n   Open positions:');
        for (const p of openPos.rows) {
            console.log('   ', p.mode, p.crypto, p.side, 'size:', p.size, 'entry:', p.avg_entry_price);
        }
    }
    
    console.log('\n' + '═'.repeat(80));
    await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
