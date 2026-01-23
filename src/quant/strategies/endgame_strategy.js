/**
 * Endgame Strategy
 * 
 * BUY in the final moments when outcome is nearly certain.
 * 
 * Logic:
 * - With 30 seconds left and price at 97%, outcome is almost locked in
 * - Pay $0.97, receive $1.00 = 3% profit
 * - Risk: Black swan flash crash (rare but catastrophic)
 * 
 * Variations:
 * 1. Conservative: >95% probability, 30s remaining
 * 2. Aggressive: >90% probability, 60s remaining  
 * 3. Ultra: >85% probability, 90s remaining (higher risk/reward)
 * 4. Safe: >97% probability, 15s remaining (very safe, small profit)
 */

export class EndgameStrategy {
    constructor(options = {}) {
        this.name = options.name || 'Endgame';
        this.options = {
            // Entry conditions
            minProbability: 0.90,       // Only buy if probability > 90%
            maxTimeRemaining: 60,       // Only enter in last 60 seconds
            minTimeRemaining: 5,        // Don't enter in last 5s (execution risk)
            
            // Safety checks
            minSpotBuffer: 0.001,       // Spot must be 0.1% above/below price_to_beat
            maxSpread: 0.05,            // Don't enter if spread > 5%
            
            // Position sizing
            maxPosition: 100,
            
            // No exits needed - hold to expiry (that's the point!)
            // But have emergency stop for flash crash
            emergencyStopLoss: 0.30,    // Exit if down 30% (flash crash protection)
            
            ...options
        };
        
        this.stats = {
            signals: 0,
            skippedSpread: 0,
            skippedBuffer: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    onTick(tick, position = null, context = {}) {
        const marketProb = tick.up_mid || 0.5;
        const timeRemaining = tick.time_remaining_sec || 0;
        const spotPrice = tick.spot_price;
        const priceToBeat = tick.price_to_beat || spotPrice;
        const spread = tick.spread_pct / 100 || 0.02;
        
        // Calculate which side is the favorite
        const upIsFavorite = marketProb > 0.5;
        const favoriteProb = upIsFavorite ? marketProb : (1 - marketProb);
        const favoriteSide = upIsFavorite ? 'up' : 'down';
        
        // Position management (only emergency exit)
        if (position) {
            const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Emergency stop loss (flash crash protection)
            if (pnlPct <= -this.options.emergencyStopLoss) {
                return this.createSignal('sell', null, 'emergency_stop', { pnlPct });
            }
            
            // Otherwise HOLD to expiry - that's the whole point!
            return this.createSignal('hold', null, 'holding_to_expiry', { 
                pnlPct, 
                timeRemaining,
                expectedProfit: (1 - position.entryPrice) / position.entryPrice
            });
        }
        
        // Entry logic - only in the endgame!
        
        // Check time window
        if (timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'too_early', { timeRemaining });
        }
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_late', { timeRemaining });
        }
        
        // Check probability threshold
        if (favoriteProb < this.options.minProbability) {
            return this.createSignal('hold', null, 'probability_too_low', { favoriteProb });
        }
        
        // Check spread (don't want to pay too much)
        if (spread > this.options.maxSpread) {
            this.stats.skippedSpread++;
            return this.createSignal('hold', null, 'spread_too_wide', { spread });
        }
        
        // Check spot buffer (is spot actually supporting the favorite?)
        const spotDelta = (spotPrice - priceToBeat) / priceToBeat;
        const spotSupports = (upIsFavorite && spotDelta > this.options.minSpotBuffer) ||
                            (!upIsFavorite && spotDelta < -this.options.minSpotBuffer);
        
        if (!spotSupports) {
            this.stats.skippedBuffer++;
            return this.createSignal('hold', null, 'spot_not_supporting', { spotDelta, favoriteSide });
        }
        
        // All conditions met - BUY the favorite!
        this.stats.signals++;
        
        const expectedProfit = (1 - favoriteProb) * 100; // e.g., 97% prob = 3% profit
        
        return this.createSignal('buy', favoriteSide, 'endgame_entry', {
            favoriteProb: favoriteProb * 100,
            expectedProfit,
            timeRemaining,
            spotDelta: spotDelta * 100
        });
    }
    
