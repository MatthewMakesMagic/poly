/**
 * Continuous Market Making — Shared Base
 *
 * Two-sided passive quoting infrastructure used by all mm-cs-* strategies.
 * Each strategy provides a computeDesiredQuotes(state, config, mm) function
 * that returns { up: { price, reason } | null, down: { price, reason } | null }.
 *
 * The base handles: window timing, inventory tracking, requoting logic,
 * price bounds, and signal emission.
 */

/**
 * Initialize or retrieve the MM state attached to the backtest state object.
 */
export function initMm(state) {
  if (!state._mm) {
    state._mm = {
      upQuoted: null,      // { price } — what we believe is resting on UP
      downQuoted: null,     // { price } — what we believe is resting on DOWN
      upInv: { cost: 0, tokens: 0 },
      downInv: { cost: 0, tokens: 0 },
      fills: 0,
      exchHistory: [],      // [{ price, ms }] for momentum / volatility
      clobUpHistory: [],    // [{ mid, ms }] for CLOB momentum
      clobDownHistory: [],
    };
  }
  return state._mm;
}

export function onWindowOpenBase(state) {
  state._mm = null;
  initMm(state);
}

export function onPassiveFillBase(fill, state) {
  const mm = initMm(state);
  const isUp = fill.token.toLowerCase().includes('-up');
  const inv = isUp ? mm.upInv : mm.downInv;
  inv.cost += fill.price * fill.size;
  inv.tokens += fill.size;
  if (isUp) mm.upQuoted = null;
  else mm.downQuoted = null;
  mm.fills++;
}

/**
 * Reconcile one side: compare desired vs current, emit cancel/place signals.
 */
function reconcileSide(signals, mm, side, desired, token, config) {
  const quotedKey = side === 'up' ? 'upQuoted' : 'downQuoted';
  const invKey = side === 'up' ? 'upInv' : 'downInv';
  const current = mm[quotedKey];

  if (!desired) {
    if (current) {
      signals.push({ action: 'cancel_all', token });
      mm[quotedKey] = null;
    }
    return;
  }

  // Already have a close-enough quote — keep it (preserves queue position)
  if (current && Math.abs(desired.price - current.price) < (config.requoteThreshold || 0.005)) {
    return;
  }

  // Inventory limit reached
  if (mm[invKey].cost >= (config.maxPerSide || 20)) {
    if (current) {
      signals.push({ action: 'cancel_all', token });
      mm[quotedKey] = null;
    }
    return;
  }

  // Price out of bounds
  const minP = config.minEntryPrice || 0.03;
  const maxP = config.maxEntryPrice || 0.55;
  if (desired.price < minP || desired.price > maxP) {
    if (current) {
      signals.push({ action: 'cancel_all', token });
      mm[quotedKey] = null;
    }
    return;
  }

  // Cancel existing + place new
  if (current) {
    signals.push({ action: 'cancel_all', token });
  }
  const cap = config.capitalPerEntry || 2;
  const size = cap / desired.price;
  signals.push({
    action: 'place_limit_buy',
    token,
    price: desired.price,
    size,
    capitalPerTrade: cap,
    reason: desired.reason || '',
  });
  mm[quotedKey] = { price: desired.price };
}

/**
 * Core evaluate function used by all continuous MM strategies.
 *
 * @param {Object} state — backtest market state
 * @param {Object} config — merged defaults + overrides
 * @param {Function} computeDesiredQuotes — (state, config, mm) => { up, down }
 * @returns {Object[]} signals
 */
