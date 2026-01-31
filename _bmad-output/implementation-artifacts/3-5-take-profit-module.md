# Story 3.5: Take-Profit Module

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **take-profit conditions evaluated and positions closed when hit**,
So that **I lock in gains according to my strategy (FR3)**.

## Acceptance Criteria

### AC1: Take-Profit Threshold Calculation

**Given** an open position exists
**When** the take-profit module evaluates
**Then** current price is compared to take-profit threshold
**And** threshold is calculated from entry_price and configured take-profit %
**And** calculation accounts for position side (long: price rises above threshold, short: price drops below threshold)

### AC2: Take-Profit Trigger Detection

**Given** price crosses take-profit threshold
**When** take-profit is triggered
**Then** orchestrator is notified to close position
**And** close can be executed as limit order (for better fill - not emergency like stop-loss)
**And** the event is logged: "Take-profit triggered at price X, threshold was Y"
**And** log includes: position_id, entry_price, current_price, take_profit_threshold, profit_amount

### AC3: Silent Monitoring

**Given** price is below take-profit threshold (for long) or above threshold (for short)
**When** take-profit evaluates
**Then** no action is taken
**And** monitoring continues silently
**And** only debug-level log is produced (not info)

### AC4: Module Interface Compliance

**Given** the take-profit module
**When** inspecting its interface
**Then** it exports: init(), evaluate(position, currentPrice), evaluateAll(positions, getCurrentPrice), getState(), shutdown()
**And** evaluate() returns: { triggered: boolean, reason?: string, action?: 'close', closeMethod?: 'limit' }
**And** module follows standard interface contract from architecture

### AC5: Configuration Support

**Given** take-profit configuration
**When** reading from config
**Then** take-profit % is configurable per strategy (FR35)
**And** default take-profit is applied if not specified
**And** config includes: defaultTakeProfitPct (e.g., 0.10 = 10%)
**And** validation rejects invalid percentages at init time

### AC6: Integration with Orchestrator Tick Cycle

**Given** the execution loop is running
**When** a tick occurs
**Then** take-profit module evaluates all open positions (after stop-loss evaluation)
**And** uses current prices from spot feed or polymarket
**And** triggered take-profits result in position close requests
**And** close requests flow to position-manager.closePosition(id, { closePrice, reason: 'take_profit_triggered' })

### AC7: Multiple Position Handling

**Given** multiple open positions exist
**When** take-profit evaluates all positions
**Then** each position is evaluated independently
**And** multiple take-profits can trigger in same tick
**And** each triggered take-profit is logged separately
**And** a summary log shows total evaluated vs triggered

## Tasks / Subtasks

- [x] **Task 1: Create Take-Profit Module Structure** (AC: 4)
  - [x] 1.1 Create `src/modules/take-profit/` directory
  - [x] 1.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 1.3 Create `types.js` with TakeProfitResult, TakeProfitError, TriggerReason
  - [x] 1.4 Create `state.js` for tracking evaluation statistics
  - [x] 1.5 Create `logic.js` for core take-profit calculations

- [x] **Task 2: Implement Take-Profit Threshold Calculation** (AC: 1)
  - [x] 2.1 Create calculateTakeProfitThreshold(position, takeProfitPct) function
  - [x] 2.2 For long positions: threshold = entry_price * (1 + takeProfitPct)
  - [x] 2.3 For short positions: threshold = entry_price * (1 - takeProfitPct)
  - [x] 2.4 Return { threshold, entry_price, side, take_profit_pct }
  - [x] 2.5 Handle edge cases (zero price, negative percentage)

- [x] **Task 3: Implement Single Position Evaluation** (AC: 1, 2, 3)
  - [x] 3.1 Create evaluate(position, currentPrice, options) function
  - [x] 3.2 Calculate threshold using calculateTakeProfitThreshold()
  - [x] 3.3 For long: triggered if currentPrice >= threshold
  - [x] 3.4 For short: triggered if currentPrice <= threshold
  - [x] 3.5 Return TakeProfitResult with triggered, reason, action, closeMethod
  - [x] 3.6 Log at debug level when not triggered, info level when triggered

