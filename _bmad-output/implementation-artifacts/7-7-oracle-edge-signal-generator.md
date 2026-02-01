# Story 7.7: Oracle Edge Signal Generator

Status: done

---

## Story

As a **trader**,
I want **entry signals generated when oracle edge conditions are met**,
So that **I can trade the UI/Oracle divergence near expiry exploiting stale oracle prices**.

---

## Acceptance Criteria

### AC1: Oracle Edge Entry Conditions
**Given** active windows exist
**When** evaluating entry conditions
**Then** signal is generated if ALL conditions met:
1. time_to_expiry < max_time_threshold (default: 30000ms)
2. oracle_staleness > min_staleness (default: 15000ms)
3. |ui_price - strike| > strike_threshold (UI shows clear direction)
4. |ui_price - oracle_price| < chainlink_deviation_threshold
5. market_token_price > confidence_threshold OR < (1 - confidence_threshold)

### AC2: Signal Content
**Given** conditions are met
**When** signal is generated
**Then** signal includes: window_id, symbol, direction (fade_up or fade_down), confidence, all_inputs
**And** signal is logged with complete state snapshot

### AC3: Silent Operation When No Signal
**Given** conditions are NOT met
**When** evaluating
**Then** no signal is generated (silent operation per FR24)
**And** evaluation continues on next tick

