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
export { SpotLagSimpleStrategy, SpotLagFastStrategy, SpotLagConfirmedStrategy, SpotLagAggressiveStrategy, createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive, createSpotLag5Sec, createSpotLag10Sec, createSpotLag30Sec, createSpotLag60Sec, createSpotLag120Sec, createSpotLag300Sec, MispricingOnlyStrategy, MispricingStrictStrategy, MispricingLooseStrategy, MispricingExtremeStrategy, createMispricingOnly, createMispricingStrict, createMispricingLoose, createMispricingExtreme, SpotLagChainlinkConfirmedStrategy, SpotLagAggressiveCLStrategy, MispricingChainlinkConfirmedStrategy, UpOnlyChainlinkStrategy, createSpotLagCLConfirmed, createSpotLagAggressiveCL, createMispricingCLConfirmed, createUpOnlyCLConfirmed, SpotLag_TakeProfit3Strategy, SpotLag_TakeProfit6Strategy, SpotLag_VolatilityAdaptiveStrategy, createSpotLagTP3, createSpotLagTP6, createSpotLagVolAdapt, SpotLag_TrailingStopStrategy, SpotLag_TrailingTightStrategy, SpotLag_TrailingWideStrategy, createSpotLagTrailing, createSpotLagTrailTight, createSpotLagTrailWide, ChainlinkDivergenceStrategy, ChainlinkDivergenceAggressiveStrategy, ChainlinkDivergenceConservativeStrategy, createCLDivergence, createCLDivergenceAggro, createCLDivergenceSafe, ChainlinkFinalSecondsStrategy, ChainlinkFinalSecondsUltraStrategy, createCLFinalSeconds, createCLFinalSecondsUltra, SpotLag_LateValueStrategy, SpotLag_DeepValueStrategy, SpotLag_CorrectSideOnlyStrategy, SpotLag_ExtremeReversalStrategy, createSpotLagLateValue, createSpotLagDeepValue, createSpotLagCorrectSide, createSpotLagExtremeReversal } from './spot_lag_simple.js';

// Import for factory
import { FairValueStrategy, createFairValueRealizedVol, createFairValueEWMA, createFairValueWithDrift, createFairValueDrift1H, createFairValueDrift4H, createFairValueDrift24H, createFairValueUpOnly4H } from './fair_value_strategy.js';
import { SpotLagStrategy, createSpotLag1s, createSpotLag5s, createSpotLag10s } from './spot_lag_strategy.js';
import { TimeConditionalStrategy } from './time_conditional_strategy.js';
import { RegimeStrategy } from './regime_strategy.js';
import { MicrostructureStrategy } from './microstructure_strategy.js';
import { CrossAssetStrategy } from './cross_asset_strategy.js';
import { createContrarianBase, createContrarianSOL, createContrarianScalp, createContrarianStrong } from './contrarian_strategy.js';
import { createEndgameBase, createEndgameConservative, createEndgameAggressive, createEndgameSafe, createEndgameMomentum } from './endgame_strategy.js';
import { createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive, createSpotLag5Sec, createSpotLag10Sec, createSpotLag30Sec, createSpotLag60Sec, createSpotLag120Sec, createSpotLag300Sec, createMispricingOnly, createMispricingStrict, createMispricingLoose, createMispricingExtreme, createSpotLagCLConfirmed, createSpotLagAggressiveCL, createMispricingCLConfirmed, createUpOnlyCLConfirmed, createSpotLagTP3, createSpotLagTP6, createSpotLagVolAdapt, createSpotLagTrailing, createSpotLagTrailTight, createSpotLagTrailWide, createCLDivergence, createCLDivergenceAggro, createCLDivergenceSafe, createCLFinalSeconds, createCLFinalSecondsUltra, createSpotLagLateValue, createSpotLagDeepValue, createSpotLagCorrectSide, createSpotLagExtremeReversal } from './spot_lag_simple.js';

/**
 * Create all quant strategies
 * Returns array of strategy instances ready to run
 */
