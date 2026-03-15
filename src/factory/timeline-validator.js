/**
 * Timeline Data Validator
 *
 * Validates data integrity during cache construction.
 * Catches known anomaly patterns:
 *   - Time bounds violations (events outside [openTime, closeTime))
 *   - Minimum event count (< 10 events = incomplete)
 *   - Flat CL prices (no change for > 60s)
 *   - L2 data gaps (missing for > 30s when L2 data exists)
 *
 * All issues are returned in a structured quality object stored
 * in the data_quality JSON column.
 */

/**
 * Validate a window's data and compute quality metadata.
 *
 * @param {Object} params
 * @param {Object[]} params.timeline - Merged event array (already time-sorted)
 * @param {number} params.rtdsCount - Count of RTDS ticks loaded
 * @param {number} params.clobCount - Count of CLOB snapshots loaded
 * @param {number} params.exchangeCount - Count of exchange ticks loaded
 * @param {number} params.l2Count - Count of L2 book ticks loaded
 * @param {number} [params.coingeckoCount=0] - Count of CoinGecko ticks loaded
 * @param {number} params.openMs - Window open time in ms
 * @param {number} params.closeMs - Window close time in ms
 * @param {string} params.symbol
 * @returns {Object} Quality metadata for data_quality column
 */
export function validateWindow({
  timeline,
  rtdsCount,
  clobCount,
  exchangeCount,
  l2Count,
  coingeckoCount = 0,
  openMs,
  closeMs,
  symbol,
}) {
  const flags = [];

  // Minimum event count check
  if (timeline.length < 10) {
    flags.push({
      type: 'incomplete',
      message: `Only ${timeline.length} events (minimum 10 required for meaningful backtesting)`,
    });
  }

  // Flat chainlink price detection (no change for > 60s)
  const flatPriceGaps = detectFlatPrices(timeline, 'chainlink', 60000);
  if (flatPriceGaps.length > 0) {
    flags.push({
      type: 'flat_prices',
      message: `Chainlink price unchanged for ${flatPriceGaps.length} gap(s) > 60s — possible feed stall`,
      gaps: flatPriceGaps,
    });
  }

  // L2 gap detection (missing for > 30s when L2 data exists in the window)
  const l2Gaps = detectL2Gaps(timeline, 30000);
  if (l2Gaps.length > 0) {
    flags.push({
      type: 'l2_gaps',
      message: `L2 data missing for ${l2Gaps.length} gap(s) > 30s — orderbook depth data unreliable`,
      gaps: l2Gaps,
    });
  }

  // Out-of-bounds events (should have been filtered in merge, but double-check)
  const oobCount = countOutOfBounds(timeline, openMs, closeMs);
  if (oobCount > 0) {
    flags.push({
      type: 'out_of_bounds',
      message: `${oobCount} event(s) outside [openTime, closeTime) — data pipeline error, these were filtered`,
    });
  }

  return {
    rtds_count: rtdsCount,
    clob_count: clobCount,
    exchange_count: exchangeCount,
    l2_count: l2Count,
    coingecko_count: coingeckoCount,
    event_count: timeline.length,
    flags,
  };
}

/**
 * Detect periods where a source's price does not change for longer than maxGapMs.
 *
 * @param {Object[]} timeline - Sorted events
 * @param {string} source - Source to check (e.g., 'chainlink')
 * @param {number} maxGapMs - Maximum allowed flat period
 * @returns {Array<{ startMs: number, endMs: number, durationMs: number }>}
 */
export function detectFlatPrices(timeline, source, maxGapMs) {
  const gaps = [];
  let lastPrice = null;
  let lastChangeMs = null;

  for (const event of timeline) {
    if (event.source !== source) continue;

    const ms = event._ms;
    const price = parseFloat(event.price);

    if (lastPrice === null) {
      lastPrice = price;
      lastChangeMs = ms;
      continue;
    }

    if (price !== lastPrice) {
      // Price changed — check if the flat period was too long
      const gapMs = ms - lastChangeMs;
      if (gapMs > maxGapMs) {
        gaps.push({
          startMs: lastChangeMs,
          endMs: ms,
          durationMs: gapMs,
        });
      }
      lastPrice = price;
      lastChangeMs = ms;
    }
  }

  // Check trailing flat period (from last change to window end)
  // Not flagged since the window may end before the gap threshold

  return gaps;
}

/**
 * Detect gaps in L2 data longer than maxGapMs.
 * Only flags gaps when L2 data exists in the window (avoids false positives
 * for symbols/periods without L2 coverage).
 *
 * @param {Object[]} timeline - Sorted events
 * @param {number} maxGapMs - Maximum allowed gap
 * @returns {Array<{ startMs: number, endMs: number, durationMs: number }>}
 */
export function detectL2Gaps(timeline, maxGapMs) {
  const gaps = [];
  let lastL2Ms = null;
  let hasL2 = false;

  for (const event of timeline) {
    if (event.source !== 'l2Up' && event.source !== 'l2Down') continue;

    hasL2 = true;
    const ms = event._ms;

    if (lastL2Ms !== null) {
      const gap = ms - lastL2Ms;
      if (gap > maxGapMs) {
        gaps.push({
          startMs: lastL2Ms,
          endMs: ms,
          durationMs: gap,
        });
      }
    }

    lastL2Ms = ms;
  }

  // Only return gaps if there was L2 data at all
  return hasL2 ? gaps : [];
}

/**
 * Count events with timestamps outside the window bounds.
 * These should have been filtered during merge, but this is a safety check.
 *
 * @param {Object[]} timeline
 * @param {number} openMs
 * @param {number} closeMs
 * @returns {number}
 */
export function countOutOfBounds(timeline, openMs, closeMs) {
  let count = 0;
  for (const event of timeline) {
    if (event._ms < openMs || event._ms >= closeMs) {
      count++;
    }
  }
  return count;
}

/**
 * Check if a quality object has any flags.
 *
 * @param {Object} quality
 * @returns {boolean}
 */
export function hasFlags(quality) {
  return quality?.flags?.length > 0;
}

/**
 * Get flag types from a quality object.
 *
 * @param {Object} quality
 * @returns {string[]}
 */
export function getFlagTypes(quality) {
  return (quality?.flags || []).map(f => f.type);
}
