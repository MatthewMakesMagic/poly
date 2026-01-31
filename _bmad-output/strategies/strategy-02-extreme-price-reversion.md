# Strategy 02: Extreme Price Reversion

## Tier
**Paper Trading** (Observation → Paper → Live when validated)

---

## Hypothesis
When market prices reach extremes (>80c or <20c), participants become overconfident. The market overshoots true probability, creating reversion opportunities.

## Edge Thesis
Behavioral bias: humans anchor and become overconfident at extremes. A market at 90c implies 90% probability, but true probability might be 80%. This overconfidence creates fade opportunities.

---

## Components

### Probability Logic
- Track price at extremes (>80c for UP, <20c for DOWN)
- Compare extreme prices to actual resolution rates
- Build calibration curve: at price X, what's actual resolution %?

### Entry Conditions
- Price reaches extreme zone (initial: >85c or <15c)
- Entry: fade the extreme (buy NO at 85c+, buy YES at 15c-)
- **Limit orders ONLY** - spreads wide at extremes, never pay market order spread

### Exit Rules
- **Stop Loss (Price-based)**: If price moves further to extreme (85c → 92c), thesis wrong. Exit.
- **Take Profit (Reversion)**: When price reverts to target zone. Example: entered at 85c, exit at 70c.
- **Resolution**: If held to expiry, accept binary outcome

### Position Sizing
- Base: $2 per trade
- Risk/reward is asymmetric: buy at 15c → max loss 15c, max gain 85c

---

## Risk Parameters
- Max position size: $4 (small due to contrarian nature)
- Stop-loss: 7c further into extreme (entry 85c → stop 92c)
- Max concurrent positions: 1 (this strategy)
- Correlation notes: Contrarian - may offset directional strategies

---

## Test Plan

### Paper Trading
- Minimum trades: 100 extreme events
- Duration: Until 100+ extreme price events observed
- Success metrics:
  - Calibration: does 85c resolve UP 85% of time, or less?
  - Win rate on reversion trades
  - Average reversion magnitude
  - Time in extreme zone before reversion

### Variations to Test
- **Variation A**: Entry at 85c/15c, target reversion to 70c/30c
- **Variation B**: Entry at 90c/10c, target reversion to 75c/25c
- **Variation C**: Entry at 80c/20c, wider zone
- Track by price bucket: 80-85, 85-90, 90-95, 95-100

### Live Graduation Criteria
- Extremes resolve in line with price <85% of time (overconfidence confirmed)
- Positive EV after spread/slippage (limit orders only)
- Reversion rate >50% within window

---

## Team Review Summary
- **Vera (Quant)**: Need 100+ extreme events by price bucket. Track calibration curve.
- **Nadia (Risk)**: Contrarian feels risky but risk/reward is asymmetric in your favor.
- **Theo (Execution)**: Limit orders ONLY. Spreads are 3-4c at extremes = 20%+ of position.
- **Cassandra (Skeptic)**: Market might be right. 90c might actually be 90%. Adverse selection risk.

---

## Falsifiability
- If extremes resolve in line with price 90%+ of time, no overconfidence exists
- If reversion rate <50%, mean reversion thesis is wrong
- If limit orders don't fill at extremes, execution is impossible

---

## Data Collection Requirements
- Price distribution over time within windows
- Resolution outcomes at various price levels
- Spread data at extreme prices
- Fill rates on limit orders at extremes
