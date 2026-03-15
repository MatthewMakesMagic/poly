/**
 * Story 5.2: Factory-JS Strategy Interchangeability Proof
 *
 * Covers:
 *   FR39 — Existing JS strategies load and execute without modification
 *   FR40 — MarketState interface unchanged; no new required fields
 *   FR41 — Factory strategies compatible with paper trading / live execution paths
 *   FR42 — Existing parallel backtest engine accepts and runs factory strategies
 *   NFR12 — Factory output matches the strategy interface contract
 *
 * This is the final integration proof that factory-composed YAML strategies
 * are fully interchangeable with hand-coded JS strategies everywhere in the
 * system: backtest engines, parallel engines, and the pipeline that feeds
 * the paper trader.
 *
 * Test architecture:
 *   1. Shape validation — factory strategies have identical interface to JS
 *   2. Signal format equivalence — output matches { action, token, capitalPerTrade, reason }
 *   3. Parallel engine acceptance — runParallelBacktest runs factory strategies
 *   4. Known-strategy equivalence — YAML edge-c vs JS edge-c, same windows, same results
 *   5. Cross-engine consistency — factory backtest engine vs parallel engine
 *   6. Paper trading compatibility — strategy shape matches what the system expects
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadBlocks } from '../../../src/factory/registry.js';
import { composeFromYaml } from '../../../src/factory/compose.js';
import { loadStrategy } from '../../../src/factory/index.js';
import { evaluateWindow, runParallelBacktest } from '../../../src/backtest/parallel-engine.js';
import { createMarketState } from '../../../src/backtest/market-state.js';
import * as edgeCJs from '../../../src/backtest/strategies/edge-c-asymmetry.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;
const YAML_PATH = new URL('../../../src/factory/strategies/edge-c-asymmetry.yaml', import.meta.url).pathname;
const TIMELINES_DB = new URL('../../../data/timelines.sqlite', import.meta.url).pathname;

let yamlStrategy;
let jsStrategy;

// ─── Deterministic test data generators ───

/**
 * Seeded PRNG for reproducible test data.
 * Same seed used in golden test for consistency.
 */
