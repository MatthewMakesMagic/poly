/**
 * Hypothesis Testing Framework
 * 
 * Formal statistical tests for trading hypotheses
 */

import * as ss from 'simple-statistics';
import { getDatabase } from '../db/connection.js';
import { saveHypothesisResult } from '../db/queries.js';
import {
    calculateReturns,
    autocorrelation,
    autocorrelationSeries,
    crossCorrelation,
    crossCorrelationSeries,
    distributionStats
} from './metrics.js';

/**
 * Standard normal CDF (approximate)
 */
function normalCDF(z) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z) / Math.sqrt(2);
    
    const t = 1.0 / (1.0 + p * z);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    
    return 0.5 * (1.0 + sign * y);
}

/**
 * Chi-squared CDF (approximate for df > 0)
 */
function chiSquaredCDF(x, df) {
    if (x <= 0) return 0;
    
    // Use normal approximation for large df
    if (df > 100) {
        const z = Math.pow(x / df, 1/3) - (1 - 2/(9*df));
        const se = Math.sqrt(2/(9*df));
        return normalCDF(z / se);
    }
    
    // Simple approximation using incomplete gamma
    // This is a rough approximation - for production use a proper library
    const k = df / 2;
    const theta = 2;
    
    // Regularized incomplete gamma approximation
    let sum = 0;
    let term = 1 / k;
    sum = term;
    
    for (let i = 1; i < 100; i++) {
        term *= x / (2 * (k + i));
        sum += term;
        if (term < 1e-10) break;
    }
    
    return Math.min(1, sum * Math.exp(-x/2) * Math.pow(x/2, k) / gamma(k));
}

/**
 * Gamma function approximation (Stirling)
 */
function gamma(n) {
    if (n === 1) return 1;
    if (n === 0.5) return Math.sqrt(Math.PI);
    if (n < 0.5) return Math.PI / (Math.sin(Math.PI * n) * gamma(1 - n));
    
    n -= 1;
    const g = 7;
    const c = [
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7
    ];
    
    let x = c[0];
    for (let i = 1; i < g + 2; i++) {
        x += c[i] / (n + i);
    }
    
    const t = n + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, n + 0.5) * Math.exp(-t) * x;
}

/**
 * H1: Mean Reversion Test
 * 
 * Tests if price returns are negatively autocorrelated,
 * indicating mean reversion behavior.
 */
export async function testMeanReversion(crypto, options = {}) {
    const {
        maxLag = 5,
        significanceLevel = 0.05
    } = options;
    
    const db = getDatabase();
    
    // Get price data
    const ticks = db.prepare(`
        SELECT up_mid as price, timestamp_ms
        FROM ticks
        WHERE crypto = ? AND up_mid IS NOT NULL
        ORDER BY timestamp_ms ASC
    `).all(crypto);
    
    if (ticks.length < 100) {
        return {
            hypothesis: 'mean_reversion',
            crypto,
            error: 'Insufficient data (need 100+ ticks)',
            isSignificant: false
        };
    }
    
    const prices = ticks.map(t => t.price);
    const returns = calculateReturns(prices);
    
    // Calculate autocorrelations
    const acf = autocorrelationSeries(returns, maxLag);
    
    // Ljung-Box test statistic
    const n = returns.length;
    let Q = 0;
    for (let k = 1; k <= maxLag; k++) {
        const rho = autocorrelation(returns, k);
        Q += (rho * rho) / (n - k);
    }
    Q *= n * (n + 2);
    
    // P-value from chi-squared distribution
    const pValue = 1 - chiSquaredCDF(Q, maxLag);
    
    // Check if lag-1 autocorrelation is negative (mean reversion)
    const lag1Acf = acf.find(a => a.lag === 1)?.value || 0;
    const isMeanReverting = lag1Acf < 0;
    
    // Standard error for autocorrelation
    const se = 1 / Math.sqrt(n);
    const lag1ZScore = lag1Acf / se;
    const lag1PValue = 2 * (1 - normalCDF(Math.abs(lag1ZScore)));
    
    const result = {
        hypothesis: 'mean_reversion',
        crypto,
        test_method: 'ljung_box',
        sample_size: returns.length,
        period_start: new Date(ticks[0].timestamp_ms).toISOString(),
        period_end: new Date(ticks[ticks.length - 1].timestamp_ms).toISOString(),
        test_statistic: Q,
        p_value: pValue,
        is_significant: pValue < significanceLevel ? 1 : 0,
        effect_size: lag1Acf,
        confidence_interval_low: lag1Acf - 1.96 * se,
        confidence_interval_high: lag1Acf + 1.96 * se,
        conclusion: isMeanReverting && lag1PValue < significanceLevel
            ? 'SIGNIFICANT: Returns show mean reversion (negative autocorrelation)'
            : 'NOT SIGNIFICANT: No clear mean reversion pattern',
        parameters: JSON.stringify({
            maxLag,
            lag1_autocorrelation: lag1Acf,
            lag1_pvalue: lag1PValue,
            all_autocorrelations: acf
        })
    };
    
    // Save to database
    saveHypothesisResult(result);
    
    return result;
}

