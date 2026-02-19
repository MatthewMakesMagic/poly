# Edge Analysis Log — 2026-02-07

## Key Finding: The CLOB Price IS the Signal

After running orthogonal factor analysis on 207 windows (102 with CLOB data), the data says one thing clearly:

**The DOWN ask price at 1 minute before close is the dominant signal. Everything else is either redundant or too noisy to measure.**

### The Binary Split

| Population | DOWN Ask | Trades | Wins | Win Rate | Note |
|------------|----------|--------|------|----------|------|
| Decided-UP | < $0.15 | 55 | 0 | **0.0%** | Market is ALWAYS right |
| Contested | ≥ $0.15 | 12 | 9 | **75.0%** | Structural deficit tips scale |

**In decided windows: NOTHING predicts a win.** Not deficit, CL trajectory, exchange range, DOWN drift. All factors tested: 0 wins out of 55.

**In contested windows: 75% win rate.** The structural Chainlink deficit (~$80 below exchange cluster) means the market systematically underestimates DOWN probability when it's uncertain.

### Correlation Matrix (proving redundancy)

| Factor A | Factor B | Pearson r | Verdict |
|----------|----------|-----------|---------|
| DOWN ask | UP ask | **-1.00** | Same signal (sum to 1) |
| Deficit | Ref gap | **-0.99** | Same signal (both = where price is vs strike) |
| DOWN ask | Deficit | **0.59** | Correlated (contested windows have higher deficit) |
| CL delta | DOWN drift | **-0.58** | Correlated (CL falls → DOWN rises) |
| CL delta | DOWN ask | -0.01 | **Independent** |
| Ex range | DOWN ask | -0.06 | **Independent** |
| Ex range | Deficit | 0.07 | **Independent** |

Truly independent axes: (1) CLOB price, (2) Deficit, (3) CL trajectory, (4) Exchange range. But with only 12 contested windows, no secondary factor has enough sample to prove additive value.

### Within Contested Windows — Secondary Factors

All sample sizes are 1-5 trades, making these unreliable:

| Factor | Best Bucket | Win Rate | n | Reliable? |
|--------|-------------|----------|---|-----------|
| Deficit $80-120 | 100% | 3 | No |
| Exchange range $80-200 | 100% | 5 | Maybe |
| CL falling > $20 | 80% | 5 | Maybe |
| DOWN drift > +0.05 | 80% | 5 | Maybe |

### Critical Data Quality Note

| Subset | Windows | DOWN Rate |
|--------|---------|-----------|
| WITH CLOB data | 102 | 42.2% |
| WITHOUT CLOB data | 105 | 67.6% |
| ALL | 207 | 55.1% |

The 55.1% "structural DOWN bias" is a blend of two different populations. The CLOB-era windows only show 42.2% DOWN — the market may be more efficient than we thought. The 67.6% in pre-CLOB windows may reflect a different market regime, or sampling bias from when data capture started.

### Edge D Sweep Results

ALL 40 configs are "profitable" but misleading — the wins are concentrated in 12 contested windows that dominate PnL regardless of filter settings. The 55 losing trades lose so little ($0.01-0.08 each) that almost any filter shows positive total PnL.

Best EV/trade: $0.075 (300s window, maxPrice 0.65). But this is 9 wins × ~$0.50 avg win minus 62 losses × ~$0.05 avg loss.

### Edge H (Buy UP when ref far above strike): DEAD

| Ref vs Strike | UP Resolution | Avg UP Ask | Edge |
|---------------|--------------|------------|------|
| > +$300 | 100% | $0.997 | None |
| +$200 to +$300 | 100% | $0.987 | None |
| +$100 to +$200 | 93.3% | $0.968 | None |
| $0 to +$100 | 47.6% | $0.770 | Marginal |

Market prices UP correctly. No room for edge.

### Implications for Strategy

1. **Edge C (deficit + ref near strike + CLOB DOWN cheap)** works because it identifies contested windows with structural bias. It's the same signal: "CLOB gives DOWN a chance + deficit exists."

2. **No new independent edge found.** CL trajectory and exchange range are genuinely independent of CLOB price, but sample is too small to validate.

