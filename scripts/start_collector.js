#!/usr/bin/env node
/**
 * Start the Tick Data Collector Service
 *
 * Usage: npm run collect
 *
 * Made crash-resistant: Will try to recover from errors instead of exiting.
 */

import dotenv from 'dotenv';
dotenv.config();

// ENABLE LIVE TRADING - Set env var if not already set
if (!process.env.LIVE_TRADING_ENABLED) {
    process.env.LIVE_TRADING_ENABLED = 'true';
    console.log('🔴 LIVE TRADING ENABLED (set automatically)');
}

// Initialize global proxy agent for all HTTP/HTTPS requests (bypasses Cloudflare blocks)
if (process.env.PROXY_URL) {
    const { bootstrap } = await import('global-agent');
    bootstrap();
    process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.PROXY_URL;
    process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.PROXY_URL;
    console.log(`🔒 Proxy enabled: ${process.env.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
}

import { TickCollector } from '../src/collectors/tick_collector.js';
import { initDatabase, setLiveStrategyEnabled, getLiveEnabledStrategies } from '../src/db/connection.js';
import { createAllQuantStrategies } from '../src/quant/strategies/index.js';

console.log('🚀 Starting Polymarket Tick Collector...\n');

// =============================================================================
// HEALTH CHECK: Verify DB strategies match code strategies
// This prevents silent failures when strategies are enabled but don't exist
// =============================================================================
async function verifyStrategySync() {
    console.log('\n🔍 Verifying strategy sync between code and database...');

    // Get all strategy names from code
    const codeStrategies = new Set(createAllQuantStrategies(100).map(s => s.getName()));

    // Get enabled strategies from database
    let dbEnabled;
    try {
        dbEnabled = await getLiveEnabledStrategies();
    } catch (e) {
        console.warn('⚠️  Could not check DB strategies:', e.message);
        return;
    }

    // Check for mismatches
    const missingInCode = dbEnabled.filter(name => !codeStrategies.has(name));

    if (missingInCode.length > 0) {
        console.error('❌ CRITICAL: Strategies enabled in DB but NOT in code:');
        for (const name of missingInCode) {
            console.error(`   - ${name}`);
        }
        console.error('   These strategies will NOT trade! Add them to code or disable in DB.');
    } else {
        console.log('✅ All enabled strategies exist in code');
    }

    // Log what's actually enabled
    console.log(`\n📊 Live trading enabled for ${dbEnabled.length} strategies:`);
    for (const name of dbEnabled) {
        const inCode = codeStrategies.has(name) ? '✓' : '❌';
        console.log(`   ${inCode} ${name}`);
    }
    console.log('');
}

// Run startup migrations - UPDATED Jan 2026 based on live data analysis
async function runMigrations() {
    try {
        // Initialize database connection first
        await initDatabase();
        
        // =================================================================
        // PRODUCTION MODE - BLACK-SCHOLES EDGE STRATEGIES Jan 28 2026
        // All strategies now use N(d2) probabilistic model for edge calculation
        // Requires minimum BS edge (2-3%) before entering trades
        // =================================================================
        const toEnable = [
            // BS EDGE STRATEGIES - all validated with proper edge calculation
            'SpotLag_ProbEdge',        // Best performer +$47
            'SpotLag_Trail_V1',        // Safe - 3% min edge
            'SpotLag_Trail_V2',        // 2.5% min edge
            'SpotLag_Trail_V3',        // 2% min edge
            'Endgame',                 // High conviction end-of-window
            'Endgame_Conservative',    // Conservative endgame
        ];

        for (const strat of toEnable) {
            await setLiveStrategyEnabled(strat, true);
            console.log(`✅ Enabled ${strat} for live trading`);
        }

        // =================================================================
        // DISABLED STRATEGIES - All others disabled for risk reduction
        // =================================================================
        const toDisable = [
            // TEST STRATEGY
            'TP_SL_Test',

            // PREVIOUSLY ENABLED CORE - disabled for now
            'SpotLag_TimeAware',    // Needs more testing with BS edge
            'SpotLag_LateOnly',     // Needs more testing
            'PureProb_Late',        // Needs more testing

            // DISABLED - need BS edge validation first
            'SpotLag_TimeAwareAggro', 'SpotLag_TimeAwareSafe', 'SpotLag_TimeAwareTP',
            'SpotLag_Trail_V4', 'SpotLag_Trail_V5',  // V4/V5 more aggressive, enable later
            'PureProb_Base', 'PureProb_Conservative', 'PureProb_Aggressive',
            'LagProb_Base', 'LagProb_Conservative', 'LagProb_Aggressive', 'LagProb_RightSide',
            'Endgame_Aggressive', 'Endgame_Safe', 'Endgame_Momentum',

            // OLD/DEPRECATED STRATEGIES
            'MicroLag_Convergence', 'MicroLag_Convergence_Aggro', 'MicroLag_Convergence_Safe',
            'SpotLag_Aggressive', 'SpotLag_Fast', 'SpotLagSimple', 'SpotLag_Confirmed',
            'SpotLag_TP3', 'SpotLag_TP3_Trailing', 'SpotLag_TP6',
            'SpotLag_VolAdapt', 'SpotLag_Trailing', 'SpotLag_TrailTight', 'SpotLag_TrailWide',
            'SpotLag_LateValue', 'SpotLag_DeepValue', 'SpotLag_CorrectSide', 'SpotLag_ExtremeReversal',
            'SpotLag_CLConfirmed', 'SpotLag_Aggressive_CL',
            'MispricingOnly', 'Mispricing_Strict', 'Mispricing_Loose', 'Mispricing_CLConfirmed', 'UpOnly_CLConfirmed',
            'CL_Divergence', 'CL_Divergence_Aggro', 'CL_Divergence_Safe', 'CL_FinalSeconds', 'CL_FinalSeconds_Ultra',
            'FairValue_RealizedVol', 'FairValue_EWMA', 'FairValue_WithDrift',
            'FV_Drift_1H', 'FV_Drift_4H', 'FV_Drift_24H', 'FV_UpOnly_4H',
            'Contrarian', 'Contrarian_SOL', 'Contrarian_Scalp', 'Contrarian_Strong',
            'TimeConditional', 'Microstructure', 'CrossAsset', 'Regime',
        ];

        for (const strat of toDisable) {
            await setLiveStrategyEnabled(strat, false);
            console.log(`❌ Disabled ${strat} for live trading`);
        }
        
        console.log('\n📊 Strategy configuration updated based on live data analysis');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail startup, just log warning
    }
}

// Run migrations before starting collector
await runMigrations();

// Verify strategy sync (alerts if DB strategies don't exist in code)
await verifyStrategySync();

let collector = null;
let restartCount = 0;
let lastRestartTime = 0;
const MAX_RESTARTS_PER_HOUR = 10;

async function startCollector() {
    try {
        collector = new TickCollector();
        await collector.start();
        console.log('✅ Collector started successfully');
        restartCount = 0; // Reset on successful start
    } catch (error) {
        console.error('❌ Failed to start collector:', error);
        scheduleRestart('startup failure');
    }
}

function scheduleRestart(reason) {
    const now = Date.now();
    
    // Reset restart count if it's been more than an hour
    if (now - lastRestartTime > 60 * 60 * 1000) {
        restartCount = 0;
    }
    
    restartCount++;
    lastRestartTime = now;
    
    if (restartCount > MAX_RESTARTS_PER_HOUR) {
        console.error(`❌ Too many restarts (${restartCount}), giving up. Reason: ${reason}`);
        process.exit(1);
    }
    
    const delay = Math.min(5000 * restartCount, 60000); // Exponential backoff, max 60s
    console.log(`🔄 Scheduling restart in ${delay/1000}s (attempt ${restartCount}/${MAX_RESTARTS_PER_HOUR}). Reason: ${reason}`);
    
    setTimeout(async () => {
        console.log('🔄 Restarting collector...');
        if (collector) {
            try {
                await collector.stop();
            } catch (e) {
                console.error('Error stopping collector:', e.message);
            }
        }
        await startCollector();
    }, delay);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n📴 Received SIGINT, shutting down gracefully...');
    if (collector) collector.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n📴 Received SIGTERM, shutting down gracefully...');
    if (collector) collector.stop();
    process.exit(0);
});

// Handle uncaught errors - TRY TO RECOVER instead of crashing
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    console.error('Stack:', error.stack);
    
    // Don't exit - try to restart
    scheduleRestart(`uncaughtException: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
    
    // Log but don't restart for unhandled rejections - they're usually not fatal
    // But if we see many in a short time, we might want to restart
});

// Start collector
startCollector();

