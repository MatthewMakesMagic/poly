# Sprint Change Proposal - Epic 7: Oracle Edge Infrastructure

**Generated:** 2026-01-31
**Project:** Poly Trading System
**Change Scope:** Major (New Epic)
**Status:** APPROVED
**Approved:** 2026-01-31

---

## Section 1: Issue Summary

### Problem Statement
Production deployment revealed significant gaps between planned scope and actual requirements:

1. **Window Discovery Gap**: No mechanism existed to find active trading windows - had to build `window-manager` module during production (Enhancement E2)

2. **Token ID Pipeline Gap**: Entry signals didn't include token IDs needed for order execution - required emergency fix (Enhancement E3)

3. **Strategy Infrastructure Gap**: Original stories didn't include the probabilistic models, multi-feed price infrastructure, or strategy components documented in `_bmad-output/strategies/`

4. **Oracle Architecture Discovery**: Critical insight revealed that Polymarket uses **Binance for UI display** but **Chainlink oracle for settlement** - this price discrepancy is the core trading opportunity

### Evidence
- Production required 4 emergency enhancements (E1-E4) documented in ENHANCEMENTS.md
- Current implementation only has Pyth REST polling (17-second ticks)
- Strategy components 07 (Window Timing Model) and 08 (Spot Lag Tracker) were never implemented
- No infrastructure to track oracle vs UI price divergence

### Context
Discovered during first production deployment on Railway. System could not execute trades because:
- No window discovery mechanism
- No token IDs in signal pipeline
- No real-time price feeds (REST polling too slow)

---

## Section 2: Impact Analysis

### Epic Impact

| Epic | Status | Impact |
|------|--------|--------|
| Epic 1-6 | Done | No changes - core infrastructure complete |
| Epic Extra (Scout) | Done | No changes |
| **Epic 7 (NEW)** | Proposed | 12 new stories for oracle edge infrastructure |

### Story Impact

**No existing stories modified.** All changes are additive via new Epic 7.

### Artifact Conflicts

| Artifact | Required Updates |
|----------|------------------|
| PRD | Add FR40 (Multi-feed infrastructure), FR41 (Oracle tracking), FR42 (Strategy variations) |
| Architecture | Add Oracle Edge section, RTDS WebSocket integration |
| Epics | Create new Epic 7 with 12 stories |

### Technical Impact

**New Infrastructure Required:**
- Polymarket RTDS WebSocket client (`wss://ws-live-data.polymarket.com`)
- Dual topic subscription: `crypto_prices` (Binance/UI) + `crypto_prices_chainlink` (Oracle)
- New database tables for tick logging, oracle tracking, signal outcomes
- Strategy composition integration with Epic 6 framework

**No Breaking Changes:** Existing modules remain functional. Epic 7 adds parallel capability.

---

## Section 3: Recommended Approach

### Chosen Path: Direct Adjustment (New Epic)

**Rationale:**
1. Existing epics are complete and tested - don't modify
2. Oracle edge is fundamentally new capability, not a fix
3. Clean separation allows parallel development
4. New infrastructure (RTDS) doesn't interfere with existing Pyth client

### Effort Assessment
- **Stories:** 12 new stories
- **Complexity:** Moderate-High (WebSocket infrastructure, statistical analysis)
- **Dependencies:** Epic 6 composition framework (complete)

### Risk Assessment
| Risk | Mitigation |
|------|------------|
| RTDS API changes | Document current behavior, add fallback to direct Binance |
| Oracle behavior changes | Heavy logging, calibration tracking, kill switches |
| Strategy doesn't work | Test multiple variations, let data decide |

---

## Section 4: Detailed Change Proposals

### New Epic 7: Oracle Edge Infrastructure

#### Phase A: RTDS Infrastructure (Foundation)

**Story 7-1: RTDS WebSocket Client**
```
Connect to Polymarket's Real Time Data Socket
- Endpoint: wss://ws-live-data.polymarket.com
- Subscribe to topic: crypto_prices (Binance/UI feed)
- Subscribe to topic: crypto_prices_chainlink (Oracle feed)
- Handle reconnection, heartbeat, error recovery
- Standard module interface: init(), getState(), shutdown()

Acceptance Criteria:
- [ ] Connects to RTDS WebSocket successfully
- [ ] Subscribes to both topics (crypto_prices, crypto_prices_chainlink)
- [ ] Receives and parses tick data for BTC, ETH, SOL, XRP
- [ ] Handles disconnection with automatic reconnect
- [ ] Exposes real-time prices via module API
- [ ] Unit tests for connection, subscription, parsing
```

