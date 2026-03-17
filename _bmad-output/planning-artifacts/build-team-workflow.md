---
status: ready
date: 2026-03-14
project: poly — Quant Factory
scope: 9 epics, 38 stories (backend + dashboard)
---

# Quant Factory Build Team & Workflow

## Team Roster

| Role | Name | Expertise | Responsibility |
|---|---|---|---|
| Lead Architect | Winston | Systems design, integration | Orchestrates build order, reviews all work, resolves conflicts |
| Quant Advisor | Marcus | 12yr Goldman → prop trading, market microstructure | Reviews metrics, statistical methods, fill simulation. Veto on quantitatively naive code |
| Pipeline Engineer | Theo | Market dynamics, data integrity | Epic 1 — timelines, SQLite, MessagePack, validation |
| Factory Engineer | Amelia | Precision engineering, testing | Epic 2 — blocks, YAML DSL, compose engine |
| Backtester Engineer | Kai | Performance systems, parallel execution | Epic 3 — backtest engine, sampling, batch runner, persistence |
| Mutation Engineer | Rena | Evolutionary algorithms, search optimization | Epic 4 — perturbation, structural mutation, crossover, versioning |
| QA Architect | Vera + Cassandra | Statistical rigor + adversarial testing | Test infra, golden tests, integration matrix, FR coverage, regression gates |
| Dashboard Engineer | Sol | React, data visualization, API design | Epics 6-9 — API endpoints, views, charts, data hooks |
| UX Designer | Sally | Visual design, user experience | Screenshots actual dashboard, iterates on aesthetics. Veto on ugly views |

## Role Details

### Marcus (Quant Advisor)
Does not write code. Reviews what engineers produce and asks:
- "Your fill simulation assumes you can buy at the ask — what about adverse selection?"
- "This confidence interval uses normal distribution — binary option returns aren't normal"
- "Why is your sweep testing 1,000 combinations on 50 windows? Multiple comparison nightmare"

### Sally (UX Designer)
Does not write code. After Sol builds a view:
1. Screenshots the actual rendered view
2. Evaluates: spacing, color palette, typography, chart readability, information hierarchy
3. Provides specific visual feedback
4. Iterates with Sol until each view looks like top-tier quant firm internal tools
5. No story in Epics 7-9 is "done" until Sally confirms it's beautiful

## Build Phases

### Phase A — Parallel Start (no cross-dependencies)

| Agent | Epic | Stories | Work |
|---|---|---|---|
| Theo | Epic 1 | 1.1-1.6 | Data pipeline, SQLite cache, MessagePack, validation |
| Amelia | Epic 2 | 2.1-2.5 | Block registry, signals, filters, sizers, YAML parser |
| Sol | Epic 6 | 6.1-6.6 | Factory API endpoints, MSW fixtures, seed data |
| Vera | — | — | Test infrastructure, golden test framework, FR coverage tooling |

**Gate:** Regression suite passes after every story. Marcus reviews each completion.

### Phase B — After Phase A dependencies met

| Agent | Epic | Stories | Work |
|---|---|---|---|
| Amelia | Epic 2 | 2.6-2.8 | Compose engine, public API, JS escape hatch compat |
| Kai | Epic 3 | 3.1-3.6 | Backtester engine, sampling, batch runner, persistence, CLI |
| Sol | Epic 7 | 7.1-7.6 | Leaderboard, strategy cards, run history, lineage, nav |
| Sally | — | — | Reviews each view as Sol completes it |
| Vera | — | — | Cross-epic integration tests (Pipeline + Factory + Backtester) |

**Gate:** Integration test: YAML → compose → cache → evaluate → metrics → persist → API → dashboard

### Phase C — After Phase B complete

| Agent | Epic | Stories | Work |
|---|---|---|---|
| Rena | Epic 4 | 4.1-4.5 | Mutation engine, perturbation, crossover, versioning, lineage |
| Sol | Epic 8 | 8.1-8.5 | Regime charts, comparison tables, cross-symbol, confidence badges |
| Sally | — | — | Reviews charts, comparison tables, visual components |
| Vera | — | — | End-to-end golden tests (full pipeline) |

**Gate:** End-to-end: idea → YAML → mutate → batch backtest → ranked results → dashboard display

### Phase D — Final Verification

| Agent | Work |
|---|---|
| Sol | Epic 9: Story 9.1 (Data coverage view) |
| Sally | Final visual polish pass — every view, chart, card |
| Vera | Story 5.2 (Factory-JS interchangeability proof) |
| Winston | Final architecture review |
| Marcus | Final quant review — "would I trust these results with real money?" |
| Sally | Final screenshot review — "would I be proud to show this?" |

## Coordination Rules

1. One Claude Code session orchestrates all engineers
2. Agents work on non-overlapping files (enforced by epic/story boundaries)
3. Every story completion triggers `npx vitest run` (regression gate — Story 5.1)
4. Every phase completion triggers cross-epic integration tests
5. Marcus has veto on quantitatively naive code
6. Sally has veto on ugly views — "beautiful" is a real acceptance criterion
7. Winston resolves architectural conflicts between engineers
8. Dashboard uses MSW fixtures during development — never blocked by backend
9. No story ships without tests (unit + integration where applicable)

## Epic Summary

### Backend (Epics 1-5)
| Epic | Stories | Owner |
|---|---|---|
| Epic 1: Data Pipeline | 6 | Theo |
| Epic 2: Strategy Factory | 8 | Amelia |
| Epic 3: Backtester + Batch Runner | 6 | Kai |
| Epic 4: Mutation + Versioning | 5 | Rena |
| Epic 5: Compatibility (Continuous) | 2 | Vera |

### Dashboard (Epics 6-9)
| Epic | Stories | Owner |
|---|---|---|
| Epic 6: Factory API | 6 | Sol |
| Epic 7: Core Views | 6 | Sol + Sally |
| Epic 8: Visualizations | 5 | Sol + Sally |
| Epic 9: Data Coverage | 1 | Sol + Sally |

**Total: 9 epics, 38 stories, 9 team members**

## Reference Documents

- PRD: `_bmad-output/planning-artifacts/prd-quant-factory.md`
- Backend Architecture: `_bmad-output/planning-artifacts/architecture-quant-factory.md`
- Backend Epics: `_bmad-output/planning-artifacts/epics-quant-factory.md`
- Dashboard Architecture: `_bmad-output/planning-artifacts/architecture-dashboard.md`
- Dashboard Epics: `_bmad-output/planning-artifacts/epics-dashboard.md`
