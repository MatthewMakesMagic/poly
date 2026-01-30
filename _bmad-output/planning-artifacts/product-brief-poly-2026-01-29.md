---
stepsCompleted: [1, 2, 3, 4, 5]
inputDocuments:
  - docs/futuremonitoring.md
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
date: 2026-01-29
author: Matthew
---

# Product Brief: poly

## Executive Summary

Poly is a personal quantitative trading system designed to discover and exploit inefficiencies in probabilistic markets - starting with Polymarket's 15-minute crypto binary options and extending to other timeframes (1-hour, 4-hour) and traditional options instruments.

The core problem isn't just "how do we trade profitably" - it's **"how do we build a system that lets us move at the speed of ideas."** Today, validating a trading hypothesis takes weeks, involves constant hot-fixing of broken logic, and produces paper trading results that don't translate to live performance. Time that should go to curiosity and idea generation gets consumed by patching systems that AI agents claimed were fixed but weren't.

Poly aims to be a **permanent information edge** - a rigorous, modular platform that:

- Enables rapid hypothesis → backtest → paper → live validation
- Provides both **AI-curated daily briefings** (what should I pay attention to?) and **beautiful human-readable visualizations** (let me see for myself)
- Is built with **agent-comprehensible modules** - bounded components that AI agents can understand and modify without needing full system context
- Maintains **consistent data contracts** across components - high-quality readability at interfaces, with insight generation as a dedicated responsibility
- Creates **institutional memory that compounds** - learnings don't evaporate between sessions

Success is defined not by fixed profit targets, but by **letting the data teach us**. The philosophy: we don't believe it until we run it with live money in real market conditions.

---

## Core Vision

### Problem Statement

Building and validating quantitative trading strategies for probabilistic markets is slow, error-prone, and opaque:

- **Validation takes weeks**: Market conditions change, and there's no rapid way to test hypotheses against historical and live data
- **Paper trading is unreliable**: Results don't translate to live performance due to subtle system bugs and misunderstanding of market mechanics
- **Constant hot-fixing**: Instead of generating ideas and being curious, time is spent fixing stop losses, take profits, and entry logic that breaks in production
- **AI agents lack depth**: Agents claim "bug fixed, ready to ship" but don't understand underlying market mechanics or API limitations - and the architecture makes it hard for them to reason about isolated components
- **No visibility**: Lack of visualization tools to understand what's actually happening with positions, orders, and test results

### Problem Impact

The consequence is **wasted opportunity and stolen curiosity**. Good trading ideas exist - the data shows edge - but broken execution means entering markets and losing money immediately. The team spins wheels on hot-fixes instead of pursuing the curiosity and idea generation that creates alpha.

### Why Existing Solutions Fall Short

Traditional quant frameworks (QuantConnect, Zipline, Backtrader) are designed for conventional financial instruments and aren't relevant to this use case - Poly isn't a product for others, it's a personal system for a small, highly qualified team.

More fundamentally, existing tools don't address the core challenges:

- They assume reliable execution, not adversarial debugging of AI-generated code
- They don't support the dual-mode interaction model (AI briefing + human exploration)
- They aren't designed for AI agents as development collaborators - modules aren't bounded for agent comprehension
- They lack the feedback loop architecture needed to learn from live market conditions

### Proposed Solution

Poly is a modular quantitative trading system built with the philosophy that **components should be agent-comprehensible and data contracts should be consistent**:

1. **Rapid Hypothesis Validation**: From idea → backtest → paper → live in hours, not weeks
2. **Dual-Mode Interface**:
   - **Push**: Daily AI briefing with observations, anomalies, architecture recommendations, and ideas to test
   - **Pull**: Beautiful visualizations of positions, orders, and backtest results for human exploration and curiosity
3. **Agent-Comprehensible Architecture**: Bounded modules that AI agents can load, understand, and modify without needing full system context - enabling effective changes within context window limits
4. **Consistent Data Contracts**: Clean interfaces with agreed-upon formats; high-quality readability at boundaries, with insight generation as a dedicated system responsibility
5. **Institutional Memory**: Learnings compound across sessions; the system gets smarter, not just bigger
6. **Extensible to Other Instruments**: Built for 15-minute crypto markets first, but architected for traditional options and other probabilistic instruments

