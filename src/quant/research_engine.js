/**
 * Research Engine
 * 
 * Coordinates all quant analysis components and generates research reports.
 * 
 * Reports generated:
 * 1. Spot Lag Report - How quickly market prices spot movements
 * 2. Market Efficiency Report - Fair value deviations by crypto/time
 * 3. Strategy Performance Report - Comparative strategy analysis
 * 4. Regime Analysis Report - Market regime distribution
 */

import { FairValueCalculator } from './fair_value.js';
import { VolatilityEstimator } from './volatility.js';
import { SpotLagAnalyzer } from './spot_lag_analyzer.js';
import { RegimeDetector } from './regime_detector.js';
import { createAllQuantStrategies } from './strategies/index.js';
import { savePaperTrade } from '../db/connection.js';
import { getLiveTrader } from '../execution/live_trader.js';

/**
 * Main Research Engine
 */
export class ResearchEngine {
    constructor(options = {}) {
        this.options = {
            capitalPerTrade: 100,
            enablePaperTrading: true,
            ...options
        };
        
        // Core analyzers
        this.fairValueCalc = new FairValueCalculator();
        this.volEstimator = new VolatilityEstimator();
        this.spotLagAnalyzer = new SpotLagAnalyzer();
        this.regimeDetector = new RegimeDetector();
        
        // Strategies
        this.strategies = createAllQuantStrategies(this.options.capitalPerTrade);
        
        // Position tracking for paper trading
        this.positions = {};  // strategyName -> crypto -> position
        
        // Performance tracking - now with crypto-level breakdown
        this.strategyPerformance = {};
        const cryptos = ['btc', 'eth', 'sol', 'xrp'];
        for (const strategy of this.strategies) {
            const byCrypto = {};
            for (const crypto of cryptos) {
                byCrypto[crypto] = {
                    signals: 0,
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    totalPnl: 0
                };
            }
            this.strategyPerformance[strategy.getName()] = {
                signals: 0,
                trades: 0,
                wins: 0,
                losses: 0,
                totalPnl: 0,
                positions: [],
                byCrypto  // NEW: crypto-level breakdown
            };
        }
        
        // Market efficiency data
        this.efficiencyData = {
            byTimephase: { early: [], mid: [], late: [] },
            byCrypto: {},
            overall: []
        };
        
        // Stats
        this.stats = {
            ticksProcessed: 0,
            windowsAnalyzed: 0,
            startTime: Date.now()
        };
        
        // Current markets (for live trading - need tokenIds)
        this.currentMarkets = {};
        
        // Initialize live trader (if enabled)
        this.initLiveTrader();
    }
    
    /**
     * Initialize the live trader
     */
    async initLiveTrader() {
        try {
            const liveTrader = getLiveTrader();
            const initialized = await liveTrader.initialize();
            if (initialized) {
                console.log('[ResearchEngine] Live trader initialized and ready');
            }
        } catch (error) {
            // Live trading not configured - that's fine
            console.log('[ResearchEngine] Live trading not enabled:', error.message);
        }
    }
    
    /**
     * Set current markets (called by tick collector when markets refresh)
     */
    setMarkets(markets) {
        this.currentMarkets = markets;
    }
    
