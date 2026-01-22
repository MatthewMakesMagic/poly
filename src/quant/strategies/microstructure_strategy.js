/**
 * Microstructure Strategy
 * 
 * Uses order book dynamics and spread information for signals.
 * 
 * Hypothesis: Order flow imbalance and spread dynamics contain
 * information about near-term price direction.
 * 
 * Signals:
 * 1. Book imbalance (bid size >> ask size suggests buying pressure)
 * 2. Spread dynamics (widening spread often precedes moves)
 * 3. Microprice divergence from mid-price
 */

export class MicrostructureStrategy {
    constructor(options = {}) {
        this.name = options.name || 'Microstructure';
        this.options = {
            // Imbalance thresholds
            imbalanceThreshold: 0.3,     // 30% imbalance to trigger
            strongImbalanceThreshold: 0.5, // 50% = strong signal
            
            // Spread thresholds
            spreadZscoreThreshold: 2.0,  // 2 std devs above normal
            
            // Price confirmation
            priceConfirmThreshold: 0.48, // Must not be extreme already
            
            maxPosition: 100,
            // Smart exits - hold unless extreme conditions
            maxDrawdown: 0.30,
            minTimeRemaining: 180,       // Need 3+ min for micro signals
            exitTimeRemaining: 60,
            
            ...options
        };
        
        // State
        this.state = {};
        this.stats = {
            totalSignals: 0,
            imbalanceSignals: 0,
            spreadSignals: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spreads: [],
                imbalances: [],
                volumes: []
            };
        }
        return this.state[crypto];
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        const marketProb = tick.up_mid || 0.5;
        const timeRemaining = tick.time_remaining_sec || 0;
        const bidSize = tick.up_bid_size || 0;
        const askSize = tick.up_ask_size || 0;
        const spread = tick.spread || (tick.up_ask - tick.up_bid) || 0;
        
        // Calculate imbalance
        const totalSize = bidSize + askSize;
        const imbalance = totalSize > 0 ? (bidSize - askSize) / totalSize : 0;
        
        // Update history
        state.spreads.push(spread);
        state.imbalances.push(imbalance);
        if (state.spreads.length > 30) state.spreads.shift();
        if (state.imbalances.length > 30) state.imbalances.shift();
        
        // Calculate spread z-score
        const avgSpread = state.spreads.reduce((a, b) => a + b, 0) / state.spreads.length;
        const spreadVariance = state.spreads.reduce((sum, s) => sum + Math.pow(s - avgSpread, 2), 0) / state.spreads.length;
        const spreadStd = Math.sqrt(spreadVariance);
        const spreadZscore = spreadStd > 0 ? (spread - avgSpread) / spreadStd : 0;
        
        // Calculate microprice
        const microprice = totalSize > 0 
            ? (tick.up_bid * askSize + tick.up_ask * bidSize) / totalSize 
            : marketProb;
        const microDivergence = microprice - marketProb;
        
        const analysis = {
            imbalance,
            spreadZscore,
            microprice,
            microDivergence,
            avgSpread,
            bidSize,
            askSize
        };
        
        // Time-based exit
        if (position && timeRemaining < this.options.exitTimeRemaining) {
            return this.createSignal('sell', null, 'time_exit', analysis);
        }
        
        // Smart position management
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Exit on extreme drawdown
            if (pnlPct <= -this.options.maxDrawdown) {
                return this.createSignal('sell', null, 'max_drawdown', analysis);
            }
            
            return this.createSignal('hold', null, 'holding_with_edge', analysis);
        }
        
        // Entry logic
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // Need enough history
        if (state.spreads.length < 10) {
            return this.createSignal('hold', null, 'insufficient_data', analysis);
        }
        
        // Signal 1: Strong book imbalance with spread widening
        if (Math.abs(imbalance) >= this.options.imbalanceThreshold && 
            spreadZscore >= this.options.spreadZscoreThreshold) {
            
            // Imbalance direction
            const side = imbalance > 0 ? 'up' : 'down';
            
            // Confirm price isn't already extreme
            const priceConfirm = side === 'up' 
                ? marketProb < (1 - this.options.priceConfirmThreshold)
                : marketProb > this.options.priceConfirmThreshold;
            
            if (priceConfirm) {
                this.stats.totalSignals++;
                this.stats.imbalanceSignals++;
                
                return this.createSignal('buy', side, 'imbalance_spread', analysis);
            }
        }
        
        // Signal 2: Strong imbalance alone
        if (Math.abs(imbalance) >= this.options.strongImbalanceThreshold) {
            const side = imbalance > 0 ? 'up' : 'down';
            
            const priceConfirm = side === 'up' 
                ? marketProb < (1 - this.options.priceConfirmThreshold)
                : marketProb > this.options.priceConfirmThreshold;
            
            if (priceConfirm) {
                this.stats.totalSignals++;
                this.stats.imbalanceSignals++;
                
                return this.createSignal('buy', side, 'strong_imbalance', analysis);
            }
        }
        
        return this.createSignal('hold', null, null, analysis);
    }
    
    createSignal(action, side, reason, analysis) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            confidence: Math.abs(analysis?.imbalance || 0),
            imbalance: analysis?.imbalance,
            spreadZscore: analysis?.spreadZscore,
            microprice: analysis?.microprice,
            microDivergence: analysis?.microDivergence
        };
    }
    
    checkRiskLimits(tick, position) {
        if (!position) return null;
        
        if (tick.time_remaining_sec < this.options.exitTimeRemaining) {
            return { action: 'sell', reason: 'time_exit' };
        }
        
        const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
        const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
        
        if (pnl >= this.options.profitTarget) {
            return { action: 'sell', reason: 'profit_target' };
        }
        if (pnl <= -this.options.stopLoss) {
            return { action: 'sell', reason: 'stop_loss' };
        }
        
        return null;
    }
    
    onWindowStart(windowInfo) {
        const state = this.state[windowInfo.crypto];
        if (state) {
            state.spreads = [];
            state.imbalances = [];
        }
    }
    
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

export default MicrostructureStrategy;
