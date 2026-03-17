---
status: complete
completedAt: '2026-03-14'
inputDocuments:
  - prd-quant-factory.md
  - architecture-quant-factory.md
  - epics-quant-factory.md
  - architecture-dashboard.md
  - dashboard/src/App.jsx
  - dashboard/src/views/BacktestReview.jsx
project_name: 'poly'
user_name: 'Matthew'
date: '2026-03-14'
scope: 'Phase 2 — Backtest Results Dashboard (read-only)'
---

# poly — Backtest Results Dashboard Epic Breakdown

## Overview

This document breaks down the read-only Backtest Results Dashboard into implementable epics and stories. The dashboard extends the existing Vite + React + Tailwind dashboard at `dashboard/` with new views for browsing, comparing, and visualizing Quant Factory results stored in `factory_runs`, `factory_results`, and `strategy_lineage`.

**Scope:** Read-only viewer. No backtest triggering, no strategy creation, no mutations.

**Backend dependency:** All stories depend on the factory database tables existing (created by backend Epics 3 and 4). Stories can be developed against seed data or mocked API responses before the backend is complete.

## Testing Philosophy

### Continuous Quality Gates

Same philosophy as the backend epics. Every story must satisfy:

1. **Unit tests** — component renders correctly with given props, hooks return expected state
2. **Integration tests** — component fetches from API, transforms data, and renders correctly
3. **Regression gate** — all previously passing dashboard tests still pass

### Agent-Interpretable Tests

Test failures should explain domain context:

Bad: `Expected element to have text content "1.8"`
Good: `Leaderboard row for "deficit-asymmetry-v1" should display Sharpe 1.8 from metrics.sharpe, but rendered "undefined" — check that the metrics JSONB field is being destructured correctly`

### Test Infrastructure

- **Vitest + React Testing Library** — component unit tests (matches existing dashboard test setup)
- **MSW (Mock Service Worker)** — mock `/api/factory/*` endpoints for integration tests without a running backend
- **Seed data fixtures** — JSON files with realistic factory_runs, factory_results, and strategy_lineage data for tests and development
- **Visual snapshot tests** — optional, for chart components where pixel-level output matters

### Test Directory Structure

```
dashboard/src/__tests__/factory/
  unit/           # Component rendering tests
  integration/    # Full view tests with mocked API
  fixtures/       # Seed data JSON files
```

---

## Epic List

### Epic 6: Factory API Endpoints

Express server endpoints that query `factory_runs`, `factory_results`, and `strategy_lineage` tables, serving data to the dashboard.
**PRD traceability:** Journey 2 (The Harvest) — dashboard review of factory results
**Backend dependency:** Epic 3 (tables exist), Epic 4 (lineage table exists)

### Epic 7: Factory Dashboard Core Views

The main factory dashboard view with leaderboard, run history, and drill-down into run details and strategy lineage.
**PRD traceability:** Journey 2 — strategy candidate cards, leaderboard, full lineage view, comparison tables

### Epic 8: Visualization Components

Charts and visual components for regime breakdowns, cross-symbol comparisons, parameter importance, and convergence tracking.
**PRD traceability:** Journey 2 — regime breakdown visualizations, cross-symbol comparison

### Epic 9: Data Coverage View

A dedicated view showing which symbols have data, date ranges, L2 availability, and quality metrics.
**PRD traceability:** FR38 (data coverage reporting)

---

## Epic 6: Factory API Endpoints

Matthew can view factory backtest results in the dashboard because the Express server exposes clean REST endpoints that query the factory database tables.

### Story 6.1: Factory Runs List Endpoint

As a dashboard viewer,
I want to fetch a list of all factory runs,
So that I can see run history with status, timestamps, and summaries.

**Depends on:** Backend Epic 3 (factory_runs table exists)

**Acceptance Criteria:**

**Given** the Express server is running and `factory_runs` table exists
**When** `GET /api/factory/runs` is called
**Then** it returns JSON with `{ ok: true, data: { runs: [...] }, meta: { total, limit, offset } }`
**And** each run includes: `run_id`, `manifest_name`, `status`, `started_at`, `completed_at`, `wall_clock_ms`, `total_runs`, `completed_runs`, `summary`, `error_message`
**And** runs are sorted by `started_at` descending (newest first)
**And** `?limit=N&offset=M` pagination works
**And** `?status=completed` filters by status
**And** a test with seed data verifies correct response shape and sorting
**And** the endpoint is registered in the existing Express router file

