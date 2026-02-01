# MAJOR DEPLOYMENT PROBLEMS

**Date:** 2026-02-01
**Severity:** CRITICAL
**Status:** UNRESOLVED - This document does NOT cover all issues

---

## Executive Summary

After spending hours building Epic 7 (Oracle Edge Infrastructure) and Epic 8 (Launch Control & Deployment Pipeline), the first live deployment was a **complete disaster**. Nearly every component failed in some way. The user had to manually exit positions to prevent further losses. This was preventable and represents a systemic failure in our development and deployment process.

**This document is incomplete.** There are likely additional issues not yet discovered.

---

## Critical Failures

### 1. EPIC 7 & 8 CODE WAS NEVER COMMITTED TO GIT

**Severity:** CRITICAL

The entire Epic 7 and Epic 8 implementation (140 files, 46,198 lines of code) was sitting uncommitted locally while we attempted to deploy. The code review workflows marked stories as "done" but **never committed the actual code**.

Railway was running the OLD codebase without:
- Strategy composition framework
- Launch config module
- Probability model
- All new components

**We deployed nothing. We tested nothing.**

---

### 2. KILL SWITCH DID NOT WORK

**Severity:** CRITICAL

After all the work on Epic 8 building a "Launch Control" system with kill switch integration, **when the user needed to stop the system in an emergency, it didn't work.**

```
User: "KILL SWITCH"
User: "STOP THE SERVICE, WE HAVE SET THE WHOLE THING UP TO BE ABLE TO DO THIS. DO IT RIGHT NOW."
```

The kill switch failed because:
- Railway CLI requires interactive TTY for confirmation prompts
- No `--yes` flag support for non-interactive stop
- Local kill signal file doesn't affect Railway deployment
- The watchdog process wasn't monitoring correctly

**The user had to manually remove the deployment from Railway dashboard.**

This is **abysmal**. The entire point of building kill switch infrastructure was for exactly this emergency scenario, and it failed completely.

---

### 3. STRATEGY NAMES DIDN'T MATCH

**Severity:** HIGH

The launch manifest used strategy names that didn't match the strategy JSON files:

| Launch Manifest | Strategy JSON File |
|-----------------|-------------------|
| `probability-model` | `"Probability Model Only"` |
| `lag-based` | `"Lag-Based"` |
| `hybrid` | `"Hybrid"` |

Result: Strategies couldn't be loaded. System silently fell back to old 70% threshold logic.

---

### 4. COMPONENTS NOT INITIALIZED

**Severity:** HIGH

The composed strategy executor called `component.module.evaluate()` without first calling `component.module.init()`.

```
Error: "Window timing model not initialized. Call init() first."
```

The probability model was discovered but never initialized, causing all evaluations to fail.

---

### 5. WRONG PRICE PASSED TO MODEL

**Severity:** HIGH

The context passed to the probability model used the **crypto dollar price** ($78,950) instead of the **token price** (0.72).

```javascript
// WRONG
spotPrice: spotData.price  // $78,950

// CORRECT
spotPrice: window.market_price  // 0.72
```

This caused the model to calculate `p_up = 1.0` for everything because $78,950 >> 0.5 strike.

---

### 6. SYMBOL CASE MISMATCH

**Severity:** MEDIUM

The model expected lowercase symbols (`btc`, `eth`, `sol`, `xrp`) but received uppercase (`BTC`).

```
Error: "Invalid symbol: BTC. Supported: btc, eth, sol, xrp"
```

---

### 7. TOKEN ID FIELD NAME MISMATCH

**Severity:** HIGH

Window manager returns:
- `token_id_up`
- `token_id_down`

Orchestrator looked for:
- `token_id`

Result: Order book calls failed with "Invalid token id" because `token_id` was undefined.

---

### 8. PROBABILITY MODEL RETURNED INCORRECT VALUES

**Severity:** CRITICAL

Even after fixes, the model returned `p_up = 1.0` for conditions where it should NOT:

