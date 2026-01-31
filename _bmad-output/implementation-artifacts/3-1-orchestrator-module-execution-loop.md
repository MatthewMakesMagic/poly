# Story 3.1: Orchestrator Module & Execution Loop

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **a central coordinator running the execution loop**,
So that **all modules work together without coupling to each other (FR1)**.

## Acceptance Criteria

### AC1: Module Initialization Order

**Given** the system starts
**When** orchestrator.init(config) is called
**Then** all modules are initialized in correct dependency order:
  1. logger (already initialized by app entry)
  2. persistence (database connection)
  3. polymarket client (API authentication)
  4. spot client (price feeds)
  5. position-manager (loads existing positions)
  6. order-manager (loads open orders)
  7. strategy modules (future stories)
**And** each module receives its config via init()
**And** initialization failures are logged and surfaced (not swallowed)

### AC2: Orchestrator Pattern Enforcement

**Given** the orchestrator is the central coordinator
**When** modules need to interact
**Then** all coordination flows through the orchestrator
**And** modules NEVER import each other directly
**And** orchestrator holds references to all module instances

### AC3: Execution Loop Skeleton

**Given** trading windows are active
**When** the execution loop runs
**Then** market data is fetched via spot client on each tick
**And** the loop respects configured tick interval (default 1s)
**And** the loop can be started, stopped, and paused
**And** each iteration is logged at debug level

### AC4: Error Handling in Orchestrator

**Given** an error occurs in any module
**When** the error propagates to orchestrator
**Then** it is logged with full context including module name, operation, and stack
**And** the orchestrator categorizes errors as: recoverable (retry) vs fatal (shutdown)
**And** recoverable errors trigger retry with exponential backoff
**And** fatal errors trigger graceful shutdown
**And** errors are NEVER swallowed silently

### AC5: Graceful Shutdown Sequence

**Given** shutdown is requested
**When** orchestrator.shutdown() is called
**Then** execution loop is stopped immediately (no new iterations)
**And** in-flight operations are allowed to complete (with timeout)
**And** all modules are shut down in reverse initialization order
**And** each module's shutdown() is awaited with timeout
**And** graceful completion is logged
**And** if module shutdown hangs, forced shutdown after timeout

### AC6: Module Interface Export

**Given** the orchestrator module
**When** inspecting its interface
**Then** it exports: init(), start(), stop(), pause(), resume(), getState(), shutdown()
**And** getState() returns: initialized, running, paused, modules (with their states)

### AC7: Health Check Support

**Given** the orchestrator is running
**When** getState() is called
**Then** it returns health status for each module
**And** identifies any modules in error state
**And** reports loop iteration count and last tick timestamp

## Tasks / Subtasks

- [x] **Task 1: Create Orchestrator Module Structure** (AC: 2, 6)
  - [x] 1.1 Create `src/modules/orchestrator/` directory
  - [x] 1.2 Create `index.js` with standard module interface
  - [x] 1.3 Create `types.js` with OrchestratorError and error codes
  - [x] 1.4 Create `state.js` for module references and loop state
  - [x] 1.5 Create `execution-loop.js` for main loop logic

- [x] **Task 2: Implement Module Initialization** (AC: 1, 2)
  - [x] 2.1 Define MODULE_INIT_ORDER constant with dependency sequence
  - [x] 2.2 Create initializeModules() function that initializes in order
  - [x] 2.3 Pass appropriate config slice to each module's init()
  - [x] 2.4 Store module references in state for later coordination
  - [x] 2.5 Handle initialization errors with proper logging
  - [x] 2.6 Add timeout for module initialization (default 5000ms)

- [x] **Task 3: Implement Execution Loop** (AC: 3)
  - [x] 3.1 Create ExecutionLoop class with start/stop/pause/resume
  - [x] 3.2 Implement configurable tick interval (config.orchestrator.tickIntervalMs)
  - [x] 3.3 Add tick counter and lastTickAt timestamp
  - [x] 3.4 Create processTick() skeleton that fetches spot price
  - [x] 3.5 Log each tick at debug level with iteration count
  - [x] 3.6 Prevent concurrent tick execution (guard against slow ticks)

