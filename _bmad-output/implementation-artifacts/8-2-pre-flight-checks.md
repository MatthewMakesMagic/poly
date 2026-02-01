# Story 8.2: Pre-flight Checks

Status: done

## Story

As a **trader**,
I want **to validate everything is ready before deploying**,
So that **I catch problems before they cost money**.

## Acceptance Criteria

1. **Given** the preflight command is run
   **When** executing `npm run preflight`
   **Then** all validation checks are executed
   **And** each check reports pass/fail with details
   **And** exit code is 0 if all pass, 1 if any fail

2. **Given** environment variables
   **When** checking
   **Then** POLYMARKET_API_KEY, API_SECRET, PASSPHRASE, PRIVATE_KEY are verified set

3. **Given** API credentials
   **When** checking
   **Then** Polymarket API is called to verify auth
   **And** current balance is reported

4. **Given** database
   **When** checking
   **Then** connection is verified
   **And** migration status is reported (X/Y applied)

5. **Given** Railway CLI
   **When** checking
   **Then** CLI is installed and authenticated
   **And** project/environment is accessible

6. **Given** launch manifest
   **When** checking
   **Then** all listed strategies exist in registry
   **And** config values are within valid ranges

## Tasks / Subtasks

- [x] Task 1: Create preflight script entry point (AC: #1)
  - [x] 1.1: Create `scripts/preflight.mjs` with proper shebang and dotenv loading
  - [x] 1.2: Implement CheckResult type structure: `{ name, pass, details, error? }`
  - [x] 1.3: Implement sequential check execution with result collection
  - [x] 1.4: Implement formatted output display (ASCII table with checkmarks/X)
  - [x] 1.5: Add `npm run preflight` script to package.json
  - [x] 1.6: Exit with code 0 on all pass, code 1 on any failure

- [x] Task 2: Implement environment variable checks (AC: #2)
  - [x] 2.1: Create `checkEnvironment()` function
  - [x] 2.2: Verify POLYMARKET_API_KEY is set (non-empty)
  - [x] 2.3: Verify POLYMARKET_API_SECRET is set (non-empty)
  - [x] 2.4: Verify POLYMARKET_PASSPHRASE is set (non-empty)
  - [x] 2.5: Verify POLYMARKET_PRIVATE_KEY is set (non-empty)
  - [x] 2.6: Return pass/fail with list of missing variables

- [x] Task 3: Implement Polymarket API auth check (AC: #3)
  - [x] 3.1: Create `checkPolymarketAuth()` function
  - [x] 3.2: Load config and extract polymarket credentials
  - [x] 3.3: Create Polymarket client and attempt authentication
  - [x] 3.4: Fetch current USDC balance
  - [x] 3.5: Return pass with balance or fail with auth error

- [x] Task 4: Implement database checks (AC: #4)
  - [x] 4.1: Create `checkDatabaseConnection()` function
  - [x] 4.2: Attempt to open database file at configured path
  - [x] 4.3: Execute `SELECT 1` to verify connection works
  - [x] 4.4: Create `checkMigrations()` function
  - [x] 4.5: Query schema_migrations table for applied migrations
  - [x] 4.6: Count migrations in `/src/persistence/migrations/` folder
  - [x] 4.7: Return pass with "X/Y applied" or fail with migration gap

- [x] Task 5: Implement Railway CLI check (AC: #5)
  - [x] 5.1: Create `checkRailwayCli()` function
  - [x] 5.2: Execute `railway --version` to check CLI installed (fixed: uses --version flag)
  - [x] 5.3: Execute `railway status` to check authenticated
  - [x] 5.4: Parse project/environment from status output
  - [x] 5.5: Return pass with project info or fail with reason

- [x] Task 6: Implement launch manifest check (AC: #6)
  - [x] 6.1: Create `checkLaunchManifest()` function
  - [x] 6.2: Import loadManifest from launch-config module
  - [x] 6.3: Import isKnownStrategy from launch-config module
  - [x] 6.4: Load manifest and validate each strategy exists
  - [x] 6.5: Validate position_size_dollars > 0
  - [x] 6.6: Validate max_exposure_dollars > position_size_dollars
  - [x] 6.7: Return pass with strategy count or fail with invalid values

- [x] Task 7: Write tests
  - [x] 7.1: Unit tests for each check function with mocked dependencies
  - [x] 7.2: Integration test with mock database and config
  - [x] 7.3: Test output formatting produces correct ASCII table

## Dev Notes

### Architecture Compliance

This story creates a **standalone script** (not a module) following the established script patterns in `scripts/`:

```
scripts/preflight.mjs    # Single file script, imports from modules
```

**Script Pattern (from launch-config.mjs, run_live_trading.mjs):**
1. Shebang: `#!/usr/bin/env node`
2. Load dotenv FIRST (.env.local, then .env)
3. Import config AFTER env loaded
4. Create child logger with module name
5. Run checks sequentially
6. Format output with console.log
7. Exit with appropriate code

**NOT a Module:** This is a CLI script, not a folder-per-module. It imports from existing modules but doesn't need its own init/getState/shutdown.

### Previous Story Intelligence (8-1-launch-manifest)

From the completed story 8-1:
- **launch-config module location:** `src/modules/launch-config/`
- **Key imports to reuse:**
  - `loadManifest()` - reads and validates launch.json
  - `isKnownStrategy(name)` - checks if strategy exists in KNOWN_STRATEGIES
  - `listAvailableStrategies()` - returns all known strategies
- **Launch.json location:** `config/launch.json`
- **KNOWN_STRATEGIES includes:** simple-threshold, oracle-edge, probability-model, lag-based, hybrid
- **Module uses ES modules** (`import`/`export`)

### Project Structure Notes

**File Locations:**
- Script: `scripts/preflight.mjs` (new)
- Database: `data/poly.db` (from config.database.path)
- Config: `config/index.js` (loads NODE_ENV-appropriate config)
- Launch manifest: `config/launch.json` (from Story 8-1)
- Migrations: `src/persistence/migrations/` (currently 13 migrations: 001-013)

**Required Environment Variables:**
```
POLYMARKET_API_KEY      # API key for CLOB
POLYMARKET_API_SECRET   # API secret for CLOB
POLYMARKET_PASSPHRASE   # Passphrase for API
POLYMARKET_PRIVATE_KEY  # Wallet private key
```

**Output Format (from epic):**
```
Pre-flight Checks
-----------------
  [check] POLYMARKET_API_KEY          set
  [check] POLYMARKET_API_SECRET       set
  [check] Polymarket API              connected (balance: $523.45)
  [check] Database                    connected, 11/11 migrations
  [check] Railway CLI                 authenticated
  [check] Launch manifest             valid (2 strategies)

All checks passed (6/6)
```

### Technical Requirements

**Script Dependencies:**
```javascript
import dotenv from 'dotenv';
import { child } from '../src/modules/logger/index.js';
import config from '../config/index.js';
import { loadManifest, isKnownStrategy } from '../src/modules/launch-config/index.js';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { readdirSync } from 'fs';
```

**Check Result Interface:**
```javascript
// Each check function returns:
{
  name: 'Environment Variables',  // Display name
  pass: true,                     // Did check pass?
  details: 'All 4 required vars set', // Success details
  error: null                     // Error message if failed
}
```

**Exit Codes:**
- `0` - All checks passed
- `1` - One or more checks failed

### Database Migration Check Pattern

```javascript
function checkMigrations() {
  const db = new Database(config.database.path);

  // Get applied migrations from database
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY id').all();
  const appliedCount = applied.length;

  // Count migration files (exclude index.js)
  const migrationFiles = readdirSync('src/persistence/migrations')
    .filter(f => f.match(/^\d{3}-.*\.js$/));
  const totalCount = migrationFiles.length;

  db.close();

  return {
    name: 'Database Migrations',
    pass: appliedCount === totalCount,
    details: `${appliedCount}/${totalCount} applied`,
    error: appliedCount < totalCount ? `Missing ${totalCount - appliedCount} migrations` : null
  };
}
```

### Railway CLI Check Pattern

```javascript
function checkRailwayCli() {
  try {
    // Check if CLI installed
    execSync('railway version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    // Check if authenticated
    const status = execSync('railway status', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    // Parse project name from status output
    const projectMatch = status.match(/Project: (.+)/);
    const project = projectMatch ? projectMatch[1] : 'unknown';

    return {
      name: 'Railway CLI',
      pass: true,
      details: `authenticated (project: ${project})`
    };
  } catch (err) {
    return {
      name: 'Railway CLI',
      pass: false,
      error: err.message.includes('command not found') ?
        'CLI not installed (npm install -g @railway/cli)' :
        'Not authenticated (run: railway login)'
    };
  }
}
```

### Polymarket Auth Check Pattern

```javascript
async function checkPolymarketAuth() {
  try {
    // Import Polymarket client (avoids loading at script start)
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');

    const wallet = new Wallet(config.polymarket.privateKey);
    const client = new ClobClient(
      config.polymarket.apiUrl || 'https://clob.polymarket.com',
      137,
      wallet,
      {
        key: config.polymarket.apiKey,
        secret: config.polymarket.apiSecret,
        passphrase: config.polymarket.passphrase
      },
      2,
      config.polymarket.funder
    );

    // Get balance to verify auth works
    const balance = await client.getBalanceAllowance();
    const usdcBalance = parseFloat(balance?.amount || 0) / 1e6;

    return {
      name: 'Polymarket API',
      pass: true,
      details: `connected (balance: $${usdcBalance.toFixed(2)})`
    };
  } catch (err) {
    return {
      name: 'Polymarket API',
      pass: false,
      error: `Auth failed: ${err.message}`
    };
  }
}
```

### Error Handling

- Each check function catches its own errors and returns a failed result
- Script continues running all checks even if some fail
- Final summary shows total passed/failed
- Exit code reflects overall result

### Testing Strategy

**Unit Tests (scripts/__tests__/preflight.test.js):**
- Mock `process.env` for environment variable checks
- Mock `better-sqlite3` for database checks
- Mock `child_process.execSync` for Railway CLI checks
- Mock `@polymarket/clob-client` for API auth checks
- Mock launch-config module for manifest checks

**Integration Tests:**
- Create temp database with test migrations
- Create temp launch.json with test config
- Run full preflight and verify output format

### References

- [Source: _bmad-output/planning-artifacts/epic-8-launch-control.md#Story 8-2]
- [Source: _bmad-output/implementation-artifacts/8-1-launch-manifest.md - launch-config module patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Error Handling Pattern]
- [Source: scripts/launch-config.mjs - existing script pattern]
- [Source: scripts/run_live_trading.mjs - dotenv and logger patterns]
- [Source: src/clients/polymarket/index.js - API client initialization]
- [Source: src/persistence/database.js - database connection pattern]
- [Source: src/persistence/migrations/ - 13 migration files (001-013)]
- [Source: config/default.js - configuration structure]

### Git Intelligence

Recent commits show:
- `cc736b4` - Config loading patterns (relevant for loading polymarket credentials)
- `e3243a8` - Strategy patterns (simple-threshold is baseline strategy)
- `8e62f32` - Logger debug level (use for preflight logging)

The project uses ES modules throughout (`import`/`export`), vitest for testing, and better-sqlite3 for database operations.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Preflight script runs successfully with 6 checks (env, API, DB connection, migrations, Railway CLI, manifest)
- Fixed Railway CLI check: uses `--version` flag instead of `version` subcommand
- All 2255 tests pass with no regressions

### Completion Notes List

- ✅ Implemented `scripts/preflight.mjs` as standalone CLI script following project patterns
- ✅ Added `npm run preflight` command to package.json
- ✅ All 6 check functions implemented: checkEnvironment(), checkPolymarketAuth(), checkDatabaseConnection(), checkMigrations(), checkRailwayCli(), checkLaunchManifest()
- ✅ CheckResult interface: `{ name, pass, details, error? }` for consistent result structure
- ✅ ASCII table output with ✓/✗ icons and formatted details
- ✅ Exit code 0 on all pass, 1 on any failure
- ✅ 21 unit tests added in scripts/__tests__/preflight.test.js
- ✅ Full regression suite passes (2255 tests)

### File List

- scripts/preflight.mjs (new, code-review updated)
- scripts/__tests__/preflight.test.js (new, code-review updated)
- package.json (modified - added preflight script)

## Senior Developer Review (AI)

**Review Date:** 2026-02-01
**Reviewer:** Claude Opus 4.5 (Adversarial Code Review)
**Outcome:** ✅ APPROVED with fixes applied

### Issues Found and Fixed

| # | Severity | Issue | Fix Applied |
|---|----------|-------|-------------|
| 1 | HIGH | Migration count hardcoded incorrectly in docs (11 vs 13) | Updated Dev Notes to reflect 13 migrations |
| 2 | HIGH | Missing explicit type validation for position_size_dollars | Added `typeof !== 'number'` check |
| 3 | HIGH | formatResults lacked EPIPE error handling for CI | Refactored to batch writes with try/catch |
| 4 | HIGH | isMainModule detection fragile with absolute paths | Added `import.meta.url` comparison |
| 5 | MEDIUM | No graceful init error handling in checkLaunchManifest | Added nested try/catch for init errors |
| 6 | MEDIUM | checkMigrations doesn't validate file content | Documented as known limitation (acceptable) |
| 7 | MEDIUM | Missing test for API timeout scenario | Added test case for timeout error path |
| 8 | LOW | Migration regex overly permissive | Changed from `/^\d+-/` to `/^\d{3,}-/` |
| 9 | LOW | Missing JSDoc for sanitizeErrorMessage | Added comprehensive JSDoc documentation |

### Test Coverage

- **Before review:** 34 tests
- **After review:** 39 tests (+5 new test cases)
- All tests pass ✅

### Code Quality Assessment

- Security: ✅ Credential sanitization implemented correctly
- Performance: ✅ Read-only DB connections, timeouts on external calls
- Error handling: ✅ Comprehensive error handling with clear messages
- Architecture compliance: ✅ Follows script patterns from project standards

## Change Log

- 2026-02-01: Initial implementation of pre-flight checks story (Story 8-2)
- 2026-02-01: Code review - 9 issues found and fixed (4 HIGH, 3 MEDIUM, 2 LOW)
