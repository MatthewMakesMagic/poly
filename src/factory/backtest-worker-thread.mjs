/**
 * Backtest Worker Thread (Performance: Parallel Window Evaluation)
 *
 * A worker_threads worker that evaluates backtest windows in isolation.
 * Each worker:
 *   - Loads a strategy ONCE (by name, via the factory loadStrategy)
 *   - Opens its own PG connection (via pg-timeline-store)
 *   - Processes multiple windows sequentially within the thread
 *   - Returns only trade results + metrics (small payload) to the main thread
 *
 * Communication protocol (parentPort messages):
 *   Main -> Worker:
 *     { type: 'init', strategyName, config }                    — load strategy + warm up
 *     { type: 'setParams', strategyParams }                     — update strategy params (for sweep)
 *     { type: 'evaluate', windowId, windowMeta, id }            — evaluate one window
 *     { type: 'shutdown' }                                      — clean exit
 *
 *   Worker -> Main:
 *     { type: 'ready' }                               — init complete
 *     { type: 'result', id, result }                  — window evaluation result
 *     { type: 'error', id, error }                    — evaluation error
 */

import { parentPort, workerData } from 'node:worker_threads';
import { unpack } from 'msgpackr';
import { evaluateWindow } from '../backtest/parallel-engine.js';
import { FeeMode, parseFeeMode } from './fee-model.js';

let strategy = null;
let backtestConfig = null;

/**
 * Load strategy by name using the factory's loadStrategy.
 * This avoids serialization of closures — the worker loads the strategy itself.
 */
async function initStrategy(strategyName, config) {
  // Dynamic import to avoid top-level initialization issues in workers
  const { loadStrategy } = await import('./index.js');
  strategy = await loadStrategy(strategyName);
  backtestConfig = config;
}

/**
 * Load a timeline from pg_timelines by window_id.
 * Each worker maintains its own connection through the persistence singleton.
 */
async function loadTimelineFromPg(windowId) {
  const { getPgTimeline } = await import('./pg-timeline-store.js');
  const row = await getPgTimeline(windowId);
  if (!row) return null;

  const timeline = unpack(row.timeline);
  const windowMeta = {
    window_id: row.window_id,
    symbol: row.symbol,
    window_close_time: row.window_close_time instanceof Date
      ? row.window_close_time.toISOString()
      : row.window_close_time,
    window_open_time: row.window_open_time instanceof Date
      ? row.window_open_time.toISOString()
      : row.window_open_time,
    ground_truth: row.ground_truth,
    strike_price: row.strike_price,
    oracle_price_at_open: row.oracle_price_at_open,
    chainlink_price_at_close: row.chainlink_price_at_close,
    event_count: row.event_count,
    built_at: row.built_at,
  };

  return { timeline, meta: windowMeta };
}

/**
 * Update strategy params (for sweep grid — avoids re-loading the strategy).
 */
function setStrategyParams(params) {
  if (!backtestConfig) {
    throw new Error('Worker not initialized — call init first');
  }
  backtestConfig.strategyParams = params;
}

/**
 * Evaluate a single window using the cached strategy.
 * Optionally accepts per-call strategyParams override (for sweep grid).
 */
async function evaluateSingleWindow(windowId, windowMeta, strategyParamsOverride) {
  if (!strategy) {
    throw new Error('Worker not initialized — call init first');
  }

  const {
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
    feeMode: feeModeInput,
    strategyParams = {},
  } = backtestConfig;

  const feeMode = parseFeeMode(feeModeInput || FeeMode.TAKER_ONLY);

  // Load timeline from PG cache
  const loaded = await loadTimelineFromPg(windowId);
  if (!loaded) {
    return { skipped: true, windowId, reason: 'timeline_not_found' };
  }

  const { timeline, meta } = loaded;

  // Use windowMeta from the message if provided (has sampling context),
  // fall back to what we loaded from PG
  const effectiveMeta = windowMeta || meta;

  // Map to evaluateWindow format
  const windowEvent = {
    window_close_time: effectiveMeta.window_close_time,
    symbol: effectiveMeta.symbol,
    strike_price: effectiveMeta.strike_price,
    oracle_price_at_open: effectiveMeta.oracle_price_at_open,
    chainlink_price_at_close: effectiveMeta.chainlink_price_at_close,
    resolved_direction: effectiveMeta.ground_truth,
    gamma_resolved_direction: effectiveMeta.ground_truth,
  };

  // Merge strategy defaults with config-level params, allowing per-call override
  const effectiveParams = strategyParamsOverride || strategyParams;
  const mergedParams = { ...strategy.defaults, ...effectiveParams };

  const result = evaluateWindow({
    window: windowEvent,
    timeline,
    strategy,
    strategyConfig: mergedParams,
    initialCapital,
    spreadBuffer,
    tradingFee,
    windowDurationMs,
    feeMode,
  });

  return result;
}

// ─── Message Handler ───

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'init': {
      try {
        await initStrategy(msg.strategyName, msg.config);
        parentPort.postMessage({ type: 'ready' });
      } catch (err) {
        parentPort.postMessage({
          type: 'error',
          id: null,
          error: `Init failed: ${err.message}`,
        });
      }
      break;
    }

    case 'setParams': {
      try {
        setStrategyParams(msg.strategyParams);
        parentPort.postMessage({ type: 'paramsSet' });
      } catch (err) {
        parentPort.postMessage({
          type: 'error',
          id: null,
          error: `setParams failed: ${err.message}`,
        });
      }
      break;
    }

    case 'evaluate': {
      try {
        const result = await evaluateSingleWindow(
          msg.windowId,
          msg.windowMeta,
          msg.strategyParams,
        );
        parentPort.postMessage({
          type: 'result',
          id: msg.id,
          result,
        });
      } catch (err) {
        parentPort.postMessage({
          type: 'error',
          id: msg.id,
          error: err.message,
        });
      }
      break;
    }

    case 'shutdown': {
      process.exit(0);
    }

    default:
      parentPort.postMessage({
        type: 'error',
        id: msg.id ?? null,
        error: `Unknown message type: ${msg.type}`,
      });
  }
});
