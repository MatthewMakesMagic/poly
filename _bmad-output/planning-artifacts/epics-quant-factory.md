---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
status: complete
completedAt: '2026-03-14'
inputDocuments:
  - prd-quant-factory.md
  - architecture-quant-factory.md
project_name: 'poly'
user_name: 'Matthew'
date: '2026-03-14'
---

# poly — Quant Factory Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the Quant Factory extension to poly, decomposing the requirements from the PRD and Architecture into implementable stories. The scope covers MVP (Phase 1): Turbo Backtester + Strategy Factory + Batch Runner + Mutation Engine.

## Testing Philosophy

### Continuous Quality Gates

Testing is not a final verification step — it is the quality floor of the entire research operation. If the backtest engine has bugs, every strategy result is garbage. Every story must satisfy three testing levels:

1. **Unit tests** — module works in isolation
2. **Integration tests** — module works with its dependencies across stories and epics
3. **Regression gate** — all previously passing tests still pass after each story completion

### Agent-Interpretable Tests

All tests must be readable and actionable by Claude Code agents. Test failures should explain:
- **What broke** — which capability is broken (data pipeline? factory? backtester?)
- **Why it broke** — descriptive error messages explaining the domain, not just the assertion
- **What to do** — is this a regression, a data issue, or an upstream dependency?

Bad: `AssertionError: expected 1.8 to equal 1.7999999`
Good: `Sharpe ratio mismatch: cached timeline produced 1.8, direct DB query produced 1.7999 — likely floating point issue in MessagePack serialization of price field`

### Test Directory Structure

```
__tests__/factory/
  unit/           # Per-module isolation tests
  integration/    # Cross-module within the factory
  e2e/            # Full pipeline tests
  regression/     # "This specific bug happened before, never again"
```

Each test file includes a comment block at the top stating which FRs/NFRs it covers.

### Golden Test Suite

Snapshot known-good baseline results for core scenarios. When `edge-c-asymmetry` runs on 50 seeded windows and produces Sharpe 1.87 — that result is frozen. Any deviation triggers investigation. This is how professional quant firms validate pipeline integrity.

### FR Coverage Report

Test output includes an FR coverage section showing which FRs are tested and which lost coverage:
```
FR Coverage: 42/42 (100%)
  FR1 ✓ (factory/unit/yaml-parser.test.js)
  FR29 ✓ (factory/unit/confidence-intervals.test.js)
  ...
```

### Integration Test Matrix (Cross-Epic)

| When this completes... | Integration test validates... |
|---|---|
| Epic 1 (Pipeline) | Cached timelines produce identical MarketState to direct DB loading |
| Epic 2 (Factory) | Composed YAML strategy produces identical signals to equivalent JS strategy |
| Epic 1 + 2 | Factory strategy runs against cached timelines, produces valid results |
| Epic 3 (Backtester) | Full pipeline: YAML → compose → cache → evaluate → metrics → persist → CLI |
| Epic 1 + 2 + 3 | Batch runner handles mixed JS and YAML strategies against cached data |
| Epic 4 (Mutation) | Mutated strategies are valid, load correctly, backtest successfully |
| Epic 1-4 | End-to-end: idea → YAML → mutate 10 → batch backtest → ranked results persisted |
| Epic 5 (Compat) | All 73 existing strategies produce identical results through old and new paths |

## Requirements Inventory

### Functional Requirements

**Strategy Definition (FR1-FR9):**
- FR1: Matthew describes a strategy idea to Claude Code, which generates a YAML strategy definition
- FR2: Matthew describes a strategy idea to Claude Code, which generates JS when logic exceeds DSL expressiveness
- FR3: Parameter sweep ranges embeddable directly in strategy configs via sweep syntax
- FR4: System parses YAML definitions into runnable strategy objects matching JS interface
- FR5: Multiple signal generators composable via logical operators (all-of, any-of)
- FR6: Library of pre-built signal generators: chainlink deficit, BS fair value, exchange consensus, CLOB imbalance, momentum, mean reversion
- FR7: Library of pre-built filters: time window, price range, cooldown, max positions
- FR8: Library of pre-built sizing methods: fixed capital, Kelly fraction, volatility-scaled
- FR9: Matthew can inspect generated artefacts before execution to verify intent

**Strategy Mutation & Versioning (FR10-FR15):**
- FR10: Claude Code generates parameter perturbations of existing strategies on request
- FR11: Claude Code generates structural mutations (add/remove signal) on request
- FR12: Claude Code crosses over two strategies into new variants on request
- FR13: Mutation engine generates N variations in a single invocation
- FR14: Each variant versioned with clear lineage (what changed between versions)
- FR15: Mutation reasoning captured (why each variant was created)

**Backtesting (FR16-FR24):**
- FR16: Backtest any strategy (YAML or JS) against historical window data
- FR17: Stratified random sampling with deterministic seeding for reproducibility
- FR18: Parameter sweep across all combinations in strategy's sweep grid
- FR19: Baseline comparison included in results
- FR20: Historical data loads significantly faster than current PG-over-network
- FR21: Multi-symbol backtests with comparison table
- FR22: Batch runner: multiple strategy/config/symbol combinations in parallel
- FR23: Port strategy to different instruments (e.g., "run this on SOL")
- FR24: Execution wall-clock time reported per run