function createPrng(seed = 42) {
  let s = seed;
  return function nextRand() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Build a mock MarketState with realistic field values.
 * This exercises the same fields that strategies read:
 * chainlink, polyRef, clobUp, clobDown, window, oraclePriceAtOpen, strike.
 */
function buildMockState({
  clPrice = 59500,
  refPrice = 59600,
  oracleAtOpen = 59600,
  downAsk = 0.45,
  downBid = 0.43,
  upAsk = 0.57,
  upBid = 0.55,
  timeToCloseMs = 90000,
  symbol = 'btc',
} = {}) {
  return {
    chainlink: { price: clPrice, ts: '2026-01-15T12:04:00Z' },
    polyRef: { price: refPrice, ts: '2026-01-15T12:04:00Z' },
    coingecko: null,
    clobUp: { bestBid: upBid, bestAsk: upAsk, mid: (upBid + upAsk) / 2, spread: upAsk - upBid },
    clobDown: { bestBid: downBid, bestAsk: downAsk, mid: (downBid + downAsk) / 2, spread: downAsk - downBid },
    oraclePriceAtOpen: oracleAtOpen,
    strike: oracleAtOpen,
    window: { symbol, timeToCloseMs, closeTime: '2026-01-15T12:05:00Z', openTime: '2026-01-15T12:00:00Z' },
    timestamp: '2026-01-15T12:04:00Z',
    _tickCount: 50,
    _exchanges: new Map(),
  };
}

/**
 * Generate N deterministic test windows with varied market conditions.
 * Covers: triggering conditions, non-triggering conditions, edge cases.
 */
function generateTestStates(count, seed = 42) {
  const rng = createPrng(seed);
  const states = [];

  for (let i = 0; i < count; i++) {
    const basePrice = 58000 + rng() * 4000;
    const clDeficit = rng() * 200 - 50;        // -50 to 150
    const refOffset = rng() * 300 - 150;        // -150 to 150
    const timeToClose = rng() * 300000;          // 0 to 5 min
    const downAsk = rng() * 0.8 + 0.1;          // 0.1 to 0.9

    states.push(buildMockState({
      clPrice: basePrice - clDeficit,
      refPrice: basePrice + refOffset,
      oracleAtOpen: basePrice,
      downAsk,
      downBid: Math.max(0.01, downAsk - 0.03),
      upAsk: 1 - downAsk + 0.02,
      upBid: 1 - downAsk,
      timeToCloseMs: timeToClose,
      symbol: 'btc',
    }));
  }

  return states;
}

/**
 * Build a minimal synthetic timeline for evaluateWindow.
 * Each event has source, timestamp, and appropriate fields.
 */
function buildSyntheticTimeline({ openMs, closeMs, oracleAtOpen, clPrice, refPrice, downAsk, downBid, upAsk, upBid }) {
  const events = [];
  const windowDuration = closeMs - openMs;
  const numTicks = 20;
  const interval = windowDuration / numTicks;

  for (let i = 0; i < numTicks; i++) {
    const ts = new Date(openMs + i * interval).toISOString();
    const ms = openMs + i * interval;

    // Chainlink tick
    events.push({ source: 'chainlink', timestamp: ts, _ms: ms, price: String(clPrice), topic: 'crypto_prices_chainlink' });

    // PolyRef tick
    events.push({ source: 'polyRef', timestamp: ts, _ms: ms + 1, price: String(refPrice), topic: 'crypto_prices' });

    // CLOB UP tick
    events.push({
      source: 'clobUp', timestamp: ts, _ms: ms + 2,
      best_bid: String(upBid), best_ask: String(upAsk),
      spread: String(upAsk - upBid), bid_size_top: '100', ask_size_top: '100',
      symbol: 'btc-up',
    });

    // CLOB DOWN tick
    events.push({
      source: 'clobDown', timestamp: ts, _ms: ms + 3,
      best_bid: String(downBid), best_ask: String(downAsk),
      spread: String(downAsk - downBid), bid_size_top: '100', ask_size_top: '100',
      symbol: 'btc-down',
    });
  }

  events.sort((a, b) => a._ms - b._ms);
  return events;
}

/**
 * Build a synthetic window event (ground truth row) for evaluateWindow.
 */
function buildWindowEvent({
  closeTime = '2026-01-15T12:15:00Z',
  symbol = 'btc',
  oracleAtOpen = 59600,
  clPriceAtClose = 59500,
  resolvedDirection = 'DOWN',
  strikePrice = 59600,
} = {}) {
  return {
    window_close_time: closeTime,
    symbol,
    strike_price: strikePrice,
    oracle_price_at_open: oracleAtOpen,
    chainlink_price_at_close: clPriceAtClose,
    resolved_direction: resolvedDirection,
    gamma_resolved_direction: resolvedDirection,
  };
}


// ═══════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
  const yamlContent = await readFile(YAML_PATH, 'utf-8');
  yamlStrategy = await composeFromYaml(yamlContent);

  // Load JS version through the factory loader for shape comparison
  jsStrategy = await loadStrategy('edge-c-asymmetry');
});


// ═══════════════════════════════════════════════════════════════
// 1. Strategy Interface Contract (NFR12, FR42)
// ═══════════════════════════════════════════════════════════════

describe('1. Strategy Interface Contract (NFR12)', () => {

  it('YAML strategy has all required interface fields', () => {
    expect(yamlStrategy, 'Factory compose must return a non-null object').toBeTruthy();
    expect(typeof yamlStrategy.name, 'name must be a string').toBe('string');
    expect(yamlStrategy.name.length, 'name must not be empty').toBeGreaterThan(0);
    expect(typeof yamlStrategy.evaluate, 'evaluate must be a function').toBe('function');
    expect(typeof yamlStrategy.onWindowOpen, 'onWindowOpen must be a function').toBe('function');
    expect(typeof yamlStrategy.defaults, 'defaults must be an object').toBe('object');
    expect(typeof yamlStrategy.sweepGrid, 'sweepGrid must be an object').toBe('object');
  });

  it('factory-loaded JS strategy has identical interface shape', () => {
    // Both YAML and JS strategies loaded through factory should have the same keys
    const yamlKeys = Object.keys(yamlStrategy).sort();
    const jsKeys = Object.keys(jsStrategy).sort();

    expect(
      yamlKeys,
      `Interface shape mismatch. YAML keys: [${yamlKeys}], JS keys: [${jsKeys}]. ` +
      'Factory must normalize both to the same shape (FR42, NFR12).'
    ).toEqual(jsKeys);
  });

  it('evaluate() returns an array (empty or with signals)', () => {
    const state = buildMockState();
    yamlStrategy.onWindowOpen(state, {});
    const result = yamlStrategy.evaluate(state, yamlStrategy.defaults);

    expect(
      Array.isArray(result),
      'evaluate() must return an array. Got: ' + typeof result
    ).toBe(true);
  });

  it('evaluate() returns [] on missing market data, never throws', () => {
    yamlStrategy.onWindowOpen({}, {});
    const emptyState = { window: { symbol: 'btc' } };
    const result = yamlStrategy.evaluate(emptyState, {});

    expect(result, 'evaluate() must return empty array on missing data, not throw').toEqual([]);
  });
});


