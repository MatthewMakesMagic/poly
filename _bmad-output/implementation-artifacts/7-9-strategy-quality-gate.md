# Story 7.9: Strategy Quality Gate

Status: review

---

## Story

As a **trader**,
I want **automatic disabling of strategies when signal quality degrades**,
So that **I don't keep trading a broken strategy**.

---

## Acceptance Criteria

### AC1: Rolling Accuracy Calculation
**Given** signal outcomes are tracked (via signal-outcome-logger)
**When** evaluating strategy quality
**Then** rolling accuracy is calculated over last N signals (default: 20)
**And** accuracy by bucket is tracked (time_remaining, staleness, spread_size)

### AC2: Accuracy Threshold Enforcement
**Given** accuracy drops below threshold
**When** accuracy < min_accuracy (default: 40%) over rolling window
**Then** strategy is auto-disabled
**And** alert is logged: "Strategy quality gate triggered - accuracy X% below threshold"
**And** no new signals are generated until manually re-enabled

### AC3: Feed Health Detection
**Given** other quality issues are detected
**When** any of the following occur:
- Oracle feed unavailable > 10 seconds
- Update pattern appears to have changed (statistical test)
- Spread behavior changes significantly
**Then** strategy is disabled
**And** specific reason is logged

### AC4: Manual Re-Enable Required
**Given** strategy is disabled (by quality gate)
**When** user wants to re-enable
**Then** manual intervention required (CLI command or config change)
**And** re-enable is logged with reason

### AC5: Distinct from Kill Switch
**Note:** This is distinct from Epic 4's kill switch. Epic 4 = emergency halt all trading. This = disable specific strategy due to quality issues.

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1-4)
  - [x] Create `src/modules/quality-gate/` folder
  - [x] Create `index.js` (public interface: init, evaluate, isDisabled, disable, enable, getState, shutdown)
  - [x] Create `evaluator.js` (QualityGateEvaluator class with core logic)
  - [x] Create `types.js` (QualityGateError, error codes, constants, DisableReason enum)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Implement rolling accuracy calculation** (AC: 1)
  - [x] Create `calculateRollingAccuracy(windowSize)` method in evaluator
  - [x] Query last N signals from oracle_edge_signals table (signal_correct IS NOT NULL)
  - [x] Calculate: win_rate = SUM(signal_correct) / COUNT(*)
  - [x] Handle case where fewer than windowSize signals exist (use available)
  - [x] Handle case where no signals with outcomes exist (skip evaluation)

- [x] **Task 3: Implement accuracy by bucket tracking** (AC: 1)
  - [x] Create `calculateBucketedAccuracy()` method
  - [x] Track accuracy by time_to_expiry buckets (0-10s, 10-20s, 20-30s)
  - [x] Track accuracy by staleness buckets (15-30s, 30-60s, 60s+)
  - [x] Track accuracy by spread buckets (0-0.1%, 0.1-0.3%, 0.3%+)
  - [x] Return object: `{ overall, by_time, by_staleness, by_spread }`

- [x] **Task 4: Implement threshold enforcement** (AC: 2)
  - [x] Create `checkAccuracyThreshold(rollingAccuracy, minAccuracy)` method
  - [x] Compare rolling accuracy to min_accuracy threshold (default 0.40)
  - [x] Return `{ breached: boolean, accuracy, threshold, deficit }`
  - [x] If breached, call `disableStrategy(DisableReason.ACCURACY_BELOW_THRESHOLD)`

- [x] **Task 5: Implement feed health monitoring** (AC: 3)
  - [x] Create `checkFeedHealth()` method
  - [x] Subscribe to RTDS client (get feed availability status)
  - [x] Track time since last oracle feed tick
  - [x] If > feedUnavailableThresholdMs (default: 10000ms), trigger disable
  - [x] Log specific reason: "Oracle feed unavailable for X seconds"

