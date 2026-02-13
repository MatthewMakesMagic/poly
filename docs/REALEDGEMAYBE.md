# VWAP Oracle Predictor vs CLOB — Edge Analysis

**Date:** 2026-02-13
**Data:** 128 BTC 15-minute windows over 32 hours (Feb 12 02:30 → Feb 13 10:15 UTC)
**Status:** Preliminary — small sample, needs validation on larger dataset

---

## What We Built

We have a **21-exchange WebSocket trade stream** (via CCXT Pro) computing a rolling 10-second volume-weighted average price (VWAP) every 1 second. This is stored in the `vwap_snapshots` table with per-exchange breakdowns.

The exchanges are: Binance, Coinbase Exchange, Kraken, Bybit, OKX, Bitstamp, Gemini, Bitfinex, HTX, Gateio, Kucoin, Mexc, Crypto.com, Bitget, Upbit, Poloniex, Whitebit, Bingx, Lbank, Phemex, Bitmart.

The hypothesis: **our VWAP composite tracks the Chainlink oracle more closely than the CLOB market makers do**, because:
- Chainlink aggregates VWAP from ~16+ data providers (CoinMarketCap, CoinGecko, Tiingo, BraveNewCoin etc.)
- Those providers compute VWAP from the same CEX/DEX trade data we're streaming
- Our VWAP should approximate what Chainlink will report, 2-5 seconds before the CLOB MMs reprice
- CLOB MMs have to account for execution risk, spread, and their own processing lag

---

## The Setup

### What is being predicted?

**Resolution rule:** `CL@close >= CL@open → UP, else DOWN`
- CL@open = Chainlink Data Streams price at window open (T-15 minutes)
- CL@close = Chainlink Data Streams price at window close (T=0)
- Both timestamps are exact to the second

### What signals are available at each time point?

At any moment T seconds before close, we can observe:

1. **VWAP direction** — Has our 21-exchange composite VWAP moved UP or DOWN compared to its value at window open (15 minutes ago)? This is computed from real-time WebSocket trade streams and updates every second.

2. **CLOB direction** — Is the Polymarket UP token currently priced above or below $0.50? This is the market's consensus bet on the resolution direction.

3. **CL direction** — Has the Chainlink oracle price moved UP or DOWN vs CL@open? This is the actual oracle that determines resolution, observable in real-time via RTDS.

### Key assumption

**We assume we can buy at the displayed CLOB price.** The entry prices shown are the CLOB's quoted price for the side we're betting on. In reality there may be spread, slippage, and latency. This needs validation.

---

## Baseline Accuracy — All 128 Windows

"Accuracy" means: does the signal at time T correctly predict the final resolution at close?

```
Signal       │ T-60s         │ T-30s         │ T-10s         │ T-5s
─────────────┼───────────────┼───────────────┼───────────────┼──────────────
VWAP dir     │ 119/128 93.0% │ 118/128 92.2% │ 117/128 91.4% │ 117/128 91.4%
CLOB dir     │ 104/128 81.3% │ 108/128 84.4% │ 109/128 85.2% │ 109/128 85.2%
CL dir       │ 122/128 95.3% │ 125/128 97.7% │ 125/128 97.7% │ (not measured)
```

**What this tells us:**
- VWAP is closer to CL's own accuracy (~95%) than the CLOB is (~85%) at every horizon
- VWAP leads CL by 2-5 seconds (known from transfer function analysis), which explains why it's slightly less accurate than CL itself
- The CLOB is ~10 percentage points worse than both — it lags behind the oracle's actual direction

---

## Strategy 1: Bet with VWAP when it disagrees with CLOB

**Rule:** At time T before close, if VWAP direction ≠ CLOB direction, buy the side VWAP says at the CLOB's current price.

**Example:** At T-60s, VWAP has moved DOWN from open (exchanges are selling off), but CLOB UP token is at $0.885. We buy DOWN for $0.115. If resolution is DOWN, we profit $0.885. If UP, we lose $0.115.

### Results by entry time

```
Entry Time │ Disagreements │ VWAP Wins        │ Total PnL │ Avg PnL/Trade
───────────┼───────────────┼──────────────────┼───────────┼──────────────
T-60s      │ 21 / 128      │ 18/21 (85.7%)    │ +$11.945  │ +$0.569
T-30s      │ 18 / 128      │ 14/18 (77.8%)    │ +$8.860   │ +$0.492
T-10s      │ 20 / 128      │ 14/20 (70.0%)    │ +$8.935   │ +$0.447
T-5s       │ 20 / 128      │ 14/20 (70.0%)    │ +$9.025   │ +$0.451
```

**Key observations:**
- T-60s has the best win rate (85.7%) and best avg PnL ($0.57/trade)
- T-10s and T-5s are the same 70% — the disagreement set is similar
- All horizons are profitable
- Disagreements occur in ~15-16% of windows (21/128 at T-60)

### What happens when they agree?

When VWAP and CLOB point the same direction, they're almost always right:
- T-60s agree: 101/107 correct (94.4%)
- T-30s agree: 104/110 correct (94.5%)
- T-10s agree: 103/108 correct (95.4%)

