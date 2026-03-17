# Adversarial Review -- Rework Sprint

**Reviewers:** Cassandra (Skeptic), Vera (Quant Researcher), Marcus (Hedge Fund Manager)
**Date:** 2026-03-15
**Document reviewed:** `epics-rework-sprint.md`
**Supporting evidence:** Trade audit, performance report, quant review, source code inspection

---

## Overall Assessment

**PASS WITH REQUIRED CHANGES**

The sprint correctly identifies the seven most urgent problems and sequences them well. The dependency diagram is honest and the parallelization plan is realistic. However, three material gaps remain: (1) several critical items from Marcus's quant review are not addressed, (2) the Sharpe fix is mathematically sound but introduces a UX landmine that needs explicit handling, and (3) the PG cache auto-build story has a race condition risk that is acknowledged but not mitigated. Additionally, the sprint's scope is narrowly focused on infrastructure fixes while leaving the fill model and statistical validation gaps that Marcus called out as "must-fix before any real capital."

The sprint will make the backtester *faster* and *more data-complete*. It will not yet make it *trustworthy*.

---

## Per-Story Review

### Epic 10, Story 10.1: Concurrent PG Queries in Factory Backtest

**Cassandra:**
- The acceptance criteria say "results are identical to the sequential path" but this is only true if the evaluation function is purely deterministic with respect to ordering. I confirmed that `evaluateWindow` is called per-window with fresh state, so ordering of windows shouldn't matter. However, the sort at line 568 sorts by `windowCloseTime` -- this requires that the parallel results are collected into an array before sorting. The implementation note correctly identifies `Promise.all` returning ordered results, but if the concurrency limiter discards ordering, you need to re-sort. This is addressed in the AC but worth a regression test.
- Increasing pool max from 10 to 20 affects ALL PG connections, not just backtest queries. If the paper trader, tick recorder, and window-close-event recorder are running simultaneously on Railway, you could hit PG's max_connections. Railway's default is often 100 connections. With pool.max=20 and multiple service replicas, this could fail silently under load.
- The estimate of "<10s for 50 windows" is plausible but unverified. The performance report estimates 6-10s. If PG is I/O-bound on the server side (disk, not network), parallelism won't help -- you'll just queue on the PG side. The AC should include a fallback: "if <10s is not achieved, document observed time and bottleneck."

**Vera:**
- Concurrency=10 with pool.max=20 means each concurrent window fires 3 queries (rtds, clob, exchange), so 30 in-flight queries. This is within PG's comfort zone but the pool.max=20 only leaves 10 connections for non-backtest queries. I would prefer pool.max=25 or a dedicated backtest pool.
- The determinism claim is correct: `evaluateWindow` is a pure function of (window, timeline, strategy, config). Parallel evaluation changes nothing about the math. But the test should verify this explicitly with at least 3 runs.

**Marcus:**
- This is a pure infrastructure fix. Good. No impact on metrics correctness. Just makes things faster. Approve.

**Required changes:**
1. Add AC: "Pool max increase does not cause connection exhaustion when other services are running concurrently. Verify by checking `SELECT count(*) FROM pg_stat_activity` during a backtest on Railway."
2. Add AC: "If <10s target is not achieved, document the observed time and bottleneck analysis."

---

### Epic 10, Story 10.2: Add L2 Book Ticks to PG Data Loader

**Cassandra:**
- This is the most critical story in the sprint. The trade audit proved that ALL 30 fills used the bestAsk fallback. This story fixes the root cause.
- Hidden dependency: The L2 query handles "missing `l2_book_ticks` table gracefully." But what about windows where the table exists but has NO data for that window? The trade audit showed "0 L2 ticks found" for all 30 trade windows. This means the L2 data simply doesn't exist for those time periods. Adding the L2 query is necessary but will return empty results for historical windows. The story's value is only realized for FUTURE windows after SOL/XRP data starts flowing and for BTC/ETH windows where L2 was being recorded.
- The AC says "a trade audit of edge-c-asymmetry on BTC with 200 windows shows non-zero fillQuality.l2CoverageRate for windows that have L2 data." But HOW MANY windows have L2 data? If L2 recording only covers certain date ranges, the coverage rate could be 5% or 50%. The AC should specify a minimum expected coverage rate or at least document the actual range.
- The `loadAllData()` function at line 409 does NOT currently load L2 data. The AC says to add it, which is correct, but this function is used by `parallel-engine.js` for bulk-loading. The parallel engine ALREADY handles L2 data in its timeline builder (confirmed in `timeline-builder.js`). So `loadAllData()` not loading L2 is actually a bug in TWO code paths, not just one.

