# Strategy M: Exchange Median Predictor

## Hypothesis

The median of our 5 exchange prices (binance, coinbase, kraken, bybit, okx) is a better predictor of Chainlink's settlement price than polyRef alone, because Chainlink IS a median aggregation of exchange feeds. If `exchange_median - deficit_estimate > strike`, buy UP. If not, buy DOWN.

## Edge Thesis

Chainlink Data Streams uses 16 independent operators who each source from multiple exchanges and compute a median. Our 5-exchange median is an approximation of what Chainlink sees. This should be a strictly better predictor than polyRef (which is Polymarket's composite reference, not a median of exchanges).

The edge:
1. We can compute what Chainlink will likely settle at: `exchange_median - structural_deficit`
2. Compare this estimate against strike to predict UP/DOWN
3. If CLOB participants are pricing off polyRef (or a single exchange), our estimate may be more accurate

## Components

### Probability Logic

```javascript
// Compute 5-exchange median
const exchangePrices = [binance, coinbase, kraken, bybit, okx].filter(p => p != null);
const median = computeMedian(exchangePrices);

// Estimate Chainlink at close
const deficitEstimate = config.deficitEstimate || 80;
const estimatedCL = median - deficitEstimate;

// Resolution prediction
const predictedDirection = estimatedCL > strike ? 'UP' : 'DOWN';
const margin = Math.abs(estimatedCL - strike);
const confidence = Math.min(margin / 200, 0.95);
```

### Entry Conditions

1. At least 3 of 5 exchange prices available
2. `margin > minMarginThreshold` (don't trade when it's a coin flip)
3. Predicted token ask < `maxPrice`
4. Window within `entryWindowMs` of close

### Exit Rules

- Hold to resolution
- Binary payout: $1.00 if correct, $0.00 if wrong

### Position Sizing

- Fixed 1 token
- Optional: scale with margin (higher margin = higher confidence = larger position)

## Risk Parameters

- Max position size: $1.00 per window
- Max loss per trade: entry price
- Correlation: Overlaps with Edge C (both use Chainlink deficit concept) but fires more broadly. May produce conflicting signals with Edge H.
- When signals conflict with Edge C or H: Edge M should be the tiebreaker (better information)

## Test Plan

### Paper Trading (Backtest)

Run as TWO parallel tests:

**Test 1: Diagnostic — Exchange Median vs PolyRef as Predictor**
- For each window: compute exchange median at offset_ms = 60000
- Compare: `|exchange_median - chainlink_at_close|` vs `|polyref - chainlink_at_close|`
- Which is closer to what Chainlink actually settles at?
- Also: which individual exchange tracks closest?

**Test 2: Strategy — Trade on Exchange Median Prediction**
- Use exchange median to predict direction
- Trade the predicted direction's token
- Measure win rate vs entry price

### Variations to Test

| Param | Values | Purpose |
|-------|--------|---------|
| deficitEstimate | 40, 60, 80, 100, 120 | What deficit adjustment makes best predictions? |
| minMarginThreshold | 0, 20, 50, 100 | Minimum confidence before trading |
| maxPrice | 0.55, 0.60, 0.65, 0.70 | Entry price cap |
| entryWindowMs | 60000, 120000 | When to evaluate |

### Diagnostic Query

```sql
-- How close is each exchange to chainlink_at_close?
SELECT
  AVG(ABS(exchange_binance - chainlink_at_close)) AS binance_err,
  AVG(ABS(exchange_coinbase - chainlink_at_close)) AS coinbase_err,
  AVG(ABS(exchange_kraken - chainlink_at_close)) AS kraken_err,
  AVG(ABS(exchange_bybit - chainlink_at_close)) AS bybit_err,
  AVG(ABS(exchange_okx - chainlink_at_close)) AS okx_err,
  AVG(ABS(polyref_price - chainlink_at_close)) AS polyref_err
FROM window_backtest_states
WHERE offset_ms = 60000  -- 1 min before close
  AND chainlink_at_close IS NOT NULL
  AND exchange_binance IS NOT NULL;
```

### Live Graduation Criteria

- Exchange median predicts direction with >60% accuracy
- Better prediction accuracy than polyRef alone
- Positive EV after accounting for actual entry prices
- 100+ trades with consistent performance

## Team Review Summary

- **Vera:** Mechanistically the soundest hypothesis. Chainlink IS a median — we're approximating it. But with only 5 of 16 operator sources, our approximation may be noisy. The diagnostic (Test 1) is critical — do it before building the full strategy.
- **Nadia:** Risk profile is moderate — trades both directions based on prediction. Diversified exposure. But don't run simultaneously with Edge C/H without conflict resolution.
- **Theo:** The diagnostic query is a 30-second analysis. Run it FIRST. If exchange median doesn't beat polyRef as a predictor, skip the full strategy.
- **Cassandra:** I like that this is testable in one query. My concern: the deficit isn't constant — it's $60-100. If you use the wrong deficit estimate, you'll be wrong on marginal windows. The sweep over deficit estimates is essential.

## Falsifiability

- If polyRef tracks Chainlink at close better than the 5-exchange median, this hypothesis is wrong
- If no single deficit estimate produces >55% prediction accuracy, the model is too noisy
- If the optimal deficit estimate is different in the first 100 windows vs the last 107, it's unstable