### Key Differentiators

| Differentiator | Description |
|----------------|-------------|
| **Personal, Not Product** | Built for a small qualified team, not consumers - no feature bloat, no market positioning games |
| **Live-First Philosophy** | Skepticism of paper results; real market conditions are the only true teacher |
| **Agent-Comprehensible Modules** | Architecture designed for AI collaborators to reason about components in isolation |
| **Push + Pull Interaction** | Daily AI briefing primes curiosity; exploration mode serves it - neither dominates |
| **Consistent Data Contracts** | Readability over reasoning at interfaces; insight generation is a dedicated responsibility |
| **Curiosity Protection** | The system's job is to protect human curiosity from being consumed by hot-fixes |
| **Extensibility by Design** | Built for probabilistic markets broadly - prediction markets, traditional options, other instruments |

---

## Target Users

### Primary User: The Trader-Strategist

**Profile: Matthew**

An experienced market participant with deep understanding of market mechanics and inefficiencies. Technically capable but focused on strategy and ideation rather than implementation details. Values curiosity and idea generation over operational tasks.

**Interaction Modes:**

| Mode | When | Primary Need | Success Looks Like |
|------|------|--------------|-------------------|
| **Live Assurance** | During active trading windows | Trust that the system is behaving as expected | Silence = working. Alerts only when something diverges from expected behavior. |
| **Review / Post-Mortem** | After trading windows close | Forensic reconstruction of what happened and why | Trade autopsy: expected vs. actual entry, chart context, liquidity snapshot, what-if analysis |
| **Ideation** | Morning briefing, curiosity sparks | Insights, recommendations, patterns worth exploring | AI-curated briefing primes curiosity; exploratory access to data serves it |

**Key Frustrations (Current State):**
- Time consumed by debugging instead of thinking
- Uncertainty about whether the system is actually doing what it should
- No structured way to understand *why* a trade diverged from expectation
- Insights buried in logs rather than surfaced proactively

**Success Vision:**
- Morning briefing primes the day's curiosity
- Live trading requires no active monitoring - the system earns trust through explained behavior
- Every trade is a learnable case study with structured data and clear visualization
- The system surfaces what matters; Matthew decides what to pursue

---

### Secondary Users: Qualified Team (Contingent)

**Profile:** Experienced market participants with technical capability, similar to Matthew. Contingent on Poly's success.

**Key Characteristics:**
- Market experience (not "punters gambling")
- Technically literate (can understand the system, not just use it)
- Would interact in similar modes: assurance, review, ideation

**Design Implication:** Clean interfaces, structured data, and self-explanatory visualizations serve both Matthew and future team members without requiring Matthew-specific knowledge.

---

### System Users: AI Agents

**Profile:** AI agents that interact with Poly's modules as development collaborators, execution monitors, and insight generators.

**Agent Roles:**

| Role | Function | What They Consume/Produce |
|------|----------|---------------------------|
| **Execution Monitor** | Real-time validation: "Do actual results match expected behavior?" | Consumes structured trade logs (JSON); produces alerts on divergence with diagnostic flags |
| **Insight Generator** | Pattern recognition across trades; surfaces recommendations | Consumes historical trade data; produces briefings, anomalies, hypotheses |
| **Development Collaborator** | Understands and modifies system components | Consumes bounded modules with consistent contracts; produces code changes |

**Structured Trade Log Format:**

Every trade produces a structured JSON log capturing:
- Strategy name and conditions met (expected vs. actual for each condition)
- Execution details (expected entry, actual entry, delta, liquidity, latency)
- Diagnostic flags (slippage cause, unexpected behaviors)

Example structure:
```json
{
  "strategy": "SpotLag_Aggressive",
  "window_epoch": 1738234500,
  "signal": {
    "conditions_met": {
      "spot_delta_pct": { "expected": ">0.03%", "actual": "0.047%", "met": true },
      "market_lag": { "expected": ">30%", "actual": "42%", "met": true },
      "time_remaining": { "expected": ">60s", "actual": "127s", "met": true }
    }
  },
  "execution": {
    "expected_entry": 0.42,
    "actual_entry": 0.45,
    "delta": 0.03,
    "liquidity_at_signal": { "bid_size": 1200, "ask_size": 850 },
    "latency_ms": 340
  },
  "diagnostic": {
    "flags": ["entry_price_worse_than_expected"]
  }
}
```

