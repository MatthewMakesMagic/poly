# Story 7.6: Oracle Staleness Detector

Status: review

---

## Story

As a **trader**,
I want **to detect when the oracle is "stale" (hasn't updated despite price movement)**,
So that **I can identify potential trading opportunities where settlement may differ from UI expectations**.

---

## Acceptance Criteria

### AC1: Staleness Detection Conditions
**Given** current market state
**When** evaluating staleness
**Then** staleness is detected if ALL conditions met:
- time_since_last_oracle_update > staleness_threshold_ms (default: 15000)
- |ui_price - oracle_price| > min_divergence (default: 0.1%)
- |ui_price - oracle_price| < chainlink_deviation_threshold (oracle unlikely to update)

### AC2: Staleness Score Calculation
**Given** staleness is detected
**When** evaluating
**Then** staleness score is calculated (0-1 scale based on how many conditions met and by how much)
**And** event is emitted for strategy layer

### AC3: Staleness Resolution Events
**Given** staleness state changes
**When** oracle updates after being stale
**Then** "staleness_resolved" event is emitted
**And** resolution is logged with: staleness_duration_ms, price_at_resolution

### AC4: Configuration Flexibility
**Given** configuration
**When** thresholds need tuning
**Then** staleness_threshold_ms, min_divergence_pct, chainlink_deviation_threshold are configurable

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1, 4)
  - [x] Create `src/modules/staleness-detector/` folder
  - [x] Create `index.js` (public interface: init, getStaleness, isStale, getState, shutdown)
  - [x] Create `detector.js` (StalenessDetector class with detection logic)
  - [x] Create `types.js` (StalenessDetectorError, error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Implement staleness detection logic** (AC: 1)
  - [x] Create `StalenessDetector` class in `detector.js`
  - [x] Implement `evaluateStaleness(symbol)` method
  - [x] Check condition 1: time_since_last_oracle_update > staleness_threshold_ms
  - [x] Check condition 2: |ui_price - oracle_price| > min_divergence_pct
  - [x] Check condition 3: |ui_price - oracle_price| < chainlink_deviation_threshold
  - [x] Return detailed evaluation result with each condition's status

- [x] **Task 3: Implement staleness score calculation** (AC: 2)
  - [x] Create `calculateStalenessScore(evaluation)` method
  - [x] Score component: time staleness (0-0.35) - how far past threshold
  - [x] Score component: divergence magnitude (0-0.35) - how much divergence exists
  - [x] Score component: update unlikelihood (0-0.30) - how unlikely oracle update is
  - [x] Normalize to 0-1 scale
  - [x] Handle edge cases (no data, negative values)

- [x] **Task 4: Implement event subscription** (AC: 2, 3)
  - [x] Create `subscribeToStaleness(callback)` function
  - [x] Emit `staleness_detected` event when score crosses threshold
  - [x] Emit `staleness_resolved` event when oracle updates during stale state
  - [x] Include full context in events: symbol, score, duration_ms, prices
  - [x] Track staleness start time for duration calculation

- [x] **Task 5: Integrate with oracle-tracker** (AC: 1)
  - [x] Import oracle-tracker module
  - [x] Subscribe to oracle updates for tracking last_update_at
  - [x] Get oracle price from oracle-tracker state
  - [x] Track per-symbol oracle state: last_price, last_update_at

- [x] **Task 6: Integrate with divergence-tracker** (AC: 1)
  - [x] Import divergence-tracker module
  - [x] Subscribe to spread updates
  - [x] Get current UI price and oracle price from divergence-tracker
  - [x] Handle case where divergence-tracker not available (fallback to oracle-tracker only)

- [x] **Task 7: Integrate with oracle-predictor** (AC: 1)
  - [x] Import oracle-predictor module
  - [x] Use getPrediction() to assess likelihood of oracle update
  - [x] Factor prediction into staleness score calculation
  - [x] Handle case where predictor has insufficient data (use defaults)

- [x] **Task 8: Implement configuration handling** (AC: 4)
  - [x] Define DEFAULT_CONFIG with:
    - staleness_threshold_ms: 15000
    - min_divergence_pct: 0.001 (0.1%)
    - chainlink_deviation_threshold_pct: 0.005 (0.5%)
    - score_threshold: 0.6 (when to emit events)
    - evaluation_interval_ms: 1000
  - [x] Accept config via init(config)
  - [x] Validate config values

- [x] **Task 9: Implement staleness logging** (AC: 3)
  - [x] Log `staleness_detected` with full context
  - [x] Log `staleness_resolved` with duration and prices
  - [x] Log periodic staleness state snapshots
  - [x] Use structured logging format per architecture.md

- [x] **Task 10: Implement module interface** (AC: 1-4)
  - [x] Export `init(config)` - setup, subscribe to trackers
  - [x] Export `getStaleness(symbol)` - get full staleness evaluation
  - [x] Export `isStale(symbol)` - simple boolean check
  - [x] Export `subscribeToStaleness(callback)` - event subscription
  - [x] Export `getState()` - full module state
  - [x] Export `shutdown()` - cleanup

- [x] **Task 11: Write comprehensive tests** (AC: 1-4)
  - [x] Unit tests for staleness condition evaluation
  - [x] Unit tests for score calculation edge cases
  - [x] Unit tests for event emission
  - [x] Integration tests with mock trackers
  - [x] Test staleness resolution detection
  - [x] Test configuration handling

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/staleness-detector/`

**File Structure (per architecture.md):**
```
src/modules/staleness-detector/
├── index.js          # Public interface (init, getStaleness, isStale, subscribeToStaleness, getState, shutdown)
├── detector.js       # StalenessDetector class with detection logic
├── types.js          # StalenessDetectorError, error codes, constants
└── __tests__/
    ├── index.test.js
    ├── detector.test.js
    └── integration.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function getStaleness(symbol) {}  // Full staleness evaluation
export function isStale(symbol) {}  // Simple boolean check
export function subscribeToStaleness(callback) {}  // Event subscription
export function getState() {}
export async function shutdown() {}
export { StalenessDetectorError, StalenessDetectorErrorCodes };
```

### Error Pattern (per architecture.md)

```javascript
import { PolyError } from '../../types/errors.js';

export class StalenessDetectorError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StalenessDetectorError';
  }
}

