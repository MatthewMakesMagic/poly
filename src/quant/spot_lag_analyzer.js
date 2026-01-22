/**
 * Spot Lag Analyzer
 * 
 * Measures how quickly the Polymarket market prices spot price movements.
 * This is critical for identifying the lead-lag alpha opportunity.
 * 
 * Key questions answered:
 * 1. When spot moves 0.1%, how long until market fully prices it?
 * 2. What's the average reaction time?
 * 3. How much alpha decays over time?
 * 
 * Methodology:
 * - Detect significant spot price changes (>0.05% threshold)
 * - Track market probability before, during, and after
 * - Calculate expected vs actual market response
 * - Build decay curve of alpha opportunity
 */

import { fairProbabilityUp } from './fair_value.js';

/**
 * Spot move event for tracking
 */
class SpotMoveEvent {
    constructor(params) {
        this.id = params.id || `spot_${Date.now()}`;
        this.crypto = params.crypto;
        this.timestamp = params.timestamp;
        
        // Spot price movement
        this.spotPriceBefore = params.spotPriceBefore;
        this.spotPriceAfter = params.spotPriceAfter;
        this.spotChange = params.spotChange;           // Absolute change
        this.spotChangePct = params.spotChangePct;     // Percentage change
        this.direction = params.spotChangePct > 0 ? 'up' : 'down';
        
        // Market state at time of spot move
        this.marketProbBefore = params.marketProbBefore;
        this.priceToBeat = params.priceToBeat;
        this.timeRemaining = params.timeRemaining;
        this.realizedVol = params.realizedVol;
        
        // Expected fair probability after move
        this.expectedFairProb = params.expectedFairProb;
        this.expectedProbChange = params.expectedProbChange;
        
        // Tracking market response over time
        this.marketSnapshots = [];  // [{t: ms_since_event, prob: market_prob}]
        
        // Results (filled after analysis)
        this.fullPricingTime = null;      // Time to fully price move (ms)
        this.halfPricingTime = null;      // Time to price 50% of move (ms)
        this.maxLag = null;               // Maximum probability lag observed
        this.alphaDecay = [];             // [{t: ms, alpha: remaining_alpha}]
    }
    
    /**
     * Add a market snapshot after the move
     */
    addSnapshot(timestamp, marketProb) {
        const msSince = timestamp - this.timestamp;
        this.marketSnapshots.push({
            t: msSince,
            prob: marketProb,
            lag: this.expectedFairProb - marketProb
        });
    }
    
    /**
     * Analyze the market response
     */
    analyze() {
        if (this.marketSnapshots.length < 2) return;
        
        const targetChange = this.expectedProbChange;
        if (Math.abs(targetChange) < 0.01) return;
        
        // Initial lag (at t=0)
        const initialLag = this.expectedFairProb - this.marketProbBefore;
        this.maxLag = Math.abs(initialLag);
        
        // Find when market reaches various thresholds of the expected move
        const thresholds = [0.25, 0.5, 0.75, 0.9, 1.0];
        const pricingTimes = {};
        
        for (const threshold of thresholds) {
            const targetProb = this.marketProbBefore + targetChange * threshold;
            
            for (const snap of this.marketSnapshots) {
                // Check if market has reached this threshold
                const achievedPct = (snap.prob - this.marketProbBefore) / targetChange;
                
                if (achievedPct >= threshold && !pricingTimes[threshold]) {
                    pricingTimes[threshold] = snap.t;
                }
            }
        }
        
        this.halfPricingTime = pricingTimes[0.5] || null;
        this.fullPricingTime = pricingTimes[0.9] || null;  // 90% as "full"
        
        // Build alpha decay curve
        this.alphaDecay = this.marketSnapshots.map(snap => ({
            t: snap.t,
            alpha: Math.abs(snap.lag),
            alphaPct: Math.abs(snap.lag / initialLag) * 100
        }));
    }
    
    /**
     * Get summary of this event
     */
    getSummary() {
        return {
            id: this.id,
            crypto: this.crypto,
            direction: this.direction,
            spotChangePct: (this.spotChangePct * 100).toFixed(3) + '%',
            expectedProbChange: (this.expectedProbChange * 100).toFixed(2) + '%',
            halfPricingTimeMs: this.halfPricingTime,
            fullPricingTimeMs: this.fullPricingTime,
            maxLag: this.maxLag,
            snapshots: this.marketSnapshots.length
        };
    }
}

/**
 * Main SpotLagAnalyzer class
 */
