# Story 5.4: Divergence Alerting

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **structured alerts when divergence is detected**,
So that **I can investigate and fix issues (FR23)**.

## Acceptance Criteria

### AC1: Severity-Based Alert Levels

**Given** divergence is detected via `checkDivergence()`
**When** an alert is triggered
**Then** the log entry has `level='warn'` for moderate divergence (high_latency, high_slippage, size_impact)
**And** the log entry has `level='error'` for severe divergence (state_divergence, size_divergence)
**And** severity levels match those defined in Story 5.3's `getDivergenceSeverity()` function

### AC2: Structured Alert Content

**Given** a divergence alert is raised
**When** reviewing the alert
**Then** it includes: what diverged (flag type), expected value, actual value, context (window_id, position_id, strategy_id)
**And** example format: "Entry slippage of 0.03 (3%) - expected 0.42, got 0.45. Latency was 340ms, spread was 0.02"
**And** all values needed for debugging are present in a single log entry

### AC3: Actionable Alert Information

**Given** a divergence alert is raised
**When** the trader reviews it
**Then** the alert provides actionable information including:
- The specific metric that diverged (latency, slippage, size, state)
- The threshold that was exceeded
- The context for investigation (timestamps, prices, sizes)
- Suggested next steps or relevant module to check

### AC4: Multiple Alerts Not Suppressed

**Given** multiple divergences occur in a short period
**When** alerts are generated
**Then** each divergence alert is logged individually (no aggregation/suppression)
**And** all alerts are stored in `trade_events` table for pattern detection
**And** post-mortem analysis can identify patterns across multiple alerts

### AC5: Fail-Loud Principle

**Given** divergence is detected
**When** the alert system processes it
**Then** the system does NOT silently continue
**And** the alert is ALWAYS generated (never skipped or deferred)
**And** alert generation does not throw - failures in alerting are themselves logged

### AC6: Alert Generation Functions

**Given** the trade-event module
**When** processing divergence
**Then** dedicated alert functions exist:
- `alertOnDivergence(event, divergenceResult)` - main entry point for divergence alerts
- `formatDivergenceAlert(divergenceResult)` - formats alert message with context
- `shouldEscalate(divergenceResult)` - determines if alert needs escalation (error vs warn)

### AC7: Alert Persistence and Query

**Given** divergence alerts are generated
**When** stored in the database
**Then** alerts are recorded via `recordAlert()` with:
- `event_type='divergence'` for divergence alerts
- `diagnostic_flags` containing the divergence flag types
- `notes` containing structured alert details (JSON)
**And** alerts can be queried via `getDivergentEvents()` and `getDivergenceSummary()`

### AC8: Integration with Existing Infrastructure

**Given** Stories 5.1-5.3 built divergence detection
**When** Story 5.4 adds alerting
**Then** alerts integrate with existing:
- `recordEntry()` / `recordExit()` - already emit warn/error based on divergence
- `recordAlert()` - for standalone divergence alerts
- `checkDivergence()` - provides divergence analysis
- Structured logging format from logger module

## Tasks / Subtasks

- [x] **Task 1: Create Dedicated Alert Functions** (AC: 3, 5, 6)
  - [x] 1.1 Create `formatDivergenceAlert(divergenceResult, event)` in logic.js
  - [x] 1.2 Create `shouldEscalate(divergenceResult)` to determine severity
  - [x] 1.3 Create `alertOnDivergence(event, divergenceResult)` as main entry point
  - [x] 1.4 Ensure alert generation never throws (wrap in try/catch, log internal errors)

- [x] **Task 2: Implement Structured Alert Messages** (AC: 2, 3)
  - [x] 2.1 Define alert message templates for each divergence type
  - [x] 2.2 Include all required context: flag type, expected, actual, threshold, context
  - [x] 2.3 Format human-readable summary message
  - [x] 2.4 Include machine-readable structured data for analysis

- [x] **Task 3: Enhance recordEntry/recordExit Alerts** (AC: 1, 2, 4)
  - [x] 3.1 Review existing divergence logging in recordEntry/recordExit
  - [x] 3.2 Enhance log messages with structured alert format
  - [x] 3.3 Ensure all divergences logged individually (no suppression)
  - [x] 3.4 Add threshold values to alert context

- [x] **Task 4: Add Alert Escalation Logic** (AC: 1, 5)
  - [x] 4.1 Implement escalation rules based on severity
  - [x] 4.2 Map divergence flags to severity levels (error: state_divergence, size_divergence; warn: others)
  - [x] 4.3 Support multiple severe divergences in single event
  - [x] 4.4 Ensure fail-loud: always alert, never skip

