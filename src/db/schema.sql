-- Polymarket Quant Platform Database Schema
-- SQLite compatible

-- Tick-level data for analysis
CREATE TABLE IF NOT EXISTS ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    timestamp_ms INTEGER NOT NULL,  -- Unix timestamp in milliseconds
    
    -- Window identification
    crypto TEXT NOT NULL,           -- 'btc', 'eth', 'sol', 'xrp'
    window_epoch INTEGER NOT NULL,  -- 15-min window start epoch
    time_remaining_sec REAL,        -- Seconds until window resolution
    
    -- Polymarket UP token data
    up_bid REAL,
    up_ask REAL,
    up_bid_size REAL,
    up_ask_size REAL,
    up_last_trade REAL,
    up_mid REAL,                    -- (up_bid + up_ask) / 2
    
    -- Polymarket DOWN token data
    down_bid REAL,
    down_ask REAL,
    down_bid_size REAL,
    down_ask_size REAL,
    down_last_trade REAL,
    
    -- Spot price data (from Binance)
    spot_price REAL,                -- Current crypto spot price
    price_to_beat REAL,             -- Start price of the window
    spot_delta REAL,                -- spot_price - price_to_beat
    spot_delta_pct REAL,            -- (spot_price - price_to_beat) / price_to_beat * 100
    
    -- Derived metrics
    spread REAL,                    -- up_ask - up_bid
    spread_pct REAL,                -- spread / up_mid * 100
    implied_prob_up REAL,           -- up_mid (market's implied probability)
    
    -- Order book depth (JSON for top 5 levels)
    up_book_depth TEXT,             -- JSON: [{price, size}, ...]
    down_book_depth TEXT,
    
    -- Chainlink oracle data (what Polymarket uses for ACTUAL resolution)
    chainlink_price REAL,           -- Chainlink oracle price
    chainlink_staleness INTEGER,    -- Seconds since last Chainlink update
    chainlink_updated_at INTEGER,   -- Unix timestamp of Chainlink update
    
    -- Price divergence between Binance (display) and Chainlink (resolution)
    price_divergence REAL,          -- Binance - Chainlink (positive = Binance higher)
    price_divergence_pct REAL       -- Divergence as percentage
);

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_ticks_crypto_epoch ON ticks(crypto, window_epoch);
CREATE INDEX IF NOT EXISTS idx_ticks_timestamp ON ticks(timestamp_ms);

-- Window-level summary data
CREATE TABLE IF NOT EXISTS windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    
    -- Resolution data
    start_price REAL,               -- Price at window start
    end_price REAL,                 -- Price at window end
    outcome TEXT,                   -- 'up', 'down', or NULL if not resolved
    resolved_at DATETIME,
    
    -- Market behavior during window
    opening_up_price REAL,          -- First up_mid after window start
    closing_up_price REAL,          -- Last up_mid before resolution
    high_up_price REAL,             -- Max up_mid during window
    low_up_price REAL,              -- Min up_mid during window
    
    -- Volume and activity
    tick_count INTEGER DEFAULT 0,
    price_change_count INTEGER DEFAULT 0,
    
    -- Price movement stats
    up_price_volatility REAL,       -- Std dev of up_mid
    spot_volatility REAL,           -- Std dev of spot_price
    max_spot_delta_pct REAL,        -- Max absolute spot deviation
    
    -- Timing
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(epoch, crypto)
);

CREATE INDEX IF NOT EXISTS idx_windows_crypto ON windows(crypto);
CREATE INDEX IF NOT EXISTS idx_windows_outcome ON windows(outcome);

-- Trade log for paper and live trading
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    timestamp_ms INTEGER NOT NULL,
    
    -- Trade identification
    trade_id TEXT UNIQUE,           -- UUID
    mode TEXT NOT NULL,             -- 'paper' or 'live'
    strategy TEXT,                  -- Strategy name
    
    -- Market
    crypto TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    
    -- Trade details
    side TEXT NOT NULL,             -- 'buy_up', 'sell_up', 'buy_down', 'sell_down'
    size REAL NOT NULL,             -- Position size in $
    price REAL NOT NULL,            -- Execution price
    
    -- Costs
    fee REAL DEFAULT 0,
    slippage REAL DEFAULT 0,        -- Difference from expected price
    
    -- Context at trade time
    spot_price REAL,
    up_bid REAL,
    up_ask REAL,
    time_remaining_sec REAL,
    
    -- P&L (filled after exit)
    exit_trade_id TEXT,             -- Reference to closing trade
    realized_pnl REAL,
    
    -- Metadata
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_window ON trades(crypto, window_epoch);

-- Position tracking
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Position identification
    mode TEXT NOT NULL,             -- 'paper' or 'live'
    crypto TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    side TEXT NOT NULL,             -- 'up' or 'down'
    
    -- Position details
    size REAL NOT NULL,             -- Current position size
    avg_entry_price REAL NOT NULL,
    entry_timestamp_ms INTEGER,
    
    -- Status
    is_open INTEGER DEFAULT 1,      -- 1 = open, 0 = closed
    
    -- P&L
    unrealized_pnl REAL,
    realized_pnl REAL,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(is_open, mode);

-- Strategy performance tracking
CREATE TABLE IF NOT EXISTS strategy_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    strategy TEXT NOT NULL,
    mode TEXT NOT NULL,             -- 'backtest', 'paper', 'live'
    
    -- Performance period
    period_start DATETIME,
    period_end DATETIME,
    
    -- Trade statistics
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    
    -- P&L
    gross_profit REAL DEFAULT 0,
    gross_loss REAL DEFAULT 0,
    net_profit REAL DEFAULT 0,
    total_fees REAL DEFAULT 0,
    
    -- Risk metrics
    max_drawdown REAL,
    max_drawdown_pct REAL,
    sharpe_ratio REAL,
    sortino_ratio REAL,
    profit_factor REAL,             -- gross_profit / abs(gross_loss)
    
    -- Per-trade stats
    avg_win REAL,
    avg_loss REAL,
    avg_trade REAL,
    win_rate REAL,
    
    -- Exposure
    avg_position_size REAL,
    max_position_size REAL,
    avg_holding_time_sec REAL
);

CREATE INDEX IF NOT EXISTS idx_strategy_perf ON strategy_performance(strategy, mode);

-- Latency measurements
CREATE TABLE IF NOT EXISTS latency_measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms INTEGER NOT NULL,
    
    crypto TEXT NOT NULL,
    measurement_type TEXT NOT NULL, -- 'spot_to_market', 'order_submit', 'order_fill'
    
    latency_ms REAL NOT NULL,
    
    -- Context
    spot_price_change_pct REAL,     -- For spot_to_market type
    order_size REAL,                -- For order types
    
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_latency_type ON latency_measurements(measurement_type);

-- Hypothesis test results
CREATE TABLE IF NOT EXISTS hypothesis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    hypothesis TEXT NOT NULL,       -- 'mean_reversion', 'btc_lead_lag', etc.
    crypto TEXT,                    -- NULL for all cryptos
    
    -- Test details
    test_method TEXT,               -- 'ljung_box', 'granger', etc.
    sample_size INTEGER,
    period_start DATETIME,
    period_end DATETIME,
    
    -- Results
    test_statistic REAL,
    p_value REAL,
    is_significant INTEGER,         -- 1 if p_value < 0.05
    effect_size REAL,
    confidence_interval_low REAL,
    confidence_interval_high REAL,
    
    -- Interpretation
    conclusion TEXT,
    parameters TEXT                 -- JSON of test parameters
);

-- System state for collector
CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