### Story 6.2: Factory Run Detail and Results Endpoints

As a dashboard viewer,
I want to fetch all results for a specific factory run,
So that I can see per-strategy/config/symbol metrics.

**Depends on:** Story 6.1

**Acceptance Criteria:**

**Given** a factory run with `run_id=42` exists with results in `factory_results`
**When** `GET /api/factory/runs/42` is called
**Then** it returns the run metadata plus its `summary` JSONB
**When** `GET /api/factory/runs/42/results` is called
**Then** it returns all `factory_results` rows for that run
**And** each result includes: `id`, `strategy_name`, `strategy_source`, `symbol`, `config`, `sample_size`, `metrics`, `elapsed_ms`
**And** `?sort=sharpe&order=desc` sorts by a metric field extracted from the JSONB
**And** `?symbol=btc` filters by symbol
**And** `?minTrades=50` filters results where `metrics->>'trades' >= 50`
**And** integration test verifies filtering and sorting with seed data

### Story 6.3: Leaderboard Endpoint

As a dashboard viewer,
I want to fetch the top strategies across all factory runs,
So that I can see a ranked leaderboard of best-performing strategies.

**Depends on:** Story 6.1

**Acceptance Criteria:**

**Given** `factory_results` contains results from multiple runs
**When** `GET /api/factory/leaderboard` is called
**Then** it returns strategies ranked by Sharpe ratio (default), deduplicated by `strategy_name + symbol` (best result per strategy per symbol)
**And** each entry includes: `strategy_name`, `symbol`, `metrics` (full JSONB), `run_id`, `config`, `sample_size`, `created_at`
**And** `?metric=profitFactor` sorts by a different metric
**And** `?limit=25` controls result count
**And** `?minTrades=50` excludes low-sample results
**And** entries with `metrics.trades < 50` get a `lowSample: true` flag in the response
**And** integration test verifies correct ranking and deduplication

### Story 6.4: Strategy Lineage Endpoint

As a dashboard viewer,
I want to fetch the full lineage tree for a strategy,
So that I can see its mutation history, parent chain, and reasoning.

**Depends on:** Backend Epic 4 (strategy_lineage table exists)

**Acceptance Criteria:**

**Given** `strategy_lineage` contains entries for `deficit-asymmetry-v1` and its mutations
**When** `GET /api/factory/strategies/deficit-asymmetry-v1/lineage` is called
**Then** it returns the full lineage chain: the strategy itself plus all ancestors (following `parent_name`) and all descendants
**And** each entry includes: `strategy_name`, `parent_name`, `mutation_type`, `mutation_reasoning`, `created_at`, `created_by`
**And** entries are ordered to form a tree (root first, then children)
**When** `GET /api/factory/strategies/deficit-asymmetry-v1/results` is called
**Then** it returns all `factory_results` rows where `strategy_name` matches
**And** `?symbol=btc` filters by symbol
**And** integration test with a 3-generation lineage chain verifies correct tree ordering

### Story 6.5: Data Coverage and Comparison Endpoints

As a dashboard viewer,
I want to fetch data coverage information and compare strategies side-by-side,
So that I can see which symbols have data and compare strategy variants.

**Depends on:** Story 6.1

**Acceptance Criteria:**

**Given** `factory_results` contains results across multiple symbols
**When** `GET /api/factory/coverage` is called
**Then** it returns per-symbol aggregates: total results count, unique strategies tested, date range of results, average sample size
**And** if the timeline cache metadata is accessible, it also includes: total windows, L2 availability percentage, date range of cached data
**When** `GET /api/factory/compare?ids=1,2,3` is called with `factory_results` IDs
**Then** it returns the full result rows for those IDs in a `comparison` array
**And** includes a `warnings` array noting if sample sizes differ by more than 2x (FR32)
**And** integration test verifies comparison with mismatched sample sizes produces warnings

### Story 6.6: API Seed Data and Test Fixtures

As a developer,
I want seed data fixtures for all factory tables,
So that I can develop and test the dashboard without a running backend.

**Acceptance Criteria:**

**Given** the dashboard test infrastructure
**When** test fixtures are loaded
**Then** `fixtures/factory-runs.json` contains 5+ realistic factory runs (mix of completed, running, failed)
**And** `fixtures/factory-results.json` contains 30+ results across multiple strategies, symbols, and configs with realistic metrics JSONB
**And** `fixtures/strategy-lineage.json` contains a 3-generation lineage chain (original -> 3 mutations -> 2 sub-mutations)
**And** metrics JSONB in fixtures matches the schema from the architecture document (sharpe, sortino, profitFactor, regime breakdown, confidenceIntervals)
**And** a `setupMockApi()` function using MSW intercepts all `/api/factory/*` endpoints and returns fixture data
**And** fixture data is used by all integration tests in subsequent stories