### AC4: Signal Direction Logic
**Given** signal direction logic
**When** UI shows "clearly UP" (ui_price >> strike) but oracle hasn't seen it
**Then** signal is FADE_UP (sell UP token / buy DOWN token)
**When** UI shows "clearly DOWN" (ui_price << strike) but oracle hasn't seen it
**Then** signal is FADE_DOWN (sell DOWN token / buy UP token)

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1, 2)
  - [x] Create `src/modules/oracle-edge-signal/` folder
  - [x] Create `index.js` (public interface: init, getSignals, subscribe, getState, shutdown)
  - [x] Create `generator.js` (OracleEdgeSignalGenerator class with signal logic)
  - [x] Create `types.js` (OracleEdgeSignalError, error codes, constants, SignalDirection enum)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Implement signal generation logic** (AC: 1, 4)
  - [x] Create `OracleEdgeSignalGenerator` class in `generator.js`
  - [x] Implement `evaluateWindow(windowData)` method
  - [x] Check condition 1: `time_remaining_ms < maxTimeThreshold` (30000ms)
  - [x] Check condition 2: `oracle_staleness_ms > minStaleness` (15000ms) via staleness-detector
  - [x] Check condition 3: `|ui_price - strike| > strikeThreshold` (clear direction from UI)
  - [x] Check condition 4: `|ui_price - oracle_price| < chainlinkDeviationThreshold` (oracle won't update)
  - [x] Check condition 5: `market_price > confidenceThreshold || market_price < (1 - confidenceThreshold)`
  - [x] Return null if ANY condition fails (silent, no signal)
  - [x] Return signal object if ALL conditions pass

- [x] **Task 3: Implement signal direction determination** (AC: 4)
  - [x] Create `determineDirection(uiPrice, oraclePrice, strike)` method
  - [x] If ui_price >> strike (UI shows UP), direction = FADE_UP (we fade the UI move)
  - [x] If ui_price << strike (UI shows DOWN), direction = FADE_DOWN
  - [x] Handle edge cases: strike is midpoint (0.5 for normalized prices)
  - [x] Document: "Fade" means bet AGAINST the UI expectation because oracle may settle differently

- [x] **Task 4: Implement confidence calculation** (AC: 2)
  - [x] Create `calculateConfidence(inputs)` method
  - [x] Factor in: staleness score, divergence magnitude, time to expiry
  - [x] Higher staleness → higher confidence (oracle more likely stale through expiry)
  - [x] Larger divergence → higher confidence (bigger potential edge)
  - [x] Less time → higher confidence (less time for oracle to update)
  - [x] Return confidence 0-1 scale

- [x] **Task 5: Integrate with staleness-detector** (AC: 1)
  - [x] Import staleness-detector module
  - [x] Use `getStaleness(symbol)` to get staleness evaluation
  - [x] Check `is_stale` and `score` from evaluation
  - [x] Get `inputs.time_since_update_ms` for staleness duration
  - [x] Handle case where staleness-detector not initialized (fallback/error)

- [x] **Task 6: Integrate with divergence-tracker** (AC: 1)
  - [x] Import divergence-tracker module
  - [x] Use `getSpread(symbol)` to get current spread
  - [x] Get ui_price and oracle_price from spread
  - [x] Get spread_pct for divergence magnitude
  - [x] Handle case where divergence-tracker not initialized

- [x] **Task 7: Integrate with window-manager** (AC: 1)
  - [x] Accept window data from caller (orchestrator provides windows)
  - [x] Use window.time_remaining_ms for time check
  - [x] Use window.market_price for confidence threshold check
  - [x] Extract symbol from window.crypto
  - [x] Strike is 0.5 (binary UP/DOWN market midpoint)

- [x] **Task 8: Implement subscription pattern** (AC: 2)
  - [x] Create `subscribe(callback)` function for signal events
  - [x] Emit `signal_generated` event with full signal object
  - [x] Return unsubscribe function
  - [x] Support multiple subscribers

- [x] **Task 9: Implement signal logging** (AC: 2)
  - [x] Log each generated signal with complete state snapshot
  - [x] Include all inputs used in evaluation
  - [x] Log `signal_generated` with: window_id, symbol, direction, confidence, all_inputs
  - [x] Use structured logging format per architecture.md

- [x] **Task 10: Implement configuration handling** (AC: 1)
  - [x] Define DEFAULT_CONFIG with:
    - maxTimeThresholdMs: 30000 (30 seconds before expiry)
    - minStalenessMs: 15000 (oracle stale for 15+ seconds)
    - strikeThreshold: 0.05 (5% from strike for "clear" direction)
    - chainlinkDeviationThresholdPct: 0.005 (0.5%)
    - confidenceThreshold: 0.65 (market price shows 65%+ conviction)
    - evaluationIntervalMs: 500 (check every 500ms)
  - [x] Accept config via init(config)
  - [x] Validate config values

- [x] **Task 11: Implement module interface** (AC: 1-4)
  - [x] Export `init(config)` - setup, connect to dependencies
  - [x] Export `evaluateWindow(windowData)` - evaluate single window for signal
  - [x] Export `evaluateAllWindows(windows)` - batch evaluate multiple windows
  - [x] Export `subscribe(callback)` - subscribe to signal events
  - [x] Export `getState()` - full module state
  - [x] Export `shutdown()` - cleanup

- [x] **Task 12: Write comprehensive tests** (AC: 1-4)
  - [x] Unit tests for condition evaluation (each condition individually)
  - [x] Unit tests for direction determination (FADE_UP vs FADE_DOWN)
  - [x] Unit tests for confidence calculation
  - [x] Unit tests for signal generation (all conditions met)
  - [x] Unit tests for no signal (one or more conditions fail)
  - [x] Integration tests with mock staleness-detector and divergence-tracker
  - [x] Test subscription pattern
  - [x] Test configuration handling

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/oracle-edge-signal/`

**File Structure (per architecture.md):**
```
src/modules/oracle-edge-signal/
├── index.js          # Public interface (init, evaluateWindow, subscribe, getState, shutdown)
├── generator.js      # OracleEdgeSignalGenerator class with signal logic
├── types.js          # OracleEdgeSignalError, error codes, SignalDirection enum
└── __tests__/
    ├── index.test.js
    ├── generator.test.js
    └── integration.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function evaluateWindow(windowData) {}  // Evaluate single window
export function evaluateAllWindows(windows) {}  // Batch evaluate
export function subscribe(callback) {}  // Subscribe to signal events
export function getState() {}
export async function shutdown() {}
export { OracleEdgeSignalError, OracleEdgeSignalErrorCodes, SignalDirection };
```

### Error Pattern (per architecture.md)

```javascript
import { PolyError } from '../../types/errors.js';

export class OracleEdgeSignalError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OracleEdgeSignalError';
  }
}

