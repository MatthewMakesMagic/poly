/**
 * Final-60s Analysis Module
 *
 * Analyzes the last 60 seconds of each window to find indicators
 * that predict resolution (UP/DOWN). Computes CL deficit, CL direction/speed,
 * exchange-vs-CL spread, CLOB pricing, and ranks predictive accuracy.
 *
 * Input: array of deserialized windows with timelines from pg_timelines.
 * Output: structured JSON with indicator rankings and radical shift stats.
 */

/**
 * Run the final-60s analysis on an array of windows.
 *
 * @param {Array<{ meta: Object, timeline: Object[] }>} windows
 * @param {Object} [options]
 * @param {string} [options.symbol] - Symbol label for output
 * @returns {Object} Structured analysis results
 */
export function analyze(windows, options = {}) {
  const symbol = options.symbol || 'unknown';
  const windowStats = [];
  let withRtds = 0;
  let withL2 = 0;
  let skippedNoGt = 0;
  let skippedNoTimeline = 0;

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
    const t60 = closeTime - 60_000; // 60 seconds before close

    // Partition events into before-T60 and last-60s
    const last60Events = timeline.filter(e => (e._ms || e.timestamp) >= t60);
    const before60Events = timeline.filter(e => (e._ms || e.timestamp) < t60);

    // --- Chainlink data ---
    const clEvents = timeline.filter(e => e.source === 'chainlink');
    const clLast60 = clEvents.filter(e => (e._ms || e.timestamp) >= t60);
    const clBefore60 = clEvents.filter(e => (e._ms || e.timestamp) < t60);

    // CL price at ~T-60 (last CL event before the 60s window)
    const clAtT60 = clBefore60.length > 0 ? clBefore60[clBefore60.length - 1] : null;
    // CL price at close (last CL event overall)
    const clAtClose = clEvents.length > 0 ? clEvents[clEvents.length - 1] : null;

    if (!clAtClose) continue; // Need at least CL at close

    const clPriceAtClose = clAtClose.price;
    const clPriceAtT60 = clAtT60 ? clAtT60.price : clPriceAtClose;
    const strikePrice = meta.strike_price;
    const resolution = (meta.ground_truth || '').toUpperCase(); // normalize to 'UP' or 'DOWN'

    // CL deficit: how far below strike (negative = below = DOWN likely)
    const clDeficit = clPriceAtClose - strikePrice;

    // CL direction in last 60s
    const clChange = clPriceAtClose - clPriceAtT60;
    const clDirection = clChange > 0 ? 'up' : clChange < 0 ? 'down' : 'flat';
    const clSpeed = Math.abs(clChange) / 60; // $/sec

    // --- Exchange data ---
    const exchangeEvents = timeline.filter(e =>
      e.source && e.source.startsWith('exchange_')
    );
    const exchangeLast60 = exchangeEvents.filter(e => (e._ms || e.timestamp) >= t60);
    let exchangeMedianVsCl = null;
    let hasRtds = false;

    if (exchangeLast60.length > 0) {
      hasRtds = true;
      withRtds++;
      const prices = exchangeLast60
        .map(e => e.price)
        .filter(p => p != null)
        .sort((a, b) => a - b);
      if (prices.length > 0) {
        const median = prices[Math.floor(prices.length / 2)];
        exchangeMedianVsCl = median - clPriceAtClose;
      }
    }

    // --- CLOB data ---
    const clobDownEvents = timeline.filter(e => e.source === 'clobDown');
    const clobDownLast60 = clobDownEvents.filter(e => (e._ms || e.timestamp) >= t60);
    let clobDownPrice = null;
    let clobSpread = null;

    if (clobDownLast60.length > 0) {
      const lastClob = clobDownLast60[clobDownLast60.length - 1];
      clobDownPrice = lastClob.best_ask != null ? lastClob.best_ask : lastClob.mid_price;
      clobSpread = lastClob.spread != null ? lastClob.spread : null;
    } else if (clobDownEvents.length > 0) {
      // Use latest available
      const lastClob = clobDownEvents[clobDownEvents.length - 1];
      clobDownPrice = lastClob.best_ask != null ? lastClob.best_ask : lastClob.mid_price;
      clobSpread = lastClob.spread != null ? lastClob.spread : null;
    }

    // --- L2 data ---
    const l2Events = timeline.filter(e =>
      e.source === 'l2Down' || e.source === 'l2Up'
    );
    const l2Last60 = l2Events.filter(e => (e._ms || e.timestamp) >= t60);
    let hasL2 = l2Last60.length > 0;
    if (hasL2) withL2++;

    windowStats.push({
      windowId: meta.window_id,
      resolution,
      strikePrice,
      clPriceAtClose,
      clDeficit,
      clDirection,
      clChange,
      clSpeed,
      exchangeMedianVsCl,
      hasRtds,
      clobDownPrice,
      clobSpread,
      hasL2,
    });
  }

  // --- Aggregate: indicator analysis ---
  const indicators = [];
  const totalAnalyzed = windowStats.length;

  if (totalAnalyzed === 0) {
    return {
      symbol,
      windowsAnalyzed: 0,
      withRtds,
      withL2,
      skippedNoGt,
      skippedNoTimeline,
      indicators: [],
      radicalShifts: { pctWith1PctMove: 0, pctDirectionChange: 0 },
      summary: 'No windows with ground truth available for analysis.',
    };
  }

  // Helper: test an indicator threshold
  function testIndicator(name, filterFn) {
    const matching = windowStats.filter(filterFn);
    if (matching.length < 5) return null; // Need minimum sample
    const downCount = matching.filter(w => w.resolution === 'DOWN').length;
    const downRate = (downCount / matching.length) * 100;
    return {
      name,
      accuracy: Math.max(downRate, 100 - downRate),
      sampleSize: matching.length,
      downRate: Math.round(downRate * 10) / 10,
      upRate: Math.round((100 - downRate) * 10) / 10,
      predictedDirection: downRate > 50 ? 'DOWN' : 'UP',
    };
  }

  // CL deficit thresholds
  for (const thresh of [0.10, 0.25, 0.50, 1.00, 2.00, 5.00]) {
    const ind = testIndicator(
      `CL deficit < -$${thresh.toFixed(2)} (below strike)`,
      w => w.clDeficit < -thresh
    );
    if (ind) indicators.push(ind);

    const indAbove = testIndicator(
      `CL deficit > +$${thresh.toFixed(2)} (above strike)`,
      w => w.clDeficit > thresh
    );
    if (indAbove) indicators.push(indAbove);
  }

  // CL direction
  const indClDown = testIndicator(
    'CL moving DOWN in last 60s',
    w => w.clDirection === 'down'
  );
  if (indClDown) indicators.push(indClDown);

  const indClUp = testIndicator(
    'CL moving UP in last 60s',
    w => w.clDirection === 'up'
  );
  if (indClUp) indicators.push(indClUp);

  // CL speed thresholds
  for (const speed of [0.01, 0.05, 0.10, 0.50]) {
    const ind = testIndicator(
      `CL speed > $${speed}/sec AND moving DOWN`,
      w => w.clSpeed > speed && w.clDirection === 'down'
    );
    if (ind) indicators.push(ind);

    const indUp = testIndicator(
      `CL speed > $${speed}/sec AND moving UP`,
      w => w.clSpeed > speed && w.clDirection === 'up'
    );
    if (indUp) indicators.push(indUp);
  }

  // Exchange vs CL spread (only windows with RTDS)
  for (const thresh of [0.10, 0.25, 0.50, 1.00]) {
    const ind = testIndicator(
      `Exchange median > CL by $${thresh.toFixed(2)} (exchanges ahead UP)`,
      w => w.exchangeMedianVsCl != null && w.exchangeMedianVsCl > thresh
    );
    if (ind) indicators.push(ind);

    const indBelow = testIndicator(
      `Exchange median < CL by $${thresh.toFixed(2)} (exchanges ahead DOWN)`,
      w => w.exchangeMedianVsCl != null && w.exchangeMedianVsCl < -thresh
    );
    if (indBelow) indicators.push(indBelow);
  }

  // CLOB DOWN price thresholds
  for (const thresh of [0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
    const ind = testIndicator(
      `CLOB DOWN ask > $${thresh.toFixed(2)}`,
      w => w.clobDownPrice != null && w.clobDownPrice > thresh
    );
    if (ind) indicators.push(ind);
  }

  for (const thresh of [0.45, 0.40, 0.35, 0.30, 0.25, 0.20]) {
    const ind = testIndicator(
      `CLOB DOWN ask < $${thresh.toFixed(2)}`,
      w => w.clobDownPrice != null && w.clobDownPrice < thresh
    );
    if (ind) indicators.push(ind);
  }

  // CLOB spread thresholds
  for (const thresh of [0.02, 0.05, 0.10]) {
    const ind = testIndicator(
      `CLOB DOWN spread > $${thresh.toFixed(2)}`,
      w => w.clobSpread != null && w.clobSpread > thresh
    );
    if (ind) indicators.push(ind);
  }

  // Combined: CL deficit + CL direction
  const indCombined = testIndicator(
    'CL below strike AND moving DOWN',
    w => w.clDeficit < 0 && w.clDirection === 'down'
  );
  if (indCombined) indicators.push(indCombined);

  const indCombinedUp = testIndicator(
    'CL above strike AND moving UP',
    w => w.clDeficit > 0 && w.clDirection === 'up'
  );
  if (indCombinedUp) indicators.push(indCombinedUp);

  // Combined: CLOB + CL
  const indClobCl = testIndicator(
    'CLOB DOWN ask > $0.60 AND CL below strike',
    w => w.clobDownPrice != null && w.clobDownPrice > 0.60 && w.clDeficit < 0
  );
  if (indClobCl) indicators.push(indClobCl);

  // Sort indicators by accuracy descending
  indicators.sort((a, b) => b.accuracy - a.accuracy);

  // --- Radical shifts ---
  const strikePrices = windowStats.map(w => w.strikePrice).filter(p => p > 0);
  const avgStrike = strikePrices.length > 0
    ? strikePrices.reduce((s, p) => s + p, 0) / strikePrices.length
    : 1;
  const onePercentThreshold = avgStrike * 0.01;

  const radicalMoves = windowStats.filter(
    w => Math.abs(w.clChange) > onePercentThreshold
  );
  const directionChanges = windowStats.filter(
    w => (w.clDirection === 'down' && w.resolution === 'UP') ||
         (w.clDirection === 'up' && w.resolution === 'DOWN')
  );

  const radicalShifts = {
    pctWith1PctMove: Math.round((radicalMoves.length / totalAnalyzed) * 1000) / 10,
    pctDirectionChange: Math.round((directionChanges.length / totalAnalyzed) * 1000) / 10,
    avgClChangeAbs: Math.round((windowStats.reduce((s, w) => s + Math.abs(w.clChange), 0) / totalAnalyzed) * 100) / 100,
  };

  // Base rate
  const totalDown = windowStats.filter(w => w.resolution === 'DOWN').length;
  const baseDownRate = Math.round((totalDown / totalAnalyzed) * 1000) / 10;

  // Summary
  const topIndicator = indicators[0];
  const summary = topIndicator
    ? `Best predictor: "${topIndicator.name}" (${topIndicator.accuracy.toFixed(1)}% accuracy, n=${topIndicator.sampleSize}). ` +
      `Base rate: ${baseDownRate}% DOWN. ` +
      `${radicalShifts.pctWith1PctMove}% of windows had >1% CL move in final 60s. ` +
      `${withRtds}/${totalAnalyzed} windows had exchange (RTDS) data, ${withL2}/${totalAnalyzed} had L2 data.`
    : `No indicators met minimum sample threshold. Base rate: ${baseDownRate}% DOWN.`;

  return {
    symbol,
    windowsAnalyzed: totalAnalyzed,
    totalInputWindows: windows.length,
    withRtds,
    withL2,
    skippedNoGt,
    skippedNoTimeline,
    baseDownRate,
    indicators: indicators.slice(0, 30), // Top 30
    radicalShifts,
    summary,
  };
}
