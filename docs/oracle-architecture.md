# Oracle Architecture & VWAP Discovery

## Date: 2026-02-09

## Key Discovery: Chainlink is VWAP, Not Spot

The settlement oracle (Chainlink Data Streams) is NOT a simple median of exchange spot prices.
It uses a 3-layer aggregation:

1. **Raw exchange data** from ~16+ centralized exchanges (Binance, Coinbase, Kraken, and many more) + decentralized exchanges
2. **Premium data aggregators** (CoinMarketCap, CoinGecko, Tiingo) compute **VWAP** — volume-weighted average price — with outlier filtering, wash trade removal, and market depth adjustments
3. **16 Chainlink nodes** each take the median of multiple aggregators, then the network takes the median of all 16 nodes

Sources:
- https://blog.chain.link/levels-of-data-aggregation-in-chainlink-price-feeds/
- https://data.chain.link/streams/btc-usd-cexprice-streams

## Transfer Function (Empirically Measured)

When exchange prices (PolyRef) move $X in 3 seconds, Chainlink absorbs:
- **+1s: 41%** of the move (median), 44% (mean)
- **+2s: 53%** of the move
- **+3s: 65%** of the move
- **+5s: 77%** of the move

This is consistent with **exponential smoothing / rolling VWAP** with:
- Half-life: ~2 seconds
- 90% capture: ~8 seconds
- 95% capture: ~12 seconds

The VWAP window appears to be on the order of **5-10 seconds**, NOT minutes.

## Structural Gap: Oracle Below Exchange Spot

| Metric | Value |
|--------|-------|
| Median gap (CL below PolyRef) | ~$150 |
| Range | $88 - $199 |
| In crash event windows | $30 - $95 (varies by BTC price level) |

The gap is persistent because VWAP always lags spot price in trending markets.

## Oracle Update Characteristics

| Feed | Tick interval | Price change / tick | Unchanged ticks |
|------|--------------|--------------------|----|
| Chainlink | 1.0s (median) | $0.00 (median), $13.93 (p95) | 50% |
| Pyth | <0.5s (sub-second) | $1.11 (median), $11.29 (p95) | 24% |
| PolyRef | 1.0s (median) | $0.00 (median), $18.03 (p95) | 58% |

Pyth updates most frequently and has the most price changes per tick.
Chainlink and PolyRef emit unchanged ticks ~50-58% of the time.

## Pyth vs Chainlink: NOT a Leading Indicator

Pyth and Chainlink move **simultaneously** (within 0-3 seconds):
- Pyth leads CL by avg **0.3s** across 11 crash events
- Both use similar VWAP methodology from similar data sources
- Neither leads the CLOB — CLOB leads both by ~5s

## CLOB Leads Oracle by ~5 Seconds

In 11 crash/flip events:
- **CLOB leads Chainlink by avg 5.4s**
- **CLOB leads Pyth by avg 5.1s**
- MMs predict the VWAP before it's published, using raw exchange data

## Late-Window Crash Event Analysis

### DOWN Resolutions (6 events)

| Window | Binance at T-0 | CLOB first DOWN | Exchange first DOWN |
|--------|---------------|-----------------|-------------------|
| 1770462900 | +$9 (UP) | T-30s | Never |
| 1770462000 | -$10 (T-1s only) | T-15s | T-1s |
| 1770459300 | +$38 (UP!) | T-6s | Never |
| 1770453000 | +$71 (UP!) | T-6s | Never |
| 1770411600 | +$39 (UP!) | T-26s | Never |
| 1770375600 | +$54 (UP!) | T-15s | Never |

In 5/6 DOWN resolutions, **no exchange we capture EVER crosses below CL@open**.
The oracle is being pulled down by the ~11 exchanges we don't capture.

### UP Resolutions (5 events)

| Window | Binance leads CLOB by | CLOB reacts at |
|--------|----------------------|----------------|
| 1770457500 | 4s | T-26s |
| 1770448500 | 23s | T-7s |
| 1770373800 | 12s | T-18s |
| 1770372000 | 25s | T-5s |
| 1770361200 | 18s | T-6s |

For UP resolutions, Binance leads CLOB by 4-25 seconds.
The CLOB follows Chainlink direction, not Binance direction.

### Exchange-Level Detail

