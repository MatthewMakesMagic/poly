/**
 * Quant Strategy Index
 * 
 * Exports all quantitative strategies for the research framework.
 * 
 * Strategy Categories:
 * 1. Fair Value - Trade deviations from theoretical probability
 * 2. Spot Lag - Trade when market lags spot movements
 * 3. Time Conditional - Different behavior by window phase
 * 4. Regime - Adapt to market conditions
 * 5. Microstructure - Order flow and spread signals
 * 6. Cross Asset - BTC leads alts
 * 7. Contrarian - FADE spot movements (backtest shows 55-63% accuracy!)
 */

// Strategy classes
export { FairValueStrategy, createFairValueRealizedVol, createFairValueEWMA, createFairValueWithDrift, DriftAwareFairValueStrategy, FairValueDrift1HStrategy, FairValueDrift4HStrategy, FairValueDrift24HStrategy, FairValueUpOnly4HStrategy, createFairValueDrift1H, createFairValueDrift4H, createFairValueDrift24H, createFairValueUpOnly4H } from './fair_value_strategy.js';
export { SpotLagStrategy, createSpotLag1s, createSpotLag5s, createSpotLag10s } from './spot_lag_strategy.js';
export { TimeConditionalStrategy } from './time_conditional_strategy.js';
export { RegimeStrategy } from './regime_strategy.js';
export { MicrostructureStrategy } from './microstructure_strategy.js';
export { CrossAssetStrategy } from './cross_asset_strategy.js';
export { ContrarianStrategy, ContrarianSOLStrategy, ContrarianScalpStrategy, ContrarianStrongStrategy, createContrarianBase, createContrarianSOL, createContrarianScalp, createContrarianStrong } from './contrarian_strategy.js';
export { EndgameStrategy, EndgameConservativeStrategy, EndgameAggressiveStrategy, EndgameSafeStrategy, EndgameMomentumStrategy, createEndgameBase, createEndgameConservative, createEndgameAggressive, createEndgameSafe, createEndgameMomentum } from './endgame_strategy.js';
export { SpotLagSimpleStrategy, SpotLagFastStrategy, SpotLagConfirmedStrategy, SpotLagAggressiveStrategy, createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive, createSpotLag5Sec, createSpotLag10Sec, createSpotLag30Sec, createSpotLag60Sec, createSpotLag120Sec, createSpotLag300Sec, MispricingOnlyStrategy, MispricingStrictStrategy, MispricingLooseStrategy, MispricingExtremeStrategy, createMispricingOnly, createMispricingStrict, createMispricingLoose, createMispricingExtreme, SpotLagChainlinkConfirmedStrategy, SpotLagAggressiveCLStrategy, MispricingChainlinkConfirmedStrategy, UpOnlyChainlinkStrategy, createSpotLagCLConfirmed, createSpotLagAggressiveCL, createMispricingCLConfirmed, createUpOnlyCLConfirmed, SpotLag_VolatilityAdaptiveStrategy, createSpotLagVolAdapt, SpotLag_TrailingStopStrategy, SpotLag_TrailingTightStrategy, SpotLag_TrailingWideStrategy, createSpotLagTrailing, createSpotLagTrailTight, createSpotLagTrailWide, ChainlinkDivergenceStrategy, ChainlinkDivergenceAggressiveStrategy, ChainlinkDivergenceConservativeStrategy, createCLDivergence, createCLDivergenceAggro, createCLDivergenceSafe, ChainlinkFinalSecondsStrategy, ChainlinkFinalSecondsUltraStrategy, createCLFinalSeconds, createCLFinalSecondsUltra, SpotLag_LateValueStrategy, SpotLag_DeepValueStrategy, SpotLag_CorrectSideOnlyStrategy, SpotLag_ExtremeReversalStrategy, SpotLag_TP3_TrailingStrategy, createSpotLagLateValue, createSpotLagDeepValue, createSpotLagCorrectSide, createSpotLagExtremeReversal, createSpotLagTP3Trailing, SpotLag_TimeAwareStrategy, SpotLag_TimeAwareAggressiveStrategy, SpotLag_TimeAwareConservativeStrategy, SpotLag_TimeAwareTPStrategy, SpotLag_LateWindowOnlyStrategy, SpotLag_ProbabilityEdgeStrategy, createSpotLagTimeAware, createSpotLagTimeAwareAggro, createSpotLagTimeAwareSafe, createSpotLagTimeAwareTP, createSpotLagLateOnly, createSpotLagProbEdge, SpotLag_TrailStrategy, SpotLag_Trail_V1Strategy, SpotLag_Trail_V2Strategy, SpotLag_Trail_V3Strategy, SpotLag_Trail_V4Strategy, SpotLag_Trail_V5Strategy, createSpotLagTrailV1, createSpotLagTrailV2, createSpotLagTrailV3, createSpotLagTrailV4, createSpotLagTrailV5, MicroLag_ConvergenceStrategy, MicroLag_ConvergenceAggroStrategy, MicroLag_ConvergenceSafeStrategy, createMicroLagConvergence, createMicroLagConvergenceAggro, createMicroLagConvergenceSafe } from './spot_lag_simple.js';