export function createAllQuantStrategies(capital = 100) {
    return [
        // Fair Value variants - ORIGINAL (assume drift=0)
        createFairValueRealizedVol(capital),
        createFairValueEWMA(capital),
        createFairValueWithDrift(capital),
        
        // Fair Value - DRIFT-AWARE variants (measure actual drift, use in Black-Scholes)
        createFairValueDrift1H(capital),   // 1-hour drift lookback
        createFairValueDrift4H(capital),   // 4-hour drift lookback
        createFairValueDrift24H(capital),  // 24-hour drift lookback
        createFairValueUpOnly4H(capital),  // UP-only with 4H drift (based on UP > DOWN insight)
        
        // Spot Lag - OLD (uses fair value - may be wrong)
        // createSpotLag1s(capital),
        // createSpotLag5s(capital),
        // createSpotLag10s(capital),
        
        // Spot Lag - NEW SIMPLE (just detect spot move, check if market lagged)
        createSpotLagSimple(capital),     // Base: hold to expiry
        createSpotLagFast(capital),       // Fast: hold to expiry
        createSpotLagConfirmed(capital),  // Confirmed: hold to expiry
        createSpotLagAggressive(capital), // Aggressive: hold to expiry
        
        // Spot Lag - TAKE PROFIT variants (exit early when price moves in our favor)
        // Backtest shows: 3% TP improves P&L by ~32% vs hold-to-expiry
        // At cheap prices (7c), we get more shares, so big moves = massive profits
        createSpotLagTP3(capital),        // 3% take-profit threshold
        createSpotLagTP6(capital),        // 6% take-profit threshold
        
        // Spot Lag - VOLATILITY ADAPTIVE take-profit
        // Backtest: HIGH vol (>8%) = 100% hit rate on 15% TP → use 12% TP
        //           MED vol (4-8%) = 84% hit rate on 15% TP → use 6% TP
        //           LOW vol (<4%) = only 51% hit 3% → hold to expiry (no TP)
        createSpotLagVolAdapt(capital),   // Dynamic TP based on volatility regime
        
        // Spot Lag - TRAILING STOP variants (NEW!)
        // Lets winners run while protecting profits
        // Activates after initial gain, then trails high-water mark
        createSpotLagTrailing(capital),    // Standard: 5% activation, 10% trail, 3% floor
        createSpotLagTrailTight(capital),  // Tight: 3% activation, 5% trail, 2% floor
        createSpotLagTrailWide(capital),   // Wide: 8% activation, 15% trail, 5% floor
        
        // Spot Lag - TIMED EXIT variants - DISABLED (data shows they destroy alpha)
        // These exit early before binary resolution, losing 96%+ of the time
        // SpotLag thesis requires holding to expiry for $1/$0 payout
        // createSpotLag5Sec(capital),       // DISABLED: 1.6% win rate
        // createSpotLag10Sec(capital),      // DISABLED: 3.3% win rate
        // createSpotLag30Sec(capital),      // DISABLED: 3.3% win rate
        // createSpotLag60Sec(capital),      // DISABLED: 6.8% win rate
        // createSpotLag120Sec(capital),     // DISABLED: 7.0% win rate
        // createSpotLag300Sec(capital),     // Keep commented - 26% win rate but still negative
        
        // MISPRICING-ONLY strategies (based on our learning: edge is from mispricing, not lag)
        createMispricingOnly(capital),    // Base: spot 0.1% off, market >10% wrong
        createMispricingStrict(capital),  // Strict: only big mispricings (>15% wrong)
        createMispricingLoose(capital),   // Loose: smaller mispricings too
        createMispricingExtreme(capital), // Extreme: only massive mispricings (>25% wrong)
        
        // CHAINLINK-CONFIRMED strategies - ONLY bet when Binance AND Chainlink agree
        // Data shows: 58% win when sources agree, 0% win when they disagree
        createSpotLagCLConfirmed(capital),    // SpotLag but only when both sources agree
        createSpotLagAggressiveCL(capital),   // Aggressive SpotLag with Chainlink confirmation
        createMispricingCLConfirmed(capital), // Mispricing only when sources agree
        createUpOnlyCLConfirmed(capital),     // UP-only when both Binance & Chainlink show UP
        
        // CHAINLINK DIVERGENCE strategies - bet on Chainlink when it disagrees with Binance
        // Thesis: Polymarket resolves using Chainlink, not Binance!
        // When Binance shows UP but Chainlink shows DOWN → bet DOWN (Chainlink wins)
        createCLDivergence(capital),          // Base: 0.1% divergence, 0.05% margin
        createCLDivergenceAggro(capital),     // Aggressive: lower thresholds
        createCLDivergenceSafe(capital),      // Conservative: higher confidence
        
        // CHAINLINK FINAL SECONDS strategies - the "frozen Chainlink" edge
        // In final 10-30 seconds, Chainlink is essentially LOCKED (heartbeat ~60s, deviation ~0.5%)
        // If Chainlink shows DOWN but market shows UP at 99¢ (DOWN at 1¢):
        // - $1 at 1¢ = 100 shares → $100 payout = 100x return
        createCLFinalSeconds(capital),        // Final 30s, max entry 15¢
        createCLFinalSecondsUltra(capital),   // Final 15s, max entry 10¢ (highest leverage)
        
        // NEW DATA-DRIVEN STRATEGIES (Jan 2026 analysis)
        // Based on live trading analysis: what conditions actually work?
        createSpotLagLateValue(capital),      // Late (60-180s) + cheap (<50c) + strong lag
        createSpotLagDeepValue(capital),      // Very cheap (<30c) + conviction play
        createSpotLagCorrectSide(capital),    // Only enter when spot already on correct side + blocks deadzone
        createSpotLagExtremeReversal(capital), // Extreme zone (<25c/>75c) + large contrary move + trailing stop
        
        // CONTRARIAN variants (FADE spot - backtest shows edge!)
        createContrarianBase(capital),      // All cryptos, moderate threshold
        createContrarianSOL(capital),       // SOL only (63% accuracy in backtest)
        createContrarianScalp(capital),     // Quick scalp, lower threshold
        createContrarianStrong(capital),    // Only big moves
        
        // ENDGAME variants (buy near-certain outcomes in final seconds)
        createEndgameBase(capital),         // 90%+ prob, last 60s
        createEndgameConservative(capital), // 95%+ prob, last 30s (safer)
        createEndgameAggressive(capital),   // 85%+ prob, last 90s (riskier)
        createEndgameSafe(capital),         // 97%+ prob, last 20s (very safe)
        createEndgameMomentum(capital),     // 90%+ prob with momentum confirmation
        
        // Time Conditional
        new TimeConditionalStrategy({ maxPosition: capital }),
        
        // Regime (was broken, now fixed to hold)
        new RegimeStrategy({ maxPosition: capital }),
        
        // Microstructure
        new MicrostructureStrategy({ maxPosition: capital }),
        
        // Cross Asset
        new CrossAssetStrategy({ maxPosition: capital })
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
