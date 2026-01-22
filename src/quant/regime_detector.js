/**
 * Market Regime Detector
 * 
 * Identifies current market regime to conditionally apply strategies.
 * 
 * Regimes:
 * 1. Volatility Regime: LOW, MEDIUM, HIGH
 * 2. Trend Regime: TRENDING_UP, TRENDING_DOWN, RANGING
 * 3. Liquidity Regime: THIN, NORMAL, THICK
 * 
 * Different strategies work better in different regimes:
 * - HIGH_VOL + TRENDING: Momentum strategies
 * - LOW_VOL + RANGING: Mean reversion strategies
 * - HIGH_VOL + CHOPPY: Reduce exposure
 */

/**
 * Main RegimeDetector class
 */
export class RegimeDetector {
    constructor(options = {}) {
        this.options = {
            // Volatility thresholds (annualized)
            lowVolThreshold: 0.3,      // Below 30% = low vol
            highVolThreshold: 0.8,     // Above 80% = high vol
            
            // Trend strength thresholds
            trendThreshold: 0.02,      // 2% move over window = trending
            strongTrendThreshold: 0.05, // 5% = strong trend
            
            // Liquidity thresholds (spread in basis points)
            thinLiquidityBps: 200,     // >2% spread = thin
            thickLiquidityBps: 50,     // <0.5% spread = thick
            
            // Lookback periods
            volLookback: 30,           // 30 ticks for vol calculation
            trendLookback: 20,         // 20 ticks for trend calculation
            
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
                spreads: [],
                timestamps: [],
                windowEpoch: null,
                lastRegime: null
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
        // Keep some history for regime continuity
        state.prices = state.prices.slice(-10);
        state.spotPrices = state.spotPrices.slice(-10);
        state.spreads = state.spreads.slice(-10);
        state.timestamps = state.timestamps.slice(-10);
    }
    
    /**
     * Update with new tick
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
        const spread = tick.spread || (tick.up_ask - tick.up_bid) || 0;
        const timestamp = tick.timestamp || Date.now();
        
        // Update history
        state.prices.push(upPrice);
        state.timestamps.push(timestamp);
        if (spotPrice) state.spotPrices.push(spotPrice);
        state.spreads.push(spread);
        
        // Trim history
        const maxLen = Math.max(this.options.volLookback, this.options.trendLookback) * 2;
        if (state.prices.length > maxLen) {
            state.prices.shift();
            state.timestamps.shift();
        }
        if (state.spotPrices.length > maxLen) {
            state.spotPrices.shift();
        }
        if (state.spreads.length > maxLen) {
            state.spreads.shift();
        }
    }
    
    /**
     * Detect current regime
     */
    detectRegime(crypto) {
        const state = this.state[crypto];
        if (!state || state.prices.length < 10) {
            return this.defaultRegime(crypto);
        }
        
        const prices = state.prices;
        const spots = state.spotPrices;
        const spreads = state.spreads;
        const n = prices.length;
        
        // 1. Volatility Regime
        const volRegime = this.detectVolatilityRegime(prices);
        
        // 2. Trend Regime
        const trendRegime = this.detectTrendRegime(prices, spots);
        
        // 3. Liquidity Regime
        const liquidityRegime = this.detectLiquidityRegime(spreads);
        
        // Combined regime classification
        const combined = this.classifyCombinedRegime(volRegime, trendRegime, liquidityRegime);
        
        const regime = {
            crypto,
            timestamp: Date.now(),
            
            // Individual regimes
            volatility: volRegime,
            trend: trendRegime,
            liquidity: liquidityRegime,
            
            // Combined regime
            combined,
            
            // Regime change detection
            changed: state.lastRegime !== null && state.lastRegime.combined !== combined,
            previousCombined: state.lastRegime?.combined || null,
            
            // Metrics
            metrics: {
                realizedVol: volRegime.value,
                trendStrength: trendRegime.strength,
                avgSpreadBps: liquidityRegime.avgSpreadBps
            }
        };
        
        // Update last regime
        state.lastRegime = regime;
        
        return regime;
    }
    
    /**
     * Detect volatility regime
     */
    detectVolatilityRegime(prices) {
        if (prices.length < this.options.volLookback) {
            return { regime: 'UNKNOWN', value: null };
        }
        
        const recentPrices = prices.slice(-this.options.volLookback);
        
        // Calculate realized volatility (annualized)
        const returns = [];
        for (let i = 1; i < recentPrices.length; i++) {
            if (recentPrices[i - 1] > 0) {
                returns.push(Math.log(recentPrices[i] / recentPrices[i - 1]));
            }
        }
        
        if (returns.length < 5) {
            return { regime: 'UNKNOWN', value: null };
        }
        
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        
        // Annualize (assuming 1-second intervals, 365*24*3600 seconds/year)
        const annualizedVol = stdDev * Math.sqrt(365 * 24 * 3600);
        
        let regime;
        if (annualizedVol < this.options.lowVolThreshold) {
            regime = 'LOW';
        } else if (annualizedVol > this.options.highVolThreshold) {
            regime = 'HIGH';
        } else {
            regime = 'MEDIUM';
        }
        
        return { regime, value: annualizedVol };
    }
    
    /**
     * Detect trend regime
     */
    detectTrendRegime(prices, spots) {
        if (prices.length < this.options.trendLookback) {
            return { regime: 'UNKNOWN', strength: 0, direction: null };
        }
        
        const recentPrices = prices.slice(-this.options.trendLookback);
        const firstPrice = recentPrices[0];
        const lastPrice = recentPrices[recentPrices.length - 1];
        
        // Price trend
        const priceChange = (lastPrice - firstPrice) / firstPrice;
        
        // Spot trend (if available)
        let spotChange = 0;
        if (spots.length >= this.options.trendLookback) {
            const recentSpots = spots.slice(-this.options.trendLookback);
            spotChange = (recentSpots[recentSpots.length - 1] - recentSpots[0]) / recentSpots[0];
        }
        
        // Combine signals
        const combinedStrength = Math.abs(priceChange);
        
        let regime;
        let direction = null;
        
        if (combinedStrength > this.options.strongTrendThreshold) {
            regime = 'STRONG_TREND';
            direction = priceChange > 0 ? 'up' : 'down';
        } else if (combinedStrength > this.options.trendThreshold) {
            regime = 'TRENDING';
            direction = priceChange > 0 ? 'up' : 'down';
        } else {
            regime = 'RANGING';
        }
        
        return { 
            regime, 
            strength: combinedStrength, 
            direction,
            priceChange,
            spotChange
        };
    }
    
    /**
     * Detect liquidity regime
     */
    detectLiquidityRegime(spreads) {
        if (spreads.length < 5) {
            return { regime: 'UNKNOWN', avgSpreadBps: null };
        }
        
        const recentSpreads = spreads.slice(-10);
        const avgSpread = recentSpreads.reduce((a, b) => a + b, 0) / recentSpreads.length;
        const avgSpreadBps = avgSpread * 10000;  // Convert to basis points
        
        let regime;
        if (avgSpreadBps > this.options.thinLiquidityBps) {
            regime = 'THIN';
        } else if (avgSpreadBps < this.options.thickLiquidityBps) {
            regime = 'THICK';
        } else {
            regime = 'NORMAL';
        }
        
        return { regime, avgSpreadBps };
    }
    
    /**
     * Classify combined regime for strategy selection
     */
    classifyCombinedRegime(volRegime, trendRegime, liquidityRegime) {
        const vol = volRegime.regime;
        const trend = trendRegime.regime;
        const liquidity = liquidityRegime.regime;
        
        // High priority: Thin liquidity = caution
        if (liquidity === 'THIN') {
            return 'CAUTION_THIN_LIQUIDITY';
        }
        
        // High vol + Strong trend = Momentum opportunity
        if (vol === 'HIGH' && (trend === 'STRONG_TREND' || trend === 'TRENDING')) {
            return 'MOMENTUM_FAVORABLE';
        }
        
        // High vol + Ranging = Choppy, stay out
        if (vol === 'HIGH' && trend === 'RANGING') {
            return 'CHOPPY_AVOID';
        }
        
        // Low vol + Ranging = Mean reversion opportunity
        if (vol === 'LOW' && trend === 'RANGING') {
            return 'MEAN_REVERSION_FAVORABLE';
        }
        
        // Medium vol + Trending = Follow trend
        if (vol === 'MEDIUM' && (trend === 'STRONG_TREND' || trend === 'TRENDING')) {
            return 'TREND_FOLLOWING';
        }
        
        // Default
        return 'NEUTRAL';
    }
    
    /**
     * Get strategy recommendations based on regime
     */
    getStrategyRecommendation(crypto) {
        const regime = this.detectRegime(crypto);
        
        const recommendations = {
            'MOMENTUM_FAVORABLE': {
                strategies: ['SpotLag', 'CrossAsset'],
                sizing: 1.0,
                description: 'High vol + trending: Use momentum strategies at full size'
            },
            'MEAN_REVERSION_FAVORABLE': {
                strategies: ['FairValue', 'TimeConditional'],
                sizing: 1.0,
                description: 'Low vol + ranging: Use mean reversion strategies at full size'
            },
            'TREND_FOLLOWING': {
                strategies: ['SpotLag', 'TimeConditional'],
                sizing: 0.8,
                description: 'Medium vol + trending: Follow trends with moderate size'
            },
            'CHOPPY_AVOID': {
                strategies: [],
                sizing: 0.3,
                description: 'High vol + ranging: Reduce exposure, choppy conditions'
            },
            'CAUTION_THIN_LIQUIDITY': {
                strategies: ['FairValue'],
                sizing: 0.5,
                description: 'Thin liquidity: Only high-conviction trades at reduced size'
            },
            'NEUTRAL': {
                strategies: ['FairValue', 'TimeConditional', 'Microstructure'],
                sizing: 0.7,
                description: 'Neutral conditions: Use diversified strategies'
            }
        };
        
        return {
            regime,
            recommendation: recommendations[regime.combined] || recommendations['NEUTRAL']
        };
    }
    
    /**
     * Default regime when insufficient data
     */
    defaultRegime(crypto) {
        return {
            crypto,
            timestamp: Date.now(),
            volatility: { regime: 'UNKNOWN', value: null },
            trend: { regime: 'UNKNOWN', strength: 0, direction: null },
            liquidity: { regime: 'UNKNOWN', avgSpreadBps: null },
            combined: 'NEUTRAL',
            changed: false,
            previousCombined: null,
            metrics: {}
        };
    }
}

export default RegimeDetector;
