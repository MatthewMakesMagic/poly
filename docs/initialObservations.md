# FINDTHEGOLD: Initial Data Observations

**Date:** 2026-02-06
**All times in Eastern (ET/EST, UTC-5)**
**Data window:** RTDS ~23 hours (Feb 5 00:34 - Feb 6 00:06 ET), CLOB/L2/Exchange ~65 minutes (Feb 5 11:01 PM - Feb 6 00:06 ET)
**Total rows captured:** ~870K (rtds 350K, clob 120K, L2 351K, exchange 20K, oracle 75K)

---

## 1. The Binance-Chainlink Offset Is Structural, Not Lag

Across 1,392 paired minutes (~23 hours), Binance spot was higher than the Chainlink RTDS feed **100% of the time**.

| Metric | Value |
|--------|-------|
| Average offset | $122.21 (0.19%) |
| Std dev | $23.27 |
| Min offset | $17.99 |
| Max offset | $162.61 |

This is the expected result of Chainlink aggregating across 16 oracle operators using a weighted median of multiple exchanges including Coinbase (which is consistently $60-80 cheaper than Binance). This is **not exploitable lag** — it's the instrument's construction. It's the reason we stream all 5 exchanges: the oracle settlement price is an aggregate, so tracking individual exchange prices alone gives a biased view.

## 2. Oracle Update "Gaps" Are a Data Artefact

The `oracle_updates` table showed apparent gaps of up to 140 seconds. Investigation revealed these are **not feed outages**. The Chainlink RTDS feed (`crypto_prices_chainlink` topic) streams continuously every second. The `oracle_updates` table uses a deviation threshold filter (0.001%) and only writes a row when price moves enough. During quiet periods the price ticks but doesn't change enough to trigger a write.

**Conclusion:** There are no meaningful oracle feed gaps. The feed is continuous.

## 3. Chainlink Lags Binance by 1-2 Seconds on Sharp Moves

Two volatility events on Feb 5 showed clear lag:

### Event A: $100 spike at 4:40:17 AM ET (Feb 5)
```
:16  Binance 71,550  Chainlink 71,428  spread $122  (normal)
:17  Binance 71,650  Chainlink 71,440  spread $210  <- Binance +$100, Chainlink +$12
:18  Binance 71,660  Chainlink 71,513  spread $148  <- Chainlink catches up +$73
:19  Binance 71,659  Chainlink 71,536  spread $122  <- normalized
```

### Event B: $48 drop at 4:41:05 AM ET (Feb 5)
```
:04  Binance 71,629  Chainlink 71,498  spread $131  (normal)
:05  Binance 71,581  Chainlink 71,497  spread  $84  <- Binance -$48, Chainlink -$1
:06  Binance 71,574  Chainlink 71,456  spread $119  <- Chainlink catches up -$41
:07  Binance 71,570  Chainlink 71,446  spread $124  <- normalizing
```

In both cases Chainlink took **1-2 seconds to follow Binance**. The spread temporarily widened/compressed by $40-90 during the lag.

**Limitation:** All RTDS timestamps are truncated to whole seconds (ms=0). The actual lag could be anywhere from ~200ms to ~1.8s. See Section 8 for the fix.

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

## 8. Data Quality Issues & Fixes Needed

### 8a. RTDS Timestamps Lack Sub-Second Precision

All RTDS ticks (Binance, Chainlink, Pyth via RTDS) have timestamps truncated to whole seconds (ms=0). This is a source limitation — Polymarket's RTDS WebSocket sends integer-second timestamps.

**Fix: Add local receipt timestamp.** Capture `Date.now()` at the moment each WebSocket message arrives and store it alongside the source timestamp. This gives ms-precision ordering between Binance and Chainlink messages even when source timestamps are rounded. Schema change:

```sql
ALTER TABLE rtds_ticks ADD COLUMN received_at TIMESTAMPTZ DEFAULT NOW();
```

This would let us measure whether Chainlink lags Binance by 200ms or 1800ms during volatility — the difference between tradeable and not.

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

## 11. Overall Assessment

Two distinct opportunity types are emerging:

### Type A: Mid-Window Volatility Spike (Section 4)
- Sharp spot move creates 3-5 second CLOB dislocation
- Example: $73 drop → BTC-UP drops to 0.48, recovers to 0.56 in 12s
- Potential: ~$450 on $4,000 position (12% return)
- Frequency: Multiple $50+ moves per hour in this data
- Risk: Need to get filled during wide-spread chaos; MMs pull liquidity before the move

### Type B: Late-Window Informed Close (Section 10)
- Oracle-lag gives 1-2s edge on confirmed direction at window close
- Buy decided winner at 0.72 ask, collect 1.00 at resolution
- Potential: 25 cents/token profit on a confirmed outcome
- Frequency: Every 15 minutes (96 windows per day)
- Risk: Spread cost (3c) eats into edge; need to confirm outcome isn't going to flip

### Data Fix Required

**Add `received_at` column to rtds_ticks** to get ms-precision ordering of when Binance vs Chainlink messages arrive. Without this, we can't determine if the 1-2 second lag is actually 200ms (untradeable) or 1800ms (very tradeable). This is the single most important data quality fix.

```sql
ALTER TABLE rtds_ticks ADD COLUMN received_at TIMESTAMPTZ DEFAULT NOW();
```

The tick-logger module should set `received_at = new Date()` at the moment the WebSocket `onmessage` fires, before any processing.

---

*This document will be updated as more data accumulates. The new capture infrastructure needs 24-48 hours to build a statistically meaningful dataset.*
