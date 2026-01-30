# Story 2.3: Order Manager - Partial Fills & Cancellation

Status: review

## Story

As a **trader**,
I want **partial fills handled correctly and the ability to cancel orders**,
So that **I have full control over order lifecycle (FR13, FR14)**.

## Acceptance Criteria

### AC1: Partial Fill Event Handling

**Given** an order receives a partial fill
**When** the partial fill event is received
**Then** order status is updated to 'partially_filled'
**And** filled_size is updated with cumulative filled amount
**And** avg_fill_price is recalculated based on all fills

### AC2: Partial Fill Completion

**Given** a partially filled order completes
**When** the final fill is received
**Then** order status is updated to 'filled'
**And** filled_size equals the total filled (may be less than requested size)
**And** avg_fill_price reflects all partial fills

### AC3: Cancel Order with Write-Ahead Logging

**Given** an open order needs to be cancelled
**When** orderManager.cancelOrder(orderId) is called
**Then** a write-ahead intent is logged for the cancellation (intent_type='cancel_order')
**And** cancel request is sent to Polymarket via polymarketClient.cancelOrder()
**And** order status is updated to 'cancelled' on confirmation
**And** cancelled_at timestamp is set
**And** the intent is marked 'completed' with cancellation details

### AC4: Cancel Order Error Handling

**Given** a cancel request fails
**When** the order was already filled, doesn't exist, or API returns error
**Then** the error is logged with context (orderId, reason, API response)
**And** a typed OrderManagerError is thrown with code 'CANCEL_FAILED'
**And** the intent is marked 'failed' with error details
**And** original order status is NOT changed (remains as it was)

### AC5: Cancel Order Validation

**Given** an attempt to cancel an order
**When** the order is in a terminal state (filled, cancelled, expired, rejected)
**Then** an OrderManagerError is thrown with code 'INVALID_CANCEL_STATE'
**And** no API call is made to Polymarket
**And** the error includes the current order status

### AC6: Module Interface Extension

**Given** the order manager module
**When** inspecting its interface
**Then** it exports: cancelOrder(orderId)
**And** it exports: handlePartialFill(orderId, fillSize, fillPrice)
**And** it exports: getPartiallyFilledOrders()
**And** follows the standard module pattern from architecture.md

### AC7: Latency Tracking for Cancellations

**Given** a cancel order operation
**When** the operation completes (success or failure)
**Then** latency from request to API response is recorded
**And** logged for monitoring (FR15)

## Tasks / Subtasks

- [x] **Task 1: Add Cancel Error Codes to Types** (AC: 4, 5)
  - [x] 1.1 Add CANCEL_FAILED to OrderManagerErrorCodes
  - [x] 1.2 Add INVALID_CANCEL_STATE to OrderManagerErrorCodes
  - [x] 1.3 Add 'partially_filled' to OrderStatus (already exists, verified)

- [x] **Task 2: Implement cancelOrder() with Write-Ahead Logging** (AC: 3, 4, 5, 7)
  - [x] 2.1 Add cancelOrder() to index.js public interface
  - [x] 2.2 Implement cancelOrder() in logic.js with validation
  - [x] 2.3 Validate order exists and is in cancellable state (open or partially_filled)
  - [x] 2.4 Log intent BEFORE API call using write-ahead.logIntent('cancel_order', windowId, payload)
  - [x] 2.5 Mark intent as executing
  - [x] 2.6 Call polymarketClient.cancelOrder(orderId)
  - [x] 2.7 Calculate and record latency
  - [x] 2.8 Update order status to 'cancelled' with cancelled_at timestamp
  - [x] 2.9 Mark intent completed/failed based on result
  - [x] 2.10 Handle API errors gracefully (order already filled, not found, etc.)

- [x] **Task 3: Implement Partial Fill Handling** (AC: 1, 2)
  - [x] 3.1 Add handlePartialFill() to index.js public interface
  - [x] 3.2 Implement handlePartialFill(orderId, fillSize, fillPrice) in logic.js
  - [x] 3.3 Validate order exists and is in fillable state
  - [x] 3.4 Update filled_size with cumulative amount
  - [x] 3.5 Recalculate avg_fill_price using weighted average formula
  - [x] 3.6 Transition status to 'partially_filled' or 'filled' based on fill completion
  - [x] 3.7 Update database and cache synchronously
  - [x] 3.8 Log partial fill events for diagnostics

