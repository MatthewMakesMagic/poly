# Sprint Change Proposal: Production Safeguards & Integration Testing

**Date:** 2026-02-01
**Triggered By:** Production incident causing ~$90 USD loss
**Author:** Matthew + Claude (Correct Course Workflow)
**Status:** APPROVED (2026-02-01)

---

## Section 1: Issue Summary

### Problem Statement

A production deployment caused ~$90 USD loss due to multiple critical bugs:

1. **Wrong Oracle Price:** `execution-loop.js:183` called `getCurrentPrice('btc')` for ALL crypto windows. ETH/SOL/XRP windows received BTC price (~$78,438) instead of their actual prices (~$2,400/$100/$1.60), causing 100% false confidence signals.

2. **Duplicate Entries:** Safeguards failed to block re-entry to the same window, allowing 8+ ETH entries and 5+ XRP entries to the same window_id.

3. **No Paper Mode Gate:** No mechanism to deploy in signal-generation-only mode. Code went live immediately on deployment.

4. **Kill Switch Ineffective:** Emergency stop didn't prevent losses in time.

### Root Cause

**2,936 unit tests passed but production failed.**

The tests mocked everything - they verified isolated components work correctly but never tested that components work together with real data. Variable names, data contracts, and module integrations were never validated end-to-end.

### Evidence

- Logs showing duplicate entries: 8+ ETH entries to `eth-15m-1769949000`
- Code: `execution-loop.js:183` hardcoded `'btc'` for all cryptos
- Financial loss: ~$90 USD in single session
- Test gap: 2,936 unit tests, zero integration tests

---

## Section 2: Impact Analysis

### Epic Impact

| Epic | Status | Impact |
|------|--------|--------|
| Epic 7 | in-progress | Add 2 new stories (7-19, 7-20) for integration tests and oracle fix |
| Epic 8 | in-progress | Add 2 new stories (8-8, 8-9) for trading gate and safeguards |
| Epic Scout | done | Add 1 new story (E.3) for paper mode clarity |

### Artifact Conflicts

| Artifact | Change Required |
|----------|-----------------|
| **PRD** | Add FR47: Trading mode gate required for all deployments |
| **Architecture** | Update execution-loop design for per-crypto prices |
| **config/default.js** | Add `liveTradingEnabled` with Railway env var |
| **execution-loop.js** | Fix oracle price per crypto, add trading gate |
| **safeguards.js** | Add position-aware 1-trade-per-window enforcement |

### Technical Impact

| Component | Change |
|-----------|--------|
| `execution-loop.js` | Per-crypto price fetch, trading gate check |
| `safeguards.js` | In-memory position Set, canEnter/reserveEntry pattern |
| `position-manager` | Notify safeguards on position open/close |
| `config/default.js` | `liveTradingEnabled` from Railway env |
| `run_live_trading.mjs` | Clear PAPER/LIVE banner on startup |
| `__tests__/integration/` | New integration test suite |

---

## Section 3: Recommended Approach

### Selected Path: Direct Adjustment

**Rationale:**
- Bugs are isolated to specific code paths
- Fixes are straightforward and well-defined
- No fundamental architecture change needed
- Integration tests prevent recurrence
- Can be implemented incrementally

### Effort & Risk Assessment

| Story | Effort | Risk | Priority |
|-------|--------|------|----------|
| 8-8 Live Trading Gate | Small | Low | CRITICAL - before any deploy |
| 8-9 One Trade Per Window | Medium | Low | CRITICAL - before any deploy |
| 7-20 Per-Crypto Oracle | Small | Low | HIGH |
| 7-19 Integration Tests | Medium | Low | HIGH |
| E.3 Scout Paper Clarity | Small | Low | MEDIUM |

### Timeline Impact

- **Immediate:** Stories 8-8 and 8-9 must complete before ANY further live deployment
- **Before next deploy:** Stories 7-19 and 7-20 should complete
- **Can follow:** Story E.3 (Scout clarity)

---

## Section 4: Detailed Change Proposals

### Story 8-8: Live Trading Gate

**Location:** Epic 8 (Launch Control)
**Priority:** CRITICAL

As a **trader**, I want **live trading disabled by default, requiring explicit Railway toggle**, so that **I must manually enable live trading in Railway dashboard**.

**Acceptance Criteria:**
- System runs in PAPER mode unless Railway variable explicitly enables live
- PAPER mode: signals logged, orders NOT placed, safeguards still record entries
- LIVE mode: orders placed, clear warning banner
- Variable: `LIVE_TRADING` = `enabled` / `disabled` (VERIFY on Railway)

**Code Changes:**
- `config/default.js`: `liveTradingEnabled: process.env.LIVE_TRADING === 'enabled'`
- `execution-loop.js`: Gate before order placement
- `run_live_trading.mjs`: Clear startup banner showing mode

---

### Story 8-9: One Trade Per Strategy Per Window Safeguard

**Location:** Epic 8 (Launch Control)
**Priority:** CRITICAL

