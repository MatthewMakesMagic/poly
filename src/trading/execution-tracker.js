/**
 * Trade Execution Tracker
 * 
 * Comprehensive tracking of trade entries and exits with:
 * - Precise timing (ms resolution)
 * - Capital management ($100/trade default)
 * - P&L calculation with fees
 * - Strategy comparison across time periods
 * 
 * This is the pre-alpha measurement foundation.
 */

import { v4 as uuidv4 } from 'uuid';

// Default configuration
const DEFAULT_CONFIG = {
    capitalPerTrade: 100,          // $100 per trade
    maxConcurrentTrades: 5,        // Max simultaneous positions
    takerFee: 0.001,               // 0.1% taker fee
    spreadCost: 0.01,              // ~1% spread cost
    roundTripCost: 0.024,          // ~2.4% total round-trip
};

/**
 * Single trade execution record
 */
class TradeExecution {
    constructor(params) {
        this.id = uuidv4();
        this.strategy = params.strategy;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;
        
        // Entry details
        this.side = params.side;                    // 'up' or 'down'
        this.entryTime = Date.now();
        this.entryPrice = params.entryPrice;        // Polymarket price (0-1)
        this.spotAtEntry = params.spotAtEntry;      // Binance spot price
        this.priceToBeat = params.priceToBeat;      // Window's price to beat
        this.timeRemainingAtEntry = params.timeRemaining;
        
        // Position sizing
        this.capital = params.capital || DEFAULT_CONFIG.capitalPerTrade;
        this.shares = this.capital / this.entryPrice;  // Shares bought
        
        // Fees
        this.entryFee = this.capital * DEFAULT_CONFIG.takerFee;
        this.exitFee = 0;
        
        // Exit details (filled on close)
        this.exitTime = null;
        this.exitPrice = null;
        this.spotAtExit = null;
        this.exitReason = null;
        this.holdingTimeMs = null;
        
        // P&L
        this.grossPnl = null;
        this.netPnl = null;
        this.returnPct = null;
        
        // Outcome tracking
        this.windowOutcome = null;      // 'up', 'down', or null
        this.wasCorrect = null;         // Did we bet correctly?
        
        // Status
        this.status = 'open';           // 'open', 'closed', 'expired'
    }
    
    /**
     * Close the trade
     */
    close(params) {
        this.exitTime = Date.now();
        this.exitPrice = params.exitPrice;
        this.spotAtExit = params.spotAtExit;
        this.exitReason = params.reason || 'manual';
        this.holdingTimeMs = this.exitTime - this.entryTime;
        
        // Calculate exit fee
        this.exitFee = (this.shares * this.exitPrice) * DEFAULT_CONFIG.takerFee;
        
        // Calculate P&L
        const exitValue = this.shares * this.exitPrice;
        this.grossPnl = exitValue - this.capital;
        this.netPnl = this.grossPnl - this.entryFee - this.exitFee;
        this.returnPct = this.netPnl / this.capital;
        
        this.status = 'closed';
        
        return this;
    }
    
    /**
     * Mark trade as expired (window ended)
     */
    expire(params) {
        this.exitTime = Date.now();
        this.windowOutcome = params.outcome;
        this.spotAtExit = params.finalPrice;
        
        // At expiry, price goes to 1 if correct, 0 if wrong
        const isCorrect = (this.side === 'up' && params.outcome === 'up') ||
                         (this.side === 'down' && params.outcome === 'down');
        
        this.wasCorrect = isCorrect;
        this.exitPrice = isCorrect ? 1.0 : 0.0;
        this.exitReason = 'window_expiry';
        this.holdingTimeMs = this.exitTime - this.entryTime;
        
        // P&L calculation
        const exitValue = this.shares * this.exitPrice;
        this.grossPnl = exitValue - this.capital;
        this.netPnl = this.grossPnl - this.entryFee;  // No exit fee on resolution
        this.returnPct = this.netPnl / this.capital;
        
        this.status = 'expired';
        
        return this;
    }
    
