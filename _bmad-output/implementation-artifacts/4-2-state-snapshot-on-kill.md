# Story 4.2: State Snapshot on Kill

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **exact state documented at kill time**,
So that **I know exactly what's open, closed, and pending for reconciliation (FR27)**.

## Acceptance Criteria

### AC1: State Snapshot on Graceful Shutdown

**Given** a graceful shutdown is executed (via SIGTERM or `cli stop`)
**When** the main process shuts down cleanly
**Then** it writes final state to `data/last-known-state.json`
**And** snapshot includes: all open positions, all pending/open orders, timestamp
**And** snapshot includes: orchestrator state, module states
**And** snapshot is marked with `forced_kill: false`
**And** watchdog confirms state file is current by checking timestamp

### AC2: State Snapshot on Forced Kill

**Given** a forced kill (SIGKILL) occurs after graceful timeout
**When** main process is forcibly terminated
**Then** watchdog writes snapshot from last-known state (periodic updates)
**And** snapshot is marked with `forced_kill: true`
**And** snapshot includes `stale_warning: true` if last update was >5 seconds ago
**And** log warns "State snapshot from last known - verify with exchange"

### AC3: Periodic State Updates During Normal Operation

**Given** the main process is running normally
**When** state changes occur (positions opened/closed, orders placed/filled)
**Then** state is periodically written to `data/last-known-state.json`
**And** updates occur at configurable interval (default: every 5 seconds)
**And** updates are non-blocking (async write)
**And** write failures are logged but don't block trading

### AC4: Post-Kill Reconciliation Information

**Given** post-kill reconciliation is needed
**When** user reviews `data/last-known-state.json`
**Then** they can see exactly: positions (with sizes, entries, current prices)
**And** orders (with statuses, fill amounts)
**And** last update timestamp
**And** whether kill was forced or graceful
**And** this enables manual verification against exchange

### AC5: State Snapshot Format

**Given** the state snapshot is written
**When** inspecting the JSON structure
**Then** it includes version field for format compatibility
**And** positions array with full position details
**And** orders array with full order details
**And** metadata: timestamp, pid, forced_kill flag, orchestrator state
**And** format matches structured logging conventions (snake_case)

### AC6: Kill Switch Integration

**Given** the watchdog triggers a kill sequence
**When** the kill completes (graceful or forced)
**Then** watchdog reads `data/last-known-state.json`
**And** logs summary of state at kill time (position count, order count)
**And** if forced kill, warns about potential staleness
**And** watchdog can operate even if main process state module is unavailable

## Tasks / Subtasks

- [x] **Task 1: Create State Snapshot Module** (AC: 1, 3, 5)
  - [x] 1.1 Create `kill-switch/state-snapshot.js` - Core snapshot logic
  - [x] 1.2 Define snapshot JSON schema/structure with version field
  - [x] 1.3 Implement `writeSnapshot(state)` - Write state to file atomically
  - [x] 1.4 Implement `readSnapshot()` - Read and parse state file
  - [x] 1.5 Implement `isSnapshotStale(maxAgeMs)` - Check if snapshot is old
  - [x] 1.6 Add snapshot types to `kill-switch/types.js`

- [x] **Task 2: Implement Periodic State Updates** (AC: 3)
  - [x] 2.1 Add periodic state writer to orchestrator or dedicated module
  - [x] 2.2 Configure update interval from `config.killSwitch.stateUpdateIntervalMs` (default: 5000)
  - [x] 2.3 Collect state from all modules: positions, orders, orchestrator
  - [x] 2.4 Write state asynchronously (non-blocking)
  - [x] 2.5 Log write failures without blocking trading
  - [x] 2.6 Stop periodic updates on shutdown

- [x] **Task 3: Integrate with Orchestrator Shutdown** (AC: 1)
  - [x] 3.1 In orchestrator shutdown(), write final state snapshot
  - [x] 3.2 Mark snapshot with `forced_kill: false`
  - [x] 3.3 Include complete position and order details
  - [x] 3.4 Include orchestrator state and module states
  - [x] 3.5 Wait for write to complete before exit

