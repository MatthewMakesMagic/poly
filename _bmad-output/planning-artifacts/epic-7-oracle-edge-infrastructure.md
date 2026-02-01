# Epic 7: Oracle Edge Infrastructure

**User Value:** I can exploit the structural difference between UI prices and oracle settlement prices, with full instrumentation to validate which strategies actually work.

**Created:** 2026-01-31
**Source:** Sprint Change Proposal (correct-course workflow)

---

## Overview

This epic builds infrastructure to:
1. Connect to Polymarket's RTDS for both UI (Binance) and Oracle (Chainlink) price feeds
2. Track oracle update patterns and detect exploitable staleness
3. Generate and validate signals based on oracle edge hypothesis
4. Implement probability models (Black-Scholes) using oracle price as ground truth
5. Measure lag between feeds and validate if lag predicts profitable trades
6. Test multiple strategy variations and let data decide what works

**Core Thesis:**
> Market prices anchor to UI (Binance RTDS). Settlement uses Oracle (Chainlink RTDS). When they diverge near expiry with a stale oracle, there may be an exploitable edge. We instrument everything, log everything, and let the data decide.

---

## FRs Covered

| FR | Description | Stories |
|----|-------------|---------|
| FR40 (NEW) | Multi-feed price infrastructure | 7-1, 7-2, 7-3 |
| FR41 (NEW) | Oracle behavior tracking | 7-4, 7-5, 7-6 |
| FR42 (NEW) | Strategy variation testing | 7-7, 7-8, 7-9, 7-10, 7-11, 7-12 |

---

## Dependencies

- **Epic 1** (Foundation): Database, logging, config
- **Epic 6** (Strategy Composition): Component registry, composition framework

---

## Phase A: RTDS Infrastructure (Foundation)

### Story 7-1: RTDS WebSocket Client

As a **developer**,
I want **a WebSocket client connected to Polymarket's Real Time Data Socket**,
So that **I can receive both UI prices (Binance) and Oracle prices (Chainlink) in real-time**.

**Acceptance Criteria:**

**Given** the RTDS client module exists
**When** initialized with config
**Then** it connects to `wss://ws-live-data.polymarket.com`
**And** subscribes to topic `crypto_prices` (Binance/UI feed)
**And** subscribes to topic `crypto_prices_chainlink` (Oracle feed)
**And** exports standard module interface: init(), getState(), shutdown()

**Given** the connection is established
**When** price updates arrive
**Then** ticks are parsed and normalized to format: `{ timestamp, topic, symbol, price }`
**And** subscribers are notified via callback or event emitter

**Given** the connection drops
**When** disconnect is detected
**Then** automatic reconnection is attempted with exponential backoff
**And** reconnection events are logged
**And** stale price warning is emitted if reconnection takes > 5 seconds

**Given** symbols to track
**When** subscribing to feeds
**Then** BTC, ETH, SOL, XRP are subscribed on both topics
**And** symbol mapping handles format differences (btcusdt vs btc/usd)

**Technical Notes:**
- Verify feed behavior via browser DevTools (Network → WS filter)
- No auth required for RTDS
- Handle both topics in single connection

---

### Story 7-2: Feed Tick Logger

As a **data analyst**,
I want **every tick from both RTDS feeds logged to the database**,
So that **I can analyze price relationships and validate strategies offline**.

**Acceptance Criteria:**

**Given** ticks arrive from RTDS client
**When** a tick is received
**Then** it is inserted into `rtds_ticks` table with: timestamp, topic, symbol, price, raw_payload

**Given** high tick volume
**When** logging ticks
**Then** batch inserts are used for efficiency (buffer and flush every 100ms or 50 ticks)
**And** no ticks are dropped under normal operation

**Given** database storage concerns
**When** ticks accumulate
**Then** configurable retention policy exists (default: 7 days)
**And** old ticks can be archived or purged

**Database Schema:**
```sql
CREATE TABLE rtds_ticks (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    topic TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    raw_payload TEXT
);

CREATE INDEX idx_rtds_ticks_timestamp ON rtds_ticks(timestamp);
CREATE INDEX idx_rtds_ticks_symbol_topic ON rtds_ticks(symbol, topic);
```

---

### Story 7-3: Feed Divergence Tracker

As a **trader**,
I want **real-time tracking of the spread between UI and Oracle prices**,
So that **I can see when they diverge and by how much**.

**Acceptance Criteria:**

