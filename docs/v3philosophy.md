# V3 Philosophy: Production Reliability Principles

**Created:** 2026-02-03
**Status:** Active
**Scope:** All trading system development

> **Note:** Originally designed for SQLite, migrated to PostgreSQL for Railway persistence.
> PostgreSQL provides data durability across deploys and better concurrent connection handling.

---

## Why This Document Exists

V1 and V2 of this system failed in production despite passing tests. The failures followed a pattern:

1. Code exists and unit tests pass
2. Production wiring differs from test wiring
3. No verification that production actually works as a whole

**Specific failures:**
- `tradingMode` not reaching ExecutionLoop (config wiring)
- Stop-loss evaluating empty list (state fragmentation)
- Safeguards allowing duplicate trades (race conditions)
- Orders placed but not tracked locally (partial failure handling)

This document establishes the principles that prevent these failures.

---

## The Six Principles

### 1. Single Book, Single Truth

**Principle:** All position, order, and trade state lives in ONE place: PostgreSQL. No module maintains shadow state in memory.

**Why:** When stop-loss reads from memory cache A and position-manager writes to memory cache B, they diverge. Stop-loss evaluates an empty list while real positions exist.

**Implementation:**
```
┌─────────────────────────────────────────┐
│        THE BOOK (PostgreSQL)            │
│  - positions table                      │
│  - orders table                         │
│  - window_entries table                 │
│  - All reads query here                 │
│  - All writes go here                   │
│  - Persistent across deploys            │
│  - Shared across all instances          │
└─────────────────────────────────────────┘
        │
        ├── orchestrator reads
        ├── stop-loss reads
        ├── take-profit reads
        ├── safeguards reads AND writes (atomic)
        └── position-manager writes
```

**Why PostgreSQL over SQLite:**
- SQLite data is lost on Railway redeploys (ephemeral filesystem)
- PostgreSQL persists across deploys and restarts
- PostgreSQL handles concurrent connections better
- PostgreSQL enables historical data retention (price feeds, order books, lag analysis)

**Rules:**
- No in-memory position caches
- No in-memory order caches
- No in-memory Sets for "already entered" tracking
- Every read is a fresh DB query
- "Slower but correct" beats "fast but divergent"

---

### 2. Identical Artifacts

**Principle:** The Docker image that passes CI is the exact image that runs in production. No environment-specific code paths.

**Why:** `config/production.js` vs `config/default.js` creates code paths that are never tested together. If behavior differs by environment, the untested path will fail.

**Implementation:**
```
Environment differences come ONLY from:
  ├── Secrets (API keys, private keys) - injected at runtime
  └── TRADING_MODE env var ('PAPER' or 'LIVE')

Nothing else. No config/production.js. No if (NODE_ENV === 'production').
```

**Config Structure:**
```javascript
// config/index.js - THE ONLY CONFIG FILE
module.exports = {
  tradingMode: process.env.TRADING_MODE || 'PAPER',

  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY,      // Secret
    apiSecret: process.env.POLYMARKET_API_SECRET, // Secret
    // ... no environment-specific logic
  },

  risk: {
    maxPositionSize: 100,    // Same everywhere
    maxDrawdownPercent: 5,   // Same everywhere
  },

  // NO: if (process.env.NODE_ENV === 'production') { ... }
};
```

---

### 3. Verify Before Acting

**Principle:** Every critical operation verifies its preconditions. If verification fails, HALT - don't proceed with partial information.

**Why:** Stop-loss received an empty position list and concluded "nothing to do." It should have asked: "Is it plausible that there are zero positions?" and verified against the exchange.

**Implementation:**
```javascript
async function evaluateStopLoss() {
  // 1. Read from THE BOOK
  const localPositions = db.all('SELECT * FROM positions WHERE status = ?', ['open']);

  // 2. VERIFY against exchange (the source of truth for money)
  const exchangePositions = await polymarket.getPositions();

  // 3. Detect blindness
  if (exchangePositions.length > 0 && localPositions.length === 0) {
    circuitBreaker.trip('STOP_LOSS_BLIND', {
      exchange: exchangePositions.length,
      local: 0,
    });
    return; // HALT - we cannot safely evaluate
  }

  // 4. Now safe to proceed
  for (const pos of localPositions) {
    // ... evaluate stop-loss
  }
}
```