- [x] **Task 4: Implement Error Handling** (AC: 4)
  - [x] 4.1 Create error categorization: RECOVERABLE vs FATAL error types
  - [x] 4.2 Define which errors are recoverable (API timeouts, transient failures)
  - [x] 4.3 Define which errors are fatal (auth failures, database corruption)
  - [x] 4.4 Implement exponential backoff for recoverable errors
  - [x] 4.5 Implement automatic shutdown trigger for fatal errors
  - [x] 4.6 Create error event emission for external monitoring

- [x] **Task 5: Implement Shutdown Sequence** (AC: 5)
  - [x] 5.1 Create shutdownModules() function with reverse order
  - [x] 5.2 Stop execution loop before module shutdown
  - [x] 5.3 Await in-flight operations with configurable timeout
  - [x] 5.4 Call each module's shutdown() with individual timeout
  - [x] 5.5 Force shutdown after module timeout (log warning)
  - [x] 5.6 Clean up all state on completion

- [x] **Task 6: Implement getState()** (AC: 6, 7)
  - [x] 6.1 Return initialized, running, paused status
  - [x] 6.2 Aggregate getState() from each module
  - [x] 6.3 Include loop metrics: tickCount, lastTickAt, tickIntervalMs
  - [x] 6.4 Include error metrics: lastError, errorCount, recoveryCount

- [x] **Task 7: Update Configuration** (AC: 1, 3, 4, 5)
  - [x] 7.1 Add orchestrator section to config/default.js
  - [x] 7.2 Add tickIntervalMs (default 1000)
  - [x] 7.3 Add moduleInitTimeoutMs (default 5000)
  - [x] 7.4 Add moduleShutdownTimeoutMs (default 5000)
  - [x] 7.5 Add maxRetryAttempts (default 3)
  - [x] 7.6 Add retryBackoffMs (default 1000)

- [x] **Task 8: Write Tests** (AC: all)
  - [x] 8.1 Test init() initializes modules in correct order
  - [x] 8.2 Test init() handles module initialization failure
  - [x] 8.3 Test start() begins execution loop
  - [x] 8.4 Test stop() halts execution loop
  - [x] 8.5 Test pause() suspends but doesn't stop loop
  - [x] 8.6 Test resume() continues paused loop
  - [x] 8.7 Test recoverable error triggers retry with backoff
  - [x] 8.8 Test fatal error triggers shutdown
  - [x] 8.9 Test shutdown() calls modules in reverse order
  - [x] 8.10 Test shutdown() respects timeout for hung modules
  - [x] 8.11 Test getState() returns complete status
  - [x] 8.12 Test tick execution doesn't overlap

## Dev Notes

### Architecture Compliance

This story creates the central orchestrator that coordinates all modules. It is the ONLY component that knows about other modules - modules never import each other directly.

**From architecture.md#Inter-Module-Communication:**
> "Orchestrator pattern - modules never import each other directly. All coordination goes through orchestrator. Orchestrator is the only 'aware' component."

**From architecture.md#Core-Architectural-Decisions:**
```
Orchestrator
    ├── calls → PositionManager
    ├── calls → StopLoss
    ├── calls → OrderManager
    ├── calls → Logger
    └── calls → StateReconciler
```

### Project Structure Notes

**Module location:** `src/modules/orchestrator/`

Create these files:
```
src/modules/orchestrator/
├── index.js          # Public interface (init, start, stop, pause, resume, getState, shutdown)
├── execution-loop.js # Main execution loop logic
├── state.js          # Module references and loop state
├── types.js          # OrchestratorError and error codes
└── __tests__/
    ├── index.test.js        # Integration tests for full orchestrator
    └── execution-loop.test.js  # Unit tests for loop logic
```

### Module Initialization Order

