---
title: 'FINDTHEGOLD Data Capture & Edge Validation Infrastructure'
slug: 'findthegold-data-capture'
created: '2026-02-05'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4, 5, 6]
tech_stack:
  - Node.js (ES Modules)
  - PostgreSQL (Railway managed)
  - Polymarket CLOB API / WebSocket
  - Polymarket RTDS WebSocket
  - Pyth Network (Hermes SSE/REST)
  - Chainlink Data Streams (via RTDS)
  - CCXT (multi-exchange library - TO ADD)
  - Vitest (testing framework)
files_to_modify:
  - src/modules/tick-logger/index.js (add Pyth subscription)
  - src/clients/spot/client.js (expose price stream for persistence)
  - src/modules/order-book-collector/index.js (L2 capture + auto-discovery)
  - src/modules/window-manager/index.js (emit token events for auto-tracking)
  - src/modules/oracle-tracker/types.js (review threshold)
  - src/persistence/migrations/022-l2-order-book-table.js (NEW)
  - src/persistence/migrations/023-clob-price-snapshots-table.js (NEW)
  - src/persistence/migrations/024-exchange-ticks-table.js (NEW)
  - src/modules/clob-price-logger/index.js (NEW)
  - src/modules/exchange-feed-collector/index.js (NEW)
  - src/clients/ccxt/index.js (NEW)
code_patterns:
  - Folder-per-module with init/getState/shutdown interface
  - Buffered writes with configurable batch size and flush interval
  - RTDS subscription via topic/symbol pattern
  - PostgreSQL persistence via async transactions
  - Window-manager for active market discovery
  - TickBuffer class for batched inserts
  - WebSocket reconnection with exponential backoff
  - CLOB WebSocket event types: 'book' (snapshot), 'price_change' (delta), 'last_trade_price'
