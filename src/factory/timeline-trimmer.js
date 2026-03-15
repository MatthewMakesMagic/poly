/**
 * Timeline Trimmer — Strip unused data sources from timelines
 *
 * Each window has ~13,000 events from 5 data sources. Most strategies only
 * need 2-3 sources. This module analyzes which sources a strategy uses and
 * strips the rest, typically saving ~70% of evaluation time.
 *
 * Rules:
 * - L2 data (l2Up, l2Down) is ALWAYS kept — needed for fill simulation
 * - Only strip sources the strategy definitely doesn't access
 * - When in doubt, keep the data (false positives are safe, false negatives break results)
 */

// ─── Signal type → data source mapping ───
// Each signal type declares which MarketState fields it reads.
// Derived from the `Reads:` comments in each signal module.

const SIGNAL_SOURCE_MAP = {
  'chainlink-deficit': {
    needsChainlink: true,
    needsClobDown: true,   // uses state.clobDown implicitly via deficit calculation
  },
  'bs-fair-value': {
    needsChainlink: true,
    needsPolyRef: true,    // state.polyRef for spot
    needsClobUp: true,     // state.clobUp for ask price comparison
    needsClobDown: true,   // state.clobDown for ask price comparison
  },
  'exchange-consensus': {
    needsExchanges: true,  // state._exchanges, getExchangeMedian()
  },
  'clob-imbalance': {
    needsClobUp: true,
    needsClobDown: true,
  },
  'momentum': {
    needsChainlink: true,
  },
  'mean-reversion': {
    needsChainlink: true,
  },
  'ref-near-strike': {
    needsPolyRef: true,    // state.polyRef
  },
};

/**
 * Create a blank sources object with all flags set to false (except L2 which is always true).
 */
function blankSources() {
  return {
    needsChainlink: false,
    needsPolyRef: false,
    needsClobUp: false,
    needsClobDown: false,
    needsExchanges: false,
    needsCoingecko: false,
    needsL2: true,          // ALWAYS true
    exchangeFilter: null,   // null = all exchanges if needsExchanges
  };
}

/**
 * Create an all-true sources object (conservative fallback for JS strategies).
 */
function allSources() {
  return {
    needsChainlink: true,
    needsPolyRef: true,
    needsClobUp: true,
    needsClobDown: true,
    needsExchanges: true,
    needsCoingecko: true,
    needsL2: true,
    exchangeFilter: null,
  };
}

/**
 * Analyze a strategy to determine which MarketState data sources it accesses.
 *
 * For YAML strategies (those with a `_definition` property attached by compose):
 *   reads the signal block types to infer sources.
 *
 * For JS strategies (no `_definition`):
 *   conservative — assume all sources needed (can't introspect closures).
 *
 * @param {Object} strategy - Strategy object from compose or JS
 * @returns {Object} Sources descriptor
 */
export function analyzeStrategySources(strategy) {
  if (!strategy) return allSources();

  const definition = strategy._definition;

  // JS strategies or strategies without definition metadata: keep everything
  if (!definition || !Array.isArray(definition.signals)) {
    return allSources();
  }

  // YAML strategy: merge source requirements from all signal types
  const sources = blankSources();

  for (const signal of definition.signals) {
    const mapping = SIGNAL_SOURCE_MAP[signal.type];
    if (!mapping) {
      // Unknown signal type — conservative: keep everything
      return allSources();
    }

    if (mapping.needsChainlink) sources.needsChainlink = true;
    if (mapping.needsPolyRef) sources.needsPolyRef = true;
    if (mapping.needsClobUp) sources.needsClobUp = true;
    if (mapping.needsClobDown) sources.needsClobDown = true;
    if (mapping.needsExchanges) sources.needsExchanges = true;
    if (mapping.needsCoingecko) sources.needsCoingecko = true;
  }

  return sources;
}

/**
 * Filter a timeline array to only include events matching the needed sources.
 * L2 events are ALWAYS kept regardless of the sources descriptor.
 * Event ordering is preserved (no re-sorting).
 *
 * @param {Object[]} timeline - Array of timeline events with `source` field
 * @param {Object} sources - Sources descriptor from analyzeStrategySources
 * @returns {Object[]} Filtered timeline (new array, original untouched)
 */
export function trimTimeline(timeline, sources) {
  if (!timeline || !Array.isArray(timeline)) return [];
  if (!sources) return timeline;

  // If all sources needed, skip filtering entirely
  if (
    sources.needsChainlink &&
    sources.needsPolyRef &&
    sources.needsClobUp &&
    sources.needsClobDown &&
    sources.needsExchanges &&
    sources.needsCoingecko
  ) {
    return timeline;
  }

  return timeline.filter(event => {
    const src = event.source;
    if (!src) return true; // No source tag — keep to be safe

    // L2 is ALWAYS kept
    if (src === 'l2Up' || src === 'l2Down') return true;

    // Source-specific checks
    if (src === 'chainlink') return sources.needsChainlink;
    if (src === 'polyRef') return sources.needsPolyRef;
    if (src === 'clobUp') return sources.needsClobUp;
    if (src === 'clobDown') return sources.needsClobDown;
    if (src === 'coingecko') return sources.needsCoingecko;

    // Exchange sources: exchange_binance, exchange_coinbase, etc.
    if (src.startsWith('exchange_')) {
      if (!sources.needsExchanges) return false;
      // Optional exchange filter
      if (sources.exchangeFilter) {
        const exchangeName = src.slice('exchange_'.length);
        return sources.exchangeFilter.includes(exchangeName);
      }
      return true;
    }

    // Unknown source — keep to be safe
    return true;
  });
}
