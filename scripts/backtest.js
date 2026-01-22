#!/usr/bin/env node
/**
 * Run Backtest
 * 
 * Tests strategies against collected historical data
 */

import { initDatabase } from '../src/db/connection.js';
import { getDataSummary } from '../src/db/queries.js';
import { BacktestEngine } from '../src/backtest/engine.js';
import { MeanReversionStrategy } from '../src/backtest/strategies/mean_reversion.js';
import { MomentumStrategy } from '../src/backtest/strategies/momentum.js';
import { ThresholdExitStrategy } from '../src/backtest/strategies/threshold_exit.js';

async function main() {
    console.log('═'.repeat(70));
    console.log('     POLYMARKET STRATEGY BACKTEST');
    console.log('═'.repeat(70));
    
    // Initialize database
    initDatabase();
    
    // Check available data
    const summary = getDataSummary();
    console.log(`\n📊 Available Data: ${summary.ticks.toLocaleString()} ticks`);
    
    if (summary.ticks < 100) {
        console.log('\n⚠️  Insufficient data for backtesting.');
        console.log('   Start the collector and wait for data to accumulate.');
        console.log('   Recommended: At least 1 hour of data');
        process.exit(0);
    }
    
    // Show available cryptos
    console.log('\n   Available cryptos:');
    for (const { crypto, count } of summary.ticksByCrypto) {
        console.log(`     ${crypto.toUpperCase()}: ${count.toLocaleString()} ticks`);
    }
    
    // Select crypto with most data
    const targetCrypto = summary.ticksByCrypto
        .sort((a, b) => b.count - a.count)[0]?.crypto || 'btc';
    
    console.log(`\n   Testing on: ${targetCrypto.toUpperCase()}`);
    
    // Initialize backtest engine
    const engine = new BacktestEngine({
        initialCapital: 1000,
        commission: 0.001,
        slippage: 0.001
    });
    
    // Define strategies to test
    const strategies = [
        new ThresholdExitStrategy({
            profitTargets: [0.02, 0.03, 0.05],
            stopLoss: 0.05,
            maxPosition: 50
        }),
        new MeanReversionStrategy({
            maWindow: 20,
            entryThreshold: 0.03,
            takeProfit: 0.02,
            stopLoss: 0.05
        }),
        new MomentumStrategy({
            lookbackTicks: 10,
            momentumThreshold: 0.001,
            takeProfit: 0.03,
            stopLoss: 0.05
        })
    ];
    
    // Run backtests
    const results = [];
    
    for (const strategy of strategies) {
        try {
            const result = await engine.run(strategy, targetCrypto);
            results.push(result);
            BacktestEngine.printResults(result);
        } catch (error) {
            console.error(`\n❌ Error testing ${strategy.getName()}:`, error.message);
        }
    }
    
    // Summary comparison
    if (results.length > 1) {
        console.log('\n' + '═'.repeat(70));
        console.log('     STRATEGY COMPARISON');
        console.log('═'.repeat(70));
        
        console.log('\n   Strategy              | Return   | Sharpe | Win Rate | Trades');
        console.log('   ' + '─'.repeat(66));
        
        for (const r of results) {
            const name = r.strategy.padEnd(20);
            const ret = ((r.netReturn || 0) * 100).toFixed(1).padStart(6) + '%';
            const sharpe = (r.sharpeRatio || 0).toFixed(2).padStart(6);
            const winRate = ((r.winRate || 0) * 100).toFixed(1).padStart(6) + '%';
            const trades = String(r.totalTrades || 0).padStart(6);
            
            console.log(`   ${name} | ${ret} | ${sharpe} | ${winRate} | ${trades}`);
        }
    }
    
    console.log('\n✅ Backtest complete');
    console.log('\nNext steps:');
    console.log('  1. If results are promising, run paper trading:');
    console.log('     npm run paper');
    console.log('  2. Adjust strategy parameters based on results');
    console.log('  3. Collect more data for robust validation');
}

main().catch(console.error);

