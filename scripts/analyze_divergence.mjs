/**
 * Binance vs Chainlink Divergence Analysis
 * 
 * Analyzes the divergence between Binance (display) and Chainlink (resolution)
 * prices to identify trading opportunities.
 * 
 * Run: node scripts/analyze_divergence.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    console.log('═'.repeat(70));
    console.log('  BINANCE vs CHAINLINK DIVERGENCE ANALYSIS');
    console.log('═'.repeat(70));
    console.log();
    
    // ========================================
    // 1. Check if we have Chainlink data
    // ========================================
    
    const chainlinkCheck = await pool.query(`
        SELECT 
            COUNT(*) as total_ticks,
            COUNT(chainlink_price) as with_chainlink,
            MIN(timestamp_ms) as first_tick,
            MAX(timestamp_ms) as last_tick
        FROM ticks
        WHERE timestamp_ms > $1
    `, [Date.now() - 24 * 60 * 60 * 1000]); // Last 24 hours
    
    const check = chainlinkCheck.rows[0];
    const hasChainlink = parseInt(check.with_chainlink) > 0;
    
    console.log('1. DATA AVAILABILITY');
    console.log('   ' + '-'.repeat(50));
    console.log(`   Total ticks (24h): ${check.total_ticks}`);
    console.log(`   With Chainlink:    ${check.with_chainlink} (${(check.with_chainlink / check.total_ticks * 100).toFixed(1)}%)`);
    
    if (!hasChainlink) {
        console.log('\n   ⚠️  NO CHAINLINK DATA YET');
        console.log('   Chainlink tracking was just deployed.');
        console.log('   Run this script again in 15-30 minutes.\n');
        
        // Still show what analysis WILL be available
        console.log('   ANALYSIS THAT WILL BE AVAILABLE:');
        console.log('   - Divergence distribution by crypto');
        console.log('   - Staleness patterns');
        console.log('   - Resolution prediction accuracy');
        console.log('   - Optimal trading windows');
        
        await pool.end();
        return;
    }
    
    const timespan = (parseInt(check.last_tick) - parseInt(check.first_tick)) / 1000 / 60;
    console.log(`   Timespan:          ${timespan.toFixed(0)} minutes`);
    console.log();
    
    // ========================================
    // 2. Divergence Distribution
    // ========================================
    
    console.log('2. DIVERGENCE DISTRIBUTION');
    console.log('   ' + '-'.repeat(50));
    
    const divergenceStats = await pool.query(`
        SELECT 
            crypto,
            COUNT(*) as ticks,
            AVG(price_divergence_pct) as avg_divergence_pct,
            STDDEV(price_divergence_pct) as stddev_divergence_pct,
            MIN(price_divergence_pct) as min_divergence_pct,
            MAX(price_divergence_pct) as max_divergence_pct,
            AVG(ABS(price_divergence_pct)) as avg_abs_divergence_pct,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_divergence_pct) as median_divergence_pct,
            AVG(chainlink_staleness) as avg_staleness
        FROM ticks
        WHERE chainlink_price IS NOT NULL
        GROUP BY crypto
        ORDER BY crypto
    `);
    
    console.log('   Crypto | Ticks | Avg Div% | Abs Div% | Min/Max Div% | Avg Stale');
    console.log('   ' + '-'.repeat(65));
    
    for (const row of divergenceStats.rows) {
        const avgDiv = parseFloat(row.avg_divergence_pct || 0).toFixed(3);
        const absDiv = parseFloat(row.avg_abs_divergence_pct || 0).toFixed(3);
        const minDiv = parseFloat(row.min_divergence_pct || 0).toFixed(3);
        const maxDiv = parseFloat(row.max_divergence_pct || 0).toFixed(3);
        const stale = parseFloat(row.avg_staleness || 0).toFixed(0);
        
        console.log(`   ${row.crypto.toUpperCase().padEnd(6)} | ${String(row.ticks).padStart(5)} | ${avgDiv.padStart(7)}% | ${absDiv.padStart(7)}% | ${minDiv}/${maxDiv} | ${stale}s`);
    }
    console.log();
    
    // ========================================
    // 3. Divergence Buckets
    // ========================================
    
    console.log('3. DIVERGENCE FREQUENCY BUCKETS');
    console.log('   ' + '-'.repeat(50));
    
    const buckets = await pool.query(`
        SELECT 
            CASE 
                WHEN ABS(price_divergence_pct) < 0.05 THEN '< 0.05%'
                WHEN ABS(price_divergence_pct) < 0.10 THEN '0.05-0.10%'
                WHEN ABS(price_divergence_pct) < 0.20 THEN '0.10-0.20%'
                WHEN ABS(price_divergence_pct) < 0.50 THEN '0.20-0.50%'
                ELSE '> 0.50%'
            END as bucket,
            COUNT(*) as count,
            AVG(chainlink_staleness) as avg_staleness
        FROM ticks
        WHERE chainlink_price IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket
    `);
    
    const totalWithChainlink = buckets.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
    
    console.log('   Divergence   | Count  | % of Total | Avg Staleness');
    console.log('   ' + '-'.repeat(55));
    
    for (const row of buckets.rows) {
        const pct = (parseInt(row.count) / totalWithChainlink * 100).toFixed(1);
        const stale = parseFloat(row.avg_staleness || 0).toFixed(0);
        console.log(`   ${row.bucket.padEnd(12)} | ${String(row.count).padStart(6)} | ${pct.padStart(9)}% | ${stale}s`);
    }
    console.log();
    
    // ========================================
    // 4. Staleness Analysis
    // ========================================
    
    console.log('4. CHAINLINK STALENESS ANALYSIS');
    console.log('   ' + '-'.repeat(50));
    
    const stalenessStats = await pool.query(`
        SELECT 
            crypto,
            AVG(chainlink_staleness) as avg_stale,
            MAX(chainlink_staleness) as max_stale,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY chainlink_staleness) as p90_stale,
            SUM(CASE WHEN chainlink_staleness > 60 THEN 1 ELSE 0 END) as count_over_60s,
            COUNT(*) as total
        FROM ticks
        WHERE chainlink_price IS NOT NULL
        GROUP BY crypto
    `);
    
    console.log('   Crypto | Avg Stale | Max Stale | P90 Stale | >60s Count | % >60s');
    console.log('   ' + '-'.repeat(65));
    
    for (const row of stalenessStats.rows) {
        const pctOver60 = (parseInt(row.count_over_60s) / parseInt(row.total) * 100).toFixed(1);
        console.log(`   ${row.crypto.toUpperCase().padEnd(6)} | ${parseFloat(row.avg_stale).toFixed(0).padStart(9)}s | ${parseFloat(row.max_stale).toFixed(0).padStart(9)}s | ${parseFloat(row.p90_stale).toFixed(0).padStart(9)}s | ${String(row.count_over_60s).padStart(10)} | ${pctOver60}%`);
    }
    console.log();
    
    // ========================================
    // 5. Divergence vs Time Remaining
    // ========================================
    
    console.log('5. DIVERGENCE BY TIME REMAINING IN WINDOW');
    console.log('   ' + '-'.repeat(50));
    
    const timeAnalysis = await pool.query(`
        WITH phases AS (
            SELECT 
                CASE 
                    WHEN time_remaining_sec > 600 THEN 1
                    WHEN time_remaining_sec > 300 THEN 2
                    WHEN time_remaining_sec > 60 THEN 3
                    ELSE 4
                END as phase_order,
                CASE 
                    WHEN time_remaining_sec > 600 THEN 'Early (>10min)'
                    WHEN time_remaining_sec > 300 THEN 'Mid (5-10min)'
                    WHEN time_remaining_sec > 60 THEN 'Late (1-5min)'
                    ELSE 'Final (<1min)'
                END as phase,
                price_divergence_pct,
                chainlink_staleness
            FROM ticks
            WHERE chainlink_price IS NOT NULL
        )
        SELECT 
            phase,
            COUNT(*) as ticks,
            AVG(ABS(price_divergence_pct)) as avg_abs_div,
            AVG(chainlink_staleness) as avg_stale
        FROM phases
        GROUP BY phase_order, phase
        ORDER BY phase_order
    `);
    
    console.log('   Phase          | Ticks  | Avg |Div|% | Avg Stale');
    console.log('   ' + '-'.repeat(50));
    
    for (const row of timeAnalysis.rows) {
        console.log(`   ${row.phase.padEnd(16)} | ${String(row.ticks).padStart(6)} | ${parseFloat(row.avg_abs_div).toFixed(3).padStart(9)}% | ${parseFloat(row.avg_stale).toFixed(0)}s`);
    }
    console.log();
    
    // ========================================
    // 6. Resolution Prediction (if we have outcomes)
    // ========================================
    
    console.log('6. DIVERGENCE vs RESOLUTION ACCURACY');
    console.log('   ' + '-'.repeat(50));
    
    // Check if we have any resolved windows with Chainlink data
    const resolutionCheck = await pool.query(`
        SELECT 
            t.crypto,
            t.window_epoch,
            w.outcome,
            AVG(t.price_divergence_pct) as avg_divergence,
            AVG(t.spot_delta_pct) as avg_binance_delta,
            AVG(CASE WHEN t.chainlink_price IS NOT NULL 
                THEN (t.chainlink_price - t.price_to_beat) / NULLIF(t.price_to_beat, 0) * 100 
                ELSE NULL END) as avg_chainlink_delta
        FROM ticks t
        JOIN windows w ON t.window_epoch = w.epoch AND t.crypto = w.crypto
        WHERE t.chainlink_price IS NOT NULL
          AND w.outcome IS NOT NULL
          AND t.time_remaining_sec < 120  -- Last 2 minutes
        GROUP BY t.crypto, t.window_epoch, w.outcome
    `);
    
    if (resolutionCheck.rows.length === 0) {
        console.log('   No resolved windows with Chainlink data yet.');
        console.log('   This analysis will show:');
        console.log('   - Whether Binance or Chainlink better predicts outcome');
        console.log('   - Divergence patterns that lead to "surprise" resolutions');
    } else {
        let binanceCorrect = 0;
        let chainlinkCorrect = 0;
        let total = 0;
        
        for (const row of resolutionCheck.rows) {
            if (row.avg_binance_delta === null || row.avg_chainlink_delta === null) continue;
            
            const binancePredicts = parseFloat(row.avg_binance_delta) > 0 ? 'up' : 'down';
            const chainlinkPredicts = parseFloat(row.avg_chainlink_delta) > 0 ? 'up' : 'down';
            
            if (binancePredicts === row.outcome) binanceCorrect++;
            if (chainlinkPredicts === row.outcome) chainlinkCorrect++;
            total++;
        }
        
        if (total > 0) {
            console.log(`   Windows analyzed: ${total}`);
            console.log(`   Binance accuracy:   ${(binanceCorrect / total * 100).toFixed(1)}% (${binanceCorrect}/${total})`);
            console.log(`   Chainlink accuracy: ${(chainlinkCorrect / total * 100).toFixed(1)}% (${chainlinkCorrect}/${total})`);
            
            if (chainlinkCorrect > binanceCorrect) {
                console.log(`\n   ✓ Chainlink is more predictive of resolution (as expected)`);
            } else if (binanceCorrect > chainlinkCorrect) {
                console.log(`\n   ⚠️ Binance is more predictive (unexpected - investigate)`);
            }
        }
    }
    console.log();
    
    // ========================================
    // 7. Trading Opportunities
    // ========================================
    
    console.log('7. POTENTIAL TRADING OPPORTUNITIES');
    console.log('   ' + '-'.repeat(50));
    
    // Find cases where Binance and Chainlink disagree on direction
    const disagreements = await pool.query(`
        SELECT 
            crypto,
            COUNT(*) as total_ticks,
            SUM(CASE 
                WHEN spot_delta_pct > 0 AND (chainlink_price - price_to_beat) / NULLIF(price_to_beat, 0) < 0 
                THEN 1 
                ELSE 0 
            END) as binance_up_chainlink_down,
            SUM(CASE 
                WHEN spot_delta_pct < 0 AND (chainlink_price - price_to_beat) / NULLIF(price_to_beat, 0) > 0 
                THEN 1 
                ELSE 0 
            END) as binance_down_chainlink_up
        FROM ticks
        WHERE chainlink_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND price_to_beat > 0
        GROUP BY crypto
    `);
    
    console.log('   Crypto | Total  | Binance UP/CL DOWN | Binance DOWN/CL UP');
    console.log('   ' + '-'.repeat(60));
    
    let totalDisagreements = 0;
    for (const row of disagreements.rows) {
        const upDown = parseInt(row.binance_up_chainlink_down || 0);
        const downUp = parseInt(row.binance_down_chainlink_up || 0);
        totalDisagreements += upDown + downUp;
        
        console.log(`   ${row.crypto.toUpperCase().padEnd(6)} | ${String(row.total_ticks).padStart(6)} | ${String(upDown).padStart(18)} | ${String(downUp).padStart(18)}`);
    }
    
    console.log();
    console.log(`   TOTAL DISAGREEMENTS: ${totalDisagreements}`);
    console.log('   These are moments where Binance shows one direction');
    console.log('   but Chainlink (resolution) shows the other.');
    console.log('   → HIGH VALUE TRADING OPPORTUNITIES');
    
    console.log();
    console.log('═'.repeat(70));
    console.log('  INTERPRETATION');
    console.log('═'.repeat(70));
    console.log();
    console.log('  KEY METRICS TO WATCH:');
    console.log('  1. Avg |Divergence| > 0.1%  → Significant exploitable gap');
    console.log('  2. Staleness > 60s often   → Chainlink is slow, opportunity window');
    console.log('  3. Disagreements > 5%      → Direction conflicts are common');
    console.log('  4. Chainlink more accurate → Confirms resolution uses Chainlink');
    console.log();
    console.log('  TRADING IMPLICATIONS:');
    console.log('  • When Binance UP but Chainlink flat → Fade the visible UP move');
    console.log('  • When staleness high near expiry    → Market may misprice');
    console.log('  • When both agree strongly           → High confidence entry');
    console.log();
    
    await pool.end();
}

main().catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
});
