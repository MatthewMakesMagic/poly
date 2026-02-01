# Sprint Change Proposal: Post-Deployment Remediation

**Date:** 2026-02-01
**Triggered By:** Catastrophic first live deployment of Epic 7 & 8
**Severity:** CRITICAL
**Status:** APPROVED (2026-02-01)

---

## Section 1: Issue Summary

### Problem Statement

Epic 7 (Oracle Edge Infrastructure) and Epic 8 (Launch Control & Deployment Pipeline) were deployed to production with critical integration failures. The deployment resulted in:

- **Wrong price inputs** causing probability model to return `p_up = 1.0` for all conditions
- **Data contract mismatches** between modules (field names, types, symbol case)
- **Missing position safeguards** allowing rapid position stacking
- **Kill switch failure** when emergency stop was needed
- **Wrong window targeting** entering positions in incorrect market windows

### Context

The code was committed (commit `32a72b5`) but required 6 emergency fix commits during live deployment:
- `a4981ed` - Component initialization
- `42df148` - Window iteration context
- `fab63a2` - Symbol case handling
- `9132fda` - Price input type
- `96283dd` - Token ID field mapping
- `75609ad` - Strategy name registry

### Root Cause Analysis

| Category | Finding |
|----------|---------|
| **Integration Testing** | Components tested in isolation, never together |
| **Data Contracts** | No standardized field naming or type enforcement |
| **Position Controls** | Safeguards specified in Epic 8 but not implemented |
| **Kill Switch** | Designed for local process, not Railway deployment |
| **Review Process** | Stories marked "done" without integration validation |

### Evidence

1. Git history shows 6 sequential fix commits in rapid succession
2. User had to manually exit positions to prevent losses
3. Kill switch command failed requiring manual Railway dashboard intervention
4. Probability model calculated `p_up = 1.0` due to receiving $78,950 instead of 0.72

---

## Section 2: Impact Analysis

### Epic Impact

| Epic | Status | Impact |
|------|--------|--------|
| **Epic 7** | in-progress | Story 7-12 cannot complete without integration validation |
| **Epic 8** | done (incorrect) | Should be reverted to in-progress; missing critical functionality |

### Story Impact

**Current Stories Requiring Re-evaluation:**

| Story | Current Status | Issue | Action |
|-------|----------------|-------|--------|
| 7-12 | in-progress | Integration incomplete | Add integration test requirements |
| 7-9 | review | Quality gate not enforced | Wire into composed strategy |
| 8-4 | done | Deploy command doesn't validate integration | Add integration test gate |
| 8-5 | done | Verification doesn't catch data contract issues | Enhance verification |

**New Stories Required:**

| Story | Epic | Title | Rationale |
|-------|------|-------|-----------|
| 7-13 | 7 | Data Contract Enforcement & Integration Tests | Prevent future integration failures |
| 7-14 | 7 | Correct Probability Model Inputs | Model receives wrong price types |
| 7-15 | 7 | Market Reference Price Parsing | Can't calculate P(UP) without strike |
| 7-16 | 7 | Edge-Based Signal Generation with Lag Detection | Signals ignore market price, miss edge |
| 8-6 | 8 | Railway API Kill Switch | Enable remote emergency stop |
| 8-7 | 8 | Position Entry Safeguards | Prevent rapid position stacking |

### Artifact Conflicts

| Artifact | Conflict | Resolution |
|----------|----------|------------|
| Architecture | No data contract specification | Add data contracts section |
| Epic 8 | Kill switch assumes local process | Add Railway API alternative |
| Sprint Status | Epic 8 marked done incorrectly | Revert to in-progress |

### Technical Impact

| Area | Impact |
|------|--------|
| **Orchestrator** | Needs data contract enforcement layer |
| **Composed Strategy** | Needs position safeguards before signal generation |
| **Kill Switch** | Needs Railway API integration |
| **CI/CD** | Needs integration test stage |

---

## Section 3: Recommended Approach

### Selected Path: Direct Adjustment

Add new stories to complete the missing functionality. No rollback or MVP reduction needed.

### Rationale

1. **Post-incident fixes are correct** - The 6 emergency commits fixed real bugs
2. **Gap, not rewrite** - Missing functionality can be added incrementally
3. **MVP unchanged** - The trading system works; we need reliability improvements
4. **Risk contained** - Changes are additive, not destructive

