/**
 * Position Path Tracker
 *
 * Tracks the complete price path from entry to expiry for every position.
 * This enables post-hoc analysis of optimal exit points.
 *
 * For each position, we record on every tick:
 * - Current market price (what we could sell for)
 * - P&L at this moment
 * - Peak P&L so far (high water mark)
 * - Drawdown from peak
 * - Spot price vs strike
 * - Time remaining
 *
 * After resolution, we can analyze:
 * - What was the optimal exit point?
 * - How often did positions hit 95¢/99¢?
 * - What trailing stop would have maximized profit?
 */

import { savePositionPathSummary } from '../db/connection.js';

// Configuration
const CONFIG = {
    // Sample rate: record every N ticks (1 = every tick)
    SAMPLE_EVERY_N_TICKS: 1,

    // Thresholds for flagging interesting events
    EXTREME_PRICE_THRESHOLD: 0.95,  // Flag when price hits 95¢
    NEAR_CERTAINTY_THRESHOLD: 0.99, // Flag when price hits 99¢
};

/**
 * Active position being tracked
 */
class TrackedPosition {
    constructor(params) {
        this.positionId = params.positionId;
        this.strategyName = params.strategyName;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;
        this.side = params.side;  // 'up' or 'down'
        this.entryPrice = params.entryPrice;
        this.entryTimestampMs = params.entryTimestampMs;
        this.entryTimeRemainingSec = params.entryTimeRemainingSec;
        this.entrySpotPrice = params.entrySpotPrice;
        this.entryPriceToBeat = params.priceToBeat;

        // Tracking state
        this.tickCount = 0;
        this.pathPoints = [];
        this.peakPrice = params.entryPrice;
        this.peakPnlPct = 0;
        this.troughPrice = params.entryPrice;
        this.maxDrawdownPct = 0;

        // Milestones
        this.hit95 = false;
        this.hit99 = false;
        this.hit95AtMs = null;
        this.hit99AtMs = null;
        this.hit95TimeRemaining = null;
        this.hit99TimeRemaining = null;

        // Resolution
        this.resolved = false;
        this.exitPrice = null;
        this.exitTimestampMs = null;
        this.finalPnlPct = null;
        this.outcome = null;
    }

    /**
     * Record a tick while position is open
     */
    recordTick(tick) {
        if (this.resolved) return;

        this.tickCount++;

        // Get current price for our side
        const currentPrice = this.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
        const currentBid = this.side === 'up' ? tick.up_bid : tick.down_bid;
        const spotPrice = tick.spot_price;
        const priceToBeat = tick.price_to_beat || this.entryPriceToBeat;
        const timeRemainingSec = tick.time_remaining_sec;

        // Calculate P&L
        const pnlPct = (currentPrice - this.entryPrice) / this.entryPrice;

        // Update peak (high water mark)
        if (currentPrice > this.peakPrice) {
            this.peakPrice = currentPrice;
            this.peakPnlPct = pnlPct;
        }

        // Update trough
        if (currentPrice < this.troughPrice) {
            this.troughPrice = currentPrice;
        }

        // Calculate drawdown from peak
        const drawdownFromPeak = this.peakPrice > 0
            ? (this.peakPrice - currentPrice) / this.peakPrice
            : 0;

        if (drawdownFromPeak > this.maxDrawdownPct) {
            this.maxDrawdownPct = drawdownFromPeak;
        }

        // Check milestones
        if (!this.hit95 && currentPrice >= CONFIG.EXTREME_PRICE_THRESHOLD) {
            this.hit95 = true;
            this.hit95AtMs = tick.timestamp_ms;
            this.hit95TimeRemaining = timeRemainingSec;
        }

        if (!this.hit99 && currentPrice >= CONFIG.NEAR_CERTAINTY_THRESHOLD) {
            this.hit99 = true;
            this.hit99AtMs = tick.timestamp_ms;
            this.hit99TimeRemaining = timeRemainingSec;
        }

        // Record path point (sampling if configured)
        if (this.tickCount % CONFIG.SAMPLE_EVERY_N_TICKS === 0) {
            this.pathPoints.push({
                timestampMs: tick.timestamp_ms,
                ticksSinceEntry: this.tickCount,
                timeRemainingSec,
                currentPrice,
                currentBid,
                pnlPct,
                spotPrice,
                spotVsStrike: spotPrice && priceToBeat
                    ? ((spotPrice - priceToBeat) / priceToBeat) * 100
                    : null,
                peakPriceSoFar: this.peakPrice,
                peakPnlSoFar: this.peakPnlPct,
                drawdownFromPeak
            });
        }
    }

