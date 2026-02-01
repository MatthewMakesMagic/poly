# Story 7.19: Cross-Module Integration Tests

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **integration tests that verify modules work together with real data**,
So that **data contract mismatches are caught before production**.

## Acceptance Criteria

### AC1: Data Contract Tests
**Given** modules that exchange data (e.g., execution-loop → strategy-evaluator, spot-client → execution-loop)
**When** integration tests run
**Then** field names and data structures are verified to match between producing and consuming modules
**And** type mismatches, missing fields, and incorrect formats are detected

### AC2: Flow Tests
**Given** the execution loop processing a tick
**When** integration tests run the full signal generation flow
**Then** correct module calls happen in correct order (window-manager → spot → strategy-evaluator → safeguards → order-manager)
**And** data flows correctly between each module transition
**And** no hardcoded test data bypasses real module interactions

### AC3: Multi-Crypto Tests
**Given** windows for multiple cryptocurrencies (BTC, ETH, SOL, XRP)
**When** integration tests process windows for each crypto
**Then** each crypto uses its own spot price from the spot client
**And** BTC windows receive BTC price (~$78,438 range)
**And** ETH windows receive ETH price (~$2,400 range)
**And** no crypto receives another crypto's price (the bug that caused ~$90 loss)

### AC4: Safeguard Invocation Tests
**Given** signals generated for entry
**When** integration tests run the execution flow
**Then** safeguards.canEnterPosition() is actually invoked with real signal data
**And** safeguards.reserveEntry() is called before order placement
**And** safeguards.confirmEntry() is called after successful order
**And** duplicate entries to same {window_id, strategy_id} are blocked

### AC5: Mode Tests
**Given** PAPER and LIVE trading modes
**When** integration tests exercise both modes
**Then** PAPER mode blocks order placement but records entries
**And** LIVE mode places orders and records entries
**And** trading_mode field appears correctly in all relevant logs

## Tasks / Subtasks

- [x] **Task 1: Create integration test infrastructure** (AC: All)
  - [x] Create `__tests__/integration/execution-flow.test.js`
  - [x] Set up test fixtures for windows, signals, and positions
  - [x] Create helper functions for common test scenarios
  - [x] Use real module instances with minimal mocking

- [x] **Task 2: Implement Data Contract Tests** (AC: 1)
  - [x] Test: execution-loop passes correct structure to strategy-evaluator
  - [x] Test: spot client returns correct structure consumed by execution-loop
  - [x] Test: signal structure matches what safeguards expects
  - [x] Test: window structure includes required crypto field
  - [x] Test: marketState structure includes spotPrices map

- [x] **Task 3: Implement Flow Tests** (AC: 2)
  - [x] Test: Full tick flow from window fetch through signal generation
  - [x] Test: Module call order verification (capture and assert call sequence)
  - [x] Test: Data transformation at each step is correct
  - [x] Test: Error in one module properly propagates/handles

- [x] **Task 4: Implement Multi-Crypto Tests** (AC: 3)
  - [x] Test: BTC window receives BTC spot price
  - [x] Test: ETH window receives ETH spot price
  - [x] Test: SOL window receives SOL spot price
  - [x] Test: XRP window receives XRP spot price
  - [x] Test: Mixed windows each receive correct crypto price
  - [x] Test: spotPrices map keyed by crypto symbol is correct

- [x] **Task 5: Implement Safeguard Invocation Tests** (AC: 4)
  - [x] Test: canEnterPosition called with actual signal data
  - [x] Test: reserveEntry blocks concurrent duplicate signals
  - [x] Test: confirmEntry called after successful order
  - [x] Test: releaseEntry called on order failure
  - [x] Test: Strategy-aware tracking works correctly

- [x] **Task 6: Implement Mode Tests** (AC: 5)
  - [x] Test: PAPER mode does not call order-manager.placeOrder
  - [x] Test: PAPER mode calls safeguards.confirmEntry
  - [x] Test: LIVE mode calls order-manager.placeOrder
  - [x] Test: trading_mode appears in paper_mode_signal logs
  - [x] Test: trading_mode appears in order_placed logs

- [x] **Task 7: CI Integration** (AC: All)
  - [x] Ensure tests run as part of `npm test`
  - [x] Add test script for integration tests only: `npm run test:integration`
  - [x] Document test running in README or TESTING.md (in test file header comments)

## Dev Notes

### Root Cause Context

**This story was created in response to a ~$90 USD production loss caused by:**

1. **Wrong Oracle Price Bug** (`execution-loop.js:183`): Called `getCurrentPrice('btc')` for ALL crypto windows. ETH/SOL/XRP windows received BTC price (~$78,438) instead of their actual prices (~$2,400/$100/$1.60), causing 100% false confidence signals.

2. **Duplicate Entry Bug**: Safeguards failed to block re-entry to the same window, allowing 8+ ETH entries and 5+ XRP entries to the same window_id.

**The critical insight:** 2,936 unit tests passed but production failed. Tests mocked everything - they verified isolated components work correctly but never tested that components work together with real data.

