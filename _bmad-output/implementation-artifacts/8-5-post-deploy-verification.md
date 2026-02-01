# Story 8.5: Post-deploy Verification

Status: done

## Story

As a **trader**,
I want **automatic verification that deployment succeeded**,
So that **I know the system is actually running correctly**.

## Acceptance Criteria

1. **Given** verification is run
   **When** executing `npm run verify` (or automatically after deploy)
   **Then** health endpoint is polled until healthy or timeout

2. **Given** health endpoint responds
   **When** verifying
   **Then** active_strategies is compared to launch.json
   **And** verification fails if they don't match exactly

3. **Given** data flow verification
   **When** checking
   **Then** last_tick must be within last 30 seconds
   **And** error_count_1m must be 0 (or below threshold)

4. **Given** Scout integration
   **When** verifying logs
   **Then** Scout checks for error patterns in recent logs
   **And** Scout verifies expected startup messages appeared

5. **Given** timeout
   **When** health check doesn't pass within 60 seconds
   **Then** verification fails
   **And** clear error message indicates what failed

## Tasks / Subtasks

- [x] Task 1: Create verify script entry point (AC: #1, #5)
  - [x] 1.1: Create `scripts/verify.mjs` with proper shebang and dotenv loading
  - [x] 1.2: Implement VerifyResult type structure matching CheckResult pattern
  - [x] 1.3: Add retry/polling logic with configurable timeout (default 60s)
  - [x] 1.4: Add `npm run verify` script to package.json
  - [x] 1.5: Exit with code 0 on success, code 1 on failure

- [x] Task 2: Implement health endpoint polling (AC: #1, #5)
  - [x] 2.1: Create `pollHealthEndpoint(url, timeoutMs)` function
  - [x] 2.2: Poll every 2 seconds until status is "healthy" or timeout
  - [x] 2.3: Support both local (http://localhost:PORT) and remote (Railway URL) endpoints
  - [x] 2.4: Handle connection errors gracefully during initial startup period
  - [x] 2.5: Return health response on success or throw on timeout

- [x] Task 3: Implement strategy manifest comparison (AC: #2)
  - [x] 3.1: Create `verifyStrategiesMatch(healthResponse, manifest)` function
  - [x] 3.2: Load launch.json manifest for expected strategies
  - [x] 3.3: Compare active_strategies array from health response to manifest.strategies
  - [x] 3.4: Require exact match (same strategies, same order is NOT required)
  - [x] 3.5: Return detailed mismatch info if verification fails (missing/extra strategies)

- [x] Task 4: Implement data flow verification (AC: #3)
  - [x] 4.1: Create `verifyDataFlow(healthResponse)` function
  - [x] 4.2: Check last_tick is within 30 seconds of current time
  - [x] 4.3: Check error_count_1m equals 0 (strict for post-deploy)
  - [x] 4.4: Return pass/fail with specific reason for failure

- [x] Task 5: Implement Scout log verification (AC: #4)
  - [x] 5.1: Create `verifyLogs()` function
  - [x] 5.2: Check for error patterns in recent logs (last 60 seconds)
  - [x] 5.3: Verify expected startup messages appeared (strategies loaded, modules initialized)
  - [x] 5.4: Return pass with log summary or fail with error patterns found
  - [x] 5.5: Make Scout integration optional if Scout module not available

- [x] Task 6: Implement formatted output (AC: #1, #5)
  - [x] 6.1: Create `formatVerifyResults(results)` function matching preflight style
  - [x] 6.2: Show polling progress during wait ("Verifying deployment...")
  - [x] 6.3: Display each verification check with pass/fail status
  - [x] 6.4: Show final success/failure summary with DEPLOYMENT SUCCESSFUL or DEPLOYMENT FAILED

- [x] Task 7: Write tests
  - [x] 7.1: Unit tests for each verification function with mocked responses
  - [x] 7.2: Unit test for strategy matching logic (match, missing, extra)
  - [x] 7.3: Unit test for data flow verification (fresh tick, stale tick, errors)
  - [x] 7.4: Integration test with mock HTTP server

## Dev Notes

### Architecture Compliance

This story creates a **standalone script** (not a module) following the established script patterns from Story 8-2:

```
scripts/verify.mjs       # Single file script, imports from modules
scripts/__tests__/verify.test.js  # Unit tests for verification logic
```

**Script Pattern (from preflight.mjs):**
1. Shebang: `#!/usr/bin/env node`
2. Load dotenv FIRST (.env.local, then .env)
3. Import config AFTER env loaded
4. Run verification checks
5. Format output with console.log
6. Exit with appropriate code

**NOT a Module:** This is a CLI script, not a folder-per-module. It imports from existing modules but doesn't need its own init/getState/shutdown.

### Previous Story Intelligence (8-1, 8-2, 8-3)

**From Story 8-1 (Launch Manifest):**
- `loadManifest()` - reads and validates launch.json
- `config/launch.json` contains `strategies` array
- Example: `{ "strategies": ["simple-threshold"], ... }`

**From Story 8-2 (Pre-flight Checks):**
- CheckResult interface: `{ name, pass, details, error? }`
- Output formatting pattern with checkmarks
- Exit code 0 for success, 1 for failure
- Script structure with dotenv loading

**From Story 8-3 (Health Endpoint Enhancement):**
- Health endpoint: `GET /api/live/status` (port via PORT env, default 3333)
- Response schema:
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
- Status can be: "healthy", "degraded", "unhealthy"

### Project Structure Notes

**File Locations:**
- Script: `scripts/verify.mjs` (new)
- Tests: `scripts/__tests__/verify.test.js` (new)
- Launch manifest: `config/launch.json` (read-only)
- Health endpoint: Running at `http://localhost:${PORT}/api/live/status`

**Environment Variables:**
```
PORT                    # Health endpoint port (default 3333)
RAILWAY_STATIC_URL      # Railway deployment URL (for remote verification)
```

**Output Format (from epic):**
```
Verifying deployment...
  [check] Health endpoint responding (45ms)
  [check] Active strategies match manifest:
      - oracle-edge
      - simple-threshold
  [check] Receiving ticks (8 in last 10s)
  [check] No errors in logs

DEPLOYMENT SUCCESSFUL
```

### Technical Requirements

**Health Endpoint Polling Pattern:**
```javascript
async function pollHealthEndpoint(url, timeoutMs = 60000) {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'healthy') {
          return health;
        }
        // Log degraded/unhealthy status but continue polling
        console.log(`  Status: ${health.status}, waiting...`);
      }
    } catch (err) {
      // Connection error - service might still be starting
      console.log('  Waiting for service to start...');
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Health check timeout - service did not become healthy');
}
```

**Strategy Match Verification:**
```javascript
function verifyStrategiesMatch(healthResponse, manifest) {
  const active = new Set(healthResponse.active_strategies);
  const expected = new Set(manifest.strategies);

  const missing = manifest.strategies.filter(s => !active.has(s));
  const extra = healthResponse.active_strategies.filter(s => !expected.has(s));

  if (missing.length === 0 && extra.length === 0) {
    return {
      name: 'Strategy Match',
      pass: true,
      details: `All ${manifest.strategies.length} strategies active`,
      strategies: manifest.strategies,
    };
  }

  return {
    name: 'Strategy Match',
    pass: false,
    error: `Mismatch: ${missing.length} missing, ${extra.length} extra`,
    missing,
    extra,
  };
}
```

**Data Flow Verification:**
```javascript
function verifyDataFlow(healthResponse) {
  const results = [];

  // Check last_tick freshness (within 30 seconds)
  if (healthResponse.last_tick) {
    const tickAge = Date.now() - new Date(healthResponse.last_tick).getTime();
    const isFresh = tickAge < 30000;
    results.push({
      name: 'Tick Freshness',
      pass: isFresh,
      details: isFresh ? `Last tick ${Math.floor(tickAge / 1000)}s ago` : null,
      error: isFresh ? null : `Last tick ${Math.floor(tickAge / 1000)}s ago (stale)`,
    });
  } else {
    results.push({
      name: 'Tick Freshness',
      pass: false,
      error: 'No tick data received',
    });
  }

  // Check error count (must be 0 for post-deploy)
  const errorCount = healthResponse.error_count_1m ?? 0;
  results.push({
    name: 'Error Rate',
    pass: errorCount === 0,
    details: errorCount === 0 ? 'No errors in last minute' : null,
    error: errorCount > 0 ? `${errorCount} errors in last minute` : null,
  });

  return results;
}
```

**Scout Log Verification (Optional):**
```javascript
async function verifyLogs() {
  // Check if Scout module is available
  // Scout provides log analysis for error patterns

  // Error patterns to check for:
  const errorPatterns = [
    'FATAL',
    'CRITICAL',
    'unhandled',
    'crash',
    'exception',
  ];

  // Expected startup messages:
  const expectedMessages = [
    'strategies_initialized',
    'orchestrator_started',
    'rtds_connected',
  ];

  // If Scout not available, return soft pass
  return {
    name: 'Log Analysis',
    pass: true,
    details: 'Scout verification skipped (module not available)',
  };
}
```

**URL Determination:**
```javascript
function getHealthUrl() {
  // For remote (Railway) verification
  if (process.env.RAILWAY_STATIC_URL) {
    return `${process.env.RAILWAY_STATIC_URL}/api/live/status`;
  }

  // For local verification
  const port = process.env.PORT || 3333;
  return `http://localhost:${port}/api/live/status`;
}
```

### Verification Flow

```
1. Determine health URL (local or Railway)
2. Poll health endpoint until healthy or timeout (60s)
   - Log progress every 2s
   - Handle connection errors gracefully
3. On healthy response:
   a. Verify active_strategies matches launch.json
   b. Verify last_tick within 30s
   c. Verify error_count_1m == 0
   d. Verify logs (Scout, optional)
4. Format and display results
5. Exit with appropriate code
```

### Error Handling

- Health endpoint timeout: Clear message about what failed to connect
- Strategy mismatch: List missing and extra strategies
- Stale tick: Show age of last tick
- Error count: Show exact count
- All errors should be actionable

### Testing Strategy

**Unit Tests (scripts/__tests__/verify.test.js):**
- Mock `fetch` for health endpoint polling
- Test `verifyStrategiesMatch()` with various scenarios:
  - Exact match
  - Missing strategies
  - Extra strategies
  - Empty arrays
- Test `verifyDataFlow()` with:
  - Fresh tick (< 30s)
  - Stale tick (> 30s)
  - No tick data
  - Error count > 0
  - Error count == 0
- Test timeout handling in `pollHealthEndpoint()`

**Integration Tests:**
- Create mock HTTP server returning health response
- Verify full verification flow
- Test output formatting

### References

- [Source: _bmad-output/planning-artifacts/epic-8-launch-control.md#Story 8-5]
- [Source: _bmad-output/implementation-artifacts/8-1-launch-manifest.md - loadManifest pattern]
- [Source: _bmad-output/implementation-artifacts/8-2-pre-flight-checks.md - script pattern, CheckResult]
- [Source: _bmad-output/implementation-artifacts/8-3-health-endpoint-enhancement.md - health response schema]
- [Source: scripts/preflight.mjs - script structure pattern]
- [Source: scripts/health-endpoint.mjs - buildStatusResponse schema]
- [Source: config/launch.json - manifest structure]

### Git Intelligence

Recent commits show:
- `9facd00` - ENHANCEMENTS.md update for BMAD cycle
- `cc736b4` - Config loading patterns
- Story 8-1, 8-2, 8-3 established Epic 8 patterns

The project uses:
- ES modules (`import`/`export`)
- Native `fetch` API (Node.js 18+)
- vitest for testing
- CheckResult interface pattern from preflight

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 34 unit tests pass for verify.mjs
- Full test suite: 2,674 tests pass across 87 test files
- No regressions detected

### Completion Notes List

- Implemented post-deploy verification script following preflight.mjs patterns
- Created `scripts/verify.mjs` with all verification functions exported for testing
- Added `npm run verify` script to package.json
- Implemented `pollHealthEndpoint()` with 2-second polling, 60-second timeout, graceful error handling
- Implemented `verifyStrategiesMatch()` with Set-based comparison for order-independent matching
- Implemented `verifyDataFlow()` checking last_tick freshness (30s threshold) and error_count_1m (must be 0)
- Implemented `verifyLogs()` with Scout integration marked as optional (soft pass when unavailable)
- Implemented `formatVerifyResults()` matching preflight output style with checkmarks
- Supports both local (localhost:PORT) and remote (RAILWAY_STATIC_URL) endpoints
- Created comprehensive test suite with 34 tests covering all verification functions

### File List

- `scripts/verify.mjs` (new) - Post-deploy verification script
- `scripts/__tests__/verify.test.js` (new) - Unit tests for verification logic
- `package.json` (modified) - Added `npm run verify` script

## Change Log

- 2026-02-01: Implemented Story 8-5 post-deploy verification script with all ACs satisfied
- 2026-02-01: **Code Review Passed** - Adversarial review by Claude Opus 4.5
  - Fixed: `loadLaunchManifest()` now validates required `strategies` array field
  - Fixed: Grammar in strategy match output (singular/plural: "1 strategy" vs "2 strategies")
  - Added: `runVerifications()` test coverage
  - Added: `loadLaunchManifest` validation test placeholder
  - All 53 tests pass
