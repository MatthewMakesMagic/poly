# Story 5.3: Divergence Detection

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **automatic detection when behavior diverges from expectation**,
So that **I'm alerted to potential issues immediately (FR22)**.

## Acceptance Criteria

### AC1: Threshold-Based Divergence Detection

**Given** a trade executes
**When** comparing expected vs actual values
**Then** divergence is detected if the difference exceeds configurable thresholds
**And** thresholds are configurable via `config.monitoring` (e.g., slippage > 2%, latency > 500ms)
**And** default thresholds align with NFR requirements (NFR1: 500ms latency)

### AC2: Diagnostic Flags Population

**Given** divergence is detected
**When** the check completes
**Then** `diagnostic_flags` JSON array is populated on the trade event
**And** flags include specific issues: `["high_latency", "high_slippage", "size_impact", "entry_slippage", "state_divergence", "size_divergence"]`
**And** flags are stored in the `trade_events` table for later analysis

### AC3: Price Divergence Detection

**Given** a trade entry or exit executes
**When** analyzing price divergence
**Then** the system checks:
- `slippage_vs_expected` exceeds configured `slippageThresholdPct`
- `slippage_signal_to_fill` indicates significant price movement during execution
**And** `high_slippage` or `entry_slippage` flag is set when thresholds exceeded

### AC4: Timing Divergence Detection

**Given** a trade executes
**When** analyzing timing divergence
**Then** the system checks:
- `latency_total_ms` exceeds configured `latencyThresholdMs` (default 500ms per NFR1)
- Individual latency components (decision→submit, submit→ack, ack→fill) for anomalies
**And** `high_latency` flag is set when threshold exceeded
**And** specific latency component flags can be set if individual stages are slow

### AC5: Size Divergence Detection

**Given** an order fills
**When** analyzing size divergence
**Then** the system checks:
- `filled_size` differs from `requested_size` (partial fills)
- `size_vs_depth_ratio` exceeds configured `sizeImpactThreshold` (potential market impact)
**And** `size_divergence` flag is set when requested ≠ filled
**And** `size_impact` flag is set when size/depth ratio exceeds threshold

### AC6: State Divergence Detection

**Given** position state is tracked
**When** comparing local state vs exchange state
**Then** the system detects divergence when:
- In-memory position differs from database position
- Local position state differs from exchange-reported state (via reconciliation)
**And** `state_divergence` flag is set
**And** both expected and actual states are logged for debugging

### AC7: Divergence Analysis Functions

**Given** the trade-event module is initialized
**When** analyzing divergence patterns
**Then** the module provides:
- `checkDivergence(event)` - checks a single event for all divergence types
- `getDivergentEvents({ windowId?, strategyId?, timeRange? })` - queries events with divergence flags
- `getDivergenceSummary({ windowId?, strategyId?, timeRange? })` - returns counts per divergence type
**And** all functions are exposed via the module's public interface

### AC8: Integration with Previous Stories

**Given** Story 5.2 implemented threshold detection and diagnostic flags
**When** divergence detection runs
**Then** it uses the existing `detectDiagnosticFlags()` function from Story 5.2
**And** extends it with additional divergence types (size_divergence, state_divergence)
**And** prepares data for Story 5.4 (Divergence Alerting)

## Tasks / Subtasks

- [x] **Task 1: Extend Diagnostic Flags Detection** (AC: 1, 2, 3, 4, 5)
  - [x] 1.1 Extend `detectDiagnosticFlags()` in logic.js with new flag types
  - [x] 1.2 Add `entry_slippage` flag detection (distinct from general high_slippage)
  - [x] 1.3 Add `size_divergence` flag when filled_size ≠ requested_size
  - [x] 1.4 Add individual latency component anomaly detection
  - [x] 1.5 Update function to accept additional event properties

- [x] **Task 2: Implement checkDivergence Function** (AC: 7)
  - [x] 2.1 Create `checkDivergence(event, thresholds)` that runs all divergence checks
  - [x] 2.2 Return structured result with all detected divergences
  - [x] 2.3 Include severity level for each divergence type
  - [x] 2.4 Return empty array if no divergence detected