- [x] **Task 6: Implement pattern change detection** (AC: 3)
  - [x] Create `checkPatternChange()` method
  - [x] Calculate recent update frequency (last 1 hour) vs historical (last 24 hours)
  - [x] If ratio > patternChangeThreshold (default: 2.0x), trigger warning
  - [x] Calculate recent spread behavior vs historical
  - [x] If significantly different (>2 std dev), trigger disable
  - [x] Log specific reason: "Update pattern change detected" or "Spread behavior change detected"

- [x] **Task 7: Implement strategy disable/enable** (AC: 2, 3, 4)
  - [x] Create `disableStrategy(reason, context)` method
  - [x] Set internal `disabled = true` flag
  - [x] Set `disabledAt` timestamp
  - [x] Set `disableReason` with DisableReason enum value
  - [x] Log alert: `quality_gate_triggered { reason, accuracy, threshold, context }`
  - [x] Emit event for orchestrator/signal-generator to stop producing signals

- [x] **Task 8: Implement manual re-enable** (AC: 4)
  - [x] Create `enableStrategy(userReason)` method
  - [x] Require `userReason` parameter (why user believes it's safe to re-enable)
  - [x] Clear `disabled` flag and `disableReason`
  - [x] Set `enabledAt` timestamp
  - [x] Log: `quality_gate_reenabled { userReason, previousDisableReason, disabledDuration }`
  - [x] Reset rolling window counters (fresh start)

- [x] **Task 9: Implement periodic evaluation** (AC: 1-3)
  - [x] Create `startPeriodicEvaluation(intervalMs)` method
  - [x] Default interval: 60000ms (1 minute)
  - [x] On each tick:
    1. Calculate rolling accuracy
    2. Check accuracy threshold
    3. Check feed health
    4. Check pattern changes (every 5th tick to reduce overhead)
  - [x] Stop evaluation when disabled (no need to keep checking)

- [x] **Task 10: Implement module interface** (AC: 1-4)
  - [x] Export `init(config)` - setup, start periodic evaluation
  - [x] Export `evaluate()` - force immediate evaluation
  - [x] Export `isDisabled()` - returns boolean
  - [x] Export `disable(reason, context)` - manual disable (for orchestrator use)
  - [x] Export `enable(userReason)` - manual enable
  - [x] Export `getState()` - full quality gate state
  - [x] Export `shutdown()` - stop periodic evaluation, cleanup

- [x] **Task 11: Integrate with oracle-edge-signal** (AC: 2)
  - [x] On init, subscribe to oracle-edge-signal module (if available)
  - [x] Before signal is generated, check `isDisabled()`
  - [x] If disabled, signal generation is skipped (handled by signal generator)
  - [x] Alternatively: export `shouldAllowSignal()` for signal generator to call

- [x] **Task 12: Write comprehensive tests** (AC: 1-4)
  - [x] Unit tests for rolling accuracy calculation
  - [x] Unit tests for bucketed accuracy
  - [x] Unit tests for threshold enforcement
  - [x] Unit tests for feed health detection
  - [x] Unit tests for pattern change detection
  - [x] Unit tests for disable/enable flow
  - [x] Integration tests with mock signal-outcome-logger
  - [x] Integration tests for periodic evaluation
  - [x] Test re-enable after manual intervention

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/quality-gate/`

**File Structure (per architecture.md):**
```
src/modules/quality-gate/
├── index.js          # Public interface (init, evaluate, isDisabled, disable, enable, getState, shutdown)
├── evaluator.js      # QualityGateEvaluator class with core logic
├── types.js          # QualityGateError, error codes, DisableReason enum
└── __tests__/
    ├── index.test.js
    ├── evaluator.test.js
    └── integration.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export async function evaluate() {}           // Force immediate evaluation
export function isDisabled() {}                // Check if quality gate triggered
export function disable(reason, context) {}    // Manual disable
export function enable(userReason) {}          // Manual re-enable
export function shouldAllowSignal() {}         // For signal generator integration
export function getState() {}
export async function shutdown() {}
export { QualityGateError, QualityGateErrorCodes, DisableReason };
```

### Error Pattern (per architecture.md)

```javascript
import { PolyError } from '../../types/errors.js';

export class QualityGateError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'QualityGateError';
  }
}

