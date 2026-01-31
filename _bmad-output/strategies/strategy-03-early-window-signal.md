# Strategy 03: Early Window Signal

## Tier
**Paper Trading** (Observation → Paper → Live when validated)

---

## Hypothesis
Spot price direction in the first 2-3 minutes of a window predicts the window's ultimate resolution. Early movers have information or early momentum persists.

## Edge Thesis
Either: (a) early participants have better information that predicts resolution, or (b) momentum in spot price tends to persist through the window. Both create predictable patterns.

---

## Components

### Probability Logic
- Measure spot price at window open
- Measure spot price at T+2min and T+3min
- Calculate early direction: is spot trending UP or DOWN?
- Signal: significant move (>0.5% in first 3 min) predicts direction

### Entry Conditions
- Window is in first 3 minutes
- Spot has moved >0.5% from window open (threshold TBD from data)
- Direction matches signal (spot up → buy YES, spot down → buy NO)
- Entry via limit order at current market price

### Exit Rules
- **Stop Loss (Thesis-based)**: If spot REVERSES and signal flips (was UP, now DOWN), exit immediately
- **Take Profit**: Hold to resolution - this is a resolution prediction strategy
- **No price-based stop**: Conviction trade, hold unless thesis invalidates

### Position Sizing
- Base: $2 per trade
- Entry is early = long time exposure, keep size small

---

## Risk Parameters
- Max position size: $3
- Stop-loss: Thesis-based (signal reversal)
- Max concurrent positions: 1 (this strategy)
- Correlation notes: May align with Strategy 5 if both signal same direction

---

## Test Plan

### Paper Trading
- Minimum trades: 200 windows with significant early movement
- Duration: Until 200+ qualifying windows observed
- Success metrics:
  - Win rate: does early direction predict resolution?
  - Momentum vs mean reversion: track both hypotheses
  - Optimal entry time: 2 min? 3 min? 5 min?
  - Signal strength: does larger early move = better prediction?

### Variations to Test
- **Variation A**: 0.3% move threshold, 2-minute window
- **Variation B**: 0.5% move threshold, 3-minute window
- **Variation C**: 0.7% move threshold, 5-minute window
- **Variation D**: Momentum only (no threshold, just direction)

### Live Graduation Criteria
- Win rate >55% after 200 trades
- Positive EV after spread/slippage
- Signal not degrading over time

---

## Team Review Summary
- **Vera (Quant)**: Pre-specify threshold to avoid overfitting. Track momentum vs mean reversion separately.
- **Nadia (Risk)**: Early entry = long exposure. Keep size small.
- **Theo (Execution)**: Execution is easiest early (more time). Good for learning.
- **Cassandra (Skeptic)**: Early movement might be random walk. Need clear falsifiability.

---

## Falsifiability
- If win rate <52% after 200 trades, thesis is noise
- If mean reversion outperforms momentum, thesis is inverted
- If signal strength doesn't correlate with win rate, no predictive power

---

## Data Collection Requirements
- Spot price at window open
- Spot price at T+1, T+2, T+3, T+5 minutes
- Window resolution outcome
- Track by magnitude of early move

---

## Notes
This strategy may be folded into the Window Timing Model (Component 7) rather than remaining standalone. Early signal could become a feature input to the probability model.
