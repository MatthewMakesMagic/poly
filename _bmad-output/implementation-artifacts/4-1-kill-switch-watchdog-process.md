# Story 4.1: Kill Switch Watchdog Process

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **a separate watchdog process that can kill trading instantly**,
So that **I can stop everything in <5 seconds even if the main process is hung (FR25, FR26)**.

## Acceptance Criteria

### AC1: Separate Process Architecture

**Given** the system is running
**When** the watchdog process starts
**Then** it runs as a separate Node.js process in `kill-switch/`
**And** it monitors the main process health
**And** it has its own PID independent of main process
**And** watchdog can be started/stopped independently of main process

### AC2: Kill Command Execution

**Given** a kill command is issued
**When** user runs `cli kill` or sends SIGTERM to watchdog
**Then** watchdog sends graceful shutdown signal (SIGTERM) to main process
**And** if no response within 2 seconds, watchdog sends SIGKILL
**And** total time from command to halt is <5 seconds (NFR2)
**And** watchdog logs each step of the kill sequence

### AC3: Unresponsive Main Process Handling

**Given** the main process is hung/unresponsive
**When** kill is triggered (FR26)
**Then** watchdog can still execute (separate process)
**And** SIGKILL forcibly terminates main process
**And** watchdog logs "Forced kill executed - main process unresponsive"
**And** watchdog records kill event with timestamp and reason

### AC4: Watchdog CLI Interface

**Given** the watchdog module
**When** inspecting its interface
**Then** it runs standalone via `node kill-switch/watchdog.js`
**And** it accepts commands: start, stop, kill, status
**And** each command provides appropriate feedback
**And** help command shows usage information

### AC5: Main Process PID Tracking

**Given** the main process starts
**When** it is running
**Then** main process writes its PID to `data/main.pid`
**And** watchdog reads this PID to know which process to signal
**And** PID file is cleaned up on graceful shutdown
**And** stale PID files are detected and handled

### AC6: Watchdog Health Monitoring

**Given** the watchdog is monitoring the main process
**When** polling for status
**Then** watchdog checks if main process PID is still running
**And** detects if main process has crashed/exited
**And** logs status changes (running, stopped, unresponsive)
**And** can report current status via CLI

## Tasks / Subtasks

- [x] **Task 1: Create Kill Switch Directory Structure** (AC: 1, 4)
  - [x] 1.1 Create `kill-switch/watchdog.js` - Main watchdog entry point
  - [x] 1.2 Create `kill-switch/commands.js` - CLI command handlers
  - [x] 1.3 Create `kill-switch/process-manager.js` - Process signal/monitoring logic
  - [x] 1.4 Create `kill-switch/state.js` - Watchdog state tracking
  - [x] 1.5 Create `kill-switch/types.js` - Error types and constants
  - [x] 1.6 Create `kill-switch/__tests__/` directory for tests
  - [x] 1.7 Update `kill-switch/README.md` with usage documentation

