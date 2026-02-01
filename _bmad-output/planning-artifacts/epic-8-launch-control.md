# Epic 8: Launch Control & Deployment Pipeline

**User Value:** I can deploy the trading system to Railway with confidence, knowing exactly which strategies will run, with pre-flight validation and post-deploy verification.

**Created:** 2026-02-01
**Source:** Sprint Change Proposal (correct-course workflow)

---

## Overview

This epic builds the operational layer between development and production:
1. A launch manifest that declares exactly which strategies to run
2. Pre-flight checks to validate everything before deployment
3. A deploy command that orchestrates the full deployment flow
4. Post-deploy verification to confirm the system is healthy
5. Clean slate guarantee - only manifest strategies run, nothing else

**Core Principle:**
> What you select = exactly what runs. Nothing more, nothing less.

**Natural Language Workflow:**
```
You: "Run oracle-edge and simple-threshold with $15 position size"
Claude: [Updates launch.json] → "Done. Deploy now?"
You: "yes"
Claude: [Runs preflight → deploy → verify] → "Live and healthy."
```

---

## FRs Covered

| FR | Description | Stories |
|----|-------------|---------|
| FR43 (NEW) | Launch manifest for strategy selection | 8-1 |
| FR44 (NEW) | Pre-flight validation | 8-2 |
| FR45 (NEW) | Health endpoint enhancement | 8-3 |
| FR46 (NEW) | Deployment orchestration | 8-4, 8-5 |

---

## Dependencies

- **Epic 6** (Strategy Composition): Component registry for available strategies
- **Epic 7** (Oracle Edge): Strategies to deploy
- **Epic Scout**: Log verification for post-deploy checks

---

## Stories

### Story 8-1: Launch Manifest

As a **trader**,
I want **a config file that declares exactly which strategies to run**,
So that **deployments are explicit and reproducible**.

**Natural Language Workflow:**
The primary way to configure is via Claude Code conversation:
```
User: "Run oracle-edge and simple-threshold with $15 position size"
Claude: Updates launch.json, confirms, offers to deploy
```

Claude Code reads the manifest, understands available strategies, and translates natural language into config updates. No manual JSON editing required.

**Acceptance Criteria:**

**Given** the launch manifest exists
**When** the orchestrator initializes
**Then** it reads `config/launch.json`
**And** loads ONLY the strategies listed in the manifest
**And** strategies not in manifest are not loaded (clean slate)

**Given** Claude Code receives a strategy selection request
**When** the user says "run X and Y with $Z position size"
**Then** Claude Code updates launch.json with the correct values
**And** confirms the change to the user

**Given** available strategies need to be known
**When** querying the system
**Then** a strategy registry exports available strategy names and descriptions

**Schema:**
```json
{
  "strategies": ["oracle-edge", "simple-threshold"],
  "position_size_dollars": 10,
  "max_exposure_dollars": 500,
  "symbols": ["BTC", "ETH", "SOL", "XRP"],
  "kill_switch_enabled": true
}
```

**Available Strategies:**
- `simple-threshold` - Current 70% threshold baseline
- `oracle-edge` - Pure staleness fade (Epic 7)
- `probability-model` - Black-Scholes with oracle spot (Epic 7)
- `lag-based` - Cross-correlation signals (Epic 7)
- `hybrid` - Weighted combination (Epic 7)

**Technical Notes:**
- CLI fallback for non-conversational use: `npm run launch:config`
- Manifest is committed to git and deployed with code

---

### Story 8-2: Pre-flight Checks

As a **trader**,
I want **to validate everything is ready before deploying**,
So that **I catch problems before they cost money**.

**Acceptance Criteria:**

**Given** the preflight command is run
**When** executing `npm run preflight`
**Then** all validation checks are executed
**And** each check reports pass/fail with details
**And** exit code is 0 if all pass, 1 if any fail

**Given** environment variables
**When** checking
**Then** POLYMARKET_API_KEY, API_SECRET, PASSPHRASE, PRIVATE_KEY are verified set

**Given** API credentials
**When** checking
**Then** Polymarket API is called to verify auth
**And** current balance is reported

**Given** database
**When** checking
**Then** connection is verified
**And** migration status is reported (X/Y applied)

**Given** Railway CLI
**When** checking
**Then** CLI is installed and authenticated
**And** project/environment is accessible

**Given** launch manifest
**When** checking
**Then** all listed strategies exist in registry
**And** config values are within valid ranges

**Output Format:**
```
Pre-flight Checks
─────────────────
  ✓ POLYMARKET_API_KEY          set
  ✓ POLYMARKET_API_SECRET       set
  ✓ Polymarket API              connected (balance: $523.45)
  ✓ Database                    connected, 8/8 migrations
  ✓ Railway CLI                 authenticated
  ✓ Launch manifest             valid (2 strategies)

All checks passed (6/6)
```

---

### Story 8-3: Health Endpoint Enhancement

As a **deployment system**,
I want **the health endpoint to report exactly what's running**,
So that **I can verify the deployment matches the manifest**.

**Acceptance Criteria:**

**Given** the health endpoint exists
**When** calling `GET /api/live/status`
**Then** response includes active_strategies array
**And** response includes connection status for all services
**And** response includes last_tick timestamp
**And** response includes error_count_1m

