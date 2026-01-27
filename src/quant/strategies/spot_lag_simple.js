/**
 * Simple Spot Lag Strategy
 * 
 * THESIS: Market lags spot by ~3.5 seconds. When spot moves, buy
 * in that direction before market catches up.
 * 
 * NO fair value calculation needed - just detect spot movement
 * and check if market has reacted.
 * 
 * Entry conditions:
 * 1. Spot moved by X% in last N seconds
 * 2. Market price hasn't moved proportionally
 * 
 * Exit: Hold to expiry (binary payout)
 */

export class SpotLagSimpleStrategy {
    constructor(options = {}) {
        this.name = options.name || 'SpotLagSimple';
        this.options = {
            // How much spot must move to trigger (0.05% = 0.0005)
            spotMoveThreshold: 0.0005,
            
            // How many ticks to look back for spot movement
            lookbackTicks: 10,
            
            // Market should have moved less than this ratio of spot move
            // e.g., if spot moved 0.1% and market moved 0.02%, ratio = 0.2
            marketLagRatio: 0.5,
            
            // Position sizing
            maxPosition: 100,
            
            // Time constraints
            minTimeRemaining: 120,  // Don't enter with < 2 min left
            
            // DISABLED: Stop loss was killing winning trades that would resolve profitably
            // Data showed 87.8% win rate at expiry vs 0% win rate on stopped trades
            // Set to 0.99 to effectively disable (only stop if position is nearly worthless)
            extremeStopLoss: 0.99,
            
            // Enabled cryptos
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],
            
            ...options
        };
        
        // State per crypto
        this.state = {};
        
        // Track if we already traded this window (prevents re-entry after stop-out)
        this.tradedThisWindow = {}; // crypto -> window_epoch
        
        this.stats = {
            signals: 0,
            spotMovesDetected: 0,
            marketLagsDetected: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],      // Recent spot prices
                marketHistory: [],    // Recent market prices (up_mid)
                timestamps: []
            };
        }
        return this.state[crypto];
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        // Check if this crypto is enabled
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        // Trim to lookback window
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        const windowEpoch = tick.window_epoch;
        
        // Position management - HOLD TO EXPIRY
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Only exit on extreme drawdown
            if (pnlPct <= -this.options.extremeStopLoss) {
                // Mark as traded so we don't re-enter this window
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            // Otherwise hold to expiry
            return this.createSignal('hold', null, 'holding_to_expiry', { pnlPct });
        }
        
        // BLOCK RE-ENTRY: If we already traded this window (stopped out), don't enter again
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded_this_window');
        }
        
        // Entry logic
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'insufficient_time');
        }
        
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_data');
        }
        
        // Calculate spot movement over lookback period
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        
        // Calculate market movement over same period
        const oldMarket = state.marketHistory[state.marketHistory.length - this.options.lookbackTicks];
        const newMarket = state.marketHistory[state.marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;  // Market is already 0-1 probability
        
        // DYNAMIC THRESHOLD: Scale required move based on distance from 50¢
        // At extremes (<20¢ or >80¢), require LARGER moves to bet against consensus
        const marketPrice = tick.up_mid || 0.5;
        const distanceFrom50 = Math.abs(marketPrice - 0.5);  // 0 at 50¢, 0.4 at 10¢/90¢
        
        // Scale factor: 1x at 50¢, up to 3x at extremes
        // This prevents noise trading against strong consensus
        const dynamicMultiplier = 1 + (distanceFrom50 * 4);  // 1x at 50¢, 2.6x at 10¢/90¢
        const dynamicThreshold = this.options.spotMoveThreshold * dynamicMultiplier;
        
        // Check if spot moved enough (using dynamic threshold)
        if (Math.abs(spotMove) < dynamicThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving', { 
                spotMove,
                threshold: (dynamicThreshold * 100).toFixed(4) + '%',
                marketPrice: (marketPrice * 100).toFixed(0) + '¢',
                multiplier: dynamicMultiplier.toFixed(2) + 'x'
            });
        }
        
        this.stats.spotMovesDetected++;
        
        // Expected market move (rough approximation)
        // If spot moved 0.1%, market should move roughly proportionally
        // For a 50/50 market, 0.1% spot move might cause ~1-5% prob change
        const expectedMarketMove = spotMove * 10;  // Rough multiplier
        
        // Check if market is lagging
        const actualVsExpected = Math.abs(marketMove) / Math.abs(expectedMarketMove);
        
        if (actualVsExpected > this.options.marketLagRatio) {
            // Market already caught up
            return this.createSignal('hold', null, 'market_caught_up', { 
                spotMove, marketMove, actualVsExpected 
            });
        }
        
        this.stats.marketLagsDetected++;
        this.stats.signals++;
        
        // Market is lagging - trade in direction of spot move
        const side = spotMove > 0 ? 'up' : 'down';
        
        return this.createSignal('buy', side, 'spot_lag_detected', {
            spotMove: (spotMove * 100).toFixed(4) + '%',
            marketMove: (marketMove * 100).toFixed(2) + '%',
            lagRatio: actualVsExpected.toFixed(2),
            crypto
        });
    }
    
    createSignal(action, side, reason, analysis = {}) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            ...analysis
        };
    }
    
    onWindowStart(windowInfo) {
        // Reset state for new window - allow trading again
        this.tradedThisWindow = {};
    }
    
    onWindowEnd(windowInfo, outcome) {
        // Position will be resolved by research engine
    }
    
    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

// Variants with different parameters

/**
 * Fast variant - looks at shorter timeframe
 */
export class SpotLagFastStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Fast',
            lookbackTicks: 5,           // Shorter lookback
            spotMoveThreshold: 0.0003,  // Lower threshold (0.03%)
            marketLagRatio: 0.3,        // Market must have moved < 30% of expected
            ...options
        });
    }
}

/**
 * Confirmed variant - waits for bigger moves
 */
export class SpotLagConfirmedStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Confirmed',
            lookbackTicks: 15,          // Longer lookback
            spotMoveThreshold: 0.001,   // Higher threshold (0.1%)
            marketLagRatio: 0.4,        // Market must have moved < 40% of expected
            ...options
        });
    }
}

/**
 * Aggressive variant - trades more often
 */
export class SpotLagAggressiveStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Aggressive',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,  // Very low threshold (0.02%)
            marketLagRatio: 0.6,        // Allow market to have moved more
            ...options
        });
    }
}

// ================================================================
// HOLDING PERIOD VARIANTS - Test different exit timings
// ================================================================

/**
 * Base class for time-based exit strategies
 * 
 * KEY: Only ONE trade per window per crypto to avoid re-entry loops
 */
class SpotLagTimedExitStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super(options);
        this.holdingPeriodSec = options.holdingPeriodSec || 30;
        this.takeProfitPct = options.takeProfitPct || 0.10; // Exit if 10% profit
        this.entryTimes = {}; // crypto -> entry timestamp
        this.tradedThisWindow = {}; // crypto -> window_epoch (prevent re-entry after exit)
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        
        // If we have a position, check for timed exit
        if (position) {
            const entryTime = this.entryTimes[crypto];
            const holdingMs = entryTime ? Date.now() - entryTime : 0;
            const holdingSec = holdingMs / 1000;
            
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Exit if holding period exceeded
            if (holdingSec >= this.holdingPeriodSec) {
                delete this.entryTimes[crypto];
                this.tradedThisWindow[crypto] = windowEpoch; // Mark as traded, prevent re-entry
                return this.createSignal('sell', null, `timed_exit_${this.holdingPeriodSec}s`, { 
                    holdingSec: holdingSec.toFixed(1), 
                    pnlPct: (pnlPct * 100).toFixed(2) + '%' 
                });
            }
            
            // Exit on take-profit
            if (pnlPct >= this.takeProfitPct) {
                delete this.entryTimes[crypto];
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'take_profit', { 
                    holdingSec: holdingSec.toFixed(1),
                    pnlPct: (pnlPct * 100).toFixed(2) + '%' 
                });
            }
            
            // Exit on extreme drawdown (keep this safety)
            if (pnlPct <= -this.options.extremeStopLoss) {
                delete this.entryTimes[crypto];
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            return this.createSignal('hold', null, 'holding_timed', { 
                holdingSec: holdingSec.toFixed(1), 
                targetSec: this.holdingPeriodSec 
            });
        }
        
        // BLOCK RE-ENTRY: If we already traded this window, don't enter again
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded_this_window');
        }
        
        // Entry logic - same as parent
        const signal = super.onTick(tick, position, context);
        
        // Track entry time if buying
        if (signal.action === 'buy') {
            this.entryTimes[crypto] = Date.now();
        }
        
        return signal;
    }
    
    // Reset on new window
    onWindowStart(windowInfo) {
        super.onWindowStart && super.onWindowStart(windowInfo);
        // Clear traded flags for new window
        this.tradedThisWindow = {};
    }
}

/**
 * 5-second hold - test if market catches up very fast
 */
export class SpotLag5SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_5sec',
            holdingPeriodSec: 5,
            takeProfitPct: 0.05,  // 5% take profit
            lookbackTicks: 5,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.3,
            ...options
        });
    }
}

/**
 * 10-second hold - test short-term catch-up
 */
export class SpotLag10SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_10sec',
            holdingPeriodSec: 10,
            takeProfitPct: 0.08,  // 8% take profit
            lookbackTicks: 5,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.3,
            ...options
        });
    }
}

/**
 * 30-second hold - test medium-term catch-up
 */
export class SpotLag30SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_30sec',
            holdingPeriodSec: 30,
            takeProfitPct: 0.10,  // 10% take profit
            lookbackTicks: 5,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.4,
            ...options
        });
    }
}

/**
 * 60-second hold - test 1-minute catch-up
 */
export class SpotLag60SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_60sec',
            holdingPeriodSec: 60,
            takeProfitPct: 0.12,  // 12% take profit
            lookbackTicks: 5,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.4,
            ...options
        });
    }
}

/**
 * 2-minute hold
 */
export class SpotLag120SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_120sec',
            holdingPeriodSec: 120,
            takeProfitPct: 0.15,  // 15% take profit
            lookbackTicks: 8,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.4,
            ...options
        });
    }
}

/**
 * 5-minute hold
 */
export class SpotLag300SecStrategy extends SpotLagTimedExitStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_300sec',
            holdingPeriodSec: 300,
            takeProfitPct: 0.20,  // 20% take profit
            lookbackTicks: 8,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.5,
            ...options
        });
    }
}

// ================================================================
// MISPRICING-ONLY STRATEGIES
// Based on insight: Edge comes from market prob being WRONG vs spot position
// Not from detecting "lag" in reaction to moves
// ================================================================

/**
 * Mispricing-Only Strategy
 * 
 * THESIS: Trade ONLY when market probability clearly doesn't match spot position.
 * 
 * Entry conditions:
 * - Spot > strike by X% BUT market prob < Y% (mispriced UP)
 * - Spot < strike by X% BUT market prob > (100-Y)% (mispriced DOWN)
 * 
 * This is different from SpotLag which looks for "movement" - 
 * this looks for "static mispricing" regardless of recent movement.
 */
export class MispricingOnlyStrategy {
    constructor(options = {}) {
        this.name = options.name || 'MispricingOnly';
        this.options = {
            // Spot must be this far from strike (as %)
            minSpotDivergence: 0.001,  // 0.1% from strike
            
            // Market prob must be this wrong
            // If spot > strike, market prob must be < this to trade UP
            maxProbForUpBet: 0.45,     // Market says <45% UP when spot is above
            // If spot < strike, market prob must be > this to trade DOWN  
            minProbForDownBet: 0.55,   // Market says >55% UP when spot is below
            
            // Position sizing
            maxPosition: 100,
            
            // Time constraints
            minTimeRemaining: 180,  // Need 3+ min for binary to resolve
            maxTimeRemaining: 840,  // Don't enter in first minute (unstable)
            
            // DISABLED: Stop loss was killing winning trades that would resolve profitably
            // Set to 0.99 to effectively disable (hold to expiry)
            extremeStopLoss: 0.99,
            
            // Enabled cryptos
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],
            
            ...options
        };
        
        // Track if we already traded this window (prevents re-entry after stop-out)
        this.tradedThisWindow = {}; // crypto -> window_epoch
        
        this.stats = {
            signals: 0,
            mispricingsDetected: 0,
            upMispricings: 0,
            downMispricings: 0
        };
    }
    
    getName() {
        return this.name;
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        const spotPrice = tick.spot_price;
        const strike = tick.price_to_beat;
        const marketProb = tick.up_mid;  // Probability market assigns to UP
        
        // Position management - HOLD TO EXPIRY
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            if (pnlPct <= -this.options.extremeStopLoss) {
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            return this.createSignal('hold', null, 'holding_to_expiry', { pnlPct });
        }
        
        // Entry timing filter
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_late');
        }
        if (timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'too_early');
        }
        
        // Calculate spot position vs strike
        const spotDivergence = (spotPrice - strike) / strike;
        const spotAbove = spotDivergence > this.options.minSpotDivergence;
        const spotBelow = spotDivergence < -this.options.minSpotDivergence;
        
        // Check for mispricing
        // UP mispricing: Spot clearly above strike, but market prob too low
        if (spotAbove && marketProb < this.options.maxProbForUpBet) {
            this.stats.mispricingsDetected++;
            this.stats.upMispricings++;
            this.stats.signals++;
            
            const mispricingMagnitude = (0.5 + spotDivergence * 50) - marketProb; // Rough "should be" vs actual
            
            return this.createSignal('buy', 'up', 'mispriced_up', {
                spotDivergence: (spotDivergence * 100).toFixed(3) + '%',
                marketProb: (marketProb * 100).toFixed(1) + '%',
                shouldBe: ((0.5 + spotDivergence * 50) * 100).toFixed(1) + '%',
                mispricingMagnitude: (mispricingMagnitude * 100).toFixed(1) + '%',
                confidence: Math.min(1, mispricingMagnitude * 2)
            });
        }
        
        // DOWN mispricing: Spot clearly below strike, but market prob too high
        if (spotBelow && marketProb > this.options.minProbForDownBet) {
            this.stats.mispricingsDetected++;
            this.stats.downMispricings++;
            this.stats.signals++;
            
            const mispricingMagnitude = marketProb - (0.5 + spotDivergence * 50);
            
            return this.createSignal('buy', 'down', 'mispriced_down', {
                spotDivergence: (spotDivergence * 100).toFixed(3) + '%',
                marketProb: (marketProb * 100).toFixed(1) + '%',
                shouldBe: ((0.5 + spotDivergence * 50) * 100).toFixed(1) + '%',
                mispricingMagnitude: (mispricingMagnitude * 100).toFixed(1) + '%',
                confidence: Math.min(1, mispricingMagnitude * 2)
            });
        }
        
        // No mispricing detected
        if (spotAbove) {
            return this.createSignal('hold', null, 'spot_above_but_correctly_priced', { marketProb });
        }
        if (spotBelow) {
            return this.createSignal('hold', null, 'spot_below_but_correctly_priced', { marketProb });
        }
        
        return this.createSignal('hold', null, 'spot_at_strike');
    }
    
    createSignal(action, side, reason, analysis = {}) {
        return {
            action,
            side,
            reason,
            size: this.options.maxPosition,
            ...analysis
        };
    }
    
    onWindowStart(windowInfo) {}
    onWindowEnd(windowInfo, outcome) {}
    
    getStats() {
        return { name: this.name, ...this.stats };
    }
}

/**
 * Strict Mispricing - Only trade BIG mispricings (>15% prob wrong)
 */
export class MispricingStrictStrategy extends MispricingOnlyStrategy {
    constructor(options = {}) {
        super({
            name: 'Mispricing_Strict',
            minSpotDivergence: 0.001,   // 0.1% from strike
            maxProbForUpBet: 0.35,      // Market must be < 35% for UP bet
            minProbForDownBet: 0.65,    // Market must be > 65% for DOWN bet
            ...options
        });
    }
}

/**
 * Loose Mispricing - Trade smaller mispricings too
 */
export class MispricingLooseStrategy extends MispricingOnlyStrategy {
    constructor(options = {}) {
        super({
            name: 'Mispricing_Loose',
            minSpotDivergence: 0.0005,  // 0.05% from strike (smaller)
            maxProbForUpBet: 0.48,      // Market < 48% for UP bet
            minProbForDownBet: 0.52,    // Market > 52% for DOWN bet
            ...options
        });
    }
}

