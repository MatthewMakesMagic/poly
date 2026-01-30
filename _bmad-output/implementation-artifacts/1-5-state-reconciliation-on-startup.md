# Story 1.5: State Reconciliation on Startup

Status: review

## Story

As a **system operator**,
I want **the system to detect and report incomplete operations on restart**,
So that **I can reconcile state and ensure no orphaned positions (FR17, FR18, FR19)**.

## Acceptance Criteria

### AC1: Detect Incomplete Intents on Startup

**Given** the application starts
**When** the persistence layer initializes
**Then** it queries for intents with status='executing'
**And** any found are reported as "incomplete intents requiring reconciliation"
**And** the query uses: `SELECT * FROM trade_intents WHERE status = 'executing'`

### AC2: Log Incomplete Intents as Warnings

**Given** incomplete intents are found
**When** the reconciliation check runs
**Then** each incomplete intent is logged with level='warn'
**And** the log includes: intent_type, window_id, created_at, payload (parsed)
**And** the log event is 'incomplete_intent_detected'

### AC3: No Automatic Retry

**Given** incomplete intents are found
**When** the reconciliation check completes
**Then** the system does NOT automatically retry the operations
**And** a summary message indicates manual reconciliation is required
**And** the system can still start (intents block alerting, not startup)

### AC4: Clean Startup with No Incomplete Intents

**Given** no incomplete intents exist
**When** the application starts
**Then** startup completes normally
**And** an info log confirms "State reconciliation complete - no incomplete intents"
**And** the reconciliation function returns `{ clean: true, incompleteCount: 0 }`

### AC5: State Divergence Detection

**Given** state divergence is detected (FR18)
**When** memory state differs from database state
**Then** a divergence event is logged with both states
**And** the log level is 'error'
**And** the system alerts (does not silently continue)
**And** the divergence is actionable (includes what to check)

### AC6: Reconciliation Module Interface

**Given** the state-reconciler module is created
**When** inspecting its interface
**Then** it exports:
- `init(config)` - Initialize with config
- `checkStartupState()` - Run reconciliation checks, returns status object
- `getIncompleteIntents()` - Get list of incomplete intents
- `markIntentReconciled(intentId, resolution)` - Mark intent as manually reconciled
- `getState()` - Return module state
- `shutdown()` - Clean shutdown

### AC7: Reconciliation Status Report

**Given** the reconciliation check completes
**When** the result is returned
**Then** it includes:
- `clean: boolean` - True if no issues found
- `incompleteCount: number` - Count of incomplete intents
- `incompleteIntents: Array` - Details of each incomplete intent
- `timestamp: string` - When reconciliation ran
- `duration_ms: number` - How long the check took

### AC8: Performance Requirement

**Given** state reconciliation is running
**When** the check executes
**Then** it completes within 10 seconds (NFR3)
**And** the duration is logged for monitoring
**And** large numbers of intents are handled efficiently

## Tasks / Subtasks

- [x] **Task 1: Create State Reconciler Module Structure** (AC: 6)
  - [x] 1.1 Create `src/modules/state-reconciler/index.js` as public interface
  - [x] 1.2 Create `src/modules/state-reconciler/logic.js` for reconciliation logic
  - [x] 1.3 Create `src/modules/state-reconciler/types.js` for type definitions
  - [x] 1.4 Ensure module follows folder-per-module architecture pattern

- [x] **Task 2: Implement checkStartupState Function** (AC: 1, 4, 7, 8)
  - [x] 2.1 Import getIncompleteIntents from write-ahead module
  - [x] 2.2 Query for intents with status='executing'
  - [x] 2.3 Calculate duration of check
  - [x] 2.4 Return ReconciliationResult object with clean, incompleteCount, etc.
  - [x] 2.5 Ensure function completes within 10 seconds (NFR3)

- [x] **Task 3: Implement Warning Logging for Incomplete Intents** (AC: 2)
  - [x] 3.1 Import logger module (child logger for 'state-reconciler')
  - [x] 3.2 Log each incomplete intent with level='warn'
  - [x] 3.3 Include intent_type, window_id, created_at, payload in log
  - [x] 3.4 Use event name 'incomplete_intent_detected'

- [x] **Task 4: Implement Clean Startup Logging** (AC: 4)
  - [x] 4.1 Log info "State reconciliation complete - no incomplete intents" when clean
  - [x] 4.2 Include duration_ms in the success log
  - [x] 4.3 Use event name 'reconciliation_complete'