3. **Need 200+ contested windows** to properly test whether CL trajectory or exchange range add value within the contested population.

4. **The 42.2% vs 67.6% DOWN rate split** between CLOB-era and pre-CLOB-era windows needs investigation. Is the market getting more efficient? Or is this sampling bias?

### Honest Sample Size Assessment

- 207 total windows, 102 with CLOB data
- 12 contested windows (DOWN ask ≥ 0.15)
- 9 wins out of 12 → 95% CI for true win rate: approximately 43% to 95% (Wilson interval)
- We CANNOT distinguish "75% edge" from "50% coin flip" with n=12
- Minimum needed for significance: ~50 contested windows

### Next Steps

1. **Keep collecting data.** We need 3-5x more windows with CLOB data before secondary factors become testable.
2. **Monitor the 42% vs 68% DOWN rate split.** If CLOB-era windows stabilize near 42%, our base rate thesis weakens.
3. **Edge C remains the best strategy** — it correctly identifies the same population (contested + deficit) but with cleaner filters.
4. **CL trajectory and exchange range are worth tracking** but can't be validated yet.

---

## Comprehensive Backtest Results — 2026-02-08

Eight strategies backtested across 207 windows (118 with CLOB data). All use the fast-track pre-computed `window_backtest_states` table.

### Lag Strategies (A through D)

#### Lag-A: Exchange Leads Settlement
**Hypothesis**: Exchange median at T-10s/T-30s predicts Chainlink settlement direction.
- Exchange median at T-10s: 94.9% raw accuracy, 99.0% with $80 margin buffer
- **Verdict**: True but CLOB already prices this in. No actionable edge — the market knows what exchanges show.

#### Lag-B: PolyRef Leads Settlement
**Hypothesis**: Deficit-adjusted polyRef is a better predictor than raw reference.
- Deficit adjustment of $60 boosts accuracy to 97.6% (from ~96.1% raw)
- Best median EV across configs: $0.50 (vs $0.18 raw)
- **Verdict**: PolyRef + deficit adjustment is the best settlement predictor. But again, CLOB already accounts for it.

#### Lag-C: CL Velocity Extrapolation
**Hypothesis**: Extrapolating CL trajectory from 60s→10s predicts settlement.
- **99.5% direction accuracy** — best predictor found across all strategies
- CL velocity beats exchange velocity (median EV $0.41 vs $0.24)
- Extrapolated CL position at close matches actual within ~$20
- **Verdict**: CL velocity is the single best predictor of settlement direction. At T-10s, CL is still moving and its trajectory is highly informative.

#### Lag-D: Exchange-CL Divergence Snap-Back
**Hypothesis**: When exchange-CL gap is unusually large, CL will "snap back."
- Gap direction shows NO predictive power for settlement
- Divergence is noise, not signal
- **Verdict**: DEAD. The exchange-CL gap is structurally noisy. No snap-back pattern exists.

### CLOB-Based Strategies (E, J, K, M)

#### Edge E: Contested + CL Momentum
**Hypothesis**: Adding CL falling filter to contested windows improves win rate.
- CL momentum adds value: median EV $0.47 (with momentum) vs $0.36 (without)
- But sample sizes are tiny (5-12 trades per config)
- **Verdict**: Promising but unvalidated. CL momentum appears to add ~11pp of EV, but n too small.

#### Edge J: Late Entry (T-10s)
**Hypothesis**: Maximum information at latest entry point outweighs market efficiency.
- **Strongest single finding**: CL_BELOW_STRIKE signal at T-10s → 5/5 wins, $0.82 EV/trade
- CLOB persistently underprices DOWN by 5-7.5pp across all time offsets
- 10s entry > 20s > 30s (information advantage grows closer to close)
- **Verdict**: Most promising strategy but tiny sample (5 trades). The 5-7pp CLOB mismatch is the core inefficiency.

#### Edge K: Contrarian — Buy UP
**Hypothesis**: Buy UP in "decided" windows where DOWN < $0.15 (UP resolves 100%).
- Market prices UP at $0.97+ in decided windows → max profit $0.03/trade - fees
- Best config: marginal $0.01-0.02 EV per trade
- **Verdict**: Not viable. Market prices UP correctly. Even 100% win rate can't overcome the thin margins.

