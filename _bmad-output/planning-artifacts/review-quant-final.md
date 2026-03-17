# Quant Factory -- Final Quantitative Review

**Reviewer:** Marcus (Quant Advisor)
**Date:** 2026-03-15
**Question:** Would I trust these results with real money?

---

## Overall Quant Assessment

**Trust Level: MEDIUM**

The system is substantially better than a naive backtest framework. It uses stratified sampling, bootstrap confidence intervals, a baseline comparison, and regime breakdown -- these are all marks of someone who knows what they should be building. However, several issues prevent me from assigning "high" trust. The most critical: the fill model is optimistic, there is no adverse selection modeling, and the fee default of zero flatters every single metric. A professional quant firm would need to address these before deploying capital.

---

## Statistical Methods Review

### Sharpe Ratio -- CORRECT with caveats

The Sharpe calculation in `metrics.js` is textbook: `(mean_excess_return / std_dev) * sqrt(periods_per_year)`. The implementation uses population variance (divides by N, not N-1), which is standard for Sharpe but worth noting -- it slightly overstates precision with small samples.

**Issue (moderate):** The annualization factor is hardcoded to 252 (trading days), but the returns being fed in are per-window returns, not daily returns. If a strategy trades 200 windows over 30 calendar days, annualizing with sqrt(252) is wrong -- it should use the actual frequency of observations. With 5-minute windows, there are roughly 105,120 windows per year (365.25 * 24 * 12), not 252. This means **all annualized Sharpe ratios are dramatically understated** relative to what the actual frequency implies, OR the framework is treating each window as one "daily" observation, which is also incorrect.

Resolution: If the intent is "Sharpe per window, annualized assuming one window = one period," then the annualization factor should match the actual sampling frequency. As-is, results are internally consistent for ranking strategies but the absolute Sharpe numbers are not meaningful.

### Sortino Ratio -- CORRECT

Uses downside deviation properly, divides by total N (not just downside N) for scaling -- this is the correct approach per Sortino & Forsey.

### Profit Factor -- CORRECT

Gross wins / gross losses, handles edge cases (zero losses = Infinity). Standard.

### Expectancy -- CORRECT

`(winRate * avgWin) - (lossRate * avgLoss)`. Standard expected value per trade.

### Max Drawdown -- CORRECT

Peak-to-trough on equity curve with duration tracking. Implementation is clean.

### Edge Per Trade -- CORRECT for binary markets

`edgePerTrade = winRate - avgEntryPrice`. This is the correct edge metric for binary options where you buy at price P and win pays 1.0. If winRate > avgEntry, you have positive EV. Good.

### Bootstrap Confidence Intervals -- SOUND with minor issue

The bootstrap in `backtest-factory.js` is well-implemented:
- Uses seeded PRNG (mulberry32) for reproducibility
- 1000 resamples is adequate for 95% CI
- Percentile method for CI bounds (2.5th and 97.5th percentile)
- p-value as fraction of bootstrap Sharpes <= 0

**Minor issue:** The p-value calculation is one-sided (fraction <= 0), which is appropriate for testing "is Sharpe positive?" but should be documented as such. Also, with 1000 resamples, the CI resolution is limited to 0.001 -- fine for practical use but not for publication-grade statistics.

**Minor issue:** The same seed is used for both sampling and bootstrap. If someone changes the seed, both the sample AND the CI change simultaneously, making it harder to disentangle sampling variance from bootstrap variance. Recommend using separate seeds.

### Regime Breakdown -- ADEQUATE but not ideal

The first-half / second-half split is a crude but useful check for edge decay. Time-of-day and day-of-week breakdowns add value.

**Moderate issue:** The split is by chronological order of sampled windows, not calendar time. If stratified sampling selects windows non-uniformly across time, the "first half" and "second half" may not correspond to meaningful time periods. This reduces the power of the regime test.

**Missing:** No volatility regime breakdown. In crypto markets, the dominant regime variable is realized volatility, not time-of-day. A high-vol vs. low-vol split would be far more informative.

---

## Signal Quality Review

### `bs-fair-value.js` -- BLACK-SCHOLES IMPLEMENTATION

**Finding (moderate):** The Black-Scholes implementation computes `d2 = (log(S/K) - 0.5 * sigma^2 * T) / (sigma * sqrt(T))` and returns `N(d2)`.