/**
 * Extreme Mispricing - Only massive mispricings (like the XRP 11% example)
 */
export class MispricingExtremeStrategy extends MispricingOnlyStrategy {
    constructor(options = {}) {
        super({
            name: 'Mispricing_Extreme',
            minSpotDivergence: 0.002,   // 0.2% from strike (larger)
            maxProbForUpBet: 0.25,      // Market must be < 25% for UP bet
            minProbForDownBet: 0.75,    // Market must be > 75% for DOWN bet
            ...options
        });
    }
}

// Factory functions for Mispricing strategies
export function createMispricingOnly(capital = 100) {
    return new MispricingOnlyStrategy({ maxPosition: capital });
}

export function createMispricingStrict(capital = 100) {
    return new MispricingStrictStrategy({ maxPosition: capital });
}

export function createMispricingLoose(capital = 100) {
    return new MispricingLooseStrategy({ maxPosition: capital });
}

export function createMispricingExtreme(capital = 100) {
    return new MispricingExtremeStrategy({ maxPosition: capital });
}

// Factory functions
export function createSpotLagSimple(capital = 100) {
    return new SpotLagSimpleStrategy({ maxPosition: capital });
}

export function createSpotLagFast(capital = 100) {
    return new SpotLagFastStrategy({ maxPosition: capital });
}

export function createSpotLagConfirmed(capital = 100) {
    return new SpotLagConfirmedStrategy({ maxPosition: capital });
}

export function createSpotLagAggressive(capital = 100) {
    return new SpotLagAggressiveStrategy({ maxPosition: capital });
}

// Timed exit factories
export function createSpotLag5Sec(capital = 100) {
    return new SpotLag5SecStrategy({ maxPosition: capital });
}

export function createSpotLag10Sec(capital = 100) {
    return new SpotLag10SecStrategy({ maxPosition: capital });
}

export function createSpotLag30Sec(capital = 100) {
    return new SpotLag30SecStrategy({ maxPosition: capital });
}

export function createSpotLag60Sec(capital = 100) {
    return new SpotLag60SecStrategy({ maxPosition: capital });
}

export function createSpotLag120Sec(capital = 100) {
    return new SpotLag120SecStrategy({ maxPosition: capital });
}

export function createSpotLag300Sec(capital = 100) {
    return new SpotLag300SecStrategy({ maxPosition: capital });
}

// ================================================================
// CHAINLINK-CONFIRMED STRATEGIES
// Only bet when BOTH Binance and Chainlink agree on direction
// This filters out the 100% losing trades where sources disagree
// ================================================================

/**
 * SpotLag with Chainlink Confirmation
 * 
 * THESIS: SpotLag works because spot position persists. But when Binance
 * and Chainlink disagree, we're betting on the wrong signal (Binance)
 * when resolution uses Chainlink. Filter to only bet when both agree.
 * 
 * Data shows:
 * - When sources agree: 58% win rate
 * - When sources disagree (bet with Binance): 0% win rate
 */
export class SpotLagChainlinkConfirmedStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_CLConfirmed',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0003,
            marketLagRatio: 0.5,
            ...options
        });
    }
    
    onTick(tick, position = null, context = {}) {
        // First check Chainlink agreement BEFORE doing SpotLag logic
        if (!position) {  // Only check on entry, not during position hold
            const strike = tick.price_to_beat;
            const binancePrice = tick.spot_price;
            const chainlinkPrice = tick.chainlink_price;
            
            // If no Chainlink data, skip this tick (don't bet without confirmation)
            if (!chainlinkPrice || !strike) {
                return this.createSignal('hold', null, 'no_chainlink_data');
            }
            
            // Check if sources agree on direction
            const binanceUp = binancePrice > strike;
            const chainlinkUp = chainlinkPrice > strike;
            
            if (binanceUp !== chainlinkUp) {
                // Sources disagree - DO NOT TRADE
                return this.createSignal('hold', null, 'sources_disagree', {
                    binance: binanceUp ? 'UP' : 'DOWN',
                    chainlink: chainlinkUp ? 'UP' : 'DOWN',
                    binancePrice: binancePrice.toFixed(2),
                    chainlinkPrice: chainlinkPrice.toFixed(2),
                    strike: strike.toFixed(2)
                });
            }
            
            // Sources agree - proceed with normal SpotLag logic
        }
        
        return super.onTick(tick, position, context);
    }
}

/**
 * Aggressive SpotLag with Chainlink Confirmation
 */
export class SpotLagAggressiveCLStrategy extends SpotLagChainlinkConfirmedStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Aggressive_CL',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,
            marketLagRatio: 0.6,
            ...options
        });
    }
}

/**
 * Mispricing with Chainlink Confirmation
 * Only bet on mispricings when both price sources agree on direction
 */
export class MispricingChainlinkConfirmedStrategy extends MispricingOnlyStrategy {
    constructor(options = {}) {
        super({
            name: 'Mispricing_CLConfirmed',
            ...options
        });
    }
    
    onTick(tick, position = null, context = {}) {
        // First check Chainlink agreement
        if (!position) {
            const strike = tick.price_to_beat;
            const binancePrice = tick.spot_price;
            const chainlinkPrice = tick.chainlink_price;
            
            if (!chainlinkPrice || !strike) {
                return this.createSignal('hold', null, 'no_chainlink_data');
            }
            
            const binanceUp = binancePrice > strike;
            const chainlinkUp = chainlinkPrice > strike;
            
            if (binanceUp !== chainlinkUp) {
                return this.createSignal('hold', null, 'sources_disagree', {
                    binance: binanceUp ? 'UP' : 'DOWN',
                    chainlink: chainlinkUp ? 'UP' : 'DOWN'
                });
            }
        }
        
        return super.onTick(tick, position, context);
    }
}

/**
 * UP-Only with Chainlink Confirmation
 * Based on findings: UP bets win more + Chainlink confirmation removes losers
 */
export class UpOnlyChainlinkStrategy {
    constructor(options = {}) {
        this.name = options.name || 'UpOnly_CLConfirmed';
        this.options = {
            minSpotDivergence: 0.0005,  // Spot must be 0.05% above strike
            maxMarketProb: 0.52,        // Market not already pricing in UP
            minTimeRemaining: 180,
            maxTimeRemaining: 780,
            maxPosition: 100,
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],
            ...options
        };
        this.tradedThisWindow = {};
        this.stats = { signals: 0 };
    }
    
    getName() { return this.name; }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        // Position management - HOLD TO EXPIRY (stop loss disabled)
        if (position) {
            const currentPrice = tick.up_mid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            // DISABLED: Stop loss was killing winning trades
            // if (pnlPct <= -0.50) {
            //     return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            // }
            return this.createSignal('hold', null, 'holding_to_expiry', { pnlPct });
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time');
        }
        
        const strike = tick.price_to_beat;
        const binancePrice = tick.spot_price;
        const chainlinkPrice = tick.chainlink_price;
        const marketProb = tick.up_mid;
        
        // MUST have Chainlink data
        if (!chainlinkPrice || !strike) {
            return this.createSignal('hold', null, 'no_chainlink_data');
        }
        
        // BOTH sources must show UP
        const binanceUp = binancePrice > strike * (1 + this.options.minSpotDivergence);
        const chainlinkUp = chainlinkPrice > strike;
        
        if (!binanceUp || !chainlinkUp) {
            return this.createSignal('hold', null, 'not_both_up', {
                binanceUp, chainlinkUp
            });
        }
        
        // Market shouldn't already be pricing it in
        if (marketProb > this.options.maxMarketProb) {
            return this.createSignal('hold', null, 'already_priced_in', { marketProb });
        }
        
        // ALL conditions met - buy UP
        this.stats.signals++;
        this.tradedThisWindow[crypto] = windowEpoch;
        
        return this.createSignal('buy', 'up', 'both_sources_up', {
            binancePrice: binancePrice.toFixed(2),
            chainlinkPrice: chainlinkPrice.toFixed(2),
            strike: strike.toFixed(2),
            marketProb: (marketProb * 100).toFixed(1) + '%'
        });
    }
    
    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }
    
    onWindowStart(windowInfo) { this.tradedThisWindow = {}; }
    onWindowEnd(windowInfo, outcome) {}
    getStats() { return { name: this.name, ...this.stats }; }
}

// ================================================================
// CHAINLINK DIVERGENCE STRATEGY (NEW!)
// Bet on Chainlink's side when it disagrees with Binance
// Because Polymarket resolves using Chainlink, not Binance!
// ================================================================

/**
 * Chainlink Divergence Strategy
 * 
 * THESIS: When Binance and Chainlink disagree on which side of the
 * price_to_beat the price is, bet on CHAINLINK's side because:
 * 1. Resolution uses Chainlink, not Binance
 * 2. Most traders watch Binance, so market will be mispriced
 * 3. Chainlink is slower to update, so it represents the "true" resolution price
 * 
 * Example from ETH trade:
 * - Price to beat: $2,931.82
 * - Binance: $2,931.32 (barely above) → Market shows UP at 98¢
 * - Chainlink: $2,926.44 (well below) → Will resolve DOWN
 * - Strategy: Buy DOWN (following Chainlink)
 * - Result: DOWN wins because resolution uses Chainlink!
 */
export class ChainlinkDivergenceStrategy {
    constructor(options = {}) {
        this.name = options.name || 'CL_Divergence';
        this.options = {
            // Minimum divergence between Binance and Chainlink (as % of price)
            minDivergence: 0.001,  // 0.1% minimum disagreement
            
            // Chainlink must be on opposite side of threshold by this margin
            minChainlinkMargin: 0.0005,  // 0.05% buffer to avoid edge cases
            
            // Time constraints
            minTimeRemaining: 60,   // At least 1 min left (for execution)
            maxTimeRemaining: 600,  // Max 10 min (closer to expiry = more confident)
            
            // Market pricing constraint - don't buy if already expensive
            maxEntryPrice: 0.70,    // Don't pay more than 70¢ (30%+ expected return)
            
            maxPosition: 100,
            enabledCryptos: ['btc', 'eth', 'sol'],  // Not XRP (no Chainlink feed)
            ...options
        };
        this.tradedThisWindow = {};
        this.stats = { signals: 0, divergences_detected: 0 };
    }
    
    getName() { return this.name; }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        // Position management - HOLD TO EXPIRY
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : tick.down_mid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            return this.createSignal('hold', null, 'holding_to_expiry', { pnlPct });
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time', { timeRemaining });
        }
        
        // Get all price data
        const strike = tick.price_to_beat;
        const binancePrice = tick.spot_price;
        const chainlinkPrice = tick.chainlink_price;
        
        // MUST have Chainlink data
        if (!chainlinkPrice || !strike || !binancePrice) {
            return this.createSignal('hold', null, 'missing_data');
        }
        
        // Calculate divergence
        const divergencePct = Math.abs(binancePrice - chainlinkPrice) / binancePrice;
        
        if (divergencePct < this.options.minDivergence) {
            return this.createSignal('hold', null, 'insufficient_divergence', { 
                divergence: (divergencePct * 100).toFixed(3) + '%'
            });
        }
        
        // Determine which side each source is on
        const binanceUp = binancePrice > strike;
        const chainlinkUp = chainlinkPrice > strike;
        
        // THE KEY CHECK: Do they disagree?
        if (binanceUp === chainlinkUp) {
            return this.createSignal('hold', null, 'sources_agree', {
                both: binanceUp ? 'UP' : 'DOWN'
            });
        }
        
        this.stats.divergences_detected++;
        
        // They disagree! Bet on CHAINLINK's side
        const betSide = chainlinkUp ? 'up' : 'down';
        const entryPrice = chainlinkUp ? tick.up_ask : tick.down_ask;
        
        // Check entry price constraint
        if (entryPrice > this.options.maxEntryPrice) {
            return this.createSignal('hold', null, 'too_expensive', {
                entryPrice: entryPrice.toFixed(2),
                maxAllowed: this.options.maxEntryPrice
            });
        }
        
        // Check Chainlink margin (not right at the edge)
        const chainlinkMargin = chainlinkUp 
            ? (chainlinkPrice - strike) / strike
            : (strike - chainlinkPrice) / strike;
            
        if (chainlinkMargin < this.options.minChainlinkMargin) {
            return this.createSignal('hold', null, 'chainlink_too_close', {
                margin: (chainlinkMargin * 100).toFixed(3) + '%'
            });
        }
        
        // ALL CONDITIONS MET - Trade on Chainlink's side!
        this.stats.signals++;
        this.tradedThisWindow[crypto] = windowEpoch;
        
        console.log(`[CL_Divergence] 🎯 DIVERGENCE DETECTED ${crypto}:`);
        console.log(`   Strike: $${strike.toFixed(2)}`);
        console.log(`   Binance: $${binancePrice.toFixed(2)} → ${binanceUp ? 'UP' : 'DOWN'}`);
        console.log(`   Chainlink: $${chainlinkPrice.toFixed(2)} → ${chainlinkUp ? 'UP' : 'DOWN'}`);
        console.log(`   Betting: ${betSide.toUpperCase()} (following Chainlink)`);
        
        return this.createSignal('buy', betSide, 'chainlink_divergence', {
            binancePrice: binancePrice.toFixed(2),
            binanceSide: binanceUp ? 'UP' : 'DOWN',
            chainlinkPrice: chainlinkPrice.toFixed(2),
            chainlinkSide: chainlinkUp ? 'UP' : 'DOWN',
            strike: strike.toFixed(2),
            divergence: (divergencePct * 100).toFixed(2) + '%',
            chainlinkMargin: (chainlinkMargin * 100).toFixed(2) + '%',
            entryPrice: entryPrice.toFixed(2),
            timeRemaining: Math.round(timeRemaining) + 's'
        });
    }
    
    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }
    
    onWindowStart(windowInfo) { this.tradedThisWindow = {}; }
    onWindowEnd(windowInfo, outcome) {}
    getStats() { return { name: this.name, ...this.stats }; }
}

/**
 * Aggressive Chainlink Divergence - lower thresholds, trades more often
 */
export class ChainlinkDivergenceAggressiveStrategy extends ChainlinkDivergenceStrategy {
    constructor(options = {}) {
        super({
            name: 'CL_Divergence_Aggro',
            minDivergence: 0.0005,      // 0.05% divergence (lower)
            minChainlinkMargin: 0.0002, // Tighter margin
            maxEntryPrice: 0.80,        // Pay up to 80¢
            maxTimeRemaining: 780,      // Earlier entries OK
            ...options
        });
    }
}

/**
 * Conservative Chainlink Divergence - higher thresholds, fewer but higher confidence trades
 */
export class ChainlinkDivergenceConservativeStrategy extends ChainlinkDivergenceStrategy {
    constructor(options = {}) {
        super({
            name: 'CL_Divergence_Safe',
            minDivergence: 0.002,       // 0.2% divergence required
            minChainlinkMargin: 0.001,  // Wider margin required
            maxEntryPrice: 0.50,        // Only cheap entries (50%+ expected return)
            minTimeRemaining: 30,       // Can trade closer to expiry
            maxTimeRemaining: 300,      // Only last 5 minutes
            ...options
        });
    }
}

export function createCLDivergence(capital = 100) {
    return new ChainlinkDivergenceStrategy({ maxPosition: capital });
}

export function createCLDivergenceAggro(capital = 100) {
    return new ChainlinkDivergenceAggressiveStrategy({ maxPosition: capital });
}

export function createCLDivergenceSafe(capital = 100) {
    return new ChainlinkDivergenceConservativeStrategy({ maxPosition: capital });
}

/**
 * FINAL SECONDS Chainlink Divergence Strategy
 * 
 * THE USER'S THESIS:
 * In the final 10-30 seconds, Chainlink is essentially "frozen" because:
 * 1. Heartbeat is ~60-120 seconds (won't trigger in 10-30s)
 * 2. Deviation threshold is ~0.5% (unlikely to trigger in final seconds)
 * 
 * If Chainlink shows DOWN but market shows UP at 99¢ (DOWN at 1¢):
 * - Chainlink WON'T update before expiry
 * - Resolution uses Chainlink → DOWN wins
 * - $1 at 1¢ = 100 shares → $100 payout = 100x return
 * 
 * This strategy ONLY trades in the final 30 seconds where:
 * - Chainlink is effectively locked
 * - Prices are most extreme
 * - Returns are potentially 10-100x
 */
