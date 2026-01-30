---
stepsCompleted: [step-01-init, step-02-discovery, step-03-success, step-04-journeys, step-05-domain, step-06-innovation, step-07-project-type, step-08-scoping, step-09-functional, step-10-nonfunctional, step-11-polish, step-12-complete]
classification:
  projectType: personal-trading-platform
  domain: fintech
  complexity: high
  projectContext: brownfield
inputDocuments:
  - product-brief-poly-2026-01-29.md
  - README.md
  - v2.md
  - STRATEGY_MANAGEMENT.md
  - POSITION_MANAGEMENT_REVIEW.md
  - TESTING.md
  - DEPLOY.md
  - IMPLEMENTATION_PLAN_TP_SL.md
  - EXECUTION.md
  - EXECUTION_ENGINE.md
  - goLive.md
  - SCOPE_TAKE_PROFIT_STOP_LOSS.md
  - PAPERTRADING.md
  - docs/futuremonitoring.md
documentCounts:
  briefs: 1
  research: 0
  projectDocs: 13
  brainstorming: 0
workflowType: 'prd'
date: 2026-01-30
---

# Product Requirements Document - poly

**Author:** Matthew
**Date:** 2026-01-30

---

## Executive Summary

Poly is a personal quantitative trading system for probabilistic markets, starting with Polymarket's 15-minute crypto binary options. The core problem: **validating trading hypotheses takes weeks, involves constant hot-fixing, and paper trading results don't translate to live performance.** Time that should go to curiosity and idea generation gets consumed by patching systems.

**Vision:** A system that lets us move at the speed of ideas - rapid hypothesis validation with agent-comprehensible modules that AI collaborators can understand and modify without needing full system context.

**MVP Philosophy:** Trust-first. Borrow when high conviction, rebuild when in doubt. The MVP proves the system can be trusted before adding features.

---

## Success Criteria

### User Success

- Morning briefing primes curiosity (future, not MVP)
- Live trading requires no active monitoring - silence = working
- Every trade is a learnable case study with structured data
- Time spent on ideas and curiosity, not debugging hot-fixes

### Technical Success (The Trust Bar)

| Metric | Target |
|--------|--------|
| **Error Explainability** | Every anomaly has a structured diagnostic - no "weird unexplainable" behaviors |
| **Diagnostic Coverage** | 100% - every trade event produces complete structured JSON log |
| **Blast Radius** | Fixes isolated to ≤2 modules - stop-loss bug doesn't cascade |
| **Fix Velocity** | Problems isolated to specific modules; fixes don't cascade |
| **No Orphaned State** | After any stop, system state is known and clean |

### Learning Velocity

| Metric | Target |
|--------|--------|
| **Hypothesis-to-Validation** | ~1 week from idea to live results |
| **Insight Density** | High ratio of "tested" to "changed something" |
| **Logging Continuity** | Structured logs continue without gaps |

### Safety Success

| Metric | Target |
|--------|--------|
| **Kill Switch** | <5 seconds from decision to all trading stopped |
| **Post-Kill Reconciliation** | Know exactly what's open, closed, pending - no scramble |

### Measurable Outcomes

| Timeframe | Success Indicators |
|-----------|-------------------|
| **1 Month** | 100% diagnostic coverage. Kill switch tested weekly. First hypothesis cycle complete. |
| **3 Months** | Multiple hypotheses tested with high insight density. Blast radius stays small. Trust earned. |
| **6 Months** | Institutional memory working. Hypothesis validation routine. System is trusted collaborator. |

---

## User Journeys

### Journey 1: Live Assurance (Primary User - Success Path)

**Opening Scene:** Trading window is active. Matthew is working on other things - ideas, research, life. The system is executing trades against the 15-minute crypto windows.

**Rising Action:** Trades execute according to strategy logic. Execution Monitor validates each trade against expected behavior. Structured JSON logs capture every signal, entry, exit.

**Climax:** Silence. Nothing demands attention. The system earns trust by behaving exactly as expected.

**Resolution:** Trading window closes with positions managed correctly. No orphaned state. Matthew's curiosity was protected - time went to ideas, not debugging.

**Failure Path:** If divergence detected → Alert with structured diagnostic: "Entry slippage of 0.03 due to latency (340ms) or liquidity gap." Clear, explainable, actionable.

---

### Journey 2: Review / Post-Mortem (Primary User - Learning Path)