**Given** ticks arrive from both feeds
**When** prices are updated
**Then** spread is calculated: `ui_price - oracle_price`
**And** percentage spread is calculated: `(ui_price - oracle_price) / oracle_price`
**And** direction is tracked: UI leading (positive) or lagging (negative)

**Given** spread is calculated
**When** querying current state
**Then** getState() returns: `{ symbol, ui_price, oracle_price, spread, spread_pct, direction, last_updated }`

**Given** spread exceeds threshold
**When** threshold is breached (configurable, default 0.3%)
**Then** an event is emitted for strategy layer
**And** breach is logged with full context

**Given** spread history is needed
**When** analyzing patterns
**Then** spread snapshots are logged periodically (every 1 second during active windows)

---

## Phase B: Oracle Behavior Analysis

### Story 7-4: Oracle Update Pattern Tracker

As a **quant researcher**,
I want **to learn the Chainlink oracle's update patterns**,
So that **I can predict when updates will occur**.

**Acceptance Criteria:**

**Given** oracle prices arrive from RTDS
**When** a price change is detected
**Then** an update record is created with: timestamp, symbol, price, previous_price, deviation_pct, time_since_previous_ms

**Given** update records accumulate
**When** analyzing patterns
**Then** statistics are available: avg_update_frequency, deviation_threshold_observed, update_frequency_by_volatility

**Given** the oracle update table
**When** querying
**Then** I can answer: "On average, how often does Chainlink update?" and "What price move triggers an update?"

**Database Schema:**
```sql
CREATE TABLE oracle_updates (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    previous_price REAL,
    deviation_from_previous_pct REAL,
    time_since_previous_ms INTEGER
);

CREATE INDEX idx_oracle_updates_symbol ON oracle_updates(symbol);
CREATE INDEX idx_oracle_updates_timestamp ON oracle_updates(timestamp);
```

---

### Story 7-5: Oracle Update Predictor

As a **trader**,
I want **to predict the probability of an oracle update before window expiry**,
So that **I can assess whether the current oracle price is likely to change**.

**Acceptance Criteria:**

**Given** current oracle state
**When** predicting update probability
**Then** inputs considered: current_deviation_from_last_update, time_since_last_update, time_to_expiry, historical_update_patterns

**Given** historical patterns exist
**When** calculating probability
**Then** use empirical distribution: P(update) = historical_rate_at_similar_conditions
**And** output includes confidence interval

**Given** prediction is made
**When** window expires
**Then** outcome is logged: predicted_probability, actual_outcome (update_occurred: true/false)
**And** calibration can be tracked over time

**Given** the predictor module
**When** querying
**Then** getPrediction(symbol, time_to_expiry_ms) returns: `{ p_update, confidence, inputs_used }`

---

### Story 7-6: Oracle Staleness Detector