- [x] **Task 5: Update recordAlert for Divergence** (AC: 7)
  - [x] 5.1 Verify recordAlert() properly handles divergence event type
  - [x] 5.2 Ensure diagnostic_flags are persisted correctly
  - [x] 5.3 Add structured notes with full alert details
  - [x] 5.4 Verify integration with getDivergentEvents() queries

- [x] **Task 6: Add Alert Helper Functions to Module Exports** (AC: 6, 8)
  - [x] 6.1 Export `formatDivergenceAlert` from module index
  - [x] 6.2 Export `shouldEscalate` from module index
  - [x] 6.3 Export `alertOnDivergence` from module index
  - [x] 6.4 Document usage in JSDoc comments

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Test formatDivergenceAlert generates correct message structure
  - [x] 7.2 Test shouldEscalate returns 'error' for severe divergences
  - [x] 7.3 Test shouldEscalate returns 'warn' for moderate divergences
  - [x] 7.4 Test alertOnDivergence never throws (handles internal errors)
  - [x] 7.5 Test multiple divergences all generate separate alerts
  - [x] 7.6 Test alert persistence via recordAlert
  - [x] 7.7 Test alerts queryable via getDivergentEvents
  - [x] 7.8 Test recordEntry emits structured divergence alert
  - [x] 7.9 Test recordExit emits structured divergence alert
  - [x] 7.10 Integration test: full divergence → alert flow

## Dev Notes

### Architecture Compliance

This story implements FR23 (System can alert on divergence with structured diagnostic). It builds on Story 5.3's divergence detection to add actionable alerting.

**From architecture.md#Monitoring-&-Logging:**
> FR23: System can alert on divergence with structured diagnostic

**From prd.md#Monitoring-&-Logging:**
> FR23: System can alert on divergence with structured diagnostic

**From epics.md#Story-5.4:**
> Divergence Alerting - I want structured alerts when divergence is detected so I can investigate and fix issues

### Project Structure Notes

**Files to modify:**
```
src/modules/trade-event/
├── index.js          # Add alertOnDivergence, formatDivergenceAlert, shouldEscalate exports
├── logic.js          # Implement alert formatting and escalation functions
└── __tests__/
    ├── logic.test.js # Add alert function tests
    └── index.test.js # Add alert integration tests

No new files needed - this story extends existing trade-event module.
```

### Previous Story Intelligence (5.3)

**From Story 5.3 implementation (completed):**
- `checkDivergence(event, thresholds)` returns structured divergence result with:
  - `hasDivergence: boolean`
  - `flags: string[]` - array of divergence flag names
  - `divergences: Array<{type, severity, details}>`
- Severity mapping already exists in `getDivergenceSeverity()`:
  - `'error'` for: `state_divergence`, `size_divergence`
  - `'warn'` for: `high_latency`, `high_slippage`, `entry_slippage`, `size_impact`, etc.
- `recordEntry()` and `recordExit()` already log with appropriate levels based on divergence
- `recordAlert()` exists for standalone alert events
- `getDivergentEvents()` queries events with divergence flags
- Diagnostic flags already populated in trade_events table

**Key insight:** Most alerting infrastructure is already in place. Story 5.4:
1. **Enhances** existing alerts with structured, actionable information
2. **Adds dedicated functions** for consistent alert formatting
3. **Ensures fail-loud** principle is consistently applied
4. **Supports pattern detection** through proper alert persistence

### Implementation Approach

**formatDivergenceAlert - Alert Message Formatting:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Format a divergence alert with structured, actionable information
 *
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @param {Object} event - Original trade event with metrics
 * @returns {Object} Formatted alert with message and structured data
 */
export function formatDivergenceAlert(divergenceResult, event) {
  const { flags, divergences } = divergenceResult;

  // Build human-readable summary
  const summaryParts = [];
  for (const divergence of divergences) {
    const { type, details } = divergence;
    summaryParts.push(formatDivergenceDetail(type, details, event));
  }

  return {
    // Human-readable summary
    message: summaryParts.join(' | '),

    // Structured data for analysis
    structured: {
      flags,
      divergences: divergences.map(d => ({
        type: d.type,
        severity: d.severity,
        expected: d.details.expected ?? d.details.threshold,
        actual: d.details.actual ?? d.details.latency_ms ?? d.details.ratio,
        threshold: getThresholdForFlag(d.type),
      })),
      context: {
        window_id: event.window_id,
        position_id: event.position_id,
        strategy_id: event.strategy_id,
        event_type: event.event_type,
      },
      timestamps: {
        signal_detected_at: event.signal_detected_at,
        order_filled_at: event.order_filled_at,
      },
    },

    // Suggested next steps
    suggestions: getSuggestionsForDivergences(flags),
  };
}