export class ChainlinkFinalSecondsStrategy {
    constructor(options = {}) {
        this.name = options.name || 'CL_FinalSeconds';
        this.options = {
            // ONLY trade in final 30 seconds (Chainlink essentially frozen)
            minTimeRemaining: 5,    // Need at least 5s to execute
            maxTimeRemaining: 30,   // Final 30 seconds only
            
            // Require significant Chainlink margin from strike
            minChainlinkMargin: 0.001,  // 0.1% away from strike minimum
            
            // Maximum entry price - we want CHEAP entries for max leverage
            maxEntryPrice: 0.15,    // Only enter if we can get in at 15¢ or less
            
            // Chainlink staleness check - if TOO stale, might update soon
            maxChainlinkStaleness: 50,  // Max 50 seconds stale (won't update in time)
            minChainlinkStaleness: 5,   // Min 5 seconds (confirms it's not about to update)
            
            maxPosition: 100,
            enabledCryptos: ['btc', 'eth', 'sol'],  // Not XRP (no Chainlink)
            ...options
        };
        this.tradedThisWindow = {};
        this.stats = { signals: 0, final_second_opportunities: 0 };
    }
    
    getName() { return this.name; }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        // Position management - HOLD TO EXPIRY (these are final seconds, no time to manage)
        if (position) {
            return this.createSignal('hold', null, 'holding_to_expiry');
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // THE KEY: Only trade in final seconds window
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_late', { timeRemaining });
        }
        if (timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'too_early', { timeRemaining });
        }
        
        // Get all price data
        const strike = tick.price_to_beat;
        const binancePrice = tick.spot_price;
        const chainlinkPrice = tick.chainlink_price;
        const chainlinkStaleness = tick.chainlink_staleness || 0;
        
        // MUST have Chainlink data
        if (!chainlinkPrice || !strike || !binancePrice) {
            return this.createSignal('hold', null, 'missing_data');
        }
        
        // Check Chainlink staleness - we want it "just right"
        // Too fresh (< 5s) = might be about to update again
        // Too stale (> 50s) = might be about to heartbeat update
        if (chainlinkStaleness < this.options.minChainlinkStaleness) {
            return this.createSignal('hold', null, 'chainlink_too_fresh', { 
                staleness: chainlinkStaleness 
            });
        }
        if (chainlinkStaleness > this.options.maxChainlinkStaleness) {
            return this.createSignal('hold', null, 'chainlink_too_stale', { 
                staleness: chainlinkStaleness 
            });
        }
        
        // Determine which side each source is on
        const binanceUp = binancePrice > strike;
        const chainlinkUp = chainlinkPrice > strike;
        
        // Do they disagree?
        if (binanceUp === chainlinkUp) {
            return this.createSignal('hold', null, 'sources_agree');
        }
        
        this.stats.final_second_opportunities++;
        
        // They disagree! Bet on CHAINLINK's side
        const betSide = chainlinkUp ? 'up' : 'down';
        const entryPrice = chainlinkUp ? tick.up_ask : tick.down_ask;
        
        // Check entry price - we want CHEAP (this is where the 100x comes from)
        if (!entryPrice || entryPrice > this.options.maxEntryPrice) {
            return this.createSignal('hold', null, 'not_cheap_enough', {
                entryPrice: entryPrice?.toFixed(2) || 'N/A',
                maxAllowed: this.options.maxEntryPrice
            });
        }
        
        // Check Chainlink margin from strike
        const chainlinkMargin = chainlinkUp 
            ? (chainlinkPrice - strike) / strike
            : (strike - chainlinkPrice) / strike;
            
        if (chainlinkMargin < this.options.minChainlinkMargin) {
            return this.createSignal('hold', null, 'chainlink_too_close', {
                margin: (chainlinkMargin * 100).toFixed(3) + '%'
            });
        }
        
        // Calculate potential return
        const potentialReturn = ((1 / entryPrice) - 1) * 100;
        
        // ALL CONDITIONS MET - This is the "frozen Chainlink" edge!
        this.stats.signals++;
        this.tradedThisWindow[crypto] = windowEpoch;
        
        console.log(`\n🎯🎯🎯 [CL_FinalSeconds] FINAL SECONDS OPPORTUNITY ${crypto}:`);
        console.log(`   ⏱️  Time remaining: ${Math.round(timeRemaining)}s`);
        console.log(`   📊 Strike: $${strike.toFixed(2)}`);
        console.log(`   📈 Binance: $${binancePrice.toFixed(2)} → ${binanceUp ? 'UP' : 'DOWN'}`);
        console.log(`   🔗 Chainlink: $${chainlinkPrice.toFixed(2)} → ${chainlinkUp ? 'UP' : 'DOWN'} (${chainlinkStaleness}s stale)`);
        console.log(`   💰 Entry price: ${(entryPrice * 100).toFixed(0)}¢`);
        console.log(`   🚀 Potential return: ${potentialReturn.toFixed(0)}x`);
        console.log(`   ✅ Betting: ${betSide.toUpperCase()} (Chainlink is FROZEN)\n`);
        
        return this.createSignal('buy', betSide, 'chainlink_frozen_divergence', {
            binancePrice: binancePrice.toFixed(2),
            binanceSide: binanceUp ? 'UP' : 'DOWN',
            chainlinkPrice: chainlinkPrice.toFixed(2),
            chainlinkSide: chainlinkUp ? 'UP' : 'DOWN',
            chainlinkStaleness: chainlinkStaleness + 's',
            strike: strike.toFixed(2),
            chainlinkMargin: (chainlinkMargin * 100).toFixed(2) + '%',
            entryPrice: (entryPrice * 100).toFixed(0) + '¢',
            potentialReturn: potentialReturn.toFixed(0) + 'x',
            timeRemaining: Math.round(timeRemaining) + 's'
        });
    }
    
    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }
    
    onWindowStart(windowInfo) { this.tradedThisWindow = {}; }
    onWindowEnd(windowInfo, outcome) {}
    getStats() { return { name: this.name, ...this.stats }; }
}

/**
 * Ultra-aggressive final seconds - trades at 10¢ or less, final 15 seconds
 */
export class ChainlinkFinalSecondsUltraStrategy extends ChainlinkFinalSecondsStrategy {
    constructor(options = {}) {
        super({
            name: 'CL_FinalSeconds_Ultra',
            minTimeRemaining: 3,     // Down to 3 seconds!
            maxTimeRemaining: 15,    // Final 15 seconds only
            maxEntryPrice: 0.10,     // Only 10¢ or less (10x+ potential)
            minChainlinkMargin: 0.0005,  // Tighter margin OK
            ...options
        });
    }
}

export function createCLFinalSeconds(capital = 100) {
    return new ChainlinkFinalSecondsStrategy({ maxPosition: capital });
}

export function createCLFinalSecondsUltra(capital = 100) {
    return new ChainlinkFinalSecondsUltraStrategy({ maxPosition: capital });
}

// Factory functions for Chainlink-confirmed strategies
export function createSpotLagCLConfirmed(capital = 100) {
    return new SpotLagChainlinkConfirmedStrategy({ maxPosition: capital });
}

export function createSpotLagAggressiveCL(capital = 100) {
    return new SpotLagAggressiveCLStrategy({ maxPosition: capital });
}

export function createMispricingCLConfirmed(capital = 100) {
    return new MispricingChainlinkConfirmedStrategy({ maxPosition: capital });
}

export function createUpOnlyCLConfirmed(capital = 100) {
    return new UpOnlyChainlinkStrategy({ maxPosition: capital });
}

// ================================================================
// REMOVED: SpotLag_TP3 and SpotLag_TP6 (Jan 2026)
// These fixed take-profit strategies were too rigid.
// Trailing stop logic added to TimeAware and ProbEdge strategies instead.
// ================================================================

// ================================================================
// TP3 + TRAILING HYBRID STRATEGY
// Quick profit OR let winners run
// ================================================================

/**
 * SpotLag_TP3_Trailing - Hybrid Strategy
 * 
 * THESIS: TP3 exits too early on big winners. This hybrid:
 * 1. Takes quick 3% profit if momentum fades
 * 2. BUT if profit exceeds 5%, activates trailing to capture bigger moves
 * 
 * Logic:
 * - If profit hits 3% but momentum is fading → EXIT (like TP3)
 * - If profit exceeds 5% → activate trailing stop
 * - Trail 8% below peak, floor at 4%
 * - Let winners run to 20%+ while protecting gains
 */
export class SpotLag_TP3_TrailingStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TP3_Trailing',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,
            marketLagRatio: 0.6,
            
            // Take-profit threshold (quick exit)
            takeProfitThreshold: 0.03,  // 3%
            
            // Trailing activation (let winners run)
            trailingActivation: 0.05,   // Activate at 5%
            trailPercent: 0.08,         // Trail 8% below peak
            profitFloor: 0.04,          // Never below 4% once trailing
            
            ...options
        });
        
        this.highWaterMark = {};
        this.trailingActivated = {};
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        
        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        // POSITION MANAGEMENT - HYBRID TP3 + TRAILING
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            
            const hwm = this.highWaterMark[crypto];
            
            // Check if trailing should activate
            if (!this.trailingActivated[crypto] && pnlPct >= this.options.trailingActivation) {
                this.trailingActivated[crypto] = true;
                console.log(`[TP3_Trailing] ${crypto}: TRAILING ACTIVATED at ${(pnlPct * 100).toFixed(1)}% profit`);
            }
            
            // TRAILING LOGIC (if activated)
            if (this.trailingActivated[crypto]) {
                const trailingStop = hwm * (1 - this.options.trailPercent);
                const floorPrice = position.entryPrice * (1 + this.options.profitFloor);
                const effectiveStop = Math.max(trailingStop, floorPrice);
                
                if (currentPrice <= effectiveStop) {
                    // Clean up
                    delete this.highWaterMark[crypto];
                    delete this.trailingActivated[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;
                    
                    return this.createSignal('sell', null, 'trailing_stop', {
                        entryPrice: position.entryPrice.toFixed(2),
                        exitPrice: currentPrice.toFixed(2),
                        hwm: hwm.toFixed(2),
                        pnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }
                
                // Still trailing - hold
                return this.createSignal('hold', null, 'trailing_active', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    hwm: hwm.toFixed(2),
                    trailStop: effectiveStop.toFixed(2)
                });
            }
            
            // QUICK TP3 LOGIC (if not trailing yet)
            // Take 3% profit if available
            if (pnlPct >= this.options.takeProfitThreshold) {
                delete this.highWaterMark[crypto];
                delete this.trailingActivated[crypto];
                this.tradedThisWindow[crypto] = windowEpoch;
                
                return this.createSignal('sell', null, 'take_profit_3pct', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    entryPrice: position.entryPrice.toFixed(2),
                    exitPrice: currentPrice.toFixed(2)
                });
            }
            
            // Holding, not yet at TP
            return this.createSignal('hold', null, 'holding_position', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                target: (this.options.takeProfitThreshold * 100) + '%'
            });
        }
        
        // Clean up if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActivated[crypto];
        
        // Use parent's entry logic
        return super.onTick(tick, position, context);
    }
    
    onWindowStart(windowInfo) {
        super.onWindowStart(windowInfo);
        this.highWaterMark = {};
        this.trailingActivated = {};
    }
}

export function createSpotLagTP3Trailing(capital = 100) {
    return new SpotLag_TP3_TrailingStrategy({ maxPosition: capital });
}

// ================================================================
// TRAILING STOP STRATEGY
// Lets winners run while protecting profits
// ================================================================

/**
 * SpotLag with Trailing Stop
 * 
 * THESIS: Fixed take-profit (3-6%) exits too early on big winners.
 * A trailing stop lets winners run while protecting accumulated gains.
 * 
 * Logic:
 * 1. Enter using SpotLag_Aggressive entry criteria
 * 2. Once profit exceeds activationThreshold (e.g., 5%), activate trailing stop
 * 3. Track high-water mark (peak price since entry)
 * 4. Trail by trailPercent (e.g., 10%) below high-water mark
 * 5. Exit when price drops below trailing stop
 * 6. Never exit below a profit floor (e.g., 3%) once trailing is activated
 * 
 * Example:
 * - Entry: 80¢, activation at 5% = 84¢
 * - Price runs to 99¢ → high-water mark = 99¢
 * - Trailing stop at 10% below HWM = 89.1¢
 * - If price drops to 89¢ → exit with ~9¢ profit vs 4¢ with TP5
 */
export class SpotLag_TrailingStopStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trailing',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,  // Aggressive entry
            marketLagRatio: 0.6,
            
            // Trailing stop parameters
            activationThreshold: 0.05,   // Activate trailing after 5% profit
            trailPercent: 0.10,          // Trail 10% below high-water mark
            profitFloor: 0.03,           // Never exit below 3% profit once activated
            
            ...options
        });
        
        // Track high-water mark per crypto
        this.highWaterMark = {};  // crypto -> highest price seen since entry
        this.trailingActivated = {};  // crypto -> boolean
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const windowEpoch = tick.window_epoch;
        
        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        // POSITION MANAGEMENT WITH TRAILING STOP
        if (position) {
            // Get current sellable price
            const currentPrice = position.side === 'up' 
                ? tick.up_bid 
                : tick.down_bid;
            
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            
            const hwm = this.highWaterMark[crypto];
            const hwmPnlPct = (hwm - position.entryPrice) / position.entryPrice;
            
            // Check if trailing stop should be activated
            if (!this.trailingActivated[crypto] && pnlPct >= this.options.activationThreshold) {
                this.trailingActivated[crypto] = true;
                console.log(`[TrailingStop] ${crypto}: ACTIVATED at ${(pnlPct * 100).toFixed(1)}% profit, HWM=${hwm.toFixed(3)}`);
            }
            
            // If trailing is activated, check for exit
            if (this.trailingActivated[crypto]) {
                // Calculate trailing stop level
                const trailingStopPrice = hwm * (1 - this.options.trailPercent);
                
                // Calculate profit floor price
                const floorPrice = position.entryPrice * (1 + this.options.profitFloor);
                
                // Trailing stop can't go below floor
                const effectiveStop = Math.max(trailingStopPrice, floorPrice);
                
                // Check if we should exit
                if (currentPrice <= effectiveStop) {
                    // Clean up state
                    delete this.highWaterMark[crypto];
                    delete this.trailingActivated[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;
                    
                    const exitReason = currentPrice <= trailingStopPrice ? 'trailing_stop' : 'profit_floor';
                    
                    return this.createSignal('sell', null, exitReason, {
                        pnlPct: (pnlPct * 100).toFixed(1) + '%',
                        entryPrice: position.entryPrice.toFixed(3),
                        exitPrice: currentPrice.toFixed(3),
                        highWaterMark: hwm.toFixed(3),
                        hwmPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                        trailingStopPrice: trailingStopPrice.toFixed(3),
                        floorPrice: floorPrice.toFixed(3)
                    });
                }
                
                // Still holding with active trailing stop
                return this.createSignal('hold', null, 'trailing_active', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    hwm: hwm.toFixed(3),
                    hwmPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                    trailingStop: effectiveStop.toFixed(3),
                    cushion: ((currentPrice - effectiveStop) / effectiveStop * 100).toFixed(1) + '%'
                });
            }
            
            // Not yet activated - check for extreme stop (safety)
            if (pnlPct <= -this.options.extremeStopLoss) {
                delete this.highWaterMark[crypto];
                delete this.trailingActivated[crypto];
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            // Waiting for activation
            return this.createSignal('hold', null, 'waiting_for_activation', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                activationAt: (this.options.activationThreshold * 100) + '%',
                needed: ((this.options.activationThreshold - pnlPct) * 100).toFixed(1) + '%'
            });
        }
        
        // Reset tracking when no position
        delete this.highWaterMark[crypto];
        delete this.trailingActivated[crypto];
        
        // Entry logic - delegate to parent
        return super.onTick(tick, position, context);
    }
    
    onWindowStart(windowInfo) {
        super.onWindowStart && super.onWindowStart(windowInfo);
        // Reset trailing state on new window
        this.highWaterMark = {};
        this.trailingActivated = {};
    }
}