**Vera:**
- The L2 query in `timeline-builder.js` line 354 (`loadL2Ticks`) uses `symbol LIKE $3` with `${symbol}%`. This matches `btc-up` and `btc-down` L2 ticks. The new query in `data-loader.js` must use the same pattern. The AC specifies the correct columns. Good.
- Direction detection from `token_id` is critical. The timeline-builder uses a `tokenDirMap` built from CLOB snapshots (line 456). If no CLOB snapshots exist for a window (rare but possible during data gaps), the fallback is `symbol.includes('down')`. This is correct as long as the `l2_book_ticks.symbol` column contains direction info like `btc-down`. Verify this is true in the actual data.
- The event schema for `l2Up`/`l2Down` includes `top_levels` which is JSONB in PG. When loaded via `persistence.all()`, PG drivers typically auto-parse JSONB to JS objects. But `buildWindowTimelinePg()` will do `{ ...tick }` spread, which preserves the parsed object. Then `MarketState.processEvent()` needs to handle `top_levels` as a JS object (array of [price, size] pairs). Confirm this is the expected format.

**Marcus:**
- This is the right fix. Without L2 data in the PG path, the entire fill simulation is fiction. But I note that even with L2 data, the fill model has no adverse selection modeling (my Critical Issue C2 from the quant review). Adding L2 data improves fill realism from "complete fiction" to "decent approximation for small orders." For $2 trades, this is probably fine. For $50+ trades, you'd still want adverse selection.
- After this fix, I'd want to see a COMPARISON: run the same 200-window backtest with L2 fills vs bestAsk-fallback fills. What's the PnL difference? If it's <5%, the bestAsk fallback was actually reasonable. If it's >20%, all previous results are unreliable.

**Required changes:**
1. Add AC: "Document the L2 data coverage date range for BTC and ETH (what dates have L2 data in the database)."
2. Add AC: "Run a comparison of 200-window backtest with L2-enabled vs L2-disabled (bestAsk fallback) and report PnL difference, to quantify the impact of this fix."

---

### Epic 10, Story 10.3: PG Timeline Cache Table and Write Path

**Cassandra:**
- The schema looks correct. `timeline BYTEA NOT NULL` is the right choice for MessagePack blobs.
- Missing from schema: there is no `version` or `schema_version` column. If the timeline format changes (e.g., new event fields added), cached timelines become stale. You'd need to invalidate or version them. Without this, a future change to event schemas will silently produce wrong results from cached timelines.
- The `window_id TEXT PRIMARY KEY` uses `{symbol}-{isoTimestamp}`. This is deterministic and collision-free. Good.
- The migration file at `migrations/pg-timelines.sql` -- does this directory already exist? If not, it needs to be created. Minor but agents can trip on this.
- No mention of VACUUM or autovacuum tuning for this table. With frequent UPSERTs during backfill, PG autovacuum should handle it, but for a table that grows by ~96 rows/day and gets bulk-loaded with 3000+ rows, it's worth noting.

**Vera:**
- "PG BYTEA blob is identical to the SQLite timeline BLOB for the same window" -- this is the key correctness invariant. The test should verify byte-level equality (`Buffer.compare(pgBlob, sqliteBlob) === 0`), not just logical equality after deserialization. MessagePack serialization IS deterministic for the same input, so byte-level equality is the right test.
- Risk: `pg_timelines` and SQLite timelines could diverge if `buildSingleWindow()` is called at different times and the underlying raw data has changed (e.g., late-arriving ticks). The story should specify: timelines are built from the SAME raw data query, so the only difference is the storage target. This is true if `buildSingleWindow()` is called once and writes to both.

**Marcus:**
- This is infrastructure. Approve as-is with the versioning concern noted.