function formatDivergenceDetail(type, details, event) {
  switch (type) {
    case 'high_latency':
      return `High latency: ${details.latency_ms}ms (threshold: ${details.threshold_ms}ms)`;

    case 'high_slippage':
    case 'entry_slippage':
      const slippagePct = event.expected_price
        ? ((details.actual - details.expected) / details.expected * 100).toFixed(2)
        : 'N/A';
      return `${type === 'entry_slippage' ? 'Entry slippage' : 'Slippage'}: ${slippagePct}% - expected ${details.expected?.toFixed(4)}, got ${details.actual?.toFixed(4)}`;

    case 'size_impact':
      return `Size impact: ${(details.ratio * 100).toFixed(1)}% of depth (threshold: ${(details.threshold * 100).toFixed(1)}%)`;

    case 'size_divergence':
      return `Size divergence: requested ${details.requested}, filled ${details.filled}`;

    case 'state_divergence':
      return `State divergence detected - local vs exchange mismatch`;

    default:
      return `${type}: divergence detected`;
  }
}

function getThresholdForFlag(flag) {
  // Return known threshold values for reference
  const thresholds = {
    high_latency: '500ms',
    high_slippage: '2%',
    entry_slippage: '2%',
    size_impact: '50% of depth',
    size_divergence: '10% difference',
    state_divergence: 'any mismatch',
  };
  return thresholds[flag] || 'N/A';
}

function getSuggestionsForDivergences(flags) {
  const suggestions = [];

  if (flags.includes('high_latency')) {
    suggestions.push('Check network latency and API response times');
  }
  if (flags.includes('high_slippage') || flags.includes('entry_slippage')) {
    suggestions.push('Review orderbook depth and timing of entry signals');
  }
  if (flags.includes('size_impact')) {
    suggestions.push('Consider reducing position size or improving liquidity detection');
  }
  if (flags.includes('size_divergence')) {
    suggestions.push('Check for partial fills and orderbook depth');
  }
  if (flags.includes('state_divergence')) {
    suggestions.push('CRITICAL: Run position reconciliation immediately');
  }

  return suggestions;
}
```

**shouldEscalate - Severity Determination:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Determine if divergence should escalate to error level
 *
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @returns {boolean} True if any divergence requires error-level escalation
 */
export function shouldEscalate(divergenceResult) {
  if (!divergenceResult || !divergenceResult.divergences) {
    return false;
  }

  // Check if any divergence has 'error' severity
  return divergenceResult.divergences.some(d => d.severity === 'error');
}
```

**alertOnDivergence - Main Entry Point:**
```javascript
// src/modules/trade-event/logic.js

import { child } from '../logger/index.js';

let log = null;

/**
 * Generate alert for divergence - fail-loud, never throws
 *
 * @param {Object} event - Trade event with metrics
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @returns {Object} Alert details (or error info if alerting failed)
 */
export function alertOnDivergence(event, divergenceResult) {
  try {
    if (!divergenceResult || !divergenceResult.hasDivergence) {
      return { alerted: false, reason: 'no_divergence' };
    }

    // Format the alert
    const alert = formatDivergenceAlert(divergenceResult, event);

    // Determine log level
    const level = shouldEscalate(divergenceResult) ? 'error' : 'warn';

    // Get or create logger
    if (!log) {
      log = child({ module: 'trade-event' });
    }

    // Log the alert - never suppress
    if (level === 'error') {
      log.error('divergence_alert', {
        message: alert.message,
        ...alert.structured,
        suggestions: alert.suggestions,
      });
    } else {
      log.warn('divergence_alert', {
        message: alert.message,
        ...alert.structured,
        suggestions: alert.suggestions,
      });
    }

    return {
      alerted: true,
      level,
      message: alert.message,
      flags: divergenceResult.flags,
    };
  } catch (error) {
    // Fail-loud but don't crash - log the alerting failure
    console.error('ALERT_SYSTEM_ERROR: Failed to generate divergence alert', {
      error: error.message,
      event_id: event?.id,
    });

    return {
      alerted: false,
      reason: 'alert_system_error',
      error: error.message,
    };
  }
}
```

### Enhanced recordEntry/recordExit Logging

The existing implementation already logs divergence with appropriate levels. Enhancement focuses on message structure:

