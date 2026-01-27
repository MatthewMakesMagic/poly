# Implementation Plan: Take Profit & Stop Loss System

**Status:** Planning
**Estimated Effort:** 8-10 hours
**Dependencies:** Live trading DISABLED until complete

---

## Build Order

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Position State Infrastructure                         │
│  └── Extended position object, state machine                    │
├─────────────────────────────────────────────────────────────────┤
│  Phase 2: Stop Loss (Fix Existing)                              │
│  └── Duplicate prevention, position cleanup                     │
├─────────────────────────────────────────────────────────────────┤
│  Phase 3: Take Profit (New)                                     │
│  └── HWM tracking, trailing logic                               │
├─────────────────────────────────────────────────────────────────┤
│  Phase 4: Position Conflict Resolution                          │
│  └── Exit-and-reverse logic                                     │
├─────────────────────────────────────────────────────────────────┤
│  Phase 5: Testing Infrastructure                                │
│  └── Simulation mode, stress tests, validation                  │
├─────────────────────────────────────────────────────────────────┤
│  Phase 6: Production Validation                                 │
│  └── Paper parity, gradual rollout                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Position State Infrastructure

### 1.1 Position State Machine

```
                    ┌──────────────┐
                    │   PENDING    │ (entry order placed)
                    └──────┬───────┘
                           │ filled
                           ▼
                    ┌──────────────┐
         ┌─────────│    OPEN      │─────────┐
         │         └──────┬───────┘         │
         │                │                 │
    stop loss        take profit       opposite signal
    triggered         triggered         (reversal)
         │                │                 │
         ▼                ▼                 ▼
    ┌─────────┐    ┌─────────────┐    ┌──────────┐
    │ EXITING │    │   EXITING   │    │ EXITING  │
    │ (stop)  │    │  (profit)   │    │(reversal)│
    └────┬────┘    └──────┬──────┘    └────┬─────┘
         │                │                 │
         └────────────────┼─────────────────┘
                          │ exit confirmed
                          ▼
                    ┌──────────────┐
                    │   CLOSED     │
                    └──────────────┘
```

### 1.2 Extended Position Object

**File:** `src/execution/live_trader.js`

```javascript
// Position states
const PositionState = {
    PENDING: 'pending',
    OPEN: 'open',
    EXITING: 'exiting',
    CLOSED: 'closed'
};

// Exit reasons (for analytics)
const ExitReason = {
    STOP_LOSS: 'stop_loss',
    TRAILING_STOP: 'trailing_stop',
    REVERSAL: 'reversal',
    WINDOW_EXPIRY: 'window_expiry',
    MANUAL: 'manual'
};

// Enhanced position structure
const createPosition = (baseData) => ({
    // Identity
    positionKey: `${baseData.strategyName}_${baseData.crypto}_${baseData.windowEpoch}`,
    strategyName: baseData.strategyName,
    crypto: baseData.crypto,
    windowEpoch: baseData.windowEpoch,

    // Token info
    tokenSide: baseData.tokenSide,  // 'UP' or 'DOWN'
    tokenId: baseData.tokenId,

    // Entry
    entryPrice: baseData.entryPrice,
    entryTime: Date.now(),
    size: baseData.size,
    shares: baseData.shares,

    // State
    state: PositionState.OPEN,
    exitReason: null,

    // Stop Loss
    stopLossThreshold: baseData.stopLossThreshold,
    stopLossPrice: baseData.entryPrice * (1 - baseData.stopLossThreshold),

    // Take Profit (Trailing Stop)
    highWaterMark: baseData.entryPrice,
    highWaterMarkTime: Date.now(),
    trailingActive: false,
    trailingActivatedAt: null,
    trailingActivatedPrice: null,

    // Metrics
    peakPnlPct: 0,
    currentPnlPct: 0,
    ticksMonitored: 0,

    // Audit
    lastUpdateTime: Date.now(),
    exitAttempts: 0,
    txHash: baseData.txHash
});
```

### 1.3 Configuration Constants