    createSignal(action, side, reason, analysis) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            confidence: analysis?.favoriteProb ? analysis.favoriteProb / 100 : 0,
            expectedProfit: analysis?.expectedProfit,
            timeRemaining: analysis?.timeRemaining,
            favoriteProb: analysis?.favoriteProb
        };
    }
    
    onWindowStart(windowInfo) {}
    
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

/**
 * Conservative Endgame - Very high probability, short time
 * Lower risk, lower reward
 */
export class EndgameConservativeStrategy extends EndgameStrategy {
    constructor(options = {}) {
        super({
            name: 'Endgame_Conservative',
            minProbability: 0.95,       // Need 95%+ probability
            maxTimeRemaining: 30,       // Only last 30 seconds
            minTimeRemaining: 5,
            minSpotBuffer: 0.002,       // Spot must be 0.2% in right direction
            emergencyStopLoss: 0.25,
            ...options
        });
    }
}

/**
 * Aggressive Endgame - Lower probability, longer time
 * Higher risk, higher reward
 */
export class EndgameAggressiveStrategy extends EndgameStrategy {
    constructor(options = {}) {
        super({
            name: 'Endgame_Aggressive',
            minProbability: 0.85,       // Accept 85%+ probability
            maxTimeRemaining: 90,       // Enter up to 90 seconds before
            minTimeRemaining: 10,
            minSpotBuffer: 0.0005,      // Lower buffer requirement
            emergencyStopLoss: 0.35,
            ...options
        });
    }
}

/**
 * Ultra Safe Endgame - Near certain outcome
 * Very low risk, very low reward
 */
export class EndgameSafeStrategy extends EndgameStrategy {
    constructor(options = {}) {
        super({
            name: 'Endgame_Safe',
            minProbability: 0.97,       // Need 97%+ probability (3% max profit)
            maxTimeRemaining: 20,       // Only last 20 seconds
            minTimeRemaining: 3,
            minSpotBuffer: 0.003,       // Spot must be 0.3% in right direction
            emergencyStopLoss: 0.20,
            ...options
        });
    }
}

/**
 * Momentum Endgame - Check that price is moving in right direction
 */
export class EndgameMomentumStrategy extends EndgameStrategy {
    constructor(options = {}) {
        super({
            name: 'Endgame_Momentum',
            minProbability: 0.90,
            maxTimeRemaining: 45,
            minTimeRemaining: 5,
            ...options
        });
        
        this.priceHistory = {};
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const marketProb = tick.up_mid || 0.5;
        
        // Track price history
        if (!this.priceHistory[crypto]) {
            this.priceHistory[crypto] = [];
        }
        this.priceHistory[crypto].push(marketProb);
        if (this.priceHistory[crypto].length > 10) {
            this.priceHistory[crypto].shift();
        }
        
        // Check momentum before entering
        const history = this.priceHistory[crypto];
        if (history.length >= 5) {
            const recent = history.slice(-5);
            const oldest = recent[0];
            const newest = recent[recent.length - 1];
            const momentum = newest - oldest;
            
            const upIsFavorite = marketProb > 0.5;
            const momentumSupports = (upIsFavorite && momentum > 0) || (!upIsFavorite && momentum < 0);
            
            // Only enter if momentum supports the favorite
            if (!momentumSupports && !position) {
                return this.createSignal('hold', null, 'momentum_against', { momentum: momentum * 100 });
            }
        }
        
        // Otherwise use parent logic
        return super.onTick(tick, position, context);
    }
}

// Factory functions
export function createEndgameBase(capital = 100) {
    return new EndgameStrategy({ maxPosition: capital });
}

export function createEndgameConservative(capital = 100) {
    return new EndgameConservativeStrategy({ maxPosition: capital });
}

export function createEndgameAggressive(capital = 100) {
    return new EndgameAggressiveStrategy({ maxPosition: capital });
}

export function createEndgameSafe(capital = 100) {
    return new EndgameSafeStrategy({ maxPosition: capital });
}

export function createEndgameMomentum(capital = 100) {
    return new EndgameMomentumStrategy({ maxPosition: capital });
}

export default EndgameStrategy;