// Import for factory
import { FairValueStrategy, createFairValueRealizedVol, createFairValueEWMA, createFairValueWithDrift, createFairValueDrift1H, createFairValueDrift4H, createFairValueDrift24H, createFairValueUpOnly4H } from './fair_value_strategy.js';
import { SpotLagStrategy, createSpotLag1s, createSpotLag5s, createSpotLag10s } from './spot_lag_strategy.js';
import { TimeConditionalStrategy } from './time_conditional_strategy.js';
import { RegimeStrategy } from './regime_strategy.js';
import { MicrostructureStrategy } from './microstructure_strategy.js';
import { CrossAssetStrategy } from './cross_asset_strategy.js';
import { createContrarianBase, createContrarianSOL, createContrarianScalp, createContrarianStrong } from './contrarian_strategy.js';
import { createEndgameBase, createEndgameConservative, createEndgameAggressive, createEndgameSafe, createEndgameMomentum } from './endgame_strategy.js';
import { createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive, createSpotLag5Sec, createSpotLag10Sec, createSpotLag30Sec, createSpotLag60Sec, createSpotLag120Sec, createSpotLag300Sec, createMispricingOnly, createMispricingStrict, createMispricingLoose, createMispricingExtreme, createSpotLagCLConfirmed, createSpotLagAggressiveCL, createMispricingCLConfirmed, createUpOnlyCLConfirmed, createSpotLagVolAdapt, createSpotLagTrailing, createSpotLagTrailTight, createSpotLagTrailWide, createCLDivergence, createCLDivergenceAggro, createCLDivergenceSafe, createCLFinalSeconds, createCLFinalSecondsUltra, createSpotLagLateValue, createSpotLagDeepValue, createSpotLagCorrectSide, createSpotLagExtremeReversal, createSpotLagTP3Trailing, createSpotLagTimeAware, createSpotLagTimeAwareAggro, createSpotLagTimeAwareSafe, createSpotLagTimeAwareTP, createSpotLagLateOnly, createSpotLagProbEdge, createSpotLagTrailV1, createSpotLagTrailV2, createSpotLagTrailV3, createSpotLagTrailV4, createSpotLagTrailV5, createMicroLagConvergence, createMicroLagConvergenceAggro, createMicroLagConvergenceSafe } from './spot_lag_simple.js';

/**
 * Create all quant strategies
 * Returns array of strategy instances ready to run
 */
