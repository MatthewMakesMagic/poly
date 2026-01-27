/**
 * Resolution Service
 *
 * Captures final-minute snapshots of all price sources for resolution analysis.
 * Detects Binance/Chainlink divergence opportunities.
 *
 * Key questions answered:
 * 1. What were Binance, Chainlink, and Market prices in the final 60 seconds?
 * 2. When did Binance and Chainlink disagree on resolution outcome?
 * 3. How often did market price match Chainlink vs Binance?
 * 4. How stale was Chainlink at resolution time?
 */

import { saveResolutionSnapshot, saveResolutionOutcome } from '../db/connection.js';

// Configuration
const CONFIG = {
    // Start capturing this many seconds before resolution
    CAPTURE_START_SEC: 60,

    // Minimum divergence to flag as opportunity (0.1% = 0.001)
    DIVERGENCE_THRESHOLD_PCT: 0.1,

    // How often to capture snapshots (every tick, but at least every second)
    MIN_CAPTURE_INTERVAL_MS: 500,

    // Chainlink staleness threshold (seconds)
    STALENESS_THRESHOLD_SEC: 120,
};

/**
 * Active capture session for a window
 */
class CaptureSession {
    constructor(crypto, epoch, priceToBeat) {
        this.crypto = crypto;
        this.epoch = epoch;
        this.priceToBeat = priceToBeat;
        this.startedAt = Date.now();
        this.lastCaptureMs = 0;
        this.snapshots = []; // In-memory snapshots for this window
        this.hadDivergence = false;
        this.maxDivergence = 0;
    }
}

/**
 * Resolution Service - Main class
 */
export class ResolutionService {
    constructor(options = {}) {
        this.options = {
            captureStartSec: CONFIG.CAPTURE_START_SEC,
            divergenceThresholdPct: CONFIG.DIVERGENCE_THRESHOLD_PCT,
            minCaptureIntervalMs: CONFIG.MIN_CAPTURE_INTERVAL_MS,
            stalenessThresholdSec: CONFIG.STALENESS_THRESHOLD_SEC,
            ...options
        };

        // Active capture sessions: `${crypto}_${epoch}` -> CaptureSession
        this.activeSessions = new Map();

        // Chainlink collector reference (set externally)
        this.chainlinkCollector = null;

        // Multi-source price collector reference (set externally)
        this.multiSourceCollector = null;

        // Stats
        this.stats = {
            sessionsStarted: 0,
            snapshotsCaptured: 0,
            outcomesRecorded: 0,
            divergenceOpportunities: 0
        };

        console.log('[ResolutionService] Initialized with options:', {
            captureStartSec: this.options.captureStartSec,
            divergenceThresholdPct: this.options.divergenceThresholdPct
        });
    }

    /**
     * Set reference to Chainlink collector
     */
    setChainlinkCollector(collector) {
        this.chainlinkCollector = collector;
        console.log('[ResolutionService] Chainlink collector linked');
    }

    /**
     * Set reference to multi-source price collector (for Pyth, etc.)
     */
    setMultiSourceCollector(collector) {
        this.multiSourceCollector = collector;
        console.log('[ResolutionService] Multi-source price collector linked');
    }

    /**
     * Process a tick - check if we should start or continue capturing
     */
    processTick(tick) {
        if (!tick || !tick.crypto) return;

        const crypto = tick.crypto;
        const epoch = tick.window_epoch;
        const timeRemaining = tick.time_remaining_sec;
        const sessionKey = `${crypto}_${epoch}`;

        // Check if we should start capturing
        if (timeRemaining <= this.options.captureStartSec && timeRemaining > 0) {
            // Start new session if not already active
            if (!this.activeSessions.has(sessionKey)) {
                this.startCapture(crypto, epoch, tick.price_to_beat);
            }

            // Capture snapshot
            const session = this.activeSessions.get(sessionKey);
            if (session) {
                this.captureSnapshot(session, tick);
            }
        }

        // Clean up old sessions (for windows that are long past)
        this.cleanupOldSessions(epoch);
    }

