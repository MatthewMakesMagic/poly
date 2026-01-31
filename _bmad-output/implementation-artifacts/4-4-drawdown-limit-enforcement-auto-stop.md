# Story 4.4: Drawdown Limit Enforcement & Auto-Stop

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **automatic stop when drawdown limits are breached**,
So that **I don't lose more than my configured risk tolerance (FR28, FR29)**.

## Acceptance Criteria

### AC1: Drawdown Limit Configuration

**Given** drawdown limits are configured (FR36)
**When** config is loaded
**Then** `config.risk.dailyDrawdownLimit` is read (e.g., 0.05 for 5%)
**And** this limit is enforced by the safety module
**And** warning threshold is also configurable (e.g., 0.03 for 3% warning)

### AC2: Drawdown Warning Alert

**Given** current drawdown approaches limit
**When** `total_drawdown_pct > (limit - warning_threshold)`
**Then** a warning is logged: "Drawdown at X%, limit is Y%"
**And** trading continues but with alert
**And** warning is logged each time drawdown worsens past the warning threshold

### AC3: Drawdown Limit Breach Detection

**Given** the safety module is checking drawdown
**When** `total_drawdown_pct >= dailyDrawdownLimit` (FR29)
**Then** `checkDrawdownLimit()` returns `{ breached: true, current, limit }`
**And** the breach is logged as error level
**And** `isAutoStopped()` returns `true`

### AC4: Auto-Stop Trigger

**Given** drawdown exceeds limit
**When** breach is detected
**Then** auto-stop is triggered immediately
**And** all open orders are cancelled (via order manager)
**And** no new positions are opened
**And** log shows: "AUTO-STOP: Drawdown limit breached at X%, limit was Y%"
**And** auto-stop state is persisted

### AC5: Manual Resume Required

**Given** auto-stop has been triggered
**When** user wants to resume trading
**Then** manual intervention is required (explicit reset call)
**And** system does NOT auto-resume
**And** reset logs: "Auto-stop manually reset by user"

### AC6: Safety Module Interface

**Given** the safety module
**When** inspecting its interface
**Then** it exports: `init()`, `checkDrawdownLimit()`, `isAutoStopped()`, `resetAutoStop()`, `getState()`, `shutdown()`
**And** `checkDrawdownLimit()` returns `{ breached: boolean, current: number, limit: number, autoStopped: boolean }`

### AC7: Orchestrator Integration

