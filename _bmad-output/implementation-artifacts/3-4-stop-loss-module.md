# Story 3.4: Stop-Loss Module

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **stop-loss conditions evaluated and positions closed when hit**,
So that **losses are limited according to my risk parameters (FR3)**.

## Acceptance Criteria

### AC1: Stop-Loss Threshold Calculation

**Given** an open position exists
**When** the stop-loss module evaluates
**Then** current price is compared to stop-loss threshold
**And** threshold is calculated from entry_price and configured stop-loss %
**And** calculation accounts for position side (long: price drops below threshold, short: price rises above threshold)

### AC2: Stop-Loss Trigger Detection

**Given** price crosses stop-loss threshold
**When** stop-loss is triggered
**Then** orchestrator is notified to close position
**And** close is executed as market order (immediate exit)
**And** the event is logged: "Stop-loss triggered at price X, threshold was Y"
**And** log includes: position_id, entry_price, current_price, stop_loss_threshold, loss_amount

### AC3: Silent Monitoring

**Given** price is above stop-loss threshold (for long) or below threshold (for short)
**When** stop-loss evaluates
**Then** no action is taken
**And** monitoring continues silently
**And** only debug-level log is produced (not info)

### AC4: Module Interface Compliance

**Given** the stop-loss module
**When** inspecting its interface
**Then** it exports: init(), evaluate(position, currentPrice), evaluateAll(positions, getCurrentPrice), getState(), shutdown()
**And** evaluate() returns: { triggered: boolean, reason?: string, action?: 'close', closeMethod?: 'market' }
**And** module follows standard interface contract from architecture

### AC5: Configuration Support

**Given** stop-loss configuration
**When** reading from config
**Then** stop-loss % is configurable per strategy (FR35)
**And** default stop-loss is applied if not specified
**And** config includes: defaultStopLossPct (e.g., 0.05 = 5%)
**And** validation rejects invalid percentages at init time

### AC6: Integration with Orchestrator Tick Cycle

**Given** the execution loop is running
**When** a tick occurs
**Then** stop-loss module evaluates all open positions
**And** uses current prices from spot feed or polymarket
**And** triggered stop-losses result in position close requests
**And** close requests flow to position-manager.closePosition(id, { emergency: true })

### AC7: Multiple Position Handling

**Given** multiple open positions exist
**When** stop-loss evaluates all positions
**Then** each position is evaluated independently
**And** multiple stop-losses can trigger in same tick
**And** each triggered stop-loss is logged separately
**And** a summary log shows total evaluated vs triggered

## Tasks / Subtasks

- [x] **Task 1: Create Stop-Loss Module Structure** (AC: 4)
  - [x] 1.1 Create `src/modules/stop-loss/` directory
  - [x] 1.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 1.3 Create `types.js` with StopLossResult, StopLossError, TriggerReason
  - [x] 1.4 Create `state.js` for tracking evaluation statistics
  - [x] 1.5 Create `logic.js` for core stop-loss calculations

- [x] **Task 2: Implement Stop-Loss Threshold Calculation** (AC: 1)
  - [x] 2.1 Create calculateStopLossThreshold(position, stopLossPct) function
  - [x] 2.2 For long positions: threshold = entry_price * (1 - stopLossPct)
  - [x] 2.3 For short positions: threshold = entry_price * (1 + stopLossPct)
  - [x] 2.4 Return { threshold, entry_price, side, stop_loss_pct }
  - [x] 2.5 Handle edge cases (zero price, negative percentage)

- [x] **Task 3: Implement Single Position Evaluation** (AC: 1, 2, 3)
  - [x] 3.1 Create evaluate(position, currentPrice, options) function
  - [x] 3.2 Calculate threshold using calculateStopLossThreshold()
  - [x] 3.3 For long: triggered if currentPrice <= threshold
  - [x] 3.4 For short: triggered if currentPrice >= threshold
  - [x] 3.5 Return StopLossResult with triggered, reason, action, closeMethod
  - [x] 3.6 Log at debug level when not triggered, info level when triggered

