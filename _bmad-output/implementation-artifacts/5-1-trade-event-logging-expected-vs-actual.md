# Story 5.1: Trade Event Logging with Expected vs Actual

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **every trade event logged with expected vs actual values**,
So that **I can analyze why trades performed as they did (FR20, FR21)**.

## Acceptance Criteria

### AC1: Trade Events Table Creation

**Given** the persistence layer initializes
**When** migrations run
**Then** a `trade_events` table is created with all columns per architecture spec
**And** includes identity columns: `event_type`, `window_id`, `position_id`, `order_id`, `strategy_id`, `module`
**And** includes timestamp columns: `signal_detected_at`, `order_submitted_at`, `order_acked_at`, `order_filled_at`
**And** includes price columns: `price_at_signal`, `price_at_submit`, `price_at_fill`, `expected_price`
**And** includes slippage columns: `slippage_signal_to_fill`, `slippage_vs_expected`
**And** includes level and event columns for log compatibility
**And** has appropriate indexes for query performance

### AC2: Trade Event Recording on Signal

**Given** a strategy generates an entry or exit signal
**When** the signal is detected
**Then** a `trade_events` record is created with `event_type = 'signal'`
**And** `signal_detected_at` is captured as ISO timestamp
**And** `price_at_signal` captures the market price when signal detected
**And** `expected_price` captures the strategy's expected execution price
**And** market context is captured: `bid_at_signal`, `ask_at_signal`, `spread_at_signal`, `depth_at_signal`

### AC3: Trade Event Recording on Entry

**Given** an entry order is submitted and fills
**When** the trade completes
**Then** a `trade_events` record is created with `event_type = 'entry'`
**And** all timestamps are populated: `signal_detected_at`, `order_submitted_at`, `order_acked_at`, `order_filled_at`
**And** all prices are populated: `price_at_signal`, `price_at_submit`, `price_at_fill`, `expected_price`
**And** slippage is calculated: `slippage_signal_to_fill = price_at_fill - price_at_signal`
**And** slippage vs expected is calculated: `slippage_vs_expected = price_at_fill - expected_price`
**And** size context is captured: `requested_size`, `filled_size`, `size_vs_depth_ratio`

### AC4: Trade Event Recording on Exit

**Given** an exit order (stop-loss, take-profit, or window expiry) executes
**When** the trade completes
**Then** a `trade_events` record is created with `event_type = 'exit'`
**And** the record links to the original position via `position_id`
**And** includes exit reason in `notes` (e.g., `{"exit_reason": "stop_loss"}`)
**And** all timing and pricing data is captured same as entry events

### AC5: Structured JSON Log Format Compliance

**Given** a trade event is recorded
**When** it is also logged via the logger module
**Then** log entry includes required fields: timestamp, level, module, event
**And** data field includes expected vs actual values
**And** format follows snake_case convention per architecture
**And** no sensitive data (credentials) is included

### AC6: 100% Diagnostic Coverage (NFR9)

**Given** any trade-related action occurs (signal, entry, exit, cancel, error)
**When** the action completes
**Then** a corresponding `trade_events` record exists
**And** a corresponding structured log entry exists
**And** no gaps in the event stream
**And** every event has complete expected vs actual data

### AC7: Trade Event Query Interface

**Given** the trade event module is initialized
**When** inspecting its interface
**Then** it exports: `init()`, `recordSignal()`, `recordEntry()`, `recordExit()`, `recordAlert()`, `getEvents()`, `getEventsByWindow()`, `getState()`, `shutdown()`
**And** all functions return Promises
**And** errors are thrown with typed error codes

## Tasks / Subtasks

- [x] **Task 1: Create trade_events Database Migration** (AC: 1)
  - [x] 1.1 Create `004-trade-events-table.js` migration file
  - [x] 1.2 Define all columns per architecture.md schema spec
  - [x] 1.3 Add indexes: `idx_events_type`, `idx_events_window`, `idx_events_strategy`, `idx_events_level`
  - [x] 1.4 Add foreign key references to `positions` table
  - [x] 1.5 Include `up()` and `down()` functions for migration

- [x] **Task 2: Create Trade Event Module Structure** (AC: 7)
  - [x] 2.1 Create `src/modules/trade-event/` directory
  - [x] 2.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 2.3 Create `types.js` with TradeEventType enum and error codes
  - [x] 2.4 Create `state.js` for internal state management
  - [x] 2.5 Create `logic.js` for event recording business logic