export const StalenessDetectorErrorCodes = {
  NOT_INITIALIZED: 'STALENESS_DETECTOR_NOT_INITIALIZED',
  INVALID_SYMBOL: 'STALENESS_DETECTOR_INVALID_SYMBOL',
  INVALID_CONFIG: 'STALENESS_DETECTOR_INVALID_CONFIG',
  TRACKER_UNAVAILABLE: 'STALENESS_DETECTOR_TRACKER_UNAVAILABLE',
  SUBSCRIPTION_FAILED: 'STALENESS_DETECTOR_SUBSCRIPTION_FAILED',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  stalenessDetector: {
    stalenessThresholdMs: 15000,           // Time since update to be "stale"
    minDivergencePct: 0.001,                // 0.1% minimum spread for staleness
    chainlinkDeviationThresholdPct: 0.005,  // 0.5% - above this, oracle likely to update
    scoreThreshold: 0.6,                    // Score above this triggers events
    evaluationIntervalMs: 1000,             // How often to evaluate staleness
  }
}
```

### Staleness Detection Algorithm

The core insight is that staleness represents a trading opportunity when:
1. **Time staleness**: Oracle hasn't updated for a while (>15s default)
2. **Price divergence**: UI and Oracle prices differ meaningfully (>0.1%)
3. **Update unlikelihood**: The divergence is below Chainlink's update threshold (~0.5%)

When all three conditions are met, the oracle is "stale" - showing an outdated price that likely won't update before expiry.

**Key Algorithm:**
```javascript
class StalenessDetector {
  constructor(config) {
    this.config = config;
    this.stalenessState = {}; // { [symbol]: { isStale, startedAt, score, evaluation } }
    this.subscribers = [];
  }

