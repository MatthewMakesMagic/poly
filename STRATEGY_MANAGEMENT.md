# Strategy Management Guide

## Critical Rules

### 1. Strategy Code ↔ Database Sync
**ALWAYS** ensure strategies exist in BOTH:
- `src/quant/strategies/index.js` (createAllQuantStrategies function)
- `live_strategies` table in database

If a strategy is enabled in the database but doesn't exist in code, **live trading will silently fail** for that strategy.

### 2. Naming Convention
Strategy names must match EXACTLY between:
- The `getName()` return value in strategy class
- The `strategy_name` column in `live_strategies` table
- The migration enable/disable lists in `scripts/start_collector.js`

### 3. Currently Enabled (Jan 2026)

**Time-Aware SpotLag (v2):**
- `SpotLag_TimeAware`
- `SpotLag_TimeAwareAggro`
- `SpotLag_TimeAwareSafe`
- `SpotLag_TimeAwareTP`
- `SpotLag_LateOnly`
- `SpotLag_ProbEdge`

**SpotLag Trail V1-V4 (Conviction-Based):**
- `SpotLag_Trail_V1` - Safe: only RIGHT side of strike, 40% stop
- `SpotLag_Trail_V2` - Moderate: wrong side only late (<120s), 30% stop
- `SpotLag_Trail_V3` - Base: both sides with 25% stop
- `SpotLag_Trail_V4` - Aggressive: both sides with 20% stop
- ~~`SpotLag_Trail_V5`~~ - **DISABLED** (too aggressive, -$1.06 P&L)

**Pure Probabilistic (NEW Jan 2026):**
- `PureProb_Base` - 5% min edge, dynamic sizing
- `PureProb_Conservative` - 8% min edge, selective
- `PureProb_Aggressive` - 3% min edge, larger positions
- `PureProb_Late` - Only last 2 min, highest conviction

**Lag + Probabilistic (NEW Jan 2026):**
- `LagProb_Base` - Lag detection + 3% min edge
- `LagProb_Conservative` - Higher thresholds, right side only
- `LagProb_Aggressive` - Lower thresholds, larger positions
- `LagProb_RightSide` - ONLY trades right side of strike

**Endgame (10x position size - killing it!):**
- `Endgame` - $1000 position, >90% prob in last 60s
- `Endgame_Aggressive` - $1000 position, >85% prob in last 90s
- `Endgame_Conservative` - $1000 position, >95% prob in last 30s
- `Endgame_Safe` - $1000 position, >97% prob in last 20s
- `Endgame_Momentum` - $1000 position, with momentum confirmation

## Probability Model (IMPLEMENTED Jan 2026)

### Core Formula
```javascript
// Expected probability based on spot displacement and time
function calculateExpectedProbability(spotDeltaPct, timeRemainingSec) {
    // Base probs calibrated from data
    const baseProbs = {
        600: 0.80,  // 10min: ~80%
        300: 0.85,  // 5min: ~85%
        120: 0.89,  // 2min: ~89%
        60: 0.90,   // 1min: ~90%
        30: 0.91,   // 30s: ~91%
    };

    // Adjust for delta magnitude (larger = more confident)
    const deltaMultiplier = Math.min(0.5 + (|spotDeltaPct| / 0.2), 1.5);
    return 0.5 + (baseProb - 0.5) * deltaMultiplier;
}
```

### Dynamic Position Sizing
```javascript
function calculateDynamicSize(edge, conviction, liquidity, baseSize) {
    // Edge multiplier: 5% edge = 1x, 10% = 2x, 15%+ = 3x
    const edgeMultiplier = Math.min(Math.max(edge / 0.05, 0.5), 3.0);

    // Conviction multiplier: high conviction = 1x, low = 0.5x
    const convictionMultiplier = 0.5 + (conviction * 0.5);

    // Size calculation
    let size = baseSize * edgeMultiplier * convictionMultiplier;

    // Liquidity cap: never take >10% of book
    return Math.min(size, liquidity * 0.10, baseSize * 3);
}
```

### Conviction Score
```javascript
// Conviction = time_weight × strike_weight
const timeWeight = timeRemaining < 60 ? 1.0 : timeRemaining < 120 ? 0.8 : 0.6;
const strikeWeight = rightSideOfStrike ? 1.0 : 0.5;
const conviction = timeWeight * strikeWeight;
```