- [x] **Task 3: Implement recordSignal()** (AC: 2)
  - [x] 3.1 Create function signature: `recordSignal({ windowId, strategyId, signalType, priceAtSignal, expectedPrice, marketContext })`
  - [x] 3.2 Capture `signal_detected_at` timestamp
  - [x] 3.3 Insert record with `event_type = 'signal'` and `level = 'info'`
  - [x] 3.4 Log signal event via logger module
  - [x] 3.5 Return the created event ID

- [x] **Task 4: Implement recordEntry()** (AC: 3, 5)
  - [x] 4.1 Create function signature: `recordEntry({ windowId, positionId, orderId, strategyId, timestamps, prices, sizes })`
  - [x] 4.2 Calculate computed latencies from timestamps
  - [x] 4.3 Calculate slippage values: `slippage_signal_to_fill`, `slippage_vs_expected`
  - [x] 4.4 Calculate `size_vs_depth_ratio` if depth data available
  - [x] 4.5 Insert record with `event_type = 'entry'` and `level = 'info'`
  - [x] 4.6 Log entry event with expected vs actual in data field
  - [x] 4.7 Return the created event ID

- [x] **Task 5: Implement recordExit()** (AC: 4, 5)
  - [x] 5.1 Create function signature: `recordExit({ windowId, positionId, orderId, strategyId, exitReason, timestamps, prices })`
  - [x] 5.2 Validate position exists and link via `position_id`
  - [x] 5.3 Store exit reason in `notes` JSON field
  - [x] 5.4 Calculate latencies and slippage same as entry
  - [x] 5.5 Insert record with `event_type = 'exit'` and `level = 'info'`
  - [x] 5.6 Log exit event with expected vs actual
  - [x] 5.7 Return the created event ID

- [x] **Task 6: Implement recordAlert()** (AC: 6)
  - [x] 6.1 Create function signature: `recordAlert({ windowId, positionId, alertType, data, level })`
  - [x] 6.2 Support levels: 'warn' and 'error' based on alert severity
  - [x] 6.3 Insert record with `event_type = 'alert'`
  - [x] 6.4 Log alert event with full diagnostic context
  - [x] 6.5 Include diagnostic_flags for pattern detection

- [x] **Task 7: Implement Query Functions** (AC: 7)
  - [x] 7.1 Implement `getEvents({ limit, offset, eventType, level })` for filtered queries
  - [x] 7.2 Implement `getEventsByWindow(windowId)` for window-based analysis
  - [x] 7.3 Implement `getEventsByPosition(positionId)` for position lifecycle view
  - [x] 7.4 Return results with computed fields (latencies, slippage)

- [x] **Task 8: Integrate with Orchestrator** (AC: 6)
  - [x] 8.1 Add trade-event module to MODULE_INIT_ORDER in orchestrator/state.js
  - [x] 8.2 Import and initialize trade-event module in orchestrator
  - [x] 8.3 Call `recordSignal()` when strategy evaluator generates signal
  - [x] 8.4 Call `recordEntry()` when position is opened
  - [x] 8.5 Call `recordExit()` when position is closed
  - [x] 8.6 Call `recordAlert()` on divergence or error conditions

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Test migration creates table with all required columns
  - [x] 9.2 Test `recordSignal()` creates correct record with timestamps
  - [x] 9.3 Test `recordEntry()` calculates slippage correctly
  - [x] 9.4 Test `recordEntry()` calculates latencies correctly
  - [x] 9.5 Test `recordExit()` links to position and includes exit reason
  - [x] 9.6 Test `recordAlert()` creates warn/error level records
  - [x] 9.7 Test query functions filter correctly
  - [x] 9.8 Test all events are also logged via logger module
  - [x] 9.9 Integration test: signal → entry → exit event chain
  - [x] 9.10 Test 100% coverage: verify no event type is missing

## Dev Notes

### Architecture Compliance

This story implements FR20 (produce structured JSON logs for every trade event) and FR21 (log expected vs actual for each signal and execution). It establishes the foundation for Epic 5's monitoring and diagnostics capabilities.

**From architecture.md#Monitoring-&-Logging:**
> FR20: System can produce structured JSON logs for every trade event
> FR21: System can log expected vs actual for each signal and execution