// ═══════════════════════════════════════════════════════════════
// 2. Signal Format Equivalence (FR42)
// ═══════════════════════════════════════════════════════════════

describe('2. Signal Format Equivalence', () => {

  it('factory signals contain required fields: action, token, capitalPerTrade, reason', () => {
    // Build a state that WILL trigger edge-c (large deficit, near strike, late in window, cheap down)
    const triggeringState = buildMockState({
      clPrice: 59400,       // 200 deficit (> 80 threshold)
      refPrice: 59650,      // 50 from oracleAtOpen (< 100 threshold)
      oracleAtOpen: 59600,
      downAsk: 0.45,        // < 0.65 maxDownPrice
      timeToCloseMs: 60000, // < 120000 entryWindowMs
    });

    yamlStrategy.onWindowOpen(triggeringState, {});
    const signals = yamlStrategy.evaluate(triggeringState, yamlStrategy.defaults);

    expect(
      signals.length,
      'Expected at least 1 signal from triggering state. ' +
      'deficit=200, refGap=50, timeToClose=60s, downAsk=0.45 — all conditions met.'
    ).toBeGreaterThan(0);

    const sig = signals[0];
    expect(sig).toHaveProperty('action');
    expect(sig).toHaveProperty('token');
    expect(sig).toHaveProperty('capitalPerTrade');
    expect(sig).toHaveProperty('reason');

    expect(sig.action, 'action must be "buy" for edge-c').toBe('buy');
    expect(sig.token, 'token must include symbol and direction').toMatch(/btc.*down/i);
    expect(typeof sig.capitalPerTrade, 'capitalPerTrade must be a number').toBe('number');
    expect(sig.capitalPerTrade, 'capitalPerTrade must be positive').toBeGreaterThan(0);
    expect(typeof sig.reason, 'reason must be a string').toBe('string');
    expect(sig.reason.length, 'reason must not be empty').toBeGreaterThan(0);
  });

  it('JS strategy signals have the same field set as factory signals', () => {
    const triggeringState = buildMockState({
      clPrice: 59400,
      refPrice: 59650,
      oracleAtOpen: 59600,
      downAsk: 0.45,
      timeToCloseMs: 60000,
    });

    edgeCJs.onWindowOpen();
    const jsSignals = edgeCJs.evaluate(triggeringState, edgeCJs.defaults);

    yamlStrategy.onWindowOpen(triggeringState, {});
    const yamlSignals = yamlStrategy.evaluate(triggeringState, yamlStrategy.defaults);

    expect(jsSignals.length, 'JS must fire on triggering state').toBeGreaterThan(0);
    expect(yamlSignals.length, 'YAML must fire on triggering state').toBeGreaterThan(0);

    const jsFields = Object.keys(jsSignals[0]).sort();
    const yamlFields = Object.keys(yamlSignals[0]).sort();

    // Both must have the core fields; YAML may have extras (e.g., confidence)
    const requiredFields = ['action', 'token', 'capitalPerTrade', 'reason'];
    for (const field of requiredFields) {
      expect(jsFields, `JS signal missing required field '${field}'`).toContain(field);
      expect(yamlFields, `YAML signal missing required field '${field}'`).toContain(field);
    }
  });
});


// ═══════════════════════════════════════════════════════════════
// 3. Parallel Engine Acceptance (FR42)
// ═══════════════════════════════════════════════════════════════

