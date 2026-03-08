/**
 * Continuous MM: BS-Conviction Pair-Hedge Strategy — 50-Variation Sweep
 *
 * Multi-mode conviction hedging with all available data sources:
 *   - BS fair value (CL spot, exchange-gap-adjusted spot)
 *   - CLOB-implied probability (market's own conviction)
 *   - CLOB momentum (drop from peak)
 *   - Exchange momentum (raw exchange signal)
 *   - Hybrid combinations (BS + CLOB agreement)
 *   - Reverse hedging (lock in profit when winning)
 *   - Dynamic floors, sizing, timing experiments
 */

import {
  initMm,
  onWindowOpenBase,
  onPassiveFillBase,
  evaluateBase,
} from './mm-continuous-base.js';

export const name = 'mm-cs-pair-hedge';
export const description = 'Party-mode variations: exch-vol, CLOB gate, sell-to-close, dynamic offset';
export const usesPassiveOrders = true;

export const defaults = {
  entryWindowMs: 840000,
  exitWindowMs: 30000,
  maxEntryPrice: 0.999,
  minEntryPrice: 0.001,
  capitalPerEntry: 1,
  maxPerSide: 50,
  requoteThreshold: 0.005,
  baseOffset: 0.01,
  hedgeMode: 'bs-conviction',
  maxPairCost: 1.05,
  hedgeForceTimeMs: 60000,
  hedgeCapital: 50,
  sweepBook: true,
  convictionFloor: 0.40,
  minVolSamples: 10,
  windowDurationMs: 900000,
  // Multi-mode params
  spotSource: 'cl',             // 'cl' | 'exchange' | 'exchange-gap'
  convictionMode: 'bs',         // 'bs' | 'clob-mid' | 'clob-momentum' | 'hybrid-and' | 'hybrid-or' | 'reverse' | 'exch-momentum'
  structuralGap: 46,            // $ gap between exchange median and CL
  clobFloor: 0.40,              // floor for CLOB-mid modes
  clobMomentumDrop: 0.15,       // fraction drop from peak for CLOB-momentum
  reverseFloor: 0.70,           // pair off when winning above this
  exchMomentumThreshold: 100,   // $ move for exchange momentum
  quoteSide: 'both',            // 'both' | 'up' | 'down'
  dynamicFloor: null,           // null | 'tighten' | 'relax'
  // V31 fix params
  fairValueGate: false,         // Only quote side when BS P(side) >= fvGateThreshold
  fvGateThreshold: 0.45,        // Fair value gate threshold
  safetyNet: false,             // Stop quoting at T-60s
  unconditionalForceHedge: false, // Force hedge at T-60s ignoring BS null + pair cost
  quoteStopMs: 60000,           // Time before close to stop quoting (when safetyNet=true)
  lateHedgeFloor: null,         // Tighter conviction floor in final minute (e.g. 0.50)
  lateHedgeMs: 60000,           // When to switch to lateHedgeFloor
  volSource: null,             // null (use spotSource) | 'exchange' (exchange ticks for sigma)
  clobMidGate: false,          // Use CLOB bestBid as entry gate instead of BS
  sellToClose: false,          // Sell excess at bestBid in sell window
  sellToCloseMs: 30000,        // Time before close to start selling (T-30s default)
  dynamicOffset: false,        // Widen offset when exchange momentum detected
  exchOffsetThreshold: 50,     // $ exchange momentum threshold
  exchOffsetMultiplier: 2,     // Multiply baseOffset on vulnerable side
};

// ─── Variations ───

export const variations = [
  // V1: Baseline — fair value gate only
  { baseOffset: 0.005, fairValueGate: true, fvGateThreshold: 0.45 },
  // V2: Gate + unconditional force hedge at T-60s
  { baseOffset: 0.005, fairValueGate: true, fvGateThreshold: 0.45, unconditionalForceHedge: true },
  // V3: V31 blind quoting (no gate)
  { baseOffset: 0.005 },
  // V4: V31 blind + unconditional force hedge at T-60s
  { baseOffset: 0.005, unconditionalForceHedge: true },
];