### Effort Estimate

| Story | Effort | Risk |
|-------|--------|------|
| 8-7 Position Entry Safeguards | Small | Low |
| 8-6 Railway API Kill Switch | Small | Low |
| 7-15 Market Reference Price Parsing | Small | Low |
| 7-14 Correct Probability Model Inputs | Medium | Medium |
| 7-16 Edge-Based Signal Generation | Medium | Medium |
| 7-13 Data Contracts & Integration Tests | Medium | Low |

**Total Effort:** ~2-3 days of focused implementation

**Critical Path:** 7-15 → 7-14 → 7-16 (probability model must be fixed in order)

### Timeline Impact

Deployment should NOT proceed until:
1. All three new stories are implemented
2. Integration tests pass
3. Kill switch verified working against Railway

---

## Section 4: Detailed Change Proposals

### Story 7-13: Data Contract Enforcement & Integration Tests

**Epic:** 7 - Oracle Edge Infrastructure
**Priority:** Critical
**Size:** Medium

**As a** developer,
**I want** standardized data contracts and integration tests for the strategy composition pipeline,
**So that** components communicate correctly and failures are caught before deployment.

**Acceptance Criteria:**

**Given** the strategy composition pipeline exists
**When** data flows between components
**Then** a data contract layer validates:
- `spotPrice` is token price (0-1), not crypto dollar price
- `symbol` is lowercase (`btc`, not `BTC`)
- `token_id` is mapped from `token_id_up`/`token_id_down`
- All required fields are present before component execution

**Given** integration tests exist
**When** running `npm run test:integration`
**Then** the full strategy pipeline is tested:
- RTDS client → Divergence tracker → Probability model → Signal generator
- Mock data produces expected signals
- Wrong data produces validation errors

**Given** probability model integration tests
**When** testing edge calculation
**Then** verify:
1. Oracle price ($95,000) + Reference ($94,500) → p_up ≈ 0.78
2. p_up (0.78) - market_price (0.52) → edge ≈ 0.26
3. Edge > 0.10 → entry signal generated
4. Edge < 0.10 → no signal
5. Negative edge → no signal
6. Lag detection: oracle moves, market doesn't → lag_detected: true

**Given** sanity check command exists
**When** running `npm run verify:edge`
**Then** fetch live data and verify:
- Oracle prices available from RTDS
- Reference prices parsed from market questions
- Edge calculation produces sensible results (0.0 - 0.5 range)
- Log results for human verification

**Given** a component receives invalid input
**When** validation fails
**Then** error is logged with field name and expected vs actual
**And** component returns error result instead of corrupted output

**Technical Notes:**
- Create `src/modules/data-contracts/` with validation schemas
- Add Zod or similar for runtime validation
- Integration tests use sqlite in-memory for speed

---

### Story 7-14: Correct Probability Model Inputs

**Epic:** 7 - Oracle Edge Infrastructure
**Priority:** Critical
**Size:** Medium

**As a** quant trader,
**I want** the probability model to receive correct oracle and reference prices,
**So that** Black-Scholes calculates meaningful probabilities for trading decisions.

**Problem Statement:**

The window-timing-model was designed to calculate P(oracle_price > reference_price at expiry) using:
- S = oracle crypto price (e.g., $95,000)
- K = market reference price (e.g., $94,500)

But the orchestrator currently passes:
- S = token price (0.72) ← WRONG
- K = 0.5 (hardcoded) ← WRONG

**Acceptance Criteria:**

**Given** the probability model is called
**When** receiving context from orchestrator
**Then** it receives:
- `oraclePrice`: Current Chainlink oracle price for the crypto (e.g., $95,000)
- `referencePrice`: Market reference price parsed from question (e.g., $94,500)
- `timeToExpiry`: Time remaining in milliseconds
- `symbol`: Lowercase crypto symbol

**Given** the divergence tracker has oracle prices
**When** building window context
**Then** orchestrator includes `oracle_price` from divergence-tracker state
**And** passes it as the spot price to probability components

**Given** probability is calculated correctly
**When** logging the calculation
**Then** log includes: `{ S: 95000, K: 94500, T_ms: 300000, sigma: 0.45, d2: 1.23, p_up: 0.89 }`

**Technical Notes:**
- Orchestrator must query divergence-tracker for current oracle prices
- Window context needs new field: `oracle_price` (from RTDS Chainlink feed)
- Story 7-15 provides the `referencePrice` from market parsing

