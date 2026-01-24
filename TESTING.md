# Polymarket Binary Options - Strategy Testing Framework

## Overview

This document captures the trading theses being tested on Polymarket's 15-minute crypto binary options (BTC, ETH, SOL, XRP). Each window, users bet whether the crypto price will be UP or DOWN relative to the strike price set at window start.

**Key Market Characteristics:**
- 15-minute windows, $1 or $0 binary payout
- Market makers provide liquidity (bid/ask spreads of 1-5%)
- Market prices are extremely "sticky" - rarely move mid-window
- Binary resolution at expiry is the only reliable "exit"

---

## Thesis 1: Spot Lag (SpotLag Strategies)

### Hypothesis
Market prices lag behind spot movements. When spot moves, there's a delay before market makers update quotes, creating a brief arbitrage opportunity.

### Original Expectation
Enter when spot moves, exit when market catches up (within 5-30 seconds).

### Actual Finding
**Market NEVER catches up mid-window.** Analysis of 30+ windows showed 0 instances of market probability adjusting to match spot position. The market only "resolves" at binary expiry.

### Why It Still Works
The edge comes from **mispricing**, not timing:
- When spot is above strike but market prob < 45% → Buy UP
- Win rate: 67-73% when mispriced vs 48-50% when correctly priced
- Spot at entry tends to persist to expiry (76-86% of the time)

### Strategies Testing This
| Strategy | Parameters | Purpose |
|----------|------------|---------|
| SpotLagSimple | 0.05% spot move, 10 tick lookback | Base case |
| SpotLag_Fast | 0.03% spot move, 5 tick lookback | More responsive |
| SpotLag_Confirmed | 0.08% spot move, 15 tick lookback | Higher confidence |
| SpotLag_Aggressive | 0.02% spot move, 8 tick lookback | More trades |
| SpotLag_5sec | 5s holding period | Test if market catches up fast |
| SpotLag_10sec | 10s holding period | Test short-term catch-up |
| SpotLag_30sec | 30s holding period | Test medium-term |
| SpotLag_60sec | 60s holding period | Test 1-minute |
| SpotLag_120sec | 120s holding period | Test 2-minute |
| SpotLag_300sec | 300s holding period | Test 5-minute |

### Key Metrics to Track
- Average holding time (expect ~500s if market never catches up)
- Exit reason distribution (expect mostly "window_expiry")
- Win rate by entry mispricing magnitude

---

## Thesis 2: Mispricing Only (MispricingOnly Strategies)

### Hypothesis
The edge comes purely from **mispricing detection**, not from detecting "lag" in market reaction. We should filter for clear mispricings where market probability is demonstrably wrong given spot position.

### Entry Logic
- Spot > strike by X% AND market prob < Y% → Buy UP
- Spot < strike by X% AND market prob > (100-Y)% → Buy DOWN

### Expected Outcome
Higher win rate than SpotLag by being more selective about entries.

### Strategies Testing This
| Strategy | Spot Threshold | Market Mispricing | Purpose |
|----------|---------------|-------------------|---------|
| MispricingOnly | 0.1% | >10% wrong | Base filter |
| Mispricing_Strict | 0.1% | >15% wrong | Only clear mispricings |
| Mispricing_Loose | 0.05% | >5% wrong | More trades |
| Mispricing_Extreme | 0.2% | >25% wrong | Only massive mispricings |

### Key Metrics to Track
- Win rate vs SpotLag strategies
- Trade frequency (Strict should have fewer, higher-quality trades)
- Average PnL per trade

---

## Thesis 3: Fair Value / Black-Scholes (FairValue Strategies)

### Hypothesis
Market occasionally misprices probability relative to theoretical fair value calculated using Black-Scholes:
```
P(UP) = Φ((ln(S/K) + (μ - σ²/2)t) / (σ√t))
```

### Critical Finding
**UP bets are profitable, DOWN bets lose money:**

| Side | Win Rate | PnL |
|------|----------|-----|
| UP | 51.2% | +$5,000+ |
| DOWN | 24.8% | -$1,000+ |

### Why The Asymmetry?
1. **Crypto has positive drift** - prices tend to go up over time
2. **Black-Scholes assumes drift=0** - underestimates UP probability
3. **XRP is extreme**: 76% win rate on UP, 4% on DOWN

### The Real Edge: Asymmetric Risk/Reward
| Entry Price | Win Rate | Risk/Reward |
|-------------|----------|-------------|
| 0-20% | 14.5% | 9:1 (Win $90 / Lose $10) |
| 20-35% | 33.9% | 2.6:1 |
| 35-50% | 55.5% | 1.4:1 |
| 50-65% | 40.0% | 0.7:1 (unfavorable) |