- [x] **Task 4: Implement Batch Evaluation** (AC: 6, 7)
  - [x] 4.1 Create evaluateAll(positions, getCurrentPrice) function
  - [x] 4.2 Iterate over all positions and call evaluate() for each
  - [x] 4.3 Collect all triggered results
  - [x] 4.4 Log summary: total_evaluated, triggered_count, positions_safe
  - [x] 4.5 Return array of results with only triggered positions

- [x] **Task 5: Add Configuration** (AC: 5)
  - [x] 5.1 Add strategy.stopLoss section to config/default.js
  - [x] 5.2 Add defaultStopLossPct (default: 0.05 = 5%)
  - [x] 5.3 Add enabled flag (default: true)
  - [x] 5.4 Validate config values at init time (percentage between 0 and 1)
  - [x] 5.5 Support per-position override via position.stop_loss_pct

- [x] **Task 6: Integrate with Orchestrator** (AC: 6)
  - [x] 6.1 Add stop-loss to MODULE_INIT_ORDER in orchestrator/state.js
  - [x] 6.2 Add stop-loss to MODULE_MAP in orchestrator/index.js
  - [x] 6.3 Update execution-loop.js to call evaluateAll() on each tick
  - [x] 6.4 For each triggered stop-loss, call position-manager.closePosition(id, { emergency: true })
  - [x] 6.5 Log position close results

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Test calculateStopLossThreshold() for long positions
  - [x] 7.2 Test calculateStopLossThreshold() for short positions
  - [x] 7.3 Test evaluate() triggers when price crosses threshold (long)
  - [x] 7.4 Test evaluate() triggers when price crosses threshold (short)
  - [x] 7.5 Test evaluate() does NOT trigger when price is safe
  - [x] 7.6 Test evaluateAll() processes multiple positions
  - [x] 7.7 Test evaluateAll() returns only triggered results
  - [x] 7.8 Test StopLossResult includes all required fields
  - [x] 7.9 Test config validation rejects invalid percentages
  - [x] 7.10 Test integration with orchestrator tick cycle
  - [x] 7.11 Test module exports standard interface

## Dev Notes

### Architecture Compliance

This story creates the stop-loss module that evaluates open positions for stop-loss conditions during each tick. It's part of the exit condition evaluation flow (FR3).

**From architecture.md#Inter-Module-Communication:**
> "Orchestrator pattern - modules never import each other directly. All coordination flows through orchestrator."

The stop-loss module receives position data and price data from orchestrator, and returns evaluation results. It never directly calls position-manager or order-manager.

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  getState: () => {},
  shutdown: async () => {}
};
```

**From architecture.md#Project-Structure:**
```
src/modules/
  stop-loss/
    index.js          # Public interface
    logic.js          # Stop-loss evaluation
    types.js          # SL-specific types
    __tests__/
        logic.test.js
```

### Project Structure Notes

**Module location:** `src/modules/stop-loss/`

Create these files:
```
src/modules/stop-loss/
├── index.js          # Public interface (init, evaluate, evaluateAll, getState, shutdown)
├── logic.js          # Core stop-loss calculations
├── state.js          # Evaluation statistics tracking
├── types.js          # StopLossResult, StopLossError, TriggerReason
└── __tests__/
    ├── index.test.js        # Integration tests
    └── logic.test.js        # Unit tests for stop-loss calculations
```

### StopLossResult Type

```javascript
// src/modules/stop-loss/types.js

/**
 * Trigger reasons for stop-loss
 */
export const TriggerReason = {
  PRICE_BELOW_THRESHOLD: 'price_below_threshold',  // Long position
  PRICE_ABOVE_THRESHOLD: 'price_above_threshold',  // Short position
  NOT_TRIGGERED: 'not_triggered',
};

