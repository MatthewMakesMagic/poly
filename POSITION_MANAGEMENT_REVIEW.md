# Position Management Review - Critical Issues

**Date:** January 27, 2026
**Status:** LIVE TRADING DISABLED pending fixes

---

## Executive Summary

The system correctly identified profitable opportunities but failed to capitalize on them due to three interconnected bugs:

1. **Stop losses not executing** - Strategies check paper positions, not live positions
2. **Take profits not executing** - Trailing stops never trigger because position data is disconnected
3. **Opposite bets allowed** - Multiple strategies can bet UP and DOWN on the same market simultaneously

**The tragic irony:** We detected BOTH the lag UP move AND the reversal DOWN move correctly. If take-profit had worked, we would have:
- Profited on ETH UP (14¢ → 36¢ = +157%)
- Then profited on ETH DOWN (61¢ → 98¢ = +60%)
- **Instead:** Held both, one won, one lost, net ~0

---

## Issue 1: Stop Losses Not Executing

### The Bug

Strategies receive `position` data from **paper trading** (ResearchEngine), not **live trading** (LiveTrader).

```
ResearchEngine.processTick()
├── strategy.onTick(tick, PAPER_POSITION, {})  ← Strategy sees this
├── Paper position PnL: -30%
├── Strategy returns: SELL (stop loss)
└── LiveTrader.processSignal() receives signal
    └── But LiveTrader has its OWN positions with DIFFERENT entry prices!
```

**Code reference:** `src/quant/research_engine.js:148-149`
```javascript
const position = this.getPosition(strategy.getName(), crypto);  // PAPER position
const signal = strategy.onTick(tick, position, {});  // Strategy evaluates PAPER PnL
```

### Evidence

From logs - positions at -30% and -44% should have stopped out:
```
SOL DOWN: Entry 64¢ → Current 24¢ = -62% (no stop loss triggered)
```

### Fix Applied (partial)

Added `LiveTrader.monitorPositions()` that checks live positions directly:
```javascript
// src/execution/live_trader.js:201-236
async monitorPositions(tick, market) {
    for (const position of livePositions) {
        const pnlPct = (currentPrice - entryPrice) / entryPrice;
        if (pnlPct < -stopLossThreshold) {
            executeExit();  // Direct exit, bypasses strategy
        }
    }
}
```

### Remaining Issue

The `monitorPositions` was triggering repeatedly (position not removed after failed exit). Need to add guard:
```javascript
if (this.exitInProgress[positionKey]) return;  // Prevent duplicate exits
```

---

## Issue 2: Take Profits Not Executing

### The Bug

Same root cause as stop losses. Trailing stop logic in strategies evaluates **paper position**, not **live position**.

**Code reference:** `src/quant/strategies/spot_lag_simple.js:3252-3290`
```javascript
// TRAILING STOP LOGIC - but using PAPER position data
if (this.trailingActive[crypto]) {
    const trailingStopPrice = hwm * (1 - this.options.trailingStopPct);
    if (currentPrice <= effectiveStop) {
        return this.createSignal('sell', null, 'trailing_stop');
    }
}
```

### The Missed Opportunity

| Position | Entry | Peak | Exit (should have been) | Actual |
|----------|-------|------|-------------------------|--------|
| ETH UP | 14¢ | 36¢ | ~32¢ (10% trail) | Held to 3¢ |
| SOL UP | 22¢ | 55¢ | ~50¢ (10% trail) | Held to 22¢ |

**ETH UP alone:** Entry 14¢, peak 36¢, 10% trailing stop = exit at 32¢ = **+128% profit**

### Fix Required

Add take-profit monitoring to `LiveTrader.monitorPositions()`:
```javascript
// Track high water mark per position
if (currentPrice > position.highWaterMark) {
    position.highWaterMark = currentPrice;
}

// Check trailing stop
const trailingStopPrice = position.highWaterMark * (1 - TRAILING_STOP_PCT);
if (position.trailingActive && currentPrice <= trailingStopPrice) {
    executeExit('trailing_stop');
}

// Activate trailing when profit exceeds threshold (e.g., 15%)
if (pnlPct >= TRAILING_ACTIVATION_PCT) {
    position.trailingActive = true;
}
```

---

## Issue 3: Opposite Bets in Same Market

### The Bug

No global coordination between strategies. Each strategy independently decides to trade, resulting in:

| Time | Strategy | Action | Result |
|------|----------|--------|--------|
| T1 | LagProb_Aggressive | BUY ETH UP @ 14¢ | Detected lag, correct! |
| T2 | SpotLag_Trail_V4 | BUY ETH DOWN @ 61¢ | Detected reversal, also correct! |
| T3 | Window End | Both resolve | One wins, one loses, net ~0 |

**Code reference:** `src/execution/live_trader.js:268` - No check for existing opposite position