This format serves all consumers: Execution Monitor validates in real-time, Insight Generator analyzes patterns, Review mode visualizes for humans.

---

### User Journeys

**Live Assurance (Background):**
1. Trades execute according to strategy logic
2. Execution Monitor validates each trade against expected behavior
3. If match → Silence (trust maintained)
4. If divergence → Alert with structured diagnostic: "Entry slippage of 0.03 due to latency (340ms) or liquidity gap"

**Review / Post-Mortem Flow:**
1. Trading window closes → Review recent trades
2. Trade Autopsy view: expected vs. actual, chart context, liquidity at signal, what-if scenarios
3. Pattern recognition: "Why did 3 of 5 trades have entry slippage?"
4. Learning captured → Informs future strategy refinement or system improvement

**Morning Ideation Flow:**
1. Open Poly → AI-generated briefing (overnight activity, anomalies, recommendations)
2. Curiosity sparked → Drill into specific trades, visualizations, patterns
3. Hypothesis formed → Queue for testing or note for exploration

---

## Success Metrics

### Core Philosophy

Success is not measured by fixed profit targets. **The data teaches us.** Success is measured by the system's ability to:
1. Behave predictably and explain its behavior when it doesn't
2. Enable rapid hypothesis validation that leads to actionable insights
3. Surface clear proof/disproof of trading theses
4. Fail safely when things go wrong, with no orphaned state

---

### System Trust Metrics

| Metric | What It Measures | Success Looks Like |
|--------|------------------|-------------------|
| **Error Explainability** | When something goes wrong, can you understand why? | Every anomaly has a structured diagnostic. No "weird unexplainable missed orders." |
| **Diagnostic Coverage** | Percentage of trade events with complete structured logs | 100% coverage. Every signal, entry, exit, and anomaly produces the full JSON log. |
| **Blast Radius** | How many modules does a fix touch? | Fixes are isolated. A stop-loss bug doesn't require changes in 3+ modules. |
| **Fix Velocity** | How fast can you go from "something's wrong" to "fixed and deployed"? | Problems isolated to specific modules; fixes don't cascade. |
| **Trust Trajectory** | Over iterations, is trust increasing? | Fewer unexplained behaviors over time. Diagnostic coverage stays at 100%. Blast radius stays small. |

**The Trust Bar:** If there's a mistake, it's clear and fixable. If diagnostic coverage drops or blast radius grows, trust is eroding.

---

### Learning Velocity Metrics

| Metric | What It Measures | Target |
|--------|------------------|--------|
| **Hypothesis-to-Validation Time** | From idea to live results | ~1 week for a complete cycle |
| **Variations per Hypothesis** | Multiple variations tested per core idea | System generates and tracks multiple variations automatically |
| **Insight Density** | Of hypotheses tested, how many led to actionable changes? | High ratio of "tested" to "changed something" - not just validation theater |
| **Logging Continuity** | Does the system keep tracking as expected? | Structured logs continue without gaps or manual intervention |

**The Learning Bar:** An idea formed on Monday should have live validation data by the following Monday. And that validation should *teach you something* that changes behavior.

---

### Hypothesis Validation Metrics

**Thesis Tracking**

Each trading strategy is tied to an explicit hypothesis. The system tracks and reports thesis status:

| Status | Meaning |
|--------|---------|
| **Testing** | Hypothesis is being validated with live data |
| **Partially Proved** | Some evidence supports the thesis, some contradicts |
| **Full Consensus** | Strong evidence across multiple conditions/timeframes |
| **Clearly Disproved** | Data contradicts the hypothesis consistently |
| **Inconclusive** | Insufficient data or mixed signals |

**Example Hypothesis:** *"The 15-minute prediction markets lag the underlying spot price movements, creating an arbitrage edge."*

The system presents this thesis before trades start, tracks supporting/contradicting evidence, and updates status as data accumulates.

---

### Safety Metrics

