/**
 * Statistical Metrics Module
 * 
 * Core statistical calculations for market analysis
 */

import * as ss from 'simple-statistics';

/**
 * Calculate returns from price series
 */
export function calculateReturns(prices) {
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1] !== 0) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
    }
    return returns;
}

/**
 * Calculate log returns
 */
export function calculateLogReturns(prices) {
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1] > 0 && prices[i] > 0) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }
    }
    return returns;
}

/**
 * Calculate autocorrelation at lag k
 */
export function autocorrelation(data, lag = 1) {
    if (data.length <= lag) return 0;
    
    const mean = ss.mean(data);
    const variance = ss.variance(data);
    
    if (variance === 0) return 0;
    
    let sum = 0;
    for (let i = lag; i < data.length; i++) {
        sum += (data[i] - mean) * (data[i - lag] - mean);
    }
    
    return sum / ((data.length - lag) * variance);
}

/**
 * Calculate autocorrelation for multiple lags
 */
export function autocorrelationSeries(data, maxLag = 10) {
    const acf = [];
    for (let lag = 1; lag <= maxLag; lag++) {
        acf.push({
            lag,
            value: autocorrelation(data, lag)
        });
    }
    return acf;
}

/**
 * Calculate cross-correlation between two series
 */
export function crossCorrelation(x, y, lag = 0) {
    if (x.length !== y.length) {
        throw new Error('Series must have same length');
    }
    
    const n = x.length;
    if (n <= Math.abs(lag)) return 0;
    
    const xMean = ss.mean(x);
    const yMean = ss.mean(y);
    const xStd = ss.standardDeviation(x);
    const yStd = ss.standardDeviation(y);
    
    if (xStd === 0 || yStd === 0) return 0;
    
    let sum = 0;
    let count = 0;
    
    if (lag >= 0) {
        for (let i = lag; i < n; i++) {
            sum += (x[i - lag] - xMean) * (y[i] - yMean);
            count++;
        }
    } else {
        for (let i = -lag; i < n; i++) {
            sum += (x[i] - xMean) * (y[i + lag] - yMean);
            count++;
        }
    }
    
    return sum / (count * xStd * yStd);
}

/**
 * Calculate cross-correlation for multiple lags
 */
export function crossCorrelationSeries(x, y, maxLag = 10) {
    const ccf = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        ccf.push({
            lag,
            value: crossCorrelation(x, y, lag)
        });
    }
    return ccf;
}

/**
 * Calculate rolling mean
 */
export function rollingMean(data, window) {
    const result = [];
    for (let i = window - 1; i < data.length; i++) {
        const slice = data.slice(i - window + 1, i + 1);
        result.push(ss.mean(slice));
    }
    return result;
}

/**
 * Calculate rolling standard deviation
 */
export function rollingStd(data, window) {
    const result = [];
    for (let i = window - 1; i < data.length; i++) {
        const slice = data.slice(i - window + 1, i + 1);
        result.push(ss.standardDeviation(slice));
    }
    return result;
}

/**
 * Calculate exponential moving average
 */
export function ema(data, span) {
    const alpha = 2 / (span + 1);
    const result = [data[0]];
    
    for (let i = 1; i < data.length; i++) {
        result.push(alpha * data[i] + (1 - alpha) * result[i - 1]);
    }
    
    return result;
}

/**
 * Calculate volatility (annualized standard deviation of returns)
 */
