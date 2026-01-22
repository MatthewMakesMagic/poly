/**
 * Volatility Estimation Module
 * 
 * Multiple volatility estimators for comparing realized vs implied volatility:
 * 
 * 1. Realized Volatility (Close-to-Close)
 *    - Standard deviation of log returns
 *    - Multiple timeframes: 10s, 30s, 60s
 * 
 * 2. Parkinson Volatility
 *    - Uses high/low range (more efficient than close-to-close)
 *    - σ² = (1/4n*ln(2)) * Σ(ln(H/L))²
 * 
 * 3. Yang-Zhang Volatility
 *    - Combines overnight and intraday moves
 *    - More robust to opening jumps
 * 
 * 4. EWMA Volatility
 *    - Exponentially weighted for recent observations
 */

/**
 * Calculate log return between two prices
 */
function logReturn(price1, price2) {
    if (price1 <= 0 || price2 <= 0) return 0;
    return Math.log(price2 / price1);
}

/**
 * Annualize volatility from per-second to per-year
 * Assuming 365 days, 24 hours, 3600 seconds
 */
function annualize(perSecondVol) {
    const secondsPerYear = 365 * 24 * 3600;
    return perSecondVol * Math.sqrt(secondsPerYear);
}

/**
 * Calculate realized volatility (close-to-close)
 * 
 * @param {number[]} prices - Array of prices
 * @param {number} intervalSec - Time interval between observations in seconds
 * @returns {number} Annualized volatility
 */
function realizedVolatility(prices, intervalSec = 1) {
    if (prices.length < 2) return null;
    
    // Calculate log returns
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push(logReturn(prices[i - 1], prices[i]));
    }
    
    // Calculate standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Annualize
    return annualize(stdDev / Math.sqrt(intervalSec));
}

/**
 * Calculate Parkinson volatility using high/low range
 * More efficient estimator than close-to-close (uses more information)
 * 
 * @param {Array<{high: number, low: number}>} bars - Array of high/low data
 * @param {number} intervalSec - Time interval between bars
 * @returns {number} Annualized volatility
 */
function parkinsonVolatility(bars, intervalSec = 1) {
    if (bars.length < 1) return null;
    
    const ln2 = Math.log(2);
    const n = bars.length;
    
    let sum = 0;
    for (const bar of bars) {
        if (bar.high > 0 && bar.low > 0) {
            const ratio = Math.log(bar.high / bar.low);
            sum += ratio * ratio;
        }
    }
    
    // Parkinson formula: σ² = (1 / 4*n*ln(2)) * Σ(ln(H/L))²
    const variance = sum / (4 * n * ln2);
    const stdDev = Math.sqrt(variance);
    
    return annualize(stdDev / Math.sqrt(intervalSec));
}

/**
 * Calculate EWMA (Exponentially Weighted Moving Average) volatility
 * More responsive to recent changes
 * 
 * @param {number[]} prices - Array of prices
 * @param {number} lambda - Decay factor (0.94 is common for daily, lower for intraday)
 * @param {number} intervalSec - Time interval between observations
 * @returns {number} Annualized volatility
 */
function ewmaVolatility(prices, lambda = 0.94, intervalSec = 1) {
    if (prices.length < 2) return null;
    
    // Calculate log returns
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push(logReturn(prices[i - 1], prices[i]));
    }
    
    if (returns.length === 0) return null;
    
    // Initialize variance with first return squared
    let variance = returns[0] * returns[0];
    
    // EWMA update: σ²(t) = λ * σ²(t-1) + (1-λ) * r²(t)
    for (let i = 1; i < returns.length; i++) {
        variance = lambda * variance + (1 - lambda) * returns[i] * returns[i];
    }
    
    const stdDev = Math.sqrt(variance);
    return annualize(stdDev / Math.sqrt(intervalSec));
}

/**
 * Main VolatilityEstimator class
 * Maintains rolling windows and computes multiple vol estimates
 */
export class VolatilityEstimator {
    constructor(options = {}) {
        this.options = {
            shortWindow: 10,      // 10 observations for short-term
            mediumWindow: 30,     // 30 observations for medium-term
            longWindow: 60,       // 60 observations for long-term
            ewmaLambda: 0.90,     // EWMA decay factor (lower = more responsive)
            intervalSec: 1,       // Default interval between observations
            ...options
        };
        
        // State per crypto
        this.state = {};
    }
    
    /**
     * Initialize state for a crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                prices: [],
                spotPrices: [],
                highs: [],
                lows: [],
                timestamps: [],
                windowEpoch: null,
                
                // Cached calculations
                cachedVols: null,
                lastCalcTime: 0
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Reset state for new window
     */
    resetWindow(crypto, epoch) {
        const state = this.initCrypto(crypto);
        state.windowEpoch = epoch;
        state.prices = [];
        state.spotPrices = [];
        state.highs = [];
        state.lows = [];
        state.timestamps = [];
        state.cachedVols = null;
    }
    
    /**
     * Update with new tick data
     */
    update(tick) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        // Check for window change
        if (state.windowEpoch !== tick.epoch && tick.epoch) {
            this.resetWindow(crypto, tick.epoch);
        }
        
        const upPrice = tick.up_mid || 0.5;
        const spotPrice = tick.spot_price;
        const timestamp = tick.timestamp || Date.now();
        
        // Update price history
        state.prices.push(upPrice);
        state.timestamps.push(timestamp);
        
