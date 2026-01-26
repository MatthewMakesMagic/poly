# Polymarket Execution Engine

Production-grade 24/7 trading execution system for Polymarket 15-minute crypto prediction markets.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      EXECUTION ENGINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │  Polymarket  │   │   Binance    │   │   Strategy   │        │
│  │  WebSocket   │   │  WebSocket   │   │   Module     │        │
│  │  (orderbook) │   │   (spot)     │   │  (signals)   │        │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘        │
│         │                  │                   │                 │
│         └──────────────────┼───────────────────┘                 │
│                            │                                     │
│                   ┌────────▼────────┐                           │
│                   │  TICK PROCESSOR │                           │
│                   └────────┬────────┘                           │
│                            │                                     │
│              ┌─────────────┼─────────────┐                      │
│              │             │             │                       │
│     ┌────────▼───────┐ ┌───▼────┐ ┌─────▼──────┐               │
│     │ RISK MANAGER   │ │ ORDER  │ │  HEALTH    │               │
│     │ - Kill Switch  │ │ STATE  │ │  MONITOR   │               │
│     │ - Circuit Brkr │ │ MACHINE│ │  - Alerts  │               │
│     │ - Limits       │ │        │ │  - Logging │               │
│     └────────────────┘ └────────┘ └────────────┘               │
│                                                                  │
│              ┌─────────────────────────┐                        │
│              │    POLYMARKET CLIENT    │                        │
│              │    - Order Placement    │                        │
│              │    - Order Cancellation │                        │
│              │    - Position Query     │                        │
│              └─────────────────────────┘                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Configure Environment

Copy `env.example` to `.env` and fill in your credentials:

```bash
cp env.example .env
```

Required variables:
- `POLYMARKET_API_KEY` - From Polymarket Settings > Builder Codes
- `POLYMARKET_SECRET` - From Polymarket Settings > Builder Codes  
- `POLYMARKET_PASSPHRASE` - From Polymarket Settings > Builder Codes
- `POLYMARKET_PRIVATE_KEY` - Your wallet private key

### 2. Test Your Setup

Run the connection test first (no money involved):

```bash
npm run exec:test:connection
```

### 3. Test Order Placement (Non-Executing)

Test placing a limit order that won't fill:

```bash
npm run exec:test:limit
```

### 4. Test Real Order ($1)

**WARNING: This will execute a real $1 trade!**

```bash
npm run exec:test:market
```

### 5. Run Dry Run

Test engine startup without trading:

```bash
npm run exec:dry-run
```

### 6. Start Trading

Paper trading (simulated execution):
```bash
npm run exec:paper
```

**Live trading (REAL MONEY):**
```bash
npm run exec:live
```

## Component Details

### PolymarketClient (`polymarket_client.js`)

Handles all communication with Polymarket's CLOB API:

- **Authentication**: HMAC-based L2 authentication + EIP-712 order signing
- **Order Placement**: Market, limit, FOK, IOC orders
- **Order Management**: Cancel, cancel all, status queries
- **Market Data**: Order book, midpoint, spread, tick size

```javascript
import { PolymarketClient, Side, OrderType } from './src/execution/index.js';

const client = new PolymarketClient({
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
    privateKey: process.env.POLYMARKET_PRIVATE_KEY
});

// Place a limit order
const response = await client.placeOrder({
    tokenId: 'abc123...',
    price: 0.55,
    size: 10,
    side: Side.BUY,
    orderType: OrderType.GTC
});
```

### OrderManager (`order_state_machine.js`)

Tracks every order through its complete lifecycle:

**States:**
- `PENDING` - Order created, not yet submitted
- `SUBMITTED` - Sent to exchange, awaiting confirmation
- `OPEN` - Confirmed and live on the order book
- `PARTIALLY_FILLED` - Some fills received
- `FILLED` - Completely filled
- `CANCELLED` - User cancelled
- `REJECTED` - Exchange rejected
- `EXPIRED` - Order expired (GTD orders)
- `FAILED` - System error

**Features:**
- Complete audit trail for every order
- Event emission for state changes
- P&L calculation
- Slippage tracking
- Serialization for crash recovery

### RiskManager (`risk_manager.js`)

**CRITICAL SAFETY COMPONENT** - Protects capital through multiple layers:

#### Kill Switch
- Manual activation via file or code
- Immediately halts ALL trading
- Requires explicit deactivation

```bash
# Emergency stop - create this file:
echo "Emergency stop" > KILL_SWITCH
```

#### Circuit Breaker
- Trips on excessive losses in time window
- Default: $10 loss in 5 minutes
- Auto-resets after 15 minute cooldown

#### Position Limits
| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxPositionPerTrade` | $1 | Maximum single order size |
| `maxPositionPerWindow` | $5 | Maximum exposure per 15-min window |
| `maxTotalExposure` | $20 | Maximum total open positions |
| `maxOpenOrders` | 5 | Maximum concurrent orders |

#### Loss Limits
| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxLossPerTrade` | $1 | Stop loss per trade |
| `maxLossPerHour` | $5 | Hourly loss limit |
| `maxLossPerDay` | $20 | Daily loss limit |
| `stopTradingAfterConsecutiveLosses` | 50 | Auto-stop after streak (effectively disabled) |

#### Market Quality Checks
- Minimum bid/ask size: $10
- Maximum spread: 10%
- Maximum slippage: 5%
- Time restrictions: 30s-870s remaining

