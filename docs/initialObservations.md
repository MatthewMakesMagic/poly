# FINDTHEGOLD: Initial Data Observations

**Date:** 2026-02-06
**All times in Eastern (ET/EST, UTC-5)**
**Data window:** RTDS ~30+ hours (Feb 5 00:34 ET onwards), CLOB/L2/Exchange continuous since Feb 5 11:01 PM ET
**Total rows captured:** ~870K+ (rtds 350K+, clob 120K+, L2 351K+, exchange 20K+, oracle 75K+)
**Received_at fix deployed:** Feb 6 ~01:00 ET — all ticks since have ms-precision local receipt timestamps

---

## 1. Feed Identity & Cross-Instrument Resolution (CRITICAL)

### 1a. What Each Feed Actually Is

| Feed | Label in Code | What It Actually Is | Relative Price Level |
|------|--------------|--------------------|--------------------|
| RTDS `crypto_prices` | "Binance-sourced" | **Polymarket reference price** — composite, NOT raw Binance. Avg $0.09 from actual Binance but not identical. | Middle of exchange cluster |
| RTDS `crypto_prices_chainlink` | "Chainlink oracle" | **Chainlink Data Streams** — 16-operator weighted median. Settlement oracle. | $60-100 below exchange cluster |
| `exchange_ticks` (binance) | "Binance" | **Actual Binance spot** — direct exchange feed via exchange-feed-collector. | Top of exchange cluster |
| `exchange_ticks` (coinbase) | "Coinbase" | Actual Coinbase spot. Consistently cheapest exchange. | Tracks near Chainlink |
| `crypto_prices_pyth` | "Pyth" | Pyth Hermes oracle. 0.003% avg divergence from Chainlink. | Tracks Chainlink |

**Price ordering (observed):** Kraken > OKX > Binance > **RTDS crypto_prices** > Bybit > **RTDS chainlink** > Coinbase

### 1b. The Strike and Settlement Use Different Instruments

The market resolution is: **Chainlink_close > Strike ? UP : DOWN**

**Strike source:** Parsed from the market question text (e.g., "Will BTC be above **$66,414.94** at 07:30 UTC?"). Polymarket sets this number at window open. It consistently lands closest to actual Binance ($4-16 off) or RTDS `crypto_prices` ($12-35 off). The Binance klines API is a fallback in our code if question parsing fails. See `window-manager/index.js:parseReferencePrice()`.

| Component | Source | Typical BTC Level |
|-----------|--------|--------------------|
| **Strike** (set at window open) | Parsed from market question. Closest to exchange cluster. | ~$67,420 |
| **Settlement** (at window close) | RTDS `crypto_prices_chainlink` (Chainlink Data Streams) | ~$67,340 |
| **Structural gap at T=0** | | **~$60-100** |

**Structural DOWN bias exists but is small relative to actual moves.** The ~$80 gap means BTC must rise ~$80 for UP to break even if all else is flat. But BTC typically moves $100-400 during a 15-minute window, so the bias is a thumb on the scale, not a broken scale. Observed margins (CL vs strike) range from +$398 to -$301 — the $80 offset is <25% of typical absolute margins. CLOB participants clearly price this in.

### 1c. Implications For All Analysis

1. **Never call RTDS `crypto_prices` "Binance"** — it's the Polymarket reference price
2. **Always use actual strike from `window_close_events`** — not computed from any feed
3. **The "threshold crossing" that matters is Chainlink-close vs Strike** — not any feed vs its own open
4. **The structural DOWN bias must be accounted for** — CLOB participants are pricing this in

### 1d. The Exchange-Cluster to Chainlink Offset Is Structural

Across 1,392 paired minutes (~23 hours), RTDS `crypto_prices` was higher than Chainlink **100% of the time**.

| Metric | Value |
|--------|-------|
| Average offset | ~$80-100 |
| Std dev | ~$10-20 |
| Range within a window | $67-$97 swing |

This is the expected result of Chainlink aggregating across 16 oracle operators using a weighted median of multiple exchanges including Coinbase (which is consistently $60-80 cheaper than the exchange cluster top). The offset is structural but NOT stable within a window — it swings by $67-97 during a single 15-minute period.