export const QualityGateErrorCodes = {
  NOT_INITIALIZED: 'QUALITY_GATE_NOT_INITIALIZED',
  INVALID_CONFIG: 'QUALITY_GATE_INVALID_CONFIG',
  SIGNAL_LOGGER_UNAVAILABLE: 'QUALITY_GATE_SIGNAL_LOGGER_UNAVAILABLE',
  EVALUATION_ERROR: 'QUALITY_GATE_EVALUATION_ERROR',
  ALREADY_DISABLED: 'QUALITY_GATE_ALREADY_DISABLED',
  NOT_DISABLED: 'QUALITY_GATE_NOT_DISABLED',
};

export const DisableReason = {
  ACCURACY_BELOW_THRESHOLD: 'accuracy_below_threshold',
  FEED_UNAVAILABLE: 'feed_unavailable',
  PATTERN_CHANGE_DETECTED: 'pattern_change_detected',
  SPREAD_BEHAVIOR_CHANGE: 'spread_behavior_change',
  MANUAL: 'manual',
};
```

### Configuration Schema

```javascript
// config/default.js additions
{
  qualityGate: {
    enabled: true,                        // Enable/disable quality gate
    evaluationIntervalMs: 60000,          // Evaluate every 1 minute
    rollingWindowSize: 20,                // Last N signals for rolling accuracy
    minAccuracyThreshold: 0.40,           // 40% minimum accuracy
    feedUnavailableThresholdMs: 10000,    // 10 seconds feed unavailable
    patternChangeThreshold: 2.0,          // 2x change in update frequency
    spreadBehaviorStdDev: 2.0,            // 2 std dev for spread behavior change
    patternCheckFrequency: 5,             // Check patterns every 5th evaluation
  }
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    disabled: false,
    disabledAt: null,
    disableReason: null,
    disableContext: null,
    lastEvaluation: {
      timestamp: '2026-02-01T12:30:00.000Z',
      rollingAccuracy: 0.55,
      signalsInWindow: 20,
      bucketedAccuracy: {
        by_time: { '0-10s': 0.60, '10-20s': 0.52, '20-30s': 0.48 },
        by_staleness: { '15-30s': 0.58, '30-60s': 0.52, '60s+': 0.45 },
        by_spread: { '0-0.1%': 0.55, '0.1-0.3%': 0.56, '0.3%+': 0.40 },
      },
      feedHealth: {
        oracleAvailable: true,
        lastOracleTickAgeMs: 1200,
      },
      patternHealth: {
        updateFrequencyRatio: 1.1,
        spreadBehaviorZScore: 0.5,
      },
    },
    evaluationCount: 42,
    config: { ... },
  };
}
```

### Database Queries (using signal-outcome-logger data)

**Rolling Accuracy Query:**
```javascript
// Uses oracle_edge_signals table from Story 7-8
const rollingAccuracy = await db.get(`
  SELECT
    COUNT(*) as total,
    SUM(signal_correct) as wins,
    CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
  FROM (
    SELECT signal_correct
    FROM oracle_edge_signals
    WHERE settlement_outcome IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ?
  )
`, [windowSize]);
```

**Accuracy by Time Bucket:**
```javascript
const byTimeBucket = await db.all(`
  SELECT
    CASE
      WHEN time_to_expiry_ms <= 10000 THEN '0-10s'
      WHEN time_to_expiry_ms <= 20000 THEN '10-20s'
      ELSE '20-30s'
    END as bucket,
    COUNT(*) as signals,
    SUM(signal_correct) as wins,
    CAST(SUM(signal_correct) AS REAL) / COUNT(*) as accuracy
  FROM (
    SELECT time_to_expiry_ms, signal_correct
    FROM oracle_edge_signals
    WHERE settlement_outcome IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ?
  )
  GROUP BY bucket
`, [windowSize]);
```

### Signal Generator Integration

The quality gate should integrate with oracle-edge-signal module to prevent signal generation when disabled. Two approaches:

**Approach A: Quality Gate Exports Check Function**
```javascript
// In oracle-edge-signal/generator.js
import * as qualityGate from '../quality-gate/index.js';

