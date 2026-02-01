# Story 7.11: Component 08 - Lag Tracker

Status: review

---

## Story

As a **quant researcher**,
I want **to measure lag between price feeds and validate if lag predicts profits**,
So that **I can determine if lag-based trading is viable**.

---

## Acceptance Criteria

### AC1: Cross-Correlation at Multiple Tau Values
**Given** price time series from multiple feeds
**When** analyzing lag
**Then** cross-correlation is calculated at multiple tau values: 0.5s, 1s, 2s, 5s, 10s, 30s

### AC2: Optimal Lag Identification
**Given** cross-correlation results
**When** finding optimal lag
**Then** tau* (optimal lag) is identified as the lag with highest correlation
**And** correlation strength at tau* is reported
**And** statistical significance is calculated (p-value < 0.05 required)

### AC3: Lag Stability Monitoring
**Given** lag measurements
**When** tracking over time
**Then** lag stability is monitored (is tau* jumping around?)
**And** lag by regime is tracked (high vol vs low vol, time of day)

### AC4: Lag Signal Logging
**Given** lag signals
**When** a lag-based entry opportunity is identified
**Then** signal is logged with: tau_used, correlation_at_tau, predicted_direction

### AC5: Lag Signal Outcome Validation
**Given** lag signal outcomes
**When** validating predictive power
**Then** track: did the lag signal predict a profitable trade?
**And** log: signal_id, prediction, outcome, pnl

### AC6: Standard Module Interface
**Given** the component
**When** initialized and used
**Then** it exports the standard module interface:
```javascript
{
  init: (config) => Promise<void>,
  analyze: (symbol, windowMs) => { tau_star, correlation, p_value, stable },
  getLagSignal: (symbol) => { has_signal, direction, tau_ms, correlation, confidence },
  getStability: (symbol) => { stable, tau_history, variance },
  getState: () => {},
  shutdown: () => Promise<void>
}
```

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 6)
  - [x] Create `src/modules/lag-tracker/index.js` (public interface)
  - [x] Create `src/modules/lag-tracker/tracker.js` (core lag analysis logic)
  - [x] Create `src/modules/lag-tracker/types.js` (error types, constants)
  - [x] Create `src/modules/lag-tracker/__tests__/index.test.js`
  - [x] Create `src/modules/lag-tracker/__tests__/tracker.test.js`
  - [x] Follow standard module pattern: init(config), getState(), shutdown()

- [x] **Task 2: Create database migration for lag_signals table** (AC: 4, 5)
  - [x] Create migration `010-lag-signals-table.js`
  - [x] Create `lag_signals` table with schema:
    ```sql
    CREATE TABLE lag_signals (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        spot_price_at_signal REAL,
        spot_move_direction TEXT,
        spot_move_magnitude REAL,
        oracle_price_at_signal REAL,
        predicted_direction TEXT,
        predicted_tau_ms INTEGER,
        correlation_at_tau REAL,
        window_id TEXT,
        outcome_direction TEXT,
        prediction_correct INTEGER,
        pnl REAL
    );
    ```
  - [x] Create indexes on timestamp, symbol, window_id

- [x] **Task 3: Implement price history buffer** (AC: 1)
  - [x] Create circular buffer for storing recent UI prices (last 60 seconds)
  - [x] Create circular buffer for storing recent oracle prices (last 60 seconds)
  - [x] Store prices with high-precision timestamps
  - [x] Implement efficient sliding window queries
  - [x] Per-symbol price history isolation

- [x] **Task 4: Implement cross-correlation calculation** (AC: 1, 2)
  - [x] Implement `calculateCrossCorrelation(seriesA, seriesB, tauMs)` function
  - [x] Align time series at specified lag offset
  - [x] Calculate Pearson correlation coefficient at each tau
  - [x] Handle missing/sparse data gracefully
  - [x] Return correlation value in range [-1, 1]

- [x] **Task 5: Implement optimal lag finder** (AC: 1, 2)
  - [x] Implement `findOptimalLag(symbol)` function
  - [x] Test tau values: 500, 1000, 2000, 5000, 10000, 30000 ms
  - [x] Identify tau* with highest absolute correlation
  - [x] Calculate p-value for statistical significance
  - [x] Return { tau_star_ms, correlation, p_value, significant }

- [x] **Task 6: Implement statistical significance test** (AC: 2)
  - [x] Implement t-test for correlation significance
  - [x] Calculate degrees of freedom from sample size
  - [x] Compute t-statistic: t = r * sqrt(n-2) / sqrt(1-r^2)
  - [x] Calculate p-value from t-distribution
  - [x] Threshold: p-value < 0.05 for significance

