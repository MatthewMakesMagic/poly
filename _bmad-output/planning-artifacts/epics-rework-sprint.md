---
status: complete
completedAt: '2026-03-15'
inputDocuments:
  - prd-quant-factory.md
  - architecture-quant-factory.md
  - performance-optimization-report.md
  - trade-audit-report.md
  - review-quant-final.md
  - review-architecture-addendum.md
  - epics-quant-factory.md
project_name: 'poly'
user_name: 'Matthew'
date: '2026-03-15'
---

# poly — Quant Factory Rework Sprint

## Overview

This document scopes a focused rework sprint to address 7 critical issues identified during the Quant Factory review cycle. The trade audit report revealed that the PG backtest path does not load L2 book data (all 30 fills used bestAsk fallback), the performance report showed 50-window backtests taking ~60s on Railway (target: <500ms), and the quant review flagged incorrect Sharpe annualization. Additional data collection gaps (gamma resolution stopped Feb 27, SOL/XRP L2 recording disabled) compound the problem.

These fixes are grouped into three epics that can be partially parallelized. The critical path runs through Epic 10 (data pipeline), while Epic 11 (data collection) and Epic 12 (metrics) can execute concurrently.

## Testing Philosophy

Same as the main Quant Factory epics document. Every story satisfies three testing levels:

1. **Unit tests** -- module works in isolation
2. **Integration tests** -- module works with its dependencies
3. **Regression gate** -- all previously passing tests still pass

Agent-interpretable test failures explain what broke, why, and what to do about it.

## Dependency Diagram

```
                    +------------------+
                    | Fix 4: SOL/XRP   |
                    | (config change)  |     +------------------+
                    | INDEPENDENT      |     | Fix 3: Gamma     |
                    +------------------+     | Backfill         |
                           |                 | INDEPENDENT      |
                           | deploys         +------------------+
                           | immediately            |
                           v                        | runs any time
                    L2 data resumes                 v
                                            gamma data resumes

  +------------------+     +------------------+     +------------------+
  | Fix 7: Concurrent|     | Fix 2: L2 Data   |     | Fix 6: Sharpe    |
  | PG Queries       |     | Loader           |     | Annualization    |
  | INDEPENDENT      |     | INDEPENDENT      |     | INDEPENDENT      |
  +------------------+     +------------------+     +------------------+
          |                        |                        |
          | ~10x speedup          | L2 in PG path          | correct metrics
          v                        v                        v
  +------------------+     +------------------+     +------------------+
  | Fix 1: PG Cache  |     | Fix 5: Verify    |     |                  |
  | (depends on 2)   |     | Sweep Bug Fix    |     |                  |
  | ~100x speedup    |     | (depends on 2+7) |     |                  |
  +------------------+     +------------------+     +------------------+
          |                        |
          +------------------------+
                    |
                    v
           REWORK COMPLETE
```

### Build Order (Critical Path)

```
Phase 0 (immediate):    Fix 4 (SOL/XRP config -- 1 line, deploy)
Phase 1 (parallel):     Fix 7 (concurrent queries) | Fix 2 (L2 loader) | Fix 6 (Sharpe) | Fix 3 (gamma)
Phase 2 (after Fix 2):  Fix 1 (PG cache) -- depends on L2 being in the data loader
Phase 3 (after 1+2+7):  Fix 5 (verification) -- needs L2 data + PG cache working
```

---

## Epic 10: Data Pipeline Rework

The backtester's Railway PG path is 100x slower than the local SQLite path and does not load L2 book data. This epic creates a server-side PG timeline cache, adds L2 loading to the PG data path, and parallelizes window queries. Together these fixes bring Railway backtests from ~60s to <500ms for 50 windows and enable realistic L2 book-walked fills.

**Fixes covered:** Fix 1 (PG cache), Fix 2 (L2 loading), Fix 7 (concurrent queries)
**FRs addressed:** FR20 (fast data loading), FR33 (build timelines from raw tables including L2)
**NFRs addressed:** NFR1 (<500ms for 50 windows), NFR7 (bit-identical results), NFR13 (PostgreSQL on Railway)

### Story 10.1: Concurrent PG Queries in Factory Backtest

