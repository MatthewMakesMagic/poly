/**
 * TP/SL Test Strategy
 *
 * PURPOSE: Validate that Take Profit and Stop Loss work correctly in LiveTrader
 *
 * BEHAVIOR:
 * - Enters markets near 50/50 (highest uncertainty = most movement)
 * - Uses $2 position size (above minimum for exits)
 * - Trades frequently to generate test data
 * - One trade per window per crypto max
 *
 * SUCCESS CRITERIA:
 * - Stop loss triggers at -15%
 * - Take profit activates at +10%, trails 10% from peak
 * - 10 successful exits (either TP or SL) = validation complete
 */

export class TP_SL_TestStrategy {
    constructor(options = {}) {
        this.name = 'TP_SL_Test';
        this.options = {
            // Entry conditions - trade near 50/50 for max movement
            minProb: 0.40,              // Only enter if prob between 40-60%
            maxProb: 0.60,
            maxTimeRemaining: 600,       // Enter early to give time for TP/SL
            minTimeRemaining: 120,       // Don't enter too late

            // Position sizing - $2 to ensure exits are above $1 minimum
            positionSize: 200,           // 200 units = $2 in production

            ...options
        };

        // Track trades this window to avoid duplicates
        this.tradedThisWindow = {};

        // Stats for monitoring
        this.stats = {
            signals: 0,
            skippedProb: 0,
            skippedTime: 0,
            skippedDuplicate: 0
        };
    }

    getName() {
        return this.name;
    }

    onTick(tick, position = null, context = {}) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        const timeRemaining = tick.time_remaining_sec || 0;
        const marketProb = tick.up_mid || 0.5;

        // If we have a position, just hold (let LiveTrader handle TP/SL)
        if (position) {
            const currentPrice = position.side === 'up' ? tick.up_bid : tick.down_bid;
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

            return {
                action: 'hold',
                reason: 'holding_for_tp_sl_test',
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                currentPrice: currentPrice.toFixed(3),
                entryPrice: position.entryPrice.toFixed(3)
            };
        }

        // Check if already traded this window
        if (this.tradedThisWindow[crypto] === windowEpoch) {
            this.stats.skippedDuplicate++;
            return { action: 'hold', reason: 'already_traded_this_window' };
        }

        // Time filter
        if (timeRemaining > this.options.maxTimeRemaining) {
            this.stats.skippedTime++;
            return { action: 'hold', reason: 'too_early', timeRemaining };
        }
        if (timeRemaining < this.options.minTimeRemaining) {
            this.stats.skippedTime++;
            return { action: 'hold', reason: 'too_late', timeRemaining };
        }

        // Probability filter - want markets NEAR 50/50 for movement
        if (marketProb < this.options.minProb || marketProb > this.options.maxProb) {
            this.stats.skippedProb++;
            return { action: 'hold', reason: 'prob_not_in_range', marketProb: (marketProb * 100).toFixed(1) + '%' };
        }

        // ENTRY SIGNAL: Pick the side with slightly better odds
        const side = marketProb > 0.5 ? 'up' : 'down';
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        // Mark as traded this window
        this.tradedThisWindow[crypto] = windowEpoch;
        this.stats.signals++;

        console.log(`[TP_SL_Test] 🧪 TEST ENTRY: ${crypto} | ${side.toUpperCase()} @ ${(sideProb * 100).toFixed(1)}% | time=${timeRemaining.toFixed(0)}s | This is a TP/SL validation trade`);

        return {
            action: 'buy',
            side: side,
            size: this.options.positionSize,
            reason: 'tp_sl_test_entry',
            confidence: sideProb,
            marketProb: (marketProb * 100).toFixed(1) + '%',
            timeRemaining: timeRemaining.toFixed(0) + 's'
        };
    }

    onWindowStart(windowInfo) {
        // Reset trade tracking for new window
        const crypto = windowInfo.crypto;
        delete this.tradedThisWindow[crypto];
    }

    onWindowEnd(windowInfo, outcome) {
        // Log for analysis
        console.log(`[TP_SL_Test] Window ended: ${windowInfo.crypto} | outcome=${outcome}`);
    }

    getStats() {
        return {
            name: this.name,
            ...this.stats
        };
    }
}

// Factory function
export function createTP_SL_TestStrategy(capital = 100) {
    // Use 2x capital to ensure $2 position size in production
    return new TP_SL_TestStrategy({ positionSize: capital * 2 });
}

export default TP_SL_TestStrategy;