## 2. Oracle Update "Gaps" Are a Data Artefact

The `oracle_updates` table showed apparent gaps of up to 140 seconds. Investigation revealed these are **not feed outages**. The Chainlink RTDS feed (`crypto_prices_chainlink` topic) streams continuously every second. The `oracle_updates` table uses a deviation threshold filter (0.001%) and only writes a row when price moves enough. During quiet periods the price ticks but doesn't change enough to trigger a write.

**Conclusion:** There are no meaningful oracle feed gaps. The feed is continuous.

## 3. Definitive Lag Measurement: Chainlink 878ms Behind Polymarket Reference

### 3a. Pre-Fix Observations (whole-second timestamps only)

Two volatility events on Feb 5 showed clear lag at whole-second resolution (RTDS `crypto_prices` vs `crypto_prices_chainlink`):

**Event A: $100 spike at 4:40:17 AM ET (Feb 5)**
```
:16  Binance 71,550  Chainlink 71,428  spread $122  (normal)
:17  Binance 71,650  Chainlink 71,440  spread $210  <- Binance +$100, Chainlink +$12
:18  Binance 71,660  Chainlink 71,513  spread $148  <- Chainlink catches up +$73
:19  Binance 71,659  Chainlink 71,536  spread $122  <- normalized
```

**Event B: $48 drop at 4:41:05 AM ET (Feb 5)**
```
:04  Binance 71,629  Chainlink 71,498  spread $131  (normal)
:05  Binance 71,581  Chainlink 71,497  spread  $84  <- Binance -$48, Chainlink -$1
:06  Binance 71,574  Chainlink 71,456  spread $119  <- Chainlink catches up -$41
:07  Binance 71,570  Chainlink 71,446  spread $124  <- normalizing
```

### 3b. Definitive Results (received_at ms-precision, 22,325 paired seconds)

After deploying the `received_at` fix, we measured Chainlink receipt lag relative to the Polymarket reference stream (`crypto_prices`) across ~5.5 hours of continuous data:

| Metric | Value |
|--------|-------|
| **Average lag** | **878ms** |
| Median lag | 853ms |
| Std deviation | 312ms |
| P95 lag | 1,304ms |
| P99 lag | 1,552ms |
| Max lag | 2,899ms |
| Min lag | -224ms (rare Binance-later) |
| Chainlink later | 99.94% (22,312 / 22,325 seconds) |
| Binance later | 0.06% (13 seconds) |

### 3c. Lag Is Constant Across Volatility Regimes

This is a critical finding. The lag does NOT increase during volatile periods — it's infrastructure/aggregation latency, not a reaction-time effect:

| Regime | Seconds | Avg Lag | Max Lag | P95 Lag |
|--------|---------|---------|---------|---------|
| Calm (<$5/sec) | 18,947 | 879ms | 2,899ms | 1,307ms |
| Normal ($5-20) | 2,914 | 876ms | 2,528ms | 1,274ms |
| Volatile ($20-50) | 382 | 872ms | 2,043ms | 1,344ms |
| Spike (>$50) | 69 | 859ms | 1,478ms | 1,314ms |

**This makes the lag predictable.** You don't need to estimate whether lag will be long enough during a move — it's always ~850ms.

### 3d. Lag Does NOT Worsen Near Window Close

Measured lag in the final 10 seconds, final 60 seconds, and rest of each window:

| Period | Avg Lag | Median | P95 | Max |
|--------|---------|--------|-----|-----|
| Final 10s | 850-1020ms | 832-995ms | 958-1349ms | 984-1349ms |
| Final 60s | 848-923ms | 836-935ms | 1217-1330ms | 1521-1576ms |
| Rest of window | 878-889ms | 846-873ms | 1294-1353ms | 1689-2064ms |

No systematic worsening near close. The lag is a stable ~850-1000ms throughout.

## 4. The Signature Event: $73 Drop With Full CLOB Coverage

At 11:48:40 PM ET on Feb 5 we captured a $73/sec Binance drop with simultaneous CLOB, L2, and Chainlink data. This is the clearest picture of the full chain of events:

### 4a. Price Feed Sequence

```
TIME      BINANCE    B_MOVE   CHAINLINK  C_MOVE   SPREAD    CLOB UP-MID  CLOB DN-MID  CLOB SPREAD
11:48:38  64,843     ---      64,772     ---      $71       0.5600       0.4400       $0.01
11:48:39  64,843     flat     64,772     flat     $72       0.5575       0.4425       $0.015
11:48:40  64,770     -$73     64,770     -$1      -$0.11    0.5000       0.5000       $0.04    <<<
11:48:41  64,809     +$39     64,720     -$50     $90       0.4900       0.5100       $0.02
11:48:42  64,809     flat     64,732     +$12     $77       0.4875       0.5125       $0.015
11:48:47  64,818     ---      64,726     ---      $92       0.5050       0.4950       $0.01
11:48:51  64,861     ---      64,768     ---      $93       0.5613       0.4388       $0.0125
11:48:52  64,867     ---      64,783     ---      $84       0.5650       0.4350       $0.01   (recovered)
```

### 4b. What Happened Step by Step

1. **:38-:39 (calm):** Spread normal at $71. CLOB at 56/44 (UP favoured). CLOB spread 1 cent.
2. **:40 (the crash):** Binance drops $73. Chainlink barely moves (-$1). Spread collapses to -$0.11 (Binance briefly below Chainlink). **CLOB instantly reprices to 50/50.** CLOB spread blows to 4 cents.
3. **:41 (the crossover):** Binance bounces +$39 but Chainlink NOW drops -$50 (catching up to where Binance was at :40). CLOB shifts to 49/51 (DOWN slightly favoured).
4. **:42-:47 (recovery):** Binance continues recovering. Chainlink slowly follows. CLOB gradually shifts back toward UP.
5. **:51-:52 (normalized):** Binance at 64,867. CLOB back to 56/44. Full round-trip in ~12 seconds.

### 4c. Key Observations From This Event

**The CLOB reacts to Binance, not the oracle.** The CLOB repriced to 50/50 at :40 when Binance crashed, even though Chainlink hadn't moved. CLOB participants are watching spot, not the settlement feed.

**The Chainlink lag created a crossover at :41.** Binance was bouncing (+$39) but Chainlink was still catching up (-$50). If a 15-minute window had been resolving at :41, the oracle snapshot would have been ~$64,720 — $90 below where Binance sat. A trader watching Binance would know the oracle price is stale-low.

**CLOB spread blew 4x during volatility.** Normal spread: 1 cent. At the crash: 4 cents. This is the cost of immediacy — you pay 4 cents to trade during the chaos instead of 1 cent in calm.

**The tradeable window was ~3-5 seconds.** From :40 (crash) to :43 (CLOB starting to recover), BTC-UP was available at 0.48-0.50 bid. By :52 it was back at 0.56. That's a 12-16% return in 12 seconds — if you could get filled.

### 4d. L2 Order Book Depth

```
TIME      BTC-UP ASK DEPTH   BTC-UP BID DEPTH   NOTE
11:48:37  29,551              27,925              Normal
11:48:39   4,491               8,750              Liquidity pulled BEFORE the crash
11:48:40  16,701              14,055              Partial return
11:48:41  20,854              19,438              Recovering
11:48:49  42,405              36,155              Flood of liquidity post-event
```

**Market makers pulled liquidity at :39 — one second before the crash.** Ask depth dropped from 29,551 to 4,491. This suggests MMs detected the move coming (likely from their own Binance feed) and widened/pulled before the CLOB repriced. By :49 depth surged to 2x normal as participants piled in post-volatility.

## 5. Cross-Exchange Price Structure

Latest snapshot (5 exchanges, 4 cryptos):

| Crypto | Cheapest Exchange | Most Expensive | Cross-Exchange Spread |
|--------|-------------------|----------------|----------------------|
| XRP | Coinbase ($1.269) | Bybit ($1.274) | 0.44% |
| SOL | Coinbase ($76.98) | OKX ($77.11) | 0.17% |
| ETH | Coinbase ($1,901) | Kraken ($1,904) | 0.16% |
| BTC | Coinbase ($64,576) | Bybit ($64,658) | 0.13% |

