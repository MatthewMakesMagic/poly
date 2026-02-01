# Story 7.4: Oracle Update Pattern Tracker

Status: review

---

## Story

As a **quant researcher**,
I want **to learn the Chainlink oracle's update patterns**,
So that **I can predict when updates will occur**.

---

## Acceptance Criteria

### AC1: Oracle Update Detection
**Given** oracle prices arrive from RTDS
**When** a price change is detected
**Then** an update record is created with: timestamp, symbol, price, previous_price, deviation_pct, time_since_previous_ms

### AC2: Pattern Statistics
**Given** update records accumulate
**When** analyzing patterns
**Then** statistics are available: avg_update_frequency, deviation_threshold_observed, update_frequency_by_volatility

### AC3: Pattern Query
**Given** the oracle update table
**When** querying
**Then** I can answer: "On average, how often does Chainlink update?" and "What price move triggers an update?"

---

## Tasks / Subtasks

- [x] **Task 1: Create database migration** (AC: 1, 3)
  - [x] Create migration `008-oracle-updates-table.js`
  - [x] Create `oracle_updates` table with schema from epic
  - [x] Create indexes on symbol and timestamp
  - [x] Test migration applies cleanly

- [x] **Task 2: Create module structure** (AC: 1, 2)
  - [x] Create `src/modules/oracle-tracker/` folder
  - [x] Create `index.js` (public interface: init, getStats, getState, shutdown)
  - [x] Create `tracker.js` (OraclePatternTracker class with update detection logic)
  - [x] Create `types.js` (OracleTrackerError, error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 3: Implement oracle update detection** (AC: 1)
  - [x] Subscribe to RTDS client for oracle topic only (`crypto_prices_chainlink`)
  - [x] Track previous price per symbol
  - [x] Detect price change when new price differs from previous
  - [x] Calculate deviation_pct: `(new_price - previous_price) / previous_price`
  - [x] Calculate time_since_previous_ms from last update timestamp
  - [x] Create update record with all fields

- [x] **Task 4: Implement database persistence** (AC: 1)
  - [x] Insert update records to `oracle_updates` table
  - [x] Use batch inserts for efficiency (buffer and flush every 10 records or 1 second)
  - [x] Include all required fields: timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms
  - [x] Handle database errors gracefully

- [x] **Task 5: Implement pattern statistics** (AC: 2)
  - [x] Create `getStats(symbol)` function
  - [x] Calculate avg_update_frequency from time_since_previous_ms
  - [x] Calculate deviation_threshold_observed (median/mean deviation that triggers updates)
  - [x] Calculate update_frequency_by_volatility (group by deviation buckets)
  - [x] Return stats structure with all calculated values

- [x] **Task 6: Implement query interface** (AC: 3)
  - [x] Create `getAverageUpdateFrequency(symbol)` - answer "how often does Chainlink update?"
  - [x] Create `getDeviationThreshold(symbol)` - answer "what price move triggers an update?"
  - [x] Create `getRecentUpdates(symbol, limit)` - get last N update records
  - [x] Expose via module getState() for debugging

- [x] **Task 7: Implement module interface** (AC: 1, 2, 3)
  - [x] Export `init(config)` - subscribe to RTDS oracle topic, setup tracking
  - [x] Export `getStats(symbol)` - get pattern statistics for symbol
  - [x] Export `getRecentUpdates(symbol, limit)` - get recent update records
  - [x] Export `getState()` - return tracker state, stats, config
  - [x] Export `shutdown()` - flush buffer, cleanup subscriptions

- [x] **Task 8: Write tests** (AC: 1, 2, 3)
  - [x] Unit tests for update detection (price change vs no change)
  - [x] Unit tests for deviation calculation
  - [x] Unit tests for time_since_previous_ms calculation
  - [x] Unit tests for statistics calculation
  - [x] Unit tests for query interface
  - [x] Integration test with mock RTDS client
  - [x] Test database persistence

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/oracle-tracker/`

**File Structure (per architecture.md):**
```
src/modules/oracle-tracker/
├── index.js          # Public interface (init, getStats, getRecentUpdates, getState, shutdown)
├── tracker.js        # OraclePatternTracker class with update detection logic
├── types.js          # OracleTrackerError, error codes, constants
└── __tests__/
    ├── index.test.js
    ├── tracker.test.js
    └── stats.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function getStats(symbol) {}  // Get pattern statistics
export function getRecentUpdates(symbol, limit = 100) {}  // Get recent update records
export function getState() {}
export async function shutdown() {}
export { OracleTrackerError, OracleTrackerErrorCodes };
```

### Database Schema (from Epic)

**Migration: 008-oracle-updates-table.js**
```sql
CREATE TABLE oracle_updates (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    previous_price REAL,
    deviation_from_previous_pct REAL,
    time_since_previous_ms INTEGER
);

CREATE INDEX idx_oracle_updates_symbol ON oracle_updates(symbol);
CREATE INDEX idx_oracle_updates_timestamp ON oracle_updates(timestamp);
```

### Pattern Reference: Divergence Tracker (Story 7-3)

This module MUST follow the EXACT same patterns as `src/modules/divergence-tracker/`:

1. **index.js** - thin wrapper that:
   - Creates child logger: `log = child({ module: 'oracle-tracker' })`
   - Uses persistence module for database access
   - Subscribes to RTDS client for oracle topic only
   - Exposes standard interface

2. **Error Handling** - use PolyError pattern:
```javascript
import { PolyError } from '../../types/errors.js';

class OracleTrackerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OracleTrackerError';
  }
}
```

3. **Error Codes:**
```javascript
export const OracleTrackerErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_TRACKER_NOT_INITIALIZED',
  INVALID_SYMBOL: 'ORACLE_TRACKER_INVALID_SYMBOL',
  PERSISTENCE_ERROR: 'ORACLE_TRACKER_PERSISTENCE_ERROR',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  oracleTracker: {
    bufferSize: 10,               // Flush after N update records
    flushIntervalMs: 1000,        // Flush every N ms
    minDeviationForUpdate: 0.0001, // Minimum deviation to count as "update" (0.01%)
  }
}
```

### Update Detection Logic

**Key Insight:** Oracle updates are detected when the PRICE CHANGES, not every tick. We need to track the previous price and only create an update record when the price differs.

**Core Algorithm:**
```javascript
class OraclePatternTracker {
  constructor(config) {
    this.previousPrices = {
      btc: { price: null, timestamp: null },
      eth: { price: null, timestamp: null },
      sol: { price: null, timestamp: null },
      xrp: { price: null, timestamp: null },
    };
    this.minDeviationForUpdate = config.minDeviationForUpdate || 0.0001;
  }