This is the risk-neutral probability that the asset finishes above the strike under BS assumptions -- correct for a digital/binary option. The implementation does NOT compute the standard BS call price formula, which would include discounting and the `d1` term. For a binary option fair value, using `N(d2)` is actually the correct approach (this is the price of a cash-or-nothing digital option under risk-neutrality with zero rates).

**Issue (moderate):** The volatility estimation uses raw squared log-returns without subtracting the mean. For very short windows (5 minutes), the drift term is negligible, so this is acceptable in practice. However, the `dt > 30` filter skips intervals longer than 30 seconds, which could throw away valid data if chainlink updates are sparse. The vol estimate is also highly sensitive to the number of data points -- with `minVolSamples: 10`, you could be estimating annualized vol from 10 observations spanning a couple of minutes. This is noisy.

**Issue (minor):** The normal CDF approximation (Abramowitz & Stegun polynomial) is accurate to ~1e-7 for |x| < 6, which is fine.

**Issue (minor):** Module-level `let clHistory = []` on line 25 is dead code (shadowed by the `let clHistory = []` inside `create()`). Not a bug but sloppy.

### `chainlink-deficit.js` -- CORRECT and well-designed

The deficit calculation is straightforward: `reference - chainlink.price`. Signals DOWN when deficit exceeds threshold. This correctly captures the structural CL lag. The strength scaling (capped at 1.0) is reasonable.

### `exchange-consensus.js` -- CORRECT

Uses `state.getAllExchanges()` and `state.getExchangeMedian()` -- properly delegates to MarketState helpers. Requires minimum exchange count. Direction logic is sound.

### `clob-imbalance.js` -- CORRECT but fragile in production

The imbalance calculation `(bidSize - askSize) / (bidSize + askSize)` is standard. The directional logic for UP vs DOWN books is correct (bid-heavy on UP book = UP signal, bid-heavy on DOWN book = DOWN signal).

**Issue (moderate):** CLOB order book imbalance is one of the most manipulable signals in any market. In Polymarket's thin books, a single order can swing the imbalance ratio dramatically. This signal would produce good backtest results if there is any correlation between book imbalance and outcome, but in live trading, adversarial actors can poison it trivially. Not a code bug -- a market microstructure concern.

### `momentum.js` -- CORRECT but simplistic

Compares current chainlink price to first observed price. Standard momentum signal. The lack of normalization by volatility means the threshold is asset-price-dependent ($20 means different things for BTC vs ETH).

### `mean-reversion.js` -- CORRECT

Rolling mean with deviation threshold. Standard implementation. Same volatility-normalization concern as momentum.

### `ref-near-strike.js` -- CORRECT

Distance check between polyRef and strike. Always signals DOWN, which is appropriate for the edge-c thesis (CL below strike = DOWN edge). Strength inversely proportional to distance.

### Overall Signal Assessment

The signals are quantitatively sound building blocks. They access MarketState through the correct interface. None exhibit look-ahead bias (they only use data available at evaluation time). The main risk is that backtested signal combinations may overfit to the specific market microstructure patterns in the training data.

---

## Market Realism Assessment

### Fill Simulation -- OPTIMISTIC (Critical Issue)

The fill model in `simulator.js` executes buys at `bestAsk + spreadBuffer` where `spreadBuffer` defaults to 0.005 (50 bps). This is the **single most important realism check** and it has several problems:

1. **No market impact.** The system checks `fillSize > clobData.askSize` for a liquidity rejection, but if `fillSize <= askSize`, it fills the entire order at `bestAsk + buffer`. In reality, large orders walk the book. For Polymarket's thin books, even a $5 order can move the price.

2. **No adverse selection.** The system does not model the fact that when your signal fires, other informed traders may also be buying, widening the spread and depleting liquidity. This is the #1 source of backtest-to-live slippage in prediction markets.

3. **Spread buffer is fixed.** The 50-bps buffer is a reasonable default for Polymarket's typical spreads, but spread is time-varying. Near resolution, spreads widen dramatically. The system uses the same buffer regardless of market conditions.

4. **bestAsk used correctly.** On the positive side, fills ARE using bestAsk (not mid-price), which avoids the most common backtest sin. The spread buffer adds further conservatism. This is substantially better than a mid-price fill model.

### Fee Modeling -- PRESENT but defaults to zero

`tradingFee` is accepted as a parameter and applied in `buyToken()` and `sellToken()`. However:

**Issue (critical):** The default `tradingFee` in `backtest-factory.js` is **0**. Polymarket charges ~2% on profits (not on notional, but on net winnings). This asymmetric fee structure is not captured. The system applies fees symmetrically on both entry and exit, which is wrong for Polymarket's actual fee schedule. With a $2 trade, 2% on winnings is ~$0.01-0.02, which matters less at this scale but would matter for any serious capital deployment.

### Position Sizing -- REALISTIC

Binary positions are correctly sized: `capitalPerTrade / fillPrice = number of tokens`. Resolution at 1.0 or 0.0 is correct. PnL = `payout - cost`. This accurately models Polymarket mechanics.

### Window Isolation -- GOOD

Each window gets a fresh MarketState and Simulator. No state leaks between windows. This is the correct approach and avoids path-dependent bias.

### Ground Truth -- GOOD

The system uses `gamma_resolved_direction` with proper fallback chain. This is the actual on-chain resolution, not a computed proxy.

---

## YAML Strategy Fidelity Check

### `edge-c-asymmetry.js` vs `edge-c-asymmetry.yaml`

The YAML definition faithfully captures the JS strategy logic:

| JS Strategy | YAML Equivalent |
|---|---|
| `deficitThreshold: 80` | `chainlink-deficit` signal, `threshold: 80` |
| `nearStrikeThreshold: 100` | `ref-near-strike` signal, `threshold: 100` |
| `entryWindowMs: 120000` | `time-window` filter, `entryWindowMs: 120000` |
| `maxDownPrice: 0.65` | `max-price` filter, `maxPrice: 0.65, side: down` |
| `capitalPerTrade: 2` | `fixed-capital` sizer, `capitalPerTrade: 2` |
| One trade per window (hasBought flag) | `once-per-window` filter |
| `combine: 'all-of'` both signals must agree | `combine: all-of` |

**Verdict: FAITHFUL.** The YAML decomposition correctly maps every condition and parameter from the original JS strategy. The compose engine's `all-of` combination matches the JS `&&` logic. The filter chain enforces the same constraints.

---

## Mutation Engine Review

### Parameter Bounds -- WELL-DESIGNED

The semantic bound classification in `mutation.js` is thoughtful:
- Price params clamped to [0, 1] -- correct for binary market probabilities
- Thresholds bounded to [0.2x, 5x] -- reasonable exploration range
- Integers enforced as >= 1
- Time and capital params enforced as positive

**Issue (moderate):** The bound classification relies on parameter NAMES matching predefined sets. If a new signal uses a parameter named `minThreshold` (not in the sets), it falls through to the generic [0.2x, 5x] rule. This is a reasonable default but could produce invalid values for parameters with tighter semantic constraints. The heuristic for price-like values (0-1 range + name includes "price" or "prob") is a nice touch.

### Structural Mutation -- SOUND

Add/remove signal and filter mutations are validated against the registry. The constraint that at least one signal must remain prevents degenerate strategies. Round-trip YAML validation catches composition errors.

### Overfitting Risk from Mutation

**Issue (moderate):** The perturbation engine generates variants and ranks by Sharpe. With 10+ variants, the best-by-Sharpe will have inflated expected performance due to selection bias (the "multiple testing" problem). The system does not apply any correction for this (e.g., Bonferroni, FDR, or out-of-sample holdout).

---

## Issues Summary

### Critical

| # | Issue | Location | Impact |
|---|---|---|---|
| C1 | Default `tradingFee = 0` flatters all metrics | `backtest-factory.js:280` | Every reported metric is overstated |
| C2 | No adverse selection modeling | `simulator.js:execute()` | Backtest fills are unrealistically optimistic |
| C3 | Polymarket's asymmetric fee structure not modeled | `simulator.js:buyToken()` | Fee drag underestimated |

### Moderate

| # | Issue | Location | Impact |
|---|---|---|---|
| M1 | Sharpe annualization factor (252) incorrect for window-level returns | `backtest-factory.js:102` | Absolute Sharpe values are not meaningful |
| M2 | No market impact model for order execution | `simulator.js:execute()` | Overstates fill quality |
| M3 | No multiple-testing correction for variant selection | `backtest-factory.js:369` | Best variant Sharpe is biased upward |
| M4 | CLOB imbalance signal is trivially manipulable | `clob-imbalance.js` | Live performance may diverge from backtest |
| M5 | Regime breakdown splits by sample order, not calendar time | `backtest-factory.js:140` | Regime analysis may be misleading |
| M6 | BS volatility estimated from as few as 10 data points | `bs-fair-value.js:116` | Noisy vol estimates produce unstable fair values |
| M7 | No volatility regime breakdown | `backtest-factory.js:computeRegimeBreakdown()` | Missing the most important regime variable |

