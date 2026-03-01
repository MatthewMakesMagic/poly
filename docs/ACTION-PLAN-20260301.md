# Action Plan — Live Trading Framework
**Created**: 2026-03-01 | **Source**: PARTYMODE10326.md

---

## PHASE 0 — SURVIVE
> **Goal**: No capital at risk until every box is checked.

### 0.1 — P0 Bug Fixes
- [ ] Add test proving VWAP strategy rejects future windows (hotfix `ee64cac` exists but unverified)
- [ ] Enforce per-position dollar cap ($5 max) at order-manager level, not strategy level
- [ ] Fix `order_id` null constraint — write fails loudly if no ID
- [ ] Fix IOC `maxPrice` to use correct field for VWAP signals

### 0.2 — Enable Disabled Safeguards
- [ ] Stop-loss module: flip to ENABLED, set default threshold (e.g. 10%)
- [ ] Safety module: set daily drawdown limit (e.g. $20) — currently `null`
- [ ] Take-profit: set sensible default (e.g. 30% or trailing 20%)

### 0.3 — Runtime Controls (replace Railway env vars)
- [ ] Create `runtime_controls` table in PostgreSQL (key/value: kill_switch, trading_mode, max_position_usd, max_session_loss, allowed_instruments, allowed_strategies)
- [ ] Orchestrator reads `runtime_controls` every tick (1s cache)
- [ ] Add `POST /api/controls` endpoint to update runtime controls
- [ ] Implement 3-level kill switch: Pause / Flatten / Emergency
- [ ] Remove dependency on Railway env vars for operational controls

### 0.4 — Startup Safety
- [ ] Position reconciliation on startup — query Polymarket API, compare to DB, circuit breaker on mismatch
- [ ] Distributed lock in PostgreSQL — only one instance can hold `active_trader` lock
- [ ] Validate token IDs against Polymarket API on startup (not just cached)

### 0.5 — Order Execution Hardening
- [ ] Balance verification before every entry — query real Polymarket balance, not internal tracking
- [ ] Order confirmation loop — poll for fill within 5s, UNKNOWN state if no response, block re-entry
- [ ] Use actual fill amount from confirmation (not requested amount) — handles partial fills
- [ ] Hard cap: max 2 orders per window per instrument, hardcoded
- [ ] Capture fees from every fill, include in P&L

### 0.6 — Dry-Run Mode
- [ ] Implement DRY_RUN mode — full code path except final POST to Polymarket
- [ ] Log full order payload that would have been sent
- [ ] Simulate fill at current market price, track through full lifecycle
- [ ] Capture order book snapshot at decision time

### 0.7 — Unified Position Pipeline
- [ ] Unified `positions` table with `mode` column (PAPER, LIVE, DRY_RUN, BACKTEST)
- [ ] Single code path: `OrderManager.execute(signal, mode)` → mode determines fill source, everything downstream identical
- [ ] Remove paper/live position tracking divergence (the Jan bug)

---

## PHASE 1 — TEST HARNESS
> **Goal**: Prove the plumbing works end-to-end. Not about edge. About correctness.

### 1.1 — Canary Strategy
- [ ] Build `always-trade-canary` strategy: at T-60s, buy whichever side CLOB favors (>$0.50)
- [ ] Register in strategy framework with standard interface: `evaluate(windowState) → Signal | null`
- [ ] Minimum position size ($1), no stop-loss (run to settlement), all instruments

### 1.2 — Runtime Assertions Module
- [ ] Extend `position-verifier` into full assertions module running every tick
- [ ] Implement all 10 assertions (signal→order mapping, fill confirmation, position count match, P&L match, no null order_ids, instrument scope, no future windows, capital cap, heartbeat)
- [ ] Any assertion failure → circuit breaker OPEN → log exact failed assertion
- [ ] Surface assertion status in health endpoint

