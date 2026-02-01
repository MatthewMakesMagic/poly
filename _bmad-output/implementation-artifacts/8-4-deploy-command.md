# Story 8.4: Deploy Command

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **a single command that deploys to Railway with clean slate**,
So that **deployment is safe and consistent**.

## Acceptance Criteria

1. **Given** deploy command is run
   **When** executing `npm run deploy`
   **Then** preflight checks run first
   **And** deployment aborts if preflight fails

2. **Given** preflight passes
   **When** continuing deploy
   **Then** current manifest is displayed
   **And** user is prompted to confirm (or edit first)

3. **Given** user confirms
   **When** deploying
   **Then** code is pushed to Railway (git push or railway up)
   **And** build status is monitored
   **And** deployment status is monitored
   **And** verification runs automatically on completion

4. **Given** deployment completes
   **When** verification passes
   **Then** success message is displayed
   **And** Scout handoff is mentioned for ongoing monitoring

5. **Given** deployment or verification fails
   **When** failure occurs
   **Then** clear error message is displayed
   **And** suggested next steps are provided

## Tasks / Subtasks

- [x] Task 1: Create `scripts/deploy.mjs` entry point (AC: #1, #2, #5)
  - [x] 1.1: Create script with shebang and module imports (dotenv, child_process, readline)
  - [x] 1.2: Import preflight check functions from `preflight.mjs`
  - [x] 1.3: Import verification functions from `verify.mjs`
  - [x] 1.4: Import launch manifest loader from `launch-config` module
  - [x] 1.5: Create `main()` async function with error handling

- [x] Task 2: Implement pre-flight execution step (AC: #1)
  - [x] 2.1: Create `runPreflightChecks()` that executes all preflight checks
  - [x] 2.2: Display preflight results using existing `formatResults()` function
  - [x] 2.3: Abort with exit code 1 if any preflight check fails
  - [x] 2.4: Continue to manifest display if all checks pass

- [x] Task 3: Implement manifest display and confirmation (AC: #2)
  - [x] 3.1: Create `displayManifest()` that shows current launch.json contents
  - [x] 3.2: Display strategies, position_size, max_exposure, symbols, kill_switch
  - [x] 3.3: Create `promptUser()` using readline for interactive prompts
  - [x] 3.4: Prompt "Edit config before deploy? (y/n)"
  - [x] 3.5: If user chooses 'y', print "Run `npm run launch:config` to edit, then re-run deploy" and exit
  - [x] 3.6: Prompt "Deploy now? (y/n)" - abort if 'n'
  - [x] 3.7: Display what will happen: "1. Push code to Railway, 2. Clean slate restart, 3. Auto-verify"

- [x] Task 4: Implement Railway deployment via git push (AC: #3)
  - [x] 4.1: Create `deployViaGit()` function using child_process.spawn
  - [x] 4.2: Check for uncommitted changes - warn user if present (git status)
  - [x] 4.3: Execute `git push origin main` with timeout (5 minutes)
  - [x] 4.4: Stream stdout/stderr to console in real-time
  - [x] 4.5: Return success/failure based on exit code
  - [x] 4.6: Handle git errors (no remote, auth failure, etc.) with clear messages

- [x] Task 5: Implement Railway CLI deployment as fallback (AC: #3)
  - [x] 5.1: Create `deployViaRailwayCli()` function
  - [x] 5.2: Execute `railway up` command with timeout (5 minutes)
  - [x] 5.3: Stream output to console in real-time
  - [x] 5.4: Parse deployment status from output
  - [x] 5.5: Return success/failure based on exit code
  - [x] 5.6: Create `selectDeployMethod()` to choose git or railway CLI

- [x] Task 6: Implement build/deploy monitoring (AC: #3)
  - [x] 6.1: After git push, display message about Railway auto-deploy
  - [x] 6.2: Wait fixed delay (30 seconds) for Railway to start deployment
  - [x] 6.3: Optionally poll Railway status via CLI if available
  - [x] 6.4: Display progress messages during wait

- [x] Task 7: Implement automatic verification (AC: #3, #4)
  - [x] 7.1: After deployment wait period, call `runVerifications()` from verify.mjs
  - [x] 7.2: Use RAILWAY_STATIC_URL env var for remote health check target
  - [x] 7.3: Display verification results using `formatVerifyResults()`
  - [x] 7.4: If verification passes, display success message with Scout mention

- [x] Task 8: Implement error handling and suggestions (AC: #5)
  - [x] 8.1: Create `displayError()` with categorized error messages
  - [x] 8.2: For preflight failure: suggest fixing issues and re-running
  - [x] 8.3: For git push failure: suggest checking remote, auth, network
  - [x] 8.4: For verification failure: suggest checking Railway logs, Scout
  - [x] 8.5: All errors use sanitizeErrorMessage() to prevent credential leakage

- [x] Task 9: Add "deploy" script to package.json (AC: #1)
  - [x] 9.1: Add `"deploy": "node scripts/deploy.mjs"` to scripts section
  - [x] 9.2: Verify script runs: `npm run deploy`

- [x] Task 10: Write tests (AC: all)
  - [x] 10.1: Unit test for `displayManifest()` - correct format
  - [x] 10.2: Unit test for `promptUser()` - mocked readline
  - [x] 10.3: Unit test for error categorization and suggestions
  - [x] 10.4: Integration test: mock git, verify flow executes correctly
  - [x] 10.5: Test error message sanitization for deploy errors

## Dev Notes

### Architecture Compliance

This story creates a **new script** (`scripts/deploy.mjs`) that orchestrates existing components. It follows the "scripts orchestrate modules" pattern established in Epic 8.

**Key Pattern:** Deploy script is an orchestrator that sequences: preflight → confirm → push → verify. Each step is already implemented (preflight.mjs, verify.mjs) - deploy.mjs just ties them together.

```
scripts/deploy.mjs (NEW)
├── Import: preflight.mjs (run checks)
├── Import: verify.mjs (post-deploy verification)
├── Import: launch-config (display manifest)
└── Uses: child_process (git push / railway up)
```

### Previous Story Intelligence (8-1, 8-2, 8-3)

**From Story 8-1 (Launch Manifest):**
- Manifest at `config/launch.json`
- Load via `import { loadManifest } from '../src/modules/launch-config/index.js'`
- Available strategies: simple-threshold, oracle-edge, probability-model, lag-based, hybrid

**From Story 8-2 (Pre-flight Checks):**
- `scripts/preflight.mjs` exports check functions
- `formatResults()` handles output formatting
- All checks return `{ name, pass, details, error }` interface
- Pattern for reading env vars and config

**From Story 8-3 (Health Endpoint):**
- Health endpoint at `/api/live/status`
- RAILWAY_STATIC_URL env var for remote verification target
- `scripts/verify.mjs` exports `runVerifications()` and `formatVerifyResults()`
- `sanitizeErrorMessage()` pattern for credential protection

### Project Structure Notes

**New Files:**
- `scripts/deploy.mjs` - Main deploy orchestration script
- `scripts/__tests__/deploy.test.js` - Unit tests for deploy script

**Modified Files:**
- `package.json` - Add "deploy" script

### Technical Requirements

**Deploy Flow (from Epic 8):**
```
1. Run preflight → abort if fail
2. Show manifest → offer edit option
3. Confirm deploy → abort if declined
4. Git push to main (or railway up)
5. Wait for build/deploy (30-60s polling)
6. Run verify
7. Report result
```

**Interactive Prompts Pattern:**
```javascript
import { createInterface } from 'readline';

async function promptUser(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}
```

**Git Push Pattern:**
```javascript
import { spawn } from 'child_process';

async function deployViaGit() {
  return new Promise((resolve, reject) => {
    const timeout = 5 * 60 * 1000; // 5 minutes

    const proc = spawn('git', ['push', 'origin', 'main'], {
      stdio: 'inherit'  // Stream to console
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Git push timed out'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Git push failed with code ${code}`));
      }
    });
  });
}
```

**Manifest Display Pattern:**
```javascript
function displayManifest(manifest) {
  console.log('\nCurrent launch.json:');
  console.log(`  Strategies: ${manifest.strategies.join(', ')}`);
  console.log(`  Position size: $${manifest.position_size_dollars}`);
  console.log(`  Max exposure: $${manifest.max_exposure_dollars}`);
  console.log(`  Symbols: ${manifest.symbols.join(', ')}`);
  console.log(`  Kill switch: ${manifest.kill_switch_enabled ? 'enabled' : 'disabled'}`);
  console.log('');
}
```

**Verification Integration:**
```javascript
import { runVerifications, formatVerifyResults } from './verify.mjs';

// Set RAILWAY_STATIC_URL for remote verification
// This should be set in the environment or configured
process.env.RAILWAY_STATIC_URL = process.env.RAILWAY_STATIC_URL || 'https://poly-production.up.railway.app';

const { results, allPassed } = await runVerifications();
formatVerifyResults(results);
```

### Deployment Timeouts (from Epic 8)

- Git push timeout: 5 minutes
- Railway build wait: variable (poll or fixed delay)
- Verification poll: 60 seconds (handled by verify.mjs)
- Total deploy flow: ~3-7 minutes typical

### Error Handling Categories

1. **Preflight Failure** → "Fix issues shown above, then re-run `npm run deploy`"
2. **User Abort** → "Deploy cancelled. No changes made."
3. **Git Push Failure** → "Check: git remote, authentication, network connectivity"
4. **Railway Build Failure** → "Check Railway dashboard for build logs"
5. **Verification Failure** → "System deployed but unhealthy. Check Scout or Railway logs."

### Success Output (from Epic 8 spec)

```
✓ DEPLOYMENT SUCCESSFUL

Scout is watching. Use /scout for monitoring.
```

### Environment Variables

- `RAILWAY_STATIC_URL` - Required for remote verification (e.g., `https://poly-production.up.railway.app`)
- If not set, deploy should warn user that verification will use localhost (which won't work for remote deploy)

### Railway Integration Notes

Railway auto-deploys on `git push origin main` when configured. The deploy script:
1. Pushes code
2. Waits for Railway to detect and build (30s delay or status polling)
3. Verifies the deployment is healthy

If Railway CLI is available and authenticated (checked by preflight), it can be used for `railway up` as an alternative to git push.

### Non-Interactive Mode (Optional Enhancement)

For CI/CD use, consider adding `--yes` or `-y` flag to skip confirmation prompts:
```bash
npm run deploy -- --yes
```

This is optional but would be valuable for automated deployments.

### References

- [Source: _bmad-output/planning-artifacts/epic-8-launch-control.md#Story 8-4]
- [Source: _bmad-output/implementation-artifacts/8-2-pre-flight-checks.md - preflight pattern]
- [Source: _bmad-output/implementation-artifacts/8-3-health-endpoint-enhancement.md - verification pattern]
- [Source: scripts/preflight.mjs - check execution and formatting]
- [Source: scripts/verify.mjs - verification execution and formatting]
- [Source: src/modules/launch-config/index.js - manifest loading]
- [Source: config/launch.json - manifest schema]

### Git Intelligence

Recent commits show:
- `9facd00` - BMAD cycle updates
- `cc736b4` - Config loading patterns
- Story 8-1, 8-2, 8-3 established preflight, manifest, and verification patterns

The project uses:
- ES modules (`import`/`export`)
- Native Node.js APIs (readline, child_process)
- No external CLI prompt libraries (keep it simple)
- vitest for testing
- Structured logging via `child({ module: 'name' })`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 2720 tests pass (88 test files)
- Deploy script tests: 22 tests pass

### Completion Notes List

- Created `scripts/deploy.mjs` - deploy orchestration script with preflight, manifest display, confirmation, git push/railway CLI, 30s wait, and verification
- Implemented `runPreflightChecks()` that imports and runs all 6 preflight checks from preflight.mjs
- Implemented `displayManifest()` to show launch.json contents (strategies, position size, max exposure, symbols, kill switch)
- Implemented `promptUser()` using readline for interactive confirmation prompts
- Implemented `deployViaGit()` with 5-minute timeout, real-time output streaming, and error handling
- Implemented `deployViaRailwayCli()` as fallback deployment method
- Implemented `selectDeployMethod()` that prefers git push, falls back to Railway CLI if no origin remote
- Implemented `waitForDeployment()` with 30-second countdown display
- Implemented `displayError()` with categorized error messages and actionable suggestions for each failure type
- Implemented `displaySuccess()` with Scout monitoring handoff message
- Added `--yes` / `-y` flag support for non-interactive CI/CD deployments
- Added warning for uncommitted changes (they won't be deployed)
- Added warning when RAILWAY_STATIC_URL not set for remote verification
- Created comprehensive test suite (22 tests) covering all functions
- All error messages use `sanitizeErrorMessage()` to prevent credential leakage

### File List

- `scripts/deploy.mjs` (NEW) - Main deploy orchestration script
- `scripts/__tests__/deploy.test.js` (NEW) - Unit tests for deploy script
- `package.json` (MODIFIED) - Added "deploy" script

## Change Log

- 2026-02-01: Story 8-4 implemented - deploy command with preflight → manifest → confirm → push → verify flow
- 2026-02-01: Secondary code review completed - fixed 8 issues, added 15 tests
- 2026-02-01: Final adversarial code review PASSED - all ACs verified, all tasks complete, 37/37 tests passing, status → done

## Secondary Code Review

**Reviewer:** Claude Opus 4.5
**Date:** 2026-02-01
**Status:** PASSED with fixes applied

### Issues Found and Fixed

| ID | Severity | Category | Description | Fix Applied |
|----|----------|----------|-------------|-------------|
| 3 | MEDIUM | Security | Process kill on timeout doesn't escalate to SIGKILL | Added SIGTERM → 5s delay → SIGKILL escalation |
| 8 | MEDIUM | Edge Case | `displayManifest()` crashes on empty strategies array | Added null/undefined guards for all manifest properties |
| 9 | MEDIUM | Edge Case | Missing null checks for manifest properties | Added defensive checks with fallback values |
| 10 | HIGH | Test Coverage | No test for `deployViaGit()` timeout behavior | Added 4 tests for spawn errors and exit codes |
| 11 | HIGH | Test Coverage | `deployViaRailwayCli()` not tested | Added 3 tests for ENOENT, success, and failure |
| 13 | MEDIUM | Test Coverage | `waitForDeployment()` not tested | Added test with fake timers |
| 17 | MEDIUM | Error Handling | Manifest load error misleadingly shows "Preflight failed" | Added specific error message for manifest failures |
| 19 | MEDIUM | Error Handling | Spawn errors not differentiated (ENOENT vs EACCES) | Added error code detection for better debugging |

### Tests Added

- `waitForDeployment()` - countdown with fake timers
- `displayManifest()` edge cases - 5 new tests for null/undefined/empty handling
- `deployViaGit()` - 4 tests for ENOENT, EACCES, success, failure
- `deployViaRailwayCli()` - 3 tests for ENOENT, success, failure
- Process timeout - test for SIGTERM → SIGKILL escalation

### Test Results

- **Before review:** 22 tests passing
- **After review:** 37 tests passing (+15 new tests)
- **Full suite:** 2814 tests passing, 0 failures

### Issues Not Fixed (Accepted Risk)

| ID | Severity | Category | Description | Reason |
|----|----------|----------|-------------|--------|
| 4 | LOW | Performance | Double init/shutdown of launch-config module | Minimal overhead, cleaner separation of concerns |
| 7 | LOW | Edge Case | Ctrl+C during prompt may not clean up readline | Standard Node.js behavior, non-critical |
| 16 | MEDIUM | Architecture | Uses console.log instead of structured logger | Scripts exempt from module patterns per architecture |

