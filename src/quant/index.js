/**
 * Quant Module Index
 * 
 * Central export for all quantitative analysis components.
 */

// Core calculators
export { FairValueCalculator, fairProbabilityUp, impliedVolatility, normalCDF } from './fair_value.js';
export { VolatilityEstimator, realizedVolatility, ewmaVolatility, parkinsonVolatility } from './volatility.js';

// Analyzers
export { SpotLagAnalyzer, SpotMoveEvent } from './spot_lag_analyzer.js';
export { RegimeDetector } from './regime_detector.js';

// Research engine
export { ResearchEngine, getResearchEngine } from './research_engine.js';

// Strategies
export { 
    createAllQuantStrategies, 
    createStrategiesByCategory, 
    getStrategy,
    QUANT_STRATEGY_LIST,
    FairValueStrategy,
    SpotLagStrategy,
    TimeConditionalStrategy,
    RegimeStrategy,
    MicrostructureStrategy,
    CrossAssetStrategy
} from './strategies/index.js';

export default {
    FairValueCalculator,
    VolatilityEstimator,
    SpotLagAnalyzer,
    RegimeDetector,
    ResearchEngine,
    getResearchEngine,
    createAllQuantStrategies
};
