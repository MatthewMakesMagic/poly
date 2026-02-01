# Story 7.3: Feed Divergence Tracker

Status: review

---

## Story

As a **trader**,
I want **real-time tracking of the spread between UI and Oracle prices**,
So that **I can see when they diverge and by how much**.

---

## Acceptance Criteria

### AC1: Spread Calculation
**Given** ticks arrive from both feeds
**When** prices are updated
**Then** spread is calculated: `ui_price - oracle_price`
**And** percentage spread is calculated: `(ui_price - oracle_price) / oracle_price`
**And** direction is tracked: UI leading (positive) or lagging (negative)

### AC2: State Query
**Given** spread is calculated
**When** querying current state
**Then** getState() returns: `{ symbol, ui_price, oracle_price, spread, spread_pct, direction, last_updated }`

### AC3: Threshold Breach Events
**Given** spread exceeds threshold
**When** threshold is breached (configurable, default 0.3%)
**Then** an event is emitted for strategy layer
**And** breach is logged with full context

### AC4: Spread History Logging
**Given** spread history is needed
**When** analyzing patterns
**Then** spread snapshots are logged periodically (every 1 second during active windows)

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1, 2)
  - [x] Create `src/modules/divergence-tracker/` folder
  - [x] Create `index.js` (public interface: init, getSpread, getState, subscribe, shutdown)
  - [x] Create `tracker.js` (DivergenceTracker class with spread calculation logic)
  - [x] Create `types.js` (DivergenceTrackerError, error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Implement spread calculation** (AC: 1)
  - [x] Track latest price per symbol per topic (ui_price, oracle_price)
  - [x] Calculate raw spread: `ui_price - oracle_price`
  - [x] Calculate percentage spread: `(ui_price - oracle_price) / oracle_price`
  - [x] Determine direction: `'ui_leading'` if spread > 0, `'ui_lagging'` if < 0, `'aligned'` if ~0
  - [x] Update spread on every tick from either feed

- [x] **Task 3: Implement subscription pattern** (AC: 3)
  - [x] Create EventEmitter or callback registry for spread updates
  - [x] Allow subscribing to spread updates per symbol
  - [x] Allow subscribing to threshold breach events
  - [x] Return unsubscribe function for each subscription
  - [x] Emit events on spread update and threshold breach

- [x] **Task 4: Implement threshold breach detection** (AC: 3)
  - [x] Configurable threshold (default 0.3% = 0.003)
  - [x] Detect breach when `|spread_pct| > threshold`
  - [x] Track breach state to avoid duplicate events
  - [x] Emit `breach_started` event when threshold crossed
  - [x] Emit `breach_ended` event when spread returns below threshold
  - [x] Log all breach events with full context

- [x] **Task 5: Implement spread snapshot logging** (AC: 4)
  - [x] Create database table or use existing logging mechanism
  - [x] Log spread snapshots every 1 second during active tracking
  - [x] Include all spread data: symbol, ui_price, oracle_price, spread, spread_pct, direction
  - [x] Configurable snapshot interval (default 1000ms)
  - [x] Configurable enable/disable for snapshot logging

- [x] **Task 6: Wire up RTDS subscription** (AC: 1)
  - [x] Subscribe to RTDS client on init for all symbols
  - [x] Handle ticks from both topics: `crypto_prices` and `crypto_prices_chainlink`
  - [x] Update spread calculation on each tick
  - [x] Handle missing price gracefully (wait for both feeds before calculating)

- [x] **Task 7: Implement module interface** (AC: 2)
  - [x] Export `init(config)` - subscribe to RTDS, start tracking
  - [x] Export `getSpread(symbol)` - get current spread for symbol
  - [x] Export `subscribe(symbol, callback)` - subscribe to spread updates
  - [x] Export `subscribeToBreaches(callback)` - subscribe to threshold breaches
  - [x] Export `getState()` - return all spreads, stats, config
  - [x] Export `shutdown()` - cleanup subscriptions gracefully

- [x] **Task 8: Write tests** (AC: 1, 2, 3, 4)
  - [x] Unit tests for spread calculation (positive, negative, zero)
  - [x] Unit tests for percentage spread calculation
  - [x] Unit tests for direction determination
  - [x] Unit tests for threshold breach detection
  - [x] Unit tests for subscription pattern (subscribe/unsubscribe)
  - [x] Integration test with mock RTDS client
  - [x] Test breach event emission

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/divergence-tracker/`

**File Structure (per architecture.md):**
```
src/modules/divergence-tracker/
├── index.js          # Public interface (init, getSpread, subscribe, getState, shutdown)
├── tracker.js        # DivergenceTracker class with spread calculation logic
├── types.js          # DivergenceTrackerError, error codes, constants
└── __tests__/
    ├── index.test.js
    ├── tracker.test.js
    └── breach.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function getSpread(symbol) {}  // Get current spread for symbol
export function subscribe(symbol, callback) {}  // Subscribe to spread updates
export function subscribeToBreaches(callback) {}  // Subscribe to threshold breaches
export function getState() {}
export async function shutdown() {}
export { DivergenceTrackerError, DivergenceTrackerErrorCodes };
```

### Pattern Reference: Tick Logger (Story 7-2) & RTDS Client (Story 7-1)

This module follows the EXACT same patterns as the previous stories:

1. **index.js** - thin wrapper that:
   - Creates child logger: `log = child({ module: 'divergence-tracker' })`
   - Instantiates internal tracker class
   - Subscribes to RTDS client for ticks
   - Exposes standard interface

2. **Error Handling** - use PolyError pattern:
```javascript
import { PolyError } from '../../types/errors.js';

class DivergenceTrackerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'DivergenceTrackerError';
  }
}
```

3. **Error Codes:**
```javascript
export const DivergenceTrackerErrorCodes = {
  NOT_INITIALIZED: 'DIVERGENCE_TRACKER_NOT_INITIALIZED',
  INVALID_SYMBOL: 'DIVERGENCE_TRACKER_INVALID_SYMBOL',
  SUBSCRIPTION_FAILED: 'DIVERGENCE_TRACKER_SUBSCRIPTION_FAILED',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  divergenceTracker: {
    thresholdPct: 0.003,          // 0.3% default threshold for breach detection
    snapshotIntervalMs: 1000,     // Log spread snapshot every 1 second
    enableSnapshots: true,        // Enable/disable snapshot logging
    alignedThresholdPct: 0.0001,  // Consider "aligned" if spread < 0.01%
  }
}
```

### Spread Calculation Logic

**Core Algorithm:**
```javascript
class DivergenceTracker {
  constructor(config) {
    this.prices = {
      btc: { ui: null, oracle: null, spread: null },
      eth: { ui: null, oracle: null, spread: null },
      sol: { ui: null, oracle: null, spread: null },
      xrp: { ui: null, oracle: null, spread: null },
    };
    this.thresholdPct = config.thresholdPct;
    this.breachState = {}; // Track breach state per symbol to avoid duplicate events
  }

