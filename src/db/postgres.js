/**
 * PostgreSQL Database Connection
 * 
 * For production use with Supabase/Neon/Vercel Postgres.
 * Falls back to SQLite for local development.
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

/**
 * Initialize PostgreSQL connection
 */
export function initPostgres() {
    if (pool) return pool;
    
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.log('⚠️  No DATABASE_URL found, PostgreSQL not available');
        return null;
    }
    
    pool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });
    
    pool.on('error', (err) => {
        console.error('PostgreSQL pool error:', err);
    });
    
    console.log('✅ PostgreSQL pool initialized');
    return pool;
}

/**
 * Get PostgreSQL pool
 */
export function getPool() {
    return pool;
}

/**
 * Execute a query
 */
export async function query(text, params = []) {
    if (!pool) {
        throw new Error('PostgreSQL not initialized');
    }
    
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
        console.log('Slow query:', { text: text.substring(0, 100), duration, rows: result.rowCount });
    }
    
    return result;
}

/**
 * Get a client for transactions
 */
export async function getClient() {
    if (!pool) {
        throw new Error('PostgreSQL not initialized');
    }
    return pool.connect();
}

/**
 * Run migrations to set up schema
 */
export async function runMigrations() {
    if (!pool) return;
    
    console.log('🔄 Running PostgreSQL migrations...');
    
    const migrations = [
        // Ticks table
        `CREATE TABLE IF NOT EXISTS ticks (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            timestamp_ms BIGINT NOT NULL,
            crypto TEXT NOT NULL,
            window_epoch BIGINT NOT NULL,
            time_remaining_sec REAL,
            up_bid REAL,
            up_ask REAL,
            up_bid_size REAL,
            up_ask_size REAL,
            up_last_trade REAL,
            up_mid REAL,
            down_bid REAL,
            down_ask REAL,
            down_bid_size REAL,
            down_ask_size REAL,
            down_last_trade REAL,
            spot_price REAL,
            price_to_beat REAL,
            spot_delta REAL,
            spot_delta_pct REAL,
            spread REAL,
            spread_pct REAL,
            implied_prob_up REAL,
            up_book_depth TEXT,
            down_book_depth TEXT
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_ticks_crypto_epoch ON ticks(crypto, window_epoch)`,
        `CREATE INDEX IF NOT EXISTS idx_ticks_timestamp ON ticks(timestamp_ms)`,
        
        // Windows table
        `CREATE TABLE IF NOT EXISTS windows (
            id SERIAL PRIMARY KEY,
            epoch BIGINT NOT NULL,
            crypto TEXT NOT NULL,
            start_price REAL,
            end_price REAL,
            outcome TEXT,
            resolved_at TIMESTAMPTZ,
            opening_up_price REAL,
            closing_up_price REAL,
            high_up_price REAL,
            low_up_price REAL,
            tick_count INTEGER DEFAULT 0,
            price_change_count INTEGER DEFAULT 0,
            up_price_volatility REAL,
            spot_volatility REAL,
            max_spot_delta_pct REAL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(epoch, crypto)
        )`,
        
        // Trades table
        `CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            timestamp_ms BIGINT NOT NULL,
            trade_id TEXT UNIQUE,
            mode TEXT NOT NULL,
            strategy TEXT,
            crypto TEXT NOT NULL,
            window_epoch BIGINT NOT NULL,
            side TEXT NOT NULL,
            size REAL NOT NULL,
            price REAL NOT NULL,
            fee REAL DEFAULT 0,
            slippage REAL DEFAULT 0,
            spot_price REAL,
            up_bid REAL,
            up_ask REAL,
            time_remaining_sec REAL,
            exit_trade_id TEXT,
            realized_pnl REAL,
            notes TEXT
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode)`,
        `CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy)`,
        
        // Predictions table
        `CREATE TABLE IF NOT EXISTS predictions (
            id SERIAL PRIMARY KEY,
            prediction_id TEXT UNIQUE,
            timestamp_ms BIGINT NOT NULL,
            crypto TEXT NOT NULL,
            window_epoch BIGINT NOT NULL,
            model_name TEXT NOT NULL,
            model_version TEXT,
            predicted_outcome TEXT,
            predicted_prob_up REAL,
            confidence REAL,
            feature_snapshot TEXT,
            signals_snapshot TEXT,
            time_remaining_sec REAL,
            spot_price REAL,
            up_mid REAL,
            spot_delta_pct REAL,
            actual_outcome TEXT,
            was_correct INTEGER,
            calibration_bucket INTEGER,
            top_feature_1 TEXT,
            top_feature_1_value REAL,
            top_feature_2 TEXT,
            top_feature_2_value REAL,
            top_feature_3 TEXT,
            top_feature_3_value REAL
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_predictions_model ON predictions(model_name, crypto)`,
        `CREATE INDEX IF NOT EXISTS idx_predictions_window ON predictions(window_epoch)`,
        
        // Trader annotations table
        `CREATE TABLE IF NOT EXISTS trader_annotations (
            id SERIAL PRIMARY KEY,
            annotation_id TEXT UNIQUE,
            timestamp_ms BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            crypto TEXT,
            window_epoch BIGINT,
            annotation_type TEXT NOT NULL,
            content TEXT NOT NULL,
            sentiment INTEGER,
            confidence INTEGER,
            tags TEXT,
            related_trade_id TEXT,
            outcome_correct INTEGER,
            outcome_notes TEXT,
            spot_price REAL,
            up_mid REAL,
            time_remaining_sec REAL
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_annotations_type ON trader_annotations(annotation_type)`,
        
        // Tick features table
        `CREATE TABLE IF NOT EXISTS tick_features (
            id SERIAL PRIMARY KEY,
            tick_id INTEGER,
            timestamp_ms BIGINT NOT NULL,
            crypto TEXT NOT NULL,
            window_epoch BIGINT NOT NULL,
            price_return_5t REAL,
            price_return_10t REAL,
            price_return_30t REAL,
            price_return_60t REAL,
            spot_return_5t REAL,
            spot_return_10t REAL,
            spot_return_30t REAL,
            up_price_sma_10 REAL,
            up_price_sma_20 REAL,
            up_price_ema_10 REAL,
            up_price_ema_20 REAL,
            up_price_vs_sma_10 REAL,
            up_price_vs_sma_20 REAL,
            price_volatility_10t REAL,
            price_volatility_30t REAL,
            spot_volatility_10t REAL,
            spot_volatility_30t REAL,
            volatility_ratio REAL,
            spread_bps REAL,
            spread_vs_avg REAL,
            bid_ask_imbalance REAL,
            bid_depth_5 REAL,
            ask_depth_5 REAL,
            depth_imbalance_5 REAL,
            weighted_mid_price REAL,
            microprice REAL,
            spot_delta_zscore REAL,
            spot_market_divergence REAL,
            spot_lead_signal REAL,
            price_to_beat_distance REAL,
            time_remaining_pct REAL,
            time_phase INTEGER,
            rsi_14 REAL,
            macd_signal REAL,
            bollinger_position REAL,
            return_autocorr_1 REAL,
            return_autocorr_5 REAL,
            mean_reversion_signal REAL
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_tick_features_lookup ON tick_features(crypto, window_epoch, timestamp_ms)`
    ];
    
    for (const sql of migrations) {
        try {
            await pool.query(sql);
        } catch (error) {
            // Ignore "already exists" errors
            if (!error.message.includes('already exists')) {
                console.error('Migration error:', error.message);
            }
        }
    }
    
    console.log('✅ PostgreSQL migrations complete');
}

/**
 * Close the pool
 */
export async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('PostgreSQL pool closed');
    }
}

export default {
    initPostgres,
    getPool,
    query,
    getClient,
    runMigrations,
    closePool
};
