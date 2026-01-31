# Component 08: Spot Lag Tracker

## Type
**Shared Component** - Infrastructure for measuring and exploiting market lag

---

## Purpose
Quantify the lag between spot price movements and Polymarket price reactions. Use this information to:
1. Validate Strategy 1 (Spot-Market Divergence)
2. Improve execution timing across all strategies
3. Detect when lag is exploitable vs noise

---

## What We're Measuring

### Lag Definition
When spot price moves at time T, how long until market price reflects that move?

- **τ = 0**: Market moves simultaneously with spot (no lag)
- **τ = 5s**: Market reflects spot movement 5 seconds later
- **τ = ∞**: Market never reflects spot movement (no relationship)

### Cross-Correlation Analysis
Measure correlation between:
- Spot returns at time T
- Market returns at time T + lag

At various lags: 0s, 1s, 2s, 5s, 10s, 30s, 60s

The lag with highest correlation is τ* (optimal lag).

---

## Implementation Specification

### Interface

```javascript
module.exports = {
  init: async (config) => {},

  // Record price observations
  recordSpotPrice: (asset, price, timestamp) => {},
  recordMarketPrice: (windowId, price, timestamp) => {},

  // Analysis
  calculateLagCorrelation: (asset, lagSeconds) => {
    // Returns correlation coefficient at specified lag
  },

  getOptimalLag: (asset) => {
    // Returns τ* that maximizes correlation
  },

  getLagProfile: (asset) => {
    // Returns { lag: correlation } for all tested lags
  },

  // Execution guidance
  shouldWaitForLag: (spotMovement, currentLag) => {
    // Returns true if we should delay order to exploit lag
  },

  getState: () => {},
  shutdown: async () => {}
};
```

### Data Collection Requirements
- Spot price at high frequency (1s or faster)
- Market price at same frequency
- Timestamps with millisecond precision
- Sufficient history (1000+ observations for statistical significance)

---

## Analysis Methodology

### Rolling Cross-Correlation

```
For each lag τ in [0, 1, 2, 5, 10, 30, 60] seconds:

  spot_returns = (spot[t] - spot[t-1]) / spot[t-1]
  market_returns = (market[t+τ] - market[t+τ-1]) / market[t+τ-1]

  correlation[τ] = corr(spot_returns, market_returns)

τ* = argmax(correlation)
```

### Statistical Significance
- Require p-value < 0.05 for correlation to be meaningful
- Sample size: 1000+ return pairs minimum
- Track confidence intervals on τ*

### Regime Detection
Lag may vary by:
- Time of day
- Asset (BTC vs ETH vs SOL)
- Market conditions (high vol vs low vol)
- Day of week

Track separately and report if patterns emerge.

---

## Outputs

### Real-Time Metrics
- Current estimated lag (τ*)
- Correlation at optimal lag
- Lag stability (is τ* jumping around?)

### Reporting
- Lag by asset
- Lag by time of day
- Lag vs execution latency comparison

### Execution Guidance
If τ* = 5 seconds and our execution latency = 1 second:
- We have 4 seconds of exploitable lag
- Strategy 1 is viable

If τ* = 2 seconds and our execution latency = 2 seconds:
- No exploitable lag
- Strategy 1 is not viable

---

## Integration Points

### Used By
- Strategy 1: Spot-Market Divergence (validation and entry timing)
- Strategy 5: Probability Model Directional (execution timing)
- Strategy 6: Market Making Hybrid (when to place orders)

### Dependencies
- Spot price client
- Market price feed (Polymarket WebSocket)
- Database for historical price storage

---

## Configuration

```javascript
// config/default.js
module.exports = {
  spotLagTracker: {
    lagsToTest: [0, 1, 2, 5, 10, 30, 60], // seconds
    sampleSize: 1000, // minimum observations
    updateFrequency: 300000, // recalculate every 5 minutes
    significanceThreshold: 0.05, // p-value
    assets: ['BTC', 'ETH', 'SOL'] // track separately
  }
};
```

---

## Testing

### Unit Tests
- Cross-correlation calculation is correct
- Optimal lag detection works with synthetic data
- Edge cases: no correlation, perfect correlation, negative correlation

### Integration Tests
- Real-time price recording works
- Lag estimates are stable over time
- Regime detection identifies meaningful patterns

---

## Key Questions to Answer

1. **Does lag exist?** Is correlation at any τ > 0 higher than at τ = 0?
2. **Is lag exploitable?** Is τ* > our execution latency?
3. **Is lag stable?** Does τ* stay consistent or jump around?
4. **Does lag vary?** Different by asset? Time of day? Volatility?
5. **Is lag predictive?** Does trading on lag produce positive returns?

---

## Notes

### Noise vs Signal
Low correlation at all lags = no predictive relationship. This would invalidate Strategy 1.

High correlation at τ = 0 = no lag, market is efficient. Strategy 1 not viable.

High correlation at τ > 0 with τ > execution latency = exploitable lag. Strategy 1 is viable.

### Edge Decay
Lag that exists today may disappear as:
- Market matures
- More sophisticated participants arrive
- Bots arbitrage it away

Track lag magnitude over weeks/months to detect decay.
