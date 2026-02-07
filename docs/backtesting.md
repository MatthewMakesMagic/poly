# Backtesting Framework

Three backtest modes for different speed/fidelity tradeoffs. All share the same strategy interface and resolution mechanics.

## Resolution Mechanics

All modes resolve the same way:

```
chainlink_close > strike ? UP : DOWN
```

- **Strike**: set at window open from Polymarket reference or Binance snapshot
- **Settlement**: Chainlink Data Streams price at window close
- **Structural bias**: Chainlink runs ~$60-100 below exchange cluster, creating a persistent DOWN bias
- **Binary payout**: winning tokens pay $1.00, losing tokens pay $0.00

## Backtest Modes

### Fast-Track (~1-2s)

Pre-computed market state snapshots stored in `window_backtest_states`. One `SELECT` loads everything, then sweeps run purely in-memory.

**Data**: 31 snapshots per window at 10-second intervals (5 min window). Each snapshot captures chainlink, polyRef, CLOB up/down, 5 exchange prices, strike, and resolution.

**When to use**:
- Structural strategies (deficit-based, ref-to-strike gap, CLOB pricing)
- Parameter sweeps (120 configs in 19ms)
- Rapid iteration on strategy logic
- Any strategy where the edge is persistent, not timing-dependent

**When NOT to use**:
- Strategies that need exact fill timing within the window
- Latency arbitrage between feeds
- CLOB depth/order book dynamics
- Sub-10-second price dynamics

**Run**:
```bash
export $(grep DATABASE_URL .env.local | xargs)
node src/backtest/run-edge-c-fast.cjs
```

**Rebuild** (after new windows are captured):
```bash
node src/backtest/build-fast-track.cjs
```

### Window-Centric (~30s)

Queries market state on-demand per window from raw tick tables. Flexible sample points, no pre-computation needed.

**Data**: Live queries against `rtds_ticks`, `clob_price_snapshots`, `exchange_ticks` with indexed lookups. Gets latest state at any arbitrary timestamp.

**When to use**:
- Validating fast-track results against raw data
- Strategies needing custom sample points (not aligned to 10s grid)
- Ad-hoc analysis of specific windows
- When fast-track table hasn't been rebuilt yet

**Run**:
```bash
export $(grep DATABASE_URL .env.local | xargs)
node src/backtest/run-edge-c.cjs
```

**Requires indexes** (already created on Railway):
```sql
CREATE INDEX idx_clob_snap_symbol_time ON clob_price_snapshots(symbol, timestamp DESC);
CREATE INDEX idx_rtds_ticks_topic_time ON rtds_ticks(topic, timestamp DESC);
```

### Full Replay (minutes)

Loads entire merged timeline and replays every tick through the engine. The engine module (`src/backtest/engine.js`) drives this mode.

**Data**: All ticks from `rtds_ticks`, `clob_price_snapshots`, `exchange_ticks` merged into a single sorted timeline. Every event updates market state, and the strategy evaluates on each tick.

**When to use**:
- Latency arbitrage (exact feed arrival timing matters)
- CLOB depth strategies (order book changes between snapshots)
- Feed divergence detection (cross-feed timing)
- Strategies with multiple entries/exits per window
- Anything where sub-second timing matters

**Run via engine API**:
```javascript
import { runBacktest } from './backtest/index.js';
import * as edgeC from './backtest/strategies/edge-c-asymmetry.js';

const result = await runBacktest({
  startDate: '2026-02-06T04:00:00Z',
  endDate: '2026-02-06T06:00:00Z', // keep range small
  strategy: edgeC,
  strategyConfig: { deficitThreshold: 80 },
  verbose: true,
});
```

**Caution**: Loading 25 hours of data requires ~4.5M rows and 2GB+ RAM. Keep date ranges small or filter by symbol/topic.

## Strategy Interface

All modes use the same strategy contract:

```javascript
// Strategy must export:
export const name = 'my-strategy';

export function evaluate(state, config) {
  // state.chainlink  — { price, ts }
  // state.polyRef    — { price, ts }
  // state.strike     — number
  // state.clobDown   — { bestBid, bestAsk, mid, spread, ts }
  // state.clobUp     — { bestBid, bestAsk, mid, spread, ts }
  // state.window     — { symbol, closeTime, timeToCloseMs, resolvedDirection }
  // state.getExchange('binance') — { price, bid, ask, ts }
  // state.getChainlinkDeficit() — strike - chainlink.price

  return []; // empty = no action
  // or: [{ action: 'buy', token: 'btc-down', size: 1, reason: '...', confidence: 0.8 }]
}

// Optional hooks (full replay mode only):
export function onWindowOpen(state, config) {}
export function onWindowClose(state, windowResult, config) {}
```

## Signal Format

```javascript
{
  action: 'buy' | 'sell',
  token: 'btc-down' | 'btc-up' | 'eth-down' | etc,  // hyphen format
  size: 1,            // number of tokens
  reason: 'string',   // required — logged in decision trail
  confidence: 0.8,    // optional, 0-1
}
```

## Feed Naming

| Tier | Code Name | Source | Role |
|------|-----------|--------|------|
| Oracle | `chainlink` | RTDS `crypto_prices_chainlink` | Settles the market |
| Oracle | `strike` | `window_close_events.strike_price` | Resolution threshold |
| Reference | `polyRef` | RTDS `crypto_prices` | What CLOB traders watch (NOT Binance) |
| Exchange | `exchange_binance` etc | `exchange_ticks` table | 5 exchanges, none privileged |
| CLOB | `clobDown`, `clobUp` | `clob_price_snapshots` | The market we trade on |

## Database Tables

| Table | Rows | Size | Purpose |
|-------|------|------|---------|
| `rtds_ticks` | 1.6M | 426 MB | Oracle + reference price ticks |
| `clob_price_snapshots` | 3.2M | 1.3 GB | CLOB token prices |
| `exchange_ticks` | 850K | 173 MB | 5 exchange feeds |
| `window_close_events` | 856 | 552 KB | Ground truth: strike, resolution |
| `window_backtest_states` | 6.4K | 2.3 MB | Pre-computed fast-track states |

## Key Files

| File | Purpose |
|------|---------|
| `src/backtest/engine.js` | Full replay engine with parameter sweep |
| `src/backtest/data-loader.js` | PostgreSQL async loaders for all tables |
| `src/backtest/market-state.js` | 3-tier feed state with accessors |
| `src/backtest/simulator.js` | Binary option position/PnL simulator |
| `src/backtest/strategies/edge-c-asymmetry.js` | Example strategy |
| `src/backtest/run-edge-c-fast.cjs` | Fast-track runner (standalone) |
| `src/backtest/run-edge-c.cjs` | Window-centric runner (standalone) |
| `src/backtest/build-fast-track.cjs` | Builds `window_backtest_states` table |
| `src/backtest/__tests__/smoke-test.cjs` | Integration test against prod DB |

## Performance

| Operation | Before Indexes | After Indexes |
|-----------|---------------|---------------|
| CLOB lookup | 3,008ms | 3ms |
| RTDS lookup | 3.7ms | 0.06ms |
| Window-centric (100 windows) | 30 min | 30s |
| Fast-track (207 windows + 120-config sweep) | N/A | 1.5s |