**Story 7-2: Feed Tick Logger**
```
Log every tick from both RTDS feeds for analysis

Database Schema:
CREATE TABLE rtds_ticks (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    topic TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    raw_payload TEXT
);

Acceptance Criteria:
- [ ] Logs every tick from both feeds
- [ ] Timestamps with millisecond precision
- [ ] Configurable retention/rotation policy
- [ ] Query helpers for analysis
```

**Story 7-3: Feed Divergence Tracker**
```
Real-time calculation of UI vs Oracle price spread

Metrics:
- ui_price - oracle_price (absolute spread)
- (ui_price - oracle_price) / oracle_price (percentage spread)
- Direction of divergence (UI leading or lagging)

Acceptance Criteria:
- [ ] Calculates spread in real-time
- [ ] Exposes current spread via API
- [ ] Logs spread history
- [ ] Alerts when spread exceeds threshold
```

#### Phase B: Oracle Behavior Analysis

**Story 7-4: Oracle Update Pattern Tracker**
```
Learn Chainlink oracle update behavior

Track:
- Update frequency (time between updates)
- Deviation thresholds (what % move triggers update)
- Update patterns by time of day, volatility regime

Database Schema:
CREATE TABLE oracle_updates (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    previous_price REAL,
    deviation_from_previous_pct REAL,
    time_since_previous_ms INTEGER
);

Acceptance Criteria:
- [ ] Detects and logs every oracle price change
- [ ] Calculates time since previous update
- [ ] Calculates deviation that triggered update
- [ ] Provides statistics on update patterns
```

**Story 7-5: Oracle Update Predictor**
```
Predict probability of oracle update before window expiry

Inputs:
- Current deviation from last oracle price
- Time since last oracle update
- Historical update patterns
- Time to window expiry

Output:
- P(oracle_update_before_expiry)

Acceptance Criteria:
- [ ] Calculates update probability given current state
- [ ] Uses historical patterns as prior
- [ ] Tracks prediction accuracy over time
- [ ] Exposes via API for strategy use
```

**Story 7-6: Oracle Staleness Detector**
```
Alert when oracle is "stale" (exploitable condition)

Staleness Conditions:
- Large time gap since last update (>15s)
- Price movement below deviation threshold
- Time to expiry is short (<30s)

Acceptance Criteria:
- [ ] Detects stale oracle conditions
- [ ] Calculates staleness score
- [ ] Emits events/alerts for strategy layer
- [ ] Logs all staleness detections
```

#### Phase C: Oracle Edge Strategy

**Story 7-7: Oracle Edge Signal Generator**
```
Generate entry signals based on oracle edge conditions

Entry Conditions (all must be true):
1. time_to_expiry < 30 seconds
2. oracle_staleness > 15 seconds
3. |ui_price - strike| > threshold (UI shows clear direction)
4. |ui_price - last_oracle_price| < chainlink_deviation_threshold
5. market_token_price > 0.85 or < 0.15 (crowd is confident)

Signal Logic:
- If UI shows UP but oracle hasn't seen it -> FADE UP
- If UI shows DOWN but oracle hasn't seen it -> FADE DOWN

Acceptance Criteria:
- [ ] Evaluates all entry conditions
- [ ] Generates signals when conditions met
- [ ] Includes confidence score
- [ ] Silent operation when no signal (FR24 compliant)
```

**Story 7-8: Signal Outcome Logger**
```
Track every signal's outcome for calibration

Database Schema:
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
    pnl REAL
);

Acceptance Criteria:
- [ ] Logs complete state at signal generation
- [ ] Updates with outcome after settlement
- [ ] Calculates P&L for each signal
- [ ] Provides query interface for analysis
```

**Story 7-9: Strategy Calibration Tracker**
```
Track signal accuracy by condition bucket

Buckets:
- Time remaining: <10s, 10-30s, >30s
- Oracle staleness: <15s, 15-30s, >30s
- Spread size: <0.5%, 0.5-1%, >1%

Kill Switch Criteria:
- Accuracy < 40% over last 20 signals
- Oracle update pattern change detected
- Feed unavailable > 10 seconds

Acceptance Criteria:
- [ ] Buckets signals by conditions
- [ ] Tracks accuracy per bucket
- [ ] Triggers kill switch when criteria met
- [ ] Provides calibration dashboard data
```

#### Phase D: Component Integration