**Result Management (FR25-FR32):**
- FR25: All results persisted to database with timestamp, strategy config, symbol
- FR26: Historical results queryable by strategy, date range, symbol
- FR27: Structured JSON output (machine-readable)
- FR28: Metrics: Sharpe, Sortino, profit factor, max drawdown, win rate, trade count, expectancy, edge per trade, regime breakdown (first/second half, time-of-day)
- FR29: Statistical significance with confidence intervals on key metrics
- FR30: CLI formatted summary tables
- FR31: Rank and compare variants with parameter importance highlighting
- FR32: Cross-symbol comparisons flag unequal sample sizes

**Data Pipeline (FR33-FR38):**
- FR33: Build pre-computed timelines from raw tables (exchange ticks, CLOB snapshots, RTDS ticks, L2 book data)
- FR34: Validate data integrity on build (flat prices, epoch mismatches, gaps)
- FR35: Incremental updates (new windows without full rebuild)
- FR36: CLI command to trigger pipeline rebuild
- FR37: Timeline completeness reporting (loaded, skipped, flagged with reasons)
- FR38: Data coverage reporting per symbol (windows, L2 availability, date ranges)

**System Compatibility (FR39-FR42):**
- FR39: All 73 existing JS strategies work without modification
- FR40: Same MarketState interface for existing strategies
- FR41: Paper trading, live execution, orchestrator, kill switch unchanged
- FR42: Factory strategies interchangeable with JS strategies in all components

### Non-Functional Requirements

- NFR1: Single strategy backtest on cached data: <500ms
- NFR2: 16-combination parameter sweep: <5 seconds
- NFR3: 100-combination batch run: <60 seconds
- NFR4: Data pipeline cache build per symbol: <10 minutes
- NFR5: YAML parsing and composition: <100ms
- NFR6: CLI table rendering: <1 second
- NFR7: Pre-computed timelines produce bit-identical results to direct DB queries
- NFR8: Validation catches 100% of known anomaly patterns
- NFR9: Deterministic reproducibility given same strategy, config, data, seed
- NFR10: No silent data failures — all issues reported in completeness output
- NFR11: ES Modules (Node.js 22) consistent with existing codebase
- NFR12: Factory output passes existing strategy interface contract — validated by test suite
- NFR13: PostgreSQL on Railway for persistence — existing stores can be extended or improved
- NFR14: CLI patterns follow existing conventions unless a better pattern is established
- NFR15: Existing functionality continues working — underlying implementation can be improved
- NFR16: Each signal generator, filter, and sizer independently testable with unit tests
- NFR17: YAML parser has comprehensive test coverage including error cases
- NFR18: No regressions to existing test pass rate (98/115 files, 3031/3273 tests)

### Additional Requirements

- **Brownfield extension:** All new code under `src/factory/`, existing `src/backtest/` unchanged
- **No starter template:** Extends existing codebase following established patterns (kebab-case files, camelCase functions, co-located `__tests__/`)
- **New dependency:** `js-yaml` for YAML parsing, `msgpackr` for MessagePack serialization
- **New DB tables:** `factory_runs`, `factory_results`, `strategy_lineage` in PostgreSQL
- **New SQLite database:** `data/timelines.sqlite` for pre-computed timeline cache
- **New scripts:** `backtest-factory.mjs`, `build-timelines.mjs`, `batch-run.mjs`, `mutate-strategy.mjs`
- **Config extension:** Factory config block added to `config/index.js`
- **Factory output contract:** Must produce `{ name, evaluate, defaults, sweepGrid }` matching existing strategy interface
- **Service layer pattern:** Batch runner implemented as importable module, not just CLI script

### FR Coverage Map

- FR1: Epic 2 — YAML strategy generation via Claude Code
- FR2: Epic 2 — JS escape hatch for complex logic
- FR3: Epic 2 — Sweep syntax embedded in YAML params
- FR4: Epic 2 — YAML parser + compose engine
- FR5: Epic 2 — Signal combination operators (all-of, any-of)
- FR6: Epic 2 — Signal building block library
- FR7: Epic 2 — Filter building block library
- FR8: Epic 2 — Sizer building block library
- FR9: Epic 2 — Inspectable YAML artefacts
- FR10: Epic 4 — Parameter perturbation mutations
- FR11: Epic 4 — Structural mutations
- FR12: Epic 4 — Strategy crossover
- FR13: Epic 4 — Batch mutation generation
- FR14: Epic 4 — Version lineage tracking
- FR15: Epic 4 — Mutation reasoning capture
- FR16: Epic 3 — Backtest YAML or JS strategies
- FR17: Epic 3 — Stratified random sampling
- FR18: Epic 3 — Parameter sweep execution
- FR19: Epic 3 — Baseline comparison
- FR20: Epic 1 — Fast data loading from pre-computed timelines
- FR21: Epic 3 — Multi-symbol backtests
- FR22: Epic 3 — Batch runner parallel execution
- FR23: Epic 3 — Cross-symbol portability
- FR24: Epic 3 — Wall-clock time reporting
- FR25: Epic 3 — Result persistence to PostgreSQL
- FR26: Epic 3 — Historical result querying
- FR27: Epic 3 — Structured JSON output
- FR28: Epic 3 — Comprehensive metrics suite
- FR29: Epic 3 — Statistical significance / confidence intervals
- FR30: Epic 3 — CLI formatted summary tables
- FR31: Epic 3 — Variant ranking and comparison
- FR32: Epic 3 — Cross-symbol sample size flagging
- FR33: Epic 1 — Pre-computed timeline building
- FR34: Epic 1 — Data integrity validation
- FR35: Epic 1 — Incremental cache updates
- FR36: Epic 1 — CLI pipeline rebuild command
- FR37: Epic 1 — Timeline completeness reporting
- FR38: Epic 1 — Data coverage reporting
- FR39: Epic 5 — Existing JS strategies unchanged
- FR40: Epic 5 — MarketState interface preserved
- FR41: Epic 5 — Existing systems unchanged
- FR42: Epic 5 — Factory/JS strategy interchangeability

