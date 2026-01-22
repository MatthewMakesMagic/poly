/**
 * Fair Value Probability Calculator
 * 
 * Calculates theoretical fair probability for binary options using
 * geometric Brownian motion (Black-Scholes framework).
 * 
 * For a 15-minute window:
 * - UP wins if spot_price(T) >= price_to_beat
 * - P(UP) = Φ(d) where d = (ln(S/K) + (μ - σ²/2)t) / (σ√t)
 * 
 * This gives us a baseline to measure market efficiency against.
 */

/**
 * Standard normal cumulative distribution function
 * Uses Abramowitz and Stegun approximation (accurate to 1e-7)
 */
function normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

    return 0.5 * (1.0 + sign * y);
}

/**
 * Inverse normal CDF (for implied volatility calculation)
 * Rational approximation by Peter J. Acklam
 */
function normalInvCDF(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;

    const a = [
        -3.969683028665376e+01,
         2.209460984245205e+02,
        -2.759285104469687e+02,
         1.383577518672690e+02,
        -3.066479806614716e+01,
         2.506628277459239e+00
    ];
    const b = [
        -5.447609879822406e+01,
         1.615858368580409e+02,
        -1.556989798598866e+02,
         6.680131188771972e+01,
        -1.328068155288572e+01
    ];
    const c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e+00,
        -2.549732539343734e+00,
         4.374664141464968e+00,
         2.938163982698783e+00
    ];
    const d = [
         7.784695709041462e-03,
         3.224671290700398e-01,
         2.445134137142996e+00,
         3.754408661907416e+00
    ];

    const pLow = 0.02425;
    const pHigh = 1 - pLow;

    let q, r;

    if (p < pLow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    } else if (p <= pHigh) {
        q = p - 0.5;
        r = q * q;
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
               (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
    } else {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
}

/**
 * Calculate fair probability that spot will be >= price_to_beat at expiry
 * 
 * @param {number} spotPrice - Current spot price
 * @param {number} priceToBeat - Strike price (window start price)
 * @param {number} timeRemainingSec - Time until expiry in seconds
 * @param {number} volatility - Annualized volatility (e.g., 0.5 for 50%)
 * @param {number} drift - Annualized drift/mean return (default 0)
 * @returns {number} Probability between 0 and 1
 */
function fairProbabilityUp(spotPrice, priceToBeat, timeRemainingSec, volatility, drift = 0) {
    // Handle edge cases
    if (timeRemainingSec <= 0) {
        return spotPrice >= priceToBeat ? 1.0 : 0.0;
    }
    if (spotPrice <= 0 || priceToBeat <= 0) {
        return 0.5;
    }
    if (volatility <= 0) {
        // No volatility - outcome is deterministic based on drift
        return spotPrice >= priceToBeat ? 1.0 : 0.0;
    }

    // Convert time to years (annualized)
    const t = timeRemainingSec / (365 * 24 * 3600);
    
    // Calculate d using Black-Scholes formula
    // d = (ln(S/K) + (μ - σ²/2)t) / (σ√t)
    const logRatio = Math.log(spotPrice / priceToBeat);
    const driftTerm = (drift - 0.5 * volatility * volatility) * t;
    const denominator = volatility * Math.sqrt(t);
    
    const d = (logRatio + driftTerm) / denominator;
    
    return normalCDF(d);
}

/**
 * Calculate implied volatility from market price
 * Uses Newton-Raphson iteration
 * 
 * @param {number} marketProb - Market's implied probability (up_mid)
 * @param {number} spotPrice - Current spot price
 * @param {number} priceToBeat - Strike price
 * @param {number} timeRemainingSec - Time until expiry
 * @param {number} drift - Assumed drift (default 0)
 * @returns {number} Implied annualized volatility
 */
function impliedVolatility(marketProb, spotPrice, priceToBeat, timeRemainingSec, drift = 0) {
    // Handle edge cases
    if (timeRemainingSec <= 0 || marketProb <= 0.01 || marketProb >= 0.99) {
        return null;
    }
    
    const t = timeRemainingSec / (365 * 24 * 3600);
    const logRatio = Math.log(spotPrice / priceToBeat);
    
    // Initial guess based on typical crypto vol
    let sigma = 0.8; // 80% annualized
    
    // Newton-Raphson iteration
    for (let i = 0; i < 50; i++) {
        const prob = fairProbabilityUp(spotPrice, priceToBeat, timeRemainingSec, sigma, drift);
        const error = prob - marketProb;
        
        if (Math.abs(error) < 1e-6) {
            return sigma;
        }
        
        // Calculate vega (derivative of price with respect to vol)
        // For binary option: vega = φ(d) * (ln(S/K) + (μ - σ²/2)t) / (σ² * √t)
        const d = (logRatio + (drift - 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
        const phi = Math.exp(-0.5 * d * d) / Math.sqrt(2 * Math.PI);
        const vega = phi * Math.sqrt(t) / sigma;
        
        if (Math.abs(vega) < 1e-10) {
            break;
        }
        
        // Update sigma
        sigma = sigma - error / vega;
        
        // Keep sigma in reasonable bounds
        sigma = Math.max(0.01, Math.min(10, sigma));
    }
    
    return sigma;
}

/**
 * Calculate the edge (alpha) between market price and fair value
 * 
 * @param {number} marketProb - Market's probability (up_mid)
 * @param {number} fairProb - Calculated fair probability
 * @returns {object} Edge analysis
 */
function calculateEdge(marketProb, fairProb) {
    const edge = fairProb - marketProb;
    const edgePct = edge * 100;
    
    // Determine trade direction
    let signal = 'HOLD';
    let side = null;
    let confidence = 0;
    
    if (edge > 0.03) {
        // Market underpricing UP
        signal = 'BUY';
        side = 'up';
        confidence = Math.min(1, edge / 0.1);
    } else if (edge < -0.03) {
        // Market overpricing UP (underpricing DOWN)
        signal = 'BUY';
        side = 'down';
        confidence = Math.min(1, -edge / 0.1);
    }
    
    return {
        edge,
        edgePct,
        signal,
        side,
        confidence,
        marketProb,
        fairProb,
        isSignificant: Math.abs(edge) > 0.03
    };
}

/**
 * Main FairValueCalculator class
 * Maintains state and provides comprehensive analysis
 */
export class FairValueCalculator {
    constructor(options = {}) {
        this.options = {
            defaultDrift: 0,
            edgeThreshold: 0.03,  // 3% edge to trigger signal
            ...options
        };
        
        // State per crypto
        this.state = {};
    }
    
    /**
     * Initialize state for a crypto
     */
    initCrypto(crypto) {
        if (!this.state[crypto]) {
            this.state[crypto] = {
                recentEdges: [],
                impliedVols: [],
                fairProbs: [],
                marketProbs: [],
                timestamps: []
            };
        }
        return this.state[crypto];
    }
    
    /**
     * Full fair value analysis for a tick
     */
    analyze(tick, realizedVol) {
        const crypto = tick.crypto;
        const state = this.initCrypto(crypto);
        
        const spotPrice = tick.spot_price;
        const priceToBeat = tick.price_to_beat || spotPrice;
        const timeRemaining = tick.time_remaining_sec || 0;
        const marketProb = tick.up_mid || 0.5;
        
        // Calculate fair probability
        const fairProb = fairProbabilityUp(
            spotPrice, 
            priceToBeat, 
            timeRemaining, 
            realizedVol,
            this.options.defaultDrift
        );
        
        // Calculate implied volatility
        const impliedVol = impliedVolatility(
            marketProb,
            spotPrice,
            priceToBeat,
            timeRemaining,
            this.options.defaultDrift
        );
        
        // Calculate edge
        const edgeAnalysis = calculateEdge(marketProb, fairProb);
        
        // Volatility spread (if we have implied vol)
        const volSpread = impliedVol !== null ? impliedVol - realizedVol : null;
        
        // Update state
        state.recentEdges.push(edgeAnalysis.edge);
        state.fairProbs.push(fairProb);
        state.marketProbs.push(marketProb);
        state.timestamps.push(Date.now());
        if (impliedVol !== null) {
            state.impliedVols.push(impliedVol);
        }
        
        // Keep limited history
        const maxHistory = 120;
        if (state.recentEdges.length > maxHistory) {
            state.recentEdges.shift();
            state.fairProbs.shift();
            state.marketProbs.shift();
            state.timestamps.shift();
        }
        if (state.impliedVols.length > maxHistory) {
            state.impliedVols.shift();
        }
        
        // Calculate rolling statistics
        const avgEdge = state.recentEdges.length > 0 
            ? state.recentEdges.reduce((a, b) => a + b, 0) / state.recentEdges.length 
            : 0;
        
        const avgImpliedVol = state.impliedVols.length > 0
            ? state.impliedVols.reduce((a, b) => a + b, 0) / state.impliedVols.length
            : null;
        
        return {
            crypto,
            timestamp: Date.now(),
            
            // Inputs
            spotPrice,
            priceToBeat,
            timeRemainingSec: timeRemaining,
            marketProb,
            
            // Calculated values
            fairProb,
            realizedVol,
            impliedVol,
            volSpread,
            
            // Edge analysis
            ...edgeAnalysis,
            
            // Rolling stats
            avgEdge,
            avgImpliedVol,
            edgeStdDev: this.calculateStdDev(state.recentEdges),
            
            // Signal strength
            signalStrength: Math.abs(edgeAnalysis.edge) / this.options.edgeThreshold
        };
    }
    
    /**
     * Calculate standard deviation
     */
    calculateStdDev(arr) {
        if (arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const variance = arr.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / arr.length;
        return Math.sqrt(variance);
    }
    
    /**
     * Get current state summary
     */
    getSummary(crypto) {
        const state = this.state[crypto];
        if (!state || state.recentEdges.length === 0) {
            return null;
        }
        
        return {
            crypto,
            sampleCount: state.recentEdges.length,
            avgEdge: state.recentEdges.reduce((a, b) => a + b, 0) / state.recentEdges.length,
            edgeStdDev: this.calculateStdDev(state.recentEdges),
            avgImpliedVol: state.impliedVols.length > 0 
                ? state.impliedVols.reduce((a, b) => a + b, 0) / state.impliedVols.length 
                : null,
            lastFairProb: state.fairProbs[state.fairProbs.length - 1],
            lastMarketProb: state.marketProbs[state.marketProbs.length - 1]
        };
    }
}

// Export functions and class
export {
    normalCDF,
    normalInvCDF,
    fairProbabilityUp,
    impliedVolatility,
    calculateEdge
};

export default FairValueCalculator;
