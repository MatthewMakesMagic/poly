# Strategy 01: Spot-Market Divergence

## Tier
**Paper Trading** (Observation → Paper → Live when validated)

---

## Hypothesis
When spot price moves, the Polymarket price lags. When divergence exceeds a threshold, convergence toward spot-implied probability is likely.

## Edge Thesis
The market is slow to incorporate spot price information. Participants are watching the Polymarket price, not the underlying spot. This creates temporary mispricings that correct as information diffuses.

---

## Components

### Probability Logic
- Calculate spot-implied probability: P(spot > strike at expiry) using Black-Scholes model
- Calculate market-implied probability: current market price
- Divergence = |spot-implied P - market P|

### Entry Conditions
- Divergence exceeds threshold (start with 5c, refine from data)
- Direction: buy the side that spot-implied probability favors
- Entry via limit order at or near current market price

### Exit Rules
- **Stop Loss (Thesis-based)**: Exit if divergence WIDENS by 50% from entry. Thesis invalidated - market moving away from spot.
- **Take Profit (Convergence)**: Exit when divergence closes to <1c. Don't wait for resolution.
- **Time Stop**: If no convergence within X minutes, exit. (X = TBD from data)

### Position Sizing
- Base: $2 per trade
- Scale: Consider larger size when divergence is extreme (>8c)

---

## Risk Parameters
- Max position size: $5
- Stop-loss: Thesis-based (divergence widens 50%)
- Max concurrent positions: 2 (this strategy)
- Correlation notes: May conflict with Strategy 5 if both signal same direction

---

## Test Plan

### Paper Trading
- Minimum trades: 200
- Duration: Until 200 divergence events observed
- Success metrics:
  - Convergence rate (target: >60%)
  - Average time to convergence
  - Win rate on simulated trades
  - Expected value per trade

### Variations to Test
- **Variation A**: 3c divergence threshold
- **Variation B**: 5c divergence threshold
- **Variation C**: 8c divergence threshold
- **Variation D**: Time-weighted (larger divergence earlier in window)

### Live Graduation Criteria
- Convergence rate >60% over 200+ observations
- Positive expected value after simulated spread/slippage
- Signal-to-fill latency < observed lag duration

---

## Team Review Summary
- **Vera (Quant)**: Need 200+ divergence events. Track lag duration vs execution latency.
- **Nadia (Risk)**: Thesis-based stop is appropriate. Edge decay is key risk.
- **Theo (Execution)**: If lag < execution latency, strategy is DOA. Measure latency first.
- **Cassandra (Skeptic)**: Lag might be noise. Falsifiability: convergence rate <55% = kill.

---

## Falsifiability
- If convergence rate <55% after 200 observations, thesis is false
- If observed lag < signal-to-fill latency, strategy is unexecutable
- If edge decays over time (first 100 vs second 100), market is adapting

---

## Data Collection Requirements
- Spot price (multi-exchange feed) at high frequency
- Market price at same frequency
- Timestamps for divergence detection and convergence
- Window outcomes for validation