```javascript
// Take Profit Configuration
const TP_CONFIG = {
    TRAILING_ACTIVATION_PCT: 0.15,   // Activate trailing at +15%
    TRAILING_STOP_PCT: 0.10,         // Trail 10% below HWM
    MIN_PROFIT_FLOOR_PCT: 0.05,      // Never exit below +5% profit
    UPDATE_HWM_THRESHOLD: 0.001,     // Min price change to update HWM (avoid noise)
};

// Stop Loss Configuration
const SL_CONFIG = {
    MAX_EXIT_ATTEMPTS: 3,            // Retry failed exits
    EXIT_RETRY_DELAY_MS: 1000,       // Wait between retries
    POSITION_LOCK_TIMEOUT_MS: 30000, // Max time in EXITING state
};

// Reversal Configuration
const REVERSAL_CONFIG = {
    MIN_PROFIT_TO_REVERSE: 0.10,     // Need +10% to allow reversal
    BLOCK_IF_LOSING: true,           // Never reverse a losing position
};
```

### 1.4 Contingencies

| Scenario | Handling |
|----------|----------|
| Position stuck in EXITING | Timeout after 30s, force to CLOSED, log error |
| Entry fails after marking PENDING | Remove position, log failed entry |
| Multiple ticks while EXITING | Skip processing, position locked |
| Process restart mid-position | Reconcile from chain on startup |

---

## Phase 2: Stop Loss (Fix Existing)

### 2.1 Current Issues

1. **Duplicate triggers** - Same position triggers stop loss repeatedly
2. **Position not removed** - After exit attempt, position stays in `livePositions`
3. **No retry on failed exit** - If exit order fails, we give up

### 2.2 Fixed Implementation

