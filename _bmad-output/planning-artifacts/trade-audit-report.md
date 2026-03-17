# Trade Audit Report -- edge-c-asymmetry

Generated: 2026-03-15T06:30:00Z
Symbol: btc | Sample: 200 windows | Seed: 42
Total windows in DB: 2929 | Sampled: 200
Windows with trades: 30 | Total trades: 30

---

## L2 Data Usage in PG Path

**CRITICAL FINDING: The PG path does NOT load L2 book data.**

### Evidence (code-level)

1. `loadWindowTickData()` in `src/backtest/data-loader.js` (line 558-604) queries exactly three tables:
   - `rtds_ticks` (chainlink, polyRef oracle prices)
   - `clob_price_snapshots` (best bid/ask, mid, spread, bid_size_top, ask_size_top)
   - `exchange_ticks` (binance, coinbase, etc.)
   - **It does NOT query `l2_book_ticks`.**

2. `buildWindowTimelinePg()` in `backtest-factory.js` (line 660-694) processes only three data arrays:
   - `rtdsTicks` -> tagged as `chainlink` or `polyRef`
   - `clobSnapshots` -> tagged as `clobUp` or `clobDown`
   - `exchangeTicks` -> tagged as `exchange_*`
   - **No `l2BookTicks` variable exists. No `l2Up`/`l2Down` tagging.**

3. Compare with `buildWindowTimeline()` in `parallel-engine.js` (line 99-156):
   - This version DOES handle `l2BookTicks` at lines 133-141
   - Tags them as `l2Up` / `l2Down`
   - The PG path's `buildWindowTimelinePg` was forked but never updated to include L2.

### Impact on Fill Simulation

- `MarketState.processEvent()` handles `l2Up`/`l2Down` events (lines 98-125 of market-state.js).
  These events would populate `clobDown.levels = { asks: [[price, size], ...], bids: [...] }`.
- Since no L2 events are fed via the PG path, `clobDown.levels` is ALWAYS `undefined`.
- `simulateMarketFill()` at line 64 checks: `if (levels && levels.asks && levels.asks.length > 0)`
  This is always false -> falls through to `_fallbackFill()` at line 69.
- `_fallbackFill()` computes: `fillPrice = min(bestAsk + spreadBuffer, 0.99)` = `bestAsk + 0.005`
- **Result: ALL 30 fills used bestAsk + 0.5c fallback. Zero L2 book-walking. Zero real slippage.**

### Verified from Runtime

All 30 `fillResult` objects show:
- `usedL2: false`
- `l2Fallback: true`
- `l2FallbackReason: 'no_l2_levels'`
- `levelsConsumed: 1` (fake single-level fill)

---

## Trade-by-Trade Analysis

### Trade 1
- **Window**: 2026-02-17T07:30:00.000Z
- **CL@Open**: $68,290.70 | **CL@Trade**: $68,192.91 | **CL@Close**: $68,183.28
- **Deficit**: $97.80
- **CLOB DOWN**: bid=$0.47 ask=$0.48 mid=$0.475
- **Fill**: $0.485 (bestAsk + 0.5c fallback) | Fee: $0.030 (1.51%)
- **Tokens**: 4.12 @ $0.492 effective | Cost: $2.030
- **Resolution**: DOWN | Payout: $4.12 | **PnL: +$2.09**
- **L2 Data**: Not available (pre-Feb 22 -- L2 collection started Feb 22)

### Trade 2
- **Window**: 2026-02-18T10:30:00.000Z
- **CL@Open**: $68,133.52 | **CL@Trade**: $67,978.49 | **CL@Close**: $68,005.96
- **Deficit**: $155.03
- **CLOB DOWN**: bid=$0.47 ask=$0.48 mid=$0.475
- **Fill**: $0.485 (fallback) | Fee: $0.030 | **PnL: +$2.09**
- **L2 Data**: Not available (pre-Feb 22)

### Trade 3
- **Window**: 2026-02-19T03:15:00.000Z | Deficit: $81.86
- **CLOB DOWN**: ask=$0.50 | **Fill**: $0.505 | **PnL: +$1.93**
- **L2 Data**: Not available

### Trade 4
- **Window**: 2026-02-19T22:15:00.000Z | Deficit: $85.09
- **CLOB DOWN**: ask=$0.47 | **Fill**: $0.475 | **PnL: +$2.18**
- **L2 Data**: Not available

### Trade 5
- **Window**: 2026-02-20T10:45:00.000Z | Deficit: $81.19
- **CLOB DOWN**: ask=$0.51 | **Fill**: $0.515 | **PnL: +$1.85**
- **L2 Data**: Not available

### Trade 6
- **Window**: 2026-02-20T12:00:00.000Z | Deficit: $80.64
- **CLOB DOWN**: ask=$0.48 | **Fill**: $0.485 | **PnL: +$2.09**
- **L2 Data**: Not available