  /**
   * Evaluate staleness for a symbol
   */
  evaluateStaleness(symbol) {
    // 1. Get current state from trackers
    const oracleState = this.getOracleState(symbol);  // { price, last_update_at }
    const divergence = this.getDivergence(symbol);     // { ui_price, oracle_price, spread_pct }

    const now = Date.now();
    const timeSinceUpdate = now - oracleState.last_update_at;
    const absDivergencePct = Math.abs(divergence.spread_pct);

    // 2. Evaluate each condition
    const conditions = {
      time_stale: timeSinceUpdate > this.config.stalenessThresholdMs,
      has_divergence: absDivergencePct > this.config.minDivergencePct,
      update_unlikely: absDivergencePct < this.config.chainlinkDeviationThresholdPct,
    };

    // 3. Calculate staleness (all conditions must be met)
    const isStale = conditions.time_stale &&
                   conditions.has_divergence &&
                   conditions.update_unlikely;

    // 4. Calculate score
    const score = this.calculateScore({
      timeSinceUpdate,
      absDivergencePct,
      conditions,
    });

    // 5. Optional: factor in oracle predictor probability
    let pNoUpdate = null;
    try {
      const prediction = oraclePredictor.getPrediction(symbol, 30000); // 30s lookahead
      pNoUpdate = 1 - prediction.p_update;
    } catch {
      // Predictor not available or insufficient data
    }

    return {
      symbol,
      is_stale: isStale,
      score,
      conditions,
      inputs: {
        time_since_update_ms: timeSinceUpdate,
        ui_price: divergence.ui_price,
        oracle_price: divergence.oracle_price,
        divergence_pct: divergence.spread_pct,
        p_no_update: pNoUpdate,
      },
      evaluated_at: new Date().toISOString(),
    };
  }

  /**
   * Calculate staleness score (0-1)
   */
  calculateScore({ timeSinceUpdate, absDivergencePct, conditions }) {
    if (!conditions.has_divergence) {
      return 0; // No divergence = not stale
    }

    // Component 1: Time staleness (0-0.35)
    // Score increases as time exceeds threshold
    const timeRatio = Math.min(timeSinceUpdate / this.config.stalenessThresholdMs, 3);
    const timeScore = conditions.time_stale
      ? Math.min(0.35, 0.15 + 0.20 * ((timeRatio - 1) / 2))
      : 0;

    // Component 2: Divergence magnitude (0-0.35)
    // Score based on how much divergence relative to thresholds
    const divergenceRange = this.config.chainlinkDeviationThresholdPct - this.config.minDivergencePct;
    const divergencePosition = (absDivergencePct - this.config.minDivergencePct) / divergenceRange;
    const divergenceScore = conditions.has_divergence
      ? Math.min(0.35, 0.15 + 0.20 * Math.min(divergencePosition, 1))
      : 0;

    // Component 3: Update unlikelihood (0-0.30)
    // Score based on how far below chainlink threshold
    const unlikelinessRatio = 1 - (absDivergencePct / this.config.chainlinkDeviationThresholdPct);
    const unlikelinessScore = conditions.update_unlikely
      ? Math.min(0.30, 0.15 + 0.15 * unlikelinessRatio)
      : 0;

    return timeScore + divergenceScore + unlikelinessScore;
  }
}
```

### Integration with Oracle Tracker (Story 7-4)

Get oracle state for staleness detection:
```javascript
import * as oracleTracker from '../oracle-tracker/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';

function getOracleState(symbol) {
  const state = oracleTracker.getState();
  const tracking = state.tracking[symbol];

  if (!tracking || tracking.last_update_at === null) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.TRACKER_UNAVAILABLE,
      `No oracle data for ${symbol}`,
      { symbol }
    );
  }

  return {
    price: tracking.last_price,
    last_update_at: new Date(tracking.last_update_at).getTime(),
  };
}
```

### Integration with Divergence Tracker (Story 7-3)

Get current spread for staleness detection:
```javascript
import * as divergenceTracker from '../divergence-tracker/index.js';

function getDivergence(symbol) {
  const state = divergenceTracker.getState();
  const spread = state.spreads[symbol];

  if (!spread || spread.oracle_price === null) {
    // Fallback: use oracle-only data
    const oracleState = getOracleState(symbol);
    return {
      ui_price: null,
      oracle_price: oracleState.price,
      spread_pct: 0,
    };
  }

  return {
    ui_price: spread.ui_price,
    oracle_price: spread.oracle_price,
    spread_pct: spread.pct || 0,
  };
}
```

### Integration with Oracle Predictor (Story 7-5)

Optionally factor in update probability:
```javascript
import * as oraclePredictor from '../oracle-predictor/index.js';