export class SpotLagAnalyzer {
    constructor(options = {}) {
        this.options = {
            spotChangeThreshold: 0.0005,  // 0.05% minimum spot change to track
            trackingDurationMs: 30000,    // Track for 30 seconds after event
            snapshotIntervalMs: 1000,     // Take snapshots every second
            maxActiveEvents: 50,          // Max concurrent events to track
            ...options
        };
        
        // State per crypto
        this.state = {};
        
        // Completed events for analysis
        this.completedEvents = [];
        
        // Aggregated statistics
        this.stats = {
            totalEvents: 0,
            avgHalfPricingTime: null,
            avgFullPricingTime: null,
            avgMaxLag: null,
            byDirection: {
                up: { count: 0, avgHalfTime: null, avgFullTime: null },
                down: { count: 0, avgHalfTime: null, avgFullTime: null }
            }
        };
    }
    
    /**
     * Initialize state for a crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                lastSpotPrice: null,
                lastMarketProb: null,
                lastTimestamp: null,
                activeEvents: [],  // Currently tracking
                recentSpots: [],   // For calculating vol
                windowEpoch: null
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Process a new tick
     */
    processTick(tick, realizedVol) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        const spotPrice = tick.spot_price;
        const marketProb = tick.up_mid || 0.5;
        const timestamp = tick.timestamp || Date.now();
        const priceToBeat = tick.price_to_beat || spotPrice;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Check for window change
        if (state.windowEpoch !== tick.epoch && tick.epoch) {
            state.windowEpoch = tick.epoch;
            state.activeEvents = [];  // Clear events on window change
        }
        
        // Update recent spots for vol calculation
        state.recentSpots.push(spotPrice);
        if (state.recentSpots.length > 60) state.recentSpots.shift();
        
        // Update active events with new snapshot
        for (const event of state.activeEvents) {
            event.addSnapshot(timestamp, marketProb);
            
            // Check if event tracking period is over
            if (timestamp - event.timestamp > this.options.trackingDurationMs) {
                event.analyze();
                this.completedEvents.push(event);
                this.updateStats(event);
            }
        }
        
        // Remove completed events
        state.activeEvents = state.activeEvents.filter(
            e => timestamp - e.timestamp <= this.options.trackingDurationMs
        );
        
        // Detect new spot move
        if (state.lastSpotPrice !== null && spotPrice !== null) {
            const spotChange = spotPrice - state.lastSpotPrice;
            const spotChangePct = spotChange / state.lastSpotPrice;
            
            if (Math.abs(spotChangePct) >= this.options.spotChangeThreshold) {
                // Calculate expected fair probability after this move
                const vol = realizedVol || 0.8;
                const expectedFairProb = fairProbabilityUp(
                    spotPrice, 
                    priceToBeat, 
                    timeRemaining, 
                    vol
                );
                const expectedProbChange = expectedFairProb - state.lastMarketProb;
                
                // Create new event
                const event = new SpotMoveEvent({
                    crypto,
                    timestamp,
                    spotPriceBefore: state.lastSpotPrice,
                    spotPriceAfter: spotPrice,
                    spotChange,
                    spotChangePct,
                    marketProbBefore: state.lastMarketProb,
                    priceToBeat,
                    timeRemaining,
                    realizedVol: vol,
                    expectedFairProb,
                    expectedProbChange
                });
                
                // Add initial snapshot (market state at time of spot move)
                event.addSnapshot(timestamp, marketProb);
                
                // Track if significant expected change
                if (Math.abs(expectedProbChange) > 0.01) {
                    // Limit active events
                    if (state.activeEvents.length < this.options.maxActiveEvents) {
                        state.activeEvents.push(event);
                        this.stats.totalEvents++;
                    }
                }
            }
        }
        
        // Update state
        state.lastSpotPrice = spotPrice;
        state.lastMarketProb = marketProb;
        state.lastTimestamp = timestamp;
        
