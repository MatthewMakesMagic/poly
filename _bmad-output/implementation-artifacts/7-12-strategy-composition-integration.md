# Story 7.12: Strategy Composition Integration

Status: ready-for-dev

---

## Story

As a **trader**,
I want **oracle edge components wired into the Epic 6 composition framework**,
So that **I can compose and switch between strategy variations**.

---

## Acceptance Criteria

### AC1: Component Registration with Epic 6 Registry
**Given** new components exist from Epic 7
**When** registering with Epic 6 component registry
**Then** these components are registered:
- `rtds-client` (type: price-source)
- `oracle-tracker` (type: analysis)
- `oracle-edge-signal` (type: signal-generator)
- `window-timing-model` (type: probability)
- `lag-tracker` (type: analysis)

### AC2: Strategy Compositions Available
**Given** components are registered
**When** composing strategies
**Then** at least these compositions are available:
1. **Oracle Edge Only**: rtds-client + oracle-tracker + oracle-edge-signal
2. **Probability Model Only**: rtds-client + window-timing-model
3. **Lag-Based**: rtds-client + lag-tracker
4. **Hybrid**: All components with weighted signal combination

### AC3: Runtime Strategy Selection
**Given** strategy compositions exist
**When** selecting active strategy
**Then** selection is via config (no code change required)
**And** active strategy can be changed at runtime via CLI

### AC4: Backtest Capability
**Given** backtest capability
**When** evaluating strategies offline
**Then** historical tick data can be replayed through strategy
**And** signal outcomes can be calculated without live trading

---

## Tasks / Subtasks

- [ ] **Task 1: Extend ComponentType enum for Epic 7 types** (AC: 1)
  - [ ] Add `PRICE_SOURCE: 'price-source'` to ComponentType
  - [ ] Add `ANALYSIS: 'analysis'` to ComponentType
  - [ ] Add `SIGNAL_GENERATOR: 'signal-generator'` to ComponentType
  - [ ] Add corresponding TypePrefix mappings: `'price-source': 'src'`, `'analysis': 'anal'`, `'signal-generator': 'sig'`
  - [ ] Update `src/modules/strategy/types.js`

- [ ] **Task 2: Create adapter wrappers for Epic 7 modules as components** (AC: 1)
  - [ ] Create `src/modules/strategy/components/price-source/rtds-client.js`
    - [ ] Implement component interface: metadata, evaluate, validateConfig
    - [ ] Wrap `src/clients/rtds/index.js` functionality
    - [ ] evaluate() returns { prices: { ui, oracle }, connected, symbols }
  - [ ] Create `src/modules/strategy/components/analysis/oracle-tracker.js`
    - [ ] Wrap `src/modules/oracle-tracker/index.js`
    - [ ] evaluate() returns { staleness, patterns, last_update }
  - [ ] Create `src/modules/strategy/components/analysis/lag-tracker.js`
    - [ ] Wrap `src/modules/lag-tracker/index.js`
    - [ ] evaluate() returns { tau_star, correlation, signal }
  - [ ] Create `src/modules/strategy/components/signal-generator/oracle-edge-signal.js`
    - [ ] Wrap `src/modules/oracle-edge-signal/index.js`
    - [ ] evaluate() returns { has_signal, direction, confidence, inputs }

- [ ] **Task 3: Update discovery to find new component types** (AC: 1)
  - [ ] Update `discoverComponents()` in `src/modules/strategy/logic.js`
  - [ ] Add directories: `components/price-source/`, `components/analysis/`, `components/signal-generator/`
  - [ ] Ensure all new types can be discovered and cataloged

- [ ] **Task 4: Create pre-configured strategy compositions** (AC: 2)
  - [ ] Create `config/strategies/oracle-edge-only.json`
    - [ ] Components: rtds-client + oracle-tracker + oracle-edge-signal
    - [ ] Entry/exit wired to signal generator output
  - [ ] Create `config/strategies/probability-only.json`
    - [ ] Components: rtds-client + window-timing-model
    - [ ] Entry based on N(d2) probability threshold
  - [ ] Create `config/strategies/lag-based.json`
    - [ ] Components: rtds-client + lag-tracker
    - [ ] Entry based on lag signal with significance threshold
  - [ ] Create `config/strategies/hybrid.json`
    - [ ] All components with weighted signal combination
    - [ ] Configurable weights for each signal type

