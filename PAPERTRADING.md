# Paper Trading System Documentation

Last Updated: January 25, 2026

## Overview

The paper trading system runs **continuously on Railway** (cloud deployment) and simulates trades across multiple quantitative strategies. It uses real market data but does not execute actual trades on Polymarket.

**Current Status:**
- 5,821+ paper trades executed since Jan 23, 2026
- +$16,506.37 cumulative P&L (simulated)
- 35.4% overall win rate
- Top strategies achieving 83-88% win rates

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        RAILWAY (Cloud)                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              TICK COLLECTOR SERVICE                      │   │
│  │              scripts/start_collector.js                  │   │
│  │                                                          │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │   │
│  │  │   Binance    │    │  Polymarket  │    │ Chainlink │  │   │
│  │  │  WebSocket   │    │  WebSocket   │    │   Oracle  │  │   │
│  │  │ (spot price) │    │ (order book) │    │  (Polygon)│  │   │
│  │  └──────┬───────┘    └──────┬───────┘    └─────┬─────┘  │   │
│  │         │                   │                  │        │   │
│  │         └─────────┬─────────┴──────────┬───────┘        │   │
│  │                   │                    │                │   │
│  │                   ▼                    ▼                │   │
│  │         ┌─────────────────────────────────────┐         │   │
│  │         │          TICK AGGREGATOR            │         │   │
│  │         │   (combines all data sources)       │         │   │
│  │         └─────────────────┬───────────────────┘         │   │
│  │                           │                             │   │
│  │                           ▼                             │   │
│  │         ┌─────────────────────────────────────┐         │   │
│  │         │        RESEARCH ENGINE              │         │   │
│  │         │   src/quant/research_engine.js      │         │   │
│  │         │                                     │         │   │
│  │         │   • Fair Value Calculator           │         │   │
│  │         │   • Volatility Estimator            │         │   │
│  │         │   • Spot Lag Analyzer               │         │   │
│  │         │   • Regime Detector                 │         │   │
│  │         │   • 30+ Trading Strategies          │         │   │
│  │         └─────────────────┬───────────────────┘         │   │
│  │                           │                             │   │
│  │                           ▼                             │   │
│  │         ┌─────────────────────────────────────┐         │   │
│  │         │      PAPER TRADE EXECUTOR           │         │   │
│  │         │   (simulated fills at bid/ask)      │         │   │
│  │         └─────────────────┬───────────────────┘         │   │
│  │                           │                             │   │
│  └───────────────────────────┼─────────────────────────────┘   │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               ▼
                ┌─────────────────────────────┐
                │    SUPABASE POSTGRESQL      │
                │                             │
                │  • ticks (944K+ records)    │
                │  • paper_trades (5.8K+)     │
                │  • windows (876)            │
                │  • system_state             │
                └─────────────────────────────┘