  updatePrice(symbol, topic, price) {
    if (topic === TOPICS.CRYPTO_PRICES) {
      this.prices[symbol].ui = price;
    } else if (topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
      this.prices[symbol].oracle = price;
    }

    this.calculateSpread(symbol);
  }

  calculateSpread(symbol) {
    const { ui, oracle } = this.prices[symbol];

    // Need both prices to calculate spread
    if (ui === null || oracle === null) {
      return null;
    }

    const spread = ui - oracle;
    const spreadPct = oracle !== 0 ? spread / oracle : 0;
    const direction = this.determineDirection(spreadPct);

    this.prices[symbol].spread = {
      raw: spread,
      pct: spreadPct,
      direction,
      ui_price: ui,
      oracle_price: oracle,
      last_updated: new Date().toISOString(),
    };

    this.checkBreachThreshold(symbol, spreadPct);
    this.notifySubscribers(symbol);

    return this.prices[symbol].spread;
  }

  determineDirection(spreadPct) {
    if (Math.abs(spreadPct) < this.alignedThresholdPct) {
      return 'aligned';
    }
    return spreadPct > 0 ? 'ui_leading' : 'ui_lagging';
  }
}
```

### Threshold Breach Logic

```javascript
checkBreachThreshold(symbol, spreadPct) {
  const absSpread = Math.abs(spreadPct);
  const wasBreached = this.breachState[symbol]?.breached || false;
  const isBreached = absSpread > this.thresholdPct;

  if (isBreached && !wasBreached) {
    // Breach started
    this.breachState[symbol] = {
      breached: true,
      breachStartedAt: new Date().toISOString(),
      spreadAtBreach: spreadPct,
    };
    this.emitBreachEvent('breach_started', symbol, spreadPct);
    log.warn('spread_breach_started', {
      symbol,
      spread_pct: spreadPct,
      threshold_pct: this.thresholdPct,
      direction: this.prices[symbol].spread.direction,
    });
  } else if (!isBreached && wasBreached) {
    // Breach ended
    const breachDurationMs = Date.now() - new Date(this.breachState[symbol].breachStartedAt).getTime();
    this.emitBreachEvent('breach_ended', symbol, spreadPct, breachDurationMs);
    log.info('spread_breach_ended', {
      symbol,
      spread_pct: spreadPct,
      breach_duration_ms: breachDurationMs,
    });
    this.breachState[symbol] = { breached: false };
  }
}
```

### Integration with RTDS Client

```javascript
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS, TOPICS } from '../../clients/rtds/types.js';