As a quant researcher,
I want the PG-path backtester to load multiple windows in parallel,
So that backtests on Railway are ~10x faster even without the timeline cache.

**Acceptance Criteria:**

**Given** `runFactoryBacktestPg()` in `src/factory/cli/backtest-factory.js` currently uses a sequential `for...of await` loop (line 543) to load and evaluate windows one at a time
**When** the loop is refactored to use the concurrency limiter pattern from `parallel-engine.js` (line 35)
**Then** window loading and evaluation runs with configurable concurrency (default: 10 parallel windows)
**And** the `createLimiter` function is imported from `parallel-engine.js` or extracted to a shared utility
**And** the PG pool max in `config/index.js` is increased from 10 to 20 to support concurrent queries
**And** the same concurrency pattern is applied to the baseline evaluation loop (lines 599-619)
**And** 50 windows on Railway complete in <10s (down from ~60s)
**And** results are identical to the sequential path (deterministic ordering preserved by sorting after parallel evaluation)
**And** unit tests verify that concurrent evaluation produces the same metrics as sequential evaluation on mocked data
**And** all previously passing tests continue to pass

**Implementation Notes:**
- The sequential loop at line 543 becomes `Promise.all(sampledWindows.map(win => limit(async () => { ... })))`
- Window results must be sorted by close time after parallel evaluation (the existing sort at line 568 handles this)
- Pool max increase: `config/index.js` line ~180, `pool.max: 10` becomes `pool.max: 20`

### Story 10.2: Add L2 Book Ticks to PG Data Loader

As a quant researcher,
I want the PG data loader to include L2 book tick data when loading per-window data,
So that the fill simulator can walk real L2 book depth instead of falling back to bestAsk + spread buffer.

**Acceptance Criteria:**

**Given** `loadWindowTickData()` in `src/backtest/data-loader.js` (line 558) currently queries only rtds_ticks, clob_price_snapshots, and exchange_ticks
**When** L2 book tick loading is added to the function
**Then** `loadWindowTickData()` also queries `l2_book_ticks` in parallel with the other three queries
**And** the L2 query selects `timestamp, token_id, symbol, event_type, best_bid, best_ask, mid_price, spread, bid_depth_1pct, ask_depth_1pct, top_levels` from `l2_book_ticks` for the window's time range and symbol
**And** the return value includes `l2BookTicks` alongside the existing `rtdsTicks`, `clobSnapshots`, `exchangeTicks`
**And** the L2 query handles missing `l2_book_ticks` table gracefully (returns empty array, does not throw)
**And** `buildWindowTimelinePg()` in `backtest-factory.js` (line 660) is updated to process L2 ticks, tagging them as `l2Up`/`l2Down` with `top_levels` preserved
**And** `l2Up`/`l2Down` events in the timeline match the schema expected by `MarketState.processEvent()`: `{ source: 'l2Up'|'l2Down', timestamp, best_bid, best_ask, mid_price, spread, bid_depth_1pct, ask_depth_1pct, top_levels, _ms }`
**And** when L2 data is not available for a window, the fill simulator falls back gracefully to bestAsk + spread buffer (existing behavior)
**And** the `loadAllData()` function (line 409) is also updated to include L2 bulk loading for the parallel-engine preloaded path
**And** a trade audit of `edge-c-asymmetry` on BTC with 200 windows shows non-zero `fillQuality.l2CoverageRate` for windows that have L2 data
**And** integration tests verify that windows with L2 data produce `l2Up`/`l2Down` events in the timeline and the fill simulator uses book-walking

**Implementation Notes:**
- The L2 query pattern already exists in `timeline-builder.js` (`loadL2Ticks()` at line 354) -- reuse that SQL
- `buildWindowTimelinePg()` needs L2 handling added (currently only processes rtds, clob, exchange)
- Direction detection: use `token_id` → direction map from CLOB snapshots (same pattern as `timeline-builder.js` line 456)
- The `loadAllData()` bulk loader should load L2 with the same `loadL2Ticks` pattern but using a date range

### Story 10.3: PG Timeline Cache Table and Write Path

As a quant researcher,
I want pre-computed timelines stored in PostgreSQL on Railway,
So that backtests on Railway can read cached blobs instead of querying 3+ raw tick tables per window.