Among our 5 exchanges:
- **Coinbase** and **Kraken** track closest to the oracle (consistently $20-40 lower than Binance/OKX/Bybit)
- In DOWN crashes: Coinbase crosses below CL@open in 4/6 cases
- In DOWN crashes: Kraken almost never crosses

The oracle appears to weight volume from lower-priced venues more heavily (consistent with VWAP mechanics where higher-volume venues with lower prices pull the average down).

## Chainlink Data Provider Architecture (Researched 2026-02-13)

### Confirmed Data Aggregators Feeding Chainlink Nodes:
- **BraveNewCoin** — uses order book VWAP (bid/ask depth weighted), NOT trade VWAP. 1-100 updates/sec.
- **CoinGecko** — VWAP from top 600 tickers, MAD outlier detection, 1000+ exchanges
- **CoinMarketCap** — volume-weighted average across market pairs, 24hr volume weighting
- **Tiingo** — both data provider AND one of the 16 BTC/USD Data Stream node operators

### 16 BTC/USD Data Stream Nodes:
Chainlayer, Chainlink Labs, Galaxy, DexTrac, Fiews, Inotel, LinkForest, LinkPool,
LinkRiver, NewRoad, Pier Two, SimplyVC, SnzPool, Syncnode, ValidationCloud, Tiingo

### Key Insight: "VWAP" = Cross-Exchange Volume Weighting, Not Time-Windowed
BraveNewCoin computes **instantaneous order book depth VWAP** — weighting by liquidity at a point in time, NOT a rolling window of past trades. This means the "smoothing half-life of ~2s" we measured is **propagation delay through the 3-layer median architecture**, not an inherent time window.

Sources:
- https://bravenewcoin.com/wp-content/uploads/2023/11/bnc_high_frequency_pricing_methodology.pdf
- https://www.coingecko.com/en/methodology
- https://support.coinmarketcap.com/hc/en-us/articles/360015968632
- https://data.chain.link/streams/btc-usd-cexprice-streams

## VWAP Predictor Results (2026-02-13) — CLOSED

### Calibration Results (21 exchanges, 160 BTC windows)

**Direction prediction accuracy by CL move magnitude:**

| CL Move Bucket | Windows | Accuracy | Avg Prediction Error |
|---|---|---|---|
| < $25 | 20 | 55% | $47 |
| $25-$50 | 14 | 57% | $51 |
| $50-$100 | 31 | 94% | $47 |
| $100-$200 | 46 | **100%** | $48 |
| $200-$500 | 44 | **100%** | $49 |
| > $500 | 5 | **100%** | $36 |

**The prediction error is ~$47 regardless of CL move size.** When signal (CL move) exceeds noise ($47), accuracy is 100%. When signal < noise, accuracy drops to coin-flip. This is a signal-to-noise limit, not a methodology problem.

### Structural Bias: $46 Constant Gap (Exchange Spot vs CL)

| Metric | At Open | At Close |
|---|---|---|
| Mean bias (exchange - CL) | +$45.78 | +$46.00 |
| Median bias | +$47.75 | +$47.79 |
| P10-P90 | $31-$56 | $31-$56 |

The gap is **constant** — identical at open and close, identical for UP and DOWN windows (+$47 vs +$45). This is NOT a directional VWAP lag. It's the permanent structural difference between our exchange spot median and CL's aggregated price.

**strike_price in window_close_events = Polymarket reference price ≈ exchange spot, NOT CL@open.** The $47 gap applies to both strike and exchange prices vs CL.

### VWAP Lookback Period: Shorter Is Better

| Lookback | Direction Accuracy | Errors on >$100 moves |
|---|---|---|
| **10s (spot)** | **94.1%** | **0** |
| 1min | 90.8% | 0 |
| 5min | 90.2% | 0 |
| 15min | 72.5% | 13 |
| 30min | 65.4% | 26 |
| 1hr | 56.9% | 35 |

**Longer lookback destroys accuracy.** CL does NOT use a long VWAP window. Best match is at 10-30 seconds, confirming the transfer function measurements.

### Tradeability of Large-Move Windows: CLOB Is Efficiently Priced

For the 95 windows with |CL move| > $100 (100% direction accuracy):

