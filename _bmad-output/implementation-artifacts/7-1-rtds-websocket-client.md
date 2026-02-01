# Story 7.1: RTDS WebSocket Client

Status: done

---

## Story

As a **developer**,
I want **a WebSocket client connected to Polymarket's Real Time Data Socket**,
So that **I can receive both UI prices (Binance) and Oracle prices (Chainlink) in real-time**.

---

## Acceptance Criteria

### AC1: WebSocket Connection
**Given** the RTDS client module exists
**When** initialized with config
**Then** it connects to `wss://ws-live-data.polymarket.com`
**And** subscribes to topic `crypto_prices` (Binance/UI feed)
**And** subscribes to topic `crypto_prices_chainlink` (Oracle feed)
**And** exports standard module interface: init(), getState(), shutdown()

### AC2: Price Update Handling
**Given** the connection is established
**When** price updates arrive
**Then** ticks are parsed and normalized to format: `{ timestamp, topic, symbol, price }`
**And** subscribers are notified via callback or event emitter

### AC3: Reconnection & Error Handling
**Given** the connection drops
**When** disconnect is detected
**Then** automatic reconnection is attempted with exponential backoff
**And** reconnection events are logged
**And** stale price warning is emitted if reconnection takes > 5 seconds

### AC4: Symbol Subscription
**Given** symbols to track
**When** subscribing to feeds
**Then** BTC, ETH, SOL, XRP are subscribed on both topics
**And** symbol mapping handles format differences (btcusdt vs btc/usd)

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1)
  - [x] Create `src/clients/rtds/` folder
  - [x] Create `index.js` (public interface)
  - [x] Create `client.js` (WebSocket implementation)
  - [x] Create `types.js` (error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Implement WebSocket connection** (AC: 1, 3)
  - [x] Use native WebSocket or `ws` package
  - [x] Connect to `wss://ws-live-data.polymarket.com`
  - [x] Implement connection state tracking
  - [x] Implement exponential backoff reconnection (1s, 2s, 4s, 8s, max 30s)
  - [x] Log all connection state changes

- [x] **Task 3: Implement topic subscription** (AC: 1, 4)
  - [x] Subscribe to `crypto_prices` topic on connect
  - [x] Subscribe to `crypto_prices_chainlink` topic on connect
  - [x] Handle subscription confirmation
  - [x] Map symbols: btcusdt/btc/usd, ethusdt/eth/usd, solusd/sol/usd, xrpusdt/xrp/usd

- [x] **Task 4: Implement message parsing** (AC: 2)
  - [x] Parse incoming WebSocket messages
  - [x] Normalize to standard format: `{ timestamp, topic, symbol, price }`
  - [x] Handle malformed messages gracefully (log and skip)

- [x] **Task 5: Implement subscription pattern** (AC: 2)
  - [x] Create EventEmitter or callback registry
  - [x] Allow subscribing to specific symbols
  - [x] Notify subscribers on each tick
  - [x] Return unsubscribe function

- [x] **Task 6: Implement module interface** (AC: 1)
  - [x] Export `init(config)` - connect and start
  - [x] Export `getCurrentPrice(symbol, topic)` - get latest price
  - [x] Export `subscribe(symbol, callback)` - subscribe to updates
  - [x] Export `getState()` - return connection state, prices, stats
  - [x] Export `shutdown()` - close connection gracefully

- [x] **Task 7: Write tests** (AC: 1, 2, 3, 4)
  - [x] Unit tests for message parsing
  - [x] Unit tests for symbol mapping
  - [x] Integration test for connection (can be mocked)
  - [x] Test reconnection logic

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/clients/rtds/`

**File Structure (per architecture.md):**
```
src/clients/rtds/
├── index.js          # Public interface (init, getState, shutdown, etc.)
├── client.js         # RTDSClient class with WebSocket logic
├── types.js          # RTDSError, error codes, constants
└── __tests__/
    ├── index.test.js
    └── client.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function getCurrentPrice(symbol, topic) {}
export function subscribe(symbol, callback) {}
export function getState() {}
export async function shutdown() {}
export { RTDSError, RTDSErrorCodes, SUPPORTED_SYMBOLS, TOPICS };
```

### Pattern Reference: Existing Spot Client

The RTDS client should follow the EXACT same pattern as `src/clients/spot/`:

1. **index.js** - thin wrapper that:
   - Creates child logger: `log = child({ module: 'rtds-client' })`
   - Instantiates internal client class
   - Exposes standard interface
   - Re-exports types

2. **client.js** - RTDSClient class that:
   - Takes `{ logger }` in constructor
   - Has `initialize(config)` method
   - Manages internal state
   - Handles reconnection logic

3. **types.js** - exports:
   - Error class extending Error
   - Error codes object
   - Constants (topics, symbols)

### WebSocket Protocol Details

**Endpoint:** `wss://ws-live-data.polymarket.com`

**Topics:**
- `crypto_prices` - Binance-sourced prices (what UI shows)
- `crypto_prices_chainlink` - Chainlink oracle prices (settlement source)

**Subscription Message Format (verify via browser DevTools):**
```javascript
// Example - actual format needs verification
{
  type: 'subscribe',
  topic: 'crypto_prices',
  symbols: ['btcusdt', 'ethusdt', 'solusd', 'xrpusdt']
}
```

**Symbol Mapping:**
| Asset | Binance Topic | Chainlink Topic |
|-------|---------------|-----------------|
| BTC | btcusdt | btc/usd |
| ETH | ethusdt | eth/usd |
| SOL | solusd | sol/usd |
| XRP | xrpusdt | xrp/usd |

### Configuration Schema

```javascript
// config/default.js additions
{
  rtds: {
    url: 'wss://ws-live-data.polymarket.com',
    reconnectIntervalMs: 1000,      // Initial reconnect delay
    maxReconnectIntervalMs: 30000,  // Max reconnect delay
    staleThresholdMs: 5000,         // Warn if no data for 5s
    symbols: ['btc', 'eth', 'sol', 'xrp'],
  }
}
```

### Error Handling

**Error Codes:**
```javascript
export const RTDSErrorCodes = {
  NOT_INITIALIZED: 'RTDS_NOT_INITIALIZED',
  CONNECTION_FAILED: 'RTDS_CONNECTION_FAILED',
  SUBSCRIPTION_FAILED: 'RTDS_SUBSCRIPTION_FAILED',
  PARSE_ERROR: 'RTDS_PARSE_ERROR',
  STALE_DATA: 'RTDS_STALE_DATA',
};
```

**Error Pattern (per architecture.md):**
```javascript
class RTDSError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'RTDSError';
    this.code = code;
    this.context = context;
  }
}
```

### Logging Requirements

All logs MUST use structured format with required fields:

```javascript
log.info('rtds_connected', { url: config.url });
log.info('rtds_subscribed', { topic: 'crypto_prices', symbols: [...] });
log.info('rtds_tick', { topic, symbol, price, timestamp });
log.warn('rtds_reconnecting', { attempt: 3, delay_ms: 4000 });
log.error('rtds_connection_failed', { error: err.message, context: {...} });
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    connected: true,
    subscribedTopics: ['crypto_prices', 'crypto_prices_chainlink'],
    prices: {
      btc: {
        crypto_prices: { price: 95234.50, timestamp: '...', staleness_ms: 123 },
        crypto_prices_chainlink: { price: 95230.00, timestamp: '...', staleness_ms: 456 },
      },
      eth: { ... },
      sol: { ... },
      xrp: { ... },
    },
    stats: {
      ticks_received: 1234,
      errors: 0,
      reconnects: 1,
      last_tick_at: '...',
    },
  };
}
```

### Testing Strategy

1. **Unit Tests:**
   - Message parsing (various formats)
   - Symbol mapping
   - Error construction

2. **Integration Tests (mocked WebSocket):**
   - Connection flow
   - Subscription flow
   - Reconnection on disconnect
   - Stale data detection

3. **Manual Verification:**
   - Open browser DevTools on Polymarket
   - Filter Network → WS
   - Observe actual message formats
   - Document in code comments

### Dependencies

**Required packages:**
- `ws` - WebSocket client for Node.js (check if already in package.json)

**Internal dependencies:**
- `src/modules/logger/` - for child logger creation

### Project Structure Notes

- Follows `src/clients/{name}/` pattern established by `spot/` and `polymarket/`
- Tests co-located in `__tests__/` folder per architecture
- No direct imports from other modules - orchestrator will coordinate
- This is a PRICE SOURCE client, will be used by story 7-2 (tick logger) and beyond

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-1]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: src/clients/spot/index.js - Pattern reference]
- [Source: src/clients/spot/client.js - Implementation reference]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass: 61 RTDS-specific tests, 1732 total tests (no regressions)
- Test run: 2026-02-01

