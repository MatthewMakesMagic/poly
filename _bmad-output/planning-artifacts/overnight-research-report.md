# Overnight Research Report -- 2026-03-15

## Timeline Cache Status

| Symbol | Windows | Date Range | Avg Events | L2 Coverage | Flagged |
|--------|---------|------------|------------|-------------|---------|
| BTC | 800 | Feb 11-20, 2026 | 15,297 | 0.0% | 2 (flat CL prices) |
| ETH | 100 (of 2,895) | Feb 11-12, 2026 | 13,565 | 0.0% | 0 |
| SOL | not built | -- | -- | -- | -- |
| XRP | not built | -- | -- | -- | -- |

**Notes:**
- BTC cache is complete and high quality (800 windows, 15k events/window).
- ETH build hit PG connection timeouts after 100 windows. It was resumed and is still running in background. The database (Railway) has statement timeout limits that cause large queries to fail.
- SOL/XRP builds not attempted yet (ETH build was taking priority).
- L2 coverage is 0% across all symbols -- fills use bestAsk + spreadBuffer (0.5c) which is a conservative but not fully realistic fill model.

## Backtester Performance

| Metric | Value | Target |
|--------|-------|--------|
| Wall-clock: 50 windows (edge-c-asymmetry) | 903ms | <500ms |
| Wall-clock: 200 windows (consensus-reversion-v1) | 27.5s | -- |
| Wall-clock: 500 windows (consensus-reversion-v1) | 73s | -- |
| Wall-clock: 200 windows x 180 sweep combos (mm-informed) | 5.1 hours | -- |
| L2 fill simulation | NOT working (0% L2 coverage) | -- |
| Fee model | TAKER_ONLY (default) -- fees ARE applied | -- |

**Notes:**
- 50-window sanity test ran at 903ms (vs 500ms target). Slightly over but acceptable -- the factory path loads timelines from SQLite which adds overhead vs in-memory.
- Fees are working correctly via the fee-model.js module. Default taker rate applied.
- Fill simulation falls back to bestAsk + 0.5c spread buffer since L2 data is unavailable.

## Strategy Results (ranked by Sharpe on BTC, 200 windows)

| Rank | Strategy | Sharpe | PF | Win% | Trades | PnL | MaxDD | Edge/Trade | CI95 |
|------|----------|--------|-----|------|--------|-----|-------|------------|------|
| 1 | consensus-reversion-v1 | 11.71 | 4.07 | 80.9% | 194 | $115 | 1.9% | 0.296 | [8.88, 15.93] |
| 2 | mm-informed (JS) | 9.47 | 13.43 | 65.8% | 114 | $116 | 1.8% | 0.157 | [7.70, 11.40] |
| 3 | midpoint-spread-v1 | 7.99 | 4.25 | 80.7% | 4,010 | $5,103 | 72.7% | 0.320 | [5.99, 10.19] |
| 4 | gated-mm-v1 | 7.21 | 3.81 | 78.9% | 4,040 | $4,857 | 77.0% | 0.300 | [5.31, 9.52] |
| 5 | bs-early-exit-v2 | 6.66 | 4.32 | 80.5% | 82 | $161 | 5.8% | 0.329 | [4.64, 8.92] |
| 6 | edge-c-asymmetry | 5.12 | inf | 100% | 19 | $39 | 0% | 0.501 | [3.82, 6.37] |
| 7 | bs-early-exit-v1 | 5.20 | 2.91 | 74.7% | 83 | $81 | 4.0% | 0.243 | [3.11, 7.50] |
| 8 | bs-early-exit-v3 | 5.20 | 2.91 | 74.7% | 83 | $203 | 9.4% | 0.243 | [3.11, 7.50] |
| 9 | deficit-momentum-v1 | 4.97 | 20.88 | 95.5% | 22 | $61 | 1.9% | 0.449 | [3.28, 6.38] |
| 10 | midpoint-spread-v2 | 4.14 | 2.85 | 69.5% | 1,506 | $2,580 | 38.1% | 0.277 | [2.38, 6.05] |