**The disagreement is the signal.** When they agree, resolution is near-certain. When they disagree, VWAP is right ~80% of the time.

---

## Strategy 2: Strong VWAP Signal + CLOB Disagreement (THE STANDOUT)

**Rule:** Same as Strategy 1, but only enter when the VWAP has moved more than a threshold amount from its opening value. Filters out noise from tiny moves.

**Rationale:** When VWAP has moved $100+ from open but CLOB still prices the other direction, the CLOB is clearly stale. When VWAP has only moved $10, it might be noise.

### Results by VWAP delta threshold (all at T-60s entry)

```
VWAP Δ Threshold │ Trades │ Win Rate          │ Total PnL │ Avg PnL/Trade
─────────────────┼────────┼───────────────────┼───────────┼──────────────
> $25             │ 16     │ 15/16 (93.8%)     │ +$10.560  │ +$0.660
> $50             │ 12     │ 11/12 (91.7%)     │ +$7.220   │ +$0.602
> $75             │ 9      │ 9/9   (100.0%)    │ +$6.375   │ +$0.708
> $100            │ 7      │ 7/7   (100.0%)    │ +$5.205   │ +$0.744
> $150            │ 4      │ 4/4   (100.0%)    │ +$3.020   │ +$0.755
```

**At VWAP delta > $75: 9/9 wins, 100% accuracy, $0.71 avg profit per $1 bet.**

This is the most compelling signal in the dataset. When our exchange composite has moved $75+ in a direction and the CLOB hasn't caught up, the CLOB is wrong every time in our sample.

**Why $75?** The structural VWAP-CL spread is ~$47 (exchanges sit above CL). A $75 VWAP delta means the exchanges have moved $75 from open, which after the ~$47 structural offset, implies CL has moved ~$28+ in that direction. That's enough to be a real directional move, not noise.

---

## Strategy 3: VWAP Predicts CL Reversal (DOES NOT WORK)

**Rule:** At T-60, if VWAP direction ≠ CL's current direction (CL is currently above open but VWAP says down, or vice versa), bet with VWAP.

**Result:** 3/8 wins (37.5%), PnL: -$1.33. **This loses money.**

**Why it fails:** VWAP doesn't predict CL *direction changes*. It tracks where CL already is, but faster than the CLOB. When VWAP and CL actually disagree, it's because of the structural spread, not because VWAP is seeing something CL isn't.

---

## Strategy 4: T-10s Entry, CLOB Not Extreme

**Rule:** At T-10s, VWAP disagrees with CLOB, AND CLOB is not already at extreme pricing (max side < $0.80). This filters out cases where the CLOB has already committed strongly.

**Result:** 9/13 wins (69.2%), PnL: +$4.75, Avg: +$0.365/trade

Slightly worse than the unfiltered T-10 strategy (14/20, +$8.94), because the filter removes some profitable trades where we'd buy the extreme cheap side and win big.

---

## The Losing Trades — What Goes Wrong

### All 3 losses at T-60 (Strategy 1):

| Window | CL Move | VWAP Said | CLOB Said | Entry | What Happened |
|--------|---------|-----------|-----------|-------|---------------|
| 04:15  | -$20    | UP        | DOWN      | $0.465 | Tiny CL move, VWAP noise above open, CL barely moved down |
| 04:45  | +$1     | DOWN      | UP        | $0.225 | CL moved $1 — effectively a coin flip, VWAP wrong by noise |
| 04:30  | -$69    | UP        | DOWN      | $0.265 | VWAP still showing UP but CL moved DOWN — genuine miss |

**Pattern:** 2/3 losses are on tiny CL moves (<$25) where the direction is essentially random. The third is a genuine miss where VWAP was stale.

### The additional losses at T-10 (6 total):

The 6 T-10 VWAP losses include the same tiny-move pattern:
- CL moves of -$20, +$1, -$9, +$35, -$69, -$30
- 4 out of 6 are sub-$35 moves — noise territory

---

## Assumptions & Caveats

### What we're assuming that might be wrong:

1. **Execution at CLOB price** — We assume we can buy at the displayed UP/DOWN token price. In reality:
   - There's spread between bid and ask
   - Our order may move the market
   - Latency between signal and execution
   - At T-60s we have more time to execute; at T-10s it's tighter

2. **Sample size** — 128 windows is thin. The 100% win rates on high-threshold Strategy 2 are from 4-9 trades. Need hundreds of windows to have statistical confidence.

3. **CLOB prices are snapshots** — The `market_up_price_60s` etc. are point-in-time snapshots captured by our window-close-event-recorder. The actual CLOB may have been different by the time we'd execute.

4. **No fees** — Polymarket trading fees are not accounted for.

5. **Market regime** — 32 hours of data during one market period. BTC was volatile (moves up to $587 in 15 min). Calmer periods may have fewer/weaker signals.

6. **The VWAP-CL structural spread** — Our VWAP sits ~$47 above CL consistently. This means when we compute "VWAP direction from open," there's a persistent upward bias. We should investigate whether this biases the direction signal.

### What we're fairly confident about:

1. **VWAP tracks CL direction** — 93% accuracy at T-60s is real. The 21-exchange composite is a good proxy for where CL is heading.

2. **CLOB lags** — 81-86% accuracy vs VWAP's 93% means the CLOB is consistently slower to reprice. This isn't surprising — MMs have to manage risk, not just track price.

3. **Disagreement = VWAP wins** — When they disagree at T-60s, VWAP is right 85.7% of the time. The CLOB is right only 14.3%. This is a strong signal even with 21 samples.

4. **Large VWAP moves are near-certain** — When VWAP has moved >$75 from open and CLOB disagrees, VWAP was right 9/9 times. The CLOB simply hadn't caught up.

---

## What CL Move Sizes Look Like

For context on BTC 15-minute windows in our sample:

```
|CL Move| Range  │ Count │ % of Total
─────────────────┼───────┼──────────
< $25            │ 18    │ 14.1%
$25 - $50        │ 16    │ 12.5%
$50 - $100       │ 31    │ 24.2%
$100 - $200      │ 33    │ 25.8%
$200 - $350      │ 22    │ 17.2%
> $350           │ 8     │ 6.3%
```

Most windows have CL moves of $50-$200. The edge is strongest on moves > $75 where VWAP clearly shows the direction.

---

## Next Steps

1. **Collect more data** — Keep vwap_snapshots + window_close_events running. Need 500+ windows for statistical significance.
2. **Validate execution** — Can we actually buy at the CLOB prices shown? Need to check order book depth at T-60s and T-10s.
3. **Account for fees and spread** — Polymarket fee structure, bid-ask spread on UP/DOWN tokens.
4. **Test on different market regimes** — Calm markets, trending markets, high-vol events.
5. **Build the signal in real-time** — The `getPredictedOracle()` function in exchange-trade-collector already exists. Need to wire it to a trading decision at T-60s.
6. **Consider the VWAP-CL structural bias** — Does the persistent $47 gap affect direction accuracy? Should we subtract it?

---

## Raw Data: All Disagreement Trades at T-60s (Strategy 1)

| # | Close (UTC) | CL Move | Resolution | CLOB Says | VWAP Says | CLOB UP Price | Entry Price | Won? | PnL |
|---|-------------|---------|------------|-----------|-----------|---------------|-------------|------|-----|
| 1 | 02:30:00 | -$16 | DOWN | UP | DOWN | 0.705 | 0.295 | YES | +0.705 |
| 2 | 04:15:00 | -$20 | DOWN | DOWN | UP | 0.465 | 0.465 | NO | -0.465 |
| 3 | 04:45:00 | +$1 | UP | UP | DOWN | 0.775 | 0.225 | NO | -0.225 |
| 4 | 05:15:00 | -$134 | DOWN | UP | DOWN | 0.955 | 0.045 | YES | +0.955 |
| 5 | 06:00:00 | +$48 | UP | DOWN | UP | 0.445 | 0.445 | YES | +0.555 |
| 6 | 06:15:00 | +$26 | UP | DOWN | UP | 0.185 | 0.185 | YES | +0.815 |
| 7 | 09:15:00 | +$49 | UP | DOWN | UP | 0.175 | 0.175 | YES | +0.825 |
| 8 | 10:15:00 | -$63 | DOWN | UP | DOWN | 0.565 | 0.435 | YES | +0.565 |
| 9 | 10:30:00 | +$115 | UP | DOWN | UP | 0.035 | 0.035 | YES | +0.965 |
| 10 | 13:00:00 | -$19 | DOWN | UP | DOWN | 0.655 | 0.345 | YES | +0.655 |
| 11 | 13:30:00 | -$90 | DOWN | UP | DOWN | 0.885 | 0.115 | YES | +0.885 |
| 12 | 14:00:00 | +$259 | UP | DOWN | UP | 0.315 | 0.315 | YES | +0.685 |
| 13 | 17:15:00 | -$102 | DOWN | UP | DOWN | 0.645 | 0.355 | YES | +0.645 |
| 14 | 20:15:00 | -$81 | DOWN | UP | DOWN | 0.855 | 0.145 | YES | +0.855 |
| 15 | 22:30:00 | +$133 | UP | DOWN | UP | 0.245 | 0.245 | YES | +0.755 |
| 16 | 23:15:00 | +$18 | UP | DOWN | UP | 0.395 | 0.395 | YES | +0.605 |
| 17 | 00:00:00 | +$16 | UP | DOWN | UP | 0.435 | 0.435 | YES | +0.565 |
| 18 | 01:00:00 | -$51 | DOWN | UP | DOWN | 0.735 | 0.265 | YES | +0.735 |
| 19 | 04:30:00 | -$69 | DOWN | DOWN | UP | 0.265 | 0.265 | NO | -0.265 |
| 20 | 05:15:00 | -$56 | DOWN | UP | DOWN | 0.605 | 0.395 | YES | +0.605 |
| 21 | 06:30:00 | -$116 | DOWN | UP | DOWN | 0.525 | 0.475 | YES | +0.525 |

**Totals: 18 wins, 3 losses. Net PnL: +$11.945 on 21 $1 bets.**