function getUpdateProbability(symbol, timeToExpiryMs) {
  try {
    const prediction = oraclePredictor.getPrediction(symbol, timeToExpiryMs);
    return prediction.p_update;
  } catch (err) {
    // Predictor not available - return null to indicate unavailable
    return null;
  }
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    staleness: {
      btc: {
        is_stale: true,
        score: 0.72,
        started_at: '2026-02-01T12:00:00Z',
        duration_ms: 45000,
        conditions: { time_stale: true, has_divergence: true, update_unlikely: true },
      },
      eth: { is_stale: false, score: 0.15, ... },
      sol: { is_stale: false, score: 0.0, ... },
      xrp: { is_stale: true, score: 0.68, ... },
    },
    stats: {
      staleness_events_emitted: 25,
      resolutions_detected: 20,
      avg_staleness_duration_ms: 32000,
    },
    config: { ... },
  };
}
```

### Event Types

```javascript
// Staleness detected event
{
  type: 'staleness_detected',
  symbol: 'btc',
  score: 0.72,
  timestamp: '2026-02-01T12:00:00Z',
  inputs: {
    time_since_update_ms: 25000,
    ui_price: 95000.50,
    oracle_price: 94950.25,
    divergence_pct: 0.0005,
    p_no_update: 0.85,
  },
}

// Staleness resolved event
{
  type: 'staleness_resolved',
  symbol: 'btc',
  staleness_duration_ms: 45000,
  price_at_resolution: 95010.00,
  timestamp: '2026-02-01T12:00:45Z',
}
```

### Logging Requirements

All logs MUST use structured format with required fields:
```javascript
log.info('staleness_detector_initialized', { config: { stalenessThresholdMs, minDivergencePct } });
log.info('staleness_detected', {
  symbol: 'btc', score: 0.72,
  time_since_update_ms: 25000, divergence_pct: 0.0005
});
log.info('staleness_resolved', {
  symbol: 'btc', duration_ms: 45000, price_at_resolution: 95010.00
});
log.warn('tracker_unavailable', { symbol, tracker: 'divergence-tracker' });
log.error('evaluation_failed', { symbol, error: err.message });
```

### Testing Strategy

1. **Unit Tests (detector.test.js):**
   - Condition evaluation with various inputs
   - Score calculation edge cases
   - All conditions false → not stale
   - Only some conditions → not stale
   - All conditions true → stale with score

2. **Unit Tests (index.test.js):**
   - Init sets up trackers
   - getStaleness returns correct structure
   - isStale returns boolean
   - Subscription callbacks called
   - Resolution detection

3. **Integration Tests (integration.test.js):**
   - Mock oracle-tracker with simulated updates
   - Mock divergence-tracker for spread
   - Mock oracle-predictor for probability
   - End-to-end staleness detection
   - Event emission flow

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/modules/oracle-tracker/` - for oracle price and update time (Story 7-4)
- `src/modules/divergence-tracker/` - for UI/Oracle spread (Story 7-3)
- `src/modules/oracle-predictor/` - for update probability (Story 7-5, optional)
- `src/clients/rtds/types.js` - for SUPPORTED_SYMBOLS constant

**No new npm packages required.**

### Previous Story Intelligence (7-1 through 7-5, 7-10, 7-11)

**Key Learnings from Story 7-5 (Oracle Predictor):**
1. Module pattern: init(config), getState(), shutdown()
2. Use child logger: `log = child({ module: 'staleness-detector' })`
3. Error handling with PolyError extension
4. Optional integration with fallback (e.g., divergence-tracker)
5. Subscription pattern with unsubscribe return
6. Handle insufficient data gracefully

**Key Learnings from Story 7-3 (Divergence Tracker):**
1. Event subscription pattern with subscribeToBreaches()
2. Track state changes (breach started/ended)
3. Calculate duration when state resolves
4. Use intervals for periodic evaluation

