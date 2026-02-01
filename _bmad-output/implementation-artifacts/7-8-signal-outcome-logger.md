# Story 7.8: Signal Outcome Logger

Status: review

---

## Story

As a **quant researcher**,
I want **every signal's outcome tracked against actual settlement**,
So that **I can measure whether the oracle edge hypothesis works**.

---

## Acceptance Criteria

### AC1: Log Complete Signal State at Generation Time
**Given** a signal is generated (from oracle-edge-signal module)
**When** logging the signal
**Then** complete state at signal time is recorded:
- timestamp, window_id, symbol
- time_to_expiry_ms, ui_price, oracle_price, oracle_staleness_ms
- strike, market_token_price
- signal_direction, confidence

### AC2: Update Signal Record on Window Settlement
**Given** window settles (at expiry time)
**When** settlement occurs
**Then** signal record is updated with:
- final_oracle_price (the Chainlink price at settlement)
- settlement_outcome (up or down)
- signal_correct (1 if our fade was right, 0 otherwise)
- pnl (calculated from entry price and settlement)

### AC3: Queryable Signal Performance Analytics
**Given** historical signals exist
**When** analyzing performance
**Then** I can query: accuracy by condition bucket, total P&L, win rate

---

## Tasks / Subtasks

- [x] **Task 1: Create module structure** (AC: 1, 2, 3)
  - [x] Create `src/modules/signal-outcome-logger/` folder
  - [x] Create `index.js` (public interface: init, logSignal, updateOutcome, getStats, getState, shutdown)
  - [x] Create `logger.js` (SignalOutcomeLogger class with core logic)
  - [x] Create `types.js` (SignalOutcomeLoggerError, error codes, constants)
  - [x] Create `__tests__/` folder

- [x] **Task 2: Create database migration** (AC: 1, 2, 3)
  - [x] Create migration `013-oracle-edge-signals-table.js`
  - [x] Schema per epic 7 specification:
    ```sql
    CREATE TABLE oracle_edge_signals (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        window_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        time_to_expiry_ms INTEGER,
        ui_price REAL,
        oracle_price REAL,
        oracle_staleness_ms INTEGER,
        strike REAL,
        market_token_price REAL,
        signal_direction TEXT,
        confidence REAL,
        token_id TEXT,
        side TEXT,
        final_oracle_price REAL,
        settlement_outcome TEXT,
        signal_correct INTEGER,
        entry_price REAL,
        exit_price REAL,
        pnl REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT
    );
    CREATE INDEX idx_oracle_edge_signals_window ON oracle_edge_signals(window_id);
    CREATE INDEX idx_oracle_edge_signals_symbol ON oracle_edge_signals(symbol);
    CREATE INDEX idx_oracle_edge_signals_timestamp ON oracle_edge_signals(timestamp);
    CREATE INDEX idx_oracle_edge_signals_outcome ON oracle_edge_signals(settlement_outcome);
    ```
  - [x] Register migration in `migrations/index.js`

- [x] **Task 3: Implement signal logging** (AC: 1)
  - [x] Create `logSignal(signal)` method in SignalOutcomeLogger
  - [x] Accept signal object from oracle-edge-signal module
  - [x] Extract all required fields from signal.inputs
  - [x] Insert row into oracle_edge_signals table
  - [x] Return inserted signal ID for tracking
  - [x] Handle duplicate window_id gracefully (upsert or skip)

- [x] **Task 4: Implement outcome update logic** (AC: 2)
  - [x] Create `updateOutcome(windowId, settlementData)` method
  - [x] settlementData contains: final_oracle_price, settlement_time
  - [x] Calculate settlement_outcome: 'up' if final > strike, 'down' otherwise
  - [x] Calculate signal_correct: 1 if our fade matched outcome, 0 otherwise
  - [x] Calculate pnl from entry_price and exit_price
  - [x] Update oracle_edge_signals row by window_id
  - [x] Set updated_at timestamp

- [x] **Task 5: Implement PnL calculation** (AC: 2)
  - [x] Create `calculatePnL(signalRecord, settlementData)` method
  - [x] If signal_correct: PnL = position_size × (1 - entry_price) - fees
  - [x] If signal incorrect: PnL = -position_size × entry_price
  - [x] For now, use market_token_price as entry_price proxy
  - [x] Add note for future: integrate with actual order fill prices