| Metric | What It Measures | Target |
|--------|------------------|--------|
| **Kill Switch Accessibility** | Can you stop all live trading instantly? | One-click/one-command in both terminal and web app |
| **Time to Kill** | From decision to all trading stopped | <5 seconds |
| **Kill Switch Reliability** | Does it actually work? | Weekly activation test confirms no trades execute after kill |
| **No Orphaned State** | After kill, is system state clean and known? | All positions documented, no orphaned orders, no divergence between memory and database |
| **Post-Kill Reconciliation** | Defined process for understanding exact state | Clear reconciliation process, not a scramble. Know exactly what's open, closed, and pending. |

**The Safety Bar:** If things go badly, you can stop everything in <5 seconds, and you know *exactly* what state you're in when you stop. No orphaned positions, no mystery orders, no state drift.

---

### What Success Looks Like

| Timeframe | Success Indicators |
|-----------|-------------------|
| **1 Month** | Diagnostic coverage at 100%. Kill switch tested weekly. First hypothesis cycle complete with at least one actionable insight. |
| **3 Months** | Multiple hypotheses tested; insight density is high (changes happening, not just validation). Blast radius stays small across fixes. Trust earned through iterations. |
| **6 Months** | Institutional memory working - learnings compound. Hypothesis validation is routine and productive. System is a trusted collaborator. Kill switch never needed, but you trust it completely. |

---

## MVP Scope

### Core Features

**Philosophy: Borrow when high conviction, rebuild when in doubt.**

Nothing is "proven" until it runs in production. The approach is to borrow existing components where there's high conviction they work correctly, wrap them in the new modular architecture, and validate through live execution. When in doubt, rebuild from scratch with proper boundaries.

**Borrow with Validation (High Conviction):**
- Polymarket API connections and authentication
- CLOB order execution mechanics
- Basic probability/pricing logic
- Spot price data feeds and normalization

**Rebuild from Scratch (Need Fresh Architecture):**
- Position management - the core of trust issues in current system
- Stop-loss and take-profit logic - source of constant hot-fixes
- Strategy architecture - needs agent-comprehensible bounded modules
- State management - must eliminate orphaned state completely
- Structured logging - new JSON format for all trade events

**Foundation First, No Polish:**
- All visualization, dashboards, and briefing systems come AFTER the execution foundation is trustworthy
- "Trustworthy" means: reliably working + easy to review + no orphaned state
- The MVP earns the right to add features by proving stability first

### Out of Scope for MVP

**Deferred to Post-MVP:**
- Beautiful web dashboard and visualizations
- AI-generated daily briefings
- Multi-timeframe support (1-hour, 4-hour windows)
- Traditional options instrument support
- Backtesting framework
- Paper trading mode
- Automated hypothesis variation generation
- Institutional memory / learning compounding

**Explicitly Not Building:**
- Consumer-facing features or onboarding
- Multi-user support beyond Matthew
- Mobile interfaces
- External integrations beyond core exchanges

### MVP Success Criteria

**The Trust Bar (Must Hit):**
- 100% diagnostic coverage - every trade event produces complete structured JSON log
- Zero orphaned state - after any stop (graceful or kill switch), system state is known and clean
- Blast radius < 2 - any fix touches at most 2 modules
- Error explainability - no "weird unexplainable" behaviors; every anomaly has structured diagnostic

**Validation Approach:**
- Run in production with real money (small positions)
- Monitor for 2+ weeks of continuous operation
- Track every instance where behavior diverges from expectation
- Only add features when foundation proves stable

**Go/No-Go for Post-MVP:**
- If trust metrics hold for 2 weeks: proceed to add visualization layer
- If orphaned state or unexplained behaviors occur: diagnose, fix, reset the clock
- If blast radius grows: stop and refactor architecture

### Future Vision

**Post-MVP Evolution (Contingent on Trust):**

*Phase 2: Visibility Layer*
- Web dashboard with position visualization
- Trade autopsy views with chart context
- Real-time monitoring display

*Phase 3: Intelligence Layer*
- AI-generated daily briefings
- Pattern recognition across trades
- Hypothesis tracking and thesis status

*Phase 4: Expansion*
- Multi-timeframe windows (1-hour, 4-hour)
- Traditional options instruments
- Backtesting framework
- Paper trading mode with production parity

*Long-term Vision:*
- Institutional memory that compounds learnings
- Multiple qualified team members interacting with the system
- Extensibility to other probabilistic markets
- The "permanent information edge" realized