Coinbase is consistently the cheapest across all pairs. This matters because Coinbase is one of the exchanges in the Chainlink aggregation — it pulls the aggregate lower than Binance.

## 6. Pyth vs Chainlink

| Metric | Value |
|--------|-------|
| Average divergence | 0.003% |
| Max divergence | 0.06% |

Negligible difference. Both oracle feeds track each other closely. No edge between them.

## 7. CLOB Microstructure

| Token | Avg Spread | Median Spread | Max Spread | Avg Mid |
|-------|-----------|---------------|------------|---------|
| XRP-UP/DOWN | 1.6 cents | 1 cent | 8 cents | 0.50 |
| SOL-UP/DOWN | 1.5 cents | 1 cent | 43 cents | 0.49-0.51 |
| ETH-UP/DOWN | 1.2 cents | 1 cent | 6 cents | 0.47-0.53 |
| BTC-UP/DOWN | 1.1 cents | 1 cent | 5 cents | 0.46-0.54 |

BTC has the tightest spreads. SOL had a 43-cent blowout (likely a flash event). All tokens median at 1 cent spread.

BTC-UP CLOB mid has only **0.44 correlation** with Chainlink price at second resolution. The CLOB trades on its own dynamics — it's not a mechanical derivative of the oracle feed.

## 8. Data Quality Issues & Fixes

### 8a. RTDS Timestamps — FIXED

All RTDS ticks (Binance, Chainlink, Pyth via RTDS) have source timestamps truncated to whole seconds (ms=0). This is a source limitation — Polymarket's RTDS WebSocket sends integer-second timestamps.

**Fix deployed Feb 6 ~01:00 ET:** Added `received_at TIMESTAMPTZ` column to `rtds_ticks`. `Date.now()` is captured at the top of `handleMessage()` before any parsing, giving ms-precision local receipt timestamps. Migration: `025-rtds-received-at-column`. See Section 3b for the definitive lag results this enabled.

### 8b. Chainlink Only Streaming for BTC

The RTDS feed currently only captures Chainlink prices for BTC. ETH, SOL, and XRP Chainlink feeds are not flowing to `rtds_ticks`. Need to verify RTDS subscription includes all symbols for the `crypto_prices_chainlink` topic.

### 8c. Duplicate Ticks

Every RTDS tick appears twice (identical timestamp, topic, symbol, price). Likely a subscription or broadcast duplication. Not harmful but doubles storage. Could deduplicate on insert.

### 8d. `time_since_previous_ms` in oracle_updates Is Misleading

This field does not match actual timestamp differences. It may represent an upstream metric from the oracle itself rather than time between our recorded observations. Should not be used for gap analysis — use actual timestamp diffs from `rtds_ticks` instead.

## 9. Emerging Thesis

The original FINDTHEGOLD thesis was: "oracle lag creates exploitable windows."

**What the data shows so far:**
- There IS lag (1-2 seconds on sharp moves)
- The CLOB reacts to Binance faster than the oracle settles
- Market makers are even faster — they pull liquidity *before* the CLOB reprices
- The tradeable window is 3-5 seconds with 4x normal spread cost
- The potential return (12-16% on a 12-second round-trip) dwarfs the spread cost

**What we need to validate:**
1. **Sub-second timing** (Section 8a fix) — is the lag 200ms or 1800ms?
2. **Fill probability** — can you actually get filled at the wide-spread prices during chaos?
3. **Frequency** — how often do $50+ single-second moves occur?
4. **Window boundary alignment** — do these moves happen near 15-minute window closes, where oracle lag affects resolution?
5. **Multi-asset coverage** — does the pattern hold for ETH/SOL/XRP?

## 10. Window Close Behavior (6 windows captured)

### 10a. Markets Decide Early, Stay Decided

All 6 captured window closes were already firmly directional by T-30 seconds. No window flipped in the final 30 seconds. Mid prices at close:

| Window Close (ET) | Direction | UP-mid at T-30 | UP-mid at T-1 | Movement |
|-------------------|-----------|----------------|---------------|----------|
| 11:15 PM | UP | 0.745 | 0.728 | Gentle drift down |
| 11:30 PM | UP | 0.742 | 0.742 | Dead flat |
| 11:45 PM | DOWN | 0.255 | 0.243 | Late push into DOWN |
| 12:00 AM | UP | 0.737 | 0.737 | Flat |
| 12:15 AM | UP | 0.727 | 0.717 | Gradual drift |
| 12:30 AM | DOWN | 0.265 | 0.238 | Active price discovery |

### 10b. Spreads Widen Near Close

CLOB spreads systematically increase in the final seconds:

| Window (ET) | Normal Spread | Final 5s Spread | Note |
|-------------|--------------|-----------------|------|
| 11:15 PM | 1 cent | 1 cent | Orderly |
| 11:30 PM | 1 cent | 1 cent | Dead calm |
| 11:45 PM | 0.7 cents | **3 cents** | 4x blowout at T-4 |
| 12:00 AM | 1 cent | 1 cent | Orderly |
| 12:15 AM | 1 cent | **3 cents** | Widened at T-26, stayed 3c for 25s |
| 12:30 AM | varies | **3 cents** | Choppy throughout |

Half the windows showed 3x spread widening near close. Market makers are pricing in uncertainty about the final oracle snapshot.

### 10c. The Opportunity: Wide Spreads + Decided Outcome

The 12:15 AM close is the textbook case:
- From T-26 to T-1 (25 seconds), spread was 3 cents
- UP-mid was steady at 0.717 the entire time
- The outcome was clearly decided (UP winning), yet MMs were charging 3x normal spread

If you know the oracle confirms the direction (from watching the aggregate feed with 1-2s advantage), you can:
- Buy the winning side at 0.72 ask during the wide-spread window
- Collect 1.00 at resolution
- That's 28 cents of edge minus 3 cents of spread cost = **25 cents profit per token**

The wide spread near close is MMs hedging against a last-second oracle surprise. An oracle-informed trader would know there's no surprise coming.

### 10d. 05:30: Active Price Discovery Example

The most volatile close showed continuous repricing:
```
T-30s  UP=0.265  (uncertainty)
T-23s  UP=0.240  (DOWN gaining confidence)
T-19s  UP=0.250  (pullback)
T-14s  UP=0.230  (DOWN pushing hard)
T-10s  UP=0.240  (another pullback)
T- 7s  UP=0.231  (final push down)
T- 1s  UP=0.238  (settled)
```

3.5 cents of range in the final 30 seconds. This kind of volatility near close means there are both informed and uninformed participants still actively trading. The informed edge from oracle lag would be most valuable in these contested closes.

## 11. Final-Seconds CLOB Behavior (20-Window Study)

### 11a. Last-Second Flip: 07:30 ET

Of 20 windows analyzed, **1 had a genuine last-second upset**:

```
07:30 ET window:
  T-30s  UP = 0.155  (DOWN dominant)
  T-16s  UP = 0.625  (massive swing to UP)
  T-3s   UP = 0.665  (UP dominant)
  T-0s   UP = 0.385  (FLIPPED BACK TO DOWN)
```

CLOB mid was above 0.50 at T-3s (signalling UP) but the final settlement was DOWN. This is the exact scenario where our 878ms oracle advantage matters — if Binance showed a late move crossing the threshold, we'd know the CLOB was wrong while market participants were still pricing the old direction.

### 11b. Massive Late-Window Repricing Events

Two windows showed enormous CLOB range in the final 30 seconds:

| Window | CLOB Range (30s) | What Happened |
|--------|-----------------|---------------|
| 05:15 ET | **0.95** (0.01 → 0.96) | Total reversal — market went from "certainly DOWN" to "certainly UP" in 30 seconds |
| 06:15 ET | **0.805** (0.74 → 0.01) | Collapse — market went from "probably UP" to "certainly DOWN" |
| 07:30 ET | **0.52** (0.155 → 0.665 → 0.385) | Whipsaw — swung through UP and back to DOWN |

