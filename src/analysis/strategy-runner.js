/**
 * Strategy Runner & Measurement System
 * 
 * Runs multiple strategies simultaneously on live data to:
 * - Compare real-time performance
 * - Measure what would have happened with each approach
 * - Track entry/exit decisions and timing
 * 
 * Pre-alpha measurement framework.
 */

import { getExecutionTracker, DEFAULT_CONFIG } from '../trading/execution-tracker.js';
import { ThresholdExitStrategy } from '../backtest/strategies/threshold_exit.js';
import { createAllStrategies, QUANT_STRATEGIES } from '../backtest/strategies/quant_suite.js';

/**
 * Strategy Signal - captures what a strategy would do at a given tick
 */
class StrategySignal {
    constructor(params) {
        this.timestamp = Date.now();
        this.strategy = params.strategy;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;
        this.timeRemaining = params.timeRemaining;
        
        // Market state at signal time
        this.spotPrice = params.spotPrice;
        this.priceToBeat = params.priceToBeat;
        this.upPrice = params.upPrice;
        this.upBid = params.upBid;
        this.upAsk = params.upAsk;
        this.spread = params.spread;
        
        // Signal
        this.action = params.action;        // 'buy', 'sell', 'hold'
        this.side = params.side;            // 'up' or 'down'
        this.reason = params.reason;
        this.confidence = params.confidence || 0;
        
        // Whether signal was executed
        this.executed = false;
        this.tradeId = null;
    }
}

/**
 * Strategy Instance - wraps a strategy with its state
 */
class StrategyInstance {
    constructor(strategy, config = {}) {
        this.strategy = strategy;
        this.name = strategy.getName();
        this.config = {
            capitalPerTrade: config.capitalPerTrade || 100,
            enabled: config.enabled !== false,
            paperTrade: config.paperTrade !== false,
            cooldownTicks: config.cooldownTicks || 10,  // Minimum ticks between trades
            maxTradesPerWindow: config.maxTradesPerWindow || 5  // Limit trades per window
        };
        
        // State per crypto
        this.positions = {};        // crypto -> position
        this.signals = [];          // Signal history
        this.tickHistory = {};      // crypto -> tick[]
        
        // Anti-death-spiral protections per crypto
        this.cooldowns = {};        // crypto -> ticks remaining
        this.tradesThisWindow = {}; // crypto -> count
        this.lastTradeTime = {};    // crypto -> timestamp
        
        // Stats
        this.signalCount = 0;
        this.buySignals = 0;
        this.sellSignals = 0;
    }
    
    /**
     * Process a tick and generate signals
     */
    processTick(tick) {
        const crypto = tick.crypto;
        
        // Initialize state for this crypto if needed
        if (!this.cooldowns[crypto]) this.cooldowns[crypto] = 0;
        if (!this.tradesThisWindow[crypto]) this.tradesThisWindow[crypto] = 0;
        
        // Decrement cooldown
        if (this.cooldowns[crypto] > 0) {
            this.cooldowns[crypto]--;
        }
        
        // Update tick history
        if (!this.tickHistory[crypto]) {
            this.tickHistory[crypto] = [];
        }
        this.tickHistory[crypto].push(tick);
        if (this.tickHistory[crypto].length > 100) {
            this.tickHistory[crypto].shift();
        }
        
        // Get current position
        const position = this.positions[crypto];
        
        // Get strategy decision
        const context = {
            equity: [],
            trades: [],
            history: this.tickHistory[crypto]
        };
        
        let signal;
        try {
            signal = this.strategy.onTick(tick, position, context);
        } catch (e) {
            signal = { action: 'hold' };
        }
        
        // Check risk limits if in position
        if (position) {
            const riskAction = this.strategy.checkRiskLimits(tick, position);
            if (riskAction) {
                signal = { action: 'sell', reason: riskAction.reason };
            }
        }
        
        // ANTI-DEATH-SPIRAL PROTECTION
        // Block buy signals if:
        // 1. Cooldown is active
        // 2. Max trades per window reached
        // 3. No valid price data
        if (signal.action === 'buy') {
            if (this.cooldowns[crypto] > 0) {
                signal = { action: 'hold', reason: 'cooldown' };
            } else if (this.tradesThisWindow[crypto] >= this.config.maxTradesPerWindow) {
                signal = { action: 'hold', reason: 'max_trades' };
            } else if (!tick.up_bid || !tick.up_ask || tick.up_bid <= 0.01 || tick.up_ask >= 0.99) {
                signal = { action: 'hold', reason: 'invalid_price' };
            }
        }
        
        // Create signal record
        const signalRecord = new StrategySignal({
            strategy: this.name,
            crypto,
            windowEpoch: tick.epoch,
            timeRemaining: tick.time_remaining_sec,
            spotPrice: tick.spot_price,
            priceToBeat: tick.price_to_beat,
            upPrice: tick.up_mid,
            upBid: tick.up_bid,
            upAsk: tick.up_ask,
            spread: tick.spread,
            action: signal.action,
            side: signal.side,
            reason: signal.reason,
            confidence: signal.confidence
        });
        
        this.signalCount++;
        if (signal.action === 'buy') this.buySignals++;
        if (signal.action === 'sell') this.sellSignals++;
        
        // Store signal (last 1000)
        this.signals.push(signalRecord);
        if (this.signals.length > 1000) this.signals.shift();
        
        return {
            signal: signalRecord,
            action: signal.action,
            side: signal.side,
            size: signal.size || this.config.capitalPerTrade,
            reason: signal.reason
        };
    }
    