  handleOracleTick(tick) {
    // tick format: { timestamp, topic, symbol, price }
    // topic MUST be 'crypto_prices_chainlink'

    const prev = this.previousPrices[tick.symbol];

    // First tick for this symbol - store but don't create update record
    if (prev.price === null) {
      this.previousPrices[tick.symbol] = {
        price: tick.price,
        timestamp: tick.timestamp,
      };
      return null;
    }

    // Calculate deviation
    const deviationPct = (tick.price - prev.price) / prev.price;

    // Only create update record if deviation exceeds minimum threshold
    if (Math.abs(deviationPct) < this.minDeviationForUpdate) {
      return null; // No meaningful update
    }

    // Calculate time since previous update
    const timeSincePreviousMs = tick.timestamp - prev.timestamp;

    // Create update record
    const updateRecord = {
      timestamp: new Date(tick.timestamp).toISOString(),
      symbol: tick.symbol,
      price: tick.price,
      previous_price: prev.price,
      deviation_from_previous_pct: deviationPct,
      time_since_previous_ms: timeSincePreviousMs,
    };

    // Update previous price
    this.previousPrices[tick.symbol] = {
      price: tick.price,
      timestamp: tick.timestamp,
    };

    return updateRecord;
  }
}
```

### Statistics Calculation

**avg_update_frequency:**
```javascript
function getAverageUpdateFrequency(symbol) {
  // Query: SELECT AVG(time_since_previous_ms) FROM oracle_updates WHERE symbol = ?
  const result = persistence.get(
    'SELECT AVG(time_since_previous_ms) as avg_ms FROM oracle_updates WHERE symbol = ?',
    [symbol]
  );
  return {
    avg_ms: result.avg_ms,
    avg_seconds: result.avg_ms / 1000,
    updates_per_minute: 60000 / result.avg_ms,
  };
}
```

**deviation_threshold_observed:**
```javascript
function getDeviationThreshold(symbol) {
  // Query: Get median/mean deviation that triggers updates
  const result = persistence.all(
    'SELECT deviation_from_previous_pct FROM oracle_updates WHERE symbol = ? ORDER BY ABS(deviation_from_previous_pct)',
    [symbol]
  );

  // Calculate median
  const deviations = result.map(r => Math.abs(r.deviation_from_previous_pct));
  deviations.sort((a, b) => a - b);
  const median = deviations[Math.floor(deviations.length / 2)];
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;

  return {
    median_pct: median,
    mean_pct: mean,
    min_pct: Math.min(...deviations),
    max_pct: Math.max(...deviations),
    sample_size: deviations.length,
  };
}
```

**update_frequency_by_volatility:**
```javascript
function getUpdatesByVolatility(symbol) {
  // Group updates by deviation buckets
  const buckets = {
    small: { min: 0, max: 0.001, count: 0, avg_interval_ms: 0 },    // 0-0.1%
    medium: { min: 0.001, max: 0.005, count: 0, avg_interval_ms: 0 }, // 0.1-0.5%
    large: { min: 0.005, max: 0.01, count: 0, avg_interval_ms: 0 },   // 0.5-1%
    extreme: { min: 0.01, max: Infinity, count: 0, avg_interval_ms: 0 }, // >1%
  };

  // Query and bucket
  const updates = persistence.all(
    'SELECT deviation_from_previous_pct, time_since_previous_ms FROM oracle_updates WHERE symbol = ?',
    [symbol]
  );

  // ... bucket logic ...

  return buckets;
}
```

### Integration with RTDS Client

**CRITICAL:** Only subscribe to oracle topic, NOT the UI topic:

```javascript
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS, SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';

