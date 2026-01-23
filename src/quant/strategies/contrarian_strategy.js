/**
 * Contrarian Strategy
 * 
 * KEY INSIGHT FROM BACKTEST:
 * When spot moves in one direction, market often moves OPPOSITE.
 * - SOL: 63% accuracy betting against spot
 * - Overall: 54.8% accuracy contrarian
 * 
 * This is likely due to:
 * - Mean reversion expectations
 * - Market makers pricing information we don't have
 * - Short-term spot moves being noise
 * 
 * Strategy: FADE short-term spot movements
 * - Spot goes UP → Buy DOWN
 * - Spot goes DOWN → Buy UP
 */

export class ContrarianStrategy {
    constructor(options = {}) {
        this.name = options.name || 'Contrarian';
        this.options = {
            // Spot movement thresholds (lowered based on actual market data)
            // Avg tick move is 0.0002%, so accumulate over more ticks
            spotThreshold: 0.00005,     // 0.005% minimum spot move to count
            spotAccumThreshold: 0.0003, // 0.03% accumulated spot move to trade
            lookbackTicks: 30,          // More ticks to accumulate movement
            
            // Position sizing
            maxPosition: 100,
            
            // Scalp exits (contrarian edge decays)
            maxHoldingMs: 60000,        // Exit after 60 seconds
            profitTarget: 0.05,         // 5% profit target (market jumps are big)
            stopLoss: 0.08,             // 8% stop loss
            
            // Time filters
            minTimeRemaining: 120,      // Don't enter with <2 min left
            exitTimeRemaining: 60,      // Exit before final minute
            
            // Crypto filter (SOL has strongest edge)
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],
            
            ...options
        };
        
        // State per crypto
        this.state = {};
        
        this.stats = {
            signals: 0,
            trades: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],
                spotAccumulated: 0,
                lastSpotPrice: null,
                ticksSinceEntry: 0
            };
        }
        return this.state[crypto];
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        // Check if this crypto is enabled
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled', {});
        }
        
        const state = this.initCrypto(crypto);
        const marketProb = tick.up_mid || 0.5;
        const spotPrice = tick.spot_price;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Track spot movement
        if (state.lastSpotPrice && spotPrice && state.lastSpotPrice > 0) {
            const spotDelta = (spotPrice - state.lastSpotPrice) / state.lastSpotPrice;
            state.spotHistory.push(spotDelta);
            state.spotAccumulated += spotDelta;
            
            // Keep limited history
            if (state.spotHistory.length > this.options.lookbackTicks) {
                const removed = state.spotHistory.shift();
                state.spotAccumulated -= removed;
            }
        }
        state.lastSpotPrice = spotPrice;
        
        // Position management
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            const holdingTime = Date.now() - position.entryTime;
            
            // Profit target
            if (pnlPct >= this.options.profitTarget) {
                return this.createSignal('sell', null, 'profit_target', { pnlPct, holdingTime });
            }
            
            // Stop loss
            if (pnlPct <= -this.options.stopLoss) {
                return this.createSignal('sell', null, 'stop_loss', { pnlPct, holdingTime });
            }
            
            // Max holding time
            if (holdingTime > this.options.maxHoldingMs) {
                return this.createSignal('sell', null, 'max_holding', { pnlPct, holdingTime });
            }
            
            // Time exit
            if (timeRemaining < this.options.exitTimeRemaining) {
                return this.createSignal('sell', null, 'time_exit', { pnlPct, holdingTime });
            }
            
            return this.createSignal('hold', null, 'holding', { pnlPct, holdingTime });
        }
        
        // Entry logic
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time', {});
        }
        
        // Check for contrarian signal
        const spotAccum = state.spotAccumulated;
        
        if (Math.abs(spotAccum) >= this.options.spotAccumThreshold) {
            // CONTRARIAN: bet OPPOSITE to spot movement
            const side = spotAccum > 0 ? 'down' : 'up';  // Spot up → buy DOWN
            
            this.stats.signals++;
            
            // Reset accumulator after signal
            state.spotAccumulated = 0;
            state.spotHistory = [];
            
            return this.createSignal('buy', side, 'contrarian_fade', {
                spotAccum: spotAccum * 100,
                direction: spotAccum > 0 ? 'fading_up_move' : 'fading_down_move'
            });
        }
        
        return this.createSignal('hold', null, 'waiting', { spotAccum: spotAccum * 100 });
    }
    
    createSignal(action, side, reason, analysis) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            confidence: Math.min(1, Math.abs(analysis?.spotAccum || 0) / 0.5),
            spotAccum: analysis?.spotAccum,
            pnlPct: analysis?.pnlPct,
            holdingTime: analysis?.holdingTime
        };
    }
    
    onWindowStart(windowInfo) {
        const state = this.state[windowInfo.crypto];
        if (state) {
            state.spotHistory = [];
            state.spotAccumulated = 0;
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

/**
 * Contrarian SOL Focus - Higher threshold, only SOL
 * SOL showed 63% accuracy in backtest
 */
export class ContrarianSOLStrategy extends ContrarianStrategy {
    constructor(options = {}) {
        super({
            name: 'Contrarian_SOL',
            enabledCryptos: ['sol'],  // Only trade SOL
            spotAccumThreshold: 0.0005,  // 0.05% threshold (lowered)
            lookbackTicks: 20,
            maxHoldingMs: 45000,  // Shorter hold
            profitTarget: 0.08,   // Higher target (SOL jumps are big)
            stopLoss: 0.10,
            ...options
        });
    }
}

/**
 * Contrarian Quick Scalp - Very short holding period
 */
export class ContrarianScalpStrategy extends ContrarianStrategy {
    constructor(options = {}) {
        super({
            name: 'Contrarian_Scalp',
            spotAccumThreshold: 0.0002,  // 0.02% threshold (lowered for more trades)
            maxHoldingMs: 15000,  // 15 second max hold
            profitTarget: 0.03,   // Quick 3% target
            stopLoss: 0.05,
            lookbackTicks: 15,    // More ticks to accumulate
            ...options
        });
    }
}

/**
 * Contrarian Strong - Only trade on large spot moves
 */
export class ContrarianStrongStrategy extends ContrarianStrategy {
    constructor(options = {}) {
        super({
            name: 'Contrarian_Strong',
            spotAccumThreshold: 0.0008,  // 0.08% threshold (lowered but still higher than base)
            maxHoldingMs: 90000,  // Longer hold for bigger moves
            profitTarget: 0.10,   // 10% target
            stopLoss: 0.12,
            lookbackTicks: 40,    // More accumulation
            ...options
        });
    }
}

// Factory functions
export function createContrarianBase(capital = 100) {
    return new ContrarianStrategy({ maxPosition: capital });
}

export function createContrarianSOL(capital = 100) {
    return new ContrarianSOLStrategy({ maxPosition: capital });
}

export function createContrarianScalp(capital = 100) {
    return new ContrarianScalpStrategy({ maxPosition: capital });
}

export function createContrarianStrong(capital = 100) {
    return new ContrarianStrongStrategy({ maxPosition: capital });
}

export default ContrarianStrategy;