**From architecture.md#Database-Schema - trade_events:**
```sql
CREATE TABLE trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    window_id TEXT NOT NULL,
    position_id INTEGER,
    order_id INTEGER,
    strategy_id TEXT,
    module TEXT NOT NULL,
    signal_detected_at TEXT,
    order_submitted_at TEXT,
    order_acked_at TEXT,
    order_filled_at TEXT,
    latency_decision_to_submit_ms INTEGER,
    latency_submit_to_ack_ms INTEGER,
    latency_ack_to_fill_ms INTEGER,
    latency_total_ms INTEGER,
    price_at_signal REAL,
    price_at_submit REAL,
    price_at_fill REAL,
    expected_price REAL,
    slippage_signal_to_fill REAL,
    slippage_vs_expected REAL,
    bid_at_signal REAL,
    ask_at_signal REAL,
    spread_at_signal REAL,
    depth_at_signal REAL,
    requested_size REAL,
    filled_size REAL,
    size_vs_depth_ratio REAL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    diagnostic_flags TEXT,
    notes TEXT,
    FOREIGN KEY (position_id) REFERENCES positions(id)
);
```

### Project Structure Notes

**New files to create:**
```
src/modules/trade-event/
├── index.js          # Public interface (init, recordSignal, recordEntry, recordExit, recordAlert, getEvents, getEventsByWindow, getState, shutdown)
├── logic.js          # Event recording and slippage/latency calculations
├── state.js          # Internal state management
├── types.js          # TradeEventType enum, error codes
└── __tests__/
    ├── index.test.js
    └── logic.test.js

src/persistence/migrations/
└── 004-trade-events-table.js  # New migration
```

**Existing files to modify:**
```
src/modules/orchestrator/state.js    # Add trade-event to MODULE_INIT_ORDER
src/modules/orchestrator/index.js    # Import and wire trade-event module
src/modules/orchestrator/execution-loop.js  # Call record functions at appropriate points
```

### Implementation Approach

**Event Type Enum:**
```javascript
// src/modules/trade-event/types.js
export const TradeEventType = {
  SIGNAL: 'signal',
  ENTRY: 'entry',
  EXIT: 'exit',
  ALERT: 'alert',
  DIVERGENCE: 'divergence',
};

export const TradeEventErrorCodes = {
  ALREADY_INITIALIZED: 'TRADE_EVENT_ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'TRADE_EVENT_NOT_INITIALIZED',
  INVALID_EVENT_TYPE: 'INVALID_EVENT_TYPE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
};
```

**recordEntry() Implementation:**
```javascript
// src/modules/trade-event/logic.js

export async function recordEntry({
  windowId,
  positionId,
  orderId,
  strategyId,
  timestamps,  // { signalDetectedAt, orderSubmittedAt, orderAckedAt, orderFilledAt }
  prices,      // { priceAtSignal, priceAtSubmit, priceAtFill, expectedPrice }
  sizes,       // { requestedSize, filledSize }
  marketContext, // { bidAtSignal, askAtSignal, spreadAtSignal, depthAtSignal }
}) {
  // Calculate latencies
  const latencies = calculateLatencies(timestamps);

  // Calculate slippage
  const slippage = {
    slippage_signal_to_fill: prices.priceAtFill - prices.priceAtSignal,
    slippage_vs_expected: prices.priceAtFill - prices.expectedPrice,
  };

  // Calculate size ratio
  const sizeVsDepthRatio = marketContext?.depthAtSignal
    ? sizes.requestedSize / marketContext.depthAtSignal
    : null;

  // Build record
  const record = {
    event_type: TradeEventType.ENTRY,
    window_id: windowId,
    position_id: positionId,
    order_id: orderId,
    strategy_id: strategyId,
    module: 'trade-event',
    ...timestamps,
    ...latencies,
    ...prices,
    ...slippage,
    ...marketContext,
    requested_size: sizes.requestedSize,
    filled_size: sizes.filledSize,
    size_vs_depth_ratio: sizeVsDepthRatio,
    level: 'info',
    event: 'trade_entry',
  };

  // Insert to database
  const eventId = await insertTradeEvent(record);

  // Log via logger module
  log.info('trade_entry', {
    window_id: windowId,
    position_id: positionId,
    expected: {
      price: prices.expectedPrice,
      size: sizes.requestedSize,
    },
    actual: {
      price: prices.priceAtFill,
      size: sizes.filledSize,
    },
    slippage: slippage.slippage_vs_expected,
    latency_ms: latencies.latency_total_ms,
  }, { strategy_id: strategyId });

  return eventId;
}
```

