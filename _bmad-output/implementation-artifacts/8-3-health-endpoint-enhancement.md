# Story 8.3: Health Endpoint Enhancement

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **deployment system**,
I want **the health endpoint to report exactly what's running**,
So that **I can verify the deployment matches the manifest**.

## Acceptance Criteria

1. **Given** the health endpoint exists
   **When** calling `GET /api/live/status`
   **Then** response includes active_strategies array
   **And** response includes connection status for all services
   **And** response includes last_tick timestamp
   **And** response includes error_count_1m

2. **Given** orchestrator loaded strategies from manifest
   **When** health endpoint reports active_strategies
   **Then** the list matches exactly what orchestrator loaded

3. **Given** performance requirements
   **When** health endpoint is called
   **Then** response time is < 500ms

## Tasks / Subtasks

- [x] Task 1: Add HTTP server to live trading entry point (AC: #1, #3)
  - [x] 1.1: Import `http` module in `scripts/run_live_trading.mjs`
  - [x] 1.2: Create HTTP server listening on PORT env var (default 3333)
  - [x] 1.3: Implement request routing for `/api/live/*` paths
  - [x] 1.4: Add server startup logging with port number
  - [x] 1.5: Graceful server shutdown in existing shutdown handler

- [x] Task 2: Implement `/api/live/status` endpoint (AC: #1, #2, #3)
  - [x] 2.1: Create `buildStatusResponse()` function that gathers all health data
  - [x] 2.2: Get `active_strategies` from `orchestrator.getState().loadedStrategies`
  - [x] 2.3: Get `uptime_seconds` from `orchestrator.getState().startedAt`
  - [x] 2.4: Get connection status: database, rtds, polymarket from module states
  - [x] 2.5: Get `last_tick` from RTDS client state (`stats.last_tick_at`)
  - [x] 2.6: Get `active_windows` count from window-manager state
  - [x] 2.7: Calculate `error_count_1m` from orchestrator error tracking
  - [x] 2.8: Set response Content-Type to `application/json`
  - [x] 2.9: Ensure response time < 500ms (no blocking operations)

- [x] Task 3: Add 1-minute error counting to orchestrator (AC: #1)
  - [x] 3.1: Add `errorTimestamps` array to orchestrator state
  - [x] 3.2: Push timestamp on each error in `handleLoopError()`
  - [x] 3.3: Add `getErrorCount1m()` function that filters timestamps in last 60s
  - [x] 3.4: Prune old timestamps periodically (on each error or via interval)

- [x] Task 4: Enhance orchestrator getState() for health endpoint (AC: #2)
  - [x] 4.1: Ensure `loadedStrategies` array is always returned (never undefined)
  - [x] 4.2: Add `startedAt` timestamp to state
  - [x] 4.3: Add `errorCount1m` to state return value
  - [x] 4.4: Add module connection states for database, rtds, polymarket

- [x] Task 5: Determine overall health status (AC: #1)
  - [x] 5.1: Create `determineHealthStatus()` function
  - [x] 5.2: Return "healthy" if: all connections ok, error_count_1m < 5, receiving ticks
  - [x] 5.3: Return "degraded" if: some connections ok, or moderate errors
  - [x] 5.4: Return "unhealthy" if: critical connections down, or high error rate

- [x] Task 6: Write tests
  - [x] 6.1: Unit test for `buildStatusResponse()` with mocked orchestrator state
  - [x] 6.2: Unit test for `getErrorCount1m()` with various timestamp scenarios
  - [x] 6.3: Unit test for `determineHealthStatus()` with various conditions
  - [x] 6.4: Integration test: start server, call `/api/live/status`, verify JSON response
  - [x] 6.5: Performance test: verify response time < 500ms

## Dev Notes

### Architecture Compliance

This story **enhances the existing entry point script** (`scripts/run_live_trading.mjs`) rather than creating a new module. The health endpoint reads state from existing modules via orchestrator.

**Key Pattern:** Health endpoint is a thin HTTP layer that queries existing module states. No new module needed - this follows the "scripts read from modules" pattern established in Story 8-2.

```
scripts/run_live_trading.mjs
├── HTTP Server (new)
│   └── GET /api/live/status
│       └── Calls orchestrator.getState()
│           └── Returns aggregated module states
```

### Previous Story Intelligence (8-1, 8-2)

**From Story 8-1 (Launch Manifest):**
- Orchestrator now tracks `loadedStrategies` in state
- `getState()` returns `loadedStrategies: loadedManifest?.strategies ?? []`
- Access via: `orchestrator.getState().loadedStrategies`

**From Story 8-2 (Pre-flight Checks):**
- Established pattern for reading module states
- Database connection check pattern
- Polymarket API check pattern

### Project Structure Notes

**Files to Modify:**
- `scripts/run_live_trading.mjs` (add HTTP server and status endpoint)
- `src/modules/orchestrator/index.js` (enhance getState() for error_count_1m)
- `src/modules/orchestrator/state.js` (add errorTimestamps tracking)

**No New Files Needed** - This story enhances existing files.

**Expected Response Schema (from Epic 8):**
```json
{
  "status": "healthy",
  "uptime_seconds": 1234,
  "active_strategies": ["oracle-edge", "simple-threshold"],
  "connections": {
    "database": "connected",
    "rtds": "connected",
    "polymarket": "authenticated"
  },
  "last_tick": "2026-02-01T12:34:56.789Z",
  "active_windows": 4,
  "error_count_1m": 0
}
```

### Technical Requirements

**HTTP Server Pattern:**
```javascript
import { createServer } from 'http';

const PORT = process.env.PORT || 3333;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/live/status') {
    const status = buildStatusResponse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  log.info('http_server_started', { port: PORT });
});
```

**Connection Status Determination:**
```javascript
function getConnectionStatus() {
  const state = orchestrator.getState();

  return {
    database: state.modules?.persistence?.initialized ? 'connected' : 'disconnected',
    rtds: state.modules?.['rtds']?.connected ? 'connected' : 'disconnected',
    polymarket: state.modules?.polymarket?.authenticated ? 'authenticated' : 'disconnected',
  };
}
```

**Error Count Tracking Pattern:**
```javascript
// In orchestrator state.js
let errorTimestamps = [];

export function recordError() {
  const now = Date.now();
  errorTimestamps.push(now);
  // Prune old timestamps (older than 5 minutes to save memory)
  errorTimestamps = errorTimestamps.filter(ts => now - ts < 5 * 60 * 1000);
}

export function getErrorCount1m() {
  const oneMinuteAgo = Date.now() - 60 * 1000;
  return errorTimestamps.filter(ts => ts > oneMinuteAgo).length;
}
```

**Health Status Determination:**
```javascript
function determineHealthStatus(connections, errorCount1m, lastTick) {
  const allConnected = Object.values(connections).every(s => s !== 'disconnected');
  const recentTick = lastTick && (Date.now() - new Date(lastTick).getTime()) < 30000;

  if (allConnected && errorCount1m === 0 && recentTick) {
    return 'healthy';
  }
  if (connections.database === 'connected' && errorCount1m < 10) {
    return 'degraded';
  }
  return 'unhealthy';
}
```

### Module State Access Patterns

**RTDS Client State** (for last_tick):
```javascript
const rtdsState = orchestrator.getState().modules?.['rtds'] || {};
// rtdsState.stats.last_tick_at contains ISO timestamp of last price tick
```

**Window Manager State** (for active_windows):
```javascript
const wmState = orchestrator.getState().modules?.['window-manager'] || {};
// wmState.activeWindows or wmState.windowCount
```

**Persistence State** (for database connection):
```javascript
const dbState = orchestrator.getState().modules?.persistence || {};
// dbState.initialized indicates connection status
```

**Polymarket State** (for API connection):
```javascript
const pmState = orchestrator.getState().modules?.polymarket || {};
// pmState.authenticated indicates auth status
```

### Railway Integration

The health endpoint path `/api/live/status` is already configured in Railway:
- `railway.live.json` specifies `"healthcheckPath": "/api/live/status"`
- Railway uses this endpoint for health checks to determine deployment success
- Endpoint must return 200 for healthy status, non-200 for unhealthy

### Error Handling

- Health endpoint should NEVER throw - always return valid JSON
- If orchestrator not initialized, return `{ status: "unhealthy", error: "not_initialized" }`
- If any module state access fails, mark that service as "unknown" not "disconnected"
- Log health check requests at debug level to avoid log spam

### Testing Strategy

**Unit Tests (scripts/__tests__/health-endpoint.test.js):**
- Mock `orchestrator.getState()` with various module states
- Test `buildStatusResponse()` produces correct JSON structure
- Test `determineHealthStatus()` logic for all status conditions
- Test `getErrorCount1m()` with various timestamp arrays

**Integration Tests:**
- Spin up HTTP server on test port
- Make actual HTTP request to `/api/live/status`
- Verify response is valid JSON with expected fields
- Verify response time < 500ms

### References

- [Source: _bmad-output/planning-artifacts/epic-8-launch-control.md#Story 8-3]
- [Source: _bmad-output/implementation-artifacts/8-1-launch-manifest.md - orchestrator loadedStrategies pattern]
- [Source: _bmad-output/implementation-artifacts/8-2-pre-flight-checks.md - module state access patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: src/modules/orchestrator/index.js:439-470 - getState() implementation]
- [Source: src/clients/rtds/index.js:87-107 - RTDS getState() with stats.last_tick_at]
- [Source: railway.live.json:10 - healthcheckPath configuration]
- [Source: scripts/run_live_trading.mjs - entry point to enhance]

### Git Intelligence

Recent commits show:
- `cc736b4` - Config loading patterns
- `e3243a8` - Strategy implementation patterns
- Story 8-1 and 8-2 established orchestrator state patterns

The project uses:
- ES modules (`import`/`export`)
- Native Node.js `http` module (no external dependencies like Express)
- vitest for testing
- Structured logging via `child({ module: 'name' })`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - implementation proceeded without issues.

### Completion Notes List

- **Task 1 Complete:** Added HTTP server to `scripts/run_live_trading.mjs` using native Node.js `http` module. Server listens on PORT env var (default 3333) and includes graceful shutdown in existing handler.

- **Task 2 Complete:** Created `scripts/health-endpoint.mjs` module with `buildStatusResponse()` function. Returns complete JSON with status, uptime_seconds, active_strategies, connections, last_tick, active_windows, and error_count_1m. All data sourced from orchestrator.getState().

- **Task 3 Complete:** Added error timestamp tracking to `src/modules/orchestrator/state.js` with `recordError()` and `getErrorCount1m()` functions. Timestamps auto-prune after 5 minutes on each error.

- **Task 4 Complete:** Enhanced orchestrator `getState()` to include `errorCount1m` field. The `loadedStrategies` and `startedAt` fields were already present from Story 8-1.

- **Task 5 Complete:** Implemented `determineHealthStatus()` with three-state logic: healthy (all OK), degraded (minor issues), unhealthy (critical failures). Handles unknown states gracefully.

- **Task 6 Complete:** Added 46 tests across two test files:
  - `scripts/__tests__/health-endpoint.test.js` - 39 tests for buildStatusResponse, getConnectionStatus, determineHealthStatus, HTTP server integration
  - `src/modules/orchestrator/__tests__/state-error-tracking.test.js` - 7 tests for recordError and getErrorCount1m

All 2823 tests pass including regression tests.

### File List

**New Files:**
- `scripts/health-endpoint.mjs` - Health endpoint logic module
- `scripts/__tests__/health-endpoint.test.js` - Health endpoint unit tests
- `src/modules/orchestrator/__tests__/state-error-tracking.test.js` - Error tracking tests

**Modified Files:**
- `scripts/run_live_trading.mjs` - Added HTTP server and health endpoint
- `src/modules/orchestrator/index.js` - Added recordError call in handleLoopError, added errorCount1m to getState
- `src/modules/orchestrator/state.js` - Added error timestamp tracking functions

## Senior Developer Review (AI)

### Review Date: 2026-02-01

### Reviewer: Claude Opus 4.5 (Adversarial Code Review)

### Outcome: **APPROVED WITH FIXES APPLIED**

### Issues Found & Fixed:

| # | Severity | Issue | Fix Applied |
|---|----------|-------|-------------|
| 1 | **MEDIUM** | Test describe block named "HTTP Server Integration" but tests didn't actually test HTTP - only tested `buildStatusResponse()` function. No real HTTP integration tests existed. | Added 3 actual HTTP integration tests using Node's native fetch: (1) valid JSON response test, (2) 500ms performance test (AC#3), (3) 404 for unknown paths. Renamed original tests to "Response Serialization". |
| 2 | **LOW** | Story claimed "33 tests" but actual count was different | Updated story to reflect accurate test count: 46 tests (39 + 7) |
| 3 | **LOW** | Test file imported `createServer` but never used it | Now properly used in HTTP integration tests |

### Verification:
- All 2823 tests pass (including 3 new HTTP integration tests)
- AC#1: Health endpoint returns all required fields ✓
- AC#2: active_strategies matches orchestrator.loadedStrategies ✓
- AC#3: Response time < 500ms verified with actual HTTP test ✓

### Code Quality Assessment:
- **Security**: No vulnerabilities found. Input validation on PORT env var. No injection risks.
- **Error Handling**: Excellent - health endpoint never throws, always returns valid JSON
- **Performance**: buildStatusResponse() runs in <1ms, HTTP round-trip <500ms verified
- **Test Coverage**: Comprehensive unit tests + actual HTTP integration tests

## Change Log

- 2026-02-01: **[Code Review]** Added 3 HTTP integration tests, fixed misleading test names, updated test counts
- 2026-02-01: Implemented health endpoint enhancement (Story 8-3) - HTTP server with /api/live/status endpoint, error tracking, health status determination

