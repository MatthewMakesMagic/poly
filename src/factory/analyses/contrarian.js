/**
 * Contrarian Analysis Module
 *
 * Finds windows where the CLOB market consensus was WRONG and the contrarian
 * bet would have paid off. Computes expected value for buying the cheap token
 * when the market is confidently pricing the other direction.
 *
 * Key questions answered:
 *   1. How often is the market wrong at T-60s?
 *   2. What signals predict when the market is wrong?
 *   3. What is the expected PnL for contrarian entries?
 *
 * Input: array of { meta, timeline } from pg_timelines cache.
 * Output: structured JSON with bucket analysis, contrarian signals, and EV.
 *
 * @module factory/analyses/contrarian
 */

import { calculateTakerFeeRate } from '../fee-model.js';

// CLOB DOWN price buckets
const PRICE_BUCKETS = [
  { label: '$0.00-0.20', lo: 0.00, hi: 0.20, consensus: 'very confident UP' },
  { label: '$0.20-0.35', lo: 0.20, hi: 0.35, consensus: 'confident UP' },
  { label: '$0.35-0.45', lo: 0.35, hi: 0.45, consensus: 'leans UP' },
  { label: '$0.45-0.55', lo: 0.45, hi: 0.55, consensus: 'uncertain' },
  { label: '$0.55-0.65', lo: 0.55, hi: 0.65, consensus: 'leans DOWN' },
  { label: '$0.65-0.80', lo: 0.65, hi: 0.80, consensus: 'confident DOWN' },
  { label: '$0.80-1.00', lo: 0.80, hi: 1.00, consensus: 'very confident DOWN' },
];

/**
 * Classify market consensus from CLOB DOWN ask price.
 * Low DOWN ask = market thinks UP. High DOWN ask = market thinks DOWN.
 */
function classifyConsensus(clobDownAsk) {
  if (clobDownAsk == null) return 'unknown';
  if (clobDownAsk < 0.45) return 'UP';
  if (clobDownAsk > 0.55) return 'DOWN';
  return 'uncertain';
}

/**
 * Compute EV for buying a token at a given price with a given win rate.
 * Payout on win = $1, payout on loss = $0.
 * EV = winRate * (1 - price) - (1 - winRate) * price
 *    = winRate - price
 *
 * After taker fees: entry cost = price * (1 + feeRate), payout still $1.
 * EV_net = winRate * (1 - price*(1+feeRate)) - (1-winRate) * price*(1+feeRate)
 *        = winRate - price*(1+feeRate)
 */
function computeEV(winRate, entryPrice, includeFees = true) {
  let effectiveEntry = entryPrice;
  if (includeFees) {
    const feeRate = calculateTakerFeeRate(entryPrice);
    effectiveEntry = entryPrice * (1 + feeRate);
  }
  return winRate - effectiveEntry;
}

/**
 * Run the contrarian analysis on an array of windows.
 *
 * @param {Array<{ meta: Object, timeline: Object[] }>} windows
 * @param {Object} [options]
 * @param {string} [options.symbol] - Symbol label for output
 * @returns {Object} Structured analysis results
 */
