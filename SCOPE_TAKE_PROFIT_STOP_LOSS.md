# Scope: Take Profit & Stop Loss System

**Status:** LIVE TRADING DISABLED
**Priority:** CRITICAL - Must complete before re-enabling live trading
**Date:** January 27, 2026

---

## Thesis

### The Problem We Discovered

On January 27, 2026, we observed the following scenario:

| Time | Event | Price | Action Taken | Optimal Action |
|------|-------|-------|--------------|----------------|
| T1 | Lag detected: spot UP, market at 14% | 14¢ | BUY UP ✅ | BUY UP ✅ |
| T2 | Price rises | 36¢ (+157%) | HOLD ❌ | TAKE PROFIT at 32¢ |
| T3 | Reversal detected: spot DOWN | 61¢ | BUY DOWN ❌ | EXIT UP, then BUY DOWN |
| T4 | DOWN position rises | 98¢ (+60%) | HOLD | HOLD or TAKE PROFIT |
| T5 | Window ends | - | Net ~$0 | Net +$4-5 profit |

**We had TWO correct signals but made ZERO profit.**

### Why This Happened

```
┌─────────────────────────────────────────────────────────────┐
│                    THE DISCONNECT                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Strategy.onTick(tick, PAPER_POSITION)                     │
│        │                                                    │
│        ▼                                                    │
│   Evaluates PAPER PnL: "Am I at -25%? No, hold."           │
│        │                                                    │
│        ▼                                                    │
│   LiveTrader has LIVE_POSITION with DIFFERENT entry price   │
│        │                                                    │
│        ▼                                                    │
│   LIVE PnL is actually -40% but strategy doesn't know!     │
│                                                             │
│   Result: Stop loss never triggers. Take profit never       │
│           triggers. Positions held to expiry.               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### The Opportunity

Our signal generation is EXCELLENT:
- Detected the lag move UP correctly
- Detected the reversal DOWN correctly
- Both would have been profitable trades

**The only failure is position management.** Fix that, and we have a profitable system.

---

## System Requirements

### 1. Live Position Tracking

LiveTrader must track complete position state:

```javascript
livePositions[positionKey] = {
    // Existing fields
    strategyName,
    crypto,
    windowEpoch,
    tokenSide,          // 'UP' or 'DOWN'
    tokenId,
    entryPrice,         // Actual fill price
    entryTime,
    size,
    shares,

    // NEW: Required for take profit
    highWaterMark,      // Highest price seen since entry
    highWaterMarkTime,  // When HWM was set
    trailingActive,     // Boolean: has trailing stop activated?
    trailingActivatedAt,// Price when trailing activated

    // NEW: Required for stop loss
    stopLossPrice,      // Calculated stop loss level
    stopLossTriggered,  // Boolean: prevent duplicate triggers

    // NEW: For analysis
    peakPnlPct,         // Highest PnL % achieved
    currentPnlPct,      // Current PnL %
};
```

### 2. Take Profit Logic

**Trailing Stop Mechanism:**

```
Entry at 14¢
    │
    ▼ Price rises to 20¢ (HWM = 20¢, +43% PnL)
    │
    ▼ Price rises to 30¢ (HWM = 30¢, +114% PnL)
    │   └── TRAILING ACTIVATES (PnL > 15% threshold)
    │
    ▼ Price rises to 36¢ (HWM = 36¢, +157% PnL, trailing stop = 32.4¢)
    │
    ▼ Price drops to 33¢ (HWM unchanged, trailing stop = 32.4¢)
    │
    ▼ Price drops to 32¢ (BELOW trailing stop)
    │
    ▼ EXIT TRIGGERED at 32¢ (+128% profit captured)
```

**Configuration:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `TRAILING_ACTIVATION_PCT` | 15% | Don't trail until meaningful profit |
| `TRAILING_STOP_PCT` | 10% | Give room for volatility but lock in gains |
| `MIN_PROFIT_FLOOR` | 5% | Never let trailing stop exit at less than 5% profit |

**Implementation:**

```javascript
// In LiveTrader.monitorPositions()

// Update high water mark
if (currentPrice > position.highWaterMark) {
    position.highWaterMark = currentPrice;
    position.highWaterMarkTime = Date.now();
    position.peakPnlPct = pnlPct;
}

// Check if trailing should activate
if (!position.trailingActive && pnlPct >= TRAILING_ACTIVATION_PCT) {
    position.trailingActive = true;
    position.trailingActivatedAt = currentPrice;
    this.logger.log(`[LiveTrader] 📈 TRAILING ACTIVATED: ${crypto} ${side} at ${(pnlPct * 100).toFixed(1)}% profit`);
}

