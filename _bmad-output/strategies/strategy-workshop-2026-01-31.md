# Strategy Workshop Session - 2026-01-31

## Session Summary

**Participants**: Matthew + Quant Team (Marcus, Vera, Nadia, Theo, Cassandra)

**Goal**: Generate 8-10 trading strategies for poly system

**Outcome**: 6 strategies + 2 shared components

---

## Strategy Division

### Tier 1: Observation/Paper Trading
| # | Strategy | Purpose |
|---|----------|---------|
| 1 | Spot-Market Divergence | Test if spot leads market price |
| 2 | Extreme Price Reversion | Test if extreme prices overshoot |
| 3 | Early Window Signal | Test if early spot direction predicts outcome |
| 4 | Oracle Discrepancy Monitor | Observe if our Oracle model beats market |

### Tier 2: Live Execution
| # | Strategy | Purpose |
|---|----------|---------|
| 5 | Probability Model Directional | Core thesis - our probability model vs market |
| 6 | Market Making Hybrid | Limit order entry when conviction exists |

### Shared Components
| # | Component | Purpose |
|---|-----------|---------|
| 7 | Window Timing Model (Black-Scholes) | Probability as f(time remaining, spot, strike, vol) |
| 8 | Spot Lag Tracker | Quantify lag patterns to improve execution |

---

## Key Decisions

### Capital & Sizing
- Starting capital: $150 USD
- Minimum position size: $2 (exchange minimum ~$1 on exit)
- No daily drawdown limit during testing phase

### Edge Threshold
- TBD from data
- Start with no threshold, collect data, refine from results

### Timeframes
- Primary: 15-minute windows
- Future consideration: 1-hour, 4-hour if 15-min proves viable

### Stop Loss / Take Profit Framework
- **Thesis-based stops**: Exit when model/thesis invalidates
- **Hold to resolution**: For directional strategies with conviction
- **Price-based stops**: For mean reversion strategies

### Market Making Economics (Polymarket)
Three revenue streams for makers:
1. Spread capture
2. Liquidity rewards (daily payouts for orders within max spread)
3. Maker rebates (20% of taker fees redistributed in 15-min crypto markets)

---

## Core Hypotheses

1. **Probability Mispricing**: Market incorrectly calculates probability given spot vs strike
2. **Spot Lag**: Market reacts slowly to underlying spot price movements
3. **Oracle Discrepancy**: We can model Oracle resolution better than market via multi-exchange feeds

---

## Team Review Summary

### Vera (Quant)
- Volatility estimation is critical - use 3-6 hour rolling realized vol for 15-min windows
- Sample sizes: 100-200+ trades minimum for statistical significance
- Edge threshold should exceed estimation error + spread + slippage

### Nadia (Risk)
- No daily drawdown limit during testing (learning > protection)
- Thesis-based stops preferred over arbitrary price stops
- Track correlation between strategies

### Theo (Execution)
- Limit orders earn spread instead of paying it (3c swing per trade)
- Signal-to-fill latency is the bound on exploitable lag
- Market making viable as overlay due to rewards programs

### Cassandra (Skeptic)
- Every strategy has falsifiability criteria
- Observation before execution for unproven theses
- Edge decay is the default assumption

---

## Files Generated

- `strategy-01-spot-market-divergence.md`
- `strategy-02-extreme-price-reversion.md`
- `strategy-03-early-window-signal.md`
- `strategy-04-oracle-discrepancy-monitor.md`
- `strategy-05-probability-model-directional.md`
- `strategy-06-market-making-hybrid.md`
- `component-07-window-timing-model.md`
- `component-08-spot-lag-tracker.md`

---

## Next Steps

1. Build Component 7 (Window Timing Model) and Component 8 (Spot Lag Tracker) as infrastructure
2. Begin observation for Strategies 1-4 (paper trading)
3. Go live with Strategy 5 (Probability Model Directional) at $2 minimum size
4. Add Strategy 6 (MM Hybrid) as enhancement once conviction logic is validated