async function init(config) {
  // ... setup ...

  // Subscribe to all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    rtdsClient.subscribe(symbol, (tick) => {
      // tick format: { timestamp, topic, symbol, price }
      tracker.updatePrice(tick.symbol, tick.topic, tick.price);
    });
  }
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    spreads: {
      btc: {
        ui_price: 95234.50,
        oracle_price: 95230.00,
        spread: 4.50,
        spread_pct: 0.0000472,
        direction: 'ui_leading',
        last_updated: '2026-02-01T12:00:00.000Z',
      },
      eth: { ... },
      sol: { ... },
      xrp: { ... },
    },
    breaches: {
      btc: { breached: false },
      eth: { breached: true, breachStartedAt: '...', spreadAtBreach: 0.0045 },
      // ...
    },
    stats: {
      ticks_processed: 12345,
      breaches_detected: 5,
      last_breach_at: '...',
    },
    config: {
      thresholdPct: 0.003,
      snapshotIntervalMs: 1000,
      enableSnapshots: true,
    },
  };
}
```

### Logging Requirements

All logs MUST use structured format with required fields:

```javascript
log.info('divergence_tracker_initialized', { config: { thresholdPct, snapshotIntervalMs } });
log.info('spread_updated', { symbol, spread_pct: 0.0012, direction: 'ui_leading' });
log.warn('spread_breach_started', { symbol, spread_pct: 0.0045, threshold_pct: 0.003, direction: 'ui_leading' });
log.info('spread_breach_ended', { symbol, spread_pct: 0.0028, breach_duration_ms: 5432 });
log.info('spread_snapshot', { symbol, ui_price, oracle_price, spread, spread_pct, direction });
```

### Testing Strategy

1. **Unit Tests (tracker.test.js):**
   - Spread calculation with positive, negative, zero spreads
   - Percentage spread calculation
   - Direction determination (ui_leading, ui_lagging, aligned)
   - Missing price handling (null before both feeds arrive)
   - Price update triggers recalculation

2. **Unit Tests (breach.test.js):**
   - Threshold breach detection
   - Breach started event emission
   - Breach ended event emission
   - Duplicate event prevention (no event if already breached)
   - Breach duration tracking

3. **Unit Tests (index.test.js):**
   - Init creates subscriptions to RTDS
   - getSpread returns correct spread data
   - subscribe/unsubscribe pattern works
   - getState returns correct shape
   - shutdown cleans up subscriptions

4. **Integration Tests:**
   - Mock RTDS client with simulated ticks
   - Verify spread updates on ticks from both topics
   - Verify breach events emitted correctly

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/clients/rtds/` - for tick subscription (Story 7-1)