#### Edge M: CLOB-Era Clean Split
**Hypothesis**: Re-run Edge C and D using ONLY CLOB-era windows (cleaner data).
- CLOB-era DOWN rate: **50.0%** (118 windows), not 42.2% (which was 102 windows at 60s offset only)
- **Edge D positive across ALL 24 configs in CLOB-era** — the edge is real, not just pre-CLOB bias
- CLOB-era Edge C also shows positive configs but fewer qualifying trades
- **Verdict**: Critical finding. The 42.2% figure was misleading. At 50% base rate, structural edge still exists.

### Cross-Strategy Synthesis

1. **Convergence on same windows**: Multiple strategies (C, D, E, J) converge on the same 5-12 contested windows. This is one edge expressed multiple ways, not independent edges.

2. **Settlement prediction is solved**: CL velocity extrapolation (99.5%), exchange median with margin (99.0%), and polyRef deficit-adjusted (97.6%) all predict settlement direction reliably. But the CLOB already reflects this — so prediction alone doesn't create an edge.

3. **The edge is CLOB mispricing**: The 5-7pp persistent underpricing of DOWN across all time offsets is the real inefficiency. The CLOB market doesn't fully account for the structural Chainlink deficit.

4. **Sample size remains the core limitation**: 12 contested windows is not enough to distinguish a 75% edge from a coin flip. Need 50+ for statistical significance.

5. **Intra-window lag arb is NOT viable** (see below).

---

## Intra-Window Lag Arb Analysis — 2026-02-08

### Hypothesis
Can we exploit the 878ms Chainlink lag and structural feed timing to buy CLOB tokens when they're stale, then exit via take-profit when the CLOB reprices?

### CLOB Repricing Diagnostic (520 CLOB-era windows, tick-by-tick)

| Metric | Value |
|--------|-------|
| CLOB update frequency | Every ~62ms (4,800/window) |
| Stale periods > 5s | **Zero** |
| Bid-ask spread | Median $0.01, Mean $0.014 |
| Round-trip cost | ~$0.024 (spread + 2×$0.005 buffer) |

**Direction match after reference moves:**

| Source → CLOB | Direction Accuracy |
|---------------|--------------------|
| Exchange median → CLOB | 41% (worse than random!) |
| PolyRef → CLOB | 46-50% |
| Chainlink → CLOB | 46-51% |

The CLOB does NOT mechanically follow reference price movements. Market makers price **probability**, not raw price. A $100 exchange drop when BTC is $5000 above strike barely changes probability. The relationship is highly nonlinear and position-dependent.

### Lag Arb Strategy Sweep (1,200 configs × 520 windows)

| Trigger Source | Profitable Configs | Median Trades | Median Avg PnL |
|---------------|-------------------|---------------|-----------------|
| Exchange median | 30% (120/400) | 58,090 | NaN (noise) |
| PolyRef | **63%** (253/400) | 80 | $0.066 |
| Chainlink | **71%** (226/320) | 144 | $0.043 |

Best performing config (exchange_median, $30 trigger, TP=$0.01, SL=$0.20, 300s): 58,820 trades, 61% win rate, $1,728 total PnL.

**But**: 80% of trades hit take-profit at $0.01 in 0.7 seconds — yet the real PnL comes from the ~5% that fall through to settlement. The take-profit capture is real but marginal ($0.005-0.01 net of spread). The settlement fallback is what makes configs profitable.

### Why Intra-Window Lag Arb Fails

1. **No stale CLOB**: The CLOB updates every 62ms. Market makers have the same exchange feeds we do and update immediately. The 878ms Chainlink lag is an oracle lag, not a CLOB lag.

2. **Direction prediction is near-random**: CLOB prices reflect probability, not raw BTC price. The mapping from "exchange moved $X" to "CLOB should move $Y" is highly nonlinear and depends on distance-to-strike.

3. **Spread eats the edge**: At $0.01 median spread, round-trip cost is ~$0.024. The CLOB would need to reprice by $0.03+ for a profitable round-trip. But in the 62ms between updates, typical CLOB movement is much smaller.