export function createAllQuantStrategies(capital = 100) {
    return [
        // ═══════════════════════════════════════════════════════════════════════
        // FAIR VALUE STRATEGIES - DISABLED (Jan 2026 analysis shows they LOSE money)
        // Market already prices time-to-expiry correctly, no edge in fair value deviation
        // Total loss: -$6,766 across all FairValue variants
        // ═══════════════════════════════════════════════════════════════════════
        // createFairValueRealizedVol(capital),  // DISABLED: -$2,724 loss
        // createFairValueEWMA(capital),         // DISABLED: -$3,068 loss
        // createFairValueWithDrift(capital),    // DISABLED: -$974 loss
        // createFairValueDrift1H(capital),      // DISABLED
        // createFairValueDrift4H(capital),      // DISABLED
        // createFairValueDrift24H(capital),     // DISABLED
        // createFairValueUpOnly4H(capital),     // DISABLED

        // ═══════════════════════════════════════════════════════════════════════
        // TIME-AWARE SPOTLAG STRATEGIES (v2) - NEW!
        // Based on fair value analysis: market prices time correctly, edge is in SPEED
        // These combine lag detection with time-to-expiry awareness
        // ═══════════════════════════════════════════════════════════════════════
        createSpotLagTimeAware(capital),       // Base: time-aware entry rules
        createSpotLagTimeAwareAggro(capital),  // Aggressive: lower thresholds, more trades
        createSpotLagTimeAwareSafe(capital),   // Conservative: higher thresholds, fewer trades
        createSpotLagTimeAwareTP(capital),     // With 5% take-profit
        createSpotLagLateOnly(capital),        // Only trade in final 2-5 minutes
        createSpotLagProbEdge(capital),        // Entry based on probability edge vs expected

        // ═══════════════════════════════════════════════════════════════════════
        // SPOTLAG TRAIL STRATEGIES V1-V5 (Jan 2026 - Simplified)
        // Proven micro-lag detection + trailing stops + liquidity guards
        // NO expected profit gate - simple momentum following
        // 5 variants with different aggression levels, all trade independently
        // ═══════════════════════════════════════════════════════════════════════
        createSpotLagTrailV1(capital),  // Ultra Conservative: 0.04% threshold, strict
        createSpotLagTrailV2(capital),  // Conservative: 0.03% threshold
        createSpotLagTrailV3(capital),  // Base/Moderate: 0.02% threshold (proven)
        createSpotLagTrailV4(capital),  // Aggressive: 0.015% threshold
        createSpotLagTrailV5(capital),  // Ultra Aggressive: 0.01% threshold

        // ═══════════════════════════════════════════════════════════════════════
        // PROVEN WINNERS - SpotLag strategies with positive PnL
        // ═══════════════════════════════════════════════════════════════════════
        createSpotLagAggressive(capital),  // +$4,735 (top performer)
        createSpotLagFast(capital),        // +$3,678
        createSpotLagSimple(capital),      // +$2,276
        createSpotLagConfirmed(capital),   // +$1,042

        // Take profit variants (TP3/TP6 removed - trailing stop added to TimeAware/ProbEdge instead)
        createSpotLagVolAdapt(capital),    // Dynamic TP based on volatility

        // Trailing stop variants
        createSpotLagTrailing(capital),
        createSpotLagTrailTight(capital),
        createSpotLagTrailWide(capital),

        // Mispricing strategies (based on actual data)
        createMispricingOnly(capital),
        createMispricingStrict(capital),
        createMispricingLoose(capital),    // +$1,707

        // Data-driven strategies (Jan 2026)
        createSpotLagLateValue(capital),   // +$1,337
        createSpotLagDeepValue(capital),   // +$873
        createSpotLagCorrectSide(capital),
        createSpotLagExtremeReversal(capital),
        createSpotLagTP3Trailing(capital),

        // ═══════════════════════════════════════════════════════════════════════
        // CHAINLINK STRATEGIES
        // ═══════════════════════════════════════════════════════════════════════
        createSpotLagCLConfirmed(capital),
        createSpotLagAggressiveCL(capital),
        createMispricingCLConfirmed(capital),
        createUpOnlyCLConfirmed(capital),
        createCLDivergence(capital),
        createCLDivergenceAggro(capital),
        createCLDivergenceSafe(capital),
        createCLFinalSeconds(capital),
        createCLFinalSecondsUltra(capital),

        // ═══════════════════════════════════════════════════════════════════════
        // ENDGAME STRATEGIES (final seconds plays)
        // ═══════════════════════════════════════════════════════════════════════
        createEndgameBase(capital),
        createEndgameConservative(capital),
        createEndgameAggressive(capital),
        createEndgameSafe(capital),
        createEndgameMomentum(capital),

        // ═══════════════════════════════════════════════════════════════════════
        // OTHER STRATEGIES - keep for comparison but lower priority
        // ═══════════════════════════════════════════════════════════════════════
        createContrarianBase(capital),
        createContrarianSOL(capital),
        createContrarianScalp(capital),
        createContrarianStrong(capital),

        new TimeConditionalStrategy({ maxPosition: capital }),
        new MicrostructureStrategy({ maxPosition: capital }),
        new CrossAssetStrategy({ maxPosition: capital }),
        new RegimeStrategy({ maxPosition: capital })
    ];
}

/**
 * Create a subset of strategies by category
 */
