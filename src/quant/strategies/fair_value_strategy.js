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
            edgeThreshold: 0.03,       // Minimum 3% edge to enter
            strongEdgeThreshold: 0.06, // 6% = strong signal
            maxPosition: 100,          // Max position size
            
            // EXIT RULES: Hold to expiry for binary payout
            // DISABLED edge reversal - fair value too noisy (0.1% spot = 18% prob swing)
            // Only exit on extreme drawdown
            
            // Risk management (extreme moves only)
            maxDrawdown: 0.30,         // Exit if down >30% (something very wrong)
            useTrailingStop: false,    // Optional: lock in gains
            trailingStopActivation: 0.20, // Activate trailing after 20% gain
            trailingStopDistance: 0.10,   // Trail by 10%
            
            // Time-based rules
            minTimeRemaining: 120,     // Don't enter with <2 min left
            exitTimeRemaining: 30,     // Exit with <30s left (let binary expire)
            
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
        
        // BINARY OPTIONS: NO TIME-BASED EXIT
        // Let positions expire naturally at window end for $1 or $0 payout
        // Early exits just pay spread twice and lose money
        
        // BINARY OPTIONS POSITION MANAGEMENT
        // Key learning: Fair value is TOO NOISY for exit signals
        // A 0.1% spot move causes 18% fair value swing = constant flip-flops
        // Solution: HOLD to expiry, only exit on extreme drawdown
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // DISABLED: Edge reversal exit - causes churning
            // Fair value swings wildly on small spot moves
            
            // EXIT only on extreme drawdown (>30% loss = cut losses)
            if (pnlPct <= -this.options.maxDrawdown) {
                return this.createSignal('sell', null, 'max_drawdown', analysis);
            }
            
            // HOLD for binary expiry - let the $1/$0 payout resolve
            return this.createSignal('hold', null, 'holding_for_expiry', analysis);
        }
        
        // Entry logic
        if (tick.time_remaining_sec < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // VARIANT DIFFERENTIATION:
        // - RealizedVol (default): Standard fair value edge
        // - EWMA: More responsive vol, use tighter threshold
        // - WithDrift: Also require spot momentum confirmation
        
        let effectiveThreshold = this.options.edgeThreshold;
        let additionalCheck = true;
        
        // EWMA variant: More responsive, use tighter threshold (2.5% vs 3%)
        if (this.options.volType === 'ewma') {
            effectiveThreshold = this.options.edgeThreshold * 0.85;  // 2.55% threshold
        }
        
        // WithDrift variant: Require spot momentum confirmation
        if (this.options.useDrift) {
            // Only enter if spot is moving in the direction of our trade
            const spotMove = tick.spot_delta_pct || 0;
            const spotDirection = spotMove > 0 ? 'up' : 'down';
            // Require spot to be moving in same direction OR flat
            additionalCheck = !analysis.side || spotDirection === analysis.side || Math.abs(spotMove) < 0.0001;
        }
        
        // Check for significant edge (with variant-specific threshold)
        const hasEdge = Math.abs(analysis.edge || 0) >= effectiveThreshold;
        
        if (hasEdge && additionalCheck) {
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

// ================================================================
// DRIFT-AWARE FAIR VALUE STRATEGIES
// 
// Key insight: FairValue makes money on UP bets, loses on DOWN bets
// Hypothesis: Crypto has positive drift that Black-Scholes (drift=0) misses
// 
// These variants:
// 1. Calculate rolling drift over different timeframes
// 2. Only trade in direction of drift
// 3. Feed drift into Black-Scholes for better fair value
// ================================================================

/**
 * Drift-Aware Fair Value Strategy
 * 
 * Calculates rolling drift and:
 * - Only takes UP bets when drift is positive
 * - Only takes DOWN bets when drift is negative
 * - Uses drift in Black-Scholes calculation for more accurate fair value
 */
export class DriftAwareFairValueStrategy extends FairValueStrategy {
    constructor(options = {}) {
        super({
            name: options.name || 'FairValue_DriftAware',
            ...options
        });
        
        // Drift calculation settings
        this.driftLookbackMs = options.driftLookbackMs || 3600000; // 1 hour default
        this.minDriftMagnitude = options.minDriftMagnitude || 0.002; // 0.2% min drift (meaningful for crypto)
        this.requireDriftAlignment = options.requireDriftAlignment !== false; // Default true
        
        // Price history for drift calculation
        this.priceHistory = {}; // crypto -> [{timestamp, price}]
    }
    
    /**
     * Calculate annualized drift from recent price history
     */
    calculateDrift(crypto) {
        const history = this.priceHistory[crypto];
        if (!history || history.length < 2) return 0;
        
        const now = Date.now();
        const cutoff = now - this.driftLookbackMs;
        
        // Filter to lookback period
        const relevantHistory = history.filter(h => h.timestamp >= cutoff);
        if (relevantHistory.length < 2) return 0;
        
        // Calculate return over the period
        const oldestPrice = relevantHistory[0].price;
        const newestPrice = relevantHistory[relevantHistory.length - 1].price;
        const periodReturn = (newestPrice - oldestPrice) / oldestPrice;
        
        // Annualize: if this is 1 hour of data, multiply by 24*365
        const periodMs = relevantHistory[relevantHistory.length - 1].timestamp - relevantHistory[0].timestamp;
        const periodsPerYear = (365 * 24 * 3600 * 1000) / periodMs;
        const annualizedDrift = periodReturn * periodsPerYear;
        
        return annualizedDrift;
    }
    
    /**
     * Update price history
     */
    updatePriceHistory(tick) {
        const crypto = tick.crypto;
        if (!this.priceHistory[crypto]) {
            this.priceHistory[crypto] = [];
        }
        
        this.priceHistory[crypto].push({
            timestamp: Date.now(),
            price: tick.spot_price
        });
        
        // Keep only relevant history (2x lookback to be safe)
        const cutoff = Date.now() - (this.driftLookbackMs * 2);
        this.priceHistory[crypto] = this.priceHistory[crypto].filter(h => h.timestamp >= cutoff);
    }
    
    /**
     * Override onTick to add drift awareness
     */
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        // Update price history
        this.updatePriceHistory(tick);
        
        // Calculate current drift
        const drift = this.calculateDrift(crypto);
        const driftDirection = drift > this.minDriftMagnitude ? 'up' : 
                              drift < -this.minDriftMagnitude ? 'down' : 'neutral';
        
        // Update volatility estimator
        this.volEstimator.update(tick);
        
        // Get volatility estimate
        const vols = this.volEstimator.getVolatilities(crypto);
        let vol = vols?.spot_realized_30 || 0.8;
        
        // Calculate fair value WITH drift (key improvement)
        // Override the default analysis to include measured drift
        const spotPrice = tick.spot_price;
        const priceToBeat = tick.price_to_beat || spotPrice;
        const timeRemaining = tick.time_remaining_sec || 0;
        const marketProb = tick.up_mid || 0.5;
        
        // Use actual drift in Black-Scholes calculation
        const fairProb = this.fairValueWithDrift(spotPrice, priceToBeat, timeRemaining, vol, drift);
        
        // Calculate edge
        const edge = fairProb - marketProb;
        const side = edge > 0 ? 'up' : 'down';
        
        const analysis = {
            fairProb,
            marketProb,
            edge,
            edgePct: edge * 100,
            side,
            drift,
            driftDirection,
            realizedVol: vol,
            confidence: Math.min(1, Math.abs(edge) / 0.1)
        };
        
        // Position management - same as parent
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            if (pnlPct <= -this.options.maxDrawdown) {
                return this.createSignal('sell', null, 'max_drawdown', analysis);
            }
            
            return this.createSignal('hold', null, 'holding_for_expiry', analysis);
        }
        
        // Entry timing check
        if (tick.time_remaining_sec < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // DRIFT ALIGNMENT CHECK - the key filter
        if (this.requireDriftAlignment) {
            // Only take UP bets when drift is positive
            if (side === 'up' && driftDirection !== 'up') {
                return this.createSignal('hold', null, 'drift_not_aligned_up', analysis);
            }
            // Only take DOWN bets when drift is negative
            if (side === 'down' && driftDirection !== 'down') {
                return this.createSignal('hold', null, 'drift_not_aligned_down', analysis);
            }
        }
        
        // Check for significant edge
        const hasEdge = Math.abs(edge) >= this.options.edgeThreshold;
        
        if (hasEdge) {
            this.stats.totalSignals++;
            this.stats.buySignals++;
            
            const isStrong = Math.abs(edge) >= this.options.strongEdgeThreshold;
            const size = isStrong ? this.options.maxPosition : this.options.maxPosition * 0.7;
            
            return this.createSignal('buy', side, 'drift_aligned_edge', analysis, size);
        }
        
        return this.createSignal('hold', null, null, analysis);
    }
    
    /**
     * Black-Scholes fair value calculation with drift
     */
    fairValueWithDrift(spotPrice, priceToBeat, timeRemainingSec, volatility, drift) {
        if (timeRemainingSec <= 0) {
            return spotPrice >= priceToBeat ? 1.0 : 0.0;
        }
        if (spotPrice <= 0 || priceToBeat <= 0 || volatility <= 0) {
            return 0.5;
        }
        
        const t = timeRemainingSec / (365 * 24 * 3600);
        const logRatio = Math.log(spotPrice / priceToBeat);
        const driftTerm = (drift - 0.5 * volatility * volatility) * t;
        const denominator = volatility * Math.sqrt(t);
        
        const d = (logRatio + driftTerm) / denominator;
        
        // Standard normal CDF
        return this.normalCDF(d);
    }
    
    normalCDF(x) {
        const a1 =  0.254829592;
        const a2 = -0.284496736;
        const a3 =  1.421413741;
        const a4 = -1.453152027;
        const a5 =  1.061405429;
        const p  =  0.3275911;

        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x);

        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

        return 0.5 * (1.0 + sign * y);
    }
}

