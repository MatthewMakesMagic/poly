#!/usr/bin/env node
/**
 * Start the Tick Data Collector Service
 * 
 * Usage: npm run collect
 */

import { TickCollector } from '../src/collectors/tick_collector.js';

console.log('🚀 Starting Polymarket Tick Collector...\n');

const collector = new TickCollector();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n📴 Received SIGINT, shutting down gracefully...');
    collector.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n📴 Received SIGTERM, shutting down gracefully...');
    collector.stop();
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    collector.stop();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
});

// Start collector
collector.start().catch((error) => {
    console.error('❌ Failed to start collector:', error);
    process.exit(1);
});

