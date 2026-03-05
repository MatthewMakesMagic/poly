/**
 * Fast Multi-Strategy Backtest Engine
 *
 * Performance-optimized engine that processes all strategies in one pass.
 * Key optimizations:
 *   1. Pre-compute _ms timestamps — never call new Date() in hot paths
 *   2. 3-way merge for timeline building — O(n) instead of O(n log n)
 *   3. In-place source tagging — no object spread copies
 *   4. Multi-strategy batching — build timeline once per window, evaluate all strategies
 *   5. Binary search using _ms — fast window slicing
 */

import { evaluateWindow } from './parallel-engine.js';

// ─── Ground Truth Resolution ───

/**
 * Get the best available resolved direction for a window.
 * Priority: gamma > onchain > resolved > computed from CL prices.
 */
function getGroundTruth(window) {
  if (window.gamma_resolved_direction) return window.gamma_resolved_direction.toUpperCase();
  if (window.onchain_resolved_direction) return window.onchain_resolved_direction.toUpperCase();
  if (window.resolved_direction) return window.resolved_direction.toUpperCase();
  const clClose = Number(window.chainlink_price_at_close);
  const clOpen = Number(window.oracle_price_at_open);
  if (clClose && clOpen) {
    return clClose >= clOpen ? 'UP' : 'DOWN';
  }
  return null;
}

// ─── Timestamp Pre-computation ───

/**
 * Add _ms field (epoch millis) to every row in the data arrays.
 * Call once after loading. All subsequent operations use _ms directly.
 *
 * @param {Object} allData - { rtdsTicks, clobSnapshots, exchangeTicks }
 */
export function precomputeTimestamps(allData) {
  const { rtdsTicks, clobSnapshots, exchangeTicks, coingeckoTicks, l2BookTicks } = allData;

  for (let i = 0; i < rtdsTicks.length; i++) {
    rtdsTicks[i]._ms = new Date(rtdsTicks[i].timestamp).getTime();
  }
  for (let i = 0; i < clobSnapshots.length; i++) {
    clobSnapshots[i]._ms = new Date(clobSnapshots[i].timestamp).getTime();
  }
  for (let i = 0; i < exchangeTicks.length; i++) {
    exchangeTicks[i]._ms = new Date(exchangeTicks[i].timestamp).getTime();
  }
  if (coingeckoTicks) {
    for (let i = 0; i < coingeckoTicks.length; i++) {
      coingeckoTicks[i]._ms = new Date(coingeckoTicks[i].timestamp).getTime();
    }
  }
  if (l2BookTicks) {
    for (let i = 0; i < l2BookTicks.length; i++) {
      l2BookTicks[i]._ms = new Date(l2BookTicks[i].timestamp).getTime();
    }
  }
}

// ─── Binary Search using _ms ───

/**
 * Binary search for the first index where _ms >= target.
 * Array must be sorted by _ms ascending.
 */
function lowerBound(arr, targetMs) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]._ms < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Binary search for the first index where _ms > target.
 */
function upperBound(arr, targetMs) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]._ms <= targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Slice a sorted array to [startMs, endMs) using binary search on _ms.
 */
function sliceByTime(sorted, startMs, endMs) {
  const lo = lowerBound(sorted, startMs);
  const hi = upperBound(sorted, endMs - 1);
  return sorted.slice(lo, hi);
}

// ─── In-place Source Tagging ───

/**
 * Tag RTDS ticks with source in-place.
 */
function tagRtdsSources(ticks) {
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const topic = tick.topic;
    if (topic === 'crypto_prices_chainlink') {
      tick.source = 'chainlink';
    } else if (topic === 'crypto_prices') {
      tick.source = 'polyRef';
    } else {
      tick.source = `rtds_${topic}`;
    }
  }
}

/**
 * Tag CLOB snapshots with source in-place.
 */
function tagClobSources(snaps) {
  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i];
    snap.source = snap.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
  }
}

/**
 * Tag exchange ticks with source in-place.
 */
function tagExchangeSources(ticks) {
  for (let i = 0; i < ticks.length; i++) {
    ticks[i].source = `exchange_${ticks[i].exchange}`;
  }
}

/**
 * Tag L2 book ticks with source in-place.
 */
function tagL2Sources(ticks) {
  for (let i = 0; i < ticks.length; i++) {
    ticks[i].source = ticks[i].direction === 'down' ? 'l2Down' : 'l2Up';
  }
}

// ─── N-Way Merge ───

/**
 * Merge N sorted arrays (by _ms) into a single sorted array.
 * O(n*k) where k = number of arrays, n = total elements.
 * For k <= 5 this is faster than a heap-based approach.
 */