**Optional (for snapshot logging):**
- `src/persistence/` - if logging snapshots to database (can use logger instead)

**No new npm packages required.**

### Previous Story Intelligence (7-1 & 7-2)

**Key Learnings from Story 7-1 (RTDS Client):**
1. Tick format is already normalized: `{ timestamp, topic, symbol, price }`
2. Use constants: `TOPICS.CRYPTO_PRICES`, `TOPICS.CRYPTO_PRICES_CHAINLINK`
3. Symbols are already normalized: btc, eth, sol, xrp
4. Subscribe pattern returns unsubscribe function

**Key Learnings from Story 7-2 (Tick Logger):**
1. Use `child({ module: 'divergence-tracker' })` for logger
2. Subscribe to all SUPPORTED_SYMBOLS on init
3. Validate tick data before processing
4. Handle edge cases (NaN, null, undefined)
5. Use rate limiting for warning logs

**Code Review Findings to Apply:**
- Validate all inputs before processing
- Use rate limiting for repeated warnings
- Handle edge cases explicitly (division by zero for spread_pct)
- Add defensive null checks

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- RTDS client provides normalized ticks - just track and calculate
- This module is an ANALYSIS module - receives ticks, calculates spreads, emits events
- Strategy layer (Story 7-7) will consume spread/breach events

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides tick data

**Used by:**
- Story 7-6 (Oracle Staleness Detector) - uses spread data for staleness detection
- Story 7-7 (Oracle Edge Signal Generator) - uses spread and breach events for signal generation

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-3]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/implementation-artifacts/7-1-rtds-websocket-client.md - RTDS client patterns]
- [Source: _bmad-output/implementation-artifacts/7-2-feed-tick-logger.md - Module patterns]
- [Source: src/clients/rtds/index.js - RTDS client interface]
- [Source: src/clients/rtds/types.js - Tick format, symbols, topics]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - All tests pass, no debug sessions required.

### Completion Notes List

- Implemented full divergence tracker module following architecture patterns from Stories 7-1 and 7-2
- DivergenceTracker class handles spread calculation with proper edge case handling (null prices, division by zero, invalid inputs)
- Subscription pattern uses Set-based callbacks for spread updates per symbol and breach events globally
- Threshold breach detection tracks state per symbol to prevent duplicate events, calculates breach duration
- Spread snapshot logging uses configurable interval with logger (not database per AC4 - "use existing logging mechanism")
- All 72 module-specific tests pass; full regression suite (1880 tests) passes
- Module follows standard interface: init(config), getSpread(symbol), subscribe(symbol, callback), subscribeToBreaches(callback), getState(), shutdown()
- Direction constants: 'ui_leading', 'ui_lagging', 'aligned' with configurable alignedThresholdPct (0.01%)
- Default breach threshold: 0.3% (0.003)

### File List

- src/modules/divergence-tracker/index.js (new)
- src/modules/divergence-tracker/tracker.js (new)
- src/modules/divergence-tracker/types.js (new)
- src/modules/divergence-tracker/__tests__/tracker.test.js (new)
- src/modules/divergence-tracker/__tests__/index.test.js (new)

### Change Log

- 2026-02-01: Implemented Story 7-3 Feed Divergence Tracker - all 8 tasks complete, 72 tests added