---

## Epic 7: Factory Dashboard Core Views

Matthew can open the Factory tab and see a leaderboard of top strategies, browse run history, drill into a specific run to see all results, and drill into a strategy to see its full mutation lineage.

### Story 7.1: Factory Dashboard View — Navigation Integration

As a dashboard user,
I want a "Factory" tab in the navigation bar,
So that I can access factory backtest results from the main dashboard.

**Depends on:** None (can start immediately)

**Acceptance Criteria:**

**Given** the dashboard is loaded
**When** the navigation bar renders
**Then** a "Factory" tab appears after the existing "Backtest" tab
**And** clicking it loads the `FactoryDashboard` view via lazy import (matching `StrategyLab` pattern)
**And** a "Coverage" tab appears after "Factory"
**And** clicking it loads the `DataCoverage` view via lazy import
**And** both views show a loading spinner during lazy load (matching existing Suspense fallback pattern)
**And** unit test verifies both tabs render in the nav and lazy-load their views
**And** existing views continue to work — no regressions

### Story 7.2: Leaderboard Table Component

As a dashboard user,
I want a leaderboard showing the top strategies ranked by Sharpe ratio,
So that I can quickly identify the most promising backtest results.

**Depends on:** Story 6.3, Story 6.6

**Acceptance Criteria:**

**Given** the Factory view is active and leaderboard data is loaded
**When** the leaderboard renders
**Then** it displays a sortable table with columns: Rank, Strategy Name, Symbol, Sharpe, Profit Factor, Win Rate, Trades, Max Drawdown, Sample Size
**And** clicking a column header sorts by that column (ascending/descending toggle)
**And** a metric selector dropdown allows switching the primary ranking metric (Sharpe, Sortino, Profit Factor, Win Rate)
**And** a minimum trades filter (dropdown: All, 50+, 100+, 200+) filters low-sample results
**And** each row has a `ConfidenceBadge` based on trade count: <50 red "Insufficient", 50-99 orange "Low", 100-199 yellow "Moderate", 200+ green "High"
**And** positive metrics (Sharpe > 0, PF > 1, WR > 50%) use emerald color; negative use red (matching existing dashboard color conventions)
**And** clicking a strategy name triggers drill-down to strategy lineage (Story 7.5)
**And** unit test verifies rendering with fixture data, sorting, and filtering
**And** the table uses the existing `SortableHeader` pattern from `BacktestReview.jsx`

### Story 7.3: Strategy Candidate Cards

As a dashboard user,
I want strategy candidates presented as rich cards above the leaderboard,
So that I can see hypothesis origin, iteration count, and confidence at a glance.

**Depends on:** Story 7.2, Story 6.4

**PRD traceability:** Journey 2 — "Each card: hypothesis origin, iteration count, best Sharpe, trade count, confidence badge"

**Acceptance Criteria:**

**Given** the leaderboard has loaded top strategies
**When** the top 4 strategies are displayed as cards above the leaderboard table
**Then** each card shows: strategy name, hypothesis (from `strategy_lineage.mutation_reasoning` for originals, or "Mutation of {parent}" for mutations), iteration count (number of lineage entries), best Sharpe, total trades across symbols, and a `ConfidenceBadge`
**And** cards use the existing `glass` CSS class for the card container
**And** clicking a card drills into the strategy lineage view (Story 7.5)
**And** if lineage data is not available (backend Epic 4 not complete), cards gracefully degrade — show "N/A" for hypothesis and iteration count
**And** unit test verifies card rendering with and without lineage data

### Story 7.4: Run History and Run Detail Views

As a dashboard user,
I want to browse factory run history and drill into a specific run to see all its results,
So that I can review batch runs and compare strategy variants within a run.

**Depends on:** Story 6.1, Story 6.2, Story 6.6

**Acceptance Criteria:**