### Integration Testing Philosophy

**The purpose of these integration tests is NOT to mock everything.** The purpose is to:

1. Use **real module instances** wherever possible
2. Only mock **external dependencies** (APIs, databases)
3. Verify **data contracts** between modules actually match
4. Catch **variable naming mismatches** and **structure changes**
5. Test **the actual flow** that happens in production

### Key Data Contracts to Test

**1. Window Structure** (window-manager → execution-loop):
```javascript
{
  id: 'btc-15m-1769949000',      // CRITICAL: format matters
  crypto: 'btc',                  // CRITICAL: used for spot price lookup
  market_id: 'market-uuid',
  token_id: 'token-uuid',
  expiry: 1769949900000,
  strike: 0.50,
  // ... other fields
}
```

**2. Spot Price Structure** (spot-client → execution-loop):
```javascript
{
  price: 78438.50,
  timestamp: 1738425600000,
  source: 'binance',
  staleness: 0,
  raw: { /* raw API response */ }
}
```

**3. spotPrices Map** (Story 7-20 - execution-loop internal):
```javascript
{
  btc: { price: 78438.50, ... },
  eth: { price: 2400.00, ... },
  sol: { price: 100.00, ... },
  xrp: { price: 1.60, ... }
}
```

**4. Signal Structure** (strategy-evaluator → execution-loop → safeguards):
```javascript
{
  window_id: 'btc-15m-1769949000',
  token_id: 'token-uuid',
  market_id: 'market-uuid',
  direction: 'long',             // 'long' or 'short'
  confidence: 0.85,
  price: 0.55,                   // market price
  market_price: 0.55,
  expected_price: 0.55,
  symbol: 'BTC',                 // CRITICAL: uppercase
  strategy_id: 'oracle-edge',    // CRITICAL: for strategy-aware safeguards
}
```

### Existing Integration Test Patterns

Reference existing tests for patterns:

**Location:** `__tests__/integration/trading-mode.test.js`
- Uses `ExecutionLoop` class directly
- Creates mock modules with `vi.fn()` for callbacks
- Uses `vi.useFakeTimers()` for timing control
- Tests both PAPER and LIVE modes
- Verifies log output with `mockLogger.info.mock.calls.filter()`

**Location:** `__tests__/integration/safeguards-flow.test.js`
- Uses real `safeguards` module (imported directly)
- Tests reserve/confirm/release flow
- Tests strategy-aware duplicate prevention
- Tests position initialization

### Module Locations

| Module | Location | Key Functions to Test |
|--------|----------|----------------------|
| execution-loop | `src/modules/orchestrator/execution-loop.js` | `_onTick()` |
| safeguards | `src/modules/position-manager/safeguards.js` | `canEnterPosition()`, `reserveEntry()`, `confirmEntry()` |
| spot client | `src/clients/spot/index.js` | `getCurrentPrice(crypto)` |
| window-manager | `src/modules/window-manager/index.js` | `getActiveWindows()` |
| strategy-evaluator | `src/modules/strategy-evaluator/index.js` | `evaluateEntryConditions(marketState)` |
| order-manager | `src/modules/order-manager/index.js` | `placeOrder(params)` |

### Test File Structure

```
__tests__/
└── integration/
    ├── trading-mode.test.js       # Story 8-8 (existing)
    ├── safeguards-flow.test.js    # Story 8-9 (existing)
    └── execution-flow.test.js     # Story 7-19 (NEW - this story)
```

### Test Implementation Approach

**For Data Contract Tests (AC1):**
```javascript
// Use real-ish modules but spy on inputs/outputs
const spotClient = {
  getCurrentPrice: vi.fn((crypto) => {
    // Return valid structure for each crypto
    return { price: PRICES[crypto], timestamp: Date.now(), source: 'test' };
  }),
};

// Verify execution-loop passes correct crypto to spot client
expect(spotClient.getCurrentPrice).toHaveBeenCalledWith('eth');  // Not 'btc'!
```

**For Flow Tests (AC2):**
```javascript
// Track call order
const callOrder = [];
const mockModules = {
  'window-manager': {
    getActiveWindows: vi.fn(() => { callOrder.push('windows'); return windows; }),
  },
  spot: {
    getCurrentPrice: vi.fn((c) => { callOrder.push(`spot:${c}`); return price; }),
  },
  // ... etc
};

// After tick, verify order
expect(callOrder).toEqual(['windows', 'spot:btc', 'spot:eth', 'strategy', ...]);
```

**For Multi-Crypto Tests (AC3):**
```javascript
const windows = [
  { id: 'btc-15m-test', crypto: 'btc', ... },
  { id: 'eth-15m-test', crypto: 'eth', ... },
  { id: 'sol-15m-test', crypto: 'sol', ... },
];

// Verify each crypto's price was fetched
expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');
expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('eth');
expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('sol');

// Verify marketState.spotPrices has correct values
expect(strategyEvaluator.evaluateEntryConditions).toHaveBeenCalledWith(
  expect.objectContaining({
    spotPrices: {
      btc: expect.objectContaining({ price: 78438 }),
      eth: expect.objectContaining({ price: 2400 }),
      sol: expect.objectContaining({ price: 100 }),
    }
  })
);
```

