/**
 * Backtesting Engine
 * 
 * Runs strategies against historical tick data
 */

import { getDatabase } from '../db/connection.js';
import { ExecutionSimulator } from './simulator.js';
import {
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    profitFactor,
    winRate,
    avgWinLoss
} from '../analysis/metrics.js';

export class BacktestEngine {
    constructor(options = {}) {
        this.options = {
            initialCapital: 10000,
            commission: 0.001,       // 0.1% per trade
            slippage: 0.001,         // 0.1% slippage
            ...options
        };
        
        this.simulator = new ExecutionSimulator({
            takerFee: this.options.commission,
            slippageFactor: this.options.slippage
        });
    }
    
    /**
     * Run backtest for a strategy
     * 
     * @param {Strategy} strategy - Strategy instance
     * @param {string} crypto - Crypto to test
     * @param {Object} dateRange - { start, end } timestamps
     */
    async run(strategy, crypto, dateRange = {}) {
        const db = getDatabase();
        
        console.log(`\n📊 Running backtest: ${strategy.getName()} on ${crypto.toUpperCase()}`);
        
        // Build query
        let query = `
            SELECT * FROM ticks
            WHERE crypto = ?
        `;
        const params = [crypto];
        
        if (dateRange.start) {
            query += ' AND timestamp_ms >= ?';
            params.push(dateRange.start);
        }
        if (dateRange.end) {
            query += ' AND timestamp_ms <= ?';
            params.push(dateRange.end);
        }
        
        query += ' ORDER BY timestamp_ms ASC';
        
        const ticks = db.prepare(query).all(...params);
        
        if (ticks.length === 0) {
            return {
                error: 'No tick data found for the specified period',
                strategy: strategy.getName(),
                crypto
            };
        }
        
        console.log(`   Processing ${ticks.length.toLocaleString()} ticks...`);
        
        // Initialize state
        const state = {
            capital: this.options.initialCapital,
            position: null,
            trades: [],
            equity: [this.options.initialCapital],
            currentWindow: null
        };
        
        // Process each tick
        for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i];
            
            // Check for window change
            if (state.currentWindow !== tick.window_epoch) {
                if (state.currentWindow !== null) {
                    // Close any open position at window end
                    if (state.position) {
                        this.closePosition(state, tick, 'window_end');
                    }
                    strategy.onWindowEnd({ epoch: state.currentWindow }, null);
                }
                
                state.currentWindow = tick.window_epoch;
                strategy.onWindowStart({ epoch: tick.window_epoch });
            }
            
            // Check risk limits first
            if (state.position) {
                const riskAction = strategy.checkRiskLimits(tick, state.position);
                if (riskAction) {
                    this.closePosition(state, tick, riskAction.reason);
                }
            }
            
            // Get strategy signal
            const context = {
                tickIndex: i,
                history: ticks.slice(Math.max(0, i - 100), i),
                equity: state.equity
            };
            
            const signal = strategy.onTick(tick, state.position, context);
            
            // Execute signal
            if (signal.action === 'buy' && !state.position) {
                this.openPosition(state, tick, signal, strategy);
            } else if (signal.action === 'sell' && state.position) {
                this.closePosition(state, tick, 'signal');
            }
            