Even 14.5% win rate is profitable when risk/reward is 9:1!

### Strategies Testing This
| Strategy | Vol Type | Notes |
|----------|----------|-------|
| FairValue_RealizedVol | 30-tick realized | Standard |
| FairValue_EWMA | EWMA | More responsive |
| FairValue_WithDrift | Realized + spot momentum | Original drift attempt |

### Key Metrics to Track
- Win rate by side (UP vs DOWN)
- Win rate by entry price bucket
- PnL by crypto (XRP should dominate)

---

## Thesis 4: Drift-Aware Fair Value (FV_Drift Strategies)

### Hypothesis
Instead of assuming drift=0 in Black-Scholes, measure actual crypto drift over recent history and:
1. Use it in the fair value calculation
2. Only trade in the direction of measured drift

### Mathematical Reality Check
For 15-minute windows, drift has minimal impact on Black-Scholes math:
```
Drift term:  μ × t = 1.0 × 0.0000285 = 0.00003
Vol term:    σ × √t = 0.8 × 0.0053 = 0.0043

Volatility is 150x larger than drift!
```

**Drift matters more as a directional FILTER than a math input.**

### Drift Thresholds (Meaningful for Crypto)
| Timeframe | Threshold | Rationale |
|-----------|-----------|-----------|
| 1 hour | 0.3% | Significant hourly move |
| 4 hours | 0.5% | Clear medium-term trend |
| 24 hours | 1.0% | Strong daily direction |

### Strategies Testing This
| Strategy | Lookback | Drift Threshold | Notes |
|----------|----------|-----------------|-------|
| FV_Drift_1H | 1 hour | 0.3% | Short-term momentum |
| FV_Drift_4H | 4 hours | 0.5% | Medium-term trend |
| FV_Drift_24H | 24 hours | 1.0% | Daily direction |
| FV_UpOnly_4H | 4 hours | 0.5% | Only UP bets |

### Key Metrics to Track
- Which drift timeframe has best win rate?
- Does drift alignment improve over base FairValue?
- Is UP-only better than bidirectional?

---

## Thesis 5: Endgame (Endgame Strategies)

### Hypothesis
In the final seconds of a window, when outcome is nearly certain (>90% probability), buy the favorite. Small edge but high certainty.

### Risk Profile
- Entry at 90%: Win $10, Lose $90 → Need >90% win rate to profit
- Entry at 95%: Win $5, Lose $95 → Need >95% win rate
- Entry at 97%: Win $3, Lose $97 → Need >97% win rate

### Strategies Testing This
| Strategy | Min Prob | Time Window | Risk Level |
|----------|----------|-------------|------------|
| Endgame | 90% | Last 60s | Moderate |
| Endgame_Conservative | 95% | Last 30s | Lower |
| Endgame_Aggressive | 85% | Last 90s | Higher |
| Endgame_Safe | 97% | Last 20s | Very Low |
| Endgame_Momentum | 90% | Last 60s | With trend confirmation |

### Current Results
8/8 wins observed (100% win rate, small sample). Entry prices around 85-98%.

### Key Metrics to Track
- Win rate (must exceed entry probability!)
- Average entry price
- Any losses (understand why favorite lost)

---

## Thesis 6: Contrarian (Contrarian Strategies)

### Hypothesis
When spot moves sharply in one direction, **fade the move** - bet it will revert. Backtest showed 55-63% accuracy.

### Rationale
- Short-term spot moves often overshoot
- Mean reversion within 15-minute windows
- Market doesn't price in the mean reversion

### Strategies Testing This
| Strategy | Threshold | Cryptos | Notes |
|----------|-----------|---------|-------|
| Contrarian | 0.05% | All | Base |
| Contrarian_SOL | 0.05% | SOL only | 63% backtest accuracy |
| Contrarian_Scalp | 0.03% | All | More trades |
| Contrarian_Strong | 0.10% | All | Only big moves |

### Key Metrics to Track
- Win rate vs SpotLag (opposite thesis!)
- SOL vs other cryptos
- Performance by spot move magnitude

---

## Thesis 7: Market Microstructure

### Hypothesis
Order flow and spread patterns contain predictive information:
- Large bid size vs ask size imbalance
- Spread widening/narrowing
- Book depth changes

### Data Being Collected
- `up_bid_size`, `up_ask_size`, `down_bid_size`, `down_ask_size`
- `spread`, `spread_pct`
- `up_book_depth`, `down_book_depth`
- Entry/exit depth captured on each trade

