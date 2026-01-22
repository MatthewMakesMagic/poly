-- Polymarket Quant Platform - Enhanced Schema v2
-- Designed for ML training and quantitative research
-- Run this to upgrade existing database

-- ============================================
-- ENHANCED TICK DATA WITH FEATURES
-- ============================================

-- Store computed features alongside raw ticks (avoids recomputation)
CREATE TABLE IF NOT EXISTS tick_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id INTEGER,                    -- Reference to ticks table
    timestamp_ms INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    
    -- ========== PRICE FEATURES ==========
    -- Momentum features (multiple timeframes)
    price_return_5t REAL,               -- 5-tick return
    price_return_10t REAL,              -- 10-tick return
    price_return_30t REAL,              -- 30-tick return
    price_return_60t REAL,              -- 60-tick return (1 min at 1/sec)
    
    spot_return_5t REAL,                -- Spot price momentum
    spot_return_10t REAL,
    spot_return_30t REAL,
    
    -- Moving average features
    up_price_sma_10 REAL,               -- Simple MA
    up_price_sma_20 REAL,
    up_price_ema_10 REAL,               -- Exponential MA
    up_price_ema_20 REAL,
    up_price_vs_sma_10 REAL,            -- Price deviation from MA (z-score)
    up_price_vs_sma_20 REAL,
    
    -- Volatility features
    price_volatility_10t REAL,          -- Rolling std of returns
    price_volatility_30t REAL,
    spot_volatility_10t REAL,
    spot_volatility_30t REAL,
    volatility_ratio REAL,              -- Short-term vol / long-term vol
    
    -- ========== ORDERBOOK FEATURES ==========
    -- Spread features
    spread_bps REAL,                    -- Spread in basis points
    spread_vs_avg REAL,                 -- Spread vs rolling average
    
    -- Depth/pressure features
    bid_ask_imbalance REAL,             -- (bid_size - ask_size) / (bid_size + ask_size)
    bid_depth_5 REAL,                   -- Total bid size top 5 levels
    ask_depth_5 REAL,                   -- Total ask size top 5 levels
    depth_imbalance_5 REAL,             -- Depth imbalance at 5 levels
    weighted_mid_price REAL,            -- Size-weighted mid price
    microprice REAL,                    -- Microprice from bid/ask sizes
    
    -- ========== SPOT-MARKET FEATURES ==========
    spot_delta_zscore REAL,             -- Spot delta normalized by window vol
    spot_market_divergence REAL,        -- Spot direction vs market probability
    spot_lead_signal REAL,              -- Is spot leading market moves?
    price_to_beat_distance REAL,        -- % distance from price to beat
    
    -- ========== TIME FEATURES ==========
    time_remaining_pct REAL,            -- % of window remaining (0-1)
    time_phase INTEGER,                 -- 1=early, 2=mid, 3=late
    seconds_since_last_trade REAL,      -- Time since last market trade
    
    -- ========== CROSS-ASSET FEATURES ==========
    btc_correlation_30t REAL,           -- Correlation with BTC (for alts)
    cross_asset_momentum REAL,          -- Are other cryptos moving same direction?
    
    -- ========== TECHNICAL INDICATORS ==========
    rsi_14 REAL,                        -- RSI(14) of up_mid
    macd_signal REAL,                   -- MACD signal line
    bollinger_position REAL,            -- Position within bollinger bands (-1 to 1)
    
    -- ========== AUTOCORRELATION FEATURES ==========
    return_autocorr_1 REAL,             -- Lag-1 autocorrelation
    return_autocorr_5 REAL,             -- Lag-5 autocorrelation
    mean_reversion_signal REAL,         -- Derived from autocorr
    
    FOREIGN KEY (tick_id) REFERENCES ticks(id)
);

CREATE INDEX IF NOT EXISTS idx_tick_features_lookup ON tick_features(crypto, window_epoch, timestamp_ms);


-- ============================================
-- ORDER FLOW / TRADE TAPE
-- ============================================

-- Individual trades as they happen (for order flow analysis)
CREATE TABLE IF NOT EXISTS trade_tape (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    
    -- Trade details
    token_side TEXT NOT NULL,           -- 'up' or 'down'
    trade_side TEXT,                    -- 'buy' or 'sell' (aggressor)
    price REAL NOT NULL,
    size REAL NOT NULL,
    
    -- Derived
    is_buy INTEGER,                     -- 1 if buyer aggressive, 0 if seller
    cumulative_volume REAL,             -- Running volume this window
    cumulative_buy_volume REAL,         -- Running buy volume
    cumulative_sell_volume REAL,        -- Running sell volume
    
    -- Order flow imbalance
    vwap_this_window REAL,              -- VWAP since window start
    trade_flow_imbalance REAL           -- (buys - sells) / total
);