### Strike Alignment (Right Side of Strike)
- **RIGHT side**: Betting UP when spot > strike, or DOWN when spot < strike
- **WRONG side**: Betting opposite to spot's position vs strike
- **Key insight**: 65.4% WR when correct side vs 14.3% when wrong side

## Strategy Sets

### Set 1: Pure Probabilistic (PureProb_*)
Trade purely on probability edge - **no lag detection required**.
- Calculates expected prob from spot delta + time
- Compares to market probability
- Trades when edge exceeds threshold
- Dynamic sizing based on edge magnitude

### Set 2: Lag + Probabilistic (LagProb_*)
Combines lag detection with probability model:
1. Detect micro-lag (spot moved, market hasn't caught up)
2. Validate with probability model (edge check)
3. Size position dynamically based on edge + conviction
4. Stop loss for wrong-side entries

### 4. How to Add a New Strategy

1. Create the strategy class in `src/quant/strategies/`
2. Export it from `src/quant/strategies/index.js`
3. Add to `createAllQuantStrategies()` function
4. Add to `toEnable` list in `scripts/start_collector.js`
5. Deploy and verify with: `railway logs | grep "Enabled.*strategy_name"`

### 5. How to Disable a Strategy

1. Add to `toDisable` list in `scripts/start_collector.js`
2. Deploy
3. Verify with DB query: `SELECT * FROM live_strategies WHERE strategy_name = 'X'`

## Debugging Live Trading Issues

### Check if live trading is running:
```bash
railway logs | grep -iE "LiveTrader|enabled: true"
```

### Check enabled strategies in DB:
```sql
SELECT strategy_name, enabled FROM live_strategies WHERE enabled = true;
```

### Check recent live trades:
```sql
SELECT timestamp_et, strategy_name, crypto, side, pnl
FROM live_trades
ORDER BY id DESC LIMIT 20;
```
Note: Use `timestamp_et` NOT `timestamp` (timezone bug).

### Verify strategy exists in code:
```bash
node -e "import('./src/quant/strategies/index.js').then(m => console.log(m.createAllQuantStrategies(100).map(s => s.getName())))"
```

## Common Failure Modes

1. **Strategy enabled in DB but not in code** → Silent failure, no trades
2. **LIVE_TRADING_ENABLED not set** → LiveTrader doesn't initialize
3. **Strategy name typo** → DB and code don't match
4. **Process crash without restart** → Check Railway logs for errors

## Health Check Query
Run this to detect mismatches:
```sql
-- Find strategies enabled but not producing trades
SELECT ls.strategy_name, ls.enabled,
       (SELECT COUNT(*) FROM live_trades lt WHERE lt.strategy_name = ls.strategy_name AND lt.timestamp > NOW() - INTERVAL '1 hour') as trades_1h
FROM live_strategies ls
WHERE ls.enabled = true
ORDER BY trades_1h ASC;
```

## Stop Loss Architecture (Jan 2026 Fix)

### Critical Understanding: Paper vs Live Positions

**Problem:** Strategies only see PAPER positions, not LIVE positions!

- `ResearchEngine.processTick()` calls `strategy.onTick(tick, position, {})`
- The `position` argument comes from `ResearchEngine.positions` (paper trading)
- LiveTrader has its own `livePositions` that strategies NEVER see
- Strategy stop loss logic evaluates paper PnL, NOT live PnL

**Solution:** LiveTrader monitors its own positions directly

```javascript
// LiveTrader.monitorPositions() - called on EVERY tick
for (const position of livePositions) {
    const pnlPct = (currentPrice - entryPrice) / entryPrice;
    if (pnlPct < -stopLossThreshold) {
        executeExit(); // Direct exit, no strategy involvement
    }
}
```

### Strategy-Specific Stop Losses
| Strategy | Stop Loss | Notes |
|----------|-----------|-------|
| SpotLag_Trail_V1 | 40% | Safe |
| SpotLag_Trail_V2 | 30% | Moderate |
| SpotLag_Trail_V3 | 25% | Base |
| SpotLag_Trail_V4 | 20% | Aggressive |
| PureProb_* | 20-30% | Varies |
| LagProb_* | 20-30% | Varies |
| Default | 25% | All others |

### Verify Stop Loss is Working
```bash
railway logs | grep "STOP LOSS TRIGGERED"
```
