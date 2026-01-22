/**
 * Real-time Feature Engineering Engine
 * 
 * Computes 50+ features from raw tick data for ML training.
 * Features are designed to capture:
 * - Momentum at multiple timeframes
 * - Mean reversion signals
 * - Order book microstructure
 * - Spot-market relationships
 * - Time decay patterns
 */

import * as ss from 'simple-statistics';

export class FeatureEngine {
    constructor(options = {}) {
        this.options = {
            maxHistory: 120,            // Keep 2 minutes of tick history
            ...options
        };
        
        // Per-crypto state
        this.state = {};
    }
    
    /**
     * Initialize state for a crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                ticks: [],              // Raw tick history
                upPrices: [],           // up_mid history
                spotPrices: [],         // spot_price history
                returns: [],            // Tick-to-tick returns
                spotReturns: [],        // Spot returns
                volumes: [],            // Volume history
                spreads: [],            // Spread history
                timestamps: [],         // Timestamps
                windowEpoch: null,      // Current window
                tradeCount: 0,
                lastFeatures: null
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
        state.ticks = [];
        state.upPrices = [];
        state.spotPrices = [];
        state.returns = [];
        state.spotReturns = [];
        state.volumes = [];
        state.spreads = [];
        state.timestamps = [];
        state.tradeCount = 0;
    }
    
    /**
     * Process a tick and compute all features
     */
    computeFeatures(tick) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        // Check for window change
        if (state.windowEpoch !== tick.epoch && tick.epoch) {
            this.resetWindow(crypto, tick.epoch);
        }
        
        // Update history
        this.updateHistory(state, tick);
        
        // Compute features
        const features = {
            timestamp_ms: tick.timestamp || Date.now(),
            crypto: crypto,
            window_epoch: tick.epoch,
            
            // Price momentum features
            ...this.computeMomentumFeatures(state),
            
            // Moving average features
            ...this.computeMAFeatures(state),
            
            // Volatility features
            ...this.computeVolatilityFeatures(state),
            
            // Order book features
            ...this.computeOrderBookFeatures(tick, state),
            
            // Spot-market relationship features
            ...this.computeSpotMarketFeatures(tick, state),
            
            // Time features
            ...this.computeTimeFeatures(tick),
            
            // Technical indicators
            ...this.computeTechnicalIndicators(state),
            
            // Autocorrelation features
            ...this.computeAutocorrFeatures(state)
        };
        
