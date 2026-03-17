# Architecture Review — Quant Factory Final

**Reviewer:** Winston (Lead Architect)
**Date:** 2026-03-15
**Scope:** Full system review against architecture-quant-factory.md and architecture-dashboard.md
**Status:** PASS WITH NOTES

---

## Overall Assessment

The Quant Factory has been built with strong architectural fidelity to the design documents. The core pipeline — YAML DSL, composable building blocks, pre-computed SQLite timelines, stratified sampling, factory backtester, batch runner, mutation engine, result persistence, and dashboard — is functional and well-structured. Module boundaries are clean, error handling is generally good, and the brownfield integration respects existing system boundaries.

There is one critical issue (column naming mismatch between the persister and API), several moderate items, and a set of minor items that constitute reasonable technical debt for an MVP.

**Verdict: PASS WITH NOTES** — the system is architecturally sound but requires the critical column naming fix before production use.

---

## Architecture Compliance Summary

| Architecture Decision | Compliance | Notes |
|----------------------|------------|-------|
| Decision 1: Pre-computed SQLite timelines | COMPLIANT | Schema, MessagePack, incremental builds, validation all match |
| Decision 2: Composable building blocks + YAML DSL | COMPLIANT | 7 signals, 5 filters, 3 sizers — all following the block interface |
| Decision 3: YAML DSL with sweep syntax | COMPLIANT | Parser, sweep extraction, validation all match spec |
| Decision 4: Mutation engine | COMPLIANT | Parameter perturbation, structural, crossover — all three types implemented |
| Decision 5: Batch runner with JSON manifest | COMPLIANT | Concurrency limiter, error isolation, persistence integration |
| Decision 6: Result persistence to PostgreSQL | PARTIALLY COMPLIANT | Tables created, but column naming mismatch (see Critical #1) |
| Decision 7: Stratified random sampling | COMPLIANT | Weekly stratification, seeded PRNG, proportional allocation |
| Decision 8: Strategy versioning | COMPLIANT | Lineage table, naming conventions, parent-child tracking |
| Dashboard Decision 1: REST API endpoints | COMPLIANT | All 8 endpoints implemented |
| Dashboard Decision 2: View + Panel + Chart | COMPLIANT | FactoryDashboard, DataCoverage views with component composition |
| Dashboard Decision 3: Recharts with theme | COMPLIANT | chart-theme.js with glass-morphism colors |
| Dashboard Decision 4: Custom hooks | COMPLIANT | All 6 hooks implemented in useFactoryData.js |
| Dashboard Decision 5: Vercel deployment | PARTIALLY COMPLIANT | No factory rewrite rules in vercel.json (see Moderate #4) |

---

## Issues Found

### CRITICAL

#### 1. Column naming mismatch between result-persister.js and factory-api.mjs

**Files:** `src/factory/result-persister.js` (line 20), `scripts/factory-api.mjs` (lines 143, 165)

The `result-persister.js` creates `factory_runs` with `id SERIAL PRIMARY KEY`, but the `factory-api.mjs` queries `SELECT run_id ... FROM factory_runs` and `WHERE run_id = $1`. The column is `id`, not `run_id`.

The architecture document specifies `run_id SERIAL PRIMARY KEY`. The persister deviated from the spec, and the API followed the spec — creating a runtime mismatch.

**Impact:** The factory API `/api/factory/runs` and `/api/factory/runs/:id` endpoints will throw SQL errors in production. The dashboard will show no factory data.

**Fix:** Either rename the column in `result-persister.js` DDL to `run_id` (matching the architecture), or update `factory-api.mjs` queries to use `id`. The former is preferable as it matches the spec and avoids confusion with `factory_results.id`.

---

### MODERATE

#### 2. Three separate copies of createPrng (DRY violation)

**Files:** `src/factory/sampler.js`, `src/factory/cli/backtest-factory.js`, `src/factory/mutation.js`

The mulberry32 PRNG implementation is copy-pasted into three files. This is not a bug — all three implementations are identical — but it violates DRY and creates maintenance risk if the algorithm needs to change.

**Recommendation:** Extract to a shared `src/factory/utils/prng.js` module and import from all three locations.

#### 3. maxSweepCombinations config not enforced

**Files:** `config/index.js` (line 537), `src/factory/cli/backtest-factory.js`

The config defines `maxSweepCombinations: 500` but the backtest engine generates all combinations from the sweep grid without checking this limit. A YAML strategy with `{sweep: [1..20]}` on 4 parameters would produce 160,000 combinations, effectively hanging the system.

**Recommendation:** Add a guard in `generateParamCombinations()` or `runFactoryBacktest()` that throws if the combination count exceeds `config.factory.maxSweepCombinations`.

#### 4. Vercel rewrite rules missing for factory API

**File:** `vercel.json`

The architecture document specifies adding Vercel rewrites for `/api/factory/*`. The current `vercel.json` has no API proxy rules at all — just a catch-all SPA rewrite. This means the factory API will not work in the Vercel production deployment.

**Impact:** Dashboard works in dev (Vite proxy handles it), but factory API calls will 404 in production on Vercel.

**Recommendation:** Add factory API rewrite rules to `vercel.json` or the dashboard's own Vercel config, matching the existing API proxy pattern for `/api/backtest/*`.

#### 5. Batch runner duplicates strategy loading logic

**Files:** `src/factory/batch-runner.js` (lines 55-103), `src/factory/index.js` (lines 39-70)

The batch runner has its own `loadStrategy()` function that duplicates the resolution logic in `src/factory/index.js`. The `index.js` version is more robust (handles `.yml`, better error messages, validates JS strategy exports). The batch runner version could diverge over time.

**Recommendation:** Have `batch-runner.js` import and use `loadStrategy` from `src/factory/index.js` instead of its own copy.

---

### MINOR

#### 6. Architecture specifies `compose-engine.js` and `yaml-parser.js`; built as `compose.js` and `parser.js`

**Files:** `src/factory/compose.js`, `src/factory/parser.js`

The architecture document names these files `compose-engine.js` and `yaml-parser.js`. The built code uses shorter names. This is cosmetic — the functionality is identical — but creates a documentation drift.

#### 7. Architecture specifies `block-registry.js`; built as `registry.js`

**File:** `src/factory/registry.js`

Same naming convention deviation as #6.

#### 8. Architecture specifies `FactoryRunDetail.jsx` and `StrategyLineage.jsx` as separate view files

**File:** `dashboard/src/views/FactoryDashboard.jsx`

These are implemented as inline components (`RunDetailView`, `StrategyLineageView`) within `FactoryDashboard.jsx` rather than separate files. This is an acceptable simplification — the architecture note about internal navigation via component state is correctly followed. The components could be extracted to separate files if they grow, but for now this is fine.

#### 9. `MetricSparkline.jsx` and `ConfidenceBadge.jsx` exist but are not rendered in the main factory views

**Files:** `dashboard/src/components/factory/MetricSparkline.jsx`, `dashboard/src/components/factory/ConfidenceBadge.jsx`

These components are built per the architecture but appear to have limited integration into the main views. They may be used conditionally or from drill-down views.

#### 10. CLOB mid_price filtering hardcoded to [0.05, 0.95]

**File:** `src/factory/timeline-builder.js` (lines 421-422)

The CLOB mid_price filtering (`if (mid < 0.05 || mid > 0.95) continue`) is hardcoded. This is reasonable for the current Polymarket binary options domain, but not configurable. If price ranges change, this becomes a silent data loss issue.

#### 11. `once-per-window` filter fires on first call regardless of signal quality

**File:** `src/factory/filters/once-per-window.js`

The filter returns `true` on the first call and `false` on all subsequent calls, regardless of the signal strength or direction. This means a weak signal early in the window will consume the single entry, preventing a stronger signal later. This is a known trade-off, not a bug, but worth noting.

#### 12. `ref-near-strike` signal always returns `DOWN` direction

**File:** `src/factory/signals/ref-near-strike.js` (line 42)

When polyRef is near strike, this signal always returns `direction: 'DOWN'`. This is correct for the edge-c hypothesis (CL deficit = DOWN edge), but the signal name "ref-near-strike" doesn't convey directional bias. A more descriptive name like `ref-near-strike-down` would improve clarity.

#### 13. `weighted` combine operator mentioned in architecture but not implemented

**File:** `src/factory/compose.js` (line 207)

The architecture pseudocode shows `'all-of' | 'any-of' | 'weighted'` as combine options. Only `all-of` and `any-of` were implemented. This is acceptable for MVP but should be noted as a future capability gap.

---

## Recommendations

### Immediate (pre-production)

1. **Fix the column naming mismatch** (Critical #1). Change `factory_runs` DDL to use `run_id SERIAL PRIMARY KEY` in `result-persister.js`, and update the `RETURNING id` and `WHERE id =` references. This must be done before any real factory runs are persisted, since changing column names after data exists requires a migration.

2. **Add sweep combination guard** (Moderate #3). Add a check in `generateParamCombinations()` that throws if combinations exceed `config.factory.maxSweepCombinations`. This prevents accidental system hang.

### Near-term (next sprint)

3. **Extract shared PRNG** (Moderate #2). Move `createPrng` to a shared utility module.

4. **Consolidate strategy loading** (Moderate #5). Have batch-runner use `index.js`'s `loadStrategy`.

5. **Add Vercel rewrite rules** (Moderate #4). Add `/api/factory/*` proxy rules for production deployment.

### Future

6. Implement `weighted` combine operator.
7. Make CLOB price bounds configurable.
8. Consider extracting `RunDetailView` and `StrategyLineageView` to separate files if they grow beyond ~100 lines each.

---

## Technical Debt Register

| ID | Description | Severity | Location | Effort |
|----|------------|----------|----------|--------|
| TD-1 | `createPrng` duplicated in 3 files | Low | sampler.js, backtest-factory.js, mutation.js | 30 min |
| TD-2 | File naming differs from architecture doc | Trivial | compose.js, parser.js, registry.js | N/A (doc-only) |
| TD-3 | `maxSweepCombinations` config exists but is unenforced | Medium | backtest-factory.js, config/index.js | 15 min |
| TD-4 | Duplicate strategy loading logic | Medium | batch-runner.js vs index.js | 30 min |
| TD-5 | `weighted` combine operator not implemented | Low | compose.js | 1 hr |
| TD-6 | CLOB mid_price bounds hardcoded | Low | timeline-builder.js:421 | 15 min |
| TD-7 | Vercel production proxy rules missing for factory API | Medium | vercel.json | 10 min |
| TD-8 | Column naming mismatch `id` vs `run_id` | Critical | result-persister.js, factory-api.mjs | 30 min |
| TD-9 | `useFactoryData` hooks use `JSON.stringify(filters)` as useCallback dep | Low | useFactoryData.js | 15 min |
| TD-10 | Factory API loads all lineage records for single-strategy query | Low | factory-api.mjs:285-336 | 30 min |

---

## Architecture Strengths

1. **Clean module boundaries.** The factory module (`src/factory/`) is fully isolated from `src/backtest/`. The only integration point is the `evaluateWindow()` import and the existing `MarketState` contract. Existing 73 strategies are completely untouched.

2. **Building block interface.** The `{ name, description, paramSchema, create }` pattern for blocks is consistent and extensible. Adding a new signal or filter is a single file drop.

3. **Compose engine output.** Factory-composed strategies produce the exact same `{ name, evaluate, onWindowOpen, defaults, sweepGrid }` interface as hand-coded JS strategies. They are truly interchangeable.

4. **Error handling is explicit.** Descriptive error messages throughout (parser, registry, compose engine). Block reference errors list available alternatives. YAML validation catches typos with unknown-key detection.

5. **Data pipeline validation.** The timeline builder validates data quality at build time and stores quality metadata. The backtester can use quality flags to filter unreliable windows.

6. **Mutation engine with semantic bounds.** Parameter perturbation respects domain-specific bounds (prices stay in [0,1], capital stays positive, times stay positive). This prevents generating nonsensical variants.

7. **Dashboard hooks.** The `useFactoryData.js` hooks follow the exact same pattern as the existing dashboard, including polling for running batch jobs.

---

*Review completed 2026-03-15. Signed off by Winston, Lead Architect.*
