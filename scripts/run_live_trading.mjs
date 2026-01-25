#!/usr/bin/env node
/**
 * Live Trading Runner
 * 
 * Runs the execution engine with our best-performing strategy.
 * Designed to run on Railway 24/7.
 * 
 * CRITICAL: This trades REAL money. Start with minimal position sizes.
 * 
 * Usage:
 *   node scripts/run_live_trading.mjs [--strategy=SpotLag_Aggressive] [--paper]
 * 
 * Environment Variables:
 *   POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE
 *   POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER_ADDRESS
 *   LIVE_STRATEGY - Strategy to run (default: SpotLag_Aggressive)
 *   LIVE_MODE - 'live' or 'paper' (default: paper)
 *   LIVE_CRYPTOS - Comma-separated list (default: btc,eth)
 *   MAX_POSITION_PER_TRADE - Override risk limit
 *   DASHBOARD_PORT - Port for dashboard (default: 3333)
 */

import dotenv from 'dotenv';
dotenv.config();

import { ExecutionEngine, EngineState } from '../src/execution/execution_engine.js';
import { 
    createSpotLagAggressive, 
    createSpotLagFast, 
    createSpotLagSimple,
    createSpotLagConfirmed,
    createSpotLag300Sec
} from '../src/quant/strategies/spot_lag_simple.js';
import { startDashboard, broadcastLiveStatus, broadcastLiveTrade, setLiveEngine } from '../src/dashboard/server.js';

// Parse command line args
const args = process.argv.slice(2);
const isPaper = args.includes('--paper') || process.env.LIVE_MODE === 'paper';
const strategyArg = args.find(a => a.startsWith('--strategy='))?.split('=')[1];

// Configuration
const CONFIG = {
    strategy: strategyArg || process.env.LIVE_STRATEGY || 'SpotLag_Aggressive',
    mode: isPaper ? 'paper' : 'live',
    cryptos: (process.env.LIVE_CRYPTOS || 'btc,eth').split(','),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3333'),
    
    // Risk parameters (conservative defaults)
    riskParams: {
        maxPositionPerTrade: parseFloat(process.env.MAX_POSITION_PER_TRADE || '1'),
        maxPositionPerWindow: parseFloat(process.env.MAX_POSITION_PER_WINDOW || '5'),
        maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE || '20'),
        maxLossPerDay: parseFloat(process.env.MAX_LOSS_PER_DAY || '20'),
        maxLossPerHour: parseFloat(process.env.MAX_LOSS_PER_HOUR || '5'),
        minTimeRemainingSeconds: parseInt(process.env.MIN_TIME_REMAINING || '30'),
        maxSpreadPercent: parseFloat(process.env.MAX_SPREAD_PERCENT || '10'),
    }
};

// Strategy factory
function createStrategy(name, capital) {
    const strategies = {
        'SpotLag_Aggressive': createSpotLagAggressive,
        'SpotLag_Fast': createSpotLagFast,
        'SpotLagSimple': createSpotLagSimple,
        'SpotLag_Confirmed': createSpotLagConfirmed,
        'SpotLag_300sec': createSpotLag300Sec,
    };
    
    const factory = strategies[name];
    if (!factory) {
        console.error(`Unknown strategy: ${name}`);
        console.log('Available strategies:', Object.keys(strategies).join(', '));
        process.exit(1);
    }
    
    return factory(capital);
}

// Main
async function main() {
    console.log('═'.repeat(70));
    console.log('     LIVE TRADING SYSTEM');
    console.log('═'.repeat(70));
    console.log();
    console.log(`   Mode:      ${CONFIG.mode.toUpperCase()}`);
    console.log(`   Strategy:  ${CONFIG.strategy}`);
    console.log(`   Cryptos:   ${CONFIG.cryptos.join(', ')}`);
    console.log(`   Max/Trade: $${CONFIG.riskParams.maxPositionPerTrade}`);
    console.log(`   Max/Day:   $${CONFIG.riskParams.maxLossPerDay} loss limit`);
    console.log();
    
    if (CONFIG.mode === 'live') {
        console.log('⚠️  LIVE MODE - REAL MONEY AT RISK');
        console.log('   Waiting 5 seconds before starting...');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Validate environment for live mode
    if (CONFIG.mode === 'live') {
        const required = ['POLYMARKET_API_KEY', 'POLYMARKET_SECRET', 'POLYMARKET_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY'];
        const missing = required.filter(k => !process.env[k]);
        if (missing.length > 0) {
            console.error('❌ Missing required environment variables:', missing.join(', '));
            process.exit(1);
        }
    }
    
    // Create strategy
    const strategy = createStrategy(CONFIG.strategy, CONFIG.riskParams.maxPositionPerTrade);
    console.log(`✅ Strategy created: ${strategy.getName()}`);
    
    // Start dashboard
    console.log('🖥️  Starting dashboard...');
    try {
        await startDashboard(CONFIG.dashboardPort);
        console.log(`   Dashboard: http://localhost:${CONFIG.dashboardPort}`);
    } catch (error) {
        console.warn('⚠️  Dashboard failed to start:', error.message);
    }
    
    // Create execution engine
    console.log('⚙️  Creating execution engine...');
    const engine = new ExecutionEngine({
        cryptos: CONFIG.cryptos,
        mode: CONFIG.mode,
        strategy: strategy,
        riskParams: CONFIG.riskParams
    });
    
    // Make engine available to dashboard
    setLiveEngine(engine);
    
    // Wire up events for dashboard
    engine.on('started', () => {
        broadcastLiveStatus(engine.getStatus());
    });
    
    engine.on('order:created', (order) => {
        console.log(`📝 Order created: ${order.side} ${order.tokenSide} ${order.crypto}`);
        broadcastLiveTrade({ type: 'order_created', order });
    });
    
    engine.on('order:fill', (order, fill) => {
        console.log(`✅ Order filled: ${order.side} ${order.tokenSide} @ ${fill.price}`);
        broadcastLiveTrade({ type: 'order_filled', order, fill });
        broadcastLiveStatus(engine.getStatus());
    });
    
    engine.on('kill_switch', (data) => {
        console.error('🛑 KILL SWITCH ACTIVATED');
        broadcastLiveStatus({ ...engine.getStatus(), killSwitch: true, killReason: data.reason });
    });
    
    engine.on('paused', (data) => {
        console.log(`⏸️  Engine paused: ${data.reason}`);
        broadcastLiveStatus(engine.getStatus());
    });
    
    engine.on('resumed', () => {
        console.log('▶️  Engine resumed');
        broadcastLiveStatus(engine.getStatus());
    });
    
    engine.on('health_check', (health) => {
        broadcastLiveStatus(engine.getStatus());
    });
    
    engine.on('error', (error) => {
        console.error('❌ Engine error:', error);
        broadcastLiveStatus({ ...engine.getStatus(), error: error.message });
    });
    
    // Periodic status broadcast
    setInterval(() => {
        if (engine.state !== EngineState.STOPPED) {
            broadcastLiveStatus(engine.getStatus());
        }
    }, 5000);
    
    // Start engine
    try {
        await engine.start();
    } catch (error) {
        console.error('❌ Failed to start engine:', error);
        process.exit(1);
    }
    
    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`\n📴 Received ${signal}, shutting down...`);
        try {
            await engine.stop('signal_' + signal.toLowerCase());
        } catch (error) {
            console.error('Error during shutdown:', error);
        }
        process.exit(0);
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Keep alive
    console.log('\n✅ Live trading system running');
    console.log('   Press Ctrl+C to stop\n');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
