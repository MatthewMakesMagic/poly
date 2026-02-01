# Story 7.10: Component 07 - Window Timing Model

Status: review

---

## Story

As a **quant trader**,
I want **Black-Scholes probability calculations using oracle price**,
So that **I can assess true probability of UP/DOWN based on settlement price**.

---

## Acceptance Criteria

### AC1: Black-Scholes N(d2) Calculation
**Given** market state is available
**When** calculating probability
**Then** Black-Scholes N(d2) is used where:
- S = oracle_price (NOT ui_price - this is settlement truth)
- K = strike (the 0.50 midpoint for UP/DOWN resolution)
- T = time_to_expiry in years
- σ = realized volatility (rolling calculation)
- r = 0 (risk-free rate, negligible for short windows)

### AC2: Volatility Calculation
**Given** volatility calculation
**When** computing sigma
**Then** realized volatility is calculated from oracle price history
**And** lookback period is configurable (default: 6 hours)
**And** volatility is calculated per asset (BTC, ETH, SOL, XRP separately)

### AC3: Volatility Surprise Detection
**Given** volatility surprise detection
**When** short-term vol (15 min) differs significantly from long-term (6 hour)
**Then** vol_surprise flag is set
**And** logged for analysis

### AC4: Calibration Tracking
**Given** calibration tracking
**When** model predicts P(UP) = X%
**Then** predictions are bucketed (50-60%, 60-70%, 70-80%, etc.)
**And** actual outcomes are tracked per bucket
**And** calibration error is calculated: |predicted - actual_hit_rate|

### AC5: Calibration Alert
**Given** calibration error exceeds threshold
**When** error > 15% over 100 predictions in a bucket
**Then** alert is raised
**And** model parameters may need adjustment

### AC6: Standard Component Interface
**Given** the component
**When** initialized and used
**Then** it exports the standard interface:
```javascript
{
  init: (config) => Promise<void>,
  calculateProbability: (oraclePrice, strike, timeToExpiryMs, symbol) => {
    p_up, p_down, sigma_used, d2, inputs
  },
  getCalibration: () => { buckets, hit_rates, calibration_error },
  getState: () => {},
  shutdown: () => Promise<void>
}
```

---

## Tasks / Subtasks

- [x] **Task 1: Create strategy component structure** (AC: 6)
  - [x] Create `src/modules/strategy/components/probability/window-timing-model.js`
  - [x] Create `src/modules/strategy/components/probability/__tests__/window-timing-model.test.js`
  - [x] Follow component template pattern from `_template.js`
  - [x] Export metadata with name, version, type, description

- [x] **Task 2: Implement Black-Scholes N(d2) calculation** (AC: 1)
  - [x] Implement `calculateD2(S, K, T, sigma)` function
  - [x] Implement `normalCDF(x)` for standard normal distribution
  - [x] Calculate d2 = (ln(S/K) + (r - σ²/2)T) / (σ√T)
  - [x] Return P(UP) = N(d2), P(DOWN) = 1 - P(UP)
  - [x] Handle edge cases: T→0, S=K, sigma→0

- [x] **Task 3: Implement realized volatility calculation** (AC: 2)
  - [x] Create `calculateRealizedVolatility(symbol, lookbackMs)` function
  - [x] Query oracle price history from `oracle_updates` table
  - [x] Calculate log returns: ln(price_t / price_t-1)
  - [x] Calculate standard deviation of returns
  - [x] Annualize: σ_annual = σ_period * √(periods_per_year)
  - [x] Cache volatility for performance (recalculate every 60s)

- [x] **Task 4: Implement per-asset volatility tracking** (AC: 2)
  - [x] Track volatility separately for BTC, ETH, SOL, XRP
  - [x] Use configurable lookback periods (default 6 hours)
  - [x] Expose via `getVolatility(symbol)` method
  - [x] Handle insufficient data gracefully (use fallback/default)

- [x] **Task 5: Implement volatility surprise detection** (AC: 3)
  - [x] Calculate short-term vol (15 min lookback)
  - [x] Calculate long-term vol (6 hour lookback)
  - [x] Detect surprise when ratio > threshold (default 1.5 or < 0.67)
  - [x] Set `vol_surprise` flag in calculation result
  - [x] Log vol surprise events with full context