- [x] **Task 4: Implement Batch Evaluation** (AC: 6, 7)
  - [x] 4.1 Create evaluateAll(positions, getCurrentPrice) function
  - [x] 4.2 Iterate over all positions and call evaluate() for each
  - [x] 4.3 Collect all triggered results
  - [x] 4.4 Log summary: total_evaluated, triggered_count, positions_safe
  - [x] 4.5 Return array of results with only triggered positions

- [x] **Task 5: Add Configuration** (AC: 5)
  - [x] 5.1 Add strategy.takeProfit section to config/default.js
  - [x] 5.2 Add defaultTakeProfitPct (default: 0.10 = 10%)
  - [x] 5.3 Add enabled flag (default: true)
  - [x] 5.4 Validate config values at init time (percentage between 0 and 1)
  - [x] 5.5 Support per-position override via position.take_profit_pct

- [x] **Task 6: Integrate with Orchestrator** (AC: 6)
  - [x] 6.1 Add take-profit to MODULE_INIT_ORDER in orchestrator/state.js (after stop-loss)
  - [x] 6.2 Add take-profit to MODULE_MAP in orchestrator/index.js
  - [x] 6.3 Update execution-loop.js to call evaluateAll() after stop-loss evaluation
  - [x] 6.4 For each triggered take-profit, call position-manager.closePosition(id, { closePrice, reason: 'take_profit_triggered' })
  - [x] 6.5 Log position close results

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Test calculateTakeProfitThreshold() for long positions
  - [x] 7.2 Test calculateTakeProfitThreshold() for short positions
  - [x] 7.3 Test evaluate() triggers when price crosses threshold (long)
  - [x] 7.4 Test evaluate() triggers when price crosses threshold (short)
  - [x] 7.5 Test evaluate() does NOT trigger when price is below/above threshold
  - [x] 7.6 Test evaluateAll() processes multiple positions
  - [x] 7.7 Test evaluateAll() returns only triggered results
  - [x] 7.8 Test TakeProfitResult includes all required fields
  - [x] 7.9 Test config validation rejects invalid percentages
  - [x] 7.10 Test integration with orchestrator tick cycle
  - [x] 7.11 Test module exports standard interface

## Dev Notes

### Architecture Compliance

This story creates the take-profit module that evaluates open positions for take-profit conditions during each tick. It's part of the exit condition evaluation flow (FR3).

**From architecture.md#Inter-Module-Communication:**
> "Orchestrator pattern - modules never import each other directly. All coordination flows through orchestrator."

The take-profit module receives position data and price data from orchestrator, and returns evaluation results. It never directly calls position-manager or order-manager.

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
  take-profit/
    index.js          # Public interface
    logic.js          # Take-profit evaluation
    types.js          # TP-specific types
    __tests__/
        logic.test.js
```

### Project Structure Notes

**Module location:** `src/modules/take-profit/`

Create these files:
```
src/modules/take-profit/
├── index.js          # Public interface (init, evaluate, evaluateAll, getState, shutdown)
├── logic.js          # Core take-profit calculations
├── state.js          # Evaluation statistics tracking
├── types.js          # TakeProfitResult, TakeProfitError, TriggerReason
└── __tests__/
    ├── index.test.js        # Integration tests
    └── logic.test.js        # Unit tests for take-profit calculations
```

### TakeProfitResult Type

```javascript
// src/modules/take-profit/types.js

/**
 * Trigger reasons for take-profit
 */
export const TriggerReason = {
  PRICE_ABOVE_THRESHOLD: 'price_above_threshold',  // Long position
  PRICE_BELOW_THRESHOLD: 'price_below_threshold',  // Short position
  NOT_TRIGGERED: 'not_triggered',
};

/**
 * Take-profit evaluation result
 */
