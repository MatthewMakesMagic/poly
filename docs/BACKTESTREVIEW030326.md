# Backtest Review — March 3, 2026

## Summary

Full backtest ran across 1,681 BTC windows (Feb 11 – Mar 2) using local SQLite (24.9 GB). Initial results showed inflated win rates due to **incorrect CLOB data** — the backtest was reading $0.50 flat pre-window reset prices instead of real orderbook data.

After correcting the CLOB lookup, the **edge-c-asymmetry** strategy showed a genuine timing edge on a 100-window random sample: 18 trades, 18 wins, avg entry $0.49, avg PnL $2.10/trade.

---

## Critical Bug: CLOB Epoch Mismatch

### The Problem

The `loadWindowTickData` function in `data-loader-sqlite.js` computed:
```js
windowEpoch = Math.floor(closeMs / 1000)  // window CLOSE time
```

But `clob_price_snapshots.window_epoch` is tagged with the window **OPEN** epoch (set by `window-close-event-recorder` via `Math.floor(nowSec / WINDOW_DURATION_SECONDS) * WINDOW_DURATION_SECONDS`).

Result: every CLOB query returned the **next** window's pre-open data (flat $0.50) instead of the current window's actual trading data.

### The Fix Required

Two changes needed in `data-loader-sqlite.js` `loadWindowTickData`:

1. **Correct epoch**: Use `closeSec - 900` (close minus one window duration) instead of `closeSec` for window_epoch lookup
2. **Token identification**: Each 15-min window has a unique `token_id`. The query must identify the correct token — the one with prices in the 0.05–0.95 range (not converging to 0 or 1, which are adjacent windows' tokens winding down)
3. **MEMORY.md warning applies**: "CLOB queries MUST filter by `window_epoch` + `timestamp >= to_timestamp(window_epoch)` to exclude pre-window $0.50 data"

### Additional Note

The `window_close_events.market_down_price_*` columns come from the **Gamma API `outcomePrices`** (last traded price), NOT from the CLOB orderbook. These are a different price source and don't match CLOB best_ask/best_bid exactly.

---

## Initial (Incorrect) Backtest Results — All Strategies

Ran against flat $0.50 CLOB data. These numbers are **invalid** but recorded for reference:

| Strategy | Trades | WR% | Total PnL | Sharpe |
|---|---|---|---|---|
| edge-c-asymmetry | 182,351 | 95.5% | $345,541 | 2.16 |
| contested-contrarian-l2 | 1,561 | 91.6% | $2,679 | 21.00 |
| contested-contrarian | 1,561 | 91.6% | $2,679 | 21.00 |
| exchange-consensus | 1,599 | 87.3% | $2,464 | 16.78 |
| cl-direction-follower | 1,116 | 91.7% | $1,930 | 14.61 |
| clob-value-buyer | 1,167 | 86.3% | $1,755 | 12.07 |
| clob-reversal | 1 | 100% | $1.81 | 0.39 |
| exchange-oracle-divergence | 3 | 33.3% | -$1.96 | -0.22 |
| late-momentum-reversal | 9 | 33.3% | -$4.69 | -0.28 |

**All results above are compromised by the $0.50 CLOB bug.** Must re-run after fix.

---

## Corrected Sample: edge-c-asymmetry (100 Random Windows)

After fixing the CLOB epoch lookup and identifying correct tokens:

- **Windows tested**: 100 random BTC windows (post Feb 17)
- **CL deficit > $80 triggered**: 42 windows
  - **ALL 42 on DOWN-resolution windows, 0 on UP** — the signal is highly selective
- **No entry < $0.65 (market already repriced)**: 24 windows
- **Trades executed**: 18
- **Wins**: 18 | **Losses**: 0 | **WR**: 100%
- **Total PnL**: $37.82
- **Avg PnL/trade**: $2.10
- **Avg entry**: ~$0.49

### Interpretation

The strategy detects when CL has moved >$80 below strike in the last 2 minutes. Since resolution = `CL@close >= CL@open ? UP : DOWN`, a large CL deficit strongly implies DOWN resolution. The edge is that the CLOB hasn't fully repriced yet in ~43% of triggered windows (18/42).

This is a **real-time information asymmetry**, not a prediction:
- The strategy reads live CL ticks showing a clear downward move
- The CLOB hasn't fully caught up (still pricing DOWN at $0.43–$0.61)
- When the CLOB HAS caught up (>$0.65), the strategy correctly passes

### Key Questions for Live Trading
- Is 18% hit rate per window (18/100) enough volume?
- How much size can you fill at these prices? (Need L2 depth data — `bid_size_top`/`ask_size_top` from corrected CLOB queries)
- Does this persist once someone trades it with real money? (MMs may adapt)
- $80 deficit threshold: could be optimized but risk of overfitting

---

## Ground Truth Validation

- **1,618/1,681 BTC windows** have `gamma_resolved_direction` (96.3%)
- Gamma vs CL-computed: **96.7% match** (1,390/1,438 where both available)
- 48 mismatches are all tiny CL moves (<$15) — gamma is correct (on-chain truth)
- Overall distribution: **834 UP (51.6%)**, **783 DOWN (48.4%)** — roughly 50/50 as expected

---

## Database State

| Table | Rows | Range |
|---|---|---|
| window_close_events | 6,724 | Feb 11 → Mar 2 |
| rtds_ticks | 12,404,185 | Feb 16 → Mar 2 |
| clob_price_snapshots | 44,646,820 | Feb 11 → Mar 2 |
| exchange_ticks | 48,460,000 | Feb 11 → Mar 1 |

SQLite: 24.9 GB at `data/backtest.sqlite`

---

## Next Steps

1. **Fix `data-loader-sqlite.js`** — correct epoch mapping and token identification
2. **Re-run full backtest** across all 9 strategies with corrected CLOB data
3. **Add L2 depth analysis** — check `bid_size_top`/`ask_size_top` to estimate fillable size
4. **Test other strategies** — contested-contrarian, exchange-consensus etc. may also show different results with real CLOB prices
5. **Out-of-sample validation** — export more recent data to test forward