    /**
     * Process a tick through all analysis components
     */
    processTick(tick) {
        this.stats.ticksProcessed++;
        
        const crypto = tick.crypto;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        // Update all analyzers
        this.volEstimator.update(tick);
        this.regimeDetector.update(tick);
        
        // Get volatility estimate
        const vol = this.volEstimator.getBestEstimate(crypto);
        
        // Fair value analysis
        const fairValueAnalysis = this.fairValueCalc.analyze(tick, vol);
        
        // Spot lag analysis
        this.spotLagAnalyzer.processTick(tick, vol);
        
        // Record efficiency data
        this.recordEfficiencyData(tick, fairValueAnalysis);
        
        // Run all strategies
        const strategySignals = [];
        for (const strategy of this.strategies) {
            const position = this.getPosition(strategy.getName(), crypto);
            const signal = strategy.onTick(tick, position, {});
            
            // Track signals (total and by crypto)
            if (signal.action === 'buy' || signal.action === 'sell') {
                const perf = this.strategyPerformance[strategy.getName()];
                perf.signals++;
                if (!perf.byCrypto[crypto]) {
                    perf.byCrypto[crypto] = { signals: 0, trades: 0, wins: 0, losses: 0, totalPnl: 0 };
                }
                perf.byCrypto[crypto].signals++;
            }
            
            // Paper trading (always runs for all strategies)
            if (this.options.enablePaperTrading) {
                this.executePaperTrade(strategy.getName(), crypto, signal, tick);
            }
            
            // LIVE TRADING - execute if strategy is enabled
            if (signal.action === 'buy' || signal.action === 'sell') {
                try {
                    const liveTrader = getLiveTrader();
                    // Get market info for this crypto (need tokenIds)
                    const market = this.currentMarkets?.[crypto];
                    
                    if (!market) {
                        // Market not available yet - skip silently
                    } else if (!liveTrader.isRunning) {
                        // LiveTrader not running - skip silently
                    } else {
                        // Log signal being sent to live trader
                        console.log(`[LiveSignal] ${strategy.getName()} | ${crypto} | ${signal.action} ${signal.side} | enabled: ${liveTrader.enabledStrategies?.has(strategy.getName())}`);
                        liveTrader.processSignal(strategy.getName(), signal, tick, market);
                    }
                } catch (e) {
                    console.error(`[LiveSignal] Error: ${e.message}`);
                }
            }
            
            strategySignals.push({
                strategy: strategy.getName(),
                signal
            });
        }
        
        return {
            tick,
            fairValue: fairValueAnalysis,
            volatility: this.volEstimator.getVolatilities(crypto),
            regime: this.regimeDetector.detectRegime(crypto),
            lagSignal: this.spotLagAnalyzer.getLagSignal(crypto, tick, vol),
            strategySignals
        };
    }
    
    /**
     * Record efficiency data for analysis
     */
    recordEfficiencyData(tick, fairValueAnalysis) {
        if (!fairValueAnalysis || fairValueAnalysis.edge === undefined) return;
        
        const crypto = tick.crypto;
        const timeRemaining = tick.time_remaining_sec || 0;
        
        const dataPoint = {
            timestamp: Date.now(),
            crypto,
            timeRemaining,
            edge: fairValueAnalysis.edge,
            edgePct: fairValueAnalysis.edgePct,
            marketProb: fairValueAnalysis.marketProb,
            fairProb: fairValueAnalysis.fairProb
        };
        
        // By time phase
        if (timeRemaining > 600) {
            this.efficiencyData.byTimephase.early.push(dataPoint);
        } else if (timeRemaining > 180) {
            this.efficiencyData.byTimephase.mid.push(dataPoint);
        } else {
            this.efficiencyData.byTimephase.late.push(dataPoint);
        }
        
        // By crypto
        if (!this.efficiencyData.byCrypto[crypto]) {
            this.efficiencyData.byCrypto[crypto] = [];
        }
        this.efficiencyData.byCrypto[crypto].push(dataPoint);
        
        // Overall
        this.efficiencyData.overall.push(dataPoint);
        
        // Trim to keep memory bounded
        const maxLen = 5000;
        for (const phase of ['early', 'mid', 'late']) {
            if (this.efficiencyData.byTimephase[phase].length > maxLen) {
                this.efficiencyData.byTimephase[phase] = 
                    this.efficiencyData.byTimephase[phase].slice(-maxLen);
            }
        }
        if (this.efficiencyData.overall.length > maxLen * 3) {
            this.efficiencyData.overall = this.efficiencyData.overall.slice(-maxLen * 3);
        }
    }
    
