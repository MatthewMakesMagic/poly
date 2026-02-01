# Story 7.2: Feed Tick Logger

Status: review

---

## Story

As a **data analyst**,
I want **every tick from both RTDS feeds logged to the database**,
So that **I can analyze price relationships and validate strategies offline**.

---

## Acceptance Criteria

### AC1: Tick Insertion
**Given** ticks arrive from RTDS client
**When** a tick is received
**Then** it is inserted into `rtds_ticks` table with: timestamp, topic, symbol, price, raw_payload

### AC2: Batch Insert Performance
**Given** high tick volume
**When** logging ticks
**Then** batch inserts are used for efficiency (buffer and flush every 100ms or 50 ticks)
**And** no ticks are dropped under normal operation

### AC3: Retention Policy
**Given** database storage concerns
**When** ticks accumulate
**Then** configurable retention policy exists (default: 7 days)
**And** old ticks can be archived or purged

---

## Tasks / Subtasks

- [x] **Task 1: Create database migration** (AC: 1)
  - [x] Create migration `007-rtds-ticks-table.js`
  - [x] Create `rtds_ticks` table with schema from epic
  - [x] Create indexes on timestamp and symbol_topic
  - [x] Test migration applies cleanly

- [x] **Task 2: Create module structure** (AC: 1, 2)
  - [x] Create `src/modules/tick-logger/` folder
  - [x] Create `index.js` (public interface: init, logTick, flush, getState, shutdown)
  - [x] Create `buffer.js` (batch buffer logic)
  - [x] Create `types.js` (error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 3: Implement tick buffer** (AC: 2)
  - [x] Create TickBuffer class with configurable thresholds
  - [x] Buffer incoming ticks in memory
  - [x] Trigger flush on: 50 ticks accumulated OR 100ms elapsed
  - [x] Track buffer statistics (count, oldest tick age)
  - [x] Handle flush errors without losing ticks

- [x] **Task 4: Implement batch insert** (AC: 1, 2)
  - [x] Use persistence.transaction for atomic inserts
  - [x] Use prepared statement for performance
  - [x] Insert all buffered ticks in single transaction
  - [x] Log insert count and duration

- [x] **Task 5: Wire up RTDS subscription** (AC: 1)
  - [x] Subscribe to RTDS client on init
  - [x] Receive ticks for all symbols (btc, eth, sol, xrp)
  - [x] Pass ticks to buffer for logging
  - [x] Handle subscription errors gracefully

- [x] **Task 6: Implement module interface** (AC: 1)
  - [x] Export `init(config)` - connect to RTDS, start logging
  - [x] Export `logTick(tick)` - manual tick insertion (for testing)
  - [x] Export `flush()` - force buffer flush
  - [x] Export `getState()` - return buffer state, stats
  - [x] Export `shutdown()` - flush remaining, close gracefully

- [x] **Task 7: Implement retention cleanup** (AC: 3)
  - [x] Create `cleanup()` function to delete old ticks
  - [x] Configurable retention period (default: 7 days)
  - [x] Run cleanup on init and optionally on schedule
  - [x] Log cleanup results (rows deleted)

- [x] **Task 8: Write tests** (AC: 1, 2, 3)
  - [x] Unit tests for buffer logic (flush thresholds)
  - [x] Unit tests for batch insert
  - [x] Integration test with mock RTDS client
  - [x] Test retention cleanup
  - [x] Test no tick loss under load

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/tick-logger/`

**File Structure (per architecture.md):**
```
src/modules/tick-logger/
├── index.js          # Public interface (init, logTick, flush, getState, shutdown)
├── buffer.js         # TickBuffer class with batching logic
├── types.js          # TickLoggerError, error codes, constants
└── __tests__/
    ├── index.test.js
    ├── buffer.test.js
    └── cleanup.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function logTick(tick) {}  // For manual/test usage
export async function flush() {}  // Force buffer flush
export function getState() {}
export async function shutdown() {}
export { TickLoggerError, TickLoggerErrorCodes };
```

### Database Schema (from Epic)

**Migration: 007-rtds-ticks-table.js**
```sql
CREATE TABLE rtds_ticks (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    topic TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    raw_payload TEXT
);

CREATE INDEX idx_rtds_ticks_timestamp ON rtds_ticks(timestamp);
CREATE INDEX idx_rtds_ticks_symbol_topic ON rtds_ticks(symbol, topic);
```

### Pattern Reference: RTDS Client (Story 7-1)

This module DEPENDS on the RTDS client from story 7-1. Follow the exact same patterns:

1. **index.js** - thin wrapper that:
   - Creates child logger: `log = child({ module: 'tick-logger' })`
   - Uses persistence module for database access
   - Subscribes to RTDS client for ticks
   - Exposes standard interface

2. **Error Handling** - use PolyError pattern:
```javascript
class TickLoggerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'TickLoggerError';
  }
}
```

3. **Error Codes:**
```javascript
export const TickLoggerErrorCodes = {
  NOT_INITIALIZED: 'TICK_LOGGER_NOT_INITIALIZED',
  BUFFER_OVERFLOW: 'TICK_LOGGER_BUFFER_OVERFLOW',
  INSERT_FAILED: 'TICK_LOGGER_INSERT_FAILED',
  CLEANUP_FAILED: 'TICK_LOGGER_CLEANUP_FAILED',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  tickLogger: {
    batchSize: 50,                // Flush after N ticks
    flushIntervalMs: 100,         // Flush every N ms
    retentionDays: 7,             // Keep ticks for N days
    cleanupOnInit: true,          // Run cleanup on init
    cleanupIntervalHours: 6,      // Run cleanup every N hours (0 to disable)
    maxBufferSize: 1000,          // Max buffer before forced flush
  }
}
```

### Batching Strategy

**Why Batching:**
- RTDS can produce 10-50 ticks/second during volatile markets
- Individual INSERTs would create I/O overhead
- SQLite performs best with batch transactions

**Buffer Logic:**
```javascript
class TickBuffer {
  constructor({ batchSize = 50, flushIntervalMs = 100, maxBufferSize = 1000 }) {
    this.buffer = [];
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.flushTimer = null;
    this.onFlush = null;  // Callback for batch insert
  }