- [x] **Task 6: Create database migration for calibration** (AC: 4, 5)
  - [x] Create migration `009-calibration-tracking-table.js`
  - [x] Create `probability_predictions` table:
    ```sql
    CREATE TABLE probability_predictions (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        window_id TEXT NOT NULL,
        predicted_p_up REAL NOT NULL,
        bucket TEXT NOT NULL,
        oracle_price_at_prediction REAL,
        strike REAL,
        time_to_expiry_ms INTEGER,
        sigma_used REAL,
        actual_outcome TEXT,  -- 'up' or 'down', NULL until settled
        prediction_correct INTEGER,  -- 1 or 0, NULL until settled
        settled_at TEXT
    );
    ```
  - [x] Create indexes on timestamp, symbol, bucket, window_id

- [x] **Task 7: Implement calibration tracking** (AC: 4)
  - [x] Log predictions to `probability_predictions` table
  - [x] Bucket predictions: 50-60%, 60-70%, 70-80%, 80-90%, 90-100%
  - [x] Track actual outcomes when windows settle
  - [x] Calculate hit rates per bucket
  - [x] Expose via `getCalibration()` method

- [x] **Task 8: Implement calibration alerting** (AC: 5)
  - [x] Monitor calibration error per bucket
  - [x] Alert when error > 15% over 100+ predictions
  - [x] Log alert with bucket, predicted_rate, actual_rate, sample_size
  - [x] Expose alert status in getState()

- [x] **Task 9: Implement standard module interface** (AC: 6)
  - [x] Export `init(config)` - setup volatility cache, subscribe to oracle tracker
  - [x] Export `calculateProbability(oraclePrice, strike, timeToExpiryMs, symbol)` - main function
  - [x] Export `getCalibration()` - return calibration stats
  - [x] Export `getVolatility(symbol)` - return current volatility estimate
  - [x] Export `getState()` - return full module state
  - [x] Export `shutdown()` - cleanup

- [x] **Task 10: Write comprehensive tests** (AC: 1-6)
  - [x] Unit tests for Black-Scholes N(d2) against known values
  - [x] Unit tests for normal CDF accuracy
  - [x] Unit tests for volatility calculation
  - [x] Unit tests for volatility annualization
  - [x] Unit tests for edge cases (T→0, S=K, etc.)
  - [x] Unit tests for vol surprise detection
  - [x] Unit tests for calibration bucket assignment
  - [x] Integration test with mock oracle data
  - [x] Calibration tracking persistence tests

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/strategy/components/probability/window-timing-model.js`

This is a **strategy component** (not a standalone module), following the component pattern from Epic 6.

**File Structure:**
```
src/modules/strategy/components/probability/
├── _template.js              # Template (existing)
├── window-timing-model.js    # NEW: Black-Scholes probability component
└── __tests__/
    └── window-timing-model.test.js  # NEW: Tests
```

**Component Metadata Pattern (MUST follow):**
```javascript
export const metadata = {
  name: 'window-timing-model',
  version: 1,
  type: 'probability',
  description: 'Black-Scholes N(d2) probability model using oracle price as settlement truth',
  author: 'BMAD',
  createdAt: '2026-02-01',
};
```

### Mathematical Implementation

**Black-Scholes N(d2) Formula:**
```javascript
function calculateD2(S, K, T, sigma, r = 0) {
  // S = oracle price (spot at settlement)
  // K = strike (0.50 midpoint for binary resolution)
  // T = time to expiry in YEARS (convert from ms)
  // sigma = annualized volatility
  // r = risk-free rate (0 for short windows)

  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  return d2;
}