/**
 * Tighter trailing - activates earlier, tighter trail
 * Good for volatile markets where quick reversals happen
 */
export class SpotLag_TrailingTightStrategy extends SpotLag_TrailingStopStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TrailTight',
            activationThreshold: 0.03,   // Activate at 3% profit
            trailPercent: 0.05,          // Trail 5% below HWM (tighter)
            profitFloor: 0.02,           // Floor at 2% profit
            ...options
        });
    }
}

/**
 * Wider trailing - lets winners run more
 * Good for trending markets with big moves
 */
export class SpotLag_TrailingWideStrategy extends SpotLag_TrailingStopStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TrailWide',
            activationThreshold: 0.08,   // Activate at 8% profit
            trailPercent: 0.15,          // Trail 15% below HWM (wider)
            profitFloor: 0.05,           // Floor at 5% profit
            ...options
        });
    }
}

export function createSpotLagTrailing(capital = 100) {
    return new SpotLag_TrailingStopStrategy({ maxPosition: capital });
}

export function createSpotLagTrailTight(capital = 100) {
    return new SpotLag_TrailingTightStrategy({ maxPosition: capital });
}

export function createSpotLagTrailWide(capital = 100) {
    return new SpotLag_TrailingWideStrategy({ maxPosition: capital });
}

// ================================================================
// VOLATILITY-ADAPTIVE TAKE-PROFIT STRATEGY
// ================================================================
// Based on backtest analysis:
// - HIGH VOL (>8% range): 100% hit rate on 15% TP → use 12% TP
// - MED VOL (4-8% range): 84% hit rate on 15% TP → use 6% TP  
// - LOW VOL (<4% range): Only 51% hit 3% TP → hold to expiry
// ================================================================

export class SpotLag_VolatilityAdaptiveStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_VolAdapt',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,  // Aggressive entry
            marketLagRatio: 0.6,
            
            // Volatility thresholds (market price range over lookback)
            highVolThreshold: 0.08,    // >8% = high volatility
            medVolThreshold: 0.04,     // 4-8% = medium volatility
            
            // Dynamic take-profit levels based on volatility regime
            highVolTakeProfit: 0.12,   // 12% TP in high vol (conservative from 15%)
            medVolTakeProfit: 0.06,    // 6% TP in medium vol
            lowVolTakeProfit: null,    // No TP in low vol - hold to expiry
            
            ...options
        });
        
        // Track volatility per crypto for logging
        this.volatilityState = {};
    }
    
    calculateVolatility(crypto) {
        const state = this.state[crypto];
        if (!state || state.marketHistory.length < 5) {
            return { volatility: 0, regime: 'unknown' };
        }
        
        // Calculate range over recent market prices
        const prices = state.marketHistory.slice(-20);
        const max = Math.max(...prices);
        const min = Math.min(...prices);
        const volatility = max - min;
        
        // Determine regime
        let regime;
        if (volatility >= this.options.highVolThreshold) {
            regime = 'HIGH';
        } else if (volatility >= this.options.medVolThreshold) {
            regime = 'MEDIUM';
        } else {
            regime = 'LOW';
        }
        
        return { volatility, regime, max, min };
    }
    
    getTakeProfitThreshold(regime) {
        switch (regime) {
            case 'HIGH':
                return this.options.highVolTakeProfit;
            case 'MEDIUM':
                return this.options.medVolTakeProfit;
            case 'LOW':
            default:
                return this.options.lowVolTakeProfit; // null = no TP
        }
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        
        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 20; // Extra for volatility calc
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        // Calculate current volatility
        const volInfo = this.calculateVolatility(crypto);
        this.volatilityState[crypto] = volInfo;
        
        // POSITION MANAGEMENT WITH VOLATILITY-ADAPTIVE TAKE-PROFIT
        if (position) {
            const currentPrice = position.side === 'up' 
                ? tick.up_bid 
                : tick.down_bid;
            
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Get dynamic take-profit threshold based on volatility
            const tpThreshold = this.getTakeProfitThreshold(volInfo.regime);
            
            // 1. TAKE-PROFIT (only if threshold is set for this regime)
            if (tpThreshold !== null && pnlPct >= tpThreshold) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'take_profit_vol_adaptive', { 
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    entryPrice: position.entryPrice.toFixed(2),
                    exitPrice: currentPrice.toFixed(2),
                    volRegime: volInfo.regime,
                    volatility: (volInfo.volatility * 100).toFixed(1) + '%',
                    threshold: (tpThreshold * 100) + '%'
                });
            }
            
            // 2. EXTREME STOP-LOSS (safety net)
            if (pnlPct <= -this.options.extremeStopLoss) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { 
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    volRegime: volInfo.regime
                });
            }
            
            // 3. HOLD - waiting for TP or expiry
            const holdReason = tpThreshold !== null 
                ? `holding_vol_${volInfo.regime}_tp${(tpThreshold*100).toFixed(0)}pct`
                : `holding_vol_${volInfo.regime}_no_tp`;
            
            return this.createSignal('hold', null, holdReason, {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                volRegime: volInfo.regime,
                volatility: (volInfo.volatility * 100).toFixed(1) + '%'
            });
        }
        
        // BLOCK RE-ENTRY if already traded this window
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded_this_window');
        }
        
        // ENTRY LOGIC - same as parent but log volatility
        const signal = super.onTick(tick, position, context);
        
        // Enhance entry signal with volatility info
        if (signal.action === 'buy') {
            signal.metadata = {
                ...signal.metadata,
                volRegime: volInfo.regime,
                volatility: (volInfo.volatility * 100).toFixed(1) + '%',
                dynamicTP: this.getTakeProfitThreshold(volInfo.regime)
            };
        }
        
        return signal;
    }
}

export function createSpotLagVolAdapt(capital = 100) {
    return new SpotLag_VolatilityAdaptiveStrategy({ maxPosition: capital });
}

// ================================================================
// NEW STRATEGIES BASED ON LIVE DATA ANALYSIS (Jan 2026)
// ================================================================

/**
 * SpotLag_LateValue Strategy
 * 
 * THESIS: Late in the window (60-180s) + cheap entry (<50c) + strong lag
 * This is the "dream scenario" - market disagrees with us, but we catch the move.
 * 
 * Key insight: Winners had cheap entries + big spot moves during trade.
 * Late timing reduces reversal risk.
 */
export class SpotLag_LateValueStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_LateValue',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0003,  // 0.03% - need some movement
            marketLagRatio: 0.5,
            minTimeRemaining: 60,       // At least 1 min (for execution)
            maxTimeRemaining: 180,      // Max 3 min (late game focus)
            ...options
        });
        
        // Additional constraints for this strategy
        this.maxEntryPrice = options.maxEntryPrice || 0.50;  // Only cheap entries
        this.minSpotDistFromStrike = options.minSpotDistFromStrike || 0.0005;  // 0.05% min (not pure noise)
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        // Hold to expiry if we have position
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            return this.createSignal('hold', null, 'holding_late_value', { 
                pnlPct: (pnlPct * 100).toFixed(1) + '%' 
            });
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // TIME GATE: Only 60-180s window
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time_for_late_value', { 
                timeRemaining,
                required: '60-180s'
            });
        }
        
        // Get price context
        const strike = tick.price_to_beat;
        const spotPrice = tick.spot_price;
        
        if (!strike || !spotPrice) {
            return this.createSignal('hold', null, 'missing_price_data');
        }
        
        // Calculate spot distance from strike
        const spotDistFromStrike = Math.abs(spotPrice - strike) / strike;
        
        // FILTER: Need some distance (not pure noise)
        if (spotDistFromStrike < this.minSpotDistFromStrike) {
            return this.createSignal('hold', null, 'spot_too_close_to_strike', {
                distance: (spotDistFromStrike * 100).toFixed(3) + '%',
                minRequired: (this.minSpotDistFromStrike * 100).toFixed(2) + '%'
            });
        }
        
        // Determine our bet direction from lag signal
        const state = this.initCrypto(crypto);
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_history');
        }
        
        // Calculate lag signal
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving_enough');
        }
        
        // Determine direction
        const betSide = spotMove > 0 ? 'up' : 'down';
        const entryPrice = betSide === 'up' ? tick.up_ask : tick.down_ask;
        
        // CHEAP ENTRY GATE: Must be under max entry price
        if (entryPrice > this.maxEntryPrice) {
            return this.createSignal('hold', null, 'entry_too_expensive', {
                entryPrice: entryPrice.toFixed(2),
                maxAllowed: this.maxEntryPrice.toFixed(2)
            });
        }
        
        // ALL CONDITIONS MET - Enter!
        this.tradedThisWindow[crypto] = windowEpoch;
        
        return this.createSignal('buy', betSide, 'late_value_entry', {
            entryPrice: entryPrice.toFixed(2),
            timeRemaining: timeRemaining.toFixed(0) + 's',
            spotDistFromStrike: (spotDistFromStrike * 100).toFixed(3) + '%',
            spotMove: (spotMove * 100).toFixed(3) + '%',
            spotPrice: spotPrice.toFixed(2),
            strike: strike.toFixed(2)
        });
    }
}

/**
 * SpotLag_DeepValue Strategy
 * 
 * THESIS: Very cheap entries (<30c) with strong conviction
 * High risk/reward - market strongly disagrees, but if we're right it's a big win.
 * 
 * From paper data: 2c-26c entries had best wins (+$98, +$90, +$88)
 */
export class SpotLag_DeepValueStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_DeepValue',
            lookbackTicks: 10,
            spotMoveThreshold: 0.0004,  // 0.04% - stronger signal required
            marketLagRatio: 0.4,        // Market must be really lagging
            minTimeRemaining: 90,       // At least 1.5 min
            maxTimeRemaining: 300,      // Up to 5 min
            ...options
        });
        
        this.maxEntryPrice = options.maxEntryPrice || 0.30;  // Very cheap only
        this.minSpotDistFromStrike = options.minSpotDistFromStrike || 0.0003;  // 0.03%
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            return this.createSignal('hold', null, 'holding_deep_value', { 
                pnlPct: (pnlPct * 100).toFixed(1) + '%' 
            });
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time', { timeRemaining });
        }
        
        const strike = tick.price_to_beat;
        const spotPrice = tick.spot_price;
        
        if (!strike || !spotPrice) {
            return this.createSignal('hold', null, 'missing_data');
        }
        
        const spotDistFromStrike = Math.abs(spotPrice - strike) / strike;
        if (spotDistFromStrike < this.minSpotDistFromStrike) {
            return this.createSignal('hold', null, 'too_close_to_strike');
        }
        
        // Build history
        const state = this.initCrypto(crypto);
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_history');
        }
        
        // Calculate lag
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        
        const oldMarket = state.marketHistory[state.marketHistory.length - this.options.lookbackTicks];
        const newMarket = state.marketHistory[state.marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        
        // Expected market move
        const expectedMarketMove = spotMove * 0.5;
        
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving');
        }
        
        // Check if market is lagging
        if (Math.abs(marketMove) > Math.abs(expectedMarketMove) * this.options.marketLagRatio) {
            return this.createSignal('hold', null, 'market_not_lagging');
        }
        
        const betSide = spotMove > 0 ? 'up' : 'down';
        const entryPrice = betSide === 'up' ? tick.up_ask : tick.down_ask;
        
        // DEEP VALUE GATE: Must be very cheap
        if (entryPrice > this.maxEntryPrice) {
            return this.createSignal('hold', null, 'not_deep_value', {
                entryPrice: entryPrice.toFixed(2),
                maxAllowed: this.maxEntryPrice.toFixed(2)
            });
        }
        
        this.tradedThisWindow[crypto] = windowEpoch;
        
        return this.createSignal('buy', betSide, 'deep_value_entry', {
            entryPrice: entryPrice.toFixed(2),
            timeRemaining: timeRemaining.toFixed(0) + 's',
            spotDistFromStrike: (spotDistFromStrike * 100).toFixed(3) + '%',
            spotMove: (spotMove * 100).toFixed(3) + '%',
            marketMove: (marketMove * 100).toFixed(2) + '%',
            spotPrice: spotPrice.toFixed(2),
            strike: strike.toFixed(2)
        });
    }
}

/**
 * SpotLag_CorrectSideOnly Strategy
 * 
 * THESIS: Only enter when spot is ALREADY on the correct side of strike.
 * From live data: 65.4% WR when correct side vs 14.3% when wrong side.
 * 
 * This is the "confirmation" play - lower risk, consistent returns.
 */
export class SpotLag_CorrectSideOnlyStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_CorrectSide',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,
            marketLagRatio: 0.6,
            minTimeRemaining: 60,   // Skip the deadzone
            maxTimeRemaining: 600,
            ...options
        });
        
        this.minSpotMargin = options.minSpotMargin || 0.0005;  // 0.05% - spot must be clearly on one side
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            return this.createSignal('hold', null, 'holding_correct_side', { 
                pnlPct: (pnlPct * 100).toFixed(1) + '%' 
            });
        }
        
        const windowEpoch = tick.window_epoch;
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // DEADZONE BLOCK: Skip 2-5min (120-300s) - 8% WR death zone
        if (timeRemaining >= 120 && timeRemaining <= 300) {
            return this.createSignal('hold', null, 'deadzone_blocked', {
                timeRemaining,
                reason: '2-5min has 8% WR'
            });
        }
        
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time', { timeRemaining });
        }
        
        const strike = tick.price_to_beat;
        const spotPrice = tick.spot_price;
        
        if (!strike || !spotPrice) {
            return this.createSignal('hold', null, 'missing_data');
        }
        
        // Calculate spot's position relative to strike
        const spotMargin = (spotPrice - strike) / strike;  // Positive = above strike
        const spotAboveStrike = spotMargin > 0;
        
        // Check if spot has enough margin (not noise)
        if (Math.abs(spotMargin) < this.minSpotMargin) {
            return this.createSignal('hold', null, 'spot_too_close_to_strike', {
                margin: (spotMargin * 100).toFixed(3) + '%',
                minRequired: (this.minSpotMargin * 100).toFixed(2) + '%'
            });
        }
        
        // Build history for lag check
        const state = this.initCrypto(crypto);
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_history');
        }
        
        // Calculate lag
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving');
        }
        
        // Determine where spot IS (not where it's moving)
        const spotSide = spotAboveStrike ? 'up' : 'down';
        
        // Also check momentum confirms the position
        const lagSide = spotMove > 0 ? 'up' : 'down';
        
        // CORRECT SIDE GATE: Momentum must confirm spot's current side
        // (spot above strike AND moving up, OR spot below strike AND moving down)
        if (lagSide !== spotSide) {
            return this.createSignal('hold', null, 'lag_disagrees_with_spot', {
                spotSide,
                lagSide,
                reason: 'Only enter when momentum confirms spot position'
            });
        }
        
        // BET ON WHERE SPOT IS, not where it's moving
        const entryPrice = spotSide === 'up' ? tick.up_ask : tick.down_ask;
        
        this.tradedThisWindow[crypto] = windowEpoch;
        
        return this.createSignal('buy', spotSide, 'correct_side_confirmed', {
            entryPrice: entryPrice.toFixed(2),
            timeRemaining: timeRemaining.toFixed(0) + 's',
            spotMargin: (spotMargin * 100).toFixed(3) + '%',
            spotMove: (spotMove * 100).toFixed(3) + '%',
            spotPrice: spotPrice.toFixed(2),
            strike: strike.toFixed(2),
            spotAboveStrike: spotAboveStrike
        });
    }
}

/**
 * SpotLag_ExtremeReversal Strategy
 * 
 * THESIS: When market is at extreme (<25¢ or >75¢), strong consensus exists.
 * If spot then moves STRONGLY against that consensus, it may signal a reversal.
 * 
 * Key: Require LARGE moves at extremes + use trailing stop to capture reversal.
 * 
 * From data: Moderate zone (20-35¢, 65-80¢) had 83% WR.
 * Extreme zone (<20¢, >80¢) had 41% WR with small moves.
 * Hypothesis: Large moves at extremes could be predictive.
 */