function mergeTimeline(...arrays) {
  // Filter out empty arrays
  const sources = arrays.filter(a => a.length > 0);
  if (sources.length === 0) return [];
  if (sources.length === 1) return sources[0];

  // Fast path: 2-way merge
  if (sources.length === 2) return merge2(sources[0], sources[1]);

  const total = sources.reduce((s, a) => s + a.length, 0);
  const result = new Array(total);
  const indices = new Array(sources.length).fill(0);
  let out = 0;

  while (out < total) {
    let minMs = Infinity;
    let minIdx = -1;
    for (let s = 0; s < sources.length; s++) {
      if (indices[s] < sources[s].length && sources[s][indices[s]]._ms < minMs) {
        minMs = sources[s][indices[s]]._ms;
        minIdx = s;
      }
    }
    result[out++] = sources[minIdx][indices[minIdx]++];
  }

  return result;
}

/**
 * Optimized 2-way merge for common case.
 */
function merge2(a, b) {
  const total = a.length + b.length;
  const result = new Array(total);
  let i = 0, j = 0, out = 0;
  while (i < a.length && j < b.length) {
    if (a[i]._ms <= b[j]._ms) {
      result[out++] = a[i++];
    } else {
      result[out++] = b[j++];
    }
  }
  while (i < a.length) result[out++] = a[i++];
  while (j < b.length) result[out++] = b[j++];
  return result;
}

// ─── CLOB Filtering ───

/**
 * Filter CLOB snapshots for a specific window.
 * Match symbol prefix, window_epoch, and active price range.
 */
function filterClobForWindow(clobSlice, symbol, windowEpochSec) {
  const prefix = symbol.toLowerCase();
  const filtered = [];

  for (let i = 0; i < clobSlice.length; i++) {
    const snap = clobSlice[i];
    const sym = snap.symbol?.toLowerCase() || '';
    if (!sym.startsWith(prefix)) continue;

    if (snap.window_epoch != null && windowEpochSec != null) {
      if (Number(snap.window_epoch) !== windowEpochSec) continue;
    }

    // Filter to active trading range
    const mid = Number(snap.mid_price ?? snap.best_bid ?? snap.best_ask ?? 0);
    if (mid < 0.05 || mid > 0.95) continue;

    filtered.push(snap);
  }

  return filtered;
}

// ─── Results Aggregation ───

/**
 * Aggregate per-window results into a combined result.
 * Matches the format from parallel-engine.js aggregateResults().
 */
