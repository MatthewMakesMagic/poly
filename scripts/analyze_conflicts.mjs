import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    console.log('═'.repeat(80));
    console.log('  STRATEGY CONFLICT ANALYSIS');
    console.log('═'.repeat(80));
    
    // 1. Conflict frequency
    console.log('\n1. CONFLICT FREQUENCY (windows where strategies disagree):');
    console.log('   ' + '-'.repeat(70));
    
    const conflictCount = await pool.query(`
        WITH window_positions AS (
            SELECT 
                window_epoch,
                crypto,
                side,
                COUNT(*) as strategy_count
            FROM paper_trades
            GROUP BY window_epoch, crypto, side
        )
        SELECT 
            w1.crypto,
            COUNT(*) as conflict_windows,
            AVG(w1.strategy_count) as avg_up_strategies,
            AVG(w2.strategy_count) as avg_down_strategies
        FROM window_positions w1
        JOIN window_positions w2 ON w1.window_epoch = w2.window_epoch 
            AND w1.crypto = w2.crypto
            AND w1.side = 'up' AND w2.side = 'down'
        GROUP BY w1.crypto
    `);
    
    console.log('   Crypto | Conflict Windows | Avg UP strats | Avg DOWN strats');
    console.log('   ' + '-'.repeat(60));
    
    for (const c of conflictCount.rows) {
        console.log(`   ${c.crypto.toUpperCase().padEnd(6)} | ${String(c.conflict_windows).padStart(16)} | ${parseFloat(c.avg_up_strategies).toFixed(1).padStart(13)} | ${parseFloat(c.avg_down_strategies).toFixed(1).padStart(15)}`);
    }
    
    // 2. Total windows traded
    const totalWindows = await pool.query(`
        SELECT crypto, COUNT(DISTINCT window_epoch) as total_windows
        FROM paper_trades
        GROUP BY crypto
    `);
    
    console.log('\n   Total windows traded per crypto:');
    for (const t of totalWindows.rows) {
        console.log(`   ${t.crypto.toUpperCase()}: ${t.total_windows} windows`);
    }
    
    // 3. Net position if combined
    console.log('\n\n2. NET POSITION ANALYSIS (if all strategies combined):');
    console.log('   ' + '-'.repeat(70));
    
    const netPositions = await pool.query(`
        SELECT 
            window_epoch,
            crypto,
            SUM(CASE WHEN side = 'up' THEN 100 ELSE -100 END) as net_position,
            SUM(CASE WHEN side = 'up' THEN 1 ELSE 0 END) as up_count,
            SUM(CASE WHEN side = 'down' THEN 1 ELSE 0 END) as down_count,
            SUM(pnl) as total_pnl
        FROM paper_trades
        GROUP BY window_epoch, crypto
        ORDER BY window_epoch DESC
        LIMIT 20
    `);
    
    console.log('   Time     | Crypto | Net Pos  | UP/DOWN | Combined PnL');
    console.log('   ' + '-'.repeat(60));
    
    for (const n of netPositions.rows) {
        const time = new Date(n.window_epoch * 1000).toISOString().slice(11, 19);
        const net = (parseFloat(n.net_position) >= 0 ? '+' : '') + parseFloat(n.net_position).toFixed(0);
        const pnl = (parseFloat(n.total_pnl) >= 0 ? '+' : '') + parseFloat(n.total_pnl).toFixed(0);
        console.log(`   ${time} | ${n.crypto.toUpperCase().padEnd(6)} | ${net.padStart(8)} | ${n.up_count}/${n.down_count}     | $${pnl}`);
    }
    
    // 4. Find non-conflicting strategy pairs
    console.log('\n\n3. NON-CONFLICTING STRATEGY PAIRS (never take opposite sides):');
    console.log('   ' + '-'.repeat(70));
    
    const pairs = await pool.query(`
        WITH strat_pairs AS (
            SELECT 
                p1.strategy_name as s1,
                p2.strategy_name as s2,
                COUNT(*) as same_windows,
                SUM(CASE WHEN p1.side != p2.side THEN 1 ELSE 0 END) as conflicts,
                SUM(p1.pnl + p2.pnl) as combined_pnl
            FROM paper_trades p1
            JOIN paper_trades p2 ON p1.window_epoch = p2.window_epoch 
                AND p1.crypto = p2.crypto
                AND p1.strategy_name < p2.strategy_name
            GROUP BY p1.strategy_name, p2.strategy_name
            HAVING COUNT(*) >= 10
        )
        SELECT *,
               ROUND(conflicts::numeric / same_windows * 100, 1) as conflict_pct
        FROM strat_pairs
        WHERE conflicts = 0
        ORDER BY combined_pnl DESC
        LIMIT 15
    `);
    
    console.log('   Strategy 1                | Strategy 2                | Windows | Combined PnL');
    console.log('   ' + '-'.repeat(75));
    
    for (const p of pairs.rows) {
        const pnl = parseFloat(p.combined_pnl).toFixed(0);
        console.log(`   ${p.s1.padEnd(25)} | ${p.s2.padEnd(25)} | ${String(p.same_windows).padStart(7)} | $${pnl.padStart(10)}`);
    }
    
    // 5. Strategy "camps" - which strategies tend to agree
    console.log('\n\n4. STRATEGY ALIGNMENT (which strategies usually agree):');
    console.log('   ' + '-'.repeat(70));
    
    const alignment = await pool.query(`
        WITH strat_pairs AS (
            SELECT 
                p1.strategy_name as s1,
                p2.strategy_name as s2,
                COUNT(*) as same_windows,
                SUM(CASE WHEN p1.side = p2.side THEN 1 ELSE 0 END) as agree,
                SUM(CASE WHEN p1.side != p2.side THEN 1 ELSE 0 END) as disagree
            FROM paper_trades p1
            JOIN paper_trades p2 ON p1.window_epoch = p2.window_epoch 
                AND p1.crypto = p2.crypto
                AND p1.strategy_name < p2.strategy_name
            GROUP BY p1.strategy_name, p2.strategy_name
            HAVING COUNT(*) >= 20
        )
        SELECT *,
               ROUND(agree::numeric / same_windows * 100, 1) as agree_pct
        FROM strat_pairs
        ORDER BY agree_pct DESC
        LIMIT 15
    `);
    
    console.log('   Strategy 1                | Strategy 2                | Agree% | Conflicts');
    console.log('   ' + '-'.repeat(75));
    
    for (const a of alignment.rows) {
        console.log(`   ${a.s1.padEnd(25)} | ${a.s2.padEnd(25)} | ${String(a.agree_pct).padStart(5)}% | ${a.disagree}`);
    }
    
    // 6. Which strategies conflict most
    console.log('\n\n5. MOST CONFLICTING STRATEGIES:');
    console.log('   ' + '-'.repeat(70));
    
    const conflicting = await pool.query(`
        WITH strat_pairs AS (
            SELECT 
                p1.strategy_name as s1,
                p2.strategy_name as s2,
                COUNT(*) as same_windows,
                SUM(CASE WHEN p1.side != p2.side THEN 1 ELSE 0 END) as conflicts
            FROM paper_trades p1
            JOIN paper_trades p2 ON p1.window_epoch = p2.window_epoch 
                AND p1.crypto = p2.crypto
                AND p1.strategy_name < p2.strategy_name
            GROUP BY p1.strategy_name, p2.strategy_name
            HAVING COUNT(*) >= 20
        )
        SELECT *,
               ROUND(conflicts::numeric / same_windows * 100, 1) as conflict_pct
        FROM strat_pairs
        ORDER BY conflict_pct DESC
        LIMIT 15
    `);
    
    console.log('   Strategy 1                | Strategy 2                | Conflict% | Count');
    console.log('   ' + '-'.repeat(75));
    
    for (const c of conflicting.rows) {
        console.log(`   ${c.s1.padEnd(25)} | ${c.s2.padEnd(25)} | ${String(c.conflict_pct).padStart(8)}% | ${c.conflicts}`);
    }
    
    console.log('\n' + '═'.repeat(80));
    await pool.end();
}

main().catch(e => { console.error(e); pool.end(); });