**Critical operations that MUST verify:**
- Stop-loss evaluation (verify can see positions)
- Take-profit evaluation (verify can see positions)
- Order placement (verify safeguard state is accessible)
- Position opening (verify not already in position)

---

### 4. Halt on Uncertainty

**Principle:** Every operation has three outcomes: SUCCESS, KNOWN_FAILURE, or UNKNOWN. On UNKNOWN, halt immediately.

**Why:** "Log and continue" on uncertainty means trading while blind. The "API succeeded but local write failed" state is UNKNOWN - we have money at risk we can't track.

**Implementation:**
```javascript
async function placeOrderSafely(params) {
  const intentId = writeAhead.logIntent('place_order', params);

  try {
    const result = await polymarket.buy(...);

    try {
      await positionManager.recordPosition(result);
      writeAhead.markCompleted(intentId);
      return { outcome: 'SUCCESS', result };

    } catch (localErr) {
      // API succeeded, local failed = UNKNOWN STATE
      circuitBreaker.trip('POSITION_TRACKING_FAILED', {
        orderId: result.orderID,
        error: localErr.message,
      });
      return { outcome: 'UNKNOWN', result, error: localErr };
    }

  } catch (apiErr) {
    writeAhead.markFailed(intentId, apiErr);
    return { outcome: 'KNOWN_FAILURE', error: apiErr };
  }
}
```

**The rule:** If you don't KNOW the state, STOP. Don't guess. Don't retry. Don't log and continue. STOP.

---

### 5. Atomic Operations

**Principle:** Operations that must be consistent use database constraints, not check-then-set patterns.

**Why:** Check-then-set has a race window. Two threads can both check, both see "clear," and both proceed.

**Anti-pattern (race condition):**
```javascript
// WRONG: Check-then-set
if (!safeguards.hasEntered(windowId)) {   // Thread A: false
  safeguards.markEntered(windowId);        // Thread A: marks
  placeOrder();                            // Thread A: places
}
// Thread B also saw false, also marks, also places = DUPLICATE TRADE
```

**Correct pattern (atomic):**
```javascript
// RIGHT: Atomic insert with unique constraint
function tryEnterWindow(windowId, strategyId) {
  try {
    db.run(
      'INSERT INTO window_entries (window_id, strategy_id, entered_at) VALUES ($1, $2, $3)',
      [windowId, strategyId, new Date().toISOString()]
    );
    return true;  // Got the lock
  } catch (err) {
    if (err.code === '23505') {  // PostgreSQL unique_violation
      return false;  // Already entered - atomic rejection
    }
    throw err;
  }
}
```

**Where this applies:**
- One trade per strategy per window (UNIQUE constraint on window_entries)
- Position opening (UNIQUE constraint on active position per market)
- Order deduplication (UNIQUE constraint on intent + status)

---

### 6. Paper Mode = Live Mode

**Principle:** Paper mode and Live mode execute identical code paths. The ONLY difference is the execution adapter.

**Why:** If Paper mode skips safeguards, skips position tracking, or uses different state management, then Paper testing proves nothing about Live behavior.

