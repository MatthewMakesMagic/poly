# Story 3.2: Strategy Entry Evaluation

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **entry conditions evaluated against real-time market state**,
So that **I open positions only when strategy criteria are met (FR2)**.

## Acceptance Criteria

### AC1: Entry Evaluation on Each Tick

**Given** the execution loop is running
**When** market data is received on each tick
**Then** entry conditions are evaluated against current state
**And** evaluation includes: spot price, market price, time remaining in window
**And** evaluation results are logged at debug level

### AC2: Entry Signal Generation

**Given** entry conditions are met
**When** strategy signals "enter position"
**Then** the signal includes: direction (long/short), confidence, market_id, window_id
**And** the signal is logged with all evaluation inputs (expected vs actual format)
**And** signal is returned to orchestrator for downstream processing

### AC3: Silent Operation When No Signal

**Given** entry conditions are NOT met
**When** strategy evaluation completes
**Then** no action is taken
**And** the system continues monitoring (silent operation - FR24)
**And** debug log captures evaluation state for post-mortem analysis

### AC4: Multi-Window Evaluation

**Given** multiple windows are available
**When** evaluating entry conditions
**Then** each window is evaluated independently
**And** positions can be opened in multiple windows if criteria met
**And** window_id is always included in evaluation context

### AC5: Evaluation Logging for Post-Mortem

**Given** a strategy evaluates entry
**When** logging the evaluation
**Then** the log includes: expected conditions, actual values, decision made
**And** this enables post-mortem analysis of "why did we enter?"
**And** log format follows structured JSON schema from architecture

### AC6: Integration with Orchestrator

**Given** the strategy-evaluator module
**When** orchestrator processTick() runs
**Then** evaluateEntry() is called with current market state
**And** entry signals flow back to orchestrator for position opening
**And** module follows standard interface contract (init, getState, shutdown)

### AC7: Entry Condition Configuration

**Given** entry conditions are configurable (FR35)
**When** reading from config
**Then** entry thresholds come from config.strategy.entry section
**And** default thresholds are applied if not specified
**And** thresholds are validated at init time

## Tasks / Subtasks

- [x] **Task 1: Create Strategy-Evaluator Module Structure** (AC: 6)
  - [x] 1.1 Create `src/modules/strategy-evaluator/` directory
  - [x] 1.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 1.3 Create `types.js` with EntrySignal, EvaluationResult, and error types
  - [x] 1.4 Create `state.js` for evaluation state tracking
  - [x] 1.5 Create `entry-logic.js` for core entry evaluation

- [x] **Task 2: Implement Entry Evaluation Logic** (AC: 1, 2, 3)
  - [x] 2.1 Create evaluateEntry(marketState) function
  - [x] 2.2 Implement spot vs market price comparison
  - [x] 2.3 Implement window time remaining check
  - [x] 2.4 Generate EntrySignal when conditions met
  - [x] 2.5 Return null when conditions not met (silent operation)
  - [x] 2.6 Log evaluation at info level with expected vs actual

- [x] **Task 3: Implement Multi-Window Support** (AC: 4)
  - [x] 3.1 Create evaluateEntryConditions(marketState) that iterates all active windows
  - [x] 3.2 Return array of entry signals (one per qualifying window)
  - [x] 3.3 Include window_id in all evaluations and signals
  - [x] 3.4 Handle empty windows array gracefully

- [x] **Task 4: Implement Evaluation Logging** (AC: 5)
  - [x] 4.1 Create structured log entries with expected/actual format
  - [x] 4.2 Include all inputs: spot_price, market_price, threshold, time_remaining
  - [x] 4.3 Include decision: signal_generated (true/false) and reason
  - [x] 4.4 Follow snake_case field naming convention

- [x] **Task 5: Integrate with Orchestrator** (AC: 6)
  - [x] 5.1 Add strategy-evaluator to MODULE_INIT_ORDER in orchestrator
  - [x] 5.2 Update ExecutionLoop._onTick() to call evaluateEntryConditions()
  - [x] 5.3 Pass entry signals to orchestrator for downstream processing
  - [x] 5.4 Handle evaluation errors appropriately