### Questions to Answer
- Do MM refresh patterns predict direction?
- Does book imbalance correlate with outcome?
- Does spread predict volatility?

---

## Thesis 8: Cross-Asset (BTC Leads)

### Hypothesis
BTC leads other cryptos (ETH, SOL, XRP). When BTC moves, alts follow with a lag.

### Strategy
When BTC show strong directional move, trade the same direction on alts.

### Key Metrics to Track
- Lead-lag correlation between BTC and alts
- Win rate on alt trades triggered by BTC
- Optimal lag time

---

## Thesis 9: Binance/Chainlink Divergence ⭐ NEW

### Hypothesis
Polymarket resolves binary options using **Chainlink oracle prices**, NOT Binance prices (which traders see on charts). When Binance and Chainlink disagree on direction relative to strike, traders watching Binance charts will be misled.

### Background Discovery (Jan 2026)
- User noticed Polymarket displays prices that differ from resolution prices
- Polymarket uses **Chainlink Data Streams** for resolution
- Binance consistently shows ~0.01-0.06% HIGHER than Chainlink
- This divergence can flip direction when price is near strike

### Initial Data (First 15 minutes of collection)

| Metric | Value | Notes |
|--------|-------|-------|
| BTC Disagreement Rate | **21.9%** | Binance UP but Chainlink DOWN (or vice versa) |
| ETH Disagreement Rate | 0% | Price far enough from strike, both agree |
| SOL Disagreement Rate | 0% | Price far enough from strike, both agree |
| Typical Divergence | 0.01-0.06% | Binance higher than Chainlink |
| Chainlink Staleness | 17-19s avg | Max observed: 34s |

### Live Example Observed (BTC @ 08:50 UTC, Jan 24 2026)

| Source | Price | vs Strike ($89,515) | Signal |
|--------|-------|---------------------|--------|
| Binance | $89,516.00 | +$1.00 | **UP** |
| Chainlink | $89,513.20 | -$1.81 | **DOWN** |

A trader watching Binance sees "UP winning" but resolution (Chainlink) says "DOWN wins."

### When Disagreements Occur
Disagreements happen when price is **very close to strike** (within ~0.05%):
- Small Binance/Chainlink divergence (~$2-3 on BTC) can flip direction
- BTC showed 21.9% of ticks with disagreement in first sample
- ETH/SOL were further from strike, so no disagreements yet

### Potential Trading Strategy
1. **Identify tight windows**: Price within 0.1% of strike
2. **Know Chainlink lags Binance**: Binance is ~0.02-0.05% ahead
3. **Fade the visible move**: If Binance shows UP but you calculate Chainlink is DOWN, bet DOWN
4. **Focus on final minutes**: Divergence increases near expiry (0.031% → 0.044%)

### Data Being Collected (Deployed Jan 24 2026)
New columns in `ticks` table:
- `chainlink_price` - Oracle price from Chainlink on Polygon
- `chainlink_staleness` - Seconds since last Chainlink update
- `chainlink_updated_at` - Timestamp of Chainlink update
- `price_divergence` - Absolute difference (Binance - Chainlink)
- `price_divergence_pct` - Percentage divergence

### Chainlink Contract Addresses (Polygon)
- BTC/USD: `0xc907E116054Ad103354f2D350FD2514433D57F6f`
- ETH/USD: `0xF9680D99D6C9589e2a93a78A04A279e509205945`
- SOL/USD: `0x10C8264C0935b3B9870013e057f330Ff3e9C56dC`
- XRP: **No direct Chainlink feed on Polygon** (may use different resolution)

### Analysis Script
```bash
# Run divergence analysis
node scripts/analyze_divergence.mjs
```

