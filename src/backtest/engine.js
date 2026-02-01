/**
 * Backtest Replay Engine
 *
 * Core replay loop that iterates through historical ticks,
 * builds market context, runs strategy evaluation, and
 * simulates trade execution.
 */

import { loadTicksBatched, getTickCount } from './data-loader.js';
import { createMarketState } from './market-state.js';
import { createContextBuilder } from './context-builder.js';
import { createSimulator } from './simulator.js';
import { child } from '../modules/logger/index.js';

const log = child({ module: 'backtest:engine' });

/**
 * @typedef {Object} BacktestConfig
 * @property {string} startDate - Start date ISO string
 * @property {string} endDate - End date ISO string
 * @property {string[]} [symbols] - Symbols to backtest
 * @property {Function} strategy - Strategy function(context) => { action, direction, size }
 * @property {Object} [strategyConfig] - Strategy configuration
 * @property {number} [initialCapital=1000] - Starting capital
 * @property {number} [slippagePct=0.001] - Slippage percentage
 * @property {number} [batchSize=10000] - Tick batch size
 * @property {Function} [onProgress] - Progress callback(processed, total)
 * @property {number} [progressIntervalTicks=1000] - Ticks between progress updates
 */

/**
 * @typedef {Object} BacktestResult
 * @property {Object} config - Backtest configuration
 * @property {Object} summary - Summary statistics
 * @property {Object[]} trades - All completed trades
 * @property {number[]} equityCurve - Equity values over time
 * @property {Object} bySymbol - Breakdown by symbol
 */

/**
 * Run a backtest with the given configuration
 *
 * @param {BacktestConfig} config - Backtest configuration
 * @returns {Promise<BacktestResult>} Backtest results
 */
export async function runBacktest(config) {
  const {
    startDate,
    endDate,
    symbols,
    strategy,
    strategyConfig = {},
    initialCapital = 1000,
    slippagePct = 0.001,
    batchSize = 10000,
    onProgress,
    progressIntervalTicks = 1000,
  } = config;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  if (typeof strategy !== 'function') {
    throw new Error('strategy must be a function');
  }

  log.info('backtest_start', {
    startDate,
    endDate,
    symbols: symbols || 'all',
    initialCapital,
    slippagePct,
  });

  // Get total tick count for progress tracking
  const totalTicks = getTickCount({ startDate, endDate, symbols });

  log.info('backtest_tick_count', { totalTicks });

  // Initialize components
  const marketState = createMarketState();
  const contextBuilder = createContextBuilder();
  const simulator = createSimulator({ initialCapital, defaultSlippagePct: slippagePct });

  // Track stats by symbol
  const symbolStats = new Map();

  let processedTicks = 0;
  let lastProgressTicks = 0;

  // Process ticks in batches
  for (const batch of loadTicksBatched({ startDate, endDate, symbols, batchSize })) {
    for (const tick of batch) {
      // Update market state
      marketState.processTick(tick);
      processedTicks++;

      // Build context for this symbol
      const symbol = tick.symbol;
      const timestamp = tick.timestamp;

      // Only evaluate if we have both prices
      if (!marketState.hasBothPrices(symbol)) {
        continue;
      }

      // Sync simulated position to context builder
      const simPosition = simulator.getPosition(symbol);
      if (simPosition) {
        contextBuilder.setPosition(symbol, {
          isOpen: true,
          direction: simPosition.direction,
          entryPrice: simPosition.entryPrice,
          size: simPosition.size,
        });
      } else {
        contextBuilder.setPosition(symbol, null);
      }

      // Build context
      const context = contextBuilder.buildContext(symbol, marketState, timestamp);

      // Run strategy
      try {
        const decision = strategy(context, strategyConfig);

        if (decision && decision.action) {
          handleDecision(symbol, decision, context, simulator, symbolStats);
        }
      } catch (err) {
        log.warn('strategy_error', { symbol, timestamp, error: err.message });
      }

      // Progress callback
      if (onProgress && processedTicks - lastProgressTicks >= progressIntervalTicks) {
        onProgress(processedTicks, totalTicks);
        lastProgressTicks = processedTicks;
      }
    }
  }

  // Final progress update
  if (onProgress) {
    onProgress(processedTicks, totalTicks);
  }

  // Close any remaining positions at last known price
  for (const position of simulator.getOpenPositions()) {
    const currentPrice = marketState.getSpotPrice(position.symbol);
    if (currentPrice !== null) {
      simulator.closePosition({
        symbol: position.symbol,
        price: currentPrice,
        timestamp: marketState.currentTimestamp,
        reason: 'backtest_end',
      });
    }
  }

  // Build results
  const stats = simulator.getStats();
  const trades = simulator.getTrades();

  // Build by-symbol breakdown
  const bySymbol = {};
  for (const [symbol, symbolStat] of symbolStats) {
    const symbolTrades = trades.filter(t => t.symbol === symbol);
    const wins = symbolTrades.filter(t => t.pnl > 0);

    bySymbol[symbol] = {
      tradeCount: symbolTrades.length,
      winCount: wins.length,
      winRate: symbolTrades.length > 0 ? wins.length / symbolTrades.length : 0,
      totalPnl: symbolTrades.reduce((s, t) => s + t.pnl, 0),
      ...symbolStat,
    };
  }

  const result = {
    config: {
      startDate,
      endDate,
      symbols: symbols || 'all',
      initialCapital,
      slippagePct,
    },
    summary: {
      totalTrades: stats.tradeCount,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      returnPct: stats.returnPct,
      maxDrawdown: stats.maxDrawdown,
      finalCapital: stats.finalCapital,
      avgWin: stats.avgWin,
      avgLoss: stats.avgLoss,
      ticksProcessed: processedTicks,
    },
    trades,
    equityCurve: simulator.getEquityCurve(),
    bySymbol,
  };

  log.info('backtest_complete', {
    totalTrades: result.summary.totalTrades,
    winRate: result.summary.winRate,
    totalPnl: result.summary.totalPnl,
    returnPct: result.summary.returnPct,
    maxDrawdown: result.summary.maxDrawdown,
    ticksProcessed: processedTicks,
  });

  return result;
}