export const OracleEdgeSignalErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_EDGE_SIGNAL_NOT_INITIALIZED',
  INVALID_WINDOW: 'ORACLE_EDGE_SIGNAL_INVALID_WINDOW',
  INVALID_CONFIG: 'ORACLE_EDGE_SIGNAL_INVALID_CONFIG',
  DEPENDENCY_UNAVAILABLE: 'ORACLE_EDGE_SIGNAL_DEPENDENCY_UNAVAILABLE',
  SUBSCRIPTION_FAILED: 'ORACLE_EDGE_SIGNAL_SUBSCRIPTION_FAILED',
};

export const SignalDirection = {
  FADE_UP: 'fade_up',   // Bet AGAINST UI showing UP (sell UP / buy DOWN)
  FADE_DOWN: 'fade_down', // Bet AGAINST UI showing DOWN (sell DOWN / buy UP)
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  oracleEdgeSignal: {
    maxTimeThresholdMs: 30000,          // Only signal within 30s of expiry
    minStalenessMs: 15000,              // Oracle must be stale for 15+ seconds
    strikeThreshold: 0.05,              // 5% from strike for "clear" direction
    chainlinkDeviationThresholdPct: 0.005, // 0.5% max divergence (oracle won't update)
    confidenceThreshold: 0.65,          // Market must show 65%+ conviction
    evaluationIntervalMs: 500,          // Check every 500ms
  }
}
```

### Oracle Edge Signal Generation Algorithm

The core thesis: When UI (Binance) prices diverge from Oracle (Chainlink) prices near expiry, AND the oracle is stale (hasn't updated), there may be an exploitable edge because settlement uses the oracle price, not the UI price.

**Key Algorithm:**
```javascript
class OracleEdgeSignalGenerator {
  constructor(config, dependencies) {
    this.config = config;
    this.stalenessDetector = dependencies.stalenessDetector;
    this.divergenceTracker = dependencies.divergenceTracker;
    this.subscribers = new Set();
    this.stats = {
      signals_generated: 0,
      evaluations_total: 0,
      conditions_checked: {},
    };
  }

  /**
   * Evaluate a window for oracle edge signal
   * @param {Object} windowData - Window from window-manager
   * @returns {Object|null} Signal object or null if no signal
   */
  evaluateWindow(windowData) {
    this.stats.evaluations_total++;

    const {
      window_id,
      crypto,
      time_remaining_ms,
      market_price,
      token_id_up,
      token_id_down,
    } = windowData;

    const symbol = crypto; // btc, eth, sol, xrp

    // Condition 1: Time to expiry check
    if (time_remaining_ms > this.config.maxTimeThresholdMs) {
      return null; // Too early
    }

    // Get staleness evaluation
    const staleness = this.getStalenessData(symbol);
    if (!staleness) {
      return null; // Can't evaluate without staleness data
    }

    // Condition 2: Oracle staleness check
    const stalenessMs = staleness.inputs?.time_since_update_ms || 0;
    if (stalenessMs < this.config.minStalenessMs) {
      return null; // Oracle not stale enough
    }

    // Get divergence data
    const divergence = this.getDivergenceData(symbol);
    if (!divergence || divergence.ui_price === null) {
      return null; // Need UI price for comparison
    }

    const { ui_price, oracle_price, spread_pct } = divergence;
    const strike = 0.5; // Binary market midpoint

    // Condition 3: Clear direction from UI
    const uiVsStrike = Math.abs(ui_price - strike);
    if (uiVsStrike < this.config.strikeThreshold) {
      return null; // UI doesn't show clear direction
    }

    // Condition 4: Divergence within Chainlink threshold (oracle won't update)
    if (Math.abs(spread_pct) >= this.config.chainlinkDeviationThresholdPct) {
      return null; // Divergence too large, oracle might update
    }

    // Condition 5: Market conviction check
    if (market_price > (1 - this.config.confidenceThreshold) &&
        market_price < this.config.confidenceThreshold) {
      return null; // Market not showing enough conviction
    }

    // All conditions passed! Generate signal
    const direction = this.determineDirection(ui_price, oracle_price, strike);
    const confidence = this.calculateConfidence({
      stalenessMs,
      spreadPct: spread_pct,
      timeRemainingMs: time_remaining_ms,
      marketPrice: market_price,
    });

    const signal = {
      window_id,
      symbol,
      direction,
      confidence,
      token_id: direction === SignalDirection.FADE_UP ? token_id_down : token_id_up,
      side: 'buy', // Always buying the opposite token (fading)
      inputs: {
        time_remaining_ms,
        market_price,
        ui_price,
        oracle_price,
        oracle_staleness_ms: stalenessMs,
        spread_pct,
        strike,
        staleness_score: staleness.score,
      },
      generated_at: new Date().toISOString(),
    };

    this.stats.signals_generated++;
    this.notifySubscribers(signal);

    return signal;
  }