4. **Take-profit is marginal**: $0.01 TP hit rate of 80% sounds good, but net of spread ($0.005 profit × 80% = $0.004/trade) barely covers the losses on the 20% that timeout/settle unfavorably.

### Implications

The structural edge in this market is **not microstructure/latency** — it's **probability mispricing**. The CLOB persistently underprices DOWN by 5-7pp because:
- Market makers don't fully account for the structural Chainlink deficit (~$80)
- The deficit creates a systematic DOWN bias that the CLOB doesn't reflect

This edge is best captured by:
1. Entering in **contested** windows (DOWN ask ≥ $0.15)
2. Using **structural signals** (deficit, CL velocity, ref-to-strike distance)
3. **Holding to settlement** — not trying to scalp intra-window repricing

---

## Chainlink Settlement Arb — 2026-02-08

### The Hypothesis

We receive the Chainlink feed in real-time. When CL drops below strike near window close, we KNOW the resolution will be DOWN before the CLOB reflects it. The CLOB prices based on exchange/reference data, but settlement uses Chainlink — which is structurally $60-100 below exchanges.

### CL Below Strike = Perfect Predictor (from T-5s)

| Offset | CL<Strike | Resolves DOWN | Accuracy | CL>Strike | Resolves UP | Accuracy |
|--------|-----------|---------------|----------|-----------|-------------|----------|
| T-60s  | 71        | 65            | 91.5%    | 59        | 57          | 96.6%    |
| T-30s  | 66        | 65            | 98.5%    | 64        | 62          | 96.9%    |
| T-10s  | 66        | 65            | 98.5%    | 64        | 62          | 96.9%    |
| T-5s   | 65        | 65            | **100%** | 65        | 63          | 96.9%    |
| T-3s   | 66        | 66            | **100%** | 64        | 63          | 98.4%    |
| T-2s   | 67        | 67            | **100%** | 63        | 63          | 100%     |
| T-1s   | 67        | 67            | **100%** | 63        | 63          | 100%     |

**From T-5s onward, CL position is a PERFECT predictor. Zero false positives.** At T-10s there is one false positive (CL dipped below then bounced back in final seconds).

### The CLOB Doesn't Know What CL Knows

When CL is below strike, the CLOB often still shows UP at high prices:

- **T-10s**: 24 windows with CL < strike, median DOWN ask $0.935 (market correctly priced). But **5 windows** have DOWN ask < $0.50 → all 5 resolve DOWN. 100% win rate, $0.82 EV/trade.
- **T-30s**: 5 mispriced windows, all win, $0.68 EV.
- **T-60s**: 9 mispriced, only 5 win (55.6%, still +EV at $0.26).

The mispricing occurs because CL is barely below strike ($15-50 deficit) while the exchange reference (polyRef) is ABOVE strike. Market makers follow exchange prices, not Chainlink.

### Strategy Results: Buy DOWN when CL < strike

| Entry | Trades | Wins | WinRate | Avg Entry | EV/trade | Total PnL |
|-------|--------|------|---------|-----------|----------|-----------|
| T-10s | 25     | 24   | 96.0%   | $0.473    | $0.49    | $12.18    |
| T-5s  | 8      | 8    | 100%    | $0.160    | $0.84    | $6.72     |
| T-3s  | 18     | 18   | 100%    | $0.083    | $0.92    | $16.51    |
| T-2s  | 31     | 31   | 100%    | $0.470    | $0.53    | $16.41    |
| T-1s  | 22     | 22   | 100%    | $0.470    | $0.53    | $11.66    |

Filter: DOWN ask < $0.50 (market thinks UP is more likely). Results with DOWN ask < $0.70 are even stronger: T-2s = 67 trades, 67 wins, $33.33 PnL.

### False Positives

5 false positives found across all data where CL was below strike + CLOB showed DOWN cheap, but resolved UP:
- All occur at T-10s or earlier (T-30s, T-60s)
- In each case, CL bounced back above strike in the final 5-8 seconds
- **Zero false positives at T-5s or below** — once CL is below strike with 5s left, it stays

### Deficit Buckets at T-10s