CREATE INDEX IF NOT EXISTS idx_trade_tape_lookup ON trade_tape(crypto, window_epoch);


-- ============================================
-- MODEL PREDICTIONS (for tracking accuracy)
-- ============================================

-- Log every prediction made for later analysis
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    
    -- Prediction details
    model_name TEXT NOT NULL,           -- 'ensemble_v1', 'xgboost_v2', etc.
    model_version TEXT,                 -- Version hash or number
    
    -- The prediction itself
    predicted_outcome TEXT,             -- 'up' or 'down'
    predicted_prob_up REAL,             -- Probability of up outcome (0-1)
    confidence REAL,                    -- Model's confidence (0-1)
    
    -- Feature values at prediction time (JSON for flexibility)
    feature_snapshot TEXT,              -- JSON of top features used
    
    -- Signals that contributed
    signals_snapshot TEXT,              -- JSON: [{name, value, weight}, ...]
    
    -- Context
    time_remaining_sec REAL,
    spot_price REAL,
    up_mid REAL,
    spot_delta_pct REAL,
    
    -- Outcome (filled after window resolves)
    actual_outcome TEXT,                -- 'up' or 'down'
    was_correct INTEGER,                -- 1 or 0
    calibration_bucket INTEGER,         -- For calibration analysis (0-10)
    
    -- Attribution
    top_feature_1 TEXT,                 -- Most important feature
    top_feature_1_value REAL,
    top_feature_2 TEXT,
    top_feature_2_value REAL,
    top_feature_3 TEXT,
    top_feature_3_value REAL
);

CREATE INDEX IF NOT EXISTS idx_predictions_model ON predictions(model_name, crypto);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(actual_outcome);
CREATE INDEX IF NOT EXISTS idx_predictions_window ON predictions(window_epoch);


-- ============================================
-- TRADER ANNOTATIONS (intuitive insights)
-- ============================================

-- Manual annotations from the intuitive trader
CREATE TABLE IF NOT EXISTS trader_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- What the annotation is about
    crypto TEXT,                        -- NULL = general market
    window_epoch INTEGER,               -- NULL = not window-specific
    
    -- The insight
    annotation_type TEXT NOT NULL,      -- 'market_regime', 'trade_idea', 'observation', 'warning'
    content TEXT NOT NULL,              -- Free text description
    
    -- Structured fields
    sentiment INTEGER,                  -- -2 to +2 (very bearish to very bullish)
    confidence INTEGER,                 -- 1-5 confidence in this insight
    
    -- Tags for searchability
    tags TEXT,                          -- JSON array: ["momentum", "reversal", "news"]
    
    -- Related trade (if this led to a trade)
    related_trade_id TEXT,
    
    -- Outcome tracking
    outcome_correct INTEGER,            -- After the fact: was this insight right?
    outcome_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_annotations_type ON trader_annotations(annotation_type);
CREATE INDEX IF NOT EXISTS idx_annotations_crypto ON trader_annotations(crypto);


-- ============================================
-- REGIME DETECTION
-- ============================================

-- Track market regimes over time
CREATE TABLE IF NOT EXISTS market_regimes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    
    -- Regime classification
    volatility_regime TEXT,             -- 'low', 'medium', 'high'
    trend_regime TEXT,                  -- 'trending_up', 'trending_down', 'ranging'
    liquidity_regime TEXT,              -- 'thin', 'normal', 'thick'
    
    -- Regime metrics
    realized_volatility_1h REAL,        -- 1-hour realized vol
    realized_volatility_24h REAL,       -- 24-hour realized vol
    trend_strength REAL,                -- ADX-like measure
    avg_spread_1h REAL,                 -- Average spread last hour
    
    -- Regime change detection
    regime_change_detected INTEGER,     -- 1 if regime just changed
    previous_regime TEXT,               -- JSON of previous regime state
    
    -- Model-based regime
    hmm_state INTEGER,                  -- Hidden Markov Model state (if used)
    hmm_state_prob REAL                 -- Probability of current state
);

CREATE INDEX IF NOT EXISTS idx_regimes_crypto ON market_regimes(crypto, timestamp_ms);


-- ============================================
-- WINDOW OUTCOMES (enhanced)
-- ============================================