- [x] **Task 4: Integrate with Watchdog Kill Sequence** (AC: 2, 6)
  - [x] 4.1 After kill sequence, read state snapshot in watchdog
  - [x] 4.2 If forced kill, mark snapshot with `forced_kill: true`
  - [x] 4.3 Check snapshot staleness (>5s old → `stale_warning: true`)
  - [x] 4.4 Log warning if stale: "State snapshot from last known - verify with exchange"
  - [x] 4.5 Log summary of state at kill time (position/order counts)
  - [x] 4.6 Handle case where state file doesn't exist

- [x] **Task 5: Add Configuration** (AC: 3)
  - [x] 5.1 Add `stateUpdateIntervalMs` to killSwitch config (default: 5000)
  - [x] 5.2 Add `stateStaleThresholdMs` to killSwitch config (default: 5000)
  - [x] 5.3 Ensure `stateFilePath` is already in config (`./data/last-known-state.json`)

- [x] **Task 6: Write Tests** (AC: all)
  - [x] 6.1 Test writeSnapshot() writes valid JSON atomically
  - [x] 6.2 Test readSnapshot() parses JSON correctly
  - [x] 6.3 Test isSnapshotStale() detects old snapshots
  - [x] 6.4 Test graceful shutdown writes snapshot with forced_kill=false
  - [x] 6.5 Test forced kill marks snapshot with forced_kill=true
  - [x] 6.6 Test periodic updates run at configured interval
  - [x] 6.7 Test watchdog reads and logs state summary
  - [x] 6.8 Test staleness warning is logged when appropriate
  - [x] 6.9 Integration test: start → trade → kill → verify snapshot

## Dev Notes

### Architecture Compliance

This story implements FR27 (document state at kill time) as part of Epic 4 Safety Controls. It builds directly on Story 4.1 (Kill Switch Watchdog) by adding state capture.

**From architecture.md#Kill-Switch:**
```
Kill sequence:
1. User triggers kill (CLI command or signal)
2. Watchdog sends graceful shutdown signal
3. If no response in 2s → SIGKILL
4. Watchdog writes state snapshot from last known state  <-- THIS STORY
5. <5s total guaranteed
```

**Shared state file:** `data/last-known-state.json`
- Main process writes periodically and on graceful shutdown
- Watchdog reads on kill completion
- Enables "know what was attempted" for reconciliation

### Project Structure Notes

**Existing files to modify:**
- `kill-switch/types.js` - Add snapshot types
- `kill-switch/process-manager.js` - Add state reading after kill
- `kill-switch/commands.js` - Log state summary on kill command
- `src/modules/orchestrator/index.js` - Add periodic state writes and final snapshot on shutdown
- `config/default.js` - Add stateUpdateIntervalMs and stateStaleThresholdMs

**New files:**
```
kill-switch/
├── state-snapshot.js    # Core snapshot read/write logic
└── __tests__/
    └── state-snapshot.test.js
```

### State Snapshot Schema

```json
{
  "version": 1,
  "timestamp": "2026-01-31T10:15:30.123Z",
  "pid": 12345,
  "forced_kill": false,
  "stale_warning": false,
  "orchestrator": {
    "state": "running",
    "started_at": "2026-01-31T08:00:00.000Z",
    "error_count": 0
  },
  "positions": [
    {
      "id": 1,
      "window_id": "window-123",
      "market_id": "market-abc",
      "token_id": "yes",
      "side": "long",
      "size": 10.5,
      "entry_price": 0.45,
      "current_price": 0.48,
      "status": "open",
      "strategy_id": "spot-lag-v1",
      "opened_at": "2026-01-31T09:00:00.000Z",
      "unrealized_pnl": 0.315
    }
  ],
  "orders": [
    {
      "order_id": "ord-xyz",
      "window_id": "window-123",
      "market_id": "market-abc",
      "side": "buy",
      "order_type": "limit",
      "price": 0.44,
      "size": 10.5,
      "filled_size": 0,
      "status": "open",
      "submitted_at": "2026-01-31T09:00:00.000Z"
    }
  ],
  "summary": {
    "open_positions": 1,
    "open_orders": 1,
    "total_exposure": 4.725
  }
}
```

