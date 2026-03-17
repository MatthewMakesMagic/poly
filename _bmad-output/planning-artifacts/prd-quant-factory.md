---
stepsCompleted: [step-01-init, step-02-discovery, step-03-success, step-04-journeys, step-05-domain, step-06-innovation, step-07-project-type, step-08-scoping, step-09-functional, step-10-nonfunctional, step-11-polish, step-12-complete]
inputDocuments:
  - product-brief-poly-2026-01-29.md
  - docs/v3philosophy.md
  - docs/THINGSTOBACKTEST.md
  - docs/BACKTESTREVIEW030326.md
  - _bmad-output/strategies/strategy-workshop-2026-02-07.md
  - .claude/plans/partitioned-sparking-harp.md
  - _bmad-output/planning-artifacts/prd.md
documentCounts:
  briefs: 1
  research: 2
  projectDocs: 4
  brainstorming: 0
classification:
  projectType: research-automation-platform
  domain: computational-research
  domainBoundary: fintech-deployment
  complexity: high
  complexityDrivers: [simulation-fidelity, combinatorial-strategy-space, autonomous-agent-coordination]
  projectContext: brownfield
workflowType: 'prd'
date: 2026-03-14
---

# Product Requirements Document — Quant Factory

**Author:** Matthew
**Date:** 2026-03-14
**Project:** poly (brownfield extension)
**Classification:** Research automation platform | Computational research | High complexity

## Executive Summary

Poly is a personal quantitative trading platform for Polymarket's 15-minute crypto binary options. The v1 system is deployed and operational: 73 strategies, parallel backtester, L2-aware paper trading, live execution with kill switch, 20 exchange feeds, and comprehensive data infrastructure.

**The problem:** The bottleneck is no longer infrastructure — it's the human loop. Going from idea to tested strategy requires manually writing JS files, running backtests, reading results, and iterating. Time that should go to curiosity gets consumed by mechanical work.

**The solution:** The Quant Factory — a research automation layer that eliminates the gap between having an idea and testing it. Matthew describes a strategy to Claude Code in natural language. Claude Code composes it from a library of building blocks into a YAML definition, backtests it in seconds against cached data, mutates it into dozens of variations, and presents ranked results with statistical significance. All results are persisted, versioned, and structured for future dashboard and agent consumption.

**What makes it different:**
- **Composable Strategy DSL** with embedded sweep syntax and evolutionary mutation — not just parameter tuning but structural exploration of the strategy space
- **Guardrails, not gatekeepers** — quality flags informed by institutional quant knowledge (adverse selection, overfitting, regime dependence) that warn but never block creative ideas
- **Built for autonomy** — every component outputs structured JSON and persists results, ready for the future vision of cloud-deployed LLM agents running overnight research loops

**MVP focus:** Turbo backtester + strategy factory + batch runner. No dashboard, no agents, no quality flags in v1. CLI via Claude Code is the interface.

## Success Criteria

### User Success

**The Discovery Loop is Alive:**
- Matthew checks a review area and finds agent-surfaced strategy candidates with full backtest evidence — without having prompted them
- New ideas flow from data patterns the system observed, not just human hypotheses
- Review-to-decision takes <5 minutes per candidate: results summary, key metrics, confidence assessment, promote/reject action

**Trust Through Transparency:**
- Every strategy candidate shows full lineage: hypothesis → backtest results → statistical significance
- Clear notifications when live strategies diverge from expected performance
- Manual intervention always available — one action to pause or kill any strategy
- Emergency auto-stop on statistically significant drawdown (configurable threshold)

### Technical Success

**Simulation Fidelity (Professional-Grade):**
- Backtest → paper → live results converge within tolerances a professional quant firm would accept
- Confidence gates use institutional-quality statistical tests (minimum sample sizes, out-of-sample validation, significance thresholds)
- Fee simulation, latency modeling, and L2 fill simulation close the paper-live gap

**Research Velocity:**
- Single strategy backtest: <500ms from cached data
- Hundreds of variations tested in parallel without manual intervention
- Strategy creation from idea to testable code: seconds via Claude Code + factory DSL

