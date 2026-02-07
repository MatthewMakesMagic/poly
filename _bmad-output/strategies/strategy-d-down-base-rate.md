# Strategy D: Structural DOWN Base Rate

## Hypothesis

The Chainlink settlement oracle is structurally ~$60-100 below exchange prices. This creates a persistent DOWN bias (55.1% in our 207-window sample). If the CLOB does not fully price this bias, buying DOWN at every window is +EV.

## Edge Thesis

Chainlink Data Streams is a 16-operator median that consistently runs below the exchange cluster. The strike is set from polymarket reference (near exchange level). Resolution: `chainlink_close > strike ? UP : DOWN`. When chainlink_close is structurally $80 below the exchange cluster where strike was set, DOWN is inherently favored.

The edge persists because:
1. Many CLOB participants may not understand the Chainlink vs exchange gap
2. The gap is variable ($60-100), making it hard to model precisely
3. New participants enter daily, maintaining the mispricing

## Components

### Probability Logic

```javascript
// Simple: DOWN resolves at observed base rate (55.1%)
// Edge = baseRate - entryPrice
// +EV when: entryPrice < observedDownRate
const baseRate = 0.551;  // from 207 windows
const edge = baseRate - downAskPrice;
```

### Entry Conditions

1. Window must be in final `entryWindowMs` before close (default: 120000ms)
2. DOWN ask price must be below `maxPrice` threshold
3. DOWN ask price must be available (non-null, >0, <1)
4. Signal fires on EVERY window that passes conditions

### Exit Rules

- Hold to resolution (no early exit)
- Binary payout: $1.00 if DOWN, $0.00 if UP

### Position Sizing

- Fixed size: 1 token per window
- Scale later based on edge magnitude (lower ask → higher conviction)

## Risk Parameters

- Max position size: $1.00 per window
- Stop-loss: N/A (hold to resolution)
- Max daily drawdown: 10 losses in a row = -$5.50 at avg entry 0.55 (manageable)
- Correlation: Fires EVERY window — maximum exposure to the base rate hypothesis. Anti-correlated with Edge H (which buys UP)

## Test Plan

### Paper Trading (Backtest)

- Run on all 207 windows in fast-track table
- Primary metric: `actual_win_rate - avg_entry_price` = edge per trade
- Success: positive edge after accounting for actual fill prices

### Variations to Test

| Param | Values | Purpose |
|-------|--------|---------|
| maxPrice | 0.50, 0.55, 0.60, 0.65, 0.70 | At what ask price does the edge disappear? |
| entryWindowMs | 30000, 60000, 120000, 180000, 300000 | Does entry timing affect fill quality? |
| (no deficit filter) | — | This is the key difference from Edge C: NO deficit filter |

### Live Graduation Criteria

- 100+ backtest trades with positive EV/trade
- Actual DOWN ask consistently < 0.55 (observed base rate)
- Win rate within 1 standard error of 55.1% (not a fluke)
- Survives forward-testing on next 100 windows after backtest period

## Team Review Summary

- **Vera:** Best sample size of all strategies (207). But 55.1% is CI ±6.8% — could be 48-62%. Need to see if edge persists when filtered by actual entry prices.
- **Nadia:** Maximum exposure (every window). Daily risk = ~96 windows × avg loss. Must have position limits.
- **Theo:** The critical question is execution: what does DOWN actually cost? If avg ask is 0.58, there's no edge. Must test with real CLOB data.
- **Cassandra:** Simplest strategy = hardest to argue against. But if the market prices DOWN at 0.56+, the edge is already captured. This strategy is really a DIAGNOSTIC — it tells us whether the market knows about the bias.

## Falsifiability

- If average DOWN ask across 207 windows is > 0.551, the market already prices the bias → no edge
- If DOWN resolution rate falls to <52% on the next 100 windows, the structural bias may be weakening
- If Chainlink Data Streams updates its methodology to track exchanges more closely, the deficit could shrink

## Implementation Notes

- Use fast-track table: `window_backtest_states`
- For each window: take `clob_down_ask` at the target offset
- Entry price = `clob_down_ask + spreadBuffer` (default 0.005)
- Compare with `resolved_direction` = 'DOWN' for win/loss
- Report: avg entry price, win rate, EV per trade, total PnL