function generateSignal(marketState) {
  // Check quality gate before generating
  if (!qualityGate.shouldAllowSignal()) {
    log.debug('signal_blocked_by_quality_gate');
    return null;
  }

  // ... rest of signal generation logic
}
```

**Approach B: Quality Gate Subscribes and Intercepts**
```javascript
// Quality gate subscribes to signal generator
// Intercepts and blocks signals when disabled
// More complex, less transparent
```

**Recommended: Approach A** - simpler, more explicit, signal generator is aware of quality gate.

### Feed Health Integration

The quality gate needs to know when the RTDS oracle feed is unavailable:

```javascript
// Subscribe to RTDS client state
let rtdsClient = null;
let lastOracleTickTime = Date.now();

async function loadRtdsClient() {
  try {
    rtdsClient = await import('../rtds/index.js');
    rtdsClient.subscribe('crypto_prices_chainlink', (tick) => {
      lastOracleTickTime = Date.now();
    });
  } catch (err) {
    log.warn('rtds_client_unavailable', { error: err.message });
  }
}

function checkFeedHealth() {
  const ageMs = Date.now() - lastOracleTickTime;
  if (ageMs > config.feedUnavailableThresholdMs) {
    return { healthy: false, ageMs, reason: 'feed_unavailable' };
  }
  return { healthy: true, ageMs };
}
```

### Pattern Change Detection

Use oracle_updates table (from Story 7-4) for pattern analysis:

```javascript
// Recent update frequency (last hour)
const recentStats = await db.get(`
  SELECT COUNT(*) as count, AVG(time_since_previous_ms) as avg_interval
  FROM oracle_updates
  WHERE timestamp > datetime('now', '-1 hour')
  AND symbol = ?
`, [symbol]);

// Historical update frequency (last 24 hours excluding recent)
const historicalStats = await db.get(`
  SELECT COUNT(*) as count, AVG(time_since_previous_ms) as avg_interval
  FROM oracle_updates
  WHERE timestamp > datetime('now', '-24 hour')
  AND timestamp < datetime('now', '-1 hour')
  AND symbol = ?
`, [symbol]);

// Calculate ratio
const frequencyRatio = (recentStats.count / 1) / (historicalStats.count / 23);
```

### Logging Requirements

All logs MUST use structured format with required fields:
```javascript
log.info('quality_gate_initialized', {
  config: { evaluationIntervalMs, rollingWindowSize, minAccuracyThreshold }
});

log.info('quality_gate_evaluation', {
  rollingAccuracy: 0.55,
  signalsInWindow: 20,
  thresholdBreached: false,
  feedHealthy: true,
});

log.warn('quality_gate_triggered', {
  reason: DisableReason.ACCURACY_BELOW_THRESHOLD,
  accuracy: 0.35,
  threshold: 0.40,
  signalsInWindow: 20,
  context: { bucketedAccuracy: { ... } },
});