- [x] **Task 3: Implement State Divergence Detection** (AC: 6)
  - [x] 3.1 Create `detectStateDivergence(localState, exchangeState)` function
  - [x] 3.2 Compare position fields: size, side, status
  - [x] 3.3 Return divergence details if any mismatch found
  - [x] 3.4 Integrate with position manager reconciliation (via public export)

- [x] **Task 4: Implement Divergence Query Functions** (AC: 7)
  - [x] 4.1 Create `queryDivergentEvents({ windowId?, strategyId?, timeRange?, flags? })` in logic.js
  - [x] 4.2 Filter events where diagnostic_flags is not null/empty
  - [x] 4.3 Support filtering by specific flag types
  - [x] 4.4 Return events with parsed diagnostic_flags

- [x] **Task 5: Implement Divergence Summary Function** (AC: 7)
  - [x] 5.1 Create `queryDivergenceSummary({ windowId?, strategyId?, timeRange? })` in logic.js
  - [x] 5.2 Aggregate counts per divergence flag type
  - [x] 5.3 Calculate percentage of events with each flag
  - [x] 5.4 Return structured summary object

- [x] **Task 6: Update recordEntry and recordExit** (AC: 2, 8)
  - [x] 6.1 Call `checkDivergence()` after latency/slippage calculations
  - [x] 6.2 Merge returned flags into `diagnostic_flags` array
  - [x] 6.3 Ensure flags are persisted in database
  - [x] 6.4 Log divergence detection at appropriate level (warn for divergence, info for normal)

- [x] **Task 7: Add Configuration for Extended Thresholds** (AC: 1)
  - [x] 7.1 Add `monitoring.partialFillThresholdPct` for size divergence (default: 0.1 = 10%)
  - [x] 7.2 Add `monitoring.latencyComponentThresholds` for individual component checks
  - [x] 7.3 Document threshold meanings in config comments

- [x] **Task 8: Export New Functions from Module Index** (AC: 7)
  - [x] 8.1 Add `getDivergenceCheck` to module exports (wraps checkDivergence)
  - [x] 8.2 Add `getDivergentEvents` to module exports
  - [x] 8.3 Add `getDivergenceSummary` to module exports
  - [x] 8.4 Update module getState() to include divergence stats

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Test `checkDivergence()` detects high_latency correctly
  - [x] 9.2 Test `checkDivergence()` detects high_slippage correctly
  - [x] 9.3 Test `checkDivergence()` detects size_divergence correctly
  - [x] 9.4 Test `checkDivergence()` detects size_impact correctly
  - [x] 9.5 Test `detectStateDivergence()` identifies position mismatches
  - [x] 9.6 Test `queryDivergentEvents()` filters correctly
  - [x] 9.7 Test `queryDivergenceSummary()` aggregates correctly
  - [x] 9.8 Test recordEntry populates diagnostic_flags on divergence
  - [x] 9.9 Test recordExit populates diagnostic_flags on divergence
  - [x] 9.10 Test no flags when values within thresholds
  - [x] 9.11 Integration test: full trade flow with divergence detection

## Dev Notes

### Architecture Compliance

This story implements FR22 (System can detect divergence from expected behavior). It builds directly on Story 5.2's threshold detection infrastructure and prepares data for Story 5.4's alerting system.

**From architecture.md#Monitoring-&-Logging:**
> FR22: System can detect divergence from expected behavior
> NFR10: System detects and reports state divergence between memory/database/exchange

**From prd.md#Monitoring-&-Logging:**
> FR22: System can detect divergence from expected behavior

**From epics.md#Story-5.3:**
> Divergence Detection - I want automatic detection when behavior diverges from expectation so I'm alerted to potential issues immediately

### Project Structure Notes

**Files to modify:**
```
src/modules/trade-event/
├── index.js          # Add checkDivergence, getDivergentEvents, getDivergenceSummary exports
├── logic.js          # Extend detectDiagnosticFlags, add divergence query functions
├── types.js          # Add DiagnosticFlag constants/enum
└── __tests__/
    ├── logic.test.js # Add divergence detection tests
    └── index.test.js # Add integration tests for divergence flow

config/
└── default.js        # Add extended threshold configuration
```

**No new files needed** - this story extends existing modules.