// Execute trailing stop
if (position.trailingActive) {
    const trailingStopPrice = position.highWaterMark * (1 - TRAILING_STOP_PCT);
    const profitFloorPrice = position.entryPrice * (1 + MIN_PROFIT_FLOOR);
    const effectiveStop = Math.max(trailingStopPrice, profitFloorPrice);

    if (currentPrice <= effectiveStop) {
        this.logger.log(`[LiveTrader] 💰 TAKE PROFIT: ${crypto} ${side} | Entry: ${entryPrice} | Peak: ${position.highWaterMark} | Exit: ${currentPrice} | Profit: ${(pnlPct * 100).toFixed(1)}%`);
        await this.executeExit(position, tick, market, 'trailing_stop');
    }
}
```

### 3. Stop Loss Logic

**Fixed Stop Loss Mechanism:**

```
Entry at 64¢
    │
    ▼ Price drops to 50¢ (-22% PnL)
    │
    ▼ Price drops to 45¢ (-30% PnL)
    │   └── STOP LOSS THRESHOLD HIT (-25%)
    │
    ▼ EXIT TRIGGERED at 45¢ (-30% loss, limited)
```

**Configuration by Strategy:**

| Strategy | Stop Loss | Rationale |
|----------|-----------|-----------|
| SpotLag_Trail_V1 | 40% | Conservative, right-side-only trades |
| SpotLag_Trail_V2 | 30% | Moderate risk tolerance |
| SpotLag_Trail_V3 | 25% | Base case |
| SpotLag_Trail_V4 | 20% | Aggressive, tighter stop |
| PureProb_* | 25% | Standard |
| LagProb_* | 25% | Standard |
| Endgame_* | 30% | Hold longer, near-expiry trades |
| Default | 25% | Fallback for unlisted strategies |

**Implementation:**

```javascript
// In LiveTrader.monitorPositions()

// Prevent duplicate stop loss triggers
if (position.stopLossTriggered) {
    return; // Already processing this exit
}

const stopLossThreshold = this.getStopLossThreshold(position.strategyName);

if (pnlPct < -stopLossThreshold) {
    position.stopLossTriggered = true; // Mark to prevent duplicates

    this.logger.log(`[LiveTrader] 🛑 STOP LOSS: ${crypto} ${side} | Entry: ${entryPrice} | Current: ${currentPrice} | Loss: ${(pnlPct * 100).toFixed(1)}%`);

    await this.executeExit(position, tick, market, 'stop_loss');
}
```

### 4. Position Conflict Resolution

**Current Problem:**

```
T1: Strategy A buys UP
T2: Strategy B buys DOWN  ← OPPOSITE BET ALLOWED
T3: One wins, one loses = Net zero
```

**Solution: Exit and Reverse**

```
T1: Strategy A buys UP
T2: UP position reaches +50% profit
T3: Strategy B signals DOWN
    ├── Check: Do we have opposite position? YES (UP)
    ├── Check: Is it profitable? YES (+50%)
    ├── Action: EXIT UP position (take profit)
    └── Action: ENTER DOWN position
T4: Both trades profitable!
```

**Implementation:**

```javascript
// In LiveTrader.processSignal()

