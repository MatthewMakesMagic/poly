---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
status: complete
completedAt: '2026-01-30'
inputDocuments:
  - prd.md
  - product-brief-poly-2026-01-29.md
  - README.md
  - v2.md
  - STRATEGY_MANAGEMENT.md
  - POSITION_MANAGEMENT_REVIEW.md
  - TESTING.md
  - DEPLOY.md
  - IMPLEMENTATION_PLAN_TP_SL.md
  - EXECUTION.md
  - EXECUTION_ENGINE.md
  - goLive.md
  - SCOPE_TAKE_PROFIT_STOP_LOSS.md
  - PAPERTRADING.md
  - docs/futuremonitoring.md
workflowType: 'architecture'
project_name: 'poly'
user_name: 'Matthew'
date: '2026-01-30'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

---

## Project Context Analysis

### Requirements Overview

**Functional Requirements (37 FRs across 8 areas):**

| Area | FRs | Architectural Implication |
|------|-----|--------------------------|
| Strategy Execution | FR1-5 | Core execution loop, market data processing |
| Position Management | FR6-10 | Position state machine, limit enforcement |
| Order Management | FR11-15 | Order lifecycle, CLOB API integration |
| State Management | FR16-19 | Persistence layer, reconciliation logic |
| Monitoring & Logging | FR20-24 | Structured logging, divergence detection |
| Safety Controls | FR25-29 | Kill switch, drawdown limits |
| Strategy Composition | FR30-34 | Component versioning, fork/update model |
| Configuration | FR35-37 | External config, secure credentials |

**Non-Functional Requirements (17 NFRs):**

| Category | Key Targets | Architectural Impact |
|----------|-------------|---------------------|
| Performance | 500ms orders, 5s kill, 10s reconcile | Low-latency paths, async where possible |
| Reliability | 100% logs, no orphaned state | Write-ahead persistence, reconciliation |
| Security | Credentials outside code | Environment/secrets management |
| Integration | Auto-reconnect, rate limit backoff | Connection manager, retry logic |

### Scale & Complexity

- **Primary domain:** Backend execution system (Node.js/TypeScript)
- **Complexity level:** Medium-High (safety-critical, real money)
- **User scale:** Single user (Matthew)
- **Estimated architectural components:** 8-10 bounded modules

### Technical Constraints & Dependencies

- **Polymarket CLOB API** - external dependency, rate limited
- **Spot price feeds** - real-time data dependency
- **Existing codebase** - borrow API clients, rebuild core modules
- **15-minute windows** - time-sensitive execution

### Cross-Cutting Concerns

1. **Structured Logging** - all modules produce consistent JSON
2. **State Persistence** - write-before-acknowledge pattern
3. **Error Propagation** - no silent failures, always surface
4. **Module Contracts** - consistent interfaces for agent comprehension

---

## Starter Template Evaluation

### Primary Technology Domain

**Backend Execution System (Node.js)** - real-time trading execution with CLI interface

This is a brownfield rebuild, not a greenfield project. No starter template applies.

### Technology Stack (Existing)

| Layer | Technology | Status |
|-------|------------|--------|
| **Runtime** | Node.js | Existing |
| **Language** | JavaScript/TypeScript | Existing |
| **Database** | SQLite | For state persistence |
| **APIs** | Polymarket CLOB, Spot feeds | Borrow existing clients |
| **Interface** | CLI (primary), Web (post-MVP) | CLI exists |

### Architectural Foundation Decisions

Rather than a starter template, the following foundations need to be established:

1. **Module structure** - how bounded modules are organized
2. **Data contracts** - interface formats between modules
3. **State persistence pattern** - SQLite schema and access
4. **Logging format** - structured JSON schema
5. **Configuration pattern** - external config management
6. **Kill switch mechanism** - separate process design

### Brownfield Approach

**Borrow with Validation:**
- Polymarket API client
- CLOB order mechanics
- Spot price normalization
- Probability calculations