### 1.3 — Phase 1a: Manual Verification (2 windows)
- [ ] Run canary on 2 windows
- [ ] Manually verify all 10 points: signal→order→fill→position→monitoring→settlement→resolution→balance
- [ ] Cross-check resolution against Polymarket API
- [ ] Cross-check P&L against actual balance change

### 1.4 — Phase 1b: Unattended Verification (20 windows)
- [ ] Run canary for 20 windows unattended
- [ ] Verify zero assertion failures across all windows
- [ ] Confirm windows include both UP and DOWN resolutions
- [ ] Review all logged data for completeness

---

## PHASE 2 — RISK ENVELOPE VALIDATION
> **Goal**: Prove stop-losses and take-profits actually fire correctly on live positions.

### 2.1 — Position Lifecycle State Machine
- [ ] Implement state machine: ENTRY → MONITORING → {STOP_TRIGGERED | TP_TRIGGERED | EXPIRY} → EXIT_PENDING → CLOSED
- [ ] Single exit decision function with priority rules (stop-loss and take-profit don't independently act)
- [ ] Once EXIT_PENDING, nothing else can modify that position

### 2.2 — Stop-Loss Variation Testing
- [ ] Variant A: 5% stop, no TP — run 5+ windows, verify trigger
- [ ] Variant B: 15% stop, no TP — run 5+ windows, verify trigger
- [ ] Variant C: 5% stop + 20% TP — run 5+ windows, verify which triggers first
- [ ] Variant D: no stop + 10% trailing TP — run 5+ windows, verify trigger
- [ ] Variant E: 50% stop (control, should never fire) — run 5+ windows

### 2.3 — Per-Trigger Verification
- [ ] For every trigger event: verify trigger price matches threshold
- [ ] Verify exit order placed immediately on trigger
- [ ] Verify exit order filled
- [ ] Verify position closed in DB
- [ ] Verify balance reflects exit
- [ ] Track intended exit price vs actual exit price (slippage measurement)

---

## PHASE 3 — REAL STRATEGY DEPLOYMENT
> **Goal**: Deploy a real strategy inside the proven framework.

### 3.1 — Pre-Deployment Checklist
- [ ] Phase 1 canary: 20+ windows, zero assertion failures — CONFIRMED
- [ ] Phase 2 stop-loss variants: all verified correct — CONFIRMED
- [ ] Dashboard showing real-time state — CONFIRMED
- [ ] Runtime kill switch tested and working — CONFIRMED

### 3.2 — Strategy Deployment
- [ ] Strategy registered in framework with declared parameters
- [ ] Risk parameters set (position size, stop-loss, session max loss)
- [ ] Instruments scoped (start with most liquid — BTC)
- [ ] Pre-registered expected performance: win rate range, kill criterion
- [ ] First 10 windows: manual review of every trade
- [ ] Scale-up criteria defined before first trade

---

## PHASE 4 — DASHBOARD
> **Goal**: See everything. Every mode, every position, every assertion, every feed.

### 4.1 — Backend: Real-Time Data Layer
- [ ] Add WebSocket support to existing health endpoint (`ws` package)
- [ ] Pipe orchestrator events to WebSocket (signals, orders, fills, position updates, assertions)
- [ ] REST endpoints for historical queries (trade log, settlement history)
- [ ] Connect runtime controls table to `POST /api/controls`

### 4.2 — Frontend: Scaffold
- [ ] React + Vite project in `/dashboard` folder
- [ ] TailwindCSS for styling
- [ ] WebSocket connection to backend
- [ ] Deploy as static site (Railway/Vercel/Netlify)

### 4.3 — View 1: Command Center
- [ ] System status bar: LIVE/PAPER/STOPPED, balance, session P&L
- [ ] Kill switch buttons: PAUSE / FLATTEN / EMERGENCY STOP
- [ ] Active strategies panel (name, status, parameters)
- [ ] Open positions panel (instrument, direction, entry, current, P&L, stop-loss level)
- [ ] Activity feed (chronological: signals, orders, fills, assertions, window events)

### 4.4 — View 2: Instrument Deep Dive
- [ ] Per-instrument: current window, oracle prices, CLOB state
- [ ] Active positions for that instrument
- [ ] Feed health: last tick age per data source (green <2s, yellow <5s, red >5s)
- [ ] Strategy signals: what each strategy sees for this instrument now

### 4.5 — View 3: Risk Dashboard
- [ ] Session drawdown chart (real-time, Recharts)
- [ ] Per-strategy P&L breakdown
- [ ] Stop-loss / take-profit trigger history
- [ ] Runtime controls editor (read/write the `runtime_controls` table)
- [ ] Assertion board: green/red for each of 10 assertions + last run time

### 4.6 — View 4: Trade History
- [ ] Full trade log with filters (strategy, instrument, date, outcome)
- [ ] Settlement verification: our resolution vs Polymarket's
- [ ] Slippage analysis: intended vs actual entry/exit prices
- [ ] Fee accounting: gross vs net P&L
- [ ] Export to CSV

### 4.7 — System Health (always visible)
- [ ] Per-feed last-tick age
- [ ] DB connection pool usage
- [ ] Data completeness % per feed per window
- [ ] Clock sync offset
- [ ] Instance lock status ("sole trader" confirmed)

---

## PARALLEL TRACK — DATA CAPTURE HARDENING
> **Runs alongside all phases. Bad data = bad everything.**

### D.1 — Feed Monitoring
- [ ] Per-feed heartbeat monitor — alert if no tick >5s
- [ ] `feed_gaps` table: start/end timestamps for every gap
- [ ] Backtests exclude windows with feed gaps (or flag them)
- [ ] Dashboard: data completeness % per feed per window

### D.2 — Timestamp Integrity
- [ ] NTP sync verification on startup
- [ ] Store both receive timestamp AND source timestamp on every tick
- [ ] Log clock offset vs exchange server timestamps
- [ ] Document known latency offsets per source

### D.3 — Database Write Reliability
- [ ] Buffer overflow counter — if flush fails, retry once, log lost tick count
- [ ] Connection pool monitoring (alert at >80% utilization)
- [ ] Query timeout logging with full context
- [ ] All operational state in PostgreSQL — no local file dependencies

### D.4 — Window Event Integrity
- [ ] Cross-validate every window event against Polymarket API after settlement
- [ ] Fix `onchain_resolved_direction` always NULL
- [ ] Fix `conditionId` missing — capture at window open or derive from market lookup
- [ ] Log all discrepancies

### D.5 — CLOB Data Quality
- [ ] Enforce `window_epoch` + `timestamp >= to_timestamp(window_epoch)` filter in data loader (not strategy)
- [ ] Track and display actual CLOB capture rate (ticks/second)
- [ ] Dedup exchange ticks by trade ID, log out-of-order count

---

## PARALLEL TRACK — ALERTING
> **Dashboard is useless if Matthew's asleep.**

- [ ] Discord/Telegram webhook for: circuit breaker trip, assertion failure, large drawdown, position in UNKNOWN state
- [ ] Daily summary message: trades, P&L, assertion pass rate, uptime
- [ ] Health endpoint failure → alert (not just log)

---

## PARALLEL TRACK — AUDIT TRAIL
> **Every decision reconstructable after the fact.**

- [ ] Every entry logged with full context: CLOB price, strategy signal, risk check result, balance at time, order payload, timestamp to millisecond
- [ ] Every exit logged: trigger reason, intended vs actual price, slippage, fees
- [ ] Decision log queryable from dashboard (View 4) and exportable

---

## FUTURE (not yet — noted for reference)
- Paper trading UI (requires significant backtest async improvements)
- Strategy hot-deployment (drop in a module, config picks it up)
- Improved backtesting: signal-replay mode, strategy variation sweeps
- Database restructuring for multi-strategy multi-instrument position management
- More exchange feeds (currently 5 of 16+ oracle uses)
- Live performance vs backtest confidence interval comparison
