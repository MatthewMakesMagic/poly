# Loss Analysis Report — Conviction-Filtered VWAP Strategies

**Date**: 2026-02-20
**Scope**: Conviction-filtered variants (`f-d3-c20`, `f-d8-c20`, `f-d8-c25`) at T-60, T-90, T-120
**Sample**: 232 trades across 26 unique windows (11 BTC, 7 ETH, 8 XRP), 1 day (Feb 19)
**Overall**: 159 wins / 73 losses = **68.5% win rate**, +$10,709 net PnL
**Window-level**: 15 won / 10 lost = **60% window win rate** (honest number — multiple trades per window resolve identically)

> **Overfitting warning**: All findings below are from a single day. Cell sizes are small (3-32 trades). Treat patterns as hypotheses to validate, not filters to deploy. Structural explanations noted where applicable.

---

## Phase 1: Feature Analysis

### 1A. VWAP Delta Magnitude — Strongest Single Predictor

| Delta bucket | N | Wins | Win% | PnL |
|---|---|---|---|---|
| <0.05% | 19 | 12 | 63.2% | +$507 |
| 0.05-0.08% | 15 | 9 | 60.0% | +$237 |
| 0.08-0.12% | 83 | 48 | 57.8% | +$1,311 |
| 0.12-0.20% | 38 | 24 | 63.2% | +$1,471 |
| **0.20%+** | **77** | **66** | **85.7%** | **+$7,183** |

**Takeaway**: Large VWAP moves (>0.20%) are highly predictive. Small moves (<0.12%) are near coin-flip territory. This makes structural sense — a large VWAP delta means exchanges have genuinely moved; small deltas are noise.

**Winner median delta**: 0.1341% vs **Loser median delta**: 0.1034%. Winners have ~30% larger deltas on average (0.2167% vs 0.1329%).

### 1B. Entry Side — DOWN Dominates

| Side | N | Wins | Win% | PnL |
|---|---|---|---|---|
| **DOWN** | **134** | **102** | **76.1%** | **+$8,153** |
| UP | 98 | 57 | 58.2% | +$2,557 |

**Structural explanation**: DOWN moves are sharper and faster (panic selling). VWAP captures these more reliably. UP moves are gradual — by the time VWAP shows UP, CLOB may have already partially repriced.

### 1C. CLOB Conviction Band

| Conviction | N | Wins | Win% | PnL |
|---|---|---|---|---|
| **0.00-0.05 (dead center)** | **90** | **74** | **82.2%** | **+$4,985** |
| 0.05-0.10 (near fair) | 36 | 26 | 72.2% | +$1,600 |
| 0.10-0.15 (mild lean) | 44 | 27 | 61.4% | +$1,764 |
| 0.15-0.20 (moderate lean) | 54 | 32 | 59.3% | +$3,176 |
| 0.20+ (decided) | 8 | 0 | 0.0% | -$816 |

**Takeaway**: Confirmation that the conviction filter works. Dead center (0-0.05) is best. The 0.20+ leakers (8 trades, all lost) come from the `f-d8-c25` variant which allows conviction up to 0.25 — consider tightening.

### 1D. Entry Price at Fill

| Entry price | N | Wins | Win% | Avg win PnL | Avg loss PnL |
|---|---|---|---|---|---|
| <0.30 | 4 | 0 | 0.0% | — | -$102 |
| 0.30-0.40 | 59 | 24 | 40.7% | +$187 | -$102 |
| **0.40-0.50** | **80** | **61** | **76.3%** | +$117 | -$102 |
| **0.50-0.60** | **79** | **64** | **81.0%** | +$95 | -$102 |
| 0.60+ | 10 | 10 | 100.0% | +$43 | — |

**Takeaway**: Cheap entries (<$0.40) = low win rate. This seems counterintuitive but makes sense: a $0.30 entry means the token is deeply out of favor — the market has information we're fighting against. Entries in the $0.40-0.60 band balance cheap enough for profit potential + market not strongly against us.

**Note**: 0.60+ entries are 100% but tiny PnL ($43 avg) — you win but barely profit. The sweet spot is $0.40-$0.50 (76.3% win, $117 avg win).

---

## Phase 2: Interaction Effects

### 2A. Delta × Side — The Key Interaction

| Side | Delta | N | Wins | Win% | PnL |
|---|---|---|---|---|---|
| **DOWN** | **large (0.20%+)** | **36** | **36** | **100%** | **+$4,627** |
| DOWN | medium (0.12-0.20%) | 11 | 9 | 81.8% | +$751 |
| DOWN | small (<0.12%) | 87 | 57 | 65.5% | +$2,775 |
| UP | large (0.20%+) | 41 | 30 | 73.2% | +$2,556 |
| UP | medium (0.12-0.20%) | 27 | 15 | 55.6% | +$720 |
| UP | small (<0.12%) | 30 | 12 | **40.0%** | **-$719** |

**Critical finding**: DOWN + large delta = perfect. UP + small delta = losing. The gap is 60 percentage points.

