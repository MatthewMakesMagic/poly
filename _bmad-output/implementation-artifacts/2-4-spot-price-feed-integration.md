# Story 2.4: Spot Price Feed Integration

Status: review

## Story

As a **trader**,
I want **real-time spot price data with reliable error handling**,
So that **strategy decisions are based on current market state (NFR5, NFR17)**.

## Acceptance Criteria

### AC1: Module Interface Compliance

**Given** the spot price client is integrated into `src/clients/spot/`
**When** inspecting its interface
**Then** it exports: init(config), getCurrentPrice(crypto), subscribe(crypto, callback), getState(), shutdown()
**And** follows the standard module interface pattern from architecture.md
**And** has a child logger via `child({ module: 'spot-client' })`

### AC2: Borrowed Code Integration

**Given** the spot price client is borrowed from existing code (`src/collectors/chainlink_prices.js`, `src/collectors/multi_source_prices.js`)
**When** integrating into `src/clients/spot/`
**Then** the client is wrapped with our module interface (init, getState, shutdown)
**And** price normalization logic is included
**And** authentication uses credentials from config (never hardcoded)

### AC3: Real-Time Price Processing

**Given** the spot feed is connected
**When** price updates are received
**Then** processing keeps pace with real-time feed (no lag accumulation - NFR5)
**And** prices are normalized to consistent format: `{ price: number, timestamp: Date, source: string, staleness: number }`
**And** getCurrentPrice(crypto) returns the latest price for BTC, ETH, SOL, XRP

### AC4: Disconnect Alert (NFR17)

**Given** the spot feed disconnects
**When** connection is lost
**Then** an alert is triggered immediately via logger.warn('spot_feed_disconnected')
**And** automatic reconnection is attempted with exponential backoff
**And** the system does NOT silently continue with stale prices
**And** isConnected state is updated to false

### AC5: Reconnection Handling

**Given** reconnection succeeds
**When** the feed is restored
**Then** an info log confirms reconnection: logger.info('spot_feed_reconnected')
**And** price processing resumes normally
**And** isConnected state is updated to true
**And** consecutiveErrors counter is reset

### AC6: Staleness Detection

**Given** prices are being tracked
**When** a price update hasn't been received for >10 seconds
**Then** the price is marked as stale (staleness > 10)
**And** logger.warn('spot_price_stale') is emitted with crypto and staleness
**And** getState() reflects the stale status

### AC7: Error Threshold Handling

**Given** the spot feed experiences consecutive errors
**When** consecutiveErrors >= MAX_CONSECUTIVE_ERRORS (10)
**Then** the source is marked as disabled
**And** logger.error('spot_source_disabled') is emitted
**And** the system falls back to remaining sources (if multi-source)

### AC8: Subscribe Callback Pattern

**Given** a subscriber wants real-time price updates
**When** subscribe(crypto, callback) is called
**Then** the callback is invoked on each price update for that crypto
**And** unsubscribe is returned for cleanup
**And** multiple subscribers can be active simultaneously

## Tasks / Subtasks

- [x] **Task 1: Create Module Structure** (AC: 1, 2)
  - [x] 1.1 Create `src/clients/spot/index.js` with standard module interface
  - [x] 1.2 Create `src/clients/spot/types.js` with error codes and price types
  - [x] 1.3 Create `src/clients/spot/client.js` for core implementation
  - [x] 1.4 Create `src/clients/spot/normalizer.js` for price normalization
  - [x] 1.5 Create `src/clients/spot/__tests__/` directory

- [x] **Task 2: Implement Types and Errors** (AC: 1)
  - [x] 2.1 Define SpotClientError extending base Error
  - [x] 2.2 Define SpotClientErrorCodes (NOT_INITIALIZED, FETCH_FAILED, SOURCE_DISABLED, SUBSCRIPTION_ERROR)
  - [x] 2.3 Define NormalizedPrice type: { price, timestamp, source, staleness, raw }
  - [x] 2.4 Define supported cryptos: ['btc', 'eth', 'sol', 'xrp']

- [x] **Task 3: Implement Core Client** (AC: 2, 3, 4, 5, 7)
  - [x] 3.1 Adapt ChainlinkPriceCollector patterns for new module
  - [x] 3.2 Implement init(config) with config validation
  - [x] 3.3 Implement connection lifecycle (connect, disconnect, reconnect)
  - [x] 3.4 Implement exponential backoff for reconnection (5s base, max 60s)
  - [x] 3.5 Track consecutiveErrors and disable after threshold
  - [x] 3.6 Implement proper cleanup on shutdown()

