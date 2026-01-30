# Story 1.3: Write-Ahead Logging

Status: done

## Story

As a **system operator**,
I want **every state-changing operation to log intent before execution**,
So that **the system knows what was attempted and can recover from any crash (FR16, FR19)**.

## Acceptance Criteria

### AC1: Intent Logging Before Execution

**Given** any state-changing operation is about to occur
**When** the operation begins
**Then** an intent record is inserted with status='pending' BEFORE the action executes
**And** the intent includes: intent_type, window_id, payload (JSON), created_at

### AC2: Intent Status Transition to Executing

**Given** an intent has been logged with status='pending'
**When** the operation starts executing
**Then** the intent status is updated to 'executing'
**And** the status transition is atomic (no partial updates)

### AC3: Intent Completion on Success

**Given** an operation completes successfully
**When** the result is confirmed
**Then** the intent status is updated to 'completed'
**And** completed_at timestamp is set to current ISO time
**And** result JSON contains the success outcome

### AC4: Intent Failure Tracking

**Given** an operation fails
**When** the error is caught
**Then** the intent status is updated to 'failed'
**And** result JSON contains the error details (code, message, context)
**And** completed_at timestamp is set

### AC5: Write-Ahead Module Interface

**Given** the write-ahead logging module is created
**When** inspecting its interface
**Then** it exports:
- `logIntent(type, windowId, payload)` - Create pending intent, returns intent ID
- `markExecuting(intentId)` - Transition to 'executing'
- `markCompleted(intentId, result)` - Transition to 'completed' with result
- `markFailed(intentId, error)` - Transition to 'failed' with error
- `getIncompleteIntents()` - Return all intents with status='executing'
- `getIntent(intentId)` - Get full intent record by ID

### AC6: Intent Type Validation

**Given** an intent is being logged
**When** the intent_type is provided
**Then** it must be one of: 'open_position', 'close_position', 'place_order', 'cancel_order'
**And** invalid types throw a typed error

### AC7: Payload JSON Serialization

**Given** a payload object is provided to logIntent
**When** the intent is stored
**Then** the payload is serialized to JSON string
**And** the payload can be retrieved and deserialized correctly
**And** non-serializable values throw a typed error

## Tasks / Subtasks

- [x] **Task 1: Create Write-Ahead Module Structure** (AC: 5)
  - [x] 1.1 Create `src/persistence/write-ahead.js` as the write-ahead logging module
  - [x] 1.2 Import persistence module for database operations
  - [x] 1.3 Add IntentError class to `src/types/errors.js` extending PolyError

- [x] **Task 2: Implement logIntent Function** (AC: 1, 6, 7)
  - [x] 2.1 Validate intent_type against allowed values
  - [x] 2.2 Serialize payload to JSON, catching serialization errors
  - [x] 2.3 Generate created_at as ISO timestamp
  - [x] 2.4 Insert record with status='pending'
  - [x] 2.5 Return the inserted intent ID (lastInsertRowid)

- [x] **Task 3: Implement Status Transition Functions** (AC: 2, 3, 4)
  - [x] 3.1 Implement markExecuting(intentId) - UPDATE status to 'executing'
  - [x] 3.2 Implement markCompleted(intentId, result) - UPDATE status to 'completed', set completed_at and result
  - [x] 3.3 Implement markFailed(intentId, error) - UPDATE status to 'failed', set completed_at and serialize error
  - [x] 3.4 All transitions validate intent exists before updating
  - [x] 3.5 All transitions validate current status allows the transition

- [x] **Task 4: Implement Query Functions** (AC: 5)
  - [x] 4.1 Implement getIncompleteIntents() - SELECT WHERE status='executing'
  - [x] 4.2 Implement getIntent(intentId) - SELECT by ID with JSON deserialization
  - [x] 4.3 Deserialize payload and result JSON on retrieval