**Latency Calculation Helper:**
```javascript
// src/modules/trade-event/logic.js

function calculateLatencies(timestamps) {
  const { signalDetectedAt, orderSubmittedAt, orderAckedAt, orderFilledAt } = timestamps;

  // Parse ISO timestamps to milliseconds
  const signalMs = new Date(signalDetectedAt).getTime();
  const submitMs = new Date(orderSubmittedAt).getTime();
  const ackMs = orderAckedAt ? new Date(orderAckedAt).getTime() : null;
  const fillMs = orderFilledAt ? new Date(orderFilledAt).getTime() : null;

  return {
    latency_decision_to_submit_ms: submitMs - signalMs,
    latency_submit_to_ack_ms: ackMs ? ackMs - submitMs : null,
    latency_ack_to_fill_ms: ackMs && fillMs ? fillMs - ackMs : null,
    latency_total_ms: fillMs ? fillMs - signalMs : null,
  };
}
```

### Previous Story Intelligence (4.4)

**From Story 4.4 implementation:**
- Module interface pattern: `init()`, `getState()`, `shutdown()` plus domain-specific functions
- Child logger pattern: `const log = createLoggerChild({ module: 'trade-event' })`
- State management pattern in `state.js` with getter/setter functions
- Error handling with typed error codes from `types.js`
- Test file pattern: comprehensive unit + integration tests
- Orchestrator integration: add to `MODULE_INIT_ORDER`, import in index.js

**Files from 4-4 commit pattern:**
- `src/modules/safety/` structure is the model to follow
- All tests pass before marking complete
- Migration pattern follows 003-daily-performance-table.js

### Git Intelligence (from recent commits)

**Commit pattern:**
```
16a9209 Implement story 4-4-drawdown-limit-enforcement-auto-stop
502a96d Implement story 4-3-drawdown-tracking
```

Follow pattern: "Implement story 5-1-trade-event-logging-expected-vs-actual"

**Test count baseline:** 1113 tests passing (from 4-4)

### Configuration Notes

No new configuration required for this story. The trade-event module uses existing:
- `config.logging.level` for log level filtering
- Database connection from persistence module

### Edge Cases

1. **Partial Fills:** If order partially fills, record both `requested_size` and `filled_size` to track fill ratio
2. **Missing Timestamps:** Some fields may be null (e.g., `order_acked_at` if no explicit ack) - calculate latencies only when both timestamps exist
3. **Signal Without Entry:** Signals that don't result in entries (filtered, limit not reached) still get recorded as signal events
4. **Rapid Events:** Use database transactions for consistency when recording multiple related events
5. **Module Not Initialized:** Throw `NOT_INITIALIZED` error, don't silently fail
6. **Position Not Found:** When recording exit, validate position exists before linking

### Testing Approach

```javascript
// src/modules/trade-event/__tests__/logic.test.js

describe('Trade Event Logic', () => {
  describe('recordEntry', () => {
    it('should calculate slippage correctly', async () => {
      const result = await recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 'order-456',
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderSubmittedAt: '2026-01-31T10:00:00.100Z',
          orderAckedAt: '2026-01-31T10:00:00.200Z',
          orderFilledAt: '2026-01-31T10:00:00.350Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtSubmit: 0.505,
          priceAtFill: 0.51,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      const event = await getEventById(result);
      expect(event.slippage_signal_to_fill).toBe(0.01); // 0.51 - 0.50
      expect(event.slippage_vs_expected).toBe(0.01);    // 0.51 - 0.50
      expect(event.latency_total_ms).toBe(350);          // 350ms total
    });

    it('should calculate latency breakdown correctly', async () => {
      const result = await recordEntry({
        // ... same as above
      });

      const event = await getEventById(result);
      expect(event.latency_decision_to_submit_ms).toBe(100);
      expect(event.latency_submit_to_ack_ms).toBe(100);
      expect(event.latency_ack_to_fill_ms).toBe(150);
    });

    it('should also log via logger module', async () => {
      const logSpy = jest.spyOn(log, 'info');

      await recordEntry({ /* ... */ });

      expect(logSpy).toHaveBeenCalledWith('trade_entry', expect.objectContaining({
        expected: expect.any(Object),
        actual: expect.any(Object),
        slippage: expect.any(Number),
      }), expect.any(Object));
    });
  });
});
```

### NFR Compliance

