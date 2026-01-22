#!/usr/bin/env node
/**
 * Start Paper Trading
 * 
 * Usage: npm run paper
 */

import { PaperTrader } from '../src/trading/paper_trader.js';
import { ThresholdExitStrategy } from '../src/backtest/strategies/threshold_exit.js';
import { MeanReversionStrategy } from '../src/backtest/strategies/mean_reversion.js';
import { MomentumStrategy } from '../src/backtest/strategies/momentum.js';

// Parse command line args
const args = process.argv.slice(2);
const strategyArg = args.find(a => a.startsWith('--strategy='))?.split('=')[1] || 'threshold';
const cryptoArg = args.find(a => a.startsWith('--crypto='))?.split('=')[1] || 'btc';
const capitalArg = parseFloat(args.find(a => a.startsWith('--capital='))?.split('=')[1] || '1000');

// Create strategy
let strategy;
switch (strategyArg.toLowerCase()) {
    case 'threshold':
        strategy = new ThresholdExitStrategy({
            profitTargets: [0.02, 0.03, 0.05],
            stopLoss: 0.05,
            maxPosition: 50
        });
        break;
    case 'meanreversion':
    case 'mean':
        strategy = new MeanReversionStrategy({
            maWindow: 20,
            entryThreshold: 0.03,
            maxPosition: 50
        });
        break;
    case 'momentum':
        strategy = new MomentumStrategy({
            lookbackTicks: 10,
            momentumThreshold: 0.001,
            maxPosition: 50
        });
        break;
    default:
        console.error(`Unknown strategy: ${strategyArg}`);
        console.log('Available strategies: threshold, meanreversion, momentum');
        process.exit(1);
}

// Create paper trader
const trader = new PaperTrader(strategy, {
    crypto: cryptoArg,
    initialCapital: capitalArg,
    logTrades: true
});

// Handle shutdown
process.on('SIGINT', () => {
    trader.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    trader.stop();
    process.exit(0);
});

// Start trading
trader.start().catch((error) => {
    console.error('❌ Failed to start paper trading:', error);
    process.exit(1);
});

