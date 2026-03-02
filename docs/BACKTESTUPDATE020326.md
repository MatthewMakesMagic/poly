# Backtest Infrastructure PRD — 2026-03-02

## Problem Statement

The current backtester attempts to pull 100M+ rows of tick data from a remote Railway PostgreSQL database to a local machine. This has failed repeatedly due to:

- **OOM crashes** — 44M CLOB snapshots + 49M exchange ticks exceeds Node.js heap
- **Connection pool exhaustion** — parallel processes overwhelm Railway's connection limit
- **O(n^2) pagination** — `LIMIT/OFFSET` on 12M rows = 1,200 round trips
- **Stack overflows** — `Array.push(...largeArray)` exceeds call stack
- **Stale task state** — old task list items appearing as "in progress"

The fundamental issue: **compute is local, data is remote**. This is architecturally wrong for an analytical workload.

## Solution Overview

**Phase 1**: Fix code bugs, co-locate compute with data via `railway run`, persist results to DB, generate the report Matthew needs today.

**Phase 2**: Build a proper backtest service + dashboard review tab for ongoing strategy research.

---

## PHASE 1: Fix & Run

**Goal**: Get a complete backtest report (9 strategies x 4 instruments) with cheap entry analysis, persisted to DB, with a readable summary document.

### Task 1.1 — Fix stack overflow in data loader

**File**: `src/backtest/data-loader.js`

- Replace `result.push(...batch)` with loop-based concat (`for (const row of batch) result.push(row)`)
- Replace `LIMIT/OFFSET` pagination with cursor-based keyset pagination (`WHERE id > $lastId ORDER BY id ASC LIMIT $batchSize`)
- This eliminates both the stack overflow and the O(n^2) scan problem

### Task 1.2 — Verify symbol filter on CLOB loader

**File**: `src/backtest/data-loader.js`

- `loadAllClobSnapshots` already has `symbolPrefix` param added — verify it works with `WHERE symbol LIKE 'btc%'`
- `loadAllDataForSymbol` already added — verify it correctly passes `sharedRtds` to avoid reloading RTDS ticks
- Test: load BTC CLOB data, confirm row count is ~1/4 of total

### Task 1.3 — Fix per-symbol memory management

**File**: `scripts/run-all-strategies-fast.mjs`

- After processing each symbol, null out `symData.clobSnapshots` and `symData.exchangeTicks`
- Add `process.memoryUsage()` logging before/after each symbol to verify GC
- Verify heap stays under 4GB throughout a full run

### Task 1.4 — Create `backtest_runs` + `backtest_trades` tables

**New migration**: `045-backtest-results-tables.js`

```sql
CREATE TABLE IF NOT EXISTS backtest_runs (
  id SERIAL PRIMARY KEY,
  run_id UUID DEFAULT gen_random_uuid(),
  status VARCHAR(20) DEFAULT 'running', -- running, completed, failed
  config JSONB,                          -- strategies, symbols, capital, dates
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  total_strategies INT,
  total_symbols INT,
  total_windows INT,
  completed_pairs INT DEFAULT 0,         -- strategy x symbol pairs done
  progress_pct NUMERIC(5,2) DEFAULT 0,
  summary JSONB,                         -- overall metrics on completion
  ai_commentary TEXT,                    -- AI-generated analysis on completion
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id SERIAL PRIMARY KEY,
  run_id UUID REFERENCES backtest_runs(run_id),
  strategy VARCHAR(50) NOT NULL,
  strategy_description TEXT,             -- human-readable strategy logic summary
  symbol VARCHAR(10) NOT NULL,
  window_epoch BIGINT,
  window_close_time TIMESTAMPTZ,
  direction VARCHAR(10),                 -- 'up' or 'down'
  entry_price NUMERIC(10,6),
  exit_price NUMERIC(10,6),
  size NUMERIC(12,4),                    -- token count
  cost NUMERIC(10,4),
  pnl NUMERIC(10,4),
  payout NUMERIC(10,4),
  won BOOLEAN,
  reason TEXT,                           -- strategy's stated reason for trade
  confidence NUMERIC(5,4),
  time_to_close_ms INT,                 -- how long before window close the entry happened
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bt_trades_run ON backtest_trades(run_id);
CREATE INDEX idx_bt_trades_strategy ON backtest_trades(run_id, strategy, symbol);
CREATE INDEX idx_bt_trades_entry ON backtest_trades(run_id, entry_price);
CREATE INDEX idx_bt_trades_cheap ON backtest_trades(run_id, entry_price) WHERE entry_price < 0.20;
```

