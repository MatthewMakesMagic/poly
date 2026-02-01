# Story 7.20: Per-Crypto Oracle Price in Execution Loop

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **each crypto window to use its own spot price**,
So that **signal confidence is calculated with correct oracle data**.

## Acceptance Criteria

### AC1: Per-Crypto Price Fetching
**Given** windows for multiple cryptocurrencies (BTC, ETH, SOL, XRP)
**When** the execution loop processes signals
**Then** each window receives the spot price for its specific crypto
**And** BTC windows use BTC price (~$78,438)
**And** ETH windows use ETH price (~$2,400)
**And** SOL windows use SOL price (~$100)
**And** XRP windows use XRP price (~$1.60)

### AC2: Price Data Structure
**Given** active windows are loaded
**When** building market state for strategy evaluation
**Then** `spotPrices` object contains prices keyed by crypto symbol
**And** each window's signal includes its correct spot_price
**And** logging clearly shows which price was used per window

### AC3: Signal Correctness
**Given** an ETH window is being evaluated
**When** the strategy calculates confidence
**Then** confidence is based on ETH price vs ETH oracle price
**And** confidence is NOT based on BTC price
**And** false 100% confidence signals are prevented

### AC4: Backward Compatibility
**Given** the existing execution loop interface
**When** the fix is applied
**Then** existing strategy modules continue to work
**And** no changes required to strategy-evaluator interface
**And** logging format remains compatible with Scout

## Tasks / Subtasks

- [x] **Task 1: Modify spot price fetching logic** (AC: 1, 2)
  - [x] Change line ~183 to extract unique cryptos from windows
  - [x] Create `spotPrices` object with per-crypto prices
  - [x] Add null/error handling for each crypto fetch
  - [x] Log which prices were fetched successfully

- [x] **Task 2: Update market state construction** (AC: 2, 3)
  - [x] Pass `spotPrices` map to strategy evaluation
  - [x] Ensure each window can access its crypto's price
  - [x] Update `marketState.spot_price` to be window-specific

- [x] **Task 3: Update signal logging** (AC: 2, 4)
  - [x] Include crypto symbol and spot_price per signal
  - [x] Add price source to tick_complete logging
  - [x] Ensure Scout can parse the updated log format

- [x] **Task 4: Write unit tests** (AC: 1-4)
  - [x] Test multi-crypto price fetching
  - [x] Test correct price assignment per window
  - [x] Test error handling when one crypto fails
  - [x] Test backward compatibility with existing interface

## Dev Notes

### Root Cause of Bug

**Location:** `src/modules/orchestrator/execution-loop.js:183`

**Original Problematic Code:**
```javascript
// 2. Fetch current spot prices
let spotData = null;
if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
  // Get BTC price as the primary reference
  spotData = this.modules.spot.getCurrentPrice('btc');
}
```

**Problem:** This fetches BTC price for ALL windows regardless of which cryptocurrency (ETH, SOL, XRP) they are trading. When an ETH window at $2,400 receives BTC price of $78,438, the confidence calculation becomes wildly incorrect.

**Impact:** ~$90 USD production loss due to false confidence signals causing multiple erroneous trades.

### Correct Implementation Pattern

**NEW code structure:**
```javascript
// 2. Fetch current spot prices for all active cryptos
let spotPrices = {};
if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
  // Get unique cryptos from windows
  const cryptos = [...new Set(windows.map(w => w.crypto))];

  for (const crypto of cryptos) {
    try {
      const priceData = this.modules.spot.getCurrentPrice(crypto);
      if (priceData) {
        spotPrices[crypto] = priceData;
      }
    } catch (err) {
      this.log.warn('spot_price_fetch_failed', {
        crypto,
        error: err.message,
      });
    }
  }

  this.log.debug('spot_prices_loaded', {
    cryptos: Object.keys(spotPrices),
    prices: Object.fromEntries(
      Object.entries(spotPrices).map(([k, v]) => [k, v?.price])
    ),
  });
}
```

### Files to Modify

| File | Change |
|------|--------|
| `src/modules/orchestrator/execution-loop.js` | Per-crypto price fetching, market state update |

### Spot Client Interface Reference

**Location:** `src/clients/spot/index.js`

**`getCurrentPrice(crypto)` method:**
- Accepts: `crypto` - symbol string (btc, eth, sol, xrp)
- Returns: `{ price, timestamp, source, staleness, raw }` or null
- Throws: `SpotClientError` if not initialized or invalid crypto

**Supported Cryptos:** btc, eth, sol, xrp (per `SUPPORTED_CRYPTOS` constant)