As a **trader**,
I want **to detect when the oracle is "stale" (hasn't updated despite price movement)**,
So that **I can identify potential trading opportunities**.

**Acceptance Criteria:**

**Given** current market state
**When** evaluating staleness
**Then** staleness is detected if ALL conditions met:
- time_since_last_oracle_update > staleness_threshold_ms (default: 15000)
- |ui_price - oracle_price| > min_divergence (default: 0.1%)
- |ui_price - oracle_price| < chainlink_deviation_threshold (oracle unlikely to update)

**Given** staleness is detected
**When** evaluating
**Then** staleness score is calculated (0-1 scale based on how many conditions met and by how much)
**And** event is emitted for strategy layer

**Given** staleness state changes
**When** oracle updates after being stale
**Then** "staleness_resolved" event is emitted
**And** resolution is logged with: staleness_duration_ms, price_at_resolution

**Given** configuration
**When** thresholds need tuning
**Then** staleness_threshold_ms, min_divergence_pct, chainlink_deviation_threshold are configurable

---

## Phase C: Oracle Edge Strategy

### Story 7-7: Oracle Edge Signal Generator

As a **trader**,
I want **entry signals generated when oracle edge conditions are met**,
So that **I can trade the UI/Oracle divergence near expiry**.

**Acceptance Criteria:**

**Given** active windows exist
**When** evaluating entry conditions
**Then** signal is generated if ALL conditions met:
1. time_to_expiry < max_time_threshold (default: 30000ms)
2. oracle_staleness > min_staleness (default: 15000ms)
3. |ui_price - strike| > strike_threshold (UI shows clear direction)
4. |ui_price - oracle_price| < chainlink_deviation_threshold
5. market_token_price > confidence_threshold OR < (1 - confidence_threshold)

**Given** conditions are met
**When** signal is generated
**Then** signal includes: window_id, symbol, direction (fade_up or fade_down), confidence, all_inputs
**And** signal is logged with complete state snapshot

**Given** conditions are NOT met
**When** evaluating
**Then** no signal is generated (silent operation per FR24)
**And** evaluation continues on next tick

**Given** signal direction logic
**When** UI shows "clearly UP" but oracle hasn't seen it
**Then** signal is FADE_UP (sell UP token / buy DOWN token)
**When** UI shows "clearly DOWN" but oracle hasn't seen it
**Then** signal is FADE_DOWN (sell DOWN token / buy UP token)

---

### Story 7-8: Signal Outcome Logger

As a **quant researcher**,
I want **every signal's outcome tracked against actual settlement**,
So that **I can measure whether the oracle edge hypothesis works**.

**Acceptance Criteria:**

**Given** a signal is generated
**When** logging the signal
**Then** complete state at signal time is recorded:
- timestamp, window_id, symbol
- time_to_expiry_ms, ui_price, oracle_price, oracle_staleness_ms
- strike, market_token_price
- signal_direction, confidence

**Given** window settles
**When** settlement occurs
**Then** signal record is updated with:
- final_oracle_price (the Chainlink price at settlement)
- settlement_outcome (up or down)
- signal_correct (1 if our fade was right, 0 otherwise)
- pnl (calculated from entry price and settlement)

**Given** historical signals exist
**When** analyzing performance
**Then** I can query: accuracy by condition bucket, total P&L, win rate

**Database Schema:**
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
    final_oracle_price REAL,
    settlement_outcome TEXT,
    signal_correct INTEGER,
    pnl REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_oracle_edge_signals_window ON oracle_edge_signals(window_id);
CREATE INDEX idx_oracle_edge_signals_symbol ON oracle_edge_signals(symbol);
```

---

### Story 7-9: Strategy Quality Gate

As a **trader**,
I want **automatic disabling of strategies when signal quality degrades**,
So that **I don't keep trading a broken strategy**.

**Acceptance Criteria:**

**Given** signal outcomes are tracked
**When** evaluating strategy quality
**Then** rolling accuracy is calculated over last N signals (default: 20)
**And** accuracy by bucket is tracked (time_remaining, staleness, spread_size)

**Given** accuracy drops below threshold
**When** accuracy < min_accuracy (default: 40%) over rolling window
**Then** strategy is auto-disabled
**And** alert is logged: "Strategy quality gate triggered - accuracy X% below threshold"
**And** no new signals are generated until manually re-enabled

**Given** other quality issues
**When** detected
**Then** strategy is disabled:
- Oracle feed unavailable > 10 seconds
- Update pattern appears to have changed (statistical test)
- Spread behavior changes significantly

**Given** strategy is disabled
**When** user wants to re-enable
**Then** manual intervention required (CLI command or config change)
**And** re-enable is logged with reason

**Note:** This is distinct from Epic 4's kill switch. Epic 4 = emergency halt all trading. This = disable specific strategy due to quality issues.

---

## Phase D: Component Integration

### Story 7-10: Component 07 - Window Timing Model

As a **quant trader**,
I want **Black-Scholes probability calculations using oracle price**,
So that **I can assess true probability of UP/DOWN based on settlement price**.

**Acceptance Criteria:**

**Given** market state is available
**When** calculating probability
**Then** Black-Scholes N(d2) is used where:
- S = oracle_price (NOT ui_price - this is settlement truth)
- K = strike (the 0.50 midpoint for UP/DOWN resolution)
- T = time_to_expiry in years
- σ = realized volatility (rolling calculation)
- r = 0 (risk-free rate, negligible for short windows)

**Given** volatility calculation
**When** computing sigma
**Then** realized volatility is calculated from oracle price history
**And** lookback period is configurable (default: 6 hours)
**And** volatility is calculated per asset (BTC, ETH, SOL, XRP separately)

**Given** volatility surprise detection
**When** short-term vol (15 min) differs significantly from long-term (6 hour)
**Then** vol_surprise flag is set
**And** logged for analysis

**Given** calibration tracking
**When** model predicts P(UP) = X%
**Then** predictions are bucketed (50-60%, 60-70%, 70-80%, etc.)
**And** actual outcomes are tracked per bucket
**And** calibration error is calculated: |predicted - actual_hit_rate|

**Given** calibration error exceeds threshold
**When** error > 15% over 100 predictions in a bucket
**Then** alert is raised
**And** model parameters may need adjustment

**Component Interface:**
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

### Story 7-11: Component 08 - Lag Tracker

As a **quant researcher**,
I want **to measure lag between price feeds and validate if lag predicts profits**,
So that **I can determine if lag-based trading is viable**.

**Acceptance Criteria:**

**Given** price time series from multiple feeds
**When** analyzing lag
**Then** cross-correlation is calculated at multiple tau values: 0.5s, 1s, 2s, 5s, 10s, 30s

**Given** cross-correlation results
**When** finding optimal lag
**Then** tau* (optimal lag) is identified as the lag with highest correlation
**And** correlation strength at tau* is reported
**And** statistical significance is calculated (p-value < 0.05 required)

**Given** lag measurements
**When** tracking over time
**Then** lag stability is monitored (is tau* jumping around?)
**And** lag by regime is tracked (high vol vs low vol, time of day)

**Given** lag signals
**When** a lag-based entry opportunity is identified
**Then** signal is logged with: tau_used, correlation_at_tau, predicted_direction

**Given** lag signal outcomes
**When** validating predictive power
**Then** track: did the lag signal predict a profitable trade?
**And** log: signal_id, prediction, outcome, pnl

**Database Schema:**
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

**Key Question to Answer:**
Does knowing "Binance moved but Chainlink hasn't" actually predict profitable trades? The data will tell us.

---

### Story 7-12: Strategy Composition Integration

As a **trader**,
I want **oracle edge components wired into the Epic 6 composition framework**,
So that **I can compose and switch between strategy variations**.

**Acceptance Criteria:**

**Given** new components exist
**When** registering with Epic 6 component registry
**Then** these components are registered:
- `rtds-client` (type: price-source)
- `oracle-tracker` (type: analysis)
- `oracle-edge-signal` (type: signal-generator)
- `window-timing-model` (type: probability)
- `lag-tracker` (type: analysis)

**Given** components are registered
**When** composing strategies
**Then** at least these compositions are available:
1. **Oracle Edge Only**: rtds-client + oracle-tracker + oracle-edge-signal
2. **Probability Model Only**: rtds-client + window-timing-model
3. **Lag-Based**: rtds-client + lag-tracker
4. **Hybrid**: All components with weighted signal combination

**Given** strategy compositions exist
**When** selecting active strategy
**Then** selection is via config (no code change required)
**And** active strategy can be changed at runtime via CLI

**Given** backtest capability
**When** evaluating strategies offline
**Then** historical tick data can be replayed through strategy
**And** signal outcomes can be calculated without live trading

**Philosophy:**
> Don't pick winners upfront. Instrument everything, log everything, let the data decide which strategy variation actually works.

---

## Summary

| Story | Title | Phase | Priority |
|-------|-------|-------|----------|
| 7-1 | RTDS WebSocket Client | A | Critical |
| 7-2 | Feed Tick Logger | A | High |
| 7-3 | Feed Divergence Tracker | A | High |
| 7-4 | Oracle Update Pattern Tracker | B | High |
| 7-5 | Oracle Update Predictor | B | Medium |
| 7-6 | Oracle Staleness Detector | B | High |
| 7-7 | Oracle Edge Signal Generator | C | High |
| 7-8 | Signal Outcome Logger | C | High |
| 7-9 | Strategy Quality Gate | C | Medium |
| 7-10 | Component 07 - Window Timing Model | D | High |
| 7-11 | Component 08 - Lag Tracker | D | Medium |
| 7-12 | Strategy Composition Integration | D | Medium |

**Recommended Implementation Order:**
1. 7-1 (RTDS Client) - Foundation
2. 7-2 (Tick Logger) - Depends on 7-1
3. 7-3 (Divergence Tracker) - Depends on 7-1
4. 7-4 (Oracle Pattern Tracker) - Depends on 7-1
5. 7-6 (Staleness Detector) - Depends on 7-4
6. 7-5 (Update Predictor) - Depends on 7-4
7. 7-7, 7-8 (Signal Generator, Outcome Logger) - Depend on 7-3, 7-6
8. 7-9 (Quality Gate) - Depends on 7-8
9. 7-10 (Window Timing Model) - Depends on 7-1
10. 7-11 (Lag Tracker) - Depends on 7-1
11. 7-12 (Composition Integration) - Depends on all above