**Rebuild from Scratch:**
- Position manager module
- Stop-loss / take-profit module
- Strategy execution module
- State reconciliation module
- Structured logging module

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
1. Module structure - folder-per-module
2. State persistence - write-ahead logging
3. Inter-module communication - orchestrator pattern
4. Kill switch - separate watchdog process

**Deferred Decisions (Post-MVP):**
- Web dashboard architecture (Phase 2)
- AI briefing generation pattern (Phase 3)
- Strategy version UI (Phase 2)

---

### Module Architecture

**Decision:** Folder-per-module with consistent internal structure

```
src/modules/
  position-manager/
    index.js          # Public interface only
    state.js          # Internal state management
    logic.js          # Business logic
    types.js          # Type definitions/contracts
  stop-loss/
    index.js
    ...
  orchestrator/
    index.js          # Coordinates all modules
    ...
```

**Rationale:**
- Clear boundaries for agent comprehension
- Each module loadable in isolation
- Blast radius naturally limited to one folder
- `index.js` is the contract - internals can change freely

---

### State Persistence

**Decision:** Write-ahead logging pattern

**Flow:**
1. Log intent to SQLite (e.g., "opening position X")
2. Execute action (place order)
3. Log result (success/failure with details)
4. Mark intent complete

**On restart:** Check for incomplete intents → reconcile with exchange state

**Rationale:**
- Simple to implement and understand
- Guarantees we know what was attempted
- Supports "no orphaned state" requirement
- Reconciliation can replay incomplete intents

---

### Inter-Module Communication

**Decision:** Orchestrator pattern

```
Orchestrator
    ├── calls → PositionManager
    ├── calls → StopLoss
    ├── calls → OrderManager
    ├── calls → Logger
    └── calls → StateReconciler
```

**Rules:**
- Modules never import each other directly
- All coordination goes through orchestrator
- Modules expose simple function interfaces
- Orchestrator is the only "aware" component

**Rationale:**
- Agent can understand one module without understanding others
- Orchestrator is single point of coordination logic
- Easy to trace execution flow
- Naturally limits blast radius

---

### Kill Switch

**Decision:** Separate watchdog process

**Architecture:**
```
┌─────────────────┐     ┌─────────────────┐
│  Main Process   │     │  Kill Switch    │
│  (Orchestrator) │◄────│  (Watchdog)     │
│                 │     │                 │
│  - Trading      │     │  - Monitors     │
│  - Positions    │     │  - Can SIGKILL  │
│  - Orders       │     │  - Writes state │
└─────────────────┘     └─────────────────┘
```

**Kill sequence:**
1. User triggers kill (CLI command or signal)
2. Watchdog sends graceful shutdown signal
3. If no response in 2s → SIGKILL
4. Watchdog writes state snapshot from last known state
5. <5s total guaranteed

**Rationale:**
- Works even if main process is hung
- Separate process can't be blocked by main process bugs
- State snapshot ensures we know position at kill time

---

### Decision Impact Analysis

**Implementation Sequence:**
1. Set up folder structure and module templates
2. Implement state persistence layer (SQLite + write-ahead)
3. Build orchestrator skeleton
4. Add modules one by one (each testable in isolation)
5. Add kill switch watchdog last

**Cross-Component Dependencies:**
- All modules depend on Logger (for structured logging)
- All modules use shared types from `/types`
- Orchestrator depends on all modules
- Kill switch is independent (only shares state file location)

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

| Category | Convention | Example |
|----------|------------|---------|
| **Files** | kebab-case | `position-manager.js`, `stop-loss.js` |
| **Folders** | kebab-case | `position-manager/`, `stop-loss/` |
| **Functions** | camelCase | `getPosition()`, `placeOrder()` |
| **Constants** | UPPER_SNAKE | `MAX_POSITION_SIZE`, `KILL_TIMEOUT_MS` |
| **DB Tables** | snake_case | `trade_intents`, `positions` |
| **DB Columns** | snake_case | `window_id`, `entry_price` |
| **Log Fields** | snake_case | `expected_price`, `actual_price` |

