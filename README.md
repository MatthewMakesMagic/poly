# Polymarket Quantitative Trading Platform

A comprehensive quantitative research and trading platform for Polymarket's 15-minute crypto prediction markets.

## Overview

This platform provides:

- **Real-time Data Collection** - 24/7 tick-level data from Polymarket and Binance
- **Statistical Analysis** - Formal hypothesis testing for trading edge detection
- **Backtesting Engine** - Strategy testing with realistic execution simulation
- **Paper Trading** - Live simulated trading without real capital
- **Web Dashboard** - Real-time monitoring and analysis visualization

## Quick Start

```bash
# Install dependencies
npm install

# Start collecting data (run 24/7 in background)
npm run collect

# After collecting data, run analysis
npm run analyze

# Backtest strategies
npm run backtest

# Paper trade with real market data
npm run paper

# Launch web dashboard
npm run dashboard
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA COLLECTION LAYER                       │
├─────────────────────────────────────────────────────────────────┤
│  Polymarket WebSocket  ──►  Tick Collector  ──►  SQLite DB     │
│  Binance WebSocket     ──►                                      │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ANALYSIS LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  Statistical Metrics  │  Hypothesis Tests  │  Backtesting      │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      EXECUTION LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  Paper Trading        │  Live Trading (future)                  │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DASHBOARD LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  Web Dashboard (http://localhost:3000)                          │
└─────────────────────────────────────────────────────────────────┘
```

## 15-Minute Crypto Markets

Polymarket offers recurring 15-minute "Up or Down" prediction markets:

| Market | Slug Pattern | Example |
|--------|--------------|---------|
| Bitcoin | `btc-updown-15m-{epoch}` | `btc-updown-15m-1768795200` |
| Ethereum | `eth-updown-15m-{epoch}` | `eth-updown-15m-1768795200` |
| Solana | `sol-updown-15m-{epoch}` | `sol-updown-15m-1768795200` |
| XRP | `xrp-updown-15m-{epoch}` | `xrp-updown-15m-1768795200` |

**How they resolve:**
- "Up" wins if end price ≥ start price
- "Down" wins otherwise
- Resolution via Chainlink price oracle

## Hypothesis Testing

The platform tests four trading hypotheses:

### H1: Mean Reversion
- **Test**: Are price returns negatively autocorrelated?
- **If true**: Fade large moves from the moving average

### H2: BTC Lead/Lag
- **Test**: Does spot price movement predict market price movement?
- **If true**: Speed edge exists - trade before market adjusts

### H3: Behavioral Clustering
- **Test**: Do prices cluster at round numbers (0.25, 0.50, 0.75)?
- **If true**: Avoid entries at round numbers

### H4: Time-of-Window Effects
- **Test**: Does price behavior differ early vs late in window?
- **If true**: Adjust strategy based on time remaining

## Built-in Strategies

### ThresholdExitStrategy (Your Hunch!)
- Enter when probability is uncertain (40-60%)
- Exit at predetermined profit targets (2%, 3%, 5%)
- Time-decay exit as window progresses
- **Key insight**: Trade the path, not the resolution

### MeanReversionStrategy
- Enter when price deviates >3% from moving average
- Exit when price reverts halfway toward MA
- Best when H1 (mean reversion) is significant

### MomentumStrategy
- Follow BTC spot price momentum
- Enter on significant spot moves
- Exit on momentum reversal

## Project Structure

```
poly/
├── src/
│   ├── collectors/
│   │   ├── tick_collector.js      # 24/7 data collection
│   │   └── window_tracker.js      # Window resolution tracking
│   │
│   ├── db/
│   │   ├── schema.sql             # Database schema
│   │   ├── connection.js          # DB connection manager
│   │   └── queries.js             # Common queries
│   │
│   ├── analysis/
│   │   ├── metrics.js             # Statistical metrics
│   │   └── hypothesis_tests.js    # Formal hypothesis tests
│   │
│   ├── backtest/
│   │   ├── engine.js              # Backtest orchestrator
│   │   ├── simulator.js           # Execution simulator
│   │   ├── strategy.js            # Strategy base class
│   │   └── strategies/            # Built-in strategies
│   │
│   ├── trading/
│   │   └── paper_trader.js        # Paper trading system
│   │
│   └── dashboard/
│       └── server.js              # Web dashboard
│
├── scripts/
│   ├── start_collector.js         # Start data collection
│   ├── run_analysis.js            # Run statistical analysis
│   ├── backtest.js                # Run backtest
│   └── paper_trade.js             # Start paper trading
│
├── data/
│   └── polymarket.db              # SQLite database
│
└── package.json
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run collect` | Start 24/7 data collection |
| `npm run analyze` | Run statistical analysis on collected data |
| `npm run backtest` | Backtest strategies on historical data |
| `npm run paper` | Start paper trading with live data |
| `npm run dashboard` | Launch web dashboard at localhost:3000 |

### Paper Trading Options

```bash
# Default (ThresholdExit strategy on BTC)
npm run paper

# Specify strategy
npm run paper -- --strategy=momentum

# Specify crypto
npm run paper -- --crypto=eth

# Specify capital
npm run paper -- --capital=5000
```

## Trading Costs

