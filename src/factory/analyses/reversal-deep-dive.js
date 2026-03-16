/**
 * Reversal Deep-Dive Analysis Module
 *
 * Finds windows where the CLOB was pricing a token under $0.20 (market very confident)
 * but the resolution went AGAINST the market (the market was WRONG).
 *
 * For each reversal, builds a tick-by-tick narrative of the final 60 seconds,
 * identifies the "tell" (earliest signal that could have predicted the reversal),
 * and compares reversals vs non-reversals to find differentiators.
 *
 * Key questions:
 *   - What happened tick-by-tick in reversal windows?
 *   - When did exchanges start moving against the CLOB consensus?
 *   - Did Pyth lead exchanges? Did L2 depth change?
 *   - What distinguishes reversals from non-reversals at the same price level?
 *
 * Input: array of { meta, timeline } from pg_timelines cache.
 * Output: structured JSON with detailed reversal narratives and comparative stats.
 *
 * @module factory/analyses/reversal-deep-dive
 */

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

/**
 * Check if a price looks like wrong-symbol data (BTC prices for SOL/XRP).
 */
function looksLikeBtcPrice(price, symbol) {
  if (!price || !symbol) return false;
  const s = symbol.toLowerCase();
  if (s === 'btc') return false;
  if (s === 'sol' && price > 1000) return true;
  if (s === 'xrp' && price > 50) return true;
  if (s === 'eth' && price > 50000) return true;
  return false;
}

/**
 * Get latest event of a given source at or before a timestamp.
 */