### Implementation Approach

**Periodic State Updates (Main Process):**
```javascript
// In orchestrator or dedicated state-writer module
let stateUpdateInterval = null;

function startPeriodicStateUpdates() {
  const intervalMs = config.killSwitch?.stateUpdateIntervalMs || 5000;

  stateUpdateInterval = setInterval(async () => {
    try {
      const snapshot = buildStateSnapshot();
      await writeStateSnapshot(snapshot);
    } catch (err) {
      log.warn('state_snapshot_write_failed', { error: err.message });
      // Don't throw - non-blocking
    }
  }, intervalMs);
}

function stopPeriodicStateUpdates() {
  if (stateUpdateInterval) {
    clearInterval(stateUpdateInterval);
    stateUpdateInterval = null;
  }
}

function buildStateSnapshot() {
  const state = getState(); // orchestrator.getState()

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    forced_kill: false,
    stale_warning: false,
    orchestrator: {
      state: state.state,
      started_at: state.startedAt,
      error_count: state.errorCount,
    },
    positions: state.modules['position-manager']?.positions || [],
    orders: state.modules['order-manager']?.orders || [],
    summary: {
      open_positions: state.modules['position-manager']?.openCount || 0,
      open_orders: state.modules['order-manager']?.openCount || 0,
      total_exposure: state.modules['position-manager']?.totalExposure || 0,
    },
  };
}
```

**Atomic File Write:**
```javascript
// kill-switch/state-snapshot.js
import fs from 'fs';
import path from 'path';

const STATE_FILE = './data/last-known-state.json';

export async function writeSnapshot(snapshot) {
  const tempFile = `${STATE_FILE}.tmp`;
  const dir = path.dirname(STATE_FILE);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file first (atomic)
  fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf-8');

  // Rename (atomic on most filesystems)
  fs.renameSync(tempFile, STATE_FILE);
}

export function readSnapshot() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const content = fs.readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(content);
}

export function isSnapshotStale(maxAgeMs = 5000) {
  const snapshot = readSnapshot();
  if (!snapshot) {
    return true;
  }

  const age = Date.now() - new Date(snapshot.timestamp).getTime();
  return age > maxAgeMs;
}
```

**Watchdog Kill Sequence Integration:**
```javascript
// kill-switch/commands.js - in kill command handler

async function handleKillCommand() {
  // ... existing kill sequence ...

  const killResult = await processManager.killMainProcess(pid);

  // After kill completes, read and log state
  const snapshot = stateSnapshot.readSnapshot();

  if (snapshot) {
    const staleThreshold = config.killSwitch?.stateStaleThresholdMs || 5000;
    const isStale = stateSnapshot.isSnapshotStale(staleThreshold);

    if (killResult.method === 'force' || killResult.method === KillMethod.FORCE) {
      snapshot.forced_kill = true;
      snapshot.stale_warning = isStale;

      if (isStale) {
        log('state_snapshot_stale_warning', {
          age_ms: Date.now() - new Date(snapshot.timestamp).getTime(),
          message: 'State snapshot from last known - verify with exchange',
        });
      }

      // Re-write with updated flags
      await stateSnapshot.writeSnapshot(snapshot);
    }

    // Log summary
    log('kill_complete_state_summary', {
      forced_kill: snapshot.forced_kill,
      stale_warning: snapshot.stale_warning,
      open_positions: snapshot.summary?.open_positions || 0,
      open_orders: snapshot.summary?.open_orders || 0,
      total_exposure: snapshot.summary?.total_exposure || 0,
      snapshot_age_ms: Date.now() - new Date(snapshot.timestamp).getTime(),
    });
  } else {
    log('kill_complete_no_state', {
      message: 'No state snapshot available - manual exchange verification required',
    });
  }

  return killResult;
}
```

### Position and Order Data Extraction