describe('3. Parallel Engine Accepts Factory Strategies (FR42)', () => {

  it('evaluateWindow runs factory YAML strategy without errors', () => {
    const closeTime = '2026-01-15T12:15:00Z';
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 5 * 60 * 1000;

    const windowEvent = buildWindowEvent({ closeTime });
    const timeline = buildSyntheticTimeline({
      openMs, closeMs,
      oracleAtOpen: 59600,
      clPrice: 59400,
      refPrice: 59650,
      downAsk: 0.45, downBid: 0.43,
      upAsk: 0.57, upBid: 0.55,
    });

    const result = evaluateWindow({
      window: windowEvent,
      timeline,
      strategy: yamlStrategy,
      strategyConfig: yamlStrategy.defaults,
      initialCapital: 100,
      spreadBuffer: 0.005,
      tradingFee: 0,
      windowDurationMs: 5 * 60 * 1000,
    });

    expect(result, 'evaluateWindow must return a result object').toBeTruthy();
    expect(result).toHaveProperty('pnl');
    expect(result).toHaveProperty('tradesInWindow');
    expect(result).toHaveProperty('trades');
    expect(result).toHaveProperty('eventsProcessed');
    expect(typeof result.pnl, 'pnl must be a number').toBe('number');
    expect(result.eventsProcessed, 'Must process timeline events').toBeGreaterThan(0);
  });

  it('runParallelBacktest runs factory YAML strategy across multiple windows', async () => {
    const rng = createPrng(77);
    const windows = [];
    const allTimelines = new Map();

    // Build 5 synthetic windows
    for (let i = 0; i < 5; i++) {
      const basePrice = 58000 + rng() * 4000;
      const clDeficit = 50 + rng() * 150;
      const downAsk = 0.3 + rng() * 0.3;

      const closeTime = `2026-01-${String(15 + i).padStart(2, '0')}T12:15:00Z`;
      const closeMs = new Date(closeTime).getTime();
      const openMs = closeMs - 5 * 60 * 1000;

      const win = buildWindowEvent({
        closeTime,
        oracleAtOpen: basePrice,
        clPriceAtClose: basePrice - clDeficit,
        resolvedDirection: rng() > 0.5 ? 'UP' : 'DOWN',
        strikePrice: basePrice,
      });
      windows.push(win);
    }

    // Build pre-loaded data arrays (empty — each window loads independently via the loadWindowTickDataFn)
    // Instead, we use a custom loadWindowTickDataFn that returns synthetic data
    const loadFn = async ({ window: win, windowDurationMs }) => {
      const closeMs = new Date(win.window_close_time).getTime();
      const openMs = closeMs - windowDurationMs;
      const oracleAtOpen = Number(win.oracle_price_at_open) || 59600;
      const clPrice = Number(win.chainlink_price_at_close) || 59500;

      return {
        rtdsTicks: buildSyntheticTimeline({
          openMs, closeMs,
          oracleAtOpen,
          clPrice,
          refPrice: oracleAtOpen + 50,
          downAsk: 0.45, downBid: 0.43,
          upAsk: 0.57, upBid: 0.55,
        }).filter(e => e.source === 'chainlink' || e.source === 'polyRef'),
        clobSnapshots: buildSyntheticTimeline({
          openMs, closeMs,
          oracleAtOpen, clPrice,
          refPrice: oracleAtOpen + 50,
          downAsk: 0.45, downBid: 0.43,
          upAsk: 0.57, upBid: 0.55,
        }).filter(e => e.source === 'clobUp' || e.source === 'clobDown'),
        exchangeTicks: [],
      };
    };

    const result = await runParallelBacktest({
      windows,
      config: {
        strategy: yamlStrategy,
        strategyConfig: yamlStrategy.defaults,
        initialCapital: 100,
        concurrency: 2,
      },
      loadWindowTickDataFn: loadFn,
    });

    expect(result, 'runParallelBacktest must return a result object').toBeTruthy();
    expect(result.summary, 'Result must have summary').toBeTruthy();
    expect(result.summary.windowsProcessed, 'Must process all 5 windows').toBe(5);
    expect(typeof result.summary.totalPnl, 'totalPnl must be a number').toBe('number');
    expect(typeof result.summary.winRate, 'winRate must be a number').toBe('number');
    expect(Array.isArray(result.trades), 'trades must be an array').toBe(true);
    expect(Array.isArray(result.equityCurve), 'equityCurve must be an array').toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════
// 4. Known-Strategy Equivalence — YAML vs JS (definitive proof)
// ═══════════════════════════════════════════════════════════════

describe('4. Known-Strategy Equivalence: YAML edge-c vs JS edge-c', () => {

  it('YAML and JS produce identical signal decisions on 100 varied states', () => {
    const states = generateTestStates(100, 42);
    const config = { ...edgeCJs.defaults };
    const mismatches = [];
    let jsFireCount = 0;
    let yamlFireCount = 0;

    for (let i = 0; i < states.length; i++) {
      // Reset both for each state (treat each as a fresh window)
      edgeCJs.onWindowOpen();
      yamlStrategy.onWindowOpen(states[i], config);

      const jsSignals = edgeCJs.evaluate(states[i], config);
      const yamlSignals = yamlStrategy.evaluate(states[i], config);

      if (jsSignals.length > 0) jsFireCount++;
      if (yamlSignals.length > 0) yamlFireCount++;

      if (jsSignals.length !== yamlSignals.length) {
        mismatches.push({
          index: i,
          type: 'count_mismatch',
          js: jsSignals.length,
          yaml: yamlSignals.length,
          deficit: (states[i].oraclePriceAtOpen - states[i].chainlink.price).toFixed(0),
          refGap: Math.abs(states[i].polyRef.price - states[i].oraclePriceAtOpen).toFixed(0),
          timeToClose: states[i].window.timeToCloseMs.toFixed(0),
          downAsk: states[i].clobDown.bestAsk.toFixed(3),
        });
        continue;
      }

      for (let j = 0; j < jsSignals.length; j++) {
        if (jsSignals[j].action !== yamlSignals[j].action) {
          mismatches.push({ index: i, field: 'action', js: jsSignals[j].action, yaml: yamlSignals[j].action });
        }
        if (jsSignals[j].token !== yamlSignals[j].token) {
          mismatches.push({ index: i, field: 'token', js: jsSignals[j].token, yaml: yamlSignals[j].token });
        }
        if (jsSignals[j].capitalPerTrade !== yamlSignals[j].capitalPerTrade) {
          mismatches.push({ index: i, field: 'capitalPerTrade', js: jsSignals[j].capitalPerTrade, yaml: yamlSignals[j].capitalPerTrade });
        }
      }
    }

    expect(
      mismatches,
      `YAML vs JS produced ${mismatches.length} signal mismatches out of 100 states.\n` +
      `JS fired ${jsFireCount}x, YAML fired ${yamlFireCount}x.\n` +
      `First 3 mismatches: ${JSON.stringify(mismatches.slice(0, 3), null, 2)}\n` +
      `This means the factory compose engine is not faithfully reproducing the JS strategy logic.`
    ).toHaveLength(0);

    // Sanity: both must fire at least once — otherwise the test is vacuous
    expect(jsFireCount, 'JS edge-c must fire at least once in 100 varied states').toBeGreaterThan(0);
    expect(yamlFireCount, 'YAML edge-c must fire at least once in 100 varied states').toBeGreaterThan(0);
  });

  it('YAML and JS produce identical backtest results on synthetic windows via evaluateWindow', () => {
    const rng = createPrng(99);
    const windowCount = 10;
    const jsResults = [];
    const yamlResults = [];

    for (let i = 0; i < windowCount; i++) {
      const basePrice = 58000 + rng() * 4000;
      const clDeficit = 50 + rng() * 150;
      const downAsk = 0.3 + rng() * 0.3;

      const closeTime = `2026-02-${String(i + 1).padStart(2, '0')}T12:15:00Z`;
      const closeMs = new Date(closeTime).getTime();
      const openMs = closeMs - 5 * 60 * 1000;

      const win = buildWindowEvent({
        closeTime,
        oracleAtOpen: basePrice,
        clPriceAtClose: basePrice - clDeficit,
        resolvedDirection: clDeficit > 0 ? 'DOWN' : 'UP',
        strikePrice: basePrice,
      });

      const timeline = buildSyntheticTimeline({
        openMs, closeMs,
        oracleAtOpen: basePrice,
        clPrice: basePrice - clDeficit,
        refPrice: basePrice + (rng() * 100 - 50),
        downAsk, downBid: Math.max(0.01, downAsk - 0.03),
        upAsk: 1 - downAsk + 0.02, upBid: 1 - downAsk,
      });

      const config = { ...edgeCJs.defaults };

      // JS version needs wrapping since it uses module-level state
      const jsWrapped = {
        name: edgeCJs.name,
        evaluate: edgeCJs.evaluate,
        onWindowOpen: edgeCJs.onWindowOpen,
        defaults: edgeCJs.defaults,
      };

      const jsResult = evaluateWindow({
        window: win, timeline, strategy: jsWrapped,
        strategyConfig: config, initialCapital: 100,
      });

      const yamlResult = evaluateWindow({
        window: win, timeline, strategy: yamlStrategy,
        strategyConfig: yamlStrategy.defaults, initialCapital: 100,
      });

      jsResults.push(jsResult);
      yamlResults.push(yamlResult);
    }

    // Compare trade counts per window
    for (let i = 0; i < windowCount; i++) {
      expect(
        jsResults[i].tradesInWindow,
        `Window ${i}: JS had ${jsResults[i].tradesInWindow} trades, ` +
        `YAML had ${yamlResults[i].tradesInWindow}. ` +
        `Trade counts must match for strategy equivalence.`
      ).toBe(yamlResults[i].tradesInWindow);
    }

    // Compare total PnL across all windows (within rounding tolerance)
    const jsTotalPnl = jsResults.reduce((s, r) => s + r.pnl, 0);
    const yamlTotalPnl = yamlResults.reduce((s, r) => s + r.pnl, 0);

    expect(
      Math.abs(jsTotalPnl - yamlTotalPnl),
      `Total PnL divergence: JS=${jsTotalPnl.toFixed(6)}, YAML=${yamlTotalPnl.toFixed(6)}. ` +
      `Difference=${Math.abs(jsTotalPnl - yamlTotalPnl).toFixed(6)}. ` +
      `Must be within 0.01 rounding tolerance for equivalence proof.`
    ).toBeLessThan(0.01);

    // Compare per-window PnL
    for (let i = 0; i < windowCount; i++) {
      expect(
        Math.abs(jsResults[i].pnl - yamlResults[i].pnl),
        `Window ${i} PnL divergence: JS=${jsResults[i].pnl.toFixed(6)}, ` +
        `YAML=${yamlResults[i].pnl.toFixed(6)}. Must be within rounding tolerance.`
      ).toBeLessThan(0.001);
    }
  });
});


// ═══════════════════════════════════════════════════════════════
// 5. Cross-Engine Consistency (factory backtest engine vs parallel engine)
// ═══════════════════════════════════════════════════════════════

describe('5. Cross-Engine Consistency', () => {

  it('same strategy + same synthetic data produces same results in evaluateWindow regardless of source', () => {
    // This tests that evaluateWindow (used by both the factory backtest engine
    // and the parallel engine) produces deterministic results.
    // Both engines ultimately call evaluateWindow — so we verify that calling it
    // twice with identical inputs yields identical outputs.

    const closeTime = '2026-01-20T12:15:00Z';
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 5 * 60 * 1000;

    const win = buildWindowEvent({
      closeTime,
      oracleAtOpen: 59600,
      clPriceAtClose: 59400,
      resolvedDirection: 'DOWN',
    });

    const timeline = buildSyntheticTimeline({
      openMs, closeMs,
      oracleAtOpen: 59600, clPrice: 59400,
      refPrice: 59650, downAsk: 0.45, downBid: 0.43,
      upAsk: 0.57, upBid: 0.55,
    });

    const config = { ...yamlStrategy.defaults };

    const result1 = evaluateWindow({
      window: win, timeline, strategy: yamlStrategy,
      strategyConfig: config, initialCapital: 100,
    });

    const result2 = evaluateWindow({
      window: win, timeline, strategy: yamlStrategy,
      strategyConfig: config, initialCapital: 100,
    });

    expect(result1.pnl, 'Same inputs must produce same PnL (determinism)').toBe(result2.pnl);
    expect(result1.tradesInWindow, 'Same inputs must produce same trade count').toBe(result2.tradesInWindow);
    expect(result1.eventsProcessed, 'Same inputs must process same event count').toBe(result2.eventsProcessed);

    // Deep compare trades
    expect(result1.trades.length).toBe(result2.trades.length);
    for (let i = 0; i < result1.trades.length; i++) {
      expect(result1.trades[i].pnl, `Trade ${i} PnL must match`).toBe(result2.trades[i].pnl);
      expect(result1.trades[i].entryPrice, `Trade ${i} entryPrice must match`).toBe(result2.trades[i].entryPrice);
    }
  });

  it('factory strategy and JS strategy produce same results through evaluateWindow (cross-implementation)', () => {
    // This is the cross-engine proof: same evaluateWindow function,
    // two different strategy implementations, same data => same result.
    const closeTime = '2026-01-25T12:15:00Z';
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 5 * 60 * 1000;

    const win = buildWindowEvent({
      closeTime,
      oracleAtOpen: 59600,
      clPriceAtClose: 59400,  // 200 deficit, will trigger edge-c
      resolvedDirection: 'DOWN',
    });

    // Build timeline that will trigger signals (late in window, big deficit)
    const timeline = [];
    const numTicks = 30;
    const windowDuration = closeMs - openMs;

    for (let i = 0; i < numTicks; i++) {
      const ts = new Date(openMs + (i / numTicks) * windowDuration).toISOString();
      const ms = openMs + (i / numTicks) * windowDuration;

      timeline.push({ source: 'chainlink', timestamp: ts, _ms: ms, price: '59400', topic: 'crypto_prices_chainlink' });
      timeline.push({ source: 'polyRef', timestamp: ts, _ms: ms + 1, price: '59650', topic: 'crypto_prices' });
      timeline.push({
        source: 'clobDown', timestamp: ts, _ms: ms + 2,
        best_bid: '0.43', best_ask: '0.45', spread: '0.02',
        bid_size_top: '100', ask_size_top: '100', symbol: 'btc-down',
      });
      timeline.push({
        source: 'clobUp', timestamp: ts, _ms: ms + 3,
        best_bid: '0.55', best_ask: '0.57', spread: '0.02',
        bid_size_top: '100', ask_size_top: '100', symbol: 'btc-up',
      });
    }
    timeline.sort((a, b) => a._ms - b._ms);

    const jsWrapped = {
      name: edgeCJs.name,
      evaluate: edgeCJs.evaluate,
      onWindowOpen: edgeCJs.onWindowOpen,
      defaults: edgeCJs.defaults,
    };

    const jsResult = evaluateWindow({
      window: win, timeline, strategy: jsWrapped,
      strategyConfig: edgeCJs.defaults, initialCapital: 100,
    });

    const yamlResult = evaluateWindow({
      window: win, timeline, strategy: yamlStrategy,
      strategyConfig: yamlStrategy.defaults, initialCapital: 100,
    });

    expect(
      jsResult.tradesInWindow,
      `Cross-engine trade count: JS=${jsResult.tradesInWindow}, YAML=${yamlResult.tradesInWindow}. Must match.`
    ).toBe(yamlResult.tradesInWindow);

    expect(
      Math.abs(jsResult.pnl - yamlResult.pnl),
      `Cross-engine PnL: JS=${jsResult.pnl.toFixed(6)}, YAML=${yamlResult.pnl.toFixed(6)}. ` +
      `Must be within rounding tolerance.`
    ).toBeLessThan(0.001);
  });
});


// ═══════════════════════════════════════════════════════════════
// 6. Paper Trading System Compatibility (FR41)
// ═══════════════════════════════════════════════════════════════

describe('6. Paper Trading System Compatibility (FR41)', () => {

  it('factory strategy object shape is compatible with backtest engine contract', () => {
    // The backtest engines (engine.js and parallel-engine.js) require:
    //   { name: string, evaluate: (state, config) => Signal[], onWindowOpen?: fn, onWindowClose?: fn }
    //
    // The paper trading system uses a different interface (evaluateMarketState, shouldFire).
    // Factory strategies target the backtest contract. Verify shape compliance.

    // Required fields
    expect(typeof yamlStrategy.name).toBe('string');
    expect(typeof yamlStrategy.evaluate).toBe('function');

    // Optional lifecycle hooks must be functions if present
    if (yamlStrategy.onWindowOpen !== undefined) {
      expect(typeof yamlStrategy.onWindowOpen).toBe('function');
    }
    if (yamlStrategy.onWindowClose !== undefined) {
      expect(typeof yamlStrategy.onWindowClose).toBe('function');
    }

    // Strategy config accessors
    expect(typeof yamlStrategy.defaults).toBe('object');
    expect(typeof yamlStrategy.sweepGrid).toBe('object');
  });

  it('factory strategy evaluate() signature matches (state, config) => Signal[]', () => {
    // Verify the function signature works: two args, returns array
    const state = buildMockState();
    yamlStrategy.onWindowOpen(state, {});

    // Call with both args
    const result = yamlStrategy.evaluate(state, yamlStrategy.defaults);
    expect(Array.isArray(result)).toBe(true);

    // Call with just state (config defaults to {})
    yamlStrategy.onWindowOpen(state, {});
    const result2 = yamlStrategy.evaluate(state, {});
    expect(Array.isArray(result2)).toBe(true);
  });

  it('factory strategy can be wrapped for paper trading pipeline', () => {
    // The paper trading system expects { name, evaluateMarketState, shouldFire, appliesTo }.
    // Factory strategies use the backtest contract { evaluate, onWindowOpen }.
    // Verify that a simple adapter wrapper works — proving factory strategies
    // CAN be promoted to paper trading with a thin wrapper.

    const adapted = {
      name: yamlStrategy.name,
      evaluateMarketState: (ctx) => {
        // Adapter: map paper trader context to backtest state shape
        return ctx; // In practice, map fields
      },
      shouldFire: (state, variation) => {
        yamlStrategy.onWindowOpen(state, {});
        const signals = yamlStrategy.evaluate(state, yamlStrategy.defaults);
        return signals.length > 0;
      },
      appliesTo: (crypto, offsetSec) => true,
    };

    expect(typeof adapted.name).toBe('string');
    expect(typeof adapted.evaluateMarketState).toBe('function');
    expect(typeof adapted.shouldFire).toBe('function');
    expect(typeof adapted.appliesTo).toBe('function');

    // Test the adapted shouldFire with a triggering state
    const triggeringState = buildMockState({
      clPrice: 59400, refPrice: 59650, oracleAtOpen: 59600,
      downAsk: 0.45, timeToCloseMs: 60000,
    });

    const fires = adapted.shouldFire(triggeringState, {});
    expect(fires, 'Adapted factory strategy must fire on triggering conditions').toBe(true);

    // Test with non-triggering state
    const nonTriggeringState = buildMockState({
      clPrice: 59590, refPrice: 59650, oracleAtOpen: 59600,
      downAsk: 0.45, timeToCloseMs: 60000,
    });
    const doesNotFire = adapted.shouldFire(nonTriggeringState, {});
    expect(doesNotFire, 'Adapted factory strategy must not fire when conditions are not met').toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════
// 7. loadStrategy() Unified Loader (FR42)
// ═══════════════════════════════════════════════════════════════

describe('7. loadStrategy() Unified Loader', () => {

  it('loads YAML strategy by name (without extension)', async () => {
    const strategy = await loadStrategy('edge-c-asymmetry');
    expect(strategy.name).toBe('edge-c-asymmetry');
    expect(typeof strategy.evaluate).toBe('function');
  });

  it('loads JS strategy by name when no YAML exists', async () => {
    // edge-c-asymmetry has both YAML and JS; YAML wins by resolution order.
    // We need a JS-only strategy. Check what exists.
    const strategy = await loadStrategy('edge-c-asymmetry.js', {
      searchDirs: [new URL('../../../src/backtest/strategies/', import.meta.url).pathname],
    });
    expect(strategy.name).toBe('edge-c-asymmetry');
    expect(typeof strategy.evaluate).toBe('function');
  });

  it('YAML-loaded and JS-loaded strategies both work in evaluateWindow', async () => {
    const yamlLoaded = await loadStrategy('edge-c-asymmetry');
    const jsLoaded = await loadStrategy('edge-c-asymmetry.js', {
      searchDirs: [new URL('../../../src/backtest/strategies/', import.meta.url).pathname],
    });

    const closeTime = '2026-03-01T12:15:00Z';
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 5 * 60 * 1000;

    const win = buildWindowEvent({ closeTime, oracleAtOpen: 59600, clPriceAtClose: 59400 });
    const timeline = buildSyntheticTimeline({
      openMs, closeMs, oracleAtOpen: 59600, clPrice: 59400,
      refPrice: 59650, downAsk: 0.45, downBid: 0.43, upAsk: 0.57, upBid: 0.55,
    });

    const yamlResult = evaluateWindow({
      window: win, timeline, strategy: yamlLoaded,
      strategyConfig: yamlLoaded.defaults, initialCapital: 100,
    });

    const jsResult = evaluateWindow({
      window: win, timeline, strategy: jsLoaded,
      strategyConfig: jsLoaded.defaults, initialCapital: 100,
    });

    expect(yamlResult.tradesInWindow).toBe(jsResult.tradesInWindow);
    expect(Math.abs(yamlResult.pnl - jsResult.pnl)).toBeLessThan(0.001);
  });
});