| Time Before Close | Avg CLOB Price (correct side) | % Below $0.85 |
|---|---|---|
| T-5min | $0.860 (median $0.925) | 31.6% |
| T-2min | $0.952 | 7.8% |
| **T-60s** | **$0.970** | **0%** |
| T-30s | $0.979 | 0% |
| T-10s | $0.982 | 0% |

**By T-60s, zero windows have CLOB < $0.90.** The market is efficiently priced. Predicting direction of large moves has no trading value because the CLOB already knows.

### Conclusion: VWAP Prediction Path Does Not Yield a Tradeable Edge

1. **Large moves (>$100)**: 100% predictable, but CLOB already at $0.97 — no margin
2. **Small moves (<$50)**: ~55% accurate = coin flip — prediction error ($47) exceeds signal
3. **Method doesn't matter**: median, mean, equal-weight, outlier-excluded, oracle-proximity, individual exchanges — all cluster at 89-91%
4. **The $46 structural gap is constant and permanent** — not exploitable for direction
5. **Only potential angle**: T-5min entry on large moves (31.6% of windows have CLOB < $0.85), but requires predicting direction 5 minutes early with confidence

## Flip Detection Analysis (2026-02-13) — NO EXCHANGE LEAD

### Setup
41 "flip events" found in 163 BTC windows — CLOB peaked >80% in the wrong direction but resolution went the other way. 25% of all windows show these reversals.

### Can Our Exchanges Detect Flips Before The CLOB?

| Metric | Result |
|---|---|
| Exchange detects flip (in final 2min) | 32/41 (78%) |
| Exchange NEVER detects flip | 9/41 (22%) |
| **Exchange leads CLOB** | **1/41 (2.4%)** |
| Exchange same time as CLOB | 24/41 |
| Exchange lags CLOB | 3/41 |

**Our exchanges almost never detect the flip before the CLOB.** In 24/41 cases they detect simultaneously; in 3 cases the CLOB is faster. Only 1 event showed exchange leading (by 60s).

### Why Exchanges Can't Detect Small Flips

The $46 structural gap masks small CL moves. Example:
- Window 02-12T06:00:00: CL moves -$0.35 (barely DOWN resolution)
- Exchange median shows +$49 (still far above strike, which ≈ exchange spot at open)
- Neither exchanges, CL, nor CLOB ever show the correct direction — CL just barely nudges below strike at the exact close moment

The 9 "never detects" cases are all CL moves from $0 to -$37 — well within the $46 structural gap.

### Tradeability of Flips Where Detected

For flips where exchange detected at same time as CLOB:
- The CLOB has already repriced by the time we'd act
- Example: 02-12T04:15:00 — exchange flips at T-30s, but CLOB already at $0.78 for correct side (entry at $0.77)
- Typical entry when exchanges flip: $0.50-$0.95, averaging ~$0.60-$0.80

**No information advantage.** The CLOB tracks the same oracle data and reprices as fast or faster than our exchange composite.

### Conclusion

The VWAP/exchange-composite approach to predicting CLOB mispricing is closed:
1. **Large moves**: CLOB correctly prices by T-60s, nothing to exploit
2. **Small moves**: Structural gap prevents detection, effectively coin flips
3. **Flips**: Our exchanges detect at the same time or later than CLOB — no lead time

Any edge must come from a fundamentally different signal source, not from replicating what the CLOB market makers already do with better data and faster infrastructure.

### Diagnostic Scripts

- `diagnose-late-crash.cjs` — finds 11 crash/flip events, shows CLOB + oracle timeline
- `diagnose-exchange-leads-clob.cjs` — all data sources (5 exchanges, PolyRef, Pyth, CL, CLOB) side by side
- `diagnose-pyth-leads-clob.cjs` — Pyth vs CL vs CLOB first-signal timing
- `diagnose-all-exchanges-vs-oracle.cjs` — all 5 exchanges individually vs oracle, with median comparison
- `calibrate-vwap-oracle.cjs` — reverse-engineer CL from exchange VWAP, sweep lag/smoothing/weighting
- `diagnose-prediction-error.cjs` — per-window CL prediction error, bucketed by move magnitude
- `diagnose-close-bias-and-tradeability.cjs` — structural bias investigation + CLOB tradeability analysis
- `diagnose-flip-detection.cjs` — can exchanges detect CLOB reversals before the market?
