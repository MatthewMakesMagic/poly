/**
 * Comprehensive Quant Strategy Suite
 * 
 * 20 diverse strategies for systematic comparison:
 * 
 * TIME-BASED (4):
 * - EarlyWindow: Trade in first 5 minutes when uncertainty is high
 * - MidWindow: Trade in middle when trends establish
 * - LateWindow: Trade in last 3 minutes with trend confirmation
 * - WindowPhase: Different behavior per phase
 * 
 * MOMENTUM (4):
 * - FastMomentum: 10-tick lookback
 * - SlowMomentum: 30-tick lookback  
 * - SpotMomentum: Follow spot price moves
 * - CrossoverMomentum: Fast/slow MA crossover
 * 
 * MEAN REVERSION (3):
 * - QuickReversion: 10-tick MA, 2% deviation
 * - DeepReversion: 20-tick MA, 5% deviation
 * - BollingerReversion: Bollinger band based
 * 
 * SPOT-BASED (3):
 * - SpotLead: Trade on spot moves before market catches up
 * - SpotDelta: Trade on spot vs price-to-beat delta
 * - SpotVelocity: Trade on rate of spot change
 * 
 * MICROSTRUCTURE (3):
 * - SpreadArb: Trade when spread is favorable
 * - BookImbalance: Trade on bid/ask size imbalance
 * - PriceLevel: Trade at round number levels
 * 
 * ENSEMBLE (3):
 * - ConsensusLong: Enter when multiple signals agree on UP
 * - ConsensusShort: Enter when multiple signals agree on DOWN
 * - ContraMajority: Fade the crowd
 */

import { Strategy } from '../strategy.js';

// ============================================
// TIME-BASED STRATEGIES
// ============================================