---

### Structured Log Format

Every log entry MUST include:

```json
{
  "timestamp": "2026-01-30T10:15:30.123Z",
  "level": "info|warn|error",
  "module": "position-manager",
  "event": "position_opened",
  "data": {
    "window_id": "...",
    "expected": { ... },
    "actual": { ... }
  },
  "context": {
    "strategy": "spot-lag-v1",
    "session_id": "..."
  }
}
```

**Required fields:** timestamp, level, module, event
**Optional fields:** data, context, error

---

### Module Interface Contract

Every module `index.js` MUST export:

```javascript
module.exports = {
  // Initialization
  init: async (config) => {},

  // Main operations (module-specific)
  // ...

  // State inspection (for debugging/reconciliation)
  getState: () => {},

  // Graceful shutdown
  shutdown: async () => {}
};
```

**Rules:**
- All public functions return Promises (async)
- Errors thrown, never swallowed
- State always inspectable via `getState()`

---

### Error Handling Pattern

```javascript
// Module throws typed errors
class PositionError extends Error {
  constructor(code, message, context) {
    super(message);
    this.code = code;      // e.g., 'POSITION_LIMIT_EXCEEDED'
    this.context = context; // { position_id, limit, attempted }
  }
}

// Orchestrator catches and logs
try {
  await positionManager.openPosition(params);
} catch (err) {
  logger.error({
    module: 'orchestrator',
    event: 'position_open_failed',
    error: {
      code: err.code,
      message: err.message,
      context: err.context
    }
  });
  // Decide: retry, alert, or propagate
}
```

---

### Test Location

```
src/modules/
  position-manager/
    index.js
    logic.js
    __tests__/
      index.test.js
      logic.test.js
```

**Rule:** Tests co-located in `__tests__` folder within each module.

---

### Configuration Pattern

```javascript
// config/default.js
module.exports = {
  polymarket: {
    apiUrl: process.env.POLYMARKET_API_URL,
    // ...
  },
  risk: {
    maxPositionSize: 100,
    maxExposure: 500,
    // ...
  },
  logging: {
    level: 'info',
    // ...
  }
};
```

**Rule:** Config loaded once at startup, passed to modules via `init(config)`.

---

### Enforcement Guidelines

**All AI Agents MUST:**
1. Follow naming conventions exactly (no exceptions)
2. Include all required log fields
3. Export standard module interface
4. Throw typed errors with context
5. Place tests in `__tests__` folder

**Pattern Verification:**
- PR review checks naming conventions
- Log schema validated at runtime
- Module interface validated at init

---

## Project Structure & Boundaries

### Complete Project Directory Structure

