# Backtester Performance Optimization Report

**Date:** 2026-03-15
**Author:** Performance Engineering Investigation
**Target:** <500ms for 50 windows total (<10ms/window), down from ~1.2s/window on Railway

---

## Current Performance Profile

### Per-Window Breakdown (PG Path: `runFactoryBacktestPg`)

The PG path in `src/factory/cli/backtest-factory.js` (line 476) runs a **sequential loop** over sampled windows. For each window, it calls `loadWindowTickData()` (line 545), which fires **3 parallel PG queries** (rtds_ticks, clob_price_snapshots, exchange_ticks) and then builds a timeline via `buildWindowTimelinePg()`.

| Phase | Estimated Time/Window | Evidence |
|-------|----------------------|----------|
| PG queries (3x parallel) | ~800-900ms | 3 queries over network; even on Railway (<1ms RTT), query execution + result transfer dominates |
| Timeline merge + sort | ~50-100ms | `buildWindowTimelinePg()` does `new Date()` parsing in sort comparator (line 688) |
| `evaluateWindow()` replay | ~100-200ms | MarketState.processEvent + strategy evaluate per tick; ~50-200 events/window |
| **Total per window** | **~1,000-1,200ms** | Matches observed ~1.2s/window |

### Aggregate Performance

| Windows | Current Time | Target |
|---------|-------------|--------|
| 50 | ~60s | <500ms |
| 200 | ~240s | <2s |

### Where Time Is Spent (estimated breakdown for 50 windows)

- **~80%: PG I/O** -- 50 windows x 3 queries each = 150 queries, sequential per window
- **~10%: Timeline merge/sort** -- Date parsing in sort comparator, object spread copies
- **~5%: MarketState replay** -- parseFloat calls, event processing
- **~5%: Metrics/aggregation** -- Sharpe, Sortino, bootstrap CI

The bottleneck is overwhelmingly **data loading from PostgreSQL**.

---

## Critical Observation: The SQLite Path Is Already Fast

The existing SQLite timeline cache (`src/factory/timeline-loader.js`) uses `better-sqlite3` with:
- MessagePack-serialized timelines (pre-computed, pre-sorted)
- Single row fetch per window (`SELECT * FROM timelines WHERE window_id = ?`)
- WAL mode, 64MB cache, synchronous=NORMAL

The `runFactoryBacktest()` function (line 277) using this path loads a window in **<1ms** (synchronous SQLite read + msgpack unpack). The evaluation loop at lines 335-365 is pure CPU. For 200 windows, the entire SQLite-path backtest takes ~2-5 seconds.

**The SQLite path already achieves near-target performance locally. The problem is that Railway has no local SQLite file.**

---

## Optimization Proposals (Ranked by Impact)

### Proposal 1: Server-Side Timeline Cache in PostgreSQL

**Expected speedup:** 50-100x (from ~60s to ~0.5-1s for 50 windows)
**Implementation effort:** Medium
**How it works:**

Create a `pg_timelines` table in PostgreSQL that mirrors the SQLite `timelines` table:

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
    timeline BYTEA NOT NULL,        -- MessagePack blob
    event_count INTEGER NOT NULL,
    data_quality TEXT,
    built_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_pg_timelines_symbol ON pg_timelines(symbol, window_close_time);