```javascript
// In recordEntry - enhance log message
const logData = {
  window_id: windowId,
  position_id: positionId,
  // Structured expected vs actual
  expected: {
    price: prices.expectedPrice,
    size: sizes.requestedSize,
  },
  actual: {
    price: prices.priceAtFill,
    size: sizes.filledSize,
  },
  // Key metrics
  slippage: slippage.slippage_vs_expected,
  slippage_pct: prices.expectedPrice
    ? (slippage.slippage_vs_expected / prices.expectedPrice * 100).toFixed(2) + '%'
    : null,
  latency_ms: latencies.latency_total_ms,
  // Divergence details (when present)
  diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : undefined,
  divergence_count: diagnosticFlags.length,
  // Thresholds exceeded (for actionable context)
  thresholds_exceeded: diagnosticFlags.length > 0
    ? getExceededThresholds(eventForFlagDetection, thresholds)
    : undefined,
};
```

### Edge Cases

1. **No divergence:** Return early, don't generate alert
2. **Multiple severe divergences:** Log as error, include all flags
3. **Alert system failure:** Catch, log to console, never crash the trade flow
4. **Null/undefined event:** Handle gracefully, log warning
5. **Missing context fields:** Use 'N/A' or null, don't fail
6. **Rapid successive divergences:** Each logged separately, no throttling

### Testing Approach

```javascript
// src/modules/trade-event/__tests__/logic.test.js

describe('Divergence Alerting', () => {
  describe('formatDivergenceAlert', () => {
    it('should format high_latency alert with actionable message', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{
          type: 'high_latency',
          severity: 'warn',
          details: { latency_ms: 600, threshold_ms: 500 },
        }],
      };
      const event = {
        window_id: 'window-1',
        position_id: 1,
        latency_total_ms: 600,
      };

      const alert = formatDivergenceAlert(divergenceResult, event);

      expect(alert.message).toContain('High latency: 600ms');
      expect(alert.message).toContain('threshold: 500ms');
      expect(alert.structured.flags).toContain('high_latency');
      expect(alert.suggestions).toContain('Check network latency');
    });

    it('should format slippage alert with percentage', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['entry_slippage'],
        divergences: [{
          type: 'entry_slippage',
          severity: 'warn',
          details: { expected: 0.42, actual: 0.45 },
        }],
      };
      const event = {
        expected_price: 0.42,
        price_at_fill: 0.45,
      };

      const alert = formatDivergenceAlert(divergenceResult, event);

      expect(alert.message).toContain('Entry slippage');
      expect(alert.message).toContain('expected 0.4200');
      expect(alert.message).toContain('got 0.4500');
    });

    it('should include suggestions for state_divergence', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['state_divergence'],
        divergences: [{
          type: 'state_divergence',
          severity: 'error',
          details: {},
        }],
      };

      const alert = formatDivergenceAlert(divergenceResult, {});

      expect(alert.suggestions).toContain('CRITICAL: Run position reconciliation immediately');
    });
  });

  describe('shouldEscalate', () => {
    it('should return true for state_divergence', () => {
      const result = {
        divergences: [{ type: 'state_divergence', severity: 'error' }],
      };

      expect(shouldEscalate(result)).toBe(true);
    });

    it('should return true for size_divergence', () => {
      const result = {
        divergences: [{ type: 'size_divergence', severity: 'error' }],
      };

      expect(shouldEscalate(result)).toBe(true);
    });

    it('should return false for only warnings', () => {
      const result = {
        divergences: [
          { type: 'high_latency', severity: 'warn' },
          { type: 'high_slippage', severity: 'warn' },
        ],
      };

      expect(shouldEscalate(result)).toBe(false);
    });

    it('should return false for null input', () => {
      expect(shouldEscalate(null)).toBe(false);
      expect(shouldEscalate({})).toBe(false);
    });
  });

  describe('alertOnDivergence', () => {
    it('should return alerted:false when no divergence', () => {
      const result = alertOnDivergence({}, { hasDivergence: false });

      expect(result.alerted).toBe(false);
      expect(result.reason).toBe('no_divergence');
    });

    it('should never throw even with invalid input', () => {
      expect(() => alertOnDivergence(null, null)).not.toThrow();
      expect(() => alertOnDivergence(undefined, undefined)).not.toThrow();
    });

    it('should return alert details when divergence exists', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{ type: 'high_latency', severity: 'warn', details: { latency_ms: 600 } }],
      };

      const result = alertOnDivergence({ window_id: 'w1' }, divergenceResult);

      expect(result.alerted).toBe(true);
      expect(result.level).toBe('warn');
      expect(result.flags).toContain('high_latency');
    });

    it('should escalate to error for severe divergence', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['state_divergence'],
        divergences: [{ type: 'state_divergence', severity: 'error', details: {} }],
      };

      const result = alertOnDivergence({}, divergenceResult);

      expect(result.level).toBe('error');
    });
  });
});
```