**From position-manager state (already implemented):**
```javascript
// src/modules/position-manager/state.js exports:
// - getCachedOpenPositions() - returns array of open positions
// - getCachedPositions(filterFn) - returns filtered positions
// - calculateTotalExposure() - returns total exposure

// In position-manager/index.js getState():
export function getState() {
  return {
    initialized: isInitialized,
    ...stateModule.getStats(),
    lastReconciliation: stateModule.getLastReconciliation(),
    openPositions: stateModule.getCachedOpenPositions(), // Full position objects
    totalExposure: stateModule.calculateTotalExposure(),
  };
}
```

**From order-manager state (already implemented):**
```javascript
// src/modules/order-manager/state.js exports:
// - getCachedOpenOrders() - returns array of open orders
// - getCachedOrders(filterFn) - returns filtered orders

// In order-manager/index.js getState():
export function getState() {
  return {
    initialized: isInitialized,
    ...stateModule.getStats(),
    openOrders: stateModule.getCachedOpenOrders(), // Full order objects
  };
}
```

### Configuration Updates

```javascript
// config/default.js
killSwitch: {
  gracefulTimeoutMs: 2000,     // 2 seconds for graceful shutdown (existing)
  stateFilePath: './data/last-known-state.json', // (existing)
  stateUpdateIntervalMs: 5000, // Periodic state update interval (NEW)
  stateStaleThresholdMs: 5000, // Consider snapshot stale after this (NEW)
},
```

### Testing Approach

**Unit tests for state-snapshot.js:**
- Test writeSnapshot creates valid JSON file
- Test atomic write (temp file → rename)
- Test readSnapshot parses correctly
- Test isSnapshotStale with various ages
- Test handling of missing directory
- Test handling of corrupted JSON

**Integration tests:**
- Start orchestrator → verify periodic writes occur
- Graceful shutdown → verify final snapshot with forced_kill=false
- Forced kill → verify watchdog adds forced_kill=true
- Stale detection → verify warning logged when snapshot old

```javascript
// kill-switch/__tests__/state-snapshot.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as stateSnapshot from '../state-snapshot.js';

describe('StateSnapshot', () => {
  const TEST_FILE = './data/test-state.json';

  beforeEach(() => {
    // Clean up test file
    if (fs.existsSync(TEST_FILE)) {
      fs.unlinkSync(TEST_FILE);
    }
  });

  describe('writeSnapshot', () => {
    it('should write valid JSON file', async () => {
      const snapshot = {
        version: 1,
        timestamp: new Date().toISOString(),
        positions: [],
        orders: [],
      };

      await stateSnapshot.writeSnapshot(snapshot, TEST_FILE);

      const content = fs.readFileSync(TEST_FILE, 'utf-8');
      expect(JSON.parse(content)).toEqual(snapshot);
    });

    it('should create directory if not exists', async () => {
      const deepPath = './data/nested/state.json';
      const snapshot = { version: 1, timestamp: new Date().toISOString() };

      await stateSnapshot.writeSnapshot(snapshot, deepPath);

      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });

  describe('isSnapshotStale', () => {
    it('should return true for old snapshot', () => {
      const oldTimestamp = new Date(Date.now() - 10000).toISOString();
      const snapshot = { version: 1, timestamp: oldTimestamp };
      fs.writeFileSync(TEST_FILE, JSON.stringify(snapshot));

      expect(stateSnapshot.isSnapshotStale(5000, TEST_FILE)).toBe(true);
    });

    it('should return false for fresh snapshot', () => {
      const freshTimestamp = new Date().toISOString();
      const snapshot = { version: 1, timestamp: freshTimestamp };
      fs.writeFileSync(TEST_FILE, JSON.stringify(snapshot));

      expect(stateSnapshot.isSnapshotStale(5000, TEST_FILE)).toBe(false);
    });
  });
});
```

### NFR Compliance

- **FR27** (Document state at kill time): Complete state snapshot written
- **NFR2** (Kill within 5 seconds): State snapshot doesn't add latency - uses last periodic update for forced kills
- **NFR8** (State persisted before acknowledging): Periodic writes ensure recent state available

### Previous Story Intelligence (4.1)

**From Story 4.1 Dev Notes:**
- Watchdog uses independent file logger at `logs/watchdog.log`
- Kill result includes: method (graceful/force), durationMs, success
- KillMethod enum: ALREADY_STOPPED, GRACEFUL, FORCE, FAILED
- PID file pattern established for process coordination
- State file path from config: `config.killSwitch.stateFilePath`

