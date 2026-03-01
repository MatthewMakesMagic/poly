# Oracle Resolution Gap Analysis & Proposed Solution

## The Problem

Our `oracle_price_at_close` does not match Polymarket's actual settlement price. This was proven on Feb 28 2026 when:
- **ETH** (10:15-10:30 PM): We captured CL@close = $1,928.315 < CL@open = $1,928.841 → we calculated DOWN
- **Polymarket settled UP** — meaning the actual CL@close was ≥ CL@open
- Our DB has `onchain_resolved_direction = NULL` for this window — the ground truth check isn't working

This means **every resolution in our backtests could be wrong** for windows where the price is near strike.

## Root Causes (3 layers)

### 1. Stale Oracle Price at Capture (Immediate Cause)

**File:** `src/modules/window-close-event-recorder/index.js:492`

At window close, we call `rtdsClient.getCurrentPrice(symbol, CRYPTO_PRICES_CHAINLINK)` which returns **the latest cached WebSocket tick** — NOT the oracle price at the exact settlement moment.

- Chainlink Data Streams publishes at ~0.5-2s intervals
- If the last CL tick arrived 1.5s before our capture, we're using a stale price
- A final oracle update arriving between our capture and actual settlement can flip the direction
- For ETH at $0.44 from strike, a single late update of $0.53 flips UP→DOWN or vice versa

### 2. On-Chain Resolution Check Not Working (Missing Ground Truth)

**File:** `src/modules/window-close-event-recorder/index.js:583-589`

The `scheduleOnchainResolutionCheck()` requires a `conditionId` from the Gamma API. If it's null, the check is skipped entirely:

```javascript
if (!capture.conditionId) {
    log.warn('onchain_check_skipped_no_condition_id', { ... });
    cleanupCapture(capture.windowId);
    return; // EXITS — no on-chain check ever happens
}
```

**Why conditionId is often null:**
- Fetched from Gamma API during the window via `fetchMarket()` (window-manager)
- Race condition: Gamma API may not have the market ready when we query
- No retry logic if the first fetch fails — we never try again
- Result: many windows have no conditionId → no on-chain check → `onchain_resolved_direction` stays NULL

### 3. No Query of Polymarket's Authoritative Resolution (Architectural Gap)

We never query Polymarket's own settlement state after the market resolves:
- No Gamma API query for `market.resolved` / `market.resolutionDirection`
- No CLOB query for final token prices ($0.99/$0.01 post-settlement)
- No event listener for CTF `ResolutionSet` events on Polygon
- No "ground truth" validation loop at all

## Timing Diagram

```
T-90s    Capture begins, schedules timers
T-5s     Capture oracle prices at various offsets (60s, 30s, 10s, 5s, 1s)
T=0      Window close time
         ├── OUR CAPTURE: rtdsClient.getCurrentPrice() → last RTDS tick (may be 0-3s old)
         ├── ACTUAL SETTLEMENT: Chainlink Data Streams snapshot at exact T=0
         └── GAP: 0-3s of oracle updates we miss
T+0-3s   Final CL update arrives in our RTDS feed (TOO LATE — we already captured)
T+55s    Polymarket may batch-settle on-chain
T+60s    Our on-chain check starts (if conditionId exists)
T+180s   We give up on on-chain check
```

## Impact on Backtests

From MEMORY.md: "Verified 129/129 (100%) match with post-resolution CLOB ground truth"

That 100% match was against CLOB ground truth, which may ALSO be slightly off for the same reason — both use RTDS feeds, not the actual on-chain settlement. The true error rate is unknown but likely affects windows where price is within ~0.05% of strike (which is a significant fraction of all windows, and exactly the ones our strategy targets).

## Proposed Solutions

### Solution A: Post-Settlement Gamma API Query (Recommended — Easiest, Most Reliable)

After each window closes, query the Gamma API 2-3 minutes later to get the actual market resolution:

```javascript
// T+120s after window close
async function fetchActualResolution(slug) {
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const market = response.json()[0];
    // market.resolved = true/false
    // market.outcome = "Up" or "Down"
    // market.resolutionSource = the actual price used
    return {
        resolved: market.resolved,
        direction: market.outcome?.toLowerCase(),
        source: 'gamma_api'
    };
}
```

**Pros:**
- Uses Polymarket's own authoritative answer — guaranteed correct
- Simple to implement — just an HTTP GET
- No blockchain interaction needed
- Can backfill all historical windows

**Cons:**
- 2-3 min delay before we know actual resolution
- Gamma API rate limits / availability
- Depends on Polymarket's API staying stable

### Solution B: Post-Settlement CLOB Token Price Check

After window close, check the CLOB price of the UP token:
- If UP token → $0.99+: resolved UP
- If UP token → $0.01-: resolved DOWN

```javascript
// T+60s — check final token prices
const upTokenPrice = await clobClient.getPrice(upTokenId);
if (upTokenPrice > 0.90) return 'up';
if (upTokenPrice < 0.10) return 'down';
return 'pending'; // retry
```

**Pros:**
- Uses CLOB data we already have access to
- Fast — CLOB reprices within seconds of settlement
- No new API dependency

**Cons:**
- Token prices near 0.90/0.10 during unsettled period could give false signal
- CLOB may not have the token listed if market is already settled/delisted

### Solution C: On-Chain CTF Event Listener (Most Robust, Most Complex)

Listen for `ConditionResolution` events on the CTF contract on Polygon:

```javascript
// Subscribe to CTF events
const filter = ctfContract.filters.ConditionResolution(conditionId);
ctfContract.on(filter, (conditionId, oracle, questionId, outcomeSlotCount, payoutNumerators) => {
    const direction = payoutNumerators[0] > 0 ? 'up' : 'down';
    updateResolution(windowId, direction);
});
```

**Pros:**
- Direct on-chain truth — cannot be wrong
- Real-time notification of settlement
- Works even if Gamma API is down

**Cons:**
- Requires Polygon RPC WebSocket subscription
- Need conditionId (which we often don't have)
- More infrastructure to maintain

### Solution D: Fix the Oracle Capture Timing (Complementary)

Instead of reading `getCurrentPrice()` at T=0, buffer the last N seconds of CL ticks and use the one closest to T=0:

```javascript
// In RTDS client: maintain a 10-second ring buffer per symbol
this.priceBuffer[symbol].push({ price, timestamp });

// At capture time: find the tick closest to window close time
getClosestPrice(symbol, targetTimestamp) {
    return this.priceBuffer[symbol]
        .filter(t => Math.abs(t.timestamp - targetTimestamp) < 3000)
        .sort((a, b) => Math.abs(a.timestamp - targetTimestamp) - Math.abs(b.timestamp - targetTimestamp))[0];
}
```

**Pros:**
- Better capture accuracy even without post-settlement check
- Useful for pre-settlement probability calculations
- Low complexity

**Cons:**
- Still won't perfectly match if CL updates at a sub-second boundary we don't see
- Doesn't solve the ground truth problem — just reduces the gap

## Recommended Implementation Order

1. **Solution A (Gamma API)** — implement first, backfill all historical windows. This gives us ground truth for every market.
2. **Solution D (Buffer)** — implement second, improves real-time capture accuracy for the probability model and pre-settlement decisions.
3. **Solution B (CLOB check)** — implement as fast fallback when Gamma API is slow/unavailable.
4. **Solution C (On-chain)** — implement last, only if we need sub-60s ground truth.

## Immediate Action Items

1. **Backfill all windows using Gamma API** — query `market.outcome` for every window in our DB where `onchain_resolved_direction IS NULL`
2. **Compare our `resolved_direction` vs Gamma truth** — find our actual error rate
3. **Re-run paper trading analysis with corrected resolutions** — our 68.5% win rate may be different
4. **Add Gamma API resolution check to the live pipeline** — run at T+120s after every window close