- [x] **Task 2: Implement PID File Management** (AC: 5)
  - [x] 2.1 Create function to write PID file at `data/main.pid`
  - [x] 2.2 Create function to read PID file
  - [x] 2.3 Create function to remove PID file on shutdown
  - [x] 2.4 Detect stale PID files (process doesn't exist)
  - [x] 2.5 Handle concurrent access to PID file safely
  - [x] 2.6 Add PID file write to main process startup (orchestrator or src/index.js)

- [x] **Task 3: Implement Process Manager** (AC: 2, 3)
  - [x] 3.1 Create `sendGracefulShutdown(pid)` - sends SIGTERM
  - [x] 3.2 Create `sendForceKill(pid)` - sends SIGKILL
  - [x] 3.3 Create `isProcessRunning(pid)` - checks if PID exists
  - [x] 3.4 Create `waitForProcessExit(pid, timeoutMs)` - waits for process to exit
  - [x] 3.5 Implement kill sequence: SIGTERM → wait 2s → SIGKILL if needed
  - [x] 3.6 Return kill result with timing and method used

- [x] **Task 4: Implement Watchdog Commands** (AC: 4)
  - [x] 4.1 Implement `start` command - starts watching main process
  - [x] 4.2 Implement `stop` command - stops watchdog gracefully
  - [x] 4.3 Implement `kill` command - triggers kill sequence
  - [x] 4.4 Implement `status` command - reports main process and watchdog status
  - [x] 4.5 Implement `help` command - shows usage information
  - [x] 4.6 Parse command line arguments with clear syntax

- [x] **Task 5: Implement Health Monitoring** (AC: 6)
  - [x] 5.1 Create `checkHealth()` function - polls main process status
  - [x] 5.2 Track last known status (running, stopped, unresponsive)
  - [x] 5.3 Log status changes for audit trail
  - [x] 5.4 Optional heartbeat file monitoring (for deeper health checks)
  - [x] 5.5 Report comprehensive status including uptime, last check time

- [x] **Task 6: Implement Watchdog Logging** (AC: 2, 3)
  - [x] 6.1 Create simple file logger for watchdog (independent of main logger)
  - [x] 6.2 Log all kill sequence steps with timestamps
  - [x] 6.3 Log health check results
  - [x] 6.4 Structured JSON format matching architecture
  - [x] 6.5 Log file at `logs/watchdog.log`

- [x] **Task 7: Integrate with CLI** (AC: 4)
  - [x] 7.1 Create `cli/commands/kill.js` - wraps watchdog kill command
  - [x] 7.2 Add kill command to CLI router
  - [x] 7.3 Provide user feedback during kill sequence
  - [x] 7.4 Handle edge cases (watchdog not running, main not running)

- [x] **Task 8: Write Tests** (AC: all)
  - [x] 8.1 Test PID file write/read/remove
  - [x] 8.2 Test stale PID detection
  - [x] 8.3 Test sendGracefulShutdown() sends SIGTERM
  - [x] 8.4 Test sendForceKill() sends SIGKILL
  - [x] 8.5 Test isProcessRunning() for existing and non-existing PIDs
  - [x] 8.6 Test kill sequence completes within 5 seconds
  - [x] 8.7 Test kill sequence uses SIGKILL after timeout
  - [x] 8.8 Test watchdog commands (start, stop, kill, status)
  - [x] 8.9 Test health monitoring detects process status changes
  - [x] 8.10 Integration test: start main → start watchdog → kill → verify stopped

## Dev Notes

### Architecture Compliance

This story creates the kill switch watchdog as a separate process that can forcibly terminate the main trading process. This is critical safety infrastructure (FR25, FR26).

**From architecture.md#Kill-Switch:**
```
┌─────────────────┐     ┌─────────────────┐
│  Main Process   │     │  Kill Switch    │
│  (Orchestrator) │◄────│  (Watchdog)     │
│                 │     │                 │
│  - Trading      │     │  - Monitors     │
│  - Positions    │     │  - Can SIGKILL  │
│  - Orders       │     │  - Writes state │
└─────────────────┘     └─────────────────┘
```

**Kill sequence:**
1. User triggers kill (CLI command or signal)
2. Watchdog sends graceful shutdown signal
3. If no response in 2s → SIGKILL
4. Watchdog writes state snapshot from last known state
5. <5s total guaranteed

**From architecture.md#Project-Structure:**
```
kill-switch/
├── watchdog.js               # Separate watchdog process
├── state-snapshot.js         # State snapshot writer
└── README.md                 # Kill switch documentation
```

### Project Structure Notes

**Module location:** `kill-switch/` (top-level, NOT under src/modules/)

This is a **standalone process** that does NOT use the standard module interface (init, getState, shutdown). It runs independently via `node kill-switch/watchdog.js <command>`.

Create these files:
```
kill-switch/
├── watchdog.js          # Entry point, CLI argument parsing
├── commands.js          # Command handlers (start, stop, kill, status)
├── process-manager.js   # Signal sending, process checking
├── state.js             # Watchdog state tracking
├── types.js             # Error types, constants
├── README.md            # Usage documentation
└── __tests__/
    ├── process-manager.test.js  # Unit tests for process management
    ├── commands.test.js         # Unit tests for CLI commands
    └── watchdog.test.js         # Integration tests
```

### PID File Strategy

**Main process PID file:** `data/main.pid`
- Written by main process at startup
- Contains just the PID number as text
- Removed on graceful shutdown
- Watchdog reads to know which process to signal

**Stale PID detection:**
```javascript
function isStale(pidFile) {
  const pid = fs.readFileSync(pidFile, 'utf-8').trim();
  try {
    // Sending signal 0 doesn't kill, just checks if process exists
    process.kill(parseInt(pid), 0);
    return false; // Process exists
  } catch (err) {
    if (err.code === 'ESRCH') {
      return true; // No such process - stale
    }
    throw err; // Other error (e.g., EPERM)
  }
}
```

### Kill Sequence Implementation

```javascript
// kill-switch/process-manager.js

const GRACEFUL_TIMEOUT_MS = 2000; // From config.killSwitch.gracefulTimeoutMs

async function killMainProcess(pid) {
  const startTime = Date.now();
  const result = {
    pid,
    startedAt: new Date().toISOString(),
    gracefulSent: false,
    forceSent: false,
    completedAt: null,
    durationMs: 0,
    method: null, // 'graceful' or 'force'
    success: false,
  };

  // Step 1: Check if process exists
  if (!isProcessRunning(pid)) {
    result.method = 'already_stopped';
    result.success = true;
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // Step 2: Send graceful shutdown (SIGTERM)
  log('kill_graceful_start', { pid });
  sendGracefulShutdown(pid);
  result.gracefulSent = true;

  // Step 3: Wait for graceful exit
  const exited = await waitForProcessExit(pid, GRACEFUL_TIMEOUT_MS);

  if (exited) {
    result.method = 'graceful';
    result.success = true;
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - startTime;
    log('kill_graceful_success', { pid, durationMs: result.durationMs });
    return result;
  }

  // Step 4: Force kill (SIGKILL) if graceful failed
  log('kill_force_start', { pid, reason: 'graceful_timeout' });
  sendForceKill(pid);
  result.forceSent = true;

  // Step 5: Verify process is dead
  await sleep(100); // Brief wait for SIGKILL to take effect
  if (!isProcessRunning(pid)) {
    result.method = 'force';
    result.success = true;
  } else {
    result.method = 'failed';
    result.success = false;
    log('kill_failed', { pid, reason: 'process_still_running' });
  }

  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - startTime;

  if (result.success && result.forceSent) {
    log('kill_force_success', { pid, durationMs: result.durationMs });
  }

  return result;
}

function sendGracefulShutdown(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
    // Process already gone - that's fine
  }
}

function sendForceKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
    // Process already gone - that's fine
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check existence only
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    // EPERM means process exists but we can't signal it
    // For our own processes, this shouldn't happen
    throw err;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(100); // Poll every 100ms
  }
  return false;
}
```

### Watchdog CLI Interface

```
Usage: node kill-switch/watchdog.js <command>

Commands:
  start     Start watching the main process
  stop      Stop the watchdog
  kill      Trigger kill sequence on main process
  status    Show status of main process and watchdog
  help      Show this help message

Examples:
  node kill-switch/watchdog.js start
  node kill-switch/watchdog.js kill
  node kill-switch/watchdog.js status
```

### Main Process Integration

**Add PID file writing to main process startup:**

```javascript
// src/index.js or orchestrator init

import fs from 'fs';
import path from 'path';

const PID_FILE = './data/main.pid';

function writePidFile() {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
}

function removePidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove PID file:', err);
    }
  }
}

// On startup
writePidFile();

// On graceful shutdown
process.on('SIGTERM', async () => {
  // ... graceful shutdown logic ...
  removePidFile();
  process.exit(0);
});

process.on('SIGINT', async () => {
  // ... graceful shutdown logic ...
  removePidFile();
  process.exit(0);
});
```

### Watchdog Logging

The watchdog has its own simple logger (independent of main logger module):

```javascript
// kill-switch/watchdog.js

import fs from 'fs';
import path from 'path';

const LOG_FILE = './logs/watchdog.log';

function log(event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'watchdog',
    event,
    data,
  };

  const line = JSON.stringify(entry) + '\n';

  // Ensure logs directory exists
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Append to log file
  fs.appendFileSync(LOG_FILE, line, 'utf-8');

  // Also print to console for CLI feedback
  console.log(`[${entry.timestamp}] ${event}`, data);
}
```

### Error Types

```javascript
// kill-switch/types.js

export const WatchdogErrorCodes = {
  PID_FILE_NOT_FOUND: 'PID_FILE_NOT_FOUND',
  PID_FILE_STALE: 'PID_FILE_STALE',
  MAIN_PROCESS_NOT_RUNNING: 'MAIN_PROCESS_NOT_RUNNING',
  KILL_FAILED: 'KILL_FAILED',
  INVALID_COMMAND: 'INVALID_COMMAND',
  WATCHDOG_ALREADY_RUNNING: 'WATCHDOG_ALREADY_RUNNING',
};

export class WatchdogError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'WatchdogError';
    this.code = code;
    this.context = context;
  }
}
```

### Configuration Usage

From `config/default.js`:
```javascript
killSwitch: {
  gracefulTimeoutMs: 2000,     // 2 seconds for graceful shutdown
  stateFilePath: './data/last-known-state.json',
}
```

The watchdog reads this config for timeout values. State file path is used by Story 4.2 (state snapshot).

### Testing Approach

**Unit tests for process-manager.js:**
- Mock `process.kill()` to test signal sending
- Test `isProcessRunning()` with mock PIDs
- Test `waitForProcessExit()` timing behavior

**Integration tests:**
- Spawn a test child process
- Use watchdog to kill it
- Verify process is terminated
- Verify timing is <5 seconds

```javascript
// kill-switch/__tests__/process-manager.test.js

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fork } from 'child_process';
import * as processManager from '../process-manager.js';

describe('ProcessManager', () => {
  describe('killMainProcess', () => {
    it('should complete within 5 seconds', async () => {
      // Spawn a long-running child process
      const child = fork('./test-fixtures/long-running.js');

      const startTime = Date.now();
      const result = await processManager.killMainProcess(child.pid);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
    });

    it('should use SIGKILL for unresponsive processes', async () => {
      // Spawn a process that ignores SIGTERM
      const child = fork('./test-fixtures/ignore-sigterm.js');

      const result = await processManager.killMainProcess(child.pid);

      expect(result.success).toBe(true);
      expect(result.forceSent).toBe(true);
      expect(result.method).toBe('force');
    });

    it('should use graceful shutdown for responsive processes', async () => {
      // Spawn a process that handles SIGTERM properly
      const child = fork('./test-fixtures/handles-sigterm.js');

      const result = await processManager.killMainProcess(child.pid);

      expect(result.success).toBe(true);
      expect(result.forceSent).toBe(false);
      expect(result.method).toBe('graceful');
    });
  });
});
```

### NFR Compliance

- **FR25** (Kill switch halts in 5 seconds): Kill sequence uses 2s graceful timeout + immediate SIGKILL = <5s total
- **FR26** (Kill switch works if main unresponsive): Separate process with SIGKILL capability
- **NFR2** (Kill switch halts all activity within 5 seconds): Verified by timing tests

### Future Story Integration

**Story 4.2 (State Snapshot on Kill):**
- After kill sequence completes, watchdog writes state to `data/last-known-state.json`
- This story focuses on the kill mechanism; Story 4.2 adds state capture

**Story 4.3 and 4.4 (Drawdown):**
- Drawdown limits can trigger automatic kill via this watchdog
- The `kill` command API is reusable for auto-stop

### Critical Implementation Notes

1. **Separate Process:** The watchdog MUST be a completely separate Node.js process. It cannot be a module within the main process, or it won't work when main is hung.

2. **No Module Interface:** Unlike src/modules/*, the kill-switch does NOT export init/getState/shutdown. It's a standalone CLI tool.

3. **PID File Race Conditions:** Handle cases where PID file exists but process doesn't (stale), or process exists but PID file doesn't (crashed before write).

4. **Signal Errors:** `process.kill()` throws ESRCH if process doesn't exist. Handle this gracefully.

5. **Permissions:** The watchdog needs to run as the same user as the main process to send signals.

6. **Timing Guarantee:** The 5-second guarantee comes from: 2s graceful timeout + SIGKILL (immediate) + small buffer. Tests must verify this.

7. **Console Output:** The watchdog should provide clear console feedback for CLI users, in addition to file logging.

8. **Independent Logger:** Use a simple file-based logger, not the main logger module. The watchdog must work even if main process modules are broken.

### References

- [Source: architecture.md#Kill-Switch] - Kill switch architecture diagram and sequence
- [Source: architecture.md#Project-Structure] - kill-switch/ directory location
- [Source: architecture.md#Inter-Module-Communication] - Note: kill-switch is NOT a module
- [Source: epics.md#Story-4.1] - Story requirements and acceptance criteria
- [Source: prd.md#FR25] - Kill switch halts trading within 5 seconds
- [Source: prd.md#FR26] - Kill switch works even if main process unresponsive
- [Source: prd.md#NFR2] - Kill switch halts all activity within 5 seconds
- [Source: config/default.js:46-50] - killSwitch configuration section
- [Source: src/types/errors.js:150-152] - KILL_SWITCH_ACTIVATED error code already defined
- [Source: src/modules/orchestrator/index.js:280-312] - Main process shutdown() method to integrate with

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass: 1017 tests across 33 test files
- Kill switch specific tests: 43 tests (26 process-manager, 13 commands, 4 integration)
- NFR2 compliance verified: kill sequence completes in <5 seconds

### Completion Notes List

- ✅ Implemented kill switch watchdog as separate Node.js process in `kill-switch/` directory
- ✅ PID file management: write on init, read for watchdog, remove on shutdown
- ✅ Process manager with SIGTERM (graceful) → wait 2s → SIGKILL (force) sequence
- ✅ Watchdog commands: start, stop, kill, status, help
- ✅ Health monitoring with periodic polling and status change logging
- ✅ Independent JSON logger at `logs/watchdog.log`
- ✅ CLI integration via `cli/commands/kill.js`
- ✅ Comprehensive test suite including integration tests
- ✅ Orchestrator integration: writes PID on init, removes on shutdown

### File List

**New files:**
- kill-switch/watchdog.js - Main entry point and CLI interface
- kill-switch/commands.js - Command handlers (start, stop, kill, status, help)
- kill-switch/process-manager.js - Signal sending, kill sequence, PID management
- kill-switch/state.js - Watchdog state tracking
- kill-switch/types.js - Error codes, constants, WatchdogError class
- kill-switch/logger.js - Independent JSON file logger
- kill-switch/README.md - Usage documentation
- kill-switch/__tests__/process-manager.test.js - Unit and integration tests
- kill-switch/__tests__/commands.test.js - Command handler tests
- kill-switch/__tests__/watchdog.test.js - End-to-end integration tests
- cli/commands/kill.js - CLI wrapper for kill command

**Modified files:**
- src/modules/orchestrator/index.js - Added PID file write/remove on init/shutdown

## Change Log

- 2026-01-31: Implemented Story 4.1 - Kill Switch Watchdog Process
  - Created kill-switch module with watchdog.js entry point
  - Implemented 2-phase kill sequence (SIGTERM → SIGKILL)
  - Added PID file management for main process tracking
  - Integrated with orchestrator for automatic PID file handling
  - Added comprehensive test suite (43 tests)
  - Verified NFR2 compliance (<5 second kill time)