// ─── Black-Scholes Binary Fair Value ───

function normalCDF(x) {
  if (x > 6) return 1;
  if (x < -6) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) *
    (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}

// Diagnostic counters for BS null returns
const bsNullReasons = { noSpot: 0, noClOpen: 0, expired: 0, fewSamples: 0, fewReturns: 0, zeroTime: 0, zeroVol: 0, ok: 0 };
export function getBsNullReasons() { return bsNullReasons; }

function computeBSFairValue({ spotNow, clOpen, timeToCloseMs, spotHistory, minSamples }) {
  if (!spotNow || spotNow <= 0) { bsNullReasons.noSpot++; return null; }
  if (!clOpen || clOpen <= 0) { bsNullReasons.noClOpen++; return null; }
  if (timeToCloseMs <= 0) { bsNullReasons.expired++; return null; }
  if (!spotHistory || spotHistory.length < minSamples) { bsNullReasons.fewSamples++; return null; }

  let sumSqReturns = 0;
  let returnCount = 0;
  for (let i = 1; i < spotHistory.length; i++) {
    const dt = (spotHistory[i].ms - spotHistory[i - 1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(spotHistory[i].price / spotHistory[i - 1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) { bsNullReasons.fewReturns++; return null; }

  const totalTimeSec = (spotHistory[spotHistory.length - 1].ms - spotHistory[0].ms) / 1000;
  if (totalTimeSec <= 0) { bsNullReasons.zeroTime++; return null; }
  const avgTimeStepSec = totalTimeSec / returnCount;
  if (avgTimeStepSec <= 0) { bsNullReasons.zeroTime++; return null; }

  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  const sigma = Math.sqrt(varPerSec * 365.25 * 24 * 3600);

  const Tyears = (timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigma * sqrtT < 1e-10) { bsNullReasons.zeroVol++; return null; }

  const d2 = (Math.log(spotNow / clOpen) - 0.5 * sigma * sigma * Tyears) / (sigma * sqrtT);
  const fairUp = normalCDF(d2);

  bsNullReasons.ok++;
  return { fairUp, fairDown: 1 - fairUp, sigma };
}

// ─── Pair Inventory Tracker ───

function initPairTracker(state) {
  if (!state._mmPair) {
    state._mmPair = {
      upTokens: 0, downTokens: 0,
      upCost: 0, downCost: 0,
      hedgeCount: 0, passiveFills: 0,
      // CLOB momentum tracking
      clobUpPeak: 0, clobDownPeak: 0,
    };
  }
  return state._mmPair;
}

function recordFill(token, price, size, isHedge, state) {
  const pt = initPairTracker(state);
  const isUp = token.toLowerCase().includes('-up') || token.toLowerCase().includes('_up');
  if (isUp) {
    pt.upTokens += size;
    pt.upCost += price * size;
  } else {
    pt.downTokens += size;
    pt.downCost += price * size;
  }
  if (isHedge) pt.hedgeCount++;
  else pt.passiveFills++;
}

// ─── Multi-Source History Tracker ───

function initTracker(state) {
  if (!state._hedgeTracker) {
    state._hedgeTracker = {
      clHistory: [],
      exchHistory: [],
      clOpen: null,
    };
  }
  return state._hedgeTracker;
}

function trackAll(state) {
  const tracker = initTracker(state);

  if (!tracker.clOpen && state.oraclePriceAtOpen) {
    tracker.clOpen = state.oraclePriceAtOpen;
  }

  const ms = state.timestamp
    ? (typeof state.timestamp === 'object' ? state.timestamp.getTime() : new Date(state.timestamp).getTime())
    : null;
  if (!ms) return tracker;

  // Track CL
  if (state.chainlink?.price) {
    const lastCl = tracker.clHistory.length > 0 ? tracker.clHistory[tracker.clHistory.length - 1] : null;
    if (!lastCl || state.chainlink.price !== lastCl.price || ms - lastCl.ms > 500) {
      tracker.clHistory.push({ price: state.chainlink.price, ms });
    }
  }

  // Track exchange median
  const exchMedian = state.getExchangeMedian();
  if (exchMedian) {
    const lastEx = tracker.exchHistory.length > 0 ? tracker.exchHistory[tracker.exchHistory.length - 1] : null;
    if (!lastEx || exchMedian !== lastEx.price || ms - lastEx.ms > 500) {
      tracker.exchHistory.push({ price: exchMedian, ms });
    }
  }

  // Track CLOB peaks for momentum mode
  const pt = initPairTracker(state);
  const upBid = state.clobUp?.bestBid;
  const downBid = state.clobDown?.bestBid;
  if (upBid && upBid > pt.clobUpPeak) pt.clobUpPeak = upBid;
  if (downBid && downBid > pt.clobDownPeak) pt.clobDownPeak = downBid;

  return tracker;
}

// ─── Get Spot + History for BS Based on Config ───

function getSpotAndHistory(state, config) {
  const tracker = initTracker(state);
  const clOpen = tracker.clOpen || (tracker.clHistory.length > 0 ? tracker.clHistory[0].price : null);

  let spotNow, spotHistory;

  if (config.spotSource === 'exchange-gap') {
    const exchMedian = state.getExchangeMedian();
    spotNow = exchMedian ? exchMedian - (config.structuralGap || 46) : null;
    spotHistory = tracker.exchHistory;
  } else if (config.spotSource === 'exchange') {
    spotNow = state.getExchangeMedian();
    spotHistory = tracker.exchHistory;
  } else {
    spotNow = state.chainlink?.price;
    spotHistory = tracker.clHistory;
  }

  // Override vol source: use exchange ticks for sigma, keep CL for spot/strike
  if (config.volSource === 'exchange') {
    spotHistory = tracker.exchHistory;
  }

  return { spotNow, clOpen, spotHistory };
}

// ─── Conviction Check (Multi-Mode) ───

function checkConviction(state, config, excessUp, excessDown) {
  const { convictionMode, convictionFloor, clobFloor, clobMomentumDrop,
          reverseFloor, exchMomentumThreshold, minVolSamples, windowDurationMs,
          dynamicFloor, structuralGap } = config;
  const ttc = state.window?.timeToCloseMs;
  const tracker = initTracker(state);
  const pt = initPairTracker(state);

  // Dynamic floor adjustment
  let effectiveBsFloor = convictionFloor;
  let effectiveClobFloor = clobFloor;
  if (dynamicFloor && ttc != null && windowDurationMs > 0) {
    const elapsed = windowDurationMs - ttc;
    const frac = Math.min(1, elapsed / windowDurationMs);
    if (dynamicFloor === 'tighten') {
      // Floor increases from base to base+0.15 over window (more demanding over time)
      effectiveBsFloor = convictionFloor + frac * 0.15;
      effectiveClobFloor = (clobFloor || convictionFloor) + frac * 0.15;
    } else if (dynamicFloor === 'relax') {
      // Floor decreases from base to base-0.15 over window (more patient over time)
      effectiveBsFloor = Math.max(0.10, convictionFloor - frac * 0.15);
      effectiveClobFloor = Math.max(0.10, (clobFloor || convictionFloor) - frac * 0.15);
    }
  }

  const mode = convictionMode || 'bs';

  // ── BS conviction ──
  if (mode === 'bs' || mode === 'hybrid-and' || mode === 'hybrid-or') {
    const { spotNow, clOpen, spotHistory } = getSpotAndHistory(state, config);
    const bs = computeBSFairValue({ spotNow, clOpen, timeToCloseMs: ttc, spotHistory, minSamples: minVolSamples });

    let bsLost = false;
    if (bs) {
      if (excessUp > 0.01 && bs.fairUp < effectiveBsFloor) bsLost = true;
      if (excessDown > 0.01 && bs.fairDown < effectiveBsFloor) bsLost = true;
    }

    if (mode === 'bs') return { lost: bsLost, info: bs ? `BS P(UP)=${bs.fairUp.toFixed(3)} σ=${(bs.sigma*100).toFixed(1)}%` : 'no-bs' };

    // For hybrid modes, also check CLOB
    let clobLost = false;
    if (excessUp > 0.01) {
      const upBid = state.clobUp?.bestBid;
      if (upBid != null && upBid < effectiveClobFloor) clobLost = true;
    } else if (excessDown > 0.01) {
      const downBid = state.clobDown?.bestBid;
      if (downBid != null && downBid < effectiveClobFloor) clobLost = true;
    }

    const bsStr = bs ? `BS=${bs.fairUp.toFixed(3)}` : 'no-bs';
    const clobStr = `CLOB=${excessUp > 0.01 ? (state.clobUp?.bestBid||0).toFixed(3) : (state.clobDown?.bestBid||0).toFixed(3)}`;

    if (mode === 'hybrid-and') return { lost: bsLost && clobLost, info: `AND ${bsStr} ${clobStr}` };
    if (mode === 'hybrid-or') return { lost: bsLost || clobLost, info: `OR ${bsStr} ${clobStr}` };
  }

  // ── CLOB-mid conviction ──
  if (mode === 'clob-mid') {
    let lost = false;
    let info = '';
    if (excessUp > 0.01) {
      const upBid = state.clobUp?.bestBid;
      if (upBid != null && upBid < effectiveClobFloor) lost = true;
      info = `CLOB-UP=${(upBid||0).toFixed(3)} floor=${effectiveClobFloor.toFixed(2)}`;
    } else if (excessDown > 0.01) {
      const downBid = state.clobDown?.bestBid;
      if (downBid != null && downBid < effectiveClobFloor) lost = true;
      info = `CLOB-DN=${(downBid||0).toFixed(3)} floor=${effectiveClobFloor.toFixed(2)}`;
    }
    return { lost, info };
  }

  // ── CLOB momentum ──
  if (mode === 'clob-momentum') {
    let lost = false;
    let info = '';
    if (excessUp > 0.01 && pt.clobUpPeak > 0) {
      const upBid = state.clobUp?.bestBid || 0;
      const drop = (pt.clobUpPeak - upBid) / pt.clobUpPeak;
      if (drop >= clobMomentumDrop) lost = true;
      info = `UP peak=${pt.clobUpPeak.toFixed(3)} now=${upBid.toFixed(3)} drop=${(drop*100).toFixed(1)}%`;
    } else if (excessDown > 0.01 && pt.clobDownPeak > 0) {
      const downBid = state.clobDown?.bestBid || 0;
      const drop = (pt.clobDownPeak - downBid) / pt.clobDownPeak;
      if (drop >= clobMomentumDrop) lost = true;
      info = `DN peak=${pt.clobDownPeak.toFixed(3)} now=${downBid.toFixed(3)} drop=${(drop*100).toFixed(1)}%`;
    }
    return { lost, info };
  }

  // ── Reverse: pair off when WINNING ──
  if (mode === 'reverse') {
    const { spotNow, clOpen, spotHistory } = getSpotAndHistory(state, { ...config, spotSource: 'cl' });
    const bs = computeBSFairValue({ spotNow, clOpen, timeToCloseMs: ttc, spotHistory, minSamples: minVolSamples });
    let lock = false;
    if (bs) {
      if (excessUp > 0.01 && bs.fairUp > reverseFloor) lock = true;
      if (excessDown > 0.01 && bs.fairDown > reverseFloor) lock = true;
    }
    return { lost: lock, info: bs ? `REVERSE BS P(UP)=${bs.fairUp.toFixed(3)}` : 'no-bs' };
  }

  // ── Exchange momentum ──
  if (mode === 'exch-momentum') {
    const exchMedian = state.getExchangeMedian();
    const clOpen = tracker.clOpen;
    if (!exchMedian || !clOpen) return { lost: false, info: 'no-data' };
    const gap = structuralGap || 46;
    const adjusted = exchMedian - gap;
    const diff = adjusted - clOpen;
    let lost = false;
    if (excessUp > 0.01 && diff < -exchMomentumThreshold) lost = true;
    if (excessDown > 0.01 && diff > exchMomentumThreshold) lost = true;
    return { lost, info: `EXCH adj=${adjusted.toFixed(0)} K=${clOpen.toFixed(0)} Δ=${diff.toFixed(0)}` };
  }

  return { lost: false, info: 'unknown-mode' };
}

// ─── Quoting (with optional side restriction) ───

function computeDesiredQuotes(state, config, _mm) {
  const { clobUp, clobDown } = state;
  const { baseOffset, quoteSide, fairValueGate, fvGateThreshold, safetyNet, quoteStopMs, clobMidGate, dynamicOffset } = config;

  // Safety net: stop quoting in final period (default T-60s)
  if (safetyNet && state.window?.timeToCloseMs != null) {
    if (state.window.timeToCloseMs <= (quoteStopMs || 60000)) {
      return { up: null, down: null };
    }
  }

  const upBid = clobUp?.bestBid;
  const downBid = clobDown?.bestBid;
  if ((!upBid || upBid <= 0) && (!downBid || downBid <= 0)) return { up: null, down: null };

  // Entry gate: CLOB-mid or BS fair value
  let allowUp = true, allowDown = true;
  if (clobMidGate) {
    // CLOB-mid gate: only quote side when market bestBid >= threshold
    if (!upBid || upBid < fvGateThreshold) allowUp = false;
    if (!downBid || downBid < fvGateThreshold) allowDown = false;
  } else if (fairValueGate) {
    const { spotNow, clOpen, spotHistory } = getSpotAndHistory(state, config);
    const bs = computeBSFairValue({
      spotNow, clOpen,
      timeToCloseMs: state.window?.timeToCloseMs,
      spotHistory,
      minSamples: config.minVolSamples,
    });
    if (bs) {
      if (bs.fairUp < fvGateThreshold) allowUp = false;
      if (bs.fairDown < fvGateThreshold) allowDown = false;
    } else {
      allowUp = false;
      allowDown = false;
    }
  }

  // Dynamic offset: widen on vulnerable side from exchange momentum
  let upOffset = baseOffset;
  let downOffset = baseOffset;
  if (dynamicOffset) {
    const tracker = initTracker(state);
    const exchMedian = state.getExchangeMedian();
    const clOpen = tracker.clOpen;
    if (exchMedian && clOpen) {
      const gap = config.structuralGap || 46;
      const adjusted = exchMedian - gap;
      const diff = adjusted - clOpen;
      const threshold = config.exchOffsetThreshold || 50;
      const multiplier = config.exchOffsetMultiplier || 2;
      if (diff > threshold) downOffset = baseOffset * multiplier;
      if (diff < -threshold) upOffset = baseOffset * multiplier;
    }
  }

  const result = { up: null, down: null };
  const side = quoteSide || 'both';

  if ((side === 'both' || side === 'up') && allowUp && upBid && upBid > 0) {
    result.up = {
      price: Math.round((upBid - Math.max(0, upOffset)) * 1000) / 1000,
      reason: `pair-hedge: off=${upOffset}`,
    };
  }

  if ((side === 'both' || side === 'down') && allowDown && downBid && downBid > 0) {
    result.down = {
      price: Math.round((downBid - Math.max(0, downOffset)) * 1000) / 1000,
      reason: `pair-hedge: off=${downOffset}`,
    };
  }

  return result;
}

// ─── Hedge Signal Generator ───

function computeHedgeSignals(state, config) {
  const { hedgeMode, maxPairCost, hedgeForceTimeMs, hedgeCapital, sweepBook, unconditionalForceHedge } = config;
  if (hedgeMode === 'never') return [];

  const pt = initPairTracker(state);
  const { clobUp, clobDown, window: win } = state;
  const sym = win?.symbol || 'btc';

  const excessUp = pt.upTokens - pt.downTokens;
  const excessDown = pt.downTokens - pt.upTokens;
  if (excessUp <= 0.01 && excessDown <= 0.01) return [];

  const ttc = win?.timeToCloseMs;
  const timeForce = hedgeForceTimeMs > 0 && ttc != null && ttc <= hedgeForceTimeMs;

  // Sell-to-close: sell excess tokens at bestBid instead of aggressive hedge
  // Uses separate sellToCloseMs window (doesn't interfere with normal force hedging)
  const sellTimeForce = config.sellToClose && ttc != null && ttc <= (config.sellToCloseMs || 30000);
  if (sellTimeForce) {
    if (pt._sellTarget == null) {
      if (excessUp > 1.0) {
        pt._sellTarget = { side: 'up', remaining: excessUp };
      } else if (excessDown > 1.0) {
        pt._sellTarget = { side: 'down', remaining: excessDown };
      } else {
        pt._sellTarget = { side: null, remaining: 0 };
      }
    }
    const target = pt._sellTarget;
    if (!target.side || target.remaining <= 0.5) return [];

    const signals = [];
    const token = target.side === 'up' ? `${sym}-up` : `${sym}-down`;
    const bid = target.side === 'up' ? clobUp?.bestBid : clobDown?.bestBid;
    if (bid && bid > 0) {
      signals.push({
        action: 'sell', token, size: target.remaining,
        reason: `sell-to-close: ${target.side} rem=${target.remaining.toFixed(1)}`,
      });
    }
    return signals;
  }

  // Unconditional force hedge: skip BS check and pair cost cap entirely
  if (unconditionalForceHedge && timeForce) {
    const signals = [];
    if (excessUp > 0.01) {
      const downAsk = clobDown?.bestAsk;
      if (downAsk && downAsk > 0 && downAsk < 1) {
        const cap = Math.min(hedgeCapital, excessUp * downAsk);
        signals.push({
          action: 'buy', token: `${sym}-down`, capitalPerTrade: cap,
          sweep: !!sweepBook,
          reason: `hedge: UNCONDITIONAL FORCE ttc=${(ttc / 1000).toFixed(0)}s excess=${excessUp.toFixed(1)}`,
        });
      }
    } else if (excessDown > 0.01) {
      const upAsk = clobUp?.bestAsk;
      if (upAsk && upAsk > 0 && upAsk < 1) {
        const cap = Math.min(hedgeCapital, excessDown * upAsk);
        signals.push({
          action: 'buy', token: `${sym}-up`, capitalPerTrade: cap,
          sweep: !!sweepBook,
          reason: `hedge: UNCONDITIONAL FORCE ttc=${(ttc / 1000).toFixed(0)}s excess=${excessDown.toFixed(1)}`,
        });
      }
    }
    return signals;
  }

  // Late-window tighter floor: in final minute, use lateHedgeFloor instead of convictionFloor
  let effectiveConfig = config;
  if (config.lateHedgeFloor != null && ttc != null && ttc <= (config.lateHedgeMs || 60000)) {
    effectiveConfig = { ...config, convictionFloor: config.lateHedgeFloor };
  }

  const conviction = checkConviction(state, effectiveConfig, excessUp, excessDown);

  if (!conviction.lost && !timeForce) return [];

  const signals = [];

  if (excessUp > 0.01) {
    const downAsk = clobDown?.bestAsk;
    if (!downAsk || downAsk <= 0 || downAsk >= 1) return signals;

    const upAvg = pt.upCost / pt.upTokens;
    const pairCost = upAvg + downAsk;
    if (pairCost > maxPairCost) return signals;

    const cap = Math.min(hedgeCapital, excessUp * downAsk);
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: cap,
      sweep: !!sweepBook,
      reason: `hedge: ${conviction.info} pc=${pairCost.toFixed(3)}${timeForce ? ' FORCE' : ''}`,
    });
  } else if (excessDown > 0.01) {
    const upAsk = clobUp?.bestAsk;
    if (!upAsk || upAsk <= 0 || upAsk >= 1) return signals;

    const downAvg = pt.downCost / pt.downTokens;
    const pairCost = downAvg + upAsk;
    if (pairCost > maxPairCost) return signals;

    const cap = Math.min(hedgeCapital, excessDown * upAsk);
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: cap,
      sweep: !!sweepBook,
      reason: `hedge: ${conviction.info} pc=${pairCost.toFixed(3)}${timeForce ? ' FORCE' : ''}`,
    });
  }

  return signals;
}