-- Enhanced window table with more outcome data
CREATE TABLE IF NOT EXISTS window_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    crypto TEXT NOT NULL,
    
    -- Resolution
    start_price REAL,                   -- Official price to beat
    end_price REAL,                     -- Final price at resolution
    outcome TEXT,                       -- 'up' or 'down'
    outcome_margin REAL,                -- How much above/below (in %)
    resolved_at DATETIME,
    
    -- Market behavior summary
    opening_up_price REAL,
    closing_up_price REAL,
    high_up_price REAL,
    low_up_price REAL,
    up_price_at_close REAL,             -- Final up_mid before resolution
    
    -- Spot behavior
    spot_high REAL,
    spot_low REAL,
    spot_range_pct REAL,
    max_favorable_move REAL,            -- Max move in outcome direction
    max_adverse_move REAL,              -- Max move against outcome
    
    -- Volume & activity
    tick_count INTEGER,
    trade_count INTEGER,
    total_volume REAL,
    buy_volume REAL,
    sell_volume REAL,
    
    -- Predictability metrics
    early_signal_accuracy REAL,         -- Was >5min prediction accurate?
    mid_signal_accuracy REAL,           -- Was 2-5min prediction accurate?
    late_signal_accuracy REAL,          -- Was <2min prediction accurate?
    price_momentum_aligned INTEGER,     -- Did momentum predict outcome?
    
    -- Market efficiency
    closing_price_vs_outcome REAL,      -- How close was market to being right?
    market_was_correct INTEGER,         -- Did market predict correctly at close?
    
    UNIQUE(epoch, crypto)
);

CREATE INDEX IF NOT EXISTS idx_window_outcomes ON window_outcomes(crypto, outcome);


-- ============================================
-- LEARNING METRICS (track what works)
-- ============================================

-- Track which features/signals are predictive over time
CREATE TABLE IF NOT EXISTS feature_importance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Feature identification
    feature_name TEXT NOT NULL,
    crypto TEXT,                        -- NULL = all cryptos
    
    -- Importance metrics
    information_gain REAL,              -- Mutual information with outcome
    correlation_with_outcome REAL,      -- Point-biserial correlation
    predictive_power REAL,              -- AUC when used alone
    
    -- Stability
    importance_std REAL,                -- Std dev of importance across windows
    rank_stability REAL,                -- How stable is this feature's rank?
    
    -- Time analysis
    best_time_phase TEXT,               -- When is this feature most useful?
    lead_time_optimal REAL,             -- Optimal lookahead for this feature
    
    -- Sample info
    sample_windows INTEGER,
    sample_period_start DATETIME,
    sample_period_end DATETIME
);

CREATE INDEX IF NOT EXISTS idx_feature_importance ON feature_importance(feature_name);


-- ============================================
-- EXECUTION QUALITY (for live trading analysis)
-- ============================================

CREATE TABLE IF NOT EXISTS execution_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL,             -- Reference to trades table
    timestamp_ms INTEGER NOT NULL,
    
    -- Pre-trade state
    mid_price_at_decision REAL,
    spread_at_decision REAL,
    book_depth_at_decision REAL,
    
    -- Execution quality
    expected_price REAL,
    actual_price REAL,
    slippage_bps REAL,                  -- Slippage in basis points
    
    -- Market impact
    price_5s_after REAL,                -- Price 5 seconds after
    price_30s_after REAL,               -- Price 30 seconds after
    market_impact_5s REAL,
    market_impact_30s REAL,
    
    -- Timing analysis
    was_good_entry INTEGER,             -- In hindsight, good timing?
    better_price_available_within_10s INTEGER,
    
    FOREIGN KEY (trade_id) REFERENCES trades(trade_id)
);


-- ============================================
-- SESSION METADATA
-- ============================================

CREATE TABLE IF NOT EXISTS collection_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME NOT NULL,
    ended_at DATETIME,
    
    -- Session info
    session_type TEXT,                  -- 'data_collection', 'paper_trading', 'live'
    cryptos_tracked TEXT,               -- JSON array
    
    -- Stats
    ticks_collected INTEGER DEFAULT 0,
    trades_collected INTEGER DEFAULT 0,
    predictions_made INTEGER DEFAULT 0,
    annotations_made INTEGER DEFAULT 0,
    
    -- Health
    binance_disconnects INTEGER DEFAULT 0,
    polymarket_disconnects INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    
    -- Notes
    notes TEXT
);
