/**
 * Scout Translator
 *
 * Converts technical trade events into plain-English explanations.
 * Scout's personality: friendly, helpful, explains like you're five.
 */

/**
 * Translate a trade event to Scout's voice
 *
 * @param {string} type - Event type (signal, entry, exit, alert, divergence)
 * @param {Object} data - Event data
 * @returns {Object} Translation with summary and explanation
 */
export function translate(type, data) {
  switch (type) {
    case 'signal':
      return translateSignal(data);
    case 'entry':
      return translateEntry(data);
    case 'exit':
      return translateExit(data);
    case 'alert':
    case 'divergence':
      return translateAlert(data);
    default:
      return {
        summary: `Unknown event: ${type}`,
        explanation: "Something happened but I'm not sure what it was.",
        icon: '?',
      };
  }
}

/**
 * Translate signal event
 */
function translateSignal(data) {
  const { signalType, strategyId, priceAtSignal, expectedPrice, tradingMode } = data;
  const direction = signalType === 'entry' ? 'entry' : 'exit';

  // Story E.3: Add mode prefix to summary
  const modePrefix = formatModePrefix(tradingMode);
  const summary = `${modePrefix}Signal fired (${direction})`;

  let explanation;
  if (direction === 'entry') {
    explanation = `Entry conditions met at ${formatPrice(priceAtSignal)}.`;
    if (expectedPrice) {
      explanation += ` Looking to get in around ${formatPrice(expectedPrice)}.`;
    }
  } else {
    explanation = `Exit signal triggered at ${formatPrice(priceAtSignal)}.`;
  }

  return {
    summary,
    explanation,
    icon: '\u25b6', // ▶
    level: 'info',
  };
}

/**
 * Translate entry event
 */
function translateEntry(data) {
  const {
    prices,
    sizes,
    latencies,
    slippage,
    hasDivergence,
    diagnosticFlags,
    tradingMode,
  } = data;

  const fillPrice = prices?.priceAtFill;
  const expectedPrice = prices?.expectedPrice;
  const requestedSize = sizes?.requestedSize;
  const filledSize = sizes?.filledSize;
  const totalLatency = latencies?.latency_total_ms;
  const slippageVsExpected = slippage?.slippage_vs_expected;

  // Calculate slippage percentage
  let slippagePct = null;
  if (expectedPrice && slippageVsExpected !== null && slippageVsExpected !== undefined) {
    slippagePct = Math.abs((slippageVsExpected / expectedPrice) * 100);
  }

  // Story E.3: Add mode prefix to summary
  const modePrefix = formatModePrefix(tradingMode);
  let summary = `${modePrefix}Filled @ ${formatPrice(fillPrice)}`;
  if (expectedPrice) {
    summary += ` (expected ${formatPrice(expectedPrice)}`;
    if (slippagePct !== null) {
      summary += `, slippage: ${slippagePct.toFixed(1)}%`;
    }
    summary += ')';
  }

  let explanation;
  if (!hasDivergence) {
    // Clean entry
    explanation = 'Position open. This looks clean.';
    if (totalLatency && totalLatency < 200) {
      explanation += ` Fast fill at ${totalLatency}ms.`;
    }
  } else {
    // Entry with issues
    const issues = [];

    if (diagnosticFlags?.includes('slippage_high')) {
      issues.push(`slippage was ${slippagePct?.toFixed(1) || '?'}%`);
    }
    if (diagnosticFlags?.includes('latency_high') || (totalLatency && totalLatency > 500)) {
      issues.push(`took ${totalLatency}ms`);
    }
    if (diagnosticFlags?.includes('size_divergence') && requestedSize !== filledSize) {
      issues.push(`got ${filledSize} instead of ${requestedSize} shares`);
    }

    if (issues.length > 0) {
      explanation = `In, but ${issues.join(' and ')}. Queued for review.`;
    } else {
      explanation = 'Position open with some divergence. Queued for review.';
    }
  }

  return {
    summary,
    explanation,
    icon: hasDivergence ? '\u26a0' : '\u2713', // ⚠ or ✓
    level: hasDivergence ? 'warn' : 'info',
  };
}

/**
 * Translate exit event
 */