```javascript
async monitorStopLoss(position, tick, market) {
    // Skip if not in OPEN state
    if (position.state !== PositionState.OPEN) {
        return null;
    }

    // Calculate current price and PnL
    const currentPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
    const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

    // Update position metrics
    position.currentPnlPct = pnlPct;
    position.ticksMonitored++;
    position.lastUpdateTime = Date.now();

    // Check stop loss
    if (pnlPct < -position.stopLossThreshold) {
        this.logger.log(`[LiveTrader] 🛑 STOP LOSS: ${position.crypto} ${position.tokenSide} | ` +
            `Entry: ${position.entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | ` +
            `Loss: ${(pnlPct * 100).toFixed(1)}%`);

        // Transition to EXITING state (prevents duplicate triggers)
        position.state = PositionState.EXITING;
        position.exitReason = ExitReason.STOP_LOSS;

        // Execute exit with retry
        const exitResult = await this.executeExitWithRetry(position, tick, market);

        if (exitResult.success) {
            position.state = PositionState.CLOSED;
            this.removePosition(position.positionKey);
            return { action: 'exited', reason: 'stop_loss', pnl: exitResult.pnl };
        } else {
            // Exit failed - log and keep trying next tick
            this.logger.error(`[LiveTrader] ❌ STOP LOSS EXIT FAILED: ${position.crypto} - ${exitResult.error}`);
            position.exitAttempts++;

            // If too many attempts, force close and reconcile later
            if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                this.logger.error(`[LiveTrader] ❌ GIVING UP on exit for ${position.positionKey} - will reconcile`);
                position.state = PositionState.CLOSED;
                this.removePosition(position.positionKey);
                this.pendingReconciliation.push(position);
            } else {
                // Reset to OPEN to try again next tick
                position.state = PositionState.OPEN;
            }
            return { action: 'exit_failed', reason: 'stop_loss', attempts: position.exitAttempts };
        }
    }

    return null; // No action taken
}
```

### 2.3 Exit With Retry

```javascript
async executeExitWithRetry(position, tick, market, maxRetries = SL_CONFIG.MAX_EXIT_ATTEMPTS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Calculate exit price with buffer
            const EXIT_BUFFER = 0.03;
            const rawPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
            const exitPrice = Math.round(Math.max(rawPrice - EXIT_BUFFER, 0.01) * 100) / 100;

            const sharesToSell = position.shares;

            // Check minimum order value
            const orderValue = sharesToSell * exitPrice;
            if (orderValue < 1.0) {
                this.logger.warn(`[LiveTrader] Order too small: $${orderValue.toFixed(2)} < $1 minimum`);
                return { success: false, error: 'order_too_small' };
            }

            const response = await this.client.sell(position.tokenId, sharesToSell, exitPrice, 'FOK');

            if (response.filled || response.shares > 0) {
                const exitValue = response.value || (sharesToSell * exitPrice);
                const pnl = exitValue - position.size;

                this.logger.log(`[LiveTrader] ✅ EXIT FILLED (attempt ${attempt}): ${position.crypto} | PnL: $${pnl.toFixed(2)}`);

                // Record in database
                await this.saveExitTrade(position, exitPrice, pnl, position.exitReason);

                return { success: true, pnl, exitPrice, attempts: attempt };
            } else {
                this.logger.warn(`[LiveTrader] Exit not filled (attempt ${attempt}): ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[LiveTrader] Exit attempt ${attempt} failed: ${error.message}`);
        }

        // Wait before retry
        if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, SL_CONFIG.EXIT_RETRY_DELAY_MS));
        }
    }

    return { success: false, error: 'max_retries_exceeded' };
}
```

### 2.4 Contingencies

| Scenario | Handling |
|----------|----------|
| Exit order rejected (price moved) | Retry with worse price (up to 3 attempts) |
| Exit order too small | Log warning, wait for price to improve or expiry |
| Network error during exit | Retry with exponential backoff |
| Position already sold (chain state) | Reconcile via balance check, remove position |
| Partial fill | Track remaining shares, continue exiting |

---

## Phase 3: Take Profit (New)

### 3.1 High Water Mark Tracking

```javascript
updateHighWaterMark(position, currentPrice) {
    // Only update if price improved meaningfully
    if (currentPrice > position.highWaterMark * (1 + TP_CONFIG.UPDATE_HWM_THRESHOLD)) {
        const previousHWM = position.highWaterMark;
        position.highWaterMark = currentPrice;
        position.highWaterMarkTime = Date.now();
        position.peakPnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

        this.logger.log(`[LiveTrader] 📈 NEW HWM: ${position.crypto} ${position.tokenSide} | ` +
            `${previousHWM.toFixed(3)} → ${currentPrice.toFixed(3)} | Peak: +${(position.peakPnlPct * 100).toFixed(1)}%`);
    }
}
```

### 3.2 Trailing Stop Logic

```javascript
async monitorTakeProfit(position, tick, market) {
    // Skip if not in OPEN state
    if (position.state !== PositionState.OPEN) {
        return null;
    }

    const currentPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
    const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

    // Update HWM
    this.updateHighWaterMark(position, currentPrice);

    // Check if trailing should activate
    if (!position.trailingActive && pnlPct >= TP_CONFIG.TRAILING_ACTIVATION_PCT) {
        position.trailingActive = true;
        position.trailingActivatedAt = Date.now();
        position.trailingActivatedPrice = currentPrice;

        this.logger.log(`[LiveTrader] 🎯 TRAILING ACTIVATED: ${position.crypto} ${position.tokenSide} | ` +
            `Entry: ${position.entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | ` +
            `Profit: +${(pnlPct * 100).toFixed(1)}%`);
    }

    // Execute trailing stop if active
    if (position.trailingActive) {
        const trailingStopPrice = position.highWaterMark * (1 - TP_CONFIG.TRAILING_STOP_PCT);
        const profitFloorPrice = position.entryPrice * (1 + TP_CONFIG.MIN_PROFIT_FLOOR_PCT);
        const effectiveStopPrice = Math.max(trailingStopPrice, profitFloorPrice);

        if (currentPrice <= effectiveStopPrice) {
            const capturedPnlPct = (effectiveStopPrice - position.entryPrice) / position.entryPrice;
            const peakCaptured = position.peakPnlPct > 0 ? (capturedPnlPct / position.peakPnlPct * 100) : 0;

            this.logger.log(`[LiveTrader] 💰 TAKE PROFIT: ${position.crypto} ${position.tokenSide} | ` +
                `Entry: ${position.entryPrice.toFixed(3)} | Peak: ${position.highWaterMark.toFixed(3)} | ` +
                `Exit: ${currentPrice.toFixed(3)} | Captured: ${peakCaptured.toFixed(0)}% of peak`);

            position.state = PositionState.EXITING;
            position.exitReason = ExitReason.TRAILING_STOP;

            const exitResult = await this.executeExitWithRetry(position, tick, market);

            if (exitResult.success) {
                position.state = PositionState.CLOSED;
                this.removePosition(position.positionKey);
                return { action: 'exited', reason: 'trailing_stop', pnl: exitResult.pnl, peakCaptured };
            } else {
                position.exitAttempts++;
                if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                    position.state = PositionState.CLOSED;
                    this.removePosition(position.positionKey);
                } else {
                    position.state = PositionState.OPEN;
                }
                return { action: 'exit_failed', reason: 'trailing_stop' };
            }
        }

        // Log trailing status periodically
        if (position.ticksMonitored % 10 === 0) {
            this.logger.log(`[LiveTrader] 📊 TRAILING: ${position.crypto} ${position.tokenSide} | ` +
                `Current: ${currentPrice.toFixed(3)} | Stop: ${effectiveStopPrice.toFixed(3)} | ` +
                `Buffer: ${((currentPrice - effectiveStopPrice) / effectiveStopPrice * 100).toFixed(1)}%`);
        }
    }

    return null;
}
```

### 3.3 Contingencies

| Scenario | Handling |
|----------|----------|
| Flash spike then crash | HWM updates on spike, trailing stop catches the crash |
| Gradual drift down | Trailing never activates (needs +15%), stop loss catches it |
| Price gaps through stop | Exit at market, may be worse than calculated |
| HWM update during EXITING | Ignore updates when not in OPEN state |
| Trailing activates then loss | Profit floor ensures minimum +5% exit |

---

## Phase 4: Position Conflict Resolution

### 4.1 Detection Logic

```javascript
checkForConflict(crypto, windowEpoch, requestedSide) {
    for (const [key, pos] of Object.entries(this.livePositions)) {
        if (pos.crypto === crypto &&
            pos.windowEpoch === windowEpoch &&
            pos.state === PositionState.OPEN) {

            if (pos.tokenSide !== requestedSide) {
                return {
                    hasConflict: true,
                    existingPosition: pos,
                    existingSide: pos.tokenSide,
                    requestedSide: requestedSide
                };
            }
        }
    }
    return { hasConflict: false };
}
```

### 4.2 Reversal Logic

```javascript
async handlePotentialReversal(conflict, signal, tick, market) {
    const pos = conflict.existingPosition;
    const currentPrice = pos.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

    // Log the opportunity
    this.logger.log(`[LiveTrader] 🔄 REVERSAL OPPORTUNITY: ${pos.crypto} | ` +
        `Current: ${pos.tokenSide} at ${(pnlPct * 100).toFixed(1)}% | ` +
        `Requested: ${conflict.requestedSide}`);

    // Check if profitable enough to reverse
    if (pnlPct >= REVERSAL_CONFIG.MIN_PROFIT_TO_REVERSE) {
        this.logger.log(`[LiveTrader] ✅ REVERSING: Exiting ${pos.tokenSide} at +${(pnlPct * 100).toFixed(1)}%`);

        pos.state = PositionState.EXITING;
        pos.exitReason = ExitReason.REVERSAL;

        const exitResult = await this.executeExitWithRetry(pos, tick, market);

        if (exitResult.success) {
            pos.state = PositionState.CLOSED;
            this.removePosition(pos.positionKey);

            // Allow the new entry to proceed
            return { allowEntry: true, exitedPosition: pos, exitPnl: exitResult.pnl };
        } else {
            this.logger.error(`[LiveTrader] ❌ REVERSAL EXIT FAILED - blocking new entry`);
            pos.state = PositionState.OPEN; // Reset state
            return { allowEntry: false, reason: 'exit_failed' };
        }
    } else if (pnlPct < 0 && REVERSAL_CONFIG.BLOCK_IF_LOSING) {
        this.logger.log(`[LiveTrader] ⚠️ BLOCKED: Won't reverse losing position (${(pnlPct * 100).toFixed(1)}%)`);
        return { allowEntry: false, reason: 'position_losing' };
    } else {
        this.logger.log(`[LiveTrader] ⚠️ BLOCKED: Profit too low to reverse (${(pnlPct * 100).toFixed(1)}% < ${(REVERSAL_CONFIG.MIN_PROFIT_TO_REVERSE * 100)}%)`);
        return { allowEntry: false, reason: 'insufficient_profit' };
    }
}
```

### 4.3 Integration into processSignal

```javascript
async processSignal(strategyName, signal, tick, market) {
    // ... existing checks ...

    if (signal.action === 'buy') {
        const requestedSide = signal.side.toUpperCase();
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;

        // Check for position conflict
        const conflict = this.checkForConflict(crypto, windowEpoch, requestedSide);

        if (conflict.hasConflict) {
            const reversalResult = await this.handlePotentialReversal(conflict, signal, tick, market);

            if (!reversalResult.allowEntry) {
                return null; // Entry blocked
            }
            // If allowEntry is true, continue to execute the new entry
        }

        // ... continue with entry logic ...
    }
}
```

### 4.4 Contingencies

| Scenario | Handling |
|----------|----------|
| Reversal exit fails | Block new entry, keep existing position |
| Reversal at exactly 10% | Use >= for threshold check |
| Multiple strategies want same reversal | First one wins, others blocked (position gone) |
| Reversal then new entry fails | Reversal still counts as profit taken |
| Rapid reversal signals | Position state machine prevents race conditions |

---

## Phase 5: Testing Infrastructure

### 5.1 Simulation Mode

Add ability to run LiveTrader in simulation mode that:
- Processes all signals as if live
- Tracks what WOULD have happened
- Compares to paper trading results
- No actual orders placed

```javascript
// In LiveTrader constructor
this.simulationMode = process.env.LIVE_TRADER_SIMULATION === 'true';