export function volatility(prices, periodsPerYear = 35040) {
    // 35040 = 15-minute periods per year (4 * 24 * 365)
    const returns = calculateReturns(prices);
    if (returns.length === 0) return 0;
    
    return ss.standardDeviation(returns) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate Sharpe ratio
 */
export function sharpeRatio(returns, riskFreeRate = 0, periodsPerYear = 35040) {
    if (returns.length === 0) return 0;
    
    const meanReturn = ss.mean(returns);
    const stdReturn = ss.standardDeviation(returns);
    
    if (stdReturn === 0) return 0;
    
    const periodRiskFree = riskFreeRate / periodsPerYear;
    const excessReturn = meanReturn - periodRiskFree;
    
    return (excessReturn / stdReturn) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate Sortino ratio (downside risk)
 */
export function sortinoRatio(returns, riskFreeRate = 0, periodsPerYear = 35040) {
    if (returns.length === 0) return 0;
    
    const meanReturn = ss.mean(returns);
    const periodRiskFree = riskFreeRate / periodsPerYear;
    const excessReturn = meanReturn - periodRiskFree;
    
    // Calculate downside deviation
    const negativeReturns = returns.filter(r => r < 0);
    if (negativeReturns.length === 0) return Infinity;
    
    const downsideStd = Math.sqrt(
        negativeReturns.reduce((sum, r) => sum + r * r, 0) / returns.length
    );
    
    if (downsideStd === 0) return Infinity;
    
    return (excessReturn / downsideStd) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate maximum drawdown
 */
export function maxDrawdown(equity) {
    if (equity.length === 0) return { maxDrawdown: 0, maxDrawdownPct: 0 };
    
    let peak = equity[0];
    let maxDD = 0;
    let maxDDPct = 0;
    
    for (const value of equity) {
        if (value > peak) {
            peak = value;
        }
        
        const dd = peak - value;
        const ddPct = peak > 0 ? dd / peak : 0;
        
        if (dd > maxDD) {
            maxDD = dd;
            maxDDPct = ddPct;
        }
    }
    
    return { maxDrawdown: maxDD, maxDrawdownPct: maxDDPct };
}

/**
 * Calculate profit factor
 */
export function profitFactor(trades) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    
    if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
    
    return grossProfit / grossLoss;
}

/**
 * Calculate win rate
 */
export function winRate(trades) {
    if (trades.length === 0) return 0;
    
    const wins = trades.filter(t => t.pnl > 0).length;
    return wins / trades.length;
}

/**
 * Calculate average win and loss
 */
export function avgWinLoss(trades) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    
    const avgWin = wins.length > 0 ? ss.mean(wins.map(t => t.pnl)) : 0;
    const avgLoss = losses.length > 0 ? ss.mean(losses.map(t => t.pnl)) : 0;
    
    return { avgWin, avgLoss, avgTrade: ss.mean(trades.map(t => t.pnl)) };
}

/**
 * Calculate Z-score for a value
 */
export function zScore(value, mean, std) {
    if (std === 0) return 0;
    return (value - mean) / std;
}

/**
 * Calculate distribution statistics
 */
export function distributionStats(data) {
    if (data.length === 0) {
        return { mean: 0, std: 0, skewness: 0, kurtosis: 0, min: 0, max: 0 };
    }
    
    return {
        mean: ss.mean(data),
        std: ss.standardDeviation(data),
        skewness: ss.sampleSkewness(data),
        kurtosis: data.length > 3 ? ss.sampleKurtosis(data) : 0,
        min: ss.min(data),
        max: ss.max(data),
        median: ss.median(data),
        q1: ss.quantile(data, 0.25),
        q3: ss.quantile(data, 0.75)
    };
}

/**
 * Bin data into histogram
 */
export function histogram(data, bins = 20) {
    if (data.length === 0) return [];
    
    const min = ss.min(data);
    const max = ss.max(data);
    const binWidth = (max - min) / bins;
    
    const hist = Array(bins).fill(0).map((_, i) => ({
        binStart: min + i * binWidth,
        binEnd: min + (i + 1) * binWidth,
        count: 0
    }));
    
    for (const value of data) {
        const binIndex = Math.min(Math.floor((value - min) / binWidth), bins - 1);
        hist[binIndex].count++;
    }
    
    return hist;
}

export default {
    calculateReturns,
    calculateLogReturns,
    autocorrelation,
    autocorrelationSeries,
    crossCorrelation,
    crossCorrelationSeries,
    rollingMean,
    rollingStd,
    ema,
    volatility,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    profitFactor,
    winRate,
    avgWinLoss,
    zScore,
    distributionStats,
    histogram
};