## Epic List

### Epic 1: Pre-Computed Timeline Data Pipeline
Matthew can build a fast local cache of pre-computed, validated timelines from PostgreSQL so that backtests run in milliseconds instead of seconds, with full data quality visibility.
**FRs covered:** FR20, FR33, FR34, FR35, FR36, FR37, FR38
**NFRs addressed:** NFR1, NFR4, NFR7, NFR8, NFR9, NFR10, NFR11

### Epic 2: Composable Strategy Factory
Matthew can define strategies as composable YAML definitions using a library of building blocks (signals, filters, sizers), with sweep syntax for parameter exploration, producing standard strategy objects identical to hand-coded JS.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9
**NFRs addressed:** NFR5, NFR11, NFR12, NFR16, NFR17

### Epic 3: Turbo Backtester and Batch Runner
Matthew can backtest any strategy (YAML or JS) against cached timelines with sampling, sweeps, and baseline comparisons, run batches of strategy/symbol combinations in parallel, and get structured results persisted to the database with CLI summaries.
**FRs covered:** FR16, FR17, FR18, FR19, FR21, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR32
**NFRs addressed:** NFR1, NFR2, NFR3, NFR6, NFR9, NFR13, NFR14

### Epic 4: Mutation Engine and Strategy Versioning
Matthew can generate parameter perturbations, structural mutations, and crossovers of existing strategies, with all variants versioned and lineage tracked in the database.
**FRs covered:** FR10, FR11, FR12, FR13, FR14, FR15
**NFRs addressed:** NFR9, NFR11, NFR13

### Epic 5: System Compatibility and Integration Verification
All 73 existing JS strategies continue to work without modification, factory strategies are interchangeable with JS strategies in all system components, and no existing functionality is broken.
**FRs covered:** FR39, FR40, FR41, FR42
**NFRs addressed:** NFR12, NFR15, NFR18

---

## Epic 1: Pre-Computed Timeline Data Pipeline

Matthew can build a fast local cache of pre-computed, validated timelines from PostgreSQL so that backtests run in milliseconds instead of seconds, with full data quality visibility.

### Story 1.1: Timeline SQLite Schema and MessagePack Infrastructure

As a quant researcher,
I want the timeline cache database schema and serialization infrastructure set up,
So that pre-computed timelines can be stored locally for fast access.

**Acceptance Criteria:**

**Given** the `data/` directory exists in the project root
**When** the timeline infrastructure is initialized
**Then** a `data/timelines.sqlite` database is created with the `timelines` table matching the architecture schema (window_id TEXT PK, symbol, window_close_time, window_open_time, ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close, timeline BLOB, event_count, data_quality, built_at)
**And** indexes on `symbol` and `window_close_time` are created
**And** `msgpackr` is added as a project dependency
**And** `js-yaml` is added as a project dependency
**And** a `src/factory/timeline-loader.js` module exports `loadTimeline(windowId)` and `loadWindowsForSymbol(symbol, options)` functions
**And** `loadTimeline` returns `{ window, timeline, quality }` with the timeline deserialized from MessagePack
**And** `loadWindowsForSymbol` returns window metadata without timeline data (for sampling)
**And** unit tests verify MessagePack round-trip serialization of sample timeline data
**And** all code uses ES Modules consistent with the existing codebase (NFR11)

### Story 1.2: Timeline Builder — Core Pipeline

As a quant researcher,
I want to build pre-computed timelines from PostgreSQL raw tables,
So that I have a fast local cache for backtesting.

**Depends on:** Story 1.1

**Acceptance Criteria:**

**Given** a PostgreSQL connection to the production database is available
**When** `node scripts/build-timelines.mjs --symbol=btc` is executed
**Then** the builder connects to PostgreSQL and queries `window_close_events` for the specified symbol
**And** for each window with ground truth, the builder loads rtds_ticks, clob_price_snapshots, exchange_ticks, l2_book_ticks, and coingecko_ticks
**And** events are tagged by source and match the exact schema expected by MarketState: RTDS events as `{ source: 'chainlink'|'polyRef', price, ts, _ms }`, CLOB events as `{ source: 'clobUp'|'clobDown', bestBid, bestAsk, mid, spread, bidSize, askSize, ts, _ms }`, exchange events as `{ source: 'exchange_<name>', price, bid, ask, ts, _ms }`
**And** events are merged into a single sorted timeline array per window
**And** timelines are serialized with MessagePack and inserted into `data/timelines.sqlite`
**And** the builder reports: total windows processed, inserted, skipped (no ground truth), and elapsed time
**And** `--symbol` flag accepts any supported symbol (btc, eth, sol, xrp, etc.)
**And** the builder can process multiple symbols when `--symbol=all` is passed
**And** cache build per symbol completes within 10 minutes (NFR4)
**And** a `src/factory/cli/build-timelines.js` module contains the core logic, importable for programmatic use