| CL vs Strike | Windows | DOWN% | Median DN Ask | EV/trade |
|-------------|---------|-------|---------------|----------|
| $0-20 below  | 3       | 66.7% | $0.240        | $0.352   |
| $20-50 below | 3       | 100%  | $0.160        | $0.832   |
| $50-100 below| 5       | 100%  | $0.930        | $0.187   |
| $100+ below  | 13      | 100%  | $0.970        | $0.038   |

Best edge is at $20-50 deficit: 100% win rate, DOWN still cheap at $0.16, $0.83 EV. At $50+ below, the CLOB already prices DOWN correctly.

### Example: Feb 06 14:15 (strike=$69,777)

CL was $17-53 below strike for the entire final 30 seconds. DOWN ask oscillated $0.10-0.49. UP ask stayed at $0.52-0.56. Resolved DOWN. You had **30 seconds** to place this trade with CL TELLING you the answer.

### Caveats

1. **CLOB price oscillations**: DOWN ask jumps between $0.01-$0.99 within seconds. Brief spikes to $0.01-0.03 may not be fillable (momentary orderbook gaps).
2. **130 windows** with CLOB data — decent sample for the main signal, but the near-strike mispriced subset is still small (5-31 trades depending on offset).
3. **Execution realism**: Can you fill in the last 5 seconds? Polymarket API latency + order matching time needs testing.
4. **The edge is shrinking by offset**: More opportunities at T-10s (25 trades) but 1 false positive. Fewer at T-5s (8 trades) but zero false positives. Trade-off between safety and frequency.

### Verdict

**This is the strongest edge found.** The Chainlink feed gives you the settlement answer before the CLOB reflects it. The mechanism is clear: market makers price off exchange data (polyRef), but settlement uses Chainlink which is $15-50 lower in contested windows. When CL < strike near close, buy DOWN — the CLOB is still pricing based on exchange reference which is above strike.

Recommended strategy:
- Watch CL in real-time
- At T-5s or later: if CL < strike → buy DOWN at market
- Expected win rate: 100% (in sample), EV: $0.53-0.92 per trade
- False positive protection: CL has never bounced back above strike in final 5 seconds in our data

---

## Update 2026-02-19: CLOB Conviction Filter

### Discovery

5 days of paper trading (Feb 14-19, ~670 windows) revealed that the VWAP contrarian edge appeared to collapse day-over-day:

| Day | ETH vwap_edge windows | Win % |
|-----|----------------------|-------|
| Feb 16 | 17 | 64.7% |
| Feb 17 | 20 | 45.0% |
| Feb 18 | 25 | 24.0% |
| Feb 19 | 4 | 0.0% |

Investigation showed this was **not an edge collapse** — it was a mix shift. Splitting windows by CLOB conviction (how far CLOB has moved from 0.50):

| Day | Near-fair windows | NF win% | Decided windows | Decided win% |
|-----|-------------------|---------|-----------------|--------------|
| Feb 16 | 6 | **83.3%** | 11 | 54.5% |
| Feb 17 | 6 | **83.3%** | 14 | 28.6% |
| Feb 18 | 7 | **71.4%** | 18 | 5.6% |

The near-fair filter held at 71-83% every day. The overall average dropped because later days had more "decided" CLOB windows (already repriced) dragging the average down.

### The Filter

**CLOB conviction = abs(clob_up_price - 0.50)**

When CLOB is near 0.50, MMs haven't repriced the VWAP move → contrarian bet has value.
When CLOB has already moved to 0.25 or 0.75, the information is already in the price.

| CLOB conviction | ETH windows | Won | Win % | PnL |
|-----------------|-------------|-----|-------|-----|
| 0-15% | 15 | 10 | 66.7% | +$1,174 |
| 15-20% | 4 | 3 | 75.0% | +$1,858 |
| 20-25% | 8 | 4 | 50.0% | +$1,826 |
| 25-30% | 11 | 5 | 45.5% | +$3,011 |
| **30%+** | **25** | **3** | **16.3%** | **-$12,130** |

Clean cutoff at ~20-25%. Conviction < 0.20 = profitable zone.

### Interaction with delta strength (ETH, near-fair CLOB only)