    /**
     * Trigger cooldown after a trade
     */
    triggerCooldown(crypto) {
        this.cooldowns[crypto] = this.config.cooldownTicks;
        this.tradesThisWindow[crypto] = (this.tradesThisWindow[crypto] || 0) + 1;
        this.lastTradeTime[crypto] = Date.now();
    }
    
    /**
     * Record position opened
     */
    openPosition(crypto, position) {
        this.positions[crypto] = position;
    }
    
    /**
     * Record position closed
     */
    closePosition(crypto) {
        delete this.positions[crypto];
    }
    
    /**
     * Handle window start
     */
    onWindowStart(windowInfo) {
        try {
            this.strategy.onWindowStart(windowInfo);
        } catch (e) {}
        
        const crypto = windowInfo.crypto;
        
        // Clear position for this crypto (shouldn't be any, but just in case)
        delete this.positions[crypto];
        
        // Clear tick history for new window
        this.tickHistory[crypto] = [];
        
        // Reset anti-death-spiral counters for new window
        this.cooldowns[crypto] = 0;
        this.tradesThisWindow[crypto] = 0;
    }
    
    /**
     * Handle window end
     */
    onWindowEnd(windowInfo) {
        try {
            this.strategy.onWindowEnd(windowInfo, windowInfo.outcome);
        } catch (e) {}
    }
    
    /**
     * Get recent signals for analysis
     */
    getRecentSignals(crypto = null, count = 100) {
        let signals = this.signals;
        if (crypto) {
            signals = signals.filter(s => s.crypto === crypto);
        }
        return signals.slice(-count);
    }
    
    /**
     * Get signal statistics
     */
    getSignalStats() {
        return {
            name: this.name,
            totalSignals: this.signalCount,
            buySignals: this.buySignals,
            sellSignals: this.sellSignals,
            holdSignals: this.signalCount - this.buySignals - this.sellSignals,
            activePositions: Object.keys(this.positions).length
        };
    }
}

/**
 * Main Strategy Runner
 * 
 * Orchestrates multiple strategies running on the same data
 */
export class StrategyRunner {
    constructor(config = {}) {
        this.config = {
            capitalPerTrade: config.capitalPerTrade || 100,
            executeTrades: config.executeTrades !== false,
            cryptos: config.cryptos || ['BTC', 'ETH', 'SOL', 'XRP'],
            ...config
        };
        
        this.strategies = new Map();
        this.executionTracker = getExecutionTracker({
            capitalPerTrade: this.config.capitalPerTrade
        });
        
        // Window state
        this.activeWindows = {};
        
        // Measurement data
        this.windowHistory = [];
        this.measurements = [];
    }
    
    /**
     * Register a strategy to run
     */
    registerStrategy(strategy, config = {}) {
        const instance = new StrategyInstance(strategy, {
            capitalPerTrade: this.config.capitalPerTrade,
            ...config
        });
        
        this.strategies.set(instance.name, instance);
        console.log(`📊 Registered strategy: ${instance.name}`);
        
        return instance;
    }
    
    /**
     * Register default strategies - uses full quant suite (20 strategies)
     */
    registerDefaultStrategies() {
        // Register the original threshold strategy
        this.registerStrategy(new ThresholdExitStrategy({ maxPosition: this.config.capitalPerTrade }));
        
        // Register the full quant suite
        const quantStrategies = createAllStrategies(this.config.capitalPerTrade);
        for (const strategy of quantStrategies) {
            this.registerStrategy(strategy);
        }
        
        console.log(`📊 Registered ${this.strategies.size} strategies (full quant suite)`);
    }
    