### Related Stories

| Story | Status | Relationship |
|-------|--------|--------------|
| 7-20 | review | Per-crypto oracle price fix (the actual bug fix) |
| 8-8 | review | Live trading gate (prevents production damage) |
| 8-9 | review | One trade per window safeguard (duplicate prevention) |

### Previous Story Intelligence (7-12)

From Story 7-12 (Strategy Composition Integration):
- Component adapter pattern for wrapping modules
- Strategy pipeline: data sources → analysis → signal generation → execution
- Config-driven strategy selection
- Backtest capability patterns

### Architecture Compliance

- **Test location**: `__tests__/integration/` per existing pattern
- **Test framework**: Vitest (existing - see package.json)
- **Naming**: kebab-case for files, describe/it blocks match AC numbers
- **Mocking**: Minimal - prefer real module instances
- **Logging**: Use mock logger to verify log output

### Project Structure Notes

- Tests should be added to `__tests__/integration/` directory
- Use Vitest framework (already configured in project)
- Follow patterns from existing integration tests
- Test file naming: `execution-flow.test.js`

### Configuration

No new configuration required. Tests use existing test configuration.

### Success Criteria

After implementing these tests:
1. **Data contract mismatches** like Story 7-20's bug would be caught in CI
2. **Safeguard bypass** like the duplicate entry bug would be caught in CI
3. **Module integration failures** would be caught before production
4. **Developers** can run integration tests to verify cross-module behavior

### Testing Commands

```bash
# Run all tests (including integration)
npm test

# Run integration tests only (if script added)
npm run test:integration

# Run specific test file
npx vitest run __tests__/integration/execution-flow.test.js
```

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-02-01-safeguards.md#Story-7-19]
- [Source: _bmad-output/implementation-artifacts/8-8-live-trading-gate.md] - Trading mode testing patterns
- [Source: _bmad-output/implementation-artifacts/8-9-one-trade-per-window-safeguard.md] - Safeguards testing patterns
- [Source: _bmad-output/implementation-artifacts/7-20-per-crypto-oracle-price-fix.md] - The bug this story prevents
- [Source: __tests__/integration/trading-mode.test.js] - Existing integration test patterns
- [Source: __tests__/integration/safeguards-flow.test.js] - Existing integration test patterns
- [Source: src/modules/orchestrator/execution-loop.js:179-224] - Per-crypto price fetching (Story 7-20)
- [Source: src/modules/position-manager/safeguards.js] - Safeguard module interface

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Test run: 32 tests in execution-flow.test.js passed
- Full suite: 3,015 tests passed with no regressions
- Integration tests: 123 tests passed via `npm run test:integration`

### Completion Notes List

1. **Task 1 Complete**: Created `__tests__/integration/execution-flow.test.js` with comprehensive test infrastructure including:
   - Realistic test fixtures matching production data structures (SPOT_PRICES, createWindow, createSignal)
   - Mock module factories with call tracking for contract verification
   - Uses real safeguards module with minimal external mocking

2. **Task 2 Complete (AC1)**: Implemented 5 data contract tests verifying:
   - execution-loop → strategy-evaluator marketState structure
   - spot-client return structure validation
   - signal structure matching safeguards expectations
   - window structure includes required crypto field
   - spotPrices map structure verification

3. **Task 3 Complete (AC2)**: Implemented 4 flow tests verifying:
   - Full tick flow from windows → spot → strategy
   - Module call order verification with call tracking
   - Data transformation at each step
   - Error propagation handling

4. **Task 4 Complete (AC3)**: Implemented 7 multi-crypto tests - CRITICAL for preventing the $90 bug:
   - BTC/ETH/SOL/XRP each receive correct prices
   - Mixed windows test ensures no cross-contamination
   - spotPrices map keyed correctly
   - Explicit test that no crypto receives another crypto's price

5. **Task 5 Complete (AC4)**: Implemented 6 safeguard invocation tests:
   - canEnterPosition called with actual signal data
   - reserveEntry blocks concurrent duplicates
   - confirmEntry after successful order
   - releaseEntry on order failure
   - Strategy-aware tracking (same window, different strategies allowed)
   - Duplicate entries blocked

6. **Task 6 Complete (AC5)**: Implemented 5 mode tests:
   - PAPER mode blocks order placement
   - PAPER mode calls confirmEntry
   - LIVE mode places orders
   - trading_mode appears in logs
   - Undefined tradingMode defaults to PAPER

7. **Task 7 Complete**: Added `npm run test:integration` script to package.json. Documentation included in test file header comments per architecture pattern.

### Change Log

- 2026-02-01: Story completed - implemented 32 integration tests across 6 test suites

### File List

- `__tests__/integration/execution-flow.test.js` (new) - 32 integration tests
- `package.json` (modified) - Added `test:integration` script
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified) - Updated story status