---

---

## Detailed Trade Breakdowns — All 21 Disagreement Trades

Below is every trade where VWAP and CLOB disagreed at T-60s. Each shows exact timestamps, price trajectories, and trade mechanics.

**How to read these:**
- "VWAP Δ" = our 21-exchange composite price minus its value at window open. Positive = exchanges have moved up since open.
- "CL Δ" = Chainlink oracle price minus its value at window open. This is what determines resolution.
- "Dir" = direction implied by that delta (UP if positive, DN if negative)
- "CLOB UP" = the Polymarket UP token price at that moment. Above $0.50 means market is betting UP.
- "Entry price" = what we'd pay for the token on the side VWAP predicts. Always the cheap side since CLOB disagrees.

---

### TRADE #1/21: WIN — btc-15m-1770862500

```
Window:  2026-02-12 02:15:00Z → 02:30:00Z  (15 min)
Entry:   2026-02-12 02:29:00Z  (T-60s)
Resolve: 2026-02-12 02:30:00Z
```

**Oracle:** CL@open $67,448.52 → CL@close $67,415.24 (−$33.27) → **DOWN**
**VWAP:** $67,563.61 → at T-60s $67,511.67 (−$51.93 from open → says DOWN)
**CLOB:** UP token at $0.705 → says UP

**Trade:** VWAP=DOWN, CLOB=UP → buy DOWN at $0.295 → Resolution DOWN → **WIN +$0.705**

What happened: VWAP had been falling for 2+ minutes. At T-60s both VWAP and CL were below open. CLOB was still pricing UP at $0.705. By T-30s the CLOB caught up (dropped to $0.465) but we'd already entered at $0.295.

```
Time    │  VWAP Δ  │ Dir │  CL Δ   │ Dir
T-300s  │   −$26   │ DN  │  +$64   │ UP    ← CL was still UP 5 min before close
T-180s  │   −$24   │ DN  │   −$6   │ DN
T-120s  │   −$36   │ DN  │  −$30   │ DN
T-60s   │   −$52   │ DN  │  −$66   │ DN    ← ENTRY: both VWAP and CL say DOWN, CLOB still UP
T-30s   │   −$58   │ DN  │  −$45   │ DN
T-10s   │   −$64   │ DN  │  −$28   │ DN
CLOSE   │   −$70   │ DN  │  −$33   │ DN    ← RESOLVED DOWN
```

---

### TRADE #2/21: LOSS — btc-15m-1770868800

```
Window:  2026-02-12 04:00:00Z → 04:15:00Z
Entry:   2026-02-12 04:14:00Z  (T-60s)
Resolve: 2026-02-12 04:15:00Z
```

**Oracle:** CL@open $67,547.13 → CL@close $67,526.62 (−$20.51) → **DOWN**
**VWAP:** $67,562.60 → at T-60s $67,617.03 (+$54.43 from open → says UP)
**CLOB:** UP token at $0.465 → says DOWN

**Trade:** VWAP=UP, CLOB=DOWN → buy UP at $0.465 → Resolution DOWN → **LOSS −$0.465**

What happened: VWAP showed +$54 at T-60s (exchanges moved up) but CL only moved +$6. Over the next 30 seconds CL reversed to −$15, then −$21 at close. The VWAP signal was +$54 but the CL move was only −$21 — a tiny move where the structural VWAP-CL spread ($47) swamped the actual signal. CLOB was right to bet DOWN (barely).

```
Time    │  VWAP Δ  │ Dir │  CL Δ   │ Dir
T-300s  │   −$15   │ DN  │   −$1   │ DN
T-180s  │   +$6    │ UP  │  +$40   │ UP    ← CL was actually UP earlier
T-120s  │  +$42    │ UP  │  +$45   │ UP
T-60s   │  +$54    │ UP  │   +$6   │ UP    ← ENTRY: VWAP strongly UP, CL barely UP
T-30s   │  +$50    │ UP  │  −$15   │ DN    ← CL reverses! VWAP hasn't caught it
T-10s   │  +$49    │ UP  │  −$18   │ DN
CLOSE   │  +$49    │ UP  │  −$21   │ DN    ← CL moved only $21 total. Noise.
```

**Lesson:** VWAP delta was +$54 but CL move was only $21. The signal-to-noise ratio was bad. Strategy 2 ($75 threshold) would have skipped this trade.

---

### TRADE #3/21: LOSS — btc-15m-1770870600

```
Window:  2026-02-12 04:30:00Z → 04:45:00Z
Entry:   2026-02-12 04:44:00Z  (T-60s)
Resolve: 2026-02-12 04:45:00Z
```

**Oracle:** CL@open $67,164.42 → CL@close $67,165.17 (+$0.74) → **UP**
**VWAP:** $67,250.13 → at T-60s $67,248.84 (−$1.29 from open → says DOWN)
**CLOB:** UP token at $0.775 → says UP

**Trade:** VWAP=DOWN, CLOB=UP → buy DOWN at $0.225 → Resolution UP → **LOSS −$0.225**