/**
 * Stop-loss evaluation result
 */
export function createStopLossResult({
  triggered = false,
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  stop_loss_threshold = 0,
  stop_loss_pct = 0,
  reason = TriggerReason.NOT_TRIGGERED,
  action = null,          // 'close' when triggered
  closeMethod = null,     // 'market' for immediate exit
  loss_amount = 0,        // Potential loss if triggered
  loss_pct = 0,           // Loss as percentage of entry
  evaluated_at = '',
} = {}) {
  return {
    triggered,
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    stop_loss_threshold,
    stop_loss_pct,
    reason,
    action,
    closeMethod,
    loss_amount,
    loss_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}

/**
 * Stop-loss error codes
 */
export const StopLossErrorCodes = {
  NOT_INITIALIZED: 'STOP_LOSS_NOT_INITIALIZED',
  INVALID_POSITION: 'INVALID_POSITION',
  INVALID_PRICE: 'INVALID_PRICE',
  CONFIG_INVALID: 'STOP_LOSS_CONFIG_INVALID',
  EVALUATION_FAILED: 'STOP_LOSS_EVALUATION_FAILED',
};

export class StopLossError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'StopLossError';
    this.code = code;
    this.context = context;
  }
}
```

### Stop-Loss Logic

```javascript
// src/modules/stop-loss/logic.js

import { TriggerReason, createStopLossResult, StopLossError, StopLossErrorCodes } from './types.js';
import { incrementEvaluations, incrementTriggered } from './state.js';

/**
 * Calculate stop-loss threshold for a position
 *
 * @param {Object} position - Position with entry_price, side
 * @param {number} stopLossPct - Stop-loss percentage (e.g., 0.05 = 5%)
 * @returns {Object} { threshold, entry_price, side, stop_loss_pct }
 */
export function calculateStopLossThreshold(position, stopLossPct) {
  const { entry_price, side } = position;

  if (!entry_price || entry_price <= 0) {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_POSITION,
      'Position has invalid entry_price',
      { position_id: position.id, entry_price }
    );
  }

  if (stopLossPct < 0 || stopLossPct > 1) {
    throw new StopLossError(
      StopLossErrorCodes.CONFIG_INVALID,
      'Stop-loss percentage must be between 0 and 1',
      { stop_loss_pct: stopLossPct }
    );
  }

  let threshold;
  if (side === 'long') {
    // Long position: stop-loss triggers when price drops below threshold
    threshold = entry_price * (1 - stopLossPct);
  } else if (side === 'short') {
    // Short position: stop-loss triggers when price rises above threshold
    threshold = entry_price * (1 + stopLossPct);
  } else {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_POSITION,
      'Position has invalid side',
      { position_id: position.id, side }
    );
  }

  return {
    threshold,
    entry_price,
    side,
    stop_loss_pct: stopLossPct,
  };
}

/**
 * Evaluate stop-loss condition for a single position
 *
 * @param {Object} position - Position to evaluate
 * @param {number} currentPrice - Current market price
 * @param {Object} options - Evaluation options
 * @param {number} options.stopLossPct - Stop-loss percentage
 * @param {Object} options.log - Logger instance
 * @returns {Object} StopLossResult
 */