**Operational Reliability:**
- Paper Mode = Live Mode (v3 philosophy — identical code paths, only executor differs)
- 100% diagnostic coverage on every trade event
- Statistically significant drawdown triggers automatic halt

### Measurable Outcomes

| Metric | Target | Timeframe |
|---|---|---|
| Time from idea to backtest result | <1 minute | Month 1 |
| Strategy candidates surfaced by agents | >0 per week | Month 2+ |
| Review-to-decision time per candidate | <5 minutes | Month 1 |
| Backtest-to-paper PnL convergence | Within professional tolerance | Month 2 |
| Emergency stop latency | <5 seconds | Day 1 |

## User Journeys

### Journey 1: The Spark (Matthew — Hand-Crafted Strategy)

Matthew's reading a paper on mean-reversion in binary markets. An idea hits: "What if I combine the Chainlink deficit signal with CLOB bid-size asymmetry — only buy DOWN when the book is lopsided?"

He tells Claude Code what he wants. Claude Code generates a YAML file with 12 lines describing the signal combination, filters, and sizing. He runs `node scripts/backtest.mjs --factory=deficit-asymmetry.yaml --sample=200 --sweep`. 40 seconds later: a comparison table with 16 parameter combinations across 200 stratified windows — Sharpe, PF, win rate, and a baseline row.

Two variants look promising — Sharpe above 1.5 with 100+ trades. He asks Claude Code to mutate them with 20 variations. Another minute. The best mutation has a 2.1 Sharpe. He promotes it to the research tracker as a seed for autonomous refinement, then goes back to reading.

**Capabilities revealed:** Strategy factory (YAML DSL), fast backtester (sampling, sweep), mutation engine, promotion to research tracker, baseline comparisons.

### Journey 2: The Harvest (Matthew — Dashboard Review)

Matthew opens the dashboard. The review area shows 4 new strategy candidates agents surfaced since his last visit. Each card: hypothesis origin, iteration count, best Sharpe, trade count, out-of-sample validation status, confidence badge.

He taps the top candidate. Full lineage: started as a mutation of `deficit-contrarian-v2`, 47 iterations over 12 hours, converged at 1.8 Sharpe across 400 windows, 62% win rate, max drawdown -3.2%. Out-of-sample: 1.6 Sharpe (slight degradation, expected). Confidence gate: green.

He hits "Promote to Paper." Another candidate has 3.5 Sharpe on 28 trades — red badge, insufficient sample. Another relies on laggy CoinGecko data. Reject both.

**Capabilities revealed:** Dashboard review area, strategy candidate cards, lineage/iteration history, confidence gates, promote/reject actions, leaderboard.

### Journey 3: The Fire Alarm (Matthew — Live Intervention)

Notification: strategy `deficit-contrarian-v7` hit -$45 over 3 hours, approaching drawdown threshold. Expected daily range: -$15 to +$25. Current deviation: 2.4 sigma. 8 consecutive losses on DOWN tokens.

He opens the dashboard. Chainlink's structural deficit narrowed from $80 to $30 — the signal premise is broken. He hits "Pause." It stops quoting immediately. Open positions held to resolution.

Other live strategies within expected ranges. He notes: the system should detect regime shifts that invalidate strategy premises. New hypothesis for agents to explore.

**Capabilities revealed:** Notification system, drawdown monitoring, deviation alerts, strategy pause/kill, regime context, incident → hypothesis feedback loop.

### Journey 4: The Autonomous Loop (Research Agent — System User)

A Claude Code agent assigned track "deficit-strategies" (Vera persona) initializes a research loop. It composes a YAML config, tests with 200 sampled windows, analyzes results, mutates, tests again. 10 variations. Best: threshold=65, 1.7 Sharpe on 220 trades. Out-of-sample: 1.5 Sharpe.

It logs iterations, updates the leaderboard, tries adaptive thresholds. Convergence — adaptive doesn't beat fixed. Marks track "refined," submits best config.

Matthew didn't spend any time on this.