### The Gold Mine We Missed

The system was RIGHT TWICE:
1. **T1:** Spot moved up, market lagged at 14% → BUY UP (correct)
2. **T2:** Spot reversed, market lagged at 61% for DOWN → BUY DOWN (correct)

If take-profit had exited the UP position before the DOWN entry:
- UP: +157% profit (14¢ → ~33¢)
- DOWN: +60% profit (61¢ → ~98¢)
- **Combined: Double profit instead of zero**

### Fix Required (partially applied)

Added to `processSignal()`:
```javascript
// CRITICAL: Prevent opposite bets in the same window
if (signal.action === 'buy') {
    for (const pos of livePositions) {
        if (pos.crypto === crypto && pos.windowEpoch === windowEpoch) {
            if (pos.tokenSide !== requestedSide) {
                logger.log(`BLOCKED OPPOSITE BET: ${strategyName} wants ${requestedSide} but have ${pos.tokenSide}`);
                return null;
            }
        }
    }
}
```

### Better Solution: Exit First, Then Reverse

Instead of blocking, we should:
1. Detect opposite signal
2. Check if current position is profitable
3. If yes: EXIT current position (take profit)
4. THEN enter the new opposite position

```javascript
if (pos.tokenSide !== requestedSide) {
    const currentPnl = calculatePnl(pos, tick);
    if (currentPnl > MIN_PROFIT_TO_REVERSE) {
        await executeExit(pos, 'reverse_signal');
        // Then allow the new entry to proceed
    } else {
        return null;  // Block if not profitable to reverse
    }
}
```

---

## Architecture Problem: Paper vs Live Disconnect

### Current Flow (Broken)

```
Tick arrives
    ↓
ResearchEngine.processTick()
    ↓
strategy.onTick(tick, PAPER_POSITION)  ← Wrong position data
    ↓
Signal generated based on paper PnL
    ↓
LiveTrader.processSignal(signal)
    ↓
LiveTrader has DIFFERENT positions with DIFFERENT prices
    ↓
Stop loss / take profit logic is WRONG
```

### Required Flow (Fixed)

```
Tick arrives
    ↓
ResearchEngine.processTick()
    ↓
strategy.onTick(tick, PAPER_POSITION)  ← For paper trading only
    ↓
LiveTrader.monitorPositions(tick)  ← CHECK LIVE POSITIONS DIRECTLY
    ├── Calculate LIVE PnL
    ├── Check stop loss against LIVE position
    ├── Check take profit against LIVE position
    └── Execute exits as needed
```

---

## Implementation Checklist

### Phase 1: Stop Loss (Critical)
- [x] Add `monitorPositions()` to LiveTrader
- [x] Add strategy-specific stop loss thresholds
- [ ] Fix duplicate exit triggering (add `exitInProgress` guard)
- [ ] Add position removal after exit attempt (success or fail)
- [ ] Test with paper trading parity check

### Phase 2: Take Profit (Critical)
- [ ] Add `highWaterMark` tracking to live positions
- [ ] Add `trailingActive` flag to live positions
- [ ] Implement trailing stop logic in `monitorPositions()`
- [ ] Add take-profit logging for monitoring
- [ ] Configure activation threshold (e.g., 15% profit)
- [ ] Configure trailing percentage (e.g., 10% from peak)

### Phase 3: Position Conflict (Critical)
- [x] Block opposite bets (basic protection)
- [ ] Implement "exit and reverse" logic
- [ ] Add minimum profit threshold for reversal
- [ ] Log reversal opportunities for analysis

### Phase 4: Testing
- [ ] Run backtests with new logic
- [ ] Paper trade for 24 hours
- [ ] Compare paper vs live position tracking
- [ ] Verify stop loss triggers at correct levels
- [ ] Verify take profit triggers at correct levels
- [ ] Verify no opposite bets slip through

---

## Key Metrics to Monitor Post-Fix

1. **Stop loss execution rate:** % of positions that hit stop loss and successfully exit
2. **Take profit capture:** Average % of peak profit captured vs lost
3. **Opposite bet blocks:** Count of blocked opposite bets
4. **Reversal opportunities:** Profitable exits followed by opposite entries
5. **Paper/Live parity:** Difference between paper and live PnL (should be minimal)

---

## Summary

The system's signal generation is working well - it correctly identified both the lag move AND the reversal. The failure is in position management:

| Component | Status | Impact |
|-----------|--------|--------|
| Entry signals | ✅ Working | Detected profitable opportunities |
| Stop loss | ❌ Broken | Held losers to expiry |
| Take profit | ❌ Broken | Let winners become losers |
| Position conflicts | ❌ Broken | Opposite bets cancelled profits |

**The path to profitability is clear:** Fix position management, and the good signals will translate to good returns.