### Story 1.3: Data Validation on Build

As a quant researcher,
I want the timeline builder to validate data integrity during cache construction,
So that I can trust the cached data and catch known anomaly patterns.

**Depends on:** Story 1.2

**Acceptance Criteria:**

**Given** the timeline builder is processing windows from PostgreSQL
**When** a window is built
**Then** CLOB epoch validation checks that `clob_price_snapshots.window_epoch` matches the window
**And** time bounds validation ensures all events fall within `[openTime, closeTime)`; out-of-bounds events are dropped
**And** minimum event count validation flags windows with fewer than 10 events as incomplete
**And** flat price detection flags windows where CL price does not change for >60s
**And** L2 gap detection flags windows with L2 data missing for >30s
**And** windows without ground truth (no gamma/onchain/resolved direction) are skipped with a log message
**And** all validation results are stored in the `data_quality` JSON column: `{ rtds_count, clob_count, exchange_count, l2_count, gaps: [] }`
**And** validation catches 100% of known anomaly patterns (NFR8)
**And** no silent data failures — all issues appear in the completeness output (NFR10)

### Story 1.4: Incremental Updates

As a quant researcher,
I want the timeline builder to only add new windows since the last build,
So that I do not have to rebuild the entire cache when new data arrives.

**Depends on:** Story 1.2

**Acceptance Criteria:**

**Given** a `data/timelines.sqlite` cache already exists with previously built timelines
**When** `node scripts/build-timelines.mjs --symbol=btc` is run again
**Then** the builder queries the latest `window_close_time` from the existing cache
**And** only windows newer than the latest cached window are fetched from PostgreSQL
**And** new windows are appended to the cache without modifying existing entries
**And** a `--rebuild` flag forces a full rebuild (drops and recreates all windows for the symbol)
**And** the incremental update reports how many windows were added vs how many already existed

### Story 1.5: Timeline Completeness and Coverage Reporting

As a quant researcher,
I want to see a summary of data coverage and quality for my cached timelines,
So that I know which symbols and date ranges are available and what quality issues exist.

**Depends on:** Story 1.3

**Acceptance Criteria:**

**Given** `data/timelines.sqlite` contains pre-built timelines
**When** `node scripts/build-timelines.mjs --report` is executed
**Then** a per-symbol summary table is displayed showing: total windows, date range (earliest/latest), L2 availability percentage, average event count, and count of flagged windows by flag type
**And** flagged windows are listed with their reasons (incomplete, flat prices, L2 gaps, epoch mismatch)
**And** a `--symbol=btc` flag filters the report to a single symbol
**And** the report includes data coverage per symbol: windows count, date range, L2 availability (FR38)
**And** completeness reporting shows loaded, skipped, and flagged counts with reasons (FR37)
**And** CLI table rendering completes in <1 second (NFR6)

### Story 1.6: Bit-Identical Validation Against Direct DB Queries

As a quant researcher,
I want to verify that pre-computed timelines produce identical results to loading data directly from PostgreSQL,
So that I can trust the cache does not introduce subtle data differences.

**Depends on:** Story 1.2

**Acceptance Criteria:**

**Given** timelines have been built for a symbol (e.g., BTC)
**When** a validation test loads the same window from both the SQLite cache and directly from PostgreSQL via the existing `data-loader.js`
**Then** the event counts are identical
**And** event timestamps, values, and sources match exactly
**And** the MarketState computed from cached timelines produces the same values as from direct DB loading
**And** at least 10 randomly selected windows are compared per symbol in the test suite
**And** pre-computed timelines produce bit-identical results to direct DB queries (NFR7)
**And** deterministic reproducibility is confirmed: same data = same results (NFR9)

---

## Epic 2: Composable Strategy Factory

Matthew can define strategies as composable YAML definitions using a library of building blocks (signals, filters, sizers), with sweep syntax for parameter exploration, producing standard strategy objects identical to hand-coded JS.

### Story 2.1: Block Registry and Building Block Interface

As a quant researcher,
I want a registry that auto-discovers and manages composable building blocks (signals, filters, sizers),
So that new blocks can be added by dropping files into the right directory.

**Acceptance Criteria:**

**Given** the `src/factory/signals/`, `src/factory/filters/`, and `src/factory/sizers/` directories exist
**When** the block registry is initialized via `loadBlocks()`
**Then** all `.js` files in each directory (excluding `index.js`) are auto-imported and registered
**And** each block module exports `name`, `description`, `paramSchema`, and `create(params)` function
**And** `getBlock(type, name)` retrieves a registered block or throws a descriptive error listing available blocks
**And** `listBlocks()` returns all registered blocks with names, descriptions, and parameter schemas
**And** the registry is a singleton, initialized once per process
**And** unit tests verify block discovery, retrieval, and error handling for missing blocks
**And** each building block is independently testable with unit tests (NFR16)