**Depends on:** Story 10.2 (L2 data must be in timelines before caching)

**Acceptance Criteria:**

**Given** the SQLite timeline schema in `src/factory/timeline-store.js` stores pre-computed, MessagePack-serialized timelines per window
**When** a PG equivalent is created
**Then** a `pg_timelines` table is created in PostgreSQL with schema:
```sql
CREATE TABLE pg_timelines (
    window_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    window_close_time TIMESTAMPTZ NOT NULL,
    window_open_time TIMESTAMPTZ NOT NULL,
    ground_truth TEXT,
    strike_price REAL,
    oracle_price_at_open REAL,
    chainlink_price_at_close REAL,
    timeline BYTEA NOT NULL,
    event_count INTEGER NOT NULL,
    data_quality TEXT,
    built_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_pg_timelines_symbol ON pg_timelines(symbol, window_close_time);
```
**And** a new module `src/factory/pg-timeline-store.js` exports functions: `insertPgTimeline(row)`, `insertPgTimelines(rows)`, `getPgTimeline(windowId)`, `getPgWindowsForSymbol(symbol, options)`, `getPgCacheSummary()`
**And** `timeline-builder.js` (`buildSingleWindow()` at line 231) gains a `--target=pg` option that writes BYTEA blobs to `pg_timelines` (in addition to or instead of SQLite)
**And** the `build-timelines.mjs` script accepts `--target=pg|sqlite|both` (default: `sqlite` for backward compatibility)
**And** incremental PG builds query `MAX(window_close_time)` from `pg_timelines` for the symbol
**And** the `pg_timelines` BYTEA blob is identical to the SQLite timeline BLOB for the same window
**And** a migration script or DDL file exists at `migrations/pg-timelines.sql`
**And** unit tests verify PG round-trip: build timeline, insert to PG, read back, unpack, compare to original

### Story 10.4: PG Timeline Cache Read Path

As a quant researcher,
I want the factory backtester on Railway to read pre-computed timelines from PG instead of querying raw tick tables,
So that 50-window backtests complete in <500ms.

**Depends on:** Story 10.3

**Acceptance Criteria:**

**Given** `pg_timelines` contains pre-built timelines for a symbol
**When** `runFactoryBacktestPg()` is invoked
**Then** it first checks `pg_timelines` for cached timelines matching the sampled windows
**And** for windows with cached timelines, it reads the BYTEA blob and deserializes with MessagePack (single row fetch per window, ~10-50KB each)
**And** for windows without cached timelines, it falls back to the raw tick loading path (Story 10.1/10.2)
**And** a `source` field in the result indicates `'pg_cache'` vs `'pg_raw'` for each window
**And** cache hit rate is reported in the backtest results
**And** 50 windows with full cache hits complete in <500ms on Railway
**And** 200 windows with full cache hits complete in <2s on Railway
**And** cached-path results are bit-identical to raw-path results (same Sharpe, same trades, same PnL)
**And** the concurrency pattern from Story 10.1 is used for cache reads (though individual reads are fast, parallelism helps with connection overhead)
**And** integration tests verify that cached and uncached paths produce identical metrics for the same windows

### Story 10.5: Auto-Build and Backfill for PG Cache

As a quant researcher,
I want new windows to be automatically cached in PG when they resolve, and old windows backfilled via script,
So that the cache stays current without manual intervention.

**Depends on:** Story 10.3

**Acceptance Criteria:**

**Given** the PG timeline cache is operational
**When** a new window resolves (the existing window-close-event flow fires at T+65s)
**Then** the timeline is built from raw tick data and inserted into `pg_timelines` automatically
**And** the auto-build hooks into the existing window-close-event recorder module (`src/modules/window-close-event-recorder/index.js`) or a new post-resolution hook
**And** auto-build failures are logged but do not block the window-close-event recording
**And** a backfill script `scripts/backfill-pg-timelines.mjs` builds and inserts timelines for all historical windows not yet in `pg_timelines`
**And** the backfill script accepts `--symbol`, `--start-date`, `--end-date` flags
**And** the backfill script reports progress: windows processed, inserted, skipped, errors
**And** the backfill processes windows in batches of 50 to manage memory and connection usage
**And** running the backfill script for BTC (~3000 windows) completes in <30 minutes