  /**
   * Determine signal direction based on UI vs strike
   */
  determineDirection(uiPrice, oraclePrice, strike) {
    // UI shows UP (price > strike), we FADE by betting DOWN
    if (uiPrice > strike) {
      return SignalDirection.FADE_UP;
    }
    // UI shows DOWN (price < strike), we FADE by betting UP
    return SignalDirection.FADE_DOWN;
  }

  /**
   * Calculate confidence score (0-1)
   */
  calculateConfidence({ stalenessMs, spreadPct, timeRemainingMs, marketPrice }) {
    // Component 1: Staleness confidence (0-0.40)
    // More stale = higher confidence oracle won't update
    const stalenessRatio = Math.min(stalenessMs / 60000, 1); // Max out at 60s
    const stalenessScore = 0.20 + 0.20 * stalenessRatio;

    // Component 2: Divergence confidence (0-0.30)
    // Larger divergence = bigger potential edge
    const absSpread = Math.abs(spreadPct);
    const divergenceScore = Math.min(absSpread / 0.005, 1) * 0.30;

    // Component 3: Time confidence (0-0.30)
    // Less time = more confident oracle won't update before expiry
    const timeScore = 0.30 * (1 - (timeRemainingMs / this.config.maxTimeThresholdMs));

    return Math.min(1, stalenessScore + divergenceScore + timeScore);
  }
}
```

### Integration with Staleness Detector (Story 7-6)

```javascript
import * as stalenessDetector from '../staleness-detector/index.js';

function getStalenessData(symbol) {
  try {
    return stalenessDetector.getStaleness(symbol);
  } catch (err) {
    // Staleness detector not available or no data
    log.warn('staleness_data_unavailable', { symbol, error: err.message });
    return null;
  }
}
```

### Integration with Divergence Tracker (Story 7-3)

```javascript
import * as divergenceTracker from '../divergence-tracker/index.js';

