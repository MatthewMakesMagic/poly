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
        
        // Check if spot moved enough
        if (Math.abs(spotMove) < this.options.spotMoveThreshold) {
            return this.createSignal('hold', null, 'spot_not_moving', { spotMove });
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
// TAKE-PROFIT STRATEGIES
// Exit early when price moves in our favor, capturing lag resolution alpha
// Backtest shows 3% TP improves P&L by ~32% vs hold-to-expiry
// ================================================================

/**
 * SpotLag with 3% Take-Profit
 * 
 * THESIS: After SpotLag entry, market "catches up" quickly.
 * Instead of holding to binary expiry (risky), exit at +3% gain.
 * 
 * Key insight: At cheap prices (e.g., 7c), we get MORE shares for $1.
 * A 3% price move from 7c to 7.2c gives same % return,
 * but if it moves to 20c (186% gain), we capture massive profit.
 * 
 * The 3% threshold ensures we lock in gains without waiting for binary.
 */
export class SpotLag_TakeProfit3Strategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TP3',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,  // Aggressive entry like SpotLag_Aggressive
            marketLagRatio: 0.6,
            takeProfitThreshold: 0.03,  // 3% take-profit
            ...options
        });
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        // Check if this crypto is enabled
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        
        // Update history (same as parent)
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        // POSITION MANAGEMENT WITH TAKE-PROFIT
        if (position) {
            // Get current price we could sell at (bid price for our side)
            const currentPrice = position.side === 'up' 
                ? tick.up_bid   // Sell UP at bid
                : tick.down_bid; // Sell DOWN at bid
            
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // 1. TAKE-PROFIT - exit when we hit threshold
            if (pnlPct >= this.options.takeProfitThreshold) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'take_profit', { 
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    entryPrice: position.entryPrice.toFixed(2),
                    exitPrice: currentPrice.toFixed(2),
                    threshold: (this.options.takeProfitThreshold * 100) + '%'
                });
            }
            
            // 2. EXTREME STOP - cut losses if way underwater
            if (pnlPct <= -this.options.extremeStopLoss) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            // 3. HOLD - waiting for take-profit or expiry
            return this.createSignal('hold', null, 'waiting_for_tp', { 
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                target: (this.options.takeProfitThreshold * 100) + '%'
            });
        }
        
        // Entry logic - delegate to parent
        return super.onTick(tick, position, context);
    }
}

/**
 * SpotLag with 6% Take-Profit
 * 
 * Higher threshold - lets winners run more before exiting.
 * Better for cheap entries where big moves are possible.
 */
export class SpotLag_TakeProfit6Strategy extends SpotLagSimpleStrategy {
    constructor(options = {}) {
        super({
            name: 'SpotLag_TP6',
            lookbackTicks: 8,
            spotMoveThreshold: 0.0002,
            marketLagRatio: 0.6,
            takeProfitThreshold: 0.06,  // 6% take-profit
            ...options
        });
    }
    
    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        
        if (!this.options.enabledCryptos.includes(crypto)) {
            return this.createSignal('hold', null, 'crypto_disabled');
        }
        
        const state = this.initCrypto(crypto);
        const timeRemaining = tick.time_remaining_sec || 0;
        const windowEpoch = tick.window_epoch;
        
        state.spotHistory.push(tick.spot_price);
        state.marketHistory.push(tick.up_mid);
        state.timestamps.push(Date.now());
        
        const maxLen = this.options.lookbackTicks + 5;
        while (state.spotHistory.length > maxLen) {
            state.spotHistory.shift();
            state.marketHistory.shift();
            state.timestamps.shift();
        }
        
        // POSITION MANAGEMENT WITH TAKE-PROFIT
        if (position) {
            const currentPrice = position.side === 'up' 
                ? tick.up_bid 
                : tick.down_bid;
            
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            if (pnlPct >= this.options.takeProfitThreshold) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'take_profit', { 
                    pnlPct: (pnlPct * 100).toFixed(1) + '%',
                    entryPrice: position.entryPrice.toFixed(2),
                    exitPrice: currentPrice.toFixed(2),
                    threshold: (this.options.takeProfitThreshold * 100) + '%'
                });
            }
            
            if (pnlPct <= -this.options.extremeStopLoss) {
                this.tradedThisWindow[crypto] = windowEpoch;
                return this.createSignal('sell', null, 'extreme_stop', { pnlPct });
            }
            
            return this.createSignal('hold', null, 'waiting_for_tp', { 
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                target: (this.options.takeProfitThreshold * 100) + '%'
            });
        }
        
        return super.onTick(tick, position, context);
    }
}

export function createSpotLagTP3(capital = 100) {
    return new SpotLag_TakeProfit3Strategy({ maxPosition: capital });
}

export function createSpotLagTP6(capital = 100) {
    return new SpotLag_TakeProfit6Strategy({ maxPosition: capital });
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

export default SpotLagSimpleStrategy;
