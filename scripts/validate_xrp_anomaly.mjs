/**
 * XRP Anomaly Validation Script
 * 
 * Tests the claim: "XRP has 76% win rate on UP, 4% on DOWN"
 * 
 * This is an extraordinary claim that requires rigorous validation:
 * 1. Calculate actual sample sizes
 * 2. Compute confidence intervals
 * 3. Compare to other cryptos
 * 4. Check for data/logic bugs
 * 5. Test if result is statistically significant
 * 
 * Usage: node scripts/validate_xrp_anomaly.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

/**
 * Calculate Wilson score confidence interval for proportions
 * More accurate than normal approximation for small samples
 */
function wilsonConfidenceInterval(successes, total, confidence = 0.95) {
    if (total === 0) return { lower: 0, upper: 0, point: 0 };
    
    const z = confidence === 0.95 ? 1.96 : (confidence === 0.99 ? 2.576 : 1.645);
    const p = successes / total;
    const n = total;
    
    const denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator;
    const margin = (z / denominator) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    
    return {
        point: p,
        lower: Math.max(0, center - margin),
        upper: Math.min(1, center + margin)
    };
}

/**
 * Two-proportion z-test
 */
function twoProportionZTest(successes1, n1, successes2, n2) {
    const p1 = successes1 / n1;
    const p2 = successes2 / n2;
    const pooledP = (successes1 + successes2) / (n1 + n2);
    
    const se = Math.sqrt(pooledP * (1 - pooledP) * (1/n1 + 1/n2));
    const z = (p1 - p2) / se;
    
    // Two-tailed p-value
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));
    
    return { z, pValue, p1, p2, diff: p1 - p2 };
}

function normalCDF(z) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * z);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1.0 + sign * y);
}