function getDivergenceData(symbol) {
  try {
    const spread = divergenceTracker.getSpread(symbol);
    return {
      ui_price: spread?.ui_price,
      oracle_price: spread?.oracle_price,
      spread_pct: spread?.pct || 0,
    };
  } catch (err) {
    log.warn('divergence_data_unavailable', { symbol, error: err.message });
    return null;
  }
}
```

### Integration with Window Manager

The orchestrator calls `evaluateWindow()` with window data from window-manager:
```javascript
// In orchestrator execution loop:
const windows = await windowManager.getActiveWindows();
for (const window of windows) {
  const signal = oracleEdgeSignal.evaluateWindow(window);
  if (signal) {
    // Handle signal (log, route to order manager, etc.)
  }
}
```

**Window Data Structure (from window-manager):**
```javascript
{
  window_id: 'btc-15m-1706745600',
  market_id: 'btc-updown-15m-1706745600',
  token_id_up: '0x...',
  token_id_down: '0x...',
  market_price: 0.72,
  best_bid: 0.71,
  best_ask: 0.73,
  spread: 0.02,
  time_remaining_ms: 25000,
  epoch: 1706745600,
  crypto: 'btc',
  end_time: '2026-02-01T12:15:00Z',
}
```

### Signal Output Structure

```javascript
{
  window_id: 'btc-15m-1706745600',
  symbol: 'btc',
  direction: 'fade_up',  // or 'fade_down'
  confidence: 0.78,
  token_id: '0x...',     // The token to BUY (opposite of UI direction)
  side: 'buy',
  inputs: {
    time_remaining_ms: 25000,
    market_price: 0.72,
    ui_price: 95500,
    oracle_price: 95450,
    oracle_staleness_ms: 22000,
    spread_pct: 0.0005,
    strike: 0.5,
    staleness_score: 0.68,
  },
  generated_at: '2026-02-01T12:14:35.123Z',
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    stats: {
      signals_generated: 15,
      evaluations_total: 5420,
      signals_by_direction: { fade_up: 8, fade_down: 7 },
      signals_by_symbol: { btc: 5, eth: 4, sol: 3, xrp: 3 },
      avg_confidence: 0.72,
    },
    config: { ... },
  };
}
```

### Logging Requirements

All logs MUST use structured format with required fields:
```javascript
log.info('oracle_edge_signal_initialized', { config: { maxTimeThresholdMs, minStalenessMs } });
log.info('signal_generated', {
  window_id: 'btc-15m-...',
  symbol: 'btc',
  direction: 'fade_up',
  confidence: 0.78,
  inputs: { ... },
});
log.debug('window_evaluated_no_signal', {
  window_id: 'btc-15m-...',
  reason: 'oracle_not_stale',
  staleness_ms: 8000,
  min_required: 15000,
});
log.warn('dependency_unavailable', { dependency: 'staleness-detector', symbol: 'btc' });
log.error('evaluation_failed', { window_id, error: err.message });
```

### Testing Strategy

1. **Unit Tests (generator.test.js):**
   - Condition 1: Time threshold (passes/fails)
   - Condition 2: Oracle staleness (passes/fails)
   - Condition 3: Strike threshold (passes/fails)
   - Condition 4: Chainlink deviation (passes/fails)
   - Condition 5: Confidence threshold (passes/fails)
   - All conditions pass → signal generated
   - Any condition fails → null returned (no signal)
   - Direction determination: FADE_UP vs FADE_DOWN
   - Confidence calculation with various inputs

2. **Unit Tests (index.test.js):**
   - Init creates dependencies
   - evaluateWindow returns correct structure or null
   - evaluateAllWindows processes multiple windows
   - subscribe/unsubscribe pattern
   - getState returns correct shape
   - shutdown cleans up

3. **Integration Tests (integration.test.js):**
   - Mock staleness-detector with simulated staleness data
   - Mock divergence-tracker with simulated spread data
   - End-to-end signal generation
   - Subscription callbacks called on signal
   - Handle missing dependencies gracefully

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/modules/staleness-detector/` - for oracle staleness detection (Story 7-6)
- `src/modules/divergence-tracker/` - for UI/Oracle spread (Story 7-3)
- `src/types/errors.js` - for PolyError base class

**No new npm packages required.**

### Previous Story Intelligence (7-1 through 7-6)

**Key Learnings from Story 7-6 (Staleness Detector):**
1. Module pattern: init(config), getState(), shutdown()
2. Use child logger: `log = child({ module: 'oracle-edge-signal' })`
3. Optional module loading with try/catch and fallback handling
4. Subscription pattern with unsubscribe return
5. Config validation in init()
6. getStaleness(symbol) returns: `{ is_stale, score, conditions, inputs }`

**Key Learnings from Story 7-3 (Divergence Tracker):**
1. getSpread(symbol) returns: `{ ui_price, oracle_price, raw, pct, direction, last_updated }`
2. Subscription to breach events via subscribeToBreaches()
3. Track state per symbol
4. Handle null/undefined prices gracefully

**Key Learnings from Window Manager:**
1. Window data structure with window_id, crypto, time_remaining_ms, market_price
2. token_id_up and token_id_down for order placement
3. Cache mechanism for API efficiency

