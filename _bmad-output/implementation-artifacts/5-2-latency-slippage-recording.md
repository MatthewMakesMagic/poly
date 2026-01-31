# Story 5.2: Latency & Slippage Recording

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **latency and slippage explicitly recorded with dedicated analysis functions**,
So that **I can identify execution quality issues and understand trade performance patterns (FR15, FR21)**.

## Acceptance Criteria

### AC1: Timestamp Capture at Each Order Stage

**Given** an order is placed
**When** the order lifecycle progresses through each stage
**Then** these timestamps are captured with millisecond precision:
- `signal_detected_at` - when the strategy signal was generated
- `order_submitted_at` - when the order was sent to the exchange
- `order_acked_at` - when the exchange acknowledged receipt
- `order_filled_at` - when the order was filled (fully or last partial)

### AC2: Latency Computation and Storage

**Given** timestamps are recorded at each stage
**When** the trade event is saved
**Then** computed latencies are calculated and stored:
- `latency_decision_to_submit_ms` = order_submitted_at - signal_detected_at
- `latency_submit_to_ack_ms` = order_acked_at - order_submitted_at
- `latency_ack_to_fill_ms` = order_filled_at - order_acked_at
- `latency_total_ms` = order_filled_at - signal_detected_at
**And** null values are handled gracefully (missing timestamps don't cause errors)

### AC3: Market Context Capture at Signal Time

**Given** a signal is detected
**When** the signal is processed
**Then** market context is captured at the moment of signal:
- `bid_at_signal` - best bid price
- `ask_at_signal` - best ask price
- `spread_at_signal` = ask_at_signal - bid_at_signal
- `depth_at_signal` - available liquidity at best price
**And** `size_vs_depth_ratio` = requested_size / depth_at_signal (when depth available)

### AC4: Slippage Computation and Storage

**Given** prices are recorded at each stage
**When** the trade event is saved
**Then** slippage is calculated and stored:
- `slippage_signal_to_fill` = price_at_fill - price_at_signal (price movement during execution)
- `slippage_vs_expected` = price_at_fill - expected_price (actual vs strategy expectation)
**And** these are stored as raw numbers (not percentages) for precision

### AC5: Latency Analysis Functions

**Given** the trade event module is initialized
**When** analyzing latency patterns
**Then** the module provides:
- `getLatencyStats({ windowId?, strategyId?, timeRange? })` - returns min/max/avg/p95 latency metrics
- `getLatencyBreakdown(eventId)` - returns detailed latency breakdown for a single event
**And** stats are grouped by latency component (decision→submit, submit→ack, ack→fill, total)

### AC6: Slippage Analysis Functions

**Given** the trade event module is initialized
**When** analyzing slippage patterns
**Then** the module provides:
- `getSlippageStats({ windowId?, strategyId?, timeRange? })` - returns min/max/avg slippage metrics
- `getSlippageBySize(options)` - correlates slippage with order size
- `getSlippageBySpread(options)` - correlates slippage with spread at signal
**And** slippage can be analyzed as both absolute values and percentages of expected price

### AC7: Order Manager Integration for Timestamp Capture

**Given** the order manager processes an order
**When** each stage of the order lifecycle occurs
**Then** timestamps are captured at the actual moment each event happens (not inferred)
**And** timestamps are passed to the trade-event module for recording
**And** latency is logged with the order acknowledgment (as required by FR15)

### AC8: Threshold-Based Alerting Preparation

**Given** latency or slippage data is recorded
**When** values exceed configurable thresholds
**Then** diagnostic flags are set for the event:
- `high_latency` flag when latency_total_ms > threshold (e.g., 500ms per NFR1)
- `high_slippage` flag when slippage_vs_expected exceeds threshold
- `size_impact` flag when size_vs_depth_ratio suggests market impact
**And** these flags are stored in `diagnostic_flags` JSON array for Story 5.3

## Tasks / Subtasks

- [x] **Task 1: Extend Order Manager for Timestamp Capture** (AC: 1, 7)
  - [x] 1.1 Add timestamp capture in `placeOrder()` for `order_submitted_at`
  - [x] 1.2 Add timestamp capture in order acknowledgment handler for `order_acked_at`
  - [x] 1.3 Add timestamp capture in fill handler for `order_filled_at`
  - [x] 1.4 Modify order events to include all captured timestamps
  - [x] 1.5 Ensure timestamps use `new Date().toISOString()` consistently

- [x] **Task 2: Extend Spot Client for Market Context** (AC: 3)
  - [x] 2.1 Add `getMarketContext(marketId)` function returning bid/ask/spread/depth
  - [x] 2.2 Ensure market context is captured at signal time in orchestrator
  - [x] 2.3 Pass market context to recordSignal() and recordEntry() calls

- [x] **Task 3: Implement Latency Stats Functions** (AC: 5)
  - [x] 3.1 Add `getLatencyStats({ windowId?, strategyId?, timeRange? })` to logic.js
  - [x] 3.2 Implement SQL aggregation for min/max/avg/count per latency type
  - [x] 3.3 Add p95 calculation using SQLite window functions or JavaScript
  - [x] 3.4 Add `getLatencyBreakdown(eventId)` for single-event analysis
  - [x] 3.5 Export functions from index.js

- [x] **Task 4: Implement Slippage Stats Functions** (AC: 6)
  - [x] 4.1 Add `getSlippageStats({ windowId?, strategyId?, timeRange? })` to logic.js
  - [x] 4.2 Implement slippage aggregation returning min/max/avg/count
  - [x] 4.3 Add `getSlippageBySize(options)` correlating slippage with order size
  - [x] 4.4 Add `getSlippageBySpread(options)` correlating slippage with spread
  - [x] 4.5 Support both absolute and percentage-based slippage metrics
  - [x] 4.6 Export functions from index.js

- [x] **Task 5: Implement Threshold Detection and Flagging** (AC: 8)
  - [x] 5.1 Add `LATENCY_THRESHOLD_MS` and `SLIPPAGE_THRESHOLD` config options
  - [x] 5.2 Modify recordEntry() to check thresholds after calculations
  - [x] 5.3 Populate `diagnostic_flags` array when thresholds exceeded
  - [x] 5.4 Add `high_latency`, `high_slippage`, `size_impact` flag detection

- [x] **Task 6: Update Orchestrator for Market Context Flow** (AC: 3, 7)
  - [x] 6.1 Capture market context when strategy signal is generated
  - [x] 6.2 Pass market context through to recordSignal() calls
  - [x] 6.3 Pass market context and timestamps through to recordEntry() calls
  - [x] 6.4 Ensure order manager timestamps are propagated correctly

- [x] **Task 7: Add Configuration for Thresholds** (AC: 8)
  - [x] 7.1 Add `monitoring.latencyThresholdMs` to config/default.js (default: 500)
  - [x] 7.2 Add `monitoring.slippageThresholdPct` to config/default.js (default: 0.02)
  - [x] 7.3 Add `monitoring.sizeImpactThreshold` to config/default.js (default: 0.5)
  - [x] 7.4 Pass thresholds to trade-event module via init(config)

- [x] **Task 8: Write Tests** (AC: all)
  - [x] 8.1 Test timestamp capture at each order stage
  - [x] 8.2 Test latency calculations with various timestamp combinations
  - [x] 8.3 Test null handling for missing timestamps
  - [x] 8.4 Test getLatencyStats() returns correct aggregations
  - [x] 8.5 Test getSlippageStats() returns correct aggregations
  - [x] 8.6 Test getSlippageBySize() correlation logic
  - [x] 8.7 Test threshold detection populates diagnostic_flags
  - [x] 8.8 Test market context capture and propagation
  - [x] 8.9 Integration test: full order lifecycle with latency recording
  - [x] 8.10 Test p95 calculation accuracy

## Dev Notes

### Architecture Compliance

This story implements FR15 (log latency for every order operation) and extends FR21 (log expected vs actual) with explicit analysis capabilities. It builds directly on Story 5.1's foundation.

**From architecture.md#Performance:**
> NFR1: Order placement completes within 500ms under normal conditions
> NFR4: System logs latency for every order operation for monitoring

**From architecture.md#Database-Schema - trade_events (already exists from 5.1):**
The latency columns (`latency_decision_to_submit_ms`, `latency_submit_to_ack_ms`, `latency_ack_to_fill_ms`, `latency_total_ms`) and slippage columns (`slippage_signal_to_fill`, `slippage_vs_expected`) are already defined and populated by Story 5.1.

**From epics.md#Story-5.2:**
> Latency & Slippage Recording - I want latency and slippage explicitly recorded so I can identify execution quality issues

### Project Structure Notes

**Files to modify:**
```
src/modules/trade-event/
├── index.js          # Add getLatencyStats, getSlippageStats, getLatencyBreakdown, getSlippageBySize, getSlippageBySpread exports
├── logic.js          # Add latency/slippage analysis query functions
└── __tests__/
    └── logic.test.js # Add tests for new analysis functions

src/modules/order-manager/
├── index.js          # Add timestamp capture at each lifecycle stage
├── logic.js          # Modify order processing to capture timestamps
└── __tests__/
    └── index.test.js # Add tests for timestamp capture

src/modules/orchestrator/
└── execution-loop.js # Ensure market context and timestamps flow through

src/clients/spot/
└── index.js          # Add getMarketContext() function if not present

config/
└── default.js        # Add monitoring threshold configuration
```

**No new files needed** - this story extends existing modules.

### Previous Story Intelligence (5.1)

**From Story 5.1 implementation:**
- `calculateLatencies(timestamps)` already exists in `logic.js` - calculates all 4 latency values
- `calculateSlippage(prices)` already exists in `logic.js` - calculates both slippage values
- Database columns for latency and slippage are already present in trade_events table
- recordEntry() already populates latency and slippage values
- recordExit() already populates latency and slippage values

**Key insight:** Story 5.1 built the recording infrastructure. Story 5.2 adds:
1. **Analysis functions** to query and aggregate the recorded data
2. **Threshold detection** to flag problematic events
3. **Enhanced market context** capture
4. **Order manager integration** to ensure timestamps are captured at the actual moments

### Implementation Approach

**Latency Stats SQL Pattern:**
```javascript
// src/modules/trade-event/logic.js

export function queryLatencyStats({ windowId, strategyId, timeRange } = {}) {
  let sql = `
    SELECT
      COUNT(*) as count,
      MIN(latency_total_ms) as min_total_ms,
      MAX(latency_total_ms) as max_total_ms,
      AVG(latency_total_ms) as avg_total_ms,
      AVG(latency_decision_to_submit_ms) as avg_decision_to_submit_ms,
      AVG(latency_submit_to_ack_ms) as avg_submit_to_ack_ms,
      AVG(latency_ack_to_fill_ms) as avg_ack_to_fill_ms
    FROM trade_events
    WHERE latency_total_ms IS NOT NULL
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

  return get(sql, params);
}
```

**P95 Calculation Pattern:**
```javascript
// P95 requires sorting - use JavaScript for simplicity
export function calculateP95Latency({ windowId, strategyId } = {}) {
  const events = queryEventsWithLatency({ windowId, strategyId });
  const latencies = events
    .map(e => e.latency_total_ms)
    .filter(l => l !== null)
    .sort((a, b) => a - b);

  if (latencies.length === 0) return null;

  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  return latencies[p95Index];
}
```

**Slippage Correlation Pattern:**
```javascript
// src/modules/trade-event/logic.js

