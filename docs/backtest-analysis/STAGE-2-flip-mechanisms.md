# Stage 2: Flip Mechanism Analysis

**Date:** 2026-03-03
**Scope:** 38 onchain-verified BTC flips (where CLOB was 80/20+ confident at T-60s and resolution went the other way)

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total flips analyzed | 38 |
| With CL price data | 34 |
| CLOB self-corrected by T-1s | 30/34 (88%) |
| CLOB still wrong at T-1s | 4/34 (12%) |
| CL direction correct at T-60 | 0/25 (0%) |

---

## Mechanism Category 1: Noise Flips — 15 of 38 (39%)

**CL move < $10 on a ~$66K asset (< 0.015%)**

The market was 80/20 confident about a direction that was decided by sub-$10 CL movements. At BTC ~$66K, that's noise — a random walk within the CL VWAP smoothing window.

Key characteristics:
- CL@close vs CL@open difference is smaller than the CL VWAP update interval precision
- In ~10 of these, our captured `CL@close` actually points the WRONG way vs onchain resolution (timing imprecision — the exact settlement used a slightly different CL value)
- CLOB self-corrected in most cases, suggesting MMs eventually realized the move was razor-thin
- 2 cases where CLOB never corrected (it stayed 80/20 wrong)

Examples:
- `2026-02-15T03:15` — CL move: -$0.74. Market at 0.90 UP, resolved DOWN. Sub-dollar CL move decided it.
- `2026-02-28T03:00` — CL move: -$0.23. Market at 0.855 UP, resolved DOWN. Twenty-three cents.
- `2026-02-22T19:30` — CL move: -$1.35. Market at 0.155 UP (85% DOWN), resolved UP.

**Implication**: The market systematically overprices confidence when CL is near the strike. When 80/20 confident, 39% of flips are literally noise. No strategy can trade these profitably because the outcome is decided by sub-second VWAP timing.

---

## Mechanism Category 2: Small Reversal — 13 of 38 (34%)

**CL move $10-$30 (0.015% - 0.045%)**

Real but small price movements in the final 60 seconds. These represent genuine directional changes where the market's confidence at T-60 was wrong.

Key characteristics:
- CL moves from $10-$30 — enough to be real but still within normal BTC 1-minute noise
- CLOB almost always self-corrects (12/13 corrected by T-1)
- Information cascade varies — sometimes EX leads, sometimes CL leads, sometimes CLOB leads

Information leaders:
- CL first: 7 cases — oracle moved before CLOB repriced
- CLOB first: 3 cases — MMs predicted the move before CL confirmed
- EX first: 3 cases — exchange prices moved first

Examples:
- `2026-02-13T17:15` — CL +$14.61. CLOB went from 0.02 to 0.775 in 60s. Exchanges led at T-10.
- `2026-02-26T01:45` — CL -$24.38. CLOB 0.975 at T-60, 0.180 at T-1. CL led at T-1.
- `2026-02-22T08:45` — CL +$17.37. CLOB corrected from 0.875 to 0.150. CL never showed correct direction in our sampling (timing issue).

**Implication**: These are tradeable in theory — the move is real and CLOB self-corrects. But the signal comes late (mostly T-30 or later) and would require very fast execution.

---

## Mechanism Category 3: Large Moves — 6 of 38 (16%)

**CL move $30-$170 (0.045% - 0.25%)**

Significant price movements in the final 60 seconds. These are real market events.

Key characteristics:
- These are genuine price reversals driven by market-wide moves
- Exchanges lead or co-lead in most cases
- CLOB self-corrects quickly (all 5 with data corrected by T-1)
- The $168.82 move is the largest — exchanges started dropping at T-30

Examples:
- `2026-02-13T22:15` — CL -$168.82. Massive drop. Exchanges moved at T-30, CLOB followed.
- `2026-02-26T12:45` — CL -$54.71. CLOB went from 0.965 to 0.002 in 60 seconds.
- `2026-03-01T06:30` — CL +$67.36 (UP direction but resolved DOWN — timing issue). Late spike followed by correction.

**Implication**: Highest signal but rarest. Exchange divergence from CL at T-30 is a potential signal.

---

## Mechanism Category 4: No CL Data — 4 of 38 (11%)

Early windows (Feb 12-13) before RTDS capture started. CLOB data present but no oracle/exchange comparison possible.

---

## Information Cascade: Who Knew First?

For the 34 flips with data:

| First to show correct direction | Count | Pct |
|-------------------------------|-------|-----|
| CL (Chainlink oracle) | 13 | 38% |
| CLOB (market makers) | 11 | 32% |
| EX (exchanges) | 8 | 24% |
| Nobody (never corrected) | 2 | 6% |

**Key insight**: There's no single dominant information source. The cascade is messy:
- Sometimes exchanges move first (large moves, news)
- Sometimes CLOB leads (MMs predicting VWAP from their own models)
- Sometimes CL leads (VWAP shifts while CLOB hasn't repriced)

---

## The "CL Moved But Resolved Opposite" Anomaly

In ~10 of 34 cases, our captured `CL@close - CL@open` direction **disagrees** with onchain resolution. This matches the 3.3% CL formula disagreement from Stage 1.

All of these are tiny CL moves (< $20). The explanation:
- Onchain resolution uses the **exact** CL value at the **exact** settlement timestamp
- Our `CL@close` capture has timing imprecision of a few seconds
- For moves under $20, a 1-2 second difference in capture time changes which side of `CL@open` the value falls on
- These are literally decided by sub-second VWAP fluctuations

---

## Key Takeaways for Strategy

1. **~40% of flips are pure noise** — the CLOB was 80/20 on a coin flip. No strategy can trade these.

2. **CLOB self-corrects 88% of the time** — but often only by T-5 or T-1. The correction happens too late for most strategies.

3. **Exchange divergence at T-30 is the strongest early signal** for large moves — but large moves are only 16% of flips.

4. **The market is systematically overconfident** when CL is near the strike. An 80/20 CLOB implies 20% flip risk, but the actual flip rate varies by HOW the move size:
   - Tiny moves: essentially 50/50 but CLOB prices 80/20
   - Small moves: genuine but hard to trade in time
   - Large moves: detectable but rare

5. **The most promising angle** isn't trading flips directly — it's understanding that when the CLOB is 80/20 and the underlying CL move is tiny, the market is systematically mispriced. The question becomes: can you DETECT tiny CL moves before settlement?

---

## What's Not Yet Done

- [ ] Sub-second exchange analysis (our sampling is at T-60/30/10/5/1 — need finer grain)
- [ ] L2 book depth analysis (bid_size_top/ask_size_top at all offsets)
- [ ] CL VWAP prediction model (exchange prices → predicted CL direction)
- [ ] Cross-window correlation (do flips cluster in time? news events?)
- [ ] ETH/SOL/XRP flip analysis (BTC only so far)
