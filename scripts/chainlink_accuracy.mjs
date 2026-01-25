/**
 * Chainlink vs Binance Resolution Accuracy Analysis
 * Checks how well each price source predicts actual market resolution
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const hoursBack = parseInt(process.argv[2]) || 48;
    const cutoffMs = Date.now() - (hoursBack * 60 * 60 * 1000);
    
    console.log('═'.repeat(80));
    console.log('  CHAINLINK vs BINANCE RESOLUTION ACCURACY');
    console.log('═'.repeat(80));
    console.log(`  Analysis Time: ${new Date().toISOString()}`);
    console.log(`  Looking back: ${hoursBack} hours`);
    console.log();
    
    // ========================================
    // 1. OVERALL TICK STATS WITH CHAINLINK
    // ========================================
    
    console.log('1. OVERALL CHAINLINK DATA STATUS');
    console.log('   ' + '-'.repeat(70));
    
    const tickStats = await pool.query(`
        SELECT 
            crypto,
            COUNT(*) as total_ticks,
            COUNT(chainlink_price) as with_chainlink,
            AVG(CASE WHEN chainlink_price IS NOT NULL THEN ABS(price_divergence_pct) END) as avg_div,
            MAX(CASE WHEN chainlink_price IS NOT NULL THEN ABS(price_divergence_pct) END) as max_div,
            AVG(CASE WHEN chainlink_price IS NOT NULL THEN chainlink_staleness END) as avg_staleness
        FROM ticks
        WHERE timestamp_ms >= $1
        GROUP BY crypto
        ORDER BY crypto
    `, [cutoffMs]);
    
    console.log('   Crypto | Total    | W/CL     | Avg |Div|% | Max Div%  | Avg Stale');
    console.log('   ' + '-'.repeat(70));
    
    for (const r of tickStats.rows) {
        const crypto = r.crypto.toUpperCase().padEnd(6);
        const total = String(r.total_ticks).padStart(8);
        const withCl = String(r.with_chainlink).padStart(8);
        const avgDiv = parseFloat(r.avg_div || 0).toFixed(4).padStart(9);
        const maxDiv = parseFloat(r.max_div || 0).toFixed(4).padStart(9);
        const stale = parseFloat(r.avg_staleness || 0).toFixed(0).padStart(5) + 's';
        console.log(`   ${crypto} | ${total} | ${withCl} | ${avgDiv}% | ${maxDiv}% | ${stale}`);
    }
    console.log();
    
    // ========================================
    // 2. EXAMINE WINDOWS WITH ACTUAL PRICES
    // ========================================
    
    console.log('2. WINDOWS WITH RESOLUTION DATA');
    console.log('   ' + '-'.repeat(70));
    
    const windowsWithPrices = await pool.query(`
        SELECT 
            crypto,
            epoch,
            outcome,
            start_price,
            end_price,
            opening_up_price,
            closing_up_price,
            resolved_at
        FROM windows
        WHERE outcome IS NOT NULL
          AND start_price > 0
          AND end_price > 0
        ORDER BY epoch DESC
        LIMIT 20
    `);
    
    if (windowsWithPrices.rows.length === 0) {
        console.log('   No windows with valid price data found.');
        console.log('   Start/end prices may not be recorded properly.');
    } else {
        console.log('   Time             | Crypto | Outcome | Start$    | End$      | Δ%');
        console.log('   ' + '-'.repeat(70));
        for (const r of windowsWithPrices.rows) {
            const time = new Date(r.epoch * 1000).toISOString().slice(0, 19);
            const crypto = r.crypto.toUpperCase().padEnd(6);
            const outcome = r.outcome.toUpperCase().padEnd(4);
            const start = parseFloat(r.start_price).toFixed(2).padStart(9);
            const end = parseFloat(r.end_price).toFixed(2).padStart(9);
            const delta = ((r.end_price - r.start_price) / r.start_price * 100).toFixed(3);
            console.log(`   ${time} | ${crypto} | ${outcome}    | $${start} | $${end} | ${delta}%`);
        }
    }
    console.log();
    
    // ========================================
    // 3. GET FINAL TICK DATA NEAR RESOLUTION
    // ========================================
    
    console.log('3. BINANCE vs CHAINLINK AT WINDOW END (Last 2 mins)');
    console.log('   ' + '-'.repeat(70));
    
    // Get ticks near window end with chainlink data
    const finalTicks = await pool.query(`
        WITH ranked AS (
            SELECT 
                t.crypto,
                t.window_epoch,
                t.timestamp_ms,
                t.time_remaining_sec,
                t.spot_price as binance_price,
                t.chainlink_price,
                t.price_to_beat,
                t.price_divergence_pct,
                t.chainlink_staleness,
                w.outcome,
                ROW_NUMBER() OVER (
                    PARTITION BY t.crypto, t.window_epoch 
                    ORDER BY t.time_remaining_sec ASC
                ) as rn
            FROM ticks t
            JOIN windows w ON t.crypto = w.crypto AND t.window_epoch = w.epoch
            WHERE t.chainlink_price IS NOT NULL
              AND t.time_remaining_sec < 120
              AND t.time_remaining_sec > 0
              AND w.outcome IS NOT NULL
              AND t.timestamp_ms >= $1
        )
        SELECT * FROM ranked WHERE rn = 1
        ORDER BY window_epoch DESC
        LIMIT 30
    `, [cutoffMs]);
    
    if (finalTicks.rows.length === 0) {
        console.log('   No data found with Chainlink prices near resolution.');
        console.log('   Either Chainlink collector not running or no recent resolutions.');
    } else {
        let binanceCorrect = 0;
        let chainlinkCorrect = 0;
        let bothAgree = 0;
        let bothCorrect = 0;
        let total = 0;
        
        console.log('   Window             | Crypto | Time| Actual | B pred | CL pred | Div%   | Winner');
        console.log('   ' + '-'.repeat(80));
        
        for (const r of finalTicks.rows) {
            total++;
            
            // Calculate predictions based on price vs price_to_beat
            const binancePred = r.binance_price > r.price_to_beat ? 'up' : 'down';
            const chainlinkPred = r.chainlink_price > r.price_to_beat ? 'up' : 'down';
            const actual = r.outcome;
            
            const binanceWin = binancePred === actual;
            const chainlinkWin = chainlinkPred === actual;
            const agree = binancePred === chainlinkPred;
            
            if (binanceWin) binanceCorrect++;
            if (chainlinkWin) chainlinkCorrect++;
            if (agree) bothAgree++;
            if (agree && binanceWin) bothCorrect++;
            
            const time = new Date(r.window_epoch * 1000).toISOString().slice(5, 19);
            const crypto = r.crypto.toUpperCase().padEnd(6);
            const remaining = r.time_remaining_sec.toFixed(0).padStart(3) + 's';
            const actualStr = actual.toUpperCase().padEnd(4);
            const binanceStr = (binanceWin ? '✓' : '✗') + binancePred.toUpperCase().padEnd(4);
            const chainlinkStr = (chainlinkWin ? '✓' : '✗') + chainlinkPred.toUpperCase().padEnd(4);
            const div = parseFloat(r.price_divergence_pct || 0).toFixed(3).padStart(6);
            const winner = agree && binanceWin ? 'BOTH ✓' :
                          chainlinkWin && !binanceWin ? 'CL ONLY ✓' :
                          binanceWin && !chainlinkWin ? 'BIN ONLY ✓' :
                          'NEITHER';
            
            console.log(`   ${time} | ${crypto} | ${remaining}| ${actualStr}   | ${binanceStr} | ${chainlinkStr}  | ${div}% | ${winner}`);
        }
        
        console.log();
        console.log('   PREDICTION ACCURACY SUMMARY:');
        console.log('   ' + '-'.repeat(50));
        console.log(`   Windows analyzed:   ${total}`);
        console.log(`   Binance correct:    ${binanceCorrect}/${total} (${(binanceCorrect/total*100).toFixed(1)}%)`);
        console.log(`   Chainlink correct:  ${chainlinkCorrect}/${total} (${(chainlinkCorrect/total*100).toFixed(1)}%)`);
        console.log(`   Both agree:         ${bothAgree}/${total} (${(bothAgree/total*100).toFixed(1)}%)`);
        console.log(`   Both correct:       ${bothCorrect}/${total} (${(bothCorrect/total*100).toFixed(1)}%)`);
        
        const disagreements = total - bothAgree;
        const chainlinkWinsDisagree = chainlinkCorrect - bothCorrect;
        const binanceWinsDisagree = binanceCorrect - bothCorrect;
        
        console.log();
        console.log(`   When they disagree (${disagreements} times):`);
        console.log(`     Chainlink wins: ${chainlinkWinsDisagree}`);
        console.log(`     Binance wins:   ${binanceWinsDisagree}`);
        
        if (chainlinkCorrect > binanceCorrect) {
            console.log('\n   📊 CONCLUSION: Chainlink is more predictive of resolution');
            console.log('      This confirms Polymarket resolves using Chainlink, not Binance');
        } else if (binanceCorrect > chainlinkCorrect) {
            console.log('\n   ⚠️ CONCLUSION: Binance more accurate - this is unexpected');
            console.log('      May indicate timing issues or staleness in Chainlink');
        } else {
            console.log('\n   ≈ CONCLUSION: Both equally predictive in this sample');
        }
    }
    console.log();
    
    // ========================================
    // 4. DIVERGENCE DISTRIBUTION
    // ========================================
    
    console.log('4. DIVERGENCE SIZE WHEN PREDICTIONS DIFFER');
    console.log('   ' + '-'.repeat(70));
    
    const divergenceWhenDifferent = await pool.query(`
        WITH near_end AS (
            SELECT 
                t.crypto,
                t.window_epoch,
                t.spot_price as binance,
                t.chainlink_price as chainlink,
                t.price_to_beat,
                t.price_divergence_pct,
                w.outcome
            FROM ticks t
            JOIN windows w ON t.crypto = w.crypto AND t.window_epoch = w.epoch
            WHERE t.chainlink_price IS NOT NULL
              AND t.time_remaining_sec < 120
              AND w.outcome IS NOT NULL
              AND t.timestamp_ms >= $1
        )
        SELECT 
            CASE 
                WHEN (binance > price_to_beat) != (chainlink > price_to_beat) THEN 'DISAGREE'
                ELSE 'AGREE'
            END as agreement,
            COUNT(*) as count,
            AVG(ABS(price_divergence_pct)) as avg_div,
            MAX(ABS(price_divergence_pct)) as max_div
        FROM near_end
        GROUP BY agreement
    `, [cutoffMs]);
    
    console.log('   Agreement  | Count | Avg |Div|% | Max |Div|%');
    console.log('   ' + '-'.repeat(50));
    for (const r of divergenceWhenDifferent.rows) {
        const agreement = r.agreement.padEnd(10);
        const count = String(r.count).padStart(5);
        const avgDiv = parseFloat(r.avg_div || 0).toFixed(4).padStart(9);
        const maxDiv = parseFloat(r.max_div || 0).toFixed(4).padStart(9);
        console.log(`   ${agreement} | ${count} | ${avgDiv}% | ${maxDiv}%`);
    }
    
    console.log();
    console.log('═'.repeat(80));
    console.log('  END OF CHAINLINK ACCURACY ANALYSIS');
    console.log('═'.repeat(80));
    
    await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