**Story 7-10: Component 07 - Window Timing Model**
```
Black-Scholes probability model using ORACLE price as spot

Model: P(UP) = N(d2) where d2 = (ln(S/K) + (r - 0.5*sigma^2)*T) / (sigma*sqrt(T))

Key: S = oracle_price (NOT ui_price)

Additional Features:
- Realized volatility calculation (3-6 hour lookback)
- Volatility surprise detection (15min vs 6hr ratio)
- Calibration tracking by prediction bucket

Acceptance Criteria:
- [ ] Calculates P(UP)/P(DOWN) using Black-Scholes
- [ ] Uses oracle price as spot (settlement truth)
- [ ] Calculates realized volatility per asset
- [ ] Tracks calibration accuracy
- [ ] Integrates with strategy composition framework
```

**Story 7-11: Component 08 - Lag Tracker (Revised)**
```
Measure lag between price feeds

Lag Measurements:
1. UI -> Oracle: When UI moves, how long until oracle reflects?
2. Oracle -> Market Token: When oracle updates, how long until tokens reprice?
3. Exploitable Window: UI move to market token reprice

Cross-Correlation Analysis:
- Test lags: 0.5s, 1s, 2s, 5s, 10s, 30s
- Find optimal lag (tau*) that maximizes correlation
- Track lag stability over time

Predictive Validation:
- When lag signal fires, did it predict profitable trade?
- Log: signal, prediction, outcome, P&L

Acceptance Criteria:
- [ ] Calculates cross-correlation at multiple lags
- [ ] Identifies optimal lag per asset
- [ ] Validates lag signals predict profits
- [ ] Integrates with strategy composition framework
```

**Story 7-12: Strategy Composition Integration**
```
Wire oracle edge components into Epic 6 composition framework

Components to Register:
- rtds-client (price source)
- oracle-tracker (oracle analysis)
- oracle-edge-signal (signal generator)
- window-timing-model (probability calculator)
- lag-tracker (lag analysis)

Strategy Compositions:
1. Oracle Edge Only: rtds + oracle-tracker + oracle-edge-signal
2. Probability Model: rtds + window-timing-model
3. Hybrid: All components, weighted signals

Acceptance Criteria:
- [ ] All components registered in component registry
- [ ] At least 2 strategy compositions defined
- [ ] Strategies can be switched via config
- [ ] Backtest harness can evaluate each strategy
```

---

## Section 5: Implementation Handoff

### Change Scope Classification: **Major**

New epic with 12 stories requiring:
- New WebSocket infrastructure
- New database schemas
- New strategy logic
- Integration with existing framework

### Handoff Recipients

| Recipient | Responsibility |
|-----------|----------------|
| SM (create-story) | Create story files for 7-1 through 7-12 |
| Dev (dev-story) | Implement each story |
| Architect | Review RTDS integration approach |

### Implementation Order

**Recommended Sequence:**
1. **7-1** (RTDS Client) - Foundation, no dependencies
2. **7-2** (Tick Logger) - Depends on 7-1
3. **7-3** (Divergence Tracker) - Depends on 7-1
4. **7-4** (Oracle Pattern Tracker) - Depends on 7-1
5. **7-5, 7-6** (Predictor, Staleness) - Depend on 7-4
6. **7-7, 7-8, 7-9** (Signal, Outcome, Calibration) - Depend on 7-3, 7-6
7. **7-10, 7-11** (Components 07, 08) - Depend on 7-1
8. **7-12** (Composition) - Depends on all above

### Success Criteria

1. RTDS WebSocket connected and logging ticks
2. Oracle update patterns documented from real data
3. At least one strategy variation generating signals
4. Calibration tracking showing signal accuracy
5. Kill switch functional and tested

---

## Appendix: Key Technical Details

### Polymarket RTDS Connection
```javascript
const ws = new WebSocket('wss://ws-live-data.polymarket.com');

// Subscribe to UI feed (Binance)
ws.send(JSON.stringify({
  type: 'subscribe',
  topic: 'crypto_prices',
  symbols: ['btcusdt', 'ethusdt', 'solusd', 'xrpusdt']
}));

// Subscribe to Oracle feed (Chainlink)
ws.send(JSON.stringify({
  type: 'subscribe',
  topic: 'crypto_prices_chainlink',
  symbols: ['btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd']
}));
```

### Oracle Edge Thesis
> Market prices anchor to UI (Binance RTDS). Settlement uses Oracle (Chainlink RTDS). When they diverge near expiry with a stale oracle, fade the crowd.

### Strategy Variations to Test
1. **Oracle Edge Only**: Pure oracle staleness play
2. **Probability Model Only**: Black-Scholes with oracle spot
3. **Lag-Based**: Cross-correlation signal
4. **Hybrid**: Weighted combination of all

**Philosophy**: Don't pick winners upfront. Instrument everything, log everything, let data decide.
