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
export { FairValueStrategy, createFairValueRealizedVol, createFairValueEWMA, createFairValueWithDrift } from './fair_value_strategy.js';
export { SpotLagStrategy, createSpotLag1s, createSpotLag5s, createSpotLag10s } from './spot_lag_strategy.js';
export { TimeConditionalStrategy } from './time_conditional_strategy.js';
export { RegimeStrategy } from './regime_strategy.js';
export { MicrostructureStrategy } from './microstructure_strategy.js';
export { CrossAssetStrategy } from './cross_asset_strategy.js';
export { ContrarianStrategy, ContrarianSOLStrategy, ContrarianScalpStrategy, ContrarianStrongStrategy, createContrarianBase, createContrarianSOL, createContrarianScalp, createContrarianStrong } from './contrarian_strategy.js';
export { EndgameStrategy, EndgameConservativeStrategy, EndgameAggressiveStrategy, EndgameSafeStrategy, EndgameMomentumStrategy, createEndgameBase, createEndgameConservative, createEndgameAggressive, createEndgameSafe, createEndgameMomentum } from './endgame_strategy.js';
export { SpotLagSimpleStrategy, SpotLagFastStrategy, SpotLagConfirmedStrategy, SpotLagAggressiveStrategy, createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive } from './spot_lag_simple.js';

// Import for factory
import { FairValueStrategy, createFairValueRealizedVol, createFairValueEWMA, createFairValueWithDrift } from './fair_value_strategy.js';
import { SpotLagStrategy, createSpotLag1s, createSpotLag5s, createSpotLag10s } from './spot_lag_strategy.js';
import { TimeConditionalStrategy } from './time_conditional_strategy.js';
import { RegimeStrategy } from './regime_strategy.js';
import { MicrostructureStrategy } from './microstructure_strategy.js';
import { CrossAssetStrategy } from './cross_asset_strategy.js';
import { createContrarianBase, createContrarianSOL, createContrarianScalp, createContrarianStrong } from './contrarian_strategy.js';
import { createEndgameBase, createEndgameConservative, createEndgameAggressive, createEndgameSafe, createEndgameMomentum } from './endgame_strategy.js';
import { createSpotLagSimple, createSpotLagFast, createSpotLagConfirmed, createSpotLagAggressive } from './spot_lag_simple.js';

/**
 * Create all quant strategies
 * Returns array of strategy instances ready to run
 */
export function createAllQuantStrategies(capital = 100) {
    return [
        // Fair Value variants (model may be wrong - keep for comparison)
        createFairValueRealizedVol(capital),
        createFairValueEWMA(capital),
        createFairValueWithDrift(capital),
        
        // Spot Lag - OLD (uses fair value - may be wrong)
        // createSpotLag1s(capital),
        // createSpotLag5s(capital),
        // createSpotLag10s(capital),
        
        // Spot Lag - NEW SIMPLE (just detect spot move, check if market lagged)
        createSpotLagSimple(capital),     // Base: 0.05% spot move, 10 tick lookback
        createSpotLagFast(capital),       // Fast: 0.03% spot move, 5 tick lookback
        createSpotLagConfirmed(capital),  // Confirmed: 0.1% spot move, 15 tick lookback
        createSpotLagAggressive(capital), // Aggressive: 0.02% spot move, more trades
        
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