// ─── Strategy Interface ───

export function evaluate(state, config) {
  const merged = { ...defaults, ...config };

  trackAll(state);

  const signals = evaluateBase(state, merged, computeDesiredQuotes);

  const { window: win } = state;
  if (win && win.timeToCloseMs != null) {
    const exitMs = merged.exitWindowMs ?? 30000;
    const entryMs = merged.entryWindowMs ?? 840000;
    const inHedgeWindow = win.timeToCloseMs > exitMs && win.timeToCloseMs < entryMs;
    // Unconditional force hedge extends into the last exitMs period
    const inForceWindow = merged.unconditionalForceHedge &&
      merged.hedgeForceTimeMs > 0 && win.timeToCloseMs <= merged.hedgeForceTimeMs;
    const inLateHedgeWindow = merged.lateHedgeFloor != null &&
      win.timeToCloseMs <= (merged.lateHedgeMs || 60000);
    const inSellWindow = merged.sellToClose &&
      win.timeToCloseMs <= (merged.sellToCloseMs || 30000);

    if (inHedgeWindow || inForceWindow || inLateHedgeWindow || inSellWindow) {
      signals.push(...computeHedgeSignals(state, merged));
    }
  }

  return signals;
}

/**
 * Live-compatible getDesiredQuotes interface.
 * Wraps computeDesiredQuotes for use by passive-mm module.
 */
