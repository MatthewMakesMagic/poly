# Critical Enhancements

Required enhancements before live trading. These are fundamental safety issues that must be addressed.

---

## Polymarket Market Mechanism [REFERENCE]

**This is fundamental to all strategy design and must be understood before implementation.**

### Conditional Token Model

Polymarket uses **conditional tokens** (ERC-1155) - physical blockchain assets, NOT derivatives.

```
┌─────────────────────────────────────────────────────────────────┐
│                    POLYMARKET MARKET                            │
│                                                                 │
│   Each market has TWO separate tokens:                         │
│                                                                 │
│   ┌─────────────┐              ┌─────────────┐                 │
│   │  UP Token   │              │ DOWN Token  │                 │
│   │  (tokenId A)│              │ (tokenId B) │                 │
│   └─────────────┘              └─────────────┘                 │
│         │                            │                          │
│         │ Separate order book        │ Separate order book     │
│         │ Separate liquidity         │ Separate liquidity      │
│         ▼                            ▼                          │
│   ┌─────────────┐              ┌─────────────┐                 │
│   │ Bids  Asks  │              │ Bids  Asks  │                 │
│   │ 0.44  0.46  │              │ 0.54  0.56  │                 │
│   └─────────────┘              └─────────────┘                 │
│                                                                 │
│   At resolution: Winner pays $1.00, Loser pays $0.00           │
└─────────────────────────────────────────────────────────────────┘
```

### No Short Selling

**You can only sell tokens you physically own.** There is no margin, no borrowing, no shorting.

| Action | Requires | Result |
|--------|----------|--------|
| BUY UP | USDC balance | Receive UP tokens |
| SELL UP | **UP token balance** | Receive USDC |
| BUY DOWN | USDC balance | Receive DOWN tokens |
| SELL DOWN | **DOWN token balance** | Receive USDC |

If you try to sell tokens you don't have: `"not enough balance / allowance"` - order rejected entirely.

### Directional Betting

```
Traditional Market:               Polymarket:
─────────────────                 ────────────
Bullish = Long asset              Bullish = BUY UP token
Bearish = Short asset             Bearish = BUY DOWN token (NOT short UP)
```

To bet AGAINST an outcome, you BUY the opposite token. You do not short.

### Market Making Implications

Market makers must:

1. **Hold inventory of BOTH tokens** - Cannot quote asks without owning the tokens to sell
2. **Manage two separate order books** - UP and DOWN have independent liquidity
3. **Accept inventory risk** - If you sell all your UP tokens, you can't quote UP asks until you acquire more
4. **Price relationship** - UP + DOWN prices don't always equal $1.00 due to spreads and independent books

```
Market Maker Inventory Example:
─────────────────────────────
Holdings: 1000 UP tokens, 800 DOWN tokens

Can quote:
  UP:   Bid 0.44 (buy more)  |  Ask 0.46 (sell from inventory)
  DOWN: Bid 0.54 (buy more)  |  Ask 0.56 (sell from inventory)

If someone lifts all 1000 UP tokens:
  UP:   Bid 0.44 (buy more)  |  Ask ??? (NO INVENTORY - cannot quote)
  DOWN: Bid 0.54 (buy more)  |  Ask 0.56 (still have inventory)
```

### Strategy Design Implications

1. **Entry**: Always a BUY (either UP or DOWN token)
2. **Exit before resolution**: SELL the token you bought
3. **Hold to resolution**: Let Oracle settle - winning token pays $1, losing pays $0
4. **No hedging via shorts**: To reduce UP exposure, must SELL UP tokens (not short)
5. **Liquidity asymmetry**: UP and DOWN books may have different depth - check both

### Resolution Mechanics

At window expiry, Oracle determines outcome:

| Outcome | UP Token Value | DOWN Token Value |
|---------|---------------|------------------|
| Spot went UP | $1.00 | $0.00 |
| Spot went DOWN | $0.00 | $1.00 |

Tokens are settled automatically. No action required if holding to resolution.