| Cost | Amount |
|------|--------|
| Spread | ~1% (1 cent on $1 contracts) |
| Taker Fee | 0.1% |
| **Total Round-Trip** | ~1.2% |

Need price moves >2.4% to be profitable after round-trip costs.

## Success Criteria

Before live trading with real capital:

1. **Minimum 3 days of tick data** (288+ windows)
2. **At least one significant hypothesis** (p < 0.05)
3. **Backtest Sharpe ratio > 1.5**
4. **Paper trading matches backtest** within 20%

## API Endpoints (Dashboard)

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | System status and data summary |
| `GET /api/ticks/latest` | Latest market ticks |
| `GET /api/windows/stats` | Window statistics |
| `GET /api/windows/recent` | Recent resolved windows |
| `GET /api/analysis/hypotheses` | Hypothesis test results |
| `GET /api/trades` | Trade history |

## Database Schema

### ticks
- Tick-level market data (bid/ask, spot price, time remaining)

### windows
- 15-minute window outcomes and statistics

### trades
- Paper and live trade records

### hypothesis_results
- Statistical test results with p-values

## 🚀 Deployment

### Architecture

| Component | Platform | Purpose |
|-----------|----------|---------|
| **Dashboard/API** | Vercel | View data, charts, predictions |
| **Data Collector** | Railway | 24/7 WebSocket connections |
| **Database** | Supabase | PostgreSQL for all data |

### Step 1: Set Up Supabase Database

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (choose region close to you)
3. Go to **Settings → Database** and copy the connection string
4. Run the schema migration:

```bash
# Copy your DATABASE_URL to .env
echo "DATABASE_URL=postgresql://..." > .env

# Run migrations (creates all tables)
node -e "import('./src/db/postgres.js').then(m => m.initPostgres() && m.runMigrations())"
```

### Step 2: Deploy Dashboard to Vercel

1. Push to GitHub (see below)
2. Go to [vercel.com](https://vercel.com) and import your repo
3. Add environment variable: `DATABASE_URL` = your Supabase connection string
4. Deploy!

Your dashboard will be live at `https://your-project.vercel.app`

### Step 3: Deploy Collector to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub"
3. Select your repository
4. Set **Start Command**: `npm run collect`
5. Add environment variable: `DATABASE_URL` = your Supabase connection string

```bash
# Cost: ~$5/month for always-on service
```

### Option 2: Docker (Self-hosted)

```bash
# Build the image
npm run docker:build

# Run with docker-compose
npm run docker:run

# View logs
npm run docker:logs

# Stop
npm run docker:stop
```

### Option 3: Any VPS (DigitalOcean, AWS, etc.)

```bash
# On your VPS
git clone <your-repo>
cd poly
npm install
npm run start

# Use PM2 for process management
npm install -g pm2
pm2 start src/main.js --name poly-trading
pm2 save
pm2 startup
```

## 📱 Notifications (WhatsApp, Telegram)

Get real-time alerts on your phone when trades execute or significant moves happen.

### Setup Telegram (Free - Recommended)

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Start a chat with your new bot
5. Get your chat ID by visiting:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
6. Set environment variables:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
   TELEGRAM_CHAT_ID=123456789
   ```

### Setup WhatsApp (via Twilio)

1. Create account at [twilio.com](https://www.twilio.com)
2. Go to Messaging → WhatsApp → Sandbox
3. Send the join code to the Twilio number
4. Set environment variables:
   ```bash
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxx
   WHATSAPP_TO=whatsapp:+1234567890
   ```

### Notification Events

| Event | Description |
|-------|-------------|
| 🔮 Prediction | New prediction generated |
| 📈 Trade Open | Position entered |
| 📉 Trade Close | Position exited (with P&L) |
| ⚠️ Significant Move | >0.5% spot price change |
| 🏁 Window End | Market resolution |
| 📊 Daily Summary | End of day stats |

See `config/notifications.example.env` for full configuration.

## 🖥️ Dashboard

The dashboard runs at `http://localhost:3000` and shows:

- **Live Predictions** - Real-time predictions for BTC, ETH, SOL
- **Active Signals** - Current trading signals with strength
- **P&L Metrics** - Today's trades, win rate, Sharpe ratio
- **Live Feed** - Real-time trade and alert stream

The dashboard auto-updates via WebSocket - no manual refresh needed.

## Commands Reference

| Command | Description |
|---------|-------------|
| `npm start` | **Start full system** (collector + dashboard + predictions) |
| `npm run collect` | Start 24/7 data collection only |
| `npm run analyze` | Run statistical analysis on collected data |
| `npm run backtest` | Backtest strategies on historical data |
| `npm run paper` | Start paper trading with live data |
| `npm run dashboard` | Launch web dashboard only |
| `npm run docker:build` | Build Docker image |
| `npm run docker:run` | Run via docker-compose |

## Resources

- [Polymarket CLOB Docs](https://docs.polymarket.com/developers/CLOB/introduction)
- [Chainlink BTC/USD Data](https://data.chain.link/streams/btc-usd)
- [Binance WebSocket API](https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams)
- [Railway Deployment](https://railway.app)
- [Twilio WhatsApp](https://www.twilio.com/docs/whatsapp)