export class SpotLag_ExtremeReversalStrategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_ExtremeReversal',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0008,  // 0.08% BASE - much higher than normal
            marketLagRatio: 0.4,
            minTimeRemaining: 120,      // At least 2 min for reversal to play out
            maxTimeRemaining: 600,      // Not too early
            ...options
        });
        
        // Extreme zone boundaries
        this.extremeThreshold = options.extremeThreshold || 0.25;  // <25¢ or >75¢
        
        // Trailing stop parameters for reversal capture
        this.activationThreshold = options.activationThreshold || 0.08;  // 8% profit to activate
        this.trailPercent = options.trailPercent || 0.12;  // Trail 12% below peak
        this.profitFloor = options.profitFloor || 0.05;    // Lock in 5% minimum
        
        this.highWaterMark = {};
        this.trailingActivated = {};
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const windowEpoch = tick.window_epoch;
        const marketPrice = tick.up_mid || 0.5;
        
        // POSITION MANAGEMENT WITH TRAILING STOP
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            
            const hwm = this.highWaterMark[crypto];
            
            // Check if trailing stop should be activated
            if (!this.trailingActivated[crypto] && pnlPct >= this.activationThreshold) {
                this.trailingActivated[crypto] = true;
            }
            
            // If trailing is activated, check for exit
            if (this.trailingActivated[crypto]) {
                const trailingStopPrice = hwm * (1 - this.trailPercent);
                const floorPrice = position.entryPrice * (1 + this.profitFloor);
                const effectiveStop = Math.max(trailingStopPrice, floorPrice);
                
                if (currentPrice <= effectiveStop) {
                    delete this.highWaterMark[crypto];
                    delete this.trailingActivated[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;
                    
                    return this.createSignal('sell', null, 'extreme_reversal_trailing_exit', {
                        entryPrice: position.entryPrice.toFixed(2),
                        exitPrice: currentPrice.toFixed(2),
                        hwm: hwm.toFixed(2),
                        pnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }
            }
            
            return this.createSignal('hold', null, 'holding_extreme_reversal', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                trailing: this.trailingActivated[crypto] ? 'ACTIVE' : 'waiting'
            });
        }
        
        // Clean up state if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActivated[crypto];
        
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }
        
        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < this.options.minTimeRemaining || timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'wrong_time', { timeRemaining });
        }
        
        // EXTREME ZONE CHECK: Only trade when market is at extreme
        const isExtreme = marketPrice < this.extremeThreshold || marketPrice > (1 - this.extremeThreshold);
        
        if (!isExtreme) {
            return this.createSignal('hold', null, 'not_extreme_zone', {
                marketPrice: (marketPrice * 100).toFixed(0) + '¢',
                required: '<' + (this.extremeThreshold * 100) + '¢ or >' + ((1 - this.extremeThreshold) * 100) + '¢'
            });
        }
        
        // Build history
        const state = this.initCrypto(crypto);
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_history');
        }
        
        // Calculate spot movement
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        
        // LARGE MOVE CHECK: At extremes, require bigger moves
        // Additional multiplier on top of already high base threshold
        const extremeMultiplier = 1.5;  // 50% harder at extremes
        const requiredMove = this.options.spotMoveThreshold * extremeMultiplier;
        
        if (Math.abs(spotMove) < requiredMove) {
            return this.createSignal('hold', null, 'move_not_large_enough', {
                spotMove: (spotMove * 100).toFixed(4) + '%',
                required: (requiredMove * 100).toFixed(4) + '%'
            });
        }
        
        // Determine direction: bet AGAINST the current extreme consensus
        // If market is at 10¢ (consensus DOWN), and spot moves UP strongly → bet UP
        // If market is at 90¢ (consensus UP), and spot moves DOWN strongly → bet DOWN
        const betSide = spotMove > 0 ? 'up' : 'down';
        const entryPrice = betSide === 'up' ? tick.up_ask : tick.down_ask;
        
        // Verify we're betting against consensus (the whole point)
        const isContrarian = (marketPrice < 0.5 && betSide === 'up') || 
                            (marketPrice > 0.5 && betSide === 'down');
        
        if (!isContrarian) {
            return this.createSignal('hold', null, 'not_contrarian', {
                marketPrice: (marketPrice * 100).toFixed(0) + '¢',
                betSide,
                reason: 'Extreme reversal requires betting against consensus'
            });
        }
        
        this.tradedThisWindow[crypto] = windowEpoch;
        
        return this.createSignal('buy', betSide, 'extreme_reversal_entry', {
            entryPrice: entryPrice.toFixed(2),
            marketPrice: (marketPrice * 100).toFixed(0) + '¢',
            spotMove: (spotMove * 100).toFixed(3) + '%',
            timeRemaining: timeRemaining.toFixed(0) + 's',
            thesis: 'Large move against strong consensus'
        });
    }
}

// Factory functions for new strategies
export function createSpotLagLateValue(capital = 100) {
    return new SpotLag_LateValueStrategy({ maxPosition: capital });
}

export function createSpotLagDeepValue(capital = 100) {
    return new SpotLag_DeepValueStrategy({ maxPosition: capital });
}

export function createSpotLagCorrectSide(capital = 100) {
    return new SpotLag_CorrectSideOnlyStrategy({ maxPosition: capital });
}

export function createSpotLagExtremeReversal(capital = 100) {
    return new SpotLag_ExtremeReversalStrategy({ maxPosition: capital });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-AWARE SPOTLAG STRATEGIES (v2)
// ═══════════════════════════════════════════════════════════════════════════════
// Based on fair value analysis showing market DOES price time correctly:
// - When spot is 0.2%+ above strike at 10min: market prob ~84%
// - When spot is 0.2%+ above strike at <60s: market prob ~90%
//
// The edge is NOT in fair value mispricing, but in SPEED:
// - Catch the market before it updates after spot moves
// - Only enter when time-adjusted probability favors us
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Time-Aware SpotLag Base Strategy
 *
 * Combines spot lag detection with time-to-expiry awareness.
 * Only enters when:
 * 1. Spot has moved significantly
 * 2. Market hasn't caught up (lag)
 * 3. Time remaining creates favorable probability dynamics
 *
 * Key insight: Early in window, small displacements create smaller edges.
 * Late in window, same displacement = near-certain outcome.
 */
/**
 * Time-Aware SpotLag Strategy
 *
 * TRAILING STOP LOGIC (Jan 2026):
 * - Tracks high-water mark (peak price reached)
 * - Activates trailing after 15% profit (avoids noise exits)
 * - Exits if price drops 30% below peak
 * - Maintains minimum 5% profit floor once trailing active
 * - Otherwise holds to expiry (preserves original behavior for small moves)
 */
export class SpotLag_TimeAwareStrategy {
    constructor(options = {}) {
        this.name = options.name || 'SpotLag_TimeAware';
        this.options = {
            // Spot movement thresholds (as % of spot price)
            spotMoveThreshold: 0.0008,  // 0.08% minimum spot move

            // Market lag detection
            lookbackTicks: 8,
            marketLagRatio: 0.5,  // Market should have moved < 50% of expected

            // Time-based entry rules (key insight from data)
            // Early window (>5min): need larger spot displacement for entry
            // Mid window (2-5min): standard thresholds
            // Late window (<2min): tighter spreads, smaller edges OK
            earlyWindowMinSpotDelta: 0.15,    // Need 0.15% spot delta when >5min left
            midWindowMinSpotDelta: 0.10,      // Need 0.10% spot delta when 2-5min left
            lateWindowMinSpotDelta: 0.05,     // Need 0.05% spot delta when <2min left

            // Time cutoffs
            earlyWindowThreshold: 300,   // >5 min = early
            lateWindowThreshold: 120,    // <2 min = late
            minTimeRemaining: 30,        // Don't enter in final 30s

            // Market probability constraints (avoid fighting strong consensus)
            maxMarketProb: 0.92,  // Don't buy UP if market already >92%
            minMarketProb: 0.08,  // Don't buy DOWN if market already <8%

            // UNDERDOG CONVICTION CHECK
            // When buying a significant underdog (<25% probability), require stronger signal
            // Either: large spot move (real reversal) OR enough time for it to play out
            underdogThreshold: 0.25,          // Below 25% = underdog
            underdogMinTime: 180,             // Underdog needs >3min OR large move
            underdogMoveMultiplier: 2.5,      // Underdog needs 2.5x normal spot move

            // Position sizing
            maxPosition: 100,

            // Enabled cryptos
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],

            // TRAILING STOP PARAMETERS
            trailingActivationPct: 0.15,  // Activate trailing after 15% profit
            trailingStopPct: 0.30,        // Exit if price drops 30% from peak
            minimumProfitFloor: 0.05,     // Never exit below 5% profit once trailing active

            ...options
        };

        this.state = {};
        this.tradedThisWindow = {};
        this.stats = { signals: 0, earlyEntries: 0, midEntries: 0, lateEntries: 0 };

        // Trailing stop state per crypto
        this.highWaterMark = {};
        this.trailingActive = {};
    }

    getName() { return this.name; }

    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],
                marketHistory: [],
                timestamps: []
            };
        }
        return this.state[crypto];
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }

        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;

        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());

        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }

        // POSITION MANAGEMENT WITH TRAILING STOP
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            const hwm = this.highWaterMark[crypto];
            const hwmPnlPct = (hwm - entryPrice) / entryPrice;

            // Check if trailing should activate
            if (!this.trailingActive[crypto] && pnlPct >= this.options.trailingActivationPct) {
                this.trailingActive[crypto] = true;
                console.log(`[${this.name}] ${crypto}: TRAILING ACTIVATED at ${(pnlPct * 100).toFixed(1)}% profit`);
            }

            // TRAILING STOP LOGIC
            if (this.trailingActive[crypto]) {
                const trailingStopPrice = hwm * (1 - this.options.trailingStopPct);
                const floorPrice = entryPrice * (1 + this.options.minimumProfitFloor);
                const effectiveStop = Math.max(trailingStopPrice, floorPrice);

                if (currentPrice <= effectiveStop) {
                    delete this.highWaterMark[crypto];
                    delete this.trailingActive[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;

                    return this.createSignal('sell', null, 'trailing_stop', {
                        entryPrice: entryPrice.toFixed(3),
                        exitPrice: currentPrice.toFixed(3),
                        highWaterMark: hwm.toFixed(3),
                        peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                        exitPnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }

                return this.createSignal('hold', null, 'trailing_active', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                    trailingStop: effectiveStop.toFixed(3)
                });
            }

            // Trailing not yet activated - hold
            return this.createSignal('hold', null, 'holding_pre_trail', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                activationThreshold: (this.options.trailingActivationPct * 100) + '%'
            });
        }

        // Clean up trailing state if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActive[crypto];

        // Block re-entry
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded_this_window');
        }

        // Time filter
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_close_to_expiry');
        }

        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_data');
        }

        // Calculate spot movement
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;

        // Calculate spot delta from strike (price_to_beat)
        const spotDeltaPct = tick.price_to_beat > 0
            ? ((tick.spot_price - tick.price_to_beat) / tick.price_to_beat) * 100
            : 0;

        // Determine time window and minimum spot delta thresholds
        let requiredSpotDelta;
        let timeWindow;
        if (timeRemaining > this.options.earlyWindowThreshold) {
            requiredSpotDelta = this.options.earlyWindowMinSpotDelta;
            timeWindow = 'early';
        } else if (timeRemaining > this.options.lateWindowThreshold) {
            requiredSpotDelta = this.options.midWindowMinSpotDelta;
            timeWindow = 'mid';
        } else {
            requiredSpotDelta = this.options.lateWindowMinSpotDelta;
            timeWindow = 'late';
        }

        // Check if spot delta is sufficient for this time window (minimum threshold)
        if (Math.abs(spotDeltaPct) < requiredSpotDelta) {
            return this.createSignal('hold', null, 'spot_delta_insufficient', {
                spotDeltaPct: spotDeltaPct.toFixed(3) + '%',
                required: requiredSpotDelta + '%',
                timeWindow
            });
        }

        // Check for spot movement (lag detection)
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving');
        }

        // Determine trade side based on spot position
        const side = spotDeltaPct > 0 ? 'up' : 'down';
        const marketProb = tick.up_mid || 0.5;

        // Avoid fighting strong consensus
        if (side === 'up' && marketProb > this.options.maxMarketProb) {
            return this.createSignal('hold', null, 'market_already_high', { marketProb });
        }
        if (side === 'down' && marketProb < this.options.minMarketProb) {
            return this.createSignal('hold', null, 'market_already_low', { marketProb });
        }

        // UNDERDOG CONVICTION CHECK
        // When buying a significant underdog (<25% probability), require stronger signal:
        // Either a large spot move (real reversal) OR enough time for it to play out
        // This prevents buying cheap losers on small immaterial lags
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);
        if (sideProb < this.options.underdogThreshold) {
            const isLargeMove = Math.abs(spotMove) > this.options.spotMoveThreshold * this.options.underdogMoveMultiplier;
            const hasTimeToPlay = timeRemaining > this.options.underdogMinTime;

            if (!isLargeMove && !hasTimeToPlay) {
                console.log(`[${this.name}] ${crypto}: UNDERDOG BLOCKED - ${side} at ${(sideProb * 100).toFixed(1)}%, move=${(Math.abs(spotMove) * 100).toFixed(3)}%, time=${timeRemaining.toFixed(0)}s (needs ${(this.options.spotMoveThreshold * this.options.underdogMoveMultiplier * 100).toFixed(3)}% OR ${this.options.underdogMinTime}s)`);
                return this.createSignal('hold', null, 'underdog_insufficient_conviction', {
                    sideProb: (sideProb * 100).toFixed(1) + '%',
                    spotMove: (Math.abs(spotMove) * 100).toFixed(3) + '%',
                    timeRemaining: timeRemaining.toFixed(0) + 's',
                    requiredMove: (this.options.spotMoveThreshold * this.options.underdogMoveMultiplier * 100).toFixed(3) + '%',
                    requiredTime: this.options.underdogMinTime + 's',
                    needsLargerMove: !isLargeMove,
                    needsMoreTime: !hasTimeToPlay
                });
            }
            // Log when we DO allow an underdog trade
            console.log(`[${this.name}] ${crypto}: UNDERDOG ALLOWED - ${side} at ${(sideProb * 100).toFixed(1)}%, largeMove=${isLargeMove}, hasTime=${hasTimeToPlay}`);
        }

        // Check market lag
        const oldMarket = state.marketHistory[state.marketHistory.length - this.options.lookbackTicks];
        const newMarket = state.marketHistory[state.marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        const expectedMarketMove = spotMove * 10;
        const lagRatio = Math.abs(marketMove) / Math.abs(expectedMarketMove);

        if (lagRatio > this.options.marketLagRatio) {
            return this.createSignal('hold', null, 'market_caught_up', { lagRatio });
        }

        // All conditions met - TRADE
        this.stats.signals++;
        if (timeWindow === 'early') this.stats.earlyEntries++;
        else if (timeWindow === 'mid') this.stats.midEntries++;
        else this.stats.lateEntries++;

        this.tradedThisWindow[crypto] = windowEpoch;

        // Log trade signal clearly (sideProb already calculated above in underdog check)
        console.log(`[${this.name}] 🎯 SIGNAL: BUY ${side.toUpperCase()} ${crypto.toUpperCase()} | ` +
            `window=${timeWindow} time=${timeRemaining.toFixed(0)}s | ` +
            `spotDelta=${spotDeltaPct.toFixed(3)}% lag=${lagRatio.toFixed(2)} | ` +
            `prob=${(sideProb * 100).toFixed(1)}%`);

        return this.createSignal('buy', side, 'time_aware_entry', {
            timeWindow,
            timeRemaining: timeRemaining.toFixed(0) + 's',
            spotDeltaPct: spotDeltaPct.toFixed(3) + '%',
            marketProb: (marketProb * 100).toFixed(1) + '%',
            sideProb: (sideProb * 100).toFixed(1) + '%',
            lagRatio: lagRatio.toFixed(2),
            crypto
        });
    }

    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }
}

/**
 * Time-Aware Aggressive: Lower thresholds, more trades
 * More lenient underdog conviction - willing to take more reversal bets
 */
