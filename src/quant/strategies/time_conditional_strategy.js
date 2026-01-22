/**
 * Time-Conditional Strategy
 * 
 * Different trading behavior based on window phase.
 * 
 * Hypothesis: Market efficiency varies through the 15-minute window.
 * - Early (>10 min): High uncertainty, fade extreme moves
 * - Mid (3-10 min): Trends establish, follow momentum
 * - Late (<3 min): Outcome becoming certain, only extreme mispricings
 */

import { FairValueCalculator } from '../fair_value.js';
import { VolatilityEstimator } from '../volatility.js';

export class TimeConditionalStrategy {
    constructor(options = {}) {
        this.name = options.name || 'TimeConditional';
        this.options = {
            // Phase boundaries (seconds remaining)
            earlyPhaseMin: 600,    // >10 min = early
            midPhaseMin: 180,      // 3-10 min = mid
            latePhaseMin: 60,      // 1-3 min = late
            
            // Early phase: Fade extreme moves (mean reversion)
            earlyFadeThreshold: 0.15,  // Fade if prob > 0.65 or < 0.35
            
            // Mid phase: Follow trends
            midTrendThreshold: 0.55,   // Follow if prob > 0.55 or < 0.45
            midMomentumConfirm: true,  // Require momentum confirmation
            
            // Late phase: Only extreme edges
            lateEdgeThreshold: 0.10,   // 10% edge required
            
            maxPosition: 100,
            // BINARY OPTIONS: Hold until expiry
            useProfitTarget: false,
            useStopLoss: false,
            profitTarget: 0.15,
            stopLoss: 0.25,
            
            ...options
        };
        
        this.fairValueCalc = new FairValueCalculator();
        this.volEstimator = new VolatilityEstimator();
        
        // State
        this.state = {};
        this.stats = {
            totalSignals: 0,
            earlySignals: 0,
            midSignals: 0,
            lateSignals: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                priceHistory: [],
                spotHistory: [],
                phase: null
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Determine current phase
     */
    getPhase(timeRemaining) {
        if (timeRemaining > this.options.earlyPhaseMin) {
            return 'early';
        } else if (timeRemaining > this.options.midPhaseMin) {
            return 'mid';
        } else if (timeRemaining > this.options.latePhaseMin) {
            return 'late';
        } else {
            return 'exit';  // Too close to resolution
        }
    }
    
    /**
     * Process tick
     */
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        // Update estimators
        this.volEstimator.update(tick);
        const vol = this.volEstimator.getBestEstimate(crypto);
        
        const marketProb = tick.up_mid || 0.5;
        const timeRemaining = tick.time_remaining_sec || 0;
        const phase = this.getPhase(timeRemaining);
        
        // Update history
        state.priceHistory.push(marketProb);
        if (tick.spot_price) state.spotHistory.push(tick.spot_price);
        if (state.priceHistory.length > 30) state.priceHistory.shift();
        if (state.spotHistory.length > 30) state.spotHistory.shift();
        
        state.phase = phase;
        
        // Fair value analysis
        const analysis = this.fairValueCalc.analyze(tick, vol);
        
        // Exit phase - close any positions
        if (phase === 'exit') {
            if (position) {
                return this.createSignal('sell', null, 'exit_phase', { phase, analysis });
            }
            return this.createSignal('hold', null, 'exit_phase', { phase, analysis });
        }
        
        // Position management - BINARY OPTIONS hold until expiry
        if (position) {
            if (this.options.useProfitTarget || this.options.useStopLoss) {
                const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
                const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
                
                if (this.options.useProfitTarget && pnl >= this.options.profitTarget) {
                    return this.createSignal('sell', null, 'profit_target', { phase, analysis });
                }
                if (this.options.useStopLoss && pnl <= -this.options.stopLoss) {
                    return this.createSignal('sell', null, 'stop_loss', { phase, analysis });
                }
            }
            return this.createSignal('hold', null, 'holding_for_expiry', { phase, analysis });
        }
        
        // Phase-specific entry logic
        let signal = null;
        
        if (phase === 'early') {
            signal = this.earlyPhaseLogic(tick, state, analysis);
        } else if (phase === 'mid') {
            signal = this.midPhaseLogic(tick, state, analysis);
        } else if (phase === 'late') {
            signal = this.latePhaseLogic(tick, state, analysis);
        }
        
        if (signal && signal.action === 'buy') {
            this.stats.totalSignals++;
            if (phase === 'early') this.stats.earlySignals++;
            if (phase === 'mid') this.stats.midSignals++;
            if (phase === 'late') this.stats.lateSignals++;
        }
        
        return signal || this.createSignal('hold', null, null, { phase, analysis });
    }
    
    /**
     * Early phase: Fade extreme moves (mean reversion)
     */
    earlyPhaseLogic(tick, state, analysis) {
        const marketProb = tick.up_mid || 0.5;
        
        // Fade if market has moved too far from 50%
        if (marketProb > (1 - this.options.earlyFadeThreshold)) {
            // Market very bullish early - fade it
            return this.createSignal('buy', 'down', 'early_fade_high', {
                phase: 'early',
                analysis,
                fadeLevel: marketProb
            });
        }
        
        if (marketProb < this.options.earlyFadeThreshold) {
            // Market very bearish early - fade it
            return this.createSignal('buy', 'up', 'early_fade_low', {
                phase: 'early',
                analysis,
                fadeLevel: marketProb
            });
        }
        
        return null;
    }
    
    /**
     * Mid phase: Follow established trends
     */
    midPhaseLogic(tick, state, analysis) {
        const marketProb = tick.up_mid || 0.5;
        
        // Check for momentum confirmation if required
        let momentumConfirmed = true;
        if (this.options.midMomentumConfirm && state.priceHistory.length >= 5) {
            const recent = state.priceHistory.slice(-5);
            const momentum = recent[recent.length - 1] - recent[0];
            
            // Momentum should align with direction we're considering
            if (marketProb > 0.5 && momentum < 0) momentumConfirmed = false;
            if (marketProb < 0.5 && momentum > 0) momentumConfirmed = false;
        }
        
        if (!momentumConfirmed) {
            return null;
        }
        
        // Follow trend if established
        if (marketProb >= this.options.midTrendThreshold) {
            return this.createSignal('buy', 'up', 'mid_trend_up', {
                phase: 'mid',
                analysis,
                trendLevel: marketProb
            });
        }
        
        if (marketProb <= (1 - this.options.midTrendThreshold)) {
            return this.createSignal('buy', 'down', 'mid_trend_down', {
                phase: 'mid',
                analysis,
                trendLevel: marketProb
            });
        }
        
        return null;
    }
    
    /**
     * Late phase: Only trade extreme mispricings
     */
    latePhaseLogic(tick, state, analysis) {
        // Only trade if there's a large edge vs fair value
        if (!analysis || !analysis.isSignificant) {
            return null;
        }
        
        if (Math.abs(analysis.edge) >= this.options.lateEdgeThreshold) {
            return this.createSignal('buy', analysis.side, 'late_edge', {
                phase: 'late',
                analysis,
                edge: analysis.edge
            });
        }
        
        return null;
    }
    
    createSignal(action, side, reason, data) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            confidence: data?.analysis?.confidence || 0,
            phase: data?.phase,
            fairProb: data?.analysis?.fairProb,
            marketProb: data?.analysis?.marketProb,
            edge: data?.analysis?.edge
        };
    }
    
    checkRiskLimits(tick, position) {
        if (!position) return null;
        
        const phase = this.getPhase(tick.time_remaining_sec);
        if (phase === 'exit') {
            return { action: 'sell', reason: 'exit_phase' };
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
            state.priceHistory = [];
            state.spotHistory = [];
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

export default TimeConditionalStrategy;
