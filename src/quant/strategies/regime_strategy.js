/**
 * Regime-Conditional Strategy
 * 
 * Applies different sub-strategies based on detected market regime.
 * 
 * Regimes:
 * - MOMENTUM_FAVORABLE: Use momentum/trend following
 * - MEAN_REVERSION_FAVORABLE: Use mean reversion
 * - CHOPPY_AVOID: Reduce exposure
 * - NEUTRAL: Balanced approach
 */

import { RegimeDetector } from '../regime_detector.js';
import { FairValueCalculator } from '../fair_value.js';
import { VolatilityEstimator } from '../volatility.js';

export class RegimeStrategy {
    constructor(options = {}) {
        this.name = options.name || 'Regime';
        this.options = {
            // Size multipliers by regime
            regimeSizing: {
                'MOMENTUM_FAVORABLE': 1.0,
                'MEAN_REVERSION_FAVORABLE': 1.0,
                'TREND_FOLLOWING': 0.8,
                'CHOPPY_AVOID': 0.3,
                'CAUTION_THIN_LIQUIDITY': 0.5,
                'NEUTRAL': 0.7
            },
            
            // Momentum regime settings
            momentumThreshold: 0.55,
            
            // Mean reversion settings
            reversionThreshold: 0.15,  // Deviation from 0.5
            
            maxPosition: 100,
            // Binary options: HOLD to expiry
            // DISABLED edge reversal - fair value too noisy
            maxDrawdown: 0.30,  // Only exit on extreme loss
            minTimeRemaining: 120,
            exitTimeRemaining: 5,  // Let binary expire
            
            ...options
        };
        
        this.regimeDetector = new RegimeDetector();
        this.fairValueCalc = new FairValueCalculator();
        this.volEstimator = new VolatilityEstimator();
        
        this.stats = {
            totalSignals: 0,
            signalsByRegime: {}
        };
    }
    
    getName() {
        return this.name;
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const marketProb = tick.up_mid || 0.5;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Update detectors
        this.regimeDetector.update(tick);
        this.volEstimator.update(tick);
        
        // Detect regime
        const regime = this.regimeDetector.detectRegime(crypto);
        const vol = this.volEstimator.getBestEstimate(crypto);
        const fairValueAnalysis = this.fairValueCalc.analyze(tick, vol);
        
        // Get size multiplier for regime
        const sizeMultiplier = this.options.regimeSizing[regime.combined] || 0.7;
        const adjustedSize = this.options.maxPosition * sizeMultiplier;
        
        const analysis = {
            regime,
            fairValue: fairValueAnalysis,
            sizeMultiplier,
            adjustedSize
        };
        
        // Time-based exit
        if (position && timeRemaining < this.options.exitTimeRemaining) {
            return this.createSignal('sell', null, 'time_exit', analysis);
        }
        
        // Smart position management for BINARY OPTIONS
        // Key insight: Hold to expiry unless extreme conditions
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            const holdingTime = Date.now() - position.entryTime;
            
            // DISABLE edge reversal exit - it causes churning due to fair value noise
            // Fair value swings 18% on a 0.1% spot move, causing constant flip-flops
            // Instead, hold to expiry and let the binary resolve
            
            // Exit on extreme drawdown only (>30% loss = something very wrong)
            if (pnlPct <= -this.options.maxDrawdown) {
                return this.createSignal('sell', null, 'max_drawdown', analysis);
            }
            
            // HOLD for binary expiry
            return this.createSignal('hold', null, 'holding_for_expiry', analysis);
        }
        
        // Entry logic
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // Avoid choppy regimes
        if (regime.combined === 'CHOPPY_AVOID') {
            return this.createSignal('hold', null, 'avoid_choppy', analysis);
        }
        
        // Regime-specific logic
        let signal = null;
        
        if (regime.combined === 'MOMENTUM_FAVORABLE' || regime.combined === 'TREND_FOLLOWING') {
            signal = this.momentumLogic(tick, regime, analysis);
        } else if (regime.combined === 'MEAN_REVERSION_FAVORABLE') {
            signal = this.meanReversionLogic(tick, regime, analysis);
        } else {
            // Neutral - use fair value edge
            signal = this.neutralLogic(tick, fairValueAnalysis, analysis);
        }
        
        if (signal && signal.action === 'buy') {
            this.stats.totalSignals++;
            this.stats.signalsByRegime[regime.combined] = 
                (this.stats.signalsByRegime[regime.combined] || 0) + 1;
        }
        
        return signal || this.createSignal('hold', null, null, analysis);
    }
    
    /**
     * Momentum logic for trending regimes
     */
    momentumLogic(tick, regime, analysis) {
        const marketProb = tick.up_mid || 0.5;
        const trendDirection = regime.trend?.direction;
        
        // Follow the trend
        if (trendDirection === 'up' && marketProb >= this.options.momentumThreshold) {
            return this.createSignal('buy', 'up', 'momentum_up', analysis);
        }
        
        if (trendDirection === 'down' && marketProb <= (1 - this.options.momentumThreshold)) {
            return this.createSignal('buy', 'down', 'momentum_down', analysis);
        }
        
        return null;
    }
    
    /**
     * Mean reversion logic for ranging regimes
     */
    meanReversionLogic(tick, regime, analysis) {
        const marketProb = tick.up_mid || 0.5;
        const deviation = marketProb - 0.5;
        
        // Fade extreme moves
        if (deviation > this.options.reversionThreshold) {
            return this.createSignal('buy', 'down', 'reversion_fade_high', analysis);
        }
        
        if (deviation < -this.options.reversionThreshold) {
            return this.createSignal('buy', 'up', 'reversion_fade_low', analysis);
        }
        
        return null;
    }
    
    /**
     * Neutral regime - use fair value edge
     */
    neutralLogic(tick, fairValueAnalysis, analysis) {
        if (fairValueAnalysis?.isSignificant) {
            return this.createSignal('buy', fairValueAnalysis.side, 'fair_value_edge', analysis);
        }
        
        return null;
    }
    
    createSignal(action, side, reason, analysis) {
        return {
            action,
            side,
            reason,
            size: analysis?.adjustedSize || this.options.maxPosition,
            confidence: Math.abs(analysis?.fairValue?.edge || 0) / 0.1,
            regime: analysis?.regime?.combined,
            regimeVolatility: analysis?.regime?.volatility?.regime,
            regimeTrend: analysis?.regime?.trend?.regime,
            sizeMultiplier: analysis?.sizeMultiplier
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
    
    onWindowStart(windowInfo) {}
    
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

export default RegimeStrategy;