**Given** the Factory view shows a "Recent Runs" section below the leaderboard
**When** factory runs are loaded
**Then** a list shows each run with: date, status badge, manifest name, total strategies, wall clock time, and a summary stat (best Sharpe in run)
**And** clicking a run navigates to a detail view (component state, not URL routing — matching `BacktestReview.jsx` pattern)
**And** the detail view shows all results for that run in a `ComparisonTable`
**And** the `ComparisonTable` has columns: Strategy, Symbol, Config (key params), Sharpe, PF, Win Rate, Trades, Max DD, Edge/Trade
**And** the table is sortable by any column
**And** a symbol filter dropdown filters results by symbol
**And** a "Back to runs" button returns to the list (matching existing pattern)
**And** when a run has `status: 'running'`, the run list polls every 30 seconds for updates
**And** integration test with MSW verifies the list-to-detail navigation flow

### Story 7.5: Strategy Lineage View

As a dashboard user,
I want to see the full mutation history of a strategy,
So that I can understand how it evolved, what was tried, and why each mutation was made.

**Depends on:** Story 6.4, Story 6.6

**PRD traceability:** Journey 2 — "Full lineage: started as a mutation of X, N iterations, converged at..."

**Acceptance Criteria:**

**Given** a strategy name is selected (from leaderboard click or card click)
**When** the lineage view renders
**Then** a `LineageTree` component shows the mutation history as a vertical timeline
**And** each node shows: strategy name, mutation type badge (original/param_perturb/structural/crossover), reasoning text, created date, created by (matthew/claude)
**And** the root node (original strategy) is at the top, children below
**And** next to the lineage tree, a metrics panel shows the best result for each strategy in the lineage chain
**And** a `MetricSparkline` (Recharts `LineChart`, small) shows Sharpe progression across the lineage chain (x = iteration, y = best Sharpe)
**And** if the strategy has results across multiple symbols, a `CrossSymbolChart` (Story 8.3) appears below
**And** a "Back" button returns to the previous view
**And** if `strategy_lineage` has no data for this strategy, a message says "No lineage data available — strategy may predate the factory system"
**And** integration test verifies the 3-generation lineage chain from fixtures renders correctly

### Story 7.6: Custom Data Hooks

As a developer,
I want shared data-fetching hooks for all factory API endpoints,
So that views can fetch data consistently without duplicating fetch logic.

**Depends on:** Stories 6.1-6.5

**Acceptance Criteria:**

**Given** the hooks file `src/hooks/useFactoryData.js` is created
**When** a component calls `useFactoryRuns(filters)`
**Then** it returns `{ runs, loading, error, refetch }` with data from `GET /api/factory/runs`
**And** `useFactoryResults(runId)` fetches from `GET /api/factory/runs/:runId/results`
**And** `useLeaderboard(options)` fetches from `GET /api/factory/leaderboard`
**And** `useStrategyLineage(name)` fetches from `GET /api/factory/strategies/:name/lineage`
**And** `useDataCoverage()` fetches from `GET /api/factory/coverage`
**And** `useCompare(resultIds)` fetches from `GET /api/factory/compare?ids=...`
**And** all hooks follow the `useState` + `useEffect` + `useCallback` pattern from existing `BacktestReview.jsx`
**And** all hooks handle loading, error, and empty states
**And** unit tests verify each hook with mocked fetch

---

## Epic 8: Visualization Components

Matthew can see beautiful charts showing regime breakdowns, cross-symbol comparisons, parameter importance, and metric distributions — making factory results genuinely insightful, not just data tables.

### Story 8.1: Regime Breakdown Charts

As a dashboard user,
I want charts showing strategy performance by time-of-day, first/second half, and day-of-week,
So that I can identify regime dependencies in strategy performance.

**Depends on:** Story 6.2 (results with metrics.regime data), Story 6.6

**PRD traceability:** Journey 2 — "regime breakdown visualizations"

**Acceptance Criteria:**

**Given** a factory result is selected that has `metrics.regime` data
**When** the `RegimeBreakdown` component renders
**Then** three Recharts `BarChart` components display:
  1. **Time-of-day:** x-axis = time buckets (0-3min, 3-6min, etc.), y-axis = win rate, bars colored by PnL (green positive, red negative), trade count shown as bar labels
  2. **First/second half:** Two grouped bars comparing Sharpe, win rate, and trades between first and second half of the window period
  3. **Day-of-week:** x-axis = Mon-Sun, y-axis = Sharpe, bars colored by trade count intensity
**And** all charts use the shared `CHART_THEME` from `chart-theme.js`
**And** tooltips show exact values on hover
**And** if `metrics.regime` is missing or empty, the component renders a "No regime data" message instead of empty charts
**And** charts are responsive (resize with container)
**And** unit test verifies rendering with fixture data containing regime metrics

