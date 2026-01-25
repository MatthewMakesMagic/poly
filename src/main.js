/**
 * Main Orchestrator
 * 
 * Ties together:
 * - Data collection (Polymarket + Binance)
 * - Prediction engine
 * - Strategy runner with execution tracking
 * - Dashboard server
 * - Notification service
 * 
 * Pre-alpha measurement framework for:
 * - Entry/exit timing analysis
 * - Capital per trade tracking ($100 default)
 * - Multi-strategy comparison
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

import { DataCollector, CRYPTO_CONFIG } from './collector/data-collector.js';
import { 
    startDashboard, 
    sendTick, 
    updatePrediction, 
    sendMetrics, 
    sendStrategyComparison,
    setStrategyRunner,
    setExecutionTracker
} from './dashboard/server.js';
import { getPredictor } from './analysis/predictor.js';
import { getStrategyRunner } from './analysis/strategy-runner.js';
import { getExecutionTracker } from './trading/execution-tracker.js';
import { getNotifier } from './notifications/notifier.js';
import { initDatabase, getDatabase } from './db/connection.js';
import { getResearchEngine } from './quant/research_engine.js';

const CONFIG = {
    DASHBOARD_PORT: process.env.DASHBOARD_PORT || 3333,
    CRYPTOS: (process.env.CRYPTOS || 'BTC,ETH,SOL,XRP').split(','),
    ENABLE_NOTIFICATIONS: process.env.ENABLE_NOTIFICATIONS !== 'false',
    PREDICTION_UPDATE_INTERVAL: 5000, // 5 seconds
    
    // Trading configuration
    CAPITAL_PER_TRADE: parseFloat(process.env.CAPITAL_PER_TRADE) || 100,
    ENABLE_PAPER_TRADING: process.env.ENABLE_PAPER_TRADING !== 'false',
    COMPARE_STRATEGIES: process.env.COMPARE_STRATEGIES !== 'false',
};

class TradingOrchestrator {
    constructor() {
        this.collector = null;
        this.predictor = getPredictor();
        this.notifier = getNotifier();
        this.running = false;
        this.tickHistory = {};
        this.currentWindow = {};
        
        // Initialize strategy runner for measurement
        this.strategyRunner = getStrategyRunner({
            capitalPerTrade: CONFIG.CAPITAL_PER_TRADE,
            executeTrades: CONFIG.ENABLE_PAPER_TRADING,
            cryptos: CONFIG.CRYPTOS
        });
        
        // Execution tracker reference
        this.executionTracker = getExecutionTracker({
            capitalPerTrade: CONFIG.CAPITAL_PER_TRADE
        });
        
        // Research engine for crypto-level strategy tracking
        this.researchEngine = getResearchEngine({
            capitalPerTrade: CONFIG.CAPITAL_PER_TRADE,
            enablePaperTrading: true
        });
        
        // Initialize tick history for each crypto
        for (const crypto of CONFIG.CRYPTOS) {
            this.tickHistory[crypto] = [];
        }
        
        // Register default strategies for comparison
        if (CONFIG.COMPARE_STRATEGIES) {
            this.strategyRunner.registerDefaultStrategies();
        }
    }
    
    async start() {
        console.log('═══════════════════════════════════════════');
        console.log('       POLY TRADING SYSTEM STARTING        ');
        console.log('═══════════════════════════════════════════\n');
        
        // Initialize database
        console.log('📦 Initializing database...');
        await initDatabase();
        
        // Start dashboard
        console.log('🖥️  Starting dashboard...');
        await startDashboard(CONFIG.DASHBOARD_PORT);
        
        // Set references for API endpoints
        setStrategyRunner(this.strategyRunner);
        setExecutionTracker(this.executionTracker);
        
        // Start data collector
        console.log('📡 Starting data collector...');
        this.collector = new DataCollector({
            cryptos: CONFIG.CRYPTOS,
            onTick: (tick) => this.handleTick(tick),
            onWindowStart: (window) => this.handleWindowStart(window),
            onWindowEnd: (window) => this.handleWindowEnd(window)
        });
        
        await this.collector.start();
        
        this.running = true;
        
        // Send periodic metrics updates
        setInterval(() => this.sendMetricsUpdate(), 10000);
        
        console.log('\n✅ System started successfully!');
        console.log(`   Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
        console.log('   Press Ctrl+C to stop\n');
        
        // Handle graceful shutdown
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }
    
    handleTick(tick) {
        const crypto = tick.crypto;
        const config = CRYPTO_CONFIG[crypto] || { priceDecimals: 2 };
        
        // Store tick in history (keep last 100)
        if (!this.tickHistory[crypto]) {
            this.tickHistory[crypto] = [];
        }
        this.tickHistory[crypto].push(tick);
        if (this.tickHistory[crypto].length > 100) {
            this.tickHistory[crypto].shift();
        }
        
        // Enhanced tick with proper pricing
        const enhancedTick = {
            ...tick,
            price_to_beat: tick.price_to_beat || tick.window_start_price,
            implied_direction: tick.spot_price >= (tick.price_to_beat || tick.window_start_price) ? 'up' : 'down'
        };
        
        // Send to dashboard
        sendTick(enhancedTick);
        
        // Generate and send prediction
        const prediction = this.predictor.predict(enhancedTick, this.tickHistory[crypto]);
        updatePrediction(prediction);
        
        // Run through strategy runner (measures all strategies)
        if (CONFIG.COMPARE_STRATEGIES) {
            const strategyResults = this.strategyRunner.processTick(enhancedTick);
            
            // Log significant strategy actions (not holds)
            for (const result of strategyResults) {
                if (result.action !== 'hold') {
                    // Action logged by execution tracker
                }
            }
        }
        
        // Also run through research engine (has crypto-level tracking)
        if (this.researchEngine) {
            this.researchEngine.processTick(enhancedTick);
        }
        
        // Check for significant moves
        if (CONFIG.ENABLE_NOTIFICATIONS && tick.spot_delta_pct) {
            if (Math.abs(tick.spot_delta_pct) > 0.005) { // 0.5% move
                this.notifier.notifySignificantMove({
                    crypto,
                    priceChange: tick.spot_delta_pct,
                    upPrice: tick.up_mid,
                    spotPrice: tick.spot_price,
                    priceToBeat: tick.price_to_beat
                });
            }
        }
    }
    
    handleWindowStart(window) {
        const config = CRYPTO_CONFIG[window.crypto] || { priceDecimals: 2 };
        const ptbStr = window.priceToBeat 
            ? `$${window.priceToBeat.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals })}`
            : 'TBD';
        
        console.log(`\n🕐 Window started: ${window.crypto} epoch ${window.epoch}`);
        console.log(`   Price to beat: ${ptbStr}`);
        
        this.currentWindow[window.crypto] = window;
        
        // Clear tick history for new window
        this.tickHistory[window.crypto] = [];
        
        // Notify strategy runner
        if (CONFIG.COMPARE_STRATEGIES) {
            this.strategyRunner.onWindowStart(window);
        }
        
        if (CONFIG.ENABLE_NOTIFICATIONS) {
            this.notifier.notifyWindowStart(window);
        }
    }
    
    handleWindowEnd(window) {
        const config = CRYPTO_CONFIG[window.crypto] || { priceDecimals: 2 };
        const outcome = window.outcome || 'unknown';
        const finalStr = window.finalPrice 
            ? `$${window.finalPrice.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals })}`
            : 'unknown';
        
        console.log(`\n🏁 Window ended: ${window.crypto} epoch ${window.epoch}`);
        console.log(`   Outcome: ${outcome.toUpperCase()} | Final: ${finalStr}`);
        
        // Notify strategy runner (will close positions)
        if (CONFIG.COMPARE_STRATEGIES) {
            this.strategyRunner.onWindowEnd(window);
            
            // Log strategy comparison for this window
            const comparison = this.strategyRunner.getStrategyComparison();
            console.log(`   Strategy Performance:`);
            for (const [name, data] of Object.entries(comparison)) {
                const metrics = data.tradeMetrics;
                if (metrics.tradeCount > 0) {
                    const pnlStr = metrics.netPnl >= 0 ? `+$${metrics.netPnl.toFixed(2)}` : `-$${Math.abs(metrics.netPnl).toFixed(2)}`;
                    console.log(`     ${name}: ${metrics.tradeCount} trades, ${pnlStr}, ${(metrics.winRate * 100).toFixed(0)}% win`);
                }
            }
        }
        
        // Also notify research engine (has crypto-level tracking)
        if (this.researchEngine) {
            this.researchEngine.onWindowEnd(window);
        }
        
        delete this.currentWindow[window.crypto];
    }
    
    async sendMetricsUpdate() {
        try {
            // Get metrics from execution tracker (real-time)
            const trackerSummary = this.executionTracker.getSummary();
            
            // Get research engine strategy report (has crypto-level breakdown)
            const researchReport = this.researchEngine 
                ? this.researchEngine.getStrategyPerformanceReport()
                : { strategies: [] };
            
            // Calculate aggregate metrics from research engine
            let totalTrades = 0;
            let totalPnl = 0;
            let wins = 0;
            let openCount = 0;
            
            for (const strat of researchReport.strategies) {
                totalTrades += strat.closedTrades || 0;
                totalPnl += strat.totalPnl || 0;
                wins += strat.wins || 0;
                openCount += strat.openPositions?.length || 0;
            }
            
            const winRate = totalTrades > 0 ? wins / totalTrades : 0;
            
            // Send to dashboard
            sendMetrics({
                totalTrades,
                totalPnl,
                winRate,
                openPositions: openCount,
                capitalPerTrade: CONFIG.CAPITAL_PER_TRADE,
                strategies: researchReport.strategies.map(s => s.name)
            });
            
            // Send detailed strategy comparison with crypto-level data
            if (typeof sendStrategyComparison === 'function') {
                sendStrategyComparison(researchReport);
            }
            
            // Also try DB metrics for historical data
            try {
                const db = getDatabase();
                if (db) {
                    const today = new Date().toISOString().split('T')[0];
                    const dbMetrics = db.prepare(`
                        SELECT 
                            COUNT(*) as totalTrades,
                            SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
                            SUM(realized_pnl) as totalPnl
                        FROM trades
                        WHERE date(timestamp) = ?
                    `).get(today);
                    
                    if (dbMetrics && dbMetrics.totalTrades > 0) {
                        console.log(`   📊 DB: ${dbMetrics.totalTrades} trades, $${(dbMetrics.totalPnl || 0).toFixed(2)} P&L`);
                    }
                }
            } catch (e) {
                // DB metrics optional
            }
        } catch (e) {
            // Ignore errors during metrics update
        }
    }
    
    async shutdown() {
        console.log('\n\n⏹️  Shutting down...');
        this.running = false;
        
        if (this.collector) {
            await this.collector.stop();
        }
        
        console.log('👋 Goodbye!\n');
        process.exit(0);
    }
}

// Main entry point
const orchestrator = new TradingOrchestrator();
orchestrator.start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});

export { TradingOrchestrator };