    /**
     * Get position for a strategy/crypto
     */
    getPosition(strategyName, crypto) {
        return this.positions[strategyName]?.[crypto] || null;
    }
    
    /**
     * Execute paper trade
     */
    executePaperTrade(strategyName, crypto, signal, tick) {
        if (!this.positions[strategyName]) {
            this.positions[strategyName] = {};
        }
        
        const position = this.positions[strategyName][crypto];
        const perf = this.strategyPerformance[strategyName];
        
        // Ensure crypto tracking exists
        if (!perf.byCrypto[crypto]) {
            perf.byCrypto[crypto] = { signals: 0, trades: 0, wins: 0, losses: 0, totalPnl: 0 };
        }
        const cryptoPerf = perf.byCrypto[crypto];
        
        if (signal.action === 'buy' && !position) {
            // Open position
            const entryPrice = signal.side === 'up' ? tick.up_ask : (1 - tick.up_bid);
            this.positions[strategyName][crypto] = {
                side: signal.side,
                entryPrice,
                entryTime: Date.now(),
                size: signal.size || 100,
                reason: signal.reason,
                windowEpoch: tick.window_epoch,
                // Additional fields for analysis
                entrySpotPrice: tick.spot_price,
                priceToBeat: tick.price_to_beat,
                timeRemainingAtEntry: tick.time_remaining_sec,
                entryMarketProb: tick.up_mid,
                // Market depth at entry
                entryBidSize: signal.side === 'up' ? tick.up_bid_size : tick.down_bid_size,
                entryAskSize: signal.side === 'up' ? tick.up_ask_size : tick.down_ask_size,
                entrySpread: tick.spread,
                entrySpreadPct: tick.spread_pct,
                entryBookImbalance: tick.up_bid_size && tick.up_ask_size 
                    ? (tick.up_bid_size - tick.up_ask_size) / (tick.up_bid_size + tick.up_ask_size) 
                    : null,
                signalStrength: signal.confidence || signal.edge || null
            };
            perf.trades++;
            cryptoPerf.trades++;
        } else if (signal.action === 'sell' && position) {
            // Close position
            const exitPrice = position.side === 'up' ? tick.up_bid : (1 - tick.up_ask);
            const pnl = (exitPrice - position.entryPrice) * position.size;
            
            if (pnl > 0) {
                perf.wins++;
                cryptoPerf.wins++;
            } else {
                perf.losses++;
                cryptoPerf.losses++;
            }
            perf.totalPnl += pnl;
            cryptoPerf.totalPnl += pnl;
            
            const closedPosition = {
                crypto,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice,
                pnl,
                entryTime: position.entryTime,
                exitTime: Date.now(),
                holdingTimeMs: Date.now() - position.entryTime,
                reason: signal.reason,
                windowEpoch: position.windowEpoch,
                // Analysis fields
                entrySpotPrice: position.entrySpotPrice,
                exitSpotPrice: tick.spot_price,
                priceToBeat: position.priceToBeat,
                timeRemainingAtEntry: position.timeRemainingAtEntry,
                timeRemainingAtExit: tick.time_remaining_sec,
                entryMarketProb: position.entryMarketProb,
                exitMarketProb: tick.up_mid,
                // Market depth at entry
                entryBidSize: position.entryBidSize,
                entryAskSize: position.entryAskSize,
                entrySpread: position.entrySpread,
                entrySpreadPct: position.entrySpreadPct,
                entryBookImbalance: position.entryBookImbalance,
                signalStrength: position.signalStrength,
                // Market depth at exit
                exitBidSize: position.side === 'up' ? tick.up_bid_size : tick.down_bid_size,
                exitAskSize: position.side === 'up' ? tick.up_ask_size : tick.down_ask_size,
                exitSpread: tick.spread,
                // Spot movement during trade
                spotMoveDuringTrade: tick.spot_price - position.entrySpotPrice,
                marketMoveDuringTrade: tick.up_mid - position.entryMarketProb
            };
            
            perf.positions.push(closedPosition);
            
            // Save to database for historical tracking
            savePaperTrade({ strategyName, ...closedPosition }).catch(() => {});
            
            // Keep last 100 positions in memory
            if (perf.positions.length > 100) {
                perf.positions.shift();
            }
            
            delete this.positions[strategyName][crypto];
        }
    }
    