### Story 8.2: Comparison Table with Parameter Importance

As a dashboard user,
I want a side-by-side comparison table that highlights which parameters matter most,
So that I can understand what drives strategy performance.

**Depends on:** Story 6.5, Story 6.6

**PRD traceability:** Journey 2 — "comparison tables, parameter importance highlighting"

**Acceptance Criteria:**

**Given** multiple factory results from a sweep are displayed in `ComparisonTable`
**When** the comparison renders
**Then** each row is a result, columns show: strategy name, symbol, each config parameter, Sharpe, PF, Win Rate, Trades
**And** config parameter columns that have high variance in Sharpe across their values are highlighted with a subtle violet background (parameter importance)
**And** parameter importance is computed client-side: for each config key, compute the standard deviation of Sharpe grouped by that key's value; keys with stddev > 0.3 are "important"
**And** a horizontal `BarChart` below the table shows parameter importance scores (parameter name vs. Sharpe variance contribution)
**And** the best-performing row is highlighted with a subtle border
**And** unit test verifies parameter importance computation and highlighting logic

### Story 8.3: Cross-Symbol Comparison Chart

As a dashboard user,
I want to see the same strategy's performance across BTC/ETH/SOL/XRP,
So that I can assess cross-symbol robustness and spot symbol-specific edge.

**Depends on:** Story 6.2, Story 6.6

**PRD traceability:** FR32 — "Cross-symbol comparisons flag unequal sample sizes"

**Acceptance Criteria:**

**Given** a strategy has results across multiple symbols
**When** the `CrossSymbolChart` component renders
**Then** a grouped `BarChart` shows Sharpe, Win Rate, and Trades for each symbol side-by-side
**And** each symbol group is color-coded from the `CHART_THEME.colors.series` palette
**And** trade count is displayed as a label above each bar
**And** if sample sizes differ by more than 2x between any two symbols, a warning banner appears: "Sample sizes vary significantly across symbols — comparison may be unreliable"
**And** symbols with <50 trades get a dashed bar outline and dimmed color
**And** tooltips show full metrics per symbol
**And** unit test verifies warning banner logic and visual differentiation of low-sample symbols

### Story 8.4: Chart Theme and Shared Utilities

As a developer,
I want a consistent chart theme and shared visualization utilities,
So that all factory charts have a cohesive look matching the dashboard's dark glass aesthetic.

**Depends on:** None (can start immediately)

**Acceptance Criteria:**

**Given** a new file `src/components/factory/chart-theme.js` is created
**When** imported by chart components
**Then** it exports `CHART_THEME` with colors (primary violet, positive emerald, negative red, neutral gray, 5-color series), axis styles (white/10 stroke, white/40 tick fill, 10px font), grid styles (white/5 stroke), tooltip styles (black/80 bg, white/10 border)
**And** it exports a `CustomTooltip` React component matching the glass aesthetic (dark background, rounded corners, small text)
**And** it exports a `formatMetric(value, type)` utility that formats Sharpe to 2 decimals, win rate as percentage, PnL with `+/-$`, trades as integer
**And** unit tests verify `formatMetric` edge cases (null, undefined, NaN, 0)

### Story 8.5: Confidence Badge and Metric Sparkline Components

As a dashboard user,
I want visual indicators for statistical confidence and metric trends,
So that I can quickly assess how trustworthy a result is and how a strategy is converging.

**Depends on:** Story 8.4

**Acceptance Criteria:**

**Given** a `ConfidenceBadge` component receives a trade count
**When** rendered
**Then** it displays a colored pill badge: <50 trades = red "Insufficient", 50-99 = orange "Low", 100-199 = yellow "Moderate", 200+ = green "High"
**And** hovering shows a tooltip explaining the threshold
**And** if confidence interval data is available (`metrics.confidenceIntervals`), the badge tooltip also shows the CI width

**Given** a `MetricSparkline` component receives an array of `{ iteration, sharpe }` values
**When** rendered
**Then** it displays a small Recharts `LineChart` (120x40px) showing Sharpe progression
**And** the line uses `CHART_THEME.colors.primary`
**And** no axes or labels — just the line and a dot on the last point
**And** unit tests verify badge color mapping and sparkline rendering with various data lengths

---

## Epic 9: Data Coverage View

Matthew can open the Coverage tab and see which symbols have cached timeline data, date ranges, L2 availability, and quality metrics — so he knows what data his backtests run against.