async function main() {
    console.log('═'.repeat(70));
    console.log('  XRP ANOMALY VALIDATION');
    console.log('  Testing claim: "XRP has 76% UP win rate, 4% DOWN win rate"');
    console.log('═'.repeat(70));
    console.log();
    
    // ========================================
    // 1. Get raw trade data by crypto and side
    // ========================================
    
    console.log('1. FETCHING TRADE DATA...\n');
    
    const tradeQuery = `
        SELECT 
            crypto,
            side,
            COUNT(*) as total_trades,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
            SUM(pnl) as total_pnl,
            AVG(pnl) as avg_pnl,
            MIN(entry_time) as first_trade,
            MAX(exit_time) as last_trade
        FROM paper_trades
        WHERE pnl IS NOT NULL
        GROUP BY crypto, side
        ORDER BY crypto, side
    `;
    
    const { rows: tradeStats } = await pool.query(tradeQuery);
    
    if (tradeStats.length === 0) {
        console.log('❌ NO TRADE DATA FOUND');
        console.log('   Need paper_trades with outcomes to validate');
        await pool.end();
        return;
    }
    
    // ========================================
    // 2. Display raw numbers
    // ========================================
    
    console.log('2. RAW TRADE STATISTICS\n');
    console.log('   Crypto | Side | Trades |  Wins | Losses | Win Rate | Total PnL');
    console.log('   ' + '-'.repeat(65));
    
    const byCrypto = {};
    for (const row of tradeStats) {
        const winRate = row.total_trades > 0 ? (parseInt(row.wins) / parseInt(row.total_trades) * 100).toFixed(1) : '0.0';
        const totalPnl = parseFloat(row.total_pnl) || 0;
        console.log(`   ${row.crypto.toUpperCase().padEnd(6)} | ${row.side.padEnd(4)} | ${String(row.total_trades).padStart(6)} | ${String(row.wins).padStart(5)} | ${String(row.losses).padStart(6)} | ${winRate.padStart(7)}% | $${totalPnl.toFixed(2)}`);
        
        if (!byCrypto[row.crypto]) byCrypto[row.crypto] = {};
        byCrypto[row.crypto][row.side] = row;
    }
    
    console.log();
    
    // ========================================
    // 3. Statistical analysis for XRP
    // ========================================
    
    console.log('3. XRP STATISTICAL ANALYSIS\n');
    
    const xrpUp = byCrypto.xrp?.up;
    const xrpDown = byCrypto.xrp?.down;
    
    if (!xrpUp && !xrpDown) {
        console.log('   ❌ NO XRP TRADES FOUND\n');
    } else {
        // XRP UP analysis
        if (xrpUp) {
            const ci = wilsonConfidenceInterval(parseInt(xrpUp.wins), parseInt(xrpUp.total_trades));
            console.log('   XRP UP:');
            console.log(`      Sample size: n = ${xrpUp.total_trades}`);
            console.log(`      Wins: ${xrpUp.wins} / ${xrpUp.total_trades}`);
            console.log(`      Win rate: ${(ci.point * 100).toFixed(1)}%`);
            console.log(`      95% CI: [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`);
            console.log(`      Margin of error: ±${((ci.upper - ci.lower) / 2 * 100).toFixed(1)}%`);
            
            const isSignificantlyAbove50 = ci.lower > 0.50;
            console.log(`      Significantly > 50%? ${isSignificantlyAbove50 ? 'YES ✓' : 'NO (CI includes 50%)'}`);
            console.log();
        }
        
        // XRP DOWN analysis
        if (xrpDown) {
            const ci = wilsonConfidenceInterval(parseInt(xrpDown.wins), parseInt(xrpDown.total_trades));
            console.log('   XRP DOWN:');
            console.log(`      Sample size: n = ${xrpDown.total_trades}`);
            console.log(`      Wins: ${xrpDown.wins} / ${xrpDown.total_trades}`);
            console.log(`      Win rate: ${(ci.point * 100).toFixed(1)}%`);
            console.log(`      95% CI: [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`);
            console.log(`      Margin of error: ±${((ci.upper - ci.lower) / 2 * 100).toFixed(1)}%`);
            
            const isSignificantlyBelow50 = ci.upper < 0.50;
            console.log(`      Significantly < 50%? ${isSignificantlyBelow50 ? 'YES ✓' : 'NO (CI includes 50%)'}`);
            console.log();
        }
        
        // Compare UP vs DOWN
        if (xrpUp && xrpDown) {
            const test = twoProportionZTest(
                parseInt(xrpUp.wins), parseInt(xrpUp.total_trades),
                parseInt(xrpDown.wins), parseInt(xrpDown.total_trades)
            );
            
            console.log('   XRP UP vs DOWN comparison:');
            console.log(`      Difference: ${(test.diff * 100).toFixed(1)}% (UP - DOWN)`);
            console.log(`      Z-statistic: ${test.z.toFixed(3)}`);
            console.log(`      P-value: ${test.pValue < 0.001 ? '<0.001' : test.pValue.toFixed(4)}`);
            console.log(`      Significant at α=0.05? ${test.pValue < 0.05 ? 'YES ✓' : 'NO'}`);
            console.log();
        }
    }
    
    // ========================================
    // 4. Compare XRP to other cryptos
    // ========================================
    
    console.log('4. CROSS-CRYPTO COMPARISON (UP trades only)\n');
    
    const upStats = tradeStats.filter(r => r.side === 'up');
    
    if (upStats.length > 1) {
        console.log('   Crypto | Trades | Win Rate |    95% CI     | Significantly > 50%?');
        console.log('   ' + '-'.repeat(65));
        
        for (const row of upStats) {
            const ci = wilsonConfidenceInterval(parseInt(row.wins), parseInt(row.total_trades));
            const sigAbove50 = ci.lower > 0.50;
            console.log(`   ${row.crypto.toUpperCase().padEnd(6)} | ${String(row.total_trades).padStart(6)} | ${(ci.point * 100).toFixed(1).padStart(7)}% | [${(ci.lower*100).toFixed(1)}%, ${(ci.upper*100).toFixed(1)}%] | ${sigAbove50 ? 'YES ✓' : 'NO'}`);
        }
        console.log();
        
        // Is XRP significantly different from others?
        if (byCrypto.xrp?.up) {
            console.log('   Is XRP UP significantly different from other cryptos?');
            const xrpData = byCrypto.xrp.up;
            
            for (const row of upStats) {
                if (row.crypto === 'xrp') continue;
                
                const test = twoProportionZTest(
                    parseInt(xrpData.wins), parseInt(xrpData.total_trades),
                    parseInt(row.wins), parseInt(row.total_trades)
                );
                
                const sig = test.pValue < 0.05 ? '✓ YES' : 'NO';
                console.log(`      vs ${row.crypto.toUpperCase()}: diff=${(test.diff*100).toFixed(1)}%, p=${test.pValue < 0.001 ? '<0.001' : test.pValue.toFixed(3)}, significant? ${sig}`);
            }
            console.log();
        }
    }
    
    // ========================================
    // 5. Check for data quality issues
    // ========================================
    
    console.log('5. DATA QUALITY CHECKS\n');
    
    // Check window outcome distribution for XRP
    const windowQuery = `
        SELECT 
            outcome,
            COUNT(*) as count
        FROM windows
        WHERE crypto = 'xrp' AND outcome IS NOT NULL
        GROUP BY outcome
    `;
    
    const { rows: windowStats } = await pool.query(windowQuery);
    
    if (windowStats.length > 0) {
        const upWindows = windowStats.find(r => r.outcome === 'up')?.count || 0;
        const downWindows = windowStats.find(r => r.outcome === 'down')?.count || 0;
        const total = parseInt(upWindows) + parseInt(downWindows);
        const upPct = total > 0 ? (upWindows / total * 100).toFixed(1) : 0;
        
        console.log('   XRP Window Outcomes (actual market results):');
        console.log(`      UP outcomes: ${upWindows} (${upPct}%)`);
        console.log(`      DOWN outcomes: ${downWindows} (${(100 - upPct).toFixed(1)}%)`);
        console.log(`      Total resolved: ${total}`);
        console.log();
        
        // This tells us if XRP itself has been trending up
        if (upPct > 55) {
            console.log('   ⚠️  XRP has been trending UP during sample period');
            console.log('      This could explain higher UP win rates (not necessarily an anomaly)');
        } else if (upPct < 45) {
            console.log('   ⚠️  XRP has been trending DOWN during sample period');
            console.log('      If UP trades still win, this IS anomalous behavior');
        } else {
            console.log('   ✓ XRP outcomes roughly balanced (45-55%)');
            console.log('      If UP trades significantly outperform, this suggests real edge');
        }
        console.log();
    }
    
    // Check time period coverage
    const timeQuery = `
        SELECT 
            MIN(entry_time) as first_trade,
            MAX(exit_time) as last_trade,
            COUNT(DISTINCT DATE(entry_time)) as trading_days
        FROM paper_trades
        WHERE crypto = 'xrp'
    `;
    
    const { rows: timeStats } = await pool.query(timeQuery);
    
    if (timeStats[0]?.first_trade) {
        const t = timeStats[0];
        console.log('   XRP Trading Period:');
        console.log(`      First trade: ${new Date(t.first_trade).toISOString()}`);
        console.log(`      Last trade: ${new Date(t.last_trade).toISOString()}`);
        console.log(`      Trading days: ${t.trading_days}`);
        console.log();
    }
    
    // ========================================
    // 6. Sample size requirements
    // ========================================
    
    console.log('6. SAMPLE SIZE ASSESSMENT\n');
    
    const REQUIRED_FOR_EDGE = 100;  // Minimum to claim edge exists
    const REQUIRED_FOR_ANOMALY = 200; // Minimum to claim XRP is special
    
    for (const crypto of Object.keys(byCrypto)) {
        const up = byCrypto[crypto]?.up;
        const down = byCrypto[crypto]?.down;
        
        const upN = parseInt(up?.total_trades || 0);
        const downN = parseInt(down?.total_trades || 0);
        const totalN = upN + downN;
        
        let status;
        if (totalN >= REQUIRED_FOR_ANOMALY) {
            status = '✓ SUFFICIENT for anomaly claims';
        } else if (totalN >= REQUIRED_FOR_EDGE) {
            status = '◐ SUFFICIENT for edge claims, need more for anomaly';
        } else {
            status = `✗ INSUFFICIENT (need ${REQUIRED_FOR_EDGE - totalN} more trades)`;
        }
        
        console.log(`   ${crypto.toUpperCase()}: ${totalN} trades (UP: ${upN}, DOWN: ${downN}) - ${status}`);
    }
    
    console.log();
    
    // ========================================
    // 7. Verdict
    // ========================================
    
    console.log('═'.repeat(70));
    console.log('  VERDICT');
    console.log('═'.repeat(70));
    console.log();
    
    if (xrpUp) {
        const ci = wilsonConfidenceInterval(parseInt(xrpUp.wins), parseInt(xrpUp.total_trades));
        const n = parseInt(xrpUp.total_trades);
        
        if (n < 30) {
            console.log('  ❓ INSUFFICIENT DATA');
            console.log(`     Only ${n} XRP UP trades. Need at least 30 for meaningful analysis.`);
            console.log('     Current results are statistically unreliable.');
        } else if (n < 100) {
            console.log('  ⚠️  PRELIMINARY EVIDENCE');
            console.log(`     ${n} XRP UP trades shows ${(ci.point * 100).toFixed(1)}% win rate`);
            console.log(`     95% CI: [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`);
            console.log('     Need 100+ trades to confirm edge, 200+ to confirm anomaly.');
        } else {
            if (ci.lower > 0.55) {
                console.log('  ✓ STATISTICALLY SIGNIFICANT EDGE');
                console.log(`     ${n} XRP UP trades with ${(ci.point * 100).toFixed(1)}% win rate`);
                console.log(`     Lower bound of 95% CI (${(ci.lower * 100).toFixed(1)}%) exceeds 55%`);
                console.log('     This edge appears REAL at current sample size.');
            } else if (ci.lower > 0.50) {
                console.log('  ◐ POSSIBLE EDGE (needs more data)');
                console.log(`     ${n} XRP UP trades with ${(ci.point * 100).toFixed(1)}% win rate`);
                console.log(`     95% CI lower bound (${(ci.lower * 100).toFixed(1)}%) slightly above 50%`);
                console.log('     Edge may be real but confidence is borderline.');
            } else {
                console.log('  ✗ NO SIGNIFICANT EDGE');
                console.log(`     ${n} XRP UP trades with ${(ci.point * 100).toFixed(1)}% win rate`);
                console.log(`     95% CI: [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`);
                console.log('     Cannot rule out that true win rate is 50% (no edge).');
            }
        }
    } else {
        console.log('  ❌ NO XRP UP TRADES FOUND');
        console.log('     Cannot validate the claim without data.');
    }
    
    console.log();
    console.log('═'.repeat(70));
    
    await pool.end();
}

main().catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
});