```
poly/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
├── .env                          # API credentials (gitignored)
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── config/
│   ├── default.js                # Default configuration
│   ├── development.js            # Dev overrides
│   └── production.js             # Production overrides
│
├── data/
│   └── poly.db                   # SQLite database (gitignored)
│
├── src/
│   ├── index.js                  # Application entry point
│   ├── types/
│   │   ├── index.js              # Shared type exports
│   │   ├── position.js           # Position types
│   │   ├── order.js              # Order types
│   │   ├── trade-log.js          # Structured log schema
│   │   └── errors.js             # Error type definitions
│   │
│   ├── modules/
│   │   ├── orchestrator/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── execution-loop.js # Main execution loop
│   │   │   ├── state.js          # Internal state
│   │   │   └── __tests__/
│   │   │       ├── index.test.js
│   │   │       └── execution-loop.test.js
│   │   │
│   │   ├── position-manager/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── logic.js          # Position business logic
│   │   │   ├── state.js          # In-memory position state
│   │   │   ├── types.js          # Position-specific types
│   │   │   └── __tests__/
│   │   │       ├── index.test.js
│   │   │       └── logic.test.js
│   │   │
│   │   ├── order-manager/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── logic.js          # Order lifecycle logic
│   │   │   ├── state.js          # Order tracking state
│   │   │   ├── types.js          # Order-specific types
│   │   │   └── __tests__/
│   │   │       ├── index.test.js
│   │   │       └── logic.test.js
│   │   │
│   │   ├── stop-loss/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── logic.js          # Stop-loss evaluation
│   │   │   ├── types.js          # SL-specific types
│   │   │   └── __tests__/
│   │   │       └── logic.test.js
│   │   │
│   │   ├── take-profit/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── logic.js          # Take-profit evaluation
│   │   │   ├── types.js          # TP-specific types
│   │   │   └── __tests__/
│   │   │       └── logic.test.js
│   │   │
│   │   ├── strategy/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── composer.js       # Strategy composition logic
│   │   │   ├── registry.js       # Component version registry
│   │   │   ├── components/
│   │   │   │   ├── probability/  # Probability logic components
│   │   │   │   ├── entry/        # Entry condition components
│   │   │   │   ├── exit/         # Exit rule components
│   │   │   │   └── sizing/       # Position sizing components
│   │   │   └── __tests__/
│   │   │       ├── composer.test.js
│   │   │       └── registry.test.js
│   │   │
│   │   ├── state-reconciler/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── logic.js          # Reconciliation logic
│   │   │   ├── divergence.js     # Divergence detection
│   │   │   └── __tests__/
│   │   │       ├── logic.test.js
│   │   │       └── divergence.test.js
│   │   │
│   │   ├── logger/
│   │   │   ├── index.js          # Public interface
│   │   │   ├── formatter.js      # JSON log formatting
│   │   │   ├── schema.js         # Log schema validation
│   │   │   └── __tests__/
│   │   │       └── formatter.test.js
│   │   │
│   │   └── safety/
│   │       ├── index.js          # Public interface
│   │       ├── drawdown.js       # Drawdown limit logic
│   │       ├── exposure.js       # Exposure limit logic
│   │       └── __tests__/
│   │           ├── drawdown.test.js
│   │           └── exposure.test.js
│   │
│   ├── persistence/
│   │   ├── index.js              # Database access layer
│   │   ├── schema.sql            # SQLite schema definition
│   │   ├── migrations/           # Database migrations
│   │   ├── write-ahead.js        # Write-ahead logging impl
│   │   └── __tests__/
│   │       └── write-ahead.test.js
│   │
│   └── clients/
│       ├── polymarket/
│       │   ├── index.js          # Polymarket API client (borrowed)
│       │   ├── clob.js           # CLOB order mechanics (borrowed)
│       │   └── auth.js           # Authentication handling
│       │
│       └── spot/
│           ├── index.js          # Spot price feed client (borrowed)
│           └── normalizer.js     # Price normalization (borrowed)
│
├── kill-switch/
│   ├── watchdog.js               # Separate watchdog process
│   ├── state-snapshot.js         # State snapshot writer
│   └── README.md                 # Kill switch documentation
│
├── cli/
│   ├── index.js                  # CLI entry point
│   ├── commands/
│   │   ├── start.js              # Start trading
│   │   ├── stop.js               # Graceful stop
│   │   ├── kill.js               # Kill switch trigger
│   │   ├── status.js             # Position/order status
│   │   └── reconcile.js          # Manual reconciliation
│   └── __tests__/
│       └── commands.test.js
│
├── logs/
│   └── .gitkeep                  # Log files (gitignored)
│
└── scripts/
    ├── setup-db.js               # Database initialization
    └── test-kill-switch.js       # Weekly kill switch test
```

---

### Architectural Boundaries

**API Boundaries:**