async function init(config) {
  // ... setup ...

  // Subscribe to all symbols, but filter for oracle topic only
  for (const symbol of SUPPORTED_SYMBOLS) {
    rtdsClient.subscribe(symbol, (tick) => {
      // ONLY process oracle (Chainlink) ticks
      if (tick.topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
        handleOracleTick(tick);
      }
    });
  }
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    tracking: {
      btc: {
        last_price: 95234.50,
        last_update_at: '2026-02-01T12:00:00.000Z',
        updates_recorded: 150,
      },
      eth: { ... },
      sol: { ... },
      xrp: { ... },
    },
    stats: {
      btc: {
        avg_update_frequency_ms: 12500,
        avg_update_frequency_seconds: 12.5,
        updates_per_minute: 4.8,
        deviation_threshold: {
          median_pct: 0.002,
          mean_pct: 0.0025,
        },
      },
      eth: { ... },
      sol: { ... },
      xrp: { ... },
    },
    buffer: {
      pending_records: 3,
      oldest_record_age_ms: 450,
    },
    config: {
      bufferSize: 10,
      flushIntervalMs: 1000,
      minDeviationForUpdate: 0.0001,
    },
  };
}
```

### Logging Requirements

All logs MUST use structured format with required fields:

```javascript
log.info('oracle_tracker_initialized', { config: { bufferSize, flushIntervalMs } });
log.info('oracle_update_detected', { symbol, price: 95234.50, deviation_pct: 0.0023, time_since_previous_ms: 15234 });
log.info('buffer_flushed', { record_count: 10, duration_ms: 12 });
log.warn('large_oracle_gap', { symbol, time_since_previous_ms: 120000 }); // 2+ minutes between updates
log.error('persistence_failed', { error: err.message, record_count: 10 });
```

### Testing Strategy

1. **Unit Tests (tracker.test.js):**
   - First tick stores price but doesn't create update record
   - Second tick with different price creates update record
   - Second tick with same price does NOT create update record
   - Deviation calculation (positive and negative moves)
   - Time since previous calculation
   - Minimum deviation threshold filtering
   - Multiple symbols tracked independently

2. **Unit Tests (stats.test.js):**
   - Average update frequency calculation
   - Deviation threshold calculation (median, mean)
   - Update frequency by volatility buckets
   - Empty data handling (no updates yet)
   - Single update handling

3. **Unit Tests (index.test.js):**
   - Init subscribes to RTDS oracle topic only (NOT UI topic)
   - getStats returns correct structure
   - getRecentUpdates returns correct records
   - getState returns correct shape
   - shutdown flushes buffer and cleans up

4. **Integration Tests:**
   - Mock RTDS client with simulated oracle ticks
   - Verify update records persisted to database
   - Query statistics from real database

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/persistence/` - for database access
- `src/clients/rtds/` - for tick subscription (Story 7-1)