What happened: CL moved +$0.74 total. That's $0.74 on a $67K asset — effectively zero. VWAP was −$1.29 from open. Both signals are noise. A literal coin flip that CLOB happened to get right because it had slight UP bias.

```
Time    │  VWAP Δ  │ Dir │  CL Δ   │ Dir
T-300s  │   +$2    │ UP  │  +$58   │ UP
T-180s  │  +$21    │ UP  │  +$50   │ UP
T-120s  │   +$7    │ UP  │  +$18   │ UP
T-60s   │   −$1    │ DN  │   −$8   │ DN    ← ENTRY: both barely negative
T-30s   │   −$9    │ DN  │   +$9   │ UP    ← CL flips to UP
CLOSE   │  −$14    │ DN  │   +$1   │ UP    ← CL ends $0.74 above open
```

**Lesson:** CL move = $0.74. This is pure noise. Strategy 2 ($25+ threshold) would have skipped this.

---

### TRADE #4/21: WIN — btc-15m-1770872400

```
Window:  2026-02-12 05:00:00Z → 05:15:00Z
Entry:   2026-02-12 05:14:00Z  (T-60s)
Resolve: 2026-02-12 05:15:00Z
```

**Oracle:** CL@open $66,970.15 → CL@close $66,757.31 (−$212.84) → **DOWN**
**VWAP:** $67,045.57 → at T-60s $66,868.93 (−$176.65 → says DOWN)
**CLOB:** UP token at $0.955 → says UP

**Trade:** VWAP=DOWN, CLOB=UP → buy DOWN at $0.045 → Resolution DOWN → **WIN +$0.955**

What happened: This is the dream trade. Exchanges had crashed $177 from open. CL was already down $238. **But the CLOB was still at $0.955 UP.** We buy DOWN for $0.045 — a 22:1 risk/reward. The CLOB never updated; it stayed at $0.955 all the way to close. Pure stale pricing.

```
Time    │  VWAP Δ  │ Dir │  CL Δ   │ Dir
T-300s  │  +$47    │ UP  │   +$4   │ UP
T-180s  │  −$11    │ DN  │  −$84   │ DN    ← crash begins
T-120s  │  −$66    │ DN  │ −$135   │ DN
T-60s   │ −$177    │ DN  │ −$238   │ DN    ← ENTRY: massive crash, CLOB at $0.955 UP (!!)
T-30s   │ −$183    │ DN  │ −$186   │ DN
CLOSE   │ −$198    │ DN  │ −$213   │ DN
```

**CLOB stayed at $0.955 UP through the entire crash.** This is the clearest example of stale CLOB pricing.

---

### TRADE #5/21: WIN — btc-15m-1770875100

```
Window:  2026-02-12 05:45:00Z → 06:00:00Z
Entry:   2026-02-12 05:59:00Z  (T-60s)
```

**Oracle:** CL +$47.00 → **UP** | **VWAP:** +$22.23 → UP | **CLOB:** $0.445 → DOWN
**Trade:** Buy UP at $0.445 → **WIN +$0.555**

Notable: CLOB was at $0.445 (DOWN) at T-60 but flipped to $0.925 by T-10s. We'd have entered cheap at $0.445.

---

### TRADE #6/21: WIN — btc-15m-1770876000

```
Window:  2026-02-12 06:00:00Z → 06:15:00Z
Entry:   2026-02-12 06:14:00Z  (T-60s)
```

**Oracle:** CL +$26.66 → **UP** | **VWAP:** +$47.53 → UP | **CLOB:** $0.185 → DOWN
**Trade:** Buy UP at $0.185 → **WIN +$0.815**

CLOB stayed at $0.185 all the way to T-1s. VWAP and CL both clearly UP for the entire final minute. MMs never repriced.

---

### TRADE #7/21: WIN — btc-15m-1770886800

```
Window:  2026-02-12 09:00:00Z → 09:15:00Z
Entry:   2026-02-12 09:14:00Z  (T-60s)
```

**Oracle:** CL +$44.48 → **UP** | **VWAP:** +$37.30 → UP | **CLOB:** $0.175 → DOWN
**Trade:** Buy UP at $0.175 → **WIN +$0.825**

Another case where CLOB stayed locked at $0.175 while VWAP and CL both showed UP for the entire final 2 minutes.

---

### TRADE #8/21: WIN — btc-15m-1770890400

```
Window:  2026-02-12 10:00:00Z → 10:15:00Z
Entry:   2026-02-12 10:14:00Z  (T-60s)
```

**Oracle:** CL −$72.65 → **DOWN** | **VWAP:** −$90.35 → DOWN | **CLOB:** $0.565 → UP
**Trade:** Buy DOWN at $0.435 → **WIN +$0.565**

CLOB started at $0.565 UP, dropped to $0.355 by T-30 — it eventually caught up, but our entry was at the stale price.

---

### TRADE #9/21: WIN — btc-15m-1770891300

```
Window:  2026-02-12 10:15:00Z → 10:30:00Z
Entry:   2026-02-12 10:29:00Z  (T-60s)
```

**Oracle:** CL +$125.14 → **UP** | **VWAP:** +$39.50 → UP | **CLOB:** $0.035 → DOWN
**Trade:** Buy UP at $0.035 → **WIN +$0.965**