- [ ] **Task 5: Implement strategy loader from config** (AC: 3)
  - [ ] Create `src/modules/strategy/loader.js`
  - [ ] Implement `loadStrategyFromConfig(configPath)`
  - [ ] Register strategy with components from config
  - [ ] Return strategy ID for execution

- [ ] **Task 6: Add CLI commands for runtime strategy selection** (AC: 3)
  - [ ] Add `strategy list` command - show available strategies
  - [ ] Add `strategy select <id>` command - set active strategy
  - [ ] Add `strategy status` command - show current active strategy
  - [ ] Update `cli/commands/` with new commands

- [ ] **Task 7: Implement backtest engine** (AC: 4)
  - [ ] Create `src/backtest/engine.js`
  - [ ] Implement tick replay from `rtds_ticks` table
  - [ ] Feed historical ticks through strategy pipeline
  - [ ] Track signal outcomes against actual settlement
  - [ ] Calculate strategy performance metrics

- [ ] **Task 8: Create backtest CLI command** (AC: 4)
  - [ ] Create `scripts/backtest.mjs` (update existing if present)
  - [ ] Accept: strategy_id, start_date, end_date, symbol
  - [ ] Output: accuracy, P&L, win rate, max drawdown

- [ ] **Task 9: Update orchestrator for multi-strategy support** (AC: 2, 3)
  - [ ] Update `src/modules/orchestrator/index.js`
  - [ ] Allow switching active strategy at runtime
  - [ ] Route execution through selected strategy pipeline
  - [ ] Maintain backward compatibility with existing entry logic

- [ ] **Task 10: Write tests for integration** (AC: 1-4)
  - [ ] Unit tests for new component types
  - [ ] Integration tests for strategy composition
  - [ ] Integration tests for strategy switching
  - [ ] Backtest engine tests with mock historical data

---

## Dev Notes

### Architecture Compliance

**Module Location:** This story touches multiple locations:
- `src/modules/strategy/` - Core strategy framework extensions
- `src/modules/strategy/components/` - New component adapters
- `config/strategies/` - Pre-configured strategy definitions
- `src/backtest/` - Backtest engine
- `cli/commands/` - CLI extensions

**Epic 6 Component Framework Reference:**
The strategy module uses a 4-slot composition model: probability → entry → sizing → exit

For Epic 7 components, we need a different pipeline model that supports:
1. **Data Sources** (RTDS feeds)
2. **Analysis** (oracle-tracker, lag-tracker)
3. **Signal Generation** (oracle-edge-signal, window-timing-model)
4. **Trade Execution** (existing entry/exit components)

### Component Adapter Pattern

Each Epic 7 module needs a thin adapter wrapper that:
1. Exports standard component interface (metadata, evaluate, validateConfig)
2. Delegates to underlying module methods
3. Normalizes output to component result format

**Example Adapter Structure:**
```javascript
// components/analysis/oracle-tracker.js
import * as oracleTracker from '../../../oracle-tracker/index.js';

export const metadata = {
  name: 'oracle-tracker',
  version: 1,
  type: 'analysis',
  description: 'Tracks oracle update patterns and staleness',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

export function evaluate(context, config) {
  const { symbol } = context;
  const state = oracleTracker.getState();
  const staleness = oracleTracker.checkStaleness(symbol);

  return {
    staleness_ms: staleness.duration,
    is_stale: staleness.is_stale,
    last_update: state.updates[symbol]?.last_timestamp,
    pattern: state.patterns[symbol],
  };
}

export function validateConfig(config) {
  return { valid: true };
}
```

### Strategy Pipeline Extension

The existing pipeline (probability → entry → sizing → exit) assumes a single-path execution.

For Epic 7's multiple signal sources, extend to support:

```
[Data Sources]
     ↓
[Analysis Components] → parallel execution
     ↓
[Signal Aggregation] → combine signals with weights
     ↓
[Entry Decision]
     ↓
[Sizing]
     ↓
[Exit Rules]
```

**Aggregation Options:**
1. **First Signal Wins**: Execute on first signal generated
2. **Weighted Average**: Combine signals with configurable weights
3. **Unanimous**: All signals must agree
4. **Threshold Count**: At least N signals must fire

### Pre-Configured Strategies