```

The existing `timeline-builder.js` (`buildSingleWindow()`, line 231) already does exactly the right work: queries PG for raw ticks, merges into a timeline, validates, serializes with MessagePack. Currently it writes to SQLite via `insertTimelines()`. A new code path would write to this PG table instead (or in addition).

On Railway, the backtester would then:
1. Query window metadata from `pg_timelines` (one query, all 50 windows)
2. For each window: `SELECT timeline FROM pg_timelines WHERE window_id = $1` -- single row, ~10-50KB BYTEA
3. `unpack(row.timeline)` -- MessagePack deserialize, ~0.1ms
4. `evaluateWindow()` -- pure CPU, ~2-5ms

**Per-window cost:** ~1-3ms (single PG row fetch on Railway) + ~2-5ms (evaluate) = ~3-8ms
**50 windows:** ~150-400ms -- well within the <500ms target

**Risks:**
- Storage: each timeline blob is ~10-50KB. For 10,000 windows, that's ~100-500MB -- trivial for PG
- Build step required: must run `buildTimelines` before backtesting (same as SQLite path)
- Consistency: timelines must be rebuilt when raw data changes

**Evidence:**
- The SQLite path (`timeline-loader.js` line 24-47) proves the pattern works
- `timeline-builder.js` line 273-288 already produces the exact row format needed
- MessagePack serialization is already used (`import { pack } from 'msgpackr'`)

---

### Proposal 2: Batch Data Loading (Preload + Slice)

**Expected speedup:** 10-20x (from ~60s to ~3-6s for 50 windows)
**Implementation effort:** Low
**How it works:**

The `parallel-engine.js` already implements this pattern (line 545, `runParallelBacktest`). When `allData` is provided, it:
1. Loads ALL ticks for the date range once (3 bulk queries)
2. Slices per-window using binary search (`sliceByTime()`, line 482)
3. Pre-computes `_ms` timestamps to avoid Date parsing in hot paths

The `fast-engine.js` takes this further with:
- In-place source tagging (no object spread -- line 114-145)
- N-way merge instead of sort (O(n) vs O(n log n) -- line 163)
- Pre-computed `_ms` on all data (`precomputeTimestamps()`, line 41)

The PG factory path (`runFactoryBacktestPg`) does NOT use this pattern -- it loads per-window at line 545. Switching to bulk-load + slice would reduce 150 queries to 3 queries.

**Per-window cost after bulk load:**
- Binary search slice: <0.01ms
- Timeline build (N-way merge): ~0.5ms
- evaluateWindow: ~2-5ms
- Total: ~3-6ms/window

**Bulk load overhead:** 3 large queries, ~2-5s depending on date range and data volume

**Risks:**
- Memory: loading all ticks for a wide date range could be 100MB+ in memory
- The bulk load time itself (3-5s) sets a floor -- acceptable for 50+ windows but not for single-window tests
- CLOB filtering per-window adds CPU (symbol prefix + epoch + price range check)

**Evidence:**
- `parallel-engine.js` lines 583-607: already implements Mode 1 (preloaded) with binary search slicing
- `fast-engine.js` lines 349-468: `runAllStrategies()` uses this for multi-strategy evaluation
- `data-loader.js` lines 409-440: `loadAllData()` already does the 3-query bulk load

---

### Proposal 3: Parallel Window Evaluation with Worker Threads

**Expected speedup:** 2-4x (on CPU-bound portion only)
**Implementation effort:** High
**How it works:**

Currently `evaluateWindow()` is called sequentially in `runFactoryBacktestPg` (line 543-563). The existing `parallel-engine.js` uses `Promise.all` with a concurrency limiter, but in Node.js this only helps with I/O-bound work -- all JS evaluation happens on one thread.

With `worker_threads`:
- Main thread loads data (bulk or cached timelines)
- Worker pool (4-8 threads) evaluates windows in true parallel
- Each worker gets a serialized timeline + strategy config, returns results

**Realistic impact analysis:**
- Data loading (80% of time) is I/O-bound -- workers don't help here
- Evaluation (20% of time, ~200ms for 50 windows after Proposal 1/2) would drop to ~50-100ms with 4 workers
- Net effect: marginal improvement on top of Proposals 1 or 2

**Risks:**
- Strategy objects contain closures/functions that can't be serialized across threads
- Significant complexity: need to serialize/deserialize strategies, timeline data
- worker_threads startup overhead (~50ms) may exceed the evaluation time for small runs
- V8 structured clone overhead for timeline arrays could negate parallelism gains

**Evidence:**
- `evaluateWindow()` in `parallel-engine.js` (line 176) is a pure function with no shared state -- ideal for workers
- But strategy objects have `evaluate()` functions that can't be `postMessage`'d without `eval` or code paths

---

### Proposal 4: PG Connection Pool Tuning

**Expected speedup:** 1.5-2x (for the current per-window PG path only)
**Implementation effort:** Low
**How it works:**

Current pool config (`config/index.js`):
```js
pool: {
    min: 2,
    max: 10,
    idleTimeoutMs: 30000,
    connectionTimeoutMs: 15000,
}
```

For burst backtest patterns (150+ queries in rapid succession), max=10 is conservative. On Railway (co-located with PG), connection overhead is minimal.

Proposed:
```js
pool: {
    min: 5,
    max: 20,           // Higher burst capacity
    idleTimeoutMs: 10000,
    connectionTimeoutMs: 5000,
}
```

Additionally, the `runFactoryBacktestPg` loop at line 543 is fully sequential (`for...of` with `await`). Even without worker threads, we could parallelize the PG queries across windows using the concurrency limiter pattern from `parallel-engine.js` (line 35):

```js
// Instead of sequential:
for (const win of sampledWindows) {
    const windowData = await loadWindowTickData({ window: win });
    // ...
}