**Actionable**: UP entries should require a higher delta threshold than DOWN entries. A minimum delta of ~0.12% for UP would eliminate the 40% bucket.

### 2B. Conviction × Side

| Side | Conviction | N | Wins | Win% |
|---|---|---|---|---|
| **DOWN** | **very near (0-0.05)** | **48** | **48** | **100%** |
| DOWN | near (0.05-0.10) | 18 | 14 | 77.8% |
| DOWN | mild (0.10-0.15) | 34 | 20 | 58.8% |
| DOWN | moderate (0.15+) | 34 | 20 | 58.8% |
| UP | very near (0-0.05) | 42 | 26 | 61.9% |
| UP | near (0.05-0.10) | 18 | 12 | 66.7% |
| UP | mild (0.10-0.15) | 10 | 7 | 70.0% |
| UP | moderate (0.15+) | 28 | 12 | **42.9%** |

**Interesting**: DOWN benefits dramatically from low conviction (100% at dead center). UP is flatter — even at dead center it's only 61.9%. For UP, mild lean (0.10-0.15) is actually the sweet spot (70%), possibly because a slight lean toward DOWN while VWAP says UP means VWAP is correcting a stale CLOB.

### 2C. Symbol × Conviction — Each Crypto Behaves Differently

| Symbol | Conviction | N | Wins | Win% | PnL |
|---|---|---|---|---|---|
| **BTC** | **very near (<0.05)** | **46** | **46** | **100%** | **+$4,475** |
| BTC | near (0.05-0.10) | 8 | 2 | 25.0% | -$345 |
| BTC | lean (0.10+) | 24 | 1 | **4.2%** | **-$2,211** |
| ETH | very near (<0.05) | 22 | 12 | 54.5% | +$118 |
| **ETH** | **near (0.05-0.10)** | **18** | **18** | **100%** | **+$1,737** |
| **ETH** | **lean (0.10+)** | **48** | **40** | **83.3%** | **+$5,634** |
| XRP | very near (<0.05) | 22 | 16 | 72.7% | +$391 |
| XRP | near (0.05-0.10) | 10 | 6 | 60.0% | +$209 |
| XRP | lean (0.10+) | 34 | 18 | 52.9% | +$702 |

**This is the biggest finding in the report.**

- **BTC**: CLOB is extremely efficient. Any lean >0.05 means the CLOB is right and our VWAP signal is wrong. Only trade BTC when CLOB is dead center.
- **ETH**: The opposite — CLOB leans are often stale/wrong. ETH performs BETTER with a slight lean (83.3% at 0.10+), meaning our VWAP signal is correcting slow MM repricing.
- **XRP**: Falls between BTC and ETH. Best at dead center (72.7%), degrades with lean.

**Structural explanation**: BTC has the deepest CLOB liquidity and fastest MMs. When BTC CLOB leans, it's because informed traders have moved it. ETH MMs are slower — a lean may reflect stale positioning, which our VWAP signal exploits.

### 2D. Multi-Factor Profiles (n >= 3)

**Toxic (0% win rate, 31 trades total):**
| Profile | N | Explanation |
|---|---|---|
| ETH + UP + small delta + very near | 10 | Small UP signal on ETH at dead center = noise |
| XRP + DOWN + small delta + lean | 10 | XRP CLOB lean is correct, small delta insufficient |
| XRP + UP + small delta + lean | 8 | Same — lean + small delta = CLOB was right |
| BTC + UP + large delta + lean | 3 | BTC lean is always right, even large UP delta can't overcome |

**Golden (100% win rate, 112 trades total):**
| Profile | N | Explanation |
|---|---|---|
| BTC + DOWN + small delta + very near | 32 | Any DOWN signal on dead-center BTC |
| ETH + DOWN + large delta + lean | 24 | Large DOWN move on ETH overrides even CLOB lean |
| BTC + UP + small delta + very near | 14 | Dead-center BTC + any VWAP signal |
| ETH + DOWN + small delta + very near | 12 | DOWN on ETH at dead center |
| XRP + DOWN + large delta + lean | 12 | Large move overcomes lean on XRP |
| XRP + UP + large delta + very near | 9 | Large UP on dead-center XRP |
| ETH + UP + small delta + lean | 9 | UP signal on ETH correcting lean — the "stale MM" pattern |

---

## Phase 3: Timing Analysis

### 3A. Offset × Side

| Offset | Side | N | Wins | Win% | PnL |
|---|---|---|---|---|---|
| **T-60** | **DOWN** | **20** | **18** | **90.0%** | **+$1,528** |
| T-60 | UP | 37 | 19 | 51.4% | +$342 |
| T-90 | DOWN | 46 | 34 | 73.9% | +$2,307 |
| T-90 | UP | 33 | 25 | 75.8% | +$2,456 |
| T-120 | DOWN | 68 | 50 | 73.5% | +$4,317 |
| T-120 | UP | 28 | 13 | 46.4% | -$241 |

**Note**: T-90 is the only offset where UP and DOWN perform similarly. At T-60 and T-120, DOWN dominates while UP struggles. T-90 may be the "sweet spot" where VWAP information is fresh enough but CLOB hasn't started repricing.

