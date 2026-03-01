# Party Mode Session — 2026-03-01
## Live Trading Framework & Web Dashboard — Full Discussion

### Participants
- **Marcus** (📈 Hedge Fund Manager) — Strategy framework, phased roadmap
- **Nadia** (🛡️ Risk Manager) — Safeguards, failure modes, kill switches
- **Winston** (🏗️ Architect) — System architecture, runtime controls, tech stack
- **Sally** (🎨 UX Designer) — Dashboard design, user experience
- **Cassandra** (🔥 The Skeptic) — Adversarial review, pre-registration
- **Theo** (📊 Market Specialist) — Execution concerns
- **Quinn** (🧪 QA Engineer) — Runtime assertions, test plans
- **Amelia** (💻 Developer) — Implementation specifics
- **Vera** (🔬 Quant Researcher) — Statistical rigour, backtest integrity

---

## Context: What Happened

On Feb 28, 2026 the live trading system suffered catastrophic failure:
- 183 ETH shares entered in a single position ($49)
- XRP got 6x position size (23.9 shares vs ~4 for others)
- No per-trade or per-session dollar cap
- VWAP strategy fired on unopened future windows
- `order_id` null constraint violations broke position tracking
- IOC maxPrice used wrong field for VWAP signals
- Portfolio reduced to ~$74 ($0.49 cash, losing positions)
- System: SHUTDOWN

Previous incidents: Feb 1 deployment (7+ emergency commits while live), Jan 27 position management bugs (stop losses not executing, take profits not triggering, opposite bets on same market).

---

## Core Principle

**Every mode of operation must produce trustworthy data, and the dashboard must prove it.**

The strategy ideas are Matthew's domain. The team's job is building the engine, the instruments, and the cockpit.

---

## Phased Roadmap

### PHASE 0 — SURVIVE (before any capital goes back in)

**P0 Bug Fixes:**
1. VWAP time bound — hotfixed (`ee64cac`) but needs test proving it rejects future windows
2. Per-position dollar cap — hard $5 max, enforced at order-manager level (not strategy level)
3. `order_id` null constraint — every order write must have an ID or write fails loudly
4. IOC `maxPrice` — must use correct field for VWAP signals

**Additional Safeguards:**
5. Balance verification before every entry — query Polymarket API for real balance, not just internal tracking
6. Position reconciliation on startup — query Polymarket for all open positions, reconcile against DB, circuit breaker trips on mismatch
7. Order confirmation loop — poll for fill confirmation within 5s, if no confirmation log as UNKNOWN and block re-entry on that window
8. Maximum orders per window per instrument — hard cap of 2, hardcoded, not configurable

**Enable Disabled Safeguards:**
- Stop-loss module: currently DISABLED by default → ENABLE
- Safety module daily drawdown limit: currently `null` → SET a value
- Take-profit: currently `null` (hold to expiry) → SET defaults

**Runtime Kill Switch Architecture:**
```
PostgreSQL table: runtime_controls
├── key: 'kill_switch'         → value: 'off' | 'on'
├── key: 'trading_mode'        → value: 'LIVE' | 'PAPER' | 'DRY_RUN'
├── key: 'max_position_usd'    → value: '5'
├── key: 'max_session_loss'    → value: '20'
├── key: 'allowed_instruments' → value: 'BTC,ETH' (or '*')
└── key: 'allowed_strategies'  → value: 'canary' (or '*')
```

Orchestrator reads this table every tick (one query, cached 1s). Dashboard writes to it. No redeploy needed.

**Three-level kill switch:**
1. **Pause**: Stop new entries, keep monitoring existing positions (stop-losses still active)
2. **Flatten**: Close all open positions at market, then pause
3. **Emergency**: Cancel all pending orders AND close all positions

**Dry-Run Mode Requirements:**
- Hit every code path except the final POST to Polymarket
- Log exact order payload that would have been sent
- Simulate fill at current market price
- Track simulated position through full lifecycle including stop-loss and settlement
- Capture order book snapshot at decision time
- Compare dry-run outcome against what actually happened

---

### PHASE 1 — TEST HARNESS (Canary Strategy)

**The Canary Strategy:**
- Name: `always-trade-canary`
- Logic: At T-60s before window close, buy the side CLOB is favoring (>$0.50)
- Instruments: ALL active instruments
- Position size: Minimum possible ($1)
- Stop loss: None (run to settlement to verify full lifecycle)
- Expected outcome: ~50% win rate, small losses to spread. Cost of testing.