- [x] **Task 6: Add Configuration** (AC: 7)
  - [x] 6.1 Add strategy.entry section to config/default.js
  - [x] 6.2 Define entry thresholds: spotLagThresholdPct (default 0.02)
  - [x] 6.3 Define minConfidence threshold (default 0.6)
  - [x] 6.4 Define minTimeRemainingMs (use existing trading.minTimeRemainingMs)
  - [x] 6.5 Validate config values at init time

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Test evaluateEntry() returns signal when conditions met
  - [x] 7.2 Test evaluateEntry() returns null when conditions not met
  - [x] 7.3 Test signal includes all required fields
  - [x] 7.4 Test multi-window evaluation returns correct signals
  - [x] 7.5 Test evaluation logging includes expected vs actual
  - [x] 7.6 Test config validation rejects invalid thresholds
  - [x] 7.7 Test integration with orchestrator tick cycle
  - [x] 7.8 Test module exports standard interface

## Dev Notes

### Architecture Compliance

This story creates the strategy-evaluator module that integrates with the orchestrator's execution loop. The module evaluates entry conditions on each tick and returns signals to the orchestrator.

**From architecture.md#Inter-Module-Communication:**
> "Orchestrator pattern - modules never import each other directly. All coordination flows through orchestrator."

The strategy-evaluator receives market state from orchestrator and returns signals back - it never directly calls order-manager or position-manager.

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  getState: () => {},
  shutdown: async () => {}
};
```

### Project Structure Notes

**Module location:** `src/modules/strategy-evaluator/`

Create these files:
```
src/modules/strategy-evaluator/
├── index.js          # Public interface (init, evaluateEntry, getState, shutdown)
├── entry-logic.js    # Core entry condition evaluation
├── state.js          # Evaluation state and metrics
├── types.js          # EntrySignal, EvaluationResult, StrategyEvaluatorError
└── __tests__/
    ├── index.test.js        # Integration tests
    └── entry-logic.test.js  # Unit tests for evaluation logic
```

### Entry Signal Type

```javascript
// src/modules/strategy-evaluator/types.js

/**
 * Entry signal generated when conditions are met
 */
export const EntrySignal = {
  window_id: '',        // Which 15-min window
  market_id: '',        // Polymarket market identifier
  direction: '',        // 'long' or 'short'
  confidence: 0,        // 0.0 to 1.0
  spot_price: 0,        // Spot price at signal
  market_price: 0,      // Market price at signal
  spot_lag: 0,          // spot - market (the edge)
  spot_lag_pct: 0,      // Percentage lag
  time_remaining_ms: 0, // Time until window expiry
  signal_at: '',        // ISO timestamp
};

/**
 * Evaluation result for logging/debugging
 */
export const EvaluationResult = {
  window_id: '',
  evaluated_at: '',
  spot_price: 0,
  market_price: 0,
  threshold_pct: 0,
  time_remaining_ms: 0,
  signal_generated: false,
  reason: '',           // 'conditions_met', 'insufficient_lag', 'time_expired', etc.
};
```

### Entry Condition Logic

The spot-lag strategy enters when:
1. **Spot price diverges from market price** by more than threshold
2. **Sufficient time remains** in the window (min 1 minute)
3. **Confidence threshold met** based on lag magnitude

```javascript
// src/modules/strategy-evaluator/entry-logic.js

/**
 * Evaluate entry conditions for a single window
 *
 * @param {Object} params - Evaluation parameters
 * @param {string} params.window_id - Window identifier
 * @param {string} params.market_id - Market identifier
 * @param {number} params.spot_price - Current spot price
 * @param {number} params.market_price - Current market price
 * @param {number} params.time_remaining_ms - Time until window expiry
 * @param {Object} params.thresholds - Entry thresholds from config
 * @returns {EntrySignal|null} Signal if conditions met, null otherwise
 */
export function evaluateEntry({
  window_id,
  market_id,
  spot_price,
  market_price,
  time_remaining_ms,
  thresholds,
}) {
  const { spotLagThresholdPct, minConfidence, minTimeRemainingMs } = thresholds;

  // Calculate spot lag
  const spot_lag = spot_price - market_price;
  const spot_lag_pct = market_price > 0 ? Math.abs(spot_lag / market_price) : 0;

  // Check time remaining
  if (time_remaining_ms < minTimeRemainingMs) {
    return { signal_generated: false, reason: 'insufficient_time' };
  }

  // Check if lag exceeds threshold
  if (spot_lag_pct < spotLagThresholdPct) {
    return { signal_generated: false, reason: 'insufficient_lag' };
  }

  // Calculate confidence based on lag magnitude
  const confidence = calculateConfidence(spot_lag_pct, spotLagThresholdPct);
  if (confidence < minConfidence) {
    return { signal_generated: false, reason: 'low_confidence' };
  }

  // Determine direction based on spot vs market
  const direction = spot_lag > 0 ? 'long' : 'short';

  return {
    window_id,
    market_id,
    direction,
    confidence,
    spot_price,
    market_price,
    spot_lag,
    spot_lag_pct,
    time_remaining_ms,
    signal_at: new Date().toISOString(),
  };
}

