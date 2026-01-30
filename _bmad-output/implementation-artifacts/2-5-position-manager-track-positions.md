# Story 2.5: Position Manager - Track Positions

Status: review

## Story

As a **trader**,
I want **all open positions tracked with current state**,
So that **I always know my exact exposure (FR6, FR9)**.

## Acceptance Criteria

### AC1: Module Interface Compliance

**Given** the position manager module is created at `src/modules/position-manager/`
**When** inspecting its interface
**Then** it exports: init(config), addPosition(params), getPosition(id), getPositions(), closePosition(id, params), getState(), shutdown()
**And** follows the standard module interface pattern from architecture.md
**And** has a child logger via `child({ module: 'position-manager' })`

### AC2: Position Creation on Order Fill

**Given** a new position is opened
**When** an order fills that creates a position
**Then** addPosition() is called with order details
**And** a record is inserted into `positions` table with status='open'
**And** the table includes: id, window_id, market_id, token_id, side, size, entry_price, current_price, status, strategy_id, opened_at, exchange_verified_at
**And** the insert is done via write-ahead logging pattern

### AC3: Position Retrieval

**Given** positions exist in the database
**When** positionManager.getPositions() is called
**Then** all open positions are returned with current state
**And** in-memory state matches database state
**And** positions with status='open' are returned

**Given** a specific position is queried
**When** positionManager.getPosition(id) is called
**Then** complete position details are returned (FR9)
**And** includes: entry_price, current_price, unrealized_pnl, size, strategy_id, status

### AC4: Price Updates

**Given** a position's market price changes
**When** updatePrice(id, newPrice) is called
**Then** current_price is updated in memory
**And** unrealized_pnl is recalculated: (current_price - entry_price) * size * (side === 'long' ? 1 : -1)
**And** updates are persisted periodically (not on every tick) based on config

### AC5: Position Status Reporting

**Given** position status is requested
**When** positionManager.getPosition(id) is called (FR9)
**Then** complete position details are returned
**And** includes: id, window_id, market_id, token_id, side, size, entry_price, current_price, unrealized_pnl, status, strategy_id, opened_at

### AC6: Positions Table Schema

**Given** the positions table is created
**When** inspecting the database schema
**Then** the table has the following structure:
```sql
CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long', 'short')),
    size REAL NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'liquidated')),
    strategy_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_price REAL,
    pnl REAL,
    exchange_verified_at TEXT,
    UNIQUE(window_id, market_id, token_id)
);
```
**And** indexes exist on status and strategy_id

### AC7: Module State Inspection

**Given** the position manager is initialized
**When** getState() is called
**Then** returns: { initialized, positions: { open: count, closed: count }, stats: { totalOpened, totalClosed, totalPnl } }

## Tasks / Subtasks

- [x] **Task 1: Create Database Migration** (AC: 6)
  - [x] 1.1 Create migration file `src/persistence/migrations/002-add-positions-table.js`
  - [x] 1.2 Add CREATE TABLE for positions with all columns from schema
  - [x] 1.3 Add indexes on status, strategy_id
  - [x] 1.4 Add UNIQUE constraint on (window_id, market_id, token_id)
  - [x] 1.5 Test migration runs idempotently

- [x] **Task 2: Create Module Structure** (AC: 1)
  - [x] 2.1 Create `src/modules/position-manager/index.js` with standard module interface
  - [x] 2.2 Create `src/modules/position-manager/types.js` with error codes and types
  - [x] 2.3 Create `src/modules/position-manager/logic.js` for business logic
  - [x] 2.4 Create `src/modules/position-manager/state.js` for in-memory position state
  - [x] 2.5 Create `src/modules/position-manager/__tests__/` directory

- [x] **Task 3: Implement Types and Errors** (AC: 1)
  - [x] 3.1 Define PositionManagerError extending PositionError
  - [x] 3.2 Define PositionManagerErrorCodes (NOT_INITIALIZED, VALIDATION_FAILED, NOT_FOUND, DUPLICATE_POSITION, DATABASE_ERROR)
  - [x] 3.3 Define PositionStatus: 'open', 'closed', 'liquidated'
  - [x] 3.4 Define Side: 'long', 'short'
  - [x] 3.5 Define Position type interface