```
S: 0.55 (token at 55%)
K: 0.50 (strike at 50%)
p_up: 1.0 ???

Expected: ~0.65-0.70, NOT 1.0
```

This caused the system to generate entry signals on EVERY window, EVERY tick.

---

### 9. RAPID POSITION STACKING

**Severity:** CRITICAL

The system generated 4 signals per tick (BTC, ETH, SOL, XRP) across multiple windows. With ticks running every second:

- 4 signals × 2 windows × multiple ticks = **massive rapid position accumulation**

No safeguards existed to prevent:
- Re-entering same window
- Rate limiting entries
- Maximum concurrent positions

---

### 10. POSITIONS ENTERED IN WRONG WINDOW

**Severity:** CRITICAL

The user reported:
> "it didn't even enter positions in the correct market window - it somehow did it in the following market window"

The system targeted the wrong epoch, entering positions in windows that were STARTING rather than windows with favorable conditions.

---

### 11. MULTIPLE DEPLOYMENT ATTEMPTS REQUIRED

**Severity:** HIGH

The deployment process required **7+ git commits and pushes** just to get basic functionality working:

1. Fix strategy names
2. Commit Epic 7/8 code (should have been done FIRST)
3. Fix component initialization
4. Fix context mapping (wrong price)
5. Fix symbol case
6. Fix token_id field name
7. Fix token price vs dollar price

Each fix required a full Railway rebuild cycle (~1-2 minutes), during which the broken system may have been executing trades.

---

## What SHOULD Have Happened

1. **All code committed BEFORE any deployment discussion**
2. **Local integration tests passing before deployment**
3. **Staging environment test before production**
4. **Kill switch tested and verified working**
5. **Single deployment with verified preflight checks**
6. **Immediate reliable stop capability**

---

## What Actually Happened

1. Marked stories as "done" without committing code
2. Deployed to production with untested, uncommitted code
3. Discovered failures one-by-one in production
4. Made 7+ emergency fixes while system was live
5. Kill switch failed when needed
6. User forced to manually exit positions
7. User forced to manually stop deployment via dashboard

---

## Lessons Learned

### NEVER AGAIN:

1. **Never mark a story "done" without verifying git commit**
2. **Never deploy without running full test suite locally**
3. **Never deploy without staging environment validation**
4. **Never trust Railway CLI for emergency stops - have dashboard open**
5. **Never assume component initialization happens automatically**
6. **Never assume field names match across modules**
7. **Never deploy composed strategy system without integration tests**

### REQUIRED BEFORE NEXT DEPLOYMENT:

- [ ] Comprehensive integration test suite for strategy composition
- [ ] Staging environment on Railway
- [ ] Verified, tested kill switch with non-interactive mode
- [ ] Pre-deployment checklist with manual verification steps
- [ ] Position entry safeguards (rate limiting, duplicate prevention)
- [ ] Correct probability model implementation with unit tests
- [ ] Field name standardization across all modules

---

## Unresolved Issues

This document is **INCOMPLETE**. Known unresolved issues include:

1. Why did positions enter in wrong window?
2. What was the actual position size discrepancy?
3. Why did probability return 1.0 for S=0.55?
4. Are there other field mismatches we haven't discovered?
5. What other components have initialization requirements?
6. Is the strategy loader properly mapping all fields?
7. Does the quality gate (Story 7-9) actually work?

---

## Conclusion

This deployment was **shoddy, piss poor, and diabolically awful**.

Hours of work on Epic 7 and Epic 8 were undermined by:
- Failure to commit code
- Failure to test integration
- Failure to verify kill switch
- Failure to validate data flow
- Failure to catch obvious bugs

The user was **extremely lucky** to catch this quickly and exit positions manually. A few more minutes of unchecked execution could have resulted in significant financial loss.

**This must never happen again.**

---

*Document created: 2026-02-01*
*Author: Post-incident review*
*Status: OPEN - Requires remediation before any future deployment*