    /**
     * Mark position as resolved
     */
    resolve(outcome, exitPrice, exitTimestampMs) {
        this.resolved = true;
        this.outcome = outcome;
        this.exitPrice = exitPrice;
        this.exitTimestampMs = exitTimestampMs;

        // Calculate final P&L based on binary outcome
        // If we held to expiry: win = 1.00, lose = 0.00
        const finalValue = (this.side === outcome) ? 1.0 : 0.0;
        this.finalPnlPct = (finalValue - this.entryPrice) / this.entryPrice;
    }

    /**
     * Get summary for database storage
     */
    getSummary() {
        // Find optimal exit point (highest price seen)
        let optimalExitPoint = null;
        let optimalExitPnl = this.peakPnlPct;
        for (const point of this.pathPoints) {
            if (point.currentPrice === this.peakPrice) {
                optimalExitPoint = point;
                break;
            }
        }

        // Calculate what P&L would have been with different exits
        const exitScenarios = {
            holdToExpiry: this.finalPnlPct,
            exitAt95: this.hit95 ? ((0.95 - this.entryPrice) / this.entryPrice) : null,
            exitAt99: this.hit99 ? ((0.99 - this.entryPrice) / this.entryPrice) : null,
            exitAtPeak: this.peakPnlPct
        };

        return {
            positionId: this.positionId,
            strategyName: this.strategyName,
            crypto: this.crypto,
            windowEpoch: this.windowEpoch,
            side: this.side,

            // Entry
            entryPrice: this.entryPrice,
            entryTimestampMs: this.entryTimestampMs,
            entryTimeRemainingSec: this.entryTimeRemainingSec,

            // Path stats
            tickCount: this.tickCount,
            pathPointCount: this.pathPoints.length,

            // Peak/trough
            peakPrice: this.peakPrice,
            peakPnlPct: this.peakPnlPct,
            troughPrice: this.troughPrice,
            maxDrawdownPct: this.maxDrawdownPct,

            // Milestones
            hit95: this.hit95,
            hit99: this.hit99,
            hit95TimeRemaining: this.hit95TimeRemaining,
            hit99TimeRemaining: this.hit99TimeRemaining,

            // Optimal exit analysis
            optimalExitTimeRemaining: optimalExitPoint?.timeRemainingSec,
            optimalExitPnl: optimalExitPnl,

            // Exit scenarios
            pnlHoldToExpiry: exitScenarios.holdToExpiry,
            pnlExitAt95: exitScenarios.exitAt95,
            pnlExitAt99: exitScenarios.exitAt99,
            pnlExitAtPeak: exitScenarios.exitAtPeak,

            // Resolution
            outcome: this.outcome,
            finalPnlPct: this.finalPnlPct
        };
    }

    /**
     * Get full path for detailed analysis
     */
    getPath() {
        return {
            positionId: this.positionId,
            strategyName: this.strategyName,
            crypto: this.crypto,
            windowEpoch: this.windowEpoch,
            side: this.side,
            entryPrice: this.entryPrice,
            points: this.pathPoints
        };
    }
}

/**
 * Position Path Tracker - Main service
 */