**Verification Checklist (after 2 windows):**
1. Signal generated → logged with timestamp, instrument, direction, confidence
2. Order placed → order payload logged, order ID captured
3. Order filled → fill confirmation received, fill price recorded
4. Position opened → DB record with correct entry price, size, direction
5. Position monitored → every tick, position P&L updated correctly
6. Window closes → settlement direction captured from oracle
7. Position resolved → DB record updated with exit price, P&L, resolution
8. Balance updated → post-settlement balance matches expected
9. Cross-check: our resolution matches Polymarket's actual resolution
10. Cross-check: our P&L calculation matches actual balance change

**Runtime Assertions (trip circuit breaker on failure):**
```
ASSERTION 1:  Every signal → exactly one order (no duplicates, no gaps)
ASSERTION 2:  Every order → fill confirmation within 10s (or explicit rejection)
ASSERTION 3:  Every fill → position record created within same tick
ASSERTION 4:  Position count in DB === position count on Polymarket API
ASSERTION 5:  Position P&L at settlement === actual balance delta
ASSERTION 6:  No null order_ids in orders table
ASSERTION 7:  No positions on instruments not in allowed_instruments
ASSERTION 8:  No entries on future windows
ASSERTION 9:  Total capital deployed <= max_session_loss at all times
ASSERTION 10: System heartbeat — no tick takes longer than 5 seconds
```

**Phased Canary Execution:**
- Phase 1a: 2 windows with manual verification
- Phase 1b: 20 windows unattended, verify all assertions held

---

### PHASE 2 — RISK ENVELOPE VALIDATION

**Stop-Loss Variation Matrix:**

| Variant | Stop-Loss | Take-Profit | Purpose |
|---------|-----------|-------------|---------|
| A | 5% | None | Tight stop, does it fire? |
| B | 15% | None | Loose stop, does it fire? |
| C | 5% | 20% | Both active, which triggers first? |
| D | None | 10% trailing | Trailing stop only |
| E | 50% | None | Should never fire (control) |

Run each variant on 5+ windows. For every trigger event verify:
- Trigger price matches threshold exactly (not 1 tick late)
- Exit order placed immediately
- Exit order filled
- Position closed in DB
- Balance reflects the exit
- Track intended exit price vs actual exit price (slippage)

**Position Lifecycle State Machine:**
```
ENTRY → MONITORING → { STOP_TRIGGERED | TAKE_PROFIT_TRIGGERED | EXPIRY }
                      ↓                ↓                        ↓
                    EXIT_PENDING    EXIT_PENDING            SETTLEMENT
                      ↓                ↓                        ↓
                    CLOSED           CLOSED                   CLOSED
```

One position, one state, one owner at a time. Stop-loss and take-profit feed into a single exit decision function with priority rules. Once EXIT_PENDING, nothing else can modify that position.

---

### PHASE 3 — REAL STRATEGY DEPLOYMENT

**Deployment checklist:**
1. Strategy registered in framework with declared parameters
2. Risk parameters set (position size, stop-loss, session max loss)
3. Instruments scoped (start with most liquid)
4. First 10 windows: manual review of every trade
5. Scale-up criteria: 10 consecutive windows with zero assertion failures AND P&L within expected range

**Pre-registration requirements (before any strategy goes live):**
- H0: Strategy has no edge (win rate = 50%, EV = 0)
- H1: Strategy win rate > X% with significance p < 0.05
- Required sample size calculated before deployment
- Kill criterion: pre-defined condition for stopping the strategy
- No moving goalposts after deployment

---

### PHASE 4 — THE DASHBOARD

**Tech Stack:**
- Backend: Extend existing health endpoint (`run_live_trading.mjs`), add WebSocket (`ws` package)
- Frontend: React + Vite, TailwindCSS, Recharts for P&L
- Data flow: WebSocket for real-time, REST for historical
- Deploy: Static site on Railway/Vercel/Netlify

**Dashboard Views:**

#### View 1: Command Center (default)
```
┌─────────────────────────────────────────────────┐
│ 🟢 LIVE │ BTC: $97,432 │ Balance: $74.00       │
│ Session P&L: -$2.30 │ [PAUSE] [FLATTEN] [STOP] │
├─────────────┬───────────────────────────────────┤
│ STRATEGIES  │ OPEN POSITIONS                    │
│             │                                    │
│ ✅ canary   │ BTC UP  $0.52 → $0.55  +$0.15    │
│ ⏸ vwap-c   │ ETH DN  $0.48 → $0.44  -$0.20    │
│ ⬚ hybrid   │ SOL UP  $0.61 → $0.58  -$0.09    │
│             │                                    │
├─────────────┴───────────────────────────────────┤
│ ACTIVITY FEED                                    │
│ 14:32:01 canary → BTC UP signal (CLOB: $0.54)  │
│ 14:32:02 ORDER placed: BTC-UP $1.00 @ $0.54    │
│ 14:32:02 FILL confirmed: 1.85 shares @ $0.54   │
│ 14:31:45 ASSERTION OK: 10/10 checks passed     │
│ 14:30:00 WINDOW 1842 opened (BTC 15m)          │
└─────────────────────────────────────────────────┘
```

