---
title: 'Production Reliability - V3 Philosophy Implementation'
slug: 'v3-philosophy-implementation'
created: '2026-02-03'
status: 'ready-for-dev'
stepsCompleted: [1, 2, 3, 4, 5]
tech_stack:
  - Node.js (ES Modules)
  - PostgreSQL (Railway managed)
  - Polymarket CLOB API
  - Polymarket Data API (positions endpoint - no auth required)
  - Binance WebSocket
  - Pyth Network
  - Chainlink
  - Vitest (testing framework)
  - better-sqlite3 (current - to be replaced with pg)
files_to_modify:
  - config/index.js (add DATABASE_URL, TRADING_MODE validation)
  - config/default.js (merge into index.js, then delete)
  - src/persistence/index.js (SQLite → PostgreSQL with pg)
  - src/persistence/database.js (replace better-sqlite3 with pg-pool)
  - src/persistence/schema-manager.js (update for PostgreSQL syntax)
  - src/persistence/write-ahead.js (update for PostgreSQL transactions)
  - src/modules/position-manager/safeguards.js (in-memory Set → DB constraints)
  - src/modules/stop-loss/index.js (direct DB query + verification)
  - src/modules/take-profit/index.js (direct DB query + verification)
  - src/modules/orchestrator/execution-loop.js (remove price cache reliance)
  - src/clients/polymarket/index.js (add getPositions via Data API)
  - NEW: src/modules/circuit-breaker/index.js
  - NEW: src/modules/data-capture/index.js
  - NEW: src/modules/position-verifier/index.js
  - NEW: src/routes/health.js (health check endpoint)
code_patterns:
  - Single Book (PostgreSQL-only state)
  - Atomic operations (DB UNIQUE constraints + transactions)
  - Verify-before-act (exchange positions before SL/TP)
  - Halt-on-uncertainty (circuit breaker on UNKNOWN)
  - Reserve/Confirm flow for safeguards (currently in-memory, needs DB migration)
  - Frozen config after validation (Object.freeze pattern)