The initialization order is critical for dependencies:

```javascript
// src/modules/orchestrator/state.js

export const MODULE_INIT_ORDER = [
  // 1. Logger is initialized before orchestrator by app entry point
  // 2. Persistence needed for write-ahead logging
  { name: 'persistence', module: null, configKey: 'database' },
  // 3. Polymarket client for API access
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  // 4. Spot client for price feeds
  { name: 'spot', module: null, configKey: 'spot' },
  // 5. Position manager (depends on persistence, uses polymarket for reconcile)
  { name: 'position-manager', module: null, configKey: null },
  // 6. Order manager (depends on persistence, polymarket)
  { name: 'order-manager', module: null, configKey: null },
  // Future: strategy modules go here
];
```

### Execution Loop Implementation

```javascript
// src/modules/orchestrator/execution-loop.js

/**
 * Execution Loop - Main trading loop coordinator
 *
 * States:
 * - stopped: Loop not running
 * - running: Loop actively processing ticks
 * - paused: Loop suspended (can resume without reinit)
 */
export class ExecutionLoop {
  constructor(config, modules, log) {
    this.config = config;
    this.modules = modules;
    this.log = log;

    this.state = 'stopped';
    this.tickCount = 0;
    this.lastTickAt = null;
    this.tickInProgress = false;
    this.intervalId = null;
  }

  start() {
    if (this.state === 'running') {
      return; // Already running
    }

    this.state = 'running';
    this.log.info('execution_loop_started', {
      tickIntervalMs: this.config.tickIntervalMs,
    });

    // Start the interval
    this.intervalId = setInterval(
      () => this._onTick(),
      this.config.tickIntervalMs
    );

    // Immediate first tick
    this._onTick();
  }

  async _onTick() {
    if (this.state !== 'running') {
      return;
    }

    // Guard against overlapping ticks
    if (this.tickInProgress) {
      this.log.warn('tick_skipped_overlap', { tickCount: this.tickCount });
      return;
    }

    this.tickInProgress = true;
    const tickStart = Date.now();

    try {
      this.tickCount++;
      this.lastTickAt = new Date().toISOString();

      this.log.debug('tick_start', { tickCount: this.tickCount });

      // 1. Fetch current spot price
      const spotPrice = await this.modules.spot.getCurrentPrice();

      // 2. Future: Evaluate strategy entry conditions
      // 3. Future: Evaluate exit conditions (stop-loss, take-profit)
      // 4. Future: Process any pending orders

      const tickDurationMs = Date.now() - tickStart;
      this.log.debug('tick_complete', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        spotPrice,
      });

    } catch (err) {
      this.log.error('tick_error', {
        tickCount: this.tickCount,
        error: err.message,
        code: err.code,
      });

      // Emit error event for orchestrator to handle
      this._emitError(err);

    } finally {
      this.tickInProgress = false;
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.state = 'stopped';
    this.log.info('execution_loop_stopped', { tickCount: this.tickCount });
  }

  pause() {
    this.state = 'paused';
    this.log.info('execution_loop_paused', { tickCount: this.tickCount });
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'running';
      this.log.info('execution_loop_resumed', { tickCount: this.tickCount });
    }
  }

  getState() {
    return {
      state: this.state,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      tickInProgress: this.tickInProgress,
    };
  }
}
```

### Error Handling Strategy