            // Update equity
            const currentEquity = this.calculateEquity(state, tick);
            state.equity.push(currentEquity);
        }
        
        // Close any remaining position
        if (state.position && ticks.length > 0) {
            this.closePosition(state, ticks[ticks.length - 1], 'backtest_end');
        }
        
        // Calculate results
        const results = this.calculateResults(state, strategy, crypto, ticks);
        
        return results;
    }
    
    /**
     * Open a new position
     */
    openPosition(state, tick, signal, strategy) {
        const size = Math.min(
            signal.size || strategy.params.maxPosition,
            state.capital * 0.5  // Max 50% of capital per position
        );
        
        if (size < 5) return; // Minimum order size
        
        const side = signal.side || 'up';
        const orderSide = `buy_${side}`;
        
        const execution = this.simulator.executeMarketOrder(
            { side: orderSide, size },
            tick
        );
        
        state.position = {
            side,
            size: execution.filledSize,
            entryPrice: execution.executionPrice,
            entryTime: tick.timestamp_ms,
            entryTick: tick
        };
        
        state.capital -= execution.filledSize + execution.fee;
    }
    
    /**
     * Close current position
     */
    closePosition(state, tick, reason) {
        if (!state.position) return;
        
        const side = state.position.side;
        const orderSide = `sell_${side}`;
        
        const execution = this.simulator.executeMarketOrder(
            { side: orderSide, size: state.position.size },
            tick
        );
        
        // Calculate P&L
        const exitPrice = side === 'up' ? tick.up_bid : (1 - tick.up_ask);
        const entryPrice = state.position.entryPrice;
        const pnl = (exitPrice - entryPrice) * state.position.size - execution.fee;
        
        // Record trade
        state.trades.push({
            side: state.position.side,
            size: state.position.size,
            entryPrice: state.position.entryPrice,
            exitPrice,
            entryTime: state.position.entryTime,
            exitTime: tick.timestamp_ms,
            pnl,
            pnlPct: (exitPrice - entryPrice) / entryPrice,
            fee: execution.fee,
            reason,
            holdingTime: tick.timestamp_ms - state.position.entryTime
        });
        
        // Update capital
        state.capital += state.position.size + pnl;
        
        // Clear position
        state.position = null;
    }
    
    /**
     * Calculate current equity
     */
    calculateEquity(state, tick) {
        let equity = state.capital;
        
        if (state.position) {
            const currentPrice = state.position.side === 'up' 
                ? tick.up_mid 
                : (1 - tick.up_mid);
            const unrealizedPnL = (currentPrice - state.position.entryPrice) * state.position.size;
            equity += state.position.size + unrealizedPnL;
        }
        
        return equity;
    }
    
    /**
     * Calculate backtest results
     */
    calculateResults(state, strategy, crypto, ticks) {
        const trades = state.trades;
        const equity = state.equity;
        
        // Basic stats
        const totalTrades = trades.length;
        const winningTrades = trades.filter(t => t.pnl > 0);
        const losingTrades = trades.filter(t => t.pnl < 0);
        
        const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
        const netProfit = grossProfit - grossLoss;
        const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
        
        // Calculate returns for risk metrics
        const returns = [];
        for (let i = 1; i < equity.length; i++) {
            if (equity[i - 1] > 0) {
                returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
            }
        }
        
        // Risk metrics
        const dd = maxDrawdown(equity);
        const sharpe = sharpeRatio(returns);
        const sortino = sortinoRatio(returns);
        const pf = profitFactor(trades);
        const wr = winRate(trades);
        const { avgWin, avgLoss, avgTrade } = avgWinLoss(trades);
        
        // Time in market
        const totalHoldingTime = trades.reduce((sum, t) => sum + t.holdingTime, 0);
        const avgHoldingTime = totalTrades > 0 ? totalHoldingTime / totalTrades : 0;
        
        const results = {
            strategy: strategy.getName(),
            crypto,
            params: strategy.getParams(),
            
            // Period
            startTime: ticks[0]?.timestamp_ms,
            endTime: ticks[ticks.length - 1]?.timestamp_ms,
            totalTicks: ticks.length,
            
            // Returns
            initialCapital: this.options.initialCapital,
            finalCapital: equity[equity.length - 1],
            netProfit,
            netReturn: (equity[equity.length - 1] - this.options.initialCapital) / this.options.initialCapital,
            grossProfit,
            grossLoss,
            totalFees,
            
            // Trade stats
            totalTrades,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: wr,
            avgWin,
            avgLoss,
            avgTrade,
            profitFactor: pf,
            
            // Risk metrics
            sharpeRatio: sharpe,
            sortinoRatio: sortino,
            maxDrawdown: dd.maxDrawdown,
            maxDrawdownPct: dd.maxDrawdownPct,
            
            // Time
            avgHoldingTimeSec: avgHoldingTime / 1000,
            
            // Execution stats
            executionStats: this.simulator.getStats(),
            
            // Trade log
            trades
        };
        
        return results;
    }
    
    /**
     * Print results summary
     */
    static printResults(results) {
        console.log('\n' + '═'.repeat(70));
        console.log(`     BACKTEST RESULTS: ${results.strategy}`);
        console.log('═'.repeat(70));
        
        console.log(`\n   Period: ${new Date(results.startTime).toISOString()} to ${new Date(results.endTime).toISOString()}`);
        console.log(`   Ticks: ${results.totalTicks.toLocaleString()}`);
        
        console.log('\n   💰 Returns:');
        console.log(`      Initial Capital: $${results.initialCapital.toFixed(2)}`);
        console.log(`      Final Capital:   $${results.finalCapital.toFixed(2)}`);
        console.log(`      Net Return:      ${(results.netReturn * 100).toFixed(2)}%`);
        console.log(`      Total Fees:      $${results.totalFees.toFixed(2)}`);
        
        console.log('\n   📊 Trade Stats:');
        console.log(`      Total Trades:    ${results.totalTrades}`);
        console.log(`      Win Rate:        ${(results.winRate * 100).toFixed(1)}%`);
        console.log(`      Profit Factor:   ${results.profitFactor.toFixed(2)}`);
        console.log(`      Avg Win:         $${results.avgWin.toFixed(2)}`);
        console.log(`      Avg Loss:        $${results.avgLoss.toFixed(2)}`);
        
        console.log('\n   ⚠️ Risk Metrics:');
        console.log(`      Sharpe Ratio:    ${results.sharpeRatio.toFixed(2)}`);
        console.log(`      Sortino Ratio:   ${results.sortinoRatio.toFixed(2)}`);
        console.log(`      Max Drawdown:    ${(results.maxDrawdownPct * 100).toFixed(2)}%`);
        
        console.log('\n   ⏱️ Timing:');
        console.log(`      Avg Holding:     ${results.avgHoldingTimeSec.toFixed(1)}s`);
        
        console.log('\n' + '═'.repeat(70));
    }
}

export default BacktestEngine;