**Opening Scene:** Trading window just closed. Matthew wants to understand what happened and why.

**Rising Action:** Opens trade autopsy view. Sees expected vs. actual for each trade. Chart context shows market conditions at signal time. Liquidity snapshot reveals order book state.

**Climax:** Pattern recognition moment - "Why did 3 of 5 trades have entry slippage?" The structured logs reveal: all three had latency >300ms during high-volume periods.

**Resolution:** Learning captured. Hypothesis formed: "Need to account for latency in high-volume conditions." This informs future strategy refinement. The system got smarter.

---

### Journey 3: Morning Ideation (Primary User - Curiosity Path)

**Opening Scene:** Morning. Matthew opens Poly. What happened overnight? What should I pay attention to today?

**Rising Action:** AI-generated briefing surfaces overnight activity, anomalies, recommendations. Something catches curiosity - an unexpected pattern in the data.

**Climax:** Drill into specific trades, visualizations. Hypothesis forms: "What if we adjusted the lag threshold for overnight windows?"

**Resolution:** Hypothesis queued for testing. Curiosity served. The briefing primed the day's thinking.

*Note: This journey is post-MVP (requires AI briefing layer).*

---

### Journey 4: Kill Switch Emergency (Primary User - Safety Path)

**Opening Scene:** Something's wrong. Unexpected behavior. Need to stop everything NOW.

**Rising Action:** One command or one click. Kill switch activated.

**Climax:** <5 seconds - all trading stopped. No new orders. Existing positions documented.

**Resolution:** Post-kill reconciliation. Clear understanding of exact state: what's open, what's closed, what's pending. No orphaned positions. No mystery orders. Clean restart when ready.

---

### Journey 5: Development Collaborator (AI Agent - Modification Path)

**Opening Scene:** Bug identified in stop-loss logic. AI agent needs to understand and fix.

**Rising Action:** Agent loads the bounded stop-loss module. Consistent data contracts at interfaces. Module is comprehensible within context window limits.

**Climax:** Fix is isolated to one module. Blast radius = 1. No cascading changes needed.

**Resolution:** Fix deployed. Structured logging confirms behavior matches expectation. Trust trajectory maintained.

---

### Journey Requirements Summary

| Journey | Capabilities Required |
|---------|----------------------|
| **Live Assurance** | Strategy execution, real-time monitoring, structured logging, divergence detection, alerting |
| **Review/Post-Mortem** | Trade autopsy views, expected vs. actual comparison, chart context, pattern recognition (post-MVP) |
| **Morning Ideation** | AI briefing generation, anomaly detection, hypothesis tracking (post-MVP) |
| **Kill Switch** | Instant stop, state reconciliation, no orphaned orders |
| **Development Collaborator** | Bounded modules, consistent data contracts, isolated fixes |

---

## Domain-Specific Requirements

*Domain: Personal Trading System (Fintech - High Complexity)*

### Execution & State Integrity

| Concern | Requirement |
|---------|-------------|
| **No Orphaned State** | System must never leave positions in unknown state. Every stop (graceful or forced) results in documented, reconcilable state. |
| **Order Integrity** | Orders submitted must be tracked to completion or failure. No "fire and forget" orders. |
| **State Reconciliation** | Ability to reconcile in-memory state with exchange state at any time. Database and API must agree. |

### API & Exchange Constraints

| Concern | Requirement |
|---------|-------------|
| **Rate Limits** | Respect Polymarket CLOB rate limits. Graceful degradation if limits hit. |
| **Latency Sensitivity** | 15-minute windows mean execution timing matters. Log latency for every order. |
| **API Key Security** | Keys stored securely, not in code. Rotation capability. |
| **Connection Resilience** | Handle disconnects, reconnects, missed data. No silent failures. |

### Financial Risk Controls

| Concern | Requirement |
|---------|-------------|
| **Position Limits** | Configurable maximum exposure per position and total. |
| **Kill Switch** | <5 second time-to-kill. Works even if main process is hung. |
| **Drawdown Limits** | Configurable daily/weekly loss limits that trigger automatic stop. |

### Crypto/Prediction Market Specific

| Concern | Requirement |
|---------|-------------|
| **Window Mechanics** | Understand 15-minute window resolution timing precisely. |
| **Probability Pricing** | Handle edge cases (0.01, 0.99, resolution events). |
| **Liquidity Awareness** | Don't assume orderbook depth. Check before sizing. |