    /**
     * Get current unrealized P&L
     */
    getUnrealizedPnl(currentPrice) {
        if (this.status !== 'open') return null;
        
        const currentValue = this.shares * currentPrice;
        const grossPnl = currentValue - this.capital;
        const estimatedExitFee = currentValue * DEFAULT_CONFIG.takerFee;
        
        return {
            gross: grossPnl,
            net: grossPnl - this.entryFee - estimatedExitFee,
            returnPct: (grossPnl - this.entryFee - estimatedExitFee) / this.capital
        };
    }
    
    /**
     * Convert to plain object for storage
     */
    toJSON() {
        return {
            id: this.id,
            strategy: this.strategy,
            crypto: this.crypto,
            windowEpoch: this.windowEpoch,
            side: this.side,
            capital: this.capital,
            shares: this.shares,
            
            entryTime: this.entryTime,
            entryPrice: this.entryPrice,
            spotAtEntry: this.spotAtEntry,
            priceToBeat: this.priceToBeat,
            timeRemainingAtEntry: this.timeRemainingAtEntry,
            entryFee: this.entryFee,
            
            exitTime: this.exitTime,
            exitPrice: this.exitPrice,
            spotAtExit: this.spotAtExit,
            exitReason: this.exitReason,
            exitFee: this.exitFee,
            holdingTimeMs: this.holdingTimeMs,
            
            grossPnl: this.grossPnl,
            netPnl: this.netPnl,
            returnPct: this.returnPct,
            
            windowOutcome: this.windowOutcome,
            wasCorrect: this.wasCorrect,
            status: this.status
        };
    }
}

/**
 * Strategy performance metrics calculator
 */
class StrategyMetrics {
    constructor(strategyName) {
        this.strategyName = strategyName;
        this.trades = [];
        this.startTime = Date.now();
    }
    
    addTrade(trade) {
        this.trades.push(trade);
    }
    
