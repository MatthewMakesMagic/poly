# Strategy O: Chainlink Acceleration (Deficit Momentum)

## Hypothesis

The Chainlink deficit at the time of entry is not the deficit at resolution. If Chainlink is *declining* (moving further below strike) in the final 2 minutes, the deficit at close will be larger than at entry → DOWN becomes more likely. Conversely, if Chainlink is rising toward strike, UP becomes more likely.

## Edge Thesis

Edge C uses a static snapshot of the deficit. But Chainlink moves during the window. If we can detect the *direction* of Chainlink movement in the final minutes, we can:

1. **Enhance Edge C:** Only buy DOWN when deficit is large AND growing (Chainlink falling)
2. **Avoid Edge C traps:** Skip DOWN when deficit is large but shrinking (Chainlink rising toward strike)
3. **Enable UP trades:** When Chainlink is rising rapidly toward strike, even a small deficit might flip to UP

The edge exists because:
- Other strategies (including our Edge C) use a point-in-time deficit
- The trajectory is additional information that most CLOB participants don't compute
- Chainlink's 878ms lag means its current trajectory has predictive power for where it settles

## Components

### Probability Logic

```javascript
// Measure Chainlink movement over lookback period
const clNow = chainlinkAtOffset(60000);   // 1 min before close
const clPrev = chainlinkAtOffset(120000);  // 2 min before close
const clDelta = clNow - clPrev;            // positive = rising, negative = falling

const deficitNow = strike - clNow;
// Estimate deficit at close
const estimatedDeficitAtClose = deficitNow - clDelta; // extrapolate 1 more minute

// If CL is falling (clDelta < 0), deficit grows → DOWN
// If CL is rising (clDelta > 0), deficit shrinks → UP possible
```

### Entry Conditions

**Mode A: Enhanced Edge C (DOWN)**
1. Base Edge C conditions met (deficit > threshold, ref near strike, etc.)
2. `clDelta < 0` (Chainlink declining) — deficit is growing
3. DOWN ask < `maxDownPrice`

**Mode B: Momentum UP**
1. `clDelta > clRisingThreshold` (Chainlink rising fast, e.g. +$20 in 1 min)
2. `estimatedDeficitAtClose < 0` (CL trajectory suggests it'll cross above strike)
3. UP ask < `maxUpPrice`

### Exit Rules

- Hold to resolution (binary payout)

### Position Sizing

- Fixed 1 token
- Scale with acceleration magnitude for conviction

## Risk Parameters

- Max position size: $1.00 per window
- Mode A: same risk as Edge C but higher selectivity → fewer trades, higher win rate expected
- Mode B: contrarian to structural bias → higher risk, must have strong signal
- Correlation: Mode A is a filtered Edge C (correlated). Mode B is anti-correlated (diversification).

## Test Plan

### Paper Trading (Backtest)

**Pre-requisite diagnostic: How much does Chainlink move in the final 2 minutes?**

```javascript
// For each window: compare chainlink_price at offset 120000 vs offset 60000 vs offset 0
// Questions:
// 1. What's the average |delta| in last 2 min?
// 2. Does the direction of delta predict resolution?
// 3. Is the signal strong enough to be actionable?
```

If the average |delta| is < $5, Chainlink barely moves and this strategy has no predictive power.

### Diagnostic Query

```sql
-- Chainlink movement in final 2 minutes
WITH cl_pairs AS (
  SELECT
    w120.window_close_time,
    w120.chainlink_price AS cl_2min,
    w60.chainlink_price AS cl_1min,
    w0.chainlink_price AS cl_close,
    w120.resolved_direction
  FROM window_backtest_states w120
  JOIN window_backtest_states w60
    ON w120.window_close_time = w60.window_close_time
    AND w60.offset_ms = 60000
  JOIN window_backtest_states w0
    ON w120.window_close_time = w0.window_close_time
    AND w0.offset_ms = 0
  WHERE w120.offset_ms = 120000
    AND w120.chainlink_price IS NOT NULL
    AND w60.chainlink_price IS NOT NULL
    AND w0.chainlink_price IS NOT NULL
)
SELECT
  COUNT(*) AS windows,
  AVG(ABS(cl_1min - cl_2min)) AS avg_delta_last_2min,
  AVG(ABS(cl_close - cl_1min)) AS avg_delta_last_1min,
  -- When CL is falling (cl_1min < cl_2min), what % resolves DOWN?
  COUNT(*) FILTER (WHERE cl_1min < cl_2min) AS cl_falling_count,
  COUNT(*) FILTER (WHERE cl_1min < cl_2min AND resolved_direction = 'DOWN') AS cl_falling_down,
  -- When CL is rising (cl_1min > cl_2min), what % resolves UP?
  COUNT(*) FILTER (WHERE cl_1min > cl_2min) AS cl_rising_count,
  COUNT(*) FILTER (WHERE cl_1min > cl_2min AND resolved_direction = 'UP') AS cl_rising_up
FROM cl_pairs;
```

### Variations to Test

| Param | Values | Purpose |
|-------|--------|---------|
| lookbackMs | 60000, 120000, 180000 | How far back to measure CL direction |
| clFallingThreshold | -5, -10, -20 | Min decline to trigger Mode A enhancement |
| clRisingThreshold | 10, 20, 50 | Min rise to trigger Mode B (UP trade) |
| Combined with Edge C | yes/no | Does adding acceleration improve Edge C win rate? |

### Live Graduation Criteria

- Diagnostic confirms: Chainlink moves > $10 in final 2 minutes in > 30% of windows
- Mode A: win rate > Edge C standalone (marginal improvement)
- Mode B: > 60% win rate on qualifying windows (must overcome structural DOWN bias)
- 30+ trades for each mode

## Team Review Summary

- **Vera:** Theoretically sound — using trajectory instead of snapshot. But the diagnostic is essential. If CL barely moves in 2 min ($2-3), there's no signal. The 878ms lag means the last second matters more than the last minute.
- **Nadia:** Mode A is safe — it's Edge C with a filter. Mode B (buying UP against structural bias) needs rigorous validation before capital deployment.
- **Theo:** 10-second sampling may miss intra-second moves. But if CL moves $20+ in a minute, that's visible at 10s resolution. The diagnostic will tell us.
- **Cassandra:** My main concern: extrapolating 1 minute of CL movement forward is naive. BTC can reverse direction in seconds. The signal might work on average but the variance could be enormous. Also: does this actually fire on different windows than Edge C, or just the same ones with an extra filter?

## Falsifiability

- If average |CL delta| in final 2 minutes is < $5, there's no signal → kill this strategy
- If CL direction in final 2 min doesn't predict resolution better than random, the trajectory is noise
- If Mode A doesn't improve Edge C's win rate, the extra filter isn't adding value