export function analyze(windows, options = {}) {
  const symbol = options.symbol || 'unknown';
  const windowStats = [];
  let skippedNoGt = 0;
  let skippedNoTimeline = 0;
  let skippedNoClob = 0;

  for (const { meta, timeline } of windows) {
    if (!meta.ground_truth) {
      skippedNoGt++;
      continue;
    }
    if (!timeline || timeline.length === 0) {
      skippedNoTimeline++;
      continue;
    }

    const closeTime = new Date(meta.window_close_time).getTime();
    const t60 = closeTime - 60_000;
    const resolution = (meta.ground_truth || '').toUpperCase();
    const strikePrice = meta.strike_price;

    // --- CLOB DOWN data at T-60s ---
    const clobDownEvents = timeline.filter(e => e.source === 'clobDown');
    // Find the last CLOB DOWN event at or before T-60s, or the closest one in the last 60s
    const clobBeforeT60 = clobDownEvents.filter(e => (e._ms || e.timestamp) <= t60);
    const clobAfterT60 = clobDownEvents.filter(e => (e._ms || e.timestamp) > t60);

    let clobAtT60 = null;
    if (clobBeforeT60.length > 0) {
      clobAtT60 = clobBeforeT60[clobBeforeT60.length - 1];
    } else if (clobAfterT60.length > 0) {
      // Use earliest event in last 60s as approximation
      clobAtT60 = clobAfterT60[0];
    }

    if (!clobAtT60) {
      skippedNoClob++;
      continue;
    }

    const clobDownAsk = clobAtT60.best_ask != null ? clobAtT60.best_ask : clobAtT60.mid_price;
    if (clobDownAsk == null || clobDownAsk <= 0 || clobDownAsk >= 1) {
      skippedNoClob++;
      continue;
    }

    const clobUpAsk = 1 - (clobAtT60.best_bid != null ? clobAtT60.best_bid : (1 - clobDownAsk));
    const clobSpread = clobAtT60.spread != null ? clobAtT60.spread : null;
    const consensus = classifyConsensus(clobDownAsk);
    const marketWrong = (consensus === 'UP' && resolution === 'DOWN') ||
                        (consensus === 'DOWN' && resolution === 'UP');

    // --- Chainlink data at T-60s ---
    const clEvents = timeline.filter(e => e.source === 'chainlink');
    const clBeforeT60 = clEvents.filter(e => (e._ms || e.timestamp) <= t60);
    const clAfterT60 = clEvents.filter(e => (e._ms || e.timestamp) > t60);
    const clAtClose = clEvents.length > 0 ? clEvents[clEvents.length - 1] : null;

    let clPriceAtT60 = null;
    let clPriceAtClose = null;
    let clDirection = null;
    let clChange = 0;
    let clSpeed = 0;
    let clDeficitFromStrike = null;

    if (clAtClose) {
      clPriceAtClose = clAtClose.price;
    }

    if (clBeforeT60.length > 0) {
      clPriceAtT60 = clBeforeT60[clBeforeT60.length - 1].price;
    } else if (clAtClose) {
      clPriceAtT60 = clAtClose.price;
    }

    if (clPriceAtT60 != null && clPriceAtClose != null) {
      clChange = clPriceAtClose - clPriceAtT60;
      clDirection = clChange > 0 ? 'up' : clChange < 0 ? 'down' : 'flat';
      clSpeed = Math.abs(clChange) / 60; // $/sec
    }

    if (clPriceAtT60 != null && strikePrice) {
      clDeficitFromStrike = clPriceAtT60 - strikePrice;
    }

    // --- Exchange data at T-60s ---
    const exchangeEvents = timeline.filter(e => e.source && e.source.startsWith('exchange_'));
    const exchangeNearT60 = exchangeEvents.filter(e => {
      const ts = e._ms || e.timestamp;
      return ts >= t60 - 10_000 && ts <= t60 + 10_000; // +/- 10s around T-60
    });
    let exchangeMedianVsCl = null;
    if (exchangeNearT60.length > 0 && clPriceAtT60 != null) {
      const prices = exchangeNearT60.map(e => e.price).filter(p => p != null).sort((a, b) => a - b);
      if (prices.length > 0) {
        const median = prices[Math.floor(prices.length / 2)];
        exchangeMedianVsCl = median - clPriceAtT60;
      }
    }

    // --- L2 depth data at T-60s ---
    const l2DownEvents = timeline.filter(e => e.source === 'l2Down');
    const l2NearT60 = l2DownEvents.filter(e => {
      const ts = e._ms || e.timestamp;
      return ts >= t60 - 15_000 && ts <= t60 + 15_000;
    });
    let l2DepthImbalance = null;
    if (l2NearT60.length > 0) {
      const last = l2NearT60[l2NearT60.length - 1];
      const bidDepth = last.bid_depth_1pct || 0;
      const askDepth = last.ask_depth_1pct || 0;
      if (bidDepth + askDepth > 0) {
        // Positive = more bids (support), negative = more asks (selling pressure)
        l2DepthImbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
      }
    }

    // --- CL % move in last 60s (verify the 1% claim) ---
    let clPctMove = null;
    if (clPriceAtT60 != null && clPriceAtT60 > 0 && clPriceAtClose != null) {
      clPctMove = Math.abs(clChange) / clPriceAtT60;
    }

    windowStats.push({
      windowId: meta.window_id,
      resolution,
      clobDownAsk,
      clobUpAsk,
      clobSpread,
      consensus,
      marketWrong,
      clPriceAtT60,
      clPriceAtClose,
      clDirection,
      clChange,
      clSpeed,
      clDeficitFromStrike,
      clPctMove,
      exchangeMedianVsCl,
      l2DepthImbalance,
      strikePrice,
    });
  }

  const totalAnalyzed = windowStats.length;
  if (totalAnalyzed === 0) {
    return {
      symbol,
      windowsAnalyzed: 0,
      totalInputWindows: windows.length,
      skippedNoGt,
      skippedNoTimeline,
      skippedNoClob,
      error: 'No windows with both ground truth and CLOB data available.',
    };
  }

  // =========================================================================
  // 1. BASE RATES
  // =========================================================================
  const totalDown = windowStats.filter(w => w.resolution === 'DOWN').length;
  const totalUp = windowStats.filter(w => w.resolution === 'UP').length;
  const baseRate = {
    downPct: round(totalDown / totalAnalyzed * 100, 1),
    upPct: round(totalUp / totalAnalyzed * 100, 1),
    downCount: totalDown,
    upCount: totalUp,
  };

  // =========================================================================
  // 2. CLOB PRICE BUCKETS
  // =========================================================================
  const clobPriceBuckets = PRICE_BUCKETS.map(bucket => {
    const inBucket = windowStats.filter(w =>
      w.clobDownAsk >= bucket.lo && w.clobDownAsk < bucket.hi
    );
    const n = inBucket.length;
    if (n === 0) {
      return {
        range: bucket.label,
        consensus: bucket.consensus,
        windows: 0,
        actualDownPct: null,
        actualUpPct: null,
        evBuyDown: null,
        evBuyDownAfterFees: null,
        evBuyUp: null,
        evBuyUpAfterFees: null,
        avgClobDownAsk: null,
      };
    }

    const downCount = inBucket.filter(w => w.resolution === 'DOWN').length;
    const downRate = downCount / n;
    const upRate = 1 - downRate;
    const avgDownAsk = inBucket.reduce((s, w) => s + w.clobDownAsk, 0) / n;
    const avgUpAsk = inBucket.reduce((s, w) => s + w.clobUpAsk, 0) / n;

    return {
      range: bucket.label,
      consensus: bucket.consensus,
      windows: n,
      actualDownPct: round(downRate * 100, 1),
      actualUpPct: round(upRate * 100, 1),
      avgClobDownAsk: round(avgDownAsk, 4),
      avgClobUpAsk: round(avgUpAsk, 4),
      // EV of buying the DOWN token at its ask price
      evBuyDown: round(computeEV(downRate, avgDownAsk, false), 4),
      evBuyDownAfterFees: round(computeEV(downRate, avgDownAsk, true), 4),
      // EV of buying the UP token at its ask price
      evBuyUp: round(computeEV(upRate, avgUpAsk, false), 4),
      evBuyUpAfterFees: round(computeEV(upRate, avgUpAsk, true), 4),
    };
  });

  // =========================================================================
  // 3. MARKET WRONG RATES
  // =========================================================================
  const consensusUpWindows = windowStats.filter(w => w.consensus === 'UP');
  const consensusDownWindows = windowStats.filter(w => w.consensus === 'DOWN');
  const uncertainWindows = windowStats.filter(w => w.consensus === 'uncertain');

  const marketWrongRate = {
    whenConsensusUp: {
      total: consensusUpWindows.length,
      wrongCount: consensusUpWindows.filter(w => w.marketWrong).length,
      wrongPct: consensusUpWindows.length > 0
        ? round(consensusUpWindows.filter(w => w.marketWrong).length / consensusUpWindows.length * 100, 1)
        : null,
    },
    whenConsensusDown: {
      total: consensusDownWindows.length,
      wrongCount: consensusDownWindows.filter(w => w.marketWrong).length,
      wrongPct: consensusDownWindows.length > 0
        ? round(consensusDownWindows.filter(w => w.marketWrong).length / consensusDownWindows.length * 100, 1)
        : null,
    },
    uncertainWindows: uncertainWindows.length,
  };

  // =========================================================================
  // 4. CONTRARIAN SIGNALS — what's different when the market is wrong?
  // =========================================================================
  const contrarianOpportunities = [];

  // Helper to test a contrarian setup
  function testContrarian(setup, filterFn, contrarianSide) {
    const matching = windowStats.filter(filterFn);
    if (matching.length < 3) return null;

    const wins = matching.filter(w => w.resolution === contrarianSide).length;
    const winRate = wins / matching.length;

    // Average entry price = average ask for the contrarian token
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
      windows: matching.length,
      wins,
      winRate: round(winRate * 100, 1),
      avgEntry: round(avgEntry, 4),
      ev: round(ev, 4),
      evAfterFees: round(evAfterFees, 4),
      profitPerDollar: round(ev / avgEntry, 4),
    };
  }

  // --- Signal: CL already moving against consensus ---
  // Market says UP (DOWN cheap) but CL moving DOWN
  const sig1 = testContrarian(
    'CLOB DOWN < $0.40 BUT CL moving DOWN',
    w => w.clobDownAsk < 0.40 && w.clDirection === 'down',
    'DOWN'
  );
  if (sig1) contrarianOpportunities.push({ ...sig1, bestIndicator: 'CL direction opposing consensus' });

  const sig1b = testContrarian(
    'CLOB DOWN < $0.35 BUT CL moving DOWN',
    w => w.clobDownAsk < 0.35 && w.clDirection === 'down',
    'DOWN'
  );
  if (sig1b) contrarianOpportunities.push({ ...sig1b, bestIndicator: 'CL direction opposing strong consensus' });

  // Market says DOWN (DOWN expensive) but CL moving UP
  const sig2 = testContrarian(
    'CLOB DOWN > $0.60 BUT CL moving UP',
    w => w.clobDownAsk > 0.60 && w.clDirection === 'up',
    'UP'
  );
  if (sig2) contrarianOpportunities.push({ ...sig2, bestIndicator: 'CL direction opposing consensus' });

  const sig2b = testContrarian(
    'CLOB DOWN > $0.65 BUT CL moving UP',
    w => w.clobDownAsk > 0.65 && w.clDirection === 'up',
    'UP'
  );
  if (sig2b) contrarianOpportunities.push({ ...sig2b, bestIndicator: 'CL direction opposing strong consensus' });

  // --- Signal: CL moving FAST against consensus ---
  const speedThresholds = [0.01, 0.05, 0.10, 0.50];
  for (const speed of speedThresholds) {
    const sig = testContrarian(
      `CLOB DOWN < $0.40 AND CL speed > $${speed}/s moving DOWN`,
      w => w.clobDownAsk < 0.40 && w.clSpeed > speed && w.clDirection === 'down',
      'DOWN'
    );
    if (sig) contrarianOpportunities.push({ ...sig, bestIndicator: `CL speed > $${speed}/sec moving DOWN` });

    const sigUp = testContrarian(
      `CLOB DOWN > $0.60 AND CL speed > $${speed}/s moving UP`,
      w => w.clobDownAsk > 0.60 && w.clSpeed > speed && w.clDirection === 'up',
      'UP'
    );
    if (sigUp) contrarianOpportunities.push({ ...sigUp, bestIndicator: `CL speed > $${speed}/sec moving UP` });
  }

  // --- Signal: Exchange prices diverging from CL (exchanges ahead) ---
  for (const thresh of [0.10, 0.25, 0.50]) {
    // Exchanges below CL (leading DOWN) while market says UP
    const sig = testContrarian(
      `CLOB DOWN < $0.40 AND exchanges < CL by $${thresh}`,
      w => w.clobDownAsk < 0.40 && w.exchangeMedianVsCl != null && w.exchangeMedianVsCl < -thresh,
      'DOWN'
    );
    if (sig) contrarianOpportunities.push({ ...sig, bestIndicator: `Exchanges ahead of CL by $${thresh} DOWN` });

    // Exchanges above CL (leading UP) while market says DOWN
    const sigUp = testContrarian(
      `CLOB DOWN > $0.60 AND exchanges > CL by $${thresh}`,
      w => w.clobDownAsk > 0.60 && w.exchangeMedianVsCl != null && w.exchangeMedianVsCl > thresh,
      'UP'
    );
    if (sigUp) contrarianOpportunities.push({ ...sigUp, bestIndicator: `Exchanges ahead of CL by $${thresh} UP` });
  }

  // --- Signal: CL deficit from strike (CL already past strike against consensus) ---
  for (const deficit of [0.10, 0.25, 0.50, 1.00]) {
    // CL below strike by $deficit but market still says UP (DOWN cheap)
    const sig = testContrarian(
      `CLOB DOWN < $0.40 AND CL below strike by $${deficit}`,
      w => w.clobDownAsk < 0.40 && w.clDeficitFromStrike != null && w.clDeficitFromStrike < -deficit,
      'DOWN'
    );
    if (sig) contrarianOpportunities.push({ ...sig, bestIndicator: `CL already $${deficit} below strike` });

    // CL above strike by $deficit but market still says DOWN (DOWN expensive)
    const sigUp = testContrarian(
      `CLOB DOWN > $0.60 AND CL above strike by $${deficit}`,
      w => w.clobDownAsk > 0.60 && w.clDeficitFromStrike != null && w.clDeficitFromStrike > deficit,
      'UP'
    );
    if (sigUp) contrarianOpportunities.push({ ...sigUp, bestIndicator: `CL already $${deficit} above strike` });
  }

  // --- Signal: Wide CLOB spread (market uncertain) ---
  for (const spreadThresh of [0.03, 0.05, 0.10]) {
    const sig = testContrarian(
      `CLOB DOWN < $0.40 AND spread > $${spreadThresh}`,
      w => w.clobDownAsk < 0.40 && w.clobSpread != null && w.clobSpread > spreadThresh,
      'DOWN'
    );
    if (sig) contrarianOpportunities.push({ ...sig, bestIndicator: `Wide CLOB spread > $${spreadThresh}` });

    const sigDown = testContrarian(
      `CLOB DOWN > $0.60 AND spread > $${spreadThresh}`,
      w => w.clobDownAsk > 0.60 && w.clobSpread != null && w.clobSpread > spreadThresh,
      'UP'
    );
    if (sigDown) contrarianOpportunities.push({ ...sigDown, bestIndicator: `Wide CLOB spread > $${spreadThresh}` });
  }

  // --- Signal: L2 depth imbalance ---
  for (const imbThresh of [0.20, 0.40, 0.60]) {
    // More ask depth than bid depth (selling pressure) while market says UP
    const sig = testContrarian(
      `CLOB DOWN < $0.40 AND L2 ask-heavy (imbalance < -${imbThresh})`,
      w => w.clobDownAsk < 0.40 && w.l2DepthImbalance != null && w.l2DepthImbalance < -imbThresh,
      'DOWN'
    );
    if (sig) contrarianOpportunities.push({ ...sig, bestIndicator: `L2 depth skewed toward asks (selling)` });

    // More bid depth (buying pressure) while market says DOWN
    const sigUp = testContrarian(
      `CLOB DOWN > $0.60 AND L2 bid-heavy (imbalance > ${imbThresh})`,
      w => w.clobDownAsk > 0.60 && w.l2DepthImbalance != null && w.l2DepthImbalance > imbThresh,
      'UP'
    );
    if (sigUp) contrarianOpportunities.push({ ...sigUp, bestIndicator: `L2 depth skewed toward bids (buying)` });
  }

  // --- Combined signal: multiple indicators aligning ---
  const sigCombo1 = testContrarian(
    'CLOB DOWN < $0.40 AND CL moving DOWN AND CL below strike',
    w => w.clobDownAsk < 0.40 && w.clDirection === 'down' && w.clDeficitFromStrike != null && w.clDeficitFromStrike < 0,
    'DOWN'
  );
  if (sigCombo1) contrarianOpportunities.push({ ...sigCombo1, bestIndicator: 'CL direction + deficit both opposing consensus' });

  const sigCombo2 = testContrarian(
    'CLOB DOWN > $0.60 AND CL moving UP AND CL above strike',
    w => w.clobDownAsk > 0.60 && w.clDirection === 'up' && w.clDeficitFromStrike != null && w.clDeficitFromStrike > 0,
    'UP'
  );
  if (sigCombo2) contrarianOpportunities.push({ ...sigCombo2, bestIndicator: 'CL direction + deficit both opposing consensus' });

  const sigCombo3 = testContrarian(
    'CLOB DOWN < $0.35 AND CL moving DOWN AND exchanges < CL',
    w => w.clobDownAsk < 0.35 && w.clDirection === 'down' &&
         w.exchangeMedianVsCl != null && w.exchangeMedianVsCl < 0,
    'DOWN'
  );
  if (sigCombo3) contrarianOpportunities.push({ ...sigCombo3, bestIndicator: 'CL + exchanges both pointing DOWN vs consensus UP' });

  const sigCombo4 = testContrarian(
    'CLOB DOWN > $0.65 AND CL moving UP AND exchanges > CL',
    w => w.clobDownAsk > 0.65 && w.clDirection === 'up' &&
         w.exchangeMedianVsCl != null && w.exchangeMedianVsCl > 0,
    'UP'
  );
  if (sigCombo4) contrarianOpportunities.push({ ...sigCombo4, bestIndicator: 'CL + exchanges both pointing UP vs consensus DOWN' });

  // Sort contrarian opportunities by EV descending
  contrarianOpportunities.sort((a, b) => b.ev - a.ev);

  // =========================================================================
  // 5. CL MOVE VERIFICATION (the 1% claim from final-60s)
  // =========================================================================
  const withClPctMove = windowStats.filter(w => w.clPctMove != null);
  const avgStrike = withClPctMove.length > 0
    ? withClPctMove.reduce((s, w) => s + w.strikePrice, 0) / withClPctMove.length
    : 0;
  const onePercentThreshold = avgStrike * 0.01;

  const clMoveVerification = {
    windowsWithCl: withClPctMove.length,
    avgStrikePrice: round(avgStrike, 2),
    onePercentThreshold: round(onePercentThreshold, 4),
    avgAbsClChange: withClPctMove.length > 0
      ? round(withClPctMove.reduce((s, w) => s + Math.abs(w.clChange), 0) / withClPctMove.length, 6)
      : null,
    avgAbsClPctMove: withClPctMove.length > 0
      ? round(withClPctMove.reduce((s, w) => s + w.clPctMove, 0) / withClPctMove.length * 100, 6)
      : null,
    medianAbsClChange: withClPctMove.length > 0
      ? round(median(withClPctMove.map(w => Math.abs(w.clChange))), 6)
      : null,
    pctWithOver1PctMove: withClPctMove.length > 0
      ? round(withClPctMove.filter(w => Math.abs(w.clChange) > onePercentThreshold).length / withClPctMove.length * 100, 1)
      : null,
    // Distribution of CL moves (in dollar terms)
    clMoveBuckets: computeClMoveBuckets(withClPctMove),
  };

  // =========================================================================
  // 6. SUMMARY
  // =========================================================================
  const bestOpportunity = contrarianOpportunities.length > 0 ? contrarianOpportunities[0] : null;
  const posEVOpportunities = contrarianOpportunities.filter(o => o.evAfterFees > 0);

  const summary = [
    `Analyzed ${totalAnalyzed} windows with CLOB data (${skippedNoClob} skipped for missing CLOB).`,
    `Base rate: ${baseRate.downPct}% DOWN, ${baseRate.upPct}% UP.`,
    `Market wrong: ${marketWrongRate.whenConsensusUp.wrongPct ?? 'N/A'}% when consensus UP (n=${marketWrongRate.whenConsensusUp.total}), ` +
    `${marketWrongRate.whenConsensusDown.wrongPct ?? 'N/A'}% when consensus DOWN (n=${marketWrongRate.whenConsensusDown.total}).`,
    `Found ${contrarianOpportunities.length} contrarian setups, ${posEVOpportunities.length} with positive EV after fees.`,
    bestOpportunity
      ? `Best: "${bestOpportunity.setup}" — ${bestOpportunity.winRate}% win rate, avg entry $${bestOpportunity.avgEntry}, EV $${bestOpportunity.ev} (after fees: $${bestOpportunity.evAfterFees}).`
      : 'No contrarian setups met minimum sample threshold.',
    `CL move verification: avg abs CL change = $${clMoveVerification.avgAbsClChange ?? 'N/A'}, ` +
    `${clMoveVerification.pctWithOver1PctMove ?? 'N/A'}% had >1% move (threshold: $${clMoveVerification.onePercentThreshold}).`,
  ].join(' ');

  return {
    symbol,
    windowsAnalyzed: totalAnalyzed,
    totalInputWindows: windows.length,
    skippedNoGt,
    skippedNoTimeline,
    skippedNoClob,
    baseRate,
    clobPriceBuckets,
    marketWrongRate,
    contrarianOpportunities: contrarianOpportunities.slice(0, 40), // Top 40
    clMoveVerification,
    summary,
  };
}

// =========================================================================
// HELPERS
// =========================================================================

function round(n, decimals) {
  if (n == null || isNaN(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeClMoveBuckets(stats) {
  const buckets = [
    { label: '< $0.01', lo: 0, hi: 0.01 },
    { label: '$0.01-0.05', lo: 0.01, hi: 0.05 },
    { label: '$0.05-0.10', lo: 0.05, hi: 0.10 },
    { label: '$0.10-0.50', lo: 0.10, hi: 0.50 },
    { label: '$0.50-1.00', lo: 0.50, hi: 1.00 },
    { label: '> $1.00', lo: 1.00, hi: Infinity },
  ];

  return buckets.map(b => {
    const count = stats.filter(w => Math.abs(w.clChange) >= b.lo && Math.abs(w.clChange) < b.hi).length;
    return {
      range: b.label,
      count,
      pct: stats.length > 0 ? round(count / stats.length * 100, 1) : 0,
    };
  });
}