### ExecutionEngine (`execution_engine.js`)

The main orchestrator that runs 24/7:

**Responsibilities:**
- Maintains WebSocket connections to Polymarket and Binance
- Processes ticks and generates signals
- Executes orders through risk-validated pipeline
- Tracks positions and P&L
- Persists state for crash recovery
- Emits events for monitoring

**States:**
- `STOPPED` - Engine not running
- `STARTING` - Initialization in progress
- `RUNNING` - Actively trading
- `PAUSED` - Connections alive but not trading
- `ERROR` - Error state, needs intervention
- `STOPPING` - Graceful shutdown in progress

### HealthMonitor (`health_monitor.js`)

Monitors system health and sends alerts:

**Alert Channels:**
- Console (always on)
- File logging (`./logs/health.log`)
- Discord webhooks (for WARNING+)

**Alert Types:**
- System: start/stop, errors, WebSocket issues
- Risk: kill switch, circuit breaker, loss limits
- Trading: fills, rejections, high slippage
- Performance: daily/hourly summaries

## Risk Management Philosophy

This system is designed with **fail-safe defaults**:

1. **Default to NOT trading** - Any uncertainty stops execution
2. **Multiple safety layers** - Kill switch > Circuit breaker > Limits
3. **Complete audit trail** - Every action is logged
4. **Conservative defaults** - Start with $1 trades, scale up manually
5. **Human oversight required** - No full autonomy

## Handling Edge Cases

### Liquidity Issues
- Pre-trade liquidity check (min $10 on each side)
- Order book depth requirements
- Slippage estimation before execution

### Slippage
- Pre-trade slippage estimation
- Real-time slippage tracking
- Alert on excessive slippage (>3%)
- Adjustable buffers on market orders

### Execution Failures
- Automatic retry with exponential backoff (up to 3 attempts)
- Order state preserved on failure
- Failed orders logged with full context
- Circuit breaker consideration for repeated failures

### System Recovery
- State persisted every 10 seconds
- Automatic state restoration on restart
- Open orders reconciled on startup
- Position state preserved across restarts

## Testing Checklist

Before going live, verify:

- [ ] `npm run exec:test:connection` passes
- [ ] `npm run exec:test:limit` - Order placed and cancelled
- [ ] `npm run exec:test:market` - $1 round-trip executed
- [ ] `npm run exec:dry-run` - Engine starts successfully
- [ ] Discord alerts working (if configured)
- [ ] Kill switch file test: `touch KILL_SWITCH` stops trading
- [ ] Database state persistence verified

## Monitoring

### Real-time Status

The engine logs status every 5 minutes including:
- Uptime
- Trade count
- Net P&L
- Open positions
- Risk status

### Health Endpoints

Engine exposes these methods:
```javascript
engine.getStatus()       // Full system status
engine.getCurrentTick()  // Latest market data
engine.riskManager.getStatus()  // Risk metrics
```

## Scaling Up

**START SMALL** and scale gradually:

1. **Day 1-7**: $1 trades, manual review of every trade
2. **Week 2**: $5 trades if profitable, tight loss limits
3. **Week 3+**: Gradually increase based on performance

To increase limits, modify `riskParams` in the engine options:

```javascript
const engine = new ExecutionEngine({
    riskParams: {
        maxPositionPerTrade: 5,      // Increase from $1
        maxPositionPerWindow: 25,
        maxTotalExposure: 100,
        maxLossPerDay: 50
    }
});
```

## Emergency Procedures

### Immediate Stop
```bash
# Option 1: Create kill switch file
echo "Emergency" > KILL_SWITCH

# Option 2: Kill the process
pkill -f "run_execution_engine"
```

### Recovery After Stop
1. Remove kill switch: `rm KILL_SWITCH`
2. Review logs: `cat logs/health.log | tail -100`
3. Check state: `cat execution_state.json`
4. Restart: `npm run exec:live`

### Loss Recovery
After hitting daily loss limit:
1. Wait until next day (automatic reset)
2. OR manually reset in code if confident:
   ```javascript
   engine.riskManager.resetDailyStats();
   ```

## File Structure

```
src/execution/
├── index.js              # Module exports
├── polymarket_client.js  # API client
├── order_state_machine.js # Order tracking
├── risk_manager.js       # Risk controls
├── execution_engine.js   # Main orchestrator
└── health_monitor.js     # Monitoring & alerts

scripts/
├── test_live_order.mjs      # Order testing harness
└── run_execution_engine.mjs # Engine launcher
```

## Troubleshooting

### "Missing environment variable"
Ensure all required variables are in `.env`:
```
POLYMARKET_API_KEY=xxx
POLYMARKET_SECRET=xxx
POLYMARKET_PASSPHRASE=xxx
POLYMARKET_PRIVATE_KEY=xxx
```

### "API Error 401"
- Check API credentials are correct
- Verify API key hasn't been revoked
- Ensure private key matches the account

### "Order rejected: insufficient balance"
- Check USDC balance on Polymarket
- Verify collateral is deposited

### "WebSocket disconnected"
- Normal - auto-reconnects
- If persistent, check network connectivity
- Max 10 reconnect attempts before pause

### "Circuit breaker tripped"
- Wait 15 minutes for auto-reset
- Review recent trades for issues
- Consider reducing position sizes