**Key Learnings from Story 7-4 (Oracle Tracker):**
1. Access tracking state via getState().tracking[symbol]
2. last_update_at is ISO string, convert with new Date().getTime()
3. Handle symbols not in SUPPORTED_SYMBOLS

**Code Review Findings to Apply:**
- Validate all inputs before processing
- Handle missing tracker data gracefully with fallbacks
- Use defensive null checks for tracker state
- Limit warning log frequency with rate limiting
- Clean up subscriptions on shutdown

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- This module is an ANALYSIS module - detects oracle staleness conditions
- Consumes data from oracle-tracker (7-4), divergence-tracker (7-3), oracle-predictor (7-5)
- Story 7-7 (Oracle Edge Signal Generator) will use staleness detection from this module

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides price feeds
- Story 7-3 (Feed Divergence Tracker) - provides UI/Oracle spread
- Story 7-4 (Oracle Pattern Tracker) - provides oracle update timing
- Story 7-5 (Oracle Update Predictor) - provides update probability (optional)

**Used by:**
- Story 7-7 (Oracle Edge Signal Generator) - uses staleness as entry condition

### Key Questions This Module Answers

1. **"Is the BTC oracle currently stale?"**
   - Answer: `isStale('btc')` returns boolean

2. **"How stale is the oracle and why?"**
   - Answer: `getStaleness('btc')` returns full evaluation with conditions and score

3. **"Should I trade based on current staleness?"**
   - Answer: If `score > 0.6`, staleness is significant enough to consider

4. **"When did the staleness end?"**
   - Answer: Subscribe to 'staleness_resolved' events with duration and prices

### Chainlink Oracle Behavior Context

**Why 0.5% deviation threshold matters:**
- Chainlink oracles typically update when price deviates 0.5% from last reported price
- If current divergence is 0.2-0.4%, oracle is unlikely to update soon
- This creates exploitable staleness where UI shows different price than settlement

**Time threshold (15s) rationale:**
- 15-minute windows mean 15s is meaningful (1.67% of window)
- Chainlink updates ~every 10-60 seconds depending on volatility
- If no update in 15s during price movement, oracle is likely "stuck"

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-6]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/implementation-artifacts/7-5-oracle-update-predictor.md - Prediction integration]
- [Source: _bmad-output/implementation-artifacts/7-4-oracle-update-pattern-tracker.md - Oracle tracker patterns]
- [Source: _bmad-output/implementation-artifacts/7-3-feed-divergence-tracker.md - Divergence tracking]
- [Source: src/modules/oracle-tracker/index.js - Module pattern reference]
- [Source: src/modules/divergence-tracker/index.js - Subscription pattern reference]
- [Source: src/modules/oracle-predictor/index.js - Prediction integration reference]
- [Source: src/clients/rtds/types.js - SUPPORTED_SYMBOLS constant]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - All tests passing

### Completion Notes List

- Implemented staleness detector module following established module patterns from oracle-tracker, divergence-tracker, and oracle-predictor
- StalenessDetector class in detector.js handles core staleness detection algorithm with three conditions: time staleness, divergence presence, and update unlikeliness
- Score calculation uses weighted components: time (0-0.35), divergence magnitude (0-0.35), update unlikeliness (0-0.30), with optional predictor bonus
- Event subscription system emits staleness_detected and staleness_resolved events with full context
- Optional integration with divergence-tracker and oracle-predictor - gracefully handles unavailability with fallbacks
- Configuration validation prevents invalid threshold combinations
- Periodic evaluation interval evaluates all symbols for staleness
- 66 comprehensive tests covering unit tests (detector.test.js), module interface tests (index.test.js), and integration tests (integration.test.js)
- All 2341 tests in full suite pass with no regressions

### File List

**New Files:**
- src/modules/staleness-detector/index.js
- src/modules/staleness-detector/detector.js
- src/modules/staleness-detector/types.js
- src/modules/staleness-detector/__tests__/detector.test.js
- src/modules/staleness-detector/__tests__/index.test.js
- src/modules/staleness-detector/__tests__/integration.test.js

### Change Log

- 2026-02-01: Story 7-6 implemented - Oracle staleness detector module with full test coverage

