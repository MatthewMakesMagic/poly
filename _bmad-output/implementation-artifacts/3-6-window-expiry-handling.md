# Story 3.6: Window Expiry Handling

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **15-minute window expiry handled correctly**,
So that **positions resolve properly at window end and I have accurate P&L on resolution (FR3)**.

## Acceptance Criteria

### AC1: Window Expiry Warning Detection

**Given** a position is open in a window
**When** the window approaches expiry (configurable, e.g., 30 seconds remaining)
**Then** the system logs "Window expiring soon" with position details
**And** log includes: position_id, window_id, time_remaining_ms, entry_price, current_price
**And** no new positions are opened in this window after the warning threshold

### AC2: Window Resolution Detection

**Given** a window expires
**When** resolution occurs (window time reaches end)
**Then** position outcome is determined by resolution (win/lose based on final resolved price)
**And** position status is updated to 'closed' (or new status 'resolved' if desired)
**And** pnl is calculated based on resolution outcome
**And** close_price is set to resolution price (0 or 1 for binary outcomes)

### AC3: Window Timing Awareness

**Given** the system is tracking window timing
**When** evaluating trades
**Then** time remaining in window is always known
**And** this is logged with every trade decision
**And** entry is blocked if time remaining < configured minTimeRemainingMs

### AC4: Position Resolution Recording

**Given** a position exists at expiry
**When** the window resolves
**Then** the resolution price/outcome is recorded
**And** the event is logged with full details: position_id, window_id, resolution_price, outcome (win/lose), pnl
**And** the position is marked closed with reason='window_expiry'

### AC5: Module Interface Compliance

**Given** the window-expiry module
**When** inspecting its interface
**Then** it exports: init(), checkExpiry(positions, windowData), evaluateAll(positions, getWindowData), getState(), shutdown()
**And** checkExpiry() returns: { expiring: WindowExpiryResult[], resolved: WindowExpiryResult[] }
**And** module follows standard interface contract from architecture

### AC6: Configuration Support

**Given** window expiry configuration
**When** reading from config
**Then** window duration is configurable (default 15 minutes = 900000ms)
**And** expiry warning threshold is configurable (default 30 seconds = 30000ms)
**And** minimum time remaining to enter is configurable (default 60 seconds = 60000ms)
**And** validation rejects invalid durations at init time

### AC7: Integration with Orchestrator Tick Cycle

**Given** the execution loop is running
**When** a tick occurs
**Then** window-expiry module evaluates all open positions (after take-profit evaluation)
**And** expiring windows trigger warning logs and block new entries
**And** resolved windows trigger position closure with proper P&L calculation
**And** results flow to position-manager for state updates

## Tasks / Subtasks

- [x] **Task 1: Create Window-Expiry Module Structure** (AC: 5)
  - [x] 1.1 Create `src/modules/window-expiry/` directory
  - [x] 1.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 1.3 Create `types.js` with WindowExpiryResult, WindowExpiryError, ExpiryReason
  - [x] 1.4 Create `state.js` for tracking evaluation statistics
  - [x] 1.5 Create `logic.js` for core window expiry calculations

- [x] **Task 2: Implement Window Time Calculation** (AC: 3)
  - [x] 2.1 Create calculateTimeRemaining(windowId, windowData) function
  - [x] 2.2 Parse window_id to extract window start time (format: e.g., "btc-15m-2026-01-31-10:00")
  - [x] 2.3 Calculate end_time = start_time + windowDurationMs
  - [x] 2.4 Return { time_remaining_ms, is_expiring, is_resolved, window_end_time }
  - [x] 2.5 Handle edge cases (invalid window_id format, already resolved)

- [x] **Task 3: Implement Expiry Warning Detection** (AC: 1)
  - [x] 3.1 Create checkExpiry(position, windowData, options) function
  - [x] 3.2 Calculate time_remaining_ms for the position's window
  - [x] 3.3 Detect "expiring soon" if time_remaining_ms <= expiryWarningThresholdMs AND time_remaining_ms > 0
  - [x] 3.4 Return WindowExpiryResult with expiring: true, reason, time_remaining_ms
  - [x] 3.5 Log at info level when expiring, debug level when safe

- [x] **Task 4: Implement Resolution Detection** (AC: 2, 4)
  - [x] 4.1 Detect resolution if time_remaining_ms <= 0
  - [x] 4.2 Determine resolution outcome from window data (resolved_price: 0 or 1 for binary)
  - [x] 4.3 Calculate P&L based on position side and resolution:
        - Long position: pnl = size * (resolution_price - entry_price)
        - Short position: pnl = size * (entry_price - resolution_price)
  - [x] 4.4 Return WindowExpiryResult with resolved: true, outcome, pnl, resolution_price
  - [x] 4.5 Log resolution with full diagnostic details