```

---

## Key Components

### 1. Tick Collector (`src/collectors/tick_collector.js`)

The main service that runs 24/7 on Railway. Responsibilities:
- Connects to Binance WebSocket for real-time spot prices
- Connects to Polymarket WebSocket for order book data
- Fetches Chainlink oracle prices from Polygon (actual resolution prices)
- Aggregates data into standardized "tick" objects
- Stores ticks to PostgreSQL database
- Runs all strategies through the Research Engine
- Detects window changes (every 15 minutes)

**Important:** The collector runs on Railway, NOT locally. To check if it's running:
```bash
node scripts/check_health.mjs
```

### 2. Research Engine (`src/quant/research_engine.js`)

Coordinates all quantitative analysis. Contains:
- **Fair Value Calculator**: Black-Scholes based fair probability
- **Volatility Estimator**: Multiple volatility estimation methods
- **Spot Lag Analyzer**: Measures how fast market prices spot moves
- **Regime Detector**: Identifies market regime (trending/ranging)
- **Strategy Manager**: Runs 30+ strategies on each tick

### 3. Strategies (`src/quant/strategies/`)

All strategies implement the same interface:
```javascript
strategy.onTick(tick, position, context) → { action: 'buy'|'sell'|'hold', side, reason }
```

**Current Strategy Categories:**

| Category | Strategies | Description |
|----------|------------|-------------|
| **SpotLag** | SpotLag_Aggressive, SpotLag_Fast, etc. | Trade when market lags spot price movements |
| **FairValue** | FairValue_EWMA, FairValue_WithDrift, etc. | Trade deviations from Black-Scholes fair value |
| **Contrarian** | Contrarian, Contrarian_Scalp, etc. | Fade (bet against) recent spot movements |
| **Endgame** | Endgame, Endgame_Aggressive, etc. | Buy near-certain outcomes in final seconds |
| **Mispricing** | Mispricing_Loose, Mispricing_Strict, etc. | Trade large market mispricings |
| **Regime** | Regime | Adapt to market conditions |
| **Time** | TimeConditional | Different behavior by window phase |
| **Microstructure** | Microstructure | Order flow and spread signals |

### 4. Paper Trade Execution

When a strategy signals a trade:

1. **Entry (buy signal):**
   - Records entry price (ask for UP, 1-bid for DOWN)
   - Stores entry tick data (spot, spread, time remaining)
   - Creates position in memory

2. **Exit (sell signal OR window expiry):**
   - Calculates exit price (bid for UP, 1-ask for DOWN)
   - Computes P&L: `(exitPrice - entryPrice) * size`
   - Saves to `paper_trades` table
   - Updates strategy performance metrics

**At window expiry:** Positions resolve as binary outcomes (price goes to $1 or $0).

---

## Database Schema

### `paper_trades` Table (Main Paper Trading Data)

```sql
CREATE TABLE paper_trades (
    id SERIAL PRIMARY KEY,
    strategy_name TEXT,
    crypto TEXT,
    side TEXT,                    -- 'up' or 'down'
    entry_time TIMESTAMP,
    exit_time TIMESTAMP,
    window_epoch INTEGER,
    holding_time_ms INTEGER,
    entry_price REAL,
    exit_price REAL,
    entry_spot_price REAL,
    exit_spot_price REAL,
    price_to_beat REAL,
    entry_market_prob REAL,
    exit_market_prob REAL,
    time_remaining_at_entry REAL,
    pnl REAL,
    outcome TEXT,                 -- 'up', 'down', or null
    reason TEXT,
    entry_bid_size REAL,
    entry_ask_size REAL,
    entry_spread REAL,
    entry_spread_pct REAL,
    exit_bid_size REAL,
    exit_ask_size REAL,
    exit_spread REAL,
    spot_move_during_trade REAL,
    market_move_during_trade REAL,
    signal_strength REAL,
    entry_book_imbalance REAL
);
```

### `ticks` Table

Raw market data (1 tick per second per crypto):
- Spot price (Binance)
- Order book (Polymarket)
- Chainlink oracle price (for resolution comparison)
- Price divergence (Binance vs Chainlink)

### `trades` Table (UNUSED for paper trading)

This table was designed for a separate `paper_trader.js` system that is NOT currently running. Paper trades go to `paper_trades` table instead.

### `windows` Table

15-minute window summaries with outcomes.

---

## Checking Performance

### Quick Database Check

```bash
# Run from project root
node scripts/review_paper_performance.mjs 6   # Last 6 hours
node scripts/db_status.mjs                    # Full status
```

### SQL Queries (Direct Database Access)

```sql
-- Strategy performance last 24 hours
SELECT 
    strategy_name,
    COUNT(*) as trades,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl)::numeric, 2) as total_pnl,
    ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::float / COUNT(*) * 100)::numeric, 1) as win_rate
FROM paper_trades
WHERE exit_time > NOW() - INTERVAL '24 hours'
GROUP BY strategy_name
ORDER BY total_pnl DESC;

-- Recent individual trades
SELECT 
    exit_time,
    strategy_name,
    crypto,
    side,
    ROUND(pnl::numeric, 2) as pnl,
    outcome
FROM paper_trades
ORDER BY exit_time DESC
LIMIT 20;
```

### Via API (when dashboard running)

```bash
# Get paper trades via API
curl "http://localhost:3333/api/paper-trades?period=hour"
```

---

## Data Flow: Tick → Trade

```
1. TICK ARRIVES
   └─→ Binance spot: $88,621
   └─→ Polymarket: UP bid=0.45, ask=0.49
   └─→ Chainlink: $88,650

2. RESEARCH ENGINE PROCESSES
   └─→ Fair value calculated: 0.52
   └─→ Spot delta: +0.15% above price_to_beat
   └─→ Market prob: 0.47 (mid)
   └─→ Regime: trending_up

