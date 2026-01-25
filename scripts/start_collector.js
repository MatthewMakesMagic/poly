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

// Run startup migrations
async function runMigrations() {
    try {
        // Initialize database connection first
        await initDatabase();
        
        // Enable new strategies (one-time migration)
        const newStrategies = [
            // Trailing stop strategies
            'SpotLag_Trailing',
            'SpotLag_TrailTight',
            'SpotLag_TrailWide',
            // CHAINLINK FINAL SECONDS ONLY - the "frozen Chainlink" edge
            // In final 10-30s, Chainlink is locked. If it disagrees with market at cheap prices = 10-100x
            // DISABLED earlier CL_Divergence strategies because Chainlink can still update (60s heartbeat)
            'CL_FinalSeconds',
            'CL_FinalSeconds_Ultra'
        ];
        
        // DISABLE strategies that trade too early (Chainlink can update before expiry)
        const toDisable = [
            'CL_Divergence',        // 60-600s remaining = Chainlink updates ~10x
            'CL_Divergence_Aggro',  // 60-780s remaining = even worse
            'CL_Divergence_Safe'    // 30-300s remaining = still risky
        ];
        
        for (const strat of toDisable) {
            await setLiveStrategyEnabled(strat, false);
            console.log(`❌ Disabled ${strat} (Chainlink can update before expiry)`);
        }
        
        for (const strat of newStrategies) {
            await setLiveStrategyEnabled(strat, true);
            console.log(`✅ Enabled ${strat} for live trading`);
        }
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