- [x] **Task 6: Implement analytics queries** (AC: 3)
  - [x] Create `getSignalStats()` method
    - Total signals, signals with outcomes, pending outcomes
    - Win rate (signal_correct = 1 / total with outcome)
    - Average confidence
    - Total PnL
  - [x] Create `getStatsByBucket(bucketType)` method
    - Bucket by: time_to_expiry (0-10s, 10-20s, 20-30s)
    - Bucket by: staleness (15-30s, 30-60s, 60s+)
    - Bucket by: confidence (0.5-0.6, 0.6-0.7, 0.7-0.8, 0.8+)
    - Bucket by: symbol (btc, eth, sol, xrp)
  - [x] Create `getRecentSignals(limit)` method
    - Return last N signals with outcomes

- [x] **Task 7: Subscribe to signal generator** (AC: 1)
  - [x] On init, subscribe to oracle-edge-signal module
  - [x] Auto-log signals as they are generated
  - [x] Handle subscription failure gracefully (log warning, continue)

- [x] **Task 8: Subscribe to window settlements** (AC: 2)
  - [x] On init, subscribe to window settlement events (from orchestrator/window-manager)
  - [x] For each settlement, check if we have a signal for that window_id
  - [x] If found, call updateOutcome with settlement data
  - [x] Handle missing signals gracefully (settlement for window we didn't signal on)

- [x] **Task 9: Implement module interface** (AC: 1-3)
  - [x] Export `init(config)` - setup database, subscribe to signals/settlements
  - [x] Export `logSignal(signal)` - manually log a signal
  - [x] Export `updateOutcome(windowId, settlementData)` - manually update outcome
  - [x] Export `getStats()` - get overall statistics
  - [x] Export `getStatsByBucket(bucketType)` - get stats by condition bucket
  - [x] Export `getRecentSignals(limit)` - get recent signals
  - [x] Export `getState()` - full module state
  - [x] Export `shutdown()` - cleanup subscriptions

- [x] **Task 10: Write comprehensive tests** (AC: 1-3)
  - [x] Unit tests for signal logging (correct field extraction)
  - [x] Unit tests for outcome calculation (signal_correct, pnl)
  - [x] Unit tests for bucket statistics
  - [x] Integration tests with mock database
  - [x] Integration tests with mock signal generator
  - [x] Test duplicate window_id handling
  - [x] Test missing settlement data handling

---

## Dev Notes

### Architecture Compliance

**Module Location:** `src/modules/signal-outcome-logger/`

**File Structure (per architecture.md):**
```
src/modules/signal-outcome-logger/
├── index.js          # Public interface (init, logSignal, updateOutcome, getStats, getState, shutdown)
├── logger.js         # SignalOutcomeLogger class with core logic
├── types.js          # SignalOutcomeLoggerError, error codes
└── __tests__/
    ├── index.test.js
    ├── logger.test.js
    └── integration.test.js
```

**Module Interface Contract (MUST follow):**
```javascript
// index.js exports
export async function init(config) {}
export async function logSignal(signal) {}      // Log signal at generation
export async function updateOutcome(windowId, settlementData) {}  // Update on settlement
export function getStats() {}                    // Overall statistics
export function getStatsByBucket(bucketType) {}  // Stats by condition bucket
export function getRecentSignals(limit) {}       // Recent signals with outcomes
export function getState() {}
export async function shutdown() {}
export { SignalOutcomeLoggerError, SignalOutcomeLoggerErrorCodes };
```

### Error Pattern (per architecture.md)

```javascript
import { PolyError } from '../../types/errors.js';

export class SignalOutcomeLoggerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'SignalOutcomeLoggerError';
  }
}

export const SignalOutcomeLoggerErrorCodes = {
  NOT_INITIALIZED: 'SIGNAL_OUTCOME_LOGGER_NOT_INITIALIZED',
  INVALID_SIGNAL: 'SIGNAL_OUTCOME_LOGGER_INVALID_SIGNAL',
  INVALID_SETTLEMENT: 'SIGNAL_OUTCOME_LOGGER_INVALID_SETTLEMENT',
  DATABASE_ERROR: 'SIGNAL_OUTCOME_LOGGER_DATABASE_ERROR',
  SIGNAL_NOT_FOUND: 'SIGNAL_OUTCOME_LOGGER_SIGNAL_NOT_FOUND',
};
```

### Signal Input Structure (from oracle-edge-signal)

The signal generator produces this structure which we must log:

```javascript
{
  window_id: 'btc-15m-1706745600',
  symbol: 'btc',
  direction: 'fade_up',  // or 'fade_down'
  confidence: 0.78,
  token_id: '0x...',     // The token to BUY
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

### Settlement Data Structure

Settlement events from window-manager/orchestrator:

```javascript
{
  window_id: 'btc-15m-1706745600',
  settlement_time: '2026-02-01T12:15:00.000Z',
  final_oracle_price: 95480,  // Chainlink price at settlement
  outcome: 'up',              // 'up' or 'down' based on final vs strike
}
```

### Signal Outcome Calculation Logic

```javascript
/**
 * Determine if our signal was correct
 *
 * @param {string} signalDirection - 'fade_up' or 'fade_down'
 * @param {string} settlementOutcome - 'up' or 'down'
 * @returns {number} 1 if correct, 0 if incorrect
 */
function calculateSignalCorrect(signalDirection, settlementOutcome) {
  // FADE_UP means we bet on DOWN (settlement should be 'down')
  if (signalDirection === 'fade_up') {
    return settlementOutcome === 'down' ? 1 : 0;
  }
  // FADE_DOWN means we bet on UP (settlement should be 'up')
  if (signalDirection === 'fade_down') {
    return settlementOutcome === 'up' ? 1 : 0;
  }
  return 0;
}

/**
 * Calculate PnL from signal
 *
 * For binary markets:
 * - If correct: We paid (1 - token_price) to win, payout is 1, so profit = token_price
 * - Actually, if we BUY token at price P and win, we get 1 USDC per token
 * - Net = 1 - P (profit per token)
 * - If we lose: we get 0, Net = -P (loss per token)
 *
 * @param {Object} signal - Signal record with market_token_price
 * @param {number} signalCorrect - 1 if correct, 0 if not
 * @param {number} positionSize - Position size in tokens (default 1 for now)
 * @returns {number} PnL in USDC
 */
function calculatePnL(signal, signalCorrect, positionSize = 1) {
  const entryPrice = signal.market_token_price;

  if (signalCorrect === 1) {
    // We bought at entryPrice, token settled at 1
    return positionSize * (1 - entryPrice);
  } else {
    // We bought at entryPrice, token settled at 0
    return -positionSize * entryPrice;
  }
}
```

### Database Query Examples

```javascript
// Get overall win rate
const winRate = await db.get(`
  SELECT
    COUNT(*) as total,
    SUM(signal_correct) as wins,
    CAST(SUM(signal_correct) AS REAL) / COUNT(*) as win_rate,
    SUM(pnl) as total_pnl,
    AVG(confidence) as avg_confidence
  FROM oracle_edge_signals
  WHERE settlement_outcome IS NOT NULL
`);

// Get stats by time bucket
const byTimeBucket = await db.all(`
  SELECT
    CASE
      WHEN time_to_expiry_ms <= 10000 THEN '0-10s'
      WHEN time_to_expiry_ms <= 20000 THEN '10-20s'
      ELSE '20-30s'
    END as bucket,
    COUNT(*) as signals,
    SUM(signal_correct) as wins,
    SUM(pnl) as pnl
  FROM oracle_edge_signals
  WHERE settlement_outcome IS NOT NULL
  GROUP BY bucket
`);

// Get stats by confidence bucket
const byConfidenceBucket = await db.all(`
  SELECT
    CASE
      WHEN confidence < 0.6 THEN '0.5-0.6'
      WHEN confidence < 0.7 THEN '0.6-0.7'
      WHEN confidence < 0.8 THEN '0.7-0.8'
      ELSE '0.8+'
    END as bucket,
    COUNT(*) as signals,
    SUM(signal_correct) as wins,
    SUM(pnl) as pnl
  FROM oracle_edge_signals
  WHERE settlement_outcome IS NOT NULL
  GROUP BY bucket
`);

// Get stats by symbol
const bySymbol = await db.all(`
  SELECT
    symbol,
    COUNT(*) as signals,
    SUM(signal_correct) as wins,
    SUM(pnl) as pnl
  FROM oracle_edge_signals
  WHERE settlement_outcome IS NOT NULL
  GROUP BY symbol
`);
```

### Configuration Schema

```javascript
// config/default.js additions
{
  signalOutcomeLogger: {
    autoSubscribeToSignals: true,       // Auto-subscribe to oracle-edge-signal
    autoSubscribeToSettlements: true,   // Auto-subscribe to settlement events
    defaultPositionSize: 1,             // Default position size for PnL calc
    retentionDays: 30,                  // Keep signals for 30 days
  }
}
```

### State Shape

```javascript
getState() {
  return {
    initialized: true,
    stats: {
      total_signals: 150,
      signals_with_outcome: 145,
      pending_outcomes: 5,
      win_rate: 0.58,
      total_pnl: 12.35,
      avg_confidence: 0.72,
    },
    subscriptions: {
      signal_generator: true,
      settlements: true,
    },
    config: { ... },
  };
}
```

### Logging Requirements

All logs MUST use structured format with required fields:
```javascript
log.info('signal_outcome_logger_initialized', { config: { autoSubscribeToSignals, autoSubscribeToSettlements } });
log.info('signal_logged', {
  window_id: 'btc-15m-...',
  symbol: 'btc',
  direction: 'fade_up',
  signal_id: 123,
});
log.info('outcome_updated', {
  window_id: 'btc-15m-...',
  signal_correct: 1,
  pnl: 0.28,
  settlement_outcome: 'down',
});
log.debug('settlement_no_signal', {
  window_id: 'btc-15m-...',
  reason: 'no_signal_for_window',
});
log.warn('outcome_update_failed', { window_id, error: err.message });
log.error('signal_logging_failed', { window_id, error: err.message });
```

### Testing Strategy

1. **Unit Tests (logger.test.js):**
   - logSignal extracts correct fields from signal object
   - calculateSignalCorrect logic for all direction/outcome combinations
   - calculatePnL for winning and losing signals
   - Bucket queries return correct groupings

2. **Unit Tests (index.test.js):**
   - Init creates subscriptions
   - logSignal inserts to database
   - updateOutcome updates correct record
   - getStats returns correct aggregations
   - getStatsByBucket returns correct buckets
   - shutdown cleans up subscriptions

3. **Integration Tests (integration.test.js):**
   - End-to-end: signal → log → settlement → outcome update
   - Verify database records match expected values
   - Test subscription callback handling
   - Test missing signal handling (settlement for unknown window)
   - Test duplicate window_id handling

### Dependencies

**Required internal modules:**
- `src/modules/logger/` - for child logger creation
- `src/modules/oracle-edge-signal/` - subscribe to signals (optional, graceful if unavailable)
- `src/persistence/` - database access for oracle_edge_signals table
- `src/types/errors.js` - for PolyError base class

**No new npm packages required.**

### Previous Story Intelligence (from 7-7)

**Key Learnings from Story 7-7 (Oracle Edge Signal Generator):**
1. Signal structure is well-defined with window_id, symbol, direction, confidence, inputs
2. inputs object contains: time_remaining_ms, market_price, ui_price, oracle_price, oracle_staleness_ms, spread_pct, strike, staleness_score
3. subscribe() returns unsubscribe function
4. Direction values: 'fade_up' (bet DOWN) or 'fade_down' (bet UP)
5. Use dynamic imports with try/catch for optional dependencies

**Code Review Findings to Apply:**
- Validate all inputs before database operations
- Handle missing/null fields gracefully
- Use transactions for multi-step database operations
- Add defensive null checks for optional data
- Rate limit warning logs

### Project Structure Notes

- Follows `src/modules/{name}/` pattern per architecture.md
- Tests co-located in `__tests__/` folder
- This module is an ANALYTICS/LOGGING module - tracks signal outcomes for hypothesis validation
- Consumes signals from oracle-edge-signal (7-7)
- Settlement events come from orchestrator/window-manager
- Story 7-9 (Strategy Quality Gate) will use this data to auto-disable poor strategies

### Relationship to Other Stories

**Depends on:**
- Story 7-7 (Oracle Edge Signal Generator) - provides signals to log

**Used by:**
- Story 7-9 (Strategy Quality Gate) - uses outcome data to evaluate strategy quality
- Quant researchers - for validating oracle edge hypothesis

### The Oracle Edge Hypothesis Validation

**This module's purpose:**
> We're generating oracle edge signals. But do they actually work? This module tracks every signal's outcome to answer that question with data.

**Key Questions This Module Will Answer:**
1. What is the overall win rate of oracle edge signals?
2. Which condition buckets have the best win rate? (time, staleness, confidence)
3. Is there a statistically significant edge, or is it random?
4. What is the expected PnL per signal?
5. Are some symbols (BTC, ETH, SOL, XRP) better than others?

**Data-Driven Strategy Refinement:**
- If win rate < 50%, the hypothesis is likely wrong
- If win rate > 55% with statistical significance, we have an edge
- If certain buckets outperform, we can tune signal generation thresholds

### Critical Implementation Notes

1. **Idempotency:** If a signal for window_id already exists, handle gracefully (upsert or skip)

2. **Async Settlement:** Settlement may come before or after signal logging depending on timing. Handle both cases.

3. **PnL Approximation:** For now, use market_token_price as entry price. Future enhancement: integrate with actual order fills from order-manager.

4. **No Trading Logic:** This module LOGS outcomes. It does NOT generate signals or place orders. Pure analytics.

5. **Retention:** Consider adding cleanup for old signals after retentionDays to prevent database bloat.

6. **Subscribe vs Manual:** Support both automatic subscription to signals AND manual logSignal() calls for flexibility.

### References

- [Source: _bmad-output/planning-artifacts/epic-7-oracle-edge-infrastructure.md#Story 7-8]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Schema]
- [Source: _bmad-output/implementation-artifacts/7-7-oracle-edge-signal-generator.md - Signal structure and subscription pattern]
- [Source: src/modules/oracle-edge-signal/generator.js - Signal generation logic and output format]
- [Source: src/modules/oracle-edge-signal/types.js - SignalDirection enum values]
- [Source: src/persistence/migrations/ - Migration patterns from 001-012]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debugging issues encountered during implementation.

### Completion Notes List

1. **Module Structure Created**: Full module structure following project patterns with index.js, logger.js, types.js, and __tests__/ folder.

2. **Database Migration**: Created migration 013-oracle-edge-signals-table.js with complete schema including UNIQUE constraint on window_id for upsert support, and 4 indexes for efficient queries.

3. **Signal Logging**: logSignal() extracts all fields from oracle-edge-signal signals, uses SQL upsert (ON CONFLICT) to handle duplicate window_ids gracefully.

4. **Outcome Updates**: updateOutcome() calculates settlement_outcome based on final_oracle_price vs strike, determines signal_correct using fade logic (fade_up wins on down, fade_down wins on up), and calculates PnL.

5. **PnL Calculation**: Binary market PnL: win = (1 - entry_price), loss = -entry_price. Uses market_token_price as entry price proxy.

6. **Analytics Queries**: getStats() for overall metrics, getStatsByBucket() for time/staleness/confidence/symbol bucketing, getRecentSignals() for recent history.

7. **Subscriptions**: Auto-subscribes to oracle-edge-signal on init (with graceful failure), exports subscribeToSettlements() for orchestrator integration.

8. **Config Added**: signalOutcomeLogger config block added to config/default.js.

9. **Comprehensive Tests**: 97 tests covering unit, integration, and edge cases - all passing with no regressions to existing 2640 tests.

### File List

**New Files:**
- src/modules/signal-outcome-logger/index.js
- src/modules/signal-outcome-logger/logger.js
- src/modules/signal-outcome-logger/types.js
- src/modules/signal-outcome-logger/__tests__/index.test.js
- src/modules/signal-outcome-logger/__tests__/logger.test.js
- src/modules/signal-outcome-logger/__tests__/integration.test.js
- src/persistence/migrations/013-oracle-edge-signals-table.js

**Modified Files:**
- config/default.js (added signalOutcomeLogger config block)

### Change Log

- 2026-02-01: Story 7-8 implementation complete. Created signal-outcome-logger module with full signal logging, outcome tracking, and analytics capabilities. 97 tests passing, all ACs satisfied.