- [x] **Task 7: Implement lag stability tracking** (AC: 3)
  - [x] Track tau* history over rolling window (last 30 measurements)
  - [x] Calculate variance of tau* selections
  - [x] Detect regime: stable (low variance) vs unstable (high variance)
  - [x] Track lag by volatility regime (using window-timing-model volatility)
  - [x] Track lag by time of day (optional, if patterns emerge)

- [x] **Task 8: Implement lag signal generation** (AC: 4)
  - [x] Detect when spot (Binance) moves significantly
  - [x] Check if oracle (Chainlink) hasn't moved yet
  - [x] Generate signal with predicted direction based on lag
  - [x] Include tau_used, correlation_at_tau, predicted_direction
  - [x] Emit signal event for strategy layer

- [x] **Task 9: Implement signal persistence** (AC: 4, 5)
  - [x] Log signals to `lag_signals` table when generated
  - [x] Use batch insert pattern (buffer + flush like oracle-tracker)
  - [x] Handle database errors gracefully with retry

- [x] **Task 10: Implement outcome tracking** (AC: 5)
  - [x] Provide `recordOutcome(signalId, outcome)` function
  - [x] Update signal record with: outcome_direction, prediction_correct, pnl
  - [x] Calculate prediction accuracy statistics
  - [x] Provide `getAccuracyStats()` method

- [x] **Task 11: Implement module interface** (AC: 6)
  - [x] Export `init(config)` - subscribe to RTDS, setup buffers
  - [x] Export `analyze(symbol, windowMs)` - return lag analysis results
  - [x] Export `getLagSignal(symbol)` - return current signal if any
  - [x] Export `getStability(symbol)` - return stability metrics
  - [x] Export `getState()` - return full module state
  - [x] Export `shutdown()` - cleanup subscriptions, flush buffers

- [x] **Task 12: Write comprehensive tests** (AC: 1-6)
  - [x] Unit tests for cross-correlation calculation
  - [x] Unit tests for optimal lag finder with known data
  - [x] Unit tests for p-value calculation
  - [x] Unit tests for stability tracking
  - [x] Unit tests for signal generation logic
  - [x] Integration tests with mock RTDS data
  - [x] Database persistence tests

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/lag-tracker/`

This is a **standalone module** (not a strategy component like window-timing-model), following the standard module pattern from Epic 7 modules (oracle-tracker, divergence-tracker).

**File Structure:**
```
src/modules/lag-tracker/
├── index.js              # Public interface
├── tracker.js            # Core lag analysis logic
├── types.js              # Error types, constants
└── __tests__/
    ├── index.test.js     # Module interface tests
    └── tracker.test.js   # Lag analysis unit tests
```

**Standard Module Interface Pattern:**
```javascript
// index.js
import { child } from '../logger/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';

let log = null;
let initialized = false;
let tracker = null;

export async function init(config = {}) {
  log = child({ module: 'lag-tracker' });
  log.info('module_init_start');
  // ... initialization
  initialized = true;
  log.info('module_initialized', { config: { ... } });
}

export function getState() {
  if (!initialized) {
    return { initialized: false, ... };
  }
  return { initialized: true, ... };
}