| Boundary | Location | Protocol |
|----------|----------|----------|
| Polymarket CLOB | `src/clients/polymarket/` | REST/WebSocket |
| Spot Price Feeds | `src/clients/spot/` | REST/WebSocket |
| SQLite Database | `src/persistence/` | Local file |

**Module Boundaries:**

All modules expose only through `index.js`. Internal files (`logic.js`, `state.js`) are never imported directly.

```
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                         │
│  (Only component that knows about other modules)         │
└────────────┬─────────┬─────────┬─────────┬─────────────┘
             │         │         │         │
    ┌────────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌──▼──────┐
    │ Position   │ │ Order  │ │Stop  │ │ Take    │
    │ Manager    │ │ Manager│ │Loss  │ │ Profit  │
    └────────────┘ └────────┘ └──────┘ └─────────┘
             │         │         │         │
             └─────────┴─────────┴─────────┘
                           │
                    ┌──────▼──────┐
                    │  Persistence │
                    │  (SQLite)    │
                    └─────────────┘
```

**Data Boundaries:**

| Layer | Read | Write |
|-------|------|-------|
| Modules | Own state only | Own state only |
| Persistence | All modules | Via write-ahead log |
| Logger | N/A | Append-only logs |

---

### Requirements to Structure Mapping

**FR → Module Mapping:**

| FR Category | FRs | Primary Module | Files |
|-------------|-----|----------------|-------|
| Strategy Execution | FR1-5 | `orchestrator`, `strategy` | `execution-loop.js`, `composer.js` |
| Position Management | FR6-10 | `position-manager` | `logic.js`, `state.js` |
| Order Management | FR11-15 | `order-manager` | `logic.js`, `state.js` |
| State Management | FR16-19 | `state-reconciler`, `persistence` | `write-ahead.js`, `divergence.js` |
| Monitoring & Logging | FR20-24 | `logger`, `orchestrator` | `formatter.js`, `schema.js` |
| Safety Controls | FR25-29 | `safety`, `kill-switch` | `watchdog.js`, `drawdown.js` |
| Strategy Composition | FR30-34 | `strategy` | `composer.js`, `registry.js`, `components/` |
| Configuration | FR35-37 | `config/` | `default.js`, `.env` |

**Cross-Cutting Concerns:**

| Concern | Primary Location | Touches |
|---------|------------------|---------|
| Structured Logging | `src/modules/logger/` | All modules via orchestrator |
| Write-Ahead Persistence | `src/persistence/write-ahead.js` | All state-changing operations |
| Error Types | `src/types/errors.js` | All modules |
| Configuration | `config/` | Loaded once, passed to `init()` |

---

### Integration Points

**Internal Communication:**

```
Module.init(config)     → Orchestrator passes config at startup
Module.getState()       → Orchestrator reads for monitoring/reconciliation
Module.shutdown()       → Orchestrator calls for graceful stop
Persistence.logIntent() → Called before any state change
Persistence.complete()  → Called after state change confirmed
```

**External Integrations:**

| System | Integration Point | Error Handling |
|--------|-------------------|----------------|
| Polymarket CLOB | `src/clients/polymarket/clob.js` | Retry with backoff, log all failures |
| Spot Price Feed | `src/clients/spot/index.js` | Alert on disconnect, no silent degradation |
| SQLite | `src/persistence/index.js` | Write-ahead logging, crash recovery |

**Data Flow:**

```
Market Data → Spot Client → Orchestrator → Strategy Evaluation
                                        ↓
                               Signal Generated
                                        ↓
                         Persistence.logIntent("open_position")
                                        ↓
                              Order Manager → CLOB API
                                        ↓
                              Fill Confirmed
                                        ↓
                           Position Manager.addPosition()
                                        ↓
                         Persistence.complete(intent_id)
                                        ↓
                              Logger.log(trade_event)
```

---

### Kill Switch Integration