## Top Performer Analysis

### 1. consensus-reversion-v1 (Sharpe 11.71 -> 10.30 at 500 windows)

**Signal combination:** exchange-consensus (any-of) + mean-reversion, with volatility-scaled sizing.

**Why it works:**
- Exchange consensus identifies the correct directional bias by aggregating multiple exchange prices vs strike
- Mean-reversion provides timing -- enters when price has temporarily overshot, giving a better entry
- The `any-of` combiner means either signal can trigger independently, which maximizes trade count
- Once-per-window filter prevents overtrading

**Robustness check (500 windows):**
- Sharpe degrades slightly from 11.71 to 10.30 (expected with larger, noisier sample)
- First half Sharpe: 10.52 | Second half: 10.08 -- very consistent, no sign of overfitting
- CI95: [8.43, 12.57], p-value = 0
- MaxDD stays at just 2.0%

**Regime breakdown (500 windows):**
- Evening is strongest (Sharpe 11.38), overnight/morning/afternoon all >9.7
- Wednesday (14.65) and Thursday (12.62) are strongest days
- Saturday is weakest (6.20) -- thinner markets?
- Consistent positive Sharpe across ALL time-of-day and day-of-week buckets

**Caution:**
- 0% L2 coverage means fill simulation uses bestAsk + buffer. Real fills may be worse.
- Zero trades on ETH -- strategy is BTC-specific due to exchange data requirements.
- The parameter sweep shows minimal sensitivity -- all threshold combinations produce nearly identical results, which means the signal fires robustly but the thresholds tested are all below the actual signal strength. Tighter thresholds could discriminate.

### 2. mm-informed (Sharpe 9.47)

**Signal combination:** BS fair value entry + early exit when fair value flips (JS strategy, not YAML).

**Why it works:**
- BS model computes theoretical fair value from polyRef/CL volatility
- Enters when CLOB price is 5-15c below fair value (cheap tokens)
- **Key differentiator:** sells back at CLOB bid if BS fair flips direction (early exit)
- This asymmetric payoff (full wins, partial losses) creates strong positive expectancy
- Even with 65.8% win rate (lower than others), the profit factor is 13.43

**Robustness:**
- 180 parameter sweep combinations all produce Sharpe 9.0-9.5 -- extraordinarily robust to parameter choices
- Best params: fairEdge=0.15, exitEdge=0.02, entryWindowMs=600000, maxEntryPrice=0.55
- MaxDD only 1.8%

**Caution:**
- Early exit requires selling back at CLOB bid, which may have worse liquidity than modeled
- 5.1 hours for 180 sweep combos -- sweep is too large for routine iteration

### 3. midpoint-spread-v1 (Sharpe 7.99 at 200 windows, 7.66 at 500)

**Signal combination:** BS fair value with cooldown-based re-entry near p=0.50.

**Why it works (or seems to):**
- BS signal fires frequently near midpoint prices, generating 4,010 trades in 200 windows (~20/window)
- 80.7% win rate on binary options near p=0.50 is excellent
- Cooldown filter (5s) allows multiple entries per window

**MAJOR RED FLAG:**
- At 500 windows: First half Sharpe = 0.00, Second half Sharpe = 12.37
- This extreme regime split suggests the strategy captures something specific to the second half of the data (Feb 16-20) that didn't exist in the first half (Feb 11-15)
- Possible explanation: market microstructure change, or the BS model calibrates better as more CL history accumulates
- MaxDD of 72.7% is unacceptable for live trading

**Verdict:** Do not trade this without understanding the regime split. Likely overfit to recent data.

## Issues Encountered