- [x] **Task 5: Implement Batch Evaluation** (AC: 7)
  - [x] 5.1 Create evaluateAll(positions, getWindowData) function
  - [x] 5.2 Iterate over all positions and call checkExpiry() for each
  - [x] 5.3 Separate results into { expiring: [], resolved: [] }
  - [x] 5.4 Log summary: total_evaluated, expiring_count, resolved_count
  - [x] 5.5 Return categorized results for orchestrator handling

- [x] **Task 6: Implement Entry Blocking Logic** (AC: 3)
  - [x] 6.1 Create canEnterWindow(windowId, windowData, options) function
  - [x] 6.2 Return false if time_remaining_ms < minTimeRemainingMs
  - [x] 6.3 Return { allowed: boolean, reason: string, time_remaining_ms }
  - [x] 6.4 Log rejection reason if entry blocked
  - [x] 6.5 Integrate check into strategy evaluator entry flow (via orchestrator)

- [x] **Task 7: Add Configuration** (AC: 6)
  - [x] 7.1 Verify trading.windowDurationMs exists in config/default.js (15 * 60 * 1000)
  - [x] 7.2 Verify trading.minTimeRemainingMs exists in config/default.js (60 * 1000)
  - [x] 7.3 Add strategy.windowExpiry section to config/default.js
  - [x] 7.4 Add expiryWarningThresholdMs (default: 30000 = 30 seconds)
  - [x] 7.5 Add enabled flag (default: true)
  - [x] 7.6 Validate config values at init time

- [x] **Task 8: Integrate with Orchestrator** (AC: 7)
  - [x] 8.1 Add window-expiry to MODULE_INIT_ORDER in orchestrator/state.js (after take-profit)
  - [x] 8.2 Add window-expiry to MODULE_MAP in orchestrator/index.js
  - [x] 8.3 Update execution-loop.js to call evaluateAll() after take-profit evaluation
  - [x] 8.4 For expiring positions: log warning, set flag to block new entries
  - [x] 8.5 For resolved positions: call position-manager.closePosition(id, { closePrice, reason: 'window_expiry', resolution_outcome })
  - [x] 8.6 Log position resolution results

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Test calculateTimeRemaining() with various window_id formats
  - [x] 9.2 Test calculateTimeRemaining() edge cases (invalid format, past windows)
  - [x] 9.3 Test checkExpiry() detects expiring windows correctly
  - [x] 9.4 Test checkExpiry() detects resolved windows correctly
  - [x] 9.5 Test P&L calculation for long position resolution (win and lose)
  - [x] 9.6 Test P&L calculation for short position resolution (win and lose)
  - [x] 9.7 Test evaluateAll() processes multiple positions
  - [x] 9.8 Test evaluateAll() separates expiring vs resolved correctly
  - [x] 9.9 Test canEnterWindow() blocks entry when time remaining too low
  - [x] 9.10 Test config validation rejects invalid durations
  - [x] 9.11 Test integration with orchestrator tick cycle
  - [x] 9.12 Test module exports standard interface

## Dev Notes

### Architecture Compliance

This story creates the window-expiry module that handles 15-minute window timing for position resolution during each tick. It's part of the exit condition evaluation flow (FR3).

**From architecture.md#Inter-Module-Communication:**
> "Orchestrator pattern - modules never import each other directly. All coordination flows through orchestrator."

The window-expiry module receives position data and window timing data from orchestrator, and returns evaluation results. It never directly calls position-manager or order-manager.

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  getState: () => {},
  shutdown: async () => {}
};
```

**From architecture.md#Project-Structure:**
```
src/modules/
  window-expiry/        # NEW MODULE (not in original architecture)
    index.js          # Public interface
    logic.js          # Window timing and resolution logic
    types.js          # WindowExpiryResult, WindowExpiryError
    state.js          # Evaluation statistics
    __tests__/
        logic.test.js
        index.test.js
```

### Project Structure Notes

**Module location:** `src/modules/window-expiry/`

Create these files:
```
src/modules/window-expiry/
├── index.js          # Public interface (init, checkExpiry, evaluateAll, canEnterWindow, getState, shutdown)
├── logic.js          # Core window timing calculations
├── state.js          # Evaluation statistics tracking
├── types.js          # WindowExpiryResult, WindowExpiryError, ExpiryReason, Resolution
└── __tests__/
    ├── index.test.js        # Integration tests
    └── logic.test.js        # Unit tests for window timing calculations
```

### WindowExpiryResult Type

```javascript
// src/modules/window-expiry/types.js

/**
 * Expiry/resolution reasons
 */