    /**
     * Handle window end - close positions at binary expiry
     */
    onWindowEnd(windowInfo) {
        this.stats.windowsAnalyzed++;
        
        // Close any open positions for this crypto at window end
        const crypto = windowInfo.crypto;
        const windowEpoch = windowInfo.epoch;
        
        for (const strategyName of Object.keys(this.positions)) {
            const position = this.positions[strategyName]?.[crypto];
            if (!position) continue;
            
            // Only close positions from THIS window (or earlier - they shouldn't exist)
            // This prevents closing positions that were opened for the NEXT window
            if (position.windowEpoch && position.windowEpoch > windowEpoch) {
                continue;  // Position is for a future window, don't close
            }
            
            // Position expires - outcome determines P&L (binary: $1 or $0)
            const isCorrect = (position.side === 'up' && windowInfo.outcome === 'up') ||
                             (position.side === 'down' && windowInfo.outcome === 'down');
            const exitPrice = isCorrect ? 1.0 : 0.0;
            const pnl = (exitPrice - position.entryPrice) * position.size;
            
            const perf = this.strategyPerformance[strategyName];
            
            // Ensure crypto tracking exists
            if (!perf.byCrypto[crypto]) {
                perf.byCrypto[crypto] = { signals: 0, trades: 0, wins: 0, losses: 0, totalPnl: 0 };
            }
            const cryptoPerf = perf.byCrypto[crypto];
            
            // Update stats
            if (pnl > 0) {
                perf.wins++;
                cryptoPerf.wins++;
            } else {
                perf.losses++;
                cryptoPerf.losses++;
            }
            perf.totalPnl += pnl;
            cryptoPerf.totalPnl += pnl;
            
            // Log the closed position
            const closedPosition = {
                crypto,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice,
                pnl,
                entryTime: position.entryTime,
                exitTime: Date.now(),
                holdingTimeMs: Date.now() - position.entryTime,
                reason: 'window_expiry',
                outcome: windowInfo.outcome,
                windowEpoch: position.windowEpoch,
                // Analysis fields
                entrySpotPrice: position.entrySpotPrice,
                exitSpotPrice: windowInfo.finalPrice,
                priceToBeat: position.priceToBeat,
                timeRemainingAtEntry: position.timeRemainingAtEntry,
                entryMarketProb: position.entryMarketProb,
                // Market depth at entry (captured when position opened)
                entryBidSize: position.entryBidSize,
                entryAskSize: position.entryAskSize,
                entrySpread: position.entrySpread,
                entrySpreadPct: position.entrySpreadPct,
                entryBookImbalance: position.entryBookImbalance,
                signalStrength: position.signalStrength,
                // Spot movement during trade
                spotMoveDuringTrade: windowInfo.finalPrice - position.entrySpotPrice
            };
            
            perf.positions.push(closedPosition);
            
            // Save to database for historical tracking
            savePaperTrade({ strategyName, ...closedPosition }).catch(() => {});
            
            // Keep last 100 positions in memory
            if (perf.positions.length > 100) {
                perf.positions.shift();
            }
            
            delete this.positions[strategyName][crypto];
        }
    }
    
    // ================================================
    // REPORT GENERATION
    // ================================================
    
    /**
     * Generate Spot Lag Report
     */
    getSpotLagReport() {
        return this.spotLagAnalyzer.getReport();
    }
    
