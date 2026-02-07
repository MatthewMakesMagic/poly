/**
 * Backtest Replay Engine
 *
 * Window-aware async replay that:
 *   1. Pre-loads window schedule from window_close_events
 *   2. Replays merged timeline events through market state
 *   3. Evaluates strategy on each event
 *   4. Executes signals through simulator
 *   5. Resolves positions at window boundaries
 *
 * Strategy interface contract:
 *   {
 *     name: string,
 *     evaluate: (state, config) => Signal[],
 *     onWindowOpen?: (state, config) => void,
 *     onWindowClose?: (state, windowResult, config) => void,
 *   }
 *
 * Signal format:
 *   { action: 'buy'|'sell', token: string, size: number, reason: string, confidence?: number }
 */

import { loadMergedTimeline, loadWindowEvents } from './data-loader.js';
import { createMarketState } from './market-state.js';
import { createSimulator } from './simulator.js';
import { child } from '../modules/logger/index.js';

const log = child({ module: 'backtest:engine' });

/**
 * @typedef {Object} BacktestConfig
 * @property {string} startDate
 * @property {string} endDate
 * @property {string[]} [symbols]
 * @property {Object} strategy - Strategy object with name + evaluate
 * @property {Object} [strategyConfig] - Params passed to strategy.evaluate
 * @property {number} [initialCapital=100]
 * @property {number} [spreadBuffer=0.005]
 * @property {number} [tradingFee=0]
 * @property {boolean} [verbose=false] - Enable decision log
 * @property {number} [windowDurationMs=300000] - Default window duration (5 min)
 * @property {Function} [onProgress]
 */

/**
 * Run a full backtest.
 *
 * @param {BacktestConfig} config
 * @returns {Promise<Object>} Backtest result
 */
export async function runBacktest(config) {
  const {
    startDate,
    endDate,
    symbols,
    strategy,
    strategyConfig = {},
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    verbose = false,
    windowDurationMs = 5 * 60 * 1000,
    onProgress,
  } = config;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  if (!strategy || typeof strategy.evaluate !== 'function') {
    throw new Error('strategy must have an evaluate function');
  }

  log.info('backtest_start', {
    startDate, endDate,
    strategy: strategy.name,
    symbols: symbols || 'all',
  });

  // Load data
  const [timeline, windows] = await Promise.all([
    loadMergedTimeline({ startDate, endDate, symbols }),
    loadWindowEvents({ startDate, endDate, symbols }),
  ]);

  return replayTimeline(timeline, windows, {
    strategy,
    strategyConfig,
    initialCapital,
    spreadBuffer,
    tradingFee,
    verbose,
    windowDurationMs,
    onProgress,
    startDate,
    endDate,
    symbols,
  });
}

/**
 * Replay a pre-loaded timeline against windows.
 * Separated from runBacktest so sweeps can share loaded data.
 *
 * @param {Object[]} timeline - Merged timeline events
 * @param {Object[]} windows - Window close events
 * @param {Object} config
 * @returns {Object} Backtest result
 */
