# Story 2.2: Order Manager - Place & Track Orders

Status: review

## Story

As a **trader**,
I want **to place orders through the CLOB API and track their lifecycle**,
So that **I know the exact state of every order from submission to completion (FR11, FR12)**.

## Acceptance Criteria

### AC1: Write-Ahead Intent Logging

**Given** an order needs to be placed
**When** orderManager.placeOrder() is called
**Then** a write-ahead intent is logged BEFORE the API call using the existing write-ahead module
**And** intent_type is 'place_order'
**And** payload includes: tokenId, side, size, price, orderType, windowId

### AC2: Order Submission via Polymarket Client

**Given** the intent has been logged
**When** the order is submitted
**Then** the order is placed via the polymarket client module (already implemented in Story 2.1)
**And** latency from intent creation to API acknowledgment is recorded (FR15, NFR4)
**And** the intent status is updated to 'executing' before the API call

### AC3: Order Database Persistence

**Given** an order is submitted
**When** the exchange acknowledges the order
**Then** a record is inserted into `orders` table with status='open'
**And** the `orders` table includes: order_id, intent_id, window_id, market_id, token_id, side, order_type, price, size, status, submitted_at, latency_ms

### AC4: Order Fill Tracking

**Given** an order fills completely
**When** fill confirmation is received
**Then** order status is updated to 'filled'
**And** filled_at timestamp and avg_fill_price are recorded
**And** the write-ahead intent is marked 'completed' with result details

### AC5: Order Terminal States

**Given** an order expires or is rejected
**When** the terminal state is received
**Then** order status is updated accordingly ('expired', 'cancelled', 'rejected')
**And** the write-ahead intent is marked 'completed' with result details
**And** error orders log the rejection reason

### AC6: Module Interface Compliance

**Given** the order manager module
**When** inspecting its interface
**Then** it exports: init(), placeOrder(), getOrder(), getOpenOrders(), getState(), shutdown()
**And** follows the standard module pattern from architecture.md

### AC7: Order Query Functions

**Given** orders exist in the database
**When** getOrder(orderId) or getOpenOrders() is called
**Then** complete order details are returned including all tracked fields
**And** in-memory state matches database state

## Tasks / Subtasks

- [x] **Task 1: Create Orders Table Migration** (AC: 3)
  - [x] 1.1 Create migration file `src/persistence/migrations/002-orders-table.js`
  - [x] 1.2 Create `orders` table with all required columns (see Dev Notes for schema)
  - [x] 1.3 Add indexes on status and window_id
  - [x] 1.4 Test migration applies cleanly on existing database

- [x] **Task 2: Create Order Manager Module Structure** (AC: 6)
  - [x] 2.1 Create `src/modules/order-manager/index.js` as public interface
  - [x] 2.2 Create `src/modules/order-manager/logic.js` for order business logic
  - [x] 2.3 Create `src/modules/order-manager/state.js` for in-memory order tracking
  - [x] 2.4 Create `src/modules/order-manager/types.js` for OrderManagerError and constants
  - [x] 2.5 Implement `init(config)`, `getState()`, `shutdown()` standard interface

- [x] **Task 3: Implement placeOrder() with Write-Ahead Logging** (AC: 1, 2)
  - [x] 3.1 Validate order parameters (tokenId, side, size, price, orderType)
  - [x] 3.2 Log intent BEFORE API call using `write-ahead.logIntent('place_order', windowId, payload)`
  - [x] 3.3 Mark intent as executing using `write-ahead.markExecuting(intentId)`
  - [x] 3.4 Record submission timestamp for latency calculation
  - [x] 3.5 Call polymarket client (buy/sell based on side)
  - [x] 3.6 Calculate latency_ms from submission to acknowledgment
  - [x] 3.7 Insert order record into database with status='open' or 'filled' (for FOK/IOC)
  - [x] 3.8 Mark intent completed/failed based on result
  - [x] 3.9 Return order result with orderId, status, latency_ms

- [x] **Task 4: Implement Order State Tracking** (AC: 4, 5)
  - [x] 4.1 Implement updateOrderStatus() for status transitions
  - [x] 4.2 Handle 'filled' status with avg_fill_price and filled_at
  - [x] 4.3 Handle 'expired', 'cancelled', 'rejected' terminal states
  - [x] 4.4 Maintain in-memory state synchronized with database
  - [x] 4.5 Log all status transitions via logger module