        state.lastFeatures = features;
        return features;
    }
    
    /**
     * Update price/return history
     */
    updateHistory(state, tick) {
        const upPrice = tick.up_mid || 0.5;
        const spotPrice = tick.spot_price;
        const spread = tick.spread || 0;
        const timestamp = tick.timestamp || Date.now();
        
        // Store raw tick
        state.ticks.push(tick);
        state.timestamps.push(timestamp);
        state.upPrices.push(upPrice);
        state.spreads.push(spread);
        
        if (spotPrice) {
            state.spotPrices.push(spotPrice);
        }
        
        // Compute returns
        if (state.upPrices.length > 1) {
            const prevPrice = state.upPrices[state.upPrices.length - 2];
            const ret = prevPrice > 0 ? (upPrice - prevPrice) / prevPrice : 0;
            state.returns.push(ret);
        }
        
        if (state.spotPrices.length > 1) {
            const prevSpot = state.spotPrices[state.spotPrices.length - 2];
            const spotRet = prevSpot > 0 ? (spotPrice - prevSpot) / prevSpot : 0;
            state.spotReturns.push(spotRet);
        }
        
        // Trim to max history
        const maxLen = this.options.maxHistory;
        if (state.ticks.length > maxLen) {
            state.ticks.shift();
            state.timestamps.shift();
            state.upPrices.shift();
            state.spreads.shift();
            if (state.returns.length > maxLen - 1) state.returns.shift();
        }
        if (state.spotPrices.length > maxLen) {
            state.spotPrices.shift();
            if (state.spotReturns.length > maxLen - 1) state.spotReturns.shift();
        }
    }
    
    /**
     * Momentum features at multiple timeframes
     */
    computeMomentumFeatures(state) {
        const prices = state.upPrices;
        const spots = state.spotPrices;
        const n = prices.length;
        const ns = spots.length;
        
        const current = prices[n - 1] || 0.5;
        const currentSpot = spots[ns - 1] || 0;
        
        return {
            // Price momentum (up_mid returns)
            price_return_5t: n > 5 ? (current - prices[n - 6]) / prices[n - 6] : null,
            price_return_10t: n > 10 ? (current - prices[n - 11]) / prices[n - 11] : null,
            price_return_30t: n > 30 ? (current - prices[n - 31]) / prices[n - 31] : null,
            price_return_60t: n > 60 ? (current - prices[n - 61]) / prices[n - 61] : null,
            
            // Spot momentum
            spot_return_5t: ns > 5 && spots[ns - 6] ? (currentSpot - spots[ns - 6]) / spots[ns - 6] : null,
            spot_return_10t: ns > 10 && spots[ns - 11] ? (currentSpot - spots[ns - 11]) / spots[ns - 11] : null,
            spot_return_30t: ns > 30 && spots[ns - 31] ? (currentSpot - spots[ns - 31]) / spots[ns - 31] : null
        };
    }
    
    /**
     * Moving average features
     */
    computeMAFeatures(state) {
        const prices = state.upPrices;
        const n = prices.length;
        const current = prices[n - 1] || 0.5;
        
        // Simple moving averages
        const sma10 = n >= 10 ? ss.mean(prices.slice(-10)) : null;
        const sma20 = n >= 20 ? ss.mean(prices.slice(-20)) : null;
        
        // Exponential moving averages
        const ema10 = this.ema(prices, 10);
        const ema20 = this.ema(prices, 20);
        
        // Price vs MA (z-score style)
        let priceVsSma10 = null;
        let priceVsSma20 = null;
        
        if (sma10 && n >= 10) {
            const std10 = ss.standardDeviation(prices.slice(-10));
            priceVsSma10 = std10 > 0 ? (current - sma10) / std10 : 0;
        }
        
        if (sma20 && n >= 20) {
            const std20 = ss.standardDeviation(prices.slice(-20));
            priceVsSma20 = std20 > 0 ? (current - sma20) / std20 : 0;
        }
        
        return {
            up_price_sma_10: sma10,
            up_price_sma_20: sma20,
            up_price_ema_10: ema10,
            up_price_ema_20: ema20,
            up_price_vs_sma_10: priceVsSma10,
            up_price_vs_sma_20: priceVsSma20
        };
    }
    
    /**
     * Volatility features
     */
    computeVolatilityFeatures(state) {
        const returns = state.returns;
        const spotReturns = state.spotReturns;
        
        // Rolling volatility of returns
        const vol10 = returns.length >= 10 ? ss.standardDeviation(returns.slice(-10)) : null;
        const vol30 = returns.length >= 30 ? ss.standardDeviation(returns.slice(-30)) : null;
        
        const spotVol10 = spotReturns.length >= 10 ? ss.standardDeviation(spotReturns.slice(-10)) : null;
        const spotVol30 = spotReturns.length >= 30 ? ss.standardDeviation(spotReturns.slice(-30)) : null;
        
        // Volatility ratio (short/long)
        const volRatio = vol10 && vol30 && vol30 > 0 ? vol10 / vol30 : null;
        
        return {
            price_volatility_10t: vol10,
            price_volatility_30t: vol30,
            spot_volatility_10t: spotVol10,
            spot_volatility_30t: spotVol30,
            volatility_ratio: volRatio
        };
    }
    
    /**
     * Order book microstructure features
     */
    computeOrderBookFeatures(tick, state) {
        const bidSize = tick.up_bid_size || 0;
        const askSize = tick.up_ask_size || 0;
        const bid = tick.up_bid || 0;
        const ask = tick.up_ask || 1;
        const mid = tick.up_mid || 0.5;
        const spread = tick.spread || (ask - bid);
        
        // Spread in basis points
        const spreadBps = mid > 0 ? (spread / mid) * 10000 : null;
        
        // Spread vs rolling average
        const spreads = state.spreads;
        const avgSpread = spreads.length >= 10 ? ss.mean(spreads.slice(-10)) : spread;
        const spreadVsAvg = avgSpread > 0 ? spread / avgSpread : 1;
        
        // Bid-ask imbalance
        const totalSize = bidSize + askSize;
        const imbalance = totalSize > 0 ? (bidSize - askSize) / totalSize : 0;
        
        // Microprice (size-weighted mid)
        const microprice = totalSize > 0 
            ? (bid * askSize + ask * bidSize) / totalSize 
            : mid;
        
        return {
            spread_bps: spreadBps,
            spread_vs_avg: spreadVsAvg,
            bid_ask_imbalance: imbalance,
            bid_depth_5: bidSize,       // Would be sum if we had depth
            ask_depth_5: askSize,
            depth_imbalance_5: imbalance,
            weighted_mid_price: mid,
            microprice: microprice
        };
    }
    
    /**
     * Spot-market relationship features
     */
    computeSpotMarketFeatures(tick, state) {
        const spotDelta = tick.spot_delta_pct || 0;
        const upMid = tick.up_mid || 0.5;
        const priceToBeat = tick.price_to_beat || tick.spot_price;
        const spotPrice = tick.spot_price;
        
        // Spot delta z-score (normalized by volatility)
        const spotReturns = state.spotReturns;
        const spotVol = spotReturns.length >= 10 
            ? ss.standardDeviation(spotReturns.slice(-10)) 
            : 0.001;
        const spotDeltaZscore = spotVol > 0 ? spotDelta / spotVol : 0;
        
        // Spot-market divergence
        // If spot says up (delta > 0) but market says down (upMid < 0.5), divergence
        const spotDirection = spotDelta > 0 ? 1 : -1;
        const marketDirection = upMid > 0.5 ? 1 : -1;
        const divergence = spotDirection !== marketDirection ? 1 : 0;
        
        // Spot lead signal - is spot moving before market?
        // Compare spot momentum vs market momentum
        const spotMom = state.spotReturns.length > 5 
            ? ss.sum(state.spotReturns.slice(-5)) 
            : 0;
        const priceMom = state.returns.length > 5 
            ? ss.sum(state.returns.slice(-5)) 
            : 0;
        const spotLeadSignal = spotMom !== 0 && Math.sign(spotMom) !== Math.sign(priceMom) 
            ? spotMom 
            : 0;
        
        // Distance from price to beat
        const ptbDistance = priceToBeat > 0 
            ? (spotPrice - priceToBeat) / priceToBeat 
            : 0;
        
        return {
            spot_delta_zscore: spotDeltaZscore,
            spot_market_divergence: divergence,
            spot_lead_signal: spotLeadSignal,
            price_to_beat_distance: ptbDistance
        };
    }
    
    /**
     * Time-based features
     */
    computeTimeFeatures(tick) {
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowDuration = 900; // 15 minutes
        
        // Time remaining as percentage
        const timePct = timeRemaining / windowDuration;
        
        // Time phase
        let phase;
        if (timeRemaining > 600) {
            phase = 1;  // Early (>10 min)
        } else if (timeRemaining > 180) {
            phase = 2;  // Mid (3-10 min)
        } else {
            phase = 3;  // Late (<3 min)
        }
        
        return {
            time_remaining_pct: timePct,
            time_phase: phase,
            seconds_since_last_trade: null  // Would need trade data
        };
    }
    
    /**
     * Technical indicators
     */
    computeTechnicalIndicators(state) {
        const prices = state.upPrices;
        const n = prices.length;
        
        // RSI (14 periods)
        let rsi = null;
        if (n >= 15) {
            const gains = [];
            const losses = [];
            for (let i = n - 14; i < n; i++) {
                const change = prices[i] - prices[i - 1];
                gains.push(change > 0 ? change : 0);
                losses.push(change < 0 ? -change : 0);
            }
            const avgGain = ss.mean(gains);
            const avgLoss = ss.mean(losses);
            rsi = avgLoss > 0 ? 100 - (100 / (1 + avgGain / avgLoss)) : 100;
        }
        
        // Bollinger position (-1 to 1)
        let bollingerPos = null;
        if (n >= 20) {
            const slice = prices.slice(-20);
            const ma = ss.mean(slice);
            const std = ss.standardDeviation(slice);
            const current = prices[n - 1];
            if (std > 0) {
                bollingerPos = (current - ma) / (2 * std);
                bollingerPos = Math.max(-1, Math.min(1, bollingerPos));
            }
        }
        
        // MACD (simplified - just the signal)
        let macdSignal = null;
        if (n >= 26) {
            const ema12 = this.ema(prices, 12);
            const ema26 = this.ema(prices, 26);
            if (ema12 && ema26) {
                macdSignal = ema12 - ema26;
            }
        }
        
        return {
            rsi_14: rsi,
            macd_signal: macdSignal,
            bollinger_position: bollingerPos
        };
    }
    
    /**
     * Autocorrelation features
     */
    computeAutocorrFeatures(state) {
        const returns = state.returns;
        
        let acf1 = null;
        let acf5 = null;
        
        if (returns.length >= 20) {
            acf1 = this.autocorrelation(returns, 1);
            acf5 = this.autocorrelation(returns, 5);
        }
        
        // Mean reversion signal: negative autocorr suggests mean reversion
        const meanRevSignal = acf1 !== null ? -acf1 : null;
        
        return {
            return_autocorr_1: acf1,
            return_autocorr_5: acf5,
            mean_reversion_signal: meanRevSignal
        };
    }
    
    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    
    /**
     * Exponential moving average
     */
    ema(data, span) {
        if (data.length < span) return null;
        
        const alpha = 2 / (span + 1);
        let ema = data[0];
        
        for (let i = 1; i < data.length; i++) {
            ema = alpha * data[i] + (1 - alpha) * ema;
        }
        
        return ema;
    }
    
    /**
     * Autocorrelation at lag k
     */
    autocorrelation(data, lag = 1) {
        if (data.length <= lag) return 0;
        
        const mean = ss.mean(data);
        const variance = ss.variance(data);
        
        if (variance === 0) return 0;
        
        let sum = 0;
        for (let i = lag; i < data.length; i++) {
            sum += (data[i] - mean) * (data[i - lag] - mean);
        }
        
        return sum / ((data.length - lag) * variance);
    }
    
    /**
     * Get current state for a crypto (for debugging)
     */
    getState(crypto) {
        return this.state[crypto] || null;
    }
    
    /**
     * Get feature summary (for quick logging)
     */
    getFeatureSummary(features) {
        if (!features) return null;
        
        return {
            momentum_5t: features.price_return_5t?.toFixed(4),
            momentum_30t: features.price_return_30t?.toFixed(4),
            volatility: features.price_volatility_10t?.toFixed(4),
            imbalance: features.bid_ask_imbalance?.toFixed(3),
            spot_zscore: features.spot_delta_zscore?.toFixed(2),
            rsi: features.rsi_14?.toFixed(1),
            time_phase: features.time_phase
        };
    }
}

// Singleton instance
let featureEngine = null;

export function getFeatureEngine() {
    if (!featureEngine) {
        featureEngine = new FeatureEngine();
    }
    return featureEngine;
}

export default FeatureEngine;