    /**
     * Register a subset of strategies by category
     */
    registerStrategySubset(categories = ['time', 'momentum', 'reversion']) {
        const categoryMap = {
            'time': ['EarlyWindow', 'MidWindow', 'LateWindow', 'WindowPhase'],
            'momentum': ['FastMomentum', 'SlowMomentum', 'SpotMomentum', 'CrossoverMomentum'],
            'reversion': ['QuickReversion', 'DeepReversion', 'BollingerReversion'],
            'spot': ['SpotLead', 'SpotDelta', 'SpotVelocity'],
            'micro': ['SpreadArb', 'BookImbalance', 'PriceLevel'],
            'ensemble': ['ConsensusLong', 'ConsensusShort', 'ContraMajority']
        };
        
        const allStrategies = createAllStrategies(this.config.capitalPerTrade);
        
        for (const category of categories) {
            const names = categoryMap[category] || [];
            for (const strategy of allStrategies) {
                if (names.includes(strategy.getName())) {
                    this.registerStrategy(strategy);
                }
            }
        }
        
        console.log(`📊 Registered ${this.strategies.size} strategies from categories: ${categories.join(', ')}`);
    }
    
    /**
     * Process a tick through all strategies
     */
    processTick(tick) {
        const crypto = tick.crypto;
        const results = [];
        
        for (const [name, instance] of this.strategies) {
            if (!instance.config.enabled) continue;
            
            const result = instance.processTick(tick);
            
            // Execute trades if enabled
            if (this.config.executeTrades && instance.config.paperTrade) {
                this.executeSignal(instance, result, tick);
            }
            
            results.push({
                strategy: name,
                ...result
            });
        }
        
        // Record measurement point
        this.recordMeasurement(tick, results);
        
        return results;
    }
    
    /**
     * Execute a signal (open/close trade)
     * 
     * Price logic:
     * - UP token: bid/ask directly from tick.up_bid/up_ask
     * - DOWN token: price = 1 - UP price
     *   - DOWN bid = 1 - UP ask
     *   - DOWN ask = 1 - UP bid
     * 
     * When buying: pay the ask
     * When selling: receive the bid
     */
    executeSignal(instance, result, tick) {
        const crypto = tick.crypto;
        
        // Validate we have price data
        if (!tick.up_bid || !tick.up_ask || tick.up_bid <= 0 || tick.up_ask <= 0) {
            return; // Skip if no valid order book
        }
        
        if (result.action === 'buy' && !instance.positions[crypto]) {
            // Calculate entry price (we pay the ask)
            let entryPrice;
            if (result.side === 'down') {
                // DOWN ask = 1 - UP bid
                entryPrice = 1 - tick.up_bid;
            } else {
                // UP ask
                entryPrice = tick.up_ask;
            }
            
            // Skip if entry price is invalid
            if (entryPrice <= 0 || entryPrice >= 1) {
                return;
            }
            
            // Open position
            const trade = this.executionTracker.openTrade({
                strategy: instance.name,
                crypto,
                windowEpoch: tick.epoch,
                side: result.side || 'up',
                entryPrice,
                spotAtEntry: tick.spot_price,
                priceToBeat: tick.price_to_beat,
                timeRemaining: tick.time_remaining_sec,
                capital: result.size
            });
            
            instance.openPosition(crypto, {
                id: trade.id,
                side: trade.side,
                entryPrice: trade.entryPrice,
                entryTime: trade.entryTime
            });
            
            result.signal.executed = true;
            result.signal.tradeId = trade.id;
            
            // Trigger cooldown to prevent rapid trading
            instance.triggerCooldown(crypto);
            
        } else if (result.action === 'sell' && instance.positions[crypto]) {
            // Close position - we receive the bid
            const position = instance.positions[crypto];
            let exitPrice;
            if (position.side === 'up') {
                exitPrice = tick.up_bid;
            } else {
                // DOWN bid = 1 - UP ask
                exitPrice = 1 - tick.up_ask;
            }
            
            // Skip if exit price is invalid
            if (exitPrice <= 0 || exitPrice >= 1) {
                return;
            }
            
            this.executionTracker.closeTrade(position.id, {
                exitPrice,
                spotAtExit: tick.spot_price,
                reason: result.reason || 'strategy_signal'
            });
            
            instance.closePosition(crypto);
            
            // Trigger cooldown after closing
            instance.triggerCooldown(crypto);
            
            result.signal.executed = true;
            result.signal.tradeId = position.id;
        }
    }
    