### Completion Notes List

1. **Module Structure Created** - Following exact pattern from `src/clients/spot/`:
   - `index.js` - Thin public interface with child logger creation
   - `client.js` - RTDSClient class with full WebSocket lifecycle management
   - `types.js` - RTDSError (extends PolyError), error codes, constants, symbol mappings

2. **WebSocket Connection** - Implemented with:
   - Connection to `wss://ws-live-data.polymarket.com`
   - Connection states: disconnected, connecting, connected, reconnecting
   - Exponential backoff reconnection (1s base, 30s max)
   - Connection timeout handling (10s default)

3. **Topic Subscription** - Auto-subscribes on connect to:
   - `crypto_prices` (Binance/UI prices)
   - `crypto_prices_chainlink` (Oracle prices for settlement)

4. **Symbol Mapping** - Bidirectional mapping implemented:
   - Binance: btcusdt, ethusdt, solusd, xrpusdt
   - Chainlink: btc/usd, eth/usd, sol/usd, xrp/usd
   - Normalized: btc, eth, sol, xrp

5. **Message Parsing** - Normalizes to standard format:
   - `{ timestamp, topic, symbol, price }`
   - Handles alternative field names (s/symbol, p/price, t/timestamp)
   - Graceful handling of malformed messages

6. **Subscription Pattern** - Implemented with:
   - Map-based callback registry per symbol
   - Returns unsubscribe function
   - Error isolation in callbacks