  add(tick) {
    this.buffer.push(tick);

    // Start timer on first tick
    if (this.buffer.length === 1) {
      this.startFlushTimer();
    }

    // Flush if batch size reached
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }

    // Emergency: drop oldest if buffer overflows
    if (this.buffer.length >= this.maxBufferSize) {
      log.warn('buffer_overflow', { dropped: 1, buffer_size: this.buffer.length });
      this.buffer.shift();
    }
  }

  flush() {
    clearTimeout(this.flushTimer);
    const ticks = this.buffer.splice(0, this.buffer.length);
    if (ticks.length > 0 && this.onFlush) {
      this.onFlush(ticks);
    }
  }
}
```

### Batch Insert SQL

```javascript
function batchInsert(ticks) {
  const insertSQL = `
    INSERT INTO rtds_ticks (timestamp, topic, symbol, price, raw_payload)
    VALUES (?, ?, ?, ?, ?)
  `;

  persistence.transaction(() => {
    for (const tick of ticks) {
      persistence.run(insertSQL, [
        tick.timestamp,
        tick.topic,
        tick.symbol,
        tick.price,
        tick.raw_payload || null
      ]);
    }
  });
}
```

### Retention Cleanup

```javascript
async function cleanupOldTicks(retentionDays = 7) {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffISO = cutoffDate.toISOString();

  const result = persistence.run(
    'DELETE FROM rtds_ticks WHERE timestamp < ?',
    [cutoffISO]
  );

  log.info('cleanup_complete', {
    deleted_rows: result.changes,
    cutoff_date: cutoffISO
  });

  return result.changes;
}
```

### Logging Requirements

All logs MUST use structured format with required fields:

```javascript
log.info('tick_logger_initialized', { config: { batchSize, flushIntervalMs, retentionDays } });
log.info('batch_inserted', { tick_count: 50, duration_ms: 12 });
log.info('cleanup_complete', { deleted_rows: 1234, cutoff_date: '...' });
log.warn('buffer_overflow', { dropped: 1, buffer_size: 1000 });
log.error('insert_failed', { error: err.message, tick_count: 50 });
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    buffer: {
      size: 23,
      oldest_tick_age_ms: 45,
    },
    stats: {
      ticks_received: 12345,
      ticks_inserted: 12300,
      batches_inserted: 246,
      ticks_dropped: 0,
      last_flush_at: '...',
      last_cleanup_at: '...',
    },
    config: {
      batchSize: 50,
      flushIntervalMs: 100,
      retentionDays: 7,
    },
  };
}
```

### Testing Strategy

1. **Unit Tests (buffer.test.js):**
   - Buffer accumulates ticks correctly
   - Flush triggers at batchSize threshold
   - Flush triggers at interval threshold
   - Buffer overflow handling (drops oldest)
   - Flush clears buffer

2. **Unit Tests (index.test.js):**
   - Init creates subscription to RTDS
   - logTick adds to buffer
   - flush() forces immediate insert
   - shutdown() flushes remaining ticks
   - getState() returns correct shape

3. **Integration Tests:**
   - Batch insert to real SQLite (in-memory or temp file)
   - Retention cleanup deletes correct rows
   - No tick loss under simulated load (100 ticks/second)

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/persistence/` - for database access
- `src/clients/rtds/` - for tick subscription (Story 7-1)