    /**
     * Calculate comprehensive metrics
     */
    calculate(period = 'all') {
        let trades = this.trades.filter(t => t.status !== 'open');
        
        // Filter by period
        if (period !== 'all') {
            const cutoff = Date.now() - this.parsePeriod(period);
            trades = trades.filter(t => t.entryTime >= cutoff);
        }
        
        if (trades.length === 0) {
            return this.emptyMetrics();
        }
        
        // Basic counts
        const winners = trades.filter(t => t.netPnl > 0);
        const losers = trades.filter(t => t.netPnl <= 0);
        
        // P&L calculations
        const totalGrossPnl = trades.reduce((s, t) => s + (t.grossPnl || 0), 0);
        const totalNetPnl = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
        const totalFees = trades.reduce((s, t) => s + (t.entryFee || 0) + (t.exitFee || 0), 0);
        
        const grossProfit = winners.reduce((s, t) => s + (t.grossPnl || 0), 0);
        const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.grossPnl || 0), 0));
        
        // Averages
        const avgWin = winners.length > 0 
            ? winners.reduce((s, t) => s + t.netPnl, 0) / winners.length 
            : 0;
        const avgLoss = losers.length > 0 
            ? losers.reduce((s, t) => s + t.netPnl, 0) / losers.length 
            : 0;
        
        // Time metrics
        const avgHoldingTime = trades.reduce((s, t) => s + (t.holdingTimeMs || 0), 0) / trades.length;
        
        // Win rate
        const winRate = winners.length / trades.length;
        
        // Profit factor
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
        
        // Returns for Sharpe calculation
        const returns = trades.map(t => t.returnPct || 0);
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        
        // Annualized Sharpe (assuming 15-min trades, ~35,000 per year)
        const tradesPerYear = 35040;
        const annualizedReturn = avgReturn * tradesPerYear;
        const annualizedStdDev = stdDev * Math.sqrt(tradesPerYear);
        const sharpeRatio = annualizedStdDev > 0 ? annualizedReturn / annualizedStdDev : 0;
        
        // Sortino (downside deviation)
        const negativeReturns = returns.filter(r => r < 0);
        const downsideVariance = negativeReturns.length > 0
            ? negativeReturns.reduce((s, r) => s + Math.pow(r, 2), 0) / negativeReturns.length
            : 0;
        const downsideStdDev = Math.sqrt(downsideVariance);
        const annualizedDownside = downsideStdDev * Math.sqrt(tradesPerYear);
        const sortinoRatio = annualizedDownside > 0 ? annualizedReturn / annualizedDownside : 0;
        
        // Max drawdown
        let peak = 0;
        let maxDrawdown = 0;
        let cumPnl = 0;
        for (const trade of trades) {
            cumPnl += trade.netPnl || 0;
            peak = Math.max(peak, cumPnl);
            maxDrawdown = Math.max(maxDrawdown, peak - cumPnl);
        }
        
        // Prediction accuracy (for expired trades)
        const resolvedTrades = trades.filter(t => t.windowOutcome !== null);
        const correctPredictions = resolvedTrades.filter(t => t.wasCorrect);
        const predictionAccuracy = resolvedTrades.length > 0 
            ? correctPredictions.length / resolvedTrades.length 
            : null;
        
        return {
            // Summary
            strategy: this.strategyName,
            period,
            tradeCount: trades.length,
            
            // Win/Loss
            winners: winners.length,
            losers: losers.length,
            winRate,
            
            // P&L
            grossPnl: totalGrossPnl,
            netPnl: totalNetPnl,
            totalFees,
            grossProfit,
            grossLoss,
            
            // Averages
            avgWin,
            avgLoss,
            avgTrade: totalNetPnl / trades.length,
            avgHoldingTimeMs: avgHoldingTime,
            avgHoldingTimeSec: avgHoldingTime / 1000,
            
            // Risk metrics
            profitFactor,
            sharpeRatio,
            sortinoRatio,
            maxDrawdown,
            maxDrawdownPct: peak > 0 ? maxDrawdown / peak : 0,
            
            // Prediction
            predictionAccuracy,
            resolvedTrades: resolvedTrades.length,
            
            // Returns
            avgReturnPct: avgReturn,
            returnStdDev: stdDev,
            
            // Capital efficiency
            capitalDeployed: trades.reduce((s, t) => s + t.capital, 0),
            returnOnCapital: totalNetPnl / trades.reduce((s, t) => s + t.capital, 0)
        };
    }
    
    parsePeriod(period) {
        const units = {
            'm': 60 * 1000,
            'h': 60 * 60 * 1000,
            'd': 24 * 60 * 60 * 1000
        };
        const match = period.match(/^(\d+)([mhd])$/);
        if (match) {
            return parseInt(match[1]) * units[match[2]];
        }
        return Infinity;
    }
    
    emptyMetrics() {
        return {
            strategy: this.strategyName,
            tradeCount: 0,
            winners: 0,
            losers: 0,
            winRate: 0,
            netPnl: 0,
            avgTrade: 0,
            sharpeRatio: 0
        };
    }
}

/**
 * Main Execution Tracker
 * 
 * Manages all trades across strategies and provides comparison metrics
 */
export class ExecutionTracker {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Track trades by strategy
        this.strategies = new Map();
        
        // All open positions
        this.openPositions = new Map();  // id -> TradeExecution
        
        // Trade history
        this.closedTrades = [];
        
