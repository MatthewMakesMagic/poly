---
workflowType: 'architecture'
status: 'complete'
completedAt: '2026-03-14'
inputDocuments:
  - prd-quant-factory.md
  - architecture-quant-factory.md
  - epics-quant-factory.md
  - dashboard/src/App.jsx
  - dashboard/src/views/BacktestReview.jsx
  - dashboard/vite.config.js
  - dashboard/package.json
project_name: 'poly'
user_name: 'Matthew'
date: '2026-03-14'
scope: 'Phase 2 — Backtest Results Dashboard (read-only)'
---

# Architecture Decision Document — Backtest Results Dashboard

**Author:** Matthew
**Date:** 2026-03-14
**Project:** poly (brownfield extension)
**Scope:** Phase 2 — Read-only dashboard for viewing Quant Factory backtest results

---

## Project Context

The Quant Factory MVP (Phase 1) produces structured backtest results persisted to PostgreSQL in three tables: `factory_runs`, `factory_results`, and `strategy_lineage`. The dashboard extends the existing Vite + React + Tailwind dashboard at `dashboard/` with new views for browsing, comparing, and visualizing these results.

This is a **read-only viewer**. It does not run backtests, create strategies, or mutate anything. It reads from the factory tables and presents results beautifully.

### Existing Dashboard Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Build | Vite 6 | `vite.config.js` with proxy to `:3333` |
| Framework | React 18 | Functional components, hooks, `useState`/`useEffect` |
| Styling | Tailwind CSS 3 | Glass morphism theme, dark mode, `glass` and `glass-subtle` utility classes |
| Charts | Recharts 2.15 | Already a dependency, used in existing views |
| Data | REST API via `/api/*` | Vite dev proxy to `localhost:3333`, Vercel proxy in production |
| State | Component-local | No Redux/Zustand — each view manages its own state via hooks |
| Routing | Tab-based | `App.jsx` uses `activeView` state, no React Router |
| Deployment | Vercel | `vercel.json` exists, static build + API proxy |

### Data Source Tables

```sql
-- Batch run metadata
factory_runs (
    run_id SERIAL PRIMARY KEY,
    manifest_name TEXT,
    manifest_json JSONB,
    status TEXT,            -- running, completed, failed
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    wall_clock_ms INTEGER,
    total_runs INTEGER,
    completed_runs INTEGER,
    summary JSONB,          -- ranking, best config
    error_message TEXT
)

-- Per-strategy/config/symbol results
factory_results (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES factory_runs,
    strategy_name TEXT,
    strategy_yaml TEXT,
    strategy_source TEXT,   -- 'yaml' or 'js'
    symbol TEXT,
    config JSONB,           -- strategy config used
    sample_size INTEGER,
    sample_seed INTEGER,
    metrics JSONB,          -- sharpe, pf, winRate, trades, maxDrawdown, expectancy, edgePerTrade, regime breakdown
    trades_summary JSONB,
    created_at TIMESTAMPTZ,
    elapsed_ms INTEGER
)

-- Version history and mutation reasoning
strategy_lineage (
    id SERIAL PRIMARY KEY,
    strategy_name TEXT,
    parent_name TEXT,
    mutation_type TEXT,     -- original, param_perturb, structural, crossover
    mutation_reasoning TEXT,
    yaml_definition TEXT,
    created_at TIMESTAMPTZ,
    created_by TEXT          -- 'matthew' or 'claude'
)
```

---

## Architecture Decisions

### Decision 1: API Layer — Extend Existing Express Server

**Decision:** Add new REST endpoints under `/api/factory/*` on the existing Express server at `localhost:3333`. The dashboard fetches data via these endpoints, consistent with the existing `/api/backtest/*` pattern.

**Endpoints:**