function replayTimeline(timeline, windows, config) {
  const {
    strategy,
    strategyConfig = {},
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    verbose = false,
    windowDurationMs = 5 * 60 * 1000,
    onProgress,
    startDate,
    endDate,
    symbols,
  } = config;

  const state = createMarketState();
  const simulator = createSimulator({ initialCapital, spreadBuffer, tradingFee });

  // Build window schedule sorted by close time
  const windowSchedule = windows.map(w => ({
    ...w,
    closeMs: new Date(w.window_close_time).getTime(),
    openMs: new Date(w.window_close_time).getTime() - windowDurationMs,
  }));

  let windowIdx = 0;
  let currentWindow = null;
  const windowResults = [];
  const decisionLog = [];
  let eventsProcessed = 0;

  // Advance to first window
  if (windowSchedule.length > 0) {
    currentWindow = windowSchedule[0];
    const openTime = new Date(currentWindow.openMs).toISOString();
    state.setWindow(currentWindow, openTime);
    if (strategy.onWindowOpen) {
      strategy.onWindowOpen(state, strategyConfig);
    }
  }

  for (const event of timeline) {
    const eventMs = new Date(event.timestamp).getTime();

    // Check window transitions
    while (currentWindow && eventMs >= currentWindow.closeMs) {
      // Resolve current window
      if (currentWindow.resolved_direction) {
        simulator.resolveWindow({
          direction: currentWindow.resolved_direction,
          timestamp: currentWindow.window_close_time,
        });
      }

      const windowPnl = simulator.getWindowPnL();
      windowResults.push({
        windowCloseTime: currentWindow.window_close_time,
        symbol: currentWindow.symbol,
        strike: currentWindow.strike_price,
        chainlinkClose: currentWindow.chainlink_price_at_close,
        resolvedDirection: currentWindow.resolved_direction,
        pnl: windowPnl,
        tradesInWindow: simulator.getTrades().filter(
          t => t.exitTimestamp === currentWindow.window_close_time
        ).length,
      });

      if (strategy.onWindowClose) {
        strategy.onWindowClose(state, windowResults[windowResults.length - 1], strategyConfig);
      }

      simulator.resetWindowPnL();

      // Advance to next window
      windowIdx++;
      if (windowIdx < windowSchedule.length) {
        currentWindow = windowSchedule[windowIdx];
        const openTime = new Date(currentWindow.openMs).toISOString();
        state.setWindow(currentWindow, openTime);
        if (strategy.onWindowOpen) {
          strategy.onWindowOpen(state, strategyConfig);
        }
      } else {
        currentWindow = null;
      }
    }

    // Update market state
    state.processEvent(event);
    if (state.window) {
      state.updateTimeToClose(event.timestamp);
    }

    eventsProcessed++;

    // Evaluate strategy
    try {
      const signals = strategy.evaluate(state, strategyConfig);
      if (!signals || signals.length === 0) continue;

      for (const signal of signals) {
        if (!signal.action || !signal.token) continue;

        // Execute through simulator
        const execResult = simulator.execute(signal, state, strategyConfig);

        if (execResult.filled) {
          if (signal.action === 'buy') {
            simulator.buyToken({
              token: signal.token,
              price: execResult.fillPrice,
              size: execResult.fillSize,
              timestamp: event.timestamp,
              reason: signal.reason || '',
            });
          } else if (signal.action === 'sell') {
            simulator.sellToken({
              token: signal.token,
              price: execResult.fillPrice,
              timestamp: event.timestamp,
              reason: signal.reason || 'strategy_sell',
            });
          }
        }

        if (verbose) {
          decisionLog.push({
            timestamp: event.timestamp,
            signal,
            execution: execResult,
            stateSnapshot: {
              chainlink: state.chainlink?.price,
              polyRef: state.polyRef?.price,
              strike: state.strike,
              clobUp: state.clobUp ? { bid: state.clobUp.bestBid, ask: state.clobUp.bestAsk } : null,
              clobDown: state.clobDown ? { bid: state.clobDown.bestBid, ask: state.clobDown.bestAsk } : null,
              timeToCloseMs: state.window?.timeToCloseMs,
            },
          });
        }
      }
    } catch (err) {
      log.warn('strategy_error', { timestamp: event.timestamp, error: err.message });
    }

    if (onProgress && eventsProcessed % 1000 === 0) {
      onProgress(eventsProcessed, timeline.length);
    }
  }

  // Resolve any remaining window
  if (currentWindow && currentWindow.resolved_direction) {
    simulator.resolveWindow({
      direction: currentWindow.resolved_direction,
      timestamp: currentWindow.window_close_time,
    });

    const windowPnl = simulator.getWindowPnL();
    const windowResult = {
      windowCloseTime: currentWindow.window_close_time,
      symbol: currentWindow.symbol,
      strike: currentWindow.strike_price,
      chainlinkClose: currentWindow.chainlink_price_at_close,
      resolvedDirection: currentWindow.resolved_direction,
      pnl: windowPnl,
      tradesInWindow: simulator.getTrades().filter(
        t => t.exitTimestamp === currentWindow.window_close_time
      ).length,
    };
    windowResults.push(windowResult);

    if (strategy.onWindowClose) {
      strategy.onWindowClose(state, windowResult, strategyConfig);
    }
  }

  if (onProgress) {
    onProgress(eventsProcessed, timeline.length);
  }

  const stats = simulator.getStats();
  const trades = simulator.getTrades();

  const result = {
    config: {
      startDate,
      endDate,
      symbols: symbols || 'all',
      strategyName: strategy.name,
      strategyConfig,
      initialCapital,
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
      eventsProcessed,
      windowsProcessed: windowResults.length,
    },
    trades,
    equityCurve: simulator.getEquityCurve(),
    windowResults,
  };

  if (verbose) {
    result.decisionLog = decisionLog;
  }

  log.info('backtest_complete', {
    strategy: strategy.name,
    totalTrades: stats.tradeCount,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    windows: windowResults.length,
  });

  return result;
}

// ─── Parameter Sweep ───

/**
 * Run the same strategy across a grid of parameter values.
 * Data is loaded once and shared across all param sets.
 *
 * @param {BacktestConfig} baseConfig
 * @param {Object} paramGrid - { paramName: [values], ... }
 * @returns {Promise<Object[]>} Array of { params, result }
 */
export async function runSweep(baseConfig, paramGrid) {
  const { startDate, endDate, symbols } = baseConfig;

  // Load data once
  const [timeline, windows] = await Promise.all([
    loadMergedTimeline({ startDate, endDate, symbols }),
    loadWindowEvents({ startDate, endDate, symbols }),
  ]);

  const paramSets = generateParamCombinations(paramGrid);

  log.info('sweep_start', {
    strategy: baseConfig.strategy?.name,
    paramSets: paramSets.length,
    params: Object.keys(paramGrid),
  });

  const results = [];

  for (const params of paramSets) {
    const mergedConfig = {
      ...baseConfig,
      strategyConfig: { ...baseConfig.strategyConfig, ...params },
      startDate,
      endDate,
      symbols,
    };

    const result = replayTimeline(timeline, windows, mergedConfig);
    results.push({ params, result });
  }

  log.info('sweep_complete', { paramSets: paramSets.length });

  return results;
}

/**
 * Generate all combinations from a parameter grid.
 *
 * @param {Object} grid - { key: [values], ... }
 * @returns {Object[]} Array of param objects
 */
function generateParamCombinations(grid) {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  const combos = [{}];

  for (const key of keys) {
    const values = grid[key];
    const newCombos = [];

    for (const existing of combos) {
      for (const value of values) {
        newCombos.push({ ...existing, [key]: value });
      }
    }

    combos.length = 0;
    combos.push(...newCombos);
  }

  return combos;
}