export class SpotLag_TimeAwareAggressiveStrategy extends SpotLag_TimeAwareStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TimeAwareAggro',
            spotMoveThreshold: 0.0005,
            earlyWindowMinSpotDelta: 0.10,
            midWindowMinSpotDelta: 0.07,
            lateWindowMinSpotDelta: 0.03,
            marketLagRatio: 0.6,
            // More lenient underdog conviction - will take riskier reversal bets
            underdogThreshold: 0.20,       // Only 20% and below = underdog
            underdogMinTime: 120,          // Only need 2 min
            underdogMoveMultiplier: 2.0,   // Only need 2x normal move
            ...options
        });
    }
}

/**
 * Time-Aware Conservative: Higher thresholds, fewer but higher-conviction trades
 * Stricter underdog conviction - only takes reversal bets with strong signals
 */
export class SpotLag_TimeAwareConservativeStrategy extends SpotLag_TimeAwareStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TimeAwareSafe',
            spotMoveThreshold: 0.0012,
            earlyWindowMinSpotDelta: 0.20,
            midWindowMinSpotDelta: 0.15,
            lateWindowMinSpotDelta: 0.08,
            marketLagRatio: 0.4,
            maxMarketProb: 0.88,
            minMarketProb: 0.12,
            // Stricter underdog conviction - only strong reversal signals
            underdogThreshold: 0.30,       // 30% and below = underdog
            underdogMinTime: 240,          // Need 4 min
            underdogMoveMultiplier: 3.0,   // Need 3x normal move
            ...options
        });
    }
}

/**
 * Time-Aware with Take Profit
 * Takes profit when market probability moves significantly in our favor
 */
export class SpotLag_TimeAwareTPStrategy extends SpotLag_TimeAwareStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TimeAwareTP',
            takeProfitThreshold: 0.05,  // 5% profit = exit
            ...options
        });
    }

    onTick(tick, position = null, context = {}) {
        // Handle exit with take profit
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

            if (pnlPct >= this.options.takeProfitThreshold) {
                return this.createSignal('sell', null, 'take_profit', { pnlPct: (pnlPct * 100).toFixed(1) + '%' });
            }

            return this.createSignal('hold', null, 'holding', { pnlPct: (pnlPct * 100).toFixed(1) + '%' });
        }

        // Entry logic from parent
        return super.onTick(tick, position, context);
    }
}

/**
 * Late-Window Only: Only trades in final 2-5 minutes
 * This is where market prob is most predictive of outcome
 */
export class SpotLag_LateWindowOnlyStrategy extends SpotLag_TimeAwareStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_LateOnly',
            earlyWindowThreshold: 300,  // Treat everything >5min as "don't trade"
            lateWindowThreshold: 120,
            minTimeRemaining: 30,
            earlyWindowMinSpotDelta: 999,  // Effectively disable early entries
            midWindowMinSpotDelta: 0.08,
            lateWindowMinSpotDelta: 0.04,
            ...options
        });
    }
}

/**
 * Probability Edge: Only enters when there's a clear gap between
 * where market IS and where it SHOULD BE given spot position and time
 *
 * TRAILING STOP LOGIC (Jan 2026):
 * - Tracks high-water mark (peak price reached)
 * - Activates trailing after 15% profit (avoids noise exits)
 * - Exits if price drops 30% below peak
 * - Maintains minimum 5% profit floor once trailing active
 * - Otherwise holds to expiry (preserves original behavior for small moves)
 */
export class SpotLag_ProbabilityEdgeStrategy {
    constructor(options = {}) {
        this.name = options.name || 'SpotLag_ProbEdge';
        this.options = {
            // Expected probabilities by time bucket when spot is displaced
            // Based on actual data analysis
            expectedProbByTime: {
                // Time remaining (sec) -> expected prob when spot is 0.2%+ above strike
                600: 0.80,  // 10min left: should be ~80%
                300: 0.85,  // 5min left: should be ~85%
                120: 0.89,  // 2min left: should be ~89%
                60: 0.90,   // 1min left: should be ~90%
                30: 0.91    // 30s left: should be ~91%
            },

            // Minimum edge required to trade
            minEdge: 0.05,  // Market must be at least 5% below expected

            // Spot displacement threshold to consider
            minSpotDeltaPct: 0.10,  // Need at least 0.1% spot displacement

            maxPosition: 100,
            minTimeRemaining: 30,
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],

            // TRAILING STOP PARAMETERS
            // Only activates after significant profit to avoid noise exits
            trailingActivationPct: 0.15,  // Activate trailing after 15% profit
            trailingStopPct: 0.30,        // Exit if price drops 30% from peak
            minimumProfitFloor: 0.05,     // Never exit below 5% profit once trailing active

            ...options
        };

        this.state = {};
        this.tradedThisWindow = {};
        this.stats = { signals: 0, avgEdge: 0 };

        // Trailing stop state per crypto
        this.highWaterMark = {};      // crypto -> highest price seen
        this.trailingActive = {};     // crypto -> boolean
    }

    getName() { return this.name; }

    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = { spotHistory: [], marketHistory: [] };
        }
        return this.state[crypto];
    }

    getExpectedProb(timeRemainingSec, spotDeltaPct) {
        // Interpolate expected probability based on time and spot delta
        const times = Object.keys(this.options.expectedProbByTime).map(Number).sort((a, b) => b - a);

        // Find bracketing times
        let expectedProb = 0.5;
        for (let i = 0; i < times.length; i++) {
            if (timeRemainingSec >= times[i]) {
                expectedProb = this.options.expectedProbByTime[times[i]];
                break;
            }
            expectedProb = this.options.expectedProbByTime[times[i]];
        }

        // Adjust for spot delta magnitude (larger delta = higher confidence)
        const deltaMultiplier = Math.min(Math.abs(spotDeltaPct) / 0.2, 1.5);  // Cap at 1.5x
        const adjusted = 0.5 + (expectedProb - 0.5) * deltaMultiplier;

        return Math.min(0.95, Math.max(0.05, adjusted));  // Clamp to [0.05, 0.95]
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }

        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;

        // POSITION MANAGEMENT WITH TRAILING STOP
        if (position) {
            // Get current position value (bid price for selling)
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            const hwm = this.highWaterMark[crypto];
            const hwmPnlPct = (hwm - entryPrice) / entryPrice;

            // Check if trailing should activate (after significant profit)
            if (!this.trailingActive[crypto] && pnlPct >= this.options.trailingActivationPct) {
                this.trailingActive[crypto] = true;
                console.log(`[${this.name}] ${crypto}: TRAILING ACTIVATED at ${(pnlPct * 100).toFixed(1)}% profit (entry=${entryPrice.toFixed(3)}, current=${currentPrice.toFixed(3)})`);
            }

            // TRAILING STOP LOGIC (only if activated)
            if (this.trailingActive[crypto]) {
                // Calculate trailing stop level (X% below high-water mark)
                const trailingStopPrice = hwm * (1 - this.options.trailingStopPct);

                // Calculate minimum floor (entry + minimum profit)
                const floorPrice = entryPrice * (1 + this.options.minimumProfitFloor);

                // Effective stop is the higher of trailing stop and floor
                const effectiveStop = Math.max(trailingStopPrice, floorPrice);

                // Check if we've hit the trailing stop
                if (currentPrice <= effectiveStop) {
                    // Clean up trailing state
                    delete this.highWaterMark[crypto];
                    delete this.trailingActive[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;

                    return this.createSignal('sell', null, 'trailing_stop', {
                        entryPrice: entryPrice.toFixed(3),
                        exitPrice: currentPrice.toFixed(3),
                        highWaterMark: hwm.toFixed(3),
                        peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                        exitPnlPct: (pnlPct * 100).toFixed(1) + '%',
                        trailingStopPrice: trailingStopPrice.toFixed(3),
                        floorPrice: floorPrice.toFixed(3)
                    });
                }

                // Still above trailing stop, continue holding
                return this.createSignal('hold', null, 'trailing_active', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    highWaterMark: hwm.toFixed(3),
                    peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                    trailingStop: effectiveStop.toFixed(3),
                    currentPrice: currentPrice.toFixed(3)
                });
            }

            // Trailing not yet activated - hold to expiry (original behavior)
            return this.createSignal('hold', null, 'holding_pre_trail', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                activationThreshold: (this.options.trailingActivationPct * 100) + '%'
            });
        }

        // Clean up trailing state if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActive[crypto];

        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded');
        }

        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_close_to_expiry');
        }

        // Calculate spot delta
        const spotDeltaPct = tick.price_to_beat > 0
            ? ((tick.spot_price - tick.price_to_beat) / tick.price_to_beat) * 100
            : 0;

        if (Math.abs(spotDeltaPct) < this.options.minSpotDeltaPct) {
            return this.createSignal('hold', null, 'spot_not_displaced');
        }

        const marketProb = tick.up_mid || 0.5;
        const side = spotDeltaPct > 0 ? 'up' : 'down';

        // Calculate expected probability
        const expectedProb = this.getExpectedProb(timeRemaining, spotDeltaPct);

        // Determine edge
        let edge;
        if (side === 'up') {
            edge = expectedProb - marketProb;  // Positive = market underpricing UP
        } else {
            edge = marketProb - (1 - expectedProb);  // Positive = market underpricing DOWN
        }

        if (edge < this.options.minEdge) {
            return this.createSignal('hold', null, 'insufficient_edge', {
                edge: (edge * 100).toFixed(1) + '%',
                expected: (expectedProb * 100).toFixed(1) + '%',
                market: (marketProb * 100).toFixed(1) + '%'
            });
        }

        // Trade!
        this.stats.signals++;
        this.tradedThisWindow[crypto] = windowEpoch;

        return this.createSignal('buy', side, 'probability_edge', {
            edge: (edge * 100).toFixed(1) + '%',
            expected: (expectedProb * 100).toFixed(1) + '%',
            market: (marketProb * 100).toFixed(1) + '%',
            spotDelta: spotDeltaPct.toFixed(2) + '%',
            timeRemaining: timeRemaining.toFixed(0) + 's',
            crypto
        });
    }

    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }
}

// Factory functions for new strategies
export function createSpotLagTimeAware(capital = 100) {
    return new SpotLag_TimeAwareStrategy({ maxPosition: capital });
}

export function createSpotLagTimeAwareAggro(capital = 100) {
    return new SpotLag_TimeAwareAggressiveStrategy({ maxPosition: capital });
}

export function createSpotLagTimeAwareSafe(capital = 100) {
    return new SpotLag_TimeAwareConservativeStrategy({ maxPosition: capital });
}

export function createSpotLagTimeAwareTP(capital = 100) {
    return new SpotLag_TimeAwareTPStrategy({ maxPosition: capital });
}

export function createSpotLagLateOnly(capital = 100) {
    return new SpotLag_LateWindowOnlyStrategy({ maxPosition: capital });
}

export function createSpotLagProbEdge(capital = 100) {
    return new SpotLag_ProbabilityEdgeStrategy({ maxPosition: capital });
}

// ================================================================
// SPOTLAG TRAILING STRATEGIES (Jan 2026 - Simplified)
//
// Based on proven SpotLag_Aggressive (87.7% WR) with added trailing stops.
// NO expected profit gate (was causing only illiquid underdog signals).
// Simple: spot moves → follow momentum → trail stop or hold to expiry.
//
// 5 VARIANTS with different aggression levels, all trade independently.
// ================================================================

/**
 * SpotLag_Trail Strategy (Base)
 *
 * THESIS: Follow spot momentum with trailing stops.
 * - Proven 0.0002 spotMoveThreshold
 * - Trailing stop captures gains, holds to expiry if momentum continues
 * - Min/max probability guards for liquidity and consensus
 */
export class SpotLag_TrailStrategy {
    constructor(options = {}) {
        this.name = options.name || 'SpotLag_Trail';
        this.options = {
            // MICRO-LAG DETECTION (proven thresholds)
            spotMoveThreshold: 0.0002,   // 0.02% - proven to generate signals
            lookbackTicks: 8,
            marketLagRatio: 0.6,         // Market should have moved < 60% of expected

            // TRAILING STOP
            trailingActivationPct: 0.10,  // Activate after 10% profit
            trailingStopPct: 0.25,        // 25% trailing from peak
            minimumProfitFloor: 0.05,     // 5% floor once trailing active

            // Time constraints
            minTimeRemaining: 30,         // Don't enter in final 30s

            // LIQUIDITY & CONSENSUS GUARDS (key fix!)
            minProbability: 0.05,         // Don't trade below 5¢ (no liquidity)
            maxProbability: 0.95,         // Don't fight 95%+ consensus

            // CONVICTION-BASED RISK MANAGEMENT
            requireRightSide: false,      // If true, only trade when on right side of strike
            wrongSideMinTime: 0,          // Min time remaining to allow wrong-side entry (0 = always allow)
            wrongSideStopLoss: 0.30,      // Stop loss threshold for wrong-side entries (30% default)

            // Position sizing
            maxPosition: 100,

            // Enabled cryptos
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],

            ...options
        };

        this.state = {};
        this.tradedThisWindow = {};
        this.stats = { signals: 0, earlyEntries: 0, midEntries: 0, lateEntries: 0, rightSideEntries: 0, wrongSideEntries: 0, stopLossExits: 0 };

        // Trailing stop state per crypto
        this.highWaterMark = {};
        this.trailingActive = {};

