#!/usr/bin/env node
/**
 * Start the Tick Data Collector Service
 * 
 * Usage: npm run collect
 * 
 * Made crash-resistant: Will try to recover from errors instead of exiting.
 */

import { TickCollector } from '../src/collectors/tick_collector.js';

console.log('🚀 Starting Polymarket Tick Collector...\n');

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