export function createTakeProfitResult({
  triggered = false,
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  take_profit_threshold = 0,
  take_profit_pct = 0,
  reason = TriggerReason.NOT_TRIGGERED,
  action = null,          // 'close' when triggered
  closeMethod = null,     // 'limit' for better fills (unlike stop-loss which uses 'market')
  profit_amount = 0,      // Realized profit if triggered
  profit_pct = 0,         // Profit as percentage of entry
  evaluated_at = '',
} = {}) {
  return {
    triggered,
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    take_profit_threshold,
    take_profit_pct,
    reason,
    action,
    closeMethod,
    profit_amount,
    profit_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}

/**
 * Take-profit error codes
 */
export const TakeProfitErrorCodes = {
  NOT_INITIALIZED: 'TAKE_PROFIT_NOT_INITIALIZED',
  INVALID_POSITION: 'INVALID_POSITION',
  INVALID_PRICE: 'INVALID_PRICE',
  CONFIG_INVALID: 'TAKE_PROFIT_CONFIG_INVALID',
  EVALUATION_FAILED: 'TAKE_PROFIT_EVALUATION_FAILED',
};

export class TakeProfitError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'TakeProfitError';
    this.code = code;
    this.context = context;
  }
}
```

### Take-Profit Logic

```javascript
// src/modules/take-profit/logic.js

import { TriggerReason, createTakeProfitResult, TakeProfitError, TakeProfitErrorCodes } from './types.js';
import { incrementEvaluations, incrementTriggered } from './state.js';

/**
 * Calculate take-profit threshold for a position
 *
 * @param {Object} position - Position with entry_price, side
 * @param {number} takeProfitPct - Take-profit percentage (e.g., 0.10 = 10%)
 * @returns {Object} { threshold, entry_price, side, take_profit_pct }
 */
export function calculateTakeProfitThreshold(position, takeProfitPct) {
  const { entry_price, side } = position;

  if (!entry_price || entry_price <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid entry_price',
      { position_id: position.id, entry_price }
    );
  }

  if (takeProfitPct < 0 || takeProfitPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'Take-profit percentage must be between 0 and 1',
      { take_profit_pct: takeProfitPct }
    );
  }

  let threshold;
  if (side === 'long') {
    // Long position: take-profit triggers when price rises above threshold
    threshold = entry_price * (1 + takeProfitPct);
  } else if (side === 'short') {
    // Short position: take-profit triggers when price drops below threshold
    threshold = entry_price * (1 - takeProfitPct);
  } else {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid side',
      { position_id: position.id, side }
    );
  }

  return {
    threshold,
    entry_price,
    side,
    take_profit_pct: takeProfitPct,
  };
}

/**
 * Evaluate take-profit condition for a single position
 *
 * @param {Object} position - Position to evaluate
 * @param {number} currentPrice - Current market price
 * @param {Object} options - Evaluation options
 * @param {number} options.takeProfitPct - Take-profit percentage
 * @param {Object} options.log - Logger instance
 * @returns {Object} TakeProfitResult
 */
