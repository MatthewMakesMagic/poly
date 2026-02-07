# Strategy Workshop Session — 2026-02-07

**Participants:** Marcus (lead), Vera, Nadia, Theo, Cassandra, Matthew
**Context:** Edge C validated (3/3 wins, +$1.15). 207 windows in fast-track table. 55.1% DOWN resolution rate.

## Key Data Points

- 207 resolved windows with pre-computed state at 10s intervals
- Resolution split: UP=93, DOWN=114 (55.1% DOWN)
- Edge C rejection analysis: 65% ref_far_from_strike, 15% deficit_low, 10% down_expensive
- Chainlink structural deficit: ~$60-100 below exchange cluster
- Chainlink lag: 878ms median after polyRef
- 5 exchange feeds + polyRef + chainlink + CLOB up/down in fast-track table

## 16 Raw Hypotheses Generated

See full ideation in session transcript below.

## Outcomes

### ADVANCE — Implement and Backtest

| ID | Name | Fire Rate | Spec File |
|----|------|-----------|-----------|
| D | Structural DOWN Base Rate | ~207 windows | strategy-d-down-base-rate.md |
| H | Ref-Above-Strike Buy UP | ~130 windows | strategy-h-ref-above-strike.md |
| M | Exchange Median Predictor | ~207 windows | strategy-m-exchange-median.md |
| O | Chainlink Acceleration | Same as C + filter | strategy-o-chainlink-accel.md |

### ADVANCE AS DIAGNOSTIC

| ID | Name | Purpose |
|----|------|---------|
| I | Coinbase-Chainlink Proximity | Which exchange best predicts Chainlink? |
| L | Volatility Regime | Regime switch for all strategies |

### DEFER (need more data)

| ID | Name | Reason |
|----|------|--------|
| F | CLOB Spread Collapse | Verify spread data quality |
| G | CLOB Mid-Price Drift | 10s sampling too coarse |
| N | CLOB Bid-Size Asymmetry | Not in fast-track table |
| Q | Combined Edge Score | 207 windows → overfitting risk |
| S | Window Time-of-Day | <10 windows per hour bucket |

### KILLED

| ID | Name | Reason |
|----|------|--------|
| J | Time-Decay Pricing | Binary options lack smooth theta decay |
| K | Dual-Token Arbitrage | Spreads + execution timing kill edge |
| R | Contrarian | No evidence of systematic CLOB overshoot |
| E | Exchange Divergence | Vague mechanism — divergence from what? |
| P | PolyRef Reversal | PolyRef-strike crossing irrelevant to resolution |

## Team Review Highlights

**Vera:** Edge D has best sample size (207) but 55.1% is barely significant (CI ±6.8%). Edge H exploits the largest rejection bucket — clever complementary design. Edge M is mechanistically sound.

**Nadia:** Edge D has highest exposure (every window). Need position limits. Edge H + Edge C together = portfolio diversification across window types.

**Theo:** Must test with ACTUAL ask prices, not theoretical. Edge M (exchange median) is a one-query diagnostic — do it first.

**Cassandra:** Killed 5 strategies. Edge D's main risk: market may already price in the 55% bias. Edge H needs to verify the ref-above-strike bucket doesn't also resolve DOWN at 55%.
