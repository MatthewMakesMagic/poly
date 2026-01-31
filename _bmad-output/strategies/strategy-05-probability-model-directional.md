# Strategy 05: Probability Model Directional

## Tier
**LIVE EXECUTION** - Core thesis strategy, real money from day 1

---

## Hypothesis
Our probability model (comparing current spot to strike using Black-Scholes framework) generates better probability estimates than the Polymarket price. The market miscalculates probability because participants are gambling, not modeling.

## Edge Thesis
The market is populated by manual traders making intuitive bets. They don't have:
- Real-time spot price feeds
- Mathematical probability models
- Calibrated volatility estimates

We have all three. When our model says 65% and market says 55%, we have 10c of expected edge.

---

## Components

### Probability Logic
- **Inputs**: Current spot price, strike price (window threshold), time remaining, volatility (σ)
- **Model**: Black-Scholes: P(UP) = N(d2) where d2 = (ln(S/K) + (r - σ²/2)τ) / (σ√τ)
- **Volatility**: 3-6 hour rolling realized volatility, updated each window
- **Output**: Our P(UP) and P(DOWN)

### Entry Conditions
- Our model probability ≠ market price
- No fixed edge threshold initially - take all trades to collect data
- Direction: if model P(UP) > market price, buy YES. Vice versa.
- Entry: limit order at model fair value. If not filled in 30s, escalate to market.

### Exit Rules
- **Stop Loss (Thesis-based)**: Exit immediately if model probability FLIPS
  - Example: bought YES because model said 60% UP. If model now says 45% UP, exit.
- **Take Profit**: HOLD TO RESOLUTION
  - This is a conviction strategy. We believe our model is right.
  - Don't exit early on price movement.
- **Resolution**: Accept binary outcome. Win or lose based on resolution.

### Position Sizing
- Base: $2 per trade
- Scale up on higher conviction:
  - Model divergence 5-10c: $2
  - Model divergence 10-15c: $3
  - Model divergence >15c: $4-5
- Never exceed $5 per single trade during testing

---

## Risk Parameters
- Max position size: $5
- Stop-loss: Thesis-based (model flips)
- No daily drawdown limit during testing
- Max concurrent positions: 3 (this strategy)
- Correlation notes: Core strategy - others may align or conflict

---

## Test Plan

### Live Trading (From Day 1)
- Minimum trades: 150 before major adjustments
- Duration: Continuous until 150+ trades
- Track everything in trade_events table

### Success Metrics
- Win rate vs model-predicted win rate
- Actual P&L vs expected P&L
- Slippage: expected entry vs actual entry
- Model calibration: is 60% prediction actually winning 60%?
- Edge by magnitude: do larger divergences produce more profit?

### Variations to Test
- **Variation A**: No edge threshold (trade all divergences)
- **Variation B**: 5c minimum edge threshold
- **Variation C**: Time-weighted (larger positions earlier in window)
- Run variations sequentially, not in parallel (avoid confusion)

### Refinement Criteria
After 150 trades:
- Set edge threshold based on break-even analysis
- Adjust volatility lookback if model is miscalibrated
- Add/remove entry conditions based on data

---

## Execution Specification

### Order Flow
1. Signal detected: model diverges from market
2. Log intent to trade_intents table
3. Place limit order at model fair value
4. If not filled in 30 seconds: escalate to aggressive (cross the spread)
5. On fill: log to positions and trade_events
6. Monitor: update model each tick, check for thesis flip
7. On resolution: log outcome, calculate P&L

### Latency Targets
- Signal detection to order submission: <500ms
- Total signal to fill: <2s ideally
- Track all latencies in trade_events

---

## Team Review Summary
- **Vera (Quant)**: Volatility estimation is critical. Use 3-6hr rolling. 5c threshold after 150 trades.
- **Nadia (Risk)**: Thesis-based stop is right. Hold to resolution for full thesis test.
- **Theo (Execution)**: Limit-then-escalate is correct approach. Track slippage religiously.
- **Cassandra (Skeptic)**: Your model might be wrong. Track model accuracy by confidence bucket.

---

## Falsifiability
- If model is not profitable after 150+ trades with meaningful divergence, thesis is wrong
- If model calibration is off (60% predictions win 50%), model needs fixing
- If profitability decays over time, edge is being arbitraged
- If slippage eats all edge, execution is the problem, not the model

---

## Data Collection Requirements
- All fields in trade_events table
- Specifically:
  - signal_detected_at, order_submitted_at, order_filled_at
  - price_at_signal, expected_price, price_at_fill
  - model_probability (custom field to add)
  - market_price_at_signal
  - resolution outcome
  - slippage calculations

---

## Integration with Architecture

This strategy uses:
- Component 7 (Window Timing Model) for probability calculation
- Component 8 (Spot Lag Tracker) for execution timing
- strategy_instances table for configuration
- trade_events table for diagnostics

Strategy ID: `prob-model-directional-v1`