/**
 * Handle a strategy decision
 *
 * @param {string} symbol - Symbol
 * @param {Object} decision - Strategy decision
 * @param {Object} context - Current context
 * @param {import('./simulator.js').Simulator} simulator - Simulator instance
 * @param {Map} symbolStats - Symbol statistics map
 */
function handleDecision(symbol, decision, context, simulator, symbolStats) {
  const { action, direction, size, reason } = decision;

  // Initialize symbol stats if needed
  if (!symbolStats.has(symbol)) {
    symbolStats.set(symbol, { signalCount: 0, entryCount: 0, exitCount: 0 });
  }
  const stats = symbolStats.get(symbol);
  stats.signalCount++;

  const hasPosition = simulator.hasPosition(symbol);
  const spotPrice = context.market.spotPrice;

  if (action === 'enter' && !hasPosition && spotPrice !== null) {
    // Open position
    simulator.openPosition({
      symbol,
      direction: direction || 'long',
      size: size || 1,
      price: spotPrice,
      timestamp: context.timestamp,
    });
    stats.entryCount++;

  } else if (action === 'exit' && hasPosition && spotPrice !== null) {
    // Close position
    simulator.closePosition({
      symbol,
      price: spotPrice,
      timestamp: context.timestamp,
      reason: reason || 'strategy_exit',
    });
    stats.exitCount++;
  }
}

/**
 * Create a strategy function from a loaded strategy definition
 *
 * Wraps the strategy composition framework components into a
 * function compatible with the backtest engine.
 *
 * @param {Object} strategyDef - Strategy definition from loader
 * @param {Object} catalog - Component catalog
 * @returns {Function} Strategy function(context, config) => decision
 */
