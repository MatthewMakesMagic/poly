/**
 * Smart Exit Logic for Binary Options
 * 
 * Shared exit rules that can be used by all strategies.
 * 
 * Exit when:
 * 1. Edge REVERSES (fair value now favors opposite side)
 * 2. Edge DISAPPEARS (no longer have meaningful edge)
 * 3. Extreme DRAWDOWN (risk management)
 * 4. TIME EXIT (let binary expire naturally)
 * 
 * Hold when:
 * - Still have edge in our direction
 */

/**
 * Default exit configuration for binary options
 */
export const DEFAULT_EXIT_CONFIG = {
    // Edge-based exits (recommended for binary options)
    exitOnEdgeReversal: true,   // Exit if fair value now favors opposite side
    exitOnEdgeLoss: true,       // Exit if edge drops below threshold
    minEdgeToHold: 0.01,        // Minimum 1% edge to continue holding
    
    // Risk management (extreme moves only)
    maxDrawdown: 0.30,          // Exit if down >30%
    
    // Trailing stop (optional - disabled by default)
    useTrailingStop: false,
    trailingStopActivation: 0.20,
    trailingStopDistance: 0.10,
    
    // Time-based
    exitTimeRemaining: 30,      // Exit with <30s left
};

/**
 * Check if position should be exited
 * 
 * @param {Object} position - Current position {side, entryPrice, ...}
 * @param {Object} tick - Current tick data
 * @param {Object} analysis - Fair value analysis {fairProb, marketProb, side, isSignificant, ...}
 * @param {Object} config - Exit configuration
 * @returns {Object|null} - Exit signal or null if should hold
 */
export function checkExitConditions(position, tick, analysis, config = {}) {
    const opts = { ...DEFAULT_EXIT_CONFIG, ...config };
    
    if (!position) return null;
    
    const marketProb = tick.up_mid;
    const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
    const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
    
    // 1. TIME EXIT - let binary expire
    if (tick.time_remaining_sec < opts.exitTimeRemaining) {
        return { action: 'sell', reason: 'time_exit' };
    }
    
    // 2. EDGE REVERSAL - fair value now favors opposite side
    if (opts.exitOnEdgeReversal && analysis?.isSignificant) {
        const currentFairSide = analysis.side;
        if (currentFairSide && currentFairSide !== position.side) {
            return { action: 'sell', reason: 'edge_reversed' };
        }
    }
    
    // 3. EDGE DISAPPEARED - no longer have meaningful edge
    if (opts.exitOnEdgeLoss && analysis?.fairProb !== undefined) {
        const ourEdge = position.side === 'up'
            ? (analysis.fairProb - analysis.marketProb)
            : (analysis.marketProb - analysis.fairProb);
        
        if (ourEdge < opts.minEdgeToHold) {
            return { action: 'sell', reason: 'edge_insufficient' };
        }
    }
    
    // 4. EXTREME DRAWDOWN - risk management
    if (pnlPct <= -opts.maxDrawdown) {
        return { action: 'sell', reason: 'max_drawdown' };
    }
    
    // 5. TRAILING STOP (if enabled)
    if (opts.useTrailingStop && pnlPct >= opts.trailingStopActivation) {
        const highWaterMark = position.highWaterMark || pnlPct;
        position.highWaterMark = Math.max(highWaterMark, pnlPct);
        
        if (pnlPct < position.highWaterMark - opts.trailingStopDistance) {
            return { action: 'sell', reason: 'trailing_stop' };
        }
    }
    
    // Still have edge, HOLD
    return null;
}

/**
 * Simple exit check for strategies without fair value analysis
 * Uses price-based rules only
 */
export function checkSimpleExitConditions(position, tick, config = {}) {
    const opts = { ...DEFAULT_EXIT_CONFIG, ...config };
    
    if (!position) return null;
    
    const marketProb = tick.up_mid;
    const currentPrice = position.side === 'up' ? marketProb : (1 - marketProb);
    const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
    
    // TIME EXIT
    if (tick.time_remaining_sec < opts.exitTimeRemaining) {
        return { action: 'sell', reason: 'time_exit' };
    }
    
    // EXTREME DRAWDOWN
    if (pnlPct <= -opts.maxDrawdown) {
        return { action: 'sell', reason: 'max_drawdown' };
    }
    
    // TRAILING STOP (if enabled)
    if (opts.useTrailingStop && pnlPct >= opts.trailingStopActivation) {
        const highWaterMark = position.highWaterMark || pnlPct;
        position.highWaterMark = Math.max(highWaterMark, pnlPct);
        
        if (pnlPct < position.highWaterMark - opts.trailingStopDistance) {
            return { action: 'sell', reason: 'trailing_stop' };
        }
    }
    
    return null;
}
