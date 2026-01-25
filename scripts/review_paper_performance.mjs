/**
 * Paper Trading Performance Review
 * 
 * Reviews recent paper trading performance and compares against Chainlink resolution.
 * Run: node scripts/review_paper_performance.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const hoursBack = parseInt(process.argv[2]) || 6;
    const cutoffMs = Date.now() - (hoursBack * 60 * 60 * 1000);
    
    console.log('═'.repeat(80));
    console.log('  PAPER TRADING PERFORMANCE REVIEW - Last', hoursBack, 'Hours');
    console.log('═'.repeat(80));
    console.log(`  Analysis Time: ${new Date().toISOString()}`);
    console.log(`  Looking back from: ${new Date(cutoffMs).toISOString()}`);
    console.log();
    
    // ========================================
    // 1. TRADE SUMMARY
    // ========================================
    
    console.log('1. TRADE ACTIVITY SUMMARY');
    console.log('   ' + '-'.repeat(70));
    
    const tradesSummary = await pool.query(`
        SELECT 
            strategy,
            crypto,
            COUNT(*) as trade_count,
            SUM(CASE WHEN side LIKE 'buy%' THEN 1 ELSE 0 END) as entries,
            SUM(CASE WHEN side LIKE 'sell%' THEN 1 ELSE 0 END) as exits,
            SUM(size) as total_volume,
            SUM(fee) as total_fees
        FROM trades
        WHERE mode = 'paper'
          AND timestamp_ms >= $1
        GROUP BY strategy, crypto
        ORDER BY strategy, crypto
    `, [cutoffMs]);
    
    if (tradesSummary.rows.length === 0) {
        console.log('   No paper trades found in the last', hoursBack, 'hours.');
        console.log('   Paper trading may not be running, or no signals triggered.');
    } else {
        console.log('   Strategy                  | Crypto | Trades | Vol($)   | Fees($)');
        console.log('   ' + '-'.repeat(70));
        
        for (const row of tradesSummary.rows) {
            const strat = (row.strategy || 'unknown').substring(0, 25).padEnd(25);
            const crypto = (row.crypto || 'n/a').toUpperCase().padEnd(6);
            const trades = String(row.trade_count).padStart(6);
            const vol = parseFloat(row.total_volume || 0).toFixed(2).padStart(8);
            const fees = parseFloat(row.total_fees || 0).toFixed(4).padStart(7);
            console.log(`   ${strat} | ${crypto} | ${trades} | ${vol} | ${fees}`);
        }
    }
    console.log();
    
    // ========================================
    // 2. P&L ANALYSIS  
    // ========================================
    
    console.log('2. PROFIT & LOSS ANALYSIS');
    console.log('   ' + '-'.repeat(70));
    
    const pnlAnalysis = await pool.query(`
        SELECT 
            strategy,
            crypto,
            COUNT(*) as closed_trades,
            SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
            SUM(realized_pnl) as total_pnl,
            AVG(realized_pnl) as avg_pnl,
            MAX(realized_pnl) as best_trade,
            MIN(realized_pnl) as worst_trade
        FROM trades
        WHERE mode = 'paper'
          AND timestamp_ms >= $1
          AND realized_pnl IS NOT NULL
        GROUP BY strategy, crypto
        ORDER BY total_pnl DESC
    `, [cutoffMs]);
    
    if (pnlAnalysis.rows.length === 0) {
        console.log('   No closed trades with P&L data found.');
    } else {
        console.log('   Strategy                  | Crypto | W/L      | Win%   | Total P&L | Avg Trade');
        console.log('   ' + '-'.repeat(75));
        
        for (const row of pnlAnalysis.rows) {
            const strat = (row.strategy || 'unknown').substring(0, 25).padEnd(25);
            const crypto = (row.crypto || 'n/a').toUpperCase().padEnd(6);
            const wl = `${row.wins}/${row.losses}`.padEnd(8);
            const total = parseInt(row.wins) + parseInt(row.losses);
            const winRate = total > 0 ? ((row.wins / total) * 100).toFixed(1) : '0.0';
            const totalPnl = parseFloat(row.total_pnl || 0).toFixed(2);
            const avgPnl = parseFloat(row.avg_pnl || 0).toFixed(4);
            const pnlSign = parseFloat(totalPnl) >= 0 ? '+' : '';
            console.log(`   ${strat} | ${crypto} | ${wl} | ${winRate.padStart(5)}% | ${pnlSign}$${totalPnl.padStart(7)} | $${avgPnl}`);
        }
    }
    console.log();
    
    // ========================================
    // 3. RECENT TRADES DETAIL
    // ========================================
    
    console.log('3. RECENT TRADES (Last 20)');
    console.log('   ' + '-'.repeat(70));
    
    const recentTrades = await pool.query(`
        SELECT 
            timestamp_ms,
            strategy,
            crypto,
            side,
            size,
            price,
            realized_pnl,
            notes
        FROM trades
        WHERE mode = 'paper'
          AND timestamp_ms >= $1
        ORDER BY timestamp_ms DESC
        LIMIT 20
    `, [cutoffMs]);
    
    if (recentTrades.rows.length === 0) {
        console.log('   No recent trades found.');
    } else {
        console.log('   Time (UTC)       | Crypto | Side     | Size($) | Price  | P&L');
        console.log('   ' + '-'.repeat(70));
        
        for (const row of recentTrades.rows) {
            const time = new Date(parseInt(row.timestamp_ms)).toISOString().slice(11, 19);
            const crypto = (row.crypto || 'n/a').toUpperCase().padEnd(6);
            const side = (row.side || '').padEnd(8);
            const size = parseFloat(row.size || 0).toFixed(2).padStart(7);
            const price = parseFloat(row.price || 0).toFixed(3).padStart(6);
            const pnl = row.realized_pnl !== null 
                ? (parseFloat(row.realized_pnl) >= 0 ? '+' : '') + parseFloat(row.realized_pnl).toFixed(4)
                : '-';
            console.log(`   ${time} | ${crypto} | ${side} | ${size} | ${price} | ${pnl.padStart(8)}`);
        }
    }
    console.log();
    
    // ========================================
    // 4. WINDOWS RESOLVED (Last Hours)
    // ========================================
    
    console.log('4. WINDOW RESOLUTIONS (Last', hoursBack, 'Hours)');
    console.log('   ' + '-'.repeat(70));
    
    // Get windows from the time period
    const epochCutoff = Math.floor(cutoffMs / 1000);
    const windowsResolved = await pool.query(`
        SELECT 
            crypto,
            epoch,
            start_price,
            end_price,
            outcome,
            resolved_at,
            opening_up_price,
            closing_up_price
        FROM windows
        WHERE epoch >= $1
          AND outcome IS NOT NULL
        ORDER BY epoch DESC
        LIMIT 30
    `, [epochCutoff]);
    
    if (windowsResolved.rows.length === 0) {
        console.log('   No resolved windows found in this period.');
    } else {
        console.log('   Time (UTC)       | Crypto | Start$    | End$      | Δ%     | Outcome | Close Up');
        console.log('   ' + '-'.repeat(80));
        
        for (const row of windowsResolved.rows) {
            const time = new Date(row.epoch * 1000).toISOString().slice(11, 19);
            const crypto = (row.crypto || 'n/a').toUpperCase().padEnd(6);
            const startP = parseFloat(row.start_price || 0).toFixed(2).padStart(9);
            const endP = parseFloat(row.end_price || 0).toFixed(2).padStart(9);
            const delta = row.start_price > 0 
                ? (((row.end_price - row.start_price) / row.start_price) * 100).toFixed(3)
                : '0.000';
            const deltaSign = parseFloat(delta) >= 0 ? '+' : '';
            const outcome = (row.outcome || '').toUpperCase().padEnd(4);
            const closeUp = parseFloat(row.closing_up_price || 0).toFixed(3);
            console.log(`   ${time} | ${crypto} | $${startP} | $${endP} | ${deltaSign}${delta.padStart(5)}% | ${outcome}    | ${closeUp}`);
        }
    }
    console.log();
    
    // ========================================
    // 5. CHAINLINK vs BINANCE COMPARISON
    // ========================================
    
    console.log('5. CHAINLINK vs BINANCE PRICE COMPARISON');
    console.log('   ' + '-'.repeat(70));
    
    // Check recent ticks with Chainlink data
    const chainlinkComparison = await pool.query(`
        SELECT 
            crypto,
            COUNT(*) as ticks,
            COUNT(chainlink_price) as with_chainlink,
            AVG(CASE WHEN chainlink_price IS NOT NULL THEN ABS(price_divergence_pct) END) as avg_abs_divergence,
            MAX(CASE WHEN chainlink_price IS NOT NULL THEN ABS(price_divergence_pct) END) as max_divergence,
            AVG(CASE WHEN chainlink_price IS NOT NULL THEN chainlink_staleness END) as avg_staleness
        FROM ticks
        WHERE timestamp_ms >= $1
        GROUP BY crypto
        ORDER BY crypto
    `, [cutoffMs]);
    
    const hasChainlinkData = chainlinkComparison.rows.some(r => parseInt(r.with_chainlink) > 0);
    
    if (!hasChainlinkData) {
        console.log('   No Chainlink price data collected in this period.');
        console.log('   Chainlink collector may need to be enabled or restarted.');
    } else {
        console.log('   Crypto | Ticks  | W/Chainlink | Avg |Div|% | Max Div% | Staleness');
        console.log('   ' + '-'.repeat(70));
        
        for (const row of chainlinkComparison.rows) {
            const crypto = row.crypto.toUpperCase().padEnd(6);
            const ticks = String(row.ticks).padStart(6);
            const withCl = String(row.with_chainlink).padStart(11);
            const avgDiv = parseFloat(row.avg_abs_divergence || 0).toFixed(4).padStart(9);
            const maxDiv = parseFloat(row.max_divergence || 0).toFixed(4).padStart(8);
            const stale = parseFloat(row.avg_staleness || 0).toFixed(0).padStart(5) + 's';
            console.log(`   ${crypto} | ${ticks} | ${withCl} | ${avgDiv}% | ${maxDiv}% | ${stale}`);
        }
    }
    console.log();
    
    // ========================================
    // 6. CHAINLINK RESOLUTION ACCURACY
    // ========================================
    
    console.log('6. RESOLUTION ACCURACY: CHAINLINK vs BINANCE');
    console.log('   ' + '-'.repeat(70));
    
    // Find windows where we have both prices near resolution
    const accuracyAnalysis = await pool.query(`
        WITH final_ticks AS (
            SELECT 
                t.crypto,
                t.window_epoch,
                t.spot_price as binance_price,
                t.chainlink_price,
                t.price_to_beat,
                w.outcome as actual_outcome,
                ROW_NUMBER() OVER (PARTITION BY t.crypto, t.window_epoch ORDER BY t.time_remaining_sec ASC) as rn
            FROM ticks t
            JOIN windows w ON t.crypto = w.crypto AND t.window_epoch = w.epoch
            WHERE t.timestamp_ms >= $1
              AND t.chainlink_price IS NOT NULL
              AND t.time_remaining_sec < 120
              AND w.outcome IS NOT NULL
        )
        SELECT 
            crypto,
            window_epoch,
            binance_price,
            chainlink_price,
            price_to_beat,
            actual_outcome,
            CASE WHEN binance_price > price_to_beat THEN 'up' ELSE 'down' END as binance_predicts,
            CASE WHEN chainlink_price > price_to_beat THEN 'up' ELSE 'down' END as chainlink_predicts
        FROM final_ticks
        WHERE rn = 1
        ORDER BY window_epoch DESC
    `, [cutoffMs]);
    
    if (accuracyAnalysis.rows.length === 0) {
        console.log('   No windows with Chainlink data near resolution found.');
        console.log('   Need more data collection for this analysis.');
    } else {
        let binanceCorrect = 0;
        let chainlinkCorrect = 0;
        let total = 0;
        
        console.log('   Window Time      | Crypto | Actual | Binance | Chainlink | Winner');
        console.log('   ' + '-'.repeat(70));
        
        for (const row of accuracyAnalysis.rows) {
            total++;
            const binanceWin = row.binance_predicts === row.actual_outcome;
            const chainlinkWin = row.chainlink_predicts === row.actual_outcome;
            if (binanceWin) binanceCorrect++;
            if (chainlinkWin) chainlinkCorrect++;
            
            const time = new Date(row.window_epoch * 1000).toISOString().slice(11, 19);
            const crypto = row.crypto.toUpperCase().padEnd(6);
            const actual = row.actual_outcome.toUpperCase().padEnd(4);
            const binance = row.binance_predicts.toUpperCase().padEnd(4);
            const chainlink = row.chainlink_predicts.toUpperCase().padEnd(4);
            const winner = binanceWin && chainlinkWin ? 'BOTH' :
                          chainlinkWin ? 'CL ✓' :
                          binanceWin ? 'BIN ✓' : 'NONE';
            console.log(`   ${time} | ${crypto} | ${actual}   | ${binance}    | ${chainlink}      | ${winner}`);
        }
        
        console.log();
        console.log('   ACCURACY SUMMARY:');
        console.log(`   Windows analyzed: ${total}`);
        console.log(`   Binance correct:   ${binanceCorrect}/${total} (${(binanceCorrect/total*100).toFixed(1)}%)`);
        console.log(`   Chainlink correct: ${chainlinkCorrect}/${total} (${(chainlinkCorrect/total*100).toFixed(1)}%)`);
        
        if (chainlinkCorrect > binanceCorrect) {
            console.log('\n   ✓ Chainlink is more predictive of actual resolution (expected)');
        } else if (binanceCorrect > chainlinkCorrect) {
            console.log('\n   ⚠️ Binance more accurate - unusual, may indicate timing issues');
        } else {
            console.log('\n   ≈ Both equally predictive in this sample');
        }
    }
    console.log();
    
    // ========================================
    // 7. DATA COLLECTION STATUS
    // ========================================
    
    console.log('7. DATA COLLECTION STATUS');
    console.log('   ' + '-'.repeat(70));
    
    const dataStatus = await pool.query(`
        SELECT 
            crypto,
            COUNT(*) as tick_count,
            MIN(timestamp_ms) as first_tick,
            MAX(timestamp_ms) as last_tick,
            COUNT(DISTINCT window_epoch) as windows_covered
        FROM ticks
        WHERE timestamp_ms >= $1
        GROUP BY crypto
        ORDER BY crypto
    `, [cutoffMs]);
    
    console.log('   Crypto | Ticks  | Windows | First Tick        | Last Tick         | Lag');
    console.log('   ' + '-'.repeat(80));
    
    for (const row of dataStatus.rows) {
        const crypto = row.crypto.toUpperCase().padEnd(6);
        const ticks = String(row.tick_count).padStart(6);
        const windows = String(row.windows_covered).padStart(7);
        const first = new Date(parseInt(row.first_tick)).toISOString().slice(11, 19);
        const last = new Date(parseInt(row.last_tick)).toISOString().slice(11, 19);
        const lagMs = Date.now() - parseInt(row.last_tick);
        const lagStr = lagMs < 60000 ? `${(lagMs/1000).toFixed(0)}s` : `${(lagMs/60000).toFixed(1)}m`;
        console.log(`   ${crypto} | ${ticks} | ${windows} | ${first} | ${last} | ${lagStr.padStart(5)}`);
    }
    
    console.log();
    console.log('═'.repeat(80));
    console.log('  END OF REPORT');
    console.log('═'.repeat(80));
    
    await pool.end();
}

main().catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
});
