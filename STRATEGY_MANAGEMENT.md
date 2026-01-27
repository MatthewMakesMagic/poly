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
Only these strategies should be live:

**Time-Aware SpotLag (v2):**
- `SpotLag_TimeAware`
- `SpotLag_TimeAwareAggro`
- `SpotLag_TimeAwareSafe`
- `SpotLag_TimeAwareTP`
- `SpotLag_LateOnly`
- `SpotLag_ProbEdge`

**Endgame:**
- `Endgame`
- `Endgame_Aggressive`
- `Endgame_Conservative`
- `Endgame_Safe`
- `Endgame_Momentum`

**All other SpotLag strategies are DISABLED** - they don't incorporate time-aware logic.

## Future Enhancement: Full Probabilistic Model

**Status:** Planned (not yet implemented)

The TimeAware strategies currently use a moneyness filter (added Jan 2026) to prevent trades when spot is too far from strike. This is a pragmatic approximation.

A more rigorous approach would calculate the **theoretical probability impact** of any spot move using:

```
P(up) = Φ((S - K) / (σ√τ))
```

Where σ = window volatility, τ = time remaining as fraction.

This would allow the strategy to:
1. Calculate expected probability change from a spot move
2. Compare to actual market price change
3. Only trade when the gap exceeds a threshold (e.g., 3% probability edge)

**Why we haven't done this yet:**
- Adds model risk (what volatility to use?)
- Makes TimeAware converge toward ProbEdge (reduces diversification)
- Current moneyness filter captures 80% of the benefit with 20% complexity

**When to revisit:**
- If we see TimeAware taking bad trades that the filter doesn't catch
- If we want to unify all SpotLag strategies into a single probabilistic framework
- When we have enough data to estimate per-crypto, time-varying volatility reliably

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
