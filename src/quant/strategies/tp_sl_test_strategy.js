/**
 * TP/SL Test Strategy
 *
 * PURPOSE: Validate Take Profit and Stop Loss logic in LiveTrader
 *
 * BEHAVIOR:
 * - ONLY trades UP side (to test trailing TP)
 * - Max 10 total trades then stops
 * - Uses $2 position size
 *
 * EXIT LOGIC (handled by LiveTrader):
 * - Stop Loss: -15% from entry (regular)
 * - Trailing Stop Loss: -10% from high water mark
 * - Take Profit: +25% (fixed)
 * - Trailing Take Profit: activates at +10%, trails 10% from peak
 */

// Global trade counter (persists across instances)
let globalTradeCount = 0;
const MAX_TOTAL_TRADES = 10;

export class TP_SL_TestStrategy {
    constructor(options = {}) {
        this.name = 'TP_SL_Test';
        this.options = {
            // Entry conditions
            maxTimeRemaining: 600,
            minTimeRemaining: 60,

            // ONLY trade UP
            forceSide: 'up',

            // Position sizing - $2
            positionSize: 200,

            ...options
        };

        this.tradedThisWindow = {};
        this.stats = {
            signals: 0,
            skippedTime: 0,
            skippedDuplicate: 0,
            skippedMaxTrades: 0
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

        // If we have a position, hold (LiveTrader handles exits)
        if (position) {
            const currentPrice = tick.up_bid; // Always UP now
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

            return {
                action: 'hold',
                reason: 'holding_for_tp_sl_test',
                pnlPct: (pnlPct * 100).toFixed(1) + '%',
                currentPrice: currentPrice.toFixed(3),
                entryPrice: position.entryPrice.toFixed(3)
            };
        }

        // Check max trades
        if (globalTradeCount >= MAX_TOTAL_TRADES) {
            this.stats.skippedMaxTrades++;
            return { action: 'hold', reason: 'max_trades_reached', totalTrades: globalTradeCount };
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

        // ALWAYS trade UP
        const side = 'up';
        const sideProb = marketProb;

        // Mark as traded
        this.tradedThisWindow[crypto] = windowEpoch;
        this.stats.signals++;
        globalTradeCount++;

        console.log(`[TP_SL_Test] 🧪 TEST ENTRY #${globalTradeCount}/${MAX_TOTAL_TRADES}: ${crypto} | UP @ ${(sideProb * 100).toFixed(1)}% | time=${timeRemaining.toFixed(0)}s`);

        return {
            action: 'buy',
            side: side,
            size: this.options.positionSize,
            reason: 'tp_sl_test_entry',
            confidence: sideProb,
            marketProb: (marketProb * 100).toFixed(1) + '%',
            timeRemaining: timeRemaining.toFixed(0) + 's',
            tradeNumber: globalTradeCount
        };
    }

    onWindowStart(windowInfo) {
        delete this.tradedThisWindow[windowInfo.crypto];
    }

    onWindowEnd(windowInfo, outcome) {
        console.log(`[TP_SL_Test] Window ended: ${windowInfo.crypto} | outcome=${outcome} | Total: ${globalTradeCount}/${MAX_TOTAL_TRADES}`);
    }

    getStats() {
        return { name: this.name, totalTrades: globalTradeCount, maxTrades: MAX_TOTAL_TRADES, ...this.stats };
    }
}

export function createTP_SL_TestStrategy(capital = 100) {
    return new TP_SL_TestStrategy({ positionSize: capital * 2 });
}

export default TP_SL_TestStrategy;
