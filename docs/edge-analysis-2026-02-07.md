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