**No new npm packages required.**

### Integration with RTDS Client

The tick logger subscribes to the RTDS client on init:

```javascript
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';

async function init(config) {
  // ... setup ...

  // Subscribe to all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    rtdsClient.subscribe(symbol, (tick) => {
      buffer.add({
        timestamp: new Date(tick.timestamp).toISOString(),
        topic: tick.topic,
        symbol: tick.symbol,
        price: tick.price,
        raw_payload: JSON.stringify(tick),
      });
    });
  }
}
```

### Previous Story Intelligence (7-1-rtds-websocket-client)

**Key Learnings from Story 7-1:**

1. **Security Validations Added:** URL validation, message size limits - no direct impact on tick logger
2. **Edge Case Handling:** NaN timestamps fallback to current time - tick logger should trust RTDS normalization
3. **Symbol Normalization:** RTDS client already normalizes to btc/eth/sol/xrp - no mapping needed here
4. **Topic Names:** Use `TOPICS.CRYPTO_PRICES` and `TOPICS.CRYPTO_PRICES_CHAINLINK` constants
5. **Tick Format:** Already normalized to `{ timestamp, topic, symbol, price }` by RTDS client

**Code Review Findings to Avoid:**
- Always validate inputs before processing (tick structure)
- Use rate limiting for warning logs (don't spam on errors)
- Handle edge cases (null/undefined tick fields)

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- Uses persistence module (never direct database access)
- RTDS client provides normalized ticks - tick logger just stores them
- This module is a DATA SINK - receives from RTDS, writes to database

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Schema]
- [Source: _bmad-output/implementation-artifacts/7-1-rtds-websocket-client.md - Previous story]
- [Source: src/clients/rtds/index.js - RTDS client interface]
- [Source: src/clients/rtds/types.js - Tick format, symbols, topics]
- [Source: src/persistence/index.js - Database access patterns]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A

### Completion Notes List

- **Task 1:** Created `007-rtds-ticks-table.js` migration with rtds_ticks table schema and indexes. Migration tested and applies cleanly.
- **Task 2:** Created full module structure in `src/modules/tick-logger/` with index.js, buffer.js, types.js, and __tests__ folder.
- **Task 3:** Implemented TickBuffer class with configurable batch size (50), flush interval (100ms), and max buffer size (1000). Includes overflow handling that drops oldest ticks.
- **Task 4:** Implemented batch insert using persistence.transaction for atomic inserts. Logs tick_count and duration_ms for each batch.
- **Task 5:** Wired up RTDS subscription on init - subscribes to all 4 supported symbols (btc, eth, sol, xrp). Each tick callback formats and adds to buffer.
- **Task 6:** Implemented full module interface: init(config), logTick(tick), flush(), getState(), shutdown(). Re-exports TickLoggerError and TickLoggerErrorCodes.
- **Task 7:** Implemented cleanupOldTicks() with configurable retention (default 7 days). Runs on init (optional) and on scheduled interval (optional). Logs deleted_rows and cutoff_date.
- **Task 8:** Created comprehensive test suite with 50 tests across 3 test files: buffer.test.js (20 tests), index.test.js (19 tests), cleanup.test.js (11 tests). All tests pass.

### File List

**New Files:**
- `src/persistence/migrations/007-rtds-ticks-table.js` - Database migration for rtds_ticks table
- `src/modules/tick-logger/index.js` - Main module interface
- `src/modules/tick-logger/buffer.js` - TickBuffer class with batching logic
- `src/modules/tick-logger/types.js` - TickLoggerError class, error codes, default config
- `src/modules/tick-logger/__tests__/buffer.test.js` - Buffer unit tests (20 tests)
- `src/modules/tick-logger/__tests__/index.test.js` - Module integration tests (19 tests)
- `src/modules/tick-logger/__tests__/cleanup.test.js` - Cleanup/retention tests (11 tests)

---

## Change Log

- **2026-02-01:** Story implementation complete. Created tick-logger module with batching, RTDS subscription, and retention cleanup. 50 tests added. All 1796 tests pass.