---

## Epic 11: Data Collection Fixes

Two data collection pipelines are broken or incomplete: gamma resolution recording stopped on Feb 27 for all symbols, and L2 tick recording is not running for SOL and XRP because they are not in the paper trader cryptos config. These are independent fixes that restore data coverage.

**Fixes covered:** Fix 3 (gamma backfill), Fix 4 (SOL/XRP cryptos)

### Story 11.1: Add SOL and XRP to Paper Trader Cryptos Config

As a quant researcher,
I want SOL and XRP added to the paper trader's crypto configuration,
So that L2 tick recording resumes for those symbols on the next deploy.

**Acceptance Criteria:**

**Given** `config/index.js` line ~485 has `cryptos: ['btc', 'eth']` in the `paperTrader` config block
**When** SOL and XRP are added to the array
**Then** the config reads `cryptos: ['btc', 'eth', 'sol', 'xrp']`
**And** the tick-recorder module (which lives inside paper-trader and records only for configured cryptos) begins recording L2 book ticks for SOL and XRP on the next Railway deploy
**And** no other config changes are needed -- the tick-recorder auto-discovers the new symbols from this array
**And** the change is verified by checking that `l2_book_ticks` receives rows with `symbol LIKE 'sol%'` and `symbol LIKE 'xrp%'` after deploy
**And** existing BTC and ETH recording is unaffected

**Implementation Notes:**
- This is a 1-line config change. Deploy immediately.
- After deploy, allow 24 hours for meaningful L2 data to accumulate before using in backtests.

### Story 11.2: Investigate and Fix Gamma Resolution Recording

As a quant researcher,
I want gamma resolution recording restarted and the Feb 28 - present gap backfilled,
So that ground truth data uses the most authoritative source (gamma API) instead of falling back to computed CL resolution.

**Acceptance Criteria:**

**Given** `gamma_resolved_direction` in `window_close_events` stopped being populated on Feb 27, 2026 for all symbols
**When** the root cause is identified and fixed
**Then** gamma resolution recording resumes for all new windows
**And** the investigation checks:
  - Whether the `gamma_resolved_direction` column update logic is in the window-close-event recorder or a separate module
  - Whether the Gamma API (`https://gamma-api.polymarket.com`) endpoint changed, rate-limited, or requires auth changes
  - Whether a deployment on or around Feb 27 broke the recording path
  - Whether the Polymarket API response format changed (new field names, different market IDs)
**And** the fix is documented with root cause analysis
**And** gamma recording is verified working for at least 24 hours of new windows before marking complete

### Story 11.3: Backfill Gamma Resolution Data

As a quant researcher,
I want gamma resolution data backfilled for windows from Feb 28 to present,
So that all recent windows have authoritative ground truth.

**Depends on:** Story 11.2 (root cause must be understood before backfill)

**Acceptance Criteria:**

**Given** the Gamma API is accessible and gamma recording is fixed
**When** a backfill script is executed
**Then** a script `scripts/backfill-gamma.mjs` queries the Gamma API for historical resolution data for each window in the gap period (Feb 28 - present)
**And** the script accepts `--symbol`, `--start-date`, `--end-date` flags
**And** for each window, it queries the Gamma markets API for the resolution result and updates `window_close_events.gamma_resolved_direction`
**And** the script handles Gamma API rate limits gracefully (backoff/retry)
**And** the script reports: total windows checked, updated, already populated, API errors
**And** after backfill, `SELECT COUNT(*) FROM window_close_events WHERE gamma_resolved_direction IS NULL AND window_close_time > '2026-02-28'` returns 0 for all symbols
**And** the backfill does not modify windows that already have `gamma_resolved_direction` set

---

## Epic 12: Metrics and Verification

The Sharpe ratio uses incorrect annualization (sqrt(252) for window-level returns), and the filter/sweep bug fix has not been verified against real data with L2 fills. These fixes ensure metrics are meaningful and the sweep system actually works.

**Fixes covered:** Fix 5 (sweep verification), Fix 6 (Sharpe annualization)
**NFRs addressed:** NFR9 (deterministic reproducibility)

### Story 12.1: Fix Sharpe Ratio Annualization