// Use concurrent:
const limit = createLimiter(10);
const promises = sampledWindows.map(win => limit(async () => {
    const windowData = await loadWindowTickData({ window: win });
    const timeline = buildWindowTimelinePg(windowData);
    return evaluateWindow({ ... });
}));
const windowResults = await Promise.all(promises);
```

With concurrency=10 and pool max=20, this would process 10 windows simultaneously on 10 connections.

**Risks:**
- More connections = more PG backend processes = more memory
- With 10 concurrent windows, each doing 3 queries, that's 30 in-flight queries -- manageable
- Won't help if PG is the bottleneck (CPU/disk on the PG server side)

**Evidence:**
- `database.js` line 127: pool max currently 10
- `parallel-engine.js` line 564: already limits DB concurrency to 10 in per-window mode
- The sequential loop in `runFactoryBacktestPg` is the missed optimization -- it doesn't use any concurrency

---

### Proposal 5: Missing Index Optimizations

**Expected speedup:** 1.5-3x on query execution time (modest overall impact)
**Implementation effort:** Low
**How it works:**

Current indexes relevant to backtest queries:

| Table | Index | Columns |
|-------|-------|---------|
| rtds_ticks | idx_rtds_ticks_timestamp | (timestamp) |
| rtds_ticks | idx_rtds_ticks_symbol_timestamp | (symbol, timestamp) |
| rtds_ticks | idx_rtds_ticks_symbol_topic | (symbol, topic) |
| clob_price_snapshots | idx_clob_snap_token_time | (token_id, timestamp DESC) |
| clob_price_snapshots | idx_clob_snap_epoch | (window_epoch, timestamp) |
| exchange_ticks | idx_ext_symbol_time | (symbol, timestamp DESC) |
| exchange_ticks | idx_ext_exchange_symbol_time | (exchange, symbol, timestamp DESC) |
| window_close_events | idx_window_close_symbol | (symbol, window_close_time DESC) |

**Missing indexes for backtest query patterns:**

1. **rtds_ticks**: The query at `data-loader.js` line 574 filters by `timestamp >= $1 AND timestamp <= $2 AND topic IN (...)`. The existing index `idx_rtds_ticks_symbol_topic` covers (symbol, topic) but NOT (topic, timestamp). A composite index `(topic, timestamp)` would be better:
   ```sql
   CREATE INDEX idx_rtds_ticks_topic_timestamp ON rtds_ticks(topic, timestamp)
   WHERE topic IN ('crypto_prices_chainlink', 'crypto_prices');
   ```
   A partial index here is ideal since only 2 of N topics are queried.

2. **clob_price_snapshots**: The query at `data-loader.js` line 583 filters by `timestamp >= $1 AND timestamp <= $2 AND symbol LIKE $3 AND window_epoch = $4`. The existing index `idx_clob_snap_epoch` covers (window_epoch, timestamp), which is good. But a covering index that includes the queried columns would avoid heap lookups:
   ```sql
   CREATE INDEX idx_clob_snap_backtest ON clob_price_snapshots(window_epoch, timestamp)
   INCLUDE (symbol, token_id, best_bid, best_ask, mid_price, spread, bid_size_top, ask_size_top);
   ```

3. **exchange_ticks**: The query uses `timestamp >= $1 AND timestamp <= $2 AND symbol = $3`. Index `idx_ext_symbol_time` has `(symbol, timestamp DESC)` -- the DESC may cause issues with range scans using `>=` and `<=`. Consider:
   ```sql
   CREATE INDEX idx_ext_symbol_time_asc ON exchange_ticks(symbol, timestamp ASC);
   ```

**Risks:**
- Index creation on large tables takes time and disk space
- Too many indexes slow down INSERT (relevant for live data capture)
- These optimizations only matter if keeping the per-window PG query path

---

### Proposal 6: Materialized View for Pre-Joined Timelines

**Expected speedup:** 5-10x over raw per-window queries
**Implementation effort:** Medium-High
**How it works:**

Create a materialized view that pre-joins window metadata with tick data:

```sql
CREATE MATERIALIZED VIEW backtest_timelines AS
SELECT
    wce.window_close_time,
    wce.symbol,
    wce.strike_price,
    wce.chainlink_price_at_close,
    wce.oracle_price_at_open,
    wce.resolved_direction,
    jsonb_agg(
        jsonb_build_object(
            'source', CASE ... END,
            'timestamp', t.timestamp,
            'price', t.price,
            ...
        ) ORDER BY t.timestamp
    ) as timeline_events