    /**
     * Start capturing for a window
     */
    startCapture(crypto, epoch, priceToBeat) {
        const sessionKey = `${crypto}_${epoch}`;

        if (this.activeSessions.has(sessionKey)) {
            return; // Already capturing
        }

        const session = new CaptureSession(crypto, epoch, priceToBeat);
        this.activeSessions.set(sessionKey, session);
        this.stats.sessionsStarted++;

        console.log(`[ResolutionService] Started capture: ${crypto} epoch=${epoch} ptb=${priceToBeat?.toFixed(2)}`);
    }

    /**
     * Capture a single snapshot
     */
    async captureSnapshot(session, tick) {
        const now = Date.now();

        // Rate limit captures
        if (now - session.lastCaptureMs < this.options.minCaptureIntervalMs) {
            return;
        }
        session.lastCaptureMs = now;

        const secondsToResolution = Math.round(tick.time_remaining_sec);
        if (secondsToResolution < 0 || secondsToResolution > this.options.captureStartSec) {
            return;
        }

        // Get Chainlink data
        let chainlinkPrice = tick.chainlink_price;
        let chainlinkStaleness = tick.chainlink_staleness;

        // If not in tick, try to get from collector
        if (!chainlinkPrice && this.chainlinkCollector) {
            const clData = this.chainlinkCollector.getPrice(session.crypto);
            if (clData) {
                chainlinkPrice = clData.price;
                chainlinkStaleness = clData.staleness;
            }
        }

        // Calculate divergence
        let divergence = null;
        let divergencePct = null;
        let isDivergenceOpportunity = false;

        if (chainlinkPrice && tick.spot_price) {
            divergence = tick.spot_price - chainlinkPrice;
            divergencePct = chainlinkPrice > 0 ? (divergence / chainlinkPrice) * 100 : 0;

            // Check for opportunity
            if (Math.abs(divergencePct) >= this.options.divergenceThresholdPct) {
                isDivergenceOpportunity = true;
                session.hadDivergence = true;
                if (Math.abs(divergencePct) > Math.abs(session.maxDivergence)) {
                    session.maxDivergence = divergencePct;
                }
            }
        }

        // Determine what each source implies
        const priceToBeat = session.priceToBeat || tick.price_to_beat;
        const binanceImplies = tick.spot_price >= priceToBeat ? 'up' : 'down';
        const chainlinkImplies = chainlinkPrice && priceToBeat
            ? (chainlinkPrice >= priceToBeat ? 'up' : 'down')
            : null;
        const marketImplies = tick.up_mid >= 0.5 ? 'up' : 'down';

        const snapshot = {
            timestampMs: tick.timestamp_ms || now,
            crypto: session.crypto,
            windowEpoch: session.epoch,
            secondsToResolution,
            binancePrice: tick.spot_price,
            chainlinkPrice,
            chainlinkStaleness,
            upBid: tick.up_bid,
            upAsk: tick.up_ask,
            upMid: tick.up_mid,
            downBid: tick.down_bid,
            downAsk: tick.down_ask,
            binanceChainlinkDivergence: divergence,
            binanceChainlinkDivergencePct: divergencePct,
            priceToBeat,
            binanceImplies,
            chainlinkImplies,
            marketImplies,
            isDivergenceOpportunity
        };

        // Store in memory
        session.snapshots.push(snapshot);

        // Save to database
        try {
            await saveResolutionSnapshot(snapshot);
            this.stats.snapshotsCaptured++;

            // Log divergence opportunities
            if (isDivergenceOpportunity) {
                console.log(`[ResolutionService] DIVERGENCE: ${session.crypto} | ` +
                            `Binance=${binanceImplies} Chainlink=${chainlinkImplies || 'N/A'} | ` +
                            `div=${divergencePct?.toFixed(3)}% | T-${secondsToResolution}s`);
            }
        } catch (error) {
            // Ignore duplicate key errors
            if (!error.message?.includes('duplicate')) {
                console.error('[ResolutionService] Failed to save snapshot:', error.message);
            }
        }
    }