export class PositionPathTracker {
    constructor(options = {}) {
        this.options = {
            sampleEveryNTicks: CONFIG.SAMPLE_EVERY_N_TICKS,
            ...options
        };

        // Active positions being tracked: positionId -> TrackedPosition
        this.activePositions = new Map();

        // Completed positions (kept in memory briefly for reporting)
        this.recentlyCompleted = [];
        this.maxRecentlyCompleted = 100;

        // Stats
        this.stats = {
            positionsTracked: 0,
            positionsCompleted: 0,
            ticksProcessed: 0,
            pathPointsRecorded: 0
        };

        console.log('[PositionPathTracker] Initialized');
    }

    /**
     * Start tracking a new position
     */
    trackPosition(params) {
        const {
            positionId,
            strategyName,
            crypto,
            windowEpoch,
            side,
            entryPrice,
            entryTimestampMs,
            entryTimeRemainingSec,
            entrySpotPrice,
            priceToBeat
        } = params;

        const position = new TrackedPosition({
            positionId: positionId || `${strategyName}_${crypto}_${windowEpoch}`,
            strategyName,
            crypto,
            windowEpoch,
            side,
            entryPrice,
            entryTimestampMs: entryTimestampMs || Date.now(),
            entryTimeRemainingSec,
            entrySpotPrice,
            priceToBeat
        });

        this.activePositions.set(position.positionId, position);
        this.stats.positionsTracked++;

        // Removed verbose logging - was cluttering logs with paper position tracking

        return position.positionId;
    }

    /**
     * Process a tick - update all active positions
     */
    processTick(tick) {
        if (!tick || !tick.crypto) return;

        this.stats.ticksProcessed++;

        // Update all positions for this crypto
        for (const [positionId, position] of this.activePositions.entries()) {
            if (position.crypto === tick.crypto && !position.resolved) {
                position.recordTick(tick);
                this.stats.pathPointsRecorded++;
            }
        }
    }

    /**
     * Called when a position is exited (manually or at expiry)
     */
    async onPositionExit(positionId, outcome, exitPrice, exitTimestampMs) {
        const position = this.activePositions.get(positionId);
        if (!position) {
            console.warn(`[PositionPathTracker] Position not found: ${positionId}`);
            return null;
        }

        position.resolve(outcome, exitPrice, exitTimestampMs || Date.now());

        // Get summary and path
        const summary = position.getSummary();
        const path = position.getPath();

        // Save to database
        try {
            await savePositionPathSummary(summary);

            // Optionally save full path (can be large)
            // await savePositionPath(path);

            console.log(`[PositionPathTracker] Completed: ${positionId} | ` +
                `outcome=${outcome} | peakPnl=${(summary.peakPnlPct * 100).toFixed(1)}% | ` +
                `finalPnl=${(summary.finalPnlPct * 100).toFixed(1)}% | ` +
                `hit95=${summary.hit95} hit99=${summary.hit99}`);
        } catch (error) {
            console.error(`[PositionPathTracker] Failed to save: ${error.message}`);
        }

        // Move to recently completed
        this.recentlyCompleted.push(summary);
        if (this.recentlyCompleted.length > this.maxRecentlyCompleted) {
            this.recentlyCompleted.shift();
        }

        // Remove from active
        this.activePositions.delete(positionId);
        this.stats.positionsCompleted++;

        return summary;
    }

    /**
     * Called when window ends - resolve all positions for that window
     */
    async onWindowEnd(windowInfo) {
        const { crypto, epoch, outcome } = windowInfo;

        const summaries = [];
        for (const [positionId, position] of this.activePositions.entries()) {
            if (position.crypto === crypto && position.windowEpoch === epoch) {
                const summary = await this.onPositionExit(
                    positionId,
                    outcome,
                    outcome === position.side ? 1.0 : 0.0,
                    Date.now()
                );
                if (summary) summaries.push(summary);
            }
        }

        return summaries;
    }