/**
 * Calculate confidence based on lag magnitude
 * Higher lag = higher confidence (up to 1.0)
 */
function calculateConfidence(lagPct, thresholdPct) {
  // Confidence scales from threshold to 2x threshold
  const ratio = lagPct / thresholdPct;
  return Math.min(1.0, 0.5 + (ratio - 1) * 0.25);
}
```

### Integration with Orchestrator

**Update `src/modules/orchestrator/state.js`:**

```javascript
// Add strategy-evaluator to MODULE_INIT_ORDER
export const MODULE_INIT_ORDER = [
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  { name: 'position-manager', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  // NEW: Add strategy-evaluator after order-manager
  { name: 'strategy-evaluator', module: null, configKey: 'strategy' },
];
```

**Update `src/modules/orchestrator/index.js`:**

```javascript
// Add import
import * as strategyEvaluator from '../strategy-evaluator/index.js';

// Add to MODULE_MAP
const MODULE_MAP = {
  // ... existing modules
  'strategy-evaluator': strategyEvaluator,
};
```

**Update `src/modules/orchestrator/execution-loop.js`:**

```javascript
async _onTick() {
  // ... existing code ...

  // 1. Fetch current spot prices
  let spotData = null;
  if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
    spotData = this.modules.spot.getCurrentPrice('btc');
  }

  // 2. Evaluate strategy entry conditions (Story 3.2)
  if (this.modules['strategy-evaluator'] && spotData) {
    const marketState = {
      spot_price: spotData.price,
      // Future: Get active windows and their market prices from polymarket client
      windows: [], // Will be populated when window management is implemented
    };

    const entrySignals = await this.modules['strategy-evaluator'].evaluateEntry(marketState);

    if (entrySignals && entrySignals.length > 0) {
      this.log.info('entry_signals_generated', {
        count: entrySignals.length,
        signals: entrySignals.map(s => ({
          window_id: s.window_id,
          direction: s.direction,
          confidence: s.confidence,
        })),
      });

      // Future: Pass signals to orchestrator for position opening (Story 3.3)
    }
  }

  // ... rest of tick processing
}
```

### Configuration Extension

Add to `config/default.js`:

```javascript
// Strategy configuration
strategy: {
  entry: {
    spotLagThresholdPct: 0.02,   // 2% lag required to enter
    minConfidence: 0.6,          // Minimum confidence to enter
    // minTimeRemainingMs comes from trading.minTimeRemainingMs
  },
},
```

### Structured Logging Format

Follow the architecture's structured log format:

```json
{
  "timestamp": "2026-01-31T10:15:30.123Z",
  "level": "debug",
  "module": "strategy-evaluator",
  "event": "entry_evaluated",
  "data": {
    "window_id": "btc-15m-2026-01-31-10:15",
    "expected": {
      "spot_lag_threshold_pct": 0.02,
      "min_time_remaining_ms": 60000
    },
    "actual": {
      "spot_price": 42150.50,
      "market_price": 42000.00,
      "spot_lag_pct": 0.0036,
      "time_remaining_ms": 720000
    },
    "signal_generated": false,
    "reason": "insufficient_lag"
  }
}
```

### Previous Story Intelligence

**From Story 3.1 (Orchestrator Module):**
- ExecutionLoop class with start/stop/pause/resume
- processTick() skeleton already fetches spot price
- Modules accessed via `this.modules` object
- Error handling via onError callback
- Module initialization in dependency order

**Key patterns established:**
- Child logger via `child({ module: 'module-name' })`
- ensureInitialized() guard pattern
- Module exports standard interface
- Typed errors with codes and context

**Test count at 602 - maintain or increase**

### Dependencies

**Existing modules used:**
- `src/modules/logger/index.js` - Structured logging via child()
- `src/clients/spot/index.js` - Spot price data

**Orchestrator changes required:**
- Add strategy-evaluator to MODULE_INIT_ORDER
- Add strategy-evaluator to MODULE_MAP
- Update execution-loop.js to call evaluateEntry()

### Testing Patterns

Follow established vitest patterns from Story 3.1:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as strategyEvaluator from '../index.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('StrategyEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await strategyEvaluator.shutdown();
  });

  describe('evaluateEntry', () => {
    it('should return signal when lag exceeds threshold', async () => {
      await strategyEvaluator.init(mockConfig);

      const result = await strategyEvaluator.evaluateEntry({
        spot_price: 42500,
        market_price: 41650, // ~2% lag
        windows: [{ window_id: 'test', market_id: 'btc', time_remaining_ms: 600000 }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe('long');
      expect(result[0].confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should return empty array when lag below threshold', async () => {
      await strategyEvaluator.init(mockConfig);

      const result = await strategyEvaluator.evaluateEntry({
        spot_price: 42100,
        market_price: 42000, // ~0.2% lag, below threshold
        windows: [{ window_id: 'test', market_id: 'btc', time_remaining_ms: 600000 }],
      });

      expect(result).toHaveLength(0);
    });
  });
});
```