### Minor

| # | Issue | Location | Impact |
|---|---|---|---|
| m1 | Same seed used for sampling and bootstrap | `backtest-factory.js:356` | Confounds sampling and CI variance |
| m2 | Dead module-level `clHistory` variable | `bs-fair-value.js:25` | Code hygiene |
| m3 | Momentum/mean-reversion thresholds not vol-normalized | `momentum.js`, `mean-reversion.js` | Thresholds are asset-price-dependent |
| m4 | No minimum sample size enforcement or warning | `backtest-factory.js:computeMetrics()` | Metrics from <30 trades are meaningless |

---

## Recommendations Before Going Live

### Must-fix (before any real capital)

1. **Set a non-zero default trading fee.** At minimum, `tradingFee` should default to Polymarket's actual fee schedule. Model fees on winnings, not on notional entry. Even a rough approximation (e.g., 0.02 per resolved winning token) would be better than zero.

2. **Add a slippage/adverse selection buffer.** Either increase `spreadBuffer` to at least 1-2% for realistic fills, or implement a simple adverse selection model: when the signal fires, assume the spread widens by some factor. Backtest with at least 2-3 different slippage assumptions and report all.

3. **Fix Sharpe annualization.** Either document that the reported Sharpe is "per-window Sharpe, annualized assuming 252 windows/year" (and label it as such), or compute the actual annualization factor based on the time span of the data and number of observations.

### Should-fix (before trusting results for strategy selection)

4. **Add out-of-sample holdout.** Reserve 20-30% of windows for validation. Report both in-sample and out-of-sample metrics. This is the single most effective overfitting guard.

5. **Add minimum trade count warnings.** Flag any metric computed from fewer than 30 trades. Below ~50 trades, Sharpe and win rate are essentially noise.

6. **Add volatility regime breakdown.** Compute realized volatility per window (from chainlink returns) and split into terciles. Report metrics per volatility bucket. This will reveal whether edge exists only in high-vol or low-vol regimes.

7. **Apply multiple-testing correction.** When running sweep variants, report the expected best-by-chance Sharpe alongside the observed best. Even a simple formula like `E[max Sharpe | N variants, null hypothesis] ~ sqrt(2 * log(N))` would help calibrate expectations.

### Nice-to-have

8. **Separate bootstrap seed from sampling seed.**
9. **Add edge decay detection.** Compute rolling Sharpe over time (e.g., last 50 windows) and flag when it drops below the CI lower bound.
10. **Normalize signal thresholds by volatility** for cross-asset portability.

---

## "Would I Trade This?" Verdict

**Not yet, but it is close.**

The architecture is professional-grade. The separation of signals, filters, sizers, and the compose engine is exactly the right design for a quant factory. The stratified sampling, bootstrap CIs, baseline comparison, and regime breakdown show statistical sophistication beyond what most retail trading systems achieve. The YAML-to-strategy pipeline is elegant and the fidelity check passes.

However, three things stop me from putting capital behind these results today:

1. **The fill model is too generous.** Every backtest metric is computed assuming you can buy at `bestAsk + 50bps` with zero fees. In Polymarket's thin books with 5-minute windows, this is optimistic. The edge for most of these strategies is 2-5% per trade -- slippage and fees could easily consume that.

2. **No out-of-sample validation.** The system ranks variants by in-sample Sharpe with no holdout. With 10+ variants, the best one is biased. I have seen too many strategies that look great in-sample and die in production.

3. **The signals are directionally correct but not battle-tested.** The chainlink deficit thesis is structurally sound (I like it -- it exploits a real market microstructure feature). But the backtest does not stress-test what happens when the market knows about this edge (adverse selection) or when Polymarket changes its fee structure.

**My recommendation:** Fix the three critical issues (fees, slippage, annualization), add a 70/30 in-sample/out-of-sample split, and re-run. If the top strategy still shows positive edge-per-trade after fees and slippage in the out-of-sample set, I would paper-trade it for 2 weeks before committing real capital. Start with $20-50 total exposure, not $100+.

The system is well-built. The edge thesis is plausible. The infrastructure is ready. The statistics just need a few more guardrails before they are trustworthy.

**Rating: 7/10 -- Promising but not production-ready.**

---

*Reviewed by Marcus, Quant Advisor. 12 years Goldman Sachs + prop trading.*