### Previous Story Intelligence (5.1 and 5.2)

**From Story 5.1 implementation:**
- `trade_events` table exists with `diagnostic_flags` TEXT column (JSON array)
- `recordEntry()` and `recordExit()` functions exist in logic.js
- Events are being recorded with latency and slippage values

**From Story 5.2 implementation:**
- `detectDiagnosticFlags(event, thresholds)` already exists in logic.js
- Detects: `high_latency`, `high_slippage`, `size_impact`
- Configuration in `config.monitoring` and `config.tradeEvent.thresholds`
- Threshold detection populates diagnostic_flags during event recording

**Key insight:** Story 5.2 built the detection infrastructure. Story 5.3:
1. **Extends** the detection with additional divergence types
2. **Adds query functions** to analyze divergence patterns
3. **Adds state divergence** detection for exchange reconciliation
4. **Prepares data** for Story 5.4's alerting system

### Implementation Approach

**Extend detectDiagnosticFlags:**
```javascript
// src/modules/trade-event/logic.js

export function detectDiagnosticFlags(event, thresholds = {}) {
  const {
    latencyThresholdMs = 500,
    slippageThresholdPct = 0.02,
    sizeImpactThreshold = 0.5,
    partialFillThresholdPct = 0.1, // NEW: 10% tolerance for partial fills
  } = thresholds;

  const flags = [];

  // Existing checks from Story 5.2
  if (event.latency_total_ms != null && event.latency_total_ms > latencyThresholdMs) {
    flags.push('high_latency');
  }

  if (event.slippage_vs_expected != null && event.expected_price != null && event.expected_price > 0) {
    const slippagePct = Math.abs(event.slippage_vs_expected / event.expected_price);
    if (slippagePct > slippageThresholdPct) {
      flags.push('high_slippage');
    }
  }

  if (event.size_vs_depth_ratio != null && event.size_vs_depth_ratio > sizeImpactThreshold) {
    flags.push('size_impact');
  }

  // NEW: Entry slippage (specifically for entry events)
  if (event.event_type === 'entry' && event.slippage_signal_to_fill != null && event.price_at_signal) {
    const entrySlippagePct = Math.abs(event.slippage_signal_to_fill / event.price_at_signal);
    if (entrySlippagePct > slippageThresholdPct) {
      flags.push('entry_slippage');
    }
  }

  // NEW: Size divergence (partial fills)
  if (event.requested_size != null && event.filled_size != null) {
    const sizeDiffPct = Math.abs(event.filled_size - event.requested_size) / event.requested_size;
    if (sizeDiffPct > partialFillThresholdPct) {
      flags.push('size_divergence');
    }
  }

  return flags;
}
```

**checkDivergence Function:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Check a trade event for all types of divergence
 *
 * @param {Object} event - Trade event with all metrics
 * @param {Object} thresholds - Threshold configuration
 * @returns {Object} Divergence check result
 */
export function checkDivergence(event, thresholds = {}) {
  const flags = detectDiagnosticFlags(event, thresholds);

  const divergences = [];

  for (const flag of flags) {
    divergences.push({
      type: flag,
      severity: getDivergenceSeverity(flag),
      details: getDivergenceDetails(event, flag),
    });
  }

  return {
    hasDivergence: flags.length > 0,
    flags,
    divergences,
    eventId: event.id,
    windowId: event.window_id,
  };
}

function getDivergenceSeverity(flag) {
  // Size and state divergence are more severe
  const severeFlags = ['state_divergence', 'size_divergence'];
  return severeFlags.includes(flag) ? 'error' : 'warn';
}