#### View 2: Instrument Deep Dive
- Per-instrument: current window, oracle prices, CLOB state, active positions, historical P&L
- Feed health: last tick age for each data source
- Strategy signals: what each strategy is seeing for this instrument right now

#### View 3: Risk Dashboard
- Session drawdown chart (real-time)
- Per-strategy P&L breakdown
- Stop-loss/take-profit trigger history
- Runtime controls editor (the `runtime_controls` table)
- Assertion status: green/red for each of the 10 checks

#### View 4: Trade History
- Full trade log with filters (strategy, instrument, date range, outcome)
- Settlement verification: our resolution vs Polymarket's
- Slippage analysis: intended vs actual entry/exit prices
- Exportable to CSV for offline analysis

**System Health Bar (always visible):**
- Feed status: per-feed last-tick age (green <2s, yellow <5s, red >5s)
- DB health: connection pool usage, last successful write
- Data completeness: % of expected ticks received per window
- Clock sync: offset vs exchange servers
- Instance lock: "sole trader" confirmed

---

## 27 Failure Modes & Mitigations

### Data Capture (Always Running)

| # | Failure Mode | Mitigation | Dashboard Indicator |
|---|---|---|---|
| 1 | Feed goes stale but connection stays open | Per-feed heartbeat monitor. If no tick >5s, log gap. Record in `feed_gaps` table with start/end timestamps. Backtests exclude tainted windows. | Per-feed last-tick age (green/yellow/red) |
| 2 | Tick timestamps drift across sources | NTP sync verification on startup. Log clock offset vs exchange servers. Store both receive timestamp and source timestamp. | Clock sync offset display |
| 3 | Database write buffer drops ticks under load | Buffer overflow counter. Failed flush → retry once → log lost tick count. | Data completeness % per feed per window |
| 4 | CLOB snapshot frequency insufficient | Track and display actual capture rate. | Ticks/second per feed in real-time |
| 5 | Exchange tick deduplication failures | Dedup by exchange trade ID. Track and log out-of-order count. | Out-of-order tick counter |
| 6 | Window events missing or incorrect | Cross-validate every window event against Polymarket API after settlement. Log discrepancies. Fix `onchain_resolved_direction` NULL issue. | Settlement verification: ours vs Polymarket |
| 7 | conditionId missing from windows | Capture at window open time or derive from market lookup. | Missing conditionId alert |
| 8 | Token ID staleness | Validate token IDs before every order placement, not just at startup. | Token ID validation status |

### Paper Trading

| # | Failure Mode | Mitigation | Dashboard Indicator |
|---|---|---|---|
| 9 | Paper fills at unrealistic prices | Use actual CLOB snapshot at decision time. Record book depth. Fill at volume-weighted price across order size. | Simulated fill quality (intended vs book-adjusted) |
| 10 | Paper trading ignores market impact | Log order-size-to-depth ratio. Flag if order >50% of visible liquidity. | Impact warning flag on paper trades |
| 11 | Paper position lifecycle diverges from live | Identical code path. Only difference: `simulateFill()` vs `placeLiveOrder()`. Everything downstream same code. | Mode indicator on each position |

### Backtesting

| # | Failure Mode | Mitigation | Dashboard Indicator |
|---|---|---|---|
| 12 | Look-ahead bias | Replay engine enforces strict time ordering. Strategy sees ONLY data with timestamps <= current tick. | Backtest integrity flag |
| 13 | Survivorship bias in window selection | Include windows with feed gaps. Handle same way live code does. | Windows excluded count + reason |
| 14 | CLOB pre-window $0.50 contamination | Filter by `window_epoch` + `timestamp >= to_timestamp(window_epoch)` in the data loader, not strategy. | N/A (enforced in code) |
| 15 | Backtest fill assumptions unrealistic | Use historical book depth if available, or conservative slippage model (1% worse than mid). | Backtest slippage model displayed |
| 16 | Clock sync across data sources in replay | Document known latency offsets per source. Apply in replay. | Latency offset table in backtest config |

### Live Trading