**Capabilities revealed:** Agent CLI, research tracker, compose/test/mutate/analyze loop, convergence detection, leaderboard submission.

### Journey Requirements Summary

| Capability | Spark | Harvest | Fire Alarm | Agent |
|---|---|---|---|---|
| Strategy Factory (YAML DSL) | Primary | | | Primary |
| Turbo Backtester | Primary | | | Primary |
| Mutation Engine | Primary | | | Primary |
| Dashboard Review Area | | Primary | Primary | |
| Confidence Gates | | Primary | | Used |
| Leaderboard | | Used | | Primary |
| Notification System | | | Primary | |
| Drawdown Monitoring | | | Primary | |
| Strategy Pause/Kill | | | Primary | |
| Agent CLI / Research Tracker | Seed | | | Primary |

## Domain-Specific Requirements

### Statistical Rigor

- **Overfitting protection:** Flag strategies with high parameter count relative to trade count. Enforce out-of-sample validation before promotion.
- **Multiple comparison correction:** When sweep-testing 100+ variants, surface false discovery rate (~5% will look significant by chance).
- **Minimum sample sizes:** Configurable thresholds (default: 100+ for consideration, 200+ for promotion). Flag, don't block.
- **In-sample vs out-of-sample:** Automatic train/test split. Report both. Flag when out-of-sample degrades >20%.
- **Survivorship bias:** Show full distribution of sweep outcomes, not just winners.

### Market Microstructure Realism

- **Adverse selection modeling:** Measure fill quality — what happens to price after fill? Flag strategies that only get filled when wrong.
- **Realistic fills:** Default to L2 book-walking, not mid-price. Warn when edge disappears at realistic fills.
- **Market impact:** Model own impact at larger sizes. Flag when P&L depends on sizes exceeding typical book depth.
- **Fee impact by default:** Backtest with Polymarket's actual fee formula. Never fee-free by default.

### Strategy Quality Flags (Inform, Don't Block)

| Flag | Trigger | Severity |
|---|---|---|
| Insufficient sample | <100 trades | Warning |
| Likely overfit | Parameter count > trades/20 | Warning |
| No out-of-sample validation | Missing holdout test | Required before promotion |
| Edge disappears with realistic fills | P&L positive at mid, negative at L2 ask | Critical |
| High correlation with live strategy | >0.8 correlation | Info |
| No documented mechanism | Missing hypothesis field | Prompt |
| Regime-dependent | Performance varies >2x across periods | Warning |
| Stale quote vulnerability | Edge depends on quote speed | Warning |
| Look-ahead risk | Signal uses non-real-time data | Critical |

### Financial Safety

- Drawdown auto-stop on statistically significant loss (configurable threshold)
- Kill switch: <5 seconds to halt all live trading (already built)
- Per-strategy capital caps and position limits enforced at deployment boundary

### Data Integrity

- Ground truth hierarchy: gamma_resolved_direction > onchain > computed from CL
- Data validation on cache build: detect CLOB epoch mismatches, flat prices, gaps
- Timestamp sanity checks: verify event ordering, flag incomplete windows

### Philosophy: Guardrails, Not Gatekeepers

Enable genuine innovation and contrarian ideas while protecting against common pitfalls. Every flag is informational — Matthew makes the final call. A "likely overfit" strategy might be brilliant if the mechanism is sound. "No documented mechanism" prompts reflection, not rejection.

## Innovation & Novel Patterns

### Composable Strategy DSL with Evolutionary Search

YAML-defined strategies from composable building blocks with a mutation engine enabling evolutionary exploration. Sweep syntax (`{sweep:60,80,100}`) embedded in configs means a single file defines its own parameter grid. Mutations go beyond parameter perturbation to structural changes (add/remove signals, crossover between strategies).

### Future: Autonomous Quant Research Farm

Cloud-deployed fleet of LLM agents via API, each with a research track and BMAD persona (Vera for stats, Cassandra for skepticism), running overnight. Coordinated via shared leaderboard and research tracker. Vision scope, not MVP.

### Validation

