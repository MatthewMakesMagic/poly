---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
workflowType: 'architecture'
lastStep: 8
status: 'complete'
completedAt: '2026-03-14'
inputDocuments:
  - prd-quant-factory.md
  - architecture.md
  - src/backtest/parallel-engine.js
  - src/backtest/simulator.js
  - src/backtest/data-loader.js
  - src/backtest/data-loader-sqlite.js
  - src/backtest/market-state.js
  - src/backtest/engine.js
  - src/backtest/fast-engine.js
  - src/backtest/metrics.js
  - src/backtest/reporter.js
  - src/backtest/strategies/*.js
  - config/index.js
  - scripts/backtest.mjs
  - scripts/run-all-strategies-fast.mjs
project_name: 'poly'
user_name: 'Matthew'
date: '2026-03-14'
---

# Architecture Decision Document — Quant Factory

**Author:** Matthew
**Date:** 2026-03-14
**Project:** poly (brownfield extension)
**Scope:** MVP — Turbo Backtester + Strategy Factory + Batch Runner

---

## Project Context Analysis

### Requirements Overview

The Quant Factory is a research automation layer added to an existing, deployed quantitative trading platform. The v1 system already has: 73 hand-coded JS strategies, a parallel backtester, data loaders for PostgreSQL and SQLite, an event-replay simulator, and comprehensive market state management.

**Functional Requirements (42 FRs across 6 areas):**

| Area | FRs | Architectural Implication |
|------|-----|--------------------------|
| Strategy Definition | FR1-9 | YAML DSL parser, compose engine, building block library |
| Strategy Mutation & Versioning | FR10-15 | Mutation engine, lineage tracking, structured diffs |
| Backtesting | FR16-24 | Timeline cache, sampling, sweep, batch runner |
| Result Management | FR25-32 | PostgreSQL persistence, structured JSON, CLI tables |
| Data Pipeline | FR33-38 | Pre-computed timelines, validation, incremental builds |
| System Compatibility | FR39-42 | Existing 73 strategies unchanged, same MarketState |

**Non-Functional Requirements (18 NFRs):**

| Category | Key Targets | Architectural Impact |
|----------|-------------|---------------------|
| Performance | <500ms single backtest, <5s 16-combo sweep, <60s 100-combo batch | Pre-computed local timelines, SQLite cache, zero-copy slicing |
| Data Integrity | Bit-identical to DB queries, deterministic reproducibility | Validation on cache build, seeded random sampling |
| Compatibility | ES Modules, Node.js 22, existing strategy interface | Factory output must match `{ name, evaluate, defaults, sweepGrid }` |
| Maintainability | Each building block independently testable | Unit tests per signal/filter/sizer, YAML parser test suite |

### Scale & Complexity

- **Primary domain:** Research automation / computational pipeline
- **Complexity level:** High (combinatorial strategy space, simulation fidelity, data pipeline correctness)
- **User scale:** Single user (Matthew) via Claude Code
- **Brownfield context:** Must integrate with existing `src/backtest/`, `src/modules/`, `src/persistence/`, `config/`

### Technical Constraints

1. **Node.js 22, ES Modules** — all existing code uses ESM `import/export`
2. **PostgreSQL on Railway** — production data store, ~50M+ rows across tick tables
3. **SQLite local cache** — `data/backtest.sqlite` via `better-sqlite3` for fast local backtests
4. **Vitest** — existing test framework (3031 passing tests)
5. **Existing strategy interface** — `{ name, evaluate(state, config), onWindowOpen?, onWindowClose?, defaults, sweepGrid }`
6. **MarketState** — the canonical state object strategies receive (chainlink, polyRef, clobUp/Down, exchanges, window context)

---

## Starter Template Evaluation

### Primary Technology Domain

**Backend computational pipeline** — no UI, no web server, CLI via Claude Code.

### Brownfield Approach

No starter template. This project extends the existing `poly/` codebase. All new code lives alongside existing modules and follows established patterns:

- **Module structure:** `src/` with kebab-case directories
- **Config:** `config/index.js` (frozen singleton)
- **Persistence:** `src/persistence/index.js` (PostgreSQL via `pg`)
- **Data loading:** `src/backtest/data-loader.js` (PG) and `src/backtest/data-loader-sqlite.js` (SQLite)
- **Testing:** Vitest, co-located `__tests__/` directories

### Technology Stack (Existing + New)

| Layer | Technology | Status |
|-------|------------|--------|
| Runtime | Node.js 22 | Existing |
| Language | JavaScript (ES Modules) | Existing |
| Database | PostgreSQL (Railway) | Existing |
| Local Cache | SQLite (better-sqlite3) | Existing |
| Testing | Vitest | Existing |
| YAML Parsing | `js-yaml` | **New dependency** |
| CLI | Scripts in `scripts/` | Existing pattern |

---

## Core Architectural Decisions

### Decision 1: Data Pipeline — Pre-Computed SQLite Timelines

**Decision:** Build pre-computed, per-window timeline files in SQLite as the primary data source for backtesting. PostgreSQL is the source of truth; SQLite is the fast cache.

**Current state:** The backtester loads data from PostgreSQL over the network (slow: 3-10s per symbol) or from a bulk SQLite export (fast but monolithic). The `data-loader-sqlite.js` already demonstrates the SQLite path with `better-sqlite3`.

**Architecture:**

```
PostgreSQL (Railway)
    ↓  [pipeline build command]
SQLite (data/timelines.sqlite)
    ↓  [binary search slicing]
Pre-merged timeline arrays in memory
    ↓  [evaluateWindow()]
Strategy evaluation
```

**Timeline table schema:**

```sql
CREATE TABLE timelines (
    window_id TEXT NOT NULL,          -- "btc-2026-03-01T12:15:00Z"
    symbol TEXT NOT NULL,
    window_close_time TEXT NOT NULL,
    window_open_time TEXT NOT NULL,
    ground_truth TEXT,                -- 'UP' or 'DOWN'
    strike_price REAL,
    oracle_price_at_open REAL,
    chainlink_price_at_close REAL,
    timeline BLOB NOT NULL,           -- MessagePack-encoded sorted events
    event_count INTEGER NOT NULL,
    data_quality TEXT,                -- JSON: { rtds_count, clob_count, exchange_count, l2_count, gaps: [] }
    built_at TEXT NOT NULL,
    PRIMARY KEY (window_id)
);

CREATE INDEX idx_timelines_symbol ON timelines(symbol);
CREATE INDEX idx_timelines_close ON timelines(window_close_time);
```

**Why MessagePack for timeline BLOB:** The timeline for a single window is 200-2000 events. MessagePack serialization is 2-3x faster than JSON.parse and produces smaller blobs. The `msgpackr` package (already compatible with better-sqlite3) handles this.

**Why not just keep using the existing SQLite loader:** The current `data-loader-sqlite.js` queries 5 separate tables per window and merges them in JS. Pre-computing the merged timeline eliminates this per-window work entirely.

**Performance budget:**
- Timeline deserialize: ~0.5ms per window (MessagePack)
- Window evaluation: ~1-5ms (existing `evaluateWindow()` perf)
- Total for 1 window: <10ms
- Total for 200 sampled windows: <2s
- NFR1 (<500ms single run) achieved with ~50 windows sample

**Rationale:**
- SQLite read is ~100x faster than PG over network
- Pre-merged timelines eliminate per-window query overhead
- Binary data (MessagePack) is faster to deserialize than JSON/CSV
- Validation happens once at build time, not every backtest
- Incremental builds: only add new windows since last build

**New dependency:** `msgpackr` (fast MessagePack encode/decode, ~80KB, zero native deps)

---

### Decision 2: Strategy Factory — Composable Building Blocks + YAML DSL

**Decision:** A library of composable building blocks (signals, filters, sizers) that can be assembled via YAML or JS. The compose engine produces a standard strategy object identical to hand-coded JS strategies.

**Strategy interface contract (unchanged):**

```javascript
{
  name: string,
  evaluate: (state: MarketState, config: Object) => Signal[],
  onWindowOpen?: (state: MarketState, config: Object) => void,
  onWindowClose?: (state: MarketState, windowResult: Object, config: Object) => void,
  defaults: Object,
  sweepGrid?: Object,
}
```

**Signal format (unchanged):**

```javascript
{
  action: 'buy' | 'sell',
  token: string,           // e.g. 'btc-down'
  capitalPerTrade: number,  // dollar amount
  reason: string,
  confidence?: number,
}
```

**Building block types:**

| Type | Purpose | Interface |
|------|---------|-----------|
| **Signal** | Generates directional conviction | `(state, config) => { direction: 'UP'|'DOWN'|null, strength: 0-1, reason: string }` |
| **Filter** | Gates entry (time, price, cooldown) | `(state, config, signalResult) => boolean` |
| **Sizer** | Determines position size | `(state, config, signalResult) => { capitalPerTrade: number }` |

**Compose engine pseudocode:**

```javascript
function compose(definition) {
  const signals = definition.signals.map(s => loadBlock('signal', s));
  const filters = definition.filters.map(f => loadBlock('filter', f));
  const sizer = loadBlock('sizer', definition.sizer);
  const combiner = definition.combine || 'all-of'; // 'all-of' | 'any-of' | 'weighted'

  return {
    name: definition.name,
    defaults: definition.params || {},
    sweepGrid: definition.sweep || {},

    evaluate(state, config) {
      // 1. Evaluate all signals
      const results = signals.map(s => s(state, config));

      // 2. Combine signals
      const combined = combine(results, combiner);
      if (!combined.direction) return [];

      // 3. Apply filters (all must pass)
      for (const filter of filters) {
        if (!filter(state, config, combined)) return [];
      }

      // 4. Size the position
      const size = sizer(state, config, combined);

      // 5. Return standard signal
      const token = `${state.window.symbol}-${combined.direction.toLowerCase() === 'up' ? 'up' : 'down'}`;
      return [{
        action: 'buy',
        token,
        capitalPerTrade: size.capitalPerTrade,
        reason: combined.reason,
        confidence: combined.strength,
      }];
    },

    onWindowOpen(state, config) {
      // Reset per-window state in all blocks
      for (const s of signals) if (s.reset) s.reset();
      for (const f of filters) if (f.reset) f.reset();
    },
  };
}
```

**Rationale:**
- Composable blocks cover ~80% of strategy patterns seen in the existing 73 strategies
- JS escape hatch ensures no expressiveness ceiling
- Same interface means factory strategies and JS strategies are interchangeable everywhere
- Sweep syntax in YAML makes parameter exploration declarative

---

### Decision 3: YAML DSL — Declarative Strategy Definitions

**Decision:** YAML files define strategies using building block names and embedded sweep syntax. Parsed by `js-yaml`, validated against a schema, then passed to the compose engine.

**Example YAML:**

```yaml
name: deficit-asymmetry-v1
description: "Buys DOWN when CL deficit is large and polyRef is near strike"
version: 1
hypothesis: "Chainlink structural lag creates persistent DOWN edge"

signals:
  - type: chainlink-deficit
    params:
      threshold: {sweep: [60, 80, 100, 120]}

  - type: ref-near-strike
    params:
      threshold: 100

combine: all-of

filters:
  - type: time-window
    params:
      entryWindowMs: {sweep: [60000, 120000]}

  - type: max-price
    params:
      maxPrice: 0.65
      side: down

  - type: once-per-window

sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2

params:
  deficitThreshold: 80
  nearStrikeThreshold: 100
```

**Sweep syntax:** `{sweep: [val1, val2, ...]}` embedded in any param. The YAML parser extracts these into a `sweepGrid` object for the parallel sweep engine.

**YAML validation rules:**
- `name` required, must be unique
- `signals` must have at least one entry
- All `type` references must resolve to registered building blocks
- `sweep` values must be arrays of the same type
- Unknown keys are errors (catch typos)

---

### Decision 4: Mutation Engine — Parameter + Structural Mutations

**Decision:** Claude Code generates mutations, not an autonomous engine. The system provides the infrastructure (structured diffs, lineage tracking), Claude Code provides the intelligence.

**Mutation types:**

1. **Parameter perturbation:** Vary numeric params by +/- 10%, 20%, 50%. Claude Code calls a utility function that returns N variants.
2. **Structural mutation:** Add/remove a signal or filter. Claude Code edits the YAML directly, guided by the block library.
3. **Crossover:** Combine signals from strategy A with filters from strategy B. Claude Code produces a new YAML.

**Mutation utility interface:**

```javascript
// Parameter perturbation — returns N YAML variant objects
function perturbParams(yamlDef, { count = 10, perturbPct = [0.1, 0.2, 0.5] }) => YamlDef[]

// Record mutation lineage
function recordMutation(parent, child, { mutationType, reasoning }) => void
```

**Lineage schema:**

```sql
CREATE TABLE strategy_lineage (
    id SERIAL PRIMARY KEY,
    strategy_name TEXT NOT NULL,
    parent_name TEXT,                 -- NULL if original
    mutation_type TEXT NOT NULL,       -- 'original', 'param_perturb', 'structural', 'crossover'
    mutation_reasoning TEXT,           -- why this variant was created
    yaml_definition TEXT NOT NULL,     -- full YAML
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'claude'   -- 'matthew' or 'claude'
);
```

**Rationale:**
- Claude Code already understands strategy logic — it does not need an autonomous mutation engine
- Providing structured utilities (perturbParams, lineage tracking) makes Claude Code faster without limiting its creativity
- All mutations are YAML, so the compose engine handles them identically

---

### Decision 5: Batch Runner — JSON Manifest + Parallel Execution

**Decision:** A batch runner accepts a JSON manifest describing multiple strategy/config/symbol combinations, executes them in parallel using the existing `runParallelBacktest()`, and produces structured JSON output.

**Manifest format:**

```json
{
  "name": "deficit-exploration-2026-03-14",
  "description": "Sweep deficit threshold across symbols",
  "runs": [
    {
      "strategy": "deficit-asymmetry-v1.yaml",
      "symbol": "btc",
      "sample": 200,
      "seed": 42
    },
    {
      "strategy": "deficit-asymmetry-v1.yaml",
      "symbol": "eth",
      "sample": 200,
      "seed": 42
    }
  ],
  "defaults": {
    "capital": 100,
    "spreadBuffer": 0.005,
    "fee": 0,
    "sweep": true
  }
}
```

**Batch runner architecture:**

```
JSON Manifest
    ↓  [parse + validate]
Run Specifications (strategy × config × symbol)
    ↓  [load timelines from SQLite cache]
Parallel Execution (reuse runParallelBacktest)
    ↓  [aggregate + rank]
Structured JSON Output + DB Persistence
    ↓  [CLI table rendering]
Console Summary
```

**Output format:**

```json
{
  "manifest": { "name": "...", "timestamp": "..." },
  "runs": [
    {
      "strategy": "deficit-asymmetry-v1",
      "symbol": "BTC",
      "config": { "deficitThreshold": 80 },
      "metrics": {
        "trades": 142,
        "winRate": 0.62,
        "sharpe": 1.8,
        "profitFactor": 2.1,
        "totalPnl": 45.20,
        "maxDrawdown": 0.08,
        "expectancy": 0.32,
        "edgePerTrade": 0.045
      },
      "elapsed_ms": 1200,
      "window_count": 200,
      "sample_seed": 42
    }
  ],
  "ranking": [
    { "rank": 1, "strategy": "...", "sharpe": 1.8, "trades": 142 }
  ],
  "baseline": { ... },
  "wall_clock_ms": 8500
}
```

**Service layer design:** The batch runner is implemented as a module with a clean API, not just a CLI script. This enables future consumers (dashboard, agents) to call it programmatically.

```javascript
// src/factory/batch-runner.js
export async function runBatch(manifest, options = {}) => BatchResult
export async function runSingle(runSpec, options = {}) => RunResult
```

**Rationale:**
- JSON manifest is machine-writable (Claude Code generates them)
- Reuses existing parallel engine — zero duplication
- Structured output enables programmatic consumption
- Service layer enables dashboard and agent access in Phase 2+

---

### Decision 6: Result Persistence — PostgreSQL with Structured Schema

**Decision:** All backtest results persist to PostgreSQL. Extends the existing `backtest_runs` and `backtest_trades` tables (already created by `run-all-strategies-fast.mjs`).

**New/extended tables:**

```sql
-- Extends existing backtest_runs table
-- Already has: run_id, status, config, total_strategies, total_symbols, total_windows,
--              completed_pairs, progress_pct, summary, error_message, completed_at

-- New: Factory-specific result storage
CREATE TABLE factory_runs (
    run_id SERIAL PRIMARY KEY,
    manifest_name TEXT NOT NULL,
    manifest_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    wall_clock_ms INTEGER,
    total_runs INTEGER NOT NULL,
    completed_runs INTEGER DEFAULT 0,
    summary JSONB,                           -- ranking, best config, etc.
    error_message TEXT
);

CREATE TABLE factory_results (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES factory_runs(run_id),
    strategy_name TEXT NOT NULL,
    strategy_yaml TEXT,                      -- full YAML definition if factory strategy
    strategy_source TEXT NOT NULL,           -- 'yaml' or 'js'
    symbol TEXT NOT NULL,
    config JSONB NOT NULL,                   -- strategy config used
    sample_size INTEGER,
    sample_seed INTEGER,
    metrics JSONB NOT NULL,                  -- sharpe, pf, winRate, trades, etc.
    trades_summary JSONB,                    -- aggregated trade stats
    created_at TIMESTAMPTZ DEFAULT NOW(),
    elapsed_ms INTEGER
);

CREATE INDEX idx_factory_results_strategy ON factory_results(strategy_name);
CREATE INDEX idx_factory_results_symbol ON factory_results(symbol);
CREATE INDEX idx_factory_results_created ON factory_results(created_at);
```

**Rationale:**
- PostgreSQL is already the production store — no new infrastructure
- JSONB for flexible metrics storage (schema evolves without migrations)
- Separate from existing `backtest_runs`/`backtest_trades` to avoid breaking the existing batch runner
- Queryable by strategy, symbol, date for edge decay analysis

---

### Decision 7: Stratified Random Sampling with Deterministic Seeding

**Decision:** Backtest runs sample windows rather than running all windows, with stratified sampling by time period and deterministic seeding for reproducibility.

**Implementation:**

```javascript
function sampleWindows(windows, { count = 200, seed = 42, stratify = 'weekly' }) {
  // 1. Group windows by stratum (week, day, or month)
  const strata = groupBy(windows, w => getStratumKey(w, stratify));

  // 2. Allocate samples proportionally to each stratum
  const allocations = allocateProportionally(strata, count);

  // 3. Sample within each stratum using seeded PRNG
  const rng = createSeededRNG(seed);
  const sampled = [];
  for (const [key, stratumWindows] of Object.entries(strata)) {
    const n = allocations[key];
    sampled.push(...shuffleAndTake(stratumWindows, n, rng));
  }

  return sampled;
}
```

**Rationale:**
- Running all 5000+ windows per symbol takes 30-60s; sampling 200 takes <5s
- Stratification ensures temporal coverage (not all samples from one week)
- Deterministic seed enables reproducibility: same seed + same data = same results
- Default of 200 windows provides sufficient statistical power for initial screening

---

### Decision 8: Strategy Versioning via YAML + Git + Lineage Table

**Decision:** Strategy versions are tracked through three mechanisms:

1. **YAML files on disk** in `src/factory/strategies/` — versioned by git
2. **Lineage table in PostgreSQL** — tracks parent-child relationships and mutation reasoning
3. **Results reference strategy names** — every result row records the exact strategy name and config

**Naming convention:** `{base-name}-v{N}` for manual iterations, `{base-name}-m{N}` for mutations.

Example: `deficit-asymmetry-v1` -> mutations -> `deficit-asymmetry-v1-m1`, `deficit-asymmetry-v1-m2`

**Rationale:**
- YAML on disk + git gives full history without any custom versioning system
- Lineage table enables querying "show me all children of deficit-asymmetry-v1"
- Simple naming convention avoids complex version management for a single-user system

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

All new code follows existing codebase conventions:

| Category | Convention | Example |
|----------|------------|---------|
| Files | kebab-case | `compose-engine.js`, `chainlink-deficit.js` |
| Directories | kebab-case | `src/factory/`, `src/factory/signals/` |
| Functions | camelCase | `composeStrategy()`, `perturbParams()` |
| Constants | UPPER_SNAKE | `DEFAULT_SAMPLE_SIZE`, `MAX_SWEEP_COMBINATIONS` |
| DB tables | snake_case | `factory_runs`, `factory_results`, `strategy_lineage` |
| YAML keys | kebab-case | `chainlink-deficit`, `time-window`, `fixed-capital` |
| Strategy names | kebab-case | `deficit-asymmetry-v1`, `vwap-contrarian-m3` |

### Module Interface Pattern

New modules follow the existing factory function pattern (not class-based):

```javascript
// src/factory/compose-engine.js
export function composeFromYaml(yamlString) { ... }
export function composeFromDefinition(definition) { ... }
export function validateDefinition(definition) { ... }
```

Building blocks export a factory function:

```javascript
// src/factory/signals/chainlink-deficit.js
export const name = 'chainlink-deficit';
export const description = 'Fires when CL deficit exceeds threshold';
export const paramSchema = {
  threshold: { type: 'number', default: 80, description: 'Min CL deficit in dollars' },
};

export function create(params) {
  return function evaluate(state, config) {
    const threshold = config.threshold ?? params.threshold;
    const deficit = state.strike - (state.chainlink?.price ?? 0);
    if (deficit > threshold) {
      return { direction: 'DOWN', strength: Math.min(deficit / 150, 1), reason: `cl_deficit=$${deficit.toFixed(0)}` };
    }
    return { direction: null, strength: 0, reason: '' };
  };
}
```

### Error Handling

Follow existing pattern: throw descriptive errors, let callers handle them.

```javascript
// YAML parsing errors include file path and line number
throw new Error(`Invalid YAML strategy "${name}": signal type "foo" not found in block library`);

// Validation errors list all issues
throw new Error(`Strategy validation failed:\n  - ${errors.join('\n  - ')}`);
```

### Test Organization

Tests co-located in `__tests__/` within each module:

```
src/factory/
  __tests__/
    compose-engine.test.js
    yaml-parser.test.js
    batch-runner.test.js
  signals/
    __tests__/
      chainlink-deficit.test.js
      ref-near-strike.test.js
```

### Configuration Pattern

New factory config added to existing `config/index.js`:

```javascript
factory: {
  strategiesDir: './src/factory/strategies/',
  blocksDir: './src/factory/blocks/',
  defaultSampleSize: 200,
  maxSweepCombinations: 1000,
  defaultSeed: 42,
},
```

---

## Project Structure & Boundaries

### New Directory Structure

All new code lives under `src/factory/`. This keeps the existing `src/backtest/` unchanged and creates a clear boundary.

```
src/factory/
├── index.js                      # Public API: compose, batch, mutate
├── compose-engine.js             # YAML → strategy object
├── yaml-parser.js                # YAML parsing + sweep extraction + validation
├── batch-runner.js               # JSON manifest → parallel execution → results
├── mutation.js                   # Parameter perturbation, lineage tracking
├── sampler.js                    # Stratified random sampling with seeded PRNG
├── result-persister.js           # Write results to PostgreSQL
├── block-registry.js             # Auto-discover and register all building blocks
│
├── signals/                      # Signal generators
│   ├── index.js                  # Auto-export all signals
│   ├── chainlink-deficit.js      # CL deficit signal
│   ├── bs-fair-value.js          # Black-Scholes fair value vs CLOB
│   ├── exchange-consensus.js     # Exchange median direction
│   ├── clob-imbalance.js         # Bid/ask size asymmetry
│   ├── momentum.js               # Price momentum (CL, exchanges)
│   ├── mean-reversion.js         # Mean reversion from extreme CLOB prices
│   └── __tests__/
│       ├── chainlink-deficit.test.js
│       ├── bs-fair-value.test.js
│       └── ...
│
├── filters/                      # Entry filters
│   ├── index.js
│   ├── time-window.js            # Only trade within last N ms
│   ├── max-price.js              # Max token price gate
│   ├── once-per-window.js        # One entry per window
│   ├── cooldown.js               # Min time between entries
│   ├── min-data.js               # Require minimum data points
│   └── __tests__/
│       └── ...
│
├── sizers/                       # Position sizing
│   ├── index.js
│   ├── fixed-capital.js          # Fixed $ per trade
│   ├── kelly-fraction.js         # Kelly criterion sizing
│   ├── volatility-scaled.js      # Scale by recent vol
│   └── __tests__/
│       └── ...
│
├── strategies/                   # YAML strategy definitions
│   ├── deficit-asymmetry-v1.yaml
│   ├── vwap-contrarian-v1.yaml
│   └── ...
│
├── __tests__/
│   ├── compose-engine.test.js
│   ├── yaml-parser.test.js
│   ├── batch-runner.test.js
│   ├── mutation.test.js
│   ├── sampler.test.js
│   └── integration/
│       ├── yaml-to-backtest.test.js       # End-to-end: YAML → compose → backtest → results
│       └── js-yaml-parity.test.js         # Verify YAML strategy matches hand-coded JS
│
└── cli/                          # CLI entry points (called by scripts/)
    ├── backtest-factory.js       # node scripts/backtest-factory.mjs
    └── build-timelines.js        # node scripts/build-timelines.mjs
```

### New Scripts

```
scripts/
├── backtest-factory.mjs          # Factory backtest CLI
├── build-timelines.mjs           # Build pre-computed timeline cache
├── batch-run.mjs                 # Run batch from JSON manifest
└── mutate-strategy.mjs           # Generate N mutations of a strategy
```

### Data Directory Extension

```
data/
├── backtest.sqlite               # Existing — raw tick data export
├── timelines.sqlite              # NEW — pre-computed per-window timelines
└── last-known-state.json         # Existing — kill switch state
```

### Architectural Boundaries

**Factory → Backtest boundary:**

The factory module produces standard strategy objects. The backtest module consumes them without knowing whether they came from YAML or JS. The interface is the existing strategy contract.

```
src/factory/compose-engine.js
    ↓  produces { name, evaluate, defaults, sweepGrid }
src/backtest/parallel-engine.js
    ↑  consumes strategy objects (unchanged)
```

**Factory → Persistence boundary:**

The factory writes results through `result-persister.js`, which uses the existing `src/persistence/index.js` module. No direct SQL in factory code.

**Data Pipeline → Backtest boundary:**

The timeline builder writes to `data/timelines.sqlite`. The backtest engine reads from it via a new timeline loader that replaces the per-window data loading.

```
src/factory/cli/build-timelines.js
    ↓  writes to data/timelines.sqlite
src/factory/timeline-loader.js
    ↓  reads pre-computed timelines
src/backtest/parallel-engine.js
    ↑  receives { timeline, window } (same as today)
```

### Requirements to Structure Mapping

| FR Category | Primary Module | Files |
|-------------|----------------|-------|
| Strategy Definition (FR1-9) | `src/factory/` | `compose-engine.js`, `yaml-parser.js`, `signals/`, `filters/`, `sizers/` |
| Mutation & Versioning (FR10-15) | `src/factory/` | `mutation.js`, `strategy_lineage` table |
| Backtesting (FR16-24) | `src/backtest/` + `src/factory/` | existing engines + `batch-runner.js`, `sampler.js` |
| Result Management (FR25-32) | `src/factory/` | `result-persister.js`, `factory_runs`/`factory_results` tables |
| Data Pipeline (FR33-38) | `src/factory/cli/` | `build-timelines.js`, `timelines.sqlite` |
| Compatibility (FR39-42) | N/A (unchanged) | All existing files remain unchanged |

---

## Data Pipeline Architecture

### Timeline Build Process

```
┌─────────────────────────────────────────────────────────────────────┐
│                     build-timelines.mjs                              │
│                                                                      │
│  1. Connect to PostgreSQL                                            │
│  2. Query window_close_events for date range                         │
│  3. For each window:                                                 │
│     a. Load rtds_ticks (chainlink, polyRef)                          │
│     b. Load clob_price_snapshots (filtered by window_epoch)          │
│     c. Load exchange_ticks (filtered by symbol)                      │
│     d. Load l2_book_ticks (if available)                             │
│     e. Load coingecko_ticks (if available)                           │
│     f. Tag sources (chainlink, polyRef, clobUp, clobDown, etc.)     │
│     g. Merge into sorted timeline                                    │
│     h. Validate: event count, time bounds, CLOB epoch match         │
│     i. Serialize to MessagePack                                      │
│     j. Insert into timelines.sqlite                                  │
│  4. Report: windows built, skipped (no ground truth), flagged        │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Validation on Build

The timeline builder validates each window and records quality metadata:

| Check | Validation | Action on Failure |
|-------|-----------|-------------------|
| Ground truth | gamma/onchain/resolved direction exists | Skip window (no ground truth) |
| CLOB epoch | clob_price_snapshots.window_epoch matches window | Flag in data_quality |
| Time bounds | All events within [openTime, closeTime) | Drop out-of-bounds events |
| Minimum events | At least 10 events per window | Flag as incomplete |
| Flat prices | CL price doesn't change for >60s | Flag as suspicious |
| L2 gaps | L2 data missing for >30s within window | Flag L2 gap |

Quality metadata stored in `data_quality` column as JSON.

### Incremental Updates

```javascript
// Only build windows newer than the latest in the cache
const lastBuilt = db.prepare('SELECT MAX(window_close_time) as latest FROM timelines').get();
const newWindows = await loadWindowsWithGroundTruth({
  startDate: lastBuilt?.latest || '2026-01-01',
  endDate: 'now',
});
```

### Timeline Loader

```javascript
// src/factory/timeline-loader.js
import Database from 'better-sqlite3';
import { unpack } from 'msgpackr';

export function loadTimeline(windowId) {
  const row = db.prepare('SELECT * FROM timelines WHERE window_id = ?').get(windowId);
  if (!row) return null;
  return {
    window: {
      window_close_time: row.window_close_time,
      symbol: row.symbol,
      strike_price: row.strike_price,
      oracle_price_at_open: row.oracle_price_at_open,
      chainlink_price_at_close: row.chainlink_price_at_close,
      resolved_direction: row.ground_truth,
      gamma_resolved_direction: row.ground_truth,
    },
    timeline: unpack(row.timeline),
    quality: JSON.parse(row.data_quality),
  };
}

export function loadWindowsForSymbol(symbol, { startDate, endDate } = {}) {
  // Returns window metadata without timeline data (for sampling)
  return db.prepare(`
    SELECT window_id, symbol, window_close_time, ground_truth, event_count, data_quality
    FROM timelines
    WHERE symbol = ?
      AND ($start IS NULL OR window_close_time >= $start)
      AND ($end IS NULL OR window_close_time <= $end)
    ORDER BY window_close_time ASC
  `).all(symbol, { start: startDate, end: endDate });
}
```

---

## Strategy Factory Architecture

### Block Registry

Auto-discovers all building blocks at startup:

```javascript
// src/factory/block-registry.js
const registry = {
  signals: new Map(),   // name → { create, paramSchema, description }
  filters: new Map(),
  sizers: new Map(),
};

export async function loadBlocks() {
  // Auto-import all .js files from signals/, filters/, sizers/
  const signalFiles = readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.js') && f !== 'index.js');
  for (const file of signalFiles) {
    const mod = await import(`./signals/${file}`);
    registry.signals.set(mod.name, mod);
  }
  // ... same for filters, sizers
}

export function getBlock(type, name) {
  const block = registry[type + 's']?.get(name);
  if (!block) throw new Error(`Unknown ${type}: "${name}". Available: ${[...registry[type + 's'].keys()].join(', ')}`);
  return block;
}

export function listBlocks() {
  return {
    signals: [...registry.signals.entries()].map(([name, mod]) => ({ name, description: mod.description, params: mod.paramSchema })),
    filters: [...registry.filters.entries()].map(([name, mod]) => ({ name, description: mod.description, params: mod.paramSchema })),
    sizers: [...registry.sizers.entries()].map(([name, mod]) => ({ name, description: mod.description, params: mod.paramSchema })),
  };
}
```

### YAML Parser

```javascript
// src/factory/yaml-parser.js
import yaml from 'js-yaml';

export function parseStrategyYaml(yamlString) {
  const raw = yaml.load(yamlString);

  // Validate required fields
  const errors = [];
  if (!raw.name) errors.push('name is required');
  if (!raw.signals || raw.signals.length === 0) errors.push('at least one signal is required');
  if (!raw.sizer) errors.push('sizer is required');
  if (errors.length > 0) throw new Error(`YAML validation failed:\n  - ${errors.join('\n  - ')}`);

  // Extract sweep grids from {sweep: [...]} syntax
  const sweepGrid = {};
  const defaults = {};
  extractSweeps(raw, sweepGrid, defaults);

  return {
    name: raw.name,
    description: raw.description || '',
    version: raw.version || 1,
    hypothesis: raw.hypothesis || '',
    signals: raw.signals,
    combine: raw.combine || 'all-of',
    filters: raw.filters || [],
    sizer: raw.sizer,
    params: defaults,
    sweepGrid,
  };
}

function extractSweeps(obj, sweepGrid, defaults, path = '') {
  if (obj && typeof obj === 'object' && obj.sweep) {
    // This is a sweep parameter
    const key = path.split('.').pop();
    sweepGrid[key] = obj.sweep;
    defaults[key] = obj.sweep[0]; // default to first value
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'params' && typeof value === 'object') {
        for (const [pkey, pval] of Object.entries(value)) {
          if (pval && typeof pval === 'object' && pval.sweep) {
            sweepGrid[pkey] = pval.sweep;
            defaults[pkey] = pval.sweep[0];
          } else {
            defaults[pkey] = pval;
          }
        }
      }
    }
  }
}
```

### Compose Engine

```javascript
// src/factory/compose-engine.js
import { getBlock } from './block-registry.js';
import { parseStrategyYaml } from './yaml-parser.js';

export function composeFromYaml(yamlString) {
  const definition = parseStrategyYaml(yamlString);
  return composeFromDefinition(definition);
}

export function composeFromDefinition(def) {
  // Instantiate blocks
  const signals = def.signals.map(s => {
    const block = getBlock('signal', s.type);
    return block.create(s.params || {});
  });

  const filters = def.filters.map(f => {
    const block = getBlock('filter', f.type);
    return block.create(f.params || {});
  });

  const sizerBlock = getBlock('sizer', def.sizer.type);
  const sizer = sizerBlock.create(def.sizer.params || {});

  const combiner = def.combine || 'all-of';

  // Per-window state
  let hasEnteredThisWindow = false;

  return {
    name: def.name,
    description: def.description,
    defaults: def.params || {},
    sweepGrid: Object.keys(def.sweepGrid).length > 0 ? def.sweepGrid : undefined,

    onWindowOpen(state, config) {
      hasEnteredThisWindow = false;
      for (const s of signals) if (s.reset) s.reset();
      for (const f of filters) if (f.reset) f.reset();
    },

    evaluate(state, config) {
      // Evaluate signals
      const results = signals.map(s => s(state, config));

      // Combine
      let combined;
      if (combiner === 'all-of') {
        // All signals must agree on direction
        const dirs = results.filter(r => r.direction).map(r => r.direction);
        if (dirs.length !== results.length) return [];
        const allSame = dirs.every(d => d === dirs[0]);
        if (!allSame) return [];
        combined = {
          direction: dirs[0],
          strength: results.reduce((s, r) => s + r.strength, 0) / results.length,
          reason: results.map(r => r.reason).filter(Boolean).join('; '),
        };
      } else if (combiner === 'any-of') {
        // Take the strongest signal
        const withDir = results.filter(r => r.direction);
        if (withDir.length === 0) return [];
        combined = withDir.reduce((best, r) => r.strength > best.strength ? r : best);
      } else {
        return [];
      }

      // Apply filters
      for (const filter of filters) {
        if (!filter(state, config, combined)) return [];
      }

      // Size
      const sizing = sizer(state, config, combined);

      // Build signal
      const dir = combined.direction.toLowerCase();
      const token = `${state.window.symbol}-${dir === 'up' ? 'up' : 'down'}`;

      return [{
        action: 'buy',
        token,
        capitalPerTrade: sizing.capitalPerTrade,
        reason: combined.reason,
        confidence: combined.strength,
      }];
    },
  };
}
```

---

## Batch Runner Architecture

### Service Layer

```javascript
// src/factory/batch-runner.js
import { composeFromYaml } from './compose-engine.js';
import { loadTimeline, loadWindowsForSymbol } from './timeline-loader.js';
import { sampleWindows } from './sampler.js';
import { runParallelBacktest, runParallelSweep } from '../backtest/parallel-engine.js';
import { evaluateWindow } from '../backtest/parallel-engine.js';
import { calculateMetrics, calculateBinaryMetrics } from '../backtest/metrics.js';
import { persistResults } from './result-persister.js';

export async function runBatch(manifest) {
  const startTime = Date.now();
  const results = [];

  for (const runSpec of manifest.runs) {
    const result = await runSingle(runSpec, manifest.defaults);
    results.push(result);
  }

  const wallClockMs = Date.now() - startTime;

  // Rank by Sharpe ratio
  const ranking = results
    .filter(r => r.metrics.trades >= 20)
    .sort((a, b) => b.metrics.sharpe - a.metrics.sharpe)
    .map((r, i) => ({ rank: i + 1, ...r }));

  const batchResult = {
    manifest: { name: manifest.name, timestamp: new Date().toISOString() },
    runs: results,
    ranking,
    wall_clock_ms: wallClockMs,
  };

  // Persist to DB
  await persistResults(batchResult);

  return batchResult;
}

export async function runSingle(runSpec, defaults = {}) {
  // 1. Load or compose strategy
  let strategy;
  if (runSpec.strategy.endsWith('.yaml')) {
    const yamlContent = readFileSync(resolve(STRATEGIES_DIR, runSpec.strategy), 'utf-8');
    strategy = composeFromYaml(yamlContent);
  } else {
    strategy = await loadJsStrategy(runSpec.strategy);
  }

  // 2. Load windows and sample
  const allWindows = loadWindowsForSymbol(runSpec.symbol);
  const windows = sampleWindows(allWindows, {
    count: runSpec.sample || defaults.sample || 200,
    seed: runSpec.seed || defaults.seed || 42,
  });

  // 3. Load pre-computed timelines for sampled windows
  const windowsWithTimelines = windows.map(w => {
    const data = loadTimeline(w.window_id);
    return { window: data.window, timeline: data.timeline };
  });

  // 4. Run backtest (sweep or single)
  if (defaults.sweep && strategy.sweepGrid) {
    // Sweep mode
    const sweepResults = [];
    const paramSets = generateParamCombinations(strategy.sweepGrid);

    for (const params of paramSets) {
      const windowResults = windowsWithTimelines.map(({ window: win, timeline }) =>
        evaluateWindow({
          window: win,
          timeline,
          strategy,
          strategyConfig: { ...strategy.defaults, ...params },
          initialCapital: defaults.capital || 100,
          spreadBuffer: defaults.spreadBuffer || 0.005,
          tradingFee: defaults.fee || 0,
        })
      );

      const metrics = computeMetrics(windowResults, strategy, params);
      sweepResults.push({ params, metrics });
    }

    // Return best by Sharpe
    sweepResults.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
    return {
      strategy: strategy.name,
      symbol: runSpec.symbol,
      sweep: true,
      variants: sweepResults,
      best: sweepResults[0],
    };
  } else {
    // Single config
    const windowResults = windowsWithTimelines.map(({ window: win, timeline }) =>
      evaluateWindow({
        window: win,
        timeline,
        strategy,
        strategyConfig: strategy.defaults || {},
        initialCapital: defaults.capital || 100,
        spreadBuffer: defaults.spreadBuffer || 0.005,
        tradingFee: defaults.fee || 0,
      })
    );

    return {
      strategy: strategy.name,
      symbol: runSpec.symbol,
      config: strategy.defaults,
      metrics: computeMetrics(windowResults, strategy, strategy.defaults),
      window_count: windows.length,
      sample_seed: runSpec.seed || defaults.seed || 42,
    };
  }
}
```

---

## Integration with Existing System

### What Does NOT Change

| Component | Location | Why |
|-----------|----------|-----|
| 73 JS strategies | `src/backtest/strategies/*.js` | FR39: work without modification |
| MarketState | `src/backtest/market-state.js` | FR40: same interface |
| Simulator | `src/backtest/simulator.js` | Unchanged execution model |
| Parallel engine | `src/backtest/parallel-engine.js` | Reused by factory batch runner |
| Paper trader | `src/modules/paper-trader/` | FR41: unchanged |
| Live execution | `src/modules/orchestrator/` | FR41: unchanged |
| Kill switch | `src/modules/safety/` | FR41: unchanged |
| Persistence | `src/persistence/` | Extended, not modified |
| Config | `config/index.js` | New `factory` section added |

### What IS New

| Component | Location | Purpose |
|-----------|----------|---------|
| Factory module | `src/factory/` | Compose engine, blocks, batch runner |
| Timeline cache | `data/timelines.sqlite` | Pre-computed per-window data |
| Factory scripts | `scripts/backtest-factory.mjs` etc. | CLI entry points |
| DB tables | `factory_runs`, `factory_results`, `strategy_lineage` | Result persistence |
| YAML strategies | `src/factory/strategies/` | Declarative strategy definitions |

### Data Flow: Idea → Results

```
Matthew describes strategy to Claude Code
    ↓
Claude Code generates YAML in src/factory/strategies/
    ↓
node scripts/backtest-factory.mjs --strategy=deficit-v1.yaml --symbol=btc --sample=200 --sweep
    ↓
YAML parsed → compose engine → strategy object
    ↓
Windows sampled from timelines.sqlite (200 windows, stratified)
    ↓
Per-window: load pre-computed timeline → evaluateWindow() (existing engine)
    ↓
Aggregate metrics (Sharpe, PF, WR, etc.)
    ↓
Results persisted to PostgreSQL (factory_results)
    ↓
CLI table printed to console
    ↓
Claude Code analyzes results, suggests mutations
    ↓
node scripts/mutate-strategy.mjs --strategy=deficit-v1.yaml --count=20
    ↓
20 YAML variants generated → batch run → ranked results
```

---

## Architecture Validation Results

### Coherence Validation

- **Stack compatibility:** Node.js 22 + ESM + better-sqlite3 + js-yaml + msgpackr — all well-tested together
- **Pattern consistency:** New code follows all existing naming, module, and error handling conventions
- **Interface compatibility:** Factory produces identical strategy objects to hand-coded JS — verified by the compose engine contract

### Requirements Coverage

| FR Category | Coverage | How |
|-------------|----------|-----|
| Strategy Definition (FR1-9) | Complete | YAML DSL + compose engine + block library |
| Mutation & Versioning (FR10-15) | Complete | mutation.js + strategy_lineage table |
| Backtesting (FR16-24) | Complete | Timeline cache + sampler + parallel engine + batch runner |
| Result Management (FR25-32) | Complete | PostgreSQL persistence + structured JSON + CLI tables |
| Data Pipeline (FR33-38) | Complete | build-timelines.mjs + validation + incremental builds |
| Compatibility (FR39-42) | Complete | Zero changes to existing code |

| NFR | Target | How Achieved |
|-----|--------|-------------|
| NFR1: <500ms single run | Pre-computed timelines + ~50 window sample | MessagePack deserialize ~0.5ms + evaluate ~5ms per window |
| NFR2: <5s 16-combo sweep | 16 × 200 windows × ~5ms/window = 16s sequential, ~2s with 50 concurrent | Reuse existing concurrency limiter |
| NFR7: Bit-identical results | Same evaluateWindow() function, same MarketState | No changes to evaluation code |
| NFR9: Deterministic | Seeded PRNG for sampling, same data cache | Same seed + same timelines.sqlite = same results |
| NFR12: Factory interface contract | Compose engine output validated by test suite | Unit test: compose YAML → check interface match |

### Implementation Readiness

**Ready for implementation.** All decisions are specific enough for an AI agent to implement without ambiguity:

1. Exact file paths and module boundaries defined
2. Data schemas specified with column types and indexes
3. Function signatures and interfaces documented
4. Building block interface standardized
5. YAML format specified with examples
6. Integration points with existing code explicitly mapped

### Implementation Priority

1. **Timeline builder** (`build-timelines.mjs`) — enables fast backtesting
2. **Block library** (signals, filters, sizers) — reusable components
3. **Compose engine** (`compose-engine.js`) — YAML to strategy
4. **YAML parser** (`yaml-parser.js`) — with sweep extraction
5. **Batch runner** (`batch-runner.js`) — service layer for execution
6. **Result persister** — write to PostgreSQL
7. **Mutation utilities** — parameter perturbation + lineage
8. **CLI scripts** — user-facing entry points
9. **Validation test** — reproduce `edge-c-asymmetry` in YAML, confirm identical results