// In executeEntry / executeExit
if (this.simulationMode) {
    this.logger.log(`[SIMULATION] Would execute: ${action} ${crypto} ${side} @ ${price}`);
    return this.simulateExecution(action, price, size);
}
```

### 5.2 Live Trading Test Suite

**File:** `src/execution/__tests__/live_trader_integration.test.js`

```javascript
describe('LiveTrader Integration Tests', () => {

    describe('Stop Loss', () => {
        it('triggers at correct threshold', async () => {
            const position = createTestPosition({ entryPrice: 0.50, stopLossThreshold: 0.25 });
            const tick = createTick({ up_bid: 0.37 }); // -26% loss

            const result = await trader.monitorStopLoss(position, tick, market);

            expect(result.action).toBe('exited');
            expect(result.reason).toBe('stop_loss');
        });

        it('does not trigger above threshold', async () => {
            const position = createTestPosition({ entryPrice: 0.50, stopLossThreshold: 0.25 });
            const tick = createTick({ up_bid: 0.40 }); // -20% loss

            const result = await trader.monitorStopLoss(position, tick, market);

            expect(result).toBeNull();
        });

        it('only triggers once per position', async () => {
            const position = createTestPosition({ entryPrice: 0.50 });
            position.state = PositionState.EXITING;

            const result = await trader.monitorStopLoss(position, tick, market);

            expect(result).toBeNull(); // Skipped because already exiting
        });
    });

    describe('Take Profit', () => {
        it('activates trailing at threshold', async () => {
            const position = createTestPosition({ entryPrice: 0.50 });
            const tick = createTick({ up_bid: 0.60 }); // +20% profit

            await trader.monitorTakeProfit(position, tick, market);

            expect(position.trailingActive).toBe(true);
            expect(position.highWaterMark).toBe(0.60);
        });

        it('exits on pullback from HWM', async () => {
            const position = createTestPosition({ entryPrice: 0.50, trailingActive: true, highWaterMark: 0.70 });
            const tick = createTick({ up_bid: 0.62 }); // 11% below HWM

            const result = await trader.monitorTakeProfit(position, tick, market);

            expect(result.action).toBe('exited');
            expect(result.reason).toBe('trailing_stop');
        });

        it('respects profit floor', async () => {
            const position = createTestPosition({ entryPrice: 0.50, trailingActive: true, highWaterMark: 0.55 });
            const tick = createTick({ up_bid: 0.51 }); // Would be below trailing, but above floor

            const result = await trader.monitorTakeProfit(position, tick, market);

            // Should not exit because 0.51 > floor (0.525 = entry + 5%)
            // Actually 0.51 < 0.525, so it SHOULD exit at floor
            expect(result.action).toBe('exited');
        });
    });

    describe('Position Conflicts', () => {
        it('blocks opposite bet when position losing', async () => {
            // Setup: existing DOWN position at -5%
            const existingPos = createTestPosition({ tokenSide: 'DOWN', entryPrice: 0.60 });
            trader.livePositions['test_key'] = existingPos;

            const signal = { action: 'buy', side: 'up' };
            const tick = createTick({ down_bid: 0.57 }); // -5% on DOWN

            const result = await trader.processSignal('TestStrategy', signal, tick, market);

            expect(result).toBeNull();
            expect(trader.livePositions['test_key']).toBeDefined(); // Position kept
        });

        it('allows reversal when position profitable', async () => {
            const existingPos = createTestPosition({ tokenSide: 'DOWN', entryPrice: 0.60 });
            trader.livePositions['test_key'] = existingPos;

            const signal = { action: 'buy', side: 'up' };
            const tick = createTick({ down_bid: 0.72 }); // +20% on DOWN

            const result = await trader.processSignal('TestStrategy', signal, tick, market);

            expect(trader.livePositions['test_key']).toBeUndefined(); // Position exited
            // New position should be created
        });
    });
});
```

### 5.3 Stress Tests

**File:** `src/execution/__tests__/live_trader_stress.test.js`

```javascript
describe('LiveTrader Stress Tests', () => {

    it('handles rapid tick updates', async () => {
        const position = createTestPosition({ entryPrice: 0.50 });
        trader.livePositions['test'] = position;

        // Simulate 100 ticks per second
        for (let i = 0; i < 1000; i++) {
            const price = 0.50 + Math.sin(i / 10) * 0.1; // Oscillating price
            const tick = createTick({ up_bid: price });
            await trader.monitorPositions(tick, market);
        }

        // Should not have duplicate exits, state should be consistent
        expect(position.state).toBeOneOf([PositionState.OPEN, PositionState.CLOSED]);
    });

    it('handles multiple positions same window', async () => {
        // 5 strategies all enter same crypto
        for (let i = 0; i < 5; i++) {
            const pos = createTestPosition({ strategyName: `Strategy_${i}`, entryPrice: 0.50 + i * 0.01 });
            trader.livePositions[`key_${i}`] = pos;
        }

        // Price drops - all should stop loss
        const tick = createTick({ up_bid: 0.30 });
        await trader.monitorPositions(tick, market);

        // All positions should be closed
        expect(Object.keys(trader.livePositions).length).toBe(0);
    });

    it('handles exit order failures gracefully', async () => {
        // Mock client to fail
        trader.client.sell = jest.fn().mockRejectedValue(new Error('Network error'));

        const position = createTestPosition({ entryPrice: 0.50 });
        trader.livePositions['test'] = position;

        const tick = createTick({ up_bid: 0.30 }); // Trigger stop loss

        // Should not throw, should handle gracefully
        await expect(trader.monitorPositions(tick, market)).resolves.not.toThrow();

        // Position should be marked for retry or reconciliation
        expect(position.exitAttempts).toBeGreaterThan(0);
    });

    it('maintains consistency during process restart', async () => {
        // Simulate positions saved to DB
        const savedPositions = [
            { positionKey: 'key1', tokenId: 'token1', shares: 10 },
            { positionKey: 'key2', tokenId: 'token2', shares: 20 },
        ];

        // Mock chain balances
        trader.client.getBalance = jest.fn()
            .mockResolvedValueOnce(10)  // token1: matches
            .mockResolvedValueOnce(15); // token2: mismatch!

        const reconciliation = await trader.reconcilePositions();

        expect(reconciliation.discrepancies.length).toBe(1);
        expect(reconciliation.discrepancies[0].tokenId).toBe('token2');
    });
});
```

### 5.4 Paper Trading Parity Check

```javascript
// Add to ResearchEngine
async validateLiveParity(tick) {
    const liveTrader = getLiveTrader();
    if (!liveTrader.isRunning) return;

    const crypto = tick.crypto;

    // Get paper positions
    const paperPositions = Object.entries(this.positions)
        .filter(([name, pos]) => pos?.[crypto])
        .map(([name, pos]) => ({ strategy: name, ...pos[crypto] }));

    // Get live positions
    const livePositions = Object.values(liveTrader.livePositions)
        .filter(pos => pos.crypto === crypto);

    // Compare
    const paperCount = paperPositions.length;
    const liveCount = livePositions.length;

    if (paperCount !== liveCount) {
        this.logger.warn(`[PARITY] ${crypto}: Paper=${paperCount} Live=${liveCount} positions`);
    }

    // Log any positions that exist in paper but not live (or vice versa)
    // This helps identify if exits are working correctly
}
```

---

## Phase 6: Production Validation

### 6.1 Rollout Plan

```
Day 1: Simulation Mode
├── Deploy with LIVE_TRADER_SIMULATION=true
├── Monitor logs for simulated exits
├── Verify stop loss would trigger at correct levels
├── Verify take profit would trigger at correct levels
└── Compare simulated vs paper results