        // Event callbacks
        this.onTradeOpen = config.onTradeOpen || (() => {});
        this.onTradeClose = config.onTradeClose || (() => {});
    }
    
    /**
     * Open a new trade
     */
    openTrade(params) {
        const trade = new TradeExecution({
            ...params,
            capital: params.capital || this.config.capitalPerTrade
        });
        
        // Register with strategy
        if (!this.strategies.has(trade.strategy)) {
            this.strategies.set(trade.strategy, new StrategyMetrics(trade.strategy));
        }
        
        // Track open position
        this.openPositions.set(trade.id, trade);
        
        // Callback
        this.onTradeOpen(trade);
        
        console.log(`📈 [${trade.strategy}] OPEN ${trade.side.toUpperCase()} ${trade.crypto}`);
        console.log(`   Capital: $${trade.capital} | Entry: ${trade.entryPrice.toFixed(4)} | Time: ${trade.timeRemainingAtEntry}s`);
        
        return trade;
    }
    
    /**
     * Close a trade by ID
     */
    closeTrade(tradeId, params) {
        const trade = this.openPositions.get(tradeId);
        if (!trade) {
            console.warn(`Trade ${tradeId} not found`);
            return null;
        }
        
        trade.close(params);
        
        // Move to closed
        this.openPositions.delete(tradeId);
        this.closedTrades.push(trade);
        
        // Add to strategy metrics
        this.strategies.get(trade.strategy).addTrade(trade);
        
        // Callback
        this.onTradeClose(trade);
        
        const pnlStr = trade.netPnl >= 0 ? `+$${trade.netPnl.toFixed(2)}` : `-$${Math.abs(trade.netPnl).toFixed(2)}`;
        const pctStr = (trade.returnPct * 100).toFixed(2);
        console.log(`📉 [${trade.strategy}] CLOSE ${trade.side.toUpperCase()} ${trade.crypto} | ${pnlStr} (${pctStr}%)`);
        console.log(`   Reason: ${trade.exitReason} | Held: ${(trade.holdingTimeMs / 1000).toFixed(1)}s`);
        
        return trade;
    }
    
    /**
     * Handle window expiry - close all positions for that window
     */
    handleWindowExpiry(crypto, windowEpoch, outcome, finalPrice) {
        const expiredTrades = [];
        
        for (const [id, trade] of this.openPositions) {
            if (trade.crypto === crypto && trade.windowEpoch === windowEpoch) {
                trade.expire({ outcome, finalPrice });
                
                this.openPositions.delete(id);
                this.closedTrades.push(trade);
                this.strategies.get(trade.strategy).addTrade(trade);
                
                expiredTrades.push(trade);
                
                const resultEmoji = trade.wasCorrect ? '✅' : '❌';
                const pnlStr = trade.netPnl >= 0 ? `+$${trade.netPnl.toFixed(2)}` : `-$${Math.abs(trade.netPnl).toFixed(2)}`;
                console.log(`🏁 [${trade.strategy}] EXPIRED ${resultEmoji} ${trade.crypto} | ${pnlStr}`);
            }
        }
        
        return expiredTrades;
    }
    
    /**
     * Get open positions for a strategy
     */
    getOpenPositions(strategy = null) {
        const positions = Array.from(this.openPositions.values());
        if (strategy) {
            return positions.filter(p => p.strategy === strategy);
        }
        return positions;
    }
    
    /**
     * Get metrics for a strategy
     */
    getStrategyMetrics(strategyName, period = 'all') {
        const strategy = this.strategies.get(strategyName);
        if (!strategy) {
            return new StrategyMetrics(strategyName).calculate();
        }
        return strategy.calculate(period);
    }
    
    /**
     * Compare all strategies
     */
    compareStrategies(period = 'all') {
        const comparison = {};
        
        for (const [name, strategy] of this.strategies) {
            comparison[name] = strategy.calculate(period);
        }
        
        return comparison;
    }
    
    /**
     * Get summary of current state
     */
    getSummary() {
        const openCount = this.openPositions.size;
        const closedCount = this.closedTrades.length;
        
        // Calculate total P&L
        const totalPnl = this.closedTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
        
        // Unrealized P&L would need current prices
        let unrealizedPnl = 0;
        for (const trade of this.openPositions.values()) {
            // Would need to pass current prices here
        }
        
        return {
            openPositions: openCount,
            closedTrades: closedCount,
            totalPnl,
            unrealizedPnl,
            strategies: Array.from(this.strategies.keys()),
            capitalPerTrade: this.config.capitalPerTrade
        };
    }
    
    /**
     * Export trade history
     */
    exportTrades() {
        return {
            config: this.config,
            openPositions: Array.from(this.openPositions.values()).map(t => t.toJSON()),
            closedTrades: this.closedTrades.map(t => t.toJSON()),
            strategies: this.compareStrategies()
        };
    }
}

// Singleton instance
let trackerInstance = null;

export function getExecutionTracker(config = {}) {
    if (!trackerInstance) {
        trackerInstance = new ExecutionTracker(config);
    }
    return trackerInstance;
}

export { TradeExecution, StrategyMetrics, DEFAULT_CONFIG };
export default ExecutionTracker;
