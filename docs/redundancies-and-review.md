# Redundancies & Review: V3 Codebase Cleanup

**Created:** 2026-02-04
**Purpose:** Catalogue of code that violates, predates, or is made redundant by the V3 philosophy. Use this document as a checklist when doing a cleanup pass.
**Reference:** [V3 Philosophy](./v3philosophy.md)

---

## Why This Cleanup Matters

The codebase evolved through three phases:
1. **V1/V2** — Feature-first development with epics and stories
2. **V3 Stages 0-3** — Foundation fixes (config, env parity, PostgreSQL, data capture)
3. **V3 Stages 4-7** — Remaining principle enforcement (single book, circuit breakers, paper parity, live)

V3 stages 0-3 changed the infrastructure under the code, but much of the application code still embodies pre-V3 patterns. These patterns passed tests but caused production failures — the exact scenario V3 was created to prevent. Code that contradicts V3 principles is not just "technical debt" — it's a production risk vector.

The epic/story backlog (7-13 through 7-16, 8-6, 8-7) was retired on 2026-02-04 because V3 stages 4-7 provide a more coherent roadmap. The functional gaps those stories identified are addressed within the V3 stage work, not as standalone items.

---

## Critical: In-Memory State Caches

**V3 Principle Violated:** Single Book, Single Truth — all state in PostgreSQL, no memory caches.

These modules maintain shadow state in memory. When modules read from different caches, they diverge. This is the root cause of V1/V2 production failures.

### Position Manager
- `src/modules/position-manager/state.js:15` — `const positionCache = new Map()`
- Lines 37-96: `cachePosition()`, `updateCachedPosition()`, `getCachedPositions()` all operate on in-memory cache
- **Fix:** Remove cache. Every read should query PostgreSQL directly.

### Order Manager
- `src/modules/order-manager/state.js:15` — `const orderCache = new Map()`
- Lines 37-200: Full cache lifecycle duplicating DB state
- **Fix:** Remove cache. Query DB for order state.

### Position Manager Safeguards
- `src/modules/position-manager/safeguards.js:33-36`
  - `enteredEntries = new Set()` — confirmed entries
  - `reservedEntries = new Set()` — pending reservations
  - `reservationTimestamps = new Map()` — timeout tracking
  - `lastEntryTimeBySymbol = new Map()` — rate limiting
- **Fix:** Replace with `window_entries` table with UNIQUE constraints (V3 Principle 5).

### Strategy Evaluator
- `src/modules/strategy-evaluator/state.js:23` — `windowsEntered: new Set()`
- Lines 62-88: In-memory window entry tracking
- **Fix:** Remove. Duplicate of safeguards tracking. Single source in DB.

### Scout Module
- `src/modules/scout/state.js:38-39`
  - `activeStrategies = new Set()`
  - `openPositions = new Map()`
- **Fix:** Query DB for active strategies and positions. Scout should read, not cache.

### Safety Module
- `src/modules/safety/state.js:27` — `warnedLevels = new Set()`
- Lines 12-74: Cached daily performance record
- **Fix:** Move to DB. File-based persistence (lines 155-182) also needs migration.

### Virtual Position Manager
- `src/modules/virtual-position-manager/index.js:23,27`
  - `virtualPositions = new Map()`
  - `highWaterMarks = new Map()`
- **Fix:** V3 Principle 6 (Paper = Live) — paper mode positions should go to PostgreSQL through the same code path as live. Mock only at the execution boundary.

---

## Critical: Check-Then-Set Patterns

**V3 Principle Violated:** Atomic Operations — DB constraints, not check-then-set.

### Safeguards Duplicate Entry Prevention
- `src/modules/position-manager/safeguards.js:149-172`
- Pattern: `if (enteredEntries.has(key))` then return blocked
- **Race window:** Two threads both check, both see clear, both proceed
- **Fix:** `INSERT INTO window_entries ... ON CONFLICT DO NOTHING` with UNIQUE constraint

### Strategy Evaluator Window Entry
- `src/modules/strategy-evaluator/entry-logic.js:62,125`
- Pattern: `if (hasEnteredWindow(id))` (line 62) ... `markWindowEntered(id)` (line 125)
- 63 lines of code between check and mark — large race window
- **Fix:** Atomic DB insert with unique constraint

### Safeguards Reservation System
- `src/modules/position-manager/safeguards.js:303-337`
- Pattern: Check `enteredEntries` and `reservedEntries`, then add to `reservedEntries`
- **Fix:** DB-level reservation with status column and unique constraint

---

## High: Duplicate Window Entry Tracking

Two independent systems track the same thing:
1. `src/modules/position-manager/safeguards.js:33` — `enteredEntries` Set
2. `src/modules/strategy-evaluator/state.js:23` — `windowsEntered` Set

Both implement check-then-set independently. This redundancy means:
- Bugs in one don't get caught by the other (false confidence)
- They can diverge silently
- **Fix:** Single `window_entries` table with UNIQUE constraint. Both modules query the same table.