**Required changes:**
1. Add a `schema_version INTEGER NOT NULL DEFAULT 1` column to the `pg_timelines` table. The cache read path should filter by `schema_version = CURRENT_VERSION` to avoid reading stale format.
2. Verify `migrations/` directory exists or specify that it should be created.

---

### Epic 10, Story 10.4: PG Timeline Cache Read Path

**Cassandra:**
- The AC says "cached-path results are bit-identical to raw-path results." This is the critical correctness claim and it's testable. Good.
- The `source` field (`'pg_cache'` vs `'pg_raw'`) is a nice touch for observability.
- Risk: if the cache has a stale timeline (built before a bug fix to timeline-builder), the cached results will be WRONG but will PASS all tests because the cache is self-consistent. The schema_version field from 10.3 would catch this.
- The AC says "<500ms for 50 windows on Railway." This is achievable: 50 single-row PG reads of 10-50KB each, even sequentially, would take ~50-100ms on Railway. With concurrency, it's trivially fast. But the AC should also test with COLD PG cache (first query after idle) to account for PG buffer cache misses.

**Vera:**
- "Bit-identical" is a strong claim. For floating point results (Sharpe, PnL), this requires that the timeline events are processed in exactly the same order with exactly the same numeric precision. Since MessagePack preserves float64 precision and the timeline is pre-sorted, this should hold. But add a note: "bit-identical means within IEEE 754 double precision, which MessagePack preserves."

**Marcus:**
- This delivers the <500ms target. Essential for interactive use. Approve.

**Required changes:** None beyond those in 10.3 (schema versioning).

---

### Epic 10, Story 10.5: Auto-Build and Backfill for PG Cache