- [x] **Task 4: Implement Price Normalization** (AC: 3)
  - [x] 4.1 Create normalizePrice(raw, source) function
  - [x] 4.2 Handle different source formats (Chainlink, Pyth, exchange WebSockets)
  - [x] 4.3 Calculate staleness from timestamp
  - [x] 4.4 Ensure consistent number precision (avoid floating point issues)

- [x] **Task 5: Implement Public Interface** (AC: 1, 3, 8)
  - [x] 5.1 Implement getCurrentPrice(crypto) returning NormalizedPrice
  - [x] 5.2 Implement subscribe(crypto, callback) with unsubscribe return
  - [x] 5.3 Implement getState() returning connection status, stats, prices
  - [x] 5.4 Implement ensureInitialized() guard pattern

- [x] **Task 6: Implement Staleness Detection** (AC: 6)
  - [x] 6.1 Track lastUpdate timestamp per crypto
  - [x] 6.2 Calculate staleness on getCurrentPrice()
  - [x] 6.3 Emit warning when staleness > STALE_THRESHOLD_MS (10000)
  - [x] 6.4 Include staleness in getState() response

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Create `src/clients/spot/__tests__/index.test.js`
  - [x] 7.2 Test init() validates config and initializes logger
  - [x] 7.3 Test getCurrentPrice() returns normalized price
  - [x] 7.4 Test subscribe() invokes callback on updates
  - [x] 7.5 Test disconnect triggers warning and reconnection
  - [x] 7.6 Test reconnection success resets state
  - [x] 7.7 Test staleness detection emits warning
  - [x] 7.8 Test consecutive errors disable source
  - [x] 7.9 Test shutdown() cleans up resources
  - [x] 7.10 Create `src/clients/spot/__tests__/normalizer.test.js`
  - [x] 7.11 Test price normalization for different sources

- [x] **Task 8: Create API Behavior Documentation** (AC: 2)
  - [x] 8.1 Document Chainlink feed addresses and decimals
  - [x] 8.2 Document supported cryptos and their sources
  - [x] 8.3 Document rate limits and polling intervals
  - [x] 8.4 Save as `src/clients/spot/API_BEHAVIOR.md`

## Dev Notes

### Architecture Compliance

This story follows the established module patterns from Stories 2.1-2.3. The spot client wraps existing price collector code with our standard module interface.

**From architecture.md#Module-Interface-Contract:**
- All public functions return Promises (async) where appropriate
- Errors thrown via typed error classes with code, message, context
- State always inspectable via getState()
- Module exports: init(), getCurrentPrice(), subscribe(), getState(), shutdown()

### Existing Borrowed Code Analysis

The project has two price collector implementations to borrow from:

**1. ChainlinkPriceCollector (`src/collectors/chainlink_prices.js`):**
- Connects to Polygon RPC for on-chain Chainlink oracles
- Supports BTC, ETH, SOL (no XRP)
- Uses ethers.js for blockchain interaction
- Has RPC rotation and error handling
- Key patterns to borrow: `testRpcEndpoint()`, `rotateRpc()`, staleness tracking

**2. MultiSourcePriceCollector (`src/collectors/multi_source_prices.js`):**
- Aggregates multiple sources: Pyth, Coinbase, Kraken, OKX, CoinCap, CoinGecko, RedStone
- WebSocket connections for real-time data
- REST polling for rate-limited APIs
- Event emitter pattern for price updates
- Key patterns to borrow: consensus pricing, divergence detection, source fallback

### Recommended Implementation Approach

For MVP, use a simplified single-source approach (Pyth or Binance) with the multi-source architecture ready for future expansion:

```javascript
// src/clients/spot/index.js - Module interface
import { child } from '../../modules/logger/index.js';
import { SpotClientError, SpotClientErrorCodes, SUPPORTED_CRYPTOS } from './types.js';
import { SpotClient } from './client.js';

let client = null;
let log = null;

export async function init(config) {
  log = child({ module: 'spot-client' });
  log.info('module_init_start');

  client = new SpotClient({ logger: log });
  await client.initialize(config.spot || {});

  log.info('module_initialized');
}

export function getCurrentPrice(crypto) {
  ensureInitialized();
  return client.getCurrentPrice(crypto);
}

export function subscribe(crypto, callback) {
  ensureInitialized();
  return client.subscribe(crypto, callback);
}

export function getState() {
  if (!client) {
    return { initialized: false, connected: false, prices: {} };
  }
  return client.getState();
}

export async function shutdown() {
  if (log) log.info('module_shutdown_start');
  if (client) {
    await client.shutdown();
    client = null;
  }
  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}
```

### Price Normalization

All price sources must be normalized to a consistent format:

```javascript
// src/clients/spot/normalizer.js
export function normalizePrice(raw, source) {
  const now = Date.now();
  const timestamp = raw.timestamp || raw.updatedAt * 1000 || now;
  const staleness = Math.floor((now - timestamp) / 1000);

  return {
    price: typeof raw.price === 'number' ? raw.price : parseFloat(raw.price),
    timestamp: new Date(timestamp),
    source,
    staleness,
    raw, // Keep original for debugging
  };
}
```

### Error Handling Pattern

```javascript
// src/clients/spot/types.js
export class SpotClientError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'SpotClientError';
    this.code = code;
    this.context = context;
  }
}

export const SpotClientErrorCodes = {
  NOT_INITIALIZED: 'SPOT_CLIENT_NOT_INITIALIZED',
  FETCH_FAILED: 'SPOT_PRICE_FETCH_FAILED',
  SOURCE_DISABLED: 'SPOT_SOURCE_DISABLED',
  SUBSCRIPTION_ERROR: 'SPOT_SUBSCRIPTION_ERROR',
  STALE_PRICE: 'SPOT_PRICE_STALE',
};

export const SUPPORTED_CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];
```

### Subscription Pattern

```javascript
// In client.js
class SpotClient {
  constructor() {
    this.subscribers = new Map(); // crypto -> Set<callback>
  }

  subscribe(crypto, callback) {
    if (!this.subscribers.has(crypto)) {
      this.subscribers.set(crypto, new Set());
    }
    this.subscribers.get(crypto).add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(crypto)?.delete(callback);
    };
  }

  notifySubscribers(crypto, price) {
    const callbacks = this.subscribers.get(crypto);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(price);
        } catch (err) {
          this.log.error('subscriber_callback_error', { crypto, error: err.message });
        }
      }
    }
  }
}
```

### Disconnect and Reconnect Pattern

```javascript
// Exponential backoff for reconnection
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

async reconnect() {
  if (this.disabled) return;

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
    RECONNECT_MAX_MS
  );

  this.log.info('spot_reconnect_scheduled', {
    attempt: this.reconnectAttempts + 1,
    delayMs: delay
  });

  await this.sleep(delay);
  this.reconnectAttempts++;

  try {
    await this.connect();
    this.reconnectAttempts = 0;
    this.consecutiveErrors = 0;
    this.log.info('spot_feed_reconnected');
  } catch (err) {
    this.log.warn('spot_reconnect_failed', { error: err.message });
    this.reconnect(); // Schedule another attempt
  }
}
```

### Project Structure

```
src/clients/spot/
├── index.js          # Public interface: init, getCurrentPrice, subscribe, getState, shutdown
├── types.js          # SpotClientError, SpotClientErrorCodes, SUPPORTED_CRYPTOS, NormalizedPrice
├── client.js         # SpotClient class with connection management
├── normalizer.js     # Price normalization utilities
├── API_BEHAVIOR.md   # Documentation of price sources and behavior
└── __tests__/
    ├── index.test.js     # Module interface tests
    ├── client.test.js    # Client tests
    └── normalizer.test.js # Normalization tests
```

### Configuration Pattern

```javascript
// config/default.js - spot section
spot: {
  primarySource: 'pyth',  // or 'chainlink', 'binance'
  sources: {
    pyth: {
      enabled: true,
      hermesUrl: 'https://hermes.pyth.network',
      pollIntervalMs: 1000,
    },
    chainlink: {
      enabled: false,  // Requires Polygon RPC
      rpcUrls: ['https://polygon-rpc.com'],
    },
  },
  staleThresholdMs: 10000,
  maxConsecutiveErrors: 10,
}
```