- [x] **Task 5: Write Tests** (AC: all)
  - [x] 5.1 Create `src/persistence/__tests__/write-ahead.test.js`
  - [x] 5.2 Test logIntent creates pending record with correct fields
  - [x] 5.3 Test status transitions: pending → executing → completed
  - [x] 5.4 Test status transitions: pending → executing → failed
  - [x] 5.5 Test invalid intent_type throws IntentError
  - [x] 5.6 Test non-serializable payload throws IntentError
  - [x] 5.7 Test getIncompleteIntents returns only 'executing' status
  - [x] 5.8 Test getIntent deserializes JSON correctly
  - [x] 5.9 Test transition validation (can't complete a 'pending' intent)

## Dev Notes

### Architecture Compliance

This story implements the **Write-Ahead Logging** pattern from the Architecture Decision Document:

**From architecture.md#State-Persistence:**
> **Decision:** Write-ahead logging pattern
>
> **Flow:**
> 1. Log intent to SQLite (e.g., "opening position X")
> 2. Execute action (place order)
> 3. Log result (success/failure with details)
> 4. Mark intent complete
>
> **On restart:** Check for incomplete intents → reconcile with exchange state

**Recovery Query (from architecture.md):**
```sql
SELECT * FROM trade_intents WHERE status = 'executing'
```

### Database Schema (Already Exists from Story 1.2)

The `trade_intents` table exists with this exact schema:

```sql
CREATE TABLE trade_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_type TEXT NOT NULL,        -- 'open_position', 'close_position', 'place_order', 'cancel_order'
    window_id TEXT NOT NULL,          -- which 15-min window
    payload TEXT NOT NULL,            -- JSON with intent details
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'executing', 'completed', 'failed'
    created_at TEXT NOT NULL,         -- ISO timestamp
    completed_at TEXT,                -- NULL until resolved
    result TEXT                       -- JSON with outcome or error
);

-- Indexes already exist:
CREATE INDEX idx_intents_status ON trade_intents(status);
CREATE INDEX idx_intents_window ON trade_intents(window_id);

-- CHECK constraints already exist:
-- intent_type IN ('open_position', 'close_position', 'place_order', 'cancel_order')
-- status IN ('pending', 'executing', 'completed', 'failed')
```

### Intent Type Constants

Define these in the module for type safety:

```javascript
const INTENT_TYPES = {
  OPEN_POSITION: 'open_position',
  CLOSE_POSITION: 'close_position',
  PLACE_ORDER: 'place_order',
  CANCEL_ORDER: 'cancel_order',
};

const INTENT_STATUS = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};
```

### Status Transition Rules

**Valid Transitions:**
- `pending` → `executing` (via markExecuting)
- `executing` → `completed` (via markCompleted)
- `executing` → `failed` (via markFailed)

**Invalid Transitions (throw error):**
- `pending` → `completed` (must go through executing)
- `pending` → `failed` (must go through executing)
- `completed` → any (terminal state)
- `failed` → any (terminal state)

### Error Pattern

```javascript
// Add to src/types/errors.js
export class IntentError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'IntentError';
  }
}

// Error codes to add:
export const IntentErrorCodes = {
  INVALID_INTENT_TYPE: 'INVALID_INTENT_TYPE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  INTENT_NOT_FOUND: 'INTENT_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
};
```

### Module Interface

```javascript
// src/persistence/write-ahead.js

/**
 * Log a new intent before executing an operation
 * @param {string} type - Intent type (one of INTENT_TYPES)
 * @param {string} windowId - The 15-minute window ID
 * @param {Object} payload - Intent details (will be JSON serialized)
 * @returns {number} The intent ID (for tracking through lifecycle)
 */
export function logIntent(type, windowId, payload) { }

/**
 * Mark intent as executing (operation starting)
 * @param {number} intentId - The intent ID from logIntent
 */
export function markExecuting(intentId) { }

/**
 * Mark intent as completed (operation succeeded)
 * @param {number} intentId - The intent ID
 * @param {Object} result - Success result details
 */
export function markCompleted(intentId, result) { }

/**
 * Mark intent as failed (operation failed)
 * @param {number} intentId - The intent ID
 * @param {Object} error - Error details (code, message, context)
 */
export function markFailed(intentId, error) { }

/**
 * Get all intents with status='executing' (for crash recovery)
 * @returns {Array} Intents that were executing when crash occurred
 */
export function getIncompleteIntents() { }

/**
 * Get a single intent by ID
 * @param {number} intentId - The intent ID
 * @returns {Object|undefined} The intent record with parsed JSON
 */
export function getIntent(intentId) { }

// Export constants for external use
export { INTENT_TYPES, INTENT_STATUS };
```

### Usage Pattern (How Other Modules Will Use This)

```javascript
import { logIntent, markExecuting, markCompleted, markFailed, INTENT_TYPES } from './write-ahead.js';

async function openPosition(windowId, positionDetails) {
  // Step 1: Log intent BEFORE doing anything
  const intentId = logIntent(
    INTENT_TYPES.OPEN_POSITION,
    windowId,
    { ...positionDetails }
  );

  // Step 2: Mark as executing
  markExecuting(intentId);

  try {
    // Step 3: Actually execute the operation
    const result = await polymarketClient.placeOrder(...);

    // Step 4: Mark completed with result
    markCompleted(intentId, {
      orderId: result.orderId,
      price: result.price,
      size: result.size,
    });

    return result;
  } catch (error) {
    // Step 4 (failure path): Mark failed with error
    markFailed(intentId, {
      code: error.code || 'UNKNOWN',
      message: error.message,
      context: error.context || {},
    });

    throw error;
  }
}
```

### Project Structure Notes

**File to Create:**
```
src/persistence/
├── write-ahead.js          # NEW: Write-ahead logging implementation
└── __tests__/
    └── write-ahead.test.js # NEW: Tests for write-ahead module
```

**Modifications:**
- `src/types/errors.js` - Add IntentError class and error codes

**Existing Files Used:**
- `src/persistence/index.js` - Use run(), get(), all() for database operations
- `src/persistence/database.js` - Already implements SQLite with WAL mode

### Previous Story Intelligence

**From Story 1.2 (SQLite Database & Core Schema):**
- Persistence module is fully functional with `run()`, `get()`, `all()` methods
- `trade_intents` table exists with all required columns and indexes
- CHECK constraints enforce valid intent_type and status values
- PersistenceError pattern established for database errors
- better-sqlite3 with WAL journal mode for crash recovery
- vitest is the test framework (`npm test` to run)

**Key Learnings from Story 1.2:**
- All imports must use ESM syntax (`import`/`export`)
- Error classes extend PolyError with code, message, context
- Test files go in `__tests__/` folder within module
- Database already handles WAL mode for write durability

### Git Intelligence

**Recent commits show why WAL is critical:**
- `4ea3e7a` - "Fix retry bug - check balance before retrying to prevent doubled positions"
- Previous issues with position state becoming inconsistent

**Write-ahead logging prevents these problems:**
- Every operation logged BEFORE execution
- Crashed operations detected on restart (status='executing')
- No "doubled positions" from retry bugs - check intent status first
- Recovery query: `SELECT * FROM trade_intents WHERE status = 'executing'`

### Testing Requirements

**Test File:** `src/persistence/__tests__/write-ahead.test.js`

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Write-Ahead Logging', () => {
  describe('logIntent', () => {
    it('creates pending intent with correct fields');
    it('returns intent ID');
    it('serializes payload to JSON');
    it('throws IntentError for invalid type');
    it('throws IntentError for non-serializable payload');
  });

  describe('markExecuting', () => {
    it('transitions pending intent to executing');
    it('throws if intent not found');
    it('throws if intent already executing');
    it('throws if intent already completed');
  });

  describe('markCompleted', () => {
    it('transitions executing intent to completed');
    it('sets completed_at timestamp');
    it('serializes result to JSON');
    it('throws if intent not executing');
  });

  describe('markFailed', () => {
    it('transitions executing intent to failed');
    it('sets completed_at timestamp');
    it('serializes error to JSON');
    it('throws if intent not executing');
  });

  describe('getIncompleteIntents', () => {
    it('returns only executing intents');
    it('returns empty array when none executing');
    it('deserializes payload JSON');
  });

  describe('getIntent', () => {
    it('returns intent by ID');
    it('deserializes payload and result JSON');
    it('returns undefined for non-existent ID');
  });
});
```

**Test Setup:**
- Initialize persistence in beforeEach with temp database
- Clean up in afterEach (shutdown persistence)
- Use actual database operations (not mocks) for integration testing

### References

- [Source: architecture.md#State-Persistence] - Write-ahead logging decision and flow
- [Source: architecture.md#Database-Schema] - trade_intents table definition
- [Source: architecture.md#trade_intents] - Recovery query documentation
- [Source: epics.md#Story-1.3] - Story requirements and acceptance criteria
- [Source: prd.md#FR16] - State persistence requirement
- [Source: prd.md#FR19] - Crash recovery requirement
- [Source: 1-2-sqlite-database-core-schema.md] - Previous story learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - all 36 tests passed on first run.

### Completion Notes List

1. **IntentError class added** to src/types/errors.js extending PolyError with error codes: INVALID_INTENT_TYPE, INVALID_PAYLOAD, INTENT_NOT_FOUND, INVALID_STATUS_TRANSITION
2. **write-ahead.js module created** with full implementation of intent lifecycle management
3. **INTENT_TYPES constant** exported: open_position, close_position, place_order, cancel_order
4. **INTENT_STATUS constant** exported: pending, executing, completed, failed
5. **logIntent()** - Creates pending intent with validation, JSON serialization, returns intent ID
6. **markExecuting()** - Transitions pending→executing with validation
7. **markCompleted()** - Transitions executing→completed with timestamp and result JSON
8. **markFailed()** - Transitions executing→failed with timestamp and error JSON
9. **getIncompleteIntents()** - Returns all 'executing' intents for crash recovery
10. **getIntent()** - Returns single intent with deserialized JSON
11. **Status transition validation** - Enforces valid transitions, terminal states cannot change
12. **39 comprehensive tests** covering all functions, edge cases, and error scenarios

**Code Review Fixes Applied:**
13. **windowId validation added** - null, undefined, empty string now throw IntentError with INVALID_PAYLOAD code
14. **Error logging added** - All IntentError throws now log to console.error before throwing (matching Story 1.2 pattern)
15. **Warning logging in safeParseJson** - Corrupted JSON now logs console.warn for debugging
16. **JSDoc improvements** - Added documentation for VALID_TRANSITIONS, race condition notes, BigInt handling notes
17. **3 new tests added** - Validation tests for null/undefined/empty windowId

### Change Log

- 2026-01-30: Implemented complete write-ahead logging module (Story 1.3)
- 2026-01-30: Code review fixes - added windowId validation, error logging, JSDoc, 3 new tests

### Senior Developer Review (AI)

**Review Date:** 2026-01-30
**Outcome:** Approved (with fixes applied)

**Issues Found & Fixed:**
- [x] [HIGH] Added windowId validation - null/undefined/empty now throw IntentError
- [x] [HIGH] Added error logging before throwing IntentError (matching Story 1.2 pattern)
- [x] [HIGH] Added warning logging in safeParseJson for corrupted JSON detection
- [x] [MEDIUM] Added 3 tests for empty/null/undefined windowId validation
- [x] [MEDIUM] Added JSDoc note about race condition in status transitions
- [x] [MEDIUM] Added JSDoc note about BigInt handling for large IDs
- [x] [LOW] Added comprehensive JSDoc for VALID_TRANSITIONS constant
- [x] [LOW] Removed unused variable in test file

**Total Issues:** 3 High, 3 Medium, 2 Low (all fixed)

### File List

**Created:**
- src/persistence/write-ahead.js - Write-ahead logging implementation
- src/persistence/__tests__/write-ahead.test.js - 36 comprehensive tests

**Modified:**
- src/types/errors.js - Added IntentError class and 4 error codes