export async function shutdown() {
  log.info('module_shutdown_start');
  // ... cleanup
  log.info('module_shutdown_complete');
  initialized = false;
}
```

### Mathematical Implementation

**Cross-Correlation Formula:**
```javascript
function calculateCrossCorrelation(seriesA, seriesB, tauMs) {
  // seriesA = spot prices (Binance) with timestamps
  // seriesB = oracle prices (Chainlink) with timestamps
  // tauMs = lag offset in milliseconds (positive means A leads B)

  // Align series: for each point in B, find corresponding point in A at time (t - tauMs)
  const alignedPairs = [];
  for (const b of seriesB) {
    const targetTime = b.timestamp - tauMs;
    const a = findClosestPoint(seriesA, targetTime, toleranceMs: 100);
    if (a) {
      alignedPairs.push({ a: a.price, b: b.price });
    }
  }

  if (alignedPairs.length < 10) {
    return null; // Insufficient data
  }

  // Calculate Pearson correlation
  const n = alignedPairs.length;
  const sumA = alignedPairs.reduce((s, p) => s + p.a, 0);
  const sumB = alignedPairs.reduce((s, p) => s + p.b, 0);
  const sumAB = alignedPairs.reduce((s, p) => s + p.a * p.b, 0);
  const sumA2 = alignedPairs.reduce((s, p) => s + p.a * p.a, 0);
  const sumB2 = alignedPairs.reduce((s, p) => s + p.b * p.b, 0);

  const numerator = n * sumAB - sumA * sumB;
  const denominator = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));

  if (denominator === 0) return 0;
  return numerator / denominator;
}
```

**Statistical Significance (T-Test):**
```javascript
function calculatePValue(correlation, sampleSize) {
  const n = sampleSize;
  const r = correlation;

  if (n < 3) return 1; // Not enough data

  // t-statistic: t = r * sqrt(n-2) / sqrt(1-r^2)
  const r2 = r * r;
  if (r2 >= 1) return 0; // Perfect correlation

  const t = r * Math.sqrt(n - 2) / Math.sqrt(1 - r2);

  // Degrees of freedom
  const df = n - 2;

  // Two-tailed p-value using Student's t-distribution
  // Approximation for df > 30 (use normal distribution)
  if (df > 30) {
    return 2 * (1 - normalCDF(Math.abs(t)));
  }

  // For smaller df, use t-distribution approximation
  // Using Abramowitz-Stegun approximation for incomplete beta function
  return tDistributionPValue(Math.abs(t), df);
}
```

**T-Distribution P-Value Approximation:**
```javascript
function tDistributionPValue(t, df) {
  // Approximation using incomplete beta function
  // For correlation significance testing

  const x = df / (df + t * t);
  const betaInc = incompleteBeta(df / 2, 0.5, x);
  return betaInc; // Two-tailed p-value
}

// Incomplete beta function approximation
function incompleteBeta(a, b, x) {
  // Lentz's continued fraction algorithm (simplified)
  // For a = df/2, b = 0.5, this gives t-distribution CDF

  // For practical purposes, use lookup table or numerical integration
  // This is a simplified approximation

  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Approximation for typical cases
  const term = Math.pow(x, a) * Math.pow(1 - x, b) / (a * beta(a, b));
  let sum = term;
  let prev = 0;

  for (let k = 0; k < 100 && Math.abs(sum - prev) > 1e-10; k++) {
    prev = sum;
    const coef = (a + k) * (a + b + k) / ((a + 2 * k + 1) * (a + 2 * k + 2));
    sum += term * coef * x;
    term *= coef * x;
  }

  return sum;
}
```

### Price History Buffer Implementation

**Circular Buffer for Efficiency:**
```javascript
class PriceBuffer {
  constructor(maxAgeMs = 60000, maxSize = 1000) {
    this.maxAgeMs = maxAgeMs;
    this.maxSize = maxSize;
    this.buffer = [];
  }

  add(price, timestamp) {
    this.buffer.push({ price, timestamp });

    // Remove old entries
    const cutoff = timestamp - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer.shift();
    }

    // Limit size
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getRange(startMs, endMs) {
    return this.buffer.filter(p => p.timestamp >= startMs && p.timestamp <= endMs);
  }

  findClosest(targetTimestamp, toleranceMs) {
    let closest = null;
    let minDiff = Infinity;

    for (const point of this.buffer) {
      const diff = Math.abs(point.timestamp - targetTimestamp);
      if (diff < minDiff && diff <= toleranceMs) {
        minDiff = diff;
        closest = point;
      }
    }

    return closest;
  }

  get length() {
    return this.buffer.length;
  }