    /**
     * Generate Market Efficiency Report
     */
    getMarketEfficiencyReport() {
        const calcStats = (data) => {
            if (data.length === 0) return null;
            
            const edges = data.map(d => d.edge);
            const absEdges = edges.map(e => Math.abs(e));
            
            const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
            const absMean = absEdges.reduce((a, b) => a + b, 0) / absEdges.length;
            const variance = edges.reduce((sum, e) => sum + Math.pow(e - mean, 2), 0) / edges.length;
            const stdDev = Math.sqrt(variance);
            
            return {
                sampleCount: data.length,
                meanEdge: mean,
                meanAbsEdge: absMean,
                stdDevEdge: stdDev,
                meanEdgePct: mean * 100,
                meanAbsEdgePct: absMean * 100
            };
        };
        
        return {
            timestamp: Date.now(),
            
            // Overall efficiency
            overall: calcStats(this.efficiencyData.overall),
            
            // By time phase
            byTimePhase: {
                early: calcStats(this.efficiencyData.byTimephase.early),
                mid: calcStats(this.efficiencyData.byTimephase.mid),
                late: calcStats(this.efficiencyData.byTimephase.late)
            },
            
            // By crypto
            byCrypto: Object.fromEntries(
                Object.entries(this.efficiencyData.byCrypto).map(([crypto, data]) => [
                    crypto, calcStats(data)
                ])
            ),
            
            // Interpretation
            interpretation: this.interpretEfficiency(calcStats(this.efficiencyData.overall))
        };
    }
    
    /**
     * Interpret efficiency metrics
     */
    interpretEfficiency(stats) {
        if (!stats) return 'Insufficient data';
        
        const absEdge = stats.meanAbsEdgePct;
        
        if (absEdge < 1) {
            return 'Market appears highly efficient (< 1% avg deviation from fair value)';
        } else if (absEdge < 3) {
            return 'Market shows moderate efficiency (1-3% avg deviation) - some opportunity';
        } else if (absEdge < 5) {
            return 'Market shows exploitable inefficiency (3-5% avg deviation)';
        } else {
            return 'Market shows significant inefficiency (> 5% avg deviation) - strong alpha potential';
        }
    }
    
    /**
     * Generate Strategy Performance Report
     */
    getStrategyPerformanceReport() {
        const report = {
            timestamp: Date.now(),
            strategies: []
        };
        
        for (const [name, perf] of Object.entries(this.strategyPerformance)) {
            const totalTrades = perf.wins + perf.losses;
            const winRate = totalTrades > 0 ? perf.wins / totalTrades : 0;
            const avgPnl = totalTrades > 0 ? perf.totalPnl / totalTrades : 0;
            
            // Calculate Sharpe-like metric
            let sharpe = 0;
            if (perf.positions.length > 1) {
                const pnls = perf.positions.map(p => p.pnl);
                const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
                const variance = pnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnls.length;
                const stdDev = Math.sqrt(variance);
                sharpe = stdDev > 0 ? mean / stdDev : 0;
            }
            
            // Determine significance
            const isSignificant = totalTrades >= 30 && Math.abs(sharpe) > 0.5;
            
            // Get open positions for this strategy
            const openPositions = [];
            if (this.positions[name]) {
                for (const [crypto, pos] of Object.entries(this.positions[name])) {
                    if (pos) {
                        openPositions.push({
                            crypto,
                            side: pos.side,
                            entryPrice: pos.entryPrice,
                            entryTime: pos.entryTime,
                            holdingMs: Date.now() - pos.entryTime
                        });
                    }
                }
            }
            
            // Build crypto-level breakdown
            const cryptoBreakdown = {};
            if (perf.byCrypto) {
                for (const [crypto, cPerf] of Object.entries(perf.byCrypto)) {
                    const cTotal = cPerf.wins + cPerf.losses;
                    const cWinRate = cTotal > 0 ? cPerf.wins / cTotal : 0;
                    cryptoBreakdown[crypto] = {
                        signals: cPerf.signals,
                        trades: cPerf.trades,
                        wins: cPerf.wins,
                        losses: cPerf.losses,
                        winRate: cWinRate,
                        winRatePct: (cWinRate * 100).toFixed(1) + '%',
                        totalPnl: cPerf.totalPnl
                    };
                }
            }
            
            report.strategies.push({
                name,
                signals: perf.signals,
                trades: perf.trades, // Positions opened
                closedTrades: totalTrades, // Positions closed (wins + losses)
                wins: perf.wins,
                losses: perf.losses,
                winRate,
                winRatePct: (winRate * 100).toFixed(1) + '%',
                totalPnl: perf.totalPnl,
                avgPnl,
                sharpe,
                isSignificant,
                openPositions,
                recentPositions: perf.positions.slice(-5),
                byCrypto: cryptoBreakdown  // NEW: crypto-level stats
            });
        }
        
        // Sort by total P&L
        report.strategies.sort((a, b) => b.totalPnl - a.totalPnl);
        
        // Add summary of all open positions
        report.totalOpenPositions = report.strategies.reduce((sum, s) => sum + s.openPositions.length, 0);
        
        return report;
    }
    