/**
 * H2: BTC Lead/Lag Test
 * 
 * Tests if BTC spot price movements predict Polymarket price movements
 */
export async function testBTCLeadLag(crypto, options = {}) {
    const {
        maxLag = 10,
        significanceLevel = 0.05
    } = options;
    
    const db = getDatabase();
    
    // Get aligned price data
    const ticks = db.prepare(`
        SELECT up_mid as market_price, spot_price, timestamp_ms
        FROM ticks
        WHERE crypto = ? 
          AND up_mid IS NOT NULL 
          AND spot_price IS NOT NULL
        ORDER BY timestamp_ms ASC
    `).all(crypto);
    
    if (ticks.length < 100) {
        return {
            hypothesis: 'btc_lead_lag',
            crypto,
            error: 'Insufficient data',
            isSignificant: false
        };
    }
    
    const marketPrices = ticks.map(t => t.market_price);
    const spotPrices = ticks.map(t => t.spot_price);
    
    const marketReturns = calculateReturns(marketPrices);
    const spotReturns = calculateReturns(spotPrices);
    
    // Ensure same length
    const minLen = Math.min(marketReturns.length, spotReturns.length);
    const mReturns = marketReturns.slice(0, minLen);
    const sReturns = spotReturns.slice(0, minLen);
    
    // Calculate cross-correlations
    const ccf = crossCorrelationSeries(sReturns, mReturns, maxLag);
    
    // Find max correlation and its lag
    let maxCorr = 0;
    let maxLagValue = 0;
    for (const { lag, value } of ccf) {
        if (Math.abs(value) > Math.abs(maxCorr)) {
            maxCorr = value;
            maxLagValue = lag;
        }
    }
    
    // Standard error
    const n = mReturns.length;
    const se = 1 / Math.sqrt(n);
    const zScore = maxCorr / se;
    const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));
    
    // Positive lag means spot leads market (potential speed edge)
    const hasSpeedEdge = maxLagValue > 0 && maxCorr > 0;
    
    const result = {
        hypothesis: 'btc_lead_lag',
        crypto,
        test_method: 'cross_correlation',
        sample_size: n,
        period_start: new Date(ticks[0].timestamp_ms).toISOString(),
        period_end: new Date(ticks[ticks.length - 1].timestamp_ms).toISOString(),
        test_statistic: zScore,
        p_value: pValue,
        is_significant: pValue < significanceLevel ? 1 : 0,
        effect_size: maxCorr,
        confidence_interval_low: maxCorr - 1.96 * se,
        confidence_interval_high: maxCorr + 1.96 * se,
        conclusion: hasSpeedEdge && pValue < significanceLevel
            ? `SIGNIFICANT: Spot leads market by ${maxLagValue} ticks (potential speed edge)`
            : 'NOT SIGNIFICANT: No clear lead/lag relationship',
        parameters: JSON.stringify({
            max_correlation: maxCorr,
            optimal_lag: maxLagValue,
            all_correlations: ccf.filter(c => Math.abs(c.lag) <= 5)
        })
    };
    
    saveHypothesisResult(result);
    
    return result;
}

