/**
 * Fair Value Deviation Strategy
 * 
 * Trades when market price deviates significantly from theoretical fair value.
 * 
 * Hypothesis: Market occasionally misprice probability relative to
 * what Black-Scholes style model predicts given spot price, volatility, and time.
 * 
 * Variants:
 * - FairValue_RealizedVol: Uses realized volatility
 * - FairValue_EWMA: Uses EWMA volatility (more responsive)
 * - FairValue_WithDrift: Incorporates momentum/drift
 */

import { FairValueCalculator } from '../fair_value.js';
import { VolatilityEstimator } from '../volatility.js';

export class FairValueStrategy {
    constructor(options = {}) {
        this.name = options.name || 'FairValue';
        this.options = {
            edgeThreshold: 0.03,       // Minimum 3% edge to trade
            strongEdgeThreshold: 0.06, // 6% = strong signal
            maxPosition: 100,          // Max position size
            // BINARY OPTIONS: Hold until window end, don't scalp
            useProfitTarget: false,    // Disabled - binary pays $1 or $0
            useStopLoss: false,        // Disabled - let position expire
            profitTarget: 0.15,        // Only if enabled: 15% (was 2%)
            stopLoss: 0.25,            // Only if enabled: 25% (was 4%)
            minTimeRemaining: 120,     // Don't enter with <2 min left
            exitTimeRemaining: 30,     // Exit with <30s left (let expire)
            volType: 'realized',       // 'realized', 'ewma', 'parkinson'
            useDrift: false,           // Whether to incorporate drift
            ...options
        };
        
        this.fairValueCalc = new FairValueCalculator({
            edgeThreshold: this.options.edgeThreshold
        });
        this.volEstimator = new VolatilityEstimator();
        
        // State
        this.positions = {};  // crypto -> position
        this.signals = [];
        this.stats = {
            totalSignals: 0,
            buySignals: 0,
            sellSignals: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    /**
     * Process tick and generate signal
     */
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        // Update volatility estimator
        this.volEstimator.update(tick);
        
        // Get volatility estimate based on type
        const vols = this.volEstimator.getVolatilities(crypto);
        let vol;
        if (this.options.volType === 'ewma' && vols?.spot_ewma) {
            vol = vols.spot_ewma;
        } else if (this.options.volType === 'parkinson' && vols?.parkinson) {
            vol = vols.parkinson;
        } else {
            vol = vols?.spot_realized_30 || 0.8;
        }
        
        // Calculate fair value and edge
        const analysis = this.fairValueCalc.analyze(tick, vol);
        
        // Time-based exit
        if (position && tick.time_remaining_sec < this.options.exitTimeRemaining) {
            return this.createSignal('sell', null, 'time_exit', analysis);
        }
        
        // Position management - BINARY OPTIONS should generally HOLD until expiry
        if (position) {
            // Only check P&L exits if explicitly enabled (not recommended for binary)
            if (this.options.useProfitTarget || this.options.useStopLoss) {
                const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
                const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
                
                if (this.options.useProfitTarget && pnl >= this.options.profitTarget) {
                    return this.createSignal('sell', null, 'profit_target', analysis);
                }
                if (this.options.useStopLoss && pnl <= -this.options.stopLoss) {
                    return this.createSignal('sell', null, 'stop_loss', analysis);
                }
            }
            
            // HOLD position - let it expire at window end for binary payout
            return this.createSignal('hold', null, 'holding_for_expiry', analysis);
        }
        
        // Entry logic
        if (tick.time_remaining_sec < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // Check for significant edge
        if (analysis.isSignificant) {
            const isStrong = Math.abs(analysis.edge) >= this.options.strongEdgeThreshold;
            const size = isStrong ? this.options.maxPosition : this.options.maxPosition * 0.7;
            
            this.stats.totalSignals++;
            this.stats.buySignals++;
            
            return this.createSignal('buy', analysis.side, 'fair_value_edge', analysis, size);
        }
        
        return this.createSignal('hold', null, null, analysis);
    }
    
    /**
     * Create standardized signal object
     */
    createSignal(action, side, reason, analysis, size = null) {
        return {
            action,
            side,
            reason,
            size: size || this.options.maxPosition,
            confidence: analysis?.confidence || 0,
            
            // Analysis data
            fairProb: analysis?.fairProb,
            marketProb: analysis?.marketProb,
            edge: analysis?.edge,
            edgePct: analysis?.edgePct,
            realizedVol: analysis?.realizedVol,
            impliedVol: analysis?.impliedVol
        };
    }
    
    /**
     * Check risk limits for open position
     */
    checkRiskLimits(tick, position) {
        if (!position) return null;
        
        // Time-based exit
        if (tick.time_remaining_sec < this.options.exitTimeRemaining) {
            return { action: 'sell', reason: 'time_exit' };
        }
        
        // P&L based exits
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
    
    /**
     * Window lifecycle hooks
     */
    onWindowStart(windowInfo) {
        // Reset for new window
    }
    
    onWindowEnd(windowInfo, outcome) {
        // Log outcome for analysis
    }
    
    /**
     * Get strategy stats
     */
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

// Factory functions for variants
export function createFairValueRealizedVol(capital = 100) {
    return new FairValueStrategy({
        name: 'FairValue_RealizedVol',
        volType: 'realized',
        maxPosition: capital
    });
}

export function createFairValueEWMA(capital = 100) {
    return new FairValueStrategy({
        name: 'FairValue_EWMA',
        volType: 'ewma',
        maxPosition: capital
    });
}

export function createFairValueWithDrift(capital = 100) {
    return new FairValueStrategy({
        name: 'FairValue_WithDrift',
        volType: 'realized',
        useDrift: true,
        maxPosition: capital
    });
}

export default FairValueStrategy;