### NFR Compliance

- **FR2** (Evaluate entry conditions against real-time market state): Core purpose of this story
- **FR24** (Operate silently when behavior matches expectations): Silent when no signal
- **FR35** (Configure strategy parameters without code changes): Entry thresholds in config
- **NFR5** (Market data processing keeps pace): Evaluation completes within tick interval
- **NFR9** (100% of trade events produce structured log): All evaluations logged

### Integration Notes

**This story creates the entry evaluation logic. Future stories complete the flow:**
- Story 3.3: Position sizing takes entry signals and calculates size
- Stories 3.4-3.5: Stop-loss and take-profit use position state
- Story 3.6: Window expiry handling

**Signal flow (after all Epic 3 stories):**
```
Tick → Spot Price → Strategy Evaluator → Entry Signal
                                              ↓
                                    Position Sizing (3.3)
                                              ↓
                                    Order Manager → CLOB
```

### References

- [Source: architecture.md#Inter-Module-Communication] - Orchestrator pattern
- [Source: architecture.md#Module-Interface-Contract] - init, getState, shutdown
- [Source: architecture.md#Structured-Log-Format] - JSON log schema
- [Source: architecture.md#Naming-Patterns] - snake_case for log fields
- [Source: epics.md#Story-3.2] - Story requirements and acceptance criteria
- [Source: prd.md#FR2] - System can evaluate entry conditions
- [Source: prd.md#FR24] - System operates silently when matching expectations
- [Source: 3-1-orchestrator-module-execution-loop.md] - Previous story patterns
- [Source: src/modules/orchestrator/execution-loop.js:147-150] - Integration point

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - no debug issues encountered during implementation.

### Completion Notes List

- Created strategy-evaluator module with standard interface (init, getState, shutdown)
- Implemented entry evaluation logic with spot-lag strategy:
  - Evaluates spot price vs market price lag
  - Checks time remaining in window
  - Calculates confidence based on lag magnitude (0.5 at threshold, 1.0 at 2x threshold)
  - Generates entry signal with direction (long/short) when conditions met
- Implemented multi-window support - evaluates each window independently
- Added structured logging with expected vs actual format for post-mortem analysis
- Integrated with orchestrator execution loop
- Added strategy.entry configuration section with defaults
- All tests pass (658 tests total, 56 new tests added)
- Test count increased from 602 to 658

### Change Log

- 2026-01-31: Implemented story 3-2 strategy entry evaluation

### File List

**New Files:**
- src/modules/strategy-evaluator/index.js
- src/modules/strategy-evaluator/types.js
- src/modules/strategy-evaluator/state.js
- src/modules/strategy-evaluator/entry-logic.js
- src/modules/strategy-evaluator/__tests__/index.test.js
- src/modules/strategy-evaluator/__tests__/entry-logic.test.js

**Modified Files:**
- src/modules/orchestrator/index.js (added strategy-evaluator import and MODULE_MAP entry)
- src/modules/orchestrator/state.js (added strategy-evaluator to MODULE_INIT_ORDER)
- src/modules/orchestrator/execution-loop.js (added strategy evaluation on each tick)
- src/modules/orchestrator/__tests__/execution-loop.test.js (updated test for tick_complete log level change)
- config/default.js (added strategy.entry configuration section)