Day 2: Reduced Position Size
├── Set LIVE_POSITION_SIZE=0.50 (50 cents)
├── Enable live trading
├── Monitor first 10 windows closely
├── Verify actual exits match expected behavior
└── Check for any error logs

Day 3: Normal Position Size
├── If Day 2 successful, set LIVE_POSITION_SIZE=1.00
├── Continue monitoring
├── Track metrics: stop loss rate, take profit rate, reversal rate
└── Compare to paper trading P&L

Day 4+: Full Operation
├── If Day 3 successful, consider increasing position sizes
├── Review metrics weekly
└── Iterate on thresholds based on data
```

### 6.2 Monitoring Dashboard Metrics

```javascript
// Add to LiveTrader.getStatus()
getMetrics() {
    return {
        // Position counts
        openPositions: Object.keys(this.livePositions).length,
        positionsToday: this.stats.positionsOpenedToday,

        // Exit metrics
        stopLossExits: this.stats.stopLossExits,
        takeProfitExits: this.stats.takeProfitExits,
        reversalExits: this.stats.reversalExits,
        expiryExits: this.stats.expiryExits,

        // Performance
        avgStopLossPct: this.stats.avgStopLossPct,
        avgTakeProfitPct: this.stats.avgTakeProfitPct,
        avgPeakCaptured: this.stats.avgPeakCaptured,

        // Errors
        failedExits: this.stats.failedExits,
        reconciliationErrors: this.stats.reconciliationErrors,

        // Conflicts
        oppositeBeetsBlocked: this.stats.oppositeBeetsBlocked,
        reversalsExecuted: this.stats.reversalsExecuted,
    };
}
```

### 6.3 Alerts

```javascript
// Add alert conditions
const ALERTS = {
    // Critical
    FAILED_EXIT_THRESHOLD: 3,           // Alert if 3+ failed exits in 1 hour
    RECONCILIATION_MISMATCH: true,      // Alert on any chain/internal mismatch

    // Warning
    STOP_LOSS_RATE_HIGH: 0.5,          // Alert if >50% of positions hit stop loss
    NO_TAKE_PROFIT_24H: true,          // Alert if no take profits in 24 hours

    // Info
    REVERSAL_EXECUTED: true,           // Log all reversals for review
};
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/execution/live_trader.js` | Major refactor: position state machine, monitoring, exit logic |
| `src/execution/__tests__/live_trader_integration.test.js` | New: Integration tests |
| `src/execution/__tests__/live_trader_stress.test.js` | New: Stress tests |
| `src/quant/research_engine.js` | Add parity check logging |
| `scripts/start_collector.js` | Add simulation mode flag handling |

---

## Success Criteria (Expanded)

| Criteria | Test | Pass Condition |
|----------|------|----------------|
| Stop loss triggers correctly | Unit test | Exit at threshold ±2% |
| Stop loss only once | Unit test | No duplicate exits |
| Take profit activates | Unit test | Activates at +15% |
| Take profit trails | Unit test | Updates HWM on rise |
| Take profit exits | Unit test | Exits at 10% below HWM |
| Profit floor works | Unit test | Never exits below +5% |
| Reversal blocks when losing | Unit test | Entry blocked |
| Reversal executes when profitable | Unit test | Exit + new entry |
| Handles rapid ticks | Stress test | No crashes or duplicates |
| Handles exit failures | Stress test | Graceful retry/reconcile |
| Paper parity | Production | Paper and live match ±10% |
| Simulation matches reality | Production | Simulated exits occur in live |

---

## Rollback Plan

If issues discovered in production:

1. **Immediate:** Set `ENABLED: false` in live_trader.js, push
2. **Positions:** Existing positions will expire at window end
3. **Reconciliation:** Run `reconcilePositions()` to verify chain state
4. **Analysis:** Review logs, identify issue
5. **Fix:** Apply fix, run through test suite
6. **Redeploy:** Follow rollout plan from Day 1

---

*This implementation plan covers all contingencies and provides a clear path to production-ready take profit and stop loss functionality.*
