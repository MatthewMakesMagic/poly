/**
 * Strategy Index
 * 
 * Export all built-in strategies
 */

export { MeanReversionStrategy } from './mean_reversion.js';
export { MomentumStrategy } from './momentum.js';
export { ThresholdExitStrategy } from './threshold_exit.js';

// Strategy factory
export function createStrategy(name, params = {}) {
    switch (name.toLowerCase()) {
        case 'meanreversion':
        case 'mean_reversion':
            const { MeanReversionStrategy } = await import('./mean_reversion.js');
            return new MeanReversionStrategy(params);
            
        case 'momentum':
            const { MomentumStrategy } = await import('./momentum.js');
            return new MomentumStrategy(params);
            
        case 'thresholdexit':
        case 'threshold_exit':
        case 'threshold':
            const { ThresholdExitStrategy } = await import('./threshold_exit.js');
            return new ThresholdExitStrategy(params);
            
        default:
            throw new Error(`Unknown strategy: ${name}`);
    }
}

export default {
    MeanReversionStrategy,
    MomentumStrategy,
    ThresholdExitStrategy,
    createStrategy
};

