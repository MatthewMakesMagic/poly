/**
 * Momentum Strategy
 * 
 * Follows the direction of BTC spot price movement
 * Entry: When BTC moves significantly in one direction
 * Exit: Time-based or reversal signal
 */

import { Strategy } from '../strategy.js';

export class MomentumStrategy extends Strategy {
    constructor(params = {}) {
        super('Momentum', {
            // Entry parameters
            lookbackTicks: 10,      // How many ticks to measure momentum
            momentumThreshold: 0.001, // 0.1% BTC move to trigger
            
            // Exit parameters
            takeProfit: 0.03,       // 3% take profit
            stopLoss: 0.05,         // 5% stop loss
            maxHoldTicks: 300,      // Max hold time in ticks
            
            // Risk
            maxPosition: 50,
            ...params
        });
        
        this.spotHistory = [];
        this.entryTick = null;
        this.ticksSinceEntry = 0;
    }
    
    onWindowStart(windowInfo) {
        this.spotHistory = [];
        this.entryTick = null;
        this.ticksSinceEntry = 0;
    }
    
    onTick(tick, position, context) {
        // Update spot price history
        this.spotHistory.push(tick.spot_price);
        
        // Track holding time
        if (position) {
            this.ticksSinceEntry++;
            
            // Check max hold time
            if (this.ticksSinceEntry >= this.params.maxHoldTicks) {
                return { action: 'sell', reason: 'max_hold_time' };
            }
        }
        
        // Need enough history
        if (this.spotHistory.length < this.params.lookbackTicks) {
            return { action: 'hold' };
        }
        
        // Calculate momentum
        const oldPrice = this.spotHistory[this.spotHistory.length - this.params.lookbackTicks];
        const currentPrice = tick.spot_price;
        const momentum = (currentPrice - oldPrice) / oldPrice;
        
        // If we have a position, check for reversal
        if (position) {
            // Check for momentum reversal
            const entryDirection = position.side === 'up' ? 1 : -1;
            const currentDirection = momentum > 0 ? 1 : -1;
            
            // Exit on strong reversal
            if (entryDirection !== currentDirection && Math.abs(momentum) > this.params.momentumThreshold) {
                return { action: 'sell', reason: 'momentum_reversal' };
            }
            
            return { action: 'hold' };
        }
        
        // Look for entry
        if (Math.abs(momentum) > this.params.momentumThreshold) {
            if (momentum > this.params.momentumThreshold) {
                // BTC moving up - bet on up
                this.entryTick = context.tickIndex;
                this.ticksSinceEntry = 0;
                return {
                    action: 'buy',
                    side: 'up',
                    size: this.params.maxPosition
                };
            } else {
                // BTC moving down - bet on down
                this.entryTick = context.tickIndex;
                this.ticksSinceEntry = 0;
                return {
                    action: 'buy',
                    side: 'down',
                    size: this.params.maxPosition
                };
            }
        }
        
        return { action: 'hold' };
    }
}

export default MomentumStrategy;