// ================================================================
// DRIFT TIMEFRAME VARIANTS
// Test which lookback period captures the best drift signal
// ================================================================

/**
 * 1-Hour Drift - Short-term momentum
 * Captures recent price action, more responsive but noisier
 * 
 * Threshold: 0.3% (meaningful for 1H crypto movement)
 */
export class FairValueDrift1HStrategy extends DriftAwareFairValueStrategy {
    constructor(options = {}) {
        super({
            name: 'FV_Drift_1H',
            driftLookbackMs: 1 * 60 * 60 * 1000,  // 1 hour
            minDriftMagnitude: 0.003, // 0.3% - meaningful 1H move for crypto
            ...options
        });
    }
}

/**
 * 4-Hour Drift - Medium-term trend
 * Balances responsiveness with noise reduction
 * 
 * Threshold: 0.5% (expect larger moves over 4H)
 */
export class FairValueDrift4HStrategy extends DriftAwareFairValueStrategy {
    constructor(options = {}) {
        super({
            name: 'FV_Drift_4H',
            driftLookbackMs: 4 * 60 * 60 * 1000,  // 4 hours
            minDriftMagnitude: 0.005, // 0.5% - meaningful 4H trend
            ...options
        });
    }
}

/**
 * 24-Hour Drift - Daily trend
 * Captures broader market direction
 * 
 * Threshold: 1% (daily moves should be larger)
 */