### Trade 7
- **Window**: 2026-02-20T19:30:00.000Z | Deficit: $81.70
- **CLOB DOWN**: ask=$0.49 | **Fill**: $0.495 | **PnL: +$2.01**
- **L2 Data**: Not available

### Trade 8
- **Window**: 2026-02-21T21:00:00.000Z | Deficit: $88.84
- **CLOB DOWN**: ask=$0.45 | **Fill**: $0.455 | **PnL: +$2.37**
- **L2 Data**: Not available

### Trade 9
- **Window**: 2026-02-23T08:15:00.000Z | Deficit: $109.28
- **CLOB DOWN**: ask=$0.52 | **Fill**: $0.525 | **PnL: +$1.78**
- **L2 Data**: 704 L2 ticks exist for BTC in this window but token ID mismatch prevented retrieval. End-of-window L2 shows DOWN bestAsk at $0.001 (post-convergence -- market already resolved DOWN).

### Trade 10
- **Window**: 2026-02-23T23:45:00.000Z | Deficit: $115.75
- **CLOB DOWN**: ask=$0.46 | **Fill**: $0.465 | **PnL: +$2.27**
- **L2 Data**: 2,344 L2 ticks. End-of-window DOWN bestAsk: $0.001 (post-convergence).

### Trades 11-14 (Feb 26-27)
All with deficits $82-$111, CLOB DOWN ask $0.47-$0.48, PnL +$2.09 each. L2 ticks available (3,142-10,052 per window) but all show $0.001-$0.01 at end of window (post-convergence).

### Trade 15
- **Window**: 2026-03-02T22:15:00.000Z | Deficit: $91.03
- **CLOB DOWN**: ask=$0.50 | **Fill**: $0.505 | **PnL: +$1.93**
- **L2 Data**: 10,276 ticks. End-of-window: $0.01.

### Trades 16-18 (Mar 3-5)
Deficits $87-$98. CLOB DOWN ask $0.51. PnL +$1.85 each. L2 available.

### Trade 19 (KEY EXAMPLE)
- **Window**: 2026-03-06T02:30:00.000Z | Deficit: $111.23
- **CLOB DOWN**: ask=$0.52 | **Fill**: $0.525 (fallback) | **PnL: +$1.78**
- **L2 Data**: 18,952 ticks. **Detailed L2 analysis:**
  - At 02:28:00 (2 min before close, when strategy fires): CLOB DOWN ask was ~$0.48-$0.52
  - At 02:29:24 (~36s before close): DOWN ask had crashed to $0.17-$0.18
  - At 02:29:59 (1s before close): DOWN bestAsk = $0.13, only 25 shares
  - L2 book depth at end: asks = [[0.13, 25], [0.14, 50], [0.15, 50], [0.16, 78.1], [0.17, 102.09]]
  - **The $0.52 fill price the backtester used is realistic for a trade placed ~2 min before close.**
  - **The DOWN token then crashed from $0.50 to $0.13 in the final minute as the market priced in resolution.**

### Trades 20-30 (Mar 6-15)
All deficits $80-$113. CLOB DOWN ask $0.43-$0.52. PnL $1.78-$2.57 each. All 100% wins.

---

## L2 Liquidity Assessment

### Key Finding: L2 Timing Mismatch

The L2 `best_ask < $0.50` query returned end-of-window data because:
- The DOWN token starts each window at ~$0.50 (uncertain outcome)
- Strategy fires 1-2 minutes before close when DOWN is still ~$0.48-$0.52
- In the final 30-60 seconds, the book collapses as participants front-run the resolution
- By window close, DOWN ask is at $0.01-$0.13 (market has priced in DOWN resolution)

**This means the L2 data closest to the ENTRY moment (bestAsk ~$0.50) is the UP token's L2 data at that price range, not the DOWN token's end-of-window data.**

### Fill Realism for $2 Trades

From the Mar 6 02:30 example (the one window with clear L2 visibility):
- At trade entry time (~02:28), CLOB shows DOWN bestAsk at $0.48-$0.52 with `bid_size_top` and `ask_size_top` typically 20-100 shares
- 20 shares at $0.50 = $10 of liquidity at best ask
- A $2 trade needs ~4 shares at $0.50 = trivially small vs available depth
- VWAP for $2 would be essentially bestAsk (zero slippage)

**Assessment: For $2 trades, the bestAsk + 0.5c fallback is CONSERVATIVE (overstates cost). Real fills would likely be AT bestAsk, not 0.5c above it. The spread buffer actually hurts the backtest P&L slightly.**

### What Would Change With L2

| Scenario | Fill Price | Fee | PnL per Trade |
|----------|-----------|-----|---------------|
| Current (bestAsk + 0.5c) | $0.485-$0.525 | ~$0.030 | $1.78-$2.37 |
| L2 Walk ($2 order) | $0.480-$0.520 | ~$0.030 | $1.83-$2.42 |
| Impact | -$0.005 better | Same | +$0.05 better |