- [x] **Task 5: Implement Query Functions** (AC: 7)
  - [x] 5.1 Implement getOrder(orderId) - returns single order with all fields
  - [x] 5.2 Implement getOpenOrders() - returns all orders with status in ('open', 'partially_filled')
  - [x] 5.3 Implement getOrdersByWindow(windowId) - returns all orders for a window
  - [x] 5.4 Ensure in-memory cache is consistent with database

- [x] **Task 6: Error Handling** (AC: all)
  - [x] 6.1 Create OrderManagerError extending PolyError from src/types/errors.js
  - [x] 6.2 Add error codes: ORDER_VALIDATION_FAILED, ORDER_SUBMISSION_FAILED, ORDER_NOT_FOUND
  - [x] 6.3 Propagate PolymarketError from client with additional context
  - [x] 6.4 Always mark intent as failed on any error

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Create `src/modules/order-manager/__tests__/index.test.js`
  - [x] 7.2 Test init() initializes module and loads config
  - [x] 7.3 Test placeOrder() logs intent BEFORE API call
  - [x] 7.4 Test placeOrder() records latency correctly
  - [x] 7.5 Test order is persisted to database with correct fields
  - [x] 7.6 Test getOrder() returns correct order details
  - [x] 7.7 Test getOpenOrders() filters by status correctly
  - [x] 7.8 Test error handling marks intent as failed
  - [x] 7.9 Test shutdown() cleans up resources

## Dev Notes

### Architecture Compliance

This story implements the Order Manager module as defined in the Architecture Decision Document.