- [x] **Task 4: Implement Position State Management** (AC: 2, 3, 4, 7)
  - [x] 4.1 Implement in-memory position cache in state.js
  - [x] 4.2 Implement loadPositionsFromDb() on init
  - [x] 4.3 Implement getOpenPositions() from cache
  - [x] 4.4 Implement getPosition(id) from cache
  - [x] 4.5 Implement updatePositionInCache(position)
  - [x] 4.6 Implement getStats() for module state

- [x] **Task 5: Implement Core Logic** (AC: 2, 3, 4, 5)
  - [x] 5.1 Implement addPosition(params) with write-ahead logging
  - [x] 5.2 Validate params: window_id, market_id, token_id, side, size, entry_price, strategy_id
  - [x] 5.3 Check for duplicate position (unique constraint)
  - [x] 5.4 Insert to database and update cache
  - [x] 5.5 Implement getPosition(id) returning full position details
  - [x] 5.6 Implement getPositions() returning all open positions
  - [x] 5.7 Implement updatePrice(id, newPrice) with unrealized P&L calculation

- [x] **Task 6: Implement Module Interface** (AC: 1, 7)
  - [x] 6.1 Implement init(config) with config validation and DB loading
  - [x] 6.2 Implement getState() returning stats and position counts
  - [x] 6.3 Implement shutdown() with cleanup
  - [x] 6.4 Implement ensureInitialized() guard pattern
  - [x] 6.5 Re-export types and constants

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Create `src/modules/position-manager/__tests__/index.test.js`
  - [x] 7.2 Test init() validates config and loads positions
  - [x] 7.3 Test addPosition() creates position with write-ahead log
  - [x] 7.4 Test addPosition() rejects duplicate positions
  - [x] 7.5 Test getPosition() returns correct details with unrealized P&L
  - [x] 7.6 Test getPositions() returns only open positions
  - [x] 7.7 Test updatePrice() updates current_price and unrealized_pnl
  - [x] 7.8 Test getState() returns correct stats
  - [x] 7.9 Test shutdown() cleans up resources
  - [x] 7.10 Create `src/modules/position-manager/__tests__/logic.test.js`
  - [x] 7.11 Test unrealized P&L calculation for long and short positions

## Dev Notes

### Architecture Compliance

This story follows the established module patterns from Stories 2.1-2.4. The position manager tracks open positions with write-ahead logging for crash recovery.

**From architecture.md#Module-Interface-Contract:**
- All public functions return Promises (async) where appropriate
- Errors thrown via typed error classes with code, message, context
- State always inspectable via getState()
- Module exports: init(), addPosition(), getPosition(), getPositions(), closePosition(), getState(), shutdown()

**Note:** closePosition() will be fully implemented in Story 2.6 (Position Manager - Reconciliation & Limits). This story focuses on tracking positions; Story 2.6 handles closing and reconciliation.

### Project Structure Notes

**Module location:** `src/modules/position-manager/`

```
src/modules/position-manager/
├── index.js          # Public interface: init, addPosition, getPosition, getPositions, updatePrice, getState, shutdown
├── types.js          # PositionManagerError, PositionManagerErrorCodes, PositionStatus, Side, Position
├── logic.js          # Business logic: addPosition, getPosition, updatePrice, calculateUnrealizedPnl
├── state.js          # In-memory position cache: loadPositions, getStats, clearCache
└── __tests__/
    ├── index.test.js  # Module interface tests
    └── logic.test.js  # Business logic tests
```

### Database Migration

The positions table must be created via migration to maintain schema versioning. Follow the pattern from `src/persistence/migrations/001-initial-schema.js`.

```javascript
// src/persistence/migrations/002-add-positions-table.js
export const version = '002';
export const name = 'add_positions_table';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('long', 'short')),
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'liquidated')),
      strategy_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_price REAL,
      pnl REAL,
      exchange_verified_at TEXT,
      UNIQUE(window_id, market_id, token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy_id);
  `);
}
```

### Unrealized P&L Calculation

```javascript
function calculateUnrealizedPnl(position) {
  if (!position.current_price) return 0;
  const priceDiff = position.current_price - position.entry_price;
  const direction = position.side === 'long' ? 1 : -1;
  return priceDiff * position.size * direction;
}
```

**Examples:**
- Long BTC at 0.45, current 0.50, size 100: (0.50 - 0.45) * 100 * 1 = +5 profit
- Short ETH at 0.60, current 0.55, size 50: (0.55 - 0.60) * 50 * -1 = +2.5 profit
- Long SOL at 0.30, current 0.25, size 200: (0.25 - 0.30) * 200 * 1 = -10 loss

### Write-Ahead Logging Pattern

From `src/persistence/write-ahead.js`:
```javascript
import { logIntent, markExecuting, markCompleted, markFailed, INTENT_TYPES } from '../persistence/write-ahead.js';