### NFR Compliance

- **FR23:** System can alert on divergence with structured diagnostic - core functionality
- **FR24:** System can operate silently when behavior matches expectations - alerts only on divergence
- **NFR9:** 100% of trade events produce complete structured log - all divergences logged

### Integration with Other Stories

**Story 5.1 (Trade Event Logging):** Uses trade_events table and structured logging
- Database persistence for alerts
- Logger module for structured output

**Story 5.2 (Latency & Slippage Recording):** Uses threshold detection infrastructure
- Threshold configuration
- Metric calculations

**Story 5.3 (Divergence Detection):** Direct dependency - uses detection results
- `checkDivergence()` provides input to alerting
- Severity levels defined in 5.3

**Story 5.5 (Silent Operation Mode):** Complementary behavior
- Alerts only when divergence detected
- Silent when everything matches expectations

### Critical Implementation Notes

1. **Never throw from alert functions** - wrap all alerting code in try/catch
2. **Log alerting failures to console** - fail-loud but don't crash trade flow
3. **Include all context** - alert should be self-contained for debugging
4. **Use existing severity mapping** - leverage Story 5.3's getDivergenceSeverity()
5. **No alert suppression** - every divergence generates its own log entry
6. **Human + machine readable** - both summary message and structured data
7. **Actionable suggestions** - help trader know what to do next

### References

- [Source: architecture.md#Monitoring-&-Logging] - FR23 requirements
- [Source: architecture.md#Structured-Log-Format] - Log schema requirements
- [Source: prd.md#FR23] - System can alert on divergence with structured diagnostic
- [Source: epics.md#Story-5.4] - Story requirements and acceptance criteria
- [Source: src/modules/trade-event/index.js] - Module interface (recordAlert, getDivergentEvents)
- [Source: src/modules/trade-event/logic.js] - checkDivergence, detectDiagnosticFlags
- [Source: config/default.js] - Threshold configuration
- [Source: 5-3-divergence-detection.md] - Previous story with divergence detection

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - all tests passed on first run.

### Completion Notes List

- **Task 1-4:** Implemented dedicated alert functions in `logic.js`:
  - `getDivergenceSeverity(flag)` - Returns 'error' for state_divergence/size_divergence, 'warn' for others
  - `formatDivergenceAlert(divergenceResult, event)` - Creates structured alert with human-readable message, machine-readable data, and actionable suggestions
  - `shouldEscalate(divergenceResult)` - Checks if any divergence has 'error' severity
  - `alertOnDivergence(event, divergenceResult)` - Main entry point, fail-loud (never throws, logs errors internally)

- **Task 3:** Enhanced `recordEntry()` and `recordExit()` in `index.js`:
  - Added `alert_message` field with human-readable summary when divergence detected
  - Added `divergences` array with type, severity, expected, actual, and threshold
  - Added `suggestions` array with actionable next steps
  - Added `slippage_pct` for slippage divergence context

- **Task 5-6:** Verified and exported alert functions:
  - `recordAlert()` already properly handles `event_type='divergence'`
  - Exported `alertOnDivergence`, `formatDivergenceAlert`, `shouldEscalate`, `getDivergenceSeverity` from module index

- **Task 7:** Added comprehensive tests:
  - 117 tests in `logic.test.js` (including 29 new Story 5.4 tests)
  - 85 tests in `index.test.js` (including 14 new Story 5.4 tests)
  - All 1322 tests in full suite pass with no regressions

### File List

**Modified:**
- `src/modules/trade-event/logic.js` - Added divergence alerting functions (getDivergenceSeverity, formatDivergenceAlert, shouldEscalate, alertOnDivergence) and helper functions (formatDivergenceDetail, getThresholdForFlag, getSuggestionsForDivergences)
- `src/modules/trade-event/index.js` - Enhanced recordEntry/recordExit with structured alert format, exported new alert functions
- `src/modules/trade-event/__tests__/logic.test.js` - Added 29 tests for Story 5.4 alert functions
- `src/modules/trade-event/__tests__/index.test.js` - Added 14 tests for Story 5.4 integration

## Change Log

| Date | Change |
|------|--------|
| 2026-01-31 | Implemented Story 5.4: Divergence Alerting - Added formatDivergenceAlert, shouldEscalate, alertOnDivergence functions; enhanced recordEntry/recordExit with structured alert format including alert_message, divergences array, suggestions; all tests passing (1322 total) |