**Integration points from 4.1:**
- `kill-switch/process-manager.js` - killMainProcess() returns result
- `kill-switch/commands.js` - handleKillCommand() needs to add state reading
- `kill-switch/logger.js` - Use for logging state summaries
- `kill-switch/types.js` - Add StateSnapshot types

### Critical Implementation Notes

1. **Atomic Writes:** Always write to temp file then rename to prevent corrupted state files

2. **Non-Blocking Updates:** Periodic state writes should use async I/O and not block trading operations

3. **Graceful Shutdown Priority:** Final snapshot write should complete before process exit

4. **Watchdog Independence:** The watchdog's state reading should work even if main process modules crashed - read from file only

5. **Schema Version:** Include version field to allow future format changes

6. **Summary Stats:** Include pre-calculated summary (counts, exposure) for quick human review

7. **Position Details:** Include unrealized P&L in position snapshot for reconciliation

8. **Stale Warning Threshold:** Default 5 seconds - if snapshot older than this after forced kill, warn user to verify with exchange

### References

- [Source: architecture.md#Kill-Switch] - Kill switch architecture and state file path
- [Source: architecture.md#Database-Schema] - Position and order table schemas
- [Source: epics.md#Story-4.2] - Story requirements and acceptance criteria
- [Source: prd.md#FR27] - System can document exact state at time of kill for reconciliation
- [Source: config/default.js:46-50] - killSwitch configuration section with stateFilePath
- [Source: kill-switch/process-manager.js:135-204] - killMainProcess() implementation
- [Source: kill-switch/commands.js] - Command handlers for kill sequence
- [Source: src/modules/orchestrator/index.js:297-326] - getState() aggregates module states
- [Source: src/modules/orchestrator/index.js:333-368] - shutdown() method to integrate with
- [Source: src/modules/position-manager/state.js:118-120] - getCachedOpenPositions()
- [Source: src/modules/order-manager/state.js:99-107] - getCachedOpenOrders()

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass: 1044 tests across 34 test files

### Completion Notes List

- Created `kill-switch/state-snapshot.js` with atomic file writes, read/parse, staleness detection, and snapshot building functions
- Added `SnapshotVersion` and default constants to `kill-switch/types.js`
- Added `stateUpdateIntervalMs` and `stateStaleThresholdMs` to `config/default.js` killSwitch section
- Integrated periodic state updates into `src/modules/orchestrator/index.js`:
  - Added `startPeriodicStateUpdates()` function called after init
  - Added `stopPeriodicStateUpdates()` function called during shutdown
  - Added `writeStateSnapshot()` function to collect state from modules
  - Final snapshot written during graceful shutdown with `forced_kill: false`
- Integrated state snapshot with watchdog kill command in `kill-switch/commands.js`:
  - After kill, reads state snapshot and logs summary
  - For forced kills, marks snapshot with `forced_kill: true`
  - Checks staleness and warns if snapshot is old (>5s)
  - Returns snapshot summary in kill command result
- Created comprehensive tests in `kill-switch/__tests__/state-snapshot.test.js` (27 tests)
- All acceptance criteria met:
  - AC1: Graceful shutdown writes snapshot with forced_kill=false ✓
  - AC2: Forced kill marks snapshot with forced_kill=true and stale_warning ✓
  - AC3: Periodic updates at configurable interval (default 5s), non-blocking ✓
  - AC4: Snapshot includes positions, orders, timestamp, kill type for reconciliation ✓
  - AC5: JSON format with version field, snake_case, summary stats ✓
  - AC6: Watchdog reads snapshot, logs summary, warns on staleness ✓

### File List

**New files:**
- kill-switch/state-snapshot.js
- kill-switch/__tests__/state-snapshot.test.js

**Modified files:**
- kill-switch/types.js
- kill-switch/commands.js
- config/default.js
- src/modules/orchestrator/index.js

### Change Log

- 2026-01-31: Implemented Story 4.2 - State Snapshot on Kill feature for FR27 compliance