**From architecture.md#Module-Architecture:**
```
src/modules/
  order-manager/
    index.js          # Public interface
    logic.js          # Order lifecycle logic
    state.js          # Order tracking state
    types.js          # Order-specific types
    __tests__/
        index.test.js
        logic.test.js
```

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  // placeOrder, getOrder, getOpenOrders
  getState: () => {},
  shutdown: async () => {}
};
```

### Database Schema - Orders Table

**CRITICAL:** Add this table via migration (002-orders-table.js)

```sql
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,    -- exchange order ID
    intent_id INTEGER,                -- links to trade_intents
    position_id INTEGER,              -- links to positions (nullable until position manager implemented)
    window_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
    order_type TEXT NOT NULL CHECK(order_type IN ('limit', 'market', 'GTC', 'FOK', 'IOC')),
    price REAL,                       -- limit price (NULL for market)
    size REAL NOT NULL,               -- requested size
    filled_size REAL DEFAULT 0,       -- how much filled
    avg_fill_price REAL,              -- average fill price
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')),
    submitted_at TEXT NOT NULL,
    latency_ms INTEGER,               -- time from submit to ack
    filled_at TEXT,
    cancelled_at TEXT,
    error_message TEXT,               -- rejection reason if rejected
    FOREIGN KEY (intent_id) REFERENCES trade_intents(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_window ON orders(window_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
```

### Write-Ahead Logging Flow

**CRITICAL:** Always log intent BEFORE calling the API

```javascript
// 1. Log intent BEFORE action
const intentId = writeAhead.logIntent('place_order', windowId, {
  tokenId,
  side,
  size,
  price,
  orderType,
  requestedAt: new Date().toISOString()
});

// 2. Mark as executing
writeAhead.markExecuting(intentId);

// 3. Record start time for latency
const startTime = Date.now();

try {
  // 4. Place order via polymarket client
  const result = await polymarketClient.buy(tokenId, dollars, price, orderType);

  // 5. Calculate latency
  const latencyMs = Date.now() - startTime;

  // 6. Insert order into database
  persistence.run(`INSERT INTO orders ...`, [...]);

  // 7. Mark intent completed
  writeAhead.markCompleted(intentId, { orderId: result.orderID, latencyMs });

  return { orderId: result.orderID, status: result.status, latencyMs };

} catch (err) {
  // ALWAYS mark failed on error
  writeAhead.markFailed(intentId, {
    code: err.code || 'UNKNOWN',
    message: err.message,
    context: err.context
  });
  throw err;
}
```

### Polymarket Client Integration

The polymarket client is already implemented in Story 2.1. Use it as follows:

```javascript
import * as polymarketClient from '../../clients/polymarket/index.js';

// For buy orders (dollars → shares)
const result = await polymarketClient.buy(tokenId, dollars, price, orderType);

// For sell orders (shares → dollars)
const result = await polymarketClient.sell(tokenId, shares, price, orderType);
```

**Order Result Structure (from API_BEHAVIOR.md):**
```javascript
{
  orderID: 'order-123',
  status: 'live' | 'matched',
  success: true,
  transactionsHashes: ['0xabc...'],  // present if filled
  takingAmount: '1000000',            // micro-units
  makingAmount: '2000000'             // micro-units
}
```

### Order Status Mapping

Map Polymarket statuses to our internal statuses:

| Polymarket Status | Our Status | Notes |
|-------------------|------------|-------|
| `live` | `open` | Order is on the book |
| `matched` | `filled` | Order completely filled |
| API error | `rejected` | Order was rejected |
| Cancel response | `cancelled` | User cancelled |
| Not filled (FOK) | `rejected` | Fill-or-kill not filled |

### Side Conversion

```javascript
// Convert our side to polymarket method
if (side === 'buy') {
  result = await polymarketClient.buy(tokenId, dollarAmount, price, orderType);
} else if (side === 'sell') {
  result = await polymarketClient.sell(tokenId, shareAmount, price, orderType);
}
```

### Latency Recording (FR15, NFR4)

**CRITICAL:** Record latency for EVERY order operation

```javascript
const startTime = Date.now();
// ... API call ...
const latencyMs = Date.now() - startTime;

// Store in orders table
persistence.run(
  `INSERT INTO orders (..., latency_ms) VALUES (..., ?)`,
  [..., latencyMs]
);

// Log for monitoring
log.info('order_placed', { orderId, latencyMs });
```

### Error Handling Pattern

```javascript
import { OrderError, ErrorCodes } from '../../types/errors.js';

// Create module-specific error
export class OrderManagerError extends OrderError {
  constructor(code, message, context = {}) {
    super(code, message, context);
  }
}

// Error codes specific to order manager
export const OrderManagerErrorCodes = {
  NOT_INITIALIZED: 'ORDER_MANAGER_NOT_INITIALIZED',
  VALIDATION_FAILED: 'ORDER_VALIDATION_FAILED',
  SUBMISSION_FAILED: 'ORDER_SUBMISSION_FAILED',
  NOT_FOUND: 'ORDER_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_ORDER_STATUS_TRANSITION',
};
```

### Testing Patterns

**From Story 2.1 - Use same patterns:**

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../persistence/index.js', () => ({
  default: {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  },
  run: vi.fn(),
  get: vi.fn(),
  all: vi.fn(),
}));

vi.mock('../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: { PLACE_ORDER: 'place_order' },
}));

vi.mock('../../clients/polymarket/index.js', () => ({
  buy: vi.fn(),
  sell: vi.fn(),
}));
```

### Expected Module Interface

```javascript
// src/modules/order-manager/index.js

import { child } from '../logger/index.js';
import { OrderManagerError, OrderManagerErrorCodes } from './types.js';
import * as logic from './logic.js';

let log = null;
let config = null;
let initialized = false;

export async function init(cfg) {
  log = child({ module: 'order-manager' });
  config = cfg;
  initialized = true;
  log.info('module_initialized');
}

export async function placeOrder({ tokenId, side, size, price, orderType, windowId, marketId }) {
  ensureInitialized();
  return logic.placeOrder({ tokenId, side, size, price, orderType, windowId, marketId }, log);
}

export async function getOrder(orderId) {
  ensureInitialized();
  return logic.getOrder(orderId);
}

export async function getOpenOrders() {
  ensureInitialized();
  return logic.getOpenOrders();
}

export function getState() {
  return {
    initialized,
    // ... stats
  };
}

export async function shutdown() {
  log?.info('module_shutdown');
  initialized = false;
}

function ensureInitialized() {
  if (!initialized) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_INITIALIZED,
      'Order manager not initialized. Call init() first.'
    );
  }
}
```

### Project Structure Notes

**Files to Create:**
```
src/
├── persistence/
│   └── migrations/
│       └── 002-orders-table.js    # New migration
└── modules/
    └── order-manager/
        ├── index.js               # Public module interface
        ├── logic.js               # Order business logic
        ├── state.js               # In-memory order tracking
        ├── types.js               # OrderManagerError, constants
        └── __tests__/
            ├── index.test.js      # Integration tests
            └── logic.test.js      # Unit tests
```

### Previous Story Intelligence

**From Story 2.1 (Polymarket API Client Integration):**
- Module interface pattern: init(), getState(), shutdown()
- Polymarket client exports: buy(), sell(), cancelOrder(), getOpenOrders()
- Error handling: PolymarketError with error codes
- Rate limiting: 100ms minimum interval (already handled by client)
- Fill verification: Multi-factor (txHash + success + status)
- Price validation: 0.01-0.99 range

**Key patterns established:**
- ESM imports (`import/export`)
- Child logger via `child({ module: 'name' })`
- Typed errors extending PolyError
- Tests with vitest (describe, it, expect, vi)

### Git Intelligence

**Recent commits (from `git log --oneline -5`):**
```
0057ddd Implement story 2-1-polymarket-api-client-integration
e3dcd28 Implement story 1-5-state-reconciliation-on-startup
d35e55b Add logger module (Story 1.4) and epic runner script
fd40e59 Add write-ahead logging module for crash recovery (Story 1.3)
a12a997 Add BMAD workflow system, planning artifacts, and analysis scripts
```

**Patterns from recent work:**
- Write-ahead logging with INTENT_TYPES constants
- Module initialization with config validation
- Tests co-located in `__tests__/` folder
- Structured logging with module name

### NFR Compliance

- **FR11** (Place orders through CLOB): Via polymarket client
- **FR12** (Track orders to completion): Database + in-memory state
- **FR15** (Log latency): latency_ms column in orders table
- **NFR4** (Log latency for every operation): Recorded on every placeOrder call
- **NFR8** (State persisted before acknowledging): Write-ahead intent BEFORE API call

### References

- [Source: architecture.md#Module-Architecture] - Module structure pattern
- [Source: architecture.md#Module-Interface-Contract] - Standard interface
- [Source: architecture.md#Database-Schema-orders] - Orders table definition
- [Source: architecture.md#Write-Ahead-Logging] - Write-ahead flow
- [Source: epics.md#Story-2.2] - Story requirements
- [Source: prd.md#FR11] - Place orders through CLOB API
- [Source: prd.md#FR12] - Track orders to completion
- [Source: prd.md#FR15] - Log latency for every order
- [Source: 2-1-polymarket-api-client-integration.md] - Previous story patterns
- [Source: src/clients/polymarket/API_BEHAVIOR.md] - Polymarket API reference
- [Source: src/persistence/write-ahead.js] - Write-ahead logging implementation
- [Source: src/types/errors.js] - Error class patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 324 tests passing after implementation
- Migration 002-orders-table verified with test database
- Schema-manager tests updated to support multiple migrations

### Completion Notes List

1. **Task 1 Complete**: Created migration 002-orders-table.js with all required columns, foreign key to trade_intents, and indexes on status, window_id, and order_id.

2. **Task 2 Complete**: Created order-manager module structure following architecture pattern with index.js (public interface), logic.js (business logic), state.js (in-memory caching), and types.js (error classes and constants).

3. **Task 3 Complete**: Implemented placeOrder() with full write-ahead logging flow - validates params, logs intent BEFORE API call, marks executing, calls polymarket client (buy/sell based on side), calculates latency, persists order, marks intent complete/failed.

4. **Task 4 Complete**: Implemented updateOrderStatus() with valid state transition validation, automatic timestamp setting for terminal states, and synchronized in-memory + database state.

5. **Task 5 Complete**: Implemented getOrder(), getOpenOrders(), getOrdersByWindow() with cache-first strategy and database fallback for consistency.

6. **Task 6 Complete**: Created OrderManagerError extending OrderError with error codes: NOT_INITIALIZED, VALIDATION_FAILED, SUBMISSION_FAILED, NOT_FOUND, INVALID_STATUS_TRANSITION, DATABASE_ERROR. Intent always marked failed on errors.

7. **Task 7 Complete**: Created comprehensive test suites - index.test.js (31 tests) and logic.test.js (29 tests) covering all acceptance criteria. Total: 60 new tests passing.

### Change Log

- 2026-01-30: Implemented Story 2.2 - Order Manager module with full write-ahead logging, database persistence, and comprehensive test coverage.

### File List

**New Files:**
- src/persistence/migrations/002-orders-table.js
- src/modules/order-manager/index.js
- src/modules/order-manager/logic.js
- src/modules/order-manager/state.js
- src/modules/order-manager/types.js
- src/modules/order-manager/__tests__/index.test.js
- src/modules/order-manager/__tests__/logic.test.js

**Modified Files:**
- src/persistence/__tests__/schema-manager.test.js (updated to support multiple migrations)