- [x] **Task 4: Implement Query Functions** (AC: 6)
  - [x] 4.1 Add getPartiallyFilledOrders() to index.js
  - [x] 4.2 Implement getPartiallyFilledOrders() in logic.js
  - [x] 4.3 Query orders with status='partially_filled'
  - [x] 4.4 Ensure cache consistency with database

- [x] **Task 5: Update State Module** (AC: 1, 2, 6)
  - [x] 5.1 Add stats tracking for partial fills (ordersPartiallyFilled)
  - [x] 5.2 Add stats tracking for cancellations (include latency)
  - [x] 5.3 Update getCachedOpenOrders() to include partially_filled (already done, verified)

- [x] **Task 6: Write Tests** (AC: all)
  - [x] 6.1 Create/extend `src/modules/order-manager/__tests__/logic.test.js`
  - [x] 6.2 Test cancelOrder() logs intent BEFORE API call
  - [x] 6.3 Test cancelOrder() validates order is cancellable
  - [x] 6.4 Test cancelOrder() rejects terminal state orders
  - [x] 6.5 Test cancelOrder() handles API errors correctly
  - [x] 6.6 Test cancelOrder() records latency
  - [x] 6.7 Test handlePartialFill() updates filled_size correctly
  - [x] 6.8 Test handlePartialFill() calculates weighted avg_fill_price
  - [x] 6.9 Test handlePartialFill() transitions to 'filled' when complete
  - [x] 6.10 Test getPartiallyFilledOrders() filters correctly
  - [x] 6.11 Test error handling marks intent as failed

## Dev Notes

### Architecture Compliance

This story extends the Order Manager module implemented in Story 2.2. All new functions follow the established patterns.

**From architecture.md#Module-Interface-Contract:**
- All public functions return Promises (async)
- Errors thrown via typed error classes
- State always inspectable via getState()

### Existing Order Manager Structure

```
src/modules/order-manager/
├── index.js          # Public interface - ADD: cancelOrder, handlePartialFill, getPartiallyFilledOrders
├── logic.js          # Business logic - ADD: cancelOrder, handlePartialFill, getPartiallyFilledOrders
├── state.js          # In-memory tracking - UPDATE: stats for partial fills
├── types.js          # Types - ADD: CANCEL_FAILED, INVALID_CANCEL_STATE error codes
└── __tests__/
    ├── index.test.js
    └── logic.test.js # EXTEND: cancel and partial fill tests
```

### Write-Ahead Logging for Cancellation

**CRITICAL:** Always log intent BEFORE calling the API

```javascript
// From write-ahead.js - INTENT_TYPES includes CANCEL_ORDER
export const INTENT_TYPES = {
  OPEN_POSITION: 'open_position',
  CLOSE_POSITION: 'close_position',
  PLACE_ORDER: 'place_order',
  CANCEL_ORDER: 'cancel_order',  // <-- Use this
};

// Cancel order flow:
async function cancelOrder(orderId, log) {
  // 1. Get order to validate and get windowId
  const order = getOrder(orderId);
  if (!order) {
    throw new OrderManagerError(OrderManagerErrorCodes.NOT_FOUND, ...);
  }

  // 2. Validate order is in cancellable state
  const cancellableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!cancellableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_CANCEL_STATE,
      `Cannot cancel order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // 3. Log intent BEFORE API call
  const intentId = writeAhead.logIntent(
    writeAhead.INTENT_TYPES.CANCEL_ORDER,
    order.window_id,
    { orderId, orderStatus: order.status, requestedAt: new Date().toISOString() }
  );

  // 4. Mark as executing
  writeAhead.markExecuting(intentId);

  // 5. Record start time for latency
  const startTime = Date.now();

  try {
    // 6. Call Polymarket API
    await polymarketClient.cancelOrder(orderId);

    // 7. Calculate latency
    const latencyMs = Date.now() - startTime;

    // 8. Update order status
    updateOrderStatus(orderId, OrderStatus.CANCELLED, {
      cancelled_at: new Date().toISOString()
    }, log);

    // 9. Mark intent completed
    writeAhead.markCompleted(intentId, { orderId, latencyMs });

    log.info('order_cancelled', { orderId, latencyMs });

    return { orderId, latencyMs, intentId };

  } catch (err) {
    const latencyMs = Date.now() - startTime;

    // ALWAYS mark failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'CANCEL_FAILED',
      message: err.message,
      latencyMs
    });

    log.error('order_cancel_failed', {
      orderId,
      error: err.message,
      code: err.code,
      latencyMs
    });

    throw new OrderManagerError(
      OrderManagerErrorCodes.CANCEL_FAILED,
      `Cancel order failed: ${err.message}`,
      { orderId, originalError: err.message, intentId }
    );
  }
}
```

### Partial Fill Handling

**Weighted Average Price Calculation:**

```javascript
function handlePartialFill(orderId, fillSize, fillPrice, log) {
  const order = getOrder(orderId);
  if (!order) {
    throw new OrderManagerError(OrderManagerErrorCodes.NOT_FOUND, ...);
  }

  // Validate order is in fillable state
  const fillableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!fillableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Cannot fill order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // Calculate new cumulative filled size
  const previousFilledSize = order.filled_size || 0;
  const previousAvgPrice = order.avg_fill_price || fillPrice;
  const newFilledSize = previousFilledSize + fillSize;

  // Calculate weighted average price
  // (previousSize * previousPrice + newSize * newPrice) / totalSize
  const newAvgPrice = previousFilledSize > 0
    ? (previousFilledSize * previousAvgPrice + fillSize * fillPrice) / newFilledSize
    : fillPrice;

  // Determine new status
  const isFullyFilled = newFilledSize >= order.size;
  const newStatus = isFullyFilled ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;

  // Build updates
  const updates = {
    filled_size: newFilledSize,
    avg_fill_price: newAvgPrice,
  };

  if (isFullyFilled) {
    updates.filled_at = new Date().toISOString();
  }

  // Update order (uses existing updateOrderStatus which handles DB + cache)
  updateOrderStatus(orderId, newStatus, updates, log);

  log.info('partial_fill_processed', {
    orderId,
    fillSize,
    fillPrice,
    newFilledSize,
    newAvgPrice,
    newStatus,
  });

  return getOrder(orderId);
}
```

### Polymarket Client Integration

The polymarket client already implements cancelOrder() (from Story 2.1):

```javascript
import * as polymarketClient from '../../clients/polymarket/index.js';