        // Position metadata for conviction-based management
        this.positionMeta = {};
    }

    getName() { return this.name; }

    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],
                marketHistory: [],
                timestamps: []
            };
        }
        return this.state[crypto];
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }

        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;

        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());

        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }

        // POSITION MANAGEMENT WITH TRAILING STOP + WRONG-SIDE STOP LOSS
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // WRONG-SIDE STOP LOSS: Cut losses early when on wrong side of strike
            const posMeta = this.positionMeta[crypto];
            if (posMeta && !posMeta.rightSideOfStrike) {
                const stopLossThreshold = this.options.wrongSideStopLoss;
                if (pnlPct < -stopLossThreshold) {
                    console.log(`[${this.name}] ${crypto}: STOP LOSS at ${(pnlPct * 100).toFixed(1)}% (wrong side of strike)`);
                    this.stats.stopLossExits++;
                    delete this.highWaterMark[crypto];
                    delete this.trailingActive[crypto];
                    delete this.positionMeta[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;

                    return this.createSignal('sell', null, 'stop_loss_wrong_side', {
                        entryPrice: entryPrice.toFixed(3),
                        exitPrice: currentPrice.toFixed(3),
                        pnlPct: (pnlPct * 100).toFixed(1) + '%',
                        stopLossThreshold: (stopLossThreshold * 100).toFixed(0) + '%'
                    });
                }
            }

            // Update high-water mark
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            const hwm = this.highWaterMark[crypto];
            const hwmPnlPct = (hwm - entryPrice) / entryPrice;

            // Check if trailing should activate
            if (!this.trailingActive[crypto] && pnlPct >= this.options.trailingActivationPct) {
                this.trailingActive[crypto] = true;
                console.log(`[${this.name}] ${crypto}: TRAILING ACTIVATED at ${(pnlPct * 100).toFixed(1)}% profit`);
            }

            // TRAILING STOP LOGIC
            if (this.trailingActive[crypto]) {
                const trailingStopPrice = hwm * (1 - this.options.trailingStopPct);
                const floorPrice = entryPrice * (1 + this.options.minimumProfitFloor);
                const effectiveStop = Math.max(trailingStopPrice, floorPrice);

                if (currentPrice <= effectiveStop) {
                    delete this.highWaterMark[crypto];
                    delete this.trailingActive[crypto];
                    this.tradedThisWindow[crypto] = windowEpoch;

                    return this.createSignal('sell', null, 'trailing_stop', {
                        entryPrice: entryPrice.toFixed(3),
                        exitPrice: currentPrice.toFixed(3),
                        highWaterMark: hwm.toFixed(3),
                        peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                        exitPnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }

                return this.createSignal('hold', null, 'trailing_active', {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    peakPnlPct: (hwmPnlPct * 100).toFixed(1) + '%',
                    trailingStop: effectiveStop.toFixed(3)
                });
            }

            // Trailing not yet activated - hold to expiry
            return this.createSignal('hold', null, 'holding_pre_trail', {
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                activationThreshold: (this.options.trailingActivationPct * 100) + '%'
            });
        }

        // Clean up trailing state if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActive[crypto];

        // Block re-entry this window
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded_this_window');
        }

        // Time filter
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_close_to_expiry');
        }

        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_data');
        }

        // Calculate spot movement
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;

        // Check for spot movement
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving');
        }

        // Calculate market movement (lag detection)
        const oldMarket = state.marketHistory[state.marketHistory.length - this.options.lookbackTicks];
        const newMarket = state.marketHistory[state.marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        const expectedMarketMove = spotMove * 10;
        const lagRatio = Math.abs(marketMove) / Math.abs(expectedMarketMove);

        if (lagRatio > this.options.marketLagRatio) {
            return this.createSignal('hold', null, 'market_caught_up');
        }

        // Determine trade side based on spot movement
        const side = spotMove > 0 ? 'up' : 'down';
        const marketProb = tick.up_mid || 0.5;
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        // STRIKE ALIGNMENT CHECK: Is spot on the RIGHT or WRONG side of strike?
        const strike = tick.price_to_beat;
        const spotPrice = newSpot;
        const spotAboveStrike = spotPrice > strike;
        const bettingUp = side === 'up';
        // RIGHT SIDE: betting direction matches spot's position vs strike
        // e.g., betting UP when spot is ABOVE strike, or betting DOWN when spot is BELOW strike
        const rightSideOfStrike = (bettingUp && spotAboveStrike) || (!bettingUp && !spotAboveStrike);

        // Calculate conviction score
        const timeWeight = timeRemaining < 60 ? 1.0 : timeRemaining < 120 ? 0.8 : timeRemaining < 300 ? 0.5 : 0.3;
        const strikeWeight = rightSideOfStrike ? 1.0 : 0.4;
        const conviction = timeWeight * strikeWeight;

        // CONVICTION-BASED ENTRY FILTER
        if (this.options.requireRightSide && !rightSideOfStrike) {
            return this.createSignal('hold', null, 'wrong_side_of_strike', {
                side,
                spotAboveStrike,
                strike: strike?.toFixed(2),
                spotPrice: spotPrice?.toFixed(2)
            });
        }

        // Wrong-side entry time filter: only allow wrong-side entries late in window
        if (!rightSideOfStrike && this.options.wrongSideMinTime > 0 && timeRemaining > this.options.wrongSideMinTime) {
            return this.createSignal('hold', null, 'wrong_side_too_early', {
                timeRemaining: timeRemaining.toFixed(0) + 's',
                minTimeRequired: this.options.wrongSideMinTime + 's'
            });
        }

        // LIQUIDITY GUARD: Don't trade below minProbability (no liquidity)
        if (sideProb < this.options.minProbability) {
            return this.createSignal('hold', null, 'below_min_probability', {
                sideProb: (sideProb * 100).toFixed(1) + '%',
                minRequired: (this.options.minProbability * 100) + '%'
            });
        }

        // CONSENSUS GUARD: Don't fight strong consensus
        if (sideProb > this.options.maxProbability) {
            return this.createSignal('hold', null, 'above_max_probability', {
                sideProb: (sideProb * 100).toFixed(1) + '%',
                maxAllowed: (this.options.maxProbability * 100) + '%'
            });
        }

        // ALL CONDITIONS MET - TRADE
        this.stats.signals++;
        if (timeRemaining > 300) this.stats.earlyEntries++;
        else if (timeRemaining > 120) this.stats.midEntries++;
        else this.stats.lateEntries++;

        // Track right/wrong side entries
        if (rightSideOfStrike) {
            this.stats.rightSideEntries++;
        } else {
            this.stats.wrongSideEntries++;
        }

        this.tradedThisWindow[crypto] = windowEpoch;

        // Store position metadata for conviction-based management
        this.positionMeta[crypto] = {
            rightSideOfStrike,
            conviction,
            entryTime: timeRemaining,
            strike,
            spotAtEntry: spotPrice
        };

        const timeWindow = timeRemaining > 300 ? 'early' : timeRemaining > 120 ? 'mid' : 'late';
        const sideLabel = rightSideOfStrike ? 'RIGHT' : 'WRONG';

        console.log(`[${this.name}] 🎯 SIGNAL: BUY ${side.toUpperCase()} ${crypto.toUpperCase()} | ` +
            `window=${timeWindow} time=${timeRemaining.toFixed(0)}s | ` +
            `spotMove=${(spotMove * 100).toFixed(3)}% lag=${lagRatio.toFixed(2)} | ` +
            `prob=${(sideProb * 100).toFixed(1)}% | ` +
            `side=${sideLabel} conv=${conviction.toFixed(2)}`);

        return this.createSignal('buy', side, 'spotlag_trail_entry', {
            timeWindow,
            timeRemaining: timeRemaining.toFixed(0) + 's',
            spotMove: (spotMove * 100).toFixed(4) + '%',
            lagRatio: lagRatio.toFixed(2),
            marketProb: (marketProb * 100).toFixed(1) + '%',
            sideProb: (sideProb * 100).toFixed(1) + '%',
            rightSideOfStrike,
            conviction: conviction.toFixed(2),
            crypto
        });
    }

    createSignal(action, side, reason, analysis = {}) {
        return { action, side, reason, size: this.options.maxPosition, ...analysis };
    }

    onWindowStart(windowInfo) {
        this.tradedThisWindow = {};
        this.positionMeta = {};  // Clear position metadata on window start
    }

    onWindowEnd(windowInfo, outcome) {}

    getStats() {
        return { name: this.name, ...this.stats };
    }
}

/**
 * V1: Safe - Only trade when on RIGHT side of strike
 * Highest conviction, fewest trades, loose stop loss as safety net
 */
export class SpotLag_Trail_V1Strategy extends SpotLag_TrailStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trail_V1',
            spotMoveThreshold: 0.0004,    // 0.04% - higher bar
            marketLagRatio: 0.4,          // Stricter lag requirement
            trailingActivationPct: 0.15,  // 15% to activate trailing
            trailingStopPct: 0.30,        // 30% trailing
            minProbability: 0.10,         // 10% min (more liquidity)
            maxProbability: 0.90,         // 90% max (less consensus fighting)
            // CONVICTION: Only trade right side of strike
            requireRightSide: true,
            wrongSideStopLoss: 0.40,      // 40% stop (safety net, shouldn't hit often)
            ...options
        });
    }
}

/**
 * V2: Moderate - Allow wrong side late only (< 120s remaining)
 * Good balance of conviction and opportunity, 30% stop on wrong side
 */
export class SpotLag_Trail_V2Strategy extends SpotLag_TrailStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trail_V2',
            spotMoveThreshold: 0.0003,    // 0.03%
            marketLagRatio: 0.5,
            trailingActivationPct: 0.12,
            trailingStopPct: 0.28,
            minProbability: 0.08,
            maxProbability: 0.92,
            // CONVICTION: Allow wrong side only in late window
            requireRightSide: false,
            wrongSideMinTime: 120,        // Only allow wrong side if < 120s remaining
            wrongSideStopLoss: 0.30,      // 30% stop on wrong side entries
            ...options
        });
    }
}

/**
 * V3: Base - Allow both sides with stop loss protection
 * Standard thresholds, 25% stop on wrong side entries
 */
export class SpotLag_Trail_V3Strategy extends SpotLag_TrailStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trail_V3',
            // Uses base defaults: 0.0002, 0.6, 0.10, 0.25, 0.05, 0.95
            // CONVICTION: Allow both sides with stop loss
            requireRightSide: false,
            wrongSideStopLoss: 0.25,      // 25% stop on wrong side entries
            ...options
        });
    }
}

/**
 * V4: Aggressive - Tighter stop loss on wrong side
 * More trades, but cut wrong-side losers quickly (20% stop)
 */
export class SpotLag_Trail_V4Strategy extends SpotLag_TrailStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trail_V4',
            spotMoveThreshold: 0.00015,   // 0.015% - lower bar
            marketLagRatio: 0.7,          // Allow more catch-up
            trailingActivationPct: 0.08,  // 8% to activate
            trailingStopPct: 0.20,        // 20% trailing (tighter)
            minProbability: 0.04,         // 4% min
            maxProbability: 0.96,
            // CONVICTION: Tight stop loss on wrong side
            requireRightSide: false,
            wrongSideStopLoss: 0.20,      // 20% stop - cut losers quickly
            ...options
        });
    }
}

/**
 * V5: DEPRECATED - Ultra Aggressive (consistently losing money)
 * Kept for backtesting only - DISABLED from live trading
 * Analysis: 4W/5L, -$1.06 P&L - too aggressive, enters wrong-side trades without protection
 */
export class SpotLag_Trail_V5Strategy extends SpotLag_TrailStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_Trail_V5',
            spotMoveThreshold: 0.0001,    // 0.01% - very low bar
            marketLagRatio: 0.8,          // Allow significant catch-up
            trailingActivationPct: 0.06,  // 6% to activate
            trailingStopPct: 0.15,        // 15% trailing (very tight)
            minProbability: 0.03,         // 3% min
            maxProbability: 0.97,
            minTimeRemaining: 20,         // Can enter later
            // No conviction-based protection - this is why it loses money
            ...options
        });
    }
}

// Factory functions
export function createSpotLagTrailV1(capital = 100) {
    return new SpotLag_Trail_V1Strategy({ maxPosition: capital });
}

export function createSpotLagTrailV2(capital = 100) {
    return new SpotLag_Trail_V2Strategy({ maxPosition: capital });
}

export function createSpotLagTrailV3(capital = 100) {
    return new SpotLag_Trail_V3Strategy({ maxPosition: capital });
}

export function createSpotLagTrailV4(capital = 100) {
    return new SpotLag_Trail_V4Strategy({ maxPosition: capital });
}

export function createSpotLagTrailV5(capital = 100) {
    return new SpotLag_Trail_V5Strategy({ maxPosition: capital });
}

// Keep old names for backwards compatibility (map to V3 base)
export const MicroLag_ConvergenceStrategy = SpotLag_Trail_V3Strategy;
export const MicroLag_ConvergenceAggroStrategy = SpotLag_Trail_V4Strategy;
export const MicroLag_ConvergenceSafeStrategy = SpotLag_Trail_V2Strategy;

export function createMicroLagConvergence(capital = 100) {
    return createSpotLagTrailV3(capital);
}

export function createMicroLagConvergenceAggro(capital = 100) {
    return createSpotLagTrailV4(capital);
}

export function createMicroLagConvergenceSafe(capital = 100) {
    return createSpotLagTrailV2(capital);
}

// =============================================================================
// PROBABILITY MODEL UTILITIES (Jan 2026)
// Used by both PureProb and enhanced Lag strategies for sizing and entry
// =============================================================================

/**
 * Calculate expected probability given spot displacement and time remaining
 * Based on empirical data: closer to expiry + larger displacement = more certain outcome
 *
 * @param {number} spotDeltaPct - Spot displacement from strike as percentage (e.g., 0.15 = 0.15%)
 * @param {number} timeRemainingSec - Seconds remaining in window
 * @returns {number} Expected probability [0.5, 0.95]
 */
function calculateExpectedProbability(spotDeltaPct, timeRemainingSec) {
    // Base expected probabilities by time bucket (calibrated from data)
    // When spot is displaced by ~0.2% from strike
    const baseProbs = {
        600: 0.80,  // 10min left: ~80%
        300: 0.85,  // 5min left: ~85%
        120: 0.89,  // 2min left: ~89%
        60: 0.90,   // 1min left: ~90%
        30: 0.91,   // 30s left: ~91%
        15: 0.93,   // 15s left: ~93%
        5: 0.95     // 5s left: ~95%
    };

    // Interpolate base probability by time
    const times = Object.keys(baseProbs).map(Number).sort((a, b) => b - a);
    let baseProb = 0.75;  // Default for very early
    for (const t of times) {
        if (timeRemainingSec <= t) {
            baseProb = baseProbs[t];
        }
    }

    // Adjust for displacement magnitude (larger delta = higher confidence)
    // deltaMultiplier scales from 0.5 (tiny delta) to 1.5 (large delta)
    const absDelta = Math.abs(spotDeltaPct);
    const deltaMultiplier = Math.min(0.5 + (absDelta / 0.2), 1.5);

    // Apply multiplier to edge over 50%
    const adjusted = 0.5 + (baseProb - 0.5) * deltaMultiplier;

    // Clamp to reasonable range
    return Math.min(0.95, Math.max(0.50, adjusted));
}

/**
 * Calculate dynamic position size based on edge, conviction, and liquidity
 *
 * @param {number} edge - Edge percentage (expected - market probability)
 * @param {number} conviction - Conviction score [0, 1]
 * @param {number} liquidityAvailable - Available liquidity on the side we're trading (in $)
 * @param {number} baseSize - Base position size
 * @returns {number} Adjusted position size
 */
function calculateDynamicSize(edge, conviction, liquidityAvailable, baseSize) {
    // Edge multiplier: scale position by edge magnitude
    // 5% edge = 1x, 10% edge = 2x, 15%+ edge = 3x (capped)
    const edgeMultiplier = Math.min(Math.max(edge / 0.05, 0.5), 3.0);

    // Conviction multiplier: scale by how confident we are
    // High conviction (right side, late) = 1x, low conviction = 0.5x
    const convictionMultiplier = 0.5 + (conviction * 0.5);

    // Calculate desired size
    let desiredSize = baseSize * edgeMultiplier * convictionMultiplier;

    // Liquidity constraint: never take more than 10% of available book
    const maxLiquiditySize = liquidityAvailable * 0.10;
    desiredSize = Math.min(desiredSize, maxLiquiditySize);

    // Floor and ceiling
    const minSize = 10;    // Minimum $10 to be worth the effort
    const maxSize = baseSize * 3;  // Never more than 3x base

    return Math.max(minSize, Math.min(maxSize, desiredSize));
}

// =============================================================================
// SET 1: PURE PROBABILISTIC STRATEGIES (PureProb_*)
// Trade purely on probability edge - no lag detection required
// When expected probability diverges from market price, take the trade
// =============================================================================

/**
 * Pure Probability Edge Strategy
 * Trades when market probability differs from expected by more than threshold
 * Uses dynamic position sizing based on edge magnitude
 */
export class PureProb_BaseStrategy {
    constructor(options = {}) {
        this.name = options.name || 'PureProb_Base';
        this.options = {
            // Entry thresholds
            minEdge: 0.05,              // Minimum 5% edge to trade
            minSpotDeltaPct: 0.05,      // Minimum 0.05% spot displacement from strike

            // Time constraints
            minTimeRemaining: 30,       // Don't enter in final 30s
            maxTimeRemaining: 600,      // Don't enter too early (before 10min mark)

            // Liquidity guards
            minProbability: 0.05,       // Don't trade below 5 cents
            maxProbability: 0.95,       // Don't trade above 95 cents
            minLiquidity: 50,           // Minimum $50 liquidity on our side

            // Position sizing
            basePosition: 100,          // Base position size
            useDynamicSizing: true,     // Use edge-based sizing

            // Risk management
            stopLoss: 0.25,             // 25% stop loss

            // Cryptos
            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],

            ...options
        };