export const ExpiryReason = {
  WINDOW_EXPIRING: 'window_expiring',      // Warning threshold reached
  WINDOW_RESOLVED: 'window_resolved',      // Window time ended
  SAFE: 'safe',                            // Window has plenty of time
};

/**
 * Resolution outcomes for binary options
 */
export const Resolution = {
  WIN: 'win',   // Position side matched resolution
  LOSE: 'lose', // Position side did not match resolution
};

/**
 * Window expiry evaluation result
 */
export function createWindowExpiryResult({
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  // Timing
  window_start_time = '',
  window_end_time = '',
  time_remaining_ms = 0,
  // Status
  is_expiring = false,
  is_resolved = false,
  reason = ExpiryReason.SAFE,
  // Resolution details (only if resolved)
  resolution_price = null,    // 0 or 1 for binary
  outcome = null,             // 'win' or 'lose'
  pnl = 0,
  pnl_pct = 0,
  // Metadata
  evaluated_at = '',
} = {}) {
  return {
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    window_start_time,
    window_end_time,
    time_remaining_ms,
    is_expiring,
    is_resolved,
    reason,
    resolution_price,
    outcome,
    pnl,
    pnl_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}

/**
 * Window expiry error codes
 */
export const WindowExpiryErrorCodes = {
  NOT_INITIALIZED: 'WINDOW_EXPIRY_NOT_INITIALIZED',
  INVALID_WINDOW_ID: 'INVALID_WINDOW_ID',
  INVALID_POSITION: 'INVALID_POSITION',
  CONFIG_INVALID: 'WINDOW_EXPIRY_CONFIG_INVALID',
  EVALUATION_FAILED: 'WINDOW_EXPIRY_EVALUATION_FAILED',
  RESOLUTION_FAILED: 'WINDOW_RESOLUTION_FAILED',
};

export class WindowExpiryError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'WindowExpiryError';
    this.code = code;
    this.context = context;
  }
}
```

### Window ID Parsing

Windows follow the format: `{asset}-{duration}-{date}-{time}`

Example: `btc-15m-2026-01-31-10:00`
- asset: btc
- duration: 15m (15 minutes)
- date: 2026-01-31
- time: 10:00 (window start time, 24-hour format)

```javascript
/**
 * Parse window_id to extract timing information
 *
 * @param {string} windowId - Window identifier (e.g., "btc-15m-2026-01-31-10:00")
 * @param {Object} options - Options
 * @param {number} options.windowDurationMs - Window duration in milliseconds
 * @returns {Object} { start_time, end_time, duration_ms, is_valid }
 */
export function parseWindowId(windowId, options = {}) {
  const { windowDurationMs = 15 * 60 * 1000 } = options;

  // Expected format: {asset}-{duration}-{date}-{time}
  // Example: btc-15m-2026-01-31-10:00
  const pattern = /^([a-z]+)-(\d+m)-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/i;
  const match = windowId.match(pattern);

  if (!match) {
    return {
      is_valid: false,
      error: 'Invalid window_id format',
      start_time: null,
      end_time: null,
      duration_ms: windowDurationMs,
    };
  }

  const [, asset, duration, date, time] = match;

  // Parse start time
  const startTimeStr = `${date}T${time}:00.000Z`;
  const startTime = new Date(startTimeStr);

  if (isNaN(startTime.getTime())) {
    return {
      is_valid: false,
      error: 'Invalid date/time in window_id',
      start_time: null,
      end_time: null,
      duration_ms: windowDurationMs,
    };
  }

  const endTime = new Date(startTime.getTime() + windowDurationMs);

  return {
    is_valid: true,
    asset,
    duration,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    duration_ms: windowDurationMs,
  };
}
```

### Window Timing Logic

```javascript
// src/modules/window-expiry/logic.js

import { ExpiryReason, Resolution, createWindowExpiryResult, WindowExpiryError, WindowExpiryErrorCodes } from './types.js';
import { incrementEvaluations, incrementExpiring, incrementResolved } from './state.js';

/**
 * Calculate time remaining in a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} options - Options
 * @param {number} options.windowDurationMs - Window duration in ms (default: 15 min)
 * @param {Date} options.now - Current time (for testing)
 * @returns {Object} { time_remaining_ms, is_expiring, is_resolved, window_end_time }
 */
export function calculateTimeRemaining(windowId, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    expiryWarningThresholdMs = 30 * 1000,
    now = new Date(),
  } = options;

  const parsed = parseWindowId(windowId, { windowDurationMs });

  if (!parsed.is_valid) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.INVALID_WINDOW_ID,
      parsed.error,
      { window_id: windowId }
    );
  }

  const endTime = new Date(parsed.end_time);
  const time_remaining_ms = endTime.getTime() - now.getTime();

  return {
    time_remaining_ms,
    is_expiring: time_remaining_ms > 0 && time_remaining_ms <= expiryWarningThresholdMs,
    is_resolved: time_remaining_ms <= 0,
    window_start_time: parsed.start_time,
    window_end_time: parsed.end_time,
  };
}