function normalCDF(x) {
  // Approximation of standard normal CDF
  // Abramowitz and Stegun approximation
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function calculateProbability(oraclePrice, strike, timeToExpiryMs, sigma) {
  // Convert time to years
  const T = timeToExpiryMs / (365.25 * 24 * 60 * 60 * 1000);

  // Edge case: T → 0 (at expiry)
  if (T <= 0 || timeToExpiryMs <= 0) {
    return {
      p_up: oraclePrice > strike ? 1.0 : (oraclePrice < strike ? 0.0 : 0.5),
      p_down: oraclePrice < strike ? 1.0 : (oraclePrice > strike ? 0.0 : 0.5),
      d2: oraclePrice > strike ? Infinity : (oraclePrice < strike ? -Infinity : 0),
      sigma_used: sigma,
      inputs: { S: oraclePrice, K: strike, T_years: 0, T_ms: timeToExpiryMs },
    };
  }

  const d2 = calculateD2(oraclePrice, strike, T, sigma);
  const p_up = normalCDF(d2);

  return {
    p_up: p_up,
    p_down: 1 - p_up,
    d2: d2,
    sigma_used: sigma,
    inputs: { S: oraclePrice, K: strike, T_years: T, T_ms: timeToExpiryMs },
  };
}
```

### Realized Volatility Calculation

**From Oracle Price History:**
```javascript
async function calculateRealizedVolatility(symbol, lookbackMs = 6 * 60 * 60 * 1000) {
  // Query oracle updates from last N hours
  const updates = persistence.all(
    `SELECT price, timestamp FROM oracle_updates
     WHERE symbol = ? AND timestamp > datetime('now', '-' || ? || ' seconds')
     ORDER BY timestamp ASC`,
    [symbol, Math.floor(lookbackMs / 1000)]
  );

  if (updates.length < 2) {
    return null; // Insufficient data
  }

  // Calculate log returns
  const logReturns = [];
  for (let i = 1; i < updates.length; i++) {
    const prevPrice = updates[i - 1].price;
    const currPrice = updates[i].price;
    if (prevPrice > 0) {
      logReturns.push(Math.log(currPrice / prevPrice));
    }
  }

  if (logReturns.length < 2) {
    return null;
  }

  // Calculate standard deviation
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize (assuming updates roughly every ~12 seconds = ~2.5M periods/year)
  const avgIntervalMs = lookbackMs / logReturns.length;
  const periodsPerYear = (365.25 * 24 * 60 * 60 * 1000) / avgIntervalMs;
  const annualizedVol = stdDev * Math.sqrt(periodsPerYear);

  return annualizedVol;
}
```

### Volatility Surprise Detection

```javascript
function detectVolatilitySurprise(shortTermVol, longTermVol) {
  if (!shortTermVol || !longTermVol || longTermVol === 0) {
    return { isSuprise: false, ratio: null };
  }

  const ratio = shortTermVol / longTermVol;
  const isSuprise = ratio > 1.5 || ratio < 0.67;

  return {
    isSurprise: isSuprise,
    ratio: ratio,
    shortTermVol: shortTermVol,
    longTermVol: longTermVol,
  };
}
```

### Calibration Bucket Assignment

```javascript
function assignBucket(p_up) {
  // Buckets: 50-60%, 60-70%, 70-80%, 80-90%, 90-100%
  // Also handle the lower half: 0-10%, 10-20%, 20-30%, 30-40%, 40-50%

  const buckets = [
    { name: '0-10%', min: 0.0, max: 0.1 },
    { name: '10-20%', min: 0.1, max: 0.2 },
    { name: '20-30%', min: 0.2, max: 0.3 },
    { name: '30-40%', min: 0.3, max: 0.4 },
    { name: '40-50%', min: 0.4, max: 0.5 },
    { name: '50-60%', min: 0.5, max: 0.6 },
    { name: '60-70%', min: 0.6, max: 0.7 },
    { name: '70-80%', min: 0.7, max: 0.8 },
    { name: '80-90%', min: 0.8, max: 0.9 },
    { name: '90-100%', min: 0.9, max: 1.0 },
  ];

  for (const bucket of buckets) {
    if (p_up >= bucket.min && p_up < bucket.max) {
      return bucket.name;
    }
  }
  return p_up >= 1.0 ? '90-100%' : '0-10%';
}
```

### Configuration Schema

```javascript
// config/default.js additions
{
  windowTimingModel: {
    volatility: {
      shortTermLookbackMs: 15 * 60 * 1000,    // 15 minutes
      longTermLookbackMs: 6 * 60 * 60 * 1000, // 6 hours
      cacheExpiryMs: 60 * 1000,               // Recalculate every 60s
      surpriseThresholdHigh: 1.5,             // Vol ratio > 1.5 = surprise
      surpriseThresholdLow: 0.67,             // Vol ratio < 0.67 = surprise
      fallbackVol: 0.5,                       // Default vol if insufficient data
    },
    calibration: {
      alertThreshold: 0.15,                   // 15% calibration error
      minSampleSize: 100,                     // Min predictions before alerting
    },
    riskFreeRate: 0,                          // Negligible for short windows
  }
}
```

### Database Schema for Calibration

**Migration: 009-calibration-tracking-table.js**
```javascript
export async function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probability_predictions (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        window_id TEXT NOT NULL,
        predicted_p_up REAL NOT NULL,
        bucket TEXT NOT NULL,
        oracle_price_at_prediction REAL,
        strike REAL,
        time_to_expiry_ms INTEGER,
        sigma_used REAL,
        vol_surprise INTEGER DEFAULT 0,
        actual_outcome TEXT,
        prediction_correct INTEGER,
        settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_prob_pred_timestamp ON probability_predictions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_symbol ON probability_predictions(symbol);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket ON probability_predictions(bucket);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_window ON probability_predictions(window_id);
  `);
}

export async function down(db) {
  db.exec('DROP TABLE IF EXISTS probability_predictions');
}
```

### Integration with Oracle Tracker

**CRITICAL:** This component uses ORACLE prices (from Story 7-1 RTDS client and Story 7-4 oracle tracker), NOT UI prices:

```javascript
import * as oracleTracker from '../../../oracle-tracker/index.js';

// Get current oracle price for a symbol
function getOraclePrice(symbol) {
  const state = oracleTracker.getState();
  return state.tracking[symbol]?.last_price || null;
}

// Use oracle price history for volatility
async function getVolatilityFromOracle(symbol) {
  // oracle_updates table has oracle price history
  return calculateRealizedVolatility(symbol, config.longTermLookbackMs);
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    volatility: {
      btc: { current: 0.45, lastCalculated: '2026-02-01T12:00:00Z', dataPoints: 1500 },
      eth: { current: 0.52, lastCalculated: '2026-02-01T12:00:00Z', dataPoints: 1400 },
      sol: { current: 0.68, lastCalculated: '2026-02-01T12:00:00Z', dataPoints: 1300 },
      xrp: { current: 0.42, lastCalculated: '2026-02-01T12:00:00Z', dataPoints: 1200 },
    },
    calibration: {
      total_predictions: 523,
      buckets: {
        '50-60%': { count: 150, hits: 85, hit_rate: 0.567, error: 0.017 },
        '60-70%': { count: 120, hits: 79, hit_rate: 0.658, error: 0.008 },
        '70-80%': { count: 100, hits: 73, hit_rate: 0.73, error: 0.02 },
        '80-90%': { count: 85, hits: 72, hit_rate: 0.847, error: 0.003 },
        '90-100%': { count: 68, hits: 64, hit_rate: 0.941, error: 0.009 },
      },
      alerts: [],
    },
    config: { /* ... */ },
  };
}
```

### Logging Requirements

```javascript
log.info('probability_calculated', {
  symbol, p_up: 0.72, p_down: 0.28, d2: 0.58, sigma: 0.45,
  inputs: { S: 95000, K: 94500, T_ms: 300000 }
});

log.info('volatility_calculated', {
  symbol, sigma: 0.45, lookback_ms: 21600000, data_points: 1500
});

log.warn('vol_surprise_detected', {
  symbol, short_term: 0.68, long_term: 0.42, ratio: 1.62
});

log.warn('calibration_alert', {
  bucket: '70-80%', predicted_midpoint: 0.75, actual_hit_rate: 0.58,
  error: 0.17, sample_size: 120
});

log.info('prediction_logged', {
  window_id, symbol, p_up: 0.72, bucket: '70-80%'
});
```

### Testing Strategy

1. **Black-Scholes Unit Tests:**
   - d2 calculation matches manual computation
   - normalCDF matches known values (N(0)=0.5, N(1)≈0.8413, N(-1)≈0.1587)
   - P(UP) = 0.5 when S = K and T > 0
   - P(UP) → 1 when S >> K
   - P(UP) → 0 when S << K
   - Edge case: T = 0 returns deterministic result

2. **Volatility Unit Tests:**
   - Annualization formula correct
   - Empty data returns null
   - Single data point returns null
   - Stable prices return near-zero vol

3. **Integration Tests:**
   - Component initializes with oracle tracker
   - Predictions logged to database
   - Calibration stats accumulate correctly

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/persistence/` - for database access
- `src/modules/oracle-tracker/` - for oracle price history (Story 7-4)

**No new npm packages required.**

### Previous Story Intelligence (7-1 through 7-4)

**Key Learnings from Story 7-4 (Oracle Tracker):**
1. Oracle updates table (`oracle_updates`) provides price history for volatility calculation
2. Use `SUPPORTED_SYMBOLS` from `rtds/types.js` for symbol validation
3. Module pattern: init(config), getState(), shutdown()
4. Use child logger: `log = child({ module: 'window-timing-model' })`
5. Buffer and batch inserts for prediction logging
6. Handle edge cases (empty data, insufficient history)

**Code Review Findings to Apply:**
- Validate all inputs before calculation
- Handle division by zero (T=0, sigma=0)
- Use defensive null checks for oracle prices
- Cache volatility calculations for performance
- Test with edge cases explicitly

### Project Structure Notes

- This is a **strategy component** (type: probability), not a standalone module
- Location: `src/modules/strategy/components/probability/`
- Follows Epic 6 component pattern for strategy composition
- Will be registered with strategy registry for use in composed strategies
- Story 7-12 (Strategy Composition Integration) will wire this into registry

### Relationship to Other Stories

**Depends on:**
- Story 7-1 (RTDS Client) - provides oracle price feed
- Story 7-4 (Oracle Pattern Tracker) - provides oracle price history table

**Used by:**
- Story 7-7 (Oracle Edge Signal Generator) - can use probability for signal confidence
- Story 7-12 (Strategy Composition Integration) - registers component in strategy registry

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-10]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Strategy Composition]
- [Source: _bmad-output/strategies/component-07-window-timing-model.md - Full mathematical specification]
- [Source: _bmad-output/implementation-artifacts/7-4-oracle-update-pattern-tracker.md - Oracle tracker patterns]
- [Source: src/modules/strategy/components/probability/_template.js - Component template]
- [Source: src/modules/oracle-tracker/index.js - Module pattern reference]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Test run: 64 tests passing in window-timing-model.test.js
- Full regression: 2024 tests passing across 64 test files

### Completion Notes List

1. **Task 1-9 (Component Implementation):** Created complete window-timing-model strategy component with:
   - Black-Scholes N(d2) probability calculation using Abramowitz-Stegun normal CDF approximation
   - Realized volatility calculation from oracle_updates table with configurable lookback
   - Per-asset (BTC, ETH, SOL, XRP) volatility tracking with 60s cache
   - Volatility surprise detection comparing 15min vs 6hr volatility
   - Calibration tracking with 10 probability buckets (0-10% through 90-100%)
   - Calibration alerting when error > 15% over 100+ predictions
   - Standard module interface: init, evaluate, validateConfig, getState, shutdown
   - Full error handling with WindowTimingModelError class

2. **Task 6 (Migration):** Created migration 009-calibration-tracking-table.js with:
   - probability_predictions table with all required columns
   - Indexes on timestamp, symbol, bucket, window_id
   - Compound index for calibration queries (bucket, actual_outcome)

3. **Task 10 (Tests):** Comprehensive test suite with 64 tests covering:
   - normalCDF accuracy against known statistical values
   - calculateD2 behavior including edge cases (T=0, sigma=0, S=K)
   - Bucket assignment logic for all 10 probability ranges
   - Module lifecycle (init, getState, shutdown)
   - Probability calculation with various inputs
   - Volatility calculation from price history
   - Calibration logging, outcome recording, and statistics
   - Standard component interface (evaluate, validateConfig)

### File List

**New files:**
- src/modules/strategy/components/probability/window-timing-model.js
- src/modules/strategy/components/probability/__tests__/window-timing-model.test.js
- src/persistence/migrations/009-calibration-tracking-table.js

**Modified files:**
- _bmad-output/implementation-artifacts/sprint-status.yaml (status update)
- _bmad-output/implementation-artifacts/7-10-window-timing-model.md (this file)

### Change Log

- 2026-02-01: Story 7-10 implementation complete. Created window-timing-model probability component with Black-Scholes N(d2), volatility tracking, and calibration system. All 64 tests pass. Full regression suite (2024 tests) passes.
