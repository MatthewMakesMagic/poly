# Story 7.5: Oracle Update Predictor

Status: review

---

## Story

As a **trader**,
I want **to predict the probability of an oracle update before window expiry**,
So that **I can assess whether the current oracle price is likely to change**.

---

## Acceptance Criteria

### AC1: Prediction Inputs
**Given** current oracle state
**When** predicting update probability
**Then** inputs considered: current_deviation_from_last_update, time_since_last_update, time_to_expiry, historical_update_patterns

### AC2: Empirical Distribution Calculation
**Given** historical patterns exist
**When** calculating probability
**Then** use empirical distribution: P(update) = historical_rate_at_similar_conditions
**And** output includes confidence interval

### AC3: Outcome Logging
**Given** prediction is made
**When** window expires
**Then** outcome is logged: predicted_probability, actual_outcome (update_occurred: true/false)
**And** calibration can be tracked over time

### AC4: Prediction Query Interface
**Given** the predictor module
**When** querying
**Then** getPrediction(symbol, time_to_expiry_ms) returns: `{ p_update, confidence, inputs_used }`

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1, 4)
  - [x] Create `src/modules/oracle-predictor/` folder
  - [x] Create `index.js` (public interface: init, getPrediction, getState, shutdown)
  - [x] Create `predictor.js` (OracleUpdatePredictor class with prediction logic)
  - [x] Create `types.js` (OraclePredictorError, error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Create database migration for prediction tracking** (AC: 3)
  - [x] Create migration `011-oracle-predictions-table.js`
  - [x] Create `oracle_update_predictions` table:
    ```sql
    CREATE TABLE oracle_update_predictions (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        window_id TEXT,
        time_to_expiry_ms INTEGER NOT NULL,
        time_since_last_update_ms INTEGER NOT NULL,
        current_deviation_pct REAL NOT NULL,
        predicted_p_update REAL NOT NULL,
        confidence_low REAL,
        confidence_high REAL,
        actual_outcome INTEGER,  -- 1 = update occurred, 0 = no update, NULL = pending
        settled_at TEXT
    );
    ```
  - [x] Create indexes on timestamp, symbol, window_id

- [x] **Task 3: Implement empirical pattern analysis** (AC: 1, 2)
  - [x] Query historical updates from `oracle_updates` table
  - [x] Build condition buckets based on: time_since_last_update, deviation_magnitude
  - [x] Calculate update rates for each bucket
  - [x] Create `analyzePatterns(symbol)` function returning bucket statistics
  - [x] Cache pattern analysis for performance (recalculate every 5 min)

- [x] **Task 4: Implement prediction algorithm** (AC: 1, 2)
  - [x] Create `getPrediction(symbol, timeToExpiryMs, currentState)` function
  - [x] Get current oracle state from oracle-tracker: last_price, last_update_at
  - [x] Calculate current_deviation_from_ui (from divergence-tracker if available)
  - [x] Calculate time_since_last_update_ms
  - [x] Match current conditions to historical bucket
  - [x] Calculate P(update) from empirical distribution
  - [x] Calculate confidence interval using Wilson score or bootstrap

- [x] **Task 5: Implement time-to-expiry probability decay** (AC: 2)
  - [x] Factor in remaining time: P(update in T) ≈ 1 - (1 - base_rate)^(T/avg_interval)
  - [x] Handle edge cases: T = 0, T very large, no historical data
  - [x] Return deterministic results at boundaries

- [x] **Task 6: Implement prediction logging** (AC: 3)
  - [x] Create `logPrediction(prediction)` function
  - [x] Insert to `oracle_update_predictions` table
  - [x] Include all inputs used for prediction
  - [x] Log prediction event with context

- [x] **Task 7: Implement outcome tracking** (AC: 3)
  - [x] Create `recordOutcome(windowId, updateOccurred)` function
  - [x] Update prediction record with actual_outcome and settled_at
  - [x] Calculate calibration metrics after recording

- [x] **Task 8: Implement calibration analysis** (AC: 3)
  - [x] Create `getCalibration()` function
  - [x] Bucket predictions by predicted_p_update (0-10%, 10-20%, etc.)
  - [x] Calculate actual update rate per bucket
  - [x] Calculate calibration error: |predicted - actual|
  - [x] Expose calibration stats in getState()

- [x] **Task 9: Implement module interface** (AC: 1, 4)
  - [x] Export `init(config)` - setup, subscribe to oracle tracker
  - [x] Export `getPrediction(symbol, timeToExpiryMs)` - main prediction function
  - [x] Export `getPatterns(symbol)` - get analyzed patterns
  - [x] Export `getCalibration()` - calibration statistics
  - [x] Export `getState()` - full module state
  - [x] Export `shutdown()` - cleanup

- [x] **Task 10: Write comprehensive tests** (AC: 1-4)
  - [x] Unit tests for prediction algorithm with mock historical data
  - [x] Unit tests for empirical bucket matching
  - [x] Unit tests for confidence interval calculation
  - [x] Unit tests for edge cases (no data, T=0, very stale oracle)
  - [x] Integration test with mock oracle-tracker
  - [x] Calibration tracking tests
  - [x] Test prediction logging and outcome recording

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/oracle-predictor/`

**File Structure (per architecture.md):**
```
src/modules/oracle-predictor/
├── index.js          # Public interface (init, getPrediction, getPatterns, getCalibration, getState, shutdown)
├── predictor.js      # OracleUpdatePredictor class with prediction logic
├── types.js          # OraclePredictorError, error codes, constants
└── __tests__/
    ├── index.test.js
    ├── predictor.test.js
    └── calibration.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export function getPrediction(symbol, timeToExpiryMs) {}  // Main prediction
export function getPatterns(symbol) {}  // Historical pattern analysis
export function getCalibration() {}  // Calibration statistics
export function getState() {}
export async function shutdown() {}
export { OraclePredictorError, OraclePredictorErrorCodes };
```

### Database Schema

**Migration: 011-oracle-predictions-table.js**
```sql
CREATE TABLE oracle_update_predictions (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    window_id TEXT,
    time_to_expiry_ms INTEGER NOT NULL,
    time_since_last_update_ms INTEGER NOT NULL,
    current_deviation_pct REAL NOT NULL,
    predicted_p_update REAL NOT NULL,
    confidence_low REAL,
    confidence_high REAL,
    bucket TEXT NOT NULL,
    inputs_json TEXT,
    actual_outcome INTEGER,  -- 1 = update occurred, 0 = no update, NULL = pending
    settled_at TEXT
);

CREATE INDEX idx_oracle_pred_timestamp ON oracle_update_predictions(timestamp);
CREATE INDEX idx_oracle_pred_symbol ON oracle_update_predictions(symbol);
CREATE INDEX idx_oracle_pred_window ON oracle_update_predictions(window_id);
CREATE INDEX idx_oracle_pred_bucket ON oracle_update_predictions(bucket);
```

### Pattern Reference: Oracle Tracker (Story 7-4)

This module MUST follow the EXACT same patterns as `src/modules/oracle-tracker/`:

1. **index.js** - thin wrapper that:
   - Creates child logger: `log = child({ module: 'oracle-predictor' })`
   - Uses persistence module for database access
   - Consumes oracle-tracker for pattern data
   - Exposes standard interface

2. **Error Handling** - use PolyError pattern:
```javascript
import { PolyError } from '../../types/errors.js';

class OraclePredictorError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OraclePredictorError';
  }
}
```

3. **Error Codes:**
```javascript
export const OraclePredictorErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_PREDICTOR_NOT_INITIALIZED',
  INVALID_SYMBOL: 'ORACLE_PREDICTOR_INVALID_SYMBOL',
  INVALID_INPUT: 'ORACLE_PREDICTOR_INVALID_INPUT',
  INSUFFICIENT_DATA: 'ORACLE_PREDICTOR_INSUFFICIENT_DATA',
  PERSISTENCE_ERROR: 'ORACLE_PREDICTOR_PERSISTENCE_ERROR',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  oraclePredictor: {
    patternCacheExpiryMs: 5 * 60 * 1000,      // Recalculate patterns every 5 min
    minHistoricalUpdates: 20,                  // Minimum updates needed for reliable prediction
    confidenceLevel: 0.95,                     // For confidence interval calculation
    buckets: {
      timeSinceLast: [                         // Time buckets in ms
        { name: '0-10s', min: 0, max: 10000 },
        { name: '10-30s', min: 10000, max: 30000 },
        { name: '30s-1m', min: 30000, max: 60000 },
        { name: '1-2m', min: 60000, max: 120000 },
        { name: '2-5m', min: 120000, max: 300000 },
        { name: '>5m', min: 300000, max: Infinity },
      ],
      deviation: [                             // Deviation buckets
        { name: 'micro', min: 0, max: 0.001 },      // 0-0.1%
        { name: 'small', min: 0.001, max: 0.003 },  // 0.1-0.3%
        { name: 'medium', min: 0.003, max: 0.005 }, // 0.3-0.5%
        { name: 'large', min: 0.005, max: 0.01 },   // 0.5-1%
        { name: 'extreme', min: 0.01, max: Infinity }, // >1%
      ],
    },
  }
}
```

### Prediction Algorithm

**Core Insight:** The oracle update probability depends on:
1. **Time since last update** - longer time increases probability
2. **Current deviation from last oracle price** - larger deviation increases probability
3. **Historical patterns** - how often updates occur under similar conditions
4. **Time remaining** - more time = more opportunities for update

**Key Algorithm:**
```javascript
class OracleUpdatePredictor {
  constructor(config) {
    this.config = config;
    this.patternCache = {}; // { symbol: { buckets, lastCalculated } }
  }

