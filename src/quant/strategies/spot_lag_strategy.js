/**
 * Spot Lead-Lag Strategy
 * 
 * Trades when market hasn't fully priced a spot price movement.
 * 
 * Hypothesis: Market reacts slowly to spot movements, creating
 * a window of opportunity to trade before prices catch up.
 * 
 * Variants:
 * - SpotLag_1s: Very fast reaction (1 second lookback)
 * - SpotLag_5s: Medium reaction (5 second lookback)
 * - SpotLag_10s: Slower, more confirmed moves
 */

import { SpotLagAnalyzer } from '../spot_lag_analyzer.js';
import { VolatilityEstimator } from '../volatility.js';

export class SpotLagStrategy {
    constructor(options = {}) {
        this.name = options.name || 'SpotLag';
        this.options = {
            lookbackSec: 5,            // Lookback window for spot change
            lagThreshold: 0.03,        // Minimum 3% probability lag
            spotChangeThreshold: 0.0003, // Minimum 0.03% spot move
            maxPosition: 100,
            
            // SCALP STRATEGY - capture lag and get out fast
            // Lag resolves in ~3.5 seconds, so don't hold long!
            maxHoldingMs: 15000,       // Exit after 15 seconds max (lag should resolve by then)
            profitTarget: 0.03,        // Exit at 3% profit (captured the lag)
            stopLoss: 0.05,            // Exit at 5% loss (lag didn't materialize)
            
            minTimeRemaining: 120,     // Need time for lag to resolve
            exitTimeRemaining: 60,     // Don't hold into final minute
            confirmationTicks: 2,      // Wait for N ticks of confirmation
            ...options
        };
        
        this.lagAnalyzer = new SpotLagAnalyzer({
            spotChangeThreshold: this.options.spotChangeThreshold
        });
        this.volEstimator = new VolatilityEstimator();
        
        // State per crypto
        this.state = {};
        this.stats = {
            totalSignals: 0,
            buySignals: 0,
            lagEvents: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    /**
     * Initialize state for crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],
                marketProbHistory: [],
                timestamps: [],
                pendingSignal: null,
                confirmationCount: 0
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Process tick and generate signal
     */
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        // Update estimators
        this.volEstimator.update(tick);
        const vol = this.volEstimator.getBestEstimate(crypto);
        this.lagAnalyzer.processTick(tick, vol);
        
        // Update history
        const spotPrice = tick.spot_price;
        const marketProb = tick.up_mid || 0.5;
        const timestamp = tick.timestamp || Date.now();
        
        state.spotHistory.push(spotPrice);
        state.marketProbHistory.push(marketProb);
        state.timestamps.push(timestamp);
        
        // Trim history
        const maxLen = Math.max(30, this.options.lookbackSec * 2);
        if (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketProbHistory.shift();
            state.timestamps.shift();
        }
        
        // SCALP POSITION MANAGEMENT
        // Lag resolves in ~3.5 seconds - get in, capture the move, get out
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            const holdingTime = Date.now() - position.entryTime;
            
            // 1. PROFIT TARGET - captured the lag, exit with profit
            if (pnlPct >= this.options.profitTarget) {
                return this.createSignal('sell', null, 'profit_target', { pnlPct, holdingTime });
            }
            
            // 2. STOP LOSS - lag didn't materialize, cut losses
            if (pnlPct <= -this.options.stopLoss) {
                return this.createSignal('sell', null, 'stop_loss', { pnlPct, holdingTime });
            }
            
            // 3. MAX HOLDING TIME - lag should resolve in ~3.5s, exit if held too long
            if (holdingTime > this.options.maxHoldingMs) {
                return this.createSignal('sell', null, 'max_holding_time', { pnlPct, holdingTime });
            }
            
            // 4. TIME EXIT - don't hold into final minute
            if (tick.time_remaining_sec < this.options.exitTimeRemaining) {
                return this.createSignal('sell', null, 'time_exit', { pnlPct, holdingTime });
            }
            
            // Still waiting for lag to resolve
            return this.createSignal('hold', null, 'waiting_for_lag', { pnlPct, holdingTime });
        }
        
        // Entry logic
        if (tick.time_remaining_sec < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', {});
        }
        
        // Get lag signal
        const lagSignal = this.lagAnalyzer.getLagSignal(crypto, tick, vol);
        
        if (!lagSignal) {
            return this.createSignal('hold', null, null, {});
        }
        
        // Check for tradeable lag
        if (lagSignal.signal === 'BUY' && lagSignal.strength > 0.5) {
            // Confirmation logic
            if (state.pendingSignal?.side === lagSignal.side) {
                state.confirmationCount++;
            } else {
                state.pendingSignal = lagSignal;
                state.confirmationCount = 1;
            }
            
            // Execute after confirmation
            if (state.confirmationCount >= this.options.confirmationTicks) {
                state.pendingSignal = null;
                state.confirmationCount = 0;
                
                this.stats.totalSignals++;
                this.stats.buySignals++;
                this.stats.lagEvents++;
                
                return this.createSignal('buy', lagSignal.side, 'spot_lag', lagSignal);
            }
        } else {
            state.pendingSignal = null;
            state.confirmationCount = 0;
        }
        
        return this.createSignal('hold', null, null, lagSignal);
    }
    
    /**
     * Create standardized signal
     */
    createSignal(action, side, reason, lagSignal) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            confidence: lagSignal?.strength || 0,
            
            // Lag analysis data
            lag: lagSignal?.lag,
            lagPct: lagSignal?.lagPct,
            spotMomentum: lagSignal?.spotMomentum,
            fairProb: lagSignal?.fairProb,
            marketProb: lagSignal?.marketProb
        };
    }
    
    /**
     * Check risk limits
     */
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
            state.spotHistory = [];
            state.marketProbHistory = [];
            state.timestamps = [];
            state.pendingSignal = null;
            state.confirmationCount = 0;
        }
    }
    
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return {
            name: this.name,
            ...this.stats,
            lagReport: this.lagAnalyzer.getReport()
        };
    }
}

// Factory functions for variants
export function createSpotLag1s(capital = 100) {
    return new SpotLagStrategy({
        name: 'SpotLag_1s',
        lookbackSec: 1,
        confirmationTicks: 1,
        maxPosition: capital
    });
}

export function createSpotLag5s(capital = 100) {
    return new SpotLagStrategy({
        name: 'SpotLag_5s',
        lookbackSec: 5,
        confirmationTicks: 2,
        maxPosition: capital
    });
}

export function createSpotLag10s(capital = 100) {
    return new SpotLagStrategy({
        name: 'SpotLag_10s',
        lookbackSec: 10,
        confirmationTicks: 3,
        maxPosition: capital
    });
}

export default SpotLagStrategy;