**Code Review Findings to Apply:**
- Validate all inputs before processing
- Handle missing dependency data gracefully (return null, not throw)
- Use rate limiting for repeated warnings
- Clean up subscriptions on shutdown
- Use defensive null checks for module state

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- This module is a SIGNAL GENERATOR - analyzes market conditions and generates entry signals
- Consumes data from staleness-detector (7-6), divergence-tracker (7-3)
- Called by orchestrator with window data from window-manager
- Story 7-8 (Signal Outcome Logger) will track whether signals were profitable

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides underlying price feeds
- Story 7-3 (Feed Divergence Tracker) - provides UI/Oracle spread
- Story 7-6 (Oracle Staleness Detector) - provides staleness evaluation

**Used by:**
- Story 7-8 (Signal Outcome Logger) - will track signal outcomes
- Story 7-9 (Strategy Quality Gate) - will disable if signal quality degrades
- Story 7-12 (Strategy Composition Integration) - will register as signal-generator component

### The Oracle Edge Thesis

**Why This Works (Hypothesis):**
1. UI prices (Binance RTDS) reflect real-time market expectations
2. Oracle prices (Chainlink RTDS) update every ~0.5% deviation or heartbeat
3. Settlement uses the ORACLE price at window expiry
4. When UI and Oracle diverge near expiry with stale oracle, the market may be "wrong"
5. Example: UI shows BTC clearly UP, but oracle is stale showing lower price
   - If oracle doesn't update before expiry, settlement uses stale price
   - We "fade" the UI by betting on DOWN (using oracle price as truth)

**This is a HYPOTHESIS - Story 7-8 will track outcomes to validate if this actually works!**

### Critical Implementation Notes

1. **Silent operation (FR24):** When no signal is generated, module stays silent. No logs for "no signal" unless debug level.

2. **Signal is just a recommendation:** This module generates signals. It does NOT place orders. The orchestrator/strategy layer decides what to do with signals.

3. **Fade logic:** "FADE_UP" means UI shows UP but we bet DOWN. "FADE_DOWN" means UI shows DOWN but we bet UP. The token_id in the signal is the one to BUY (the opposite of UI direction).

4. **Strike is 0.5:** For binary UP/DOWN markets, the strike is the midpoint (0.5 normalized). The question is "will price be above or below current level?"

5. **This builds on staleness-detector:** Don't re-implement staleness detection. Use the getStaleness() API from Story 7-6.

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-7]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/implementation-artifacts/7-6-oracle-staleness-detector.md - Staleness detection integration]
- [Source: _bmad-output/implementation-artifacts/7-3-feed-divergence-tracker.md - Divergence tracking integration]
- [Source: src/modules/staleness-detector/index.js - getStaleness() API]
- [Source: src/modules/divergence-tracker/index.js - getSpread() API]
- [Source: src/modules/window-manager/index.js - Window data structure]
- [Source: src/modules/window-manager/types.js - SUPPORTED_CRYPTOS constant]
- [Source: src/clients/rtds/types.js - SUPPORTED_SYMBOLS constant]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - Clean implementation with no debug issues

### Completion Notes List

- ✅ Created oracle-edge-signal module with full test coverage
- ✅ Implemented 5-condition signal generation algorithm per AC1
- ✅ Signal content includes window_id, symbol, direction, confidence, all_inputs per AC2
- ✅ Silent operation (returns null) when conditions not met per AC3
- ✅ FADE_UP/FADE_DOWN direction logic with correct token selection per AC4
- ✅ Confidence calculation factors: staleness (0-40%), divergence (0-30%), time (0-30%)
- ✅ Integration with staleness-detector and divergence-tracker via dynamic imports
- ✅ Graceful handling when dependencies unavailable (returns null, logs warning)
- ✅ Subscription pattern with unsubscribe function, supports multiple subscribers
- ✅ 113 tests passing: 67 generator tests, 32 index tests, 14 integration tests (post-review)
- ✅ Full test suite (2471 tests) passes with no regressions

### File List