| # | Failure Mode | Mitigation | Dashboard Indicator |
|---|---|---|---|
| 17 | Partial fills | Use actual fill amount from order confirmation, not requested amount. Always. | Requested vs filled amount per trade |
| 18 | Order rejection without notification | Explicit state machine: Order placed → confirmation → position opened. No confirmation = no position. | Order state machine status |
| 19 | Network partition during position | Startup reconciliation: query Polymarket API for all positions, match against DB. Mismatch = circuit breaker. | Reconciliation status on startup |
| 20 | Settlement race condition | Settlement query with retry and confirmation. Don't record resolution until confirmed on-chain or via Polymarket resolved status. | Settlement confirmation status |
| 21 | Multiple instances (Railway restart overlap) | Distributed lock in PostgreSQL. Only one instance holds `active_trader` lock. Second instance → observer-only mode. | Instance lock: "sole trader" confirmed |
| 22 | Fee accounting missing | Capture fee from every fill confirmation. Include in P&L. Dashboard shows gross AND net P&L. | Gross vs Net P&L display |
| 23 | Railway has no persistent volume | Everything in PostgreSQL. No local file dependencies for operational state. Kill-switch PID file approach won't work. | N/A (architectural decision) |
| 24 | Health endpoint goes down but trading continues | Health endpoint failure = circuit breaker trip. If can't report status, can't trade. | Health endpoint status |
| 25 | Database connection pool exhaustion | Connection pool monitoring. Pool utilization >80% = alert. Query timeout = log with full context. | Pool utilization % |

### Cross-Cutting

| # | Failure Mode | Mitigation | Dashboard Indicator |
|---|---|---|---|
| 26 | Paper and live use different position tracking | Unified `positions` table with `mode` column (PAPER, LIVE, DRY_RUN, BACKTEST). Single code path. | All modes visible side-by-side |
| 27 | Stop-loss and take-profit modules conflict | Single exit decision function with priority rules. Position lifecycle state machine. Once EXIT_PENDING, nothing else modifies. | Position state machine visualization |

---

## Strategy Interface (Framework Design)

```
Layer 1 — Strategy Interface
  Every strategy implements: evaluate(windowState) → Signal | null
  Every strategy declares: instrument scope, entry timing, risk parameters
  Strategy registration = drop a module in, config picks it up

Layer 2 — Position Lifecycle
  Entry → active monitoring → exit (stop/take/expiry)
  All three use the same position source — single positions table

Layer 3 — Risk Envelope
  Per-position cap, per-session cap, per-instrument cap
  Runtime kill switch via DB flag + API endpoint
  Circuit breaker for system failures (exists)
  Drawdown breaker for strategy failures (needs building)

Layer 4 — Observer (Dashboard)
  Read-only tap into all three layers
  WebSocket/SSE for real-time updates
  Health endpoint is the embryo
```

**Unified Code Path (critical architectural requirement):**
```
Strategy → Signal → OrderManager.execute(signal, mode)
                         │
                    mode=LIVE → Polymarket API → real fill
                    mode=PAPER → SimulatedBook → simulated fill
                    mode=DRY_RUN → log only → no fill
                         │
                         ▼
                    PositionManager.open(fill, mode)  ← SAME code
                         │
                         ▼
                    StopLoss.evaluate(position)  ← SAME code
                    TakeProfit.evaluate(position) ← SAME code
                         │
                         ▼
                    Settlement.resolve(position)  ← SAME code
```

---

## Alerting (Beyond Dashboard)

- Telegram/Discord bot for: circuit breaker trip, assertion failure, large drawdown, position stuck in UNKNOWN state
- Daily summary: trades, P&L, assertion pass rate, system uptime
- Webhook to Discord channel (10 lines of code)

## Audit Trail

Every decision must be reconstructable: "We entered because: CLOB was $0.54, VWAP said UP, canary strategy was active, risk check passed with $68 balance, order placed at 14:32:01.234."

---

## Key Existing Infrastructure

| Component | Status | Notes |
|---|---|---|
| Orchestrator (41 modules) | Operational but buggy | Dependency-ordered init works |
| Config system (V3 Philosophy) | Complete | Deep-frozen, unified |
| Circuit breaker (V3 Stage 5) | Implemented | Catches system failures only |
| Stop-loss module | Implemented but DISABLED | Needs enabling + testing |
| Take-profit module | Implemented but DISABLED | Needs enabling + testing |
| Safety module (drawdown) | Implemented but DISABLED | Limits set to null |
| Kill switch (separate process) | Implemented | NOT tested with Railway |
| Health endpoint | Working | `/api/live/status` on port 3333 |
| Position verifier | Partial | Needs expansion to full assertions |
| Paper trader + VWAP strategy | Implemented | Code path diverges from live |
| Backtest (3 modes) | Working | Needs signal-replay mode |
| Dashboard | Does not exist | Only JSON health endpoint |
| Runtime controls (DB-based) | Does not exist | Needs building |
| Feed gap monitoring | Does not exist | Needs building |
| Startup reconciliation | Does not exist | Needs building |