export function evaluate(position, currentPrice, options = {}) {
  const { takeProfitPct = 0.10, log } = options;

  // Validate current price
  if (typeof currentPrice !== 'number' || currentPrice <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_PRICE,
      'Invalid current price for take-profit evaluation',
      { position_id: position.id, current_price: currentPrice }
    );
  }

  // Calculate threshold
  const { threshold, entry_price, side } = calculateTakeProfitThreshold(position, takeProfitPct);

  // Track evaluation count
  incrementEvaluations();

  // Check if triggered
  let triggered = false;
  let reason = TriggerReason.NOT_TRIGGERED;

  if (side === 'long' && currentPrice >= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_ABOVE_THRESHOLD;
  } else if (side === 'short' && currentPrice <= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_BELOW_THRESHOLD;
  }

  // Calculate profit amount
  const priceMove = side === 'long'
    ? currentPrice - entry_price
    : entry_price - currentPrice;
  const profit_amount = position.size * priceMove;
  const profit_pct = priceMove / entry_price;

  const result = createTakeProfitResult({
    triggered,
    position_id: position.id,
    window_id: position.window_id,
    side,
    entry_price,
    current_price: currentPrice,
    take_profit_threshold: threshold,
    take_profit_pct: takeProfitPct,
    reason,
    action: triggered ? 'close' : null,
    closeMethod: triggered ? 'limit' : null,  // Limit order for better fills
    profit_amount: triggered ? profit_amount : 0,
    profit_pct: triggered ? profit_pct : 0,
  });

  // Log appropriately
  if (triggered) {
    incrementTriggered();
    if (log) {
      log.info('take_profit_triggered', {
        position_id: position.id,
        window_id: position.window_id,
        side,
        entry_price,
        current_price: currentPrice,
        take_profit_threshold: threshold,
        profit_amount,
        profit_pct,
        expected: { take_profit_pct: takeProfitPct },
        actual: { current_price: currentPrice, threshold_reached: true },
      });
    }
  } else {
    if (log) {
      log.debug('take_profit_evaluated', {
        position_id: position.id,
        current_price: currentPrice,
        threshold,
        distance_to_threshold: side === 'long' ? threshold - currentPrice : currentPrice - threshold,
      });
    }
  }

  return result;
}