export function evaluate(position, currentPrice, options = {}) {
  const { stopLossPct = 0.05, log } = options;

  // Validate current price
  if (typeof currentPrice !== 'number' || currentPrice <= 0) {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_PRICE,
      'Invalid current price for stop-loss evaluation',
      { position_id: position.id, current_price: currentPrice }
    );
  }

  // Calculate threshold
  const { threshold, entry_price, side } = calculateStopLossThreshold(position, stopLossPct);

  // Track evaluation count
  incrementEvaluations();

  // Check if triggered
  let triggered = false;
  let reason = TriggerReason.NOT_TRIGGERED;

  if (side === 'long' && currentPrice <= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_BELOW_THRESHOLD;
  } else if (side === 'short' && currentPrice >= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_ABOVE_THRESHOLD;
  }

  // Calculate loss amount
  const priceMove = side === 'long'
    ? entry_price - currentPrice
    : currentPrice - entry_price;
  const loss_amount = position.size * priceMove;
  const loss_pct = priceMove / entry_price;

  const result = createStopLossResult({
    triggered,
    position_id: position.id,
    window_id: position.window_id,
    side,
    entry_price,
    current_price: currentPrice,
    stop_loss_threshold: threshold,
    stop_loss_pct: stopLossPct,
    reason,
    action: triggered ? 'close' : null,
    closeMethod: triggered ? 'market' : null,
    loss_amount: triggered ? loss_amount : 0,
    loss_pct: triggered ? loss_pct : 0,
  });

  // Log appropriately
  if (triggered) {
    incrementTriggered();
    if (log) {
      log.info('stop_loss_triggered', {
        position_id: position.id,
        window_id: position.window_id,
        side,
        entry_price,
        current_price: currentPrice,
        stop_loss_threshold: threshold,
        loss_amount,
        loss_pct,
        expected: { stop_loss_pct: stopLossPct },
        actual: { current_price: currentPrice, threshold_breached: true },
      });
    }
  } else {
    if (log) {
      log.debug('stop_loss_evaluated', {
        position_id: position.id,
        current_price: currentPrice,
        threshold,
        distance_to_threshold: side === 'long' ? currentPrice - threshold : threshold - currentPrice,
      });
    }
  }

  return result;
}