// Cancel a single order
const result = await polymarketClient.cancelOrder(orderId);
// Returns: { success: true } or throws PolymarketError
```

**From API_BEHAVIOR.md - DELETE /order/{id}:**
```json
{
  "success": true
}
```

**Possible error scenarios:**
- Order not found (404)
- Order already filled
- Order already cancelled
- Rate limit (429)
- Auth error (401)

### Error Codes to Add

```javascript
// Add to OrderManagerErrorCodes in types.js
export const OrderManagerErrorCodes = {
  NOT_INITIALIZED: 'ORDER_MANAGER_NOT_INITIALIZED',
  VALIDATION_FAILED: 'ORDER_VALIDATION_FAILED',
  SUBMISSION_FAILED: 'ORDER_SUBMISSION_FAILED',
  NOT_FOUND: 'ORDER_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_ORDER_STATUS_TRANSITION',
  DATABASE_ERROR: 'ORDER_DATABASE_ERROR',
  CANCEL_FAILED: 'ORDER_CANCEL_FAILED',           // NEW
  INVALID_CANCEL_STATE: 'ORDER_INVALID_CANCEL_STATE', // NEW
};
```

### Testing Patterns (from Story 2.2)

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
  INTENT_TYPES: {
    PLACE_ORDER: 'place_order',
    CANCEL_ORDER: 'cancel_order',  // Needed for cancel tests
  },
}));

vi.mock('../../clients/polymarket/index.js', () => ({
  buy: vi.fn(),
  sell: vi.fn(),
  cancelOrder: vi.fn(),  // Mock this for cancel tests
}));
```

### State Updates Required

```javascript
// state.js - Add to stats tracking
const stats = {
  ordersPlaced: 0,
  ordersFilled: 0,
  ordersCancelled: 0,
  ordersRejected: 0,
  ordersPartiallyFilled: 0,  // NEW: track partial fills
  totalLatencyMs: 0,
  cancelLatencyMs: 0,        // NEW: track cancel latency separately
  lastOrderTime: null,
};
```

### Project Structure Notes

**Files to Modify:**
```
src/modules/order-manager/
├── index.js          # Add cancelOrder, handlePartialFill, getPartiallyFilledOrders exports
├── logic.js          # Add cancel and partial fill logic
├── state.js          # Add partial fill and cancel stats
├── types.js          # Add CANCEL_FAILED, INVALID_CANCEL_STATE error codes
└── __tests__/
    └── logic.test.js # Add cancel and partial fill tests
```

### Previous Story Intelligence (Story 2.2)

