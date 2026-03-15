/**
 * Contrarian Signals Analysis Module
 *
 * Finds windows where exchange VWAP, Pyth, and CLOB data diverge,
 * indicating the CLOB is slow to reprice. Computes expected value
 * for buying contrarian tokens when the CLOB hasn't caught up.
 *
 * NOT using Chainlink (unavailable for non-BTC).
 * Uses: exchange_* (Binance, Coinbase, etc.), pyth, coingecko, clobUp, clobDown, l2Down/l2Up
 *
 * Ground truth: gamma_resolved_direction from pg_timelines (meta.ground_truth)
 *
 * @module factory/analyses/contrarian-signals
 */

import { calculateTakerFeeRate } from '../fee-model.js';

// ─── Timing offsets: seconds before window close ───
const OFFSETS = [
  { label: 'T-60s', seconds: 60 },
  { label: 'T-30s', seconds: 30 },
  { label: 'T-10s', seconds: 10 },
];

// ─── Helpers ───

function round(n, decimals) {
  if (n == null || isNaN(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeEV(winRate, entryPrice, includeFees = true) {
  let effectiveEntry = entryPrice;
  if (includeFees) {
    const feeRate = calculateTakerFeeRate(entryPrice);
    effectiveEntry = entryPrice * (1 + feeRate);
  }
  return winRate - effectiveEntry;
}

/**
 * Classify CLOB consensus from DOWN ask price.
 * Low DOWN ask = market thinks UP. High DOWN ask = market thinks DOWN.
 */
function classifyConsensus(clobDownAsk) {
  if (clobDownAsk == null) return 'unknown';
  if (clobDownAsk < 0.45) return 'UP';
  if (clobDownAsk > 0.55) return 'DOWN';
  return 'uncertain';
}

/**
 * Check if a price looks like wrong-symbol data (BTC prices for SOL/XRP).
 * BTC: ~$80K-$110K range. SOL: ~$50-$250. XRP: ~$0.30-$5.
 */
function looksLikeBtcPrice(price, symbol) {
  if (!price || !symbol) return false;
  const s = symbol.toLowerCase();
  if (s === 'btc') return false; // BTC prices are expected
  if (s === 'sol' && price > 1000) return true;   // SOL shouldn't be >$1000
  if (s === 'xrp' && price > 50) return true;     // XRP shouldn't be >$50
  return false;
}

/**
 * Extract exchange median price from events within a time window.
 */
function getExchangeMedian(timeline, fromMs, toMs) {
  const prices = [];
  for (const e of timeline) {
    if (!e.source || !e.source.startsWith('exchange_')) continue;
    const ts = e._ms || e.timestamp;
    if (ts >= fromMs && ts <= toMs && e.price != null) {
      prices.push(e.price);
    }
  }
  return { median: median(prices), count: prices.length };
}

/**
 * Get exchange median over a lookback interval for rate-of-change computation.
 */
function getExchangeMedianInWindow(timeline, centerMs, halfWindowMs) {
  return getExchangeMedian(timeline, centerMs - halfWindowMs, centerMs + halfWindowMs);
}

/**
 * Get latest Pyth price at or before a timestamp.
 */
function getLatestPyth(timeline, beforeMs) {
  let latest = null;
  for (const e of timeline) {
    if (e.source !== 'pyth') continue;
    const ts = e._ms || e.timestamp;
    if (ts <= beforeMs && e.price != null) {
      if (!latest || ts > (latest._ms || latest.timestamp)) {
        latest = e;
      }
    }
  }
  return latest;
}

/**
 * Get latest CLOB DOWN snapshot at or before a timestamp.
 */
function getLatestClobDown(timeline, beforeMs) {
  let latest = null;
  for (const e of timeline) {
    if (e.source !== 'clobDown') continue;
    const ts = e._ms || e.timestamp;
    if (ts <= beforeMs) {
      if (!latest || ts > (latest._ms || latest.timestamp)) {
        latest = e;
      }
    }
  }
  return latest;
}

/**
 * Get latest L2 snapshot for DOWN token at or before a timestamp.
 */
function getLatestL2Down(timeline, beforeMs) {
  let latest = null;
  for (const e of timeline) {
    if (e.source !== 'l2Down') continue;
    const ts = e._ms || e.timestamp;
    if (ts <= beforeMs) {
      if (!latest || ts > (latest._ms || latest.timestamp)) {
        latest = e;
      }
    }
  }
  return latest;
}

/**
 * Compute CLOB shift: how much the DOWN price moved in a lookback period.
 */
function getClobShift(timeline, atMs, lookbackMs) {
  const earlierClob = getLatestClobDown(timeline, atMs - lookbackMs);
  const currentClob = getLatestClobDown(timeline, atMs);
  if (!earlierClob || !currentClob) return null;

  const earlierPrice = earlierClob.best_ask != null ? earlierClob.best_ask : earlierClob.mid_price;
  const currentPrice = currentClob.best_ask != null ? currentClob.best_ask : currentClob.mid_price;
  if (earlierPrice == null || currentPrice == null) return null;

  return currentPrice - earlierPrice;
}

// ─── Main Analysis ───

/**
 * Run the contrarian-signals analysis.
 *
 * @param {Array<{ meta: Object, timeline: Object[] }>} windows
 * @param {Object} [options]
 * @param {string} [options.symbol]
 * @returns {Object}
 */
export function analyze(windows, options = {}) {
  const symbol = (options.symbol || 'unknown').toLowerCase();
  let skippedNoGt = 0;
  let skippedNoTimeline = 0;
  let skippedBadData = 0;

  // Per-offset accumulation
  const offsetResults = {};
  for (const { label } of OFFSETS) {
    offsetResults[label] = {
      snapshots: [],  // all computed snapshots for this offset
    };
  }

  for (const { meta, timeline } of windows) {
    if (!meta.ground_truth) {
      skippedNoGt++;
      continue;
    }
    if (!timeline || timeline.length === 0) {
      skippedNoTimeline++;
      continue;
    }

    const resolution = (meta.ground_truth || '').toUpperCase();
    const strikePrice = meta.strike_price || meta.oracle_price_at_open;
    const closeTime = new Date(meta.window_close_time).getTime();

    // Sanity check: skip windows where exchange data has wrong-symbol prices
    const exchangeEvents = timeline.filter(e => e.source && e.source.startsWith('exchange_') && e.price != null);
    if (exchangeEvents.length > 0) {
      const samplePrices = exchangeEvents.slice(0, 10).map(e => e.price);
      const anyBtc = samplePrices.some(p => looksLikeBtcPrice(p, symbol));
      if (anyBtc) {
        skippedBadData++;
        continue;
      }
    }

    // Also check Pyth
    const pythEvents = timeline.filter(e => e.source === 'pyth' && e.price != null);
    if (pythEvents.length > 0) {
      const samplePrices = pythEvents.slice(0, 5).map(e => e.price);
      const anyBtc = samplePrices.some(p => looksLikeBtcPrice(p, symbol));
      if (anyBtc) {
        skippedBadData++;
        continue;
      }
    }

    // ─── Compute signals at each offset ───
    for (const { label, seconds } of OFFSETS) {
      const T = closeTime - seconds * 1000;

      // Signal 1: Exchange-CLOB Divergence
      const exchSnap = getExchangeMedian(timeline, T - 5000, T);
      const exchangeMedian = exchSnap.median;
      const pythSnap = getLatestPyth(timeline, T);
      const pythPrice = pythSnap ? pythSnap.price : null;
      const clobSnap = getLatestClobDown(timeline, T);

      let clobDownAsk = null;
      let clobDownBid = null;
      let clobSpread = null;
      if (clobSnap) {
        clobDownAsk = clobSnap.best_ask != null ? clobSnap.best_ask : clobSnap.mid_price;
        clobDownBid = clobSnap.best_bid != null ? clobSnap.best_bid : null;
        clobSpread = clobSnap.spread != null ? clobSnap.spread : null;
      }

      if (clobDownAsk == null || clobDownAsk <= 0 || clobDownAsk >= 1) continue;

      const clobUpAsk = clobDownBid != null ? (1 - clobDownBid) : (1 - clobDownAsk);
      const clobConsensus = classifyConsensus(clobDownAsk);

      // Exchange implied direction
      let exchangeImpliedDirection = null;
      if (exchangeMedian != null && strikePrice != null) {
        exchangeImpliedDirection = exchangeMedian > strikePrice ? 'UP' : 'DOWN';
      }

      // Pyth implied direction
      let pythImpliedDirection = null;
      if (pythPrice != null && strikePrice != null) {
        pythImpliedDirection = pythPrice > strikePrice ? 'UP' : 'DOWN';
      }

      // Divergence: exchange says one thing, CLOB says another
      const exchangeClobDiverge = exchangeImpliedDirection != null &&
        clobConsensus !== 'uncertain' &&
        clobConsensus !== 'unknown' &&
        exchangeImpliedDirection !== clobConsensus;

      // Signal 2: Price Velocity
      const exchEarlier = getExchangeMedianInWindow(timeline, T - 30000, 2500);
      const exchNow = getExchangeMedianInWindow(timeline, T, 2500);
      let priceChangeRate = null;
      let priceAcceleration = null;
      let clobLag = false;

      if (exchEarlier.median != null && exchNow.median != null) {
        priceChangeRate = (exchNow.median - exchEarlier.median) / 30; // $/sec
        // Acceleration: compare rate of first 15s vs last 15s
        const exchMid = getExchangeMedianInWindow(timeline, T - 15000, 2500);
        if (exchMid.median != null) {
          const rate1 = (exchMid.median - exchEarlier.median) / 15;
          const rate2 = (exchNow.median - exchMid.median) / 15;
          priceAcceleration = rate2 - rate1; // positive = speeding up
        }

        // CLOB lag: exchange moved but CLOB direction doesn't match
        const exchDirection = priceChangeRate > 0 ? 'UP' : priceChangeRate < 0 ? 'DOWN' : null;
        if (exchDirection && clobConsensus !== 'uncertain' && clobConsensus !== 'unknown') {
          clobLag = exchDirection !== clobConsensus;
        }
      }

      // Signal 3: CLOB Repricing Speed
      const clobShift30 = getClobShift(timeline, T, 30000);
      let clobStale = false;
      if (exchangeMedian != null && strikePrice != null && clobShift30 != null) {
        const exchPctMove = Math.abs(exchangeMedian - strikePrice) / strikePrice;
        clobStale = exchPctMove > 0.001 && Math.abs(clobShift30) < 0.01;
      }

      // Signal 4: Depth/Flow (L2)
      const l2Snap = getLatestL2Down(timeline, T);
      let bidAskImbalance = null;
      let depthThinning = null;

      if (l2Snap) {
        const bidDepth = l2Snap.bid_depth_1pct || l2Snap.total_bid_size || 0;
        const askDepth = l2Snap.ask_depth_1pct || l2Snap.total_ask_size || 0;
        if (bidDepth + askDepth > 0) {
          bidAskImbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
        }
        // Check if one side is thin (< 25% of total)
        if (bidDepth + askDepth > 0) {
          const bidPct = bidDepth / (bidDepth + askDepth);
          const askPct = askDepth / (bidDepth + askDepth);
          if (bidPct < 0.25) depthThinning = 'bids_thin';
          else if (askPct < 0.25) depthThinning = 'asks_thin';
        }
      }

      offsetResults[label].snapshots.push({
        windowId: meta.window_id,
        resolution,
        strikePrice,
        // Exchange/Pyth
        exchangeMedian,
        exchangeCount: exchSnap.count,
        pythPrice,
        exchangeImpliedDirection,
        pythImpliedDirection,
        // CLOB
        clobDownAsk,
        clobUpAsk,
        clobSpread,
        clobConsensus,
        // Divergence
        exchangeClobDiverge,
        // Velocity
        priceChangeRate,
        priceAcceleration,
        clobLag,
        // CLOB speed
        clobShift30,
        clobStale,
        // Depth
        bidAskImbalance,
        depthThinning,
        hasL2: l2Snap != null,
      });
    }
  }

  // ─── Analyze each offset ───
  const analysis = {};

  for (const { label } of OFFSETS) {
    const snaps = offsetResults[label].snapshots;
    analysis[label] = analyzeOffset(snaps, label);
  }

  // ─── Cross-offset comparison ───
  const timingComparison = buildTimingComparison(analysis);

  // ─── Summary ───
  const allBuckets = [];
  for (const { label } of OFFSETS) {
    for (const b of (analysis[label].signalBuckets || [])) {
      allBuckets.push({ ...b, timing: label });
    }
  }
  allBuckets.sort((a, b) => (b.evAfterFees || -999) - (a.evAfterFees || -999));

  const posEV = allBuckets.filter(b => b.evAfterFees > 0 && b.sampleSize >= 5);
  const bestBucket = posEV.length > 0 ? posEV[0] : allBuckets[0];

  const summaryLines = [
    `Analyzed ${windows.length} input windows for ${symbol.toUpperCase()}.`,
    `Skipped: ${skippedNoGt} no ground truth, ${skippedNoTimeline} no timeline, ${skippedBadData} bad/wrong-symbol data.`,
  ];

  for (const { label } of OFFSETS) {
    const a = analysis[label];
    summaryLines.push(
      `${label}: ${a.totalSnapshots} windows, ${a.withExchange} with exchange data, ${a.withPyth} with Pyth, ${a.withL2} with L2.`
    );
  }

  if (posEV.length > 0) {
    summaryLines.push(`Found ${posEV.length} signal buckets with positive EV after fees (min n=5).`);
    summaryLines.push(
      `Best: "${bestBucket.setup}" at ${bestBucket.timing} — ` +
      `win ${bestBucket.winRate}%, entry $${bestBucket.avgEntry}, ` +
      `EV $${bestBucket.evAfterFees} (n=${bestBucket.sampleSize}).`
    );
  } else {
    summaryLines.push('No signal buckets with positive EV after fees (min n=5).');
  }

  return {
    symbol,
    totalInputWindows: windows.length,
    skippedNoGt,
    skippedNoTimeline,
    skippedBadData,
    analysis,
    timingComparison,
    topSignals: allBuckets.slice(0, 30),
    summary: summaryLines.join(' '),
  };
}

// ─── Per-Offset Analysis ───

function analyzeOffset(snaps, label) {
  const totalSnapshots = snaps.length;
  if (totalSnapshots === 0) {
    return { label, totalSnapshots: 0, signalBuckets: [], baseRate: null };
  }

  const totalDown = snaps.filter(s => s.resolution === 'DOWN').length;
  const totalUp = snaps.filter(s => s.resolution === 'UP').length;
  const baseRate = {
    downPct: round(totalDown / totalSnapshots * 100, 1),
    upPct: round(totalUp / totalSnapshots * 100, 1),
  };

  const withExchange = snaps.filter(s => s.exchangeMedian != null).length;
  const withPyth = snaps.filter(s => s.pythPrice != null).length;
  const withL2 = snaps.filter(s => s.hasL2).length;

  const signalBuckets = [];

  // Helper to test a signal bucket
  function testBucket(setup, filterFn, contrarianSide) {
    const matching = snaps.filter(filterFn);
    if (matching.length < 3) return null;

    const wins = matching.filter(s => s.resolution === contrarianSide).length;
    const winRate = wins / matching.length;

    // Average entry price
    let avgEntry;
    if (contrarianSide === 'DOWN') {
      avgEntry = matching.reduce((s, w) => s + w.clobDownAsk, 0) / matching.length;
    } else {
      avgEntry = matching.reduce((s, w) => s + w.clobUpAsk, 0) / matching.length;
    }

    const ev = computeEV(winRate, avgEntry, false);
    const evAfterFees = computeEV(winRate, avgEntry, true);

    return {
      setup,
      contrarianSide,
      sampleSize: matching.length,
      wins,
      winRate: round(winRate * 100, 1),
      avgEntry: round(avgEntry, 4),
      ev: round(ev, 4),
      evAfterFees: round(evAfterFees, 4),
    };
  }

  // ─── Bucket 1: "Exchanges say DOWN, CLOB says UP" → buy DOWN ───
  const b1 = testBucket(
    'Exchange says DOWN, CLOB says UP → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' && s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b1) signalBuckets.push(b1);

  // Sub-buckets by confidence
  const b1a = testBucket(
    'Exchange says DOWN, CLOB DOWN ask < $0.35 (strong UP consensus) → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' && s.clobDownAsk < 0.35,
    'DOWN'
  );
  if (b1a) signalBuckets.push(b1a);

  const b1b = testBucket(
    'Exchange says DOWN, CLOB DOWN ask < $0.25 (very strong UP consensus) → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' && s.clobDownAsk < 0.25,
    'DOWN'
  );
  if (b1b) signalBuckets.push(b1b);

  // ─── Bucket 2: "Exchanges say UP, CLOB says DOWN" → buy UP ───
  const b2 = testBucket(
    'Exchange says UP, CLOB says DOWN → buy UP',
    s => s.exchangeImpliedDirection === 'UP' && s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b2) signalBuckets.push(b2);

  const b2a = testBucket(
    'Exchange says UP, CLOB DOWN ask > $0.65 (strong DOWN consensus) → buy UP',
    s => s.exchangeImpliedDirection === 'UP' && s.clobDownAsk > 0.65,
    'UP'
  );
  if (b2a) signalBuckets.push(b2a);

  const b2b = testBucket(
    'Exchange says UP, CLOB DOWN ask > $0.75 (very strong DOWN consensus) → buy UP',
    s => s.exchangeImpliedDirection === 'UP' && s.clobDownAsk > 0.75,
    'UP'
  );
  if (b2b) signalBuckets.push(b2b);

  // ─── Bucket 3: "Exchange moving fast, CLOB hasn't moved" ───
  // Exchange velocity > threshold, CLOB stale
  for (const rateThresh of [0.01, 0.05, 0.10]) {
    const b3d = testBucket(
      `Exchange moving DOWN >${rateThresh.toFixed(2)}$/s, CLOB stale → buy DOWN`,
      s => s.priceChangeRate != null && s.priceChangeRate < -rateThresh && s.clobStale,
      'DOWN'
    );
    if (b3d) signalBuckets.push(b3d);

    const b3u = testBucket(
      `Exchange moving UP >${rateThresh.toFixed(2)}$/s, CLOB stale → buy UP`,
      s => s.priceChangeRate != null && s.priceChangeRate > rateThresh && s.clobStale,
      'UP'
    );
    if (b3u) signalBuckets.push(b3u);
  }

  // ─── Bucket 3b: Exchange moving fast in direction X, buy that direction ───
  for (const rateThresh of [0.01, 0.05, 0.10]) {
    const b3bd = testBucket(
      `Exchange velocity < -${rateThresh.toFixed(2)}$/s → buy DOWN`,
      s => s.priceChangeRate != null && s.priceChangeRate < -rateThresh,
      'DOWN'
    );
    if (b3bd) signalBuckets.push(b3bd);

    const b3bu = testBucket(
      `Exchange velocity > +${rateThresh.toFixed(2)}$/s → buy UP`,
      s => s.priceChangeRate != null && s.priceChangeRate > rateThresh,
      'UP'
    );
    if (b3bu) signalBuckets.push(b3bu);
  }

  // ─── Bucket 4: Exchange + Pyth agree, CLOB disagrees ───
  const b4d = testBucket(
    'Exchange AND Pyth both say DOWN, CLOB says UP → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' && s.pythImpliedDirection === 'DOWN' && s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b4d) signalBuckets.push(b4d);

  const b4u = testBucket(
    'Exchange AND Pyth both say UP, CLOB says DOWN → buy UP',
    s => s.exchangeImpliedDirection === 'UP' && s.pythImpliedDirection === 'UP' && s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b4u) signalBuckets.push(b4u);

  // ─── Bucket 5: CLOB lag (exchange direction changed but CLOB still pricing old) ───
  const b5d = testBucket(
    'CLOB lagging: exchange shifted DOWN but CLOB still says UP → buy DOWN',
    s => s.clobLag && s.priceChangeRate != null && s.priceChangeRate < 0 && s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b5d) signalBuckets.push(b5d);

  const b5u = testBucket(
    'CLOB lagging: exchange shifted UP but CLOB still says DOWN → buy UP',
    s => s.clobLag && s.priceChangeRate != null && s.priceChangeRate > 0 && s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b5u) signalBuckets.push(b5u);

  // ─── Bucket 6: Price acceleration (move speeding up) ───
  const b6d = testBucket(
    'Exchange accelerating DOWN + CLOB says UP → buy DOWN',
    s => s.priceAcceleration != null && s.priceAcceleration < -0.001 &&
         s.priceChangeRate != null && s.priceChangeRate < 0 &&
         s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b6d) signalBuckets.push(b6d);

  const b6u = testBucket(
    'Exchange accelerating UP + CLOB says DOWN → buy UP',
    s => s.priceAcceleration != null && s.priceAcceleration > 0.001 &&
         s.priceChangeRate != null && s.priceChangeRate > 0 &&
         s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b6u) signalBuckets.push(b6u);

  // ─── Bucket 7: L2 depth imbalance ───
  for (const imbThresh of [0.20, 0.40]) {
    const b7d = testBucket(
      `L2 ask-heavy (imb < -${imbThresh}) + CLOB says UP → buy DOWN`,
      s => s.bidAskImbalance != null && s.bidAskImbalance < -imbThresh && s.clobConsensus === 'UP',
      'DOWN'
    );
    if (b7d) signalBuckets.push(b7d);

    const b7u = testBucket(
      `L2 bid-heavy (imb > +${imbThresh}) + CLOB says DOWN → buy UP`,
      s => s.bidAskImbalance != null && s.bidAskImbalance > imbThresh && s.clobConsensus === 'DOWN',
      'UP'
    );
    if (b7u) signalBuckets.push(b7u);
  }

  // ─── Bucket 8: Depth thinning (MMs pulling) ───
  const b8d = testBucket(
    'Bids thinning (MMs pulling bids) + CLOB says UP → buy DOWN',
    s => s.depthThinning === 'bids_thin' && s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b8d) signalBuckets.push(b8d);

  const b8u = testBucket(
    'Asks thinning (MMs pulling asks) + CLOB says DOWN → buy UP',
    s => s.depthThinning === 'asks_thin' && s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b8u) signalBuckets.push(b8u);

  // ─── Bucket 9: Combined — exchange diverge + velocity ───
  const b9d = testBucket(
    'Exchange says DOWN + velocity < -0.01$/s + CLOB says UP → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' &&
         s.priceChangeRate != null && s.priceChangeRate < -0.01 &&
         s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b9d) signalBuckets.push(b9d);

  const b9u = testBucket(
    'Exchange says UP + velocity > +0.01$/s + CLOB says DOWN → buy UP',
    s => s.exchangeImpliedDirection === 'UP' &&
         s.priceChangeRate != null && s.priceChangeRate > 0.01 &&
         s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b9u) signalBuckets.push(b9u);

  // ─── Bucket 10: All feeds agree against CLOB ───
  const b10d = testBucket(
    'Exchange + Pyth + velocity all say DOWN, CLOB says UP → buy DOWN',
    s => s.exchangeImpliedDirection === 'DOWN' &&
         s.pythImpliedDirection === 'DOWN' &&
         s.priceChangeRate != null && s.priceChangeRate < 0 &&
         s.clobConsensus === 'UP',
    'DOWN'
  );
  if (b10d) signalBuckets.push(b10d);

  const b10u = testBucket(
    'Exchange + Pyth + velocity all say UP, CLOB says DOWN → buy UP',
    s => s.exchangeImpliedDirection === 'UP' &&
         s.pythImpliedDirection === 'UP' &&
         s.priceChangeRate != null && s.priceChangeRate > 0 &&
         s.clobConsensus === 'DOWN',
    'UP'
  );
  if (b10u) signalBuckets.push(b10u);

  // Sort by EV after fees
  signalBuckets.sort((a, b) => (b.evAfterFees || -999) - (a.evAfterFees || -999));

  // ─── Divergence stats ───
  const divergeCount = snaps.filter(s => s.exchangeClobDiverge).length;
  const divergeCorrect = snaps.filter(s =>
    s.exchangeClobDiverge && s.exchangeImpliedDirection === s.resolution
  ).length;

  const clobLagCount = snaps.filter(s => s.clobLag).length;
  const clobStaleCount = snaps.filter(s => s.clobStale).length;

  return {
    label,
    totalSnapshots,
    withExchange,
    withPyth,
    withL2,
    baseRate,
    divergenceStats: {
      totalDiverge: divergeCount,
      divergePct: round(divergeCount / totalSnapshots * 100, 1),
      exchangeCorrectWhenDiverge: divergeCount > 0
        ? round(divergeCorrect / divergeCount * 100, 1)
        : null,
      exchangeCorrectCount: divergeCorrect,
    },
    clobLagCount,
    clobLagPct: round(clobLagCount / totalSnapshots * 100, 1),
    clobStaleCount,
    clobStalePct: round(clobStaleCount / totalSnapshots * 100, 1),
    signalBuckets,
  };
}

// ─── Timing Comparison ───

function buildTimingComparison(analysis) {
  const comparison = [];
  const allSetups = new Set();

  for (const key of Object.keys(analysis)) {
    for (const b of (analysis[key].signalBuckets || [])) {
      allSetups.add(b.setup);
    }
  }

  for (const setup of allSetups) {
    const row = { setup };
    for (const key of Object.keys(analysis)) {
      const bucket = (analysis[key].signalBuckets || []).find(b => b.setup === setup);
      if (bucket) {
        row[key] = {
          winRate: bucket.winRate,
          ev: bucket.ev,
          evAfterFees: bucket.evAfterFees,
          sampleSize: bucket.sampleSize,
          avgEntry: bucket.avgEntry,
        };
      } else {
        row[key] = null;
      }
    }
    comparison.push(row);
  }

  // Sort by best EV across any timing
  comparison.sort((a, b) => {
    const bestA = Math.max(
      ...[a['T-60s'], a['T-30s'], a['T-10s']].filter(Boolean).map(x => x.evAfterFees || -999)
    );
    const bestB = Math.max(
      ...[b['T-60s'], b['T-30s'], b['T-10s']].filter(Boolean).map(x => x.evAfterFees || -999)
    );
    return bestB - bestA;
  });

  return comparison;
}
