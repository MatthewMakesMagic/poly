#!/usr/bin/env node
/**
 * Execution Engine Launcher
 * 
 * Starts the 24/7 trading execution engine with proper:
 * - Signal handling (graceful shutdown)
 * - Crash recovery
 * - Health monitoring
 * - Logging
 * 
 * Usage:
 *   node scripts/run_execution_engine.mjs [options]
 * 
 * Options:
 *   --paper         Run in paper trading mode (default for safety)
 *   --live          Run in LIVE trading mode (real money!)
 *   --crypto=btc    Comma-separated list of cryptos (default: btc,xrp)
 *   --max-position  Maximum position per trade in USD (default: 1)
 *   --dry-run       Test startup but don't actually trade
 * 
 * Environment Variables:
 *   POLYMARKET_API_KEY       - API key from Polymarket
 *   POLYMARKET_SECRET        - API secret
 *   POLYMARKET_PASSPHRASE    - API passphrase
 *   POLYMARKET_PRIVATE_KEY   - Private key for signing
 *   POLYMARKET_FUNDER_ADDRESS - Your Polymarket profile address
 *   DISCORD_WEBHOOK_URL      - Optional Discord webhook for alerts
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // Also try .env as fallback

import { 
    ExecutionEngine, 
    EngineState, 
    attachMonitor 
} from '../src/execution/index.js';

// Parse command line arguments
function parseArgs() {
    const args = {
        mode: 'paper',        // Default to paper for safety
        cryptos: ['btc', 'xrp'],
        maxPosition: 1,
        dryRun: false
    };
    
    for (const arg of process.argv.slice(2)) {
        if (arg === '--paper') {
            args.mode = 'paper';
        } else if (arg === '--live') {
            args.mode = 'live';
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg.startsWith('--crypto=')) {
            args.cryptos = arg.split('=')[1].split(',').map(c => c.trim().toLowerCase());
        } else if (arg.startsWith('--max-position=')) {
            args.maxPosition = parseFloat(arg.split('=')[1]);
        }
    }
    
    return args;
}

// Verify environment
function verifyEnvironment(mode) {
    const required = [
        'POLYMARKET_API_KEY',
        'POLYMARKET_SECRET',
        'POLYMARKET_PASSPHRASE',
        'POLYMARKET_PRIVATE_KEY'
    ];
    
    const missing = required.filter(v => !process.env[v]);
    
    if (missing.length > 0) {
        console.error('\n❌ Missing required environment variables:');
        for (const v of missing) {
            console.error(`   - ${v}`);
        }
        console.error('\nPlease set these in your .env file.\n');
        return false;
    }
    
    if (mode === 'live') {
        console.log('\n⚠️  WARNING: LIVE TRADING MODE');
        console.log('   Real money will be used for trades.');
        console.log('   Make sure you have run test_live_order.mjs first.\n');
    }
    
    return true;
}

// Simple strategy for testing (can be replaced with real strategy)
class TestStrategy {
    constructor() {
        this.name = 'test_strategy';
        this.signalCount = 0;
    }
    
    getName() {
        return this.name;
    }
    
    onTick(tick, position) {
        // For now, don't generate any signals automatically
        // This is just a placeholder
        return { action: 'hold' };
    }
    
    // Generate manual signal (for testing)
    generateSignal(side, size) {
        return {
            action: 'buy',
            side,
            size,
            reason: 'manual_test'
        };
    }
}

// Main function
async function main() {
    const args = parseArgs();
    
    console.log('═'.repeat(70));
    console.log('     POLYMARKET EXECUTION ENGINE');
    console.log('═'.repeat(70));
    console.log(`   Mode: ${args.mode.toUpperCase()}`);
    console.log(`   Cryptos: ${args.cryptos.join(', ')}`);
    console.log(`   Max Position: $${args.maxPosition}`);
    console.log(`   Dry Run: ${args.dryRun}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('═'.repeat(70));
    
    // Verify environment
    if (!verifyEnvironment(args.mode)) {
        process.exit(1);
    }
    
    // Create engine
    const engine = new ExecutionEngine({
        mode: args.mode,
        cryptos: args.cryptos,
        strategy: new TestStrategy(),
        riskParams: {
            maxPositionPerTrade: args.maxPosition,
            maxPositionPerWindow: args.maxPosition * 5,
            maxTotalExposure: args.maxPosition * 20,
            maxLossPerTrade: args.maxPosition,
            maxLossPerDay: args.maxPosition * 20
        }
    });
    
    // Attach health monitor
    const monitor = attachMonitor(engine, {
        enableDiscord: !!process.env.DISCORD_WEBHOOK_URL
    });
    
    // Setup signal handlers for graceful shutdown
    let isShuttingDown = false;
    
    async function shutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log(`\n\nReceived ${signal}, shutting down gracefully...`);
        
        try {
            await engine.stop(`signal_${signal}`);
            console.log('Shutdown complete.');
            process.exit(0);
        } catch (error) {
            console.error('Error during shutdown:', error);
            process.exit(1);
        }
    }
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle uncaught errors
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception:', error);
        await monitor.alert(
            'UNCAUGHT_EXCEPTION',
            'CRITICAL',
            `Uncaught exception: ${error.message}`,
            { error: error.message, stack: error.stack }
        );
        await shutdown('uncaughtException');
    });
    
    process.on('unhandledRejection', async (reason) => {
        console.error('Unhandled rejection:', reason);
        await monitor.alert(
            'UNHANDLED_REJECTION',
            'ERROR',
            `Unhandled rejection: ${reason}`,
            { reason: String(reason) }
        );
    });
    
    // Dry run - just test startup
    if (args.dryRun) {
        console.log('\n🧪 Dry run mode - testing startup only...\n');
        try {
            await engine.start();
            console.log('\n✅ Engine started successfully!');
            console.log('   Dry run complete. Shutting down...\n');
            await engine.stop('dry_run_complete');
            process.exit(0);
        } catch (error) {
            console.error('\n❌ Engine failed to start:', error.message);
            process.exit(1);
        }
    }
    
    // Start engine
    try {
        await engine.start();
        
        console.log('\n✅ Engine running. Press Ctrl+C to stop.\n');
        console.log('Commands (via REPL - not implemented yet):');
        console.log('   status  - Show current status');
        console.log('   pause   - Pause trading');
        console.log('   resume  - Resume trading');
        console.log('   stop    - Stop engine');
        console.log('');
        
        // Keep alive
        setInterval(() => {
            // Heartbeat - engine handles its own periodic tasks
        }, 60000);
        
    } catch (error) {
        console.error('\n❌ Failed to start engine:', error);
        await monitor.engineError(error);
        process.exit(1);
    }
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