### Testing Patterns (from Story 2.3)

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger
vi.mock('../../modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock axios for REST sources
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('SpotClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with valid config', async () => {
    // Test implementation
  });

  it('should emit warning on disconnect', async () => {
    // Test disconnect handling
  });
});
```

### Previous Story Intelligence (Story 2.3)

**Patterns established:**
- ESM imports (`import/export`)
- Child logger via `child({ module: 'module-name' })`
- Typed errors extending base Error class
- Tests with vitest (describe, it, expect, vi)
- ensureInitialized() guard pattern
- getState() for inspection

### Git Intelligence

**Recent commits:**
```
6b18044 Implement story 2-3-order-manager-partial-fills-cancellation
3c7ab1a Implement story 2-2-order-manager-place-track-orders
0057ddd Implement story 2-1-polymarket-api-client-integration
```

**Patterns from recent work:**
- Module initialization with config validation
- Tests co-located in `__tests__/` folder
- Structured logging with module name
- Error codes defined in types.js
- API_BEHAVIOR.md documentation pattern (from polymarket client)

### NFR Compliance

- **NFR5** (Market data keeps pace): No lag accumulation - process prices immediately
- **NFR14** (Handle API disconnects): Automatic reconnection with backoff
- **NFR17** (Spot price feed failures): Alert immediately, not silent degradation

### Polymarket Client Pattern Reference

Use `src/clients/polymarket/index.js` as the template for module structure:
- Same init/getState/shutdown pattern
- Same ensureInitialized() guard
- Same typed error handling
- Same child logger pattern

### Chainlink Feed Reference

From `src/collectors/chainlink_prices.js`:
```javascript
const CHAINLINK_FEEDS = {
  btc: { address: '0xc907E116054Ad103354f2D350FD2514433D57F6f', pair: 'BTC/USD', decimals: 8 },
  eth: { address: '0xF9680D99D6C9589e2a93a78A04A279e509205945', pair: 'ETH/USD', decimals: 8 },
  sol: { address: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC', pair: 'SOL/USD', decimals: 8 },
  xrp: null, // No direct feed
};
```

### Pyth Price IDs Reference

From `src/collectors/multi_source_prices.js`:
```javascript
const PYTH_PRICE_IDS = {
  btc: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  eth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  sol: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  xrp: '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
};
```

### References

- [Source: architecture.md#Module-Interface-Contract] - Standard interface pattern
- [Source: architecture.md#Error-Handling-Pattern] - Typed errors with context
- [Source: architecture.md#Naming-Patterns] - kebab-case files, camelCase functions
- [Source: epics.md#Story-2.4] - Story requirements
- [Source: prd.md#NFR5] - Market data keeps pace with real-time feed
- [Source: prd.md#NFR17] - Spot price feed failures trigger alerts
- [Source: src/collectors/chainlink_prices.js] - Chainlink integration patterns
- [Source: src/collectors/multi_source_prices.js] - Multi-source patterns, WebSocket handling
- [Source: src/clients/polymarket/index.js] - Module interface template
- [Source: 2-3-order-manager-partial-fills-cancellation.md] - Previous story patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass: 60 spot client tests + 414 total project tests
- No regressions detected

### Completion Notes List

- Implemented spot price client module using Pyth Network as primary data source
- Created standard module interface following established patterns (init, getState, shutdown, getCurrentPrice, subscribe)
- Implemented SpotClientError extending PolyError for consistent error handling
- Price normalization supports Pyth, Chainlink, and generic exchange formats
- Exponential backoff reconnection: 5s base, 60s max
- Staleness detection with 10-second threshold and warning logs
- Source auto-disable after 10 consecutive errors
- Subscription pattern with unsubscribe cleanup function
- Comprehensive test coverage (35 index tests, 25 normalizer tests)

### Change Log

- 2026-01-30: Initial implementation of spot price client (Story 2.4)

### File List

- src/clients/spot/index.js (new)
- src/clients/spot/types.js (new)
- src/clients/spot/client.js (new)
- src/clients/spot/normalizer.js (new)
- src/clients/spot/API_BEHAVIOR.md (new)
- src/clients/spot/__tests__/index.test.js (new)
- src/clients/spot/__tests__/normalizer.test.js (new)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)
- _bmad-output/implementation-artifacts/2-4-spot-price-feed-integration.md (modified)