export function evaluateBase(state, config, computeDesiredQuotes) {
  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null) return [];

  const mm = initMm(state);
  const sym = win.symbol;
  const signals = [];

  const exitMs = config.exitWindowMs ?? 30000;
  const entryMs = config.entryWindowMs ?? 840000;

  // Exit window — cancel everything
  if (win.timeToCloseMs <= exitMs) {
    if (mm.upQuoted || mm.downQuoted) {
      signals.push({ action: 'cancel_all' });
      mm.upQuoted = null;
      mm.downQuoted = null;
    }
    return signals;
  }

  // Before entry window — do nothing
  if (win.timeToCloseMs >= entryMs) return [];

  // Track exchange price history (for momentum / vol strategies)
  const exchMedian = state.getExchangeMedian();
  if (exchMedian && state.timestamp) {
    const ms = typeof state.timestamp === 'object'
      ? state.timestamp.getTime()
      : new Date(state.timestamp).getTime();
    mm.exchHistory.push({ price: exchMedian, ms });
    // Keep last 60 seconds
    const cutoff = ms - 60000;
    while (mm.exchHistory.length > 1 && mm.exchHistory[0].ms < cutoff) {
      mm.exchHistory.shift();
    }
  }

  // Track CLOB mid history
  if (clobUp.mid && state.timestamp) {
    const ms = typeof state.timestamp === 'object'
      ? state.timestamp.getTime()
      : new Date(state.timestamp).getTime();
    mm.clobUpHistory.push({ mid: clobUp.mid, ms });
    mm.clobDownHistory.push({ mid: clobDown.mid || (1 - clobUp.mid), ms });
    const cutoff = ms - 60000;
    while (mm.clobUpHistory.length > 1 && mm.clobUpHistory[0].ms < cutoff) {
      mm.clobUpHistory.shift();
    }
    while (mm.clobDownHistory.length > 1 && mm.clobDownHistory[0].ms < cutoff) {
      mm.clobDownHistory.shift();
    }
  }

  // Compute desired quotes (strategy-specific)
  const desired = computeDesiredQuotes(state, config, mm);

  // Reconcile each side independently
  reconcileSide(signals, mm, 'up', desired.up, `${sym}-up`, config);
  reconcileSide(signals, mm, 'down', desired.down, `${sym}-down`, config);

  return signals;
}

// ─── Utility Functions for Strategies ───

/**
 * Exchange directional signal: how far exchange median is above/below CL-adjusted strike.
 * Positive = UP bias, negative = DOWN bias.
 */
export function getExchangeSignal(state, structuralGap) {
  const exchMedian = state.getExchangeMedian();
  if (!exchMedian || !state.strike) return null;
  return exchMedian - (state.strike + (structuralGap ?? 46));
}

/**
 * Exchange disagreement: range across all exchange prices.
 * High disagreement = uncertain signal.
 */
export function getExchangeDisagreement(state) {
  const spread = state.getExchangeSpread();
  if (!spread) return 0;
  return spread.range;
}

/**
 * CLOB book imbalance: ratio of bid depth to total depth.
 * > 0.5 = more bids (buying pressure), < 0.5 = more asks (selling pressure).
 */
export function getBookImbalance(book) {
  if (!book) return 0.5;
  const bidD = book.bidDepth1pct || book.bidSize || 0;
  const askD = book.askDepth1pct || book.askSize || 0;
  const total = bidD + askD;
  if (total === 0) return 0.5;
  return bidD / total;
}

/**
 * CLOB spread as a signal: wider spread = more uncertainty.
 */
export function getClobSpread(book) {
  if (!book || !book.bestBid || !book.bestAsk) return 0;
  return book.bestAsk - book.bestBid;
}

/**
 * Exchange price volatility: standard deviation of recent exchange prices.
 */
export function getExchangeVolatility(exchHistory) {
  if (!exchHistory || exchHistory.length < 3) return 0;
  const prices = exchHistory.map(h => h.price);
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
  return Math.sqrt(variance);
}

/**
 * Exchange momentum: price change over lookback period.
 */
export function getExchangeMomentum(exchHistory, lookbackMs) {
  if (!exchHistory || exchHistory.length < 2) return 0;
  const now = exchHistory[exchHistory.length - 1];
  const cutoff = now.ms - (lookbackMs || 10000);
  // Find the oldest price within the lookback
  let oldest = exchHistory[0];
  for (let i = 0; i < exchHistory.length; i++) {
    if (exchHistory[i].ms >= cutoff) {
      oldest = exchHistory[i];
      break;
    }
  }
  return now.price - oldest.price;
}

/**
 * Time fraction: how far through the entry window we are (0 = just opened, 1 = about to close).
 */
export function getTimeFraction(win, entryWindowMs, exitWindowMs) {
  const totalWindow = (entryWindowMs || 840000) - (exitWindowMs || 30000);
  const elapsed = (entryWindowMs || 840000) - win.timeToCloseMs;
  return Math.max(0, Math.min(1, elapsed / totalWindow));
}
