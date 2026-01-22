#!/usr/bin/env node
/**
 * Run Statistical Analysis
 * 
 * Analyzes collected data and runs hypothesis tests
 */

import { initDatabase } from '../src/db/connection.js';
import { getDataSummary, getWindowStats } from '../src/db/queries.js';
import { runAllTests } from '../src/analysis/hypothesis_tests.js';
import { distributionStats } from '../src/analysis/metrics.js';

async function main() {
    console.log('═'.repeat(70));
    console.log('     POLYMARKET STATISTICAL ANALYSIS');
    console.log('═'.repeat(70));
    
    // Initialize database
    const db = initDatabase();
    
    // Get data summary
    console.log('\n📊 Data Summary:\n');
    const summary = getDataSummary();
    
    console.log(`   Total Ticks: ${summary.ticks.toLocaleString()}`);
    console.log(`   Total Windows: ${summary.windows}`);
    console.log(`   Total Trades: ${summary.trades}`);
    
    if (summary.ticksByCrypto.length > 0) {
        console.log('\n   Ticks by Crypto:');
        for (const { crypto, count, first_tick, last_tick } of summary.ticksByCrypto) {
            const duration = last_tick && first_tick 
                ? ((last_tick - first_tick) / 1000 / 60).toFixed(1) + ' min'
                : 'N/A';
            console.log(`     ${crypto.toUpperCase()}: ${count.toLocaleString()} ticks (${duration})`);
        }
    }
    
    // Check if we have enough data
    if (summary.ticks < 100) {
        console.log('\n⚠️  Insufficient data for analysis.');
        console.log('   Start the collector and wait for data to accumulate.');
        console.log('   Recommended: At least 1 hour of data (240+ ticks per crypto)');
        process.exit(0);
    }
    
    // Get window statistics
    console.log('\n📈 Window Statistics:\n');
    const windowStats = getWindowStats();
    
    if (Array.isArray(windowStats) && windowStats.length > 0) {
        for (const stat of windowStats) {
            console.log(`   ${stat.crypto.toUpperCase()}:`);
            console.log(`     Windows: ${stat.total_windows} (Up: ${stat.up_count}, Down: ${stat.down_count})`);
            if (stat.total_windows > 0) {
                console.log(`     Up Rate: ${((stat.up_count / stat.total_windows) * 100).toFixed(1)}%`);
                console.log(`     Avg Price Change: ${(stat.avg_price_change * 100).toFixed(2)}%`);
                console.log(`     Avg Price Range: ${(stat.avg_price_range * 100).toFixed(2)}%`);
            }
        }
    }
    
    // Run hypothesis tests for each crypto with sufficient data
    console.log('\n' + '═'.repeat(70));
    console.log('     HYPOTHESIS TESTS');
    console.log('═'.repeat(70));
    
    const cryptosWithData = summary.ticksByCrypto
        .filter(c => c.count >= 100)
        .map(c => c.crypto);
    
    if (cryptosWithData.length === 0) {
        console.log('\n⚠️  No crypto has enough data for hypothesis tests.');
        console.log('   Need at least 100 ticks per crypto.');
        process.exit(0);
    }
    
    for (const crypto of cryptosWithData) {
        try {
            await runAllTests(crypto);
        } catch (error) {
            console.error(`\n❌ Error testing ${crypto}:`, error.message);
        }
    }
    
    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('     ANALYSIS COMPLETE');
    console.log('═'.repeat(70));
    console.log('\nNext steps:');
    console.log('  1. Review hypothesis test results above');
    console.log('  2. If significant patterns found, run backtest:');
    console.log('     npm run backtest');
    console.log('  3. Continue collecting data for more robust analysis');
}

main().catch(console.error);

