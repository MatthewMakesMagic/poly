---
stepsCompleted: [1, 2, 3, 4]
status: complete
completedAt: '2026-01-30'
inputDocuments:
  - prd.md
  - architecture.md
---

# poly - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for poly, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**Strategy Execution (FR1-5):**
- FR1: System can execute trading strategies against live Polymarket windows
- FR2: System can evaluate entry conditions against real-time market state
- FR3: System can evaluate exit conditions (stop-loss, take-profit, window expiry)
- FR4: System can size positions based on configurable parameters and available liquidity
- FR5: System can respect configurable position limits and exposure caps

**Position Management (FR6-10):**
- FR6: System can track all open positions with current state
- FR7: System can reconcile in-memory position state with exchange state
- FR8: System can close positions through normal exit or emergency kill
- FR9: System can report position status on demand
- FR10: System can prevent opening positions that would exceed limits

**Order Management (FR11-15):**
- FR11: System can place orders through Polymarket CLOB API
- FR12: System can track orders from submission to fill/cancel/expiry
- FR13: System can handle partial fills appropriately
- FR14: System can cancel open orders on demand
- FR15: System can log latency for every order operation

**State Management (FR16-19):**
- FR16: System can persist state to durable storage (positions, orders, logs)
- FR17: System can reconcile in-memory state with persistent state on restart
- FR18: System can detect and report state divergence between memory, database, and exchange
- FR19: System can recover to known-good state after crash or kill

**Monitoring & Logging (FR20-24):**
- FR20: System can produce structured JSON logs for every trade event
- FR21: System can log expected vs. actual for each signal and execution
- FR22: System can detect divergence from expected behavior
- FR23: System can alert on divergence with structured diagnostic
- FR24: System can operate silently when behavior matches expectations

**Safety Controls (FR25-29):**
- FR25: User can trigger kill switch to halt all trading within 5 seconds
- FR26: Kill switch can operate even if main process is unresponsive
- FR27: System can document exact state at time of kill for reconciliation
- FR28: System can enforce configurable drawdown limits
- FR29: System can auto-stop when drawdown limits breached

**Strategy Composition (FR30-34):**
- FR30: Strategies can be composed from reusable components (probability logic, entry rules, exit rules, sizing)
- FR31: Components can be versioned independently
- FR32: System can track which component versions a strategy uses
- FR33: User can fork a strategy to create a variation with modified components
- FR34: User can update a central component when change is a core improvement

**Configuration (FR35-37):**
- FR35: User can configure strategy parameters without code changes
- FR36: User can configure risk limits (position size, exposure, drawdown)
- FR37: User can configure API credentials securely outside codebase

### NonFunctional Requirements

**Performance (NFR1-5):**
- NFR1: Order placement completes within 500ms under normal conditions
- NFR2: Kill switch halts all activity within 5 seconds of trigger
- NFR3: State reconciliation completes within 10 seconds on restart
- NFR4: System logs latency for every order operation for monitoring
- NFR5: Market data processing keeps pace with real-time feed (no lag accumulation)

**Reliability (NFR6-10):**
- NFR6: System recovers to known-good state after any crash or kill
- NFR7: No orphaned positions under any failure scenario
- NFR8: State persisted to disk before acknowledging any position change
- NFR9: 100% of trade events produce complete structured log (no gaps)
- NFR10: System detects and reports state divergence between memory/database/exchange

**Security (NFR11-13):**
- NFR11: API credentials stored outside codebase (environment or secure file)
- NFR12: API credentials never logged or exposed in diagnostics
- NFR13: Credentials support rotation without code changes

**Integration (NFR14-17):**
- NFR14: System handles Polymarket API disconnects with automatic reconnection
- NFR15: System respects rate limits and backs off gracefully when limits hit
- NFR16: System detects and logs API response anomalies (unexpected formats, errors)
- NFR17: Spot price feed failures trigger alerts, not silent degradation

### Additional Requirements

**From Architecture - Project Setup:**
- Brownfield project (no starter template) - rebuild core modules from existing codebase
- Folder-per-module structure: `src/modules/{module-name}/` with `index.js`, `logic.js`, `state.js`, `types.js`
- Test co-location: `__tests__/` folder within each module
- Configuration pattern: `config/default.js` loaded at startup, passed via `init(config)`

**From Architecture - Module Interface Contract:**
- All modules MUST export: `init(config)`, `getState()`, `shutdown()`
- All public functions return Promises (async)
- Errors thrown via typed error classes with `code`, `message`, `context`
- Modules never import each other directly - all coordination through orchestrator

**From Architecture - Database Schema (6 tables):**
- `trade_intents` - Write-ahead logging for crash recovery
- `positions` - Position state with exchange verification
- `orders` - Order lifecycle with latency tracking
- `trade_events` - Detailed diagnostics with slippage/latency columns
- `strategy_instances` - Strategy composition registry
- `daily_performance` - Drawdown tracking for safety

**From Architecture - Naming Conventions:**
- Files/Folders: kebab-case (`position-manager.js`)
- Functions: camelCase (`getPosition()`)
- Constants: UPPER_SNAKE (`MAX_POSITION_SIZE`)
- DB Tables/Columns: snake_case (`trade_intents`, `window_id`)
- Log Fields: snake_case (`expected_price`, `actual_price`)

**From Architecture - Structured Logging:**
- Every log entry MUST include: timestamp, level, module, event
- Optional fields: data (with expected/actual), context, error
- JSON format with schema validation at runtime