        return {
            activeEvents: state.activeEvents.length,
            completedEvents: this.completedEvents.length
        };
    }
    
    /**
     * Update aggregated statistics
     */
    updateStats(event) {
        const events = this.completedEvents;
        
        // Calculate averages
        const halfTimes = events.filter(e => e.halfPricingTime !== null).map(e => e.halfPricingTime);
        const fullTimes = events.filter(e => e.fullPricingTime !== null).map(e => e.fullPricingTime);
        const maxLags = events.filter(e => e.maxLag !== null).map(e => e.maxLag);
        
        this.stats.avgHalfPricingTime = halfTimes.length > 0 
            ? halfTimes.reduce((a, b) => a + b, 0) / halfTimes.length 
            : null;
        this.stats.avgFullPricingTime = fullTimes.length > 0 
            ? fullTimes.reduce((a, b) => a + b, 0) / fullTimes.length 
            : null;
        this.stats.avgMaxLag = maxLags.length > 0 
            ? maxLags.reduce((a, b) => a + b, 0) / maxLags.length 
            : null;
        
        // Update by direction
        for (const dir of ['up', 'down']) {
            const dirEvents = events.filter(e => e.direction === dir);
            const dirHalfTimes = dirEvents.filter(e => e.halfPricingTime !== null).map(e => e.halfPricingTime);
            const dirFullTimes = dirEvents.filter(e => e.fullPricingTime !== null).map(e => e.fullPricingTime);
            
            this.stats.byDirection[dir].count = dirEvents.length;
            this.stats.byDirection[dir].avgHalfTime = dirHalfTimes.length > 0 
                ? dirHalfTimes.reduce((a, b) => a + b, 0) / dirHalfTimes.length 
                : null;
            this.stats.byDirection[dir].avgFullTime = dirFullTimes.length > 0 
                ? dirFullTimes.reduce((a, b) => a + b, 0) / dirFullTimes.length 
                : null;
        }
    }
    
    /**
     * Get current lag measurement signal
     * Returns the "lag signal" for trading decisions
     */
    getLagSignal(crypto, tick, realizedVol) {
        const state = this.state[crypto];
        if (!state) return null;
        
        const spotPrice = tick.spot_price;
        const marketProb = tick.up_mid || 0.5;
        const priceToBeat = tick.price_to_beat || spotPrice;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Calculate expected fair probability
        const vol = realizedVol || 0.8;
        const fairProb = fairProbabilityUp(spotPrice, priceToBeat, timeRemaining, vol);
        
        // Current lag
        const lag = fairProb - marketProb;
        
        // Check recent spot momentum (over last 5 ticks)
        const recentSpots = state.recentSpots.slice(-5);
        let spotMomentum = 0;
        if (recentSpots.length >= 2) {
            spotMomentum = (recentSpots[recentSpots.length - 1] - recentSpots[0]) / recentSpots[0];
        }
        
        // Signal: if there's significant lag AND spot is moving in a direction
        const lagThreshold = 0.03;  // 3% probability lag
        const momentumThreshold = 0.0003;  // 0.03% spot movement
        
        let signal = 'HOLD';
        let side = null;
        let strength = 0;
        
        if (lag > lagThreshold && spotMomentum > momentumThreshold) {
            // Market is behind - spot went up, market hasn't caught up
            signal = 'BUY';
            side = 'up';
            strength = Math.min(1, lag / 0.1);
        } else if (lag < -lagThreshold && spotMomentum < -momentumThreshold) {
            // Market is behind - spot went down, market hasn't caught up
            signal = 'BUY';
            side = 'down';
            strength = Math.min(1, -lag / 0.1);
        }
        
        return {
            crypto,
            timestamp: Date.now(),
            fairProb,
            marketProb,
            lag,
            lagPct: lag * 100,
            spotMomentum,
            spotMomentumPct: spotMomentum * 100,
            signal,
            side,
            strength,
            avgHalfPricingTime: this.stats.avgHalfPricingTime,
            avgFullPricingTime: this.stats.avgFullPricingTime
        };
    }
    
    /**
     * Get comprehensive report
     */
    getReport() {
        return {
            timestamp: Date.now(),
            totalEvents: this.stats.totalEvents,
            completedEvents: this.completedEvents.length,
            
            // Key metrics
            avgHalfPricingTimeMs: this.stats.avgHalfPricingTime,
            avgFullPricingTimeMs: this.stats.avgFullPricingTime,
            avgMaxLag: this.stats.avgMaxLag,
            avgMaxLagPct: this.stats.avgMaxLag !== null ? this.stats.avgMaxLag * 100 : null,
            
            // By direction
            upMoves: this.stats.byDirection.up,
            downMoves: this.stats.byDirection.down,
            
            // Alpha decay (average across events)
            alphaDecayCurve: this.buildAverageDecayCurve(),
            
            // Recent events summary
            recentEvents: this.completedEvents.slice(-10).map(e => e.getSummary())
        };
    }
    
    /**
     * Build average alpha decay curve
     */
    buildAverageDecayCurve() {
        const timePoints = [0, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 30000];
        const curve = [];
        
        for (const t of timePoints) {
            const alphasAtT = [];
            
            for (const event of this.completedEvents) {
                // Find closest snapshot to this time point
                const snap = event.alphaDecay.find(s => Math.abs(s.t - t) < 1500);
                if (snap) {
                    alphasAtT.push(snap.alphaPct);
                }
            }
            
            if (alphasAtT.length > 0) {
                curve.push({
                    timeMs: t,
                    avgAlphaPct: alphasAtT.reduce((a, b) => a + b, 0) / alphasAtT.length,
                    sampleCount: alphasAtT.length
                });
            }
        }
        
        return curve;
    }
    
    /**
     * Get summary for a specific crypto
     */
    getCryptoSummary(crypto) {
        const state = this.state[crypto];
        if (!state) return null;
        
        const cryptoEvents = this.completedEvents.filter(e => e.crypto === crypto);
        
        return {
            crypto,
            activeTracking: state.activeEvents.length,
            completedEvents: cryptoEvents.length,
            lastSpotPrice: state.lastSpotPrice,
            lastMarketProb: state.lastMarketProb
        };
    }
}

export { SpotMoveEvent };
export default SpotLagAnalyzer;