test_patterns:
  - Framework: Vitest with vi.mock()
  - Unit: __tests__/*.test.js collocated with modules
  - Integration: __tests__/integration/*.test.js
  - Lifecycle: beforeEach(init)/afterEach(shutdown)
  - Module mocking: vi.fn() for dependencies
philosophy_doc: docs/v3philosophy.md
database: PostgreSQL (Railway)
data_retention:
  raw_ticks: 7 days (future: months)
  aggregates: indefinite
  events: indefinite
investigation_findings:
  critical_gaps:
    - "safeguards.js uses in-memory Set (enteredEntries, reservedEntries)"
    - "stop-loss/take-profit read position.current_price from cache, not DB"
    - "polymarket client has NO getPositions() method"
    - "entire persistence layer hardcoded to better-sqlite3 API"
  sqlite_specific_code:
    - "database.js:44 - new Database(path)"
    - "database.js:47 - PRAGMA journal_mode = WAL"
    - "database.js:192 - db.transaction(fn)()"
    - "migrations - INTEGER PRIMARY KEY AUTOINCREMENT"
  config_status:
    - "TRADING_MODE hardcoded to PAPER in default.js:12"
    - "Railway detection exists (RAILWAY_ENVIRONMENT vars)"
    - "Config frozen after validation (index.js:179)"
---

# Tech-Spec: V3 Philosophy Implementation

**Created:** 2026-02-03
**Philosophy Reference:** [docs/v3philosophy.md](../../docs/v3philosophy.md)

## Overview

### Problem Statement

Production failures follow a consistent pattern: code passes unit tests but fails when deployed. Root causes:

1. **State Fragmentation** - Stop-loss reads memory, position-manager writes different memory. They diverge.
2. **Environment Divergence** - config/production.js has code paths never tested with config/default.js.
3. **Race Conditions** - Check-then-set patterns in safeguards allow duplicate trades.
4. **Silent Failures** - Operations fail partially and continue, leaving unknown state.
5. **Paper/Live Divergence** - Paper mode skips real state management, so it proves nothing.
6. **Integration Gaps** - Modules work alone, fail together.

### Solution

Implement the V3 Philosophy: six principles that eliminate these failure modes by construction, not by testing after the fact.

### Scope

**In Scope:**
- Config consolidation (eliminate environment-specific files)
- Single Book migration (SQLite-only state, no memory caches)
- Atomic safeguards (DB constraints replace check-then-set)
- Verify-before-act patterns for SL/TP
- Circuit breaker with halt-on-uncertainty
- Paper/Live parity (mock at execution boundary only)
- Polymarket Data API integration (getPositions for verification)
- Integration test suite for module interactions

**Out of Scope:**
- UI/dashboard changes
- New trading strategies
- Performance optimization (correctness first)

---

## Context for Development

### Philosophy Principles (from v3philosophy.md)

| # | Principle | Implementation |
|---|-----------|----------------|
| 1 | Single Book | All state in SQLite. No memory caches. |
| 2 | Identical Artifacts | One config file. Env vars for secrets + TRADING_MODE only. |
| 3 | Verify Before Acting | SL/TP verify they can see positions before evaluating. |
| 4 | Halt on Uncertainty | Unknown outcome = circuit breaker trips. |
| 5 | Atomic Operations | DB constraints for safeguards, not check-then-set. |
| 6 | Paper = Live | Same flow everywhere. Mock only at execution boundary. |

### Polymarket API Capabilities

**Verified via API documentation:**

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET https://data-api.polymarket.com/positions?user=0x...` | Full position list | None |
| `getTrades()` (CLOB) | Filled order history | L2 headers |
| `getOpenOrders()` (CLOB) | Active orders | L2 headers |

The Data API positions endpoint returns: `conditionId`, `asset`, `size`, `avgPrice`, `currentValue`, `curPrice`, `outcome` - everything needed for reconciliation.

### Current State Audit

| Module | Current State Storage | Required Change |
|--------|----------------------|-----------------|
| position-manager | Memory + SQLite | SQLite only |
| safeguards | In-memory Set | SQLite with UNIQUE constraint |
| stop-loss | Reads from position-manager memory | Query SQLite directly |
| take-profit | Reads from position-manager memory | Query SQLite directly |
| order-manager | Memory cache + SQLite | SQLite only (cache is OK for reads if populated from DB) |

### Files to Reference (Deep Investigation Results)

| File | Key Lines | Purpose | Required Changes |
|------|-----------|---------|------------------|
| `config/index.js` | 25-39, 47-61, 72-84 | Config loading, Railway detection, deep merge | Add DATABASE_URL handling, TRADING_MODE validation |
| `config/default.js` | 12 | TRADING_MODE='PAPER' hardcoded | Merge into index.js, delete file |
| `src/persistence/database.js` | 44, 47, 192 | SQLite-specific: `new Database()`, WAL pragma, transaction | Replace with pg-pool, PostgreSQL syntax |
| `src/persistence/index.js` | 34-74, 108-193 | Interface: init, run, get, all, exec, transaction | Same interface, PostgreSQL implementation |
| `src/persistence/schema-manager.js` | 71 | `PRAGMA table_info()` | PostgreSQL information_schema queries |
| `src/modules/position-manager/safeguards.js` | 33-37, 149-172, 303-412 | In-memory Sets, duplicate check, reserve/confirm | DB constraints with UNIQUE, transaction |
| `src/modules/stop-loss/index.js` | Full file | Evaluation logic | Add DB query for positions, verification step |
| `src/modules/take-profit/index.js` | Full file | Evaluation with trailing | Add DB query for positions, verification step |
| `src/modules/orchestrator/execution-loop.js` | 676-692, 863-879 | Gets positions from cache, price fallback | Direct DB query for positions |
| `src/clients/polymarket/index.js` | 43-78, 208-247 | Init, buy/sell methods | Add getPositions() via Data API |

### Technical Decisions (Investigation-Based)

| Decision | Rationale |
|----------|-----------|
| Replace `better-sqlite3` with `pg` + `pg-pool` | PostgreSQL required for Railway persistence; same interface pattern |
| Connection pool: main (2-10) + CB dedicated (2) | Circuit breaker needs guaranteed connection; main pool for all others |
| Keep reserve/confirm safeguard pattern | Already implemented, just move from Set to DB constraint |
| Add `position_entry_locks` table | New table for atomic safeguards: (window_id, strategy_id) UNIQUE |
| Polymarket Data API for verification | `GET positions?user=0x...` - no auth, returns all position data |
| Vitest as test framework | Already in use, keep patterns: vi.mock, beforeEach/afterEach |

---

## Implementation Plan

### Phase 0: PostgreSQL Migration

**Task 0.1: Railway PostgreSQL Setup**
- Provision PostgreSQL on Railway
- Configure connection string as env var `DATABASE_URL`
- Test connectivity from local and deployed environments

**Task 0.1.1: Update v3philosophy.md for PostgreSQL**
- Replace all references to "SQLite" with "PostgreSQL" in `docs/v3philosophy.md`
- **Specific changes required:**
  - Line 259: Change "Position recorded in SQLite" → "Position recorded in PostgreSQL"
  - Line 213: Change error code `SQLITE_CONSTRAINT_UNIQUE` → PostgreSQL `23505`
  - Lines 383, 397: Update checklist references from "SQLite" → "PostgreSQL"
  - Add header note: "Originally designed for SQLite, migrated to PostgreSQL for Railway persistence"
- Update code examples to use PostgreSQL syntax (SERIAL, TIMESTAMPTZ, etc.)
- This keeps the "law" document consistent with implementation

**Task 0.2: Persistence Layer Migration**
- Replace `better-sqlite3` with `pg` (node-postgres)
- Update `src/persistence/index.js` to use PostgreSQL
- Connection pooling configuration (main pool: min 2, max 10)
- **Dedicated circuit breaker pool** (max 2, separate from main)
- Same interface: `run()`, `get()`, `all()`, `transaction()`
- **Startup guard**: Refuse to start if PostgreSQL unreachable (fail closed)
- Retry connection 3x with 2s delay before fatal exit
- **Query timeout**: 5 second max for all queries
- **Query retry**: Exponential backoff (100ms, 200ms, 400ms) for connection errors
- Retryable errors: ECONNRESET, ETIMEDOUT, 57P01 (admin shutdown)
- Non-retryable: constraint violations, syntax errors
- **DATABASE_URL Security Requirements**:
  - Must include `sslmode=require` for Railway PostgreSQL
  - Validate connection string format before first connection (reject malformed URLs)
  - **NEVER log DATABASE_URL** - redact in all error messages
  - Parse and validate: host, port, database name, user must be present
  - Reject connections without SSL in production (TRADING_MODE=LIVE)

**Task 0.3: Core Schema Migration**
- Migrate existing tables to PostgreSQL syntax:
  - `trade_intents`, `positions`, `orders`, `trade_events`
  - `daily_performance`, `strategy_instances`, `window_entries`
- Run migrations on startup (idempotent)
- **Migration version tracking**: `schema_migrations` table with version + checksum
- **Version check on startup**: If code expects LOWER version than DB, refuse to start
- **Additive-only policy**: No DROP COLUMN, RENAME COLUMN, or breaking ALTER for 7 days
- New columns must have DEFAULT values for backward compatibility
- **Rollback strategy**:
  - Each migration file has corresponding `down` migration in same file
  - `schema_migrations` tracks both `up_checksum` and `down_checksum`
  - Rollback command: `npm run migrate:down` (runs last N down migrations)
  - Down migrations must be tested before up migration is deployed
  - **Data-corrupting migrations require backup**: Any migration that modifies existing data must trigger a pre-migration backup to `_backups` table

**Task 0.3.1: Database-Level Constraints**
- Add `position_counters` table with CHECK constraints for limits:
  ```sql
  CREATE TABLE position_counters (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    open_count INTEGER NOT NULL DEFAULT 0 CHECK (open_count <= 5),
    total_exposure DECIMAL(20,8) NOT NULL DEFAULT 0 CHECK (total_exposure <= 1000)
  );
  ```
- All limit enforcement at database level, not application level
- Position open/close atomically updates counters in same transaction
- **Concurrent update protection** (prevents race conditions):
  ```sql
  -- Use conditional UPDATE with RETURNING to atomically check-and-increment
  UPDATE position_counters
  SET open_count = open_count + 1
  WHERE id = 1 AND open_count < 5
  RETURNING open_count;
  -- If no rows returned, limit was reached (reject position)
  ```
- Never use SELECT then UPDATE pattern (race window)
- Same pattern for total_exposure: UPDATE WHERE total_exposure + $new < 1000

**Task 0.3.2: Write-Ahead Log Migration**
- Update `src/persistence/write-ahead.js` for PostgreSQL
- Verify `logIntent()`, `markExecuting()`, `markCompleted()` use pg transactions
- Verify `getIncompleteIntents()` works on startup for crash recovery
- Test: Create intent → kill process → restart → intent detected as incomplete

**Task 0.3.3: Add Required npm Scripts**
- Add to package.json scripts:
  ```json
  {
    "db:migrate": "node scripts/migrate.js up",
    "db:migrate:down": "node scripts/migrate.js down",
    "db:manage-partitions": "node scripts/manage-partitions.js",
    "data:replay-batches": "node scripts/replay-failed-batches.js",
    "test:alerts": "node scripts/test-alerts.js",
    "health:check": "curl -f http://localhost:3000/health || exit 1"
  }
  ```
- Create corresponding script files in `scripts/` directory
- Each script should be runnable standalone and exit with appropriate code

**Task 0.4: Data Capture Schema (New Tables)**

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- RAW PRICE FEEDS (High frequency, partitioned by day)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE price_ticks (
  id BIGSERIAL,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  source VARCHAR(30) NOT NULL,  -- 'binance_spot', 'binance_polymarket', 'chainlink', 'pyth', 'polymarket'
  price DECIMAL(20, 8) NOT NULL,
  token_id VARCHAR(100),        -- For Polymarket prices
  PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

-- Create partitions for current + next 7 days (cron job creates new ones)
-- Auto-drop partitions older than 7 days

CREATE INDEX idx_price_ticks_symbol_source ON price_ticks (symbol, source, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- ORDER BOOK SNAPSHOTS (Every 1-5 seconds)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE order_book_snapshots (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  token_id VARCHAR(100) NOT NULL,
  best_bid DECIMAL(10, 4),
  best_ask DECIMAL(10, 4),
  spread DECIMAL(10, 6),
  mid_price DECIMAL(10, 4),
  bid_depth_100 DECIMAL(20, 2),  -- $ within 1% of best bid
  ask_depth_100 DECIMAL(20, 2),
  bid_depth_500 DECIMAL(20, 2),  -- $ within 5%
  ask_depth_500 DECIMAL(20, 2)
);

CREATE INDEX idx_orderbook_symbol_time ON order_book_snapshots (symbol, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- LAG CORRELATION ANALYSIS (Periodic snapshots)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE lag_analysis (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  fast_feed VARCHAR(30) NOT NULL,   -- e.g., 'binance_spot'
  slow_feed VARCHAR(30) NOT NULL,   -- e.g., 'chainlink'
  tau_star_ms INTEGER,              -- Optimal lag
  correlation DECIMAL(6, 4),
  p_value DECIMAL(10, 8),
  sample_size INTEGER,
  tau_variance DECIMAL(10, 4),      -- Stability metric
  correlation_profile JSONB         -- {0: 0.12, 1000: 0.45, 2000: 0.67, ...}
);

CREATE INDEX idx_lag_analysis_symbol ON lag_analysis (symbol, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- ORACLE UPDATE EVENTS (When Chainlink/Pyth actually updates)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE oracle_updates (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  oracle_source VARCHAR(30) NOT NULL,  -- 'chainlink', 'pyth'
  old_price DECIMAL(20, 8),
  new_price DECIMAL(20, 8),
  price_change_pct DECIMAL(10, 6),
  time_since_last_update_ms INTEGER
);

CREATE INDEX idx_oracle_updates_symbol ON oracle_updates (symbol, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- FEED DIVERGENCE EVENTS (When feeds disagree)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE feed_divergence_events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  fast_feed VARCHAR(30) NOT NULL,
  slow_feed VARCHAR(30) NOT NULL,
  fast_feed_price DECIMAL(20, 8),
  slow_feed_price DECIMAL(20, 8),
  divergence_pct DECIMAL(10, 6),
  divergence_direction VARCHAR(10),  -- 'up' or 'down'
  window_id VARCHAR(100),
  time_to_window_close_ms INTEGER,   -- NULL if not near close
  convergence_time_ms INTEGER,
  converged_to_price DECIMAL(20, 8)
);

CREATE INDEX idx_divergence_symbol ON feed_divergence_events (symbol, timestamp DESC);
CREATE INDEX idx_divergence_window ON feed_divergence_events (window_id) WHERE window_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- WINDOW CLOSE EVENTS (Critical for Edge 2: Resolution prediction)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE window_close_events (
  id BIGSERIAL PRIMARY KEY,
  window_id VARCHAR(100) NOT NULL UNIQUE,
  symbol VARCHAR(10) NOT NULL,

  -- Timing
  window_close_time TIMESTAMPTZ NOT NULL,
  oracle_resolution_time TIMESTAMPTZ,

  -- Oracle prices at intervals before close
  oracle_price_60s_before DECIMAL(20, 8),
  oracle_price_30s_before DECIMAL(20, 8),
  oracle_price_10s_before DECIMAL(20, 8),
  oracle_price_5s_before DECIMAL(20, 8),
  oracle_price_1s_before DECIMAL(20, 8),
  oracle_price_at_close DECIMAL(20, 8),

  -- All feed prices at close
  binance_price_at_close DECIMAL(20, 8),
  pyth_price_at_close DECIMAL(20, 8),
  chainlink_price_at_close DECIMAL(20, 8),
  polymarket_binance_at_close DECIMAL(20, 8),

  -- Market prices at intervals (UP token)
  market_up_price_60s DECIMAL(10, 4),
  market_up_price_30s DECIMAL(10, 4),
  market_up_price_10s DECIMAL(10, 4),
  market_up_price_5s DECIMAL(10, 4),
  market_up_price_1s DECIMAL(10, 4),

  -- Market prices at intervals (DOWN token)
  market_down_price_60s DECIMAL(10, 4),
  market_down_price_30s DECIMAL(10, 4),
  market_down_price_10s DECIMAL(10, 4),
  market_down_price_5s DECIMAL(10, 4),
  market_down_price_1s DECIMAL(10, 4),

  -- Resolution
  strike_price DECIMAL(20, 8) NOT NULL,
  resolved_direction VARCHAR(10),

  -- Market consensus analysis
  market_consensus_direction VARCHAR(10),
  market_consensus_confidence DECIMAL(6, 4),
  surprise_resolution BOOLEAN
);

CREATE INDEX idx_window_close_symbol ON window_close_events (symbol, window_close_time DESC);
CREATE INDEX idx_window_close_surprise ON window_close_events (surprise_resolution) WHERE surprise_resolution = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════
-- ENHANCED LAG SIGNALS (With execution context)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE lag_signals (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  window_id VARCHAR(100),

  -- Signal generation context
  spot_price DECIMAL(20, 8) NOT NULL,
  oracle_price DECIMAL(20, 8) NOT NULL,
  polymarket_price DECIMAL(10, 4),
  spot_move_pct DECIMAL(10, 6) NOT NULL,
  predicted_direction VARCHAR(10) NOT NULL,
  predicted_tau_ms INTEGER NOT NULL,
  correlation_at_signal DECIMAL(6, 4),
  confidence DECIMAL(6, 4),

  -- Order book context
  spread_at_signal DECIMAL(10, 6),
  depth_at_signal DECIMAL(20, 2),

  -- Outcome tracking
  oracle_update_timestamp TIMESTAMPTZ,
  oracle_update_price DECIMAL(20, 8),
  actual_tau_ms INTEGER,
  outcome_direction VARCHAR(10),
  prediction_correct BOOLEAN,

  -- If traded
  order_id VARCHAR(100),
  fill_price DECIMAL(10, 4),
  slippage DECIMAL(10, 6),
  pnl DECIMAL(20, 8)
);

CREATE INDEX idx_lag_signals_symbol ON lag_signals (symbol, timestamp DESC);
CREATE INDEX idx_lag_signals_correct ON lag_signals (prediction_correct, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- RESOLUTION EDGE PERFORMANCE (Track Edge 2 predictions)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE resolution_edge_performance (
  id BIGSERIAL PRIMARY KEY,
  window_id VARCHAR(100) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(10) NOT NULL,

  -- Prediction
  predicted_resolution VARCHAR(10),
  prediction_confidence DECIMAL(6, 4),
  prediction_source VARCHAR(50),  -- 'oracle_lead', 'feed_divergence', 'model'
  time_before_close_ms INTEGER,

  -- Position taken
  position_size DECIMAL(20, 8),
  entry_price DECIMAL(10, 4),

  -- Outcome
  actual_resolution VARCHAR(10),
  correct BOOLEAN,
  pnl DECIMAL(20, 8),

  -- Analysis
  oracle_vs_prediction_diff DECIMAL(20, 8)
);

CREATE INDEX idx_resolution_edge_symbol ON resolution_edge_performance (symbol, timestamp DESC);
CREATE INDEX idx_resolution_edge_correct ON resolution_edge_performance (correct, timestamp DESC);
```

### Phase 1: Foundation (Config + Schema)

**Task 1.1: Config Consolidation**
- Delete `config/default.js`, `config/development.js`, `config/production.js`
- Create single `config/index.js`
- Environment variables: `TRADING_MODE`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_PRIVATE_KEY`
- All other config values are constants (same everywhere)

**Task 1.1.1: Logging Standards**
- **Format**: JSON (for Railway log aggregation)
- **Required fields** for every log entry:
  ```json
  { "timestamp": "ISO8601", "level": "INFO|WARN|ERROR|CRITICAL",
    "module": "circuit-breaker", "event": "cb_tripped", "context": {...} }
  ```
- **Log levels**:
  - `DEBUG`: Verbose (disabled in production)
  - `INFO`: Normal operations (startup, shutdown, trades)
  - `WARN`: Recoverable issues (rate limited, cache used)
  - `ERROR`: Failures requiring attention (DB error, API failure)
  - `CRITICAL`: System halting (circuit breaker trips, shutdown)
- **Destination**: stdout (Railway captures automatically)
- **Sensitive data**: NEVER log API keys, private keys, DATABASE_URL
- Update `src/modules/logger/index.js` to enforce format

**Task 1.2: Schema Migration for Safeguards**
- Add `window_entries` table with UNIQUE constraint on `(window_id, strategy_id)`
- Migration script to create table

```sql
CREATE TABLE IF NOT EXISTS window_entries (
  id SERIAL PRIMARY KEY,
  window_id VARCHAR(100) NOT NULL,
  strategy_id VARCHAR(50) NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id VARCHAR(100),
  UNIQUE(window_id, strategy_id)
);
```

### Phase 2: Single Book Migration

**Task 2.1: Safeguards Atomic Rewrite**
- Remove in-memory `enteredWindows` Set
- Implement `tryEnterWindowAndPlaceOrder()` - **entry and order in single transaction**
- **Transaction isolation: SERIALIZABLE** (required for race condition prevention)
- Atomic flow:
  1. `BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE`
  2. INSERT into window_entries (fails if UNIQUE violated OR serialization conflict)
  3. Place order (still in transaction)
  4. UPDATE window_entries with order_id
  5. COMMIT (or ROLLBACK on any failure)
- **Serialization failure handling**: On PostgreSQL error 40001 (serialization_failure), retry once then return `{ entered: false, reason: 'SERIALIZATION_CONFLICT' }`
- If entry succeeds but order fails: both rolled back (no orphaned entry)
- Returns `{ entered: false, reason: 'ALREADY_ENTERED' }` if window already taken
- **Rollback recovery procedure** (if reverting to in-memory safeguards):
  1. Before deploying old code: export `window_entries` to JSON backup
  2. On startup, old code must load `window_entries` into in-memory Set
  3. Add one-time migration: `initializeFromDatabase()` populates Set from table
  4. After stable rollback: `TRUNCATE window_entries` to clean state
  - This prevents duplicate trades during/after rollback

**Task 2.2: Position-Manager State Consolidation**
- Remove in-memory position cache
- All reads query SQLite directly
- `getOpenPositions()` → `SELECT * FROM positions WHERE status = 'open'`

**Task 2.3: Stop-Loss Direct DB Access**
- Remove dependency on position-manager.getPositions() memory
- Query SQLite directly for open positions
- Add verification step (see Phase 3)

**Task 2.4: Take-Profit Direct DB Access**
- Same pattern as stop-loss

### Phase 3: Verify-Before-Act + Circuit Breaker

**Task 3.1: Polymarket Client - Add getPositions()**
- New function calling Data API: `GET https://data-api.polymarket.com/positions`
- Parameter: wallet address from config
- Returns: array of position objects

**Task 3.2: Circuit Breaker Module**
- New module: `src/modules/circuit-breaker/`
- States: `CLOSED` (normal), `OPEN` (halted)
- Methods: `trip(reason, context)`, `isOpen()`, `getState()`, `reset(operatorId, reason)` (manual only)
- When OPEN: all order placement blocked
- **Add to `src/types/errors.js` CircuitBreakerReasons enum:**
  ```javascript
  const CircuitBreakerReasons = {
    STOP_LOSS_BLIND: 'STOP_LOSS_BLIND',           // Exchange has positions, local doesn't
    TAKE_PROFIT_BLIND: 'TAKE_PROFIT_BLIND',       // Same for TP
    POSITION_TRACKING_FAILED: 'POSITION_TRACKING_FAILED', // API ok, local write failed
    VERIFICATION_RATE_LIMITED: 'VERIFICATION_RATE_LIMITED', // 429 + stale cache
    DATA_CAPTURE_UNRECOVERABLE: 'DATA_CAPTURE_UNRECOVERABLE', // Batch backup failed
    SERIALIZATION_CONFLICT: 'SERIALIZATION_CONFLICT', // Repeated 40001 errors
    MANUAL_TRIP: 'MANUAL_TRIP',                   // Operator triggered
  };
  ```
- **Uses dedicated connection pool** (separate from main pool)
- **On pool exhaustion or timeout: assume OPEN** (fail closed)
- Circuit breaker check is FIRST operation, with 1 second timeout
- State stored in PostgreSQL `circuit_breaker` table
- **Reset safety**: `reset()` blocked if any active orders exist (status: open/partially_filled)
- Reset requires operator ID and reason for audit trail
- **Automated escalation** (when OPEN):
  - 0-5 min: Log ERROR every 30s, continue monitoring
  - 5-15 min: Log CRITICAL, send alert (webhook/PagerDuty if configured)
  - 15-30 min: Attempt to cancel all open orders (safe shutdown prep)
  - 30+ min: **Graceful shutdown** - cancel orders, log final state, exit process
  - Railway will restart container in PAPER mode (safe default)
- **Escalation bypass**: If `CB_ALLOW_EXTENDED_HALT=true` env var set, skip auto-shutdown (for debugging)

**Task 3.3: Stop-Loss Verification**
- Before evaluating, query exchange positions via `polymarket.getPositions()`
- If exchange has positions but local has none → `circuitBreaker.trip('STOP_LOSS_BLIND')`
- Only evaluate if verification passes
- **Rate limit handling**:
  - HTTP 429 = rate limited, HTTP 503 = service unavailable (treat same)
  - Parse `Retry-After` header if present (seconds or HTTP-date)
  - Cache last successful verification for 30 seconds
  - If rate limited and cache < 30s old: use cached data with WARNING log
  - If rate limited and cache > 30s old: trip circuit breaker (`VERIFICATION_RATE_LIMITED`)
  - **Expected limits**: Data API ~100 req/min (unauthed), monitor actual usage
- **Orphan detection**: If local count > exchange count, log ERROR but don't halt
  - Possible causes: exchange latency, position just closed, data inconsistency
  - Flag for manual investigation

**Task 3.3.1: Shared PositionVerifier Module**
- Extract verification logic into `src/modules/position-verifier/index.js`
- Both stop-loss and take-profit call `positionVerifier.verify()`
- Single implementation of rate limit cache, divergence detection, CB integration
- Prevents duplicate code and divergent bug fixes
- **PAPER mode handling**:
  - In PAPER mode, exchange has no real positions
  - `verify()` skips exchange call, returns `{ verified: true, mode: 'PAPER', skipped: true }`
  - Log WARNING: "Exchange verification skipped in PAPER mode"
  - All other verification logic (local DB checks) still runs
  - This maintains Paper=Live parity for local state while acknowledging exchange difference

**Task 3.4: Take-Profit Verification**
- Uses shared `positionVerifier.verify()` from Task 3.3.1

**Task 3.5: Order Placement Halt-on-Uncertainty**
- If API succeeds but local position recording fails → `circuitBreaker.trip('POSITION_TRACKING_FAILED')`
- Return `{ outcome: 'UNKNOWN' }` - never continue silently

**Task 3.6: Health Check Endpoint**
- Implement `GET /health` endpoint for Railway health checks
- Returns HTTP 200 only if ALL conditions pass:
  - PostgreSQL main pool has ≥1 available connection
  - PostgreSQL CB pool has ≥1 available connection
  - Circuit breaker state is CLOSED
  - Primary price feed (Binance) received data within 30s
- Returns HTTP 503 with JSON body if any condition fails:
  ```json
  { "healthy": false, "checks": { "db_main": true, "db_cb": true, "circuit_breaker": false, "binance_feed": true } }
  ```
- **Railway integration** - update these files:
  ```json
  // railway.json
  { "healthcheckPath": "/health", "healthcheckTimeout": 5 }
  ```
  ```dockerfile
  # Dockerfile - update HEALTHCHECK
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
  ```
- Health check must respond within 5 seconds (Railway timeout)

**Task 3.7: Alert Integration**
- Implement alerting for circuit breaker escalation events
- **Configuration via env vars**:
  - `ALERT_WEBHOOK_URL` - HTTP POST endpoint for alerts (optional)
  - `ALERT_PAGERDUTY_KEY` - PagerDuty integration key (optional)
- If no alert config: log CRITICAL but continue escalation timeline
- **Alert payload**:
  ```json
  { "event": "circuit_breaker_escalation", "stage": "5min|15min|30min",
    "reason": "STOP_LOSS_BLIND", "timestamp": "ISO8601", "trading_mode": "LIVE" }
  ```
- Alerts sent async (don't block escalation timer)
- Test: `npm run test:alerts` sends test alert to configured endpoint

### Phase 4: Paper/Live Parity

**Task 4.1: Mock Executor for Paper Mode**
- In `polymarket/index.js`: if `TRADING_MODE === 'PAPER'`, use mock executor
- Mock executor simulates fill at current market price
- Returns same shape as real executor
- **Strict mode validation**:
  - TRADING_MODE must be exactly 'PAPER' or 'LIVE' (case-insensitive, trimmed)
  - Invalid value = startup failure (not silent default)
  - Missing value = default to PAPER with warning log
- **LIVE mode confirmation**: Requires `CONFIRM_LIVE_TRADING=true` env var
  - **Strict parsing**: Only exact string `"true"` (case-insensitive) is accepted
  - `"false"`, `"0"`, `""`, `"1"`, `"yes"` = NOT valid (startup failure)
  - Prevents accidental LIVE deployment via boolean coercion bugs
  - LIVE without confirmation = startup failure with clear error message
- **Mode is immutable**: Set once at startup, never re-read
  - Prevents mid-session mode changes from env reload

**Task 4.2: Verify Same State Flow**
- Paper mode must: record position in PostgreSQL, update safeguards, be visible to SL/TP
- Integration test: run same signal in PAPER, verify state changes

### Phase 5: Data Capture Infrastructure

**Task 5.1: Multi-Feed Price Collector**
- Subscribe to price feeds (initial release):
  - Binance WebSocket (direct) - PRIMARY
  - Polymarket's Binance feed (via RTDS)
  - Chainlink (via RTDS or direct)
  - ~~Pyth Network~~ - **DEFERRED to Phase 6** (requires Hermes API integration, different pull model)
- Write to `price_ticks` table with batching (every 500ms or 100 ticks)
- **Feed health monitoring**:
  - Track last tick timestamp per feed
  - Stale thresholds: Binance 5s, Chainlink 60s, Polymarket 10s
  - (Pyth threshold TBD when integrated)
  - Log warning when any feed goes stale
  - **If Binance (primary) stale > 5s: halt new trading signals**
- Auto-reconnect on WebSocket disconnect with exponential backoff
- **Batch failure recovery**:
  - On batch insert failure: retry once with 100ms delay
  - If retry fails: write batch to `failed_batches` table (NOT filesystem - Railway is ephemeral)
  ```sql
  CREATE TABLE failed_batches (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    batch_data JSONB NOT NULL,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    replayed_at TIMESTAMPTZ
  );
  ```
  - Max in-memory batch queue: 1000 ticks (prevent OOM)
  - If queue full: drop oldest batch with ERROR log
  - **If failed_batches INSERT also fails**: trip circuit breaker (`DATA_CAPTURE_UNRECOVERABLE`)
  - Replay mechanism: `npm run data:replay-batches` queries failed_batches WHERE replayed_at IS NULL
  - Auto-cleanup: DELETE FROM failed_batches WHERE replayed_at < NOW() - INTERVAL '7 days'

**Task 5.2: Order Book Snapshot Collector**
- Every 1-5 seconds, snapshot order book for active markets
- Write to `order_book_snapshots`
- Calculate depth at various price levels

**Task 5.3: Oracle Update Detector**
- Detect when Chainlink/Pyth prices change
- Write to `oracle_updates` with time since last update
- Emit event for downstream consumers

**Task 5.4: Feed Divergence Detector**
- Compare all feeds in real-time
- When divergence exceeds threshold, write to `feed_divergence_events`
- Track if/when convergence occurs

**Task 5.5: Window Close Event Recorder**
- **Start capture 90 seconds before close** (buffer for timer drift)
- Record all prices at 60s, 30s, 10s, 5s, 1s before close
- Max sample rate: 10 samples/second (prevent system overload)
- After resolution, record outcome and detect "surprise" resolutions
- **Resolution capture with retry**:
  - First attempt 1s after close
  - Retry every 10s for up to 60s if resolution not available
  - Log error if resolution never captured
- "Surprise" threshold: only flag if market consensus > 95%
- Write complete event to `window_close_events` (UNIQUE on window_id)

**Task 5.6: Data Quality Monitor**
- Create `npm run data:check-gaps` script to verify no gaps > 1 minute
- Query:
  ```sql
  SELECT symbol, source, timestamp,
         timestamp - LAG(timestamp) OVER (PARTITION BY symbol, source ORDER BY timestamp) AS gap
  FROM price_ticks
  WHERE timestamp > NOW() - INTERVAL '24 hours'
  HAVING gap > INTERVAL '1 minute';
  ```
- Expose via `/health` as `data_gaps: true/false`
- If gaps detected: log WARNING with gap details
- Used for Stage 3 exit criteria verification

**Task 5.7: Partition Management**
- **Implementation: node-cron** (not pg_cron - Railway doesn't expose it reliably)
- Schedule: Run at startup + daily at 00:05 UTC
- **Partition creation** (create 7 days ahead):
  ```sql
  CREATE TABLE IF NOT EXISTS price_ticks_20260210
  PARTITION OF price_ticks
  FOR VALUES FROM ('2026-02-10') TO ('2026-02-11');
  ```
- **Partition cleanup** (drop partitions > 7 days old):
  ```sql
  DROP TABLE IF EXISTS price_ticks_20260203;
  ```
- **Failure handling**:
  - If partition creation fails: log CRITICAL, continue (inserts will fail but won't crash)
  - If partition exists: no-op (idempotent)
  - If cleanup fails: log ERROR, continue (storage grows but system works)
- Add npm script: `npm run db:manage-partitions` for manual run
- Design for future: config option to extend retention (default: 7 days)

**Task 5.7: Edge 2 Validation (Data-First Approach)**

**CRITICAL: Do NOT implement Edge 2 trading until data validates the edge exists.**

```
Phase A: Data Collection (2+ weeks)
├─ Capture ALL window_close_events
├─ No trading, only observation
└─ Build dataset of 500+ window closes

Phase B: Analysis
├─ When exactly does oracle sample? (oracle_resolution_time vs window_close_time)
├─ Which feed matches resolution? (compare all feeds to resolved price)
├─ Is there predictable lag? (market vs oracle at close)
├─ How often do "surprises" occur? (market consensus wrong)
└─ OUTPUT: Report with statistical significance

Phase C: Strategy Decision
├─ IF edge exists AND is statistically significant:
│   └─ Implement Edge 2 with strict limits (see below)
├─ IF edge is marginal or inconsistent:
│   └─ Continue data collection, do not trade
└─ IF no edge:
    └─ Archive Edge 2, focus on Edge 1 (lag arbitrage)
```

**Task 5.8: Edge 2 Risk Limits (If Implemented)**

```javascript
const RESOLUTION_EDGE_LIMITS = {
  maxPositionSize: 50,         // Max $50 per trade (limits visibility)
  maxDailyTrades: 3,           // Don't be statistically obvious
  minConfidence: 0.85,         // Only high-conviction signals
  cooldownAfterWinMs: 3600000, // 1 hour cooldown after win
  minWinRateThreshold: 0.60,   // Kill switch if win rate drops below 60%
  maxConsecutiveLosses: 3,     // Pause after 3 losses in a row
};
```

- All limits enforced before order placement
- Performance tracked in `resolution_edge_performance` table
- Weekly review: if win rate < 60% over 20+ trades, disable Edge 2
- Goal: sustainable edge extraction, not maximum short-term profit

### Phase 6: Future Enhancements (Deferred)

**Note:** These tasks are documented but NOT part of the initial V3 release. They depend on data collected in Phase 5.

**Task 6.1: Pyth Network Integration**
- Integrate Pyth price feeds via Hermes API
- Pyth uses pull model (different from Binance push)
- Requires: `@pythnetwork/hermes-client` SDK
- Add to feed health monitoring once integrated

**Task 6.2: Edge 2 Strategy Implementation**
- Only implement after Phase 5 data validates the edge (500+ window closes)
- Requires statistical analysis report with p < 0.05
- If edge not validated: archive this task

**Task 6.3: Advanced Alerting (PagerDuty/Slack)**
- Richer alert routing rules
- Escalation policies
- On-call schedules
- Depends on basic webhook alerting (Task 3.7) working first

### Phase 7: Integration Tests

**Task 7.1: Position Visibility Test**
```
GIVEN position-manager records a position
WHEN stop-loss evaluates
THEN stop-loss sees that position
```

**Task 7.2: Race Condition Test**
```
GIVEN a signal for window W
WHEN two concurrent calls try to enter
THEN exactly one succeeds
AND exactly one order placed
```

**Task 7.3: Failure Cascade Test**
```
GIVEN successful API order
WHEN local recording fails
THEN circuit breaker trips
AND no further orders placed
```

**Task 7.4: Verification Blindness Test**
```
GIVEN exchange has positions
WHEN local DB has none (simulated divergence)
THEN stop-loss trips circuit breaker
AND does NOT evaluate empty list silently
```

**Task 7.5: Full Flow Test**
```
GIVEN system in clean state
WHEN signal received → order placed → position opened → price drops → stop-loss triggers
THEN entire flow completes correctly
AND all state consistent
```

**Task 7.6: Data Capture Test**
```
GIVEN all price feeds connected
WHEN window approaches close
THEN price_ticks contains data from all feeds
AND window_close_events is populated correctly
AND feed_divergence_events captures any divergences
```

### Phase 8: Staged Deployment Pipeline

**Deployment is NOT a single step. Each stage has gates that must pass.**

#### Stage Dependency Tree

```
                                    ┌─────────────────────────┐
                                    │   GOAL: LIVE Trading    │
                                    │   with V3 Guarantees    │
                                    └───────────┬─────────────┘
                                                │
                                    ┌───────────▼───────────┐
                                    │      STAGE 7: LIVE    │
                                    │   Manual Approval     │
                                    └───────────┬───────────┘
                                                │
                                    REQUIRES ALL:
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                   Stage 6         Stage 5         Stage 4
                 Paper Flow     Circuit Breaker   Single Book
                  (48 hrs)      + Verification    + Atomicity
                        │               │               │
                        └───────┬───────┴───────┬───────┘
                                │               │
                                ▼               ▼
                            Stage 3         Stage 2
                          Data Capture    PostgreSQL
                           (24 hrs)       Foundation
                                │               │
                                └───────┬───────┘
                                        ▼
                                    Stage 1
                                 Environment
                                   Parity
                                        │
                                        ▼
                                    Stage 0
                                    Config
                                Consolidation
```

**Parallelization:** Stages 3, 4, 5 can run in parallel after Stage 2.

---

#### Stage 0: Config Consolidation

**Goal:** Single config file, environment-only differences

**Actions:**
- Create `config/index.js` (unified)
- Delete `config/default.js`, `config/development.js`, `config/production.js`
- Add TRADING_MODE validation (PAPER/LIVE only)
- Add CONFIRM_LIVE_TRADING requirement for LIVE
- Add DATABASE_URL env var handling

**Exit Criteria:**
- [ ] Single config file exists
- [ ] `npm test` passes with unified config
- [ ] TRADING_MODE defaults to PAPER
- [ ] LIVE without CONFIRM_LIVE_TRADING fails startup

**Rollback:** Restore old config files from git

---

#### Stage 1: Environment Parity

**Goal:** Same Docker image runs identically everywhere

**Preconditions:** Stage 0 complete

**Actions:**
- Update Dockerfile (if needed)
- Build Docker image with SHA tag
- Run tests inside container locally
- Run same tests in CI with same image

**Exit Criteria:**
- [ ] `docker build -t poly:$SHA .` succeeds
- [ ] `docker run poly:$SHA npm test` passes locally
- [ ] Same command passes in GitHub Actions
- [ ] No `if (process.env.NODE_ENV)` in codebase

**Rollback:** Previous Dockerfile from git

---

#### Stage 2: PostgreSQL Foundation

**Goal:** PostgreSQL as Single Book, data persists across deploys

**Preconditions:** Stage 1 complete, Railway PostgreSQL provisioned

**Actions:**
- Provision Railway PostgreSQL
- Replace better-sqlite3 with pg
- Implement connection pooling (main + circuit breaker pools)
- Implement startup guard (fail if no DB)
- Implement query timeout (5s) and retry
- Run migrations with version tracking
- Add position_counters with CHECK constraints

**Exit Criteria:**
- [ ] `DATABASE_URL` connects to Railway PostgreSQL
- [ ] All existing tests pass with PostgreSQL
- [ ] Insert position → restart container → position still exists
- [ ] Startup fails if DATABASE_URL invalid/unreachable
- [ ] **Data API accessible**: `curl https://data-api.polymarket.com/positions?user=0xYOUR_WALLET` returns valid JSON

**Rollback:** Keep SQLite code on branch until Stage 3 validated

**Note:** Data API check validates external dependency early - Stages 3/4/5 all need this API.

**GATE: Do not proceed until data persistence verified on Railway**

---

#### Stage 3: Data Capture Running

**Goal:** Price feeds, window close events populating

**Preconditions:** Stage 2 complete

**Actions:**
- Create partitioned tables (price_ticks, etc.)
- Implement multi-feed collector with health monitoring
- Implement window close event recorder
- Deploy to Railway
- Monitor for 24 hours

**Exit Criteria:**
- [ ] price_ticks shows data from all feeds
- [ ] window_close_events capturing closes
- [ ] Feed health monitoring working
- [ ] 24 hours continuous data with no gaps > 1 minute

**Rollback:** Disable data capture module

**GATE: 24 hours of clean data capture before proceeding**

---

#### Stage 4: Single Book + Atomic Safeguards

**Goal:** No in-memory state, all operations atomic

**Preconditions:** Stage 2 complete

**Actions:**
- Remove in-memory Set from safeguards.js
- Implement tryEnterWindowAndPlaceOrder() with transaction
- Remove in-memory position cache
- Update stop-loss/take-profit to query PostgreSQL directly
- Write and run race condition test

**Exit Criteria:**
- [ ] No in-memory state tracking in safeguards
- [ ] Race condition test: 100 concurrent entries → exactly 1 succeeds
- [ ] Stop-loss sees positions immediately after creation

**Rollback:** Restore in-memory safeguards (less safe, but functional)

---

#### Stage 5: Circuit Breaker + Verify-Before-Act

**Goal:** System halts on uncertainty, never trades blind

**Preconditions:** Stage 2 complete, Polymarket Data API accessible

**Actions:**
- Create circuit-breaker module with dedicated pool
- Implement trip(), isOpen(), reset() with audit trail
- Add reset safety (blocked if active orders)
- Implement polymarket.getPositions()
- Add verification to stop-loss and take-profit

**Exit Criteria:**
- [ ] Circuit breaker module exists and tested
- [ ] Exchange positions + empty local → CB trips
- [ ] Reset with active orders → error thrown
- [ ] Pool exhaustion → trading halted

**Rollback:** Remove CB checks (risky, last resort)

---

#### Stage 6: Paper Mode Full Flow

**Goal:** Complete trading cycle works in PAPER mode

**Preconditions:** Stages 4 and 5 complete

**Actions:**
- Implement mock executor for PAPER mode
- Verify PAPER records real positions in PostgreSQL
- Run full flow: signal → order → position → SL trigger
- Deploy to Railway in PAPER mode
- Monitor for 48 hours

**Exit Criteria:**
- [ ] PAPER mode creates real positions in DB
- [ ] Stop-loss evaluates and closes PAPER positions
- [ ] Safeguards prevent duplicate PAPER trades
- [ ] 48 hours of PAPER trading with no errors
- [ ] Manual review of all trades looks correct

**Rollback:** Revert to previous implementation

**GATE: 48 hours of clean PAPER trading before LIVE**

---

#### Stage 7: LIVE (Human Approved)

**Goal:** Real money trading with all guarantees

**Preconditions:** ALL previous stages complete

**Actions:**
- Set TRADING_MODE=LIVE, CONFIRM_LIVE_TRADING=true
- Require manual approval in GitHub
- Deploy with $10 max position size
- Human actively monitors first 2 hours
- Kill switch tested and armed

**Exit Criteria:**
- [ ] GitHub approval received
- [ ] LIVE trade executes successfully
- [ ] Position in both local DB and Polymarket
- [ ] No unexpected behavior for 24 hours

**Rollback:**
- Immediate: Set TRADING_MODE=PAPER
- If positions exist: Manual close via Polymarket UI
- Circuit breaker trip for automated rollback

---

#### Rollback Decision Tree

```
Problem detected at Stage N:

├─ Is trading LIVE?
│   ├─ YES: Trip circuit breaker FIRST, then investigate
│   └─ NO: Safe to investigate without time pressure
│
├─ Does problem affect earlier stages?
│   ├─ Stage N only: Rollback Stage N, earlier stages stay
│   └─ Affects earlier: Rollback to last known-good stage
│
├─ Is there data loss risk?
│   ├─ YES: Preserve PostgreSQL data, only rollback code
│   └─ NO: Full rollback safe
│
└─ Can we fix forward?
    ├─ YES + Low risk: Fix and redeploy
    └─ NO or High risk: Rollback first, fix safely
```

---

#### Time Estimates (Conservative)

| Stage | Duration | Notes |
|-------|----------|-------|
| Stage 0 | 2-4 hours | Config refactoring |
| Stage 1 | 2-4 hours | Docker verification |
| Stage 2 | 1-2 days | PostgreSQL migration (most complex) |
| Stage 3 | 1 day + **24hr gate** | Data capture + monitoring |
| Stage 4 | 4-8 hours | Atomic safeguards |
| Stage 5 | 4-8 hours | Circuit breaker + verification |
| Stage 6 | 4 hours + **48hr gate** | Paper mode full flow |
| Stage 7 | 1 hour + ongoing | LIVE deployment |

**Total: ~5-7 days minimum** (including mandatory time gates)

---

**Task 8.1: CI/CD Pipeline with Stage Gates**
- GitHub Actions workflow with stage dependencies
- Each stage requires previous stage to pass
- `environment: production` requires manual approval
- Automated tests for Stages 0-5
- Duration gates enforced: Stage 3 (24hr), Stage 6 (48hr)

**Task 8.2: Rollback Safety**
- Additive-only migrations for 7-day rollback window
- Previous Docker image tagged and retained
- Rollback procedure documented and tested
- SQLite branch preserved until Stage 3 validated

---

## Acceptance Criteria (Given/When/Then)

### AC0: PostgreSQL Migration

- [ ] **AC0.1** Given DATABASE_URL is set, when system starts, then it connects to Railway PostgreSQL
- [ ] **AC0.2** Given DATABASE_URL is invalid, when system starts, then it exits with fatal error after 3 retries
- [ ] **AC0.3** Given persistence.run() is called, when query succeeds, then same result format as SQLite
- [ ] **AC0.4** Given a query runs > 5 seconds, when timeout triggers, then query is cancelled and error thrown
- [ ] **AC0.5** Given connection error (ECONNRESET), when query fails, then retry with exponential backoff (max 2)
- [ ] **AC0.6** Given position_counters.open_count = 5, when opening new position, then CHECK constraint rejects
- [ ] **AC0.7** Given code version < DB schema version, when system starts, then it refuses to run
- [ ] **AC0.8** Given DATABASE_URL without `sslmode=require`, when TRADING_MODE=LIVE, then startup fails
- [ ] **AC0.9** Given DATABASE_URL in error message, when logged, then connection string is redacted
- [ ] **AC0.10** Given migration with `down` script, when `npm run migrate:down` runs, then schema reverts correctly
- [ ] **AC0.11** Given two concurrent position opens, when both try to increment open_count, then only one succeeds (no race)
- [ ] **AC0.12** Given write-ahead intent created, when process crashes and restarts, then incomplete intent detected

### AC1: Config Consolidation

- [ ] **AC1.1** Given only config/index.js exists, when `npm test` runs, then all tests pass
- [ ] **AC1.2** Given TRADING_MODE=PAPER, when system starts, then mock executor is used
- [ ] **AC1.3** Given TRADING_MODE=LIVE without CONFIRM_LIVE_TRADING=true, when system starts, then it exits with error
- [ ] **AC1.4** Given Docker image built locally, when same image runs on Railway, then behavior is identical

### AC2: Single Book

- [ ] **AC2.1** Given safeguards.js code, when inspected, then no in-memory Set for entry tracking
- [ ] **AC2.2** Given window_id + strategy_id already entered, when second entry attempted, then UNIQUE constraint rejects
- [ ] **AC2.3** Given entry INSERT succeeds but order placement fails, when transaction completes, then both are rolled back
- [ ] **AC2.4** Given position created, when stop-loss queries positions, then it queries PostgreSQL directly
- [ ] **AC2.5** Given position created, when take-profit queries positions, then it queries PostgreSQL directly
- [ ] **AC2.6** Given two concurrent tryEnterWindow() calls, when serialization conflict (40001), then one retries and returns SERIALIZATION_CONFLICT

### AC3: Verify Before Act

- [ ] **AC3.1** Given Polymarket has 2 positions and local DB has 0, when stop-loss evaluates, then circuit breaker trips
- [ ] **AC3.2** Given verification API returns 429, when cache is < 30s old, then cached data used with warning
- [ ] **AC3.3** Given verification API returns 429, when cache is > 30s old, then circuit breaker trips
- [ ] **AC3.4** Given local has 3 positions and exchange has 2, when verification runs, then ERROR logged (no halt)
- [ ] **AC3.5** Given TRADING_MODE=PAPER, when verification runs, then exchange check skipped with WARNING log
- [ ] **AC3.6** Given getPositions() called, when Data API returns 200, then array of {conditionId, size, avgPrice} returned
- [ ] **AC3.7** Given getPositions() called, when Data API returns 500, then error thrown (not empty array)

### AC4: Circuit Breaker

- [ ] **AC4.1** Given circuit breaker is OPEN, when order placement attempted, then order is blocked
- [ ] **AC4.2** Given circuit breaker is OPEN, when reset() called without operatorId, then error thrown
- [ ] **AC4.3** Given active orders exist (status: open), when reset() called, then reset blocked
- [ ] **AC4.4** Given dedicated pool timeout (1s), when CB check fails, then assume OPEN (fail closed)
- [ ] **AC4.5** Given circuit breaker OPEN for 30+ minutes, when escalation timer fires, then graceful shutdown initiated
- [ ] **AC4.6** Given `GET /health` called, when CB is OPEN, then HTTP 503 returned with `circuit_breaker: false`
- [ ] **AC4.7** Given `GET /health` called, when all checks pass, then HTTP 200 returned within 5 seconds
- [ ] **AC4.8** Given ALERT_WEBHOOK_URL is set, when CB escalates past 5min, then HTTP POST sent to webhook
- [ ] **AC4.9** Given CB OPEN 30+ min AND open orders exist, when shutdown initiated, then cancelAll() called before exit

### AC5: Halt on Uncertainty

- [ ] **AC5.1** Given API order succeeds, when local position recording fails, then outcome = 'UNKNOWN' returned
- [ ] **AC5.2** Given outcome = 'UNKNOWN', when order placement returns, then circuit breaker is tripped
- [ ] **AC5.3** Given any UNKNOWN state, when code path inspected, then no "log and continue" pattern exists

### AC6: Paper/Live Parity

- [ ] **AC6.1** Given TRADING_MODE=PAPER, when signal triggers order, then position recorded in PostgreSQL
- [ ] **AC6.2** Given PAPER position exists, when price drops below stop-loss, then SL triggers close
- [ ] **AC6.3** Given PAPER mode, when same window_id entered twice, then second entry blocked by safeguards
- [ ] **AC6.4** Given TRADING_MODE set at startup, when process.env.TRADING_MODE changes, then mode unchanged

### AC7: Data Capture Infrastructure

- [ ] **AC7.1** Given Binance WebSocket connected, when tick received, then row inserted in price_ticks
- [ ] **AC7.2** Given Chainlink price changes, when oracle_updates queried, then change is recorded
- [ ] **AC7.3** Given Binance feed stale > 5s, when new signal generated, then signal is blocked
- [ ] **AC7.4** Given window closes in 90s, when capture starts, then prices recorded at 60s, 30s, 10s, 5s, 1s
- [ ] **AC7.5** Given resolution not available at close, when 60s passes, then retries recorded in logs
- [ ] **AC7.6** Given partition cron runs, when executed, then partitions for next 7 days exist
- [ ] **AC7.7** Given partition older than 7 days, when cleanup runs, then partition dropped and storage reclaimed
- [ ] **AC7.8** Given batch insert fails, when retry fails, then batch logged to backup file with ERROR
- [ ] **AC7.9** Given backup file write fails, when batch cannot be persisted, then CB trips with DATA_CAPTURE_UNRECOVERABLE
- [ ] **AC7.10** Given failed_batches table has unprocessed rows, when `npm run data:replay-batches` runs, then batches re-inserted

### AC8: Integration Tests

- [ ] **AC8.1** Given position-visibility.test.js runs, when complete, then all assertions pass
- [ ] **AC8.2** Given 100 concurrent entry attempts, when race-condition.test.js runs, then exactly 1 succeeds
- [ ] **AC8.3** Given failure-cascade.test.js simulates API success + local fail, then CB trips
- [ ] **AC8.4** Given verification-blindness.test.js simulates divergence, then CB trips (not silent eval)
- [ ] **AC8.5** Given full-flow.test.js runs end-to-end, then signal → order → position → SL all consistent

### AC9: Staged Deployment Pipeline

- [ ] **AC9.1** Given Stage 0 incomplete, when Stage 1 attempted, then blocked by dependency
- [ ] **AC9.2** Given Stage 3 < 24 hours, when Stage 4 attempted, then blocked by time gate
- [ ] **AC9.3** Given Stage 6 < 48 hours, when Stage 7 attempted, then blocked by time gate
- [ ] **AC9.4** Given Stage 7 triggered, when no manual approval, then deployment blocked

### AC10: Edge 2 Validation (Data-First)

- [ ] **AC10.1** Given < 2 weeks of window_close_events data, when Edge 2 enabled, then system refuses
- [ ] **AC10.2** Given Edge 2 win rate < 60% over 20 trades, when next signal generated, then Edge 2 disabled
- [ ] **AC10.3** Given Edge 2 enabled, when position size > $50, then order rejected

---

## Testing Strategy

### Unit Tests (per module)

| Module | Test File | Key Scenarios |
|--------|-----------|---------------|
| persistence | `src/persistence/__tests__/database.test.js` | Connection, pooling, query timeout, retry, SSL validation |
| safeguards | `src/modules/position-manager/__tests__/safeguards.test.js` | Atomic entry, UNIQUE violation, transaction rollback, serialization |
| circuit-breaker | `src/modules/circuit-breaker/__tests__/index.test.js` | trip(), isOpen(), reset() with audit, escalation timer |
| position-verifier | `src/modules/position-verifier/__tests__/index.test.js` | Rate limit cache, divergence detection, shared verification |
| stop-loss | `src/modules/stop-loss/__tests__/index.test.js` | DB query, uses position-verifier, CB integration |
| take-profit | `src/modules/take-profit/__tests__/index.test.js` | DB query, uses position-verifier, CB integration |
| polymarket | `src/clients/polymarket/__tests__/index.test.js` | getPositions(), mock executor |
| health | `src/routes/__tests__/health.test.js` | All checks pass/fail scenarios, timeout handling |

### Integration Tests

| Test File | Scenario | Modules Involved |
|-----------|----------|------------------|
| `__tests__/integration/position-visibility.test.js` | PM creates position → SL sees it | position-manager, stop-loss, persistence |
| `__tests__/integration/race-condition.test.js` | 100 concurrent entries → 1 wins | safeguards, persistence |
| `__tests__/integration/failure-cascade.test.js` | API success + local fail → CB trips | order-manager, circuit-breaker |
| `__tests__/integration/verification-blindness.test.js` | Exchange > local → CB trips | stop-loss, polymarket, circuit-breaker |
| `__tests__/integration/full-flow.test.js` | Signal → Order → Position → SL | All modules |
| `__tests__/integration/paper-live-parity.test.js` | Same signal, same state in both modes | config, polymarket, position-manager |
| `__tests__/integration/data-capture.test.js` | All feeds → tables populated | data-capture, persistence |

### Manual Testing Steps (Pre-LIVE)

1. **Local PostgreSQL Test**
   - Start local PostgreSQL container
   - Run full test suite: `npm test`
   - Verify all tests pass

2. **Railway PostgreSQL Test**
   - Deploy to Railway staging
   - Insert position via PAPER trade
   - Restart container
   - Verify position persists

3. **Circuit Breaker Test**
   - Manually trip CB via API/script
   - Attempt order placement → verify blocked
   - Reset CB with operator ID
   - Verify order placement works

4. **48-Hour Paper Mode Burn-in**
   - Deploy PAPER mode to Railway
   - Monitor for 48 hours
   - Review all trades for correctness
   - Check no unexpected errors in logs

---

## Dependencies

**Infrastructure:**
- Railway PostgreSQL (managed)
- Railway deployment (existing)

**APIs:**
- Polymarket Data API (verified available, no auth required)
- Polymarket CLOB API (existing)
- Binance WebSocket (existing via RTDS)
- Chainlink price feeds (existing via RTDS)
- Pyth Network (new - needs integration)

**NPM Packages (New):**
- `pg` - PostgreSQL client for Node.js
- `pg-pool` - Connection pooling

## Risks

| Risk | Mitigation |
|------|------------|
| Data API eventual consistency | Use CLOB `getTrades()` for immediate verification, Data API for periodic reconciliation |
| Performance impact of DB-only reads | Accept slower for correct. Profile later if needed. PostgreSQL is faster than SQLite for concurrent access. |
| Breaking existing behavior | Comprehensive integration tests before deploy |
| PostgreSQL connection issues | Connection pooling, auto-reconnect, health checks |
| High data volume (price_ticks) | Partitioning by day, 7-day retention, batch inserts |
| Pyth integration complexity | Start with Chainlink-only, add Pyth as enhancement |

## Notes

- This is foundational work. No new features until this is solid.
- Every change must pass the V3 Philosophy checklist (see docs/v3philosophy.md)
- Manual circuit breaker reset is intentional - we want human verification before resuming
- Data capture enables two distinct edges:
  - **Edge 1: Multi-Feed Latency** - Detect moves on fast feeds before slow feeds react
  - **Edge 2: Window Close Resolution** - Predict oracle resolution in final seconds of window
- 7-day raw data retention for now; design supports future extension to months