export class FairValueDrift24HStrategy extends DriftAwareFairValueStrategy {
    constructor(options = {}) {
        super({
            name: 'FV_Drift_24H',
            driftLookbackMs: 24 * 60 * 60 * 1000,  // 24 hours
            minDriftMagnitude: 0.01, // 1% - meaningful daily trend
            ...options
        });
    }
}

/**
 * UP-Only with 4H Drift
 * Only takes UP bets, uses 4-hour drift for fair value calculation
 */
export class FairValueUpOnly4HStrategy extends DriftAwareFairValueStrategy {
    constructor(options = {}) {
        super({
            name: 'FV_UpOnly_4H',
            driftLookbackMs: 4 * 60 * 60 * 1000,
            ...options
        });
    }
    
    onTick(tick, position = null, context = {}) {
        const signal = super.onTick(tick, position, context);
        
        // Only allow UP bets
        if (signal.action === 'buy' && signal.side === 'down') {
            return this.createSignal('hold', null, 'up_only_filter', signal);
        }
        
        return signal;
    }
}

// Factory functions for drift variants
export function createFairValueDrift1H(capital = 100) {
    return new FairValueDrift1HStrategy({ maxPosition: capital });
}

export function createFairValueDrift4H(capital = 100) {
    return new FairValueDrift4HStrategy({ maxPosition: capital });
}

export function createFairValueDrift24H(capital = 100) {
    return new FairValueDrift24HStrategy({ maxPosition: capital });
}

export function createFairValueUpOnly4H(capital = 100) {
    return new FairValueUpOnly4HStrategy({ maxPosition: capital });
}

export default FairValueStrategy;