test_patterns:
  - Framework: Vitest with vi.mock()
  - Unit: __tests__/*.test.js collocated with modules
  - Integration: __tests__/integration/*.test.js
  - Lifecycle: beforeEach(init)/afterEach(shutdown)
findthegold_ref: docs/FINDTHEGOLD.md
v3_philosophy_ref: docs/v3philosophy.md
future_context: Market making algorithms will need order book depth and depth-change-over-time data
---

# Tech-Spec: FINDTHEGOLD Data Capture & Edge Validation Infrastructure

**Created:** 2026-02-05
**Research Reference:** [docs/FINDTHEGOLD.md](../../docs/FINDTHEGOLD.md)

## Overview

### Problem Statement

The oracle edge thesis was built on a fundamentally wrong model — assuming Polymarket resolves via Chainlink Data Feeds (push-based, deviation-triggered) when it actually uses Chainlink Data Streams (pull-based, sub-second, multi-source aggregation). Before any trading based on the reframed thesis, we need comprehensive multi-source data capture to empirically validate whether a predictable edge exists in the Data Streams aggregation.

Critical data gaps block validation:
1. **Pyth prices not persisted** — Spot client polls Pyth at 1s but doesn't write to database
2. **CLOB token prices only on-demand** — UP/DOWN prices captured in last 60s of windows or during sizing; missing first 14 minutes
3. **Market depth not tracked continuously** — Order book collector exists but requires manual token activation; no per-level depth history
4. **No cross-exchange correlation** — Only Binance (via RTDS) and Pyth available; can't reverse-engineer which sources drive Data Streams median
5. **Oracle tracker may over-filter** — 0.01% threshold could discard real micro-movements in the aggregation

### Solution

Extend existing infrastructure (tick-logger, order-book-collector, spot client) to capture all available price sources continuously at 1s intervals, persist everything to PostgreSQL, and enable empirical validation via diagnostic queries. Design the order book capture schema for future market making use — per-level depth with change-over-time queryability.

### Scope

**In Scope:**
- Pyth price persistence via tick-logger (new `crypto_prices_pyth` topic)
- Continuous CLOB UP/DOWN token prices at 1s throughout full 15-min windows
- Market depth at 2+ levels bid/ask at 1s throughout windows (market-making ready schema)
- Auto-discovery: wire order-book-collector to window-manager for automatic token tracking
- Additional exchange feeds — Coinbase, Kraken, Bybit, OKX via CCXT
- Oracle tracker threshold review (0.01% may filter real micro-movements)
- Diagnostic SQL queries (A-D from FINDTHEGOLD) as validation step

**Out of Scope:**
- Trading strategy changes or execution logic modifications
- Chainlink Data Streams direct API integration (research item, not code)
- Backtesting framework changes
- Market making algorithm implementation (but schema must support it)

## Context for Development

### Codebase Patterns

**Module Interface Contract:**
- All modules export: `init(config)`, `getState()`, `shutdown()`
- Async operations return Promises
- Errors via typed error classes with `code`, `message`, `context`

**Buffered Persistence Pattern (from tick-logger):**
- `TickBuffer` class with configurable `batchSize` and `flushIntervalMs`
- Dead-letter queue for failed inserts (single retry)
- Fire-and-forget flush with async transaction
- Cleanup on init + periodic cleanup via interval

**RTDS Subscription Pattern:**
- Subscribe by topic + symbol filter
- Callback receives normalized tick `{ timestamp, topic, symbol, price }`
- Unsubscribe returns cleanup function

**CLOB WebSocket Pattern (from btc-quad-stream.js):**
- Connect to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Send: `{ type: 'market', assets_ids: [tokenId] }`
- Receive events: `book` (full snapshot), `price_change` (delta), `last_trade_price`
- Maintain local order book Map for bids/asks
- Delta updates: size=0 means remove level

**Window Manager Pattern:**
- `getActiveWindows()` returns array of windows with `token_id_up`, `token_id_down`, `epoch`, `crypto`
- 5s cache to reduce API calls
- `get15MinWindows(count)` returns epoch objects

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/modules/tick-logger/index.js` | Buffered tick persistence — extend for Pyth topic |
| `src/modules/tick-logger/buffer.js` | TickBuffer class with batching logic |
| `src/modules/order-book-collector/index.js` | Existing snapshot collector — enhance for L2 |
| `src/clients/spot/client.js` | Pyth polling at 1s — source for persistence |
| `src/clients/spot/index.js` | Spot client public interface with subscribe() |
| `src/modules/window-manager/index.js` | Active window discovery — source for auto-tracking |
| `src/modules/oracle-tracker/types.js:41` | `minDeviationForUpdate: 0.0001` threshold config |
| `src/clients/rtds/client.js` | RTDS WebSocket patterns |
| `scripts/btc-quad-stream.js` | Reference implementation for CLOB WS + Pyth SSE |
| `src/persistence/migrations/018-order-book-snapshots-table.js` | Existing schema (aggregated depth only) |

### Technical Decisions

**TD1: Pyth Persistence via Tick-Logger**
- Extend tick-logger to subscribe to spot client price updates
- Add `crypto_prices_pyth` topic to `rtds_ticks` table
- Reuse existing buffering infrastructure

**TD2: L2 Order Book with Delta Tracking**
- New table `order_book_levels` with per-level price/size
- Capture timestamp, token_id, side, price_level, size, delta_type (snapshot/insert/update/delete)
- Enables market making analysis: queue position, depth collapse detection
- 1s snapshot interval with full L2 on each cycle

**TD3: CLOB Price Logger (New Module)**
- Subscribe to CLOB WebSocket for all active window tokens
- Persist mid-price, best_bid, best_ask, spread every 1s
- Auto-discover tokens from window-manager
- New table `clob_price_snapshots`

**TD4: Multi-Exchange via CCXT**
- Add `ccxt` dependency for unified exchange API
- New module `exchange-feed-collector`
- Exchanges: Binance, Coinbase, Kraken, Bybit, OKX
- Polling at 1s for BTC, ETH, SOL, XRP
- New table `exchange_ticks` with exchange column

**TD5: Oracle Tracker Threshold**
- Current: 0.0001 (0.01%) — may filter real micro-movements
- Make configurable via config
- Consider lowering or removing for research phase

**TD6: Auto-Discovery Integration**
- Window-manager emits token events on window create/close
- Order-book-collector subscribes to these events
- Tokens auto-added when window becomes active, removed on close

## Implementation Plan

### Tasks

#### Phase 1: Database Schema (Run First)

- [x] **Task 1.1: Create L2 Order Book Levels Table**
  - File: `src/persistence/migrations/022-l2-order-book-table.js`
  - Action: Create new migration with schema:
    ```sql
    CREATE TABLE order_book_levels (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      token_id VARCHAR(100) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      side VARCHAR(4) NOT NULL,  -- 'bid' or 'ask'
      price DECIMAL(10, 6) NOT NULL,
      size DECIMAL(20, 8) NOT NULL,
      level_index SMALLINT NOT NULL,  -- 0 = best, 1 = second best, etc.
      snapshot_id BIGINT NOT NULL  -- groups levels from same snapshot
    );
    CREATE INDEX idx_obl_token_time ON order_book_levels (token_id, timestamp DESC);
    CREATE INDEX idx_obl_snapshot ON order_book_levels (snapshot_id);
    ```
  - Notes: `snapshot_id` enables reconstructing full book state at any point; `level_index` enables "top N levels" queries

- [x] **Task 1.2: Create CLOB Price Snapshots Table**
  - File: `src/persistence/migrations/023-clob-price-snapshots-table.js`
  - Action: Create new migration with schema:
    ```sql
    CREATE TABLE clob_price_snapshots (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      token_id VARCHAR(100) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      window_epoch BIGINT NOT NULL,
      best_bid DECIMAL(10, 6),
      best_ask DECIMAL(10, 6),
      mid_price DECIMAL(10, 6),
      spread DECIMAL(10, 6),
      last_trade_price DECIMAL(10, 6),
      bid_size_top DECIMAL(20, 8),
      ask_size_top DECIMAL(20, 8)
    );
    CREATE INDEX idx_clob_snap_token_time ON clob_price_snapshots (token_id, timestamp DESC);
    CREATE INDEX idx_clob_snap_epoch ON clob_price_snapshots (window_epoch, timestamp);
    ```
  - Notes: Captures market consensus (UP/DOWN probability) throughout full 15-min window

- [x] **Task 1.3: Create Exchange Ticks Table**
  - File: `src/persistence/migrations/024-exchange-ticks-table.js`
  - Action: Create new migration with schema:
    ```sql
    CREATE TABLE exchange_ticks (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      price DECIMAL(20, 8) NOT NULL,
      bid DECIMAL(20, 8),
      ask DECIMAL(20, 8),
      volume_24h DECIMAL(30, 8)
    );
    CREATE INDEX idx_ext_exchange_symbol_time ON exchange_ticks (exchange, symbol, timestamp DESC);
    CREATE INDEX idx_ext_symbol_time ON exchange_ticks (symbol, timestamp DESC);
    ```
  - Notes: Multi-exchange price capture for cross-correlation analysis

- [x] **Task 1.4: Run Migrations**
  - File: `src/persistence/migrations/index.js`
  - Action: Add imports for migrations 022, 023, 024; run `npm run migrate`

#### Phase 2: Pyth Price Persistence

- [x] **Task 2.1: Add Pyth Subscription to Tick-Logger**
  - File: `src/modules/tick-logger/index.js`
  - Action: In `init()`, after RTDS subscriptions, add:
    ```javascript
    // Subscribe to spot client for Pyth prices
    import * as spotClient from '../../clients/spot/index.js';

    for (const crypto of ['btc', 'eth', 'sol', 'xrp']) {
      const unsubscribe = spotClient.subscribe(crypto, (price) => {
        handleTick({
          timestamp: price.timestamp,
          topic: 'crypto_prices_pyth',
          symbol: crypto,
          price: price.price,
          source: 'pyth',
        });
      });
      unsubscribers.push(unsubscribe);
    }
    ```
  - Notes: Reuses existing `handleTick()` and buffer infrastructure; no new table needed (uses `rtds_ticks`)

- [x] **Task 2.2: Update Tick-Logger Types**
  - File: `src/modules/tick-logger/types.js`
  - Action: Add `'crypto_prices_pyth'` to any topic validation if present

#### Phase 3: CLOB Price Logger (New Module)

- [x] **Task 3.1: Create CLOB Price Logger Module Structure**
  - File: `src/modules/clob-price-logger/index.js` (NEW)
  - Action: Create module with standard interface:
    - `init(config)` — connect to CLOB WebSocket, subscribe to window-manager events
    - `getState()` — return connection status, active tokens, stats
    - `shutdown()` — close WebSocket, clear intervals
  - Notes: Follow pattern from `btc-quad-stream.js` lines 193-288 for CLOB WebSocket handling

- [x] **Task 3.2: Create CLOB Price Logger Types**
  - File: `src/modules/clob-price-logger/types.js` (NEW)
  - Action: Create error class `ClobPriceLoggerError`, error codes, default config:
    ```javascript
    export const DEFAULT_CONFIG = {
      snapshotIntervalMs: 1000,  // 1s
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      restUrl: 'https://clob.polymarket.com',
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30000,
      maxActiveTokens: 20,
    };
    ```

- [x] **Task 3.3: Implement CLOB WebSocket Connection**
  - File: `src/modules/clob-price-logger/index.js`
  - Action: Implement WebSocket lifecycle:
    - Connect to `wsUrl`
    - On open: send `{ type: 'market', assets_ids: [tokenIds] }`
    - Handle events: `book`, `price_change`, `last_trade_price`
    - Maintain local order book state per token
    - Reconnect with exponential backoff on disconnect
  - Notes: Reference `scripts/btc-quad-stream.js` lines 218-284

- [x] **Task 3.4: Implement Snapshot Persistence**
  - File: `src/modules/clob-price-logger/index.js`
  - Action: Add 1s interval that:
    - For each active token, capture current state (best_bid, best_ask, mid, spread, last_trade)
    - Batch insert to `clob_price_snapshots` table
    - Use TickBuffer pattern for batching if needed

- [x] **Task 3.5: Wire to Window-Manager**
  - File: `src/modules/clob-price-logger/index.js`
  - Action: On init, call `window-manager.getActiveWindows()` to get initial tokens; poll every 5s to detect new windows and add their UP/DOWN tokens

#### Phase 4: L2 Order Book Capture

- [x] **Task 4.1: Enhance Order Book Collector for L2**
  - File: `src/modules/order-book-collector/index.js`
  - Action: Modify `takeSnapshot()` to capture per-level data:
    ```javascript
    // Instead of just aggregated depth, capture each level
    const levels = [];
    let snapshotId = Date.now(); // or use sequence

    bids.slice(0, 10).forEach((bid, idx) => {
      levels.push({
        timestamp, token_id, symbol,
        side: 'bid',
        price: parseFloat(bid.price),
        size: parseFloat(bid.size),
        level_index: idx,
        snapshot_id: snapshotId,
      });
    });
    // Same for asks
    ```
  - Notes: Keep existing aggregated snapshot logic; add L2 capture in parallel

- [x] **Task 4.2: Add L2 Persistence**
  - File: `src/modules/order-book-collector/index.js`
  - Action: In `runSnapshotCycle()`, after existing persistence, batch insert L2 levels to `order_book_levels` table

- [x] **Task 4.3: Update Snapshot Interval to 1s**
  - File: `src/modules/order-book-collector/types.js`
  - Action: Change `DEFAULT_CONFIG.snapshotIntervalMs` from 5000 to 1000

- [x] **Task 4.4: Wire Auto-Discovery from Window-Manager**
  - File: `src/modules/order-book-collector/index.js`
  - Action: In `init()`, poll window-manager every 5s:
    ```javascript
    setInterval(async () => {
      const windows = await windowManager.getActiveWindows();
      const activeTokenIds = new Set();

      for (const w of windows) {
        activeTokenIds.add(w.token_id_up);
        activeTokenIds.add(w.token_id_down);

        if (!activeTokens.has(w.token_id_up)) {
          addToken(w.token_id_up, `${w.crypto}-up`);
        }
        if (!activeTokens.has(w.token_id_down)) {
          addToken(w.token_id_down, `${w.crypto}-down`);
        }
      }

      // Remove tokens no longer active
      for (const [tokenId] of activeTokens) {
        if (!activeTokenIds.has(tokenId)) {
          removeToken(tokenId);
        }
      }
    }, 5000);
    ```

#### Phase 5: Multi-Exchange Feed Collector

- [x] **Task 5.1: Add CCXT Dependency**
  - File: `package.json`
  - Action: Run `npm install ccxt`

- [x] **Task 5.2: Create CCXT Client Wrapper**
  - File: `src/clients/ccxt/index.js` (NEW)
  - Action: Create client that wraps CCXT for our exchanges:
    ```javascript
    import ccxt from 'ccxt';

    const EXCHANGES = ['binance', 'coinbase', 'kraken', 'bybit', 'okx'];
    const SYMBOLS = { btc: 'BTC/USDT', eth: 'ETH/USDT', sol: 'SOL/USDT', xrp: 'XRP/USDT' };

    let exchanges = {};

    export async function init() {
      for (const name of EXCHANGES) {
        exchanges[name] = new ccxt[name]({ enableRateLimit: true });
      }
    }

    export async function fetchTicker(exchange, symbol) {
      const ccxtSymbol = SYMBOLS[symbol];
      return await exchanges[exchange].fetchTicker(ccxtSymbol);
    }
    ```
  - Notes: CCXT handles rate limiting internally

- [x] **Task 5.3: Create Exchange Feed Collector Module**
  - File: `src/modules/exchange-feed-collector/index.js` (NEW)
  - Action: Create module that polls all exchanges at 1s:
    - `init(config)` — initialize CCXT client, start polling interval
    - Poll each exchange for BTC, ETH, SOL, XRP
    - Batch insert to `exchange_ticks` table
    - Handle individual exchange errors gracefully (continue with others)

- [x] **Task 5.4: Create Exchange Feed Collector Types**
  - File: `src/modules/exchange-feed-collector/types.js` (NEW)
  - Action: Create error class, default config with exchanges list and poll interval

#### Phase 6: Oracle Tracker Threshold Update

- [x] **Task 6.1: Make Threshold Configurable**
  - File: `src/modules/oracle-tracker/index.js`
  - Action: Read threshold from config instead of hardcoded default:
    ```javascript
    config = {
      minDeviationForUpdate: cfg.oracleTracker?.minDeviationForUpdate
        ?? DEFAULT_CONFIG.minDeviationForUpdate,
      // ... rest
    };
    ```

- [x] **Task 6.2: Lower Default Threshold**
  - File: `src/modules/oracle-tracker/types.js`
  - Action: Change `minDeviationForUpdate` from `0.0001` to `0.00001` (0.001%) for research phase
  - Notes: Can be overridden via config if too noisy

#### Phase 7: Integration & Validation

- [x] **Task 7.1: Register New Modules in Orchestrator**
  - File: `src/modules/orchestrator/index.js` (or wherever modules are registered)
  - Action: Add initialization for `clob-price-logger` and `exchange-feed-collector` modules

- [x] **Task 7.2: Add Diagnostic Queries Script**
  - File: `scripts/findthegold-diagnostics.js` (NEW)
  - Action: Create script that runs FINDTHEGOLD queries A-D against database and outputs results:
    - Query A: Chainlink price change frequency
    - Query B: Distribution of time between real price changes
    - Query C: Binance vs Chainlink spread
    - Query D: Oracle update frequency distribution
  - Notes: Copy SQL from `docs/FINDTHEGOLD.md` lines 203-304

- [x] **Task 7.3: Create Data Capture Health Check**
  - File: `src/routes/health.js` (extend existing)
  - Action: Add `/health/data-capture` endpoint that reports:
    - Pyth ticks in last minute
    - CLOB snapshots in last minute
    - L2 levels in last minute
    - Exchange ticks in last minute
    - Any gaps or staleness warnings

### Acceptance Criteria

#### AC1: Pyth Persistence
- [x] **Given** the system is running, **when** Pyth prices are polled at 1s intervals, **then** they are persisted to `rtds_ticks` table with topic `crypto_prices_pyth`
- [x] **Given** 1 hour of operation, **when** querying `rtds_ticks`, **then** there are ~3600 Pyth ticks per crypto (btc, eth, sol, xrp)

#### AC2: CLOB Price Snapshots
- [x] **Given** active 15-minute windows exist, **when** the CLOB price logger runs, **then** UP and DOWN token prices are captured every 1s throughout the full window
- [x] **Given** a window transitions from active to closed, **when** querying `clob_price_snapshots`, **then** there are ~900 snapshots for that window (15 min × 60 sec)
- [x] **Given** the WebSocket disconnects, **when** reconnection occurs, **then** the module resumes capturing without manual intervention

#### AC3: L2 Order Book Capture
- [x] **Given** active tokens are being tracked, **when** snapshot interval fires, **then** per-level bid/ask data (top 10 levels each side) is persisted to `order_book_levels`
- [x] **Given** a token's order book, **when** querying by `snapshot_id`, **then** the full book state at that moment can be reconstructed
- [x] **Given** no manual `addToken()` calls, **when** a new window becomes active, **then** its UP/DOWN tokens are automatically added for tracking

#### AC4: Multi-Exchange Feeds
- [x] **Given** CCXT is configured, **when** the exchange feed collector runs, **then** BTC/ETH/SOL/XRP prices from Binance, Coinbase, Kraken, Bybit, OKX are captured at 1s intervals
- [x] **Given** one exchange API fails, **when** the polling cycle runs, **then** other exchanges continue to be captured (graceful degradation)
- [x] **Given** 1 hour of operation, **when** querying `exchange_ticks`, **then** there are ~3600 ticks per exchange per crypto

#### AC5: Oracle Tracker Threshold
- [x] **Given** the oracle tracker is running, **when** Chainlink price changes by 0.001% (new threshold), **then** an update record is created in `oracle_updates`
- [x] **Given** config specifies a custom threshold, **when** the module initializes, **then** it uses the configured value instead of default

#### AC6: Auto-Discovery
- [x] **Given** a new 15-minute window becomes active, **when** the order-book-collector polls window-manager, **then** the new window's UP and DOWN tokens are automatically added for tracking within 5s
- [x] **Given** a window closes, **when** the next poll occurs, **then** those tokens are removed from active tracking

#### AC7: Diagnostic Queries
- [x] **Given** data has been captured for 24+ hours, **when** running `findthegold-diagnostics.js`, **then** queries A-D execute and output formatted results
- [x] **Given** the health endpoint is called, **when** data capture is healthy, **then** it reports tick counts > 0 for all sources in the last minute

#### AC8: Data Integrity
- [x] **Given** high write volume (~700K rows/hour), **when** the system runs for 24 hours, **then** no data loss occurs (verified via count queries)
- [x] **Given** PostgreSQL connection drops, **when** reconnection occurs, **then** buffered data is persisted via dead-letter retry

## Additional Context

### Dependencies

**New NPM Dependency:**
- `ccxt` — unified cryptocurrency exchange API library

**Existing Dependencies (already in package.json):**
- `ws` — WebSocket client for CLOB
- `pg` — PostgreSQL driver
- `axios` — HTTP client (used by spot client)

### Testing Strategy

**Unit Tests (per module):**
- `src/modules/clob-price-logger/__tests__/index.test.js` — WebSocket connection, event handling, snapshot persistence
- `src/modules/exchange-feed-collector/__tests__/index.test.js` — CCXT polling, error handling, graceful degradation
- `src/clients/ccxt/__tests__/index.test.js` — Exchange initialization, ticker fetching

**Integration Tests:**
- `src/__tests__/integration/data-capture.test.js` — End-to-end: source → module → database
- Verify row counts after fixed time period
- Verify schema correctness of persisted data

**Manual Validation:**
- Run system for 1 hour, execute diagnostic queries
- Compare Pyth vs Chainlink vs Exchange prices visually
- Verify no gaps in timestamp sequences

### Notes

**Data Volume Estimates (per hour):**
- Pyth: 4 cryptos × 3600 ticks = 14,400 rows
- CLOB prices: ~8 tokens × 3600 = 28,800 rows
- L2 order book: ~8 tokens × 3600 × ~20 levels = 576,000 rows
- Exchange feeds: 5 exchanges × 4 cryptos × 3600 = 72,000 rows
- Total: ~700K rows/hour → ~17M rows/day

**Retention Policy:**
- `order_book_levels`: 7-day retention (high volume)
- `clob_price_snapshots`: 30-day retention
- `exchange_ticks`: 30-day retention
- `rtds_ticks` (Pyth): follows existing 7-day policy
- Implement cleanup in each module following tick-logger pattern

**Risk Mitigations:**
- **DB Write Bottleneck:** Use batched inserts (TickBuffer pattern), transaction per batch
- **CCXT Rate Limits:** CCXT has built-in rate limiting; add per-exchange error counters
- **WebSocket Instability:** Exponential backoff reconnection; don't lose data during reconnect (buffer in memory)
- **Railway Resource Limits:** Monitor PostgreSQL storage; implement retention cleanup early

**Future Considerations (Out of Scope):**
- Adaptive sampling based on volatility (capture more during high vol)
- Direct Chainlink Data Streams API integration (requires research)
- Real-time alerting on data capture gaps
- Partitioned tables for better query performance on historical data
