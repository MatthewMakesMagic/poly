# Go Live Checklist

Pre-deployment review for live trading systems.

## Critical: Module Load Timing

**Issue discovered Jan 2026:** Static ES module imports are hoisted before any code runs.

```javascript
// THIS DOES NOT WORK AS EXPECTED:
process.env.LIVE_TRADING_ENABLED = 'true';  // Appears first
import { TickCollector } from './tick_collector.js';  // Actually runs FIRST

// The import runs BEFORE the env var is set because static imports are hoisted
```

**Fix:** Check environment variables at RUNTIME (in `initialize()` or similar), not at module load time.

```javascript
// BAD - evaluated when module loads (before env var is set)
const CONFIG = {
    ENABLED: process.env.LIVE_TRADING_ENABLED === 'true',
};

// GOOD - checked at runtime when initialize() is called
async initialize() {
    const isEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
    // ...
}
```

---

## Pre-Deploy Checklist

### 1. Environment Variables
- [ ] `LIVE_TRADING_ENABLED` - set to 'true' for live trading
- [ ] `LIVE_POSITION_SIZE` - default $1, adjust as needed
- [ ] `PROXY_URL` - required to bypass Cloudflare blocks
- [ ] API keys configured (POLY_API_KEY, etc.)

### 2. Strategy Configuration
- [ ] Check `scripts/start_collector.js` - which strategies are in `toEnable` vs `toDisable`
- [ ] Verify strategy names match between code and database
- [ ] Run `verifyStrategySync()` output - no "CRITICAL" mismatches

### 3. Position Management
- [ ] Take profit configs set per strategy in `TP_STRATEGY_CONFIG`
- [ ] Stop loss thresholds configured in `SL_STRATEGY_CONFIG`
- [ ] Position state machine working (OPEN → EXITING → CLOSED)

### 4. Risk Controls
- [ ] Max positions per market limit
- [ ] Daily loss limit configured
- [ ] Opposite bet detection active (prevents UP + DOWN on same market)

---

## Post-Deploy Verification

### Immediate (first 30 seconds)
```bash
railway logs | grep -E "(LIVE TRADING ENABLED|API verified|Balance)"
```

Expected output:
```
🔴 LIVE TRADING ENABLED (set automatically)
[LiveTrader] API verified - Balance: X USDC
```

### First 5 minutes
```bash
railway logs | grep -E "(LiveTrader|TEST ENTRY|EXECUTING|Take profit|Stop loss)"
```

Watch for:
- Strategy signals generating
- Live trades executing (not just paper)
- TP/SL monitoring active

### Ongoing Monitoring
```bash
# Check for errors
railway logs | grep -E "(ERROR|FAILED|Exception)"

# Check trade execution
railway logs | grep "EXECUTING"

# Check TP/SL triggers
railway logs | grep -E "(Take profit|Stop loss|trailing)"
```

---

## Emergency Procedures

### Stop All Trading Immediately
Option 1 - Environment variable:
```bash
railway variables set LIVE_TRADING_ENABLED=false
```

Option 2 - Code change (if env var doesn't propagate):
```javascript
// In live_trader.js initialize()
async initialize() {
    return false;  // Emergency stop
}
```

### Known Issues Log

| Date | Issue | Root Cause | Fix |
|------|-------|------------|-----|
| Jan 2026 | Live trading always disabled | Static imports hoisted before env var set | Check env var at runtime in initialize() |
| Jan 2026 | Opposite bets cancelling profits | No global position coordination | Added conflict detection in processSignal() |
| Jan 2026 | TP/SL not triggering | Strategies checked paper positions, not live | Added monitorPositions() for live position checks |

---

## Strategy-Specific Settings

### Take Profit Configs (in live_trader.js)
```javascript
'TP_SL_Test': { activation: 0.10, trail: 0.10, floor: 0.03 },
'SpotLag_Trail_V1': { activation: 0.20, trail: 0.15, floor: 0.08 },
'SpotLag_Trail_V2': { activation: 0.15, trail: 0.12, floor: 0.06 },
// ... etc
```

### Test Mode
Before enabling production strategies, validate with `TP_SL_Test`:
1. Only enable `TP_SL_Test` in start_collector.js
2. Watch for 10 successful TP or SL exits
3. Then re-enable production strategies