FROM window_close_events wce
LEFT JOIN rtds_ticks t ON ...
LEFT JOIN clob_price_snapshots c ON ...
GROUP BY wce.window_close_time, wce.symbol, ...;
```

**Why this is worse than Proposal 1:**
- JSONB aggregation is slow for large event arrays
- The materialized view must be refreshed when data changes
- Query planner may struggle with the multi-table join
- Proposal 1 (pre-computed BYTEA blobs) is simpler and faster

**Risks:**
- Refresh time could be minutes for large datasets
- JSONB parsing on the client is slower than MessagePack
- Complex SQL to maintain

**Evidence:**
- The timeline-builder already does this work in JS more efficiently
- MessagePack is ~2x faster than JSON for serialization/deserialization

---

## Recommended Implementation Order

### Phase 1: Quick Wins (1 day, ~10x improvement)

1. **Add concurrency to `runFactoryBacktestPg`** -- wrap the sequential loop with a concurrency limiter (Proposal 4 partial). This is a ~10-line change that parallelizes the existing per-window PG queries. Expected: 50 windows in ~6-10s instead of ~60s.

2. **Increase pool max to 20** -- support the concurrent queries (Proposal 4 partial).

### Phase 2: Server-Side Cache (2-3 days, ~100x improvement)

3. **Create `pg_timelines` table** -- mirror the SQLite schema in PostgreSQL (Proposal 1).

4. **Add PG write path to timeline-builder** -- after building a timeline for SQLite, also INSERT into `pg_timelines`. The existing `buildSingleWindow()` already produces the correct row format.

5. **Add `runFactoryBacktestPgCached` function** -- load pre-computed timelines from `pg_timelines` instead of querying raw tick tables. This is structurally identical to the existing `runFactoryBacktest` (SQLite path) but reads from PG instead of SQLite.

6. **Run `buildTimelines` on Railway as a cron job** -- keep the PG cache up to date.

### Phase 3: Optimization Polish (1 day, marginal improvements)

7. **Add missing indexes** (Proposal 5) -- partial index on rtds_ticks for backtest topics.

8. **Pre-compute `_ms` in timeline blobs** -- the timeline-builder already does this (`_ms` field in `mergeTimeline()` at timeline-builder.js line 407). Verify the PG-cached blobs preserve this field.

---

## Estimated Combined Speedup

| Phase | 50 Windows | 200 Windows | Speedup vs Current |
|-------|-----------|-------------|-------------------|
| Current (sequential PG) | ~60s | ~240s | 1x |
| Phase 1 (concurrent PG) | ~6-10s | ~25-40s | ~6-10x |
| Phase 2 (PG timeline cache) | ~0.3-0.5s | ~1-2s | ~100-200x |
| Phase 3 (indexes + polish) | ~0.2-0.4s | ~0.8-1.5s | ~150-300x |

**Phase 2 alone achieves the target of <500ms for 50 windows.**

The key insight is that the existing architecture already has the solution -- the SQLite timeline cache path (`runFactoryBacktest`) is fast because it reads pre-computed blobs. Moving that cache from SQLite (local-only) to PostgreSQL (accessible from Railway) eliminates the bottleneck entirely without changing the evaluation logic.

---

## Appendix: Data Size Estimates

### Events Per Window (5-minute window, BTC)

| Source | Typical Count | Bytes/Event |
|--------|--------------|-------------|
| chainlink (RTDS) | 5-15 | ~100 |
| polyRef (RTDS) | 10-30 | ~100 |
| clobUp snapshots | 20-60 | ~200 |
| clobDown snapshots | 20-60 | ~200 |
| exchange ticks (5 exchanges) | 50-150 | ~150 |
| L2 book ticks | 100-500 | ~500 (includes top_levels JSONB) |
| **Total** | **200-800** | **~20-100KB** |

### MessagePack Blob Sizes

Typical timeline blob size after MessagePack serialization: **10-50KB per window**.
For 10,000 windows: **100-500MB** total storage in PG -- trivial.

### Table Row Counts (estimated from migration comments)

| Table | Rows/Day | Total (est.) |
|-------|----------|-------------|
| rtds_ticks | ~50,000 | ~5M+ |
| clob_price_snapshots | ~200,000 | ~20M+ |
| exchange_ticks | ~500,000 | ~50M+ |
| l2_book_ticks | ~2,600,000 | ~260M+ |
| window_close_events | ~96 (4/hr) | ~10,000+ |

### PG Pool Configuration

Current (`config/index.js`):
- Main pool: min=2, max=10, idle=30s, connect timeout=15s
- CB pool: min=1, max=2
- Query timeout: 5s (via `statement_timeout`)
- Retry: 3 attempts, 100ms initial, 2s max

The 5s query timeout is appropriate for individual window queries but may be tight for bulk loads of large tables. Consider raising to 30s for bulk-load queries specifically.