if (signal.action === 'buy') {
    const requestedSide = signal.side.toUpperCase();

    // Check for opposite position in same crypto/window
    for (const [key, pos] of Object.entries(this.livePositions)) {
        if (pos.crypto === crypto && pos.windowEpoch === windowEpoch) {
            if (pos.tokenSide !== requestedSide) {
                // We have an opposite position
                const currentPrice = pos.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
                const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

                if (pnlPct >= MIN_PROFIT_TO_REVERSE) {
                    // Profitable - exit and allow reversal
                    this.logger.log(`[LiveTrader] 🔄 REVERSAL: Exiting ${pos.tokenSide} at +${(pnlPct * 100).toFixed(1)}% to enter ${requestedSide}`);
                    await this.executeExit(pos, tick, market, 'reversal');
                    // Continue to process the new entry below
                } else {
                    // Not profitable enough to reverse
                    this.logger.log(`[LiveTrader] ⚠️ BLOCKED: ${strategyName} wants ${requestedSide} but ${pos.tokenSide} only at ${(pnlPct * 100).toFixed(1)}%`);
                    return null;
                }
            }
        }
    }
}
```

**Configuration:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `MIN_PROFIT_TO_REVERSE` | 10% | Don't reverse unless we're locking in real profit |
| `BLOCK_IF_LOSING` | true | Never reverse a losing position (let stop loss handle it) |

---

## Implementation Plan

### Phase 1: Core Infrastructure (2-3 hours)

**File:** `src/execution/live_trader.js`

1. Extend position object with new fields (HWM, trailing state, etc.)
2. Refactor `monitorPositions()` to handle both stop loss AND take profit
3. Add duplicate trigger prevention
4. Add position removal after successful exit
5. Add comprehensive logging

### Phase 2: Take Profit (1-2 hours)

**File:** `src/execution/live_trader.js`

1. Implement high water mark tracking
2. Implement trailing stop activation logic
3. Implement trailing stop execution
4. Add profit floor protection
5. Add configuration constants

### Phase 3: Position Conflicts (1-2 hours)

**File:** `src/execution/live_trader.js`

1. Implement opposite position detection
2. Implement profitability check
3. Implement exit-and-reverse flow
4. Add reversal logging and metrics

### Phase 4: Testing (2-3 hours)

1. Unit tests for each component
2. Paper trading validation (compare paper vs simulated live)
3. Manual review of logs for correct behavior
4. Backtest against January 27 data to verify we would have profited

### Phase 5: Re-enable Live Trading

1. Set `ENABLED: true` in config
2. Start with reduced position sizes
3. Monitor closely for first few windows
4. Verify stop loss and take profit are triggering correctly

---

## Success Criteria

Before re-enabling live trading, we must verify:

| Criteria | Test Method |
|----------|-------------|
| Stop loss triggers at correct threshold | Log shows exit at -25% (±2%) |
| Stop loss only triggers once per position | No duplicate exit attempts in logs |
| Take profit activates at +15% | Log shows "TRAILING ACTIVATED" |
| Take profit exits on pullback | Log shows exit when price drops 10% from peak |
| Profit floor works | No take-profit exit below +5% profit |
| Opposite bets blocked when losing | Log shows "BLOCKED" message |
| Reversal works when profitable | Log shows "REVERSAL" with exit then entry |
| Position removed after exit | No repeated processing of same position |

---

## Expected Outcomes

### Before (Current State)

- Stop loss: Never triggers
- Take profit: Never triggers
- Opposite bets: Allowed, cancel each other out
- **Result:** Good signals → Poor returns

### After (Fixed State)

- Stop loss: Limits losses to 20-40% per strategy
- Take profit: Captures 80-90% of peak profits
- Opposite bets: Trigger profitable reversals
- **Result:** Good signals → Good returns

### Projected Improvement

Based on January 27 data:

| Metric | Before | After (Projected) |
|--------|--------|-------------------|
| ETH trades | +157%, then -82% = Net +10% | +128%, then +60% = Net +188% |
| Win rate | ~50% (one wins, one loses) | ~70% (both win) |
| Avg profit per window | ~$0 | +$2-4 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Take profit exits too early | Set activation threshold at 15%, not lower |
| Stop loss whipsaws | Use 25% threshold, not tighter |
| Exit orders fail | Retry logic, position marked as "exit pending" |
| Race conditions | Use position-level locks, process sequentially |
| Missing reversals | Log all reversal opportunities for analysis |

---

## Sign-off Checklist

- [ ] Code review completed
- [ ] Unit tests passing
- [ ] Paper trading shows correct behavior (24 hours minimum)
- [ ] Backtest against historical data shows improvement
- [ ] Documentation updated
- [ ] Reduced position sizes configured for initial live run
- [ ] Monitoring alerts configured
- [ ] Rollback plan documented

---

## Appendix: Key Code Locations

| Component | File | Function/Line |
|-----------|------|---------------|
| Position tracking | `src/execution/live_trader.js` | `livePositions` object |
| Stop loss (current) | `src/execution/live_trader.js:201` | `monitorPositions()` |
| Take profit (TODO) | `src/execution/live_trader.js` | `monitorPositions()` |
| Entry processing | `src/execution/live_trader.js:268` | `processSignal()` |
| Exit execution | `src/execution/live_trader.js:640` | `executeExit()` |
| Strategy stop loss thresholds | `src/execution/live_trader.js:243` | `getStopLossThreshold()` |
| Paper position tracking | `src/quant/research_engine.js:43` | `this.positions` |

---

*This document serves as the specification for the take profit/stop loss system. No live trading until all success criteria are met.*