    /**
     * Get active positions
     */
    getActivePositions() {
        const positions = [];
        for (const [positionId, position] of this.activePositions.entries()) {
            positions.push({
                positionId,
                strategyName: position.strategyName,
                crypto: position.crypto,
                windowEpoch: position.windowEpoch,
                side: position.side,
                entryPrice: position.entryPrice,
                tickCount: position.tickCount,
                peakPrice: position.peakPrice,
                peakPnlPct: position.peakPnlPct,
                hit95: position.hit95,
                hit99: position.hit99
            });
        }
        return positions;
    }

    /**
     * Get recently completed positions
     */
    getRecentlyCompleted() {
        return this.recentlyCompleted;
    }

    /**
     * Get stats
     */
    getStats() {
        return {
            ...this.stats,
            activePositions: this.activePositions.size,
            recentlyCompleted: this.recentlyCompleted.length
        };
    }

    /**
     * Get exit analysis report
     */
    getExitAnalysisReport() {
        const completed = this.recentlyCompleted;
        if (completed.length === 0) {
            return { message: 'No completed positions yet' };
        }

        // Aggregate stats
        let totalHit95 = 0;
        let totalHit99 = 0;
        let sumPnlHold = 0;
        let sumPnl95 = 0;
        let sumPnl99 = 0;
        let sumPnlPeak = 0;
        let count95 = 0;
        let count99 = 0;

        for (const p of completed) {
            if (p.hit95) totalHit95++;
            if (p.hit99) totalHit99++;

            sumPnlHold += p.pnlHoldToExpiry || 0;
            sumPnlPeak += p.pnlExitAtPeak || 0;

            if (p.pnlExitAt95 !== null) {
                sumPnl95 += p.pnlExitAt95;
                count95++;
            }
            if (p.pnlExitAt99 !== null) {
                sumPnl99 += p.pnlExitAt99;
                count99++;
            }
        }

        return {
            totalPositions: completed.length,
            hit95Rate: (totalHit95 / completed.length * 100).toFixed(1) + '%',
            hit99Rate: (totalHit99 / completed.length * 100).toFixed(1) + '%',
            avgPnl: {
                holdToExpiry: (sumPnlHold / completed.length * 100).toFixed(2) + '%',
                exitAt95: count95 > 0 ? (sumPnl95 / count95 * 100).toFixed(2) + '%' : 'N/A',
                exitAt99: count99 > 0 ? (sumPnl99 / count99 * 100).toFixed(2) + '%' : 'N/A',
                exitAtPeak: (sumPnlPeak / completed.length * 100).toFixed(2) + '%'
            },
            recommendation: this.getExitRecommendation(completed)
        };
    }

    /**
     * Generate exit recommendation based on data
     */
    getExitRecommendation(completed) {
        if (completed.length < 20) {
            return 'Insufficient data - need 20+ positions for recommendation';
        }

        let sumHold = 0, sumPeak = 0;
        for (const p of completed) {
            sumHold += p.pnlHoldToExpiry || 0;
            sumPeak += p.pnlExitAtPeak || 0;
        }

        const avgHold = sumHold / completed.length;
        const avgPeak = sumPeak / completed.length;
        const lostAlpha = avgPeak - avgHold;

        if (lostAlpha > 0.05) {
            return `Hold-to-expiry loses ${(lostAlpha * 100).toFixed(1)}% vs optimal exit. Consider take-profit or trailing stop.`;
        } else if (lostAlpha < -0.02) {
            return `Hold-to-expiry outperforms early exits by ${(-lostAlpha * 100).toFixed(1)}%. Continue holding.`;
        } else {
            return 'Minimal difference between hold-to-expiry and optimal exit. Either approach is acceptable.';
        }
    }
}

// Singleton
let positionPathTrackerInstance = null;

export function getPositionPathTracker(options = {}) {
    if (!positionPathTrackerInstance) {
        positionPathTrackerInstance = new PositionPathTracker(options);
    }
    return positionPathTrackerInstance;
}

export default PositionPathTracker;