async function addPosition(params, log) {
  // 1. Log intent BEFORE any action
  const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, params.windowId, params);

  try {
    // 2. Mark executing
    markExecuting(intentId);

    // 3. Insert to database
    const position = insertPosition(params);

    // 4. Mark completed
    markCompleted(intentId, { positionId: position.id });

    return position;
  } catch (error) {
    // 5. Mark failed on error
    markFailed(intentId, { code: error.code, message: error.message });
    throw error;
  }
}
```

### Error Handling Pattern

```javascript
// src/modules/position-manager/types.js
import { PositionError } from '../../types/errors.js';

export const PositionManagerErrorCodes = {
  NOT_INITIALIZED: 'POSITION_MANAGER_NOT_INITIALIZED',
  VALIDATION_FAILED: 'POSITION_VALIDATION_FAILED',
  NOT_FOUND: 'POSITION_NOT_FOUND',
  DUPLICATE_POSITION: 'DUPLICATE_POSITION',
  DATABASE_ERROR: 'POSITION_DATABASE_ERROR',
  INVALID_STATUS_TRANSITION: 'POSITION_INVALID_STATUS_TRANSITION',
};

export class PositionManagerError extends PositionError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PositionManagerError';
  }
}
```

### Module Interface Pattern

Follow the established pattern from `src/modules/order-manager/index.js`:

```javascript
// src/modules/position-manager/index.js
import { child } from '../logger/index.js';
import { PositionManagerError, PositionManagerErrorCodes } from './types.js';
import * as logic from './logic.js';
import { getStats, clearCache } from './state.js';

let log = null;
let config = null;
let initialized = false;

export async function init(cfg) {
  if (initialized) return;

  log = child({ module: 'position-manager' });
  config = cfg;

  log.info('module_init_start');

  // Load positions from database
  logic.loadPositionsFromDb(log);

  initialized = true;
  log.info('module_initialized');
}

export async function addPosition(params) {
  ensureInitialized();
  return logic.addPosition(params, log);
}

export function getPosition(id) {
  ensureInitialized();
  return logic.getPosition(id);
}

export function getPositions() {
  ensureInitialized();
  return logic.getPositions();
}

export function updatePrice(id, newPrice) {
  ensureInitialized();
  return logic.updatePrice(id, newPrice, log);
}

export function getState() {
  return {
    initialized,
    ...getStats(),
  };
}

export async function shutdown() {
  if (log) log.info('module_shutdown_start');
  clearCache();
  config = null;
  initialized = false;
  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

function ensureInitialized() {
  if (!initialized) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_INITIALIZED,
      'Position manager not initialized. Call init() first.'
    );
  }
}

export { PositionManagerError, PositionManagerErrorCodes, PositionStatus, Side } from './types.js';
```

### Testing Patterns

Follow the established vitest patterns from Story 2.4:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger
vi.mock('../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock persistence
vi.mock('../../persistence/index.js', () => ({
  default: {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  },
}));

describe('PositionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and load positions', async () => {
    // Test implementation
  });
});
```

### Configuration Pattern

From `config/default.js`:
```javascript
risk: {
  maxPositionSize: 100,        // Maximum size per position
  maxExposure: 500,            // Maximum total exposure
  dailyDrawdownLimit: 0.05,    // 5% daily drawdown limit
  positionLimitPerMarket: 1,   // Max positions per market
},
```

**Note:** Position limits will be enforced in Story 2.6 (Reconciliation & Limits).

### Dependencies on Previous Stories

- **Story 1.2 (SQLite):** Database connection via `src/persistence/index.js`
- **Story 1.3 (Write-Ahead):** Intent logging via `src/persistence/write-ahead.js`
- **Story 1.4 (Logger):** Structured logging via `src/modules/logger/index.js`
- **Story 2.2 (Order Manager):** Order fills trigger position creation