These are not calm, decided closes. They represent contested final seconds where oracle-informed positioning would be enormously valuable.

### 11c. Typical Pattern: 18/20 Windows Firmly Decided

The other 18 windows showed the expected pattern — CLOB settled well before close:
- Range typically 0.49-0.61 (just the normal bid-ask spread between UP and DOWN tokens)
- Price at T-30s was on the same side of 0.50 as the final close
- No meaningful last-second movement

### 11d. Summary: ~10-15% of Windows Are Contested

3 of 20 windows (15%) showed significant last-30s volatility. 1 of 20 (5%) had an actual last-second flip. This means roughly every 1-2 hours there's a window close worth trading around, and roughly once every 5 hours there's a flip that an oracle-informed engine would catch.

## 12. The Cross-Instrument Information Asymmetry (07:30 ET Deep Dive)

The 07:30 ET window reveals a structural edge distinct from lag:

### 12a. What CLOB Participants Were Seeing

```
07:29:53  Polymarket ref:  $66,414.41  (just $0.53 below strike!)
07:29:53  CLOB UP-mid:     0.5875      (pricing as likely UP)
```

The Polymarket reference price was **fifty-three cents** from the $66,414.94 strike. If you're watching that feed, this looks like a coin flip leaning UP. The CLOB pricing at 0.59 is rational given the ref price.

### 12b. What the Settlement Oracle Was Showing

```
07:29:53  Chainlink:       $66,323.65  ($91.29 below strike)
07:29:53  Deficit needed:  $91.29
07:29:53  Biggest CL single-tick up-move ever observed: $82.79
```

Chainlink was $91 below strike. The biggest single Chainlink up-move in the entire dataset ($82.79) wouldn't have been enough to bridge the gap. A late update couldn't have flipped this — the deficit was literally unprecedented to overcome in one tick.

### 12c. The Asymmetry

CLOB participants are rationally pricing off the Polymarket reference stream (near strike). But the market resolves on Chainlink (consistently ~$80-100 lower). When the ref is near the strike, the CLOB prices ~50/50 — but the Chainlink resolution is almost certainly DOWN because it needs the ref to be ~$80 *above* the strike for Chainlink to cross it.

This is not irrational behaviour from CLOB participants. It's a structural information asymmetry: knowing which instrument settles the market, and the persistent offset between that instrument and the price feed most participants are watching.

## 13. Potential Edge Categories

Multiple distinct strategies emerge from the data. Each targets a different market dynamic and may work independently or in combination. More data and backtesting is needed to validate each.

### Edge A: Lag-Based (Mid-Window Volatility)
- **Mechanic:** Chainlink lags the Polymarket reference by 878ms (median 853ms, P95 1,304ms). Sharp spot moves create temporary CLOB dislocations.
- **Example:** $73 drop → BTC-UP drops to 0.48, recovers to 0.56 in 12s. $125 spike at 06:37 ET → CLOB moved 0.655 → 0.703, L2 depth dropped 70%.
- **Window:** 3-5 seconds of CLOB dislocation after a sharp move
- **Potential:** ~$450 on $4,000 position (12% return)
- **Frequency:** Multiple $50+ moves per hour
- **Key risk:** MMs pull liquidity ~1 second after the spike. Requires sub-200ms execution to beat them.

### Edge B: Lag-Based (Near-Close Timing)
- **Mechanic:** 878ms oracle lag gives advance knowledge of settlement direction at window close
- **Example:** 15% of windows have contested final 30 seconds; 5% have actual last-second flips
- **Window:** Final seconds before window close, when the CLOB is still adjusting
- **Potential:** 25-65 cents/token on flipped outcomes; 5-10 cents on wide-spread decided outcomes
- **Frequency:** ~3 contested closes per 20 windows; ~1 flip per 20 windows
- **Key risk:** Spread cost (3-4c) and fill probability during chaotic close