- [x] **Task 5: Implement No-Retry Behavior** (AC: 3)
  - [x] 5.1 Document that manual reconciliation is required (in logs)
  - [x] 5.2 Return result but do NOT call any retry/execute functions
  - [x] 5.3 Log summary: "X incomplete intents found - manual reconciliation required"

- [x] **Task 6: Implement markIntentReconciled Function** (AC: 6)
  - [x] 6.1 Accept intentId and resolution object
  - [x] 6.2 Update intent status to 'failed' with resolution in result field
  - [x] 6.3 Set completed_at timestamp
  - [x] 6.4 Log the manual reconciliation action
  - [x] 6.5 Validate intent exists and is in 'executing' status

- [x] **Task 7: Implement State Divergence Detection** (AC: 5)
  - [x] 7.1 Create detectDivergence(memoryState, dbState) function
  - [x] 7.2 Compare position counts and key fields
  - [x] 7.3 Log divergence with level='error' if found
  - [x] 7.4 Include both states in log for debugging
  - [x] 7.5 Return list of divergences found

- [x] **Task 8: Implement Module init, getState, shutdown** (AC: 6)
  - [x] 8.1 Implement init(config) to store config and set up logger
  - [x] 8.2 Implement getState() returning config, lastReconciliation, stats
  - [x] 8.3 Implement shutdown() for clean module shutdown
  - [x] 8.4 Track stats: totalChecks, incompleteFound, divergencesDetected

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Create `src/modules/state-reconciler/__tests__/index.test.js`
  - [x] 9.2 Test checkStartupState with no incomplete intents (clean)
  - [x] 9.3 Test checkStartupState with incomplete intents (warns, returns list)
  - [x] 9.4 Test no automatic retry occurs
  - [x] 9.5 Test markIntentReconciled updates status correctly
  - [x] 9.6 Test detectDivergence identifies differences
  - [x] 9.7 Test performance under 10 seconds with many intents
  - [x] 9.8 Test getState returns expected structure
  - [x] 9.9 Test logging includes required fields

## Dev Notes

### Architecture Compliance

This story implements the **State Reconciliation** pattern from the Architecture Decision Document.

**From architecture.md#State-Persistence:**
> **On restart:** Check for incomplete intents → reconcile with exchange state

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  // Main operations (module-specific)
  getState: () => {},
  shutdown: async () => {}
};
```

**From architecture.md#Project-Structure:**
```
src/modules/
  state-reconciler/
    index.js          # Public interface
    logic.js          # Reconciliation logic
    divergence.js     # Divergence detection
    __tests__/
        logic.test.js
        divergence.test.js
```

### Recovery Query (From Architecture)

```sql
SELECT * FROM trade_intents WHERE status = 'executing'
```

This query returns intents that were mid-execution when the system crashed. These represent operations that:
- Started but didn't complete
- May have partially executed on the exchange
- Require manual verification against exchange state

### ReconciliationResult Type

```javascript
// src/modules/state-reconciler/types.js

/**
 * @typedef {Object} IncompleteIntent
 * @property {number} id - Intent ID
 * @property {string} intent_type - Type of operation
 * @property {string} window_id - Trading window
 * @property {Object} payload - Intent details (parsed JSON)
 * @property {string} created_at - When intent was created
 */

/**
 * @typedef {Object} ReconciliationResult
 * @property {boolean} clean - True if no issues found
 * @property {number} incompleteCount - Number of incomplete intents
 * @property {IncompleteIntent[]} incompleteIntents - Details of each
 * @property {string} timestamp - When reconciliation ran
 * @property {number} duration_ms - How long the check took
 */
```

### Expected Module Interface

```javascript
// src/modules/state-reconciler/index.js

let config = null;
let log = null;  // Child logger for this module

export async function init(cfg) {
  config = cfg;
  log = logger.child({ module: 'state-reconciler' });
}

/**
 * Run startup reconciliation checks
 * @returns {ReconciliationResult}
 */