export class EarlyWindowStrategy extends Strategy {
    constructor(params = {}) {
        super('EarlyWindow', {
            entryTimeMin: 600,      // Only enter when >10 min remaining
            exitTimeMin: 300,       // Exit by 5 min remaining
            entryRange: 0.15,       // Enter when price in 35-65%
            profitTarget: 0.025,
            stopLoss: 0.04,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const time = tick.time_remaining_sec;
        const upPrice = tick.up_mid || 0.5;
        
        // Time-based exit
        if (position && time < this.params.exitTimeMin) {
            return { action: 'sell', reason: 'time_exit' };
        }
        
        // Only trade early in window
        if (time < this.params.entryTimeMin) {
            return { action: 'hold' };
        }
        
        // Check position P&L
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            return { action: 'hold' };
        }
        
        // Entry logic - bet on uncertainty resolution
        if (upPrice >= 0.5 - this.params.entryRange && upPrice <= 0.5 + this.params.entryRange) {
            const spotDelta = tick.spot_delta_pct || 0;
            const side = spotDelta > 0 ? 'up' : 'down';
            return { action: 'buy', side, size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class MidWindowStrategy extends Strategy {
    constructor(params = {}) {
        super('MidWindow', {
            entryTimeMax: 600,      // Enter when <10 min remaining
            entryTimeMin: 180,      // But >3 min remaining
            trendThreshold: 0.55,   // Need clear trend
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const time = tick.time_remaining_sec;
        const upPrice = tick.up_mid || 0.5;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (time < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        // Only trade in mid-window
        if (time > this.params.entryTimeMax || time < this.params.entryTimeMin) {
            return { action: 'hold' };
        }
        
        // Follow established trend
        if (upPrice >= this.params.trendThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (upPrice <= 1 - this.params.trendThreshold) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class LateWindowStrategy extends Strategy {
    constructor(params = {}) {
        super('LateWindow', {
            entryTimeMax: 180,       // Only enter in last 3 min
            exitTimeMin: 30,         // Exit by 30 sec
            trendThreshold: 0.60,    // Need strong trend
            profitTarget: 0.015,
            stopLoss: 0.025,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const time = tick.time_remaining_sec;
        const upPrice = tick.up_mid || 0.5;
        
        if (position) {
            if (time < this.params.exitTimeMin) return { action: 'sell', reason: 'time_exit' };
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            return { action: 'hold' };
        }
        
        // Only trade late
        if (time > this.params.entryTimeMax) {
            return { action: 'hold' };
        }
        
        // Follow strong trend
        if (upPrice >= this.params.trendThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (upPrice <= 1 - this.params.trendThreshold) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class WindowPhaseStrategy extends Strategy {
    constructor(params = {}) {
        super('WindowPhase', {
            // Phase thresholds (seconds remaining)
            earlyPhase: 600,
            midPhase: 180,
            // Different behavior per phase
            earlyThreshold: 0.45,    // Fade moves early
            midThreshold: 0.55,      // Follow trend mid
            lateThreshold: 0.65,     // Strong confirm late
            profitTarget: 0.02,
            stopLoss: 0.035,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const time = tick.time_remaining_sec;
        const upPrice = tick.up_mid || 0.5;
        
        if (position) {
            if (time < 30) return { action: 'sell', reason: 'time_exit' };
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            return { action: 'hold' };
        }
        
        // Phase-based entry
        if (time > this.params.earlyPhase) {
            // Early: fade extreme moves
            if (upPrice >= 1 - this.params.earlyThreshold) {
                return { action: 'buy', side: 'down', size: this.params.maxPosition };
            }
            if (upPrice <= this.params.earlyThreshold) {
                return { action: 'buy', side: 'up', size: this.params.maxPosition };
            }
        } else if (time > this.params.midPhase) {
            // Mid: follow trend
            if (upPrice >= this.params.midThreshold) {
                return { action: 'buy', side: 'up', size: this.params.maxPosition };
            }
            if (upPrice <= 1 - this.params.midThreshold) {
                return { action: 'buy', side: 'down', size: this.params.maxPosition };
            }
        } else {
            // Late: only strong signals
            if (upPrice >= this.params.lateThreshold) {
                return { action: 'buy', side: 'up', size: this.params.maxPosition };
            }
            if (upPrice <= 1 - this.params.lateThreshold) {
                return { action: 'buy', side: 'down', size: this.params.maxPosition };
            }
        }
        
        return { action: 'hold' };
    }
}

// ============================================
// MOMENTUM STRATEGIES
// ============================================

export class FastMomentumStrategy extends Strategy {
    constructor(params = {}) {
        super('FastMomentum', {
            lookback: 10,           // 10-tick lookback
            momentumThreshold: 0.01, // 1% move
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            cooldownTicks: 5,       // Wait 5 ticks after exit
            ...params
        });
        this.priceHistory = [];
        this.cooldown = 0;
    }
    
    onWindowStart() {
        this.priceHistory = [];
        this.cooldown = 0;
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > this.params.lookback) {
            this.priceHistory.shift();
        }
        
        if (this.cooldown > 0) {
            this.cooldown--;
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) {
                this.cooldown = this.params.cooldownTicks;
                return { action: 'sell', reason: 'profit_target' };
            }
            if (pnl <= -this.params.stopLoss) {
                this.cooldown = this.params.cooldownTicks;
                return { action: 'sell', reason: 'stop_loss' };
            }
            if (tick.time_remaining_sec < 60) {
                return { action: 'sell', reason: 'time_exit' };
            }
            return { action: 'hold' };
        }
        
        if (this.priceHistory.length < this.params.lookback || this.cooldown > 0) {
            return { action: 'hold' };
        }
        
        const oldPrice = this.priceHistory[0];
        const momentum = (upPrice - oldPrice) / oldPrice;
        
        if (momentum > this.params.momentumThreshold && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (momentum < -this.params.momentumThreshold && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class SlowMomentumStrategy extends Strategy {
    constructor(params = {}) {
        super('SlowMomentum', {
            lookback: 30,            // 30-tick lookback
            momentumThreshold: 0.02, // 2% move
            profitTarget: 0.025,
            stopLoss: 0.04,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > this.params.lookback) {
            this.priceHistory.shift();
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 90) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (this.priceHistory.length < this.params.lookback) {
            return { action: 'hold' };
        }
        
        const oldPrice = this.priceHistory[0];
        const momentum = (upPrice - oldPrice) / oldPrice;
        
        if (momentum > this.params.momentumThreshold && tick.time_remaining_sec > 180) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (momentum < -this.params.momentumThreshold && tick.time_remaining_sec > 180) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class SpotMomentumStrategy extends Strategy {
    constructor(params = {}) {
        super('SpotMomentum', {
            spotThreshold: 0.001,    // 0.1% spot move
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotDelta = tick.spot_delta_pct || 0;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Follow significant spot moves
        if (spotDelta > this.params.spotThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (spotDelta < -this.params.spotThreshold) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class CrossoverMomentumStrategy extends Strategy {
    constructor(params = {}) {
        super('CrossoverMomentum', {
            fastPeriod: 5,
            slowPeriod: 15,
            profitTarget: 0.02,
            stopLoss: 0.035,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    calcMA(prices, period) {
        if (prices.length < period) return null;
        const slice = prices.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        const fastMA = this.calcMA(this.priceHistory, this.params.fastPeriod);
        const slowMA = this.calcMA(this.priceHistory, this.params.slowPeriod);
        
        if (!fastMA || !slowMA || tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Crossover signals
        if (fastMA > slowMA * 1.01) {  // Fast above slow by 1%
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (fastMA < slowMA * 0.99) {  // Fast below slow by 1%
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

// ============================================
// MEAN REVERSION STRATEGIES
// ============================================

export class QuickReversionStrategy extends Strategy {
    constructor(params = {}) {
        super('QuickReversion', {
            maPeriod: 10,
            deviationThreshold: 0.02,  // 2% from MA
            profitTarget: 0.015,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > this.params.maPeriod * 2) {
            this.priceHistory.shift();
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (this.priceHistory.length < this.params.maPeriod) {
            return { action: 'hold' };
        }
        
        const ma = this.priceHistory.slice(-this.params.maPeriod).reduce((a, b) => a + b, 0) / this.params.maPeriod;
        const deviation = (upPrice - ma) / ma;
        
        if (deviation > this.params.deviationThreshold && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };  // Fade
        }
        if (deviation < -this.params.deviationThreshold && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };  // Fade
        }
        
        return { action: 'hold' };
    }
}

export class DeepReversionStrategy extends Strategy {
    constructor(params = {}) {
        super('DeepReversion', {
            maPeriod: 20,
            deviationThreshold: 0.05,  // 5% from MA
            profitTarget: 0.03,
            stopLoss: 0.05,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > this.params.maPeriod * 2) {
            this.priceHistory.shift();
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 90) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (this.priceHistory.length < this.params.maPeriod) {
            return { action: 'hold' };
        }
        
        const ma = this.priceHistory.slice(-this.params.maPeriod).reduce((a, b) => a + b, 0) / this.params.maPeriod;
        const deviation = (upPrice - ma) / ma;
        
        if (deviation > this.params.deviationThreshold && tick.time_remaining_sec > 180) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        if (deviation < -this.params.deviationThreshold && tick.time_remaining_sec > 180) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class BollingerReversionStrategy extends Strategy {
    constructor(params = {}) {
        super('BollingerReversion', {
            period: 20,
            stdDevMultiplier: 2.0,
            profitTarget: 0.02,
            stopLoss: 0.04,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > this.params.period * 2) {
            this.priceHistory.shift();
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 90) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (this.priceHistory.length < this.params.period) {
            return { action: 'hold' };
        }
        
        const prices = this.priceHistory.slice(-this.params.period);
        const ma = prices.reduce((a, b) => a + b, 0) / this.params.period;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - ma, 2), 0) / this.params.period;
        const stdDev = Math.sqrt(variance);
        
        const upperBand = ma + stdDev * this.params.stdDevMultiplier;
        const lowerBand = ma - stdDev * this.params.stdDevMultiplier;
        
        if (upPrice > upperBand && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        if (upPrice < lowerBand && tick.time_remaining_sec > 120) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

// ============================================
// SPOT-BASED STRATEGIES
// ============================================

export class SpotLeadStrategy extends Strategy {
    constructor(params = {}) {
        super('SpotLead', {
            // Trade when spot moves but market hasn't caught up
            spotMoveThreshold: 0.0005,   // 0.05% spot move
            marketLagThreshold: 0.52,     // Market should be >52% if spot up
            profitTarget: 0.015,
            stopLoss: 0.025,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotDelta = tick.spot_delta_pct || 0;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Spot up but market hasn't reflected it
        if (spotDelta > this.params.spotMoveThreshold && upPrice < this.params.marketLagThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        // Spot down but market hasn't reflected it
        if (spotDelta < -this.params.spotMoveThreshold && upPrice > (1 - this.params.marketLagThreshold)) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class SpotDeltaStrategy extends Strategy {
    constructor(params = {}) {
        super('SpotDelta', {
            deltaThreshold: 0.002,     // 0.2% from price to beat
            confirmationPrice: 0.45,   // Market price suggests same direction
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotDelta = tick.spot_delta_pct || 0;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Strong spot delta with market confirmation
        if (spotDelta > this.params.deltaThreshold && upPrice < (1 - this.params.confirmationPrice)) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (spotDelta < -this.params.deltaThreshold && upPrice > this.params.confirmationPrice) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class SpotVelocityStrategy extends Strategy {
    constructor(params = {}) {
        super('SpotVelocity', {
            lookback: 10,
            velocityThreshold: 0.0001,  // Rate of spot change per tick
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
        this.spotHistory = [];
    }
    
    onWindowStart() {
        this.spotHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotPrice = tick.spot_price;
        
        if (spotPrice) {
            this.spotHistory.push(spotPrice);
            if (this.spotHistory.length > this.params.lookback) {
                this.spotHistory.shift();
            }
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (this.spotHistory.length < this.params.lookback || tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Calculate velocity (rate of change)
        const oldSpot = this.spotHistory[0];
        const velocity = (spotPrice - oldSpot) / oldSpot / this.params.lookback;
        
        if (velocity > this.params.velocityThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (velocity < -this.params.velocityThreshold) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

// ============================================
// MICROSTRUCTURE STRATEGIES
// ============================================

export class SpreadArbStrategy extends Strategy {
    constructor(params = {}) {
        super('SpreadArb', {
            maxSpread: 0.015,        // Only trade when spread < 1.5%
            minEdge: 0.51,           // Need at least 51% to enter
            profitTarget: 0.015,
            stopLoss: 0.02,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spread = tick.spread || 0.01;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (spread > this.params.maxSpread || tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Only enter when spread is tight and there's an edge
        if (upPrice >= this.params.minEdge) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        if (upPrice <= 1 - this.params.minEdge) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class BookImbalanceStrategy extends Strategy {
    constructor(params = {}) {
        super('BookImbalance', {
            imbalanceThreshold: 1.5,   // Bid size > 1.5x ask size = bullish
            priceConfirm: 0.48,        // Price must be reasonable
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const bidSize = tick.up_bid_size || 0;
        const askSize = tick.up_ask_size || 0;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120 || !bidSize || !askSize) {
            return { action: 'hold' };
        }
        
        const bidAskRatio = bidSize / (askSize || 1);
        
        // Bullish imbalance
        if (bidAskRatio > this.params.imbalanceThreshold && upPrice < (1 - this.params.priceConfirm)) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        // Bearish imbalance
        if (bidAskRatio < 1 / this.params.imbalanceThreshold && upPrice > this.params.priceConfirm) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class PriceLevelStrategy extends Strategy {
    constructor(params = {}) {
        super('PriceLevel', {
            // Trade at psychological levels
            levels: [0.25, 0.33, 0.40, 0.50, 0.60, 0.67, 0.75],
            levelTolerance: 0.02,
            profitTarget: 0.02,
            stopLoss: 0.03,
            maxPosition: 100,
            ...params
        });
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120) {
            return { action: 'hold' };
        }
        
        // Find nearest level
        let nearestLevel = null;
        let minDist = Infinity;
        for (const level of this.params.levels) {
            const dist = Math.abs(upPrice - level);
            if (dist < minDist) {
                minDist = dist;
                nearestLevel = level;
            }
        }
        
        // Fade move toward extreme level
        if (nearestLevel && minDist < this.params.levelTolerance) {
            if (nearestLevel >= 0.65) {
                return { action: 'buy', side: 'down', size: this.params.maxPosition };
            }
            if (nearestLevel <= 0.35) {
                return { action: 'buy', side: 'up', size: this.params.maxPosition };
            }
        }
        
        return { action: 'hold' };
    }
}

// ============================================
// ENSEMBLE STRATEGIES
// ============================================

export class ConsensusLongStrategy extends Strategy {
    constructor(params = {}) {
        super('ConsensusLong', {
            // Enter long when multiple signals agree
            minSignals: 2,
            profitTarget: 0.025,
            stopLoss: 0.04,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotDelta = tick.spot_delta_pct || 0;
        
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > 20) this.priceHistory.shift();
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120 || this.priceHistory.length < 10) {
            return { action: 'hold' };
        }
        
        // Count bullish signals
        let bullishSignals = 0;
        
        // Signal 1: Spot positive
        if (spotDelta > 0.0005) bullishSignals++;
        
        // Signal 2: Price momentum positive
        const ma10 = this.priceHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
        if (upPrice > ma10) bullishSignals++;
        
        // Signal 3: Price above 50%
        if (upPrice > 0.52) bullishSignals++;
        
        // Signal 4: Rising prices
        if (this.priceHistory.length >= 5) {
            const recent = this.priceHistory.slice(-5);
            if (recent[4] > recent[0]) bullishSignals++;
        }
        
        if (bullishSignals >= this.params.minSignals) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class ConsensusShortStrategy extends Strategy {
    constructor(params = {}) {
        super('ConsensusShort', {
            minSignals: 2,
            profitTarget: 0.025,
            stopLoss: 0.04,
            maxPosition: 100,
            ...params
        });
        this.priceHistory = [];
    }
    
    onWindowStart() {
        this.priceHistory = [];
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        const spotDelta = tick.spot_delta_pct || 0;
        
        this.priceHistory.push(upPrice);
        if (this.priceHistory.length > 20) this.priceHistory.shift();
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) return { action: 'sell', reason: 'profit_target' };
            if (pnl <= -this.params.stopLoss) return { action: 'sell', reason: 'stop_loss' };
            if (tick.time_remaining_sec < 60) return { action: 'sell', reason: 'time_exit' };
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 120 || this.priceHistory.length < 10) {
            return { action: 'hold' };
        }
        
        // Count bearish signals
        let bearishSignals = 0;
        
        if (spotDelta < -0.0005) bearishSignals++;
        
        const ma10 = this.priceHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
        if (upPrice < ma10) bearishSignals++;
        
        if (upPrice < 0.48) bearishSignals++;
        
        if (this.priceHistory.length >= 5) {
            const recent = this.priceHistory.slice(-5);
            if (recent[4] < recent[0]) bearishSignals++;
        }
        
        if (bearishSignals >= this.params.minSignals) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

export class ContraStrategy extends Strategy {
    constructor(params = {}) {
        super('ContraMajority', {
            // Fade extreme market moves
            extremeThreshold: 0.70,
            profitTarget: 0.03,
            stopLoss: 0.05,
            maxPosition: 100,
            cooldownTicks: 30,
            ...params
        });
        this.cooldown = 0;
    }
    
    onWindowStart() {
        this.cooldown = 0;
    }
    
    onTick(tick, position, context) {
        const upPrice = tick.up_mid || 0.5;
        
        if (this.cooldown > 0) this.cooldown--;
        
        if (position) {
            const currentPrice = position.side === 'up' ? upPrice : (1 - upPrice);
            const pnl = (currentPrice - position.entryPrice) / position.entryPrice;
            if (pnl >= this.params.profitTarget) {
                this.cooldown = this.params.cooldownTicks;
                return { action: 'sell', reason: 'profit_target' };
            }
            if (pnl <= -this.params.stopLoss) {
                this.cooldown = this.params.cooldownTicks;
                return { action: 'sell', reason: 'stop_loss' };
            }
            if (tick.time_remaining_sec < 90) {
                return { action: 'sell', reason: 'time_exit' };
            }
            return { action: 'hold' };
        }
        
        if (tick.time_remaining_sec < 180 || this.cooldown > 0) {
            return { action: 'hold' };
        }
        
        // Fade extreme moves
        if (upPrice >= this.params.extremeThreshold) {
            return { action: 'buy', side: 'down', size: this.params.maxPosition };
        }
        if (upPrice <= 1 - this.params.extremeThreshold) {
            return { action: 'buy', side: 'up', size: this.params.maxPosition };
        }
        
        return { action: 'hold' };
    }
}

// Export all strategies
export const QUANT_STRATEGIES = [
    // Time-based
    EarlyWindowStrategy,
    MidWindowStrategy,
    LateWindowStrategy,
    WindowPhaseStrategy,
    // Momentum
    FastMomentumStrategy,
    SlowMomentumStrategy,
    SpotMomentumStrategy,
    CrossoverMomentumStrategy,
    // Mean Reversion
    QuickReversionStrategy,
    DeepReversionStrategy,
    BollingerReversionStrategy,
    // Spot-based
    SpotLeadStrategy,
    SpotDeltaStrategy,
    SpotVelocityStrategy,
    // Microstructure
    SpreadArbStrategy,
    BookImbalanceStrategy,
    PriceLevelStrategy,
    // Ensemble
    ConsensusLongStrategy,
    ConsensusShortStrategy,
    ContraStrategy
];

export function createAllStrategies(capitalPerTrade = 100) {
    return QUANT_STRATEGIES.map(StrategyClass => new StrategyClass({ maxPosition: capitalPerTrade }));
}

export default QUANT_STRATEGIES;