/**
 * Check if a position's window is expiring or resolved
 *
 * @param {Object} position - Position to check
 * @param {Object} windowData - Optional window resolution data
 * @param {Object} options - Evaluation options
 * @returns {Object} WindowExpiryResult
 */
export function checkExpiry(position, windowData = {}, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    expiryWarningThresholdMs = 30 * 1000,
    log,
    now = new Date(),
  } = options;

  incrementEvaluations();

  const timing = calculateTimeRemaining(position.window_id, {
    windowDurationMs,
    expiryWarningThresholdMs,
    now,
  });

  let is_expiring = timing.is_expiring;
  let is_resolved = timing.is_resolved;
  let reason = ExpiryReason.SAFE;
  let resolution_price = null;
  let outcome = null;
  let pnl = 0;
  let pnl_pct = 0;

  if (is_resolved) {
    reason = ExpiryReason.WINDOW_RESOLVED;
    incrementResolved();

    // Get resolution price from window data (0 or 1 for binary options)
    resolution_price = windowData.resolution_price ?? null;

    if (resolution_price !== null) {
      // Calculate outcome and P&L
      if (position.side === 'long') {
        // Long position wins if resolution is 1 (YES won)
        outcome = resolution_price === 1 ? Resolution.WIN : Resolution.LOSE;
        pnl = position.size * (resolution_price - position.entry_price);
      } else {
        // Short position wins if resolution is 0 (NO won / YES lost)
        outcome = resolution_price === 0 ? Resolution.WIN : Resolution.LOSE;
        pnl = position.size * (position.entry_price - resolution_price);
      }
      pnl_pct = pnl / (position.size * position.entry_price);
    }

    if (log) {
      log.info('window_resolved', {
        position_id: position.id,
        window_id: position.window_id,
        side: position.side,
        entry_price: position.entry_price,
        resolution_price,
        outcome,
        pnl,
        pnl_pct,
      });
    }
  } else if (is_expiring) {
    reason = ExpiryReason.WINDOW_EXPIRING;
    incrementExpiring();

    if (log) {
      log.info('window_expiring_soon', {
        position_id: position.id,
        window_id: position.window_id,
        time_remaining_ms: timing.time_remaining_ms,
        entry_price: position.entry_price,
        current_price: position.current_price,
      });
    }
  } else {
    // Safe - plenty of time remaining
    if (log) {
      log.debug('window_expiry_checked', {
        position_id: position.id,
        window_id: position.window_id,
        time_remaining_ms: timing.time_remaining_ms,
      });
    }
  }

  return createWindowExpiryResult({
    position_id: position.id,
    window_id: position.window_id,
    side: position.side,
    entry_price: position.entry_price,
    current_price: position.current_price,
    window_start_time: timing.window_start_time,
    window_end_time: timing.window_end_time,
    time_remaining_ms: timing.time_remaining_ms,
    is_expiring,
    is_resolved,
    reason,
    resolution_price,
    outcome,
    pnl,
    pnl_pct,
  });
}

/**
 * Check if entry is allowed for a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} options - Options
 * @param {number} options.minTimeRemainingMs - Minimum time required
 * @returns {Object} { allowed: boolean, reason: string, time_remaining_ms }
 */
export function canEnterWindow(windowId, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    minTimeRemainingMs = 60 * 1000,
    log,
    now = new Date(),
  } = options;

  try {
    const timing = calculateTimeRemaining(windowId, {
      windowDurationMs,
      now,
    });

    const allowed = timing.time_remaining_ms >= minTimeRemainingMs;
    const reason = allowed
      ? 'sufficient_time_remaining'
      : `insufficient_time_remaining: ${timing.time_remaining_ms}ms < ${minTimeRemainingMs}ms required`;

    if (!allowed && log) {
      log.info('entry_blocked_expiry', {
        window_id: windowId,
        time_remaining_ms: timing.time_remaining_ms,
        min_required_ms: minTimeRemainingMs,
      });
    }

    return {
      allowed,
      reason,
      time_remaining_ms: timing.time_remaining_ms,
    };
  } catch (err) {
    return {
      allowed: false,
      reason: `window_id_error: ${err.message}`,
      time_remaining_ms: 0,
    };
  }
}

/**
 * Evaluate window expiry for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getWindowData - Function to get window data (resolution info)
 * @param {Object} options - Evaluation options
 * @returns {Object} { expiring: WindowExpiryResult[], resolved: WindowExpiryResult[], summary }
 */
