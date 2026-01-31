# Critical Enhancements

Required enhancements before live trading. These are fundamental safety issues that must be addressed.

---

## E1: Pre-Exit Balance Verification [CRITICAL]

**Status:** NOT IMPLEMENTED
**Priority:** BLOCKER - Do not run live without this
**Identified:** 2026-01-31

### Problem

The current exit logic trusts `position.shares` from in-memory state without verifying against the exchange before selling. This creates risk of:

1. **Overselling** - Attempting to sell more shares than we actually hold
2. **Double-selling** - Attempting to sell after already exited (race condition)
3. **Accidental short** - In extreme edge cases, could theoretically create opposite position

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