As a **trader**, I want **maximum one trade per strategy per window, with position-aware fast lookup**, so that **I never have duplicate entries and execution remains fast**.

**Acceptance Criteria:**
- In-memory Set of entered {window_id, strategy_id} pairs
- Initialized from position-manager on startup
- O(1) lookup in hot path (no DB query per signal)
- canEnter() → reserveEntry() → order → confirmEntry() flow
- Works for both PAPER and LIVE modes

**Architecture:**
```
Position-Manager ←→ Safeguards (in-memory Set)
       ↓                    ↓
   DB (source)          O(1) lookup
```

---

### Story 7-19: Cross-Module Integration Tests

**Location:** Epic 7 (Oracle Edge Infrastructure)
**Priority:** HIGH

As a **developer**, I want **integration tests that verify modules work together with real data**, so that **data contract mismatches are caught before production**.

**Test Categories:**
1. **Data Contract Tests:** Verify field names match between modules
2. **Flow Tests:** Verify correct module calls in correct order
3. **Multi-Crypto Tests:** Verify each crypto uses its own price
4. **Safeguard Tests:** Verify safeguards are actually invoked
5. **Mode Tests:** Verify paper vs live behavior

**Technical Notes:**
- Use real module instances (minimal mocking)
- Test file: `__tests__/integration/execution-flow.test.js`
- Run as part of CI before any deployment

---

### Story 7-20: Per-Crypto Oracle Price in Execution Loop

**Location:** Epic 7 (Oracle Edge Infrastructure)
**Priority:** HIGH

As a **trader**, I want **each crypto window to use its own spot price**, so that **signal confidence is calculated with correct oracle data**.

**Code Change:**
```javascript
// OLD (line 183):
spotData = this.modules.spot.getCurrentPrice('btc');

// NEW:
const cryptos = [...new Set(windows.map(w => w.crypto))];
const spotPrices = {};
for (const crypto of cryptos) {
  spotPrices[crypto] = this.modules.spot.getCurrentPrice(crypto);
}
// Pass correct price per window to strategy
```

---

### Story E.3: Scout Paper Mode Signal Clarity

**Location:** Epic Extra (Scout)
**Priority:** MEDIUM

As a **trader monitoring via Scout**, I want **clear visual distinction between paper signals and live trades**, so that **I immediately know if I'm watching simulation or real money**.

**Acceptance Criteria:**
- PAPER mode logs: `[PAPER] signal_generated`
- LIVE mode logs: `[LIVE] order_placed`
- Scout summary: "Paper signals: 12, Live orders: 0"
- Mode field added to all signal/order log entries

---

## Section 5: Implementation Handoff

### Change Scope Classification

**MODERATE** - Requires backlog reorganization and careful sequencing

### Implementation Sequence

```
1. [8-8] Live Trading Gate        ← MUST complete first
2. [8-9] One Trade Per Window     ← MUST complete before deploy
3. [7-20] Per-Crypto Oracle       ← Fix the actual bug
4. [7-19] Integration Tests       ← Prevent recurrence
5. [E.3] Scout Paper Clarity      ← Nice to have
```

### Handoff Recipients

| Role | Responsibility |
|------|----------------|
| **Dev (Claude)** | Implement stories 8-8, 8-9, 7-19, 7-20, E.3 |
| **Matthew** | Verify Railway variable name, approve deployment |
| **Scout** | Verify paper/live mode detection works |

### Success Criteria

1. System defaults to PAPER mode on all deployments
2. Maximum 1 trade per strategy per window enforced
3. Each crypto uses correct spot price
4. Integration tests catch data contract mismatches
5. Scout clearly shows paper vs live mode

### Pre-Deployment Checklist

- [ ] Verify Railway variable name: `LIVE_TRADING` = `enabled`/`disabled`?
- [ ] Stories 8-8 and 8-9 complete and tested
- [ ] Integration tests passing (Story 7-19)
- [ ] Per-crypto oracle fix deployed (Story 7-20)
- [ ] Railway `LIVE_TRADING` set to `disabled` before deploy
- [ ] Manual verification of PAPER mode after deploy
- [ ] Only enable `LIVE_TRADING=enabled` after paper testing

---

## Appendix: Variable Name Verification

**ACTION REQUIRED:** Verify exact Railway variable name before implementation.

Current docs reference: `LIVE_TRADING_ENABLED` = `true`/`false`
User indicates Railway may use: `LIVE_TRADING` = `enabled`/`disabled`

Check Railway dashboard → Variables section for the actual naming convention.

---

**Document Status:** APPROVED
**Approved By:** Matthew
**Approved At:** 2026-02-01
**Next Step:** Implementation via dev-story workflow

### Implementation Commands

```bash
# Start with critical stories first:
/bmad-bmm-dev-story 8-8   # Live Trading Gate
/bmad-bmm-dev-story 8-9   # One Trade Per Window Safeguard
/bmad-bmm-dev-story 7-20  # Per-Crypto Oracle Fix
/bmad-bmm-dev-story 7-19  # Integration Tests
/bmad-bmm-dev-story E.3   # Scout Paper Mode Clarity
```