function translateExit(data) {
  const {
    exitReason,
    prices,
    hasDivergence,
    diagnosticFlags,
    latencies,
  } = data;

  const fillPrice = prices?.priceAtFill;
  const expectedPrice = prices?.expectedPrice;
  const totalLatency = latencies?.latency_total_ms;

  // Format exit reason
  const reasonText = formatExitReason(exitReason);

  let summary = `${reasonText} @ ${formatPrice(fillPrice)}`;

  let explanation;
  if (!hasDivergence) {
    // Clean exit
    if (exitReason === 'take_profit') {
      explanation = 'Nice. Closed for profit.';
    } else if (exitReason === 'stop_loss') {
      explanation = 'Stop hit. Limited the loss.';
    } else if (exitReason === 'window_expiry') {
      explanation = 'Window ended. Position resolved.';
    } else {
      explanation = 'Closed cleanly.';
    }
  } else {
    // Exit with issues
    const issues = [];

    if (diagnosticFlags?.includes('slippage_high')) {
      issues.push('slippage on exit');
    }
    if (diagnosticFlags?.includes('latency_high') || (totalLatency && totalLatency > 500)) {
      issues.push(`slow fill (${totalLatency}ms)`);
    }

    if (issues.length > 0) {
      explanation = `Closed, but ${issues.join(' and ')}. Queued for review.`;
    } else {
      explanation = 'Closed with some divergence. Queued for review.';
    }
  }

  return {
    summary,
    explanation,
    icon: hasDivergence ? '\u26a0' : '\u2713', // ⚠ or ✓
    level: hasDivergence ? 'warn' : 'info',
  };
}

/**
 * Translate alert/divergence event
 */
function translateAlert(data) {
  const { alertType, level, data: alertData, diagnosticFlags } = data;

  let summary;
  let explanation;

  if (alertType === 'divergence' || diagnosticFlags?.includes('state_divergence')) {
    summary = 'State mismatch detected';
    explanation = "What I think we have doesn't match the exchange. This needs attention now.";
  } else if (diagnosticFlags?.includes('size_divergence')) {
    summary = 'Size mismatch';
    explanation = "Got a different size than requested. Queued for review.";
  } else if (diagnosticFlags?.includes('latency_high')) {
    summary = 'Latency spike';
    explanation = "That was slow. Might be exchange lag or network. Queued for review.";
  } else if (diagnosticFlags?.includes('slippage_high')) {
    summary = 'High slippage';
    explanation = "Price moved more than expected during execution. Queued for review.";
  } else {
    summary = `Alert: ${alertType || 'unknown'}`;
    explanation = alertData?.message || "Something needs attention. Queued for review.";
  }

  return {
    summary,
    explanation,
    icon: level === 'error' ? '\u2717' : '\u26a0', // ✗ or ⚠
    level: level || 'warn',
  };
}

/**
 * Format price for display
 */
function formatPrice(price) {
  if (price === null || price === undefined) return '?.???';
  return price.toFixed(3);
}

/**
 * Format exit reason to human-readable text
 */
function formatExitReason(reason) {
  switch (reason) {
    case 'take_profit':
      return 'Take-profit';
    case 'stop_loss':
      return 'Stop-loss';
    case 'window_expiry':
      return 'Window expiry';
    case 'manual':
      return 'Manual close';
    default:
      return 'Closed';
  }
}

/**
 * Get a status message for silent operation
 */
export function getSilentOperationMessage() {
  return {
    summary: 'All quiet',
    explanation: "Everything's working as expected.",
    icon: '\u2713', // ✓
    level: 'info',
  };
}

/**
 * Get time ago string
 */
export function getTimeAgo(isoTimestamp) {
  if (!isoTimestamp) return 'never';

  const now = new Date();
  const then = new Date(isoTimestamp);
  const diffMs = now - then;

  if (diffMs < 1000) return 'just now';
  if (diffMs < 60000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  return `${Math.floor(diffMs / 3600000)}h ago`;
}

/**
 * Story E.3: Format trading mode prefix for translations
 *
 * @param {string|null} mode - 'PAPER', 'LIVE', or null
 * @returns {string} Formatted prefix string
 */
export function formatModePrefix(mode) {
  if (!mode) {
    return '';
  }
  return `[${mode}] `;
}