**Cassandra:**
- "Auto-build hooks into the existing window-close-event recorder module or a new post-resolution hook" -- this is vague. Which one? If it hooks into the recorder module, it adds latency to the critical path of recording window close events. If it's a separate hook, how is it triggered? The AC says "auto-build failures are logged but do not block recording," which is good, but the mechanism needs to be specified.
- Race condition: if the auto-build fires at T+65s and the backfill script is also running, they could both try to INSERT the same window_id. The `window_id PRIMARY KEY` will cause a conflict. The INSERT should use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`.
- "Backfill processes windows in batches of 50" -- at 50 windows per batch, and ~3 PG queries per window (to build the timeline), that's 150 queries per batch. With concurrency, this is fine. But the backfill also needs to WRITE 50 rows per batch. Each row is 10-50KB, so 0.5-2.5MB per batch. Trivial for PG.
- "BTC ~3000 windows completes in <30 minutes" -- at ~1s per window (3 PG reads + timeline build + 1 PG write), 3000 windows = 3000s = 50 minutes sequentially. With concurrency=10, ~5-10 minutes. The 30-minute target is achievable but not with sequential processing. The AC should specify that the backfill uses concurrent processing.

**Vera:**
- The backfill must build timelines from the SAME raw data and the SAME code path as `buildSingleWindow()` in timeline-builder.js. If the backfill uses a different code path, the cached timelines will diverge from what the SQLite path produces. Ensure the backfill script calls `buildSingleWindow()` directly.
- Auto-building at T+65s means the raw tick data must already be fully committed to PG. If there's any write lag (e.g., async tick insertion), the auto-built timeline could be missing the last few ticks. This is unlikely (65 seconds is generous) but should be documented as an assumption.

**Marcus:**
- The auto-build is a maintenance concern, not a correctness concern. Approve with the race condition fix.

**Required changes:**
1. Specify `ON CONFLICT (window_id) DO NOTHING` in the INSERT to handle race conditions between auto-build and backfill.
2. Specify that the backfill script uses concurrent processing (e.g., concurrency=10) to achieve the <30 minute target.
3. Clarify whether auto-build hooks into the recorder module or uses a separate trigger.

---

### Epic 11, Story 11.1: Add SOL and XRP to Paper Trader Cryptos Config

**Cassandra:**
- I verified the code. `config/index.js` line 485 has `cryptos: ['btc', 'eth']` in `paperTrader`. Line 474 has `cryptos: ['btc', 'eth', 'xrp', 'sol']` in `exchangeTradeCollector`. So exchange ticks are ALREADY being collected for SOL/XRP, but the paper trader (which drives L2 recording) is not. The fix is correct.
- Risk: adding SOL and XRP to L2 recording increases PG write volume. L2 book ticks are the highest-volume table (~2.6M rows/day currently for BTC+ETH). Adding two more symbols could double this to ~5.2M rows/day. Verify that PG storage and write throughput can handle this.
- The config object is deep-frozen (`deepFreeze(config)` at line 601). This means you cannot modify it at runtime. The change must be in the source code. Correct approach.

**Vera:** No concerns. This is a config change.

**Marcus:** Deploy immediately. Every day without SOL/XRP L2 data is a day of lost data coverage. Approve.

**Required changes:** None. Ship it.

---

### Epic 11, Story 11.2: Investigate and Fix Gamma Resolution Recording

**Cassandra:**
- This is an investigation story, not a build story. The effort estimate of "1-2 hrs" is optimistic. If the root cause is an API change, it could be fixed quickly. If it's a subtle timing issue in the recorder module, it could take much longer.
- The AC says "gamma recording is verified working for at least 24 hours." This means the story cannot be marked complete on the same day it's started. The sprint plan assumes parallel execution in Phase 1, but this story has a built-in 24-hour wait. Adjust the timeline.
- What if the Gamma API is permanently changed or deprecated? The AC doesn't have a fallback plan. What if gamma resolution data is simply no longer available? The sprint should have a contingency: "if the Gamma API is unavailable, document the gap and fall back to onchain_resolved_direction permanently."

**Vera:**
- The ground truth fallback chain is: gamma > onchain > resolved > computed. If gamma stops working, onchain is the next best. How does `onchain_resolved_direction` compare to `gamma_resolved_direction` historically? If they agree 99.9% of the time, the gamma gap is cosmetic. If they diverge meaningfully, the gap matters. The investigation should include this comparison.

**Marcus:**
- Ground truth quality is foundational. If you don't know what actually happened, your backtest is worthless. But onchain resolution IS authoritative -- gamma is just more convenient. The real question is whether the computed CL fallback (the bottom of the chain) is reliable. In the trade audit, all resolutions used the fallback chain correctly. Approve but with lower priority than the data pipeline work.

**Required changes:**
1. Add contingency AC: "If Gamma API is permanently unavailable, document this and remove gamma from the ground truth fallback chain."
2. Add AC: "Compare gamma vs onchain resolution agreement rate for historical data to quantify the impact of the gap."

---

### Epic 11, Story 11.3: Backfill Gamma Resolution Data

**Cassandra:**
- Depends on 11.2. If 11.2 reveals the Gamma API is dead, this story is impossible.
- "The script handles Gamma API rate limits gracefully" -- what are the actual rate limits? If the Gamma API is throttled to 1 req/sec and there are 1500 windows to backfill, that's 25 minutes of API calls. If it's 10 req/sec, it's 2.5 minutes. The script should log the expected duration.
- Risk: the Gamma API returns resolution data for a MARKET, not a WINDOW. The script needs to map windows to Gamma market IDs. How is this mapping done? The AC doesn't specify. If window_close_events doesn't store the Gamma market ID or condition ID, the script needs to compute it (time-based market lookup). This is a non-trivial mapping that could introduce errors.

**Vera:**
- "After backfill, gamma_resolved_direction IS NULL returns 0" -- this is only meaningful if every window in the gap period actually HAS a gamma resolution. If some windows correspond to markets the Gamma API doesn't know about, the NULL count would be non-zero legitimately. The AC should distinguish between "API returned no data" and "window has no corresponding market."

**Marcus:** Lower priority. If onchain resolution is reliable, this is a nice-to-have. Approve with lower effort priority.

**Required changes:**
1. Specify how window-to-Gamma-market-ID mapping works.
2. Distinguish between "API unavailable" and "no corresponding market" in the final NULL count check.

---

### Epic 12, Story 12.1: Fix Sharpe Ratio Annualization

**Cassandra:**
- The math is correct: for 15-minute windows, `periodsPerYear = (365.25 * 24 * 60) / 15 = 35,064`. sqrt(35064) = 187.3 vs current sqrt(252) = 15.9. This is a 12x increase in reported annualized Sharpe.
- **UX LANDMINE:** A strategy that currently reports Sharpe=2.0 will suddenly report Sharpe=23.7. The user will either think something is broken or think their strategy is incredible. The AC says "a comment in the code documents the annualization logic" but this is not enough. The OUTPUT needs a prominent warning: "NOTE: Annualized Sharpe assumes continuous 15-min window trading. Raw Sharpe (no annualization) is the more stable metric for strategy comparison."
- The formula `periodsPerYear = (365.25 * 24 * 60) / windowDurationMinutes` assumes trading is continuous (24/7/365). For crypto markets this is correct. But if anyone ever extends this to equity markets, it would be wrong. Document the assumption.
- The AC says to report both `sharpeAnnualized` and `sharpeRaw`. Good. But what about backward compatibility? Any downstream code that reads `result.metrics.sharpe` will get... which one? The AC should specify which value is stored in the existing `sharpe` field for backward compatibility.

**Vera:**
- The annualization formula is textbook correct for i.i.d. returns: `Sharpe_annual = Sharpe_per_period * sqrt(N)` where N is periods per year. The key assumption is that per-period returns are i.i.d. For 5-minute windows, this is a TERRIBLE assumption -- there's strong autocorrelation in intraday returns (momentum at short horizons, mean-reversion at longer horizons). Annualizing with sqrt(35064) dramatically overstates the "true" Sharpe because it assumes you can independently sample the same edge 35,064 times per year.
- **Recommendation:** The raw Sharpe (mean/stddev, no sqrt(N)) should be the PRIMARY metric. The annualized Sharpe should be labeled as "theoretical annualized Sharpe assuming i.i.d. returns" and used only for rough comparison with industry benchmarks.
- The bootstrap CI in `bootstrapSharpeCI` also uses the annualization factor. The CI width will scale by the same 12x, which is mathematically correct but could produce absurdly wide CIs. This is expected behavior but surprising to users.
- Population variance (divides by N, not N-1) is used in `calculateSharpeRatio`. This is standard for Sharpe but slightly biased for small samples. With typical trade counts of 30-200, the bias is <5%. Acceptable.

**Marcus:**
- I recommended this fix. The current annualization is wrong. Reporting raw Sharpe as primary and annualized as secondary is the correct approach. But I want to be clear: an annualized Sharpe of 23.7 on 15-minute windows is NOT the same as a 23.7 Sharpe from a daily strategy. The time-aggregation assumption inflates the number. Any competent quant knows this, but this system may be used by people who don't know this. **Label it clearly.**
- After this fix, use raw Sharpe for strategy ranking and comparison. Only use annualized Sharpe when comparing to published benchmarks (and even then, caveat heavily).

**Required changes:**
1. Specify that `result.metrics.sharpe` retains the RAW (unannualized) Sharpe for backward compatibility, and add `result.metrics.sharpeAnnualized` as the new annualized metric.
2. Add a user-facing note in the output JSON: `sharpeNote: "Raw Sharpe (no annualization) is the primary ranking metric. Annualized Sharpe assumes continuous 24/7 i.i.d. window returns and overstates edge for short-window strategies."`
3. The Sortino ratio should receive the same treatment (raw + annualized).

---

### Epic 12, Story 12.2: Verify Filter/Sweep Bug Fix with Real Data

**Cassandra:**
- This is a verification story, not a build story. The AC is well-structured: it checks both directional monotonicity (more trades at lower threshold) and metric diversity (3+ distinct Sharpes across 9 combos).
- Risk: what if the sweep produces different Sharpe values but they're all positive? That could mean the strategy is robust to parameter choice (good) or that the edge is so large that even bad parameters can't kill it (suspicious). The verification should note whether the BEST and WORST parameter combos have meaningfully different performance.
- The dependency on 10.1 and 10.2 is correct. But this story also implicitly depends on there being L2 data for the test windows. If the BTC L2 data only covers certain date ranges, the "non-zero l2CoverageRate" check might only apply to a subset of windows.

**Vera:**
- 9 combinations is a very small grid. With 9 data points, you cannot compute meaningful parameter sensitivity statistics. This is a smoke test, not a parameter optimization study. That's fine for verification, but the story should be explicit that this is a FUNCTIONAL test, not a STATISTICAL test.
- The directional monotonicity checks (lower threshold = more trades, tighter price filter = fewer trades) are good sanity checks. If they fail, either the bug isn't fixed or the parameter doesn't work as expected.

**Marcus:**
- This is the right verification approach. If this passes, I have moderate confidence the sweep system works. If it fails, there's still a bug. Approve.

**Required changes:** None. Good as-is.

---

## Missing Items

### Items from Marcus's Quant Review NOT addressed by this sprint:

1. **C1/C3: Fee model (Critical).** Marcus flagged `tradingFee = 0` as critical and Polymarket's asymmetric fee structure as not modeled. The sprint does NOT fix this. The `feeMode: FeeMode.TAKER_ONLY` is already set as default in `backtest-factory.js` line 298, but Marcus's concern about Polymarket's fee-on-winnings structure remains unaddressed. This is a **material omission** -- every metric computed with the wrong fee model is overstated.

2. **C2: No adverse selection modeling (Critical).** Marcus called this the #1 source of backtest-to-live slippage. The sprint adds L2 book-walking (which helps with market impact) but does NOT model adverse selection (informed traders front-running your signal). For $2 trades this may not matter, but it's a conceptual gap.

3. **M3: No multiple-testing correction for variant selection (Moderate).** The sweep system ranks by Sharpe with no correction for selection bias. This sprint doesn't address it.

4. **M5: Regime breakdown splits by sample order, not calendar time (Moderate).** Not addressed.

5. **M7: No volatility regime breakdown (Moderate).** Not addressed.

6. **Recommendation 4: Out-of-sample holdout (Should-fix).** Marcus said to reserve 20-30% of windows for validation. The sprint does not add this. This is the single most effective guard against overfitting and its absence is concerning.

7. **Recommendation 5: Minimum trade count warnings (Should-fix).** Not addressed.

### Items from the trade audit NOT addressed:

8. **100% win rate on 30 trades requires scrutiny.** The trade audit flagged this. The sprint doesn't add any statistical test for "suspiciously high win rate" (e.g., a binomial test against the naive base rate).

### Items from the performance report NOT addressed:

9. **Missing indexes (Proposal 5).** The performance report identified missing indexes on `rtds_ticks(topic, timestamp)`, covering index on `clob_price_snapshots`, and ascending index on `exchange_ticks`. These would improve raw PG query performance even for windows not in the cache. Not included in the sprint.

10. **Pre-computed `_ms` timestamps in PG path.** The `buildWindowTimelinePg()` function in `backtest-factory.js` (line 688) uses `new Date(a.timestamp).getTime()` in the sort comparator, which is slow. The timeline-builder's `mergeTimeline()` already pre-computes `_ms`. The PG path timeline builder should do the same. The sprint mentions this for cached timelines but not for the raw PG path.

---

## After This Sprint: What's Still Concerning?

**Marcus's perspective:**

1. **The fill model is still too generous.** Adding L2 book-walking is a big improvement, but without adverse selection modeling, the backtest still overstates fill quality. When your signal fires, the market KNOWS something is happening. Other participants are also buying. The spread widens. Liquidity thins. The backtest assumes you can walk the resting book at leisure. In reality, you're in a race.

2. **No out-of-sample validation exists anywhere in the system.** Every strategy is evaluated on the SAME data it was developed against. The mutation engine generates variants and ranks by in-sample Sharpe. This is the textbook recipe for overfitting. Until there's a train/test split, I cannot trust any strategy selection result.

3. **No concept of strategy capacity.** The system assumes $2 trades. What happens at $10? $50? The L2 book-walking would show slippage at larger sizes, but there's no systematic capacity analysis. "How much capital can this strategy absorb before the edge degrades?" is a fundamental question that isn't even asked.

4. **Edge decay detection is missing.** The strategies exploit structural market microstructure features (CL lag, CLOB imbalance). These features can change. The system has no rolling performance monitor that flags when a strategy's edge has decayed. The regime breakdown (first/second half) is a crude proxy but not a real monitoring system.

5. **The 100% win rate backtest is not stress-tested.** 30 trades, all wins, no L2 data, with bestAsk fallback fills. After this sprint, the L2 data will be available and the Sharpe will be correctly annualized. But has anyone checked what happens when the CL deficit is $80 but the window resolves UP? Is the strategy's stopping rule correct? What's the expected loss when it's wrong?

---

## Recommended Changes to the Sprint

### Must-add (before declaring the rework "complete"):

1. **Story 12.3: Add out-of-sample holdout split.** Reserve 30% of windows (stratified by time, not random) as a holdout set. Report both in-sample and out-of-sample metrics. This is 2-3 hours of work and is the single highest-value addition to the system. Without it, every sweep result is suspect.

2. **Story 12.1 amendment: Make raw Sharpe the primary metric.** The current AC allows ambiguity about which Sharpe is "primary." Explicitly specify that `result.metrics.sharpe` = raw Sharpe, and `result.metrics.sharpeAnnualized` = the new correctly-annualized value.

3. **Story 10.2 amendment: Pre-compute `_ms` in `buildWindowTimelinePg()`.** The current implementation uses `new Date()` in the sort comparator. Add `_ms: new Date(a.timestamp).getTime()` to each event during construction and sort by `_ms` instead. This is a 5-line change that eliminates repeated Date parsing in the hot path.

### Should-add (high value, moderate effort):

4. **Story 12.4: Minimum trade count warnings.** Flag any metric computed from fewer than 30 trades with a prominent warning. This is a 30-minute change.

5. **Story 10.3 amendment: Add `schema_version` column.** Prevents stale cache bugs after future timeline format changes.

6. **Story 10.5 amendment: Use `ON CONFLICT DO NOTHING` for race condition safety.**

### Nice-to-have (lower priority):

7. **Index optimization from performance report.** Partial index on `rtds_ticks(topic, timestamp)` for backtest topics.

8. **Adverse selection buffer.** Add a configurable "adverse selection multiplier" to the fill simulator. Default 1.0 (no adjustment), with recommended values of 1.5-2.0 for more conservative testing. This doesn't model adverse selection properly but at least lets you stress-test assumptions.

---

## Summary Table

| Story | Cassandra | Vera | Marcus | Verdict |
|-------|-----------|------|--------|---------|
| 10.1: Concurrent PG | Pool exhaustion risk | Determinism OK | Approve | Pass with minor changes |
| 10.2: L2 Data Loader | L2 data may not exist for historical windows | Query pattern correct | Compare L2 vs fallback impact | Pass with required changes |
| 10.3: PG Cache Write | No schema versioning | Byte-level equality test needed | Approve | Pass with required changes |
| 10.4: PG Cache Read | Stale cache risk | Float precision OK | Approve | Pass |
| 10.5: Auto-Build | Race condition, vague hook | Build path must match | Approve | Pass with required changes |
| 11.1: SOL/XRP Config | Write volume increase | N/A | Ship immediately | Pass |
| 11.2: Gamma Investigation | 24-hour wait; API may be dead | Compare gamma vs onchain | Lower priority | Pass with contingency |
| 11.3: Gamma Backfill | Market ID mapping unclear | NULL semantics | Lower priority | Pass with clarifications |
| 12.1: Sharpe Fix | 12x Sharpe jump is a UX bomb | i.i.d. assumption is wrong for short windows | Raw Sharpe must be primary | Pass with required changes |
| 12.2: Sweep Verification | Good smoke test | Not a statistical test | Approve | Pass |

**Bottom line:** The sprint is well-structured and addresses real problems. But it's a *plumbing* sprint, not a *trustworthiness* sprint. After this sprint, the data pipeline will be fast and complete. The metrics will be correctly computed. But the system will still lack the statistical guardrails (out-of-sample validation, trade count warnings, capacity analysis) that separate a research tool from a production trading system. The most impactful addition would be a 70/30 time-stratified train/test split -- 3 hours of work that transforms every result from "probably overfit" to "possibly real."
