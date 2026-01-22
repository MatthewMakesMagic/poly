/**
 * Mean Reversion Strategy
 * 
 * Fades large moves from the moving average
 * Entry: When price deviates > threshold from MA
 * Exit: When price reverts toward MA, or stop/take-profit
 */

import { Strategy } from '../strategy.js';
import { ema } from '../../analysis/metrics.js';

export class MeanReversionStrategy extends Strategy {
    constructor(params = {}) {
        super('MeanReversion', {
            // Entry parameters
            maWindow: 20,           // MA window (in ticks)
            entryThreshold: 0.03,   // Enter when price > 3% from MA
            
            // Exit parameters
            takeProfit: 0.02,       // 2% take profit
            stopLoss: 0.05,         // 5% stop loss
            revertThreshold: 0.5,   // Exit when 50% reverted to MA
            
            // Risk
            maxPosition: 50,
            ...params
        });
        
        this.priceHistory = [];
        this.maHistory = [];
    }
    
    onWindowStart(windowInfo) {
        // Reset for new window
        this.priceHistory = [];
        this.maHistory = [];
    }
    
    onTick(tick, position, context) {
        // Update price history
        this.priceHistory.push(tick.up_mid);
        
        // Need enough history for MA
        if (this.priceHistory.length < this.params.maWindow) {
            return { action: 'hold' };
        }
        
        // Calculate moving average
        const prices = this.priceHistory.slice(-this.params.maWindow);
        const ma = prices.reduce((a, b) => a + b, 0) / prices.length;
        this.maHistory.push(ma);
        
        const currentPrice = tick.up_mid;
        const deviation = (currentPrice - ma) / ma;
        
        // If we have a position, check for exit
        if (position) {
            const entryDeviation = (position.entryPrice - ma) / ma;
            const currentDeviation = deviation;
            
            // Check if price has reverted enough
            if (Math.abs(currentDeviation) < Math.abs(entryDeviation) * (1 - this.params.revertThreshold)) {
                return { action: 'sell', reason: 'reversion_target' };
            }
            
            return { action: 'hold' };
        }
        
        // Look for entry
        if (Math.abs(deviation) > this.params.entryThreshold) {
            // Price is extended - fade the move
            if (deviation > this.params.entryThreshold) {
                // Price above MA - bet on down (sell up)
                return {
                    action: 'buy',
                    side: 'down',
                    size: this.params.maxPosition
                };
            } else {
                // Price below MA - bet on up
                return {
                    action: 'buy',
                    side: 'up',
                    size: this.params.maxPosition
                };
            }
        }
        
        return { action: 'hold' };
    }
}

export default MeanReversionStrategy;