    /**
     * Handle window start across all strategies
     */
    onWindowStart(windowInfo) {
        this.activeWindows[windowInfo.crypto] = windowInfo;
        
        for (const [name, instance] of this.strategies) {
            instance.onWindowStart(windowInfo);
        }
        
        // Record window start
        this.windowHistory.push({
            type: 'start',
            ...windowInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle window end across all strategies
     */
    onWindowEnd(windowInfo) {
        // Close any open positions for this window
        this.executionTracker.handleWindowExpiry(
            windowInfo.crypto,
            windowInfo.epoch,
            windowInfo.outcome,
            windowInfo.finalPrice
        );
        
        // Notify strategies
        for (const [name, instance] of this.strategies) {
            instance.onWindowEnd(windowInfo);
            instance.closePosition(windowInfo.crypto);
        }
        
        delete this.activeWindows[windowInfo.crypto];
        
        // Record window end
        this.windowHistory.push({
            type: 'end',
            ...windowInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Record measurement point for analysis
     */
    recordMeasurement(tick, strategyResults) {
        const measurement = {
            timestamp: Date.now(),
            crypto: tick.crypto,
            epoch: tick.epoch,
            timeRemaining: tick.time_remaining_sec,
            
            // Market state
            spotPrice: tick.spot_price,
            priceToBeat: tick.price_to_beat,
            spotDelta: tick.spot_delta_pct,
            upPrice: tick.up_mid,
            spread: tick.spread,
            
            // Strategy actions
            strategies: {}
        };
        
        for (const result of strategyResults) {
            measurement.strategies[result.strategy] = {
                action: result.action,
                side: result.side,
                reason: result.reason,
                executed: result.signal?.executed
            };
        }
        
        this.measurements.push(measurement);
        
        // Keep last 10000 measurements
        if (this.measurements.length > 10000) {
            this.measurements.shift();
        }
    }
    
    /**
     * Get comparison of all strategies
     */
    getStrategyComparison(period = 'all') {
        const comparison = {};
        
        for (const [name, instance] of this.strategies) {
            comparison[name] = {
                signalStats: instance.getSignalStats(),
                tradeMetrics: this.executionTracker.getStrategyMetrics(name, period)
            };
        }
        
        return comparison;
    }
    
    /**
     * Get what each strategy would have done in last N windows
     */
    getWindowAnalysis(count = 10) {
        // Get last N completed windows
        const completedWindows = this.windowHistory
            .filter(w => w.type === 'end')
            .slice(-count);
        
        const analysis = completedWindows.map(window => {
            const windowMeasurements = this.measurements.filter(
                m => m.crypto === window.crypto && m.epoch === window.epoch
            );
            
            // Analyze each strategy's behavior during this window
            const strategyBehavior = {};
            
            for (const [name, instance] of this.strategies) {
                const signals = instance.getRecentSignals(window.crypto)
                    .filter(s => s.windowEpoch === window.epoch);
                
                const buySignals = signals.filter(s => s.action === 'buy');
                const sellSignals = signals.filter(s => s.action === 'sell');
                
                strategyBehavior[name] = {
                    totalSignals: signals.length,
                    buyCount: buySignals.length,
                    sellCount: sellSignals.length,
                    firstBuy: buySignals[0] || null,
                    firstSell: sellSignals[0] || null,
                    executed: signals.filter(s => s.executed).length
                };
            }
            
            return {
                crypto: window.crypto,
                epoch: window.epoch,
                outcome: window.outcome,
                priceToBeat: window.priceToBeat,
                finalPrice: window.finalPrice,
                priceChange: window.finalPrice && window.priceToBeat 
                    ? ((window.finalPrice - window.priceToBeat) / window.priceToBeat * 100).toFixed(4)
                    : null,
                measurementCount: windowMeasurements.length,
                strategies: strategyBehavior
            };
        });
        
        return analysis;
    }
    
    /**
     * Get summary for dashboard
     */
    getSummary() {
        const trackerSummary = this.executionTracker.getSummary();
        
        return {
            ...trackerSummary,
            activeWindows: Object.keys(this.activeWindows),
            registeredStrategies: Array.from(this.strategies.keys()),
            measurementCount: this.measurements.length,
            windowsTracked: this.windowHistory.filter(w => w.type === 'end').length,
            comparison: this.getStrategyComparison()
        };
    }
}

// Singleton
let runnerInstance = null;

export function getStrategyRunner(config = {}) {
    if (!runnerInstance) {
        runnerInstance = new StrategyRunner(config);
    }
    return runnerInstance;
}

export { StrategySignal, StrategyInstance };
export default StrategyRunner;
