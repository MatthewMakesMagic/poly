/**
 * Real-time Prediction Engine
 * 
 * Generates predictions based on:
 * - Current market state
 * - Historical patterns
 * - Spot price momentum
 */

import { getDatabase } from '../db/connection.js';
import { autocorrelation, crossCorrelation } from './metrics.js';

export class Predictor {
    constructor() {
        this.predictions = {};
        this.confidence = {};
    }
    
    /**
     * Generate prediction for current window
     */
    predict(tick, history = []) {
        const crypto = tick.crypto;
        
        // Feature extraction
        const features = this.extractFeatures(tick, history);
        
        // Generate prediction
        const prediction = this.generatePrediction(features);
        
        // Store prediction
        this.predictions[crypto] = {
            ...prediction,
            crypto,
            timestamp: Date.now(),
            upPrice: tick.up_mid,
            downPrice: 1 - tick.up_mid,
            spotPrice: tick.spot_price,
            timeRemaining: tick.time_remaining_sec
        };
        
        return this.predictions[crypto];
    }
    
    /**
     * Extract features from tick and history
     */
    extractFeatures(tick, history) {
        const features = {
            // Current state
            upPrice: tick.up_mid,
            spotDelta: tick.spot_delta_pct || 0,
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread_pct || 0,
            
            // Default values
            priceReturn: 0,
            spotMomentum: 0,
            priceVolatility: 0,
            recentAutocorr: 0
        };
        
        if (history.length < 10) {
            return features;
        }
        
        // Price return over last N ticks
        const oldPrice = history[0].up_mid;
        const newPrice = tick.up_mid;
        features.priceReturn = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;
        
        // Spot price momentum
        const oldSpot = history[0].spot_price;
        const newSpot = tick.spot_price;
        features.spotMomentum = oldSpot > 0 ? (newSpot - oldSpot) / oldSpot : 0;
        
        // Price volatility
        const prices = history.map(h => h.up_mid).filter(p => p > 0);
        if (prices.length > 1) {
            const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
            const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
            features.priceVolatility = Math.sqrt(variance);
        }
        
        // Recent autocorrelation (mean reversion signal)
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1] > 0) {
                returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
            }
        }
        if (returns.length > 5) {
            features.recentAutocorr = autocorrelation(returns, 1);
        }
        
        return features;
    }
    
    /**
     * Generate prediction from features
     */
    generatePrediction(features) {
        // Simple ensemble of signals
        const signals = [];
        
        // Signal 1: Spot momentum (if BTC is up, market likely to resolve up)
        if (Math.abs(features.spotMomentum) > 0.0005) {
            signals.push({
                name: 'spot_momentum',
                direction: features.spotMomentum > 0 ? 'up' : 'down',
                strength: Math.min(Math.abs(features.spotMomentum) * 100, 1),
                weight: 0.4
            });
        }
        
        // Signal 2: Current spot delta (if BTC above start price, likely up)
        if (Math.abs(features.spotDelta) > 0.01) {
            signals.push({
                name: 'spot_delta',
                direction: features.spotDelta > 0 ? 'up' : 'down',
                strength: Math.min(Math.abs(features.spotDelta) / 0.1, 1),
                weight: 0.3
            });
        }
        
        // Signal 3: Market price (market's implied probability)
        if (Math.abs(features.upPrice - 0.5) > 0.05) {
            signals.push({
                name: 'market_price',
                direction: features.upPrice > 0.5 ? 'up' : 'down',
                strength: Math.abs(features.upPrice - 0.5) * 2,
                weight: 0.2
            });
        }
        
        // Signal 4: Mean reversion (if autocorr is negative, fade recent move)
        if (features.recentAutocorr < -0.1 && Math.abs(features.priceReturn) > 0.01) {
            signals.push({
                name: 'mean_reversion',
                direction: features.priceReturn > 0 ? 'down' : 'up',
                strength: Math.min(Math.abs(features.recentAutocorr), 0.5),
                weight: 0.1
            });
        }
        
        // Combine signals
        let upScore = 0;
        let downScore = 0;
        let totalWeight = 0;
        
        for (const signal of signals) {
            const score = signal.strength * signal.weight;
            if (signal.direction === 'up') {
                upScore += score;
            } else {
                downScore += score;
            }
            totalWeight += signal.weight;
        }
        
        // Normalize
        if (totalWeight > 0) {
            upScore /= totalWeight;
            downScore /= totalWeight;
        }
        
        // Determine outcome
        const netScore = upScore - downScore;
        const outcome = netScore >= 0 ? 'up' : 'down';
        const confidence = Math.abs(netScore) / (upScore + downScore + 0.001);
        
        // Adjust confidence based on time remaining
        // More confident as we get closer to resolution
        const timeWeight = 1 - (features.timeRemaining / 900);
        const adjustedConfidence = confidence * (0.5 + 0.5 * timeWeight);
        
        return {
            outcome,
            confidence: Math.min(adjustedConfidence, 0.95),
            upScore,
            downScore,
            signals,
            features
        };
    }
    
    /**
     * Get current prediction for a crypto
     */
    getPrediction(crypto) {
        return this.predictions[crypto] || null;
    }
    
    /**
     * Get all current predictions
     */
    getAllPredictions() {
        return Object.values(this.predictions);
    }
}

// Singleton
let predictor = null;

export function getPredictor() {
    if (!predictor) {
        predictor = new Predictor();
    }
    return predictor;
}

export default Predictor;

