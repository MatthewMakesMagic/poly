# Sprint Change Proposal - Epic 8: Launch Control & Deployment Pipeline

**Generated:** 2026-02-01
**Project:** Poly Trading System
**Change Scope:** Minor (New Epic - 5 small stories)
**Status:** APPROVED
**Approved:** 2026-02-01

---

## Section 1: Issue Summary

### Problem Statement

No structured workflow exists to deploy and verify the trading system. Current state:
- `git push` → Railway auto-deploys → hope it works
- No pre-flight validation
- No strategy selection mechanism
- No verification that deployment succeeded
- No clean-slate guarantee (old strategies could linger)

### Core Principle: Clean Slate Deployment

**What you select = exactly what runs. Nothing more, nothing less.**

- Deployment wipes previous state
- Only explicitly selected strategies are activated
- A manifest (`config/launch.json`) is the source of truth
- Health endpoint reports what's actually running for verification

---

## Section 2: Impact Analysis

| Epic | Status | Impact |
|------|--------|--------|
| Epic 1-6 | Done | No changes |
| Epic 7 | In Progress | Provides strategies to deploy |
| Epic Scout | Done | Integrated for log verification |
| **Epic 8 (NEW)** | Proposed | 5 small stories |

**Future Epic (not this one):** Tracking/observability of what strategies ran when and their outcomes over time.

---

## Section 3: CLI Interaction Sketch

```
$ npm run preflight

Pre-flight Checks
─────────────────
  ✓ POLYMARKET_API_KEY          set
  ✓ POLYMARKET_API_SECRET       set
  ✓ POLYMARKET_PASSPHRASE       set
  ✓ POLYMARKET_PRIVATE_KEY      set
  ✓ Polymarket API              connected (balance: $523.45)
  ✓ Database                    connected, 8/8 migrations
  ✓ Railway CLI                 authenticated
  ✓ Railway project             poly-trading (production)

All checks passed (8/8)


$ npm run deploy

Current launch.json:
  Strategies: oracle-edge, simple-threshold
  Position size: $10
  Max exposure: $500
  Symbols: BTC, ETH, SOL, XRP

Edit config before deploy? (y/n) n

Running pre-flight checks... ✓ passed

This will:
  1. Push current code + launch.json to Railway
  2. Railway will restart with CLEAN SLATE
  3. ONLY strategies in manifest will activate

Deploy now? (y/n) y

Deploying...
  ✓ Git push to main
  ✓ Railway build complete (38s)
  ✓ Deployment started

Verifying...
  ✓ Health endpoint responding (45ms)
  ✓ Active strategies match manifest:
      - oracle-edge ✓
      - simple-threshold ✓
  ✓ Receiving ticks (8 in last 10s)
  ✓ No errors in logs

✓ DEPLOYMENT SUCCESSFUL

Scout is watching. Use /scout for monitoring.
```

---

## Section 4: Stories

### Story 8-1: Launch Manifest

**As a** trader
**I want** a config file that declares exactly which strategies to run
**So that** deployments are explicit and reproducible

**Natural Language Workflow:**
The primary way to configure is via Claude Code conversation:
```
User: "Run oracle-edge and simple-threshold with $15 position size"
Claude: Updates launch.json, confirms, offers to deploy
```

Claude Code reads the manifest, understands available strategies, and translates natural language into config updates. No manual JSON editing required.

**Acceptance Criteria:**
- [ ] `config/launch.json` file created with schema
- [ ] Contains: selected_strategies[], position_size, max_exposure, symbols[], kill_switch
- [ ] Orchestrator reads this on startup and activates ONLY listed strategies
- [ ] Strategies not in manifest are not loaded (clean slate)
- [ ] Strategy registry exports available strategies (for Claude Code to reference)
- [ ] CLI helper for non-conversational use: `npm run launch:config`

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

**Available Strategies Reference:**
- `simple-threshold` - Current 70% threshold baseline
- `oracle-edge` - Pure staleness fade (Epic 7)
- `probability-model` - Black-Scholes with oracle spot (Epic 7)
- `lag-based` - Cross-correlation signals (Epic 7)
- `hybrid` - Weighted combination (Epic 7)

---

### Story 8-2: Pre-flight Checks