/**
 * H3: Behavioral Clustering Test
 * 
 * Tests if prices cluster around round numbers (0.25, 0.50, 0.75)
 */
export async function testBehavioralClustering(crypto, options = {}) {
    const {
        roundNumbers = [0.25, 0.50, 0.75],
        tolerance = 0.02,
        significanceLevel = 0.05
    } = options;
    
    const db = getDatabase();
    
    const ticks = db.prepare(`
        SELECT up_mid as price
        FROM ticks
        WHERE crypto = ? AND up_mid IS NOT NULL
    `).all(crypto);
    
    if (ticks.length < 100) {
        return {
            hypothesis: 'behavioral_clustering',
            crypto,
            error: 'Insufficient data',
            isSignificant: false
        };
    }
    
    const prices = ticks.map(t => t.price);
    const n = prices.length;
    
    // Count observations near round numbers
    let observedNearRound = 0;
    for (const price of prices) {
        for (const round of roundNumbers) {
            if (Math.abs(price - round) <= tolerance) {
                observedNearRound++;
                break;
            }
        }
    }
    
    // Expected under uniform distribution
    const expectedPct = roundNumbers.length * tolerance * 2; // Each round ± tolerance
    const expectedNearRound = n * expectedPct;
    
    // Chi-squared test
    const chiSquared = Math.pow(observedNearRound - expectedNearRound, 2) / expectedNearRound +
                       Math.pow((n - observedNearRound) - (n - expectedNearRound), 2) / (n - expectedNearRound);
    
    const pValue = 1 - chiSquaredCDF(chiSquared, 1);
    
    const observedPct = observedNearRound / n;
    const hasClustering = observedPct > expectedPct * 1.5;
    
    const result = {
        hypothesis: 'behavioral_clustering',
        crypto,
        test_method: 'chi_squared',
        sample_size: n,
        period_start: null,
        period_end: null,
        test_statistic: chiSquared,
        p_value: pValue,
        is_significant: pValue < significanceLevel ? 1 : 0,
        effect_size: observedPct - expectedPct,
        confidence_interval_low: null,
        confidence_interval_high: null,
        conclusion: hasClustering && pValue < significanceLevel
            ? `SIGNIFICANT: Prices cluster at round numbers (${(observedPct * 100).toFixed(1)}% vs expected ${(expectedPct * 100).toFixed(1)}%)`
            : 'NOT SIGNIFICANT: No excessive clustering at round numbers',
        parameters: JSON.stringify({
            observed_near_round: observedNearRound,
            expected_near_round: expectedNearRound,
            observed_pct: observedPct,
            expected_pct: expectedPct,
            round_numbers: roundNumbers,
            tolerance
        })
    };
    
    saveHypothesisResult(result);
    
    return result;
}

/**
 * H4: Time-of-Window Effects Test
 * 
 * Tests if price behavior differs across early, mid, and late window periods
 */