7. **Stale Data Detection** - Background monitoring:
   - Checks every second for stale prices
   - Emits warnings when threshold exceeded (5s default)

8. **Tests** - 61 comprehensive tests:
   - types.test.js: 12 tests for error class, codes, constants, mappings
   - client.test.js: 35 tests for WebSocket client functionality
   - index.test.js: 14 tests for public module interface

### File List

**New Files Created:**
- `src/clients/rtds/index.js` - Public module interface
- `src/clients/rtds/client.js` - RTDSClient WebSocket implementation
- `src/clients/rtds/types.js` - Error class, codes, constants, mappings
- `src/clients/rtds/__tests__/types.test.js` - Unit tests for types
- `src/clients/rtds/__tests__/client.test.js` - Unit tests for client
- `src/clients/rtds/__tests__/index.test.js` - Integration tests for module

**No existing files modified.**

### Change Log

- 2026-02-01: Initial implementation of RTDS WebSocket client module (Story 7.1)
- 2026-02-01: Code review completed - 15 findings, all fixed (see Code Review Record below)

---

## Code Review Record

### Reviewer
Claude Opus 4.5 (Secondary Adversarial Review)

### Review Date
2026-02-01

### Findings Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| 🔴 Critical | 3 | 3 |
| 🟠 High | 4 | 4 |
| 🟡 Medium | 5 | 5 |
| 🟢 Low | 3 | 3 |
| **Total** | **15** | **15** |

### Critical Findings (Fixed)

1. **SECURITY: No URL Validation on WebSocket Connection** (`client.js:114`)
   - WebSocket URL used without validation, allowing redirect to malicious servers
   - **Fix:** Added `validateUrl()` method with allowed hosts list and protocol validation

2. **SECURITY: Unbounded Message Size** (`client.js:228-249`)
   - No limit on incoming WebSocket message size, risking memory exhaustion
   - **Fix:** Added size check with configurable `maxMessageSizeBytes` (default 1MB)

3. **EDGE CASE: Potential Null Reference in handlePriceUpdate** (`client.js:266`)
   - Missing null check on `this.prices[tick.symbol]` could throw on unsupported symbols
   - **Fix:** Added defensive null check with warning log

### High Severity Findings (Fixed)

4. **ERROR HANDLING: Missing Topic Validation** (`client.js:256-284`)
   - `message.topic` could be undefined, causing ticks with undefined topics
   - **Fix:** Added topic validation before processing price updates

5. **PERFORMANCE: Stale Monitoring Log Spam** (`client.js:509-530`)
   - Stale warnings logged every second per symbol/topic during reconnection
   - **Fix:** Added rate limiting with `staleWarningIntervalMs` (default 30s)

6. **EDGE CASE: Date.parse Returns NaN** (`client.js:317`)
   - Malformed timestamp strings would result in NaN timestamps
   - **Fix:** Added NaN check with fallback to current time

7. **TEST COVERAGE: Missing Security Tests**
   - No tests for URL validation, message size limits
   - **Fix:** Added 14 new tests covering security and edge cases

### Medium Severity Findings (Fixed)

8-12. Various edge case handling and test coverage improvements

### Test Results After Fixes

- RTDS module tests: 75 passed (was 61)
- Full test suite: 1746 passed (no regressions)

### Files Modified

- `src/clients/rtds/client.js` - Added security validations and edge case handling
- `src/clients/rtds/types.js` - Added new config defaults for security limits
- `src/clients/rtds/__tests__/client.test.js` - Added 14 new tests
