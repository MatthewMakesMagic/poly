# Component 07: Window Timing Model (Black-Scholes)

## Type
**Shared Component** - Infrastructure used by multiple strategies

---

## Purpose
Calculate probability of UP/DOWN outcome as a function of:
- Current spot price
- Strike price (window threshold)
- Time remaining in window
- Volatility

This is the probability engine that powers Strategy 5 and Strategy 6.

---

## Mathematical Framework

### Black-Scholes for Binary Options

**P(UP)** = N(d2)

Where:
- d2 = (ln(S/K) + (r - σ²/2)τ) / (σ√τ)
- S = current spot price
- K = strike price
- τ = time to expiry (in appropriate units)
- σ = volatility (annualized, then scaled)
- r = risk-free rate (≈ 0 for 15-min windows)
- N() = standard normal CDF

**P(DOWN)** = 1 - P(UP)

### Volatility Scaling

Volatility input should match the timeframe:

| Window | Vol Lookback | Scaling |
|--------|--------------|---------|
| 15-min | 3-6 hours rolling | σ_15min = σ_annual / √(365 * 24 * 4) |
| 1-hour | 6-24 hours rolling | σ_1hr = σ_annual / √(365 * 24) |
| 4-hour | 1-3 days rolling | σ_4hr = σ_annual / √(365 * 6) |

Or calculate realized volatility directly from recent returns at the trading frequency.

---

## Implementation Specification

### Interface

```javascript
// Component exports
module.exports = {
  init: async (config) => {},

  // Core function
  calculateProbability: (spotPrice, strikePrice, timeRemaining, volatility) => {
    // Returns { pUp: number, pDown: number }
  },

  // Convenience wrappers
  getProbabilityForWindow: (windowId) => {
    // Fetches current spot, strike, time remaining, calculates prob
  },

  // Volatility estimation
  getCurrentVolatility: (asset, lookbackHours) => {
    // Returns rolling realized volatility
  },

  getState: () => {},
  shutdown: async () => {}
};
```

### Inputs Required
- **Spot price feed**: Real-time from spot client
- **Strike price**: From window definition (where UP/DOWN threshold is)
- **Window timing**: Start time, end time, current time
- **Historical prices**: For volatility calculation

### Outputs
- P(UP): probability spot will be above strike at expiry
- P(DOWN): probability spot will be below strike at expiry
- Confidence metrics (optional): how stable is the estimate?

---

## Volatility Estimation

### Recommended Approach: Rolling Realized Volatility

```
σ = std(returns) * √(periods_per_year)

For 15-min windows using 1-min returns:
- Collect last 180-360 minutes of 1-min returns
- Calculate standard deviation
- Annualize: σ_annual = σ_1min * √(365 * 24 * 60)
```

### Regime Detection (Optional Enhancement)

Track if current volatility is:
- **High regime**: σ > 1.5 * median(σ over last week)
- **Low regime**: σ < 0.5 * median(σ over last week)
- **Normal regime**: otherwise

Adjust behavior:
- High vol: require larger edge to trade
- Low vol: smaller edge acceptable

---

## Integration Points

### Used By
- Strategy 5: Probability Model Directional
- Strategy 6: Market Making Hybrid
- Strategy 1: Spot-Market Divergence (for spot-implied probability)

### Dependencies
- Spot price client (for current price and historical prices)
- Window definitions (for strike and timing)
- Database (for caching volatility calculations)

---

## Configuration

```javascript
// config/default.js
module.exports = {
  windowTiming: {
    volatility: {
      lookbackMinutes: {
        '15min': 240,  // 4 hours
        '1hour': 720,  // 12 hours
        '4hour': 2880  // 2 days
      },
      updateFrequency: 60000, // Recalculate every minute
      regimeThresholds: {
        high: 1.5,
        low: 0.5
      }
    },
    probability: {
      riskFreeRate: 0 // Negligible for short windows
    }
  }
};
```

---

## Testing

### Unit Tests
- Black-Scholes calculation matches known values
- Volatility scaling is correct for different timeframes
- Edge cases: τ → 0, S = K, extreme volatility

### Integration Tests
- Probability updates correctly as time passes
- Volatility estimate is stable (not jumping erratically)
- Output matches expected values for historical windows

---

## Notes

### Time Decay
As τ → 0, probability becomes more binary:
- If S > K: P(UP) → 1
- If S < K: P(UP) → 0
- If S ≈ K: P(UP) remains uncertain

This is correct behavior - certainty increases as expiry approaches.

### Limitations of Black-Scholes
- Assumes log-normal returns (crypto has fat tails)
- Assumes constant volatility (vol is stochastic)
- Assumes continuous trading (windows are discrete events)

These limitations mean our model is approximate. Track calibration: do 60% predictions win 60% of the time?