| Endpoint | Purpose | Query Params |
|----------|---------|-------------|
| `GET /api/factory/runs` | List all factory runs | `?limit=50&offset=0&status=completed` |
| `GET /api/factory/runs/:runId` | Single run detail with summary | |
| `GET /api/factory/runs/:runId/results` | All results for a run | `?sort=sharpe&order=desc&symbol=btc` |
| `GET /api/factory/leaderboard` | Top strategies across all runs | `?metric=sharpe&limit=25&minTrades=50` |
| `GET /api/factory/strategies/:name/lineage` | Full lineage tree for a strategy | |
| `GET /api/factory/strategies/:name/results` | All results for a strategy across runs | `?symbol=btc` |
| `GET /api/factory/coverage` | Data coverage summary per symbol | |
| `GET /api/factory/compare` | Side-by-side comparison | `?ids=1,2,3` (factory_results IDs) |

**Response format:** All endpoints return JSON matching the existing API conventions:
```json
{
  "ok": true,
  "data": { ... },
  "meta": { "total": 100, "limit": 50, "offset": 0 }
}
```

**Rationale:**
- The existing dashboard already proxies `/api/*` to `localhost:3333` (Vite dev) and via Vercel rewrites (production)
- The existing `BacktestReview.jsx` view already fetches from `/api/backtest/runs` — this is the established pattern
- Direct PostgreSQL from the browser is not viable (security, connection pooling, CORS)
- A separate API service would add deployment complexity for no benefit
- Express endpoints are trivial to implement — each is a single SQL query against the factory tables

### Decision 2: Component Architecture — View + Panel + Chart Pattern

**Decision:** Follow the existing dashboard's component hierarchy. New views are added as lazy-loaded tabs in `App.jsx`. Each view composes panels (data sections) and charts (visualizations).

**New views:**

```
src/views/
  FactoryDashboard.jsx      — Main entry: leaderboard + recent runs
  FactoryRunDetail.jsx       — Single run: all results, comparison table
  StrategyLineage.jsx        — Single strategy: mutation tree, version history
  DataCoverage.jsx           — Symbol coverage, date ranges, L2 availability

src/components/factory/
  StrategyCard.jsx           — Candidate card (hypothesis, Sharpe, trades, confidence)
  LeaderboardTable.jsx       — Sortable/filterable top strategies
  ComparisonTable.jsx        — Side-by-side variant comparison
  RegimeBreakdown.jsx        — Time-of-day, first/second half, day-of-week charts
  CrossSymbolChart.jsx       — Same strategy across symbols with sample size warnings
  LineageTree.jsx            — Vertical mutation history with reasoning
  MetricSparkline.jsx        — Small inline metric visualization
  RunHistoryList.jsx         — List of batch runs with status badges
  CoverageMatrix.jsx         — Symbol x data-type availability grid
  ConfidenceBadge.jsx        — Sample size / statistical confidence indicator
```

**Navigation:** Add two new tabs to the existing `VIEWS` array in `App.jsx`:
- `factory` — "Factory" — main factory dashboard (leaderboard + runs)
- `coverage` — "Coverage" — data coverage view

The Factory view handles internal navigation (run detail, strategy lineage) via component state, matching the existing `BacktestReview.jsx` pattern of `selectedRun` state.

**Rationale:**
- Matches the existing tab-based navigation — no React Router needed
- Lazy loading keeps initial bundle small (existing pattern with `StrategyLab` and `BacktestReview`)
- Component-local state is sufficient — each view fetches its own data, no cross-view state sharing needed
- The existing `BacktestReview.jsx` already demonstrates the list-to-detail pattern; factory views follow the same approach

### Decision 3: Charting — Recharts with Custom Theme

**Decision:** Use Recharts (already installed, v2.15) for all visualizations. Build a thin theme layer that applies the existing glass-morphism dark aesthetic consistently.

**Chart types needed:**

| Visualization | Recharts Component | Data Source |
|--------------|-------------------|-------------|
| Regime breakdown (time-of-day) | `BarChart` | `metrics.regime.timeOfDay` from `factory_results` |
| Regime breakdown (first/second half) | `BarChart` | `metrics.regime.halfSplit` |
| Regime breakdown (day-of-week) | `BarChart` | `metrics.regime.dayOfWeek` |
| Cross-symbol comparison | `BarChart` grouped | `factory_results` grouped by symbol |
| Metric distribution | `BarChart` histogram | Aggregate across results |
| Strategy convergence | `LineChart` | Lineage chain ordered by iteration |
| Parameter importance | `BarChart` horizontal | Computed from sweep results variance |

