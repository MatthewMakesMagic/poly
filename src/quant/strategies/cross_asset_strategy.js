/**
 * Cross-Asset Strategy
 * 
 * Uses BTC as a leading indicator for ETH, SOL, XRP.
 * 
 * Hypothesis: BTC often leads altcoin movements. When BTC moves
 * significantly, alts follow with a lag, creating opportunity.
 * 
 * This strategy:
 * 1. Monitors BTC spot price movements
 * 2. When BTC moves significantly, checks if alt markets have reacted
 * 3. Trades alts that haven't yet priced the BTC move
 */

import { fairProbabilityUp } from '../fair_value.js';

export class CrossAssetStrategy {
    constructor(options = {}) {
        this.name = options.name || 'CrossAsset';
        this.options = {
            // BTC movement thresholds
            btcMoveThreshold: 0.001,    // 0.1% BTC move to trigger
            btcStrongMoveThreshold: 0.003, // 0.3% = strong move
            
            // Alt response thresholds  
            altLagThreshold: 0.02,       // 2% probability lag
            
            // Lookback
            lookbackSec: 10,             // 10 second lookback for BTC move
            
            // Which alts to trade
            targetCryptos: ['eth', 'sol', 'xrp'],
            
            maxPosition: 100,
            // Smart exits - hold unless extreme conditions
            maxDrawdown: 0.30,
            minTimeRemaining: 180,
            exitTimeRemaining: 5,  // Let binary expire
            
            ...options
        };
        
        // BTC state (shared across all alts)
        this.btcState = {
            spotHistory: [],
            timestamps: []
        };
        
        // State per target crypto
        this.state = {};
        
        this.stats = {
            totalSignals: 0,
            btcLeadSignals: 0,
            cryptoSignals: {}
        };
        
        for (const crypto of this.options.targetCryptos) {
            this.stats.cryptoSignals[crypto] = 0;
        }
    }
    
    getName() {
        return this.name;
    }
    
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                marketProbHistory: [],
                spotHistory: [],
                timestamps: []
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Update BTC state
     */
    updateBTC(tick) {
        if (tick.crypto !== 'BTC' && tick.crypto !== 'btc') return;
        
        const timestamp = tick.timestamp || Date.now();
        const spotPrice = tick.spot_price;
        
        if (spotPrice) {
            this.btcState.spotHistory.push(spotPrice);
            this.btcState.timestamps.push(timestamp);
            
            // Trim history
            if (this.btcState.spotHistory.length > 30) {
                this.btcState.spotHistory.shift();
                this.btcState.timestamps.shift();
            }
        }
    }
    
    /**
     * Get BTC movement over lookback period
     */
    getBTCMovement() {
        const history = this.btcState.spotHistory;
        const timestamps = this.btcState.timestamps;
        
        if (history.length < 2) return null;
        
        const now = Date.now();
        const lookbackMs = this.options.lookbackSec * 1000;
        
        // Find price from lookback seconds ago
        let oldPrice = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (now - timestamps[i] >= lookbackMs) {
                oldPrice = history[i];
                break;
            }
        }
        
        if (!oldPrice) {
            // Use oldest available
            oldPrice = history[0];
        }
        
        const currentPrice = history[history.length - 1];
        const change = (currentPrice - oldPrice) / oldPrice;
        
        return {
            change,
            changePct: change * 100,
            direction: change > 0 ? 'up' : 'down',
            isSignificant: Math.abs(change) >= this.options.btcMoveThreshold,
            isStrong: Math.abs(change) >= this.options.btcStrongMoveThreshold
        };
    }
    
    /**
     * Process tick for a target crypto
     */
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto?.toLowerCase();
        
        // Update BTC state if this is a BTC tick
        if (crypto === 'btc') {
            this.updateBTC(tick);
            // Don't trade BTC with this strategy
            return { action: 'hold', side: null, reason: 'btc_lead_only' };
        }
        
        // Only trade target cryptos
        if (!this.options.targetCryptos.includes(crypto)) {
            return { action: 'hold', side: null, reason: 'not_target_crypto' };
        }
        
        const state = this.initCrypto(crypto);
        const marketProb = tick.up_mid || 0.5;
        const spotPrice = tick.spot_price;
        const timeRemaining = tick.time_remaining_sec || 0;
        const timestamp = tick.timestamp || Date.now();
        
        // Update state
        state.marketProbHistory.push(marketProb);
        state.timestamps.push(timestamp);
        if (spotPrice) state.spotHistory.push(spotPrice);
        
        if (state.marketProbHistory.length > 30) {
            state.marketProbHistory.shift();
            state.timestamps.shift();
        }
        if (state.spotHistory.length > 30) {
            state.spotHistory.shift();
        }
        
        // Get BTC movement
        const btcMove = this.getBTCMovement();
        
        const analysis = {
            btcMove,
            marketProb,
            crypto
        };
        
        // Time-based exit
        if (position && timeRemaining < this.options.exitTimeRemaining) {
            return this.createSignal('sell', null, 'time_exit', analysis);
        }
        
        // Smart position management
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Exit on extreme drawdown
            if (pnlPct <= -this.options.maxDrawdown) {
                return this.createSignal('sell', null, 'max_drawdown', analysis);
            }
            
            return this.createSignal('hold', null, 'holding_with_edge', analysis);
        }
        
        // Entry logic
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', analysis);
        }
        
        // No BTC signal
        if (!btcMove || !btcMove.isSignificant) {
            return this.createSignal('hold', null, 'no_btc_signal', analysis);
        }
        
        // Check if this alt has responded to BTC move
        // Expected direction based on BTC
        const expectedSide = btcMove.direction;
        
        // Check if alt market has priced the move
        // If BTC went up, alt UP probability should have increased
        const altExpectedProb = expectedSide === 'up' ? 0.55 : 0.45;
        const hasResponded = expectedSide === 'up' 
            ? marketProb >= altExpectedProb 
            : marketProb <= altExpectedProb;
        
        if (!hasResponded) {
            // Alt hasn't responded to BTC move - opportunity
            const size = btcMove.isStrong ? this.options.maxPosition : this.options.maxPosition * 0.7;
            
            this.stats.totalSignals++;
            this.stats.btcLeadSignals++;
            this.stats.cryptoSignals[crypto]++;
            
            return this.createSignal('buy', expectedSide, 'btc_lead', analysis, size);
        }
        
        return this.createSignal('hold', null, 'alt_already_responded', analysis);
    }
    
    createSignal(action, side, reason, analysis, size = null) {
        return {
            action,
            side,
            reason,
            size: size || this.options.maxPosition,
            confidence: analysis?.btcMove?.isStrong ? 0.8 : 0.5,
            btcChange: analysis?.btcMove?.changePct,
            btcDirection: analysis?.btcMove?.direction,
            targetCrypto: analysis?.crypto
        };
    }
    
    checkRiskLimits(tick, position) {
        if (!position) return null;
        
        if (tick.time_remaining_sec < this.options.exitTimeRemaining) {
            return { action: 'sell', reason: 'time_exit' };
        }
        
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
    
    onWindowStart(windowInfo) {
        const crypto = windowInfo.crypto?.toLowerCase();
        const state = this.state[crypto];
        if (state) {
            state.marketProbHistory = [];
            state.spotHistory = [];
            state.timestamps = [];
        }
    }
    
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

export default CrossAssetStrategy;