function getDivergenceDetails(event, flag) {
  switch (flag) {
    case 'high_latency':
      return { latency_ms: event.latency_total_ms, threshold_ms: 500 };
    case 'high_slippage':
    case 'entry_slippage':
      return {
        slippage: event.slippage_vs_expected,
        expected: event.expected_price,
        actual: event.price_at_fill,
      };
    case 'size_impact':
      return { ratio: event.size_vs_depth_ratio, threshold: 0.5 };
    case 'size_divergence':
      return {
        requested: event.requested_size,
        filled: event.filled_size,
      };
    default:
      return {};
  }
}
```

**Divergent Events Query:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Query events that have divergence flags
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string[]} [options.flags] - Filter by specific flag types
 * @returns {Object[]} Events with divergence
 */
export function queryDivergentEvents({ windowId, strategyId, timeRange, flags } = {}) {
  let sql = `
    SELECT * FROM trade_events
    WHERE diagnostic_flags IS NOT NULL
      AND diagnostic_flags != '[]'
  `;
  const params = [];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  sql += ' ORDER BY id DESC';

  let events = all(sql, params).map(event => {
    if (event.diagnostic_flags) {
      event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
    }
    return event;
  });

  // Filter by specific flags if requested
  if (flags && flags.length > 0) {
    events = events.filter(e =>
      e.diagnostic_flags?.some(f => flags.includes(f))
    );
  }

  return events;
}
```

**Divergence Summary Query:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Get summary of divergence occurrences
 *
 * @param {Object} options - Query options
 * @returns {Object} Summary with counts per divergence type
 */
export function queryDivergenceSummary({ windowId, strategyId, timeRange } = {}) {
  // First get all events with divergence
  const events = queryDivergentEvents({ windowId, strategyId, timeRange });

  // Count total events (with and without divergence) for percentage
  let totalSql = 'SELECT COUNT(*) as count FROM trade_events WHERE 1=1';
  const totalParams = [];

  if (windowId) {
    totalSql += ' AND window_id = ?';
    totalParams.push(windowId);
  }
  if (strategyId) {
    totalSql += ' AND strategy_id = ?';
    totalParams.push(strategyId);
  }
  if (timeRange?.startDate) {
    totalSql += ' AND signal_detected_at >= ?';
    totalParams.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    totalSql += ' AND signal_detected_at <= ?';
    totalParams.push(timeRange.endDate);
  }

  const totalResult = get(totalSql, totalParams);
  const totalEvents = totalResult?.count || 0;

  // Aggregate flags
  const flagCounts = {};
  for (const event of events) {
    for (const flag of event.diagnostic_flags || []) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
  }

  return {
    totalEvents,
    eventsWithDivergence: events.length,
    divergenceRate: totalEvents > 0 ? events.length / totalEvents : 0,
    flagCounts,
    flagRates: Object.fromEntries(
      Object.entries(flagCounts).map(([flag, count]) => [
        flag,
        totalEvents > 0 ? count / totalEvents : 0,
      ])
    ),
  };
}
```

**State Divergence Detection:**
```javascript
// src/modules/trade-event/logic.js

/**
 * Detect state divergence between local and exchange state
 *
 * @param {Object} localState - Position state from local database
 * @param {Object} exchangeState - Position state from exchange API
 * @returns {Object|null} Divergence details or null if no divergence
 */
export function detectStateDivergence(localState, exchangeState) {
  const divergences = [];

  // Check size
  if (localState.size !== exchangeState.size) {
    divergences.push({
      field: 'size',
      local: localState.size,
      exchange: exchangeState.size,
    });
  }

  // Check side
  if (localState.side !== exchangeState.side) {
    divergences.push({
      field: 'side',
      local: localState.side,
      exchange: exchangeState.side,
    });
  }

  // Check status (if position exists on one side but not other)
  if (localState.status !== exchangeState.status) {
    divergences.push({
      field: 'status',
      local: localState.status,
      exchange: exchangeState.status,
    });
  }

  if (divergences.length === 0) {
    return null;
  }

  return {
    positionId: localState.id || exchangeState.id,
    windowId: localState.window_id || exchangeState.window_id,
    divergences,
    localState,
    exchangeState,
  };
}
```

### Configuration Extension

```javascript
// config/default.js - add to monitoring section