### Edge C: Cross-Instrument Information Asymmetry (Section 12)
- **Mechanic:** The strike is set from the exchange cluster (~Binance level), but settlement uses Chainlink (~$80-100 lower). When the ref price is near the strike, the CLOB prices ~50/50, but the Chainlink outcome is heavily DOWN-biased. The reverse is also true: when ref is moderately above the strike, the CLOB may price confident UP, but if it's not $80+ above, Chainlink is still below.
- **Example:** 07:30 ET — ref was $0.53 below strike, CLOB at 0.59 (UP), but Chainlink was $91 below strike. DOWN was never in doubt for an informed observer.
- **Window:** Any time the ref price is within ~$80 of the strike, the CLOB may be systematically mispricing relative to actual settlement probability
- **Potential:** Selling overpriced UP tokens (or buying underpriced DOWN) when ref is near/below strike
- **Frequency:** Needs quantification — depends on how often ref hovers near the strike
- **Key risk:** The structural offset is not perfectly stable (ranges $60-100 within a window). Needs a probabilistic model that accounts for offset variance, not a binary threshold.

### Edge D: Probabilistic Modelling
- **Mechanic:** Build a model that ingests all feeds (exchange cluster, Chainlink, Pyth, CLOB prices, L2 depth) and outputs a settlement probability superior to the CLOB's implied probability.
- **Inputs:** Strike, current Chainlink price, current ref price, Chainlink-ref offset distribution, time remaining, recent volatility, L2 depth
- **Advantage over CLOB:** Our model knows the settlement instrument (Chainlink) and its offset distribution. Most CLOB participants appear to be pricing off the ref stream.
- **Potential:** Systematic edge on every window where our model diverges materially from CLOB pricing
- **Frequency:** Potentially every window, not just contested ones
- **Key risk:** Model risk, parameter estimation, assumes CLOB participants don't learn the same edge

### Execution Speed Assessment

Can an execution engine beat the ~1-second MM liquidity pull?

**Yes, with reasonable architecture.** The chain of events:
1. Exchange/ref price moves (T=0) — detected via direct exchange feeds or RTDS `crypto_prices`
2. Our engine receives it (~5-20ms network latency)
3. Signal computation: compare to actual strike, current Chainlink level, offset distribution (~1-5ms)
4. CLOB order submission (~10-50ms API round-trip)
5. **Total: ~50-100ms from price move**

The MMs pull liquidity ~1000ms after the spot move (from L2 data in Section 4d). That gives a **~900ms window** to submit orders.

Key nuance: **not all edges need sub-second execution.** Edge C (information asymmetry) may persist for minutes when the ref is near the strike. Edge D (probabilistic model) could generate signals well before close. Only Edges A and B require racing the lag.

### What We Need Next

1. **More data.** The current dataset covers ~30 hours. Need days/weeks to build statistically meaningful distributions of offset behaviour, CLOB pricing patterns, and outcome frequencies.
2. **Backtest infrastructure.** Simulate each edge type against historical windows to measure theoretical PnL, win rate, and max drawdown.
3. **Offset distribution model.** Characterize the Chainlink-to-strike gap: mean, variance, autocorrelation, relationship to volatility regime. This underpins Edges C and D.
4. **CLOB fill probability analysis.** How often can you actually get filled at the prices we observe? What's the slippage? Need to compare available depth to realistic position sizes.
5. **Multi-asset expansion.** Current analysis is BTC-only. ETH/SOL/XRP may have different offset characteristics, different CLOB liquidity, and different edge profiles.

### Open Questions

1. **Strike source precision:** Strike is parsed from market question text (e.g., "$66,414.94"). Polymarket sets this value — it lands $4-16 from Binance and $12-35 from RTDS `crypto_prices`. The exact source Polymarket uses internally is unknown but is clearly in the exchange cluster, not the Chainlink level.
2. **Structural DOWN bias magnitude:** The ~$80 offset creates a DOWN tilt but is small relative to 15-min BTC moves ($100-400). Observed outcomes show a healthy mix of UP and DOWN. Need more data to quantify the actual bias in outcome frequencies.
3. **CLOB participant sophistication:** Are CLOB MMs already accounting for the Chainlink offset? If so, the information asymmetry edge (C) may be smaller than it appears. If not, it's wide open.

---

*Last updated: Feb 6, 2026. Data collection ongoing. Feed identity clarified — all future analysis uses correct instrument labels.*