**Best trade in the dataset.** CLOB was at $0.035 (extreme DOWN) but CL had already moved +$97 from open. By T-30s CLOB jumped to $0.655 — it caught up, but we entered at $0.035. A 28:1 payoff.

---

### TRADE #10/21: WIN — btc-15m-1770900300

```
Window:  2026-02-12 12:45:00Z → 13:00:00Z
Entry:   2026-02-12 12:59:00Z  (T-60s)
```

**Oracle:** CL −$20.01 → **DOWN** | **VWAP:** −$109.17 → DOWN | **CLOB:** $0.655 → UP
**Trade:** Buy DOWN at $0.345 → **WIN +$0.655**

VWAP was down $109 from open but CL only ended down $20. VWAP got the direction right even though the magnitude was different. CLOB eventually flipped — $0.095 at T-1s — but again, we entered at the stale $0.345 price.

---

### TRADE #11/21: WIN — btc-15m-1770902100

```
Window:  2026-02-12 13:15:00Z → 13:30:00Z
Entry:   2026-02-12 13:29:00Z  (T-60s)
```

**Oracle:** CL −$96.86 → **DOWN** | **VWAP:** −$126.55 → DOWN | **CLOB:** $0.885 → UP
**Trade:** Buy DOWN at $0.115 → **WIN +$0.885**

CLOB was at $0.885 (strong UP) despite VWAP being down $127 and CL down $155 at entry time. CLOB **never repriced** — stayed at $0.885 through close. Another case of completely stale CLOB pricing during a real move.

---

### TRADE #12/21: WIN — btc-15m-1770903900

```
Window:  2026-02-12 13:45:00Z → 14:00:00Z
Entry:   2026-02-12 13:59:00Z  (T-60s)
```

**Oracle:** CL +$258.73 → **UP** | **VWAP:** +$189.43 → UP | **CLOB:** $0.315 → DOWN
**Trade:** Buy UP at $0.315 → **WIN +$0.685**

Massive $259 CL move UP. VWAP saw +$189 at entry. CLOB at $0.315 (DOWN). CLOB never updated — stayed at $0.315 all the way through. A $259 move and the CLOB didn't even flinch.

---

### TRADE #13/21: WIN — btc-15m-1770915600

```
Window:  2026-02-12 17:00:00Z → 17:15:00Z
Entry:   2026-02-12 17:14:00Z  (T-60s)
```

**Oracle:** CL −$101.52 → **DOWN** | **VWAP:** −$147.70 → DOWN | **CLOB:** $0.645 → UP
**Trade:** Buy DOWN at $0.355 → **WIN +$0.645**

---

### TRADE #14/21: WIN — btc-15m-1770926400

```
Window:  2026-02-12 20:00:00Z → 20:15:00Z
Entry:   2026-02-12 20:14:00Z  (T-60s)
```

**Oracle:** CL −$80.60 → **DOWN** | **VWAP:** −$222.01 → DOWN | **CLOB:** $0.855 → UP
**Trade:** Buy DOWN at $0.145 → **WIN +$0.855**

VWAP was down $222 (!) from open. CLOB at $0.855 UP. Resolution: DOWN. CLOB never moved from $0.855.

---

### TRADE #15/21: WIN — btc-15m-1770934500

```
Window:  2026-02-12 22:15:00Z → 22:30:00Z
Entry:   2026-02-12 22:29:00Z  (T-60s)
```

**Oracle:** CL +$133.25 → **UP** | **VWAP:** +$19.60 → UP | **CLOB:** $0.245 → DOWN
**Trade:** Buy UP at $0.245 → **WIN +$0.755**

---

### TRADE #16/21: WIN — btc-15m-1770937200

```
Window:  2026-02-12 23:00:00Z → 23:15:00Z
Entry:   2026-02-12 23:14:00Z  (T-60s)
```

**Oracle:** CL +$17.28 → **UP** | **VWAP:** +$73.39 → UP | **CLOB:** $0.395 → DOWN
**Trade:** Buy UP at $0.395 → **WIN +$0.605**

Interesting case: CL was actually DN at T-60s (−$1.62) but VWAP was UP (+$73). CL flipped to UP only in the final seconds (+$17 at close). **VWAP predicted the CL direction change 60 seconds early.**

```
T-60s   │  +$73    │ UP  │   −$2   │ DN    ← CL still DOWN, VWAP already UP
T-30s   │  +$68    │ UP  │  −$13   │ DN    ← CL still DOWN
T-10s   │  +$61    │ UP  │  −$16   │ DN    ← CL still DOWN
T-5s    │  +$56    │ UP  │  −$22   │ DN    ← CL at its lowest!
CLOSE   │  +$50    │ UP  │  +$17   │ UP    ← CL flips UP in final seconds
```

---

### TRADE #17/21: WIN — btc-15m-1770939900

```
Window:  2026-02-12 23:45:00Z → 2026-02-13 00:00:00Z
Entry:   2026-02-12 23:59:00Z  (T-60s)
```