log.info('quality_gate_reenabled', {
  userReason: 'Manual re-enable after market stabilized',
  previousDisableReason: DisableReason.ACCURACY_BELOW_THRESHOLD,
  disabledDurationMs: 3600000,
});
```

### Testing Strategy

1. **Unit Tests (evaluator.test.js):**
   - calculateRollingAccuracy returns correct value with various signal counts
   - calculateRollingAccuracy handles < windowSize signals correctly
   - calculateRollingAccuracy handles zero signals correctly
   - calculateBucketedAccuracy groups correctly by each dimension
   - checkAccuracyThreshold correctly detects breach
   - checkFeedHealth detects unavailable feed
   - disableStrategy sets correct state
   - enableStrategy clears state and logs correctly

2. **Unit Tests (index.test.js):**
   - Init starts periodic evaluation
   - evaluate() triggers immediate check
   - isDisabled() returns correct state
   - disable() manually disables with reason
   - enable() requires userReason
   - getState() returns complete state
   - shutdown() stops periodic evaluation

3. **Integration Tests (integration.test.js):**
   - End-to-end: signal outcomes accumulate → accuracy drops → gate triggers
   - Verify disable prevents signal generation (via shouldAllowSignal)
   - Test re-enable flow with user reason
   - Test feed health detection (mock RTDS unavailable)
   - Test pattern change detection (insert unusual oracle_updates)

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/modules/signal-outcome-logger/` - for reading signal outcomes
- `src/persistence/` - database access for queries
- `src/types/errors.js` - for PolyError base class

**Optional internal modules (graceful failure):**
- `src/clients/rtds/` - for feed health monitoring
- `src/modules/oracle-tracker/` - for pattern change data

**No new npm packages required.**

### Previous Story Intelligence (from 7-8)

**Key Learnings from Story 7-8 (Signal Outcome Logger):**
1. Oracle edge signals are logged to `oracle_edge_signals` table with complete state
2. Settlement updates `signal_correct` (1 = correct, 0 = incorrect) and `pnl`
3. `getStats()` returns overall win_rate, total_pnl, avg_confidence
4. `getStatsByBucket(bucketType)` returns breakdown by time/staleness/confidence/symbol
5. `getRecentSignals(limit)` returns recent signals with outcomes
6. Module uses dynamic imports with try/catch for optional dependencies

**Code Review Findings to Apply:**
- Validate all inputs before database operations
- Handle missing/null fields gracefully
- Use defensive null checks for optional data
- Rate limit warning logs
- Use transactions for multi-step database operations

### Previous Story Files and Patterns

**Files created in Story 7-8:**
- `src/modules/signal-outcome-logger/index.js` - Reference for module interface pattern
- `src/modules/signal-outcome-logger/logger.js` - Reference for class-based implementation
- `src/modules/signal-outcome-logger/types.js` - Reference for error/enum patterns

**Pattern from 7-8 to follow:**
```javascript
// Module state pattern
let log = null;
let initialized = false;
let evaluator = null;
let config = null;

// Optional module references (loaded dynamically)
let signalOutcomeLoggerModule = null;

export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'quality-gate' });
  log.info('module_init_start');

  // Extract module-specific config
  const qualityGateConfig = cfg.qualityGate || {};
  config = { /* merge with defaults */ };

  // Load optional dependencies
  await loadDependencies();

  // Create evaluator instance
  evaluator = new QualityGateEvaluator({ config, logger: log, db: database });

  // Start periodic evaluation
  if (config.enabled) {
    evaluator.startPeriodicEvaluation(config.evaluationIntervalMs);
  }

  initialized = true;
  log.info('quality_gate_initialized', { config: { ... } });
}
```

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- This module is a SAFETY/QUALITY module - auto-disables poor strategies
- Consumes data from signal-outcome-logger (7-8)
- Distinct from kill-switch (Epic 4) - this is strategy-level, not system-level
- Should integrate with oracle-edge-signal (7-7) to block signals when disabled

### Relationship to Other Stories

**Depends on:**
- Story 7-8 (Signal Outcome Logger) - provides signal outcome data for accuracy calculation
- Story 7-1 (RTDS WebSocket Client) - for feed health monitoring (optional)
- Story 7-4 (Oracle Update Pattern Tracker) - for pattern change detection (optional)

**Used by:**
- Story 7-12 (Strategy Composition Integration) - quality gate as part of composed strategy
- Orchestrator - to check if strategy should be active

### The Quality Gate Philosophy