---

## E1: Pre-Exit Balance Verification [CRITICAL]

**Status:** IMPLEMENTED
**Priority:** BLOCKER - Do not run live without this
**Identified:** 2026-01-31
**Implemented:** 2026-01-31

### Problem

The current exit logic trusts `position.shares` from in-memory state without verifying against the exchange before selling. This creates risk of:

1. **Wasted API calls** - Attempting to sell more shares than we hold (API rejects, but wastes time/rate limit)
2. **Double-sell attempts** - Attempting to sell after already exited (API rejects, but causes confusion)
3. **Stale state confusion** - System believes it has position when it doesn't, leading to incorrect decisions

Note: Polymarket uses conditional tokens (physical assets), NOT derivatives. You cannot short-sell or create a position by selling tokens you don't own. The API will reject with "not enough balance / allowance". However, relying on API rejection is not defense-in-depth.

### Current Behavior

```javascript
// live_trader.js:702 - Trusts memory state
const sharesToSell = position.shares;

// Immediately attempts sell without verification
let response = await this.client.sell(position.tokenId, sharesToSell, exitPrice, 'FOK');
```

**Safeguards that exist:**
- Polymarket API rejects sells exceeding balance ("not enough balance / allowance")
- Position deleted from `livePositions` after successful fill
- FOK orders are all-or-nothing

**Safeguards that are MISSING:**
- No `getBalance(tokenId)` call before exit attempt
- No comparison of expected vs actual shares before selling
- No graceful handling of already-exited state

### Required Fix

Add real-time balance verification before every exit attempt:

```javascript
async executeExit(position, reason, tick) {
    const tokenId = position.tokenId;
    const expectedShares = position.shares;

    // CRITICAL: Verify actual balance before selling
    const actualBalance = await this.client.getBalance(tokenId);

    // Case 1: Already exited (balance is 0)
    if (actualBalance === 0) {
        this.logger.warn('exit_already_complete', {
            tokenId,
            expectedShares,
            actualBalance: 0,
            reason: 'position_already_closed'
        });
        delete this.livePositions[positionKey];
        return { success: true, reason: 'already_exited' };
    }

    // Case 2: Balance mismatch (partial fill we didn't track, or sync issue)
    if (actualBalance !== expectedShares) {
        this.logger.warn('exit_balance_mismatch', {
            tokenId,
            expectedShares,
            actualBalance,
            difference: expectedShares - actualBalance
        });
        // Use actual balance, not expected
        position.shares = actualBalance;
    }

    // Case 3: Balance matches - proceed with exit
    const sharesToSell = position.shares;

    // Now safe to attempt sell
    let response = await this.client.sell(tokenId, sharesToSell, exitPrice, 'FOK');
    // ... rest of exit logic
}
```

### Implementation Location

- **Primary:** `src/execution/live_trader.js` - `executeExit()` function
- **Also consider:** `src/modules/orchestrator/execution-loop.js` if exit logic moves there

### Acceptance Criteria

1. Every exit attempt calls `getBalance(tokenId)` before placing sell order
2. If balance is 0, position is cleaned up without attempting sell
3. If balance differs from expected, warning is logged and actual balance is used
4. Balance verification latency is tracked (adds ~100ms per exit)
5. Divergence events feed into Story 5-3 divergence detection

### Dependencies

- `polymarketClient.getBalance(tokenId)` - Already implemented in Story 2-1
- Logger module - Already implemented in Story 1-4

### Risk if Not Implemented

- **Medium-High:** While Polymarket API rejects invalid sells, relying on exchange rejection is not defense-in-depth
- **Edge case:** Fast market + partial fill tracking failure + rapid exit attempts = undefined behavior
- System should KNOW its state, not discover it via API errors

---

## Monitoring Philosophy: "Silence = Trust" (Story 5.5, FR24)

**Status:** IMPLEMENTED
**Story:** 5-5-silent-operation-mode
**Requirement:** FR24 - System can operate silently when behavior matches expectations