        if (spotPrice) {
            state.spotPrices.push(spotPrice);
        }
        
        // Track high/low for Parkinson
        // Group into 5-second bars for efficiency
        const barIndex = Math.floor(state.prices.length / 5);
        if (!state.highs[barIndex]) {
            state.highs[barIndex] = upPrice;
            state.lows[barIndex] = upPrice;
        } else {
            state.highs[barIndex] = Math.max(state.highs[barIndex], upPrice);
            state.lows[barIndex] = Math.min(state.lows[barIndex], upPrice);
        }
        
        // Trim to max history
        const maxLen = this.options.longWindow * 2;
        if (state.prices.length > maxLen) {
            state.prices.shift();
            state.timestamps.shift();
        }
        if (state.spotPrices.length > maxLen) {
            state.spotPrices.shift();
        }
        
        // Invalidate cache
        state.cachedVols = null;
    }
    
    /**
     * Get all volatility estimates
     */
    getVolatilities(crypto) {
        const state = this.state[crypto];
        if (!state) return null;
        
        // Use cache if recent
        if (state.cachedVols && Date.now() - state.lastCalcTime < 500) {
            return state.cachedVols;
        }
        
        const prices = state.prices;
        const spots = state.spotPrices;
        const n = prices.length;
        const ns = spots.length;
        
        // Calculate volatilities at different windows
        const result = {
            crypto,
            timestamp: Date.now(),
            sampleCount: n,
            
            // Market price (up_mid) volatility
            realized_10: n >= this.options.shortWindow 
                ? realizedVolatility(prices.slice(-this.options.shortWindow), this.options.intervalSec) 
                : null,
            realized_30: n >= this.options.mediumWindow 
                ? realizedVolatility(prices.slice(-this.options.mediumWindow), this.options.intervalSec) 
                : null,
            realized_60: n >= this.options.longWindow 
                ? realizedVolatility(prices.slice(-this.options.longWindow), this.options.intervalSec) 
                : null,
            
            // EWMA volatility
            ewma: n >= this.options.shortWindow 
                ? ewmaVolatility(prices.slice(-this.options.mediumWindow), this.options.ewmaLambda, this.options.intervalSec) 
                : null,
            
            // Parkinson (using high/low bars)
            parkinson: null,  // Calculated below
            
            // Spot price volatility
            spot_realized_10: ns >= this.options.shortWindow 
                ? realizedVolatility(spots.slice(-this.options.shortWindow), this.options.intervalSec) 
                : null,
            spot_realized_30: ns >= this.options.mediumWindow 
                ? realizedVolatility(spots.slice(-this.options.mediumWindow), this.options.intervalSec) 
                : null,
            spot_realized_60: ns >= this.options.longWindow 
                ? realizedVolatility(spots.slice(-this.options.longWindow), this.options.intervalSec) 
                : null,
            
            spot_ewma: ns >= this.options.shortWindow 
                ? ewmaVolatility(spots.slice(-this.options.mediumWindow), this.options.ewmaLambda, this.options.intervalSec) 
                : null
        };
        
        // Calculate Parkinson if we have enough bars
        if (state.highs.length >= 3) {
            const bars = [];
            for (let i = Math.max(0, state.highs.length - 10); i < state.highs.length; i++) {
                if (state.highs[i] && state.lows[i]) {
                    bars.push({ high: state.highs[i], low: state.lows[i] });
                }
            }
            if (bars.length >= 2) {
                result.parkinson = parkinsonVolatility(bars, 5); // 5-second bars
            }
        }
        
        // Best estimate (weighted average of available estimators)
        const estimates = [result.realized_30, result.ewma, result.parkinson].filter(v => v !== null);
        result.bestEstimate = estimates.length > 0 
            ? estimates.reduce((a, b) => a + b, 0) / estimates.length 
            : null;
        
        // Volatility ratio (short/long) - high ratio suggests vol is increasing
        if (result.realized_10 && result.realized_60 && result.realized_60 > 0) {
            result.volRatio = result.realized_10 / result.realized_60;
        } else {
            result.volRatio = null;
        }
        
        // Cache result
        state.cachedVols = result;
        state.lastCalcTime = Date.now();
        
        return result;
    }
    
    /**
     * Get the best single volatility estimate for fair value calculation
     */
    getBestEstimate(crypto) {
        const vols = this.getVolatilities(crypto);
        if (!vols) return 0.8; // Default 80% annualized for crypto
        
        // Prefer spot volatility for fair value (it's what matters for outcome)
        if (vols.spot_realized_30 !== null) {
            return vols.spot_realized_30;
        }
        if (vols.spot_ewma !== null) {
            return vols.spot_ewma;
        }
        if (vols.bestEstimate !== null) {
            return vols.bestEstimate;
        }
        
        return 0.8; // Default fallback
    }
    
    /**
     * Get state summary
     */
    getSummary(crypto) {
        const vols = this.getVolatilities(crypto);
        if (!vols) return null;
        
        return {
            crypto,
            sampleCount: vols.sampleCount,
            bestEstimate: vols.bestEstimate,
            spotVol: vols.spot_realized_30,
            marketVol: vols.realized_30,
            volRatio: vols.volRatio,
            isVolIncreasing: vols.volRatio !== null && vols.volRatio > 1.2
        };
    }
}

// Export functions and class
export {
    logReturn,
    annualize,
    realizedVolatility,
    parkinsonVolatility,
    ewmaVolatility
};

export default VolatilityEstimator;