### Story 2.2: Signal Building Blocks

As a quant researcher,
I want a library of pre-built signal generators covering common trading patterns,
So that I can compose strategies without writing JS for standard signals.

**Depends on:** Story 2.1

**Acceptance Criteria:**

**Given** the block registry is operational
**When** signal blocks are loaded
**Then** the following signals are available: `chainlink-deficit`, `bs-fair-value`, `exchange-consensus`, `clob-imbalance`, `momentum`, `mean-reversion`
**And** each signal's `create(params)` returns an `evaluate(state, config)` function
**And** each signal's evaluate returns `{ direction: 'UP'|'DOWN'|null, strength: 0-1, reason: string }`
**And** each signal reads from `MarketState` properties matching the existing codebase (state.chainlink, state.strike, state.clobUp, state.clobDown, etc.)
**And** each signal has a `paramSchema` defining its configurable parameters with types and defaults
**And** each signal has unit tests with mocked MarketState verifying correct directional output and edge cases
**And** signals handle missing/null data gracefully (return `{ direction: null }` rather than throwing)

### Story 2.3: Filter Building Blocks

As a quant researcher,
I want a library of pre-built entry filters for gating trade signals,
So that I can add risk controls and timing logic without writing JS.

**Depends on:** Story 2.1

**Acceptance Criteria:**

**Given** the block registry is operational
**When** filter blocks are loaded
**Then** the following filters are available: `time-window`, `max-price`, `once-per-window`, `cooldown`, `min-data`
**And** each filter's `create(params)` returns a function `(state, config, signalResult) => boolean`
**And** `time-window` accepts `entryWindowMs` and returns `true` only within the last N ms of the window
**And** `max-price` accepts `maxPrice` and `side` (up/down), returns `true` when the token price is below maxPrice
**And** `once-per-window` tracks whether a trade has already been entered in the current window and has a `reset()` method called on window open
**And** `cooldown` enforces a minimum time between entries
**And** `min-data` requires a minimum number of data points before allowing entry
**And** each filter has unit tests verifying pass/fail conditions

### Story 2.4: Sizer Building Blocks

As a quant researcher,
I want a library of pre-built position sizing methods,
So that I can control capital allocation without writing JS.

**Depends on:** Story 2.1

**Acceptance Criteria:**

**Given** the block registry is operational
**When** sizer blocks are loaded
**Then** the following sizers are available: `fixed-capital`, `kelly-fraction`, `volatility-scaled`
**And** each sizer's `create(params)` returns a function `(state, config, signalResult) => { capitalPerTrade: number }`
**And** `fixed-capital` returns the configured dollar amount per trade
**And** `kelly-fraction` computes position size based on Kelly criterion given estimated edge and variance
**And** `volatility-scaled` adjusts size inversely to recent price volatility
**And** each sizer has unit tests verifying correct sizing calculations

### Story 2.5: YAML Parser with Sweep Syntax Extraction

As a quant researcher,
I want to write strategy definitions in YAML with embedded sweep syntax,
So that a single file defines both the strategy and its parameter exploration grid.

**Depends on:** Story 2.1

**Acceptance Criteria:**

**Given** a YAML string defining a strategy with `name`, `signals`, `filters`, `sizer`, `combine`, and `params`
**When** `parseStrategyYaml(yamlString)` is called
**Then** the parsed definition includes all strategy fields with correct types
**And** `{sweep: [val1, val2, ...]}` syntax in any param is extracted into a `sweepGrid` object
**And** sweep parameters default to their first value in the `defaults` object
**And** validation enforces: `name` required, at least one signal, sizer required, all `type` references resolvable to registered blocks
**And** unknown keys produce validation errors (catch typos)
**And** `sweep` values must be arrays of the same type
**And** validation errors include the strategy name and all issues found (not just the first)
**And** YAML parsing and composition completes in <100ms (NFR5)
**And** the parser has comprehensive test coverage including error cases (NFR17)

### Story 2.6: Compose Engine — YAML to Strategy Object

As a quant researcher,
I want YAML definitions to be compiled into runnable strategy objects,
So that factory strategies are interchangeable with hand-coded JS strategies everywhere.

**Depends on:** Stories 2.2, 2.3, 2.4, 2.5

**Acceptance Criteria:**

**Given** a valid parsed YAML definition and a loaded block registry
**When** `composeFromYaml(yamlString)` or `composeFromDefinition(definition)` is called
**Then** the compose engine instantiates signal, filter, and sizer blocks from the definition
**And** it returns a strategy object with `{ name, evaluate, onWindowOpen, defaults, sweepGrid }` matching the existing strategy interface contract
**And** the `evaluate(state, config)` function: (1) evaluates all signals, (2) combines them via the `combine` operator (all-of or any-of), (3) applies all filters, (4) sizes the position, (5) returns a standard signal array `[{ action, token, capitalPerTrade, reason, confidence }]`
**And** `onWindowOpen` resets stateful blocks (e.g., once-per-window filter)
**And** factory output passes the existing strategy interface contract (NFR12)
**And** an integration test composes a YAML strategy and verifies its evaluate function produces correct signals against a mocked MarketState
**And** a known-strategy equivalence test recreates `edge-c-asymmetry` in YAML, composes it, runs both JS and YAML versions against 50 seeded windows, and confirms identical results (golden test baseline)
**And** a `validateDefinition(definition)` function checks all block references before composition