function getLatestEvent(timeline, source, beforeMs) {
  let latest = null;
  for (const e of timeline) {
    if (e.source !== source) continue;
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
 * Get exchange median price from events within a time window.
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
  return { median: median(prices), count: prices.length, prices };
}

/**
 * Extract CLOB DOWN ask price from a CLOB event.
 */
function getClobPrice(event) {
  if (!event) return null;
  return event.best_ask != null ? parseFloat(event.best_ask) : parseFloat(event.mid_price || 0);
}

/**
 * Extract CLOB spread from a CLOB event.
 */
function getClobSpread(event) {
  if (!event) return null;
  return event.spread != null ? parseFloat(event.spread) : null;
}

// ─── Snapshot Builder ───

/**
 * Build a snapshot of market state at a given time offset.
 */
function buildSnapshot(timeline, closeMs, offsetSeconds, strikePrice, symbol) {
  const T = closeMs - offsetSeconds * 1000;

  // Exchange median (5-second window around T)
  const exch = getExchangeMedian(timeline, T - 5000, T);

  // Pyth price
  const pythEvent = getLatestEvent(timeline, 'pyth', T);
  const pythPrice = pythEvent ? parseFloat(pythEvent.price) : null;

  // CLOB DOWN
  const clobDownEvent = getLatestEvent(timeline, 'clobDown', T);
  const clobDownAsk = getClobPrice(clobDownEvent);
  const clobDownSpread = getClobSpread(clobDownEvent);
  const clobDownBid = clobDownEvent?.best_bid != null ? parseFloat(clobDownEvent.best_bid) : null;

  // CLOB UP
  const clobUpEvent = getLatestEvent(timeline, 'clobUp', T);
  const clobUpAsk = getClobPrice(clobUpEvent);

  // L2 DOWN
  const l2DownEvent = getLatestEvent(timeline, 'l2Down', T);
  let l2BidDepth = null, l2AskDepth = null;
  if (l2DownEvent) {
    l2BidDepth = parseFloat(l2DownEvent.bid_depth_1pct || l2DownEvent.total_bid_size || 0);
    l2AskDepth = parseFloat(l2DownEvent.ask_depth_1pct || l2DownEvent.total_ask_size || 0);
  }

  // L2 UP
  const l2UpEvent = getLatestEvent(timeline, 'l2Up', T);
  let l2UpBidDepth = null, l2UpAskDepth = null;
  if (l2UpEvent) {
    l2UpBidDepth = parseFloat(l2UpEvent.bid_depth_1pct || l2UpEvent.total_bid_size || 0);
    l2UpAskDepth = parseFloat(l2UpEvent.ask_depth_1pct || l2UpEvent.total_ask_size || 0);
  }

  return {
    exchangeMedian: exch.median,
    exchangeCount: exch.count,
    pythPrice,
    clobDownAsk,
    clobDownBid,
    clobDownSpread,
    clobUpAsk,
    l2BidDepth,
    l2AskDepth,
    l2UpBidDepth,
    l2UpAskDepth,
    exchangeVsStrike: exch.median != null && strikePrice ? round(exch.median - strikePrice, 4) : null,
    pythVsStrike: pythPrice != null && strikePrice ? round(pythPrice - strikePrice, 4) : null,
  };
}

// ─── Narrative Builder ───

/**
 * Build a tick-by-tick narrative of the last 60 seconds of a window.
 * Returns an array of events sorted by relative time (seconds before close, negative).
 */
function buildNarrative(timeline, closeMs, strikePrice) {
  const t60 = closeMs - 60000;
  const events = [];

  // Track previous values to compute deltas
  let prevExchangePrice = null;
  let prevClobDownAsk = null;
  let prevClobUpAsk = null;
  let prevPythPrice = null;

  // Get initial state at T-60
  for (const e of timeline) {
    const ts = e._ms || e.timestamp;
    if (ts > t60) break;
    if (e.source?.startsWith('exchange_') && e.price != null) prevExchangePrice = parseFloat(e.price);
    if (e.source === 'clobDown') prevClobDownAsk = getClobPrice(e);
    if (e.source === 'clobUp') prevClobUpAsk = getClobPrice(e);
    if (e.source === 'pyth' && e.price != null) prevPythPrice = parseFloat(e.price);
  }

  for (const e of timeline) {
    const ts = e._ms || e.timestamp;
    if (ts < t60 || ts > closeMs) continue;

    const relativeT = round((ts - closeMs) / 1000, 1); // negative seconds before close

    if (e.source?.startsWith('exchange_') && e.price != null) {
      const price = parseFloat(e.price);
      const vsStrike = strikePrice ? round(price - strikePrice, 4) : null;
      const delta = prevExchangePrice != null ? round(price - prevExchangePrice, 4) : null;
      events.push({
        t: relativeT,
        event: 'exchange',
        source: e.source,
        price: round(price, 4),
        vs_strike: vsStrike,
        delta,
      });
      prevExchangePrice = price;
    } else if (e.source === 'pyth' && e.price != null) {
      const price = parseFloat(e.price);
      const vsStrike = strikePrice ? round(price - strikePrice, 4) : null;
      const delta = prevPythPrice != null ? round(price - prevPythPrice, 4) : null;
      events.push({
        t: relativeT,
        event: 'pyth',
        price: round(price, 4),
        vs_strike: vsStrike,
        delta,
      });
      prevPythPrice = price;
    } else if (e.source === 'clobDown') {
      const ask = getClobPrice(e);
      const spread = getClobSpread(e);
      const shift = prevClobDownAsk != null && ask != null ? round(ask - prevClobDownAsk, 4) : null;
      events.push({
        t: relativeT,
        event: 'clob_down',
        ask: round(ask, 4),
        bid: e.best_bid != null ? round(parseFloat(e.best_bid), 4) : null,
        spread: round(spread, 4),
        shift,
      });
      prevClobDownAsk = ask;
    } else if (e.source === 'clobUp') {
      const ask = getClobPrice(e);
      const shift = prevClobUpAsk != null && ask != null ? round(ask - prevClobUpAsk, 4) : null;
      events.push({
        t: relativeT,
        event: 'clob_up',
        ask: round(ask, 4),
        bid: e.best_bid != null ? round(parseFloat(e.best_bid), 4) : null,
        shift,
      });
      prevClobUpAsk = ask;
    } else if (e.source === 'l2Down' || e.source === 'l2Up') {
      const bidDepth = parseFloat(e.bid_depth_1pct || e.total_bid_size || 0);
      const askDepth = parseFloat(e.ask_depth_1pct || e.total_ask_size || 0);
      events.push({
        t: relativeT,
        event: e.source === 'l2Down' ? 'l2_down' : 'l2_up',
        bidDepth: round(bidDepth, 2),
        askDepth: round(askDepth, 2),
        imbalance: bidDepth + askDepth > 0 ? round((bidDepth - askDepth) / (bidDepth + askDepth), 3) : null,
      });
    }
  }

  return events;
}

// ─── Tell Finder ───

/**
 * Analyze the narrative to find the "tell" — the earliest signal that predicted the reversal.
 *
 * For a reversal where e.g. CLOB said UP (DOWN was cheap) but it resolved DOWN:
 *   - Look for when exchanges started going below strike
 *   - Look for exchange velocity ($/sec) moving against consensus
 *   - Check if Pyth showed the move before exchanges
 *   - Check CLOB spread widening
 *   - Check L2 depth changes
 */
function findTell(narrative, resolution, cheapSide, strikePrice, clobDownAskAtEntry) {
  const tell = {
    exchangeReversedAt: null,        // seconds before close when exchange crossed strike against consensus
    exchangeSpeedAtReversal: null,    // $/sec at point of reversal
    pythLeadExchangeBy: null,        // seconds Pyth showed direction before exchange confirmed
    clobLaggedBy: null,              // seconds CLOB took to reprice after exchange moved
    clobSpreadWidenedAt: null,       // when CLOB spread started widening
    l2DepthChangedAt: null,          // when L2 depth shifted meaningfully
    earlyExchangeVelocity: null,     // exchange velocity in the T-60 to T-30 period
    lateExchangeVelocity: null,      // exchange velocity in the T-30 to T-0 period
    maxExchangeDeviation: null,      // max deviation of exchange from strike in reversal direction
    clobRepriceAmount: null,         // how much CLOB repriced in last 60s
    signalSummary: null,             // human-readable summary
  };

  // Determine what "crossing strike" means for this reversal
  // If resolution is DOWN: exchange going BELOW strike is the reversal signal
  // If resolution is UP: exchange going ABOVE strike is the reversal signal
  const reversalDirection = resolution === 'DOWN' ? 'below' : 'above';

  // Exchange events
  const exchangeEvents = narrative.filter(e => e.event === 'exchange' && e.price != null);
  const pythEvents = narrative.filter(e => e.event === 'pyth' && e.price != null);
  const clobDownEvents = narrative.filter(e => e.event === 'clob_down' && e.ask != null);
  const l2Events = narrative.filter(e => e.event === 'l2_down' || e.event === 'l2_up');

  // Find when exchange first crossed strike in the reversal direction
  for (const e of exchangeEvents) {
    if (strikePrice == null) break;
    const crossed = reversalDirection === 'below'
      ? e.price < strikePrice
      : e.price > strikePrice;
    if (crossed && tell.exchangeReversedAt === null) {
      tell.exchangeReversedAt = e.t;
      break;
    }
  }

  // Exchange velocity: compute in early vs late halves
  const earlyExch = exchangeEvents.filter(e => e.t >= -60 && e.t < -30);
  const lateExch = exchangeEvents.filter(e => e.t >= -30);

  if (earlyExch.length >= 2) {
    const first = earlyExch[0];
    const last = earlyExch[earlyExch.length - 1];
    const dt = last.t - first.t;
    if (dt !== 0) {
      tell.earlyExchangeVelocity = round((last.price - first.price) / Math.abs(dt), 4);
    }
  }

  if (lateExch.length >= 2) {
    const first = lateExch[0];
    const last = lateExch[lateExch.length - 1];
    const dt = last.t - first.t;
    if (dt !== 0) {
      tell.lateExchangeVelocity = round((last.price - first.price) / Math.abs(dt), 4);
    }
  }

  // Exchange speed at reversal point
  if (tell.exchangeReversedAt != null && exchangeEvents.length >= 2) {
    // Find events around the reversal time
    const nearReversal = exchangeEvents.filter(e => Math.abs(e.t - tell.exchangeReversedAt) < 10);
    if (nearReversal.length >= 2) {
      const first = nearReversal[0];
      const last = nearReversal[nearReversal.length - 1];
      const dt = last.t - first.t;
      if (dt !== 0) {
        tell.exchangeSpeedAtReversal = round((last.price - first.price) / Math.abs(dt), 4);
      }
    }
  }

  // Max exchange deviation from strike in reversal direction
  if (strikePrice != null && exchangeEvents.length > 0) {
    let maxDev = 0;
    for (const e of exchangeEvents) {
      const dev = reversalDirection === 'below'
        ? strikePrice - e.price  // positive when below strike
        : e.price - strikePrice; // positive when above strike
      if (dev > maxDev) maxDev = dev;
    }
    tell.maxExchangeDeviation = round(maxDev, 4);
  }

  // Pyth lead time: did Pyth cross strike before exchange?
  if (strikePrice != null && pythEvents.length > 0) {
    let pythCrossedAt = null;
    for (const e of pythEvents) {
      const crossed = reversalDirection === 'below'
        ? e.price < strikePrice
        : e.price > strikePrice;
      if (crossed) {
        pythCrossedAt = e.t;
        break;
      }
    }
    if (pythCrossedAt != null && tell.exchangeReversedAt != null) {
      tell.pythLeadExchangeBy = round(tell.exchangeReversedAt - pythCrossedAt, 1);
    }
  }

  // CLOB lag: how long after exchange crossed did CLOB start repricing?
  if (tell.exchangeReversedAt != null && clobDownEvents.length >= 2) {
    // For DOWN resolution: CLOB DOWN ask should INCREASE (market recognizing DOWN is more likely)
    // For UP resolution: CLOB DOWN ask should DECREASE (market recognizing UP is more likely)
    const expectedDirection = resolution === 'DOWN' ? 1 : -1;
    let clobMovedAt = null;

    for (const e of clobDownEvents) {
      if (e.t < tell.exchangeReversedAt) continue;
      if (e.shift != null && e.shift * expectedDirection > 0.01) {
        clobMovedAt = e.t;
        break;
      }
    }
    if (clobMovedAt != null) {
      tell.clobLaggedBy = round(clobMovedAt - tell.exchangeReversedAt, 1);
    }
  }

  // CLOB reprice amount: total shift in last 60s
  if (clobDownEvents.length >= 2) {
    const first = clobDownEvents[0];
    const last = clobDownEvents[clobDownEvents.length - 1];
    if (first.ask != null && last.ask != null) {
      tell.clobRepriceAmount = round(last.ask - first.ask, 4);
    }
  }

  // CLOB spread widening
  const spreads = clobDownEvents.filter(e => e.spread != null);
  if (spreads.length >= 2) {
    const baseSpread = spreads[0].spread;
    for (const e of spreads) {
      if (e.spread > baseSpread * 1.5 && e.spread > baseSpread + 0.01) {
        tell.clobSpreadWidenedAt = e.t;
        break;
      }
    }
  }

  // L2 depth change
  if (l2Events.length >= 2) {
    const first = l2Events[0];
    for (let i = 1; i < l2Events.length; i++) {
      const e = l2Events[i];
      if (first.bidDepth > 0 && e.bidDepth < first.bidDepth * 0.5) {
        tell.l2DepthChangedAt = e.t;
        break;
      }
      if (first.askDepth > 0 && e.askDepth < first.askDepth * 0.5) {
        tell.l2DepthChangedAt = e.t;
        break;
      }
    }
  }

  // Build signal summary
  const signals = [];
  if (tell.exchangeReversedAt != null) {
    signals.push(`Exchange crossed strike at T${tell.exchangeReversedAt}s`);
  }
  if (tell.pythLeadExchangeBy != null && tell.pythLeadExchangeBy > 0) {
    signals.push(`Pyth led exchange by ${tell.pythLeadExchangeBy}s`);
  }
  if (tell.clobLaggedBy != null) {
    signals.push(`CLOB lagged by ${tell.clobLaggedBy}s`);
  }
  if (tell.earlyExchangeVelocity != null && tell.lateExchangeVelocity != null) {
    const accel = round(Math.abs(tell.lateExchangeVelocity) - Math.abs(tell.earlyExchangeVelocity), 4);
    if (accel > 0.005) {
      signals.push(`Exchange accelerating (${accel > 0 ? '+' : ''}${accel} $/s^2)`);
    }
  }
  if (tell.clobSpreadWidenedAt != null) {
    signals.push(`CLOB spread widened at T${tell.clobSpreadWidenedAt}s`);
  }
  if (tell.l2DepthChangedAt != null) {
    signals.push(`L2 depth shifted at T${tell.l2DepthChangedAt}s`);
  }
  tell.signalSummary = signals.length > 0 ? signals.join('; ') : 'No clear tell detected';

  return tell;
}

// ─── Main Analysis ───

/**
 * Run the reversal deep-dive analysis.
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

  const CHEAP_THRESHOLD = 0.20; // token priced under this is "cheap"
  const TIMING_OFFSETS = [
    { label: 'T-60s', seconds: 60 },
    { label: 'T-30s', seconds: 30 },
  ];

  // Collect all reversal candidates
  const candidates = [];

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
    const closeMs = new Date(meta.window_close_time).getTime();

    // Sanity check: skip windows with wrong-symbol exchange data
    const exchangeEvents = timeline.filter(e => e.source?.startsWith('exchange_') && e.price != null);
    if (exchangeEvents.length > 0) {
      const samplePrices = exchangeEvents.slice(0, 10).map(e => e.price);
      if (samplePrices.some(p => looksLikeBtcPrice(p, symbol))) {
        skippedBadData++;
        continue;
      }
    }

    // Check Pyth too
    const pythEvents = timeline.filter(e => e.source === 'pyth' && e.price != null);
    if (pythEvents.length > 0) {
      if (pythEvents.slice(0, 5).some(e => looksLikeBtcPrice(e.price, symbol))) {
        skippedBadData++;
        continue;
      }
    }

    // Check each timing offset for cheap tokens
    for (const { label, seconds } of TIMING_OFFSETS) {
      const snap = buildSnapshot(timeline, closeMs, seconds, strikePrice, symbol);

      if (snap.clobDownAsk == null || snap.clobDownAsk <= 0 || snap.clobDownAsk >= 1) continue;

      // Compute UP ask (complement)
      const clobUpAsk = snap.clobUpAsk != null ? snap.clobUpAsk : (1 - snap.clobDownAsk);

      // Check if DOWN token is cheap (under threshold)
      const downIsCheap = snap.clobDownAsk < CHEAP_THRESHOLD;
      // Check if UP token is cheap (DOWN ask is high, meaning UP ask = 1 - DOWN bid is low)
      const upIsCheap = clobUpAsk < CHEAP_THRESHOLD;

      if (!downIsCheap && !upIsCheap) continue;

      // Determine which side is cheap
      const cheapSide = downIsCheap ? 'DOWN' : 'UP';
      const cheapPrice = downIsCheap ? snap.clobDownAsk : clobUpAsk;
      const isReversal = cheapSide === resolution; // cheap side won = market was WRONG

      // Build the narrative for this window
      const narrative = buildNarrative(timeline, closeMs, strikePrice);

      // Find the tell (only detailed analysis for reversals, but compute for non-reversals too for comparison)
      const tell = findTell(narrative, resolution, cheapSide, strikePrice, cheapPrice);

      candidates.push({
        windowId: meta.window_id,
        timing: label,
        cheapSide,
        cheapPrice: round(cheapPrice, 4),
        resolution,
        isReversal,
        classification: isReversal ? 'reversed' : 'confirmed',
        strikePrice: round(strikePrice, 2),
        oraclePriceAtOpen: round(meta.oracle_price_at_open, 2),
        windowCloseTime: meta.window_close_time,
        snapshotAtEntry: {
          exchangeMedian: round(snap.exchangeMedian, 4),
          exchangeVsStrike: snap.exchangeVsStrike,
          pythPrice: round(snap.pythPrice, 4),
          pythVsStrike: snap.pythVsStrike,
          clobDownAsk: round(snap.clobDownAsk, 4),
          clobDownSpread: round(snap.clobDownSpread, 4),
          clobUpAsk: round(clobUpAsk, 4),
          l2BidDepth: round(snap.l2BidDepth, 2),
          l2AskDepth: round(snap.l2AskDepth, 2),
          hasExchange: snap.exchangeMedian != null,
          hasPyth: snap.pythPrice != null,
          hasL2: snap.l2BidDepth != null,
        },
        narrative,
        tell,
      });
    }
  }

  // Split into reversals and non-reversals
  const reversals = candidates.filter(c => c.isReversal);
  const nonReversals = candidates.filter(c => !c.isReversal);

  // ─── Comparative Statistics ───
  const comparison = buildComparison(reversals, nonReversals);

  // ─── Bucket breakdown (by timing and price bucket) ───
  const bucketBreakdown = buildBucketBreakdown(candidates);

  // ─── Summary ───
  const summaryLines = [
    `Reversal Deep-Dive for ${symbol.toUpperCase()}: ${windows.length} input windows.`,
    `Skipped: ${skippedNoGt} no ground truth, ${skippedNoTimeline} no timeline, ${skippedBadData} bad data.`,
    `Found ${candidates.length} cheap-token candidates (token < $${CHEAP_THRESHOLD}).`,
    `${reversals.length} reversals (market was WRONG), ${nonReversals.length} confirmed (market was RIGHT).`,
    `Reversal rate: ${candidates.length > 0 ? round(reversals.length / candidates.length * 100, 1) : 0}%.`,
  ];

  if (reversals.length > 0) {
    const avgTell = reversals
      .filter(r => r.tell.exchangeReversedAt != null)
      .map(r => r.tell.exchangeReversedAt);
    if (avgTell.length > 0) {
      const avgReversalTime = round(avgTell.reduce((s, t) => s + t, 0) / avgTell.length, 1);
      summaryLines.push(
        `Average exchange reversal signal at T${avgReversalTime}s (${avgTell.length}/${reversals.length} had exchange crossing strike).`
      );
    }
  }

  return {
    symbol,
    totalInputWindows: windows.length,
    skippedNoGt,
    skippedNoTimeline,
    skippedBadData,
    cheapThreshold: CHEAP_THRESHOLD,
    totalCandidates: candidates.length,
    totalReversals: reversals.length,
    totalConfirmed: nonReversals.length,
    reversalRate: candidates.length > 0 ? round(reversals.length / candidates.length * 100, 1) : 0,
    reversals: reversals.map(r => ({
      windowId: r.windowId,
      timing: r.timing,
      cheapSide: r.cheapSide,
      cheapPrice: r.cheapPrice,
      resolution: r.resolution,
      strikePrice: r.strikePrice,
      windowCloseTime: r.windowCloseTime,
      snapshotAtEntry: r.snapshotAtEntry,
      narrative: r.narrative,
      tell: r.tell,
    })),
    nonReversals: nonReversals.map(r => ({
      windowId: r.windowId,
      timing: r.timing,
      cheapSide: r.cheapSide,
      cheapPrice: r.cheapPrice,
      resolution: r.resolution,
      strikePrice: r.strikePrice,
      windowCloseTime: r.windowCloseTime,
      snapshotAtEntry: r.snapshotAtEntry,
      tell: r.tell,
      // Omit full narrative for non-reversals to reduce output size, keep tell
    })),
    comparison,
    bucketBreakdown,
    summary: summaryLines.join(' '),
  };
}

// ─── Comparison Builder ───

/**
 * Build comparative statistics between reversals and non-reversals.
 */
function buildComparison(reversals, nonReversals) {
  if (reversals.length === 0 && nonReversals.length === 0) {
    return { note: 'No candidates found' };
  }

  function groupStats(group, label) {
    if (group.length === 0) return { label, count: 0 };

    // Exchange velocity stats
    const earlyVelocities = group
      .filter(c => c.tell.earlyExchangeVelocity != null)
      .map(c => c.tell.earlyExchangeVelocity);
    const lateVelocities = group
      .filter(c => c.tell.lateExchangeVelocity != null)
      .map(c => c.tell.lateExchangeVelocity);

    // Exchange vs strike at entry
    const exchVsStrike = group
      .filter(c => c.snapshotAtEntry.exchangeVsStrike != null)
      .map(c => c.snapshotAtEntry.exchangeVsStrike);

    // Pyth vs strike at entry
    const pythVsStrike = group
      .filter(c => c.snapshotAtEntry.pythVsStrike != null)
      .map(c => c.snapshotAtEntry.pythVsStrike);

    // CLOB spread
    const clobSpreads = group
      .filter(c => c.snapshotAtEntry.clobDownSpread != null)
      .map(c => c.snapshotAtEntry.clobDownSpread);

    // Exchange reversal timing
    const exchangeReversalTimes = group
      .filter(c => c.tell.exchangeReversedAt != null)
      .map(c => c.tell.exchangeReversedAt);

    // Max exchange deviation
    const maxDeviations = group
      .filter(c => c.tell.maxExchangeDeviation != null)
      .map(c => c.tell.maxExchangeDeviation);

    // CLOB reprice amount
    const clobReprices = group
      .filter(c => c.tell.clobRepriceAmount != null)
      .map(c => Math.abs(c.tell.clobRepriceAmount));

    // Pyth lead times
    const pythLeads = group
      .filter(c => c.tell.pythLeadExchangeBy != null)
      .map(c => c.tell.pythLeadExchangeBy);

    // CLOB lag
    const clobLags = group
      .filter(c => c.tell.clobLaggedBy != null)
      .map(c => c.tell.clobLaggedBy);

    // Data availability
    const withExchange = group.filter(c => c.snapshotAtEntry.hasExchange).length;
    const withPyth = group.filter(c => c.snapshotAtEntry.hasPyth).length;
    const withL2 = group.filter(c => c.snapshotAtEntry.hasL2).length;

    return {
      label,
      count: group.length,
      dataAvailability: {
        withExchange,
        withPyth,
        withL2,
      },
      avgEarlyExchangeVelocity: earlyVelocities.length > 0
        ? round(earlyVelocities.reduce((s, v) => s + v, 0) / earlyVelocities.length, 5) : null,
      avgLateExchangeVelocity: lateVelocities.length > 0
        ? round(lateVelocities.reduce((s, v) => s + v, 0) / lateVelocities.length, 5) : null,
      avgAbsEarlyVelocity: earlyVelocities.length > 0
        ? round(earlyVelocities.reduce((s, v) => s + Math.abs(v), 0) / earlyVelocities.length, 5) : null,
      avgAbsLateVelocity: lateVelocities.length > 0
        ? round(lateVelocities.reduce((s, v) => s + Math.abs(v), 0) / lateVelocities.length, 5) : null,
      avgExchangeVsStrike: exchVsStrike.length > 0
        ? round(exchVsStrike.reduce((s, v) => s + v, 0) / exchVsStrike.length, 4) : null,
      avgAbsExchangeVsStrike: exchVsStrike.length > 0
        ? round(exchVsStrike.reduce((s, v) => s + Math.abs(v), 0) / exchVsStrike.length, 4) : null,
      avgPythVsStrike: pythVsStrike.length > 0
        ? round(pythVsStrike.reduce((s, v) => s + v, 0) / pythVsStrike.length, 4) : null,
      avgClobSpread: clobSpreads.length > 0
        ? round(clobSpreads.reduce((s, v) => s + v, 0) / clobSpreads.length, 4) : null,
      avgExchangeReversalTime: exchangeReversalTimes.length > 0
        ? round(exchangeReversalTimes.reduce((s, v) => s + v, 0) / exchangeReversalTimes.length, 1) : null,
      exchangeReversalCount: exchangeReversalTimes.length,
      avgMaxDeviation: maxDeviations.length > 0
        ? round(maxDeviations.reduce((s, v) => s + v, 0) / maxDeviations.length, 4) : null,
      avgClobRepriceAmount: clobReprices.length > 0
        ? round(clobReprices.reduce((s, v) => s + v, 0) / clobReprices.length, 4) : null,
      avgPythLead: pythLeads.length > 0
        ? round(pythLeads.reduce((s, v) => s + v, 0) / pythLeads.length, 1) : null,
      avgClobLag: clobLags.length > 0
        ? round(clobLags.reduce((s, v) => s + v, 0) / clobLags.length, 1) : null,
    };
  }

  const reversalStats = groupStats(reversals, 'reversals');
  const confirmedStats = groupStats(nonReversals, 'confirmed');

  // Key differentiators
  const differentiators = [];

  if (reversalStats.avgAbsLateVelocity != null && confirmedStats.avgAbsLateVelocity != null) {
    const diff = round(reversalStats.avgAbsLateVelocity - confirmedStats.avgAbsLateVelocity, 5);
    if (Math.abs(diff) > 0.001) {
      differentiators.push({
        metric: 'Late exchange velocity (abs)',
        reversals: reversalStats.avgAbsLateVelocity,
        confirmed: confirmedStats.avgAbsLateVelocity,
        diff,
        interpretation: diff > 0
          ? 'Reversals have FASTER exchange moves in last 30s'
          : 'Confirmed have faster exchange moves in last 30s',
      });
    }
  }

  if (reversalStats.avgAbsExchangeVsStrike != null && confirmedStats.avgAbsExchangeVsStrike != null) {
    const diff = round(reversalStats.avgAbsExchangeVsStrike - confirmedStats.avgAbsExchangeVsStrike, 4);
    differentiators.push({
      metric: 'Exchange distance from strike (abs)',
      reversals: reversalStats.avgAbsExchangeVsStrike,
      confirmed: confirmedStats.avgAbsExchangeVsStrike,
      diff,
      interpretation: diff < 0
        ? 'Reversals have exchange CLOSER to strike (tighter, more uncertain)'
        : 'Reversals have exchange FURTHER from strike',
    });
  }

  if (reversalStats.avgClobSpread != null && confirmedStats.avgClobSpread != null) {
    const diff = round(reversalStats.avgClobSpread - confirmedStats.avgClobSpread, 4);
    differentiators.push({
      metric: 'CLOB spread',
      reversals: reversalStats.avgClobSpread,
      confirmed: confirmedStats.avgClobSpread,
      diff,
      interpretation: diff > 0
        ? 'Reversals have WIDER CLOB spreads (less certain)'
        : 'Reversals have tighter CLOB spreads',
    });
  }

  if (reversalStats.avgMaxDeviation != null && confirmedStats.avgMaxDeviation != null) {
    const diff = round(reversalStats.avgMaxDeviation - confirmedStats.avgMaxDeviation, 4);
    differentiators.push({
      metric: 'Max exchange deviation from strike',
      reversals: reversalStats.avgMaxDeviation,
      confirmed: confirmedStats.avgMaxDeviation,
      diff,
      interpretation: diff > 0
        ? 'Reversals had LARGER exchange moves against CLOB consensus'
        : 'Confirmed had larger exchange moves supporting CLOB consensus',
    });
  }

  if (reversalStats.avgClobRepriceAmount != null && confirmedStats.avgClobRepriceAmount != null) {
    const diff = round(reversalStats.avgClobRepriceAmount - confirmedStats.avgClobRepriceAmount, 4);
    differentiators.push({
      metric: 'CLOB reprice magnitude in final 60s',
      reversals: reversalStats.avgClobRepriceAmount,
      confirmed: confirmedStats.avgClobRepriceAmount,
      diff,
      interpretation: diff > 0
        ? 'Reversals saw MORE CLOB repricing (market starting to realize it was wrong)'
        : 'Confirmed saw more CLOB repricing',
    });
  }

  // Sort by absolute diff (most distinctive first)
  differentiators.sort((a, b) => {
    // Normalize diffs for comparison (different scales)
    const aNorm = Math.abs(a.diff || 0);
    const bNorm = Math.abs(b.diff || 0);
    return bNorm - aNorm;
  });

  return {
    reversalStats,
    confirmedStats,
    differentiators,
    keyDifferentiator: differentiators.length > 0
      ? differentiators[0].interpretation
      : 'Insufficient data to identify key differentiator',
  };
}

// ─── Bucket Breakdown ───

/**
 * Break down candidates by timing and price bucket.
 */
function buildBucketBreakdown(candidates) {
  const buckets = [
    { label: '$0.00-0.05', min: 0, max: 0.05 },
    { label: '$0.05-0.10', min: 0.05, max: 0.10 },
    { label: '$0.10-0.15', min: 0.10, max: 0.15 },
    { label: '$0.15-0.20', min: 0.15, max: 0.20 },
  ];

  const timings = ['T-60s', 'T-30s'];
  const breakdown = {};

  for (const timing of timings) {
    breakdown[timing] = {};
    for (const bucket of buckets) {
      const matching = candidates.filter(c =>
        c.timing === timing &&
        c.cheapPrice >= bucket.min &&
        c.cheapPrice < bucket.max
      );
      if (matching.length === 0) continue;

      const reversed = matching.filter(c => c.isReversal).length;
      breakdown[timing][bucket.label] = {
        total: matching.length,
        reversed,
        confirmed: matching.length - reversed,
        reversalRate: round(reversed / matching.length * 100, 1),
        byDirection: {
          downCheap: matching.filter(c => c.cheapSide === 'DOWN').length,
          upCheap: matching.filter(c => c.cheapSide === 'UP').length,
        },
        windowIds: matching.map(c => ({
          id: c.windowId,
          classification: c.classification,
          cheapSide: c.cheapSide,
          cheapPrice: c.cheapPrice,
        })),
      };
    }
  }

  return breakdown;
}