  /**
   * Get prediction for probability of oracle update before expiry
   */
  getPrediction(symbol, timeToExpiryMs, currentState = null) {
    // 1. Get current oracle state from oracle-tracker
    const oracleState = currentState || this.getOracleState(symbol);
    const timeSinceLastUpdate = Date.now() - oracleState.last_update_at;

    // 2. Get current deviation (oracle vs UI price, from divergence-tracker)
    const currentDeviation = this.getCurrentDeviation(symbol);

    // 3. Get historical patterns (cached)
    const patterns = this.getPatterns(symbol);

    // 4. Find matching bucket
    const bucket = this.findBucket(timeSinceLastUpdate, currentDeviation, patterns);

    // 5. Calculate base probability from empirical data
    const baseProb = bucket.updateRate; // P(update | current conditions)

    // 6. Adjust for time remaining
    // If avg update interval is I ms, and we have T ms remaining,
    // P(at least one update in T) ≈ 1 - e^(-T/I) ≈ 1 - (1 - r)^(T/I)
    const avgInterval = patterns.avgUpdateIntervalMs;
    const effectiveIntervals = timeToExpiryMs / avgInterval;
    const pNoUpdate = Math.pow(1 - baseProb, effectiveIntervals);
    const pUpdate = 1 - pNoUpdate;

    // 7. Calculate confidence interval using Wilson score
    const { low, high } = this.wilsonConfidence(
      bucket.updates,
      bucket.total,
      this.config.confidenceLevel
    );

    return {
      p_update: pUpdate,
      confidence: { low, high },
      inputs_used: {
        symbol,
        time_to_expiry_ms: timeToExpiryMs,
        time_since_last_update_ms: timeSinceLastUpdate,
        current_deviation_pct: currentDeviation,
        bucket: bucket.name,
        avg_update_interval_ms: avgInterval,
        bucket_update_rate: baseProb,
        bucket_sample_size: bucket.total,
      },
    };
  }

