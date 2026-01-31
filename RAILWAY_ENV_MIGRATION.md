# Railway Environment Variable Migration Guide

This document describes the environment variables that need to be updated in Railway after migrating from the old execution system to the new modular system.

## Summary

The new modular system uses centralized configuration (`config/default.js`, `config/production.js`) instead of scattered environment variables. Many old env vars are **no longer used** and should be **removed** from Railway.

## Environment Variables to REMOVE from Railway

These variables are from the old system and are no longer used:

| Variable | Old Purpose | Why Remove |
|----------|-------------|------------|
| `LIVE_TRADING_ENABLED` | Toggle live trading | New system is always live-ready, controlled by config |
| `LIVE_POSITION_SIZE` | Position size in USD | Replaced by `config.strategy.sizing.baseSizeDollars` |
| `MAX_POSITION_PER_TRADE` | Max per trade | Replaced by `config.risk.maxPositionSize` |
| `MAX_TOTAL_EXPOSURE` | Max total exposure | Replaced by `config.risk.maxExposure` |
| `MAX_LOSS_PER_DAY` | Daily loss limit | Replaced by `config.risk.dailyDrawdownLimit` |
| `POLYMARKET_SECRET` | API secret | Renamed to `POLYMARKET_API_SECRET` |
| `DATABASE_URL` | PostgreSQL connection | Replaced by `DATABASE_PATH` for SQLite |
| `DASHBOARD_PORT` | Old dashboard | Old dashboard removed |
| `DISCORD_WEBHOOK_URL` | Discord alerts | Old notification system removed |
| `PROXY_URL` | HTTP proxy | No longer needed with new system |

## Environment Variables to ADD/UPDATE in Railway

### Required Variables

```bash
# Node environment
NODE_ENV=production

# Polymarket API credentials (note the name change!)
POLYMARKET_API_URL=https://clob.polymarket.com
POLYMARKET_API_KEY=<your-api-key>
POLYMARKET_API_SECRET=<your-api-secret>     # Was POLYMARKET_SECRET
POLYMARKET_PASSPHRASE=<your-passphrase>
POLYMARKET_PRIVATE_KEY=<your-private-key>
POLYMARKET_FUNDER_ADDRESS=<your-funder-address>

# Spot price feed
SPOT_PROVIDER=pyth
SPOT_ENDPOINT=<your-spot-endpoint>

# Logging
LOG_LEVEL=warn   # 'warn' for production silence, 'info' for debugging

# Database (SQLite path - optional, defaults to ./data/poly.db)
DATABASE_PATH=./data/poly.db

# Optional: Starting capital for drawdown calculations
STARTING_CAPITAL=1000
```

## Configuration Comparison

### Position Sizing

**OLD (env var):**
```bash
LIVE_POSITION_SIZE=6  # Min $6, used directly
```

**NEW (config file):**
```javascript
// config/default.js
strategy: {
  sizing: {
    baseSizeDollars: 10,     // Change this for different base size
    minSizeDollars: 1,
    maxSlippagePct: 0.01,
    confidenceMultiplier: 0.5,
  }
}
```

To change position size: Edit `config/default.js` or create environment override.

### Risk Limits

**OLD (env vars):**
```bash
MAX_POSITION_PER_TRADE=1
MAX_TOTAL_EXPOSURE=20
MAX_LOSS_PER_DAY=20
```

**NEW (config file):**
```javascript
// config/production.js
risk: {
  maxPositionSize: 100,      // Max $100 per position
  maxExposure: 500,          // Max $500 total exposure
  dailyDrawdownLimit: 0.05,  // 5% drawdown limit
}
```

## Railway Service Configuration

Update `railway.live.json` is already correct:
```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm run live",
    "restartPolicyType": "ALWAYS",
    "numReplicas": 1,
    "healthcheckPath": "/api/live/status"
  }
}
```

## Migration Steps

1. **Backup current Railway env vars** (screenshot or export)
2. **Remove old variables** listed above from Railway dashboard
3. **Add/update required variables** with new names
4. **Redeploy** with the new entry point
5. **Verify** logs show the new modular system starting

## Position Size Issue (12.56 USD)

The issue where position size was 12.56 instead of 2 USD was caused by:

1. Railway running the OLD code (`src/execution/live_trader.js`)
2. Old code has scaling logic: `POSITION_SIZE / STRATEGY_CAPITAL_BASE`
3. Old code enforces minimum $6: `Math.max(6, parseFloat(process.env.LIVE_POSITION_SIZE || '6'))`

After this migration, position sizing is controlled by `config.strategy.sizing.baseSizeDollars` which defaults to **$2** with confidence multiplier disabled (fixed size).