- **DSL:** Recreate `edge-c-asymmetry` in YAML, confirm identical results vs hand-coded JS. Mutate and verify valid output.
- **Quality flags:** Run existing 73 strategies through flag system, verify correct identification of known issues.

### Risks

- **DSL expressiveness:** May not cover all JS strategy logic. Mitigation: JS is the escape hatch, DSL is additive.
- **Quality flag false positives:** Could discourage valid contrarian ideas. Mitigation: all flags informational, Matthew has final say.

## Research Automation Platform — Technical Requirements

### Data Pipeline

- Significantly faster than current PG-over-network approach (pre-computed timelines, cloud-hosted backtester, or both)
- Data integrity validation catches bugs like CLOB epoch mismatch — silently bad data is worse than no data
- Matthew should not need to understand pipeline internals — fast and correct

### Strategy Interface

- YAML/DSL covers common 80% of use cases; JS escape hatch for complex logic
- Both produce identical interface: `{ name, evaluate, defaults, sweepGrid }`
- Factory and JS strategies interchangeable in all system components

### Result Persistence

- All results persisted to database, dated, clearly logged
- Queryable by strategy, date range, symbol, research track
- Historical results enable edge decay trend analysis

### Dashboard (Post-MVP)

- Extend or rebuild deferred to implementation
- Review area for strategy candidates with promote/reject
- Leaderboard view
- Live strategy monitoring with drawdown alerts

## Functional Requirements

### Strategy Definition

- FR1: Matthew describes a strategy idea to Claude Code, which generates a YAML strategy definition
- FR2: Matthew describes a strategy idea to Claude Code, which generates JS when logic exceeds DSL expressiveness
- FR3: Parameter sweep ranges embeddable directly in strategy configs via sweep syntax
- FR4: System parses YAML definitions into runnable strategy objects matching JS interface
- FR5: Multiple signal generators composable via logical operators (all-of, any-of)
- FR6: Library of pre-built signal generators: chainlink deficit, BS fair value, exchange consensus, CLOB imbalance, momentum, mean reversion
- FR7: Library of pre-built filters: time window, price range, cooldown, max positions
- FR8: Library of pre-built sizing methods: fixed capital, Kelly fraction, volatility-scaled
- FR9: Matthew can inspect generated artefacts before execution to verify intent

### Strategy Mutation & Versioning

- FR10: Claude Code generates parameter perturbations of existing strategies on request
- FR11: Claude Code generates structural mutations (add/remove signal) on request
- FR12: Claude Code crosses over two strategies into new variants on request
- FR13: Mutation engine generates N variations in a single invocation
- FR14: Each variant versioned with clear lineage (what changed between versions)
- FR15: Mutation reasoning captured (why each variant was created)

### Backtesting

- FR16: Backtest any strategy (YAML or JS) against historical window data
- FR17: Stratified random sampling with deterministic seeding for reproducibility
- FR18: Parameter sweep across all combinations in strategy's sweep grid
- FR19: Baseline comparison included in results
- FR20: Historical data loads significantly faster than current PG-over-network
- FR21: Multi-symbol backtests with comparison table
- FR22: Batch runner: multiple strategy/config/symbol combinations in parallel
- FR23: Port strategy to different instruments (e.g., "run this on SOL")
- FR24: Execution wall-clock time reported per run

### Result Management

- FR25: All results persisted to database with timestamp, strategy config, symbol
- FR26: Historical results queryable by strategy, date range, symbol
- FR27: Structured JSON output (machine-readable)
- FR28: Metrics: Sharpe, Sortino, profit factor, max drawdown, win rate, trade count, expectancy, edge per trade, regime breakdown (first/second half, time-of-day)
- FR29: Statistical significance with confidence intervals on key metrics
- FR30: CLI formatted summary tables
- FR31: Rank and compare variants with parameter importance highlighting
- FR32: Cross-symbol comparisons flag unequal sample sizes

### Data Pipeline