```javascript
// src/modules/orchestrator/types.js

export const ErrorCategory = {
  RECOVERABLE: 'recoverable',  // Retry with backoff
  FATAL: 'fatal',              // Trigger shutdown
};

// Categorize errors by code
export function categorizeError(error) {
  const fatalCodes = [
    'AUTH_FAILED',
    'DATABASE_CORRUPTED',
    'CONFIG_INVALID',
    'PERSISTENCE_INIT_FAILED',
  ];

  const recoverableCodes = [
    'API_TIMEOUT',
    'RATE_LIMIT',
    'CONNECTION_LOST',
    'SPOT_DISCONNECTED',
  ];

  if (fatalCodes.includes(error.code)) {
    return ErrorCategory.FATAL;
  }

  if (recoverableCodes.includes(error.code)) {
    return ErrorCategory.RECOVERABLE;
  }

  // Default: treat unknown errors as recoverable
  return ErrorCategory.RECOVERABLE;
}

export const OrchestratorErrorCodes = {
  NOT_INITIALIZED: 'ORCHESTRATOR_NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'ORCHESTRATOR_ALREADY_INITIALIZED',
  MODULE_INIT_FAILED: 'MODULE_INIT_FAILED',
  MODULE_SHUTDOWN_FAILED: 'MODULE_SHUTDOWN_FAILED',
  LOOP_ERROR: 'EXECUTION_LOOP_ERROR',
  FATAL_ERROR: 'ORCHESTRATOR_FATAL_ERROR',
};
```

### Shutdown Sequence

```javascript
// src/modules/orchestrator/index.js (partial)

async function shutdown() {
  log.info('orchestrator_shutdown_start');

  // 1. Stop execution loop immediately
  if (executionLoop) {
    executionLoop.stop();
  }

  // 2. Wait for any in-flight operations
  if (state.inFlightOperations > 0) {
    log.info('waiting_for_inflight', { count: state.inFlightOperations });
    await waitForInflight(config.orchestrator.moduleShutdownTimeoutMs);
  }

  // 3. Shutdown modules in reverse order
  const reverseOrder = [...MODULE_INIT_ORDER].reverse();

  for (const entry of reverseOrder) {
    if (entry.module && typeof entry.module.shutdown === 'function') {
      try {
        log.info('module_shutdown', { module: entry.name });
        await withTimeout(
          entry.module.shutdown(),
          config.orchestrator.moduleShutdownTimeoutMs,
          `${entry.name} shutdown timeout`
        );
      } catch (err) {
        log.warn('module_shutdown_timeout', {
          module: entry.name,
          error: err.message
        });
        // Continue with other modules - don't let one block the rest
      }
    }
  }

  // 4. Clean up orchestrator state
  state = initialState();
  initialized = false;

  log.info('orchestrator_shutdown_complete');
}
```

### Configuration Extension

Add to `config/default.js`:

```javascript
// Orchestrator configuration
orchestrator: {
  tickIntervalMs: 1000,           // 1 second between ticks
  moduleInitTimeoutMs: 5000,      // 5 seconds per module init
  moduleShutdownTimeoutMs: 5000,  // 5 seconds per module shutdown
  maxRetryAttempts: 3,            // Retries for recoverable errors
  retryBackoffMs: 1000,           // Base backoff (doubles each retry)
  inflightTimeoutMs: 10000,       // Max wait for in-flight ops
},
```

### Dependencies

**Existing modules coordinated:**
- `src/modules/logger/index.js` - Structured logging (already initialized)
- `src/persistence/index.js` - Database access and write-ahead
- `src/clients/polymarket/index.js` - Polymarket API client
- `src/clients/spot/index.js` - Spot price feed client
- `src/modules/position-manager/index.js` - Position tracking
- `src/modules/order-manager/index.js` - Order lifecycle

**New utility needed:**
```javascript
// Timeout wrapper for async operations
async function withTimeout(promise, ms, errorMessage) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeout]);
}
```

### Testing Patterns

Follow established vitest patterns:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as orchestrator from '../index.js';