### Philosophy

Epic 5 implements a monitoring philosophy where:

1. **Info logs** capture all trade data for post-mortem analysis
2. **Warn logs** indicate moderate divergence requiring attention
3. **Error logs** indicate severe divergence requiring immediate action
4. **No warn/error = trust** - the system is operating as expected

This approach prevents alert fatigue while ensuring:
- All trades are fully logged for later analysis
- Divergence is detected and surfaced immediately
- Normal operation doesn't interrupt the trader
- Trust is earned through demonstrated reliability

### Log Level Guidelines

| Level | Meaning | Action Required |
|-------|---------|-----------------|
| info | Normal operation | None - review later if needed |
| warn | Moderate divergence (latency, slippage) | Investigate soon |
| error | Severe divergence (size, state mismatch) | Investigate immediately |

### Querying Silent Operation

```javascript
const state = tradeEvent.getState();

if (state.divergence.silentOperationConfirmed) {
  console.log('System operating normally - all trades within expectations');
} else {
  console.log(`Divergence rate: ${(state.divergence.divergenceRate * 100).toFixed(1)}%`);
  console.log('Flag distribution:', state.divergence.flagCounts);
}
```

### Health Summary Fields

| Field | Type | Description |
|-------|------|-------------|
| `divergence.eventsWithDivergence` | number | Count of events with any divergence |
| `divergence.divergenceRate` | number | Ratio of divergent events to total (0-1) |
| `divergence.flagCounts` | object | Count per divergence flag type |
| `divergence.silentOperationConfirmed` | boolean | True when divergence rate is 0% |

### Log Level Configuration

Configure log level in `config/default.js`:

```javascript
logging: {
  level: process.env.LOG_LEVEL || 'info',  // 'info', 'warn', or 'error'
  directory: './logs',
  jsonFormat: true,
}
```

- **info**: All logs emitted (default for development)
- **warn**: Info logs suppressed, only warn/error emitted
- **error**: Only error logs emitted

**Note:** warn and error logs are NEVER suppressed regardless of config level.

### Related Stories

- **Story 5.1:** Trade event logging with expected vs actual values
- **Story 5.2:** Latency and slippage recording with thresholds
- **Story 5.3:** Divergence detection with flags
- **Story 5.4:** Divergence alerting with structured alerts
- **Story 5.5:** Silent operation mode (this enhancement)

---

## E2: Window Discovery - Connect Existing Scripts to Execution Loop [CRITICAL]

**Status:** TEMP SOLUTION IMPLEMENTED
**Priority:** BLOCKER - No trades execute without this
**Identified:** 2026-01-31
**Temp Fix:** 2026-01-31

### Problem

The execution loop passes `windows: []` to strategy evaluation, so no signals ever fire. However, the window discovery logic **already exists** in standalone scripts:

**Existing Scripts (working):**
- `scripts/crypto-15min-tracker.js` - Full window discovery + live streaming
- `scripts/discover-markets.js` - General market discovery via Gamma API

**What the scripts already do:**
```javascript
// Calculate 15-min window epochs
function get15MinWindows(count = 5) {
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / 900) * 900;
  // Returns: { epoch, startTime, endTime, startsIn, endsIn }
}

// Fetch market by slug pattern: {crypto}-updown-15m-{epoch}
async function fetchMarket(crypto, epoch) {
  const slug = `${crypto}-updown-15m-${epoch}`;
  const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
  // Returns: { upTokenId, downTokenId, upPrice, downPrice, ... }
}

// Get order book for pricing
async function fetchOrderBook(tokenId) {
  const response = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
  // Returns: { bestBid, bestAsk, spread, midpoint, ... }
}
```

**The disconnect (in execution-loop.js:168-174):**
```javascript
const marketState = {
  spot_price: spotData.price,
  // Future: Get active windows and their market prices from polymarket client
  windows: [], // <-- HARDCODED EMPTY - scripts not connected
};
```

### Required Fix