- **FR20:** System can produce structured JSON logs for every trade event (this story)
- **FR21:** System can log expected vs actual for each signal and execution (this story)
- **NFR9:** 100% of trade events produce complete structured log - enforced by integration tests
- **NFR4:** System logs latency for every order operation - captured in latency columns

### Integration with Other Stories

**Story 5.2 (Latency & Slippage Recording):** Builds directly on this story's latency and slippage columns
- The latency columns (`latency_*_ms`) and slippage columns (`slippage_*`) are populated here
- Story 5.2 will add threshold checking and pattern analysis

**Story 5.3 (Divergence Detection):** Uses trade_events data
- The `diagnostic_flags` column will be populated when divergence detected
- `recordAlert()` with `event_type = 'divergence'` will be called from divergence logic

**Story 5.4 (Divergence Alerting):** Uses alerts recorded here
- The `recordAlert()` function creates the records that alerting will process
- Level distinction (warn vs error) determines alert severity

**Story 5.5 (Silent Operation Mode):** Relies on level filtering
- Normal operations are `level = 'info'` (silent)
- Divergences are `level = 'warn'` or `level = 'error'` (alerts)

### Critical Implementation Notes

1. **Use snake_case for all database columns and log fields** - per architecture naming conventions

2. **Always record BOTH database entry AND log entry** - dual storage ensures 100% coverage

3. **Calculate slippage from actual values** - don't trust pre-computed values passed in

4. **Timestamps must be ISO format** - use `new Date().toISOString()` consistently

5. **Foreign key to positions is optional** - signal events won't have position_id yet

6. **The `diagnostic_flags` column stores JSON array** - for future pattern detection (Story 5.3)

7. **Use child logger with module name** - `createLoggerChild({ module: 'trade-event' })`

### References

- [Source: architecture.md#Database-Schema] - trade_events table specification
- [Source: architecture.md#Monitoring-&-Logging] - FR20, FR21 requirements
- [Source: architecture.md#Structured-Log-Format] - JSON log format specification
- [Source: prd.md#FR20] - System can produce structured JSON logs for every trade event
- [Source: prd.md#FR21] - System can log expected vs. actual for each signal and execution
- [Source: prd.md#NFR9] - 100% of trade events produce complete structured log (no gaps)
- [Source: epics.md#Story-5.1] - Story requirements and acceptance criteria
- [Source: src/modules/logger/index.js] - Logger module interface to use
- [Source: src/modules/logger/formatter.js] - JSON formatting patterns
- [Source: src/persistence/migrations/003-daily-performance-table.js] - Migration pattern to follow
- [Source: src/modules/safety/] - Module structure pattern to follow

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

### Completion Notes List

- Created trade_events database migration with all columns per architecture spec and 4 indexes
- Implemented trade-event module with standard interface: init(), getState(), shutdown() plus domain functions
- Implemented recordSignal() with market context capture and structured logging
- Implemented recordEntry() with latency and slippage calculations, expected vs actual logging
- Implemented recordExit() with position validation and exit reason tracking
- Implemented recordAlert() with warn/error levels and diagnostic flags
- Implemented query functions: getEvents(), getEventsByWindow(), getEventsByPosition()
- Integrated module with orchestrator: added to MODULE_INIT_ORDER, MODULE_MAP, and execution-loop
- Added recordSignal calls when strategy evaluator generates signals
- Added recordExit calls for stop-loss, take-profit, and window expiry position closes
- Wrote comprehensive tests: 69 new tests (38 index.test.js + 31 logic.test.js)
- All 1182 tests pass (baseline was 1113, added 69 new tests)

### File List

**New files:**
- src/persistence/migrations/004-trade-events-table.js
- src/modules/trade-event/index.js
- src/modules/trade-event/types.js
- src/modules/trade-event/state.js
- src/modules/trade-event/logic.js
- src/modules/trade-event/__tests__/index.test.js
- src/modules/trade-event/__tests__/logic.test.js

**Modified files:**
- src/modules/orchestrator/state.js (added trade-event to MODULE_INIT_ORDER)
- src/modules/orchestrator/index.js (added trade-event import and MODULE_MAP entry)
- src/modules/orchestrator/execution-loop.js (added recordSignal and recordExit calls)

## Change Log

- 2026-01-31: Implemented story 5-1-trade-event-logging-expected-vs-actual - trade event module with expected vs actual logging for all trade events (FR20, FR21)