function aggregateResults(windowResults, meta) {
  const { strategy, strategyConfig, initialCapital, elapsedMs, windowCount } = meta;

  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let totalEventsProcessed = 0;
  const allTrades = [];
  const perWindowSummaries = [];

  const sorted = [...windowResults].sort((a, b) =>
    new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
  );

  let runningCapital = initialCapital;
  const equityCurve = [initialCapital];
  let peakCapital = initialCapital;
  let maxDrawdown = 0;

  for (let i = 0; i < sorted.length; i++) {
    const wr = sorted[i];
    totalPnl += wr.pnl;
    totalTrades += wr.tradesInWindow;
    totalEventsProcessed += wr.eventsProcessed;

    for (let t = 0; t < wr.trades.length; t++) {
      allTrades.push(wr.trades[t]);
      if (wr.trades[t].pnl > 0) totalWins++;
    }

    perWindowSummaries.push({
      windowCloseTime: wr.windowCloseTime,
      symbol: wr.symbol,
      strike: wr.strike,
      chainlinkClose: wr.chainlinkClose,
      resolvedDirection: wr.resolvedDirection,
      pnl: wr.pnl,
      tradesInWindow: wr.tradesInWindow,
    });

    runningCapital += wr.pnl;
    equityCurve.push(runningCapital);

    if (runningCapital > peakCapital) {
      peakCapital = runningCapital;
    }
    if (peakCapital > 0) {
      const dd = (peakCapital - runningCapital) / peakCapital;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const returnPct = initialCapital > 0 ? totalPnl / initialCapital : 0;

  const winTrades = allTrades.filter(t => t.pnl > 0);
  const lossTrades = allTrades.filter(t => t.pnl <= 0);
  const avgWin = winTrades.length > 0
    ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length
    : 0;
  const avgLoss = lossTrades.length > 0
    ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length
    : 0;

  return {
    config: {
      strategyName: strategy.name,
      strategyConfig,
      initialCapital,
      startDate: sorted.length > 0 ? sorted[0].windowCloseTime : null,
      endDate: sorted.length > 0 ? sorted[sorted.length - 1].windowCloseTime : null,
    },
    summary: {
      totalTrades,
      winRate,
      totalPnl,
      returnPct,
      maxDrawdown,
      finalCapital: runningCapital,
      avgWin,
      avgLoss,
      eventsProcessed: totalEventsProcessed,
      windowsProcessed: windowCount,
      elapsedMs,
    },
    trades: allTrades,
    equityCurve,
    windowResults: perWindowSummaries,
  };
}

// ─── Main Entry Point ───

/**
 * Run all strategies against all windows in a single optimized pass.
 *
 * @param {Object} params
 * @param {Object[]} params.windows - Window close events with ground truth
 * @param {Object} params.allData - Pre-loaded data with _ms already computed
 * @param {Object[]} params.strategies - Array of strategy objects
 * @param {Object} [params.config] - Backtest config overrides
 * @returns {Object} Map of { [strategyName]: aggregatedResult }
 */
export function runAllStrategies({ windows, allData, strategies, config = {} }) {
  const {
    initialCapital = 10000,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
  } = config;

  const { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks } = allData;

  // Tag sources in-place (idempotent — only tags if not already tagged)
  if (rtdsTicks.length > 0 && rtdsTicks[0].source === undefined) {
    tagRtdsSources(rtdsTicks);
  }
  if (clobSnapshots.length > 0 && clobSnapshots[0].source === undefined) {
    tagClobSources(clobSnapshots);
  }
  if (exchangeTicks.length > 0 && exchangeTicks[0].source === undefined) {
    tagExchangeSources(exchangeTicks);
  }
  if (l2BookTicks?.length > 0 && l2BookTicks[0].source === undefined) {
    tagL2Sources(l2BookTicks);
  }

  // Per-strategy result accumulators
  const strategyWindowResults = {};
  for (const strategy of strategies) {
    strategyWindowResults[strategy.name] = [];
  }

  const startTime = Date.now();

  // Process each window — build timeline once, evaluate all strategies
  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    const closeMs = new Date(win.window_close_time).getTime();
    const openMs = closeMs - windowDurationMs;

    // window_epoch is the window OPEN time, not CLOSE time
    // 900 = 15 minutes (one window duration in seconds)
    const windowEpochSec = Math.floor(closeMs / 1000) - 900;

    // Slice data for this window using binary search on _ms
    const winRtds = sliceByTime(rtdsTicks, openMs, closeMs);
    const winClobRaw = sliceByTime(clobSnapshots, openMs, closeMs);
    const winExchangeRaw = sliceByTime(exchangeTicks, openMs, closeMs);

    // Filter CLOB for correct epoch + token + active range
    const winClob = filterClobForWindow(winClobRaw, win.symbol, windowEpochSec);

    // Filter exchange ticks by symbol
    const winSymbol = win.symbol?.toLowerCase();
    let winExchange;
    if (winSymbol) {
      winExchange = [];
      for (let i = 0; i < winExchangeRaw.length; i++) {
        if (winExchangeRaw[i].symbol?.toLowerCase() === winSymbol) {
          winExchange.push(winExchangeRaw[i]);
        }
      }
    } else {
      winExchange = winExchangeRaw;
    }

    // Slice L2 data for this window
    let winL2 = [];
    if (l2BookTicks?.length > 0) {
      const l2Raw = sliceByTime(l2BookTicks, openMs, closeMs);
      if (winSymbol) {
        for (let i = 0; i < l2Raw.length; i++) {
          if (l2Raw[i].symbol?.toLowerCase().startsWith(winSymbol)) {
            winL2.push(l2Raw[i]);
          }
        }
      } else {
        winL2 = l2Raw;
      }
    }

    // Build merged timeline via N-way merge (O(n))
    const timeline = mergeTimeline(winRtds, winClob, winExchange, winL2);

    // Evaluate each strategy on this window's timeline
    for (let s = 0; s < strategies.length; s++) {
      const strategy = strategies[s];

      const result = evaluateWindow({
        window: win,
        timeline,
        strategy,
        strategyConfig: strategy.defaults || {},
        initialCapital,
        spreadBuffer,
        tradingFee,
        windowDurationMs,
      });

      strategyWindowResults[strategy.name].push(result);
    }
  }

  const elapsedMs = Date.now() - startTime;

  // Aggregate results per strategy
  const results = {};
  for (const strategy of strategies) {
    results[strategy.name] = aggregateResults(
      strategyWindowResults[strategy.name],
      {
        strategy,
        strategyConfig: strategy.defaults || {},
        initialCapital,
        elapsedMs,
        windowCount: windows.length,
      }
    );
  }

  return results;
}