As a quant researcher,
I want the Sharpe ratio annualized correctly based on actual trading frequency,
So that absolute Sharpe values are meaningful and comparable to industry benchmarks.

**Acceptance Criteria:**

**Given** `calculateSharpeRatio()` in `src/backtest/metrics.js` (line 32) uses a hardcoded `periodsPerYear = 252` parameter
**And** `computeMetrics()` in `src/factory/cli/backtest-factory.js` (line 113) passes `252` as the annualization factor
**And** `bootstrapSharpeCI()` (line 217) also uses `252`
**When** the annualization is fixed
**Then** `computeMetrics()` computes the actual annualization factor from the data: `periodsPerYear = (365.25 * 24 * 60) / windowDurationMinutes` (e.g., for 15-minute windows: 35,064; for 5-minute windows: 105,192)
**And** alternatively, raw (unannualized) Sharpe is reported alongside the annualized value with trade count prominently displayed
**And** the `calculateSharpeRatio()` function signature remains unchanged (it already accepts `periodsPerYear` as a parameter)
**And** the fix is applied consistently in: `computeMetrics()`, `bootstrapSharpeCI()`, and any other call sites that pass the annualization factor
**And** `calculateSortinoRatio()` (line 57) receives the same corrected `periodsPerYear`
**And** the result JSON includes both `sharpeAnnualized` and `sharpeRaw` (unannualized = mean/stddev without sqrt(N) scaling) so consumers can choose
**And** existing tests are updated to expect the new annualization factor
**And** a comment in the code documents the annualization logic and references Marcus's review recommendation

**Implementation Notes:**
- Marcus recommended: "Either document that the reported Sharpe is per-window Sharpe annualized assuming 252 windows/year, or compute the actual annualization factor based on the time span."
- The cleanest approach: report raw Sharpe (no annualization) as the primary metric, with trade count. Add annualized Sharpe as a secondary metric using actual window frequency.
- For 15-minute windows: `sqrt(35064)` = ~187.3 vs current `sqrt(252)` = ~15.9. Annualized Sharpe will be ~12x higher than currently reported. This is mathematically correct but may look unusual -- document clearly.

### Story 12.2: Verify Filter/Sweep Bug Fix with Real Data

As a quant researcher,
I want to verify that the filter/sweep bug fix actually works -- that different sweep parameter values produce different backtest results when run against real data on Railway with L2 fills,
So that I can trust the sweep system for strategy optimization.

**Depends on:** Story 10.1 (concurrent queries) and Story 10.2 (L2 data in PG path)

**Acceptance Criteria:**

**Given** the filter bug was fixed (blocks now read params from runtime config instead of hardcoded defaults)
**And** the PG path now loads L2 data and supports concurrent queries
**When** a strategy with meaningful sweep params is run on Railway
**Then** run `edge-c-asymmetry` with sweep grid `{ deficitThreshold: [60, 80, 100], maxDownPrice: [0.55, 0.65, 0.75] }` -- 9 combinations
**And** confirm that at least 3 different Sharpe values are produced across the 9 combinations
**And** confirm that `deficitThreshold: 60` produces more trades than `deficitThreshold: 100` (lower threshold = more triggers)
**And** confirm that `maxDownPrice: 0.55` produces fewer trades than `maxDownPrice: 0.75` (tighter price filter = fewer entries)
**And** confirm that the results include non-zero `fillQuality.l2CoverageRate` for windows that have L2 data
**And** document the verification results: strategy, symbol, sweep grid, per-variant trade counts and Sharpe values
**And** this is a verification story -- no code changes unless the test reveals a remaining bug
**And** if a remaining bug is found, file a separate story and block this story on it

---

## Build Phase Plan

### Phase 0: Immediate Deploy (5 minutes)

| Story | Fix | Effort | Dependencies | Parallelizable |
|-------|-----|--------|-------------|----------------|
| 11.1 | Fix 4: SOL/XRP config | 5 min | None | Deploy immediately |

**Action:** Change 1 line in `config/index.js`, deploy to Railway. L2 recording begins automatically.

### Phase 1: Independent Fixes (parallel, ~2-3 hours each)