**Theme constants:**
```javascript
// src/components/factory/chart-theme.js
export const CHART_THEME = {
  colors: {
    primary: '#8b5cf6',    // violet
    positive: '#34d399',   // emerald
    negative: '#f87171',   // red
    neutral: '#6b7280',    // gray
    series: ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#14b8a6'],
  },
  axis: { stroke: 'rgba(255,255,255,0.1)', tick: { fill: 'rgba(255,255,255,0.4)', fontSize: 10 } },
  grid: { stroke: 'rgba(255,255,255,0.05)' },
  tooltip: { bg: 'rgba(0,0,0,0.8)', border: 'rgba(255,255,255,0.1)' },
};
```

**Rationale:**
- Recharts is already installed — zero new dependencies for charting
- It handles responsive sizing, tooltips, and animations out of the box
- A shared theme object ensures visual consistency across all factory charts
- Recharts' declarative API matches React patterns well

### Decision 4: Data Fetching — Custom Hooks with SWR-like Caching

**Decision:** Build lightweight custom hooks for factory data fetching. No SWR/React Query dependency — keep it simple with `useState` + `useEffect` + manual cache, matching the existing dashboard pattern.

**Hooks:**

```javascript
// src/hooks/useFactoryData.js
export function useFactoryRuns(filters)       // returns { runs, loading, error, refetch }
export function useFactoryResults(runId)      // returns { results, loading, error }
export function useLeaderboard(options)       // returns { strategies, loading, error }
export function useStrategyLineage(name)      // returns { lineage, loading, error }
export function useDataCoverage()             // returns { coverage, loading, error }
export function useCompare(resultIds)         // returns { comparison, loading, error }
```

**Polling:** Optional 30-second polling on the runs list when any run has `status: 'running'`. Stops when all visible runs are completed. No WebSocket needed — factory runs are batch jobs, not real-time.

**Rationale:**
- The existing dashboard uses raw `useState` + `useEffect` + `fetch` (see `BacktestReview.jsx`) — no external data-fetching library
- Adding React Query or SWR for a read-only dashboard is unnecessary complexity
- A shared hook file centralizes fetch logic without introducing a state management layer
- Polling only when needed avoids unnecessary network traffic

### Decision 5: Deployment — Vercel (Existing)

**Decision:** Deploy alongside the existing dashboard on Vercel. The factory API endpoints are served by the same Express server on Railway that handles `/api/backtest/*`.

**Architecture:**

```
Browser (Vercel static)
    ↓  /api/factory/*
Vercel Rewrites (vercel.json)
    ↓
Railway Express Server
    ↓  SQL queries
PostgreSQL (Railway)
    → factory_runs, factory_results, strategy_lineage
```

**Vercel config additions:**
```json
{
  "rewrites": [
    { "source": "/api/factory/:path*", "destination": "https://poly-api.railway.app/api/factory/:path*" }
  ]
}
```

**Rationale:**
- The existing dashboard is already on Vercel — adding new views requires zero deployment changes
- API proxy pattern is already established for `/api/backtest/*`
- No new infrastructure, no new costs, no new CI/CD pipelines

### Decision 6: No Client-Side State Management Library

**Decision:** No Redux, Zustand, Jotai, or similar. Each view manages its own state via React hooks. Shared data (like leaderboard metric selection) lives in the parent component and passes down as props.

**Rationale:**
- The existing dashboard has zero state management libraries and works fine
- Each factory view is self-contained — there is no cross-view state to synchronize
- The most complex state is "which strategy am I drilling into" — trivially handled by `useState`
- Adding a state library would be the only architecture decision that breaks from established patterns

---

## Component Hierarchy