    /**
     * Called when window ends - finalize resolution data
     */
    async onWindowEnd(windowInfo) {
        const { crypto, epoch, outcome, finalPrice, priceToBeat } = windowInfo;
        const sessionKey = `${crypto}_${epoch}`;

        const session = this.activeSessions.get(sessionKey);

        // Get final snapshot data (most recent tick before resolution)
        let finalBinance = finalPrice;
        let finalChainlink = null;
        let finalPyth = null;
        let finalMarketUpMid = null;
        let chainlinkStalenessAtResolution = null;
        let pythStalenessAtResolution = null;

        if (session && session.snapshots.length > 0) {
            const lastSnapshot = session.snapshots[session.snapshots.length - 1];
            finalChainlink = lastSnapshot.chainlinkPrice;
            finalMarketUpMid = lastSnapshot.upMid;
            chainlinkStalenessAtResolution = lastSnapshot.chainlinkStaleness;
        } else if (this.chainlinkCollector) {
            // Try to get current Chainlink price
            const clData = this.chainlinkCollector.getPrice(crypto);
            if (clData) {
                finalChainlink = clData.price;
                chainlinkStalenessAtResolution = clData.staleness;
            }
        }

        // Get Pyth price from multi-source collector
        if (this.multiSourceCollector) {
            const pythData = this.multiSourceCollector.getPrice('pyth', crypto);
            if (pythData) {
                finalPyth = pythData.price;
                pythStalenessAtResolution = pythData.staleness;
            }
        }

        // Determine predictions
        const binancePredicted = finalBinance >= priceToBeat ? 'up' : 'down';
        const chainlinkPredicted = finalChainlink && priceToBeat
            ? (finalChainlink >= priceToBeat ? 'up' : 'down')
            : null;
        const pythPredicted = finalPyth && priceToBeat
            ? (finalPyth >= priceToBeat ? 'up' : 'down')
            : null;
        const marketPredicted = finalMarketUpMid !== null
            ? (finalMarketUpMid >= 0.5 ? 'up' : 'down')
            : null;

        // Check accuracy
        const binanceWasCorrect = binancePredicted === outcome;
        const chainlinkWasCorrect = chainlinkPredicted ? chainlinkPredicted === outcome : null;
        const pythWasCorrect = pythPredicted ? pythPredicted === outcome : null;
        const marketWasCorrect = marketPredicted ? marketPredicted === outcome : null;

        // Check staleness
        const chainlinkWasStale = chainlinkStalenessAtResolution !== null &&
                                  chainlinkStalenessAtResolution > this.options.stalenessThresholdSec;

        // Calculate divergences
        let divergenceMagnitude = null;
        let binancePythDivergence = null;
        if (finalBinance && finalChainlink) {
            divergenceMagnitude = ((finalBinance - finalChainlink) / finalChainlink) * 100;
        }
        if (finalBinance && finalPyth) {
            binancePythDivergence = ((finalBinance - finalPyth) / finalPyth) * 100;
        }

        const hadDivergenceOpportunity = session?.hadDivergence || false;
        if (hadDivergenceOpportunity) {
            this.stats.divergenceOpportunities++;
        }

        const outcomeData = {
            crypto,
            windowEpoch: epoch,
            finalBinance,
            finalChainlink,
            finalPyth,
            finalMarketUpMid,
            priceToBeat,
            binancePredicted,
            chainlinkPredicted,
            pythPredicted,
            marketPredicted,
            actualOutcome: outcome,
            chainlinkWasStale,
            chainlinkStalenessAtResolution,
            pythStalenessAtResolution,
            hadDivergenceOpportunity,
            divergenceMagnitude,
            binancePythDivergence,
            binanceWasCorrect,
            chainlinkWasCorrect,
            pythWasCorrect,
            marketWasCorrect
        };

        // Save outcome
        try {
            await saveResolutionOutcome(outcomeData);
            this.stats.outcomesRecorded++;

            // Log interesting cases - when sources disagree
            const disagreements = [];
            if (binanceWasCorrect !== chainlinkWasCorrect && chainlinkWasCorrect !== null) {
                disagreements.push(`Binance=${binancePredicted}(${binanceWasCorrect ? '✓' : '✗'}) vs Chainlink=${chainlinkPredicted}(${chainlinkWasCorrect ? '✓' : '✗'})`);
            }
            if (binanceWasCorrect !== pythWasCorrect && pythWasCorrect !== null) {
                disagreements.push(`Binance=${binancePredicted}(${binanceWasCorrect ? '✓' : '✗'}) vs Pyth=${pythPredicted}(${pythWasCorrect ? '✓' : '✗'})`);
            }
            if (pythWasCorrect !== chainlinkWasCorrect && pythWasCorrect !== null && chainlinkWasCorrect !== null) {
                disagreements.push(`Pyth=${pythPredicted}(${pythWasCorrect ? '✓' : '✗'}) vs Chainlink=${chainlinkPredicted}(${chainlinkWasCorrect ? '✓' : '✗'})`);
            }

            if (disagreements.length > 0) {
                console.log(`[ResolutionService] DISAGREEMENT: ${crypto} epoch=${epoch} | ${disagreements.join(' | ')} | actual=${outcome}`);
            }
        } catch (error) {
            console.error('[ResolutionService] Failed to save outcome:', error.message);
        }

        // Clean up session
        this.activeSessions.delete(sessionKey);
    }