3. EACH STRATEGY EVALUATES
   └─→ SpotLag_Aggressive: "BUY UP" (spot up, market hasn't moved)
   └─→ FairValue_EWMA: "HOLD" (market within fair range)
   └─→ Contrarian: "HOLD" (waiting for bigger move)

4. PAPER TRADE EXECUTED
   └─→ SpotLag_Aggressive opens position
   └─→ Entry price: 0.49 (ask)
   └─→ Size: $100
   └─→ Saved to positions map

5. LATER: EXIT SIGNAL or WINDOW EXPIRY
   └─→ Exit price: 0.98 (bid at expiry)
   └─→ P&L: (0.98 - 0.49) * 100 = $49
   └─→ Saved to paper_trades table
```

---

## Current Top Performers (as of Jan 25, 2026)

| Strategy | Win Rate | Total P&L | Notes |
|----------|----------|-----------|-------|
| SpotLag_Aggressive | 87.7% | +$1,084 | Best overall |
| SpotLag_Fast | 88.4% | +$763 | High win rate |
| Mispricing_Loose | 100% | +$263 | Small sample |
| SpotLag_Confirmed | 100% | +$105 | Very selective |
| FairValue_WithDrift | 34.4% | +$606 | Volume player |

### Strategies to Avoid

| Strategy | Win Rate | Total P&L | Issue |
|----------|----------|-----------|-------|
| Contrarian_Scalp | 23.2% | -$939 | Market trending |
| Contrarian | 22.0% | -$690 | Fading winners |
| FV_Drift_1H | 39.0% | -$495 | Drift estimate off |

---

## CRITICAL: Strategy Conflicts

**94% of windows have strategies taking OPPOSITE sides!**

### Conflict Analysis

| Crypto | Windows with Conflicts | Total Windows | Conflict Rate |
|--------|------------------------|---------------|---------------|
| BTC | 123 | 130 | 95% |
| ETH | 123 | 131 | 94% |
| SOL | 122 | 129 | 95% |
| XRP | 106 | 129 | 82% |

### The Problem

In paper trading, each strategy tracks its OWN position independently:
```javascript
// research_engine.js
this.positions = {};  // strategyName -> crypto -> position
```

So for BTC at 06:45:00:
- SpotLag_Aggressive: BUY UP $100
- Contrarian_Strong: BUY DOWN $100
- ...5 strategies UP, 5 strategies DOWN
- Net position = $0 (cancels out!)
- But paper P&L still tracks each independently

### Strategy "Camps"

Strategies cluster into groups that almost always agree:

| Camp | Members | Internal Agreement |
|------|---------|-------------------|
| **FairValue Camp** | FairValue_EWMA, FairValue_RealizedVol, FairValue_WithDrift | 98%+ |
| **SpotLag Camp** | SpotLag_Fast, SpotLag_Aggressive, SpotLag_300sec, SpotLag_Confirmed | 94%+ |
| **Contrarian Camp** | Contrarian, Contrarian_Scalp, Contrarian_Strong | 93%+ |
| **Drift Camp** | FV_Drift_4H, FV_Drift_24H | 94%+ |

### Camp Conflicts

| Camp 1 | Camp 2 | Conflict Rate |
|--------|--------|---------------|
| Contrarian | SpotLag | **87%** |
| FairValue | TimeConditional | **81%** |
| Contrarian | FairValue | ~50% |

### Implications for Live Trading

**Option 1: Single Strategy**
- Pick ONE strategy (e.g., SpotLag_Aggressive)
- Simple, no conflicts
- Risk: All eggs in one basket

**Option 2: Single Camp**
- Run strategies from ONE camp (e.g., all SpotLag variants)
- They agree 94%+ of the time
- Position size = sum of agreeing strategies
- Risk: Correlated losses

**Option 3: Weighted Ensemble**
- Weight strategies by past performance
- Net position = sum(weight * signal)
- Only trade if net is strong (e.g., |net| > $300)
- Most sophisticated

**Option 4: Master/Slave**
- One "master" strategy decides direction
- Others only trade if they agree with master
- Master = highest Sharpe strategy

### Recommended Approach for Live

1. **Start with SpotLag_Aggressive ONLY** (87.7% win rate, +$4,845)
2. Add SpotLag_Fast if SpotLag_Aggressive agrees
3. NEVER run Contrarian alongside SpotLag (87% conflict!)
4. Consider netting: if SpotLag says UP $100 and another says DOWN $100, don't trade

---

## Moving to Live Trading

### Key Differences

| Aspect | Paper Trading | Live Trading |
|--------|---------------|--------------|
| Execution | Simulated at bid/ask | Actual orders via API |
| Slippage | None (fills at quoted) | Real (market impact) |
| Fees | None | 0.1% taker fee |
| Timing | Instant fills | Order latency (100-500ms) |
| Risk | None (simulated money) | Real capital at risk |
| Size limits | None | Min 5 shares, max varies |

### Required Changes for Live

1. **Execution Engine Integration**
   - Use `src/execution/execution_engine.js`
   - Real API credentials required
   - Order signing with private key

2. **Risk Management**
   - Position limits per crypto
   - Daily loss limits
   - Max exposure caps
   - See `src/execution/risk_manager.js`

3. **Order Management**
   - Handle partial fills
   - Cancel stale orders
   - Track order state machine

4. **Monitoring**
   - Real-time P&L tracking
   - Slippage monitoring
   - Error alerting

### Live Trading Configuration

```env
# Required in .env for live trading
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_secret
POLYMARKET_PASSPHRASE=your_passphrase
POLYMARKET_PRIVATE_KEY=your_private_key
POLYMARKET_FUNDER_ADDRESS=your_address

# Risk limits
MAX_POSITION_PER_TRADE=1
MAX_TOTAL_EXPOSURE=20
MAX_LOSS_PER_DAY=20
```

### Position Management for Multi-Strategy Live

If running multiple strategies live, you need a **Position Aggregator**:

```javascript
// Conceptual - NOT YET IMPLEMENTED
class PositionAggregator {
    constructor() {
        this.netPositions = {};  // crypto -> { side, size }
        this.strategySignals = {}; // crypto -> { strategyName -> signal }
    }
    
    // Called when any strategy signals
    onStrategySignal(strategyName, crypto, signal) {
        this.strategySignals[crypto] = this.strategySignals[crypto] || {};
        this.strategySignals[crypto][strategyName] = signal;
        
        // Recalculate net position
        let netUp = 0, netDown = 0;
        for (const [name, sig] of Object.entries(this.strategySignals[crypto])) {
            if (sig.action === 'buy') {
                if (sig.side === 'up') netUp += sig.size;
                else netDown += sig.size;
            }
        }
        
        const net = netUp - netDown;
        
        // Only trade if net is strong enough
        if (Math.abs(net) < MIN_NET_POSITION) {
            return { action: 'hold', reason: 'conflicting_signals' };
        }
        
        return {
            action: 'trade',
            side: net > 0 ? 'up' : 'down',
            size: Math.abs(net)
        };
    }
}
```

### Current Recommended Live Setup

Based on paper trading data:

```
SINGLE STRATEGY MODE (Safest):
└── SpotLag_Aggressive only
    ├── 87.7% win rate
    ├── +$4,845 P&L
    └── Clear signals, no conflicts

DUAL STRATEGY MODE (If more volume needed):
└── SpotLag_Aggressive + SpotLag_Fast
    ├── Both agree 94% of time
    ├── Combined when agreeing
    └── Skip when disagreeing

AVOID COMBINING:
├── SpotLag + Contrarian (87% conflict!)
├── FairValue + TimeConditional (81% conflict!)
└── Any strategies from different "camps"
```

---

## Strategy File Locations

### Where Strategies Are Defined

```
src/quant/strategies/
├── index.js                    # Registry - createAllQuantStrategies()
├── spot_lag_simple.js          # SpotLag variants (BEST PERFORMERS)
│   ├── SpotLagSimpleStrategy
│   ├── SpotLagFastStrategy
│   ├── SpotLagAggressiveStrategy
│   ├── SpotLagConfirmedStrategy
│   ├── MispricingOnlyStrategy
│   └── ... (20+ variants)
├── fair_value_strategy.js      # FairValue variants
│   ├── FairValueStrategy
│   ├── DriftAwareFairValueStrategy
│   └── FairValueDrift1H/4H/24H
├── contrarian_strategy.js      # Contrarian variants (LOSING)
│   ├── ContrarianStrategy
│   ├── ContrarianScalpStrategy
│   └── ContrarianStrongStrategy
├── endgame_strategy.js         # Endgame variants
├── regime_strategy.js          # Regime adaptive
├── time_conditional_strategy.js # Time-based
├── microstructure_strategy.js  # Order flow
└── cross_asset_strategy.js     # Cross-asset correlations
```

### How Strategies Are Created

In `src/quant/strategies/index.js`:
```javascript
export function createAllQuantStrategies(capital = 100) {
    return [
        createFairValueRealizedVol(capital),
        createSpotLagSimple(capital),
        createSpotLagAggressive(capital),
        // ... 30+ strategies
    ];
}
```

### How Strategies Are Loaded

In `src/quant/research_engine.js`:
```javascript
constructor(options = {}) {
    // Line 38 - creates all strategies
    this.strategies = createAllQuantStrategies(this.options.capitalPerTrade);
    
    // Line 41 - position tracking per strategy per crypto
    this.positions = {};  // strategyName -> crypto -> position
}
```

### To Add/Remove Strategies

1. Edit `src/quant/strategies/index.js`
2. Add/remove from the `createAllQuantStrategies()` array
3. Redeploy the tick collector on Railway

### To Modify Strategy Parameters

Each strategy file exports factory functions with configurable parameters:

```javascript
// spot_lag_simple.js
export function createSpotLagAggressive(capital = 100) {
    return new SpotLagSimpleStrategy({
        name: 'SpotLag_Aggressive',
        spotMoveThreshold: 0.0003,   // Trigger on 0.03% moves
        marketLagRatio: 0.7,          // Market must lag by 30%+
        maxPosition: capital,
        minTimeRemaining: 60,         // Enter up to 60s before expiry
        // ...
    });
}
```

---

## Important Files

| File | Purpose |
|------|---------|
| `scripts/start_collector.js` | Entry point for collector service |
| `src/collectors/tick_collector.js` | Main tick collection logic |
| `src/quant/research_engine.js` | Strategy orchestration (line 38 creates strategies) |
| `src/quant/strategies/index.js` | **Strategy registry** - add/remove strategies here |
| `src/quant/strategies/spot_lag_simple.js` | **SpotLag strategies** (top performers) |
| `src/quant/strategies/fair_value_strategy.js` | FairValue strategies |
| `src/quant/strategies/contrarian_strategy.js` | Contrarian strategies (avoid!) |
| `src/db/connection.js` | Database connection + `savePaperTrade()` |
| `src/execution/execution_engine.js` | For live trading |
| `src/execution/risk_manager.js` | Risk limits for live |
| `scripts/analyze_conflicts.mjs` | **NEW** - Analyze strategy conflicts |

---

## Troubleshooting

### No paper trades appearing?

1. Check collector is running on Railway
2. Verify database connection: `node scripts/db_status.mjs`
3. Check `paper_trades` table, NOT `trades` table

### Stale data?

1. Check `system_state.collector_health` timestamp
2. Railway deployment may need restart

### Chainlink data missing?

1. XRP has no Chainlink feed (expected)
2. Check RPC connectivity in tick_collector logs

---

## Key Insights from Paper Trading

1. **SpotLag strategies work** - 83-88% win rates suggest market does lag spot
2. **Contrarian fails in trends** - Don't fade strong momentum
3. **Chainlink divergence is small** - Usually <0.1%, occasional 0.2-0.4%
4. **Volume matters** - High-volume strategies have more signal
5. **Endgame is safe but small** - 100% win rate but few opportunities

---

---

## LIVE TRADING SETUP

### Overview

The live trading system uses the same strategy framework as paper trading but executes real orders through the Polymarket API. It runs on Railway with a web dashboard for monitoring and emergency controls.

```
┌─────────────────────────────────────────────────────────────────┐
│                        RAILWAY (Live Trading)                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              LIVE TRADING SERVICE                        │   │
│  │              scripts/run_live_trading.mjs                │   │
│  │                                                          │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │   │
│  │  │  Execution   │    │    Risk      │    │  Strategy │  │   │
│  │  │   Engine     │←───│   Manager    │←───│  (Single) │  │   │
│  │  └──────┬───────┘    └──────────────┘    └───────────┘  │   │
│  │         │                                                │   │
│  │         ▼                                                │   │
│  │  ┌──────────────┐    ┌──────────────┐                   │   │
│  │  │  Polymarket  │    │   Dashboard  │                   │   │
│  │  │     API      │    │    Server    │←──── Web UI       │   │
│  │  │  (real $$$)  │    │  (port 3333) │                   │   │
│  │  └──────────────┘    └──────────────┘                   │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Running Live Trading Locally

```bash
# Paper mode (no real trades)
npm run live:paper

# Live mode with SpotLag_Aggressive
npm run live:aggressive

# Custom strategy
LIVE_STRATEGY=SpotLag_Fast npm run live

# Full live mode (TRADES REAL MONEY!)
npm run live
```

### Required Environment Variables

```env
# .env file - REQUIRED for live trading
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_secret  
POLYMARKET_PASSPHRASE=your_passphrase
POLYMARKET_PRIVATE_KEY=your_private_key
POLYMARKET_FUNDER_ADDRESS=your_address

# Strategy configuration
LIVE_MODE=live           # 'live' or 'paper'
LIVE_STRATEGY=SpotLag_Aggressive
LIVE_CRYPTOS=btc,eth     # Comma-separated

# Risk limits (conservative defaults)
MAX_POSITION_PER_TRADE=1
MAX_POSITION_PER_WINDOW=5
MAX_TOTAL_EXPOSURE=20
MAX_LOSS_PER_DAY=20
MAX_LOSS_PER_HOUR=5
MIN_TIME_REMAINING=30
MAX_SPREAD_PERCENT=10

# Dashboard
DASHBOARD_PORT=3333
```

### Web Dashboard

The live trading dashboard is available at:
- **Local:** `http://localhost:3333`
- **Railway:** Your Railway public URL

**Features:**
- Real-time status (RUNNING/PAUSED/STOPPED)
- Live P&L tracking
- Open positions display
- **KILL SWITCH** button - stops all trading instantly
- **PAUSE/RESUME** controls
- Risk status monitoring
- Daily loss tracking

### Dashboard Controls

| Control | Action |
|---------|--------|
| **KILL SWITCH** | Stops engine completely, cancels all orders |
| **Pause** | Stops new trades, keeps data feeds running |
| **Resume** | Resumes trading (if risk allows) |

### API Endpoints (Live Trading)

```bash
# Get live status
curl http://localhost:3333/api/live/status

# Trigger kill switch (POST)
curl -X POST http://localhost:3333/api/live/kill

# Pause trading (POST)  
curl -X POST http://localhost:3333/api/live/pause

# Resume trading (POST)
curl -X POST http://localhost:3333/api/live/resume

# Get positions (GET)
curl http://localhost:3333/api/live/positions
```

### Railway Deployment

**Option A: Separate Service for Live Trading**

1. Create a new Railway service in your project
2. Set environment variables (all POLYMARKET_* credentials)
3. Use start command: `npm run live`
4. Set restart policy: ALWAYS

**Option B: Using railway.live.json**

```bash
# Deploy using live config
railway up --config railway.live.json
```

**Environment Variables on Railway:**

Set these in Railway dashboard → Service → Variables:

```
POLYMARKET_API_KEY=xxx
POLYMARKET_SECRET=xxx
POLYMARKET_PASSPHRASE=xxx
POLYMARKET_PRIVATE_KEY=xxx
POLYMARKET_FUNDER_ADDRESS=xxx
DATABASE_URL=your_supabase_connection_string
LIVE_MODE=live
LIVE_STRATEGY=SpotLag_Aggressive
LIVE_CRYPTOS=btc,eth
MAX_POSITION_PER_TRADE=1
DASHBOARD_PORT=3333
```

### Key Files

| File | Purpose |
|------|---------|
| `scripts/run_live_trading.mjs` | Main live trading runner |
| `src/execution/execution_engine.js` | Order execution and position management |
| `src/execution/risk_manager.js` | Risk limits and kill switch |
| `src/dashboard/server.js` | Dashboard + API endpoints |
| `src/dashboard/public/index.html` | Web UI with kill switch |
| `railway.live.json` | Railway config for live trading |

### Safety Features

1. **Kill Switch File**: Create `./KILL_SWITCH` file to stop trading
2. **Risk Manager**: Auto-stops on:
   - Daily loss limit exceeded
   - Consecutive losses (5+)
   - Circuit breaker trips
3. **Dashboard Kill Button**: One-click emergency stop
4. **Automatic State Recovery**: Resumes after crashes

### Recommended Live Trading Sequence

1. **Start Paper Mode**
   ```bash
   npm run live:paper
   ```
   Verify everything works, check dashboard

2. **Start with $1 trades**
   ```bash
   MAX_POSITION_PER_TRADE=1 npm run live
   ```
   Monitor for 24 hours

3. **Scale Up Gradually**
   - Week 1: $1/trade
   - Week 2: $5/trade (if profitable)
   - Week 3+: $10/trade

4. **Monitor Dashboard**
   - Check P&L trend
   - Watch for risk limit hits
   - Review trade quality

### Next Steps

1. Select top 2-3 strategies for live testing
2. Implement position size based on confidence
3. Add slippage buffer to entry/exit prices
4. Set up live monitoring dashboard
5. Start with minimal capital ($10-20 per trade)