- FR33: Build pre-computed timelines from raw tables (exchange ticks, CLOB snapshots, RTDS ticks, L2 book data)
- FR34: Validate data integrity on build (flat prices, epoch mismatches, gaps)
- FR35: Incremental updates (new windows without full rebuild)
- FR36: CLI command to trigger pipeline rebuild
- FR37: Timeline completeness reporting (loaded, skipped, flagged with reasons)
- FR38: Data coverage reporting per symbol (windows, L2 availability, date ranges)

### System Compatibility

- FR39: All 73 existing JS strategies work without modification
- FR40: Same MarketState interface for existing strategies
- FR41: Paper trading, live execution, orchestrator, kill switch unchanged
- FR42: Factory strategies interchangeable with JS strategies in all components

## Project Scoping & Phased Development

### MVP (Phase 1) — Backtester + Factory + Batch Runner

**Core journey:** The Spark (Journey 1) — idea → Claude Code → YAML → backtest → results → iterate

**Must-have:**

1. **Turbo Backtester** — fast data pipeline, random sampling, baseline comparisons, structured JSON output, all results persisted
2. **Strategy Factory** — composable building blocks, YAML DSL, sweep syntax, mutation engine, JS escape hatch
3. **Batch Runner** — JSON manifest input, parallel execution, structured output, built as service layer for future consumers

**Not in MVP:** Dashboard, quality flags, agent orchestration, paper-live parity, notifications, confidence gates.

**Design constraint:** All services built with dashboard and agent consumption in mind. Clean APIs, structured outputs, queryable results. CLI is the first consumer, not the only intended one.

### Phase 2 — Dashboard + Quality Flags

- Dashboard review area (candidates, leaderboard, promote/reject)
- Quality flags system (overfit, adverse selection, regime dependence)
- Live strategy monitoring with drawdown alerts
- Paper-live parity (fee models, latency simulation, L2 fills, reconciliation)
- Confidence gates for backtest → paper → live transitions

### Phase 3 — Autonomous Research

- Agent orchestration (Claude Code sessions as local agents)
- Research tracker and leaderboard persistence
- Agent CLI and prompt templates
- Multi-agent coordination

### Phase 4 — Cloud Research Farm

- Cloud-deployed LLM agents via API (1-10 overnight)
- Cross-pollination between research tracks
- Incident → hypothesis feedback loop
- Regime change detection and auto-pause

### Risk Mitigation

| Risk | Mitigation |
|---|---|
| Data pipeline architecture uncertainty | Start with fastest local path, evolve to cloud |
| DSL expressiveness limits | JS escape hatch — DSL is additive |
| Silently bad data | Validation on cache build + timeline completeness reporting |
| Edge decay (backtest ≠ live) | Phase 2 paper-live parity. MVP accepts this risk. |
| Solo developer resource | Tight MVP scope: backtester + factory + batch runner only |

## Non-Functional Requirements

### Performance

- NFR1: Single strategy backtest on cached data: <500ms
- NFR2: 16-combination parameter sweep: <5 seconds
- NFR3: 100-combination batch run: <60 seconds
- NFR4: Data pipeline cache build per symbol: <10 minutes
- NFR5: YAML parsing and composition: <100ms
- NFR6: CLI table rendering: <1 second

### Data Integrity

- NFR7: Pre-computed timelines produce bit-identical results to direct DB queries
- NFR8: Validation catches 100% of known anomaly patterns
- NFR9: Deterministic reproducibility given same strategy, config, data, seed
- NFR10: No silent data failures — all issues reported in completeness output

### Integration & Compatibility

- NFR11: ES Modules (Node.js 22) consistent with existing codebase
- NFR12: Factory output passes existing strategy interface contract — validated by test suite
- NFR13: PostgreSQL on Railway for persistence — existing stores can be extended or improved
- NFR14: CLI patterns follow existing conventions unless a better pattern is established
- NFR15: Existing functionality continues working — underlying implementation can be improved

### Maintainability

- NFR16: Each signal generator, filter, and sizer independently testable with unit tests
- NFR17: YAML parser has comprehensive test coverage including error cases
- NFR18: No regressions to existing test pass rate (98/115 files, 3031/3273 tests)