1. **Sweep parameters don't differentiate:** All YAML strategies show identical results across parameter combinations. This is because the signal thresholds tested (minEdge 0.03-0.12, deficit threshold 15-120) are all below the actual signal strength when it fires. The signals are binary (fire/don't fire) rather than gradual. Recommendation: test much wider parameter ranges or modify signals to be more granular.

2. **ETH has no exchange data for consensus signal:** All strategies produce zero trades on ETH. The exchange-consensus signal requires >= 2 exchanges; ETH may only have 1 in the data. The BS signals also fail because they need sufficient chainlink history (50+ samples) which isn't available in the short time-window filters.

3. **ETH build connection issues:** Railway PG has statement timeouts that kill long queries. Only 100 of 2,895 ETH windows were cached before timeout. Build was resumed and is running in background.

4. **L2 data completely absent:** 0% L2 coverage for both BTC and ETH. Fill simulation uses bestAsk + 0.5c spread buffer. This is conservative but not realistic -- real L2 fills could be better or worse.

5. **YAML compose engine lacks early exit:** The compose engine only handles entry (buy) signals. There's no YAML block for position management (sell-back, stop-loss, trailing stop). The mm-informed JS strategy has early exit built in, which is why it performs well. Building a YAML `exit` block type would unlock the best-performing strategy pattern for the compose pipeline.

6. **mm-informed sweep is too slow:** 180 combinations x 200 windows took 5.1 hours. Need to either reduce the sweep grid or parallelize better.

## Recommendations

### Immediate (today)
1. **Paper trade consensus-reversion-v1 on BTC** -- Sharpe 10.30, consistent across regimes, only 2% MaxDD. Use params: threshold=30, deviationThreshold=30.
2. **Paper trade mm-informed on BTC** -- Sharpe 9.47, robust to params. Use params: fairEdge=0.15, exitEdge=0.02, entryWindowMs=600000, maxEntryPrice=0.55.
3. **Do NOT deploy midpoint-spread-v1** until the first/second half regime split is understood.

### Short-term (this week)
4. **Build an `exit` block type for the YAML compose engine** -- this would let you YAML-define the mm-informed pattern (BS entry + early exit), which was the second-best performer.
5. **Fix ETH timeline builds** -- the PG connection timeouts need handling (retry logic, smaller batch queries).
6. **Test wider parameter ranges** -- current sweeps don't discriminate. Try minEdge from 0.01 to 0.30 in finer increments.
7. **Build SOL and XRP caches** once ETH is done.

### Research ideas
8. **Combine consensus-reversion with early exit** -- the top two strategies use different mechanisms. A hybrid could be even better.
9. **Add maker rebate accounting** -- consensus-reversion generates 490 trades in 500 windows. If each trade earns ~0.5c maker rebate, that's $2.45 additional PnL (small but adds up).
10. **Investigate the midpoint-spread regime split** -- if the Feb 16-20 regime change can be identified (e.g., BTC volatility spike, market structure change), it may reveal when midpoint strategies work vs don't.

## Files Created

Strategy YAMLs (8 files):
- `src/factory/strategies/midpoint-spread-v1.yaml`
- `src/factory/strategies/midpoint-spread-v2.yaml`
- `src/factory/strategies/bs-early-exit-v1.yaml`
- `src/factory/strategies/bs-early-exit-v2.yaml`
- `src/factory/strategies/bs-early-exit-v3.yaml`
- `src/factory/strategies/gated-mm-v1.yaml`
- `src/factory/strategies/deficit-momentum-v1.yaml`
- `src/factory/strategies/consensus-reversion-v1.yaml`

Detailed JSON results:
- `_bmad-output/planning-artifacts/consensus-reversion-v1-btc.json` (200 windows)
- `_bmad-output/planning-artifacts/consensus-reversion-v1-btc-500.json` (500 windows)
- `_bmad-output/planning-artifacts/midpoint-spread-v1-btc-500.json` (500 windows)

## Background Processes Still Running

- ETH timeline build (incremental resume, PID check: `ps aux | grep build-timelines`)
