/**
 * OracleOverseer Service
 *
 * Tracks every lag event with resultant market PRICE changes (bid/ask, not just probability)
 * and signal-to-execution latency for live trades.
 *
 * Key questions answered:
 * 1. When lag is detected, how much does it cost to buy that direction?
 * 2. How quickly do bid/ask prices move after a lag event?
 * 3. What's the signal-to-execution latency in live trading?
 * 4. How much slippage occurs between signal and fill?
 */

import { v4 as uuidv4 } from 'uuid';
import { saveLagEvent, saveLatencyMeasurement } from '../db/connection.js';

// Configuration
const CONFIG = {
    // Minimum lag to track (as percentage, e.g., 3 = 3%)
    LAG_THRESHOLD_PCT: 3.0,

    // How long to track price changes after lag detection (ms)
    PRICE_TRACKING_WINDOW_MS: 5000,

    // Number of ticks to keep in history per crypto
    TICK_HISTORY_SIZE: 30,

    // Minimum spot move to consider as significant (0.05% = 0.0005)
    SPOT_MOVE_THRESHOLD: 0.0005,
};

/**
 * Represents an active lag event being tracked
 */
class LagEvent {
    constructor(params) {
        this.eventId = params.eventId || `lag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.timestampMs = params.timestampMs;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;

        // Lag detection
        this.direction = params.direction; // 'up' or 'down'
        this.lagMagnitude = params.lagMagnitude; // fair_prob - market_prob
        this.lagMagnitudePct = params.lagMagnitudePct;

        // Spot movement
        this.spotBefore = params.spotBefore;
        this.spotAfter = params.spotAfter;
        this.spotChangePct = params.spotChangePct;

        // Market prices at detection (BEFORE)
        this.upBidBefore = params.upBidBefore;
        this.upAskBefore = params.upAskBefore;
        this.downBidBefore = params.downBidBefore;
        this.downAskBefore = params.downAskBefore;

        // Market prices after tracking (AFTER) - filled later
        this.upBidAfter = null;
        this.upAskAfter = null;
        this.downBidAfter = null;
        this.downAskAfter = null;

        // Derived metrics - filled later
        this.bidChangeCents = null;
        this.askChangeCents = null;
        this.costToBuyDirection = null;

        // Volume at detection
        this.upBidSize = params.upBidSize;
        this.upAskSize = params.upAskSize;

        // Timing
        this.timeRemainingSec = params.timeRemainingSec;
        this.trackingStartMs = Date.now();
        this.trackingDurationMs = null;

        // State
        this.isTracking = true;
        this.peakBidChange = 0;
        this.peakAskChange = 0;

        // Trade linkage
        this.resultedInTrade = false;
        this.linkedTradeId = null;
    }

    /**
     * Update with new tick data during tracking window
     */
    update(tick) {
        if (!this.isTracking) return;

        // Track the price at this moment
        const currentUpBid = tick.up_bid;
        const currentUpAsk = tick.up_ask;
        const currentDownBid = tick.down_bid;
        const currentDownAsk = tick.down_ask;

        // For "up" lag, we care about up_ask (cost to buy UP)
        // For "down" lag, we care about down_ask (cost to buy DOWN)
        if (this.direction === 'up') {
            const bidChange = (currentUpBid - this.upBidBefore) * 100; // In cents
            const askChange = (currentUpAsk - this.upAskBefore) * 100;

            if (Math.abs(bidChange) > Math.abs(this.peakBidChange)) {
                this.peakBidChange = bidChange;
                this.upBidAfter = currentUpBid;
            }
            if (Math.abs(askChange) > Math.abs(this.peakAskChange)) {
                this.peakAskChange = askChange;
                this.upAskAfter = currentUpAsk;
            }

            this.costToBuyDirection = currentUpAsk;
        } else {
            const bidChange = (currentDownBid - this.downBidBefore) * 100;
            const askChange = (currentDownAsk - this.downAskBefore) * 100;

            if (Math.abs(bidChange) > Math.abs(this.peakBidChange)) {
                this.peakBidChange = bidChange;
                this.downBidAfter = currentDownBid;
            }
            if (Math.abs(askChange) > Math.abs(this.peakAskChange)) {
                this.peakAskChange = askChange;
                this.downAskAfter = currentDownAsk;
            }

            this.costToBuyDirection = currentDownAsk;
        }
    }

    /**
     * Finalize the event after tracking window
     */
    finalize() {
        this.isTracking = false;
        this.trackingDurationMs = Date.now() - this.trackingStartMs;

        // Set final values
        this.bidChangeCents = this.peakBidChange;
        this.askChangeCents = this.peakAskChange;

        // Ensure after prices are set
        if (this.upBidAfter === null) this.upBidAfter = this.upBidBefore;
        if (this.upAskAfter === null) this.upAskAfter = this.upAskBefore;
        if (this.downBidAfter === null) this.downBidAfter = this.downBidBefore;
        if (this.downAskAfter === null) this.downAskAfter = this.downAskBefore;
    }

    /**
     * Convert to database format
     */
    toDBFormat() {
        return {
            eventId: this.eventId,
            timestampMs: this.timestampMs,
            crypto: this.crypto,
            windowEpoch: this.windowEpoch,
            direction: this.direction,
            lagMagnitude: this.lagMagnitude,
            lagMagnitudePct: this.lagMagnitudePct,
            spotBefore: this.spotBefore,
            spotAfter: this.spotAfter,
            spotChangePct: this.spotChangePct,
            upBidBefore: this.upBidBefore,
            upAskBefore: this.upAskBefore,
            upBidAfter: this.upBidAfter,
            upAskAfter: this.upAskAfter,
            bidChangeCents: this.bidChangeCents,
            askChangeCents: this.askChangeCents,
            costToBuyDirection: this.costToBuyDirection,
            downBidBefore: this.downBidBefore,
            downAskBefore: this.downAskBefore,
            downBidAfter: this.downBidAfter,
            downAskAfter: this.downAskAfter,
            upBidSize: this.upBidSize,
            upAskSize: this.upAskSize,
            timeRemainingSec: this.timeRemainingSec,
            trackingDurationMs: this.trackingDurationMs,
            resultedInTrade: this.resultedInTrade,
            linkedTradeId: this.linkedTradeId
        };
    }
}

/**
 * OracleOverseer - Main service class
 */
export class OracleOverseer {
    constructor(options = {}) {
        this.options = {
            lagThresholdPct: CONFIG.LAG_THRESHOLD_PCT,
            priceTrackingWindowMs: CONFIG.PRICE_TRACKING_WINDOW_MS,
            tickHistorySize: CONFIG.TICK_HISTORY_SIZE,
            spotMoveThreshold: CONFIG.SPOT_MOVE_THRESHOLD,
            ...options
        };

        // State per crypto
        this.state = {}; // crypto -> { tickHistory, lastSpot, lastFairProb }

        // Active lag events being tracked
        this.activeLagEvents = []; // Array of LagEvent

        // Completed events (in memory, for reporting)
        this.completedEvents = []; // Last N completed events
        this.maxCompletedEvents = 100;

        // Execution latency tracking
        this.pendingSignals = new Map(); // signalId -> { strategyName, signal, tick, generatedMs }

        // Stats
        this.stats = {
            ticksProcessed: 0,
            lagEventsDetected: 0,
            lagEventsCompleted: 0,
            signalsTracked: 0,
            ordersSent: 0,
            ordersFilled: 0
        };

        console.log('[OracleOverseer] Initialized with options:', {
            lagThresholdPct: this.options.lagThresholdPct,
            priceTrackingWindowMs: this.options.priceTrackingWindowMs
        });
    }

    /**
     * Initialize state for a crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                tickHistory: [],
                lastSpot: null,
                lastFairProb: null,
                lastMarketProb: null
            };
        }
        return this.state[crypto];
    }

    /**
     * Process a tick - detect lag events and track price changes
     *
     * @param {Object} tick - The tick data
     * @param {number} fairProb - The calculated fair probability (from fair value calc)
     */
    processTick(tick, fairProb) {
        if (!tick || !tick.crypto) return;

        this.stats.ticksProcessed++;
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);

        // Update tick history
        state.tickHistory.push({
            timestamp: tick.timestamp_ms || Date.now(),
            spot: tick.spot_price,
            upMid: tick.up_mid,
            upBid: tick.up_bid,
            upAsk: tick.up_ask,
            downBid: tick.down_bid,
            downAsk: tick.down_ask
        });

        // Trim history
        while (state.tickHistory.length > this.options.tickHistorySize) {
            state.tickHistory.shift();
        }

        // Update active lag events
        this.updateActiveLagEvents(tick);

        // Check for new lag events
        if (fairProb !== null && fairProb !== undefined) {
            this.detectLag(tick, fairProb, state);
            state.lastFairProb = fairProb;
        }

        state.lastSpot = tick.spot_price;
        state.lastMarketProb = tick.up_mid;
    }

    /**
     * Update all active lag events with new tick
     */
    updateActiveLagEvents(tick) {
        const now = Date.now();
        const crypto = tick.crypto;

        for (let i = this.activeLagEvents.length - 1; i >= 0; i--) {
            const event = this.activeLagEvents[i];

            // Only update events for this crypto
            if (event.crypto !== crypto) continue;

            // Check if tracking window expired
            const elapsed = now - event.trackingStartMs;
            if (elapsed >= this.options.priceTrackingWindowMs) {
                // Finalize and save
                event.finalize();
                this.saveCompletedEvent(event);
                this.activeLagEvents.splice(i, 1);
                continue;
            }

            // Update with current tick
            event.update(tick);
        }
    }

    /**
     * Detect new lag events
     */
    detectLag(tick, fairProb, state) {
        const marketProb = tick.up_mid;
        if (!marketProb || !fairProb) return;

        // Calculate lag magnitude
        const lag = fairProb - marketProb;
        const lagPct = Math.abs(lag) * 100;

        // Check if significant lag
        if (lagPct < this.options.lagThresholdPct) return;

        // Determine direction (lag > 0 means market underprices UP)
        const direction = lag > 0 ? 'up' : 'down';

        // Calculate spot change
        const spotChangePct = state.lastSpot && state.lastSpot > 0
            ? ((tick.spot_price - state.lastSpot) / state.lastSpot) * 100
            : 0;

        // Check if we already have an active event for this crypto/direction/window
        const existingEvent = this.activeLagEvents.find(
            e => e.crypto === tick.crypto &&
                 e.direction === direction &&
                 e.windowEpoch === tick.window_epoch
        );

        if (existingEvent) {
            // Already tracking this lag, just update magnitude if larger
            if (lagPct > Math.abs(existingEvent.lagMagnitudePct)) {
                existingEvent.lagMagnitude = lag;
                existingEvent.lagMagnitudePct = lagPct;
            }
            return;
        }

        // Create new lag event
        const event = new LagEvent({
            timestampMs: tick.timestamp_ms || Date.now(),
            crypto: tick.crypto,
            windowEpoch: tick.window_epoch,
            direction,
            lagMagnitude: lag,
            lagMagnitudePct: lagPct,
            spotBefore: state.lastSpot,
            spotAfter: tick.spot_price,
            spotChangePct,
            upBidBefore: tick.up_bid,
            upAskBefore: tick.up_ask,
            downBidBefore: tick.down_bid,
            downAskBefore: tick.down_ask,
            upBidSize: tick.up_bid_size,
            upAskSize: tick.up_ask_size,
            timeRemainingSec: tick.time_remaining_sec
        });

        this.activeLagEvents.push(event);
        this.stats.lagEventsDetected++;

        console.log(`[OracleOverseer] LAG DETECTED: ${tick.crypto} ${direction.toUpperCase()} | ` +
                    `lag=${lagPct.toFixed(1)}% | ask=${(direction === 'up' ? tick.up_ask : tick.down_ask).toFixed(3)} | ` +
                    `time=${tick.time_remaining_sec?.toFixed(0)}s`);
    }

    /**
     * Save a completed lag event
     */
    async saveCompletedEvent(event) {
        this.stats.lagEventsCompleted++;

        // Keep in memory for reporting
        this.completedEvents.push(event);
        while (this.completedEvents.length > this.maxCompletedEvents) {
            this.completedEvents.shift();
        }

        // Persist to database
        try {
            await saveLagEvent(event.toDBFormat());
            console.log(`[OracleOverseer] Event saved: ${event.crypto} ${event.direction} | ` +
                        `bidChange=${event.bidChangeCents?.toFixed(1)}c | askChange=${event.askChangeCents?.toFixed(1)}c`);
        } catch (error) {
            console.error('[OracleOverseer] Failed to save event:', error.message);
        }
    }

    // =========================================================================
    // EXECUTION LATENCY TRACKING
    // =========================================================================

    /**
     * Called when a strategy generates a signal (before order is sent)
     *
     * @param {string} strategyName - Name of the strategy
     * @param {Object} signal - The strategy signal
     * @param {Object} tick - Current tick data
     * @returns {string} signalId for tracking
     */
    onSignalGenerated(strategyName, signal, tick) {
        const signalId = `sig_${Date.now()}_${uuidv4().substr(0, 8)}`;

        this.pendingSignals.set(signalId, {
            signalId,
            strategyName,
            signal,
            crypto: tick.crypto,
            windowEpoch: tick.window_epoch,
            side: signal.side,
            generatedMs: Date.now(),
            priceAtSignal: signal.side === 'up' ? tick.up_ask : tick.down_ask,
            spotAtSignal: tick.spot_price,
            requestedSize: signal.size || 1
        });

        this.stats.signalsTracked++;
        return signalId;
    }

    /**
     * Called when order is submitted to SDK
     *
     * @param {string} signalId - The signal ID from onSignalGenerated
     * @param {Object} tick - Current tick data
     */
    onOrderSent(signalId, tick) {
        const pending = this.pendingSignals.get(signalId);
        if (!pending) return;

        pending.orderSentMs = Date.now();
        pending.signalToOrderMs = pending.orderSentMs - pending.generatedMs;
        pending.priceAtOrder = pending.side === 'up' ? tick.up_ask : tick.down_ask;

        this.stats.ordersSent++;
    }

    /**
     * Called when order fill is confirmed
     *
     * @param {string} signalId - The signal ID
     * @param {Object} fillDetails - { avgPrice, shares, wasRetry }
     * @param {Object} tick - Current tick data
     */
    async onOrderFilled(signalId, fillDetails, tick) {
        const pending = this.pendingSignals.get(signalId);
        if (!pending) return;

        const now = Date.now();
        pending.orderFilledMs = now;
        pending.orderToFillMs = pending.orderSentMs ? now - pending.orderSentMs : null;
        pending.totalLatencyMs = now - pending.generatedMs;
        pending.priceAtFill = fillDetails.avgPrice;
        pending.filledSize = fillDetails.shares * fillDetails.avgPrice;
        pending.fillRate = pending.requestedSize > 0
            ? pending.filledSize / pending.requestedSize
            : 1;
        pending.wasRetry = fillDetails.wasRetry || false;
        pending.fillStatus = 'filled';
        pending.spotAtFill = tick.spot_price;

        // Calculate slippage (in cents)
        pending.slippageCents = (pending.priceAtFill - pending.priceAtSignal) * 100;

        this.stats.ordersFilled++;

        // Find any related lag event
        const relatedEvent = this.activeLagEvents.find(
            e => e.crypto === pending.crypto &&
                 e.direction === pending.side &&
                 e.windowEpoch === pending.windowEpoch
        );

        if (relatedEvent) {
            relatedEvent.resultedInTrade = true;
            relatedEvent.linkedTradeId = signalId;
            pending.lagEventId = relatedEvent.eventId;
        }

        // Save to database
        try {
            await saveLatencyMeasurement({
                signalId: pending.signalId,
                timestampMs: now,
                strategyName: pending.strategyName,
                crypto: pending.crypto,
                windowEpoch: pending.windowEpoch,
                side: pending.side,
                signalGeneratedMs: pending.generatedMs,
                orderSentMs: pending.orderSentMs,
                orderFilledMs: pending.orderFilledMs,
                signalToOrderMs: pending.signalToOrderMs,
                orderToFillMs: pending.orderToFillMs,
                totalLatencyMs: pending.totalLatencyMs,
                priceAtSignal: pending.priceAtSignal,
                priceAtOrder: pending.priceAtOrder,
                priceAtFill: pending.priceAtFill,
                slippageCents: pending.slippageCents,
                spotAtSignal: pending.spotAtSignal,
                spotAtFill: pending.spotAtFill,
                requestedSize: pending.requestedSize,
                filledSize: pending.filledSize,
                fillRate: pending.fillRate,
                wasRetry: pending.wasRetry,
                fillStatus: pending.fillStatus,
                lagEventId: pending.lagEventId
            });

            console.log(`[OracleOverseer] Latency: ${pending.strategyName} | ` +
                        `total=${pending.totalLatencyMs}ms | slippage=${pending.slippageCents?.toFixed(1)}c`);
        } catch (error) {
            console.error('[OracleOverseer] Failed to save latency:', error.message);
        }

        // Clean up
        this.pendingSignals.delete(signalId);
    }

    /**
     * Called when order is rejected or times out
     */
    async onOrderRejected(signalId, reason) {
        const pending = this.pendingSignals.get(signalId);
        if (!pending) return;

        pending.fillStatus = 'rejected';
        pending.totalLatencyMs = Date.now() - pending.generatedMs;

        try {
            await saveLatencyMeasurement({
                signalId: pending.signalId,
                timestampMs: Date.now(),
                strategyName: pending.strategyName,
                crypto: pending.crypto,
                windowEpoch: pending.windowEpoch,
                side: pending.side,
                signalGeneratedMs: pending.generatedMs,
                orderSentMs: pending.orderSentMs,
                totalLatencyMs: pending.totalLatencyMs,
                priceAtSignal: pending.priceAtSignal,
                spotAtSignal: pending.spotAtSignal,
                requestedSize: pending.requestedSize,
                fillStatus: 'rejected',
                fillRate: 0
            });
        } catch (error) {
            console.error('[OracleOverseer] Failed to save rejected order:', error.message);
        }

        this.pendingSignals.delete(signalId);
    }

    // =========================================================================
    // REPORTING
    // =========================================================================

    /**
     * Get lag event report with price change analysis
     */
    getLagPriceReport() {
        if (this.completedEvents.length === 0) {
            return { message: 'No lag events recorded yet' };
        }

        const upEvents = this.completedEvents.filter(e => e.direction === 'up');
        const downEvents = this.completedEvents.filter(e => e.direction === 'down');

        const calcStats = (events) => {
            if (events.length === 0) return null;

            const askChanges = events.map(e => e.askChangeCents || 0);
            const bidChanges = events.map(e => e.bidChangeCents || 0);
            const lagMagnitudes = events.map(e => e.lagMagnitudePct);

            return {
                count: events.length,
                avgLagPct: (lagMagnitudes.reduce((a, b) => a + b, 0) / events.length).toFixed(2),
                avgAskChangeCents: (askChanges.reduce((a, b) => a + b, 0) / events.length).toFixed(2),
                avgBidChangeCents: (bidChanges.reduce((a, b) => a + b, 0) / events.length).toFixed(2),
                maxAskChangeCents: Math.max(...askChanges).toFixed(2),
                tradeLinked: events.filter(e => e.resultedInTrade).length
            };
        };

        return {
            totalEvents: this.completedEvents.length,
            activeEvents: this.activeLagEvents.length,
            up: calcStats(upEvents),
            down: calcStats(downEvents),
            byCrypto: {
                btc: calcStats(this.completedEvents.filter(e => e.crypto === 'btc')),
                eth: calcStats(this.completedEvents.filter(e => e.crypto === 'eth')),
                sol: calcStats(this.completedEvents.filter(e => e.crypto === 'sol')),
                xrp: calcStats(this.completedEvents.filter(e => e.crypto === 'xrp'))
            },
            recentEvents: this.completedEvents.slice(-5).map(e => ({
                crypto: e.crypto,
                direction: e.direction,
                lagPct: e.lagMagnitudePct?.toFixed(1),
                askChange: e.askChangeCents?.toFixed(1) + 'c',
                resultedInTrade: e.resultedInTrade
            }))
        };
    }

    /**
     * Get execution latency report
     */
    getLatencyReport() {
        return {
            signalsTracked: this.stats.signalsTracked,
            ordersSent: this.stats.ordersSent,
            ordersFilled: this.stats.ordersFilled,
            pendingSignals: this.pendingSignals.size,
            fillRate: this.stats.ordersSent > 0
                ? ((this.stats.ordersFilled / this.stats.ordersSent) * 100).toFixed(1) + '%'
                : 'N/A'
        };
    }

    /**
     * Get overall stats
     */
    getStats() {
        return {
            ...this.stats,
            activeLagEvents: this.activeLagEvents.length,
            completedEvents: this.completedEvents.length,
            pendingSignals: this.pendingSignals.size
        };
    }

    /**
     * Link a trade to a lag event (for external callers)
     */
    linkTradeToLag(tradeId, crypto, windowEpoch, side) {
        const event = this.activeLagEvents.find(
            e => e.crypto === crypto &&
                 e.windowEpoch === windowEpoch &&
                 e.direction === side
        ) || this.completedEvents.find(
            e => e.crypto === crypto &&
                 e.windowEpoch === windowEpoch &&
                 e.direction === side
        );

        if (event) {
            event.resultedInTrade = true;
            event.linkedTradeId = tradeId;
            return event.eventId;
        }
        return null;
    }
}

// Singleton instance
let oracleOverseerInstance = null;

export function getOracleOverseer(options = {}) {
    if (!oracleOverseerInstance) {
        oracleOverseerInstance = new OracleOverseer(options);
    }
    return oracleOverseerInstance;
}

export default OracleOverseer;