    /**
     * Generate Regime Analysis Report
     */
    getRegimeAnalysisReport() {
        const regimes = {};
        
        for (const crypto of Object.keys(this.regimeDetector.state)) {
            const regime = this.regimeDetector.detectRegime(crypto);
            regimes[crypto] = {
                current: regime.combined,
                volatility: regime.volatility,
                trend: regime.trend,
                liquidity: regime.liquidity,
                recommendation: this.regimeDetector.getStrategyRecommendation(crypto)
            };
        }
        
        return {
            timestamp: Date.now(),
            regimes
        };
    }
    
    /**
     * Get comprehensive summary
     */
    getSummary() {
        return {
            timestamp: Date.now(),
            runtime: Date.now() - this.stats.startTime,
            runtimeMin: ((Date.now() - this.stats.startTime) / 60000).toFixed(1),
            ticksProcessed: this.stats.ticksProcessed,
            windowsAnalyzed: this.stats.windowsAnalyzed,
            
            // Spot lag summary
            spotLag: {
                avgHalfPricingTimeMs: this.spotLagAnalyzer.stats.avgHalfPricingTime,
                avgFullPricingTimeMs: this.spotLagAnalyzer.stats.avgFullPricingTime,
                totalEvents: this.spotLagAnalyzer.stats.totalEvents
            },
            
            // Efficiency summary
            efficiency: this.getMarketEfficiencyReport().overall,
            
            // Top strategy
            topStrategy: this.getTopStrategy(),
            
            // Strategy count
            activeStrategies: this.strategies.length
        };
    }
    
    /**
     * Get top performing strategy
     */
    getTopStrategy() {
        let best = null;
        let bestPnl = -Infinity;
        
        for (const [name, perf] of Object.entries(this.strategyPerformance)) {
            const totalTrades = perf.wins + perf.losses;
            if (totalTrades >= 5 && perf.totalPnl > bestPnl) {
                bestPnl = perf.totalPnl;
                best = {
                    name,
                    trades: totalTrades,
                    pnl: perf.totalPnl,
                    winRate: perf.wins / totalTrades
                };
            }
        }
        
        return best;
    }
    
    /**
     * Get all current volatility estimates
     */
    getVolatilities() {
        const vols = {};
        for (const crypto of Object.keys(this.volEstimator.state)) {
            vols[crypto] = this.volEstimator.getVolatilities(crypto);
        }
        return vols;
    }
}

// Singleton
let researchEngineInstance = null;

export function getResearchEngine(options = {}) {
    if (!researchEngineInstance) {
        researchEngineInstance = new ResearchEngine(options);
    }
    return researchEngineInstance;
}

export default ResearchEngine;