### Key Questions to Answer (REVISIT)
1. **What % of windows have direction disagreements?** Initial: 21.9% for BTC
2. **Does disagreement predict "surprise" resolutions?** Need resolved windows with Chainlink data
3. **Is Chainlink or Binance more predictive of outcome?** Expect Chainlink (it's the resolution source)
4. **How does staleness affect disagreement?** Higher staleness = more divergence?
5. **What's the optimal entry timing?** Final minute shows higher divergence
6. **Can we build a real-time alert for disagreements?** Flag when Binance UP but Chainlink DOWN

### Status: ACTIVELY COLLECTING DATA
- Started: Jan 24, 2026 ~08:50 UTC
- Need: 24-48 hours for statistically meaningful patterns
- Revisit: Run `analyze_divergence.mjs` daily

---

## Data Collection Summary

### Per-Tick Data (ticks table)
- Timestamp, crypto, window_epoch, time_remaining
- Bid/ask prices and sizes for UP and DOWN
- Spot price, price_to_beat, spread
- Book depth
- **NEW (Jan 2026)**: Chainlink oracle prices, staleness, price divergence

### Per-Trade Data (paper_trades table)
- Entry/exit times, prices, spot prices
- Holding time, PnL, outcome, exit reason
- **NEW**: Entry depth (bid_size, ask_size, spread, book_imbalance)
- **NEW**: Spot/market movement during trade

### Per-Window Data (window_summary table)
- OHLC for market probability
- Spot open/close/high/low
- Average spread, bid/ask sizes
- Outcome, final spot vs strike
- Trades executed, total PnL

---

## Key Learnings So Far

### 1. Market is Extremely Sticky
Market probability rarely changes mid-window. Price at entry ≈ price 5 minutes later. The only "movement" is binary resolution at expiry.

### 2. Mispricing is the Edge
Strategies win when market probability is WRONG relative to spot position, not because they detect "lag" that gets corrected.

### 3. Spot Persistence
Where spot is at entry predicts where it will be at expiry 76-86% of the time. Spot position is the dominant signal.

### 4. Asymmetric Entry Pricing
Cheap entries (< 35%) have favorable risk/reward even with low win rates. The Kelly-optimal strategy enters cheap and lets variance work.

### 5. UP Bias in Crypto
All strategies perform better on UP bets. Crypto's positive drift means DOWN bets are swimming upstream.

### 6. XRP is an Outlier
76% win rate on UP, 4% on DOWN. Something about XRP's market structure makes it extremely predictable upward.

---

## Theses to Revisit (Scheduled)

| Thesis | When | What to Check |
|--------|------|---------------|
| **Thesis 9: Chainlink Divergence** | Jan 25-26, 2026 | Run `analyze_divergence.mjs`, check if disagreements predict outcomes |
| Thesis 6: XRP Anomaly | After more diverse market conditions | Does 76% UP hold in down/ranging markets? |

---

## Next Questions to Answer

1. **Which drift timeframe is optimal?** 1H vs 4H vs 24H
2. **Is UP-only strictly better?** Remove DOWN bets entirely?
3. **Why do losing trades lose?** Analyze the 25% of SpotLag losses
4. **When do mispricings occur?** Time of day, after news, specific cryptos?
5. **Can we size positions based on edge magnitude?** Kelly criterion
6. **Do MMs have patterns?** Refresh cycles, quote changes
7. **⭐ Does Binance/Chainlink divergence predict surprise resolutions?** (Thesis 9 - REVISIT after 24-48h)
8. **⭐ Can we build a real-time Chainlink disagreement alert?** Flag trading opportunities
9. **⭐ How does XRP resolve without a Polygon Chainlink feed?** Different oracle source?

---

## How to Run Analysis

```bash
# Connect to database
psql $DATABASE_URL

# Recent performance by strategy
SELECT strategy_name, COUNT(*), SUM(pnl), 
       ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 1) as win_rate
FROM paper_trades 
WHERE exit_time > NOW() - INTERVAL '24 hours'
GROUP BY strategy_name
ORDER BY SUM(pnl) DESC;

# Performance by crypto and side
SELECT crypto, side, COUNT(*), 
       ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 1) as win_rate,
       SUM(pnl)
FROM paper_trades
GROUP BY crypto, side
ORDER BY crypto, side;

# Entry price distribution
SELECT 
    CASE WHEN entry_price < 0.2 THEN '0-20%'
         WHEN entry_price < 0.35 THEN '20-35%'
         WHEN entry_price < 0.5 THEN '35-50%'
         ELSE '50%+' END as bucket,
    COUNT(*), SUM(pnl)
FROM paper_trades
GROUP BY bucket
ORDER BY bucket;
```

---

## Dashboard Access

- **Railway URL**: `https://poly-production-ff76.up.railway.app`
- **WebSocket**: Real-time tick data and strategy signals
- **API Endpoints**:
  - `/api/paper-trades?period=hour` - Historical trades
  - `/api/strategies` - Current strategy performance

---

*Last updated: January 24, 2026*
*Document maintained for sharing with other agents and collaborators.*

---

## Revision Log

| Date | Change |
|------|--------|
| Jan 24, 2026 | Added Thesis 9 (Binance/Chainlink Divergence) - Initial findings: 21.9% BTC disagreement rate |
| Jan 24, 2026 | Added Chainlink data collection (chainlink_price, staleness, divergence columns) |
| Jan 24, 2026 | Added `scripts/analyze_divergence.mjs` for ongoing analysis |