Option A: **Convert scripts to module** (recommended)
```javascript
// New: src/modules/window-manager/index.js
export async function getActiveWindows() {
  const windows = [];
  const epochs = get15MinWindows(2); // Current + next

  for (const crypto of ['btc', 'eth', 'sol', 'xrp']) {
    for (const epoch of epochs) {
      const market = await fetchMarket(crypto, epoch.epoch);
      if (market && market.active && !market.closed) {
        const book = await fetchOrderBook(market.upTokenId);
        windows.push({
          window_id: `${crypto}-15m-${epoch.epoch}`,
          market_id: market.slug,
          token_id_up: market.upTokenId,
          token_id_down: market.downTokenId,
          market_price: book?.midpoint || market.upPrice,
          time_remaining_ms: epoch.endsIn * 1000,
          crypto,
        });
      }
    }
  }
  return windows;
}
```

Option B: **Direct integration in execution loop**
```javascript
// In execution-loop.js tick()
import { get15MinWindows, fetchMarket, fetchOrderBook } from '../scripts/crypto-15min-tracker.js';

const windows = await getActiveWindows(); // Call new helper
const marketState = {
  spot_price: spotData.price,
  windows, // NOW POPULATED
};
```

### Why Tests Pass But Live Fails

Tests mock windows with hardcoded data:
```javascript
// In tests - provides fake windows
evaluateEntryConditions({
  windows: [{ window_id: 'test', market_price: 0.80 }]
});

// In production - empty array
evaluateEntryConditions({
  windows: [] // From hardcoded empty array
});
```

### Multi-Exchange Discovery (Reference)

The spot client already supports multiple sources for reference prices:
- **Pyth Network** - Primary oracle feed (implemented)
- **Chainlink** - Alternative oracle (normalizer ready)
- **Binance WebSocket** - Exchange spot prices (used in tracker script)

Spot price normalization in `src/clients/spot/normalizer.js` handles format differences.

### Files Involved

| File | Role | Status |
|------|------|--------|
| `scripts/crypto-15min-tracker.js` | Window discovery logic | ✅ Working standalone |
| `scripts/discover-markets.js` | Market discovery | ✅ Working standalone |
| `src/modules/orchestrator/execution-loop.js:171` | Needs windows | ❌ Hardcoded empty |
| `src/clients/spot/normalizer.js` | Multi-source normalization | ✅ Ready |
| `src/modules/window-manager/` | Should exist | ✅ TEMP Created |

### TEMP Solution Implemented

Created `src/modules/window-manager/` module that:
- Wraps logic from `scripts/crypto-15min-tracker.js`
- Fetches active windows via REST API (with 5-second caching)
- Integrated into orchestrator initialization
- Called from execution loop each tick

**Limitations of TEMP solution:**
- REST polling instead of WebSocket (higher latency)
- Simple caching (may miss rapid price changes)
- No rate limiting protection
- Fetches all cryptos each tick (could be optimized)

**Production solution should:**
- Use WebSocket subscriptions for real-time book updates
- Implement proper rate limiting
- Cache at window level (not global)
- Only fetch cryptos with active strategies

### Acceptance Criteria

1. Execution loop receives populated `windows[]` array each tick
2. Windows include: window_id, market_id, token_ids, market_price, time_remaining_ms
3. Strategy evaluator processes windows and generates entry signals
4. System logs window discovery results (count, cryptos, epochs)
5. Graceful handling when no markets exist for current epoch

### Risk if Not Implemented

- **CRITICAL:** No trades will ever execute
- All unit tests pass but system is non-functional
- Strategies evaluate against empty array → no signals → no orders

---

## Future Enhancements

(Add additional enhancements here as identified)

---

## Enhancement Status Key

| Status | Meaning |
|--------|---------|
| NOT IMPLEMENTED | Enhancement identified but not started |
| IN PROGRESS | Currently being implemented |
| IMPLEMENTED | Code complete, needs testing |
| VERIFIED | Tested and confirmed working |
| DEPLOYED | In production |
