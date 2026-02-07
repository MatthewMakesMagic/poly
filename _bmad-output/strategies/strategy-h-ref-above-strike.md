# Strategy H: Ref-Above-Strike → Buy UP

## Hypothesis

When polyRef is significantly above strike (>$100), the price has moved UP enough that even with the ~$80 Chainlink structural deficit, Chainlink at close is still above strike → UP resolves. This is the complement to Edge C, exploiting the 65% of windows that Edge C rejects.

## Edge Thesis

Edge C rejects 65% of windows because `ref_far_from_strike` (polyRef is >$100 from strike). In most of these, polyRef is ABOVE strike — meaning BTC has risen since window open. Even though Chainlink runs ~$80 below exchange prices:

```
If polyRef = strike + $200
And chainlink ≈ polyRef - $80 = strike + $120
Then chainlink_close > strike → UP
```

The edge exists because:
1. CLOB participants may see "ref far from strike" and still price uncertainty
2. The structural deficit is known but its exact magnitude per window isn't
3. When ref is far above, UP tokens may still be priced at 0.50-0.65 instead of 0.70+

## Components

### Probability Logic

```javascript
// Probability increases with ref-to-strike margin vs deficit
const refAboveStrike = polyRef.price - strike;  // positive = ref above
const estimatedCLAtClose = polyRef.price - 80;  // rough deficit estimate
const margin = estimatedCLAtClose - strike;      // positive = UP likely

// Higher margin = higher confidence
const pUp = margin > 0 ? Math.min(0.5 + margin / 200, 0.95) : 0.3;
```

### Entry Conditions

1. `polyRef.price - strike > minRefAboveThreshold` (default: $100)
2. `UP ask < maxUpPrice` (default: 0.70)
3. Window within `entryWindowMs` of close (default: 120000ms)
4. UP ask is available (non-null, >0, <1)

### Exit Rules

- Hold to resolution
- Binary payout: $1.00 if UP, $0.00 if DOWN

### Position Sizing

- Fixed 1 token
- Optional: scale with margin (larger ref-above-strike = larger position)

## Risk Parameters

- Max position size: $1.00 per window
- Stop-loss: N/A (hold to resolution)
- Max loss per trade: UP ask price (e.g., $0.65)
- Correlation: **Anti-correlated with Edge C** — fires when C is silent. Together they cover different market regimes.

## Test Plan

### Paper Trading (Backtest)

- Run on all 207 windows, expect ~130 to qualify (the 65% Edge C rejects)
- Primary metric: win rate on qualifying windows vs avg entry price
- Must measure: what's the actual resolution split when ref is >$100 above strike?

### Variations to Test

| Param | Values | Purpose |
|-------|--------|---------|
| minRefAboveThreshold | 50, 100, 150, 200, 300 | How far above strike before UP is favored? |
| maxUpPrice | 0.55, 0.60, 0.65, 0.70, 0.80 | How much are we willing to pay? |
| entryWindowMs | 60000, 120000, 180000 | Timing sensitivity |
| deficitEstimate | 60, 80, 100 | Used for confidence scoring |

### Critical Diagnostic First

Before running the full strategy: **bucket windows by refAboveStrike and check resolution rate**

```sql
-- What % resolves UP when ref is far above strike?
SELECT
  CASE
    WHEN polyref_price - strike_price > 300 THEN '>300'
    WHEN polyref_price - strike_price > 200 THEN '200-300'
    WHEN polyref_price - strike_price > 100 THEN '100-200'
    WHEN polyref_price - strike_price > 0 THEN '0-100'
    ELSE '<0 (below)'
  END AS ref_above_bucket,
  COUNT(*) as windows,
  COUNT(*) FILTER (WHERE resolved_direction = 'UP') AS up_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE resolved_direction = 'UP') / COUNT(*), 1) AS up_pct
FROM window_backtest_states
WHERE offset_ms = 60000  -- 1 min before close
  AND resolved_direction IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

### Live Graduation Criteria

- UP resolution rate > 60% in the qualifying bucket
- avg UP ask < observed UP resolution rate (positive EV)
- 50+ qualifying trades in backtest
- Complementary to Edge C (different windows)

## Team Review Summary

- **Vera:** Mechanistically the strongest of the new hypotheses. If ref is $200+ above strike, Chainlink needs to be ABOVE its usual $80 deficit zone to resolve DOWN — unlikely. But need to verify with data.
- **Nadia:** Anti-correlation with Edge C is a portfolio benefit. Running C + H together diversifies across market regimes.
- **Theo:** UP tokens in "ref far above" windows — are they cheap? If the market already prices this at 0.75+, there's no edge. Check actual asks.
- **Cassandra:** The mechanism is sound but the critical question is: how often does ref move $200+ above strike in a 5-minute window? If it's rare (<20 windows), we can't validate. Also: ref could be above strike at minute 3 and crash back by minute 5.

## Falsifiability

- If UP resolution rate in "ref >$100 above strike" windows is ≤55%, the deficit overwhelms the directional move
- If UP ask in qualifying windows is consistently >0.70, the market already prices it correctly
- If fewer than 30 windows qualify, insufficient sample size