export async function testTimeOfWindowEffects(crypto, options = {}) {
    const {
        significanceLevel = 0.05
    } = options;
    
    const db = getDatabase();
    
    const ticks = db.prepare(`
        SELECT up_mid as price, time_remaining_sec, window_epoch
        FROM ticks
        WHERE crypto = ? 
          AND up_mid IS NOT NULL 
          AND time_remaining_sec IS NOT NULL
        ORDER BY timestamp_ms ASC
    `).all(crypto);
    
    if (ticks.length < 300) {
        return {
            hypothesis: 'time_of_window_effects',
            crypto,
            error: 'Insufficient data',
            isSignificant: false
        };
    }
    
    // Segment by time remaining (early: >600s, mid: 300-600s, late: <300s)
    const early = [];
    const mid = [];
    const late = [];
    
    // Group by window and calculate returns within each segment
    const windowGroups = {};
    for (const tick of ticks) {
        if (!windowGroups[tick.window_epoch]) {
            windowGroups[tick.window_epoch] = [];
        }
        windowGroups[tick.window_epoch].push(tick);
    }
    
    for (const windowTicks of Object.values(windowGroups)) {
        if (windowTicks.length < 10) continue;
        
        for (let i = 1; i < windowTicks.length; i++) {
            const ret = (windowTicks[i].price - windowTicks[i-1].price) / windowTicks[i-1].price;
            const timeRemaining = windowTicks[i].time_remaining_sec;
            
            if (timeRemaining > 600) {
                early.push(ret);
            } else if (timeRemaining > 300) {
                mid.push(ret);
            } else {
                late.push(ret);
            }
        }
    }
    
    // Calculate statistics for each segment
    const earlyStats = distributionStats(early);
    const midStats = distributionStats(mid);
    const lateStats = distributionStats(late);
    
    // ANOVA-like comparison (simplified F-test)
    const allReturns = [...early, ...mid, ...late];
    const grandMean = ss.mean(allReturns);
    
    // Between-group variance
    const betweenSS = early.length * Math.pow(earlyStats.mean - grandMean, 2) +
                      mid.length * Math.pow(midStats.mean - grandMean, 2) +
                      late.length * Math.pow(lateStats.mean - grandMean, 2);
    
    // Within-group variance
    const withinSS = early.reduce((sum, r) => sum + Math.pow(r - earlyStats.mean, 2), 0) +
                     mid.reduce((sum, r) => sum + Math.pow(r - midStats.mean, 2), 0) +
                     late.reduce((sum, r) => sum + Math.pow(r - lateStats.mean, 2), 0);
    
    const k = 3; // number of groups
    const n = allReturns.length;
    
    const fStatistic = (betweenSS / (k - 1)) / (withinSS / (n - k));
    
    // Approximate p-value (F-distribution approximation)
    // For simplicity, use a threshold approach
    const criticalF = 3.0; // Approximate F(2, large) at α=0.05
    const pValue = fStatistic > criticalF ? 0.01 : 0.10; // Simplified
    
    // Check if volatility changes across periods
    const volDiff = Math.abs(lateStats.std - earlyStats.std) / earlyStats.std;
    
    const result = {
        hypothesis: 'time_of_window_effects',
        crypto,
        test_method: 'anova',
        sample_size: n,
        period_start: null,
        period_end: null,
        test_statistic: fStatistic,
        p_value: pValue,
        is_significant: pValue < significanceLevel ? 1 : 0,
        effect_size: volDiff,
        confidence_interval_low: null,
        confidence_interval_high: null,
        conclusion: pValue < significanceLevel
            ? `SIGNIFICANT: Price behavior differs across window periods (vol change: ${(volDiff * 100).toFixed(1)}%)`
            : 'NOT SIGNIFICANT: No clear time-of-window effects',
        parameters: JSON.stringify({
            early: { count: early.length, mean: earlyStats.mean, std: earlyStats.std },
            mid: { count: mid.length, mean: midStats.mean, std: midStats.std },
            late: { count: late.length, mean: lateStats.mean, std: lateStats.std },
            volatility_change_pct: volDiff * 100
        })
    };
    
    saveHypothesisResult(result);
    
    return result;
}

/**
 * Run all hypothesis tests for a crypto
 */
export async function runAllTests(crypto) {
    console.log(`\n📊 Running hypothesis tests for ${crypto.toUpperCase()}...\n`);
    
    const results = {};
    
    console.log('H1: Testing Mean Reversion...');
    results.meanReversion = await testMeanReversion(crypto);
    console.log(`   ${results.meanReversion.conclusion}`);
    
    console.log('H2: Testing BTC Lead/Lag...');
    results.btcLeadLag = await testBTCLeadLag(crypto);
    console.log(`   ${results.btcLeadLag.conclusion}`);
    
    console.log('H3: Testing Behavioral Clustering...');
    results.clustering = await testBehavioralClustering(crypto);
    console.log(`   ${results.clustering.conclusion}`);
    
    console.log('H4: Testing Time-of-Window Effects...');
    results.timeEffects = await testTimeOfWindowEffects(crypto);
    console.log(`   ${results.timeEffects.conclusion}`);
    
    console.log('\n✅ All tests complete');
    
    return results;
}

export default {
    testMeanReversion,
    testBTCLeadLag,
    testBehavioralClustering,
    testTimeOfWindowEffects,
    runAllTests
};