```
App.jsx
├── HealthBar
├── Nav (add 'Factory' and 'Coverage' tabs)
│
├── FactoryDashboard (lazy)
│   ├── LeaderboardTable
│   │   └── StrategyCard (hover/click → drill)
│   ├── RunHistoryList
│   │   └── StatusBadge (reuse existing)
│   │
│   ├── [drilled into run] FactoryRunDetail
│   │   ├── ComparisonTable
│   │   ├── RegimeBreakdown
│   │   └── CrossSymbolChart
│   │
│   └── [drilled into strategy] StrategyLineage
│       ├── LineageTree
│       ├── MetricSparkline (convergence over iterations)
│       └── ConfidenceBadge
│
└── DataCoverage (lazy)
    └── CoverageMatrix
```

---

## Key Implementation Notes

### Metrics JSONB Structure

The `metrics` column in `factory_results` contains the full metrics suite from FR28. Dashboard components should expect:

```json
{
  "sharpe": 1.8,
  "sortino": 2.1,
  "profitFactor": 2.3,
  "maxDrawdown": 0.08,
  "winRate": 0.62,
  "trades": 142,
  "expectancy": 0.32,
  "edgePerTrade": 0.045,
  "totalPnl": 45.20,
  "regime": {
    "firstHalf": { "sharpe": 1.9, "trades": 71, "winRate": 0.63 },
    "secondHalf": { "sharpe": 1.7, "trades": 71, "winRate": 0.61 },
    "timeOfDay": [
      { "bucket": "0-3min", "trades": 28, "winRate": 0.64, "pnl": 12.5 },
      { "bucket": "3-6min", "trades": 35, "winRate": 0.60, "pnl": 10.2 }
    ],
    "dayOfWeek": [
      { "day": "Mon", "trades": 22, "sharpe": 2.1 },
      { "day": "Tue", "trades": 20, "sharpe": 1.5 }
    ]
  },
  "confidenceIntervals": {
    "sharpe": { "lower": 1.2, "upper": 2.4, "level": 0.95 },
    "winRate": { "lower": 0.55, "upper": 0.69, "level": 0.95 }
  }
}
```

### Confidence Badges

Derived client-side from trade count and metric confidence intervals:

| Trade Count | Badge | Color |
|------------|-------|-------|
| < 50 | Insufficient | Red |
| 50-99 | Low | Orange |
| 100-199 | Moderate | Yellow |
| 200+ | High | Green |

Additional flags from confidence interval width and in-sample/out-of-sample divergence.

### Parameter Importance Highlighting

For comparison tables showing sweep results, parameter importance is computed client-side:
1. Group results by each parameter value
2. Compute variance of Sharpe across parameter values
3. Parameters with highest variance get highlighted — they matter most

### Cross-Symbol Sample Size Warnings

When comparing the same strategy across symbols, display a warning banner if sample sizes differ by more than 2x. This implements FR32 visually.

---

## Dependencies

### New npm Dependencies

None required. The existing stack (React 18, Recharts 2.15, Tailwind 3) covers all needs.

### Backend Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `factory_runs` table | Created by Epic 3 (backend) | Must exist before dashboard can display runs |
| `factory_results` table | Created by Epic 3 (backend) | Must exist before dashboard can display results |
| `strategy_lineage` table | Created by Epic 4 (backend) | Must exist before lineage view works |
| `/api/factory/*` endpoints | New (this epic) | Added to existing Express server |

### Deployment Dependencies

- Vercel rewrite rules updated for `/api/factory/*`
- Railway Express server updated with factory API routes

---

## What This Architecture Does NOT Include

- **No backtest triggering** — this is a viewer, not a control plane
- **No strategy creation or editing** — read-only
- **No WebSocket connections** — factory results are batch, not real-time
- **No authentication** — single-user system, same as existing dashboard
- **No React Router** — tab-based navigation, same as existing
- **No state management library** — component-local state, same as existing
- **No new CSS framework** — Tailwind with existing glass-morphism theme
- **No new charting library** — Recharts already installed