**As a** trader
**I want** to validate everything is ready before deploying
**So that** I catch problems before they cost money

**Acceptance Criteria:**
- [ ] `npm run preflight` runs all checks
- [ ] Checks: env vars, API credentials (with balance check), database connection, migrations, Railway CLI auth
- [ ] Each check reports pass/fail with details
- [ ] Exit code 0 if all pass, 1 if any fail
- [ ] Can be run standalone or as part of deploy

**Checks:**
1. Environment variables (POLYMARKET_*, DATABASE_URL)
2. Polymarket API auth (hit /auth endpoint, report balance)
3. Database connection + migration status
4. Railway CLI installed and authenticated
5. Launch manifest valid (strategies exist)

---

### Story 8-3: Health Endpoint Enhancement

**As a** deployment system
**I want** the health endpoint to report exactly what's running
**So that** I can verify the deployment matches the manifest

**Acceptance Criteria:**
- [ ] `GET /api/live/status` returns enhanced payload
- [ ] Reports: active_strategies[], connection status, last_tick, error_count_1m
- [ ] active_strategies matches what orchestrator actually loaded
- [ ] Response time < 500ms

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

---

### Story 8-4: Deploy Command

**As a** trader
**I want** a single command that deploys to Railway with clean slate
**So that** deployment is safe and consistent

**Acceptance Criteria:**
- [ ] `npm run deploy` orchestrates full deployment
- [ ] Runs preflight first, aborts if failed
- [ ] Shows current manifest, offers to edit (interactive prompt)
- [ ] Confirms before deploying (shows what will happen)
- [ ] Pushes to Railway (git push or railway up)
- [ ] Waits for build + deploy completion
- [ ] Runs verification automatically
- [ ] Reports success/failure with clear output

**Flow:**
1. Run preflight → abort if fail
2. Show manifest → offer edit
3. Confirm deploy
4. Git push to main (triggers Railway)
5. Poll Railway for build/deploy status
6. Run verify
7. Report result

---

### Story 8-5: Post-deploy Verification

**As a** trader
**I want** automatic verification that deployment succeeded
**So that** I know the system is actually running correctly

**Acceptance Criteria:**
- [ ] `npm run verify` runs standalone or after deploy
- [ ] Polls health endpoint until healthy or timeout (60s)
- [ ] Compares active_strategies to manifest (must match exactly)
- [ ] Checks tick flow (receiving data)
- [ ] Checks error count (should be 0 or low)
- [ ] Integrates with Scout for log verification
- [ ] Clear pass/fail output

**Verification Points:**
1. Health endpoint returns 200 with status: "healthy"
2. active_strategies matches launch.json exactly
3. last_tick within last 30 seconds
4. error_count_1m == 0
5. Scout reports no error patterns in logs

---

## Section 5: Implementation

### Implementation Order

1. **8-1** (Launch Manifest) - Foundation, orchestrator integration
2. **8-3** (Health Endpoint) - Needed for verification
3. **8-2** (Pre-flight) - Standalone utility
4. **8-5** (Verify) - Uses health endpoint
5. **8-4** (Deploy) - Orchestrates everything

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

### Dependencies
```json
{
  "dependencies": {
    "inquirer": "^9.0.0"  // Simple prompts, not full TUI
  }
}
```

### Success Criteria

1. `npm run preflight` validates system readiness
2. `npm run deploy` deploys with confirmation and verification
3. Only strategies in manifest are running (clean slate)
4. Health endpoint confirms what's actually active
5. Failed deployments are clearly reported

---

## Appendix: Clean Slate Implementation

### How Orchestrator Enforces Manifest

```javascript
// In orchestrator init()
import launchConfig from '../../config/launch.json';

async function init(config) {
  // Load ONLY strategies from manifest
  const activeStrategies = [];

  for (const strategyName of launchConfig.strategies) {
    const strategy = await loadStrategy(strategyName);
    if (strategy) {
      activeStrategies.push(strategy);
      log.info('strategy_loaded', { name: strategyName });
    }
  }

  // No other strategies loaded - clean slate
  state.activeStrategies = activeStrategies;
}
```

### Railway Restart = Clean Slate

Railway restarts the container on deploy, so:
- No in-memory state persists
- App reads fresh manifest on startup
- Only manifest strategies activate

This is the clean slate guarantee.