---

## High: File-Based Persistence

**V3 Principle Violated:** Single Book — PostgreSQL is the single source of truth.

### Safety Auto-Stop State
- `src/modules/safety/state.js:155-182` — writes to JSON file
- `config/index.js:352-354` — `autoStopStateFile: './data/auto-stop-state.json'`
- **Fix:** Move to a `system_state` table in PostgreSQL.

### Kill Switch State
- `config/index.js:352` — `stateFilePath: './data/last-known-state.json'`
- **Fix:** Move to PostgreSQL. Ephemeral filesystem on Railway means this state is lost on redeploy anyway.

---

## High: In-Memory Statistics

Multiple modules accumulate stats in memory that are lost on restart:

- `src/modules/position-manager/state.js:20-24` — `totalOpened`, `totalClosed`, `totalPnl`
- `src/modules/order-manager/state.js:20-30` — `ordersPlaced`, `ordersFilled`, latency
- `src/modules/scout/state.js:23-32` — event counters, signal counts
- `src/modules/order-book-collector/index.js:38-43` — snapshot counts

**Fix:** Compute from DB queries or write to a `metrics` table. Stats computed from the book are always correct; stats accumulated in memory drift on restart.

---

## Medium: SQLite Remnants

### Config Fallback
- `config/index.js:221-232` — `getSqliteDatabasePath()` still exported
- **Fix:** Remove. PostgreSQL is the only persistence layer.

### Scripts
- `scripts/preflight.mjs:551,638` — hardcoded `./data/poly.db` paths
- `scripts/backtest.mjs:224` — references `./data/poly.db`
- **Fix:** Remove SQLite references. Use DATABASE_URL only.

### Tests
- `src/modules/state-reconciler/__tests__/index.test.js:25` — SQLite test fixture
- `src/modules/strategy/components/probability/__tests__/window-timing-model.test.js:19` — SQLite test fixture
- **Fix:** Update tests to use PostgreSQL test database.

---

## Medium: Legacy Config Patterns

### Deprecated Env Var Support
- `config/index.js:71-94` — backwards compatibility for `LIVE_TRADING_ENABLED`
- Emits deprecation warning but still supports the old pattern
- **Fix:** Remove. V3 uses `TRADING_MODE` only.

### Test Environment Detection
- `config/index.js:57-59` — `isTestEnvironment()` checks `NODE_ENV`
- Not a direct V3 violation (test detection is acceptable), but review whether this creates code path divergence.

---

## Medium: Temporary / Marked-for-Replacement Code

### Window Manager
- `src/modules/window-manager/index.js:4-10` — marked as "TEMP SOLUTION"
- Comment states it needs WebSocket subscriptions
- `src/modules/window-manager/index.js:140` — `openingPriceCache = new Map()`
- **Fix:** Evaluate if this module should be rewritten or removed as part of V3 Stage 4.

---

## Low: Acceptable In-Memory Patterns

These are in-memory but do not violate V3 because they don't represent trading state:

- **Event subscribers** (callbacks/listeners) — `spot/client.js`, `rtds/client.js`, `divergence-tracker/tracker.js`, `oracle-edge-signal/generator.js`. These are pub/sub wiring, not state.
- **Strategy loader registry** — `strategy/loader.js:29`. Loaded strategy definitions are code, not trading state.
- **Backtest module** — `src/backtest/`. Uses in-memory state intentionally for simulation. Not production code. Evaluate if still needed.

---

## Retired Epic Stories

The following backlog stories were retired on 2026-02-04, superseded by V3 stages:

| Story | Original Purpose | Superseded By |
|-------|-----------------|---------------|
| 7-13 | Data contract integration tests | V3 integration testing philosophy + Stage 4 |
| 7-14 | Correct probability model inputs | Stage 6 paper mode validation |
| 7-15 | Market reference price parsing | Stage 6 paper mode validation |
| 7-16 | Edge-based signal generation | Stage 6 paper mode validation |
| 8-6 | Railway API kill-switch | `/kill` skill + Stage 5 circuit breakers |
| 8-7 | Position entry safeguards | Stage 4 atomic operations + 8-9 (done) |

---

## Cleanup Priority Order

When performing the cleanup pass, work through these in order:

1. **In-memory state caches** (Critical) — position-manager, order-manager, safeguards
2. **Check-then-set patterns** (Critical) — safeguards, strategy-evaluator
3. **Duplicate tracking** (High) — consolidate window entry tracking to DB
4. **File-based persistence** (High) — safety state, kill switch state
5. **In-memory stats** (High) — move to DB or compute from DB
6. **SQLite remnants** (Medium) — config, scripts, tests
7. **Legacy config** (Medium) — deprecated env vars
8. **Temp code** (Medium) — window manager

*This cleanup should happen as part of V3 Stage 4 (Single Book + Atomic Safeguards), which directly addresses items 1-3.*