**Implementation:**
```
┌─────────────────────────────────────────────────────────────┐
│                    EXECUTION FLOW                           │
│                                                             │
│  Signal → Safeguards → Position Check → Order Decision      │
│     │                                                       │
│     │  (Identical in PAPER and LIVE)                        │
│     │                                                       │
│     ▼                                                       │
│  ┌─────────────────────┐                                    │
│  │   TRADING_MODE?     │                                    │
│  └─────────────────────┘                                    │
│       │           │                                         │
│     PAPER        LIVE                                       │
│       │           │                                         │
│       ▼           ▼                                         │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │ MockExecutor│  │ RealExecutor│  ← ONLY DIFFERENCE        │
│  │ - Fake fill │  │ - Real API  │                           │
│  │ - Real price│  │             │                           │
│  └─────────────┘  └─────────────┘                           │
│       │           │                                         │
│       └─────┬─────┘                                         │
│             ▼                                               │
│  Position recorded in PostgreSQL (SAME in both modes)       │
│  Stop-loss evaluates against PostgreSQL (SAME in both modes)│
│  Take-profit evaluates (SAME in both modes)                 │
│  Safeguards check PostgreSQL (SAME in both modes)           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**The mock executor:**
```javascript
// In PAPER mode only - simulates fills at market price
async function mockBuy(tokenId, dollars, price) {
  const marketPrice = await polymarket.getBestPrices(tokenId);
  return {
    orderID: `paper-${Date.now()}`,
    status: 'matched',
    fillPrice: marketPrice.ask,  // Pessimistic fill assumption
    size: dollars / marketPrice.ask,
  };
}
```

---

## Integration Testing Philosophy

### The Problem

Modules work in isolation. They fail in concert. Unit tests verify:
- Position-manager can record a position ✓
- Stop-loss can evaluate a position ✓
- Safeguards can block a duplicate ✓

But they don't verify:
- Stop-loss sees what position-manager recorded ✗
- Safeguards block when orchestrator calls twice quickly ✗
- The whole flow works when wired together ✗

### The Solution: Integration Tests at Every Boundary

```
┌─────────────────────────────────────────────────────────────┐
│                   INTEGRATION TEST LAYERS                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  LAYER 3: Full Flow Tests                                   │
│  └─ "Signal → Order → Position → StopLoss triggers"         │
│  └─ "Duplicate signal in same window → blocked"             │
│  └─ "API fails mid-flow → circuit breaker trips"            │
│                                                             │
│  LAYER 2: Module Pair Tests                                 │
│  └─ position-manager + stop-loss: "SL sees PM's positions"  │
│  └─ orchestrator + safeguards: "rapid calls → one entry"    │
│  └─ order-manager + position-manager: "order fill → pos"    │
│                                                             │
│  LAYER 1: Module Unit Tests                                 │
│  └─ Each module in isolation                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Required Integration Test Scenarios

**Scenario 1: Position Visibility**
```
GIVEN position-manager records a position
WHEN stop-loss evaluates
THEN stop-loss sees that position
AND can trigger exit if conditions met
```

**Scenario 2: Race Condition Prevention**
```
GIVEN a signal for window W, strategy S
WHEN two execution loops try to enter simultaneously
THEN exactly one succeeds
AND exactly one order is placed
```

**Scenario 3: Failure Cascade**
```
GIVEN a successful API order
WHEN local position recording fails
THEN circuit breaker trips
AND no further orders are placed
AND alert is raised
```

**Scenario 4: Paper/Live Parity**
```
GIVEN identical signal in PAPER and LIVE mode
WHEN processed through the full flow
THEN state changes are identical
AND only the execution call differs
```

**Scenario 5: Recovery State**
```
GIVEN system crashes with executing intent
WHEN system restarts
THEN incomplete intent is detected
AND reconciliation runs
AND system halts if exchange state differs from local
```

### Test Location

```
__tests__/
  integration/
    position-visibility.test.js      # Scenario 1
    race-condition.test.js           # Scenario 2
    failure-cascade.test.js          # Scenario 3
    paper-live-parity.test.js        # Scenario 4
    recovery-state.test.js           # Scenario 5
    full-flow.test.js                # End-to-end scenarios
```

---

## Checklist for New Code

Before merging any trading-related code:

- [ ] **Single Book:** Does this code read/write state? If yes, does it use PostgreSQL directly (not memory cache)?
- [ ] **No Environment Branches:** Does this code have `if (production)` or `if (development)`? Remove them.
- [ ] **Verify Before Act:** Does this critical operation verify its preconditions?
- [ ] **Halt on Unknown:** Does this operation have an "unknown" outcome path? Does it halt?
- [ ] **Atomic:** Does this check-then-act? Convert to atomic DB operation.
- [ ] **Paper Parity:** Does this behave differently in PAPER mode (other than execution)?
- [ ] **Integration Test:** Is there an integration test covering this code's interaction with other modules?

---

## Summary

| Principle | One-Liner |
|-----------|-----------|
| Single Book | All state in PostgreSQL. No memory caches. |
| Identical Artifacts | Same image everywhere. Env vars for secrets only. |
| Verify Before Acting | Check preconditions. Halt if blind. |
| Halt on Uncertainty | Unknown state = STOP. Don't guess. |
| Atomic Operations | DB constraints, not check-then-set. |
| Paper = Live | Same flow. Mock only at execution boundary. |
| Integration Tests | Test module interactions, not just modules. |

---

*This document is the law. Violations cause production losses.*