| Story | Fix | Effort | Dependencies | Parallelizable |
|-------|-----|--------|-------------|----------------|
| 10.1 | Fix 7: Concurrent PG queries | 1-2 hrs | None | Yes |
| 10.2 | Fix 2: L2 data loader | 2-3 hrs | None | Yes |
| 12.1 | Fix 6: Sharpe annualization | 1-2 hrs | None | Yes |
| 11.2 | Fix 3: Gamma investigation | 1-2 hrs | None | Yes |

**All four can run in parallel.** They touch different files with no overlapping code.

- Fix 7 touches: `backtest-factory.js` (the PG evaluation loop), `config/index.js` (pool max)
- Fix 2 touches: `data-loader.js` (add L2 query), `backtest-factory.js` (buildWindowTimelinePg)
- Fix 6 touches: `backtest-factory.js` (computeMetrics, bootstrapSharpeCI), `metrics.js` (documentation)
- Fix 3 touches: window-close-event recorder or gamma-specific module, new backfill script

**Note:** Fix 2 and Fix 7 both touch `backtest-factory.js` -- if running truly in parallel, coordinate to avoid merge conflicts. Fix 7 changes the evaluation loop structure; Fix 2 changes `buildWindowTimelinePg`. These are in different functions so conflicts are manageable.

### Phase 2: PG Cache (after Fix 2, ~3-4 hours)

| Story | Fix | Effort | Dependencies | Parallelizable |
|-------|-----|--------|-------------|----------------|
| 10.3 | Fix 1a: PG cache write | 2-3 hrs | 10.2 | Yes (with 10.4) |
| 10.4 | Fix 1b: PG cache read | 2-3 hrs | 10.3 | Sequential |
| 10.5 | Fix 1c: Auto-build + backfill | 2-3 hrs | 10.3 | After 10.3 |
| 11.3 | Fix 3b: Gamma backfill | 1-2 hrs | 11.2 | Yes |

### Phase 3: Verification (after Phase 2, ~1 hour)

| Story | Fix | Effort | Dependencies | Parallelizable |
|-------|-----|--------|-------------|----------------|
| 12.2 | Fix 5: Sweep verification | 1 hr | 10.1, 10.2 | Last |

### Critical Path

```
Fix 4 (5 min) --> deploy
Fix 2 (2-3 hrs) --> Fix 1a (2-3 hrs) --> Fix 1b (2-3 hrs) --> Fix 5 (1 hr)
```

**Total critical path: ~8-10 hours of agent work.**

With parallelization, the full sprint can complete in one focused session:
- Phase 0 + Phase 1 agents launch simultaneously
- Phase 2 begins as soon as Fix 2 completes
- Phase 3 is a 1-hour verification pass

### Estimated Wall-Clock Time

| Phase | Duration | Agents Working |
|-------|----------|---------------|
| Phase 0 | 5 min | 1 |
| Phase 1 | 2-3 hrs | 4 (parallel) |
| Phase 2 | 4-5 hrs | 2 (10.3/10.4 sequential, 11.3 parallel) |
| Phase 3 | 1 hr | 1 |
| **Total** | **~7-9 hrs** | **Sequential equivalent: ~15-18 hrs** |

---

## Post-Sprint Validation

After all stories complete, run the following validation suite:

1. **Performance validation:** `node scripts/backtest-factory.mjs --strategy=edge-c-asymmetry --symbol=btc --sample=50 --source=pg` completes in <500ms on Railway
2. **L2 coverage validation:** Trade audit shows `fillQuality.l2CoverageRate > 0` for BTC windows after Feb 2026
3. **Gamma coverage validation:** `SELECT COUNT(*) FROM window_close_events WHERE gamma_resolved_direction IS NOT NULL AND window_close_time > '2026-02-28'` returns >0 for all symbols
4. **SOL/XRP recording validation:** `SELECT COUNT(*) FROM l2_book_ticks WHERE symbol LIKE 'sol%' AND timestamp > NOW() - INTERVAL '24 hours'` returns >0
5. **Sharpe validation:** Sharpe values include both raw and annualized with correct window-frequency scaling
6. **Sweep validation:** 9-combination sweep produces at least 3 distinct Sharpe values
7. **Regression gate:** Full test suite passes with no new failures vs pre-sprint baseline