        this.state = {};
        this.tradedThisWindow = {};
        this.positionMeta = {};
        this.stats = { signals: 0, totalEdge: 0, avgEdge: 0 };
    }

    getName() { return this.name; }

    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = { lastSignalWindow: null };
        }
        return this.state[crypto];
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled', this.options.basePosition);
        }

        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        const marketProb = tick.up_mid || 0.5;
        const strike = tick.price_to_beat;
        const spotPrice = tick.spot_price;

        // Position management with stop loss
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Stop loss
            if (pnlPct < -this.options.stopLoss) {
                delete this.positionMeta[crypto];
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'stop_loss', this.options.basePosition, {
                    pnlPct: (pnlPct * 100).toFixed(1) + '%'
                });
            }

            // Hold to expiry otherwise
            return this.createSignal('hold', null, 'holding', this.options.basePosition, {
                pnlPct: (pnlPct * 100).toFixed(1) + '%'
            });
        }

        // Already traded this window
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded', this.options.basePosition);
        }

        // Time filter
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_late', this.options.basePosition);
        }
        if (timeRemaining > this.options.maxTimeRemaining) {
            return this.createSignal('hold', null, 'too_early', this.options.basePosition);
        }

        // Calculate spot delta from strike
        const spotDeltaPct = strike > 0 ? ((spotPrice - strike) / strike) * 100 : 0;

        if (Math.abs(spotDeltaPct) < this.options.minSpotDeltaPct) {
            return this.createSignal('hold', null, 'spot_too_close', this.options.basePosition);
        }

        // Determine side based on spot position
        const side = spotDeltaPct > 0 ? 'up' : 'down';
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        // Liquidity guards
        if (sideProb < this.options.minProbability || sideProb > this.options.maxProbability) {
            return this.createSignal('hold', null, 'probability_bounds', this.options.basePosition);
        }

        // Calculate expected probability
        const expectedProb = calculateExpectedProbability(spotDeltaPct, timeRemaining);
        const expectedSideProb = side === 'up' ? expectedProb : expectedProb;  // Same for the side we're betting

        // Calculate edge
        const edge = expectedSideProb - sideProb;

        if (edge < this.options.minEdge) {
            return this.createSignal('hold', null, 'insufficient_edge', this.options.basePosition, {
                edge: (edge * 100).toFixed(1) + '%',
                expected: (expectedSideProb * 100).toFixed(1) + '%',
                market: (sideProb * 100).toFixed(1) + '%'
            });
        }

        // Check liquidity
        const liquidity = side === 'up' ? (tick.up_ask_size || 100) : (tick.down_ask_size || 100);
        if (liquidity < this.options.minLiquidity) {
            return this.createSignal('hold', null, 'insufficient_liquidity', this.options.basePosition);
        }

        // Calculate conviction (right side of strike always = high conviction for PureProb)
        const conviction = 0.8 + (0.2 * Math.min(timeRemaining / 60, 1));  // Higher conviction later

        // Calculate position size
        let size = this.options.basePosition;
        if (this.options.useDynamicSizing) {
            size = calculateDynamicSize(edge, conviction, liquidity, this.options.basePosition);
        }

        // Store position metadata
        this.positionMeta[crypto] = { edge, conviction, expectedProb: expectedSideProb };
        this.tradedThisWindow[crypto] = windowEpoch;
        this.stats.signals++;
        this.stats.totalEdge += edge;
        this.stats.avgEdge = this.stats.totalEdge / this.stats.signals;

        console.log(`[${this.name}] 🎯 SIGNAL: BUY ${side.toUpperCase()} ${crypto.toUpperCase()} | ` +
            `edge=${(edge * 100).toFixed(1)}% expected=${(expectedSideProb * 100).toFixed(1)}% ` +
            `market=${(sideProb * 100).toFixed(1)}% | size=$${size.toFixed(0)} | time=${timeRemaining.toFixed(0)}s`);

        return this.createSignal('buy', side, 'probability_edge', size, {
            edge: (edge * 100).toFixed(1) + '%',
            expected: (expectedSideProb * 100).toFixed(1) + '%',
            market: (sideProb * 100).toFixed(1) + '%',
            spotDelta: spotDeltaPct.toFixed(3) + '%',
            conviction: conviction.toFixed(2),
            crypto
        });
    }

    createSignal(action, side, reason, size, analysis = {}) {
        return { action, side, reason, size, ...analysis };
    }

    onWindowStart(windowInfo) {
        this.tradedThisWindow = {};
        this.positionMeta = {};
    }

    onWindowEnd(windowInfo, outcome) {}

    getStats() { return { name: this.name, ...this.stats }; }
}

/**
 * PureProb Conservative - Higher edge requirement, more selective
 */
export class PureProb_ConservativeStrategy extends PureProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'PureProb_Conservative',
            minEdge: 0.08,              // Need 8% edge
            minSpotDeltaPct: 0.10,      // Need 0.1% spot delta
            minTimeRemaining: 60,       // Don't enter too late
            maxTimeRemaining: 300,      // Only trade in last 5 min
            stopLoss: 0.30,             // 30% stop
            ...options
        });
    }
}

/**
 * PureProb Aggressive - Lower edge threshold, more trades
 */
export class PureProb_AggressiveStrategy extends PureProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'PureProb_Aggressive',
            minEdge: 0.03,              // Accept 3% edge
            minSpotDeltaPct: 0.03,      // Lower spot delta requirement
            minTimeRemaining: 20,       // Can enter later
            maxTimeRemaining: 600,      // Trade full window
            stopLoss: 0.20,             // Tighter stop
            basePosition: 150,          // Larger base position
            ...options
        });
    }
}

/**
 * PureProb Late - Only trade in final 2 minutes for highest conviction
 */
export class PureProb_LateStrategy extends PureProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'PureProb_Late',
            minEdge: 0.04,              // Lower edge OK when late
            minSpotDeltaPct: 0.05,
            minTimeRemaining: 15,       // Can enter very late
            maxTimeRemaining: 120,      // Only last 2 min
            stopLoss: 0.20,
            basePosition: 200,          // Larger position for high conviction
            ...options
        });
    }
}

// Factory functions for PureProb
export function createPureProbBase(capital = 100) {
    return new PureProb_BaseStrategy({ basePosition: capital });
}

export function createPureProbConservative(capital = 100) {
    return new PureProb_ConservativeStrategy({ basePosition: capital });
}

export function createPureProbAggressive(capital = 100) {
    return new PureProb_AggressiveStrategy({ basePosition: capital });
}

export function createPureProbLate(capital = 100) {
    return new PureProb_LateStrategy({ basePosition: capital });
}

// =============================================================================
// SET 2: LAG + PROBABILISTIC STRATEGIES (LagProb_*)
// Waits for lag signal, then uses probability model for entry validation and sizing
// Combines the best of both approaches
// =============================================================================

/**
 * Lag + Probability Strategy
 * 1. Detects micro-lag (spot moved, market hasn't caught up)
 * 2. Validates with probability model (expected vs market)
 * 3. Sizes position dynamically based on edge and liquidity
 */
export class LagProb_BaseStrategy {
    constructor(options = {}) {
        this.name = options.name || 'LagProb_Base';
        this.options = {
            // Lag detection (from Trail strategies)
            spotMoveThreshold: 0.0002,   // 0.02% spot move
            lookbackTicks: 8,
            marketLagRatio: 0.6,         // Market moved < 60% of expected

            // Probability validation
            minEdge: 0.03,               // Need at least 3% probability edge
            useEdgeValidation: true,     // Validate with probability model

            // Time constraints
            minTimeRemaining: 30,

            // Liquidity guards
            minProbability: 0.05,
            maxProbability: 0.95,
            minLiquidity: 50,

            // Conviction-based risk (from Trail)
            requireRightSide: false,
            wrongSideStopLoss: 0.25,

            // Position sizing
            basePosition: 100,
            useDynamicSizing: true,

            // Trailing stop (from Trail)
            trailingActivationPct: 0.10,
            trailingStopPct: 0.25,
            minimumProfitFloor: 0.05,

            enabledCryptos: ['btc', 'eth', 'sol', 'xrp'],
            ...options
        };

        this.state = {};
        this.tradedThisWindow = {};
        this.positionMeta = {};
        this.highWaterMark = {};
        this.trailingActive = {};
        this.stats = { signals: 0, rightSide: 0, wrongSide: 0, avgEdge: 0, totalEdge: 0 };
    }

    getName() { return this.name; }

    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                spotHistory: [],
                marketHistory: [],
                timestamps: []
            };
        }
        return this.state[crypto];
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled', this.options.basePosition);
        }

        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        const marketProb = tick.up_mid || 0.5;
        const strike = tick.price_to_beat;

        // Update history
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(marketProb);
        state.timestamps.push(Date.now());

        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }

        // Position management
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Wrong-side stop loss
            const posMeta = this.positionMeta[crypto];
            if (posMeta && !posMeta.rightSideOfStrike) {
                if (pnlPct < -this.options.wrongSideStopLoss) {
                    console.log(`[${this.name}] ${crypto}: STOP LOSS at ${(pnlPct * 100).toFixed(1)}% (wrong side)`);
                    this.cleanup(crypto, windowEpoch);
                    return this.createSignal('sell', null, 'stop_loss_wrong_side', this.options.basePosition, {
                        pnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }
            }

            // Trailing stop logic
            if (!this.highWaterMark[crypto] || currentPrice > this.highWaterMark[crypto]) {
                this.highWaterMark[crypto] = currentPrice;
            }
            const hwm = this.highWaterMark[crypto];

            if (!this.trailingActive[crypto] && pnlPct >= this.options.trailingActivationPct) {
                this.trailingActive[crypto] = true;
            }

            if (this.trailingActive[crypto]) {
                const trailingStop = hwm * (1 - this.options.trailingStopPct);
                const floor = entryPrice * (1 + this.options.minimumProfitFloor);
                const effectiveStop = Math.max(trailingStop, floor);

                if (currentPrice <= effectiveStop) {
                    this.cleanup(crypto, windowEpoch);
                    return this.createSignal('sell', null, 'trailing_stop', this.options.basePosition, {
                        pnlPct: (pnlPct * 100).toFixed(1) + '%'
                    });
                }
            }

            return this.createSignal('hold', null, 'holding', this.options.basePosition, {
                pnlPct: (pnlPct * 100).toFixed(1) + '%'
            });
        }

        // Clean up if no position
        delete this.highWaterMark[crypto];
        delete this.trailingActive[crypto];

        // Already traded this window
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            return this.createSignal('hold', null, 'already_traded', this.options.basePosition);
        }

        // Time filter
        if (timeRemaining < this.options.minTimeRemaining) {
            return this.createSignal('hold', null, 'too_late', this.options.basePosition);
        }

        // Need enough history
        if (state.spotHistory.length < this.options.lookbackTicks) {
            return this.createSignal('hold', null, 'insufficient_data', this.options.basePosition);
        }

        // Calculate spot movement (LAG DETECTION)
        const oldSpot = state.spotHistory[state.spotHistory.length - this.options.lookbackTicks];
        const newSpot = state.spotHistory[state.spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;

        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving', this.options.basePosition);
        }

        // Calculate market lag
        const oldMarket = state.marketHistory[state.marketHistory.length - this.options.lookbackTicks];
        const newMarket = state.marketHistory[state.marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        const expectedMove = spotMove * 10;
        const lagRatio = Math.abs(marketMove) / Math.abs(expectedMove);

        if (lagRatio > this.options.marketLagRatio) {
            return this.createSignal('hold', null, 'market_caught_up', this.options.basePosition);
        }

        // Determine side
        const side = spotMove > 0 ? 'up' : 'down';
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        // Liquidity bounds
        if (sideProb < this.options.minProbability || sideProb > this.options.maxProbability) {
            return this.createSignal('hold', null, 'probability_bounds', this.options.basePosition);
        }

        // Calculate spot delta and expected probability
        const spotDeltaPct = strike > 0 ? ((newSpot - strike) / strike) * 100 : 0;
        const expectedProb = calculateExpectedProbability(spotDeltaPct, timeRemaining);
        const expectedSideProb = side === 'up' ? expectedProb : expectedProb;
        const edge = expectedSideProb - sideProb;

        // Edge validation
        if (this.options.useEdgeValidation && edge < this.options.minEdge) {
            return this.createSignal('hold', null, 'insufficient_edge', this.options.basePosition, {
                edge: (edge * 100).toFixed(1) + '%'
            });
        }

        // Strike alignment check
        const spotAboveStrike = newSpot > strike;
        const bettingUp = side === 'up';
        const rightSideOfStrike = (bettingUp && spotAboveStrike) || (!bettingUp && !spotAboveStrike);

        if (this.options.requireRightSide && !rightSideOfStrike) {
            return this.createSignal('hold', null, 'wrong_side', this.options.basePosition);
        }

        // Calculate conviction
        const timeWeight = timeRemaining < 60 ? 1.0 : timeRemaining < 120 ? 0.8 : 0.6;
        const strikeWeight = rightSideOfStrike ? 1.0 : 0.5;
        const conviction = timeWeight * strikeWeight;

        // Check liquidity
        const liquidity = side === 'up' ? (tick.up_ask_size || 100) : (tick.down_ask_size || 100);

        // Calculate position size
        let size = this.options.basePosition;
        if (this.options.useDynamicSizing) {
            size = calculateDynamicSize(Math.max(edge, 0.03), conviction, liquidity, this.options.basePosition);
        }

        // Store metadata
        this.positionMeta[crypto] = { rightSideOfStrike, conviction, edge, expectedProb: expectedSideProb };
        this.tradedThisWindow[crypto] = windowEpoch;
        this.stats.signals++;
        this.stats.totalEdge += edge;
        this.stats.avgEdge = this.stats.totalEdge / this.stats.signals;
        if (rightSideOfStrike) this.stats.rightSide++; else this.stats.wrongSide++;

        const sideLabel = rightSideOfStrike ? 'RIGHT' : 'WRONG';
        console.log(`[${this.name}] 🎯 SIGNAL: BUY ${side.toUpperCase()} ${crypto.toUpperCase()} | ` +
            `lag=${lagRatio.toFixed(2)} edge=${(edge * 100).toFixed(1)}% | ` +
            `side=${sideLabel} size=$${size.toFixed(0)} | time=${timeRemaining.toFixed(0)}s`);

        return this.createSignal('buy', side, 'lag_prob_entry', size, {
            lagRatio: lagRatio.toFixed(2),
            edge: (edge * 100).toFixed(1) + '%',
            expected: (expectedSideProb * 100).toFixed(1) + '%',
            market: (sideProb * 100).toFixed(1) + '%',
            rightSideOfStrike,
            conviction: conviction.toFixed(2),
            crypto
        });
    }

    cleanup(crypto, windowEpoch) {
        delete this.highWaterMark[crypto];
        delete this.trailingActive[crypto];
        delete this.positionMeta[crypto];
        this.tradedThisWindow[crypto] = windowEpoch;
    }

    createSignal(action, side, reason, size, analysis = {}) {
        return { action, side, reason, size, ...analysis };
    }

    onWindowStart(windowInfo) {
        this.tradedThisWindow = {};
        this.positionMeta = {};
    }

    onWindowEnd(windowInfo, outcome) {}

    getStats() { return { name: this.name, ...this.stats }; }
}

/**
 * LagProb Conservative - Higher thresholds, right side only
 */
export class LagProb_ConservativeStrategy extends LagProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'LagProb_Conservative',
            spotMoveThreshold: 0.0003,   // Higher threshold
            marketLagRatio: 0.5,         // Stricter lag
            minEdge: 0.05,               // Higher edge requirement
            requireRightSide: true,      // Only right side
            wrongSideStopLoss: 0.30,
            basePosition: 100,
            ...options
        });
    }
}

/**
 * LagProb Aggressive - Lower thresholds, more trades
 */
export class LagProb_AggressiveStrategy extends LagProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'LagProb_Aggressive',
            spotMoveThreshold: 0.00015,  // Lower threshold
            marketLagRatio: 0.7,         // Allow more catch-up
            minEdge: 0.02,               // Lower edge OK
            requireRightSide: false,
            wrongSideStopLoss: 0.20,     // Tight stop on wrong side
            basePosition: 150,           // Larger base
            trailingActivationPct: 0.08,
            ...options
        });
    }
}

/**
 * LagProb RightSide - Only trades when on right side of strike
 */
export class LagProb_RightSideStrategy extends LagProb_BaseStrategy {
    constructor(options = {}) {
        super({
            name: 'LagProb_RightSide',
            spotMoveThreshold: 0.0002,
            marketLagRatio: 0.6,
            minEdge: 0.03,
            requireRightSide: true,      // ONLY right side
            basePosition: 200,           // Higher conviction = larger size
            trailingActivationPct: 0.12,
            ...options
        });
    }
}

// Factory functions for LagProb
export function createLagProbBase(capital = 100) {
    return new LagProb_BaseStrategy({ basePosition: capital });
}

export function createLagProbConservative(capital = 100) {
    return new LagProb_ConservativeStrategy({ basePosition: capital });
}

export function createLagProbAggressive(capital = 100) {
    return new LagProb_AggressiveStrategy({ basePosition: capital });
}

export function createLagProbRightSide(capital = 100) {
    return new LagProb_RightSideStrategy({ basePosition: capital });
}

export default SpotLagSimpleStrategy;