**Given** orchestrator loaded strategies from manifest
**When** health endpoint reports active_strategies
**Then** the list matches exactly what orchestrator loaded

**Given** performance requirements
**When** health endpoint is called
**Then** response time is < 500ms

**Response Schema:**
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

**Technical Notes:**
- Orchestrator must track which strategies it loaded
- Health endpoint queries orchestrator state

---

### Story 8-4: Deploy Command

As a **trader**,
I want **a single command that deploys to Railway with clean slate**,
So that **deployment is safe and consistent**.

**Acceptance Criteria:**

**Given** deploy command is run
**When** executing `npm run deploy`
**Then** preflight checks run first
**And** deployment aborts if preflight fails

**Given** preflight passes
**When** continuing deploy
**Then** current manifest is displayed
**And** user is prompted to confirm (or edit first)

**Given** user confirms
**When** deploying
**Then** code is pushed to Railway (git push or railway up)
**And** build status is monitored
**And** deployment status is monitored
**And** verification runs automatically on completion

**Given** deployment completes
**When** verification passes
**Then** success message is displayed
**And** Scout handoff is mentioned for ongoing monitoring

**Given** deployment or verification fails
**When** failure occurs
**Then** clear error message is displayed
**And** suggested next steps are provided

**Flow:**
```
1. Run preflight → abort if fail
2. Show manifest → offer edit option
3. Confirm deploy → abort if declined
4. Git push to main
5. Monitor Railway build/deploy
6. Run verify
7. Report result
```

**Technical Notes:**
- Use Railway CLI if available, fallback to git push
- Timeout for build: 5 minutes
- Timeout for deploy: 2 minutes

---

### Story 8-5: Post-deploy Verification

As a **trader**,
I want **automatic verification that deployment succeeded**,
So that **I know the system is actually running correctly**.

**Acceptance Criteria:**

**Given** verification is run
**When** executing `npm run verify` (or automatically after deploy)
**Then** health endpoint is polled until healthy or timeout

**Given** health endpoint responds
**When** verifying
**Then** active_strategies is compared to launch.json
**And** verification fails if they don't match exactly

**Given** data flow verification
**When** checking
**Then** last_tick must be within last 30 seconds
**And** error_count_1m must be 0 (or below threshold)

**Given** Scout integration
**When** verifying logs
**Then** Scout checks for error patterns in recent logs
**And** Scout verifies expected startup messages appeared

**Given** timeout
**When** health check doesn't pass within 60 seconds
**Then** verification fails
**And** clear error message indicates what failed

**Verification Points:**
1. Health endpoint returns 200 with status: "healthy"
2. active_strategies matches launch.json exactly
3. last_tick within last 30 seconds
4. error_count_1m == 0
5. Scout reports no error patterns

**Output Format:**
```
Verifying deployment...
  ✓ Health endpoint responding (45ms)
  ✓ Active strategies match manifest:
      - oracle-edge ✓
      - simple-threshold ✓
  ✓ Receiving ticks (8 in last 10s)
  ✓ No errors in logs

✓ DEPLOYMENT SUCCESSFUL
```

---

## Summary

| Story | Title | Priority | Size |
|-------|-------|----------|------|
| 8-1 | Launch Manifest | Critical | Small |
| 8-2 | Pre-flight Checks | High | Small |
| 8-3 | Health Endpoint Enhancement | High | Small |
| 8-4 | Deploy Command | High | Small |
| 8-5 | Post-deploy Verification | High | Small |

**Recommended Implementation Order:**
1. 8-1 (Launch Manifest) - Foundation, orchestrator integration
2. 8-3 (Health Endpoint) - Needed for verification
3. 8-2 (Pre-flight) - Standalone utility
4. 8-5 (Verify) - Uses health endpoint
5. 8-4 (Deploy) - Orchestrates everything

---

## Appendix: Clean Slate Implementation

### How Orchestrator Enforces Manifest

```javascript
// In orchestrator init()
import launchConfig from '../../config/launch.json' assert { type: 'json' };

async function init(config) {
  // Load ONLY strategies from manifest
  const activeStrategies = [];

  for (const strategyName of launchConfig.strategies) {
    const strategy = await loadStrategy(strategyName);
    if (strategy) {
      activeStrategies.push(strategy);
      log.info('strategy_loaded', { name: strategyName });
    } else {
      log.error('strategy_not_found', { name: strategyName });
      throw new Error(`Strategy not found: ${strategyName}`);
    }
  }

  // Track for health endpoint
  state.activeStrategies = activeStrategies;
  state.activeStrategyNames = launchConfig.strategies;

  log.info('strategies_initialized', {
    count: activeStrategies.length,
    names: launchConfig.strategies
  });
}
```

### Railway Restart = Clean Slate

Railway restarts the container on deploy:
- No in-memory state persists
- App reads fresh manifest on startup
- Only manifest strategies activate
- This is the clean slate guarantee

### Package.json Scripts

```json
{
  "scripts": {
    "launch:config": "node scripts/launch-config.mjs",
    "preflight": "node scripts/preflight.mjs",
    "deploy": "node scripts/deploy.mjs",
    "verify": "node scripts/verify.mjs"
  }
}
```