**Purpose:**
> We generate signals, track outcomes, and measure accuracy. If accuracy drops below threshold, we automatically stop trading that strategy. Better to preserve capital than trade a broken strategy.

**Key Principles:**
1. **Data-Driven Disabling:** Only disable based on measured outcomes, not hunches
2. **Manual Re-Enable:** Require human judgment to restart - prevents auto-thrashing
3. **Multiple Detection Methods:** Accuracy, feed health, pattern changes
4. **Distinct from Kill Switch:** Kill switch = emergency stop all. Quality gate = stop bad strategy.

**Expected Behavior:**
- Normal operation: Periodic evaluation every minute, no action needed
- Degraded accuracy: After 20+ signals with <40% accuracy, auto-disable
- Feed issues: After 10 seconds of no oracle ticks, auto-disable
- Re-enable: User must explicitly re-enable with reason

### Critical Implementation Notes

1. **Don't Evaluate Too Quickly:** Need sufficient signals (default 20) to make statistical judgment

2. **Grace Period on Startup:** Don't evaluate until enough signals accumulate

3. **Feed Health vs. Signal Accuracy:** Two separate checks - feed can be healthy but signals still bad

4. **Pattern Change is Informational:** Log and warn, but primary disable trigger is accuracy

5. **State Persistence:** Consider persisting disabled state across restarts (write to file or DB)

6. **Orchestrator Integration:** Orchestrator should call `shouldAllowSignal()` before delegating to signal generator

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-9]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/implementation-artifacts/7-8-signal-outcome-logger.md - Signal outcome data structure]
- [Source: src/modules/signal-outcome-logger/index.js - getStats, getStatsByBucket interfaces]
- [Source: src/modules/signal-outcome-logger/logger.js - Database query patterns]
- [Source: config/default.js - Config schema patterns]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass: 192 tests across 6 test files for quality-gate and oracle-edge-signal modules

### Completion Notes List

1. **Module Structure Created** - Implemented quality-gate module following established patterns from signal-outcome-logger
2. **Rolling Accuracy Calculation** - Queries oracle_edge_signals table for last N signals with outcomes
3. **Bucketed Accuracy** - Tracks accuracy by time_to_expiry, staleness, and spread buckets
4. **Threshold Enforcement** - Auto-disables strategy when accuracy falls below 40% threshold
5. **Feed Health Monitoring** - Tracks RTDS oracle feed availability, disables after 10s unavailable
6. **Pattern Change Detection** - Compares recent (1hr) vs historical (24hr) update patterns
7. **Disable/Enable Flow** - Proper state management with callbacks, timestamps, and reason tracking
8. **Manual Re-Enable** - Requires user reason to re-enable, resets evaluation counter
9. **Periodic Evaluation** - Runs every 60s, checks patterns every 5th evaluation
10. **Module Interface** - Standard init/evaluate/isDisabled/disable/enable/getState/shutdown exports
11. **Signal Generator Integration** - oracle-edge-signal/generator.js now checks shouldAllowSignal() before generating
12. **Comprehensive Tests** - 79 unit tests in evaluator.test.js, 68 in index.test.js, 11 integration tests

### File List

**New Files:**
- `src/modules/quality-gate/index.js` - Public module interface
- `src/modules/quality-gate/evaluator.js` - QualityGateEvaluator class with core logic
- `src/modules/quality-gate/types.js` - Error classes, error codes, DisableReason enum
- `src/modules/quality-gate/__tests__/evaluator.test.js` - Unit tests for evaluator
- `src/modules/quality-gate/__tests__/index.test.js` - Unit tests for module interface
- `src/modules/quality-gate/__tests__/integration.test.js` - Integration tests

**Modified Files:**
- `src/modules/oracle-edge-signal/generator.js` - Added quality gate integration (shouldAllowSignal check)
- `config/default.js` - Added qualityGate configuration section

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-01 | Story implemented with all tasks complete | Claude Opus 4.5 |