```
┌──────────────────────┐         ┌──────────────────────┐
│    Main Process      │         │   Kill Switch        │
│    (poly/src/)       │◄───────│   (kill-switch/)     │
│                      │ Signal  │                      │
│ - Trades             │         │ - Monitors main      │
│ - Orders             │         │ - Can SIGKILL        │
│ - Positions          │         │ - Writes snapshot    │
└──────────────────────┘         └──────────────────────┘
         │                                │
         │ Shared state file              │
         └────────────┬───────────────────┘
                      ▼
              data/last-known-state.json
```

**Kill Sequence:**
1. `cli/commands/kill.js` or signal received
2. Watchdog sends graceful shutdown to main
3. If no response in 2s → SIGKILL
4. Watchdog writes state snapshot from last-known-state
5. <5s total guaranteed

---

### Database Schema

**Location:** `src/persistence/schema.sql`

#### trade_intents (Write-Ahead Logging)

Core table for "no orphaned state" guarantee. Every state-changing operation logs intent before execution.

```sql
CREATE TABLE trade_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_type TEXT NOT NULL,        -- 'open_position', 'close_position', 'place_order', 'cancel_order'
    window_id TEXT NOT NULL,          -- which 15-min window
    payload TEXT NOT NULL,            -- JSON with intent details
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'executing', 'completed', 'failed'
    created_at TEXT NOT NULL,         -- ISO timestamp
    completed_at TEXT,                -- NULL until resolved
    result TEXT                       -- JSON with outcome or error
);

CREATE INDEX idx_intents_status ON trade_intents(status);
CREATE INDEX idx_intents_window ON trade_intents(window_id);
```

**Recovery query:** `SELECT * FROM trade_intents WHERE status = 'executing'`

---

#### positions

Position state with exchange verification for reconciliation.

```sql
CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_id TEXT NOT NULL,
    market_id TEXT NOT NULL,          -- Polymarket market identifier
    token_id TEXT NOT NULL,           -- YES or NO token
    side TEXT NOT NULL,               -- 'long' or 'short'
    size REAL NOT NULL,               -- position size in tokens
    entry_price REAL NOT NULL,
    current_price REAL,               -- last known price
    status TEXT NOT NULL DEFAULT 'open',  -- 'open', 'closed', 'liquidated'
    strategy_id TEXT NOT NULL,        -- which strategy opened this
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_price REAL,
    pnl REAL,                         -- realized P&L when closed
    exchange_verified_at TEXT,        -- last reconciliation timestamp
    UNIQUE(window_id, market_id, token_id)
);

CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_strategy ON positions(strategy_id);
```

---

#### orders

Full order lifecycle with latency tracking.

```sql
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,    -- exchange order ID
    intent_id INTEGER,                -- links to trade_intents
    position_id INTEGER,              -- links to positions
    window_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL,               -- 'buy' or 'sell'
    order_type TEXT NOT NULL,         -- 'limit', 'market'
    price REAL,                       -- limit price (NULL for market)
    size REAL NOT NULL,               -- requested size
    filled_size REAL DEFAULT 0,       -- how much filled
    avg_fill_price REAL,              -- average fill price
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired'
    submitted_at TEXT NOT NULL,
    latency_ms INTEGER,               -- time from submit to ack
    filled_at TEXT,
    cancelled_at TEXT,
    FOREIGN KEY (intent_id) REFERENCES trade_intents(id),
    FOREIGN KEY (position_id) REFERENCES positions(id)
);

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_window ON orders(window_id);
```

---

#### trade_events

Detailed diagnostics with explicit slippage and latency columns for queryable analysis.