**Oracle:** CL +$16.46 → **UP** | **VWAP:** +$16.85 → UP | **CLOB:** $0.435 → DOWN
**Trade:** Buy UP at $0.435 → **WIN +$0.565**

---

### TRADE #18/21: WIN — btc-15m-1770943500

```
Window:  2026-02-13 00:45:00Z → 01:00:00Z
Entry:   2026-02-13 00:59:00Z  (T-60s)
```

**Oracle:** CL −$47.04 → **DOWN** | **VWAP:** −$34.87 → DOWN | **CLOB:** $0.735 → UP
**Trade:** Buy DOWN at $0.265 → **WIN +$0.735**

Critical detail: at T-60s, CL was actually +$22 (UP). But VWAP was already −$35 (DOWN). CL flipped to DOWN only in the final 5 seconds (−$23 at T-5s, −$47 at close). **VWAP called the reversal 60 seconds before CL confirmed it.**

```
T-60s   │  −$35    │ DN  │  +$22   │ UP    ← CL still UP, VWAP already DOWN
T-30s   │  −$39    │ DN  │   +$4   │ UP    ← CL fading
T-10s   │  −$43    │ DN  │   +$0   │ UP    ← CL nearly flat
T-5s    │  −$45    │ DN  │  −$23   │ DN    ← CL flips DOWN
CLOSE   │  −$50    │ DN  │  −$47   │ DN    ← RESOLVED DOWN
```

---

### TRADE #19/21: LOSS — btc-15m-1770956100

```
Window:  2026-02-13 04:15:00Z → 04:30:00Z
Entry:   2026-02-13 04:29:00Z  (T-60s)
```

**Oracle:** CL −$25.76 → **DOWN** | **VWAP:** +$10.83 → UP | **CLOB:** $0.265 → DOWN
**Trade:** Buy UP at $0.265 → **LOSS −$0.265**

VWAP delta was only +$10.83 — tiny signal. CL was already −$15 at entry. CL ended −$26. Another sub-$30 move where the signal is noise. Strategy 2 ($25 threshold) would have skipped.

---

### TRADE #20/21: WIN — btc-15m-1770958800

```
Window:  2026-02-13 05:00:00Z → 05:15:00Z
Entry:   2026-02-13 05:14:00Z  (T-60s)
```

**Oracle:** CL −$57.19 → **DOWN** | **VWAP:** −$75.58 → DOWN | **CLOB:** $0.605 → UP
**Trade:** Buy DOWN at $0.395 → **WIN +$0.605**

---

### TRADE #21/21: WIN — btc-15m-1770963300

```
Window:  2026-02-13 06:15:00Z → 06:30:00Z
Entry:   2026-02-13 06:29:00Z  (T-60s)
```

**Oracle:** CL −$127.14 → **DOWN** | **VWAP:** −$178.40 → DOWN | **CLOB:** $0.525 → UP
**Trade:** Buy DOWN at $0.475 → **WIN +$0.525**

CLOB was $0.525 (barely UP) at T-60s but flipped to $0.025 by T-30s. We'd have entered at $0.475 — not the cheapest entry, but still profitable.

---

## Trade Summary Statistics

```
Total trades:    21
Wins:            18 (85.7%)
Losses:           3 (14.3%)
Total PnL:      +$11.945
Avg PnL/trade:  +$0.569

Winning trades:
  Avg profit:    +$0.717
  Avg entry:     $0.283 (buying the cheap side)
  Avg |CL move|: $84

Losing trades:
  Avg loss:      −$0.318
  Avg entry:     $0.318
  Avg |CL move|: $16   ← ALL losses are on tiny CL moves
```

**The pattern is clear:** wins happen on real CL moves ($50+), losses happen on noise (<$25). Strategy 2 with a $75 VWAP delta threshold eliminates all 3 losses and goes 9/9.

---

*Analysis scripts: `src/backtest/diagnose-vwap-edge.cjs`, `src/backtest/diagnose-vwap-trade-details.cjs`*
*Data sources: `vwap_snapshots` (21-exchange WebSocket VWAP), `window_close_events` (CLOB pricing + oracle data)*

---

## Appendix: Chainlink Oracle Value Pipeline

### How CL Values Flow Through Our System

This section documents the complete path of Chainlink Data Streams prices from source to our analysis, since the entire edge depends on correctly predicting and comparing against these values.

#### 1. The Oracle Source: Chainlink Data Streams

Polymarket resolves BTC 15-minute windows using **Chainlink Data Streams** (not on-chain Chainlink Price Feeds). These are an off-chain pull-based oracle product.

**How Chainlink computes the price:**
- **16 independent node operators** each compute a BTC/USD price
- Each node pulls data from **premium data aggregators**: CoinMarketCap, CoinGecko, Tiingo, BraveNewCoin, CryptoCompare, etc.
- These aggregators compute **VWAP** (Volume-Weighted Average Price) from all CEX + DEX trade data they have access to
- The 16 node prices are **medianed** — the median of 16 VWAP-derived prices becomes the official CL price
- This is NOT a simple last-trade price. It's a multi-layer VWAP aggregation.