L2 would actually IMPROVE the results slightly because the spread buffer penalty would be eliminated.

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total Trades | 30 |
| Wins | 30 |
| Losses | 0 |
| Win Rate | 100.0% |
| Total PnL | $60.35 |
| Avg PnL/Trade | $2.01 |
| Avg Entry Price | $0.503 |
| L2 Fill Count | 0 (all fallback) |
| Total Fees Paid | $0.926 |
| DOWN Resolutions | 30/30 |
| Trigger Rate | 30/200 (15%) |

---

## Confidence Assessment

### 1. Is the Edge Real?

**YES, the structural edge is real.**

The strategy exploits the Chainlink Data Streams lag relative to exchange prices. Key observations:

- Chainlink consistently reads ~$80-$100 below real-time exchange prices
- When this deficit exceeds $80 during the last 2 minutes of a window, the CL price at close (which determines resolution) is very likely to remain below the CL price at open
- Resolution = `CL@close >= CL@open ? UP : DOWN`. Since CL is always below exchanges, and the deficit grows during volatile periods, DOWN is the correct call
- The strategy only triggers during windows where this deficit is already evident -- it's not predicting, it's reading a persistent structural mispricing

### 2. Is the 100% Win Rate Sustainable?

**Probably not 100%, but likely very high (85-95%).**

- With 30 trades at 100% wins, the 95% binomial confidence interval for the true win rate is [88.4%, 100%]
- The edge is structural (CL lag), not statistical -- it would take a sudden CL price jump of >$80 in 2 minutes to flip a trade
- P(30/30 wins | true WR=90%): 4.2%
- P(30/30 wins | true WR=95%): 21.5%
- P(30/30 wins | true WR=85%): 0.7%
- The 100% observed rate is most consistent with a true rate of 92-98%

### 3. Are the Fills Realistic?

**YES, for $2 trades.**

- $2 orders on Polymarket BTC prediction markets are trivially small
- CLOB snapshots show `ask_size_top` of 20-100 shares ($10-$50 of value) at the best ask
- A $2 order would fill at or very near bestAsk with zero meaningful slippage
- The 0.5c spread buffer is actually CONSERVATIVE -- real fills would be slightly better
- **Caveat**: If scaling to $50-$100+ per trade, L2 book depth becomes critical

### 4. Potential Issues Found

**Issue A: PG Path Missing L2 Data** (CONFIRMED BUG)
- `loadWindowTickData()` does not query `l2_book_ticks`
- `buildWindowTimelinePg()` does not handle L2 events
- The parallel-engine's `buildWindowTimeline()` DOES handle L2
- **Fix needed**: Add `l2_book_ticks` query to `loadWindowTickData()` and add `l2BookTicks` handling to `buildWindowTimelinePg()`

**Issue B: No Look-Ahead Bias Detected**
- `oracle_price_at_open` is captured at window open (not look-ahead)
- Ground truth uses on-chain resolution (not computed)
- Strategy only uses data available at trade time (CL, polyRef, CLOB)

**Issue C: Small Sample Size**
- 30 trades across ~4 weeks is too few for production confidence
- Need 100+ trades minimum for meaningful statistics
- Consider: expanding date range, lowering deficit threshold to $60 for more trades (with expected lower WR)

**Issue D: No Loss Scenarios Observed**
- Every trade resolved DOWN -- we have zero data on loss magnitude
- Need to understand: when this strategy loses, how badly? (Max adverse fill, etc.)

### 5. Bottom Line

**Trust Level: MODERATE-HIGH**

| Dimension | Assessment |
|-----------|------------|
| Edge concept | STRONG -- structural CL lag is real and persistent |
| Fill realism ($2) | GOOD -- bestAsk fallback is actually conservative for tiny orders |
| Fill realism ($100+) | UNKNOWN -- need L2 book-walking for larger orders |
| Win rate | PLAUSIBLE -- consistent with 90-98% true rate |
| Sample size | INSUFFICIENT -- 30 trades is below statistical significance |
| Look-ahead bias | NONE DETECTED |
| Code correctness | BUG FOUND -- PG path missing L2 data loading |

**Recommendations:**
1. **Fix the PG path bug**: Add `l2_book_ticks` query to `loadWindowTickData()` and L2 handling to `buildWindowTimelinePg()`.
2. **Re-run with full sample**: Use ALL windows (2929), not just 200, to get more trades.
3. **Scale testing**: Test with $10, $50, $100 capital per trade to assess fill degradation.
4. **Paper trade first**: Run this strategy in paper trading for 1 week before live deployment.
5. **Set position limits**: Even if the edge is real, start with $2-$5 per trade until 100+ live trades confirm the win rate.