---

### Story 7-15: Market Reference Price Parsing

**Epic:** 7 - Oracle Edge Infrastructure
**Priority:** Critical
**Size:** Small

**As a** quant trader,
**I want** the market reference price extracted from market questions,
**So that** the probability model has the correct strike price for calculations.

**Problem Statement:**

Polymarket binary markets have questions like:
- "Will BTC be above **$94,500** at 12:15 UTC?"
- "Will ETH be above **$3,250** at 12:30 UTC?"

The reference price ($94,500, $3,250) is the strike (K) for Black-Scholes, but it's not being parsed.

**Acceptance Criteria:**

**Given** window-manager fetches a market
**When** parsing market data
**Then** extract reference price from `market.question` using regex
**And** include `reference_price` in window object

**Given** question format: "Will {CRYPTO} be above ${PRICE} at {TIME}?"
**When** parsing
**Then** extract numeric price value (handle commas, decimals)

**Given** reference price is extracted
**When** window object is returned
**Then** window includes: `{ reference_price: 94500, ... }`

**Given** question format is unexpected
**When** parsing fails
**Then** log warning with question text
**And** set `reference_price: null`
**And** strategy should skip this window (cannot calculate probability)

**Regex Pattern:**
```javascript
const match = question.match(/above\s*\$?([\d,]+(?:\.\d+)?)/i);
const referencePrice = match ? parseFloat(match[1].replace(',', '')) : null;
```

**Technical Notes:**
- Implement in `window-manager/index.js` in `fetchMarket()` function
- Add to window object returned by `getActiveWindows()`
- Probability model should reject windows without reference_price

---

### Story 7-16: Edge-Based Signal Generation with Lag Detection

**Epic:** 7 - Oracle Edge Infrastructure
**Priority:** Critical
**Size:** Medium

**As a** quant trader,
**I want** signals generated only when there's a positive edge between model probability and market price,
**So that** I only enter trades where the market is mispriced in my favor.

**Problem Statement:**

Current signal logic:
```javascript
if (p_up > 0.7) signal = 'entry';  // Ignores market price!
```

This enters trades even when there's NO edge or NEGATIVE edge.

**Correct Logic:**

```
Model says: 75% chance UP (from Black-Scholes)
Market price: 51% (token price)
Edge: 75% - 51% = 24% → TRADE (positive edge)

Model says: 75% chance UP
Market price: 85% (token price)
Edge: 75% - 85% = -10% → NO TRADE (negative edge, market already priced it)
```

**Acceptance Criteria:**

**Given** probability model returns p_up
**When** evaluating signal
**Then** calculate edge: `edge = p_up - market_token_price`
**And** generate 'entry' signal only if `edge > min_edge_threshold`

**Given** configurable thresholds
**When** strategy is loaded
**Then** honor configuration:
```json
{
  "edge": {
    "min_edge_threshold": 0.10,
    "max_edge_threshold": 0.50,
    "confidence_weight": true
  }
}
```

**Given** lag detection is enabled
**When** oracle price moves but market token price hasn't repriced
**Then** edge opportunity is detected
**And** signal includes: `{ edge, lag_detected: true, oracle_move_pct, market_move_pct }`

**Given** lag creates edge
**When** generating signal
**Then** log: `edge_signal: { p_up: 0.75, market_price: 0.51, edge: 0.24, lag_ms: 1500 }`

**Given** edge is too high (> max_edge_threshold)
**When** evaluating
**Then** treat as suspicious (possible stale data or market issue)
**And** log warning, optionally skip

**Lag Detection Logic:**

```javascript
// Detect lag between price feeds
const oracleMoved = Math.abs(currentOraclePrice - previousOraclePrice) / previousOraclePrice;
const marketMoved = Math.abs(currentTokenPrice - previousTokenPrice);

// If oracle moved significantly but market hasn't repriced
if (oracleMoved > 0.001 && marketMoved < 0.02) {
  lagDetected = true;
  lagOpportunity = true;  // Market hasn't caught up to oracle move
}
```

**Integration Test Requirements:**

**Given** integration tests for edge calculation
**When** running test suite
**Then** verify:
1. Edge correctly calculated from model vs market
2. No signal when edge < threshold
3. Signal generated when edge > threshold
4. Lag detection triggers on oracle move without market reprice
5. Suspicious edge (too high) is logged/skipped
6. End-to-end: oracle price change → probability recalc → edge detected → signal generated