```sql
CREATE TABLE trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identity
    event_type TEXT NOT NULL,         -- 'signal', 'entry', 'exit', 'alert', 'divergence'
    window_id TEXT NOT NULL,
    position_id INTEGER,
    order_id INTEGER,
    strategy_id TEXT,
    module TEXT NOT NULL,

    -- Timestamps (ISO format)
    signal_detected_at TEXT,
    order_submitted_at TEXT,
    order_acked_at TEXT,
    order_filled_at TEXT,

    -- Computed latencies (milliseconds)
    latency_decision_to_submit_ms INTEGER,
    latency_submit_to_ack_ms INTEGER,
    latency_ack_to_fill_ms INTEGER,
    latency_total_ms INTEGER,

    -- Prices
    price_at_signal REAL,
    price_at_submit REAL,
    price_at_fill REAL,
    expected_price REAL,

    -- Computed slippage
    slippage_signal_to_fill REAL,     -- price_at_fill - price_at_signal
    slippage_vs_expected REAL,        -- price_at_fill - expected_price

    -- Market context at signal
    bid_at_signal REAL,
    ask_at_signal REAL,
    spread_at_signal REAL,
    depth_at_signal REAL,

    -- Size context
    requested_size REAL,
    filled_size REAL,
    size_vs_depth_ratio REAL,         -- requested_size / depth_at_signal

    -- Diagnostic
    level TEXT NOT NULL,              -- 'info', 'warn', 'error'
    event TEXT NOT NULL,              -- specific event name
    diagnostic_flags TEXT,            -- JSON array for flexible flags
    notes TEXT,                       -- JSON for anything else

    FOREIGN KEY (position_id) REFERENCES positions(id)
);

CREATE INDEX idx_events_type ON trade_events(event_type);
CREATE INDEX idx_events_window ON trade_events(window_id);
CREATE INDEX idx_events_strategy ON trade_events(strategy_id);
CREATE INDEX idx_events_level ON trade_events(level);
```

---

#### strategy_instances

Strategy composition registry for versioned components.

```sql
CREATE TABLE strategy_instances (
    id TEXT PRIMARY KEY,              -- strategy instance ID
    name TEXT NOT NULL,               -- human-readable name
    base_strategy_id TEXT,            -- NULL if original, otherwise forked from
    probability_component TEXT NOT NULL,  -- component version ID
    entry_component TEXT NOT NULL,
    exit_component TEXT NOT NULL,
    sizing_component TEXT NOT NULL,
    config TEXT NOT NULL,             -- JSON strategy config
    created_at TEXT NOT NULL,
    active INTEGER DEFAULT 1          -- is this strategy currently active?
);

CREATE INDEX idx_strategy_active ON strategy_instances(active);
```

---

#### daily_performance

Drawdown tracking for safety controls (FR28-29).

```sql
CREATE TABLE daily_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD
    starting_balance REAL NOT NULL,
    current_balance REAL NOT NULL,
    realized_pnl REAL DEFAULT 0,
    unrealized_pnl REAL DEFAULT 0,
    drawdown_pct REAL DEFAULT 0,      -- (starting - current) / starting
    max_drawdown_pct REAL DEFAULT 0,  -- worst drawdown today
    trades_count INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
);
```

---

#### Schema Summary

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `trade_intents` | Write-ahead logging, crash recovery | status, window_id |
| `positions` | Position state, reconciliation | status, strategy_id |
| `orders` | Order lifecycle, latency tracking | status, window_id |
| `trade_events` | Diagnostics, slippage analysis | event_type, strategy_id, level |
| `strategy_instances` | Strategy composition registry | active |
| `daily_performance` | Drawdown tracking, safety | date (unique) |

---

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
- Node.js/JavaScript runtime with SQLite - well-established pairing
- Folder-per-module structure aligns with orchestrator pattern
- Write-ahead logging pattern is SQLite-native (journal mode)
- Kill switch as separate process uses standard Node.js IPC
- Database schema directly supports all architectural patterns

**Pattern Consistency:**
- Naming conventions internally consistent across all layers
- All modules export same interface contract (`init`, `getState`, `shutdown`)
- Error handling pattern applies uniformly
- Structured logging schema consistent across all modules
- Schema uses `snake_case` as specified in naming conventions