### Story 9.1: Data Coverage View

As a dashboard user,
I want a dedicated view showing data coverage per symbol,
So that I understand which symbols have data and what quality issues exist.

**Depends on:** Story 6.5, Story 7.1

**PRD traceability:** FR38 — "Data coverage reporting per symbol (windows, L2 availability, date ranges)"

**Acceptance Criteria:**

**Given** the Coverage tab is clicked
**When** the `DataCoverage` view loads and fetches from `GET /api/factory/coverage`
**Then** a `CoverageMatrix` component displays a grid with rows = symbols (BTC, ETH, SOL, XRP) and columns = coverage metrics
**And** columns include: Total Windows, Date Range (earliest - latest), L2 Availability %, Strategies Tested, Average Sample Size
**And** L2 availability is color-coded: >80% green, 50-80% yellow, <50% red
**And** symbols with no data show a "No data" row in muted text
**And** each symbol row is clickable, expanding to show a list of quality flags (if available from the coverage API)
**And** the view uses the existing `glass` card styling
**And** integration test verifies rendering with coverage fixture data

---

## Dependency Graph

```
Story 6.6 (Seed Data / MSW)  ←── all integration tests depend on this
     ↓
Story 6.1 (Runs API)
     ↓
Story 6.2 (Results API) ──→ Story 7.4 (Run History + Detail)
     ↓
Story 6.3 (Leaderboard API) ──→ Story 7.2 (Leaderboard Table) ──→ Story 7.3 (Strategy Cards)
     ↓
Story 6.4 (Lineage API) ──→ Story 7.5 (Strategy Lineage View)
     ↓
Story 6.5 (Coverage + Compare API) ──→ Story 9.1 (Data Coverage View)
                                   ──→ Story 8.2 (Comparison + Param Importance)

Story 7.1 (Nav Integration) ← can start immediately, no API dependency
Story 7.6 (Data Hooks) ← can start after Stories 6.1-6.5
Story 8.4 (Chart Theme) ← can start immediately
Story 8.5 (Badge + Sparkline) ← depends on 8.4
Story 8.1 (Regime Breakdown) ← depends on 6.2, 8.4
Story 8.3 (Cross-Symbol Chart) ← depends on 6.2, 8.4
```

## Parallelization Plan

Three workstreams can proceed in parallel:

| Stream | Stories | Notes |
|--------|---------|-------|
| **API** | 6.6 → 6.1 → 6.2 → 6.3 → 6.4 → 6.5 | Backend Express endpoints |
| **UI Shell** | 7.1 → 7.6 → 7.2 → 7.3 → 7.4 | Nav, hooks, core views (can use MSW mocks) |
| **Visualizations** | 8.4 → 8.5 → 8.1 → 8.2 → 8.3 | Chart theme, then chart components |

Story 7.5 (Lineage View) and 9.1 (Coverage View) join after their API dependencies are complete.

---

## Integration Test Matrix (Cross-Epic)

| When this completes... | Integration test validates... |
|---|---|
| Epic 6 (API) | All endpoints return correct data shape from seed database |
| Epic 7 (Core Views) | Full navigation flow: Factory tab → leaderboard → click strategy → lineage view → back |
| Epic 7 + 8 (Views + Charts) | Run detail view renders comparison table AND regime charts for a result with full metrics |
| Epic 6 + 7 (API + Views) | End-to-end with MSW: fetch leaderboard → render top 25 → sort by PF → filter 100+ trades → verify results |
| Epic 9 (Coverage) | Coverage view renders matrix with correct color coding for L2 availability thresholds |
| All Epics | Full integration: navigate every view, verify no console errors, verify all data renders |

---

## FR Coverage Map (Dashboard-Relevant FRs)

| FR | Epic/Story | Dashboard Implementation |
|----|-----------|------------------------|
| FR26 | Epic 6 (Stories 6.1-6.4) | Historical results queryable via API endpoints |
| FR28 | Epic 7 (Story 7.2, 7.4), Epic 8 (Story 8.1) | Metrics displayed in leaderboard, comparison tables, regime charts |
| FR29 | Epic 8 (Story 8.5) | Confidence badges and CI display |
| FR31 | Epic 8 (Story 8.2) | Variant ranking with parameter importance highlighting |
| FR32 | Epic 8 (Story 8.3) | Cross-symbol comparison with sample size warnings |
| FR38 | Epic 9 (Story 9.1) | Data coverage reporting in dedicated view |