### Risk Mitigations

| Risk | Mitigation |
|------|------------|
| **Orphaned positions from crash** | Persistent state with reconciliation on restart |
| **Stuck in bad position** | Kill switch + manual intervention path |
| **API changes/deprecation** | Bounded API module, easy to update in isolation |
| **Execution bugs losing money** | 100% diagnostic logging, blast radius ≤2 |

---

## Personal Trading Platform - Specific Requirements

### Project-Type Overview

This is a **real-time execution system** with these characteristics:
- Single user (Matthew), not multi-tenant
- Terminal/CLI primary interface, web dashboard future
- Connects to external APIs (Polymarket CLOB, spot price feeds)
- Time-sensitive execution (15-minute windows)
- Stateful (positions, orders, strategy state)
- Requires high reliability (real money at stake)

### Technical Architecture Considerations

**Execution Model:**
- Event-driven execution responding to market conditions
- Continuous monitoring during trading windows
- Graceful handling of API disconnects and reconnects

**State Management:**
- Persistent state (SQLite or similar) for positions, orders, logs
- In-memory state must reconcile with persistent state on restart
- No orphaned state under any failure condition

**Module Architecture:**
- Agent-comprehensible bounded modules
- Consistent data contracts at interfaces
- Blast radius ≤2 for any fix

**Configuration:**
- Strategy parameters externalized (not hardcoded)
- Risk limits configurable (position size, drawdown)
- API credentials secured outside codebase

### Key Technical Decisions

| Question | Answer |
|----------|--------|
| Real-time or batch? | Real-time during trading windows |
| State persistence? | Persistent + in-memory with reconciliation |
| Monitoring approach? | Silence = working, alerts on divergence |
| Kill switch? | External process, <5s to halt |
| Logging format? | Structured JSON with expected vs. actual |

### Strategy Architecture

**Composition Model:**
- Strategies composed from reusable parts (probability logic, entry conditions, exit rules, sizing)
- Parts can be shared across strategies
- A strategy is an instantiation of component versions

**Versioning Model:**
- **Fork as variation**: Creates new strategy instance with modified component (for testing hypotheses)
- **Update central**: Improves shared component when change is "purely thought out" (core fix)
- Version lineage tracked and visible in WindowUI (post-MVP)

**Visibility (Post-MVP):**
- See all strategy versions and their component composition
- Compare performance across variations
- Clear audit trail of what changed and when
- WindowUI shows strategy lineage and shared components

### Implementation Considerations

**Borrowed Components (existing, validate in production):**
- Polymarket API client
- CLOB order mechanics
- Spot price normalization
- Probability calculations

**Rebuilt Components (new architecture):**
- Position manager module
- Stop-loss / take-profit module
- Strategy execution module
- State reconciliation module
- Structured logging module

---

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Trust-First / Problem-Solving MVP

The MVP isn't about features - it's about proving the system can be trusted. Philosophy: *"Borrow when high conviction, rebuild when in doubt."*

**MVP Success Gate:**
- 2+ weeks continuous operation with trust metrics holding
- Zero orphaned state incidents
- Every divergence explained in structured diagnostic
- Only then proceed to add features

**Resource Model:** Personal project (Matthew) + AI agents as development collaborators

### MVP Feature Set (Phase 1)

**Core Journeys Supported:**
- Live Assurance (silence = working, alerts on divergence)
- Kill Switch Emergency (<5s to halt, clean state)
- Development Collaborator (bounded modules, isolated fixes)

**Must-Have Capabilities:**

| Capability | Rationale |
|------------|-----------|
| Position management (rebuilt) | Core of trust issues - must work reliably |
| Stop-loss / take-profit (rebuilt) | Source of constant hot-fixes - needs clean architecture |
| State reconciliation | No orphaned state under any condition |
| Structured logging | 100% diagnostic coverage, expected vs. actual |
| Kill switch | Safety non-negotiable |
| Strategy execution | Runs the actual trading logic |

**Borrowed with Validation:**
- Polymarket API connections
- CLOB order mechanics
- Spot price feeds
- Probability calculations

### Post-MVP Features

**Phase 2 - Visibility Layer:**
- Web dashboard with position visualization
- Trade autopsy views with chart context
- Real-time monitoring display
- Strategy version visibility