  /**
   * Analyze historical update patterns
   */
  analyzePatterns(symbol) {
    // Query all updates for symbol from oracle_updates table
    const updates = persistence.all(
      `SELECT timestamp, price, previous_price, deviation_from_previous_pct, time_since_previous_ms
       FROM oracle_updates
       WHERE symbol = ?
       ORDER BY timestamp ASC`,
      [symbol]
    );

    if (updates.length < this.config.minHistoricalUpdates) {
      return null; // Insufficient data
    }

    // Calculate average update interval
    const avgInterval = updates.reduce((sum, u) => sum + (u.time_since_previous_ms || 0), 0) / updates.length;

    // Build 2D bucket matrix: time_since_last x deviation
    const bucketMatrix = {};

    for (const timeBucket of this.config.buckets.timeSinceLast) {
      for (const devBucket of this.config.buckets.deviation) {
        const key = `${timeBucket.name}:${devBucket.name}`;
        bucketMatrix[key] = {
          name: key,
          timeBucket: timeBucket.name,
          deviationBucket: devBucket.name,
          updates: 0,  // Count of updates that occurred
          total: 0,    // Total time periods in this bucket
          updateRate: 0,
        };
      }
    }

    // Count updates per bucket
    // For each update, determine what bucket conditions existed BEFORE the update
    for (const update of updates) {
      const timeSincePrev = update.time_since_previous_ms || 0;
      const deviation = Math.abs(update.deviation_from_previous_pct || 0);

      const timeBucket = this.findTimeBucket(timeSincePrev);
      const devBucket = this.findDeviationBucket(deviation);

      if (timeBucket && devBucket) {
        const key = `${timeBucket.name}:${devBucket.name}`;
        bucketMatrix[key].updates++;
        bucketMatrix[key].total++;
      }
    }

    // Calculate update rates
    for (const bucket of Object.values(bucketMatrix)) {
      bucket.updateRate = bucket.total > 0 ? bucket.updates / bucket.total : 0;
    }

    return {
      symbol,
      totalUpdates: updates.length,
      avgUpdateIntervalMs: avgInterval,
      buckets: bucketMatrix,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Wilson score confidence interval for binomial proportion
   */
  wilsonConfidence(successes, total, confidenceLevel = 0.95) {
    if (total === 0) {
      return { low: 0, high: 1 };
    }

    const p = successes / total;
    const z = this.getZScore(confidenceLevel);
    const n = total;

    const denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator;
    const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;

    return {
      low: Math.max(0, center - spread),
      high: Math.min(1, center + spread),
    };
  }

  /**
   * Get z-score for confidence level
   */
  getZScore(confidenceLevel) {
    // Common z-scores
    const zScores = {
      0.90: 1.645,
      0.95: 1.96,
      0.99: 2.576,
    };
    return zScores[confidenceLevel] || 1.96;
  }
}
```

### Integration with Oracle Tracker (Story 7-4)

**CRITICAL:** This module consumes data from oracle-tracker:

```javascript
import * as oracleTracker from '../oracle-tracker/index.js';
import { SUPPORTED_SYMBOLS, TOPICS } from '../../clients/rtds/types.js';

function getOracleState(symbol) {
  const state = oracleTracker.getState();
  const tracking = state.tracking[symbol];

  if (!tracking || !tracking.last_update_at) {
    throw new OraclePredictorError(
      OraclePredictorErrorCodes.INSUFFICIENT_DATA,
      `No oracle data available for ${symbol}`,
      { symbol }
    );
  }

  return {
    last_price: tracking.last_price,
    last_update_at: new Date(tracking.last_update_at).getTime(),
    updates_recorded: tracking.updates_recorded,
  };
}
```

### Integration with Divergence Tracker (Story 7-3)

For current deviation, optionally integrate with divergence-tracker:

```javascript
import * as divergenceTracker from '../divergence-tracker/index.js';

function getCurrentDeviation(symbol) {
  try {
    const state = divergenceTracker.getState();
    const symbolState = state.spreads[symbol];

    if (symbolState && symbolState.spread_pct !== null) {
      return Math.abs(symbolState.spread_pct);
    }
  } catch (err) {
    // Divergence tracker not available, use estimate from oracle updates
  }

  // Fallback: estimate deviation from recent oracle update
  const latestUpdate = persistence.get(
    'SELECT deviation_from_previous_pct FROM oracle_updates WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1',
    [symbol]
  );

  return Math.abs(latestUpdate?.deviation_from_previous_pct || 0);
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    patterns: {
      btc: {
        totalUpdates: 1500,
        avgUpdateIntervalMs: 12500,
        analyzedAt: '2026-02-01T12:00:00Z',
        bucketCount: 30,
      },
      eth: { ... },
      sol: { ... },
      xrp: { ... },
    },
    calibration: {
      total_predictions: 200,
      buckets: {
        '0-10%': { count: 50, actual_rate: 0.08, error: 0.02 },
        '10-20%': { count: 40, actual_rate: 0.15, error: 0.05 },
        // ...
      },
      avg_error: 0.05,
    },
    config: { ... },
  };
}
```

### Logging Requirements

All logs MUST use structured format with required fields:

```javascript
log.info('oracle_predictor_initialized', { config: { patternCacheExpiryMs, minHistoricalUpdates } });
log.info('prediction_generated', {
  symbol, p_update: 0.35, confidence: { low: 0.28, high: 0.42 },
  time_to_expiry_ms: 30000, time_since_last_update_ms: 45000
});
log.info('patterns_analyzed', { symbol, total_updates: 1500, avg_interval_ms: 12500, bucket_count: 30 });
log.info('prediction_logged', { prediction_id: 123, symbol, p_update: 0.35 });
log.info('outcome_recorded', { prediction_id: 123, actual_outcome: true, prediction_correct: true });
log.warn('insufficient_historical_data', { symbol, updates_found: 15, min_required: 20 });
log.error('prediction_failed', { symbol, error: err.message });
```

### Testing Strategy

1. **Unit Tests (predictor.test.js):**
   - Bucket matching for time and deviation
   - Wilson confidence interval calculation
   - Time decay probability calculation
   - Edge cases (no data, T=0, very stale oracle)
   - Pattern caching behavior

2. **Unit Tests (index.test.js):**
   - Init sets up pattern cache
   - getPrediction returns correct structure
   - getPatterns returns analyzed patterns
   - getState returns correct shape
   - shutdown cleans up

3. **Unit Tests (calibration.test.js):**
   - Prediction logging to database
   - Outcome recording updates prediction
   - Calibration calculation from recorded predictions
   - Bucket assignment for predictions

4. **Integration Tests:**
   - Mock oracle-tracker with simulated data
   - Mock divergence-tracker for deviation
   - End-to-end prediction with database

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/persistence/` - for database access
- `src/modules/oracle-tracker/` - for oracle state and historical data (Story 7-4)
- `src/modules/divergence-tracker/` - for current UI/Oracle deviation (Story 7-3, optional)

**No new npm packages required.**

### Previous Story Intelligence (7-1 through 7-4, 7-10)

**Key Learnings from Story 7-4 (Oracle Tracker):**
1. Oracle updates table (`oracle_updates`) provides all historical update data
2. Access via `oracleTracker.getState()` for current tracking
3. Use `SUPPORTED_SYMBOLS` from `rtds/types.js` for symbol validation
4. Module pattern: init(config), getState(), shutdown()
5. Use child logger: `log = child({ module: 'oracle-predictor' })`
6. Handle edge cases (empty data, insufficient history)

**Key Learnings from Story 7-10 (Window Timing Model):**
1. Calibration tracking pattern - bucket predictions, track outcomes, calculate errors
2. Use `probability_predictions` table pattern for tracking
3. Wilson score or bootstrap for confidence intervals
4. Cache expensive calculations with expiry
5. Handle insufficient data gracefully with fallbacks

**Code Review Findings to Apply:**
- Validate all inputs before prediction
- Handle division by zero (bucket.total = 0)
- Use defensive null checks for oracle state
- Cache pattern analysis for performance
- Test with empty data scenarios
- Use rate limiting for warning logs

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- This module is an ANALYSIS module - predicts oracle update probability
- Consumes data from oracle-tracker (7-4) and optionally divergence-tracker (7-3)
- Story 7-6 (Oracle Staleness Detector) will use predictions from this module
- Story 7-7 (Oracle Edge Signal Generator) will use both staleness and predictions

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides oracle price feed
- Story 7-4 (Oracle Pattern Tracker) - provides oracle update history and statistics

**Optionally integrates with:**
- Story 7-3 (Feed Divergence Tracker) - for current UI/Oracle spread

**Used by:**
- Story 7-6 (Oracle Staleness Detector) - uses update probability for staleness assessment
- Story 7-7 (Oracle Edge Signal Generator) - uses probability in signal confidence

### Key Questions This Module Answers

1. **"What's the probability that Chainlink will update BTC before expiry?"**
   - Answer: `getPrediction('btc', timeToExpiryMs)` returns { p_update, confidence, inputs_used }

2. **"What historical patterns exist for oracle updates?"**
   - Answer: `getPatterns('eth')` returns bucket matrix with update rates

3. **"Is our prediction model well-calibrated?"**
   - Answer: `getCalibration()` returns bucket-level calibration stats and errors

4. **"Should I trust the current oracle price will persist?"**
   - Answer: Low p_update + time_since_update < avg_interval → oracle likely stable

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-5]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Schema]
- [Source: _bmad-output/implementation-artifacts/7-4-oracle-update-pattern-tracker.md - Oracle tracker patterns]
- [Source: _bmad-output/implementation-artifacts/7-10-window-timing-model.md - Calibration tracking patterns]
- [Source: src/modules/oracle-tracker/index.js - Module pattern reference]
- [Source: src/modules/oracle-tracker/tracker.js - Pattern tracking reference]
- [Source: src/modules/oracle-tracker/types.js - Error pattern reference]
- [Source: src/clients/rtds/types.js - TOPICS, SUPPORTED_SYMBOLS constants]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A

### Completion Notes List

- Created oracle-predictor module with standard module interface pattern
- Implemented OracleUpdatePredictor class with empirical pattern analysis and Wilson confidence intervals
- Created database migration 011-oracle-predictions-table.js for calibration tracking
- Used exponential decay model for time-to-expiry probability adjustment
- Integrated with oracle-tracker for oracle state, optional divergence-tracker for deviation
- All 85 tests pass (44 predictor, 18 index, 23 calibration)
- Full test suite passes (2234 tests) with no regressions

### File List

**New Files:**
- src/modules/oracle-predictor/index.js
- src/modules/oracle-predictor/predictor.js
- src/modules/oracle-predictor/types.js
- src/modules/oracle-predictor/__tests__/index.test.js
- src/modules/oracle-predictor/__tests__/predictor.test.js
- src/modules/oracle-predictor/__tests__/calibration.test.js
- src/persistence/migrations/011-oracle-predictions-table.js

---

## Change Log

- 2026-02-01: Initial implementation of oracle-predictor module (all 10 tasks completed)