**Structure Alignment:**
- Project structure directly reflects module architecture decisions
- Each module folder contains exactly the files specified in patterns
- Test co-location follows defined convention
- Kill switch properly separated at directory level
- Schema location matches project structure (`src/persistence/schema.sql`)

---

### Requirements Coverage Validation ✅

**Functional Requirements (37 FRs):**

| FR Category | Coverage | Implementation |
|-------------|----------|----------------|
| Strategy Execution (FR1-5) | ✅ | `orchestrator/`, `strategy/`, `strategy_instances` table |
| Position Management (FR6-10) | ✅ | `position-manager/`, `positions` table |
| Order Management (FR11-15) | ✅ | `order-manager/`, `orders` table |
| State Management (FR16-19) | ✅ | `persistence/`, `trade_intents` table |
| Monitoring & Logging (FR20-24) | ✅ | `logger/`, `trade_events` table |
| Safety Controls (FR25-29) | ✅ | `safety/`, `kill-switch/`, `daily_performance` table |
| Strategy Composition (FR30-34) | ✅ | `strategy/components/`, `strategy_instances` table |
| Configuration (FR35-37) | ✅ | `config/`, `.env` |

**Non-Functional Requirements (17 NFRs):**

| NFR Category | Coverage | Implementation |
|--------------|----------|----------------|
| Performance (NFR1-5) | ✅ | Async patterns, latency columns in schema |
| Reliability (NFR6-10) | ✅ | Write-ahead logging, reconciliation, structured logs |
| Security (NFR11-13) | ✅ | `.env` credentials, never logged |
| Integration (NFR14-17) | ✅ | Retry logic in clients, alert on failure |

---

### Implementation Readiness Validation ✅

**Decision Completeness:**
- All critical decisions documented with rationale
- Module interface contract specified with code examples
- Error handling pattern specified with code examples
- Structured log schema specified with full JSON example
- Database schema fully specified with 6 tables

**Structure Completeness:**
- Complete directory tree with 50+ files specified
- Every module has defined internal files
- Integration points between modules documented
- Data flow diagram shows complete execution path

**Pattern Completeness:**
- Naming conventions cover all categories
- Enforcement guidelines specify what AI agents MUST do
- Configuration pattern shows how modules receive config
- Schema provides concrete data contracts

---

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**✅ Architectural Decisions**
- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed

**✅ Implementation Patterns**
- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**✅ Project Structure**
- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

**✅ Database Schema**
- [x] All tables defined with columns and types
- [x] Indexes specified for query performance
- [x] Foreign key relationships documented
- [x] Recovery queries documented

---

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High

**Key Strengths:**
- Clear module boundaries enable isolated development and testing
- Write-ahead logging guarantees no orphaned state
- Orchestrator pattern prevents module coupling
- Kill switch as separate process ensures <5s halt
- Structured logging schema enables 100% diagnostic coverage
- Explicit database schema provides concrete contracts for agents
- Detailed slippage/latency columns enable pattern analysis

**Areas for Future Enhancement:**
- Alerting/notification mechanism (can use console initially)
- CI/CD pipeline specifics (can evolve with codebase)
- Retry backoff parameters (can tune in production)

---

### Implementation Handoff

**AI Agent Guidelines:**
1. Follow all architectural decisions exactly as documented
2. Use implementation patterns consistently across all components
3. Respect project structure and boundaries
4. Refer to this document for all architectural questions
5. Never have modules import each other directly
6. Use the database schema exactly as specified

**First Implementation Priority:**
1. Set up folder structure and module templates
2. Initialize SQLite with schema (`src/persistence/schema.sql`)
3. Implement persistence layer (write-ahead logging)
4. Build orchestrator skeleton
5. Add modules one by one (each testable in isolation)
6. Add kill switch watchdog last