### Window Data Structure Reference

Windows contain a `crypto` field indicating the cryptocurrency:
```javascript
{
  id: 'eth-15m-1769949000',
  crypto: 'eth',           // <-- Use this for price lookup
  market_id: '...',
  token_id: '...',
  // ...
}
```

### Market State Update

**Current (WRONG):**
```javascript
const marketState = {
  spot_price: spotData.price,  // BTC price for all windows!
  windows,
};
```

**Fixed:**
```javascript
const marketState = {
  spotPrices,  // { btc: {...}, eth: {...}, sol: {...}, xrp: {...} }
  windows,
  // Individual window evaluation uses: spotPrices[window.crypto]
};
```

### Strategy Evaluator Compatibility

The strategy-evaluator module expects `marketState.spot_price`. Two options:

1. **Per-window evaluation:** Modify strategy-evaluator to accept spotPrices map
2. **Loop-level fix:** Pass correct price per window in evaluation loop

**Recommended:** Option 2 - Modify execution loop to pass correct price per window:
```javascript
for (const window of windows) {
  const windowSpotPrice = spotPrices[window.crypto]?.price;
  const singleWindowState = {
    spot_price: windowSpotPrice,
    windows: [window],
  };
  // Evaluate single window with correct price
}
```

### Testing Strategy

1. **Unit Tests:** Mock spot client with different prices per crypto
2. **Integration Tests:** Verify correct price flows to signals
3. **Regression Tests:** Ensure existing BTC-only scenarios work

### Related Stories

| Story | Relationship |
|-------|--------------|
| 7-19 | Cross-module integration tests (catches this class of bug) |
| 8-8 | Live trading gate (prevents production damage during bugs) |
| 8-9 | One trade per window (prevents duplicate entries) |
| 7-1 | RTDS WebSocket client (alternative price source) |

### Previous Story Intelligence (7-12)

From Story 7-12 Strategy Composition Integration:
- Standard module interface patterns (`init`, `getState`, `shutdown`)
- Component evaluation receives market context
- Strategy execution receives marketState object

### Project Structure Notes

- Module location: `src/modules/orchestrator/`
- Test location: `src/modules/orchestrator/__tests__/`
- Follows existing naming conventions (kebab-case files)
- Uses standard logging format with module identifier

### Configuration

No new configuration required. Uses existing spot client configuration for all supported cryptos.

### Error Handling

**Scenario:** One crypto price fails to fetch
**Behavior:** Log warning, continue with available prices, skip windows for missing crypto
**Rationale:** Partial operation is better than complete failure

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-02-01-safeguards.md#Story 7-20]
- [Source: _bmad-output/planning-artifacts/architecture.md#Module Interface Contract]
- [Source: src/modules/orchestrator/execution-loop.js:183 - Bug location]
- [Source: src/clients/spot/index.js - Spot client interface]

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - implementation was straightforward

### Completion Notes List

- **Task 1 Complete**: Refactored execution-loop.js to fetch windows BEFORE spot prices, then fetch per-crypto spot prices based on unique cryptos in active windows. Added graceful error handling that logs warnings per-crypto instead of failing the entire tick.
- **Task 2 Complete**: Updated marketState to include `spotPrices` map keyed by crypto symbol (e.g., `{btc: {price: 78438, ...}, eth: {price: 2400, ...}}`). Maintains backward compatibility with `spot_price` for existing code.
- **Task 3 Complete**: Added `spot_prices_loaded` debug log with all fetched cryptos and prices. Updated `tick_complete` log to include `spotPrices` object for multi-asset tracking.
- **Task 4 Complete**: Added 6 new unit tests for Story 7-20 in execution-loop.test.js covering multi-crypto fetching, correct price assignment, error handling, and deduplication. Updated existing tests for new behavior. Fixed integration tests to include window data for proper flow.
- **All 2983 tests pass** including 96 orchestrator tests and all integration tests.

### File List

- `src/modules/orchestrator/execution-loop.js` - Modified: Per-crypto spot price fetching, marketState includes spotPrices map
- `src/modules/orchestrator/__tests__/execution-loop.test.js` - Modified: Added 6 new tests for Story 7-20, updated existing mocks
- `__tests__/integration/trading-mode.test.js` - Modified: Updated mock window-manager to return BTC window for proper flow
- `__tests__/integration/safeguards-flow.test.js` - Modified: Updated mock window-manager to return BTC window for proper flow

### Change Log

- 2026-02-01: Story 7-20 implementation complete - Per-crypto oracle price fix prevents false confidence signals