**Sanity Check on Deploy:**

**Given** system is deployed to Railway
**When** post-deploy verification runs
**Then** execute sanity check:
1. Fetch current oracle prices
2. Fetch current market token prices
3. Calculate expected probability for sample window
4. Verify edge calculation matches expected
5. Log: `sanity_check_passed: { oracle: 95000, ref: 94500, p_up: 0.78, market: 0.52, edge: 0.26 }`

**Technical Notes:**
- Modify `window-timing-model.js` evaluate() to receive market_price in context
- Add edge calculation before returning signal
- Track previous prices for lag detection (in-memory state)
- Add `npm run verify:edge` command for deployment sanity check

---

### Story 8-6: Railway API Kill Switch

**Epic:** 8 - Launch Control & Deployment Pipeline
**Priority:** Critical
**Size:** Small

**As a** trader,
**I want** to say "kill" to Claude and have it immediately stop Railway,
**So that** I can halt trading in an emergency without any manual steps.

**Core Requirement:**

```
User: "kill"
Claude: [Executes kill script automatically]
Claude: "Railway service stopped. Deployment terminated."
```

**NO** CLI instructions. **NO** dashboard links. **NO** "you need to...". Just dead.

**Acceptance Criteria:**

**Given** user says "kill" (or "stop", "halt", "emergency stop")
**When** Claude Code receives this
**Then** Claude automatically executes `node kill-switch/railway-kill.mjs`
**And** the Railway service is stopped via API
**And** Claude confirms: "Killed. Service stopped at {timestamp}"

**Given** Railway API call is made
**When** executing kill
**Then** service replicas set to 0 (immediate stop)
**And** no user interaction required
**And** completion within 5 seconds

**Given** kill succeeds
**When** confirming to user
**Then** show: deployment name, stop time, final status

**Given** kill fails (API error, network issue)
**When** first attempt fails
**Then** retry once automatically
**And** if still fails, Claude opens Railway dashboard in browser AND displays the direct stop URL
**And** says "Auto-kill failed. Opened dashboard - click Stop on poly-live service"

**Given** local development (no Railway deployment)
**When** kill is executed
**Then** send SIGTERM/SIGKILL to local orchestrator process
**And** confirm local process stopped

**Implementation:**

1. **Claude Code Hook** (`.claude/settings.json` or hooks):
```json
{
  "hooks": {
    "user_prompt_submit": {
      "match": "^(kill|stop|halt|emergency)",
      "command": "node kill-switch/railway-kill.mjs"
    }
  }
}
```

2. **Kill Script** (`kill-switch/railway-kill.mjs`):
```javascript
// 1. Detect environment (Railway vs local)
// 2. If Railway: Call API to set replicas=0
// 3. If local: Send SIGTERM to PID file process
// 4. Verify stopped
// 5. Exit with status code (0=success, 1=failed)
```

3. **Railway API Call**:
```javascript
const response = await fetch('https://backboard.railway.app/graphql', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: `mutation { serviceInstanceUpdate(serviceId: "${SERVICE_ID}", input: { numReplicas: 0 }) { id } }`
  })
});
```

**Environment Variables Required:**
- `RAILWAY_API_TOKEN` - Railway API token with deploy permissions
- `RAILWAY_SERVICE_ID` - The specific service ID for poly-live

**Testing:**
- Test with staging deployment first
- Verify kill works when called by Claude
- Verify retry logic on failure
- Verify fallback opens browser

**Technical Notes:**
- Store SERVICE_ID in `.env` or `config/railway.json`
- Script must be executable and return proper exit codes
- Claude should interpret exit code and report success/failure

---

### Story 8-7: Position Entry Safeguards

**Epic:** 8 - Launch Control & Deployment Pipeline
**Priority:** Critical
**Size:** Small

**As a** trader,
**I want** safeguards preventing rapid position accumulation,
**So that** a malfunctioning strategy cannot stack unlimited positions.

**Acceptance Criteria:**

**Given** a signal is generated
**When** evaluating entry
**Then** the following checks are enforced:
1. **Duplicate window check:** No re-entry to same window_id within session
2. **Rate limiting:** Maximum 1 entry per symbol per 5 seconds
3. **Concurrent cap:** Maximum 8 open positions total (configurable)
4. **Per-tick limit:** Maximum 2 entries per tick cycle