**No new npm packages required.**

### Previous Story Intelligence (7-1, 7-2, 7-3)

**Key Learnings from Story 7-1 (RTDS Client):**
1. Tick format is already normalized: `{ timestamp, topic, symbol, price }`
2. Use constants: `TOPICS.CRYPTO_PRICES_CHAINLINK` for oracle topic
3. Symbols are already normalized: btc, eth, sol, xrp
4. Subscribe pattern returns unsubscribe function
5. URL validation and message size limits already implemented

**Key Learnings from Story 7-2 (Tick Logger):**
1. Use batching for database inserts - buffer and flush pattern works well
2. Use `child({ module: 'oracle-tracker' })` for logger
3. Handle buffer overflow gracefully
4. Use persistence.transaction for atomic batch inserts

**Key Learnings from Story 7-3 (Divergence Tracker):**
1. Subscribe to RTDS for all symbols, filter by topic in callback
2. Track state per symbol with a Map/object structure
3. Use Set-based callbacks for subscriptions
4. Handle edge cases (null prices, first tick scenario)
5. Include `unref()` on intervals to allow process exit

**Code Review Findings to Apply:**
- Validate all inputs before processing
- Use rate limiting for warning logs (e.g., large oracle gap warnings)
- Handle edge cases explicitly (first tick, same price)
- Add defensive null checks
- Test with empty data scenarios

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- RTDS client provides normalized ticks - filter for oracle topic only
- This module is an ANALYSIS module - receives oracle ticks, detects updates, persists patterns
- Story 7-5 (Oracle Update Predictor) will consume statistics from this module
- Story 7-6 (Oracle Staleness Detector) will use update timing from this module

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides tick data
- Story 7-2 (Tick Logger) - provides migration pattern reference

**Used by:**
- Story 7-5 (Oracle Update Predictor) - uses update statistics for prediction
- Story 7-6 (Oracle Staleness Detector) - uses last update timing for staleness detection

### Key Questions This Module Answers

1. **"On average, how often does Chainlink update BTC?"**
   - Answer: `getAverageUpdateFrequency('btc')` returns avg_ms, avg_seconds, updates_per_minute

2. **"What price move triggers a Chainlink update for ETH?"**
   - Answer: `getDeviationThreshold('eth')` returns median_pct, mean_pct showing typical deviation that triggers updates