**From Architecture - Kill Switch:**
- Separate watchdog process in `kill-switch/` directory
- Shared state file: `data/last-known-state.json`
- Kill sequence: graceful signal → 2s timeout → SIGKILL → state snapshot

**From Architecture - Borrowed Components (validate, don't rebuild):**
- Polymarket API client (`src/clients/polymarket/`)
- CLOB order mechanics
- Spot price feed client (`src/clients/spot/`)
- Price normalization logic

### FR Coverage Map

| FR | Epic | Description |
|----|------|-------------|
| FR1 | Epic 3 | Execute strategies against live windows |
| FR2 | Epic 3 | Evaluate entry conditions |
| FR3 | Epic 3 | Evaluate exit conditions (SL/TP/expiry) |
| FR4 | Epic 3 | Size positions based on config + liquidity |
| FR5 | Epic 3 | Respect position limits and exposure caps |
| FR6 | Epic 2 | Track all open positions |
| FR7 | Epic 2 | Reconcile position state with exchange |
| FR8 | Epic 2 | Close positions (normal or emergency) |
| FR9 | Epic 2 | Report position status on demand |
| FR10 | Epic 2 | Prevent positions exceeding limits |
| FR11 | Epic 2 | Place orders through CLOB API |
| FR12 | Epic 2 | Track orders to fill/cancel/expiry |
| FR13 | Epic 2 | Handle partial fills |
| FR14 | Epic 2 | Cancel open orders on demand |
| FR15 | Epic 2 | Log latency for every order |
| FR16 | Epic 1 | Persist state to durable storage |
| FR17 | Epic 1 | Reconcile memory with persistent state |
| FR18 | Epic 1 | Detect state divergence |
| FR19 | Epic 1 | Recover to known-good state |
| FR20 | Epic 5 | Produce structured JSON logs |
| FR21 | Epic 5 | Log expected vs actual |
| FR22 | Epic 5 | Detect divergence from expected |
| FR23 | Epic 5 | Alert on divergence with diagnostic |
| FR24 | Epic 5 | Operate silently when matching |
| FR25 | Epic 4 | Kill switch halts in 5 seconds |
| FR26 | Epic 4 | Kill switch works if main unresponsive |
| FR27 | Epic 4 | Document state at kill time |
| FR28 | Epic 4 | Enforce drawdown limits |
| FR29 | Epic 4 | Auto-stop on drawdown breach |
| FR30 | Epic 6 | Compose strategies from components |
| FR31 | Epic 6 | Version components independently |
| FR32 | Epic 6 | Track component versions per strategy |
| FR33 | Epic 6 | Fork strategies for variations |
| FR34 | Epic 6 | Update central components |
| FR35 | Epic 1 | Configure strategy params without code |
| FR36 | Epic 1 | Configure risk limits |
| FR37 | Epic 1 | Configure credentials securely |

---

## Epic List

### Epic 1: Foundation & Persistence
**User Value:** System has reliable infrastructure with crash recovery - the foundation for "no orphaned state"

This establishes the trust foundation. After this epic, the system can persist state, recover from any crash, and produce structured logs. All subsequent epics build on this reliable base.

**FRs covered:** FR16, FR17, FR18, FR19, FR35, FR36, FR37

**Scope:**
- Project structure setup (folder-per-module architecture)
- SQLite database with full schema (6 tables)
- Write-ahead logging implementation
- Logger module with structured JSON format
- Configuration loading pattern
- Shared types and error definitions

---

### Epic 2: Trading Operations
**User Value:** System can place orders and manage positions reliably

After this epic, you can place orders through Polymarket, track their lifecycle, and maintain accurate position state with exchange reconciliation.

**FRs covered:** FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR14, FR15

**Scope:**
- Order manager module (lifecycle, latency tracking)
- Position manager module (state, reconciliation)
- Polymarket API client integration
- Spot price feed client integration

**⚠️ CRITICAL - Execution Provider Integration:**
When integrating Polymarket (or any execution provider):
1. **Deep API Understanding:** Document every API endpoint, parameter, response format, and edge case before writing integration code
2. **Behavior Validation:** Test API behavior extensively in sandbox/testnet before live integration
3. **Document Learnings:** Once validated, save API behavior documentation as permanent workflow reference
4. **Rate Limits & Errors:** Understand and document all rate limits, error codes, and retry semantics
5. **State Mapping:** Clearly map Polymarket order/position states to our internal states

This rigor prevents "borrowed code that looks right but fails in production" - the exact problem we're solving with this rebuild.

---

### Epic 3: Strategy Execution
**User Value:** System executes trades according to strategy logic with proper entry/exit conditions

After this epic, the system runs the trading strategy, evaluates entry conditions against market state, and manages exits (stop-loss, take-profit, window expiry).

**FRs covered:** FR1, FR2, FR3, FR4, FR5

**Scope:**
- Orchestrator module (execution loop, coordination)
- Stop-loss module
- Take-profit module
- Strategy evaluation logic
- Position sizing with liquidity awareness

---

### Epic 4: Safety Controls
**User Value:** I can stop everything instantly and enforce risk limits

After this epic, you have a working kill switch (<5s to halt) and automatic drawdown protection. Critical safety infrastructure for live trading confidence.

**FRs covered:** FR25, FR26, FR27, FR28, FR29

**Scope:**
- Kill switch watchdog (separate process)
- State snapshot on kill
- Drawdown limit enforcement
- Auto-stop on limit breach
- Safety module

---

### Epic 5: Monitoring & Diagnostics
**User Value:** Every trade is fully explainable - I can understand divergence and trust the system

After this epic, the system detects when behavior deviates from expectation, alerts with structured diagnostics, and operates silently when everything matches. Enables the "100% diagnostic coverage" trust metric.

**FRs covered:** FR20, FR21, FR22, FR23, FR24

**Scope:**
- Divergence detection logic
- Expected vs actual comparison
- Structured diagnostic alerts
- Silent operation mode
- Diagnostic flags system

---

### Epic 6: Strategy Composition
**User Value:** I can compose and evolve strategies - fork variations, update components, track versions

After this epic, strategies are composed from versioned components, can be forked for hypothesis testing, and centrally updated when improvements are proven. Enables the "hypothesis → validation" learning velocity.

**FRs covered:** FR30, FR31, FR32, FR33, FR34

**Scope:**
- Strategy composer module
- Component version registry
- Strategy forking mechanism
- Central component updates
- Version lineage tracking

---

## Epic Dependencies

```
Epic 1: Foundation & Persistence
    ↓ (provides persistence, logging, config)
Epic 2: Trading Operations
    ↓ (provides order/position management)
Epic 3: Strategy Execution
    ↓ (provides live trading capability)
Epic 4: Safety Controls ←── Critical before live trading
    ↓
Epic 5: Monitoring & Diagnostics
    ↓
Epic 6: Strategy Composition
```

Each epic is **standalone** - Epic 2 works without Epic 3, Epic 3 works without Epic 4, etc. But the natural flow delivers increasing value toward the complete MVP.

---

## Epic 1: Foundation & Persistence

**User Value:** System has reliable infrastructure with crash recovery - the foundation for "no orphaned state"

### Story 1.1: Project Structure & Configuration

As a **developer (human or AI agent)**,
I want **a consistent folder-per-module project structure with configuration loading**,
So that **I can work on isolated modules with clear boundaries and externalized settings**.

**Acceptance Criteria:**

**Given** the project is initialized
**When** I inspect the directory structure
**Then** I see `src/modules/`, `src/types/`, `src/persistence/`, `src/clients/`, `config/`, `cli/`, `kill-switch/` directories
**And** each module folder contains `index.js` as the public interface

**Given** configuration files exist in `config/`
**When** the application starts
**Then** configuration is loaded from `config/default.js`
**And** environment-specific overrides are applied (development.js or production.js)
**And** `.env` values are available for credentials (FR37)

**Given** shared types are needed
**When** I import from `src/types/`
**Then** I have access to position, order, trade-log, and error type definitions
**And** error classes include `code`, `message`, and `context` properties

---

### Story 1.2: SQLite Database & Core Schema

As a **system operator**,
I want **a SQLite database initialized with the trade_intents table**,
So that **the system can persist state and recover from crashes (FR16)**.

**Acceptance Criteria:**

**Given** the application starts for the first time
**When** the persistence layer initializes
**Then** SQLite database is created at `data/poly.db`
**And** the `trade_intents` table exists with columns: id, intent_type, window_id, payload, status, created_at, completed_at, result
**And** indexes exist on `status` and `window_id`

**Given** the database already exists
**When** the application starts
**Then** the existing database is used without data loss
**And** schema migrations run if needed

**Given** a database operation fails
**When** the error is caught
**Then** a typed error with code and context is thrown (not swallowed)

---

### Story 1.3: Write-Ahead Logging

As a **system operator**,
I want **every state-changing operation to log intent before execution**,
So that **the system knows what was attempted and can recover from any crash (FR16, FR19)**.

**Acceptance Criteria:**

**Given** any state-changing operation is about to occur
**When** the operation begins
**Then** an intent record is inserted with status='pending' BEFORE the action executes
**And** the intent includes: intent_type, window_id, payload (JSON), created_at

**Given** an intent has been logged
**When** the operation starts executing
**Then** the intent status is updated to 'executing'

**Given** an operation completes successfully
**When** the result is confirmed
**Then** the intent status is updated to 'completed'
**And** completed_at timestamp is set
**And** result JSON contains the outcome

**Given** an operation fails
**When** the error is caught
**Then** the intent status is updated to 'failed'
**And** result JSON contains the error details

---

### Story 1.4: Logger Module

As a **developer**,
I want **a structured JSON logging module**,
So that **every trade event produces complete, queryable logs (FR20, NFR9)**.

**Acceptance Criteria:**

**Given** any module needs to log an event
**When** logger.info/warn/error is called
**Then** a JSON log entry is produced with required fields: timestamp, level, module, event
**And** optional fields (data, context, error) are included when provided

**Given** a log entry is created
**When** the entry is written
**Then** the timestamp is ISO format (e.g., "2026-01-30T10:15:30.123Z")
**And** the level is one of: info, warn, error
**And** field names use snake_case convention

**Given** the logger module is initialized
**When** init(config) is called
**Then** the logger respects the configured log level
**And** logs are written to `logs/` directory
**And** the module exports: init(), getState(), shutdown()

**Given** sensitive data might be logged
**When** credentials or API keys appear in log data
**Then** they are redacted or never included (NFR12)

---

### Story 1.5: State Reconciliation on Startup

As a **system operator**,
I want **the system to detect and report incomplete operations on restart**,
So that **I can reconcile state and ensure no orphaned positions (FR17, FR18, FR19)**.

**Acceptance Criteria:**

**Given** the application starts
**When** the persistence layer initializes
**Then** it queries for intents with status='executing'
**And** any found are reported as "incomplete intents requiring reconciliation"

**Given** incomplete intents are found
**When** the reconciliation check runs
**Then** each incomplete intent is logged with level='warn'
**And** the log includes: intent_type, window_id, created_at, payload
**And** the system does NOT automatically retry (manual reconciliation required)

**Given** no incomplete intents exist
**When** the application starts
**Then** startup completes normally
**And** an info log confirms "State reconciliation complete - no incomplete intents"

**Given** state divergence is detected (FR18)
**When** memory state differs from database state
**Then** a divergence event is logged with both states
**And** the system alerts (does not silently continue)

---

## Epic 2: Trading Operations

**User Value:** System can place orders and manage positions reliably

### Story 2.1: Polymarket API Client Integration

As a **developer**,
I want **the Polymarket API client integrated with documented behavior**,
So that **I understand exactly how the API works before trusting it with real orders**.

**Acceptance Criteria:**

**Given** the Polymarket client is borrowed from existing code
**When** integrating into `src/clients/polymarket/`
**Then** the client is wrapped with our module interface (init, getState, shutdown)
**And** authentication uses credentials from config (never hardcoded)

**Given** API integration begins
**When** documenting API behavior
**Then** every endpoint used is documented with: URL, parameters, response format, error codes
**And** rate limits are documented and respected (NFR15)
**And** documentation is saved as `src/clients/polymarket/API_BEHAVIOR.md`

**Given** the client is initialized
**When** connection to Polymarket fails
**Then** a typed error is thrown with context
**And** the error is logged with level='error'
**And** automatic reconnection is attempted with backoff (NFR14)

**Given** an API response is received
**When** the response format is unexpected (NFR16)
**Then** the anomaly is logged with the actual response
**And** the operation fails gracefully (not silent corruption)

---

### Story 2.2: Order Manager - Place & Track Orders

As a **trader**,
I want **to place orders through the CLOB API and track their lifecycle**,
So that **I know the exact state of every order from submission to completion (FR11, FR12)**.

**Acceptance Criteria:**

**Given** an order needs to be placed
**When** orderManager.placeOrder() is called
**Then** a write-ahead intent is logged BEFORE the API call
**And** the order is submitted to Polymarket CLOB
**And** latency from submit to acknowledgment is recorded (FR15, NFR4)

**Given** an order is submitted
**When** the exchange acknowledges the order
**Then** a record is inserted into `orders` table with status='open'
**And** the `orders` table includes: order_id, intent_id, window_id, market_id, token_id, side, order_type, price, size, status, submitted_at, latency_ms

**Given** an order fills completely
**When** fill confirmation is received
**Then** order status is updated to 'filled'
**And** filled_at timestamp and avg_fill_price are recorded
**And** the write-ahead intent is marked 'completed'

**Given** an order expires or is rejected
**When** the terminal state is received
**Then** order status is updated accordingly ('expired', 'cancelled')
**And** the write-ahead intent is marked 'completed' with result details

**Given** the order manager module
**When** inspecting its interface
**Then** it exports: init(), placeOrder(), getOrder(), getOpenOrders(), getState(), shutdown()

---

### Story 2.3: Order Manager - Partial Fills & Cancellation

As a **trader**,
I want **partial fills handled correctly and the ability to cancel orders**,
So that **I have full control over order lifecycle (FR13, FR14)**.

**Acceptance Criteria:**

**Given** an order receives a partial fill
**When** the partial fill event is received
**Then** order status is updated to 'partially_filled'
**And** filled_size is updated with cumulative filled amount
**And** avg_fill_price is recalculated

**Given** a partially filled order completes
**When** the final fill is received
**Then** order status is updated to 'filled'
**And** filled_size equals the total filled (may be less than requested size)

**Given** an open order needs to be cancelled
**When** orderManager.cancelOrder(orderId) is called
**Then** a write-ahead intent is logged for the cancellation
**And** cancel request is sent to Polymarket
**And** order status is updated to 'cancelled' on confirmation

**Given** a cancel request fails
**When** the order was already filled or doesn't exist
**Then** the error is logged with context
**And** a typed error is thrown (not swallowed)
**And** the intent is marked 'failed' with reason

---

### Story 2.4: Spot Price Feed Integration

As a **trader**,
I want **real-time spot price data with reliable error handling**,
So that **strategy decisions are based on current market state (NFR5, NFR17)**.

**Acceptance Criteria:**

**Given** the spot price client is borrowed from existing code
**When** integrating into `src/clients/spot/`
**Then** the client is wrapped with our module interface (init, getState, shutdown)
**And** price normalization logic is included

**Given** the spot feed is connected
**When** price updates are received
**Then** processing keeps pace with real-time feed (no lag accumulation - NFR5)
**And** prices are normalized to consistent format

**Given** the spot feed disconnects
**When** connection is lost
**Then** an alert is triggered immediately (NFR17)
**And** automatic reconnection is attempted
**And** the system does NOT silently continue with stale prices

**Given** reconnection succeeds
**When** the feed is restored
**Then** an info log confirms reconnection
**And** price processing resumes normally

**Given** the spot client module
**When** inspecting its interface
**Then** it exports: init(), getCurrentPrice(), subscribe(), getState(), shutdown()

---

### Story 2.5: Position Manager - Track Positions

As a **trader**,
I want **all open positions tracked with current state**,
So that **I always know my exact exposure (FR6, FR9)**.

**Acceptance Criteria:**

**Given** a new position is opened
**When** an order fills that creates a position
**Then** a record is inserted into `positions` table
**And** the table includes: id, window_id, market_id, token_id, side, size, entry_price, current_price, status, strategy_id, opened_at, exchange_verified_at

**Given** positions exist in the database
**When** positionManager.getPositions() is called
**Then** all open positions are returned with current state
**And** in-memory state matches database state

**Given** a position's market price changes
**When** price updates are received
**Then** current_price is updated in memory
**And** updates are persisted periodically (not on every tick)

**Given** position status is requested
**When** positionManager.getPosition(id) or CLI status command runs
**Then** complete position details are returned (FR9)
**And** includes: entry_price, current_price, unrealized P&L, size, strategy

**Given** the position manager module
**When** inspecting its interface
**Then** it exports: init(), addPosition(), getPosition(), getPositions(), closePosition(), getState(), shutdown()

---

### Story 2.6: Position Manager - Reconciliation & Limits

As a **trader**,
I want **position state reconciled with the exchange and limits enforced**,
So that **I never have orphaned positions or exceed risk limits (FR7, FR8, FR10)**.

**Acceptance Criteria:**

**Given** the system starts or reconciliation is triggered
**When** positionManager.reconcile() is called
**Then** exchange API is queried for current positions
**And** exchange state is compared to local database state
**And** any divergence is logged with both states (FR7)

**Given** reconciliation finds a divergence
**When** exchange has a position we don't have locally
**Then** a warning alert is raised
**And** the orphan is logged for manual review
**And** exchange_verified_at is NOT updated until resolved

**Given** a new position would exceed limits
**When** the position is requested (FR10)
**Then** the system checks against configured limits (FR36)
**And** if limit would be exceeded, the request is rejected
**And** a typed error with code='POSITION_LIMIT_EXCEEDED' is thrown

**Given** a position needs to be closed
**When** positionManager.closePosition() is called (FR8)
**Then** a write-ahead intent is logged
**And** a sell order is placed to close the position
**And** on fill, position status is updated to 'closed'
**And** close_price, closed_at, and pnl are recorded

**Given** an emergency close is needed
**When** closePosition() is called with emergency=true
**Then** the close happens via market order (not limit)
**And** the intent type is 'emergency_close'

---

## Epic 3: Strategy Execution

**User Value:** System executes trades according to strategy logic with proper entry/exit conditions

### Story 3.1: Orchestrator Module & Execution Loop

As a **trader**,
I want **a central coordinator running the execution loop**,
So that **all modules work together without coupling to each other (FR1)**.

**Acceptance Criteria:**

**Given** the orchestrator is the central coordinator
**When** modules need to interact
**Then** all coordination flows through the orchestrator
**And** modules NEVER import each other directly

**Given** the system starts
**When** orchestrator.init(config) is called
**Then** all modules are initialized in correct order: logger → persistence → clients → position-manager → order-manager → strategy modules
**And** each module receives its config via init()

**Given** trading windows are active
**When** the execution loop runs
**Then** market data is fetched via spot client
**And** strategy evaluation is triggered
**And** entry/exit decisions flow to order manager
**And** the loop respects rate limits and timing

**Given** an error occurs in any module
**When** the error propagates to orchestrator
**Then** it is logged with full context
**And** the orchestrator decides: retry, alert, or shutdown
**And** errors are NEVER swallowed silently

**Given** shutdown is requested
**When** orchestrator.shutdown() is called
**Then** all modules are shut down in reverse order
**And** each module's shutdown() is awaited
**And** graceful completion is logged

**Given** the orchestrator module
**When** inspecting its interface
**Then** it exports: init(), start(), stop(), getState(), shutdown()

---

### Story 3.2: Strategy Entry Evaluation

As a **trader**,
I want **entry conditions evaluated against real-time market state**,
So that **I open positions only when strategy criteria are met (FR2)**.

**Acceptance Criteria:**

**Given** the execution loop is running
**When** market data is received
**Then** entry conditions are evaluated against current state
**And** evaluation includes: spot price, market price, time remaining in window

**Given** entry conditions are met
**When** strategy signals "enter position"
**Then** the signal includes: direction (long/short), confidence, market_id, window_id
**And** the signal is logged with all evaluation inputs

**Given** entry conditions are NOT met
**When** strategy evaluation completes
**Then** no action is taken
**And** the system continues monitoring (silent operation)

**Given** multiple windows are available
**When** evaluating entry conditions
**Then** each window is evaluated independently
**And** positions can be opened in multiple windows if criteria met

**Given** a strategy evaluates entry
**When** logging the evaluation
**Then** the log includes: expected conditions, actual values, decision made
**And** this enables post-mortem analysis of "why did we enter?"

---

### Story 3.3: Position Sizing & Liquidity

As a **trader**,
I want **positions sized based on config and available liquidity**,
So that **I don't exceed risk limits or move the market (FR4, FR5)**.

**Acceptance Criteria:**

**Given** an entry signal is generated
**When** calculating position size
**Then** base size comes from strategy config (FR35)
**And** size is adjusted based on available orderbook liquidity
**And** size respects maximum position size limit (FR36)

**Given** liquidity is thin
**When** orderbook depth is less than desired size
**Then** position size is reduced to available liquidity
**And** a warning is logged: "Size reduced due to liquidity"
**And** the trade proceeds with reduced size (not rejected)

**Given** position would exceed exposure cap
**When** total exposure + new position > max exposure (FR5)
**Then** position size is reduced to fit within cap
**Or** the trade is rejected if minimum size not achievable
**And** rejection is logged with code='EXPOSURE_CAP_EXCEEDED'

**Given** sizing is calculated
**When** the result is returned
**Then** it includes: requested_size, actual_size, reason_for_adjustment
**And** this is logged for diagnostics

---

### Story 3.4: Stop-Loss Module

As a **trader**,
I want **stop-loss conditions evaluated and positions closed when hit**,
So that **losses are limited according to my risk parameters (FR3)**.

**Acceptance Criteria:**

**Given** an open position exists
**When** the stop-loss module evaluates
**Then** current price is compared to stop-loss threshold
**And** threshold is calculated from entry_price and configured stop-loss %

**Given** price crosses stop-loss threshold
**When** stop-loss is triggered
**Then** orchestrator is notified to close position
**And** close is executed as market order (immediate exit)
**And** the event is logged: "Stop-loss triggered at price X, threshold was Y"

**Given** price is above stop-loss threshold
**When** stop-loss evaluates
**Then** no action is taken
**And** monitoring continues silently

**Given** the stop-loss module
**When** inspecting its interface
**Then** it exports: init(), evaluate(position), getState(), shutdown()
**And** evaluate() returns: { triggered: boolean, reason?: string }

**Given** stop-loss configuration
**When** reading from config
**Then** stop-loss % is configurable per strategy (FR35)
**And** default stop-loss is applied if not specified

---

### Story 3.5: Take-Profit Module

As a **trader**,
I want **take-profit conditions evaluated and positions closed when hit**,
So that **I lock in gains according to my strategy (FR3)**.

**Acceptance Criteria:**

**Given** an open position exists
**When** the take-profit module evaluates
**Then** current price is compared to take-profit threshold
**And** threshold is calculated from entry_price and configured take-profit %

**Given** price crosses take-profit threshold
**When** take-profit is triggered
**Then** orchestrator is notified to close position
**And** close is executed (can be limit order for better fill)
**And** the event is logged: "Take-profit triggered at price X, threshold was Y"

**Given** price is below take-profit threshold
**When** take-profit evaluates
**Then** no action is taken
**And** monitoring continues silently

**Given** the take-profit module
**When** inspecting its interface
**Then** it exports: init(), evaluate(position), getState(), shutdown()
**And** evaluate() returns: { triggered: boolean, reason?: string }

**Given** take-profit configuration
**When** reading from config
**Then** take-profit % is configurable per strategy (FR35)
**And** default take-profit is applied if not specified

---

### Story 3.6: Window Expiry Handling

As a **trader**,
I want **15-minute window expiry handled correctly**,
So that **positions resolve properly at window end (FR3)**.

**Acceptance Criteria:**

**Given** a position is open in a window
**When** the window approaches expiry (e.g., 30 seconds remaining)
**Then** the system logs "Window expiring soon" with position details
**And** no new positions are opened in this window

**Given** a window expires
**When** resolution occurs
**Then** position outcome is determined by resolution (win/lose)
**And** position status is updated to 'closed' or 'resolved'
**And** pnl is calculated and recorded

**Given** the system is tracking window timing
**When** evaluating trades
**Then** time remaining in window is always known
**And** this is logged with every trade decision

**Given** a position exists at expiry
**When** the window resolves
**Then** the resolution price/outcome is recorded
**And** the event is logged with full details
**And** the position is marked closed with reason='window_expiry'

---

## Epic 4: Safety Controls

**User Value:** I can stop everything instantly and enforce risk limits

### Story 4.1: Kill Switch Watchdog Process

As a **trader**,
I want **a separate watchdog process that can kill trading instantly**,
So that **I can stop everything in <5 seconds even if the main process is hung (FR25, FR26)**.

**Acceptance Criteria:**

**Given** the system is running
**When** the watchdog process starts
**Then** it runs as a separate Node.js process in `kill-switch/`
**And** it monitors the main process health
**And** it has its own PID independent of main process

**Given** a kill command is issued
**When** user runs `cli kill` or sends SIGTERM
**Then** watchdog sends graceful shutdown signal to main process
**And** if no response within 2 seconds, watchdog sends SIGKILL
**And** total time from command to halt is <5 seconds (NFR2)

**Given** the main process is hung/unresponsive
**When** kill is triggered (FR26)
**Then** watchdog can still execute (separate process)
**And** SIGKILL forcibly terminates main process
**And** watchdog logs "Forced kill executed - main process unresponsive"

**Given** the watchdog module
**When** inspecting its interface
**Then** it runs standalone via `node kill-switch/watchdog.js`
**And** it accepts commands: start, stop, kill, status

---

### Story 4.2: State Snapshot on Kill

As a **trader**,
I want **exact state documented at kill time**,
So that **I know exactly what's open, closed, and pending for reconciliation (FR27)**.

**Acceptance Criteria:**

**Given** a kill is executed
**When** the system halts
**Then** watchdog writes state snapshot to `data/last-known-state.json`
**And** snapshot includes: all open positions, all pending orders, timestamp

**Given** the main process shuts down gracefully
**When** shutdown completes
**Then** it writes final state to the shared state file
**And** watchdog confirms state file is current

**Given** a forced kill (SIGKILL) occurs
**When** main process is terminated
**Then** watchdog writes snapshot from last-known state
**And** snapshot is marked with "forced_kill: true"
**And** log warns "State snapshot from last known - verify with exchange"

**Given** post-kill reconciliation is needed
**When** user reviews `last-known-state.json`
**Then** they can see exactly: positions (with sizes, entries), orders (with statuses), last update time
**And** this enables manual verification against exchange

---

### Story 4.3: Drawdown Tracking

As a **trader**,
I want **daily drawdown tracked continuously**,
So that **I know my current risk exposure (FR28)**.

**Acceptance Criteria:**

**Given** a new trading day begins
**When** the system starts or date changes
**Then** a record is created in `daily_performance` table
**And** starting_balance is captured

**Given** trades execute throughout the day
**When** positions close with realized P&L
**Then** realized_pnl is updated
**And** current_balance is recalculated
**And** drawdown_pct = (starting - current) / starting

**Given** unrealized P&L changes
**When** position prices update
**Then** unrealized_pnl is recalculated
**And** drawdown_pct includes unrealized losses

**Given** drawdown is queried
**When** safety module checks current drawdown
**Then** current drawdown_pct is returned
**And** max_drawdown_pct (worst today) is also tracked

---

### Story 4.4: Drawdown Limit Enforcement & Auto-Stop

As a **trader**,
I want **automatic stop when drawdown limits are breached**,
So that **I don't lose more than my configured risk tolerance (FR28, FR29)**.

**Acceptance Criteria:**

**Given** drawdown limits are configured (FR36)
**When** config is loaded
**Then** daily_drawdown_limit_pct is read (e.g., 5%)
**And** this limit is enforced by the safety module

**Given** current drawdown approaches limit
**When** drawdown_pct > (limit - warning_threshold)
**Then** a warning is logged: "Drawdown at X%, limit is Y%"
**And** trading continues but with alert

**Given** drawdown exceeds limit
**When** drawdown_pct >= daily_drawdown_limit_pct (FR29)
**Then** auto-stop is triggered immediately
**And** all open orders are cancelled
**And** no new positions are opened
**And** log shows: "AUTO-STOP: Drawdown limit breached"

**Given** auto-stop has been triggered
**When** user wants to resume trading
**Then** manual intervention is required
**And** system does NOT auto-resume

**Given** the safety module
**When** inspecting its interface
**Then** it exports: init(), checkDrawdown(), isAutoStopped(), getState(), shutdown()

---

## Epic 5: Monitoring & Diagnostics

**User Value:** Every trade is fully explainable - I can understand divergence and trust the system

### Story 5.1: Trade Event Logging with Expected vs Actual

As a **trader**,
I want **every trade event logged with expected vs actual values**,
So that **I can analyze why trades performed as they did (FR20, FR21)**.

**Acceptance Criteria:**

**Given** any trade event occurs (signal, entry, exit)
**When** the event is logged
**Then** it includes expected values (what strategy predicted)
**And** it includes actual values (what really happened)
**And** format follows structured JSON schema

**Given** a trade entry occurs
**When** logging the event
**Then** record is inserted into `trade_events` table
**And** includes: price_at_signal, expected_price, price_at_fill
**And** includes all timestamp columns for latency analysis

**Given** the trade_events table
**When** analyzing past trades
**Then** slippage_vs_expected is queryable directly
**And** latency_total_ms is queryable directly
**And** no JSON parsing needed for core metrics

**Given** 100% diagnostic coverage is required (NFR9)
**When** any trade-related action occurs
**Then** a corresponding log entry exists
**And** no gaps in the event stream

---

### Story 5.2: Latency & Slippage Recording

As a **trader**,
I want **latency and slippage explicitly recorded**,
So that **I can identify execution quality issues (FR15, FR21)**.

**Acceptance Criteria:**

**Given** an order is placed
**When** the order lifecycle completes
**Then** these timestamps are recorded: signal_detected_at, order_submitted_at, order_acked_at, order_filled_at

**Given** timestamps are recorded
**When** the trade event is saved
**Then** computed latencies are calculated and stored:
- latency_decision_to_submit_ms
- latency_submit_to_ack_ms
- latency_ack_to_fill_ms
- latency_total_ms

**Given** prices are recorded at each stage
**When** the trade event is saved
**Then** slippage is calculated and stored:
- slippage_signal_to_fill (price movement during execution)
- slippage_vs_expected (actual vs strategy expectation)

**Given** market context matters
**When** signal is detected
**Then** bid_at_signal, ask_at_signal, spread_at_signal, depth_at_signal are captured
**And** size_vs_depth_ratio is calculated

---

### Story 5.3: Divergence Detection

As a **trader**,
I want **automatic detection when behavior diverges from expectation**,
So that **I'm alerted to potential issues immediately (FR22)**.

**Acceptance Criteria:**

**Given** a trade executes
**When** comparing expected vs actual
**Then** divergence is detected if difference exceeds threshold
**And** thresholds are configurable (e.g., slippage > 2%, latency > 500ms)

**Given** divergence is detected
**When** the check completes
**Then** diagnostic_flags array is populated
**And** flags include specific issues: ["entry_slippage", "high_latency", "size_reduced"]

**Given** multiple divergence types exist
**When** analyzing a trade
**Then** each type is checked independently:
- Price divergence (expected vs actual)
- Timing divergence (latency thresholds)
- Size divergence (requested vs filled)
- State divergence (local vs exchange)

---

### Story 5.4: Divergence Alerting

As a **trader**,
I want **structured alerts when divergence is detected**,
So that **I can investigate and fix issues (FR23)**.

**Acceptance Criteria:**

**Given** divergence is detected
**When** alert is triggered
**Then** log entry has level='warn' or level='error' based on severity
**And** alert includes: what diverged, expected value, actual value, context

**Given** an alert is raised
**When** reviewing the alert
**Then** it provides actionable information
**And** example: "Entry slippage of 0.03 (3%) - expected 0.42, got 0.45. Latency was 340ms, spread was 0.02"

**Given** multiple alerts in short period
**When** pattern emerges
**Then** alerts are not suppressed (each logged individually)
**And** enables pattern detection in post-mortem

**Given** the alert system
**When** divergence occurs
**Then** the system does NOT silently continue
**And** alert is always generated (fail-loud principle)

---

### Story 5.5: Silent Operation Mode

As a **trader**,
I want **the system to operate silently when everything matches expectations**,
So that **silence means working and I'm not overwhelmed with noise (FR24)**.

**Acceptance Criteria:**

**Given** a trade executes successfully
**When** actual matches expected within thresholds
**Then** only info-level logs are produced
**And** no alerts or warnings are raised

**Given** the system is running normally
**When** no divergence is detected
**Then** the trader is NOT interrupted
**And** system "earns trust through silence"

**Given** logs are being written
**When** everything is normal
**Then** info logs capture the data (for later analysis)
**But** no attention-grabbing alerts occur

**Given** the monitoring philosophy
**When** reviewing system behavior
**Then** warnings/errors = something needs attention
**And** info only = system working as expected
**And** silence in alerts = trust maintained

---

## Epic 6: Strategy Composition

**User Value:** I can compose and evolve strategies - fork variations, update components, track versions

### Story 6.1: Strategy Component Registry

As a **trader**,
I want **strategy components versioned and registered**,
So that **I can track what logic each strategy uses (FR31, FR32)**.

**Acceptance Criteria:**

**Given** strategy components exist (probability, entry, exit, sizing)
**When** they are stored
**Then** each has a unique version ID
**And** components live in `src/modules/strategy/components/{type}/`

**Given** the `strategy_instances` table
**When** a strategy is registered
**Then** it records: id, name, probability_component, entry_component, exit_component, sizing_component
**And** each component field contains the version ID

**Given** a component is updated
**When** the version changes
**Then** a new version ID is created
**And** old version remains available
**And** strategies using old version are not affected

**Given** the registry is queried
**When** asking "what components does strategy X use?"
**Then** complete version information is returned
**And** includes: component type, version ID, created_at

---

### Story 6.2: Strategy Composition

As a **trader**,
I want **strategies composed from reusable components**,
So that **I can mix and match logic without rewriting (FR30)**.

**Acceptance Criteria:**

**Given** components exist in the registry
**When** creating a new strategy
**Then** I specify which component versions to use
**And** strategy is instantiated with those components

**Given** a strategy is composed
**When** it executes
**Then** it calls the specified component versions
**And** probability → entry → sizing → exit flow is maintained

**Given** components are reusable
**When** two strategies share a component
**Then** they reference the same component version
**And** updates to the component affect both (if using same version)

**Given** the composer module
**When** inspecting its interface
**Then** it exports: createStrategy(), getStrategy(), listStrategies()

---

### Story 6.3: Strategy Forking

As a **trader**,
I want **to fork a strategy to test variations**,
So that **I can run experiments without affecting the original (FR33)**.

**Acceptance Criteria:**

**Given** an existing strategy
**When** user forks it
**Then** a new strategy instance is created
**And** base_strategy_id points to the original
**And** new strategy has its own ID and name

**Given** a forked strategy
**When** I modify one component
**Then** only the fork uses the new component version
**And** original strategy is unchanged

**Given** the fork relationship
**When** viewing strategy lineage
**Then** I can see: original → fork → modifications
**And** this enables "what did I change?" analysis

**Given** forking is used for hypothesis testing
**When** comparing strategies
**Then** I can see which components differ
**And** performance can be compared (post-MVP)

---

### Story 6.4: Central Component Updates

As a **trader**,
I want **to update a central component when the change is proven**,
So that **improvements propagate to all strategies using it (FR34)**.

**Acceptance Criteria:**

**Given** a component improvement is validated
**When** updating the central component
**Then** a new version is created (not modified in place)
**And** I can choose which strategies to upgrade

**Given** strategies reference component versions
**When** a new version exists
**Then** existing strategies continue using their specified version
**And** I can update strategy to use new version explicitly

**Given** a "core fix" (not experimental)
**When** updating component and upgrading strategies
**Then** the change propagates to all selected strategies
**And** version history is preserved

**Given** component updates
**When** reviewing what changed
**Then** I can diff old version vs new version
**And** strategies using each version are visible

---

### Story 6.5: Strategy Configuration

As a **trader**,
I want **strategy parameters configurable without code changes**,
So that **I can tune strategies through config files (FR35)**.

**Acceptance Criteria:**

**Given** a strategy instance
**When** it has configurable parameters
**Then** parameters are stored in config JSON field
**And** includes: thresholds, percentages, timing values

**Given** config changes are needed
**When** updating strategy config
**Then** changes take effect on next execution cycle
**And** no code deployment required

**Given** configuration is loaded
**When** strategy initializes
**Then** it receives its config via init(config)
**And** parameters override defaults

**Given** the configuration system
**When** parameters are invalid
**Then** validation errors are thrown at startup
**And** system does not run with invalid config