export function createComposedStrategy(strategyDef, catalog) {
  const { components, config: strategyConfig, pipeline } = strategyDef;

  return function composedStrategy(context, config) {
    const mergedConfig = { ...strategyConfig, ...config };
    const results = {};

    // Execute components in pipeline order
    const order = pipeline?.order || Object.keys(components);

    for (const componentType of order) {
      const versionIds = components[componentType];
      if (!versionIds) continue;

      const ids = Array.isArray(versionIds) ? versionIds : [versionIds];

      for (const versionId of ids) {
        // Find component in catalog
        let component = null;
        for (const type of Object.keys(catalog)) {
          if (catalog[type][versionId]) {
            component = catalog[type][versionId];
            break;
          }
        }

        if (!component || !component.module || typeof component.module.evaluate !== 'function') {
          continue;
        }

        try {
          // Build component context
          const componentContext = {
            ...context,
            previousResults: results,
          };

          const result = component.module.evaluate(componentContext, mergedConfig);
          results[versionId] = result;

          // Check for signal
          if (result.has_signal && result.direction) {
            // Convert oracle edge signal format to backtest decision
            return {
              action: 'enter',
              direction: result.direction === 'FADE_UP' ? 'short' : 'long',
              confidence: result.confidence,
              reason: `signal_from_${component.name}`,
            };
          }

          // Check for probability-based entry
          if (result.probability !== undefined && result.signal === 'entry') {
            return {
              action: 'enter',
              direction: result.probability > 0.5 ? 'long' : 'short',
              confidence: Math.abs(result.probability - 0.5) * 2,
              reason: `probability_threshold`,
            };
          }

          // Check for lag-based entry
          if (result.signal?.has_signal && result.signal.direction) {
            return {
              action: 'enter',
              direction: result.signal.direction === 'up' ? 'long' : 'short',
              confidence: result.signal.confidence,
              reason: 'lag_signal',
            };
          }
        } catch (err) {
          // Component evaluation failed - continue with others
        }
      }
    }

    // No signal from any component
    return { action: null };
  };
}

/**
 * Create a simple threshold strategy for testing
 *
 * @param {Object} options - Strategy options
 * @param {number} [options.entryThreshold=0.001] - Enter when spread > threshold
 * @param {number} [options.exitThreshold=0] - Exit when spread < threshold
 * @param {number} [options.stopLossPct=0.05] - Stop loss percentage
 * @param {number} [options.takeProfitPct=0.02] - Take profit percentage
 * @returns {Function} Strategy function
 */
export function createThresholdStrategy(options = {}) {
  const {
    entryThreshold = 0.001,
    exitThreshold = 0,
    stopLossPct = 0.05,
    takeProfitPct = 0.02,
  } = options;

  return function thresholdStrategy(context) {
    const { market, position } = context;
    const spreadPct = market.spreadPct;

    if (spreadPct === null) {
      return { action: null };
    }

    // If we have a position, check exit conditions
    if (position.isOpen) {
      const pnlPct = position.unrealizedPnl / (position.entryPrice * position.size);

      // Stop loss
      if (pnlPct <= -stopLossPct) {
        return { action: 'exit', reason: 'stop_loss' };
      }

      // Take profit
      if (pnlPct >= takeProfitPct) {
        return { action: 'exit', reason: 'take_profit' };
      }

      // Exit on spread reversal
      if (position.direction === 'long' && spreadPct < exitThreshold) {
        return { action: 'exit', reason: 'spread_reversal' };
      }
      if (position.direction === 'short' && spreadPct > -exitThreshold) {
        return { action: 'exit', reason: 'spread_reversal' };
      }

      return { action: null };
    }

    // Check entry conditions
    if (spreadPct > entryThreshold) {
      // Spot > Oracle, expect oracle to catch up (spot likely to fall or oracle rise)
      return { action: 'enter', direction: 'short', size: 1 };
    }

    if (spreadPct < -entryThreshold) {
      // Oracle > Spot, expect spot to catch up (spot likely to rise)
      return { action: 'enter', direction: 'long', size: 1 };
    }

    return { action: null };
  };
}