**1. Oracle Edge Only (`oracle-edge-only.json`):**
```json
{
  "name": "Oracle Edge Only",
  "description": "Trade based on oracle staleness and UI/oracle divergence",
  "components": {
    "priceSource": "src-rtds-client-v1",
    "analysis": ["anal-oracle-tracker-v1"],
    "signalGenerator": "sig-oracle-edge-signal-v1"
  },
  "config": {
    "stalenessThresholdMs": 15000,
    "minDivergencePct": 0.1,
    "maxTimeToExpiryMs": 30000
  }
}
```

**2. Probability Model Only (`probability-only.json`):**
```json
{
  "name": "Probability Model Only",
  "description": "Black-Scholes N(d2) based entry using oracle price",
  "components": {
    "priceSource": "src-rtds-client-v1",
    "probability": "prob-window-timing-model-v1"
  },
  "config": {
    "entryThreshold": 0.70,
    "exitThreshold": 0.30
  }
}
```

**3. Lag-Based (`lag-based.json`):**
```json
{
  "name": "Lag-Based",
  "description": "Trade based on cross-correlation lag between feeds",
  "components": {
    "priceSource": "src-rtds-client-v1",
    "analysis": ["anal-lag-tracker-v1"]
  },
  "config": {
    "minCorrelation": 0.5,
    "significanceThreshold": 0.05
  }
}
```

**4. Hybrid (`hybrid.json`):**
```json
{
  "name": "Hybrid",
  "description": "Weighted combination of all signal sources",
  "components": {
    "priceSource": "src-rtds-client-v1",
    "probability": "prob-window-timing-model-v1",
    "analysis": ["anal-oracle-tracker-v1", "anal-lag-tracker-v1"],
    "signalGenerator": "sig-oracle-edge-signal-v1"
  },
  "config": {
    "weights": {
      "probability": 0.3,
      "oracleEdge": 0.4,
      "lagSignal": 0.3
    },
    "aggregation": "weighted_average",
    "minCombinedScore": 0.6
  }
}
```

### Backtest Engine Design

**Core Flow:**
```javascript
async function runBacktest(strategyId, options) {
  const { startDate, endDate, symbol } = options;

  // 1. Load historical ticks
  const ticks = await loadHistoricalTicks(startDate, endDate, symbol);

  // 2. Load strategy
  const strategy = getStrategy(strategyId);

  // 3. Replay ticks through strategy
  const signals = [];
  for (const tick of ticks) {
    const context = buildContextFromTick(tick);
    const result = executeStrategy(strategyId, context);

    if (result.decision.action === 'enter') {
      signals.push({
        timestamp: tick.timestamp,
        direction: result.decision.direction,
        probability: result.decision.probability,
      });
    }
  }

  // 4. Match signals to outcomes
  const outcomes = await matchSignalsToOutcomes(signals);

  // 5. Calculate metrics
  return calculateBacktestMetrics(outcomes);
}
```

**Metrics Calculated:**
- Win Rate: correct / total signals
- P&L: sum of individual trade P&L
- Max Drawdown: worst peak-to-trough decline
- Sharpe Ratio: risk-adjusted returns
- Signal Quality: accuracy by confidence bucket

### CLI Commands

**`strategy list`:**
```
Available Strategies:
  1. oracle-edge-only (active)
  2. probability-only
  3. lag-based
  4. hybrid
```

**`strategy select <id>`:**
```
> strategy select probability-only
Switching active strategy to: probability-only
Previous: oracle-edge-only
Strategy loaded and validated.
```

**`strategy status`:**
```
Active Strategy: probability-only
Components:
  - priceSource: src-rtds-client-v1 ✓
  - probability: prob-window-timing-model-v1 ✓
Config:
  - entryThreshold: 0.70
  - exitThreshold: 0.30
Last Execution: 2026-02-01T14:30:00Z
Signals Today: 12 (8 correct, 66.7%)
```

### Dependencies

**Required internal modules:**
- `src/modules/strategy/` - Epic 6 composition framework
- `src/clients/rtds/` - Story 7-1 RTDS client
- `src/modules/oracle-tracker/` - Story 7-4 oracle pattern tracker
- `src/modules/oracle-edge-signal/` - Story 7-7 signal generator
- `src/modules/strategy/components/probability/window-timing-model.js` - Story 7-10
- `src/modules/lag-tracker/` - Story 7-11 lag analysis