monitoring: {
  latencyThresholdMs: 500,         // Flag events with latency > 500ms (per NFR1)
  slippageThresholdPct: 0.02,      // Flag events with slippage > 2% of expected price
  sizeImpactThreshold: 0.5,        // Flag events where size > 50% of available depth
  partialFillThresholdPct: 0.1,    // Flag partial fills with >10% difference (NEW)
  latencyComponentThresholds: {    // Individual component thresholds (NEW)
    decisionToSubmitMs: 100,       // Decision to submit should be fast
    submitToAckMs: 200,            // Exchange ack should be quick
    ackToFillMs: 300,              // Fill after ack varies by liquidity
  },
},
```

### Edge Cases

1. **No Divergence:** Return empty flags array, not null
2. **Partial Data:** Skip checks where required fields are null
3. **Zero Expected Price:** Guard against division by zero in percentage calculations
4. **Multiple Flags:** Events can have multiple divergence flags simultaneously
5. **Empty Events:** Handle gracefully when no events match filters
6. **JSON Parsing:** Safely parse diagnostic_flags, handle malformed JSON
7. **State Not Available:** Handle case where exchange state can't be retrieved

### Testing Approach

```javascript
// src/modules/trade-event/__tests__/logic.test.js

describe('Divergence Detection', () => {
  describe('checkDivergence', () => {
    it('should detect high latency divergence', () => {
      const event = { latency_total_ms: 600 };
      const thresholds = { latencyThresholdMs: 500 };

      const result = checkDivergence(event, thresholds);

      expect(result.hasDivergence).toBe(true);
      expect(result.flags).toContain('high_latency');
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].severity).toBe('warn');
    });

    it('should detect size divergence from partial fill', () => {
      const event = {
        requested_size: 100,
        filled_size: 80, // 20% difference
      };
      const thresholds = { partialFillThresholdPct: 0.1 };

      const result = checkDivergence(event, thresholds);

      expect(result.flags).toContain('size_divergence');
    });

    it('should detect multiple divergences simultaneously', () => {
      const event = {
        latency_total_ms: 600,
        slippage_vs_expected: 0.05,
        expected_price: 1.0,
        requested_size: 100,
        filled_size: 50,
      };

      const result = checkDivergence(event);

      expect(result.flags).toContain('high_latency');
      expect(result.flags).toContain('high_slippage');
      expect(result.flags).toContain('size_divergence');
    });

    it('should return no divergence when within thresholds', () => {
      const event = {
        latency_total_ms: 200,
        slippage_vs_expected: 0.005,
        expected_price: 1.0,
        requested_size: 100,
        filled_size: 100,
      };

      const result = checkDivergence(event);

      expect(result.hasDivergence).toBe(false);
      expect(result.flags).toHaveLength(0);
    });
  });

  describe('detectStateDivergence', () => {
    it('should detect size mismatch', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 80, side: 'long', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].field).toBe('size');
    });

    it('should return null when states match', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 100, side: 'long', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result).toBeNull();
    });
  });

  describe('queryDivergentEvents', () => {
    beforeEach(async () => {
      // Insert test events with various flags
      await insertTestEvent({ diagnostic_flags: ['high_latency'] });
      await insertTestEvent({ diagnostic_flags: ['high_slippage', 'size_impact'] });
      await insertTestEvent({ diagnostic_flags: null }); // No divergence
    });

    it('should return only events with divergence', async () => {
      const events = queryDivergentEvents();

      expect(events).toHaveLength(2);
      expect(events.every(e => e.diagnostic_flags?.length > 0)).toBe(true);
    });

    it('should filter by specific flags', async () => {
      const events = queryDivergentEvents({ flags: ['high_latency'] });

      expect(events).toHaveLength(1);
      expect(events[0].diagnostic_flags).toContain('high_latency');
    });
  });

  describe('queryDivergenceSummary', () => {
    it('should calculate correct divergence rates', async () => {
      // Insert 10 events, 3 with divergence
      for (let i = 0; i < 7; i++) {
        await insertTestEvent({ diagnostic_flags: null });
      }
      await insertTestEvent({ diagnostic_flags: ['high_latency'] });
      await insertTestEvent({ diagnostic_flags: ['high_slippage'] });
      await insertTestEvent({ diagnostic_flags: ['high_latency', 'size_impact'] });

      const summary = queryDivergenceSummary();

      expect(summary.totalEvents).toBe(10);
      expect(summary.eventsWithDivergence).toBe(3);
      expect(summary.divergenceRate).toBe(0.3);
      expect(summary.flagCounts.high_latency).toBe(2);
      expect(summary.flagCounts.high_slippage).toBe(1);
    });
  });
});
```

### NFR Compliance

- **FR22:** System can detect divergence from expected behavior - core functionality of this story
- **NFR10:** System detects and reports state divergence between memory/database/exchange - state divergence detection
- **NFR1:** 500ms latency threshold is enforced - inherited from Story 5.2

### Integration with Other Stories

**Story 5.1 (Trade Event Logging):** Uses the trade_events table and diagnostic_flags column
- Database schema and recording infrastructure

**Story 5.2 (Latency & Slippage Recording):** Extends the threshold detection
- `detectDiagnosticFlags()` is extended with new flag types
- Uses same threshold configuration pattern

**Story 5.4 (Divergence Alerting):** Produces data for alerting
- `diagnostic_flags` populated by this story triggers alerts
- `getDivergentEvents()` provides query interface for alert system

**Story 5.5 (Silent Operation Mode):** Determines logging level
- Divergence → warn/error level (alerts)
- No divergence → info level (silent)

### Critical Implementation Notes

1. **Extend, don't replace** - The existing `detectDiagnosticFlags()` function should be extended
2. **Return empty array, not null** - Consistent handling for no divergence
3. **Multiple flags per event** - Events can have several divergence types simultaneously
4. **Preserve existing behavior** - Story 5.2 thresholds must continue working
5. **State divergence is severe** - Should result in 'error' level, not 'warn'
6. **Prepare for alerting** - Structure data for Story 5.4 consumption
7. **Use existing patterns** - Follow query function patterns from Story 5.2

### References

- [Source: architecture.md#Monitoring-&-Logging] - FR22, NFR10 requirements
- [Source: architecture.md#Database-Schema] - trade_events.diagnostic_flags column
- [Source: prd.md#FR22] - System can detect divergence from expected behavior
- [Source: prd.md#NFR10] - System detects and reports state divergence
- [Source: epics.md#Story-5.3] - Story requirements and acceptance criteria
- [Source: src/modules/trade-event/logic.js] - Existing detectDiagnosticFlags() function
- [Source: src/modules/trade-event/index.js] - Module interface to extend
- [Source: config/default.js] - Threshold configuration pattern
- [Source: 5-1-trade-event-logging-expected-vs-actual.md] - Foundation story
- [Source: 5-2-latency-slippage-recording.md] - Threshold detection story

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - All tests pass

### Completion Notes List

- Extended `detectDiagnosticFlags()` with 4 new flag types: `entry_slippage`, `size_divergence`, `slow_decision_to_submit`, `slow_submit_to_ack`, `slow_ack_to_fill`
- Implemented `checkDivergence()` function that runs all divergence checks and returns structured results with severity levels
- Implemented `detectStateDivergence()` for comparing local vs exchange position state
- Implemented `queryDivergentEvents()` for querying events with divergence flags
- Implemented `queryDivergenceSummary()` for aggregating divergence statistics
- Updated `recordEntry()` and `recordExit()` to use enhanced divergence detection with appropriate log levels (error for size_divergence, warn for other divergences, info for normal)
- Added extended threshold configuration in `config/default.js` including `partialFillThresholdPct` and `latencyComponentThresholds`
- Exported new functions from module index: `getDivergenceCheck`, `getDivergentEvents`, `getDivergenceSummary`, `getStateDivergence`
- Updated `getState()` to include divergence stats
- Added 29 new unit tests for logic.js and 14 new integration tests for index.js
- All 1281 tests pass (161 in trade-event module)

### File List

- src/modules/trade-event/logic.js (modified) - Extended detectDiagnosticFlags, added checkDivergence, detectStateDivergence, queryDivergentEvents, queryDivergenceSummary
- src/modules/trade-event/index.js (modified) - Added getDivergenceCheck, getDivergentEvents, getDivergenceSummary, getStateDivergence exports, updated recordEntry/recordExit with divergence logging
- config/default.js (modified) - Added partialFillThresholdPct and latencyComponentThresholds
- src/modules/trade-event/__tests__/logic.test.js (modified) - Added 29 new tests for Story 5.3 divergence detection
- src/modules/trade-event/__tests__/index.test.js (modified) - Added 14 new integration tests for Story 5.3