/**
 * Evaluate take-profit for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} options - Evaluation options
 * @param {number} options.takeProfitPct - Default take-profit percentage
 * @param {Object} options.log - Logger instance
 * @returns {Object} { triggered: TakeProfitResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  const { takeProfitPct = 0.10, log } = options;
  const triggered = [];
  let evaluatedCount = 0;

  for (const position of positions) {
    try {
      // Get current price for this position
      const currentPrice = getCurrentPrice(position);
      if (!currentPrice) {
        if (log) {
          log.warn('take_profit_skip_no_price', { position_id: position.id });
        }
        continue;
      }

      // Use per-position take-profit if set, otherwise default
      const positionTakeProfitPct = position.take_profit_pct || takeProfitPct;

      const result = evaluate(position, currentPrice, {
        takeProfitPct: positionTakeProfitPct,
        log,
      });

      evaluatedCount++;

      if (result.triggered) {
        triggered.push(result);
      }
    } catch (err) {
      if (log) {
        log.error('take_profit_evaluation_error', {
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
    log.info('take_profit_evaluation_complete', {
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
// Add take-profit to MODULE_INIT_ORDER after stop-loss
export const MODULE_INIT_ORDER = [
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  { name: 'position-manager', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  { name: 'strategy-evaluator', module: null, configKey: null },
  { name: 'position-sizer', module: null, configKey: null },
  // Exit condition modules
  { name: 'stop-loss', module: null, configKey: null },
  // NEW: Add take-profit after stop-loss (exit conditions)
  { name: 'take-profit', module: null, configKey: null },
];
```

**Update `src/modules/orchestrator/index.js`:**

```javascript
// Add import
import * as takeProfit from '../take-profit/index.js';

// Add to MODULE_MAP
const MODULE_MAP = {
  // ... existing modules
  'take-profit': takeProfit,
};
```

**Update `src/modules/orchestrator/execution-loop.js`:**

Replace the comment at line 268-270 with actual implementation:

```javascript
// 5. Evaluate exit conditions - take-profit (Story 3.5)
let takeProfitResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
if (this.modules['take-profit'] && this.modules['position-manager']) {
  const takeProfitModule = this.modules['take-profit'];
  const positionManager = this.modules['position-manager'];

  // Get all open positions (positions not already closed by stop-loss)
  const openPositions = positionManager.getPositions();

  if (openPositions.length > 0) {
    // Get current price for each position
    const getCurrentPrice = (position) => {
      // Use position's current_price if available, otherwise fetch from spot
      if (position.current_price) {
        return position.current_price;
      }
      // Fallback to spot price
      if (spotData?.price) {
        return spotData.price;
      }
      return null;
    };

    takeProfitResults = takeProfitModule.evaluateAll(openPositions, getCurrentPrice);

    // Close any triggered positions (limit order, not emergency)
    for (const result of takeProfitResults.triggered) {
      try {
        await positionManager.closePosition(result.position_id, {
          // Note: NOT emergency - use limit order for better fills
          closePrice: result.current_price,
          reason: 'take_profit_triggered',
        });

        this.log.info('take_profit_position_closed', {
          position_id: result.position_id,
          window_id: result.window_id,
          entry_price: result.entry_price,
          close_price: result.current_price,
          take_profit_threshold: result.take_profit_threshold,
          profit_amount: result.profit_amount,
          profit_pct: result.profit_pct,
        });
      } catch (closeErr) {
        this.log.error('take_profit_close_failed', {
          position_id: result.position_id,
          error: closeErr.message,
          code: closeErr.code,
        });
      }
    }
  }
}

// Update tick_complete log to include take-profit metrics
const tickDurationMs = Date.now() - tickStart;
this.log.info('tick_complete', {
  tickCount: this.tickCount,
  durationMs: tickDurationMs,
  spotPrice: spotData?.price || null,
  entrySignalsCount: entrySignals.length,
  sizingResultsCount: sizingResults.length,
  sizingSuccessCount: sizingResults.filter(r => r.success).length,
  stopLossEvaluated: stopLossResults.summary.evaluated,
  stopLossTriggered: stopLossResults.summary.triggered,
  // NEW: Take-profit metrics
  takeProfitEvaluated: takeProfitResults.summary.evaluated,
  takeProfitTriggered: takeProfitResults.summary.triggered,
});
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
  stopLoss: {
    enabled: true,
    defaultStopLossPct: 0.05,       // 5% default stop-loss
  },
  // NEW: Take-profit configuration
  takeProfit: {
    enabled: true,                   // Enable/disable take-profit evaluation
    defaultTakeProfitPct: 0.10,      // 10% default take-profit
  },
},
```

### Structured Logging Format

Follow the architecture's structured log format:

```json
{
  "timestamp": "2026-01-31T10:15:30.123Z",
  "level": "info",
  "module": "take-profit",
  "event": "take_profit_triggered",
  "data": {
    "position_id": 42,
    "window_id": "btc-15m-2026-01-31-10:00",
    "side": "long",
    "expected": {
      "take_profit_pct": 0.10,
      "entry_price": 0.50,
      "threshold": 0.55
    },
    "actual": {
      "current_price": 0.56,
      "threshold_reached": true,
      "profit_amount": 0.60,
      "profit_pct": 0.12
    }
  }
}
```

### Previous Story Intelligence

**From Story 3.4 (Stop-Loss Module):**
- 801 tests passing after implementation (up from 731)
- Stop-loss module structure: index.js, logic.js, state.js, types.js
- evaluateAll() pattern for batch processing
- Integration in execution-loop.js after entry/sizing evaluation
- Child logger via `child({ module: 'module-name' })`
- ensureInitialized() guard pattern
- Factory function for result type (createStopLossResult)
- Per-position override support (position.stop_loss_pct)

**Key patterns to replicate:**
- TakeProfitResult mirrors StopLossResult structure
- TakeProfitError mirrors StopLossError
- TriggerReason enum for trigger types
- state.js tracks evaluation/triggered counts
- Config validation at init time
- Batch evaluation with summary statistics

**Critical difference from stop-loss:**
- Trigger direction is OPPOSITE: long triggers when price RISES, short triggers when price DROPS
- closeMethod is 'limit' not 'market' (for better fills, not emergency exit)
- profit_amount instead of loss_amount
- profit_pct instead of loss_pct

**Test count at 801 - maintain or increase**

### Position Manager Integration

**From src/modules/position-manager/index.js:**
```javascript
// Methods used by take-profit:
function getPositions() // Returns all open positions with current_price
async function closePosition(positionId, params = {})
  // params.closePrice = price to close at
  // params.reason = 'take_profit_triggered' for logging
  // Note: NOT using emergency: true like stop-loss
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
  // Optional: per-position take-profit override
  take_profit_pct?: number,
}
```

### Testing Patterns

Follow established vitest patterns from stop-loss story:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as takeProfit from '../index.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockConfig = {
  strategy: {
    takeProfit: {
      enabled: true,
      defaultTakeProfitPct: 0.10,
    },
  },
};

describe('TakeProfit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await takeProfit.shutdown();
  });

  describe('evaluate', () => {
    it('should trigger when long position price rises above threshold', async () => {
      await takeProfit.init(mockConfig);

      const position = {
        id: 1,
        window_id: 'test-window',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = takeProfit.evaluate(position, 0.56); // 12% gain, threshold is 10%

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('price_above_threshold');
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('limit');  // NOT 'market'
    });

    it('should NOT trigger when long position price is below threshold', async () => {
      await takeProfit.init(mockConfig);

      const position = {
        id: 1,
        window_id: 'test-window',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = takeProfit.evaluate(position, 0.54); // 8% gain, threshold is 10%

      expect(result.triggered).toBe(false);
      expect(result.action).toBe(null);
    });

    it('should trigger when short position price drops below threshold', async () => {
      await takeProfit.init(mockConfig);

      const position = {
        id: 2,
        window_id: 'test-window',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      const result = takeProfit.evaluate(position, 0.44); // 12% drop, threshold is 10%

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('price_below_threshold');
    });
  });

  describe('evaluateAll', () => {
    it('should evaluate multiple positions and return only triggered', async () => {
      await takeProfit.init(mockConfig);

      const positions = [
        { id: 1, side: 'long', entry_price: 0.50, size: 10 },  // Will trigger at 0.56
        { id: 2, side: 'long', entry_price: 0.50, size: 10 },  // Safe at 0.54
        { id: 3, side: 'short', entry_price: 0.50, size: 10 }, // Will trigger at 0.44
      ];

      const getCurrentPrice = (pos) => {
        if (pos.id === 1) return 0.56;  // 12% gain - triggered
        if (pos.id === 2) return 0.54;  // 8% gain - safe
        if (pos.id === 3) return 0.44;  // 12% drop - triggered
      };

      const { triggered, summary } = takeProfit.evaluateAll(positions, getCurrentPrice);

      expect(triggered.length).toBe(2);
      expect(summary.evaluated).toBe(3);
      expect(summary.triggered).toBe(2);
      expect(summary.safe).toBe(1);
    });
  });
});
```

### NFR Compliance

- **FR3** (Evaluate exit conditions - take-profit): Core purpose of this story
- **FR35** (Configure strategy parameters without code changes): Take-profit % in config
- **NFR5** (Market data processing keeps pace): Evaluation completes within tick interval
- **NFR9** (100% of trade events produce structured log): All evaluations logged

### Signal Flow After This Story

```
Tick → Spot Price → Strategy Evaluator → Entry Signal
                                              ↓
                                    Position Sizer
                                              ↓
                                    SizingResult → Order Manager (future)

Tick → Open Positions → Stop-Loss Module (Story 3.4)
                                              ↓
                              StopLossResult { triggered }
                                              ↓
                              Position Manager → closePosition()

Tick → Open Positions → Take-Profit Module (this story)
                                              ↓
                              TakeProfitResult { triggered }
                                              ↓
                              Position Manager → closePosition()
```

### Critical Implementation Notes

1. **Side-Aware Threshold**: Long positions trigger when price RISES ABOVE threshold, short positions trigger when price DROPS BELOW threshold. This is OPPOSITE of stop-loss direction.

2. **Limit Order Close**: Take-profit triggers should use limit orders (NOT emergency: true) to allow better fills. Unlike stop-loss which uses market orders for immediate exit.

3. **Current Price Source**: Use position.current_price if available (updated by tick), otherwise fall back to spot price. Log warning if no price available.

4. **Per-Position Override**: Support per-position take_profit_pct that overrides the default. This enables different profit targets for different strategies.

5. **Silent When Safe**: Only log at debug level when positions are safe. Info logging only for triggered take-profits to maintain "silence = working" principle.

6. **Atomic Evaluation**: Each position is evaluated independently. A failure in one position's evaluation should not prevent others from being evaluated.

7. **Profit Calculation**: Calculate profit_amount and profit_pct for diagnostics. For long: profit = size * (current - entry). For short: profit = size * (entry - current).

8. **Evaluation Order**: Take-profit evaluation happens AFTER stop-loss in the tick cycle. Positions closed by stop-loss are not re-evaluated by take-profit.

### References

- [Source: architecture.md#Inter-Module-Communication] - Orchestrator pattern
- [Source: architecture.md#Module-Interface-Contract] - init, getState, shutdown
- [Source: architecture.md#Project-Structure] - take-profit module location
- [Source: architecture.md#Structured-Log-Format] - JSON log schema
- [Source: architecture.md#Naming-Patterns] - snake_case for log fields
- [Source: epics.md#Story-3.5] - Story requirements and acceptance criteria
- [Source: prd.md#FR3] - Evaluate exit conditions (stop-loss, take-profit, window expiry)
- [Source: prd.md#FR35] - Configure strategy parameters without code changes
- [Source: 3-4-stop-loss-module.md] - Previous story patterns and module structure
- [Source: src/modules/stop-loss/index.js] - Stop-loss module as reference implementation
- [Source: src/modules/stop-loss/logic.js] - Stop-loss calculation logic patterns
- [Source: src/modules/stop-loss/types.js] - Type definitions pattern
- [Source: src/modules/position-manager/index.js:86-104] - getPositions() and closePosition() API
- [Source: src/modules/orchestrator/execution-loop.js:268-270] - Comment placeholder for take-profit integration
- [Source: config/default.js:82-86] - Stop-loss configuration section to extend

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered during implementation.

### Completion Notes List

- Implemented take-profit module following the same patterns as stop-loss module (Story 3.4)
- Key difference from stop-loss: Trigger direction is OPPOSITE (long triggers when price RISES, short when price DROPS)
- Uses 'limit' closeMethod instead of 'market' for better fills (not emergency exit)
- Tracks profit_amount and profit_pct instead of loss_amount and loss_pct
- 70 new tests added (37 in logic.test.js, 33 in index.test.js)
- All 871 tests pass (up from 801 in previous story)
- Integrated with orchestrator tick cycle after stop-loss evaluation
- Configuration added to config/default.js with 10% default take-profit

### File List

**New Files:**
- src/modules/take-profit/index.js - Public interface (init, evaluate, evaluateAll, getState, shutdown)
- src/modules/take-profit/logic.js - Core take-profit calculations
- src/modules/take-profit/state.js - Evaluation statistics tracking
- src/modules/take-profit/types.js - TakeProfitResult, TakeProfitError, TriggerReason
- src/modules/take-profit/__tests__/logic.test.js - Unit tests (37 tests)
- src/modules/take-profit/__tests__/index.test.js - Integration tests (33 tests)

**Modified Files:**
- config/default.js - Added strategy.takeProfit configuration section
- src/modules/orchestrator/state.js - Added take-profit to MODULE_INIT_ORDER
- src/modules/orchestrator/index.js - Added take-profit import and MODULE_MAP entry
- src/modules/orchestrator/execution-loop.js - Added take-profit evaluation in tick cycle

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-31 | Implemented story 3-5-take-profit-module - Take-profit module with threshold calculation, position evaluation, batch processing, orchestrator integration, and 70 comprehensive tests | Claude Opus 4.5 |