    /**
     * Clean up old sessions
     */
    cleanupOldSessions(currentEpoch) {
        // Keep only sessions from recent epochs (last 2 windows)
        const oldestValid = currentEpoch - (15 * 60 * 2);

        for (const [key, session] of this.activeSessions.entries()) {
            if (session.epoch < oldestValid) {
                this.activeSessions.delete(key);
            }
        }
    }

    // =========================================================================
    // REPORTING
    // =========================================================================

    /**
     * Get divergence report
     */
    getDivergenceReport() {
        return {
            sessionsStarted: this.stats.sessionsStarted,
            snapshotsCaptured: this.stats.snapshotsCaptured,
            outcomesRecorded: this.stats.outcomesRecorded,
            divergenceOpportunities: this.stats.divergenceOpportunities,
            activeSessions: this.activeSessions.size,
            divergenceRate: this.stats.outcomesRecorded > 0
                ? ((this.stats.divergenceOpportunities / this.stats.outcomesRecorded) * 100).toFixed(1) + '%'
                : 'N/A'
        };
    }

    /**
     * Get current active sessions
     */
    getActiveSessions() {
        const sessions = [];
        for (const [key, session] of this.activeSessions.entries()) {
            sessions.push({
                crypto: session.crypto,
                epoch: session.epoch,
                priceToBeat: session.priceToBeat,
                snapshotsCount: session.snapshots.length,
                hadDivergence: session.hadDivergence,
                maxDivergencePct: session.maxDivergence?.toFixed(3)
            });
        }
        return sessions;
    }

    /**
     * Get stats
     */
    getStats() {
        return {
            ...this.stats,
            activeSessions: this.activeSessions.size,
            chainlinkConnected: !!this.chainlinkCollector
        };
    }
}

// Singleton instance
let resolutionServiceInstance = null;

export function getResolutionService(options = {}) {
    if (!resolutionServiceInstance) {
        resolutionServiceInstance = new ResolutionService(options);
    }
    return resolutionServiceInstance;
}

export default ResolutionService;