**Database tables used:**
- `rtds_ticks` - Historical tick data for backtest
- `oracle_updates` - Oracle price history
- `lag_signals` - Lag signal outcomes
- `oracle_edge_signals` - Oracle edge signal outcomes
- `strategy_instances` - Strategy registry (Epic 6)

### Previous Story Intelligence (7-11)

**Key Learnings from Story 7-11 (Lag Tracker):**
1. Buffer pattern for batch database operations
2. Cross-correlation calculation at multiple tau values
3. Statistical significance with p-value < 0.05
4. Signal outcome tracking for accuracy measurement
5. Standard module interface pattern

**From Story 7-10 (Window Timing Model):**
1. Component metadata structure for registry
2. evaluate() and validateConfig() interface
3. Black-Scholes N(d2) probability calculation
4. Calibration tracking pattern

**From Epic 6 Stories:**
1. Component version ID format: `{prefix}-{name}-v{version}`
2. Strategy composition: probability → entry → sizing → exit
3. Deep merge for config inheritance in forks
4. Batch upgrade for component version changes

### Configuration Schema

**config/default.js additions:**
```javascript
{
  strategies: {
    default: 'oracle-edge-only',           // Default active strategy
    configDir: 'config/strategies/',       // Strategy definition directory
    autoDiscover: true,                    // Auto-register strategies from dir
  },
  backtest: {
    tickBatchSize: 10000,                  // Ticks per batch in replay
    parallelEval: false,                   // Single-threaded by default
    outputDir: 'logs/backtest/',           // Backtest result storage
  }
}
```

### File Structure

New files to create:
```
src/modules/strategy/
├── components/
│   ├── price-source/
│   │   └── rtds-client.js           # RTDS client adapter
│   ├── analysis/
│   │   ├── oracle-tracker.js        # Oracle tracker adapter
│   │   └── lag-tracker.js           # Lag tracker adapter
│   └── signal-generator/
│       └── oracle-edge-signal.js    # Oracle edge signal adapter
├── loader.js                         # Strategy config loader

config/strategies/
├── oracle-edge-only.json
├── probability-only.json
├── lag-based.json
└── hybrid.json

src/backtest/
├── engine.js                         # Backtest engine
├── replay.js                         # Tick replay logic
└── metrics.js                        # Performance metrics calculation

cli/commands/
├── strategy-list.js
├── strategy-select.js
└── strategy-status.js
```

### Project Structure Notes

- New component types (price-source, analysis, signal-generator) extend Epic 6 framework
- Backward compatible - existing strategies still work
- Pre-configured strategies loaded from JSON config files
- Backtest capability enables offline strategy evaluation
- CLI commands provide runtime strategy management

### Philosophy

> Don't pick winners upfront. Instrument everything, log everything, let the data decide which strategy variation actually works.

This story enables that philosophy by:
1. Making all strategies composable and switchable
2. Providing backtest capability to evaluate historically
3. Supporting multiple signal sources that can be weighted
4. Allowing runtime strategy changes for live experimentation

### Testing Strategy

1. **Component Adapter Unit Tests:**
   - Each adapter correctly wraps underlying module
   - evaluate() returns expected format
   - validateConfig() catches invalid configs

2. **Strategy Composition Tests:**
   - All pre-configured strategies load without error
   - Component references resolve correctly
   - Pipeline execution produces valid results

3. **CLI Integration Tests:**
   - `strategy list` shows all strategies
   - `strategy select` changes active strategy
   - `strategy status` reports correct state

4. **Backtest Engine Tests:**
   - Historical ticks loaded correctly
   - Signals generated match live behavior
   - Metrics calculated accurately

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-12]
- [Source: _bmad-output/planning-artifacts/architecture.md#Strategy Composition (FR30-34)]
- [Source: src/modules/strategy/index.js - Epic 6 strategy interface]
- [Source: src/modules/strategy/composer.js - Composition and execution]
- [Source: src/modules/strategy/registry.js - Component registration]
- [Source: src/modules/strategy/components/probability/window-timing-model.js - Component pattern]
- [Source: src/modules/lag-tracker/index.js - Module interface pattern]
- [Source: src/clients/rtds/index.js - RTDS client interface]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