**Given** a safeguard is triggered
**When** entry is blocked
**Then** reason is logged: `entry_blocked: { reason, window_id, symbol }`
**And** signal is discarded (not queued)

**Given** safeguards are configurable
**When** launch.json is read
**Then** these settings are honored:
```json
{
  "safeguards": {
    "max_concurrent_positions": 8,
    "min_entry_interval_ms": 5000,
    "max_entries_per_tick": 2,
    "duplicate_window_prevention": true
  }
}
```

**Given** safeguards exist
**When** disabled in launch.json
**Then** warning is logged: `safeguards_disabled: { setting }`

**Technical Notes:**
- Implement in `src/modules/position-manager/safeguards.js`
- Called from orchestrator before order placement
- State tracked in memory (reset on restart is acceptable)

---

## Section 5: Implementation Handoff

### Change Scope Classification: **MODERATE**

This requires:
- 3 new stories added to backlog
- Epic 8 status reverted to in-progress
- Sprint status file updated
- Development team implementation

### Handoff Recipients

| Role | Responsibility |
|------|----------------|
| **Developer** | Implement stories 7-13, 8-6, 8-7 |
| **Scrum Master** | Update sprint status, create story files |
| **Tester** | Validate integration tests cover failure scenarios |

### Implementation Order

**Phase 1: Safety (Do First)**
1. **8-7 Position Entry Safeguards** - Prevent runaway position stacking
2. **8-6 Railway API Kill Switch** - Emergency stop capability

**Phase 2: Probability Model Fix (Core Logic)**
3. **7-15 Market Reference Price Parsing** - Get strike price from market question
4. **7-14 Correct Probability Model Inputs** - Wire oracle + reference prices to model
5. **7-16 Edge-Based Signal Generation** - Only trade when edge exists, detect lag

**Phase 3: Validation**
6. **7-13 Data Contracts & Integration Tests** - Full pipeline validation

### Success Criteria

Before next deployment:

**Safety:**
- [ ] Story 8-7: Position safeguards active (rate limiting, duplicate prevention)
- [ ] Story 8-6: Kill switch verified against Railway API

**Probability Model:**
- [ ] Story 7-15: Reference price extracted from market questions
- [ ] Story 7-14: Model receives oracle price ($95,000) not token price (0.72)
- [ ] Story 7-16: Edge calculated (model vs market), lag detection working

**Integration:**
- [ ] Story 7-13: All integration tests pass: `npm run test:integration`
- [ ] Edge sanity check passes on deploy: `npm run verify:edge`

**Verification Tests:**
- [ ] With oracle at $95,000 and reference at $94,500, p_up ≈ 0.75-0.85
- [ ] With market price at 0.51, edge = p_up - 0.51 ≈ 0.24-0.34
- [ ] Signal generated only when edge > 0.10
- [ ] No signal when market price already > model probability

### Pre-Deployment Checklist Addition

Add to `npm run preflight`:
```
✓ Integration tests passing
✓ Position safeguards enabled
✓ Railway API token configured
✓ Kill switch verified (dry-run)
✓ Edge calculation sanity check passed
✓ Reference price parsing verified
```

---

## Appendix A: Sprint Status Updates

### Changes to sprint-status.yaml

```yaml
# Epic 8 status change
epic-8: in-progress  # Was: done

# New Epic 8 stories
8-6-railway-api-kill-switch: backlog
8-7-position-entry-safeguards: backlog

# New Epic 7 stories (Probability Model Fix)
7-13-data-contract-integration-tests: backlog
7-14-correct-probability-model-inputs: backlog
7-15-market-reference-price-parsing: backlog
7-16-edge-based-signal-generation: backlog
```

---

## Appendix B: Architecture Updates Needed

### Data Contract Specification (New Section)

Add to Architecture document:

```markdown
## Data Contracts

### Window Context Contract

All strategy components receive window context with these standardized fields:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `oracle_price` | number ($) | divergence-tracker | Chainlink oracle crypto price (e.g., $95,000) |
| `reference_price` | number ($) | window.reference_price | Strike from market question (e.g., $94,500) |
| `market_price` | number (0-1) | window.market_price | Token price (market's implied probability) |
| `symbol` | string (lowercase) | window.crypto.toLowerCase() | e.g., "btc", "eth" |
| `token_id` | string | window.token_id_up | For LONG entries |
| `token_id_up` | string | window.token_id_up | UP token address |
| `token_id_down` | string | window.token_id_down | DOWN token address |
| `timeToExpiry` | number (ms) | window.time_remaining_ms | Milliseconds to window close |
| `window_id` | string | window.window_id | Unique window identifier |
| `market_id` | string | window.market_id | Polymarket market ID |

### Price Types (Critical Distinction)

| Price Type | Example | Use |
|------------|---------|-----|
| **Oracle Price** | $95,000 | Black-Scholes S (spot) - settlement truth |
| **Reference Price** | $94,500 | Black-Scholes K (strike) - from market question |
| **Token Price** | 0.72 | Market's implied probability - for edge calculation |

### Probability Model Flow

```
1. Oracle price ($95,000) + Reference price ($94,500) → Black-Scholes → p_up (0.78)
2. p_up (0.78) - market_price (0.52) → edge (0.26)
3. edge (0.26) > threshold (0.10) → SIGNAL ENTRY
```

### Validation

Components MUST validate input before processing:
- Reject if oracle_price <= 0
- Reject if reference_price <= 0 or null
- Reject if market_price > 1 or < 0
- Reject if symbol not in ['btc', 'eth', 'sol', 'xrp']
- Reject if token_id is undefined or empty
```

---

## Appendix C: Kill Switch Implementation

### User Experience

```
User: kill
Claude: Stopping Railway deployment...
Claude: ✓ Killed. poly-live stopped at 2026-02-01T14:32:15Z
```

No questions. No instructions. Just dead.

### Claude Code Hook Configuration

Add to `.claude/settings.json`:
```json
{
  "hooks": {
    "user_prompt_submit": [
      {
        "pattern": "^\\s*(kill|stop|halt|emergency)\\s*$",
        "command": "node kill-switch/railway-kill.mjs",
        "blocking": true
      }
    ]
  }
}
```

### Kill Script (`kill-switch/railway-kill.mjs`)

```javascript
#!/usr/bin/env node
import 'dotenv/config';

const RAILWAY_API = 'https://backboard.railway.app/graphql';
const TOKEN = process.env.RAILWAY_API_TOKEN;
const SERVICE_ID = process.env.RAILWAY_SERVICE_ID;

async function killRailway() {
  console.log('Stopping Railway deployment...');

  const mutation = `
    mutation {
      serviceInstanceUpdate(
        serviceId: "${SERVICE_ID}"
        input: { numReplicas: 0 }
      ) { id }
    }
  `;

  const response = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: mutation }),
  });

  if (!response.ok) {
    throw new Error(`Railway API error: ${response.status}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0].message);
  }

  console.log(`✓ Killed. Service stopped at ${new Date().toISOString()}`);
  process.exit(0);
}

async function killLocal() {
  const { readFileSync, existsSync } = await import('fs');
  const pidFile = './data/main.pid';

  if (!existsSync(pidFile)) {
    console.log('No local process running.');
    process.exit(0);
  }

  const pid = parseInt(readFileSync(pidFile, 'utf8').trim());
  process.kill(pid, 'SIGTERM');

  // Wait and force kill if needed
  await new Promise(r => setTimeout(r, 2000));
  try { process.kill(pid, 'SIGKILL'); } catch {}

  console.log(`✓ Killed local process ${pid}`);
  process.exit(0);
}

// Detect environment and kill appropriately
if (TOKEN && SERVICE_ID) {
  killRailway().catch(err => {
    console.error(`Kill failed: ${err.message}`);
    console.log('Opening Railway dashboard...');
    import('open').then(m => m.default('https://railway.app/dashboard'));
    process.exit(1);
  });
} else {
  killLocal().catch(err => {
    console.error(`Local kill failed: ${err.message}`);
    process.exit(1);
  });
}
```

### Environment Setup

Add to `.env`:
```bash
RAILWAY_API_TOKEN=your-railway-api-token
RAILWAY_SERVICE_ID=your-service-id-from-railway
```

Get SERVICE_ID from Railway dashboard URL: `railway.app/project/.../service/{SERVICE_ID}`

---

**Document Created:** 2026-02-01
**Author:** Correct Course Workflow
**Approved:** 2026-02-01 by Matthew
**Status:** APPROVED - Ready for Implementation