/**
 * Evaluate stop-loss for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} options - Evaluation options
 * @param {number} options.stopLossPct - Default stop-loss percentage
 * @param {Object} options.log - Logger instance
 * @returns {Object} { triggered: StopLossResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  const { stopLossPct = 0.05, log } = options;
  const triggered = [];
  let evaluatedCount = 0;

  for (const position of positions) {
    try {
      // Get current price for this position
      const currentPrice = getCurrentPrice(position);
      if (!currentPrice) {
        if (log) {
          log.warn('stop_loss_skip_no_price', { position_id: position.id });
        }
        continue;
      }

      // Use per-position stop-loss if set, otherwise default
      const positionStopLossPct = position.stop_loss_pct || stopLossPct;

      const result = evaluate(position, currentPrice, {
        stopLossPct: positionStopLossPct,
        log,
      });

      evaluatedCount++;

      if (result.triggered) {
        triggered.push(result);
      }
    } catch (err) {
      if (log) {
        log.error('stop_loss_evaluation_error', {
          position_id: position.id,
          error: err.message,
          code: err.code,
        });
      }
    }
  }

  const summary = {
    evaluated: evaluatedCount,
    triggered: triggered.length,
    safe: evaluatedCount - triggered.length,
  };

  if (log && evaluatedCount > 0) {
    log.info('stop_loss_evaluation_complete', {
      total_positions: positions.length,
      ...summary,
    });
  }

  return { triggered, summary };
}
```

### Integration with Orchestrator

**Update `src/modules/orchestrator/state.js`:**

```javascript
// Add stop-loss to MODULE_INIT_ORDER after position-sizer
export const MODULE_INIT_ORDER = [
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  { name: 'position-manager', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  { name: 'strategy-evaluator', module: null, configKey: 'strategy' },
  { name: 'position-sizer', module: null, configKey: 'strategy' },
  // NEW: Add stop-loss after position-sizer (exit conditions)
  { name: 'stop-loss', module: null, configKey: 'strategy' },
];
```

**Update `src/modules/orchestrator/index.js`:**

```javascript
// Add import
import * as stopLoss from '../stop-loss/index.js';

// Add to MODULE_MAP
const MODULE_MAP = {
  // ... existing modules
  'stop-loss': stopLoss,
};
```

**Update `src/modules/orchestrator/execution-loop.js`:**

```javascript
async _onTick() {
  // ... existing code for entry signals and sizing ...

  // 4. Evaluate exit conditions - stop-loss (Story 3.4)
  let stopLossResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
  if (this.modules['stop-loss'] && this.modules['position-manager']) {
    const stopLoss = this.modules['stop-loss'];
    const positionManager = this.modules['position-manager'];

    // Get all open positions
    const openPositions = positionManager.getPositions();

    if (openPositions.length > 0) {
      // Get current price for each position
      const getCurrentPrice = (position) => {
        // Use position's current_price if available, otherwise fetch from spot
        if (position.current_price) {
          return position.current_price;
        }
        // Fallback to spot price
        if (this.modules.spot && spotData) {
          return spotData.price;
        }
        return null;
      };

      stopLossResults = stopLoss.evaluateAll(openPositions, getCurrentPrice);

      // Close any triggered positions
      for (const result of stopLossResults.triggered) {
        try {
          await positionManager.closePosition(result.position_id, {
            emergency: true,
            closePrice: result.current_price,
            reason: 'stop_loss_triggered',
          });

          this.log.info('stop_loss_position_closed', {
            position_id: result.position_id,
            window_id: result.window_id,
            loss_amount: result.loss_amount,
            loss_pct: result.loss_pct,
          });
        } catch (closeErr) {
          this.log.error('stop_loss_close_failed', {
            position_id: result.position_id,
            error: closeErr.message,
            code: closeErr.code,
          });
        }
      }
    }
  }

  // 5. Future: Evaluate take-profit conditions (Story 3.5)
  // 6. Future: Check window expiry (Story 3.6)

  const tickDurationMs = Date.now() - tickStart;
  this.log.info('tick_complete', {
    tickCount: this.tickCount,
    durationMs: tickDurationMs,
    spotPrice: spotData?.price || null,
    entrySignalsCount: entrySignals.length,
    sizingResultsCount: sizingResults.length,
    sizingSuccessCount: sizingResults.filter(r => r.success).length,
    // NEW: Stop-loss metrics
    stopLossEvaluated: stopLossResults.summary.evaluated,
    stopLossTriggered: stopLossResults.summary.triggered,
  });
}
```

### Configuration Extension

Add to `config/default.js`:

```javascript
// Strategy configuration
strategy: {
  entry: {
    spotLagThresholdPct: 0.02,
    minConfidence: 0.6,
  },
  sizing: {
    baseSizeDollars: 10,
    minSizeDollars: 1,
    maxSlippagePct: 0.01,
    confidenceMultiplier: 0.5,
  },
  // NEW: Stop-loss configuration
  stopLoss: {
    enabled: true,                  // Enable/disable stop-loss evaluation
    defaultStopLossPct: 0.05,       // 5% default stop-loss
  },
},
```

### Structured Logging Format

Follow the architecture's structured log format:

```json
{
  "timestamp": "2026-01-31T10:15:30.123Z",
  "level": "info",
  "module": "stop-loss",
  "event": "stop_loss_triggered",
  "data": {
    "position_id": 42,
    "window_id": "btc-15m-2026-01-31-10:00",
    "side": "long",
    "expected": {
      "stop_loss_pct": 0.05,
      "entry_price": 0.50,
      "threshold": 0.475
    },
    "actual": {
      "current_price": 0.47,
      "threshold_breached": true,
      "loss_amount": 0.30,
      "loss_pct": 0.06
    }
  }
}
```

### Previous Story Intelligence

**From Story 3.3 (Position Sizing & Liquidity):**
- 731 tests passing after implementation
- Position-sizer integrated into execution-loop.js
- Established pattern: modules in tick cycle return results, orchestrator handles actions
- Child logger via `child({ module: 'module-name' })`
- ensureInitialized() guard pattern

**From Story 3.2 (Strategy Entry Evaluation):**
- EntrySignal type with window_id, market_id, direction, confidence
- Signals logged at info level with expected vs actual format
- evaluateEntryConditions() called in tick cycle

**From Story 3.1 (Orchestrator Module):**
- ExecutionLoop class with start/stop/pause/resume
- processTick() calls modules in sequence
- Modules accessed via `this.modules` object
- Error handling via onError callback

**Key patterns established:**
- Child logger via `child({ module: 'module-name' })`
- ensureInitialized() guard pattern
- Module exports standard interface
- Typed errors with codes and context
- Factory functions for result types (createStopLossResult)

**Test count at 731 - maintain or increase**

### Position Manager Integration

**From src/modules/position-manager/index.js:**
```javascript
// Methods used by stop-loss:
function getPositions() // Returns all open positions with current_price
async function closePosition(positionId, params = {})
  // params.emergency = true for market order close
  // params.closePrice = override close price
  // params.reason = 'stop_loss_triggered' for logging
```

**Position object structure (from types.js):**
```javascript
{
  id: number,
  window_id: string,
  market_id: string,
  token_id: string,
  side: 'long' | 'short',
  size: number,
  entry_price: number,
  current_price: number,
  status: 'open' | 'closed' | 'liquidated',
  strategy_id: string,
  // Optional: per-position stop-loss override
  stop_loss_pct?: number,
}
```

### Testing Patterns

Follow established vitest patterns from previous stories:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as stopLoss from '../index.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('StopLoss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopLoss.shutdown();
  });

  describe('evaluate', () => {
    it('should trigger when long position price drops below threshold', async () => {
      await stopLoss.init(mockConfig);

      const position = {
        id: 1,
        window_id: 'test-window',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = stopLoss.evaluate(position, 0.47); // 6% drop, threshold is 5%

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('price_below_threshold');
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('market');
    });

    it('should NOT trigger when long position price is above threshold', async () => {
      await stopLoss.init(mockConfig);

      const position = {
        id: 1,
        window_id: 'test-window',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = stopLoss.evaluate(position, 0.48); // 4% drop, threshold is 5%

      expect(result.triggered).toBe(false);
      expect(result.action).toBe(null);
    });

    it('should trigger when short position price rises above threshold', async () => {
      await stopLoss.init(mockConfig);

      const position = {
        id: 2,
        window_id: 'test-window',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      const result = stopLoss.evaluate(position, 0.53); // 6% rise, threshold is 5%

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('price_above_threshold');
    });
  });

  describe('evaluateAll', () => {
    it('should evaluate multiple positions and return only triggered', async () => {
      await stopLoss.init(mockConfig);

      const positions = [
        { id: 1, side: 'long', entry_price: 0.50, size: 10 },  // Will trigger at 0.47
        { id: 2, side: 'long', entry_price: 0.50, size: 10 },  // Safe at 0.50
        { id: 3, side: 'short', entry_price: 0.50, size: 10 }, // Will trigger at 0.53
      ];

      const getCurrentPrice = (pos) => {
        if (pos.id === 1) return 0.47;  // 6% drop - triggered
        if (pos.id === 2) return 0.50;  // No change - safe
        if (pos.id === 3) return 0.53;  // 6% rise - triggered
      };

      const { triggered, summary } = stopLoss.evaluateAll(positions, getCurrentPrice);

      expect(triggered.length).toBe(2);
      expect(summary.evaluated).toBe(3);
      expect(summary.triggered).toBe(2);
      expect(summary.safe).toBe(1);
    });
  });
});
```

### NFR Compliance

- **FR3** (Evaluate exit conditions - stop-loss): Core purpose of this story
- **FR35** (Configure strategy parameters without code changes): Stop-loss % in config
- **NFR5** (Market data processing keeps pace): Evaluation completes within tick interval
- **NFR9** (100% of trade events produce structured log): All evaluations logged

### Signal Flow After This Story

```
Tick → Spot Price → Strategy Evaluator → Entry Signal
                                              ↓
                                    Position Sizer
                                              ↓
                                    SizingResult → Order Manager (future)

Tick → Open Positions → Stop-Loss Module (this story)
                                              ↓
                              StopLossResult { triggered: true }
                                              ↓
                              Position Manager → closePosition()
```

### Critical Implementation Notes

1. **Side-Aware Threshold**: Long positions trigger when price drops BELOW threshold, short positions trigger when price rises ABOVE threshold. This is the opposite direction.

2. **Immediate Execution**: Stop-loss triggers should use market orders (emergency: true) to ensure immediate exit. Don't wait for limit fills.

3. **Current Price Source**: Use position.current_price if available (updated by tick), otherwise fall back to spot price. Log warning if no price available.

4. **Per-Position Override**: Support per-position stop_loss_pct that overrides the default. This enables different risk levels for different strategies.

5. **Silent When Safe**: Only log at debug level when positions are safe. Info logging only for triggered stop-losses to maintain "silence = working" principle.

6. **Atomic Evaluation**: Each position is evaluated independently. A failure in one position's evaluation should not prevent others from being evaluated.

7. **Loss Calculation**: Calculate loss_amount and loss_pct for diagnostics. For long: loss = size * (entry - current). For short: loss = size * (current - entry).

### References

- [Source: architecture.md#Inter-Module-Communication] - Orchestrator pattern
- [Source: architecture.md#Module-Interface-Contract] - init, getState, shutdown
- [Source: architecture.md#Project-Structure] - stop-loss module location
- [Source: architecture.md#Structured-Log-Format] - JSON log schema
- [Source: architecture.md#Naming-Patterns] - snake_case for log fields
- [Source: epics.md#Story-3.4] - Story requirements and acceptance criteria
- [Source: prd.md#FR3] - Evaluate exit conditions (stop-loss, take-profit, window expiry)
- [Source: prd.md#FR35] - Configure strategy parameters without code changes
- [Source: 3-3-position-sizing-liquidity.md] - Previous story patterns and module structure
- [Source: 3-2-strategy-entry-evaluation.md] - Signal evaluation patterns
- [Source: 3-1-orchestrator-module-execution-loop.md] - Orchestrator tick integration
- [Source: src/modules/position-manager/index.js:86-104] - getPositions() and closePosition() API
- [Source: src/modules/orchestrator/execution-loop.js:214-216] - Comment placeholder for stop-loss integration
- [Source: config/default.js:69-82] - Strategy configuration section

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - clean implementation with all tests passing.

### Completion Notes List

- Created stop-loss module with full standard interface (init, evaluate, evaluateAll, getState, shutdown)
- Implemented side-aware threshold calculation (long: price drops below, short: price rises above)
- Added per-position stop-loss override support
- Integrated with orchestrator tick cycle - evaluates all open positions on each tick
- Triggered stop-losses call position-manager.closePosition with emergency: true
- Added 70 new tests covering all acceptance criteria
- Full test suite passes: 801 tests (up from 731)
- Follows all established patterns: child logger, ensureInitialized guard, typed errors, factory functions

### File List

**New Files:**
- src/modules/stop-loss/index.js
- src/modules/stop-loss/logic.js
- src/modules/stop-loss/state.js
- src/modules/stop-loss/types.js
- src/modules/stop-loss/__tests__/index.test.js
- src/modules/stop-loss/__tests__/logic.test.js

**Modified Files:**
- config/default.js (added strategy.stopLoss configuration)
- src/modules/orchestrator/state.js (added stop-loss to MODULE_INIT_ORDER)
- src/modules/orchestrator/index.js (added stop-loss import and MODULE_MAP entry)
- src/modules/orchestrator/execution-loop.js (added stop-loss evaluation in tick cycle)

## Change Log

- 2026-01-31: Implemented story 3-4-stop-loss-module - all tasks complete, all tests passing
