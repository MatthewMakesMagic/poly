/**
 * Extreme CLOB Analysis
 *
 * Focuses on windows where CLOB tokens are priced at extremes near close (<$0.10 or >$0.90).
 * These represent high-confidence market bets. When the market is wrong at these prices,
 * the contrarian payout is massive (9:1 or better).
 *
 * Key question: what signals predict when extreme CLOB pricing is WRONG?
 */

export function analyze(windowsWithTimelines, options = {}) {
  const symbol = options.symbol || '?';
  const timingOffsets = [60000, 30000, 10000, 5000]; // T-60s, T-30s, T-10s, T-5s

  const results = {
    symbol,
    windowsAnalyzed: 0,
    timings: {},
  };

  for (const offsetMs of timingOffsets) {
    const label = `T-${offsetMs / 1000}s`;
    const snapshots = [];

    for (const { meta, timeline } of windowsWithTimelines) {
      if (!timeline || !Array.isArray(timeline)) continue;
      if (!meta.ground_truth) continue;

      const closeMs = new Date(meta.window_close_time).getTime();
      const targetMs = closeMs - offsetMs;
      const resolution = meta.ground_truth.toUpperCase();

      // Find CLOB state nearest to target time
      let clobDown = null;
      let clobUp = null;
      let latestExchangeMedian = null;
      let latestPyth = null;

      const exchangePrices = [];

      for (const event of timeline) {
        const eventMs = event._ms || new Date(event.timestamp).getTime();
        if (eventMs > targetMs) break; // past our target time

        if (event.source === 'clobDown') {
          clobDown = {
            bestBid: parseFloat(event.best_bid || event.bestBid || 0),
            bestAsk: parseFloat(event.best_ask || event.bestAsk || 0),
            mid: parseFloat(event.mid_price || event.mid || 0),
          };
        } else if (event.source === 'clobUp') {
          clobUp = {
            bestBid: parseFloat(event.best_bid || event.bestBid || 0),
            bestAsk: parseFloat(event.best_ask || event.bestAsk || 0),
            mid: parseFloat(event.mid_price || event.mid || 0),
          };
        } else if (event.source?.startsWith('exchange_')) {
          const price = parseFloat(event.price);
          if (price > 0 && price < 1000000) {
            // Track recent exchange prices (last 10 seconds of data before target)
            if (eventMs > targetMs - 10000) {
              exchangePrices.push(price);
            }
          }
        } else if (event.source === 'pyth') {
          latestPyth = parseFloat(event.price);
        }
      }

      if (!clobDown || !clobUp) continue;
      if (clobDown.bestAsk <= 0 || clobUp.bestAsk <= 0) continue;

      // Exchange median
      if (exchangePrices.length > 0) {
        exchangePrices.sort((a, b) => a - b);
        latestExchangeMedian = exchangePrices[Math.floor(exchangePrices.length / 2)];
      }

      const strike = parseFloat(meta.oracle_price_at_open || meta.strike_price || 0);
      const exchangeAboveStrike = latestExchangeMedian && strike ? latestExchangeMedian > strike : null;

      snapshots.push({
        windowId: meta.window_id,
        resolution,
        clobDownAsk: clobDown.bestAsk,
        clobDownBid: clobDown.bestBid,
        clobDownMid: clobDown.mid,
        clobUpAsk: clobUp.bestAsk,
        clobUpMid: clobUp.mid,
        exchangeMedian: latestExchangeMedian,
        pythPrice: latestPyth,
        strike,
        exchangeAboveStrike,
      });
    }

    // Bucket by CLOB DOWN ask price
    const buckets = [
      { label: '$0.00-0.05', min: 0, max: 0.05 },
      { label: '$0.05-0.10', min: 0.05, max: 0.10 },
      { label: '$0.10-0.15', min: 0.10, max: 0.15 },
      { label: '$0.15-0.20', min: 0.15, max: 0.20 },
      { label: '$0.20-0.30', min: 0.20, max: 0.30 },
      { label: '$0.30-0.40', min: 0.30, max: 0.40 },
      { label: '$0.40-0.50', min: 0.40, max: 0.50 },
      { label: '$0.50-0.60', min: 0.50, max: 0.60 },
      { label: '$0.60-0.70', min: 0.60, max: 0.70 },
      { label: '$0.70-0.80', min: 0.70, max: 0.80 },
      { label: '$0.80-0.90', min: 0.80, max: 0.90 },
      { label: '$0.90-0.95', min: 0.90, max: 0.95 },
      { label: '$0.95-1.00', min: 0.95, max: 1.00 },
    ];

    const bucketResults = buckets.map(b => {
      const windows = snapshots.filter(s => s.clobDownAsk >= b.min && s.clobDownAsk < b.max);
      const total = windows.length;
      if (total === 0) return { ...b, count: 0 };

      const downResolved = windows.filter(w => w.resolution === 'DOWN').length;
      const upResolved = total - downResolved;
      const downPct = (downResolved / total) * 100;

      // EV of buying DOWN at this price
      const avgDownAsk = windows.reduce((s, w) => s + w.clobDownAsk, 0) / total;
      const evBuyDown = (downPct / 100) * (1 - avgDownAsk) - ((100 - downPct) / 100) * avgDownAsk;

      // EV of buying UP at this price
      const avgUpAsk = windows.reduce((s, w) => s + w.clobUpAsk, 0) / total;
      const evBuyUp = ((100 - downPct) / 100) * (1 - avgUpAsk) - (downPct / 100) * avgUpAsk;

      // When exchange disagrees with CLOB at this price level
      const exchangeDisagrees = windows.filter(w => {
        if (w.exchangeAboveStrike === null) return false;
        const clobSaysDown = w.clobDownAsk > 0.55;
        const clobSaysUp = w.clobDownAsk < 0.45;
        if (clobSaysDown) return w.exchangeAboveStrike; // exchange says UP, CLOB says DOWN
        if (clobSaysUp) return !w.exchangeAboveStrike; // exchange says DOWN, CLOB says UP
        return false;
      });

      const exchangeDisagreeCorrect = exchangeDisagrees.filter(w => {
        if (w.exchangeAboveStrike) return w.resolution === 'UP';
        return w.resolution === 'DOWN';
      });

      return {
        ...b,
        count: total,
        downResolved,
        upResolved,
        downPct: Math.round(downPct * 10) / 10,
        avgDownAsk: Math.round(avgDownAsk * 1000) / 1000,
        avgUpAsk: Math.round(avgUpAsk * 1000) / 1000,
        evBuyDown: Math.round(evBuyDown * 1000) / 1000,
        evBuyUp: Math.round(evBuyUp * 1000) / 1000,
        exchangeDisagreeCount: exchangeDisagrees.length,
        exchangeDisagreeCorrectPct: exchangeDisagrees.length > 0
          ? Math.round((exchangeDisagreeCorrect.length / exchangeDisagrees.length) * 1000) / 10
          : null,
        // Individual windows at extremes for inspection
        windows: total <= 20 ? windows.map(w => ({
          id: w.windowId,
          res: w.resolution,
          downAsk: Math.round(w.clobDownAsk * 1000) / 1000,
          upAsk: Math.round(w.clobUpAsk * 1000) / 1000,
          exch: w.exchangeMedian ? Math.round(w.exchangeMedian * 100) / 100 : null,
          strike: Math.round(w.strike * 100) / 100,
        })) : undefined,
      };
    });

    results.timings[label] = {
      totalSnapshots: snapshots.length,
      baseRate: {
        downPct: snapshots.length > 0 ? Math.round((snapshots.filter(s => s.resolution === 'DOWN').length / snapshots.length) * 1000) / 10 : 0,
      },
      buckets: bucketResults.filter(b => b.count > 0),
    };
  }

  results.windowsAnalyzed = windowsWithTimelines.length;
  return results;
}