### Task 1.5 — Update backtest script to persist trades

**File**: `scripts/run-all-strategies-fast.mjs`

- At start: insert a row into `backtest_runs` with status='running', get `run_id`
- After each strategy x symbol: bulk insert trades to `backtest_trades`, update `completed_pairs` and `progress_pct`
- On completion: update `backtest_runs` with status='completed', summary JSON
- On failure: update with status='failed', error_message
- Each strategy must include its `description` (from the strategy file's docblock or `defaults.description`) in every trade row

### Task 1.6 — Micro test

Run a minimal validation before the full backtest:
- 1 strategy (`contested-contrarian`) x BTC x 50 windows
- Windows should include: clear direction (CLOB >0.90), contested (0.45-0.55), surprise flips (CLOB >0.80 wrong direction)
- Verify: trades persist to `backtest_trades`, metrics match expectations, no OOM/crashes
- Run via `railway run` to validate cloud execution

### Task 1.7 — Full backtest via `railway run`

- Execute: `railway run node --max-old-space-size=4096 scripts/run-all-strategies-fast.mjs`
- 9 strategies x 4 symbols x ~1,670 windows each
- Monitor progress by polling `backtest_runs` table
- Expected runtime: under 10 minutes with co-located compute

### Task 1.8 — Generate report

- Local script queries `backtest_trades` and `backtest_runs` for the completed run
- Produces a structured report saved to `docs/BACKTESTUPDATE020326-results.md`
- Report structure:
  1. **Overall summary** — total trades, total PnL, best/worst strategies
  2. **Per-instrument breakdown** (BTC, ETH, SOL, XRP) — each instrument's results across all strategies
  3. **Per-strategy breakdown** — each strategy's description, logic, and results across all instruments
  4. **Cheap entry analysis** — trades under $0.10, $0.10-0.20, $0.20-0.30 by strategy and instrument
  5. **Top 30 most profitable cheap trades** — the "slow market maker" opportunities
  6. **Worst 10 cheap losses** — what went wrong
  7. **AI-generated commentary** — per-instrument observations, per-strategy analysis, why certain strategies work on certain instruments, specific commentary on contrarian cheap entries and likely causes (slow MM repricing, oracle lag, etc.)

---

## PHASE 2: Backtest Service + Dashboard

**Goal**: Persistent backtest infrastructure with a dashboard review tab for ongoing strategy research.

### Task 2.1 — Backtest worker service

- Separate Railway service with its own Dockerfile (does NOT touch dashboard build)
- Same pattern as paper-trader: shared DB, independent deployment
- Triggered via API endpoint (`POST /api/backtest/start`) or CLI
- Reads strategy files, runs the parallel engine, writes to `backtest_runs` + `backtest_trades`
- Updates `progress_pct` in `backtest_runs` after each strategy x symbol pair completes

### Task 2.2 — CLI trigger + monitor

- `node scripts/trigger-backtest.mjs --full` — triggers a new backtest run
- `node scripts/trigger-backtest.mjs --status` — shows current run progress
- `node scripts/trigger-backtest.mjs --report <run_id>` — pulls and displays results
- Polls `backtest_runs` every 30s, shows progress bar in terminal

### Task 2.3 — Dashboard: Backtest Review tab

New `/backtest` route in the Next.js dashboard:

**Active Run View:**
- Progress bar showing % complete
- Current strategy x symbol being processed
- ETA based on elapsed time and pairs remaining

**Completed Runs List:**
- Table of historical runs with date, status, total trades, overall PnL
- Click into any run for the full report

### Task 2.4 — Dashboard: Results view (the main event)

When viewing a completed backtest run:

**Header:**
- Run date, duration, config summary
- **AI-Generated Commentary** — the headline analysis. Not just a number summary — explains WHY strategies performed differently per instrument, calls out cheap entry / slow market maker opportunities, identifies which instruments have real edge vs noise. This is generated automatically on backtest completion and stored with the run.

**Strategy Cards:**
- Each strategy gets a card with:
  - **Strategy name + description** — what it tests, the base logic, entry conditions (surfaced from the strategy file's docblock)
  - Per-instrument results table (WR%, PnL, avg entry, ROC, trades, Sharpe)
  - Cheap entry breakdown for that strategy

**Filters:**
- Filter by instrument (BTC / ETH / SOL / XRP / ALL)
- Filter by strategy (dropdown of all strategies)
- Filter by entry price range (< $0.10, $0.10-0.20, etc.)
- Sort by: PnL, win rate, ROC, trade count

**Cheap Entry Deep Dive:**
- Dedicated section showing all trades under $0.20
- Sortable by PnL, entry price, strategy
- Each trade row: strategy, instrument, entry price, tokens, cost, PnL, ROC%, reason
- Highlights trades where the strategy was contrarian (bet against CLOB consensus) and won

### Task 2.5 — AI-generated commentary (per-run)

On every backtest completion (not optional):
- Generate natural-language analysis of the full results
- Structure: overall take, per-instrument observations, per-strategy analysis, cheap entry opportunities
- Specifically address: why certain strategies outperform on BTC but not SOL/XRP, whether cheap entries correlate with slow MM repricing or oracle lag, which strategy x instrument combinations are worth trading live
- Store in `backtest_runs.ai_commentary`
- Display as the headline of the dashboard results view

---

## Strategy Descriptions (for reference)

Each strategy file in `src/backtest/strategies/` must export a `description` string that gets stored with every trade and displayed in the dashboard. Current strategies:

| Strategy | Logic |
|----------|-------|
| `contested-contrarian` | When CLOB shows contested market (both UP/DOWN tokens 0.35-0.65) and exchange median disagrees with CLOB, bet with exchange direction |
| `contested-contrarian-l2` | Same as above + L2 order book depth confirmation (bid/ask imbalance) |
| `exchange-consensus` | When 3+ of 5 exchanges agree on direction and CLOB hasn't repriced, bet with exchange consensus |
| `cl-direction-follower` | Follow Chainlink oracle direction (CL@latest vs CL@open), enter when CLOB is cheap |
| `clob-value-buyer` | Buy tokens priced below fair value based on oracle signal, regardless of CLOB consensus |
| `edge-c-asymmetry` | Exploit asymmetric payoff when CLOB is near 0.50 but oracle strongly favors one direction |
| `exchange-oracle-divergence` | When exchange prices diverge from oracle by >$X threshold, bet on convergence direction |
| `late-momentum-reversal` | In final 30-90s, when CLOB momentum reverses (was going UP, now selling off), bet on reversal |
| `clob-reversal` | Detect sudden CLOB price reversals and follow the new direction |

---

## Technical Notes

- **Railway compute**: Verify memory allocation is >= 4GB for the backtest service
- **Database**: All tables on existing Railway PostgreSQL instance
- **Dashboard**: Existing Next.js app at `/Users/matthewkirkham/poly/dash` (or wherever deployed)
- **No Gamma API calls**: All ground truth data is already backfilled in `window_close_events.gamma_resolved_direction`. The backtester only reads from the DB.
- **Binary option P&L**: cost = entryPrice x tokens, payout = win ? $1.00 x tokens : $0.00, PnL = payout - cost
- **Capital-based sizing**: $2 per trade. fillSize = capitalPerTrade / fillPrice. Entry at $0.08 = 25 tokens, win = $25, profit = $23 (1,150% ROC)

## Files Modified (Phase 1 prep, already done)

- `src/backtest/data-loader.js` — added `loadAllDataForSymbol()`, symbol-filtered CLOB loading
- `src/backtest/simulator.js` — `capitalPerTrade` support, L2 liquidity check
- `src/backtest/metrics.js` — dollar-based metrics (dollarPnlPerTrade, avgCostPerTrade, returnOnCapitalPerTrade)
- All 9 strategy files — changed from `positionSize: 1` to `capitalPerTrade: 2`
- `scripts/run-all-strategies-fast.mjs` — per-symbol loading, cheap entry analysis, 6GB heap

## Code Bugs to Fix (Phase 1 blockers)

1. `data-loader.js:123` — `result.push(...batch)` stack overflow on large batches. Fix: loop push.
2. `data-loader.js:85-109` — `LIMIT/OFFSET` pagination is O(n^2). Fix: keyset pagination `WHERE id > $lastId`.
3. `data-loader.js:399-411` — `loadAllClobSnapshots` loads all symbols when no filter given. Fix: always require symbol filter in backtest context.