export function getDesiredQuotes(state, config) {
  const c = { ...defaults, ...config };
  const { clobUp, clobDown, window: win } = state;
  if (!win || (!clobUp && !clobDown)) return { up: null, down: null };
  if (win.timeToCloseMs == null) return { up: null, down: null };
  if (win.timeToCloseMs <= c.exitWindowMs) return { up: null, down: null };
  if (win.timeToCloseMs >= c.entryWindowMs) return { up: null, down: null };

  // Initialize trackers (pair tracker + exchange/CL history)
  initPairTracker(state);
  trackAll(state);

  const mm = initMm(state);
  const desired = computeDesiredQuotes(state, c, mm);

  // Add size + capital for reconciler, check inventory + price bounds
  for (const side of ['up', 'down']) {
    if (!desired[side]) continue;
    const inv = side === 'up' ? mm.upInv : mm.downInv;
    if (inv.cost >= c.maxPerSide) { desired[side] = null; continue; }
    if (desired[side].price < c.minEntryPrice || desired[side].price > c.maxEntryPrice) { desired[side] = null; continue; }
    desired[side].size = c.capitalPerEntry / desired[side].price;
    desired[side].capital = c.capitalPerEntry;
  }
  return desired;
}

export function onWindowOpen(state) {
  onWindowOpenBase(state);
  state._mmPair = null;
  state._hedgeTracker = null;
  initPairTracker(state);
  initTracker(state);
}

export function onPassiveFill(fill, state) {
  onPassiveFillBase(fill, state);
  recordFill(fill.token, fill.price, fill.size, false, state);
}

export function onAggressiveFill(fill, state) {
  recordFill(fill.token, fill.price, fill.size, true, state);
}

export function onSell(fill, state) {
  const pt = initPairTracker(state);
  const isUp = fill.token.toLowerCase().includes('-up') || fill.token.toLowerCase().includes('_up');
  if (isUp) {
    pt.upTokens = Math.max(0, pt.upTokens - fill.size);
  } else {
    pt.downTokens = Math.max(0, pt.downTokens - fill.size);
  }
  // Decrement sell-to-close target to prevent overselling
  if (pt._sellTarget) {
    pt._sellTarget.remaining = Math.max(0, pt._sellTarget.remaining - fill.size);
  }
}