  clear() {
    this.buffer = [];
  }
}
```

### Lag Signal Generation Logic

**Signal Conditions:**
```javascript
function checkLagSignal(symbol) {
  // Get recent spot (Binance) price movement
  const spotPrices = spotBuffers[symbol].getRange(now - 5000, now);
  const spotMove = calculatePriceMove(spotPrices);

  // Get current oracle (Chainlink) state
  const oraclePrice = oracleTracker.getLatestPrice(symbol);
  const oracleStale = oracleTracker.isStale(symbol);

  // Check conditions
  const significantSpotMove = Math.abs(spotMove.magnitude) > config.minMoveMagnitude;
  const oracleLagging = oracleStale || !hasOracleMoved(symbol, spotMove.startTime);

  if (significantSpotMove && oracleLagging) {
    // Predict oracle will catch up to spot
    const predictedDirection = spotMove.magnitude > 0 ? 'up' : 'down';

    // Get lag analysis for confidence
    const lagAnalysis = analyze(symbol);

    if (lagAnalysis.significant) {
      return {
        has_signal: true,
        direction: predictedDirection,
        tau_ms: lagAnalysis.tau_star_ms,
        correlation: lagAnalysis.correlation,
        confidence: calculateConfidence(lagAnalysis),
        spot_price: spotPrices[spotPrices.length - 1].price,
        oracle_price: oraclePrice,
        spot_move_magnitude: spotMove.magnitude,
      };
    }
  }

  return { has_signal: false };
}
```

### Configuration Schema

```javascript
// config/default.js additions
{
  lagTracker: {
    // Buffer settings
    bufferMaxAgeMs: 60000,        // Keep last 60 seconds of prices
    bufferMaxSize: 2000,          // Max points per symbol

    // Tau values to test
    tauValues: [500, 1000, 2000, 5000, 10000, 30000], // milliseconds

    // Signal generation
    minMoveMagnitude: 0.001,      // 0.1% minimum move to generate signal
    minCorrelation: 0.5,          // Minimum correlation for signal
    significanceThreshold: 0.05,  // P-value threshold

    // Stability tracking
    stabilityWindowSize: 30,      // Number of tau* samples to track
    stabilityThreshold: 5000,     // Variance threshold (ms^2) for stability

    // Persistence
    bufferSize: 10,               // Flush after N signals
    flushIntervalMs: 1000,        // Flush every N ms
  }
}
```

### Database Migration

**Migration: 010-lag-signals-table.js**
```javascript
export async function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lag_signals (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        spot_price_at_signal REAL,
        spot_move_direction TEXT,
        spot_move_magnitude REAL,
        oracle_price_at_signal REAL,
        predicted_direction TEXT,
        predicted_tau_ms INTEGER,
        correlation_at_tau REAL,
        window_id TEXT,
        outcome_direction TEXT,
        prediction_correct INTEGER,
        pnl REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_lag_signals_timestamp ON lag_signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_lag_signals_symbol ON lag_signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_lag_signals_window ON lag_signals(window_id);
  `);
}

export async function down(db) {
  db.exec('DROP TABLE IF EXISTS lag_signals');
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    buffers: {
      btc: { spot_count: 450, oracle_count: 380, oldest_ms: 55000, newest_ms: 100 },
      eth: { spot_count: 420, oracle_count: 360, oldest_ms: 54000, newest_ms: 150 },
      sol: { spot_count: 400, oracle_count: 340, oldest_ms: 53000, newest_ms: 200 },
      xrp: { spot_count: 380, oracle_count: 320, oldest_ms: 52000, newest_ms: 250 },
    },
    analysis: {
      btc: { tau_star_ms: 2000, correlation: 0.82, p_value: 0.001, significant: true },
      eth: { tau_star_ms: 1500, correlation: 0.78, p_value: 0.003, significant: true },
      sol: { tau_star_ms: 2500, correlation: 0.71, p_value: 0.012, significant: true },
      xrp: { tau_star_ms: 3000, correlation: 0.65, p_value: 0.028, significant: true },
    },
    stability: {
      btc: { stable: true, variance: 1200, samples: 30 },
      eth: { stable: true, variance: 1800, samples: 28 },
      sol: { stable: false, variance: 8500, samples: 25 },
      xrp: { stable: false, variance: 12000, samples: 22 },
    },
    signals: {
      pending_records: 3,
      total_generated: 47,
      total_correct: 28,
      accuracy: 0.596,
    },
    config: { /* ... */ },
  };
}
```

### Logging Requirements

```javascript
log.info('lag_analysis_complete', {
  symbol, tau_star_ms: 2000, correlation: 0.82, p_value: 0.001,
  significant: true, sample_size: 120
});

log.info('lag_signal_generated', {
  symbol, direction: 'up', tau_ms: 2000, correlation: 0.82,
  spot_price: 95200, oracle_price: 95100, move_magnitude: 0.003
});

log.info('lag_signal_outcome', {
  signal_id: 47, predicted: 'up', actual: 'up',
  correct: true, pnl: 12.50
});

log.info('stability_change', {
  symbol: 'sol', was_stable: true, now_stable: false,
  variance: 8500, threshold: 5000
});

log.warn('insufficient_data', {
  symbol, spot_count: 8, oracle_count: 5, required: 10
});
```

### Testing Strategy

1. **Cross-Correlation Unit Tests:**
   - Perfect positive correlation returns 1.0
   - Perfect negative correlation returns -1.0
   - No correlation returns ~0.0
   - Lagged data returns high correlation at correct tau
   - Insufficient data returns null

2. **P-Value Unit Tests:**
   - High correlation with large sample → low p-value
   - Low correlation with small sample → high p-value
   - Borderline cases at significance threshold

3. **Stability Unit Tests:**
   - Consistent tau* → stable = true
   - Varying tau* → stable = false
   - Variance calculation accuracy

4. **Signal Generation Tests:**
   - Signal generated when conditions met
   - No signal when spot move too small
   - No signal when correlation too low
   - Direction prediction matches spot move

5. **Integration Tests:**
   - Full pipeline with simulated RTDS data
   - Database persistence and retrieval
   - Outcome recording and accuracy calculation

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/persistence/` - for database access
- `src/clients/rtds/` - for price feed subscription (Story 7-1)
- `src/modules/oracle-tracker/` - for oracle state (Story 7-4)

**Imports from window-timing-model (Story 7-10):**
- `normalCDF(x)` function can be reused for p-value calculation
- Volatility regime data for lag-by-volatility tracking

**No new npm packages required.**

### Previous Story Intelligence (7-10)

**Key Learnings from Story 7-10 (Window Timing Model):**
1. Use `normalCDF` approximation (Abramowitz-Stegun) for statistical calculations
2. Buffer and batch inserts for database efficiency
3. Handle edge cases (insufficient data, division by zero)
4. Use configurable thresholds with sensible defaults
5. Cache computationally expensive results (refresh periodically)
6. Comprehensive test coverage for mathematical functions
7. Follow component metadata pattern for registry integration

**Module Patterns from Story 7-4 (Oracle Tracker):**
1. Subscribe to RTDS client, filter by topic
2. Buffer records, flush on size or interval
3. Transaction-wrapped batch inserts for atomicity
4. Handle database errors with retry (keep in buffer)
5. Use `child({ module: 'lag-tracker' })` for logging
6. `unsubscribers` array for cleanup on shutdown

### Project Structure Notes

- This is a **standalone module** under `src/modules/lag-tracker/`
- Follows Epic 7 module pattern (like oracle-tracker, divergence-tracker)
- Will be registered as component type "analysis" in Story 7-12
- Subscribes directly to RTDS client for both feeds
- Uses oracle-tracker state to detect oracle staleness

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides UI and oracle price feeds
- Story 7-4 (Oracle Pattern Tracker) - provides oracle update patterns
- Story 7-10 (Window Timing Model) - mathematical utilities, volatility regime

**Used by:**
- Story 7-12 (Strategy Composition Integration) - registers as analysis component
- Future lag-based strategy compositions

### Key Question to Answer

> Does knowing "Binance moved but Chainlink hasn't" actually predict profitable trades? The data will tell us.

This module instruments everything needed to answer this question:
1. Cross-correlation at multiple lags → Is there a consistent lag?
2. Optimal lag identification → What is the typical lag?
3. Lag stability → Is the lag reliable?
4. Signal generation → When conditions are right, what do we predict?
5. Outcome tracking → Were we right? Did it make money?

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-11]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Schema]
- [Source: _bmad-output/implementation-artifacts/7-10-window-timing-model.md - Mathematical patterns]
- [Source: src/modules/oracle-tracker/index.js - Module pattern reference]
- [Source: src/modules/divergence-tracker/index.js - Subscription patterns]
- [Source: src/clients/rtds/index.js - RTDS subscription interface]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No significant debug issues encountered.

### Completion Notes List

- **2026-02-01**: Implemented complete lag-tracker module with all 12 tasks completed:
  - Created standard module structure following oracle-tracker/divergence-tracker patterns
  - Implemented PriceBuffer circular buffer class for efficient price history storage
  - Implemented cross-correlation calculation using Pearson correlation at specified lag offsets
  - Implemented optimal lag finder that tests multiple tau values (500, 1000, 2000, 5000, 10000, 30000 ms)
  - Implemented statistical significance testing using t-test for correlation significance
  - Implemented lag stability tracking with variance calculation and stability detection
  - Implemented lag signal generation detecting spot vs oracle divergence
  - Implemented signal persistence using batch insert pattern with transaction-wrapped writes
  - Implemented outcome tracking with prediction accuracy statistics
  - Created database migration 010-lag-signals-table.js
  - All 54 unit tests passing
  - Full test suite (2090 tests) passing

### File List

- `src/modules/lag-tracker/index.js` (new)
- `src/modules/lag-tracker/tracker.js` (new)
- `src/modules/lag-tracker/types.js` (new)
- `src/modules/lag-tracker/__tests__/index.test.js` (new)
- `src/modules/lag-tracker/__tests__/tracker.test.js` (new)
- `src/persistence/migrations/010-lag-signals-table.js` (new)

### Change Log

- 2026-02-01: Initial implementation of lag-tracker module - all tasks complete