| Delta | Windows | Won | Win % | PnL |
|-------|---------|-----|-------|-----|
| Strong (≥10%) | 10 | 8 | **80.0%** | +$5,446 |
| Medium (6-10%) | 5 | 3 | 60.0% | +$1,348 |
| Weak (<6%) | 7 | 5 | 71.4% | +$153 |

### Signal timing (ETH, near-fair CLOB only)

| Offset | Win % | PnL | Note |
|--------|-------|-----|------|
| T-120 | 54.1% | +$859 | VWAP may not have moved enough |
| T-90 | 45.5% | +$328 | |
| **T-60** | **67.9%** | **+$1,486** | **Sweet spot** |
| T-30 | 23.5% | -$1,164 | CLOB has started repricing |
| T-10 | 53.8% | +$129 | |

### Entry side asymmetry (ETH, near-fair)

| Side | Windows | Won | Win % |
|------|---------|-----|-------|
| DOWN | 11 | 9 | **81.8%** |
| UP | 11 | 7 | 63.6% |

### Cross-instrument

| Symbol | Near-fair win% | Decided win% |
|--------|---------------|--------------|
| ETH | **69.2%** | 26.9% |
| XRP | **53.6%** | 17.3% |
| BTC | 41.3% | 27.1% |

### Other findings from 5-day paper run

- **btc_lead strategy**: Dead (21% window win rate). Killed.
- **SOL**: Dead across all strategies (10-15%). Killed from all trading.
- **spread_widen**: 55-59% trade win rate but negative PnL due to expensive entries ($0.73-0.76).

### Implementation

Added conviction-filtered variations to paper trader (deployed Feb 19):
- `f-d3-c20`: delta ≥ 3%, conviction < 20% (loose delta, strict conviction)
- `f-d8-c20`: delta ≥ 8%, conviction < 20% (the golden combo)
- `f-d8-c25`: delta ≥ 8%, conviction < 25% (wider band)

Running alongside unfiltered variants for direct A/B comparison. All VWAP strategies (vwap_edge, vwap_cg_edge, down_only, down_cg, vwap20_edge, down_v20) now test both filtered and unfiltered.

---

## Update 2026-02-19 (cont.): Crossover Pattern — Decided CLOB Wrong

### Discovery

Separate from the near-fair conviction edge, there is a second distinct pattern: **CLOB strongly decided one direction, but resolves the other way.** These "crossover" windows are where the VWAP contrarian strategy captures massive asymmetric payoffs.

At T-10, CLOB gets the final resolution wrong:
- CLOB says UP (>0.70): wrong **20.6%** of the time (7/34 windows)
- CLOB says DOWN (<0.30): wrong **7.9%** of the time (3/38 windows)

### Crossover trade performance (all offsets)

| Offset | Trades | Won | Win % | Avg Entry | Total PnL | Avg Win PnL |
|--------|--------|-----|-------|-----------|-----------|-------------|
| T-120 | 58 | 48 | 82.8% | $0.37 | +$14,478 | $323 |
| T-90 | 46 | 40 | 87.0% | $0.33 | +$12,857 | $337 |
| T-60 | 29 | 24 | 82.8% | $0.40 | +$7,293 | $325 |
| T-30 | 22 | 20 | 90.9% | $0.37 | +$4,734 | $247 |
| T-10 | 19 | 17 | 89.5% | $0.44 | +$4,194 | $259 |

**$43,556 total PnL from crossover trades.** 83-91% win rates at every timing.

### T-10 crossover fills (vwap_edge contrarian entries)

| Window | Symbol | CLOB UP | Entry | Shares | Slip | Levels | Ask Depth | PnL |
|--------|--------|---------|-------|--------|------|--------|-----------|-----|
| eth-1771275600 | ETH | 0.905 | $0.136 | 736 | 0.046 | 5 | $21.71 | +$634 |
| eth-1771210800 | ETH | 0.110 | $0.173 | 577 | 0.063 | 6 | $2.10 | +$475 |
| eth-1771207200 | ETH | 0.830 | $0.226 | 442 | 0.006 | 2 | $63.66 | +$340 |
| sol-1771467300 | SOL | 0.790 | $0.240 | 417 | 0.020 | 5 | $40.93 | +$315 |
| btc-1771173900 | BTC | 0.240 | $0.251 | 399 | 0.011 | 2 | $16.50 | +$297 |
| eth-1771497000 | ETH | 0.730 | $0.695 | 144 | 0.245 | 8 | $14.27 | +$42 |
| eth-1771280100 | ETH | 0.940 | $0.980 | 102 | 0.000 | 1 | $2.91 | $0 |

