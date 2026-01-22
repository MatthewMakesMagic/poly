/**
 * Threshold Exit Strategy
 * 
 * Your original hunch: Enter positions and exit at profit thresholds
 * rather than holding to resolution.
 * 
 * This strategy focuses on capturing small, consistent gains
 * by setting tight profit targets.
 */

import { Strategy } from '../strategy.js';

export class ThresholdExitStrategy extends Strategy {
    constructor(params = {}) {
        super('ThresholdExit', {
            // Entry parameters
            entryBias: 0.50,         // Only enter when prob near 50%
            entryBiasRange: 0.10,    // +/- 10% from bias (40-60%)
            
            // Exit parameters - THE KEY INNOVATION
            profitTargets: [0.02, 0.03, 0.05], // 2%, 3%, 5% profit levels
            targetWeights: [0.5, 0.3, 0.2],    // Exit 50% at 2%, 30% at 3%, 20% at 5%
            stopLoss: 0.05,          // 5% stop loss
            
            // Time-based exit
            timeDecayStart: 300,     // Start exiting after 5 min (300s)
            forceExitTime: 60,       // Force exit with 1 min remaining
            
            // Risk
            maxPosition: 100,
            minSpread: 0.02,         // Don't enter if spread > 2%
            ...params
        });
        
        this.partialExits = [];
        this.entryPrice = null;
    }
    
    onWindowStart(windowInfo) {
        this.partialExits = [];
        this.entryPrice = null;
    }
    
    onTick(tick, position, context) {
        // Check spread - avoid illiquid markets
        if (tick.spread_pct > this.params.minSpread * 100) {
            if (position) {
                return { action: 'sell', reason: 'spread_widened' };
            }
            return { action: 'hold' };
        }
        
        // Force exit near window end
        if (tick.time_remaining_sec < this.params.forceExitTime && position) {
            return { action: 'sell', reason: 'time_force_exit' };
        }
        
        // If we have a position, check thresholds
        if (position) {
            return this.checkExitThresholds(tick, position);
        }
        
        // Look for entry near 50/50
        const upPrice = tick.up_mid;
        const bias = this.params.entryBias;
        const range = this.params.entryBiasRange;
        
        if (upPrice >= bias - range && upPrice <= bias + range) {
            // Market is uncertain - good time to enter
            // Choose side based on slight edge indicators
            
            // Use spot delta as a tiebreaker
            const spotDelta = tick.spot_delta_pct || 0;
            const side = spotDelta > 0 ? 'up' : 'down';
            
            this.entryPrice = side === 'up' ? upPrice : (1 - upPrice);
            
            return {
                action: 'buy',
                side,
                size: this.params.maxPosition
            };
        }
        
        return { action: 'hold' };
    }
    
    checkExitThresholds(tick, position) {
        const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
        const entryPrice = position.entryPrice;
        const pnlPct = (currentPrice - entryPrice) / entryPrice;
        
        // Check stop loss
        if (pnlPct <= -this.params.stopLoss) {
            return { action: 'sell', reason: 'stop_loss' };
        }
        
        // Check profit targets (simplified - full exit at first target for now)
        for (let i = 0; i < this.params.profitTargets.length; i++) {
            const target = this.params.profitTargets[i];
            
            if (pnlPct >= target && !this.partialExits.includes(i)) {
                this.partialExits.push(i);
                return { action: 'sell', reason: `profit_target_${i + 1}` };
            }
        }
        
        // Time decay - start taking profits earlier as window progresses
        if (tick.time_remaining_sec < this.params.timeDecayStart) {
            // Reduce profit target as time runs out
            const timeRatio = tick.time_remaining_sec / this.params.timeDecayStart;
            const adjustedTarget = this.params.profitTargets[0] * timeRatio;
            
            if (pnlPct >= adjustedTarget && pnlPct > 0) {
                return { action: 'sell', reason: 'time_decay_profit' };
            }
        }
        
        return { action: 'hold' };
    }
}

export default ThresholdExitStrategy;