export function createStrategiesByCategory(categories, capital = 100) {
    const categoryMap = {
        'fairvalue': [
            createFairValueRealizedVol(capital),
            createFairValueEWMA(capital),
            createFairValueWithDrift(capital)
        ],
        'spotlag': [
            createSpotLag1s(capital),
            createSpotLag5s(capital),
            createSpotLag10s(capital)
        ],
        'time': [
            new TimeConditionalStrategy({ maxPosition: capital })
        ],
        'regime': [
            new RegimeStrategy({ maxPosition: capital })
        ],
        'microstructure': [
            new MicrostructureStrategy({ maxPosition: capital })
        ],
        'crossasset': [
            new CrossAssetStrategy({ maxPosition: capital })
        ]
    };
    
    const strategies = [];
    for (const category of categories) {
        const cat = category.toLowerCase();
        if (categoryMap[cat]) {
            strategies.push(...categoryMap[cat]);
        }
    }
    
    return strategies;
}

/**
 * Get strategy by name
 */
export function getStrategy(name, capital = 100) {
    const strategies = {
        'FairValue': () => new FairValueStrategy({ maxPosition: capital }),
        'FairValue_RealizedVol': () => createFairValueRealizedVol(capital),
        'FairValue_EWMA': () => createFairValueEWMA(capital),
        'FairValue_WithDrift': () => createFairValueWithDrift(capital),
        'SpotLag': () => new SpotLagStrategy({ maxPosition: capital }),
        'SpotLag_1s': () => createSpotLag1s(capital),
        'SpotLag_5s': () => createSpotLag5s(capital),
        'SpotLag_10s': () => createSpotLag10s(capital),
        'TimeConditional': () => new TimeConditionalStrategy({ maxPosition: capital }),
        'Regime': () => new RegimeStrategy({ maxPosition: capital }),
        'Microstructure': () => new MicrostructureStrategy({ maxPosition: capital }),
        'CrossAsset': () => new CrossAssetStrategy({ maxPosition: capital })
    };
    
    const factory = strategies[name];
    return factory ? factory() : null;
}

/**
 * List all available strategies
 */
export const QUANT_STRATEGY_LIST = [
    // Fair Value
    { name: 'FairValue_RealizedVol', category: 'fairvalue', description: 'Trade deviations from BS fair value using realized volatility' },
    { name: 'FairValue_EWMA', category: 'fairvalue', description: 'Trade deviations from BS fair value using EWMA volatility' },
    { name: 'FairValue_WithDrift', category: 'fairvalue', description: 'Trade deviations incorporating momentum drift' },
    
    // Spot Lag (following spot)
    { name: 'SpotLag_1s', category: 'spotlag', description: 'Fast reaction to spot moves (1s lookback)' },
    { name: 'SpotLag_5s', category: 'spotlag', description: 'Medium reaction to spot moves (5s lookback)' },
    { name: 'SpotLag_10s', category: 'spotlag', description: 'Slower confirmed spot moves (10s lookback)' },
    
    // Contrarian (FADING spot - backtest shows 55-63% edge!)
    { name: 'Contrarian', category: 'contrarian', description: 'FADE spot moves - bet opposite to short-term spot direction' },
    { name: 'Contrarian_SOL', category: 'contrarian', description: 'SOL-only contrarian (63% accuracy in backtest)' },
    { name: 'Contrarian_Scalp', category: 'contrarian', description: 'Quick scalp contrarian, lower threshold' },
    { name: 'Contrarian_Strong', category: 'contrarian', description: 'Only fade large spot moves' },
    
    // Endgame (buy near-certain outcomes in final seconds)
    { name: 'Endgame', category: 'endgame', description: 'Buy >90% favorites in last 60 seconds' },
    { name: 'Endgame_Conservative', category: 'endgame', description: 'Buy >95% favorites in last 30 seconds (safer)' },
    { name: 'Endgame_Aggressive', category: 'endgame', description: 'Buy >85% favorites in last 90 seconds (riskier)' },
    { name: 'Endgame_Safe', category: 'endgame', description: 'Buy >97% favorites in last 20 seconds (very safe)' },
    { name: 'Endgame_Momentum', category: 'endgame', description: 'Buy >90% favorites with momentum confirmation' },
    
    // Time Conditional
    { name: 'TimeConditional', category: 'time', description: 'Different behavior by window phase' },
    
    // Regime
    { name: 'Regime', category: 'regime', description: 'Adapt strategy to market regime' },
    
    // Microstructure
    { name: 'Microstructure', category: 'microstructure', description: 'Order flow and spread signals' },
    
    // Cross Asset
    { name: 'CrossAsset', category: 'crossasset', description: 'BTC leads alt coins' }
];

export default {
    createAllQuantStrategies,
    createStrategiesByCategory,
    getStrategy,
    QUANT_STRATEGY_LIST
};