**Patterns established:**
- ESM imports (`import/export`)
- Child logger via `child({ module: 'order-manager' })`
- OrderManagerError extending OrderError
- ValidStatusTransitions for state machine
- Cache-first with database fallback
- Tests with vitest (describe, it, expect, vi)
- Write-ahead logging before API calls
- Latency recording with Date.now()

**Order Status Transitions (from types.js):**
```javascript
export const ValidStatusTransitions = {
  [OrderStatus.PENDING]: [OrderStatus.OPEN, OrderStatus.FILLED, OrderStatus.REJECTED],
  [OrderStatus.OPEN]: [OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED],
  [OrderStatus.PARTIALLY_FILLED]: [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED],
  [OrderStatus.FILLED]: [], // Terminal state
  [OrderStatus.CANCELLED]: [], // Terminal state
  [OrderStatus.EXPIRED]: [], // Terminal state
  [OrderStatus.REJECTED]: [], // Terminal state
};
```

Note: PARTIALLY_FILLED can transition to CANCELLED - this is important for cancel functionality.

### Git Intelligence

**Recent commits:**
```
3c7ab1a Implement story 2-2-order-manager-place-track-orders
0057ddd Implement story 2-1-polymarket-api-client-integration
e3dcd28 Implement story 1-5-state-reconciliation-on-startup
```

**Patterns from recent work:**
- Write-ahead logging with INTENT_TYPES constants (includes CANCEL_ORDER)
- Module initialization with config validation
- Tests co-located in `__tests__/` folder
- Structured logging with module name
- Error codes defined in types.js

### NFR Compliance

- **FR13** (Handle partial fills): handlePartialFill() with weighted average price
- **FR14** (Cancel open orders): cancelOrder() with write-ahead logging
- **FR15** (Log latency for every operation): Latency recorded for cancel operations
- **NFR8** (State persisted before acknowledging): Write-ahead intent BEFORE cancel API call

### References

- [Source: architecture.md#Module-Interface-Contract] - Standard interface pattern
- [Source: architecture.md#Error-Handling-Pattern] - Typed errors with context
- [Source: architecture.md#Write-Ahead-Logging] - Write-ahead flow
- [Source: epics.md#Story-2.3] - Story requirements (FR13, FR14)
- [Source: prd.md#FR13] - Handle partial fills appropriately
- [Source: prd.md#FR14] - Cancel open orders on demand
- [Source: prd.md#FR15] - Log latency for every order operation
- [Source: 2-2-order-manager-place-track-orders.md] - Previous story patterns
- [Source: src/clients/polymarket/API_BEHAVIOR.md] - Polymarket cancel API
- [Source: src/persistence/write-ahead.js] - INTENT_TYPES.CANCEL_ORDER
- [Source: src/modules/order-manager/types.js] - ValidStatusTransitions
- [Source: src/modules/order-manager/logic.js] - Existing order logic patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 354 tests pass (59 order-manager tests, full suite regression clean)
- Updated ValidStatusTransitions to allow partially_filled → partially_filled for multiple partial fill handling

### Completion Notes List

- Added CANCEL_FAILED and INVALID_CANCEL_STATE error codes to OrderManagerErrorCodes
- Implemented cancelOrder() with full write-ahead logging pattern (intent logged BEFORE API call)
- Implemented handlePartialFill() with weighted average price calculation
- Implemented getPartiallyFilledOrders() query function
- Added cancel latency tracking (avgCancelLatencyMs) and partial fill counter (ordersPartiallyFilled) to stats
- Updated ValidStatusTransitions to allow partially_filled → partially_filled transition for consecutive partial fills
- Added 30 new tests covering all cancel and partial fill functionality
- All acceptance criteria satisfied (AC1-AC7)

### Change Log

- 2026-01-30: Implemented story 2-3-order-manager-partial-fills-cancellation (Claude Opus 4.5)

### File List

- src/modules/order-manager/types.js (modified: added error codes, updated ValidStatusTransitions)
- src/modules/order-manager/index.js (modified: added cancelOrder, handlePartialFill, getPartiallyFilledOrders exports)
- src/modules/order-manager/logic.js (modified: added cancelOrder, handlePartialFill, getPartiallyFilledOrders implementations)
- src/modules/order-manager/state.js (modified: added ordersPartiallyFilled, cancelLatencyMs stats, recordCancelLatency, recordPartialFill functions)
- src/modules/order-manager/__tests__/logic.test.js (modified: added 30 tests for cancel and partial fill functionality)
