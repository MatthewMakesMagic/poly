/**
 * Strategy Base Class
 * 
 * All trading strategies should extend this class
 */

export class Strategy {
    constructor(name, params = {}) {
        this.name = name;
        this.params = {
            maxPosition: 100,       // Max $ per position
            stopLoss: 0.10,         // 10% stop loss
            takeProfit: 0.05,       // 5% take profit
            maxDailyLoss: 500,      // Daily loss limit
            ...params
        };
        
        // State
        this.position = null;
        this.dailyPnL = 0;
        this.trades = [];
    }
    
    /**
     * Called on each tick - override in subclass
     * 
     * @param {Object} tick - Current market tick
     * @param {Object} position - Current position (or null)
     * @param {Object} context - Additional context (history, etc.)
     * @returns {Object} - { action: 'buy'|'sell'|'hold', side: 'up'|'down', size: number }
     */
    onTick(tick, position, context) {
        return { action: 'hold' };
    }
    
    /**
     * Called at start of each window - override in subclass
     */
    onWindowStart(windowInfo) {
        // Reset window-specific state
    }
    
    /**
     * Called at end of each window - override in subclass
     */
    onWindowEnd(windowInfo, outcome) {
        // Handle window resolution
    }
    
    /**
     * Check if position should be closed due to risk limits
     */
    checkRiskLimits(tick, position) {
        if (!position) return false;
        
        const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
        const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
        
        // Stop loss
        if (pnlPct <= -this.params.stopLoss) {
            return { action: 'close', reason: 'stop_loss' };
        }
        
        // Take profit
        if (pnlPct >= this.params.takeProfit) {
            return { action: 'close', reason: 'take_profit' };
        }
        
        // Daily loss limit
        if (this.dailyPnL <= -this.params.maxDailyLoss) {
            return { action: 'close', reason: 'daily_loss_limit' };
        }
        
        return false;
    }
    
    /**
     * Reset daily P&L (call at start of each day)
     */
    resetDaily() {
        this.dailyPnL = 0;
    }
    
    /**
     * Get strategy parameters
     */
    getParams() {
        return this.params;
    }
    
    /**
     * Get strategy name
     */
    getName() {
        return this.name;
    }
}

export default Strategy;

