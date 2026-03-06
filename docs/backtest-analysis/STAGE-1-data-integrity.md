# Stage 1: Data Integrity Fixes

**Date:** 2026-03-03
**Scope:** BTC only (1,681 windows in SQLite backtest database)

---

## Problems Found & Fixed

### 1. Backtest Runner — OOM / Bulk Loading

**Problem:** `run-backtest-fast.mjs` called `loadAllDataForSymbol()` which loaded 12M+ CLOB rows, 12M+ exchange ticks, and 12M RTDS ticks into memory per symbol. Crashed with OOM (exit code 134) before producing any results.

**Fix:** Rewrote runner to call `loadWindowTickData()` per window (~2-3K rows each). Multi-strategy batching preserved — timeline built once per window, all strategies evaluated against it.

**Result:** Full BTC backtest (1,212 windows x 9 strategies) completes in 85 seconds. Memory usage trivial.

**Files changed:**
- `scripts/run-backtest-fast.mjs` — complete rewrite of data loading loop

### 2. CLOB Epoch Assignment

**Problem:** CLOB snapshots were being loaded with wrong `window_epoch` values, pulling prices from adjacent windows (converging to 0 or 1, not the active 0.05-0.95 range).

**Fix:** `loadWindowTickData()` correctly computes `windowEpoch = Math.floor(closeMs/1000) - 900` and filters CLOB data to that epoch plus active range (0.05-0.95).

**Verification:** 8/10 test windows showed real CLOB price movement after fix. 2 skipped due to genuine data conditions (not bugs).

**Files changed:**
- `src/backtest/data-loader-sqlite.js` — epoch calculation in `loadWindowTickData()`

### 3. SQLite Indexes for Per-Window Queries

**Problem:** No composite index for the per-window CLOB query pattern (`WHERE window_epoch = ? AND symbol LIKE ? AND timestamp BETWEEN ? AND ?`). Queries hitting 44M row table were slow.

**Fix:** Added three indexes:
- `idx_clob_epoch_sym_ts` on `clob_price_snapshots(window_epoch, symbol, timestamp)`
- `idx_clob_epoch_ts` on `clob_price_snapshots(window_epoch, timestamp)`
- `idx_rtds_ts_topic` on `rtds_ticks(timestamp, topic)`

Also bumped SQLite pragmas: `cache_size = -256000` (256MB), `mmap_size = 2147483648` (2GB).

**Result:** Per-window CLOB query: ~3ms warm.

**Files changed:**
- `scripts/add-backtest-indexes.mjs` — index creation script
- `src/backtest/data-loader-sqlite.js` — updated pragmas

### 4. `window_close_events.market_up_price_*` Fields — Inverted/Wrong

**Problem:** The recorder's `windowManager.fetchMarket()` returns values that don't match raw CLOB data. Example: raw CLOB shows `btc-up = 0.065` (market pricing DOWN at 93.5%), but recorder stored `market_up_price_60s = 0.915` — nearly the exact inverse.

**Root cause:** The recorder calls the Polymarket API live at scheduled intervals. This is a different data source from our captured `clob_price_snapshots`. The values appear inverted or come from a different token/epoch.

**Fix:** Do not use `market_up_price_*` fields for analysis. Query raw `clob_price_snapshots` directly with correct epoch filtering.

**Impact:** The initial "80% of flips never corrected" finding was completely wrong — built on these inverted values. Real data shows the opposite: 84% of flips DO correct before close.

### 5. Resolution Ground Truth — Onchain Backfill

**Problem:** Resolution direction came from three sources with different reliability:
- `gamma_resolved_direction` — from Polymarket Gamma API (1,618 of 1,681 windows)
- `onchain_resolved_direction` — from Polygon CTF contract (was 0 for BTC)
- `resolved_direction` — from our CL@close >= CL@open formula (63 windows)

Cross-checking gamma vs CL formula showed 96.8% agreement overall, but **32% disagreement on flip windows** — the exact cases we care about.

**Fix:** Backfilled `onchain_resolved_direction` for all 1,789 BTC windows by reading the CTF contract's `payoutNumerators` on Polygon. This is the actual settlement — money changed hands based on this value.

**Verification:**
- Onchain vs Gamma: **99.9% agreement** (1,617 match, 1 mismatch)
- Onchain vs CL formula: **96.7% agreement** (1,451 match, 49 mismatch)
- Gamma was essentially correct all along
- CL formula has timing imprecision (our captured CL@open/CL@close don't exactly match settlement timestamps)

**Files changed:**
- `scripts/backfill-onchain-resolution.mjs` — reads condition_ids from Postgres, calls Polygon CTF, writes to SQLite

---

## Data State After Stage 1

| Data Source | Status | Notes |
|-------------|--------|-------|
| Raw CLOB snapshots (`clob_price_snapshots`) | **Trusted** | Correct epoch tagging, proper symbol filtering |
| Raw RTDS ticks (`rtds_ticks`) | **Trusted** | Chainlink + Polymarket reference prices |
| Raw exchange ticks (`exchange_ticks`) | **Trusted** | 5 exchanges, BTC + ETH |
| `window_close_events.onchain_resolved_direction` | **Gold standard** | Verified on-chain for all 1,681 BTC windows |
| `window_close_events.gamma_resolved_direction` | **Reliable** | 99.9% match with onchain |
| `window_close_events.market_up_price_*` | **DO NOT USE** | Inverted/wrong values from different data source |
| `window_close_events.oracle_price_at_open/close` | **Approximate** | ~3% disagreement with onchain on direction for small CL moves |

---

## Key Findings from Clean Data

### Flip Analysis (onchain-verified)

- **1,422 windows** where CLOB was 80/20 confident at T-60s
- **38 flips** (2.7%) — market was wrong despite high confidence
- **32 of 38 flips** (84%) — CLOB crossed 0.50 before close (market self-corrected)
- **6 flips** (16%) — CLOB never crossed 0.50 (market still wrong at T-1s)

### Confidence Tier Flip Rates

| Confidence | Windows | Flip Rate |
|-----------|---------|-----------|
| 95/5 | 1,121 | 0.7% |
| 90/10 | 152 | 5.9% |
| 85/15 | 72 | 11.1% |
| 80/20 | 77 | 16.9% |
| 70/30 | 107 | 26.2% |
| 60/40 | 87 | 28.7% |
| 50/50 | 65 | 47.7% |

### Big Swings

- **242 windows** (14.4%) had >20pt CLOB movement in final 60s
- **94% moved TOWARD the correct resolution** — CLOB is self-correcting
- Only 6% moved away from resolution

---

## What's NOT Yet Done

- [ ] ETH/SOL/XRP onchain backfill (BTC only so far)
- [ ] Fix `windowManager.fetchMarket()` inversion bug in live recorder
- [ ] Root cause analysis of the 38 flip windows (Stage 2: WHY did they flip?)
- [ ] Investigate what VWAP, exchange data, L2 book depth showed in each flip
