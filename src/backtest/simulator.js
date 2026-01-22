/**
 * Execution Simulator
 * 
 * Simulates realistic trade execution for backtesting
 */

import { v4 as uuidv4 } from 'uuid';

export class ExecutionSimulator {
    constructor(options = {}) {
        this.options = {
            takerFee: 0.001,        // 0.1% taker fee
            makerFee: 0,            // 0% maker fee (rebate available)
            slippageModel: 'linear', // 'none', 'linear', 'sqrt'
            slippageFactor: 0.001,  // Slippage per $100 size
            latencyMs: 100,         // Simulated latency
            partialFills: false,    // Enable partial fills based on book depth
            ...options
        };
        
        // Execution stats
        this.stats = {
            totalOrders: 0,
            filledOrders: 0,
            partialFills: 0,
            totalSlippage: 0,
            totalFees: 0
        };
    }
    
    /**
     * Simulate a market order execution
     * 
     * @param {Object} order - Order details
     * @param {Object} tick - Current market state
     * @returns {Object} - Execution result
     */
    executeMarketOrder(order, tick) {
        this.stats.totalOrders++;
        
        const { side, size } = order;
        
        // Determine execution price based on side
        let basePrice;
        if (side === 'buy_up' || side === 'sell_down') {
            // Buying up token (or selling down = buying up)
            basePrice = tick.up_ask;
        } else {
            // Selling up token (or buying down = selling up)
            basePrice = tick.up_bid;
        }
        
        // Apply slippage
        const slippage = this.calculateSlippage(size, tick);
        const executionPrice = side.includes('buy') 
            ? basePrice + slippage 
            : basePrice - slippage;
        
        // Calculate fee
        const fee = size * this.options.takerFee;
        
        // Check if order can be filled (simplified - check top of book)
        const availableSize = side.includes('buy') 
            ? tick.up_ask_size 
            : tick.up_bid_size;
        
        let filledSize = size;
        let fillType = 'full';
        
        if (this.options.partialFills && size > availableSize) {
            filledSize = availableSize;
            fillType = 'partial';
            this.stats.partialFills++;
        }
        
        this.stats.filledOrders++;
        this.stats.totalSlippage += Math.abs(slippage) * filledSize;
        this.stats.totalFees += fee;
        
        return {
            orderId: uuidv4(),
            side,
            requestedSize: size,
            filledSize,
            fillType,
            basePrice,
            executionPrice,
            slippage,
            fee,
            timestamp: tick.timestamp_ms + this.options.latencyMs,
            tick
        };
    }
    
    /**
     * Simulate a limit order execution
     */
    executeLimitOrder(order, tick) {
        const { side, size, limitPrice } = order;
        
        // Check if limit price is marketable
        const marketPrice = side.includes('buy') ? tick.up_ask : tick.up_bid;
        
        if (side.includes('buy') && limitPrice >= marketPrice) {
            // Limit is at or above ask - fills as market
            return this.executeMarketOrder({ side, size }, tick);
        }
        
        if (side.includes('sell') && limitPrice <= marketPrice) {
            // Limit is at or below bid - fills as market
            return this.executeMarketOrder({ side, size }, tick);
        }
        
        // Order rests on book - no immediate fill
        return {
            orderId: uuidv4(),
            side,
            requestedSize: size,
            filledSize: 0,
            fillType: 'pending',
            limitPrice,
            timestamp: tick.timestamp_ms,
            tick
        };
    }
    
    /**
     * Calculate slippage based on order size and market conditions
     */
    calculateSlippage(size, tick) {
        if (this.options.slippageModel === 'none') {
            return 0;
        }
        
        const spread = tick.spread || (tick.up_ask - tick.up_bid);
        
        if (this.options.slippageModel === 'linear') {
            // Linear slippage: proportional to size
            return (size / 100) * this.options.slippageFactor * spread;
        }
        
        if (this.options.slippageModel === 'sqrt') {
            // Square root slippage: more realistic for larger orders
            return Math.sqrt(size / 100) * this.options.slippageFactor * spread;
        }
        
        return 0;
    }
    
    /**
     * Get execution statistics
     */
    getStats() {
        return {
            ...this.stats,
            avgSlippage: this.stats.filledOrders > 0 
                ? this.stats.totalSlippage / this.stats.filledOrders 
                : 0,
            avgFee: this.stats.filledOrders > 0 
                ? this.stats.totalFees / this.stats.filledOrders 
                : 0,
            fillRate: this.stats.totalOrders > 0 
                ? this.stats.filledOrders / this.stats.totalOrders 
                : 0
        };
    }
    
    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            totalOrders: 0,
            filledOrders: 0,
            partialFills: 0,
            totalSlippage: 0,
            totalFees: 0
        };
    }
}

export default ExecutionSimulator;