**Phase 3 - Intelligence Layer:**
- AI-generated daily briefings
- Pattern recognition across trades
- Hypothesis tracking and thesis status
- Morning Ideation journey enabled

**Phase 4 - Expansion:**
- Multi-timeframe windows (1-hour, 4-hour)
- Traditional options instruments
- Backtesting framework
- Paper trading mode with production parity

---

## Functional Requirements

### Strategy Execution

- **FR1:** System can execute trading strategies against live Polymarket windows
- **FR2:** System can evaluate entry conditions against real-time market state
- **FR3:** System can evaluate exit conditions (stop-loss, take-profit, window expiry)
- **FR4:** System can size positions based on configurable parameters and available liquidity
- **FR5:** System can respect configurable position limits and exposure caps

### Position Management

- **FR6:** System can track all open positions with current state
- **FR7:** System can reconcile in-memory position state with exchange state
- **FR8:** System can close positions through normal exit or emergency kill
- **FR9:** System can report position status on demand
- **FR10:** System can prevent opening positions that would exceed limits

### Order Management

- **FR11:** System can place orders through Polymarket CLOB API
- **FR12:** System can track orders from submission to fill/cancel/expiry
- **FR13:** System can handle partial fills appropriately
- **FR14:** System can cancel open orders on demand
- **FR15:** System can log latency for every order operation

### State Management

- **FR16:** System can persist state to durable storage (positions, orders, logs)
- **FR17:** System can reconcile in-memory state with persistent state on restart
- **FR18:** System can detect and report state divergence between memory, database, and exchange
- **FR19:** System can recover to known-good state after crash or kill

### Monitoring & Logging

- **FR20:** System can produce structured JSON logs for every trade event
- **FR21:** System can log expected vs. actual for each signal and execution
- **FR22:** System can detect divergence from expected behavior
- **FR23:** System can alert on divergence with structured diagnostic
- **FR24:** System can operate silently when behavior matches expectations

### Safety Controls

- **FR25:** User can trigger kill switch to halt all trading within 5 seconds
- **FR26:** Kill switch can operate even if main process is unresponsive
- **FR27:** System can document exact state at time of kill for reconciliation
- **FR28:** System can enforce configurable drawdown limits
- **FR29:** System can auto-stop when drawdown limits breached

### Strategy Composition

- **FR30:** Strategies can be composed from reusable components (probability logic, entry rules, exit rules, sizing)
- **FR31:** Components can be versioned independently
- **FR32:** System can track which component versions a strategy uses
- **FR33:** User can fork a strategy to create a variation with modified components
- **FR34:** User can update a central component when change is a core improvement

### Configuration

- **FR35:** User can configure strategy parameters without code changes
- **FR36:** User can configure risk limits (position size, exposure, drawdown)
- **FR37:** User can configure API credentials securely outside codebase

---

## Non-Functional Requirements

### Performance

| NFR | Requirement |
|-----|-------------|
| **NFR1** | Order placement completes within 500ms under normal conditions |
| **NFR2** | Kill switch halts all activity within 5 seconds of trigger |
| **NFR3** | State reconciliation completes within 10 seconds on restart |
| **NFR4** | System logs latency for every order operation for monitoring |
| **NFR5** | Market data processing keeps pace with real-time feed (no lag accumulation) |

### Reliability

| NFR | Requirement |
|-----|-------------|
| **NFR6** | System recovers to known-good state after any crash or kill |
| **NFR7** | No orphaned positions under any failure scenario |
| **NFR8** | State persisted to disk before acknowledging any position change |
| **NFR9** | 100% of trade events produce complete structured log (no gaps) |
| **NFR10** | System detects and reports state divergence between memory/database/exchange |

### Security

| NFR | Requirement |
|-----|-------------|
| **NFR11** | API credentials stored outside codebase (environment or secure file) |
| **NFR12** | API credentials never logged or exposed in diagnostics |
| **NFR13** | Credentials support rotation without code changes |

### Integration

| NFR | Requirement |
|-----|-------------|
| **NFR14** | System handles Polymarket API disconnects with automatic reconnection |
| **NFR15** | System respects rate limits and backs off gracefully when limits hit |
| **NFR16** | System detects and logs API response anomalies (unexpected formats, errors) |
| **NFR17** | Spot price feed failures trigger alerts, not silent degradation |