export function querySlippageBySize({ windowId, strategyId } = {}) {
  // Group by size buckets and calculate avg slippage per bucket
  let sql = `
    SELECT
      CASE
        WHEN requested_size < 50 THEN 'small'
        WHEN requested_size < 200 THEN 'medium'
        ELSE 'large'
      END as size_bucket,
      COUNT(*) as count,
      AVG(slippage_vs_expected) as avg_slippage,
      AVG(requested_size) as avg_size
    FROM trade_events
    WHERE requested_size IS NOT NULL
      AND slippage_vs_expected IS NOT NULL
      AND event_type IN ('entry', 'exit')
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

  sql += ' GROUP BY size_bucket ORDER BY avg_size';

  return all(sql, params);
}
```

**Threshold Detection Pattern:**
```javascript
// src/modules/trade-event/logic.js

export function detectDiagnosticFlags(event, thresholds) {
  const flags = [];

  if (event.latency_total_ms > thresholds.latencyThresholdMs) {
    flags.push('high_latency');
  }

  if (event.slippage_vs_expected !== null && event.expected_price) {
    const slippagePct = Math.abs(event.slippage_vs_expected / event.expected_price);
    if (slippagePct > thresholds.slippageThresholdPct) {
      flags.push('high_slippage');
    }
  }

  if (event.size_vs_depth_ratio > thresholds.sizeImpactThreshold) {
    flags.push('size_impact');
  }

  return flags;
}
```

### Configuration Pattern

```javascript
// config/default.js - add to existing config

module.exports = {
  // ... existing config ...

  monitoring: {
    // Latency threshold for flagging (NFR1: 500ms target)
    latencyThresholdMs: 500,

    // Slippage threshold as percentage of expected price
    slippageThresholdPct: 0.02, // 2%

    // Size impact threshold (ratio of size to depth)
    sizeImpactThreshold: 0.5, // 50% of available depth
  },
};
```

### Order Manager Timestamp Integration

The order manager needs to capture timestamps at the actual moments:

```javascript
// src/modules/order-manager/logic.js

async function submitOrder(orderParams) {
  const orderSubmittedAt = new Date().toISOString(); // Capture BEFORE API call

  const response = await polymarketClient.placeOrder(orderParams);

  const orderAckedAt = new Date().toISOString(); // Capture AFTER API response

  return {
    ...response,
    timestamps: {
      orderSubmittedAt,
      orderAckedAt,
    },
  };
}
```

### Edge Cases

1. **Missing Timestamps:** Calculate only the latencies where both timestamps exist
2. **Negative Latencies:** Log warning if timestamps are out of order (clock skew)
3. **Zero Depth:** Set size_vs_depth_ratio to null if depth is 0 or missing
4. **Partial Fills:** Use the final fill timestamp for latency calculations
5. **Market Orders:** Expected price may differ from limit orders - handle appropriately
6. **No Events:** Return empty stats object, not error

### Testing Approach

```javascript
// src/modules/trade-event/__tests__/logic.test.js

describe('Latency Analysis', () => {
  describe('getLatencyStats', () => {
    it('should calculate min/max/avg correctly', async () => {
      // Insert test events with known latencies
      await insertTestEvent({ latency_total_ms: 100 });
      await insertTestEvent({ latency_total_ms: 200 });
      await insertTestEvent({ latency_total_ms: 300 });

      const stats = queryLatencyStats();

      expect(stats.min_total_ms).toBe(100);
      expect(stats.max_total_ms).toBe(300);
      expect(stats.avg_total_ms).toBe(200);
      expect(stats.count).toBe(3);
    });

    it('should filter by windowId', async () => {
      await insertTestEvent({ window_id: 'w1', latency_total_ms: 100 });
      await insertTestEvent({ window_id: 'w2', latency_total_ms: 200 });

      const stats = queryLatencyStats({ windowId: 'w1' });

      expect(stats.count).toBe(1);
      expect(stats.avg_total_ms).toBe(100);
    });
  });

  describe('calculateP95Latency', () => {
    it('should calculate 95th percentile correctly', async () => {
      // Insert 100 events with latencies 1-100
      for (let i = 1; i <= 100; i++) {
        await insertTestEvent({ latency_total_ms: i });
      }

      const p95 = calculateP95Latency();

      expect(p95).toBe(95);
    });
  });
});

describe('Slippage Analysis', () => {
  describe('getSlippageBySize', () => {
    it('should group slippage by size buckets', async () => {
      await insertTestEvent({ requested_size: 25, slippage_vs_expected: 0.01 });
      await insertTestEvent({ requested_size: 100, slippage_vs_expected: 0.02 });
      await insertTestEvent({ requested_size: 300, slippage_vs_expected: 0.03 });

      const results = querySlippageBySize();

      expect(results).toHaveLength(3);
      expect(results.find(r => r.size_bucket === 'small').avg_slippage).toBe(0.01);
      expect(results.find(r => r.size_bucket === 'medium').avg_slippage).toBe(0.02);
      expect(results.find(r => r.size_bucket === 'large').avg_slippage).toBe(0.03);
    });
  });
});

describe('Threshold Detection', () => {
  it('should flag high latency events', () => {
    const event = { latency_total_ms: 600 };
    const thresholds = { latencyThresholdMs: 500 };

    const flags = detectDiagnosticFlags(event, thresholds);

    expect(flags).toContain('high_latency');
  });

  it('should flag high slippage events', () => {
    const event = {
      slippage_vs_expected: 0.015, // 1.5% slippage on $1 expected
      expected_price: 1.0
    };
    const thresholds = { slippageThresholdPct: 0.01 }; // 1% threshold

    const flags = detectDiagnosticFlags(event, thresholds);

    expect(flags).toContain('high_slippage');
  });
});
```

### NFR Compliance

- **FR15:** System can log latency for every order operation - timestamps captured at each stage
- **FR21:** System can log expected vs. actual for each signal and execution - slippage analysis
- **NFR1:** Order placement completes within 500ms - threshold detection flags violations
- **NFR4:** System logs latency for every order operation for monitoring - analysis functions enable this

### Integration with Other Stories

**Story 5.1 (Trade Event Logging):** This story builds directly on 5.1's infrastructure
- Uses existing calculateLatencies() and calculateSlippage() functions
- Adds analysis layer on top of existing data

**Story 5.3 (Divergence Detection):** Uses the diagnostic_flags populated here
- high_latency, high_slippage, size_impact flags prepared for divergence detection

**Story 5.4 (Divergence Alerting):** Uses threshold violations detected here
- Events with diagnostic_flags trigger alerting logic

**Story 5.5 (Silent Operation Mode):** Uses info level for normal, warn/error for flagged
- Normal latency/slippage = info (silent)
- Threshold violations = warn (alerts)

### Critical Implementation Notes

1. **Capture timestamps at actual moments** - not derived from other data
2. **Use consistent ISO format** - `new Date().toISOString()` everywhere
3. **Handle nulls gracefully** - missing data should not cause errors
4. **Calculate percentages correctly** - slippage_vs_expected / expected_price for %
5. **Use database aggregation** - SQLite is efficient for stats queries
6. **P95 in JavaScript** - easier than SQLite for percentile calculations
7. **Size buckets are configurable** - small/medium/large thresholds from config

### References

- [Source: architecture.md#Performance] - NFR1, NFR4 latency requirements
- [Source: architecture.md#Database-Schema] - trade_events table with latency/slippage columns
- [Source: prd.md#FR15] - System can log latency for every order operation
- [Source: prd.md#FR21] - System can log expected vs. actual for each signal and execution
- [Source: prd.md#NFR1] - Order placement completes within 500ms under normal conditions
- [Source: prd.md#NFR4] - System logs latency for every order operation for monitoring
- [Source: epics.md#Story-5.2] - Story requirements and acceptance criteria
- [Source: src/modules/trade-event/logic.js] - Existing calculateLatencies() and calculateSlippage() functions
- [Source: src/modules/trade-event/index.js] - Existing module interface to extend
- [Source: 5-1-trade-event-logging-expected-vs-actual.md] - Previous story implementation

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