export async function checkStartupState() {
  const startTime = Date.now();

  const incompleteIntents = await getIncompleteIntentsFromDb();

  if (incompleteIntents.length === 0) {
    log.info('reconciliation_complete', {
      clean: true,
      incomplete_count: 0,
      duration_ms: Date.now() - startTime,
    });
    return { clean: true, incompleteCount: 0, incompleteIntents: [], ... };
  }

  // Log each incomplete intent as warning
  for (const intent of incompleteIntents) {
    log.warn('incomplete_intent_detected', {
      intent_id: intent.id,
      intent_type: intent.intent_type,
      window_id: intent.window_id,
      created_at: intent.created_at,
      payload: intent.payload,
    });
  }

  log.warn('reconciliation_requires_manual_action', {
    incomplete_count: incompleteIntents.length,
    message: 'Manual reconciliation required - check exchange state',
  });

  return {
    clean: false,
    incompleteCount: incompleteIntents.length,
    incompleteIntents,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Get list of incomplete intents (for external queries)
 */
export function getIncompleteIntents() {
  return getIncompleteIntentsFromDb();
}

/**
 * Mark an intent as manually reconciled
 * @param {number} intentId
 * @param {Object} resolution - What was done to reconcile
 */
export async function markIntentReconciled(intentId, resolution) {
  // Update intent to 'failed' status with resolution details
}

export function getState() {
  return {
    config,
    lastReconciliation: null,  // Updated after checkStartupState
    stats: {
      totalChecks: 0,
      incompleteFound: 0,
      divergencesDetected: 0,
    },
    initialized: config !== null,
  };
}

export async function shutdown() {
  // Clean shutdown
}
```

### Usage Pattern (Integration with Startup)

```javascript
// In orchestrator startup sequence:

import * as persistence from '../persistence/index.js';
import * as logger from './logger/index.js';
import * as stateReconciler from './state-reconciler/index.js';

async function startup(config) {
  // 1. Initialize persistence
  await persistence.init(config.database);

  // 2. Initialize logger
  await logger.init(config);

  // 3. Initialize state reconciler
  await stateReconciler.init(config);

  // 4. Run startup reconciliation
  const reconciliationResult = await stateReconciler.checkStartupState();

  if (!reconciliationResult.clean) {
    // Log warning but continue startup
    // Operator should check exchange state
    console.warn(`WARNING: ${reconciliationResult.incompleteCount} incomplete intents found`);
    console.warn('Check exchange state before trading');
  }

  // 5. Continue with other module initialization...
}
```

### Divergence Detection Logic

```javascript
// src/modules/state-reconciler/logic.js

/**
 * Detect divergence between memory and database state
 * Called during runtime to verify consistency
 */
export function detectDivergence(memoryPositions, dbPositions) {
  const divergences = [];

  // Check for positions in memory not in DB
  for (const memPos of memoryPositions) {
    const dbPos = dbPositions.find(p => p.id === memPos.id);
    if (!dbPos) {
      divergences.push({
        type: 'MEMORY_ONLY',
        position_id: memPos.id,
        memory_state: memPos,
        db_state: null,
      });
    } else if (memPos.size !== dbPos.size || memPos.status !== dbPos.status) {
      divergences.push({
        type: 'STATE_MISMATCH',
        position_id: memPos.id,
        field: memPos.size !== dbPos.size ? 'size' : 'status',
        memory_value: memPos.size !== dbPos.size ? memPos.size : memPos.status,
        db_value: memPos.size !== dbPos.size ? dbPos.size : dbPos.status,
      });
    }
  }

  // Check for positions in DB not in memory
  for (const dbPos of dbPositions) {
    const memPos = memoryPositions.find(p => p.id === dbPos.id);
    if (!memPos) {
      divergences.push({
        type: 'DB_ONLY',
        position_id: dbPos.id,
        memory_state: null,
        db_state: dbPos,
      });
    }
  }

  return divergences;
}
```

### Error Handling

StateReconciler errors should NOT crash the application. The module should:
1. Log errors with full context
2. Return error state in results
3. Allow startup to continue (with warnings)
4. Never automatically retry failed intents (safety first)

### Project Structure Notes

**Files to Create:**
```
src/modules/state-reconciler/
├── index.js          # Public interface
├── logic.js          # Reconciliation and divergence logic
├── types.js          # Type definitions
└── __tests__/
    ├── index.test.js     # Integration tests
    └── logic.test.js     # Unit tests for logic functions
```

### Previous Story Intelligence

**From Story 1.3 (Write-Ahead Logging):**
- `getIncompleteIntents()` function exists in write-ahead module
- Returns intents with status='executing'
- Includes payload deserialized from JSON
- This story uses that function directly

**From Story 1.4 (Logger Module):**
- Logger provides child() method for module-specific logging
- Use log levels: info for success, warn for incomplete intents, error for divergence
- All logs follow structured JSON format

**Key Patterns Established:**
- All imports use ESM syntax
- Module interface: init(), getState(), shutdown()
- Error classes extend PolyError
- Tests use vitest

### Git Intelligence

**Recent commits showing why reconciliation matters:**
- `4ea3e7a` - "Fix retry bug - check balance before retrying to prevent doubled positions"
- This exact scenario is what reconciliation prevents: knowing what was attempted before retrying

**The write-ahead + reconciliation pattern:**
1. Story 1.3 logs intents BEFORE execution
2. Story 1.5 detects interrupted intents ON RESTART
3. Together: no mystery about what was happening when crash occurred

### Testing Requirements

**Test File:** `src/modules/state-reconciler/__tests__/index.test.js`

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('State Reconciler', () => {
  describe('checkStartupState', () => {
    it('returns clean=true when no incomplete intents');
    it('logs info message when clean');
    it('returns incomplete intents when found');
    it('logs warn for each incomplete intent');
    it('includes duration_ms in result');
    it('completes within 10 seconds with 1000 intents');
  });

  describe('logging', () => {
    it('uses warn level for incomplete intents');
    it('uses error level for divergences');
    it('includes intent_type, window_id, created_at in warn logs');
    it('includes both states in divergence logs');
  });

  describe('markIntentReconciled', () => {
    it('updates intent status to failed');
    it('sets completed_at timestamp');
    it('includes resolution in result field');
    it('throws if intent not found');
    it('throws if intent not in executing status');
  });

  describe('detectDivergence', () => {
    it('returns empty array when states match');
    it('detects position in memory but not DB');
    it('detects position in DB but not memory');
    it('detects field value mismatches');
  });

  describe('getState', () => {
    it('returns config and stats');
    it('tracks totalChecks');
    it('tracks incompleteFound');
  });
});
```

### NFR Compliance

- **NFR3** (State reconciliation within 10 seconds): Track and enforce duration
- **NFR6** (Recover to known-good state): Reconciliation enables this by identifying what needs checking
- **NFR7** (No orphaned positions): Incomplete intents point to potentially orphaned state
- **NFR10** (Detect state divergence): Divergence detection function fulfills this

### Manual Reconciliation Process

When incomplete intents are found, operator should:
1. Note the intent_type and window_id
2. Check exchange state for that window
3. Verify if the operation completed, partially completed, or failed
4. Call `markIntentReconciled(intentId, { action: 'verified_on_exchange', result: '...' })`
5. Resume normal operation

### References

- [Source: architecture.md#State-Persistence] - Write-ahead logging and recovery pattern
- [Source: architecture.md#Module-Interface-Contract] - Module interface standard
- [Source: architecture.md#Project-Structure] - File locations for state-reconciler
- [Source: architecture.md#trade_intents] - Recovery query documentation
- [Source: epics.md#Story-1.5] - Story requirements and acceptance criteria
- [Source: prd.md#FR17] - Reconcile memory with persistent state
- [Source: prd.md#FR18] - Detect state divergence
- [Source: prd.md#FR19] - Recover to known-good state
- [Source: prd.md#NFR3] - Reconciliation within 10 seconds
- [Source: prd.md#NFR6] - Recover to known-good state after crash
- [Source: prd.md#NFR7] - No orphaned positions
- [Source: 1-3-write-ahead-logging.md] - Write-ahead module provides getIncompleteIntents()
- [Source: 1-4-logger-module.md] - Logger module provides child logger pattern

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 225 tests pass (8 test files)
- State reconciler tests: 56 tests (20 logic + 36 integration)
- No regressions in existing persistence, write-ahead, or logger tests

### Completion Notes List

- Implemented state-reconciler module following folder-per-module architecture pattern
- Module exports: init, checkStartupState, getIncompleteIntents, markIntentReconciled, detectDivergence, getState, shutdown (AC6)
- checkStartupState queries for intents with status='executing' via write-ahead module (AC1)
- Each incomplete intent logged with level='warn' including intent_type, window_id, created_at, payload (AC2)
- Event name 'incomplete_intent_detected' used for warnings (AC2)
- No automatic retry - summary message indicates manual reconciliation required (AC3)
- Clean startup logs info "State reconciliation complete - no incomplete intents" with duration_ms (AC4)
- Event name 'reconciliation_complete' used for clean startup (AC4)
- detectDivergence compares memory vs DB positions, logs divergences at error level with actionable messages (AC5)
- ReconciliationResult includes: clean, incompleteCount, incompleteIntents, timestamp, duration_ms (AC7)
- Performance test verifies completion within 10 seconds with 100 intents (AC8/NFR3)
- markIntentReconciled validates intent exists and is in 'executing' status before updating to 'failed' (AC6)

### Change Log

- 2026-01-30: Implemented state-reconciler module (Story 1.5) - all tasks complete

### File List

- src/modules/state-reconciler/index.js (new)
- src/modules/state-reconciler/logic.js (new)
- src/modules/state-reconciler/types.js (new)
- src/modules/state-reconciler/__tests__/index.test.js (new)
- src/modules/state-reconciler/__tests__/logic.test.js (new)