### Story 2.7: Factory Configuration and Public API

As a quant researcher,
I want factory configuration integrated into the existing config system and a clean public API,
So that factory functionality is accessible from scripts and future consumers.

**Depends on:** Story 2.6

**Acceptance Criteria:**

**Given** the compose engine and block registry are functional
**When** the factory module is imported via `src/factory/index.js`
**Then** a public API exports: `composeFromYaml`, `composeFromDefinition`, `validateDefinition`, `listBlocks`, `loadBlocks`
**And** a factory config block is added to `config/index.js` with: `strategiesDir`, `blocksDir`, `defaultSampleSize`, `maxSweepCombinations`, `defaultSeed`
**And** YAML strategy files can be placed in `src/factory/strategies/` and loaded by name
**And** a utility function loads a strategy by name (resolving `.yaml` or `.js` files from the strategies directory)
**And** the factory module follows existing patterns in the codebase (NFR14)

### Story 2.8: JS Escape Hatch Compatibility

As a quant researcher,
I want to use hand-coded JS strategies alongside YAML factory strategies with no distinction,
So that complex logic that exceeds DSL expressiveness can still participate in the factory workflow.

**Depends on:** Story 2.7

**Acceptance Criteria:**

**Given** the factory public API is operational
**When** a JS strategy file is loaded from `src/factory/strategies/` (or `src/backtest/strategies/`)
**Then** it is recognized as a valid strategy if it exports `{ name, evaluate, defaults, sweepGrid }`
**And** the strategy loader returns JS strategies and YAML strategies through the same interface
**And** JS strategies can be used in batch runs, sweeps, and comparisons identically to YAML strategies (FR42)
**And** an integration test verifies that a known hand-coded JS strategy (e.g., `edge-c-asymmetry`) can be loaded through the factory loader and produces expected output

---

## Epic 3: Turbo Backtester and Batch Runner

Matthew can backtest any strategy (YAML or JS) against cached timelines with sampling, sweeps, and baseline comparisons, run batches of strategy/symbol combinations in parallel, and get structured results persisted to the database with CLI summaries.

### Story 3.1: Stratified Random Sampler

As a quant researcher,
I want to sample windows using stratified random sampling with deterministic seeding,
So that backtests are fast, temporally representative, and reproducible.

**Depends on:** Epic 1 (timeline loader)

**Acceptance Criteria:**

**Given** a list of window metadata for a symbol (from `loadWindowsForSymbol`)
**When** `sampleWindows(windows, { count, seed, stratify })` is called
**Then** windows are grouped by stratum (weekly by default, configurable to daily or monthly)
**And** sample allocations are proportional to stratum size
**And** a seeded PRNG ensures the same seed + same data produces identical samples (NFR9)
**And** the default sample size is 200 windows
**And** if fewer windows exist than requested, all windows are returned
**And** the sampler module is at `src/factory/sampler.js`
**And** unit tests verify deterministic output, proportional allocation, and edge cases (empty input, count > available)

### Story 3.2: Factory Backtest Engine

As a quant researcher,
I want to backtest a factory or JS strategy against cached timelines with sampling and sweep support,
So that I can go from idea to backtest result in seconds.

**Depends on:** Story 3.1, Epic 2 (compose engine)

**Acceptance Criteria:**

**Given** pre-computed timelines exist in `data/timelines.sqlite` and a strategy (YAML or JS) is available
**When** `node scripts/backtest-factory.mjs --strategy=deficit-asymmetry-v1.yaml --symbol=btc --sample=200 --seed=42` is run
**Then** the strategy is loaded (YAML composed via factory, JS loaded directly)
**And** windows are sampled using stratified random sampling with the specified seed
**And** each sampled window's timeline is loaded from SQLite cache and evaluated
**And** if the strategy has a `sweepGrid`, all parameter combinations are tested (FR18)
**And** results include: trades, winRate, sharpe, sortino, profitFactor, maxDrawdown, expectancy, edgePerTrade (FR28)
**And** regime breakdown is computed: first half vs second half, time-of-day (4 buckets: overnight, morning, afternoon, evening), and day-of-week splits (FR28)
**And** statistical significance with confidence intervals is computed for key metrics using bootstrap methods (1000 resamples) for Sharpe ratio, with Lo (2002) autocorrelation adjustment when applicable (FR29)
**And** a baseline comparison (e.g., random entry, always-buy) is included in results (FR19)
**And** wall-clock execution time is reported (FR24)
**And** single strategy backtest on cached data completes in <500ms for 50 windows (NFR1)
**And** 16-combination parameter sweep completes in <5 seconds (NFR2)
**And** the core logic lives in `src/factory/cli/backtest-factory.js`, importable as a module

### Story 3.3: Result Persistence to PostgreSQL

As a quant researcher,
I want all backtest results automatically persisted to the database,
So that I can query historical results and track strategy performance over time.

**Depends on:** Story 3.2

**Acceptance Criteria:**