3. **"Are there patterns based on volatility?"**
   - Answer: `getStats('sol')` includes update_frequency_by_volatility buckets

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-4]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Schema]
- [Source: _bmad-output/implementation-artifacts/7-1-rtds-websocket-client.md - RTDS client patterns]
- [Source: _bmad-output/implementation-artifacts/7-2-feed-tick-logger.md - Batching and migration patterns]
- [Source: _bmad-output/implementation-artifacts/7-3-feed-divergence-tracker.md - Divergence tracker patterns]
- [Source: src/clients/rtds/types.js - TOPICS, SUPPORTED_SYMBOLS constants]
- [Source: src/modules/divergence-tracker/index.js - Module pattern reference]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered during implementation.

### Completion Notes List

1. **Database Migration (Task 1)**: Created `008-oracle-updates-table.js` with the oracle_updates table schema matching the epic specification. Includes indexes on symbol and timestamp for efficient querying.

2. **Module Structure (Task 2)**: Implemented standard module pattern following divergence-tracker:
   - `index.js`: Public interface with init, getStats, getAverageUpdateFrequency, getDeviationThreshold, getRecentUpdates, getState, shutdown
   - `tracker.js`: OraclePatternTracker class with update detection logic
   - `types.js`: OracleTrackerError, error codes, default config, volatility buckets

3. **Update Detection (Task 3)**: Implemented in `tracker.js` - detects price changes by comparing current tick to previous, only creates update record when deviation exceeds configurable threshold (default 0.01%). Filters for oracle topic only (`TOPICS.CRYPTO_PRICES_CHAINLINK`).

4. **Database Persistence (Task 4)**: Batch insert pattern with configurable buffer size (default 10) and flush interval (default 1000ms). Uses persistence.transaction for atomic inserts. Graceful error handling with logging.

5. **Pattern Statistics (Task 5)**: `getStats(symbol)` returns comprehensive statistics:
   - avg_update_frequency (ms, seconds, updates_per_minute)
   - deviation_threshold (median, mean, min, max, sample_size)
   - update_frequency_by_volatility (small/medium/large/extreme buckets with counts and avg intervals)

6. **Query Interface (Task 6)**: Three query functions implemented:
   - `getAverageUpdateFrequency(symbol)` - answers "how often does Chainlink update?"
   - `getDeviationThreshold(symbol)` - answers "what price move triggers an update?"
   - `getRecentUpdates(symbol, limit)` - returns last N update records

7. **Module Interface (Task 7)**: Standard module contract:
   - `init(config)` - subscribes to RTDS, sets up tracking and flush intervals
   - `getStats(symbol)` - comprehensive pattern statistics
   - `getRecentUpdates(symbol, limit)` - recent update records
   - `getState()` - full module state including tracking, stats, buffer, config
   - `shutdown()` - flushes buffer, cleans up subscriptions and intervals

8. **Tests (Task 8)**: 73 comprehensive tests across 3 test files:
   - `tracker.test.js` (33 tests): Update detection, deviation calculation, multi-symbol tracking, edge cases
   - `index.test.js` (28 tests): Module interface, getStats, getRecentUpdates, init/shutdown
   - `stats.test.js` (12 tests): Volatility buckets, deviation threshold calculations, edge cases

### File List

**New Files:**
- `src/persistence/migrations/008-oracle-updates-table.js` - Database migration
- `src/modules/oracle-tracker/index.js` - Module public interface
- `src/modules/oracle-tracker/tracker.js` - OraclePatternTracker class
- `src/modules/oracle-tracker/types.js` - Error classes, constants, config
- `src/modules/oracle-tracker/__tests__/tracker.test.js` - Tracker unit tests
- `src/modules/oracle-tracker/__tests__/index.test.js` - Module integration tests
- `src/modules/oracle-tracker/__tests__/stats.test.js` - Statistics calculation tests

**Modified Files:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` - Status updated to in-progress → review
- `_bmad-output/implementation-artifacts/7-4-oracle-update-pattern-tracker.md` - Task checkboxes, dev record

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-01 | Initial implementation of oracle pattern tracker module | Claude Opus 4.5 |

