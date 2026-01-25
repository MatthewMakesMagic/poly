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

// Initialize global proxy agent for all HTTP/HTTPS requests (bypasses Cloudflare blocks)
if (process.env.PROXY_URL) {
    const { bootstrap } = await import('global-agent');
    bootstrap();
    process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.PROXY_URL;
    process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.PROXY_URL;
    console.log(`🔒 Proxy enabled: ${process.env.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
}

import { TickCollector } from '../src/collectors/tick_collector.js';
import { initDatabase, setLiveStrategyEnabled } from '../src/db/connection.js';

console.log('🚀 Starting Polymarket Tick Collector...\n');

// Run startup migrations - UPDATED Jan 2026 based on live data analysis
async function runMigrations() {
    try {
        // Initialize database connection first
        await initDatabase();
        
        // =================================================================
        // ENABLE - Strategies that WORK based on live trading data
        // =================================================================
        const toEnable = [
            // PROVEN WINNERS from live data:
            'SpotLag_Aggressive',     // 100% WR, +$2.54 - Best performer
            'SpotLag_TP3',            // 75% WR, +$2.27 - Quick profit exits
            'Endgame_Aggressive',     // 100% WR, +$0.15 - Late confirmation
            'SpotLag_Trailing',       // 50% WR but trailing logic locks in gains
            
            // NEW DATA-DRIVEN STRATEGIES:
            'SpotLag_LateValue',      // Late (60-180s) + cheap entry + strong lag
            'SpotLag_DeepValue',      // Very cheap (<30c) + conviction play  
            'SpotLag_CorrectSide',    // Only when spot on correct side + blocks deadzone
            'SpotLag_ExtremeReversal', // Extreme zone + large contrary move + trailing stop
            
            // CHAINLINK FINAL SECONDS - test frozen Chainlink thesis
            'CL_FinalSeconds',        // Final 30s
            'CL_FinalSeconds_Ultra'   // Final 15s
        ];
        
        for (const strat of toEnable) {
            await setLiveStrategyEnabled(strat, true);
            console.log(`✅ Enabled ${strat} for live trading`);
        }
        
        // =================================================================
        // DISABLE - Strategies that DON'T WORK based on live data
        // =================================================================
        const toDisable = [
            // EARLY CHAINLINK DIVERGENCE - 0% live win rate
            'CL_Divergence',          // 0% WR in live
            'CL_Divergence_Aggro',    // 0% WR in live
            'CL_Divergence_Safe',     // 0% WR in live
            
            // UNDERPERFORMERS from live data:
            'SpotLag_TrailWide',      // 17% WR, -$1.35 - too wide trailing
            'SpotLag_TrailTight',     // Keep disabled for now
            'SpotLag_TP6'             // Higher threshold underperformed TP3
        ];
        
        for (const strat of toDisable) {
            await setLiveStrategyEnabled(strat, false);
            console.log(`❌ Disabled ${strat} - underperformed in live data`);
        }
        
        console.log('\n📊 Strategy configuration updated based on live data analysis');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail startup, just log warning
    }
}

// Run migrations before starting collector
await runMigrations();

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