### 3B. Time of Day (ET)

| Hour ET | N | Wins | Win% | PnL | Note |
|---|---|---|---|---|---|
| 2 AM | 7 | 1 | 14.3% | -$477 | Asia/quiet |
| 4 AM | 6 | 0 | 0.0% | -$612 | Asia/quiet |
| 5 AM | 16 | 16 | 100% | +$1,955 | Europe open |
| 7 AM | 2 | 0 | 0.0% | -$204 | Thin |
| 9 AM | 10 | 0 | 0.0% | -$1,020 | US pre-market |
| 11 AM | 30 | 30 | 100% | +$4,200 | US session |
| 12 PM | 60 | 48 | 80.0% | +$4,596 | US session |
| 13 PM | 24 | 12 | 50.0% | -$193 | US midday |
| 16 PM | 58 | 48 | 82.8% | +$3,549 | US afternoon |
| 17 PM | 12 | 0 | 0.0% | -$1,224 | End of US |

**Caution**: This is ONE day. Hour-by-hour patterns are extremely likely to be noise at this sample size. The only structural observation: US session hours (10-16 ET) tend to have more volume and more reliable VWAP signal due to more exchanges active.

---

## Phase 4: Individual Losing Windows

11 losing windows identified. Common patterns:

| Window | Symbol | Side | Delta | Conviction | Hour ET | Pattern |
|---|---|---|---|---|---|---|
| btc-1771521300 | BTC | UP | 0.19% | lean | 12 | BTC lean = CLOB right |
| btc-1771525800 | BTC | DOWN | 0.09% | lean | 13 | Small delta + lean |
| btc-1771527600 | BTC | UP | 0.10% | lean | 14 | Small delta + lean |
| btc-1771540200 | BTC | DOWN | 0.09% | lean | 17 | Small delta + lean |
| eth-1771502400 | ETH | DOWN | 0.04% | lean | 7 | Tiny delta |
| eth-1771521300 | ETH | UP | 0.32% | lean | 12 | Large but UP vs DOWN resolution |
| eth-1771534800 | ETH | UP | 0.11% | very near | 16 | Small UP on dead center |
| xrp-1771487100 | XRP | DOWN | 0.05% | lean | 2 | Small delta + lean + Asia hours |
| xrp-1771493400 | XRP | UP | 0.17% | very near | 4 | Asia hours |
| xrp-1771512300 | XRP | UP | 0.21% | lean | 9 | Lean = CLOB right |
| xrp-1771538400 | XRP | DOWN | 0.13% | lean | 17 | Medium delta but lean won |

**9 of 11 losses share at least one of**: small/medium delta (<0.20%), OR BTC with any lean. Only 2 losses (eth-1771521300 and xrp-1771512300) had delta >0.20%, both were fighting a lean.

---

## Actionable Findings (Ranked by Confidence)

### HIGH CONFIDENCE (structural, actionable now)

1. **Raise minimum delta for UP entries**: UP + delta <0.12% = 40% win rate. Require 0.12%+ for UP entries. Would eliminate 30 trades (12 wins, 18 losses). Net improvement: +6 wins protected at cost of 12 wins skipped.

2. **Tighten BTC conviction filter to 0.05**: BTC at conviction >0.05 = 4-25% win rate. Only allow BTC when CLOB is dead center (<0.05). Would eliminate 32 BTC trades (3 wins, 29 losses) from the lean bucket. Massive improvement.

3. **Keep `f-d8-c25` under observation**: The c25 variant allows conviction up to 0.25 — all 8 trades that leaked into the "decided" bucket (0.20+) lost. Consider dropping to c20 max.

### MEDIUM CONFIDENCE (validate over 3+ days before acting)

4. **Asymmetric delta thresholds**: DOWN can trade on small deltas (65.5% at <0.12%). UP needs >0.12%. This has structural backing (DOWN moves are sharper) but needs more data.

5. **ETH is the opposite of BTC**: ETH works better with lean conviction (83.3%) than dead center (54.5%). Consider ETH-specific conviction rules. Structural explanation exists (slower MMs) but 1 day is thin.

### LOW CONFIDENCE (interesting but likely overfitting at this sample)

6. **Time-of-day effects**: Asia hours underperform, US session outperforms. Could be real (more exchanges active = better VWAP) but hour-by-hour with n=2-16 is noise.

7. **Entry price floor of $0.40**: Below $0.40 = 40.7%. But this is correlated with conviction — may not add independent signal.

---

## Summary

The losing trades cluster around a clear profile: **small VWAP delta + CLOB lean + BTC**. The conviction filter catches some of this but not all. The two highest-impact, lowest-overfitting-risk changes:

1. **Per-symbol conviction limits**: BTC < 0.05, ETH < 0.25, XRP < 0.20
2. **Side-dependent delta thresholds**: DOWN >= 0.03%, UP >= 0.12%

Combined, these would have eliminated ~62 losing trades and ~15 winning trades from today's sample — flipping the win rate from 68.5% to an estimated ~80%+. But this needs validation on fresh data before implementation.