**New Files:**
- src/modules/oracle-edge-signal/index.js
- src/modules/oracle-edge-signal/generator.js
- src/modules/oracle-edge-signal/types.js
- src/modules/oracle-edge-signal/__tests__/index.test.js
- src/modules/oracle-edge-signal/__tests__/generator.test.js
- src/modules/oracle-edge-signal/__tests__/integration.test.js

### Change Log

- 2026-02-01: Story 7-7 implemented - Oracle Edge Signal Generator module complete with full test coverage
- 2026-02-01: Secondary code review completed - 10 issues identified and fixed

---

## Secondary Code Review

### Review Date
2026-02-01

### Reviewer
Claude Opus 4.5 (claude-opus-4-5-20251101)

### Issues Found and Fixed

#### CRITICAL ISSUES (3)

1. **Division by Zero Risk in Confidence Calculation** (`generator.js:275`)
   - **Problem:** If `maxTimeThresholdMs` was 0, division by zero would occur
   - **Fix:** Added defensive check with fallback to 30000ms default
   - **Severity:** Critical - could crash signal generation

2. **Missing Validation for Negative Time Remaining** (`generator.js:82`)
   - **Problem:** `time_remaining_ms < 0` (expired windows) could generate signals
   - **Fix:** Added explicit check: `time_remaining_ms <= 0` returns null with 'window_expired' reason
   - **Severity:** Critical - could generate signals for already-expired windows

3. **Missing Market Price Bounds Validation** (`generator.js:153`)
   - **Problem:** Invalid market prices (NaN, negative, >1) could pass conviction check
   - **Fix:** Added validation: `market_price >= 0 && market_price <= 1 && Number.isFinite(market_price)`
   - **Severity:** Critical - invalid data could generate erroneous signals

#### EDGE CASE ISSUES (6)

4. **Missing oracle_price Null Check** (`generator.js:126`)
   - **Problem:** `oracle_price` used without null/NaN validation
   - **Fix:** Added explicit validation before use
   - **Severity:** Medium - could cause NaN in calculations

5. **No Type Validation for Window Data** (`generator.js:70-77`)
   - **Problem:** Numeric fields used without type checking
   - **Fix:** Added `typeof === 'number' && Number.isFinite()` checks
   - **Severity:** Medium - type coercion bugs

6. **Missing token_id Validation** (`generator.js:178`)
   - **Problem:** Signal could have undefined token_id
   - **Fix:** Added validation that both token_id_up and token_id_down are present and truthy
   - **Severity:** Medium - downstream failures

7. **Confidence Calculation NaN Safety** (`generator.js:262-278`)
   - **Problem:** NaN inputs could propagate through calculation
   - **Fix:** Added defensive Number.isFinite() checks with fallback values
   - **Severity:** Low - defensive hardening

#### TEST COVERAGE GAPS (4 new test suites, 18 new tests)

8. **Missing tests for negative/zero time_remaining_ms** - Added 2 tests
9. **Missing tests for NaN/Infinity numeric inputs** - Added 4 tests
10. **Missing tests for invalid market_price bounds** - Added 3 tests
11. **Missing tests for undefined/null token IDs** - Added 5 tests
12. **Missing tests for confidence calculation edge cases** - Added 4 tests

### Test Results After Fixes

- **Before review:** 95 tests (49 generator + 32 index + 14 integration)
- **After review:** 113 tests (67 generator + 32 index + 14 integration)
- **All tests passing:** ✅

### Architecture Compliance

- ✅ Follows folder-per-module structure
- ✅ Exports standard interface (init, getState, shutdown)
- ✅ Uses PolyError base class for typed errors
- ✅ Structured logging with required fields
- ✅ No direct module imports (uses dynamic import for dependencies)
- ✅ Tests co-located in `__tests__/` folder

### Security Assessment

- ✅ No credential exposure
- ✅ No injection vulnerabilities
- ✅ No unsafe type coercion (after fixes)
- ✅ Input validation on all public interfaces

### Performance Notes

- Debug logging on every failed condition could create overhead in high-frequency evaluation
- Consider rate-limiting or aggregating debug logs in production if performance issues arise