export function evaluateAll(positions, getWindowData, options = {}) {
  const { log } = options;
  const expiring = [];
  const resolved = [];
  let evaluatedCount = 0;

  for (const position of positions) {
    try {
      // Get window resolution data (if available)
      const windowData = getWindowData ? getWindowData(position.window_id) : {};

      const result = checkExpiry(position, windowData, options);
      evaluatedCount++;

      if (result.is_resolved) {
        resolved.push(result);
      } else if (result.is_expiring) {
        expiring.push(result);
      }
    } catch (err) {
      if (log) {
        log.error('window_expiry_evaluation_error', {
          position_id: position.id,
          window_id: position.window_id,
          error: err.message,
          code: err.code,
        });
      }
    }
  }

  const summary = {
    evaluated: evaluatedCount,
    expiring: expiring.length,
    resolved: resolved.length,
    safe: evaluatedCount - expiring.length - resolved.length,
  };

  if (log && evaluatedCount > 0) {
    log.info('window_expiry_evaluation_complete', {
      total_positions: positions.length,
      ...summary,
    });
  }

  return { expiring, resolved, summary };
}
```

### Integration with Orchestrator

**Update `src/modules/orchestrator/state.js`:**

```javascript
// Add window-expiry to MODULE_INIT_ORDER after take-profit
export const MODULE_INIT_ORDER = [
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  { name: 'position-manager', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  { name: 'strategy-evaluator', module: null, configKey: null },
  { name: 'position-sizer', module: null, configKey: null },
  // Exit condition modules
  { name: 'stop-loss', module: null, configKey: null },
  { name: 'take-profit', module: null, configKey: null },
  // NEW: Add window-expiry after take-profit (final exit condition)
  { name: 'window-expiry', module: null, configKey: null },
];
```

**Update `src/modules/orchestrator/index.js`:**

```javascript
// Add import
import * as windowExpiry from '../window-expiry/index.js';

// Add to MODULE_MAP
const MODULE_MAP = {
  // ... existing modules
  'window-expiry': windowExpiry,
};
```

**Update `src/modules/orchestrator/execution-loop.js`:**

After take-profit evaluation (around line 321), add:

```javascript
// 6. Evaluate exit conditions - window expiry (Story 3.6)
let windowExpiryResults = { expiring: [], resolved: [], summary: { evaluated: 0, expiring: 0, resolved: 0, safe: 0 } };
if (this.modules['window-expiry'] && this.modules['position-manager']) {
  const windowExpiryModule = this.modules['window-expiry'];
  const positionManager = this.modules['position-manager'];

  // Get all open positions
  const openPositions = positionManager.getPositions();

  if (openPositions.length > 0) {
    // Get window data (resolution info) for each window
    const getWindowData = (windowId) => {
      // Future: Query polymarket for window resolution data
      // For now, return empty (window will be checked by timing only)
      // When resolution data is available, it should include:
      // { resolution_price: 0 or 1, resolved_at: ISO timestamp }
      return {};
    };

    windowExpiryResults = windowExpiryModule.evaluateAll(openPositions, getWindowData, {
      windowDurationMs: this.config.trading?.windowDurationMs || 15 * 60 * 1000,
      expiryWarningThresholdMs: this.config.strategy?.windowExpiry?.expiryWarningThresholdMs || 30 * 1000,
    });

    // Handle resolved positions - close with resolution P&L
    for (const result of windowExpiryResults.resolved) {
      try {
        await positionManager.closePosition(result.position_id, {
          closePrice: result.resolution_price ?? result.current_price,
          reason: 'window_expiry',
          resolution_outcome: result.outcome,
          pnl: result.pnl,
        });

        this.log.info('window_expiry_position_closed', {
          position_id: result.position_id,
          window_id: result.window_id,
          entry_price: result.entry_price,
          resolution_price: result.resolution_price,
          outcome: result.outcome,
          pnl: result.pnl,
          pnl_pct: result.pnl_pct,
        });
      } catch (closeErr) {
        this.log.error('window_expiry_close_failed', {
          position_id: result.position_id,
          error: closeErr.message,
          code: closeErr.code,
        });
      }
    }

    // Note: Expiring positions are logged but not closed - they will resolve naturally
    // The expiring flag can be used to block new entries in expiring windows
  }
}

// Update tick_complete log to include window expiry metrics
const tickDurationMs = Date.now() - tickStart;
this.log.info('tick_complete', {
  tickCount: this.tickCount,
  durationMs: tickDurationMs,
  spotPrice: spotData?.price || null,
  entrySignalsCount: entrySignals.length,
  sizingResultsCount: sizingResults.length,
  sizingSuccessCount: sizingResults.filter(r => r.success).length,
  stopLossEvaluated: stopLossResults.summary.evaluated,
  stopLossTriggered: stopLossResults.summary.triggered,
  takeProfitEvaluated: takeProfitResults.summary.evaluated,
  takeProfitTriggered: takeProfitResults.summary.triggered,
  // NEW: Window expiry metrics
  windowExpiryEvaluated: windowExpiryResults.summary.evaluated,
  windowExpiryExpiring: windowExpiryResults.summary.expiring,
  windowExpiryResolved: windowExpiryResults.summary.resolved,
});
```

### Configuration Extension

Add to `config/default.js`:

```javascript
// Strategy configuration
strategy: {
  // ... existing entry, sizing, stopLoss, takeProfit ...

  // NEW: Window expiry configuration
  windowExpiry: {
    enabled: true,                        // Enable/disable window expiry evaluation
    expiryWarningThresholdMs: 30 * 1000,  // 30 seconds - warn when this close to expiry
  },
},
```

**Note:** The `trading.windowDurationMs` and `trading.minTimeRemainingMs` already exist in config/default.js and should be used.

### Structured Logging Format

Follow the architecture's structured log format:

```json
{
  "timestamp": "2026-01-31T10:14:30.123Z",
  "level": "info",
  "module": "window-expiry",
  "event": "window_expiring_soon",
  "data": {
    "position_id": 42,
    "window_id": "btc-15m-2026-01-31-10:00",
    "time_remaining_ms": 28500,
    "entry_price": 0.50,
    "current_price": 0.55
  }
}
```

```json
{
  "timestamp": "2026-01-31T10:15:00.123Z",
  "level": "info",
  "module": "window-expiry",
  "event": "window_resolved",
  "data": {
    "position_id": 42,
    "window_id": "btc-15m-2026-01-31-10:00",
    "side": "long",
    "expected": {
      "entry_price": 0.50,
      "position_side": "long"
    },
    "actual": {
      "resolution_price": 1,
      "outcome": "win",
      "pnl": 5.00,
      "pnl_pct": 1.00
    }
  }
}
```

### Previous Story Intelligence

**From Story 3.5 (Take-Profit Module):**
- 871 tests passing after implementation (up from 801)
- Module structure: index.js, logic.js, state.js, types.js
- evaluateAll() pattern for batch processing
- Integration in execution-loop.js after stop-loss evaluation
- Child logger via `child({ module: 'module-name' })`
- ensureInitialized() guard pattern
- Factory function for result type (createTakeProfitResult)
- Per-position config support

**Key patterns to replicate:**
- WindowExpiryResult mirrors TakeProfitResult/StopLossResult structure
- WindowExpiryError mirrors TakeProfitError
- ExpiryReason enum for status types
- state.js tracks evaluation/expiring/resolved counts
- Config validation at init time
- Batch evaluation with summary statistics

**Critical differences from stop-loss/take-profit:**
- Two output categories: expiring (warning) vs resolved (action)
- Resolution based on time, not price crossing threshold
- P&L calculated from resolution outcome (0 or 1), not market exit price
- Entry blocking function (canEnterWindow) for strategy evaluator

**Test count at 871 - maintain or increase**

### Position Manager Integration

**From src/modules/position-manager/index.js:**
```javascript
// Methods used by window-expiry:
function getPositions() // Returns all open positions
async function closePosition(positionId, params = {})
  // params.closePrice = resolution price (0 or 1)
  // params.reason = 'window_expiry' for logging
  // params.resolution_outcome = 'win' or 'lose'
  // params.pnl = calculated P&L from resolution
```

**Position object structure (from types.js):**
```javascript
{
  id: number,
  window_id: string,  // e.g., "btc-15m-2026-01-31-10:00"
  market_id: string,
  token_id: string,
  side: 'long' | 'short',
  size: number,
  entry_price: number,
  current_price: number,
  status: 'open' | 'closed' | 'liquidated',
  strategy_id: string,
}
```

### Testing Patterns

Follow established vitest patterns from stop-loss/take-profit stories:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as windowExpiry from '../index.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockConfig = {
  trading: {
    windowDurationMs: 15 * 60 * 1000,
    minTimeRemainingMs: 60 * 1000,
  },
  strategy: {
    windowExpiry: {
      enabled: true,
      expiryWarningThresholdMs: 30 * 1000,
    },
  },
};

describe('WindowExpiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await windowExpiry.shutdown();
  });

  describe('calculateTimeRemaining', () => {
    it('should parse window_id and calculate remaining time', async () => {
      await windowExpiry.init(mockConfig);

      // Set current time to 10:10 (10 min into a 10:00 window)
      vi.setSystemTime(new Date('2026-01-31T10:10:00.000Z'));

      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00');

      expect(result.time_remaining_ms).toBe(5 * 60 * 1000); // 5 min left
      expect(result.is_resolved).toBe(false);
      expect(result.is_expiring).toBe(false);
    });

    it('should detect expiring window when within threshold', async () => {
      await windowExpiry.init(mockConfig);

      // Set current time to 10:14:40 (20 sec before expiry)
      vi.setSystemTime(new Date('2026-01-31T10:14:40.000Z'));

      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00', {
        expiryWarningThresholdMs: 30 * 1000,
      });

      expect(result.time_remaining_ms).toBe(20 * 1000); // 20 sec left
      expect(result.is_expiring).toBe(true);
      expect(result.is_resolved).toBe(false);
    });

    it('should detect resolved window when past end time', async () => {
      await windowExpiry.init(mockConfig);

      // Set current time to 10:16 (1 min past expiry)
      vi.setSystemTime(new Date('2026-01-31T10:16:00.000Z'));

      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00');

      expect(result.time_remaining_ms).toBeLessThan(0);
      expect(result.is_resolved).toBe(true);
    });
  });

  describe('checkExpiry', () => {
    it('should calculate P&L for long position win (resolution = 1)', async () => {
      await windowExpiry.init(mockConfig);
      vi.setSystemTime(new Date('2026-01-31T10:16:00.000Z')); // Past expiry

      const position = {
        id: 1,
        window_id: 'btc-15m-2026-01-31-10:00',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const windowData = { resolution_price: 1 }; // YES won

      const result = windowExpiry.checkExpiry(position, windowData);

      expect(result.is_resolved).toBe(true);
      expect(result.outcome).toBe('win');
      expect(result.pnl).toBe(5); // 10 * (1 - 0.50)
    });

    it('should calculate P&L for short position win (resolution = 0)', async () => {
      await windowExpiry.init(mockConfig);
      vi.setSystemTime(new Date('2026-01-31T10:16:00.000Z'));

      const position = {
        id: 2,
        window_id: 'btc-15m-2026-01-31-10:00',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      const windowData = { resolution_price: 0 }; // NO won

      const result = windowExpiry.checkExpiry(position, windowData);

      expect(result.is_resolved).toBe(true);
      expect(result.outcome).toBe('win');
      expect(result.pnl).toBe(5); // 10 * (0.50 - 0)
    });
  });

  describe('canEnterWindow', () => {
    it('should block entry when time remaining too low', async () => {
      await windowExpiry.init(mockConfig);

      // Set current time to 10:14:30 (30 sec before expiry)
      vi.setSystemTime(new Date('2026-01-31T10:14:30.000Z'));

      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', {
        minTimeRemainingMs: 60 * 1000, // Need 60 sec
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('insufficient_time_remaining');
    });

    it('should allow entry when sufficient time remains', async () => {
      await windowExpiry.init(mockConfig);

      // Set current time to 10:10:00 (5 min before expiry)
      vi.setSystemTime(new Date('2026-01-31T10:10:00.000Z'));

      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', {
        minTimeRemainingMs: 60 * 1000,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('evaluateAll', () => {
    it('should separate expiring and resolved positions', async () => {
      await windowExpiry.init(mockConfig);
      vi.setSystemTime(new Date('2026-01-31T10:16:00.000Z')); // Past 10:00 window

      const positions = [
        { id: 1, window_id: 'btc-15m-2026-01-31-10:00', side: 'long', size: 10, entry_price: 0.50 }, // Resolved
        { id: 2, window_id: 'btc-15m-2026-01-31-10:05', side: 'long', size: 10, entry_price: 0.50 }, // Expiring (10:05-10:20)
        { id: 3, window_id: 'btc-15m-2026-01-31-10:10', side: 'long', size: 10, entry_price: 0.50 }, // Safe (10:10-10:25)
      ];

      const getWindowData = (windowId) => {
        if (windowId === 'btc-15m-2026-01-31-10:00') {
          return { resolution_price: 1 };
        }
        return {};
      };

      const { expiring, resolved, summary } = windowExpiry.evaluateAll(positions, getWindowData);

      expect(resolved.length).toBe(1);
      expect(resolved[0].position_id).toBe(1);
      expect(expiring.length).toBe(1); // 10:05 window expiring at 10:16
      expect(summary.evaluated).toBe(3);
    });
  });
});
```

### NFR Compliance

- **FR3** (Evaluate exit conditions - window expiry): Core purpose of this story
- **FR35** (Configure strategy parameters without code changes): Window timing in config
- **NFR5** (Market data processing keeps pace): Evaluation completes within tick interval
- **NFR9** (100% of trade events produce structured log): All evaluations logged

### Signal Flow After This Story

```
Tick → Spot Price → Strategy Evaluator → Entry Signal
                                              ↓
                              Window Expiry → canEnterWindow() check
                                              ↓
                                    Position Sizer
                                              ↓
                                    SizingResult → Order Manager (future)

Tick → Open Positions → Stop-Loss Module (Story 3.4)
                                              ↓
                              StopLossResult { triggered }
                                              ↓
                              Position Manager → closePosition()

Tick → Open Positions → Take-Profit Module (Story 3.5)
                                              ↓
                              TakeProfitResult { triggered }
                                              ↓
                              Position Manager → closePosition()

Tick → Open Positions → Window-Expiry Module (this story)
                                              ↓
                              WindowExpiryResult { expiring, resolved }
                                              ↓
                              Resolved → Position Manager → closePosition()
                              Expiring → Log warning, block new entries
```

### Critical Implementation Notes

1. **Window ID Format**: Must parse window_id correctly to extract timing. Format: `{asset}-{duration}-{date}-{time}` (e.g., "btc-15m-2026-01-31-10:00"). The date is assumed to be in UTC.

2. **Resolution vs Expiring**: Two distinct states:
   - Expiring: time_remaining > 0 but <= threshold - warning only, don't close
   - Resolved: time_remaining <= 0 - window ended, calculate P&L and close

3. **Binary Option P&L**: Resolution price is 0 or 1. For long positions: pnl = size * (resolution - entry). For short: pnl = size * (entry - resolution).

4. **Entry Blocking**: The canEnterWindow() function should be called by strategy evaluator (via orchestrator) to prevent new entries in windows with insufficient time remaining.

5. **Resolution Data Source**: In MVP, window data may not be available immediately at expiry. The module should handle missing resolution data gracefully (log warning, check again next tick).

6. **Timezone Handling**: Window times in window_id are parsed as UTC. Ensure consistent timezone handling.

7. **Multiple Windows**: Different positions may be in different windows. Each window resolves independently.

8. **Evaluation Order**: Window expiry evaluation happens AFTER take-profit in the tick cycle. This is intentional - let price-based exits trigger first, then handle time-based expiry.

### References

- [Source: architecture.md#Inter-Module-Communication] - Orchestrator pattern
- [Source: architecture.md#Module-Interface-Contract] - init, getState, shutdown
- [Source: architecture.md#Project-Structure] - Module organization
- [Source: architecture.md#Structured-Log-Format] - JSON log schema
- [Source: architecture.md#Naming-Patterns] - snake_case for log fields
- [Source: epics.md#Story-3.6] - Story requirements and acceptance criteria
- [Source: prd.md#FR3] - Evaluate exit conditions (stop-loss, take-profit, window expiry)
- [Source: prd.md#Domain-Specific-Requirements] - Window mechanics: "Understand 15-minute window resolution timing precisely"
- [Source: config/default.js:52-56] - trading.windowDurationMs and trading.minTimeRemainingMs
- [Source: 3-5-take-profit-module.md] - Previous story patterns and module structure
- [Source: src/modules/take-profit/index.js] - Take-profit module as reference implementation
- [Source: src/modules/orchestrator/execution-loop.js:323] - Comment placeholder for window expiry

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debugging issues encountered.

### Completion Notes List

- Implemented window-expiry module following established patterns from stop-loss/take-profit modules
- Module parses window_id format: `{asset}-{duration}-{date}-{time}` (e.g., "btc-15m-2026-01-31-10:00")
- Two output categories: expiring (warning) and resolved (action required)
- Resolution-based P&L calculation for binary options (resolution_price 0 or 1)
- Entry blocking via canEnterWindow() function for strategy evaluator integration
- Full integration with orchestrator execution loop (step 6 after take-profit)
- 103 new tests added, total test count increased from 871 to 974
- All acceptance criteria satisfied

### File List

**New files:**
- src/modules/window-expiry/index.js
- src/modules/window-expiry/logic.js
- src/modules/window-expiry/state.js
- src/modules/window-expiry/types.js
- src/modules/window-expiry/__tests__/index.test.js
- src/modules/window-expiry/__tests__/logic.test.js

**Modified files:**
- config/default.js (added strategy.windowExpiry configuration)
- src/modules/orchestrator/state.js (added window-expiry to MODULE_INIT_ORDER)
- src/modules/orchestrator/index.js (added window-expiry import and MODULE_MAP entry)
- src/modules/orchestrator/execution-loop.js (added step 6 window expiry evaluation)

## Change Log

- 2026-01-31: Story 3.6 implementation complete - window-expiry module created with full orchestrator integration