// Mock all module dependencies
vi.mock('../../persistence/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../../clients/polymarket/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

// ... mock other modules

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  describe('init', () => {
    it('should initialize modules in correct order', async () => {
      const initOrder = [];
      persistence.init.mockImplementation(() => {
        initOrder.push('persistence');
        return Promise.resolve();
      });
      polymarket.init.mockImplementation(() => {
        initOrder.push('polymarket');
        return Promise.resolve();
      });
      // ... etc

      await orchestrator.init(mockConfig);

      expect(initOrder).toEqual([
        'persistence',
        'polymarket',
        'spot',
        'position-manager',
        'order-manager'
      ]);
    });
  });
});
```

### Previous Story Intelligence

**Patterns established in Epic 2:**
- All modules follow init(config), getState(), shutdown() interface
- Child logger via `child({ module: 'module-name' })`
- Write-ahead logging for state changes
- ensureInitialized() guard pattern
- Error classes with codes and context

**Key learnings from Story 2.6:**
- Test count at 489 - maintain or increase
- Position manager has reconcile() for exchange state sync
- closePosition() with emergency flag for urgent exits
- Module state includes limits and lastReconciliation

### Git Intelligence

**Recent commits:**
```
b99844d Add code review helper scripts
e8b1d8a Fix code review issues for story 2-6 position-manager-reconciliation-limits
d4545dc Fix code review issues for story 2-5 position-manager-track-positions
```

**Epic 2 established these patterns:**
- Module files: index.js, logic.js, state.js, types.js
- Test files in `__tests__/` folder
- Import from logger via child()
- Import persistence for database access
- Write-ahead logging before state changes

### NFR Compliance

- **FR1** (Execute strategies against live windows): Execution loop provides the framework
- **NFR1** (Order placement in 500ms): Loop design allows fast tick processing
- **NFR6** (Recover to known-good state): Orchestrator manages startup recovery via modules
- **NFR14** (Handle API disconnects): Error categorization enables reconnect logic

### Integration Notes

**This story creates the skeleton - future stories fill in:**
- Story 3.2: Strategy entry evaluation logic in processTick()
- Story 3.3: Position sizing integration
- Stories 3.4-3.5: Stop-loss and take-profit module coordination
- Story 3.6: Window expiry handling

**Orchestrator will coordinate these modules once created:**
- stop-loss/ (Story 3.4)
- take-profit/ (Story 3.5)
- strategy/ (Epic 6)
- safety/ (Epic 4)

### References

- [Source: architecture.md#Inter-Module-Communication] - Orchestrator pattern definition
- [Source: architecture.md#Module-Architecture] - Folder-per-module structure
- [Source: architecture.md#Module-Interface-Contract] - init, getState, shutdown requirement
- [Source: architecture.md#Project-Structure-Boundaries] - Complete directory structure
- [Source: architecture.md#Error-Handling-Pattern] - Typed errors with context
- [Source: epics.md#Story-3.1] - Story requirements
- [Source: prd.md#FR1] - System can execute trading strategies
- [Source: config/default.js] - Existing configuration patterns
- [Source: 2-6-position-manager-reconciliation-limits.md] - Previous story patterns
- [Source: src/modules/_template/index.js] - Module template reference

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - implementation proceeded without blockers

### Completion Notes List

- ✅ Created orchestrator module structure following established patterns
- ✅ Implemented module initialization in dependency order (persistence → polymarket → spot → position-manager → order-manager)
- ✅ Implemented ExecutionLoop class with start/stop/pause/resume functionality
- ✅ Added error categorization (RECOVERABLE vs FATAL) with automatic shutdown for fatal errors
- ✅ Implemented graceful shutdown in reverse initialization order with configurable timeouts
- ✅ getState() aggregates all module states and loop metrics
- ✅ Added orchestrator configuration to config/default.js
- ✅ All 52 orchestrator tests pass
- ✅ Full test suite (602 tests) passes with no regressions
- ✅ All acceptance criteria satisfied

### File List

**New files:**
- src/modules/orchestrator/index.js
- src/modules/orchestrator/types.js
- src/modules/orchestrator/state.js
- src/modules/orchestrator/execution-loop.js
- src/modules/orchestrator/__tests__/index.test.js
- src/modules/orchestrator/__tests__/execution-loop.test.js

**Modified files:**
- config/default.js

## Change Log

- 2026-01-31: Story 3.1 implementation complete - Created orchestrator module with execution loop, module coordination, error handling, and graceful shutdown