**Given** the orchestrator is running
**When** before evaluating entry signals
**Then** orchestrator calls `safety.checkDrawdownLimit()`
**And** if breached or auto-stopped, no entry signals are evaluated
**And** existing positions are allowed to close normally (don't trap funds)

## Tasks / Subtasks

- [x] **Task 1: Add Drawdown Limit Configuration** (AC: 1)
  - [x] 1.1 Verify `config.risk.dailyDrawdownLimit` exists (already 0.05 in config)
  - [x] 1.2 Add `config.safety.drawdownWarningPct` (default: 0.03 or 60% of limit)
  - [x] 1.3 Add `config.safety.autoStopStateFile` for persisting auto-stop state

- [x] **Task 2: Implement Auto-Stop State Management** (AC: 3, 5)
  - [x] 2.1 Add `autoStopped` boolean to safety module state
  - [x] 2.2 Add `autoStoppedAt` timestamp when triggered
  - [x] 2.3 Add `autoStopReason` string with breach details
  - [x] 2.4 Persist auto-stop state to file for survival across restarts
  - [x] 2.5 Load auto-stop state on init (if exists, remain stopped)

- [x] **Task 3: Implement checkDrawdownLimit()** (AC: 1, 2, 3, 6)
  - [x] 3.1 Create function `checkDrawdownLimit()` in safety module
  - [x] 3.2 Get current `total_drawdown_pct` from `getDrawdownStatus()`
  - [x] 3.3 Compare against `config.risk.dailyDrawdownLimit`
  - [x] 3.4 If approaching limit (warning threshold), log warning
  - [x] 3.5 If breached, set `autoStopped = true` and log error
  - [x] 3.6 Return `{ breached, current, limit, autoStopped }`

- [x] **Task 4: Implement isAutoStopped()** (AC: 3, 5, 6)
  - [x] 4.1 Create function `isAutoStopped()` returning boolean
  - [x] 4.2 Read from in-memory state (cached for fast access)
  - [x] 4.3 Also return true if auto-stop state file exists and is current day

- [x] **Task 5: Implement resetAutoStop()** (AC: 5, 6)
  - [x] 5.1 Create function `resetAutoStop()` for manual resume
  - [x] 5.2 Clear `autoStopped` flag
  - [x] 5.3 Delete or archive auto-stop state file
  - [x] 5.4 Log: "Auto-stop manually reset by user"
  - [x] 5.5 Require explicit confirmation (e.g., pass `confirm: true`)

- [x] **Task 6: Implement Auto-Stop Trigger Logic** (AC: 4)
  - [x] 6.1 Create internal function `triggerAutoStop(reason)`
  - [x] 6.2 Set `autoStopped = true`, `autoStoppedAt = now`
  - [x] 6.3 Cancel all open orders (coordinate with order manager)
  - [x] 6.4 Persist auto-stop state to file
  - [x] 6.5 Log error: "AUTO-STOP: Drawdown limit breached"
  - [x] 6.6 Include drawdown details in log context

- [x] **Task 7: Integrate with Order Manager** (AC: 4)
  - [x] 7.1 Safety module calls `orderManager.cancelAllOrders()` on auto-stop
  - [x] 7.2 If orderManager not available, log warning and continue
  - [x] 7.3 Handle errors gracefully (don't block auto-stop on cancel failure)

- [x] **Task 8: Integrate with Orchestrator** (AC: 7)
  - [x] 8.1 Add `safety.checkDrawdownLimit()` call before entry evaluation
  - [x] 8.2 If `breached` or `autoStopped`, skip entry signal evaluation
  - [x] 8.3 Continue exit evaluations (stop-loss, take-profit, expiry)
  - [x] 8.4 Log when skipping entries due to auto-stop

- [x] **Task 9: Update Module Interface** (AC: 6)
  - [x] 9.1 Export `checkDrawdownLimit()` from safety/index.js
  - [x] 9.2 Export `isAutoStopped()` from safety/index.js
  - [x] 9.3 Export `resetAutoStop()` from safety/index.js
  - [x] 9.4 Update `getState()` to include auto-stop status
  - [x] 9.5 Update JSDoc documentation

- [x] **Task 10: Write Tests** (AC: all)
  - [x] 10.1 Test warning logged when drawdown approaches limit
  - [x] 10.2 Test auto-stop triggered when limit breached
  - [x] 10.3 Test `isAutoStopped()` returns true after breach
  - [x] 10.4 Test `checkDrawdownLimit()` returns correct structure
  - [x] 10.5 Test `resetAutoStop()` clears auto-stop state
  - [x] 10.6 Test auto-stop state persists across module restart
  - [x] 10.7 Test orchestrator skips entries when auto-stopped
  - [x] 10.8 Test exits still evaluated when auto-stopped
  - [x] 10.9 Integration test: drawdown → breach → auto-stop → reset

## Dev Notes

### Architecture Compliance

This story implements FR28 (enforce configurable drawdown limits) and FR29 (auto-stop when drawdown limits breached). It builds directly on Story 4.3's drawdown tracking infrastructure.

**From architecture.md#Safety-Controls:**
> FR28: System can enforce configurable drawdown limits
> FR29: System can auto-stop when drawdown limits breached

**From architecture.md#Module-Interface-Contract:**
```javascript
// src/modules/safety/index.js exports:
init(config)
getState()
shutdown()
checkDrawdownLimit()   // NEW: This story
isAutoStopped()        // NEW: This story
resetAutoStop()        // NEW: This story
```

### Project Structure Notes

**Existing files to modify:**
```
src/modules/safety/
├── index.js          # Add checkDrawdownLimit, isAutoStopped, resetAutoStop exports
├── drawdown.js       # Add limit checking logic
├── state.js          # Add autoStopped state tracking
└── types.js          # Add new error codes if needed

src/modules/orchestrator/
├── index.js          # Integrate safety check before entry evaluation
└── execution-loop.js # Add drawdown check in tick loop

config/default.js     # Add drawdownWarningPct configuration
```

**New files (optional):**
```
src/modules/safety/
└── auto-stop.js      # Dedicated auto-stop logic (or inline in drawdown.js)
```

### Implementation Approach

**checkDrawdownLimit() Implementation:**
```javascript
// src/modules/safety/drawdown.js (or new auto-stop.js)

export function checkDrawdownLimit(config, log) {
  const status = getDrawdownStatus();
  const limit = config.risk.dailyDrawdownLimit;  // e.g., 0.05 (5%)
  const warningThreshold = config.safety.drawdownWarningPct || limit * 0.6;

  const current = status.total_drawdown_pct;  // Includes unrealized
  const breached = current >= limit;

  // Check for warning (approaching limit)
  if (!breached && current >= warningThreshold && !hasWarnedThisLevel(current)) {
    log.warn('drawdown_warning', {
      event: 'drawdown_approaching_limit',
      current_pct: (current * 100).toFixed(2),
      limit_pct: (limit * 100).toFixed(2),
      remaining_pct: ((limit - current) * 100).toFixed(2),
    });
    markWarnedLevel(current);
  }

  // Check for breach
  if (breached && !isAutoStopped()) {
    triggerAutoStop({
      reason: 'drawdown_limit_breached',
      current_pct: current,
      limit_pct: limit,
    }, log);
  }

  return {
    breached,
    current,
    limit,
    autoStopped: isAutoStopped(),
  };
}
```

**Auto-Stop State:**
```javascript
// src/modules/safety/state.js - add to existing state

let autoStopState = {
  autoStopped: false,
  autoStoppedAt: null,
  autoStopReason: null,
};

export function setAutoStopped(stopped, reason = null) {
  autoStopState.autoStopped = stopped;
  autoStopState.autoStoppedAt = stopped ? new Date().toISOString() : null;
  autoStopState.autoStopReason = reason;
}

export function getAutoStopState() {
  return { ...autoStopState };
}

export function isAutoStopped() {
  return autoStopState.autoStopped;
}
```

**Auto-Stop Persistence:**
```javascript
// Persist to file for survival across restarts
import { writeFileSync, readFileSync, existsSync } from 'fs';

const AUTO_STOP_FILE = './data/auto-stop-state.json';

export function persistAutoStopState(state) {
  writeFileSync(AUTO_STOP_FILE, JSON.stringify({
    ...state,
    date: new Date().toISOString().split('T')[0],  // YYYY-MM-DD
  }, null, 2));
}

export function loadAutoStopState() {
  if (!existsSync(AUTO_STOP_FILE)) return null;

  const data = JSON.parse(readFileSync(AUTO_STOP_FILE, 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  // Only load if from today (auto-stop resets on new day)
  if (data.date === today) {
    return data;
  }
  return null;  // Old auto-stop, ignore
}
```

**Orchestrator Integration:**
```javascript
// src/modules/orchestrator/execution-loop.js

async function executeTick() {
  // Check drawdown limit before evaluating entries
  const drawdownCheck = safety.checkDrawdownLimit();

  if (drawdownCheck.autoStopped) {
    log.info('entries_skipped_auto_stop', {
      event: 'auto_stop_active',
      drawdown_pct: (drawdownCheck.current * 100).toFixed(2),
    });

    // Skip entry evaluation but continue to exits
    // Existing positions should still be monitored for stop-loss/take-profit
  } else {
    // Normal entry evaluation
    await evaluateEntrySignals();
  }

  // Always evaluate exits (even when auto-stopped)
  await evaluateExitConditions();
}
```

### Previous Story Intelligence (4.3)

**From Story 4.3 implementation:**
- `getDrawdownStatus()` returns `total_drawdown_pct` including unrealized losses - use this for limit checking
- `recordRealizedPnl()` updates drawdown on position close - limit check should happen after
- Cached record pattern for fast access - reuse for auto-stop state
- Non-blocking async pattern established - auto-stop should not block trading

**Files modified in 4.3:**
- `src/modules/safety/index.js` - Add new exports here
- `src/modules/safety/drawdown.js` - Add limit checking logic here
- `src/modules/safety/state.js` - Add auto-stop state here
- `config/default.js` - Already has `risk.dailyDrawdownLimit = 0.05`

**Integration points from 4.3:**
- `recordRealizedPnl()` - should call `checkDrawdownLimit()` after updating P&L
- `updateUnrealizedPnl()` - should also trigger limit check
- `getDrawdownStatus()` - provides the `total_drawdown_pct` needed for comparison

### Git Intelligence (from recent commits)

**Previous story commit pattern:**
```
502a96d Implement story 4-3-drawdown-tracking
ce15014 Implement story 4-2-state-snapshot-on-kill
d0f579f Implement story 4-1-kill-switch-watchdog-process
```

Follow pattern: "Implement story 4-4-drawdown-limit-enforcement-auto-stop"

**Files from 4-3 commit (relevant to this story):**
- `src/modules/safety/drawdown.js` - 294 lines, core drawdown logic
- `src/modules/safety/index.js` - 180 lines, module interface
- `src/modules/safety/state.js` - 96 lines, state management
- All tests pass (1081 tests total)

### Configuration Updates

```javascript
// config/default.js - add to safety section

safety: {
  startingCapital: parseFloat(process.env.STARTING_CAPITAL) || 1000,
  unrealizedUpdateIntervalMs: 5000,
  // NEW for Story 4.4:
  drawdownWarningPct: 0.03,           // Warn at 3% (60% of default 5% limit)
  autoStopStateFile: './data/auto-stop-state.json',
},
```

### Error Handling

```javascript
// src/modules/safety/types.js - add new error codes

export const SafetyErrorCodes = {
  // Existing...
  ALREADY_INITIALIZED: 'SAFETY_ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'SAFETY_NOT_INITIALIZED',
  // NEW for Story 4.4:
  DRAWDOWN_LIMIT_BREACHED: 'DRAWDOWN_LIMIT_BREACHED',
  AUTO_STOP_ACTIVE: 'AUTO_STOP_ACTIVE',
  RESET_REQUIRES_CONFIRMATION: 'RESET_REQUIRES_CONFIRMATION',
};
```

### Edge Cases

1. **Multiple Breaches:** Only trigger auto-stop once (check `isAutoStopped()` first)
2. **Race Conditions:** Use synchronous flag check to prevent multiple triggers
3. **Order Cancel Failure:** Log warning but continue with auto-stop (primary goal is prevent new trades)
4. **Unrealized Volatility:** Use total_drawdown_pct which includes unrealized to catch paper losses
5. **New Day:** Auto-stop should reset on new trading day (based on date in state file)
6. **Restart While Auto-Stopped:** Load persisted state and remain stopped until manual reset

### Testing Approach

```javascript
// src/modules/safety/__tests__/limit-enforcement.test.js

describe('Drawdown Limit Enforcement', () => {
  describe('checkDrawdownLimit', () => {
    it('should return breached=false when under limit', async () => {
      // Setup: 2% drawdown, 5% limit
      await recordRealizedPnl(-20, 1000);  // 2% drawdown
      const result = checkDrawdownLimit();
      expect(result.breached).toBe(false);
      expect(result.current).toBeCloseTo(0.02);
      expect(result.limit).toBe(0.05);
    });

    it('should log warning when approaching limit', async () => {
      // Setup: 3.5% drawdown, 5% limit, 3% warning threshold
      await recordRealizedPnl(-35, 1000);
      checkDrawdownLimit();
      expect(log.warn).toHaveBeenCalledWith('drawdown_warning', expect.any(Object));
    });

    it('should trigger auto-stop when limit breached', async () => {
      // Setup: 5% drawdown, 5% limit
      await recordRealizedPnl(-50, 1000);
      const result = checkDrawdownLimit();
      expect(result.breached).toBe(true);
      expect(result.autoStopped).toBe(true);
    });

    it('should include unrealized losses in breach check', async () => {
      // Setup: 2% realized + 3% unrealized = 5% total
      await recordRealizedPnl(-20, 1000);   // 2% realized
      await updateUnrealizedPnl(-30, 1000); // 3% unrealized
      const result = checkDrawdownLimit();
      expect(result.breached).toBe(true);
    });
  });

  describe('isAutoStopped', () => {
    it('should return true after auto-stop triggered', async () => {
      await recordRealizedPnl(-50, 1000);
      checkDrawdownLimit();
      expect(isAutoStopped()).toBe(true);
    });

    it('should persist across module restart', async () => {
      // Trigger auto-stop
      await recordRealizedPnl(-50, 1000);
      checkDrawdownLimit();

      // Simulate restart
      await shutdown();
      await init(config);

      expect(isAutoStopped()).toBe(true);
    });
  });

  describe('resetAutoStop', () => {
    it('should require confirmation', () => {
      setAutoStopped(true, 'test');
      expect(() => resetAutoStop()).toThrow();
      expect(() => resetAutoStop({ confirm: true })).not.toThrow();
    });

    it('should clear auto-stop state', async () => {
      setAutoStopped(true, 'test');
      resetAutoStop({ confirm: true });
      expect(isAutoStopped()).toBe(false);
    });
  });
});
```

### NFR Compliance

- **FR28:** System can enforce configurable drawdown limits (this story)
- **FR29:** System can auto-stop when drawdown limits breached (this story)
- **NFR2:** Kill switch halts all activity within 5 seconds - auto-stop prevents new trades immediately
- **NFR9:** 100% of trade events produce complete structured log - all auto-stop events logged

### Integration with Other Stories

**Story 4.1 (Kill Switch):** Auto-stop is NOT the same as kill switch
- Auto-stop: Prevents new entries, allows exits, manual reset required
- Kill switch: Halts everything immediately, writes state snapshot

**Story 4.2 (State Snapshot):** State snapshot should include auto-stop status
- When taking snapshot, include `isAutoStopped()` result
- Helps with post-kill reconciliation

**Story 4.3 (Drawdown Tracking):** Direct foundation for this story
- Uses `getDrawdownStatus().total_drawdown_pct` for limit comparison
- Extends `recordRealizedPnl()` and `updateUnrealizedPnl()` to check limit after update

### Critical Implementation Notes

1. **Check TOTAL drawdown:** Use `total_drawdown_pct` (includes unrealized) not just `drawdown_pct`

2. **Single Trigger:** Auto-stop should only fire once per breach event (check `isAutoStopped()` first)

3. **Non-Blocking Cancel:** Order cancellation should be fire-and-forget, don't block auto-stop

4. **Exits Continue:** When auto-stopped, still evaluate stop-loss, take-profit, and window expiry

5. **Day Boundary:** Auto-stop from previous day should NOT persist to new day

6. **Warning Levels:** Track what warning levels have been logged to avoid spam

7. **Orchestrator Check Location:** Check drawdown BEFORE entry evaluation, not after

### References

- [Source: architecture.md#Safety-Controls] - FR28, FR29 requirements
- [Source: architecture.md#Module-Interface-Contract] - Module interface pattern
- [Source: epics.md#Story-4.4] - Story requirements and acceptance criteria
- [Source: prd.md#FR28] - System can enforce configurable drawdown limits
- [Source: prd.md#FR29] - System can auto-stop when drawdown limits breached
- [Source: config/default.js:30] - risk.dailyDrawdownLimit = 0.05 (5%)
- [Source: src/modules/safety/index.js] - Existing safety module interface
- [Source: src/modules/safety/drawdown.js] - Existing drawdown tracking from Story 4.3
- [Source: src/modules/orchestrator/execution-loop.js] - Entry evaluation location

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - Implementation completed without issues.

### Completion Notes List

- Implemented drawdown limit enforcement with configurable warning threshold (default 3%) and limit (default 5%)
- Added auto-stop state management with file persistence for survival across restarts
- Auto-stop state resets on new trading day (based on date comparison)
- Integrated with orchestrator execution loop - entries skipped when auto-stopped but exits continue
- Safety module wired to order manager for order cancellation on auto-stop
- Warning level tracking uses 0.5% buckets to avoid log spam
- Manual reset requires explicit `{ confirm: true }` to prevent accidental resume
- All 1113 tests pass including 32 new limit enforcement tests

### File List

**Modified:**
- config/default.js - Added `drawdownWarningPct` and `autoStopStateFile` to safety config
- src/modules/safety/types.js - Added new error codes (DRAWDOWN_LIMIT_BREACHED, AUTO_STOP_ACTIVE, RESET_REQUIRES_CONFIRMATION)
- src/modules/safety/state.js - Added auto-stop state management and file persistence
- src/modules/safety/drawdown.js - Added checkDrawdownLimit(), triggerAutoStop(), resetAutoStop()
- src/modules/safety/index.js - Exported new functions, added order manager integration
- src/modules/orchestrator/state.js - Added safety module to MODULE_INIT_ORDER
- src/modules/orchestrator/index.js - Added safety module import and order manager wiring
- src/modules/orchestrator/execution-loop.js - Added drawdown limit check before entry evaluation
- src/modules/orchestrator/__tests__/index.test.js - Added safety module mock

**New:**
- src/modules/safety/__tests__/limit-enforcement.test.js - 32 tests for all limit enforcement functionality

## Change Log

| Date | Change |
|------|--------|
| 2026-01-31 | Story implementation complete - all ACs satisfied, 1113 tests passing |