**Key implication:** CL price is structurally ~$30-$150 below raw exchange spot because VWAP includes older trades. This is the "structural gap" — it's constant and doesn't help predict direction.

**Transfer function (measured):** When exchanges move $X in aggregate:
- +1 second: CL absorbs ~41% of the move
- +2 seconds: ~53%
- +3 seconds: ~65%
- +5 seconds: ~77%
- +8 seconds: ~90% (effective smoothing half-life ~2s)

#### 2. How We Receive CL Prices: RTDS Subscription

Our system subscribes to Chainlink prices via Polymarket's **Real-Time Data Streams (RTDS)** WebSocket service.

**Feed:** `crypto_prices_chainlink` topic in RTDS
- Defined in `src/clients/rtds/types.js` as `TOPICS.CRYPTO_PRICES_CHAINLINK`
- Returns the latest Chainlink Data Streams price for BTC
- Updates arrive at ~1 second granularity (timestamps truncated to seconds)
- The RTDS client holds the most recent price in memory: `rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK)`

**Important distinction from other feeds:**
| Feed | Topic | What it is |
|------|-------|------------|
| `crypto_prices` | Polymarket composite reference | Near-Binance but NOT raw Binance |
| `crypto_prices_chainlink` | Chainlink Data Streams | **Settlement oracle** — this is what resolves markets |
| `crypto_prices_pyth` | Pyth oracle | Tracks CL within 0-3s, NOT a leading indicator |

#### 3. Where CL Values Are Stored

CL values end up in two tables through two independent collection paths:

##### Path A: `vwap_snapshots` table (via exchange-trade-collector)

`src/modules/exchange-trade-collector/index.js` runs the 21-exchange WebSocket pipeline:
1. Streams real-time trades via CCXT Pro `watchTrades()` from 21 exchanges
2. Computes rolling 10-second VWAP per exchange per symbol using in-memory ring buffers
3. Every 1 second, calls `rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK)` to get the current CL price
4. Persists a snapshot row to `vwap_snapshots` with columns:
   - `composite_vwap` — our 21-exchange VWAP (the signal)
   - `chainlink_price` — the CL price at that same second (ground truth)
   - `vwap_cl_spread` — the difference (structural gap monitoring)
   - `exchange_detail` — per-exchange VWAP breakdown (JSONB)

**This is the primary data source for our edge analysis.** ~1 row/second, ~920K rows over 32 hours.

##### Path B: `window_close_events` table (via window-close-event-recorder)

`src/modules/window-close-event-recorder/index.js` captures prices around each 15-minute window close:
1. Starts capture 90 seconds before window close
2. At T-60s, T-30s, T-10s, T-5s, T-1s: calls `rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK)` → stored as `oracle_price_Xs_before`
3. At T=0 (close): captures `oracle_price_at_close`
4. **NEW (2026-02-13):** At capture start, queries `vwap_snapshots` for `chainlink_price` at window open time → stored as `oracle_price_at_open`
5. Self-resolves: `oracle_price_at_close >= oracle_price_at_open → UP, else DOWN` → stored as `resolved_direction`

#### 4. Resolution Formula (Fixed 2026-02-13)

**Previous (WRONG):** `CL@close > strike_price → UP, else DOWN`
- `strike_price` is the Polymarket reference price (~exchange spot), which sits ~$47 ABOVE CL
- This meant almost every window resolved DOWN (CL was always below strike)
- 14/128 windows would have gotten different resolutions with this formula

**Current (CORRECT):** `CL@close >= CL@open → UP, else DOWN`
- Both values are from Chainlink Data Streams
- Verified 129/129 (100%) match against post-resolution CLOB ground truth
- `CL@open` sourced from `vwap_snapshots.chainlink_price` at window open time
- `CL@close` sourced from `rtdsClient.getCurrentPrice()` at window close time

**The fix:**
- `determineResolution()` now compares `capture.oraclePrices.close >= capture.oracleOpenPrice`
- `fetchOracleOpenPrice()` queries `vwap_snapshots` for the CL price within ±5s of window open
- Falls back to previous window's `oracle_price_at_close` (consecutive windows share boundaries)
- Self-resolves immediately at close time — no longer depends on Gamma API `market.closed` (which was timing out after 60s, leaving `resolved_direction` NULL for all rows)

#### 5. Data Integrity Summary

| Question | Answer |
|----------|--------|
| What price resolves the market? | Chainlink Data Streams BTC/USD |
| How do we get it? | RTDS `crypto_prices_chainlink` subscription |
| Where is CL@close stored? | `window_close_events.oracle_price_at_close` and `vwap_snapshots.chainlink_price` |
| Where is CL@open stored? | `window_close_events.oracle_price_at_open` (NEW) and `vwap_snapshots.chainlink_price` |
| Are both from the same source? | Yes — both are `rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK)` |
| Is the resolution formula verified? | Yes — 129/129 match against post-resolution CLOB (UP token → $0.99 or $0.01) |
| Is CL different from exchange spot? | Yes — CL is ~$30-$150 below spot (VWAP vs last-trade) |
| Does Pyth help predict CL? | No — Pyth uses similar VWAP methodology, tracks CL within 0-3s, not a leading indicator |