**Given** a backtest run has completed with results
**When** results are persisted
**Then** a `factory_runs` row is created with: manifest_name, manifest_json, status, started_at, completed_at, wall_clock_ms, total_runs, completed_runs, summary, error_message
**And** a `factory_results` row is created per strategy/config/symbol combination with: strategy_name, strategy_yaml, strategy_source ('yaml' or 'js'), symbol, config (JSONB), sample_size, sample_seed, metrics (JSONB), trades_summary, elapsed_ms
**And** DB table creation SQL is in a migration or initialization function
**And** indexes exist on `strategy_name`, `symbol`, and `created_at`
**And** a `result-persister.js` module handles all DB writes using the existing `src/persistence/index.js` module
**And** historical results are queryable by strategy, date range, and symbol (FR26)
**And** failed runs still persist with error_message and status='failed'

### Story 3.4: Structured JSON Output and CLI Tables

As a quant researcher,
I want backtest results output as structured JSON and as formatted CLI summary tables,
So that results are both machine-readable and human-scannable.

**Depends on:** Story 3.2

**Acceptance Criteria:**

**Given** a backtest run has completed
**When** results are rendered
**Then** structured JSON is written to stdout or a file containing: manifest metadata, per-run metrics, ranking, baseline, wall_clock_ms (FR27)
**And** a `--json` flag outputs raw JSON only (for piping to other tools)
**And** by default, a CLI summary table is rendered showing: rank, strategy name, config key params, sharpe, profitFactor, winRate, trades, totalPnl (FR30)
**And** variants are ranked by Sharpe ratio with parameter importance highlighted (FR31)
**And** multi-symbol comparisons flag unequal sample sizes with a warning (FR32)
**And** CLI table rendering completes in <1 second (NFR6)

### Story 3.5: Multi-Symbol Backtests

As a quant researcher,
I want to run the same strategy across multiple symbols and see a comparison table,
So that I can identify which instruments a strategy works best on.

**Depends on:** Story 3.4

**Acceptance Criteria:**

**Given** a strategy definition and multiple symbols with cached timelines
**When** `node scripts/backtest-factory.mjs --strategy=deficit-asymmetry-v1.yaml --symbol=btc,eth,sol --sample=200` is run
**Then** the strategy is backtested independently on each symbol
**And** a comparison table shows metrics side-by-side per symbol (FR21)
**And** unequal sample sizes across symbols are flagged (FR32)
**And** each symbol's results are independently persisted to the database
**And** porting a strategy to a different instrument requires only changing the `--symbol` flag (FR23)

### Story 3.6: Batch Runner — JSON Manifest Execution

As a quant researcher,
I want to define batch runs via JSON manifests and execute multiple strategy/config/symbol combinations in parallel,
So that I can run comprehensive explorations without manual iteration.

**Depends on:** Stories 3.3, 3.4

**Acceptance Criteria:**

**Given** a JSON manifest file describing multiple runs (strategy, symbol, sample, seed, config overrides)
**When** `node scripts/batch-run.mjs --manifest=deficit-exploration.json` is executed
**Then** the manifest is parsed and validated
**And** all runs execute in parallel using the existing `runParallelBacktest()` pattern (FR22)
**And** results are aggregated into a unified output with per-run metrics and overall ranking
**And** all results are persisted to `factory_runs` and `factory_results` tables
**And** a CLI summary table shows the ranking across all runs
**And** a `--json` flag outputs raw JSON for programmatic consumption
**And** manifest-level defaults (capital, fee, sweep) apply to all runs unless overridden per-run
**And** 100-combination batch run completes in <60 seconds (NFR3)
**And** the batch runner is implemented as `src/factory/batch-runner.js` with `runBatch(manifest)` and `runSingle(runSpec)` exports, usable programmatically by future consumers
**And** errors in individual runs do not crash the batch — they are captured and reported

---

## Epic 4: Mutation Engine and Strategy Versioning

Matthew can generate parameter perturbations, structural mutations, and crossovers of existing strategies, with all variants versioned and lineage tracked in the database.

### Story 4.1: Strategy Lineage Schema and Persistence

As a quant researcher,
I want a lineage tracking system for strategy versions,
So that I can see the full evolutionary history of any strategy variant.

**Acceptance Criteria:**

**Given** the PostgreSQL database is accessible
**When** the lineage system is initialized
**Then** a `strategy_lineage` table is created with: id, strategy_name, parent_name (NULL if original), mutation_type ('original', 'param_perturb', 'structural', 'crossover'), mutation_reasoning, yaml_definition, created_at, created_by ('matthew' or 'claude')
**And** a `recordMutation(parent, child, { mutationType, reasoning })` function persists lineage records
**And** a `getLineage(strategyName)` function returns the full ancestor chain for a strategy
**And** a `getChildren(strategyName)` function returns all direct descendants
**And** the naming convention follows `{base-name}-v{N}` for manual iterations and `{base-name}-m{N}` for mutations
**And** unit tests verify lineage recording and querying

### Story 4.2: Parameter Perturbation Engine

As a quant researcher,
I want to generate N parameter variations of an existing strategy,
So that I can quickly explore the parameter space around a promising configuration.

**Depends on:** Story 4.1, Epic 2 (YAML parser)

**Acceptance Criteria:**