5/7 had entries below $0.26 with real book depth ($2-$64 within 1%).

### Liquidity finding: separate order books

UP and DOWN are **separate order books** on Polymarket. When CLOB strongly favors UP, MMs may pull DOWN-side quotes entirely. The eth-1771280100 crossover (CLOB UP 0.940) had zero DOWN liquidity — best DOWN ask was $0.98.

But eth-1771275600 (also CLOB UP 0.905) had real DOWN depth at $0.13-$0.15 with 167+59+184 shares. The difference is whether a MM is providing two-sided liquidity at that moment.

**Practical filter**: check contrarian token's best ask before entering. If best ask > $0.50, the book is empty — skip.

### Entry price evolution across offsets (same crossover windows)

| Offset | Avg Entry | Avg CLOB Conviction | Trades |
|--------|-----------|-------------------|--------|
| T-90 | $0.434 | 0.120 | 1 |
| T-60 | $0.459 | 0.108 | 2 |
| T-30 | $0.447 | 0.249 | 4 |
| T-10 | $0.386 | 0.335 | 7 |

Entries get **cheaper** closer to close as CLOB moves further, pushing the contrarian token to extreme lows. More windows qualify at T-10 (7 vs 1-4) since crossovers reveal themselves late.

### Two distinct patterns in VWAP contrarian

| Pattern | CLOB state | Win rate | Avg PnL/win | Frequency |
|---------|-----------|----------|-------------|-----------|
| Near-fair contrarian | 0.30-0.70 | 69% | ~$150 | Common |
| Crossover contrarian | >0.70 or <0.30 | 86% | ~$310 | ~15-20% of ETH windows |

The conviction filter (`maxClobConviction < 0.20`) targets pattern 1. The unfiltered variants catch pattern 2. Both run in parallel for A/B comparison.

### Crossover frequency by instrument

| Symbol | Windows with T-10 data | Crossovers | Rate |
|--------|----------------------|------------|------|
| ETH | 26 | 5 | **19.2%** |
| BTC | 17 | 1 | 5.9% |
| SOL | 30 | 1 | 3.3% |
| XRP | 23 | 0 | 0.0% |

ETH has the highest crossover rate — MMs reprice ETH slowest.

---

## Update 2026-02-19 (cont.): New Strategies Deployed

### Strategy: `contra_depth` (Contrarian Book Depth)

When CLOB is strongly decided (conviction > 0.25) but the contrarian token still has real ask depth (>$5-10), MMs are quoting the "losing" side with real money. This is itself predictive — presence of contrarian liquidity signals informed disagreement. Entry = contrarian side.

Variations: `cd-c25-d5`, `cd-c25-d10`, `cd-c30-d5` (conviction × depth thresholds).

### Strategy: `xover_spread` (Crossover Spread Predictor)

When CLOB is decided but the contrarian token's spread is widening (>$0.10-0.20), MMs are pulling quotes. Observed: eth-1771497000 DOWN spread went from $0.02 at T-90 to $0.36 at T-10 before resolution flipped. Wide contrarian spread = crossover incoming. Entry = contrarian side.

Variations: `xs-c25-s10`, `xs-c25-s20`, `xs-c30-s15` (conviction × spread thresholds).

### Other Considerations (Briefly Discussed, Not Implemented)

**Cross-asset clustering**: When multiple cryptos (BTC + ETH + XRP) all show VWAP-CLOB disagreement simultaneously, the signal may be stronger — a macro move affecting all assets. Could track agreement count across active windows and boost confidence when 2+ assets align. Not implemented — needs more data to validate frequency and incremental edge.

**Pre-positioning (Ruled Out)**: Limit buy orders on the contrarian token don't work — the contrarian token is already priced cheap (that's the edge). A limit order below the current ask would only fill if the price drops further, meaning you'd be buying something that's becoming MORE worthless. The entry has to be a market/taker order when the signal fires.