### Integration Points

**Order Manager Integration (Future):**
When an order fills completely, the order manager (or orchestrator) will call:
```javascript
import * as positionManager from '../position-manager/index.js';

// On order fill
const position = await positionManager.addPosition({
  windowId: order.window_id,
  marketId: order.market_id,
  tokenId: order.token_id,
  side: order.side === 'buy' ? 'long' : 'short',
  size: order.filled_size,
  entryPrice: order.avg_fill_price,
  strategyId: order.strategy_id || 'manual',
});
```

**Spot Client Integration (Future):**
Price updates from spot client will call:
```javascript
import * as positionManager from '../position-manager/index.js';

// On price update
const positions = positionManager.getPositions();
for (const pos of positions) {
  if (pos.token_id === tokenId) {
    positionManager.updatePrice(pos.id, newPrice);
  }
}
```

### NFR Compliance

- **NFR7** (No orphaned positions): Write-ahead logging ensures every position action is recoverable
- **NFR8** (State persisted before ack): Position inserted to DB before returning from addPosition()
- **FR6** (Track all open positions): getPositions() returns all open positions
- **FR9** (Report position status): getPosition(id) returns complete position details

### Previous Story Intelligence (Story 2.4)

**Patterns established:**
- ESM imports (`import/export`)
- Child logger via `child({ module: 'module-name' })`
- Typed errors extending base Error class
- Tests with vitest (describe, it, expect, vi)
- ensureInitialized() guard pattern
- getState() for inspection
- Module interface: init, getState, shutdown + domain operations

### Git Intelligence

**Recent commits:**
```
f82b7f7 Implement story 2-4-spot-price-feed-integration
6b18044 Implement story 2-3-order-manager-partial-fills-cancellation
3c7ab1a Implement story 2-2-order-manager-place-track-orders
0057ddd Implement story 2-1-polymarket-api-client-integration
```

**Patterns from recent work:**
- Module initialization with config validation
- Tests co-located in `__tests__/` folder
- Structured logging with module name
- Error codes defined in types.js
- Database migrations pattern

### Existing Codebase References

**Module template:** Use `src/modules/order-manager/index.js` as the template for structure.

**Write-ahead types:** `INTENT_TYPES.OPEN_POSITION` is already defined in `src/persistence/write-ahead.js`.

**Error base class:** `PositionError` is already defined in `src/types/errors.js`.

### References

- [Source: architecture.md#Module-Interface-Contract] - Standard interface pattern
- [Source: architecture.md#Database-Schema#positions] - Full schema definition
- [Source: architecture.md#Error-Handling-Pattern] - Typed errors with context
- [Source: architecture.md#Naming-Patterns] - kebab-case files, camelCase functions
- [Source: epics.md#Story-2.5] - Story requirements
- [Source: prd.md#FR6] - Track all open positions with current state
- [Source: prd.md#FR9] - Report position status on demand
- [Source: prd.md#NFR7] - No orphaned positions under any failure
- [Source: prd.md#NFR8] - State persisted before acknowledging position change
- [Source: src/modules/order-manager/index.js] - Module interface template
- [Source: src/persistence/write-ahead.js] - Write-ahead logging patterns
- [Source: src/types/errors.js] - PositionError base class
- [Source: 2-4-spot-price-feed-integration.md] - Previous story patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered during implementation.

### Completion Notes List

- Implemented position manager module following established patterns from order-manager
- Created database migration 002-add-positions-table.js with full schema including indexes
- Implemented write-ahead logging pattern for position creation (OPEN_POSITION intent type)
- Position state is cached in-memory for fast access, synced with database
- Unrealized P&L calculation implemented for both long and short positions
- All 458 tests pass (44 new tests added for position-manager)
- closePosition() is stubbed - full implementation in Story 2.6

### File List

- src/persistence/migrations/002-add-positions-table.js (new)
- src/modules/position-manager/index.js (new)
- src/modules/position-manager/types.js (new)
- src/modules/position-manager/logic.js (new)
- src/modules/position-manager/state.js (new)
- src/modules/position-manager/__tests__/index.test.js (new)
- src/modules/position-manager/__tests__/logic.test.js (new)

### Change Log

- 2026-01-30: Implemented Story 2.5 - Position Manager Track Positions (all ACs satisfied)