**Given** an existing YAML strategy definition
**When** `perturbParams(yamlDef, { count: 10, perturbPct: [0.1, 0.2, 0.5] })` is called
**Then** N variant YAML definitions are generated with numeric parameters perturbed by the specified percentages (FR10)
**And** perturbations respect semantic param bounds: prices stay in [0, 1] for binary options, thresholds stay within [0.2x, 5x] of original value, counts stay positive integers
**And** each variant has a unique name following the `{base-name}-m{N}` convention
**And** each variant is a valid YAML definition that passes the factory parser validation
**And** perturbation details are recorded as mutation reasoning (FR15)
**And** lineage is recorded linking each variant to its parent (FR14)
**And** the mutation module is at `src/factory/mutation.js`
**And** `node scripts/mutate-strategy.mjs --strategy=deficit-asymmetry-v1.yaml --count=10 --type=perturb` generates variants and writes them to `src/factory/strategies/`

### Story 4.3: Structural Mutation Support

As a quant researcher,
I want to add or remove signals and filters from existing strategies to create structural variants,
So that I can explore fundamentally different strategy structures, not just parameter tweaks.

**Depends on:** Story 4.2

**Acceptance Criteria:**

**Given** an existing YAML strategy definition and the block registry
**When** a structural mutation is requested (FR11)
**Then** the mutation engine can add a new signal from the block library to the strategy
**And** the mutation engine can remove an existing signal (if more than one remains)
**And** the mutation engine can add or remove a filter
**And** each structural variant is validated against the factory parser before output
**And** structural mutation reasoning is captured: which block was added/removed and why (FR15)
**And** lineage is recorded with `mutation_type: 'structural'`

### Story 4.4: Strategy Crossover

As a quant researcher,
I want to combine elements from two different strategies into new hybrid variants,
So that I can discover synergies between different trading approaches.

**Depends on:** Story 4.2

**Acceptance Criteria:**

**Given** two existing YAML strategy definitions
**When** a crossover is requested (FR12)
**Then** the mutation engine can combine signals from strategy A with filters from strategy B
**And** the mutation engine can mix-and-match sizers between strategies
**And** each crossover variant has a unique name and is validated
**And** crossover reasoning captures which elements came from each parent (FR15)
**And** lineage records both parent strategies with `mutation_type: 'crossover'`

### Story 4.5: Batch Mutation Generation

As a quant researcher,
I want to generate multiple mutations in a single invocation and immediately see them available for backtesting,
So that mutation + backtest loops are fast and fluid.

**Depends on:** Stories 4.2, 4.3, 4.4

**Acceptance Criteria:**

**Given** an existing strategy and a mutation configuration
**When** `node scripts/mutate-strategy.mjs --strategy=deficit-asymmetry-v1.yaml --count=20 --type=perturb` is run (FR13)
**Then** N variant YAML files are generated and written to `src/factory/strategies/`
**And** all variants are registered in the strategy lineage table
**And** a summary table is printed showing variant names, mutation type, and key parameter changes
**And** a `--backtest` flag automatically backtests all generated variants via the batch runner
**And** a `--type=mixed` option generates a mix of perturbations, structural mutations, and crossovers
**And** Matthew can inspect generated YAML files before execution (FR9)

---

## Epic 5: System Compatibility and Integration Verification

All 73 existing JS strategies continue to work without modification, factory strategies are interchangeable with JS strategies in all system components, and no existing functionality is broken.

**NOTE: Story 5.1 is a CONTINUOUS GATE, not a final step.** The existing test suite must pass after every story completion across all epics. Story 5.1's acceptance criteria define the regression gate that runs continuously. Story 5.2 is the final interchangeability proof.

### Story 5.1: Existing Strategy Non-Regression (Continuous Gate)

As a quant researcher,
I want confirmation that all 73 existing JS strategies work identically after every code change,
So that I can trust the factory extension never breaks my deployed trading system.

**Acceptance Criteria:**

**Given** any story in any epic has been completed
**When** the existing test suite is run (`npx vitest run`)
**Then** all previously passing tests continue to pass (no regressions) (NFR18)
**And** the existing 73 strategies in `src/backtest/strategies/` load and execute without modification (FR39)
**And** the existing `MarketState` interface is unchanged — no added required fields (FR40)
**And** paper trading, live execution, orchestrator, and kill switch function identically (FR41)
**And** the existing `scripts/backtest.mjs` and `scripts/run-all-strategies-fast.mjs` produce the same results as before
**And** this gate runs after EVERY story completion, not just at the end of Epic 5

### Story 5.2: Factory-JS Strategy Interchangeability

As a quant researcher,
I want factory-composed strategies to be usable everywhere JS strategies are used,
So that I can seamlessly promote factory strategies to paper trading and live execution.

**Depends on:** Story 5.1, Epic 2, Epic 3

**Acceptance Criteria:**

**Given** a YAML strategy has been composed into a strategy object via the factory
**When** the strategy object is passed to existing system components
**Then** the existing parallel backtest engine accepts and runs factory strategies (FR42)
**And** factory strategies can be loaded by the paper trading system
**And** factory strategies produce the same signal format `[{ action, token, capitalPerTrade, reason }]` as JS strategies
**And** an integration test recreates a known JS strategy (e.g., `edge-c-asymmetry`) in YAML, backtests both, and confirms results are within rounding tolerance
**And** factory output passes the existing strategy interface contract, validated by test (NFR12)
