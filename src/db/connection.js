/**
 * Database Connection Manager
 * 
 * Uses PostgreSQL when DATABASE_URL is set (production/Railway)
 * Falls back to SQLite for local development
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database mode
const USE_POSTGRES = !!process.env.DATABASE_URL;

// PostgreSQL pool
let pgPool = null;

// SQLite db (lazy loaded)
let sqliteDb = null;

/**
 * Initialize PostgreSQL connection
 */
function initPostgres() {
    if (pgPool) return pgPool;
    
    console.log('📂 Initializing PostgreSQL connection...');
    
    pgPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,                     // Reduced from 10 - Supabase free tier has limits
        min: 1,                     // Keep at least 1 connection alive
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,  // Timeout for new connections
        allowExitOnIdle: false      // Keep pool alive
    });
    
    pgPool.on('error', (err) => {
        console.error('PostgreSQL pool error:', err.message);
        // Don't crash - just log. Pool will try to reconnect.
    });
    
    pgPool.on('connect', () => {
        console.log('📡 New PostgreSQL connection established');
    });
    
    console.log('✅ PostgreSQL initialized (max 5 connections)');
    return pgPool;
}

/**
 * Recreate pool if it's dead
 */
function ensurePool() {
    if (!pgPool) {
        return initPostgres();
    }
    return pgPool;
}

/**
 * Initialize SQLite (for local dev only)
 */
async function initSQLite(dbPath = null) {
    if (sqliteDb) return sqliteDb;
    
    // Dynamic import to avoid loading better-sqlite3 on Vercel
    const Database = (await import('better-sqlite3')).default;
    
    const defaultPath = join(__dirname, '../../data/polymarket.db');
    const path = dbPath || defaultPath;
    
    console.log(`📂 Initializing SQLite at: ${path}`);
    
    sqliteDb = new Database(path);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('synchronous = NORMAL');
    
    // Initialize schema
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    sqliteDb.exec(schema);
    
    console.log('✅ SQLite initialized');
    return sqliteDb;
}

/**
 * Initialize the database connection
 */
export function initDatabase(dbPath = null) {
    if (USE_POSTGRES) {
        return initPostgres();
    } else {
        return initSQLite(dbPath);
    }
}

/**
 * Get database instance
 */
export function getDatabase() {
    if (USE_POSTGRES) {
        if (!pgPool) initPostgres();
        return pgPool;
    } else {
        if (!sqliteDb) initSQLite();
        return sqliteDb;
    }
}

/**
 * Close database connection
 */
export async function closeDatabase() {
    if (pgPool) {
        await pgPool.end();
        pgPool = null;
        console.log('🔴 PostgreSQL closed');
    }
    if (sqliteDb) {
        sqliteDb.close();
        sqliteDb = null;
        console.log('🔴 SQLite closed');
    }
}

/**
 * Insert a tick record
 */
export async function insertTick(tick) {
    if (USE_POSTGRES) {
        const pool = ensurePool();
        const query = `
            INSERT INTO ticks (
                timestamp_ms, crypto, window_epoch, time_remaining_sec,
                up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                spot_price, price_to_beat, spot_delta, spot_delta_pct,
                spread, spread_pct, implied_prob_up,
                up_book_depth, down_book_depth,
                chainlink_price, chainlink_staleness, chainlink_updated_at,
                price_divergence, price_divergence_pct
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29
            )
        `;
        const values = [
            tick.timestamp_ms, tick.crypto, tick.window_epoch, tick.time_remaining_sec,
            tick.up_bid, tick.up_ask, tick.up_bid_size, tick.up_ask_size, tick.up_last_trade, tick.up_mid,
            tick.down_bid, tick.down_ask, tick.down_bid_size, tick.down_ask_size, tick.down_last_trade,
            tick.spot_price, tick.price_to_beat, tick.spot_delta, tick.spot_delta_pct,
            tick.spread, tick.spread_pct, tick.implied_prob_up,
            tick.up_book_depth, tick.down_book_depth,
            tick.chainlink_price, tick.chainlink_staleness, tick.chainlink_updated_at,
            tick.price_divergence, tick.price_divergence_pct
        ];
        return pool.query(query, values);
    } else {
        const db = getDatabase();
        const stmt = db.prepare(`
            INSERT INTO ticks (
                timestamp_ms, crypto, window_epoch, time_remaining_sec,
                up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                spot_price, price_to_beat, spot_delta, spot_delta_pct,
                spread, spread_pct, implied_prob_up,
                up_book_depth, down_book_depth,
                chainlink_price, chainlink_staleness, chainlink_updated_at,
                price_divergence, price_divergence_pct
            ) VALUES (
                @timestamp_ms, @crypto, @window_epoch, @time_remaining_sec,
                @up_bid, @up_ask, @up_bid_size, @up_ask_size, @up_last_trade, @up_mid,
                @down_bid, @down_ask, @down_bid_size, @down_ask_size, @down_last_trade,
                @spot_price, @price_to_beat, @spot_delta, @spot_delta_pct,
                @spread, @spread_pct, @implied_prob_up,
                @up_book_depth, @down_book_depth,
                @chainlink_price, @chainlink_staleness, @chainlink_updated_at,
                @price_divergence, @price_divergence_pct
            )
        `);
        return stmt.run(tick);
    }
}

/**
 * Batch insert ticks for better performance
 * FIXED: Uses single client for all inserts instead of getting new connections
 */
export async function insertTicksBatch(ticks) {
    if (!ticks || ticks.length === 0) return;
    
    if (USE_POSTGRES) {
        const pool = ensurePool();
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            
            // Insert each tick using the SAME client (not calling insertTick which gets new connection)
            const query = `
                INSERT INTO ticks (
                    timestamp_ms, crypto, window_epoch, time_remaining_sec,
                    up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                    down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                    spot_price, price_to_beat, spot_delta, spot_delta_pct,
                    spread, spread_pct, implied_prob_up,
                    up_book_depth, down_book_depth,
                    chainlink_price, chainlink_staleness, chainlink_updated_at,
                    price_divergence, price_divergence_pct
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
            `;
            
            for (const tick of ticks) {
                const values = [
                    tick.timestamp_ms, tick.crypto, tick.window_epoch, tick.time_remaining_sec,
                    tick.up_bid, tick.up_ask, tick.up_bid_size, tick.up_ask_size, tick.up_last_trade, tick.up_mid,
                    tick.down_bid, tick.down_ask, tick.down_bid_size, tick.down_ask_size, tick.down_last_trade,
                    tick.spot_price, tick.price_to_beat, tick.spot_delta, tick.spot_delta_pct,
                    tick.spread, tick.spread_pct, tick.implied_prob_up,
                    tick.up_book_depth, tick.down_book_depth,
                    tick.chainlink_price, tick.chainlink_staleness, tick.chainlink_updated_at,
                    tick.price_divergence, tick.price_divergence_pct
                ];
                await client.query(query, values);
            }
            
            await client.query('COMMIT');
        } catch (e) {
            if (client) {
                try { await client.query('ROLLBACK'); } catch (re) { /* ignore */ }
            }
            throw e;
        } finally {
            if (client) {
                try { client.release(); } catch (re) { /* ignore */ }
            }
        }
    } else {
        const db = getDatabase();
        const stmt = db.prepare(`
            INSERT INTO ticks (
                timestamp_ms, crypto, window_epoch, time_remaining_sec,
                up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                spot_price, price_to_beat, spot_delta, spot_delta_pct,
                spread, spread_pct, implied_prob_up,
                up_book_depth, down_book_depth,
                chainlink_price, chainlink_staleness, chainlink_updated_at,
                price_divergence, price_divergence_pct
            ) VALUES (
                @timestamp_ms, @crypto, @window_epoch, @time_remaining_sec,
                @up_bid, @up_ask, @up_bid_size, @up_ask_size, @up_last_trade, @up_mid,
                @down_bid, @down_ask, @down_bid_size, @down_ask_size, @down_last_trade,
                @spot_price, @price_to_beat, @spot_delta, @spot_delta_pct,
                @spread, @spread_pct, @implied_prob_up,
                @up_book_depth, @down_book_depth,
                @chainlink_price, @chainlink_staleness, @chainlink_updated_at,
                @price_divergence, @price_divergence_pct
            )
        `);
        const insertMany = db.transaction((ticks) => {
            for (const tick of ticks) {
                stmt.run(tick);
            }
        });
        insertMany(ticks);
    }
}

/**
 * Insert or update a window record
 */
export async function upsertWindow(window) {
    if (USE_POSTGRES) {
        const pool = getDatabase();
        const query = `
            INSERT INTO windows (
                epoch, crypto, start_price, end_price, outcome, resolved_at,
                opening_up_price, closing_up_price, high_up_price, low_up_price,
                tick_count, price_change_count,
                up_price_volatility, spot_volatility, max_spot_delta_pct
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT(epoch, crypto) DO UPDATE SET
                end_price = EXCLUDED.end_price,
                outcome = EXCLUDED.outcome,
                resolved_at = EXCLUDED.resolved_at,
                closing_up_price = EXCLUDED.closing_up_price,
                high_up_price = GREATEST(windows.high_up_price, EXCLUDED.high_up_price),
                low_up_price = LEAST(windows.low_up_price, EXCLUDED.low_up_price),
                tick_count = EXCLUDED.tick_count,
                price_change_count = EXCLUDED.price_change_count,
                up_price_volatility = EXCLUDED.up_price_volatility,
                spot_volatility = EXCLUDED.spot_volatility,
                max_spot_delta_pct = GREATEST(windows.max_spot_delta_pct, EXCLUDED.max_spot_delta_pct)
        `;
        const values = [
            window.epoch, window.crypto, window.start_price, window.end_price,
            window.outcome, window.resolved_at, window.opening_up_price, window.closing_up_price,
            window.high_up_price, window.low_up_price, window.tick_count, window.price_change_count,
            window.up_price_volatility, window.spot_volatility, window.max_spot_delta_pct
        ];
        return pool.query(query, values);
    } else {
        const db = getDatabase();
        const stmt = db.prepare(`
            INSERT INTO windows (
                epoch, crypto, start_price, end_price, outcome, resolved_at,
                opening_up_price, closing_up_price, high_up_price, low_up_price,
                tick_count, price_change_count,
                up_price_volatility, spot_volatility, max_spot_delta_pct
            ) VALUES (
                @epoch, @crypto, @start_price, @end_price, @outcome, @resolved_at,
                @opening_up_price, @closing_up_price, @high_up_price, @low_up_price,
                @tick_count, @price_change_count,
                @up_price_volatility, @spot_volatility, @max_spot_delta_pct
            )
            ON CONFLICT(epoch, crypto) DO UPDATE SET
                end_price = @end_price,
                outcome = @outcome,
                resolved_at = @resolved_at,
                closing_up_price = @closing_up_price,
                high_up_price = MAX(high_up_price, @high_up_price),
                low_up_price = MIN(low_up_price, @low_up_price),
                tick_count = @tick_count,
                price_change_count = @price_change_count,
                up_price_volatility = @up_price_volatility,
                spot_volatility = @spot_volatility,
                max_spot_delta_pct = MAX(max_spot_delta_pct, @max_spot_delta_pct)
        `);
        return stmt.run(window);
    }
}

/**
 * Insert a trade record
 */
export async function insertTrade(trade) {
    if (USE_POSTGRES) {
        const pool = getDatabase();
        const query = `
            INSERT INTO trades (
                timestamp_ms, trade_id, mode, strategy,
                crypto, window_epoch, side, size, price,
                fee, slippage, spot_price, up_bid, up_ask,
                time_remaining_sec, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `;
        const values = [
            trade.timestamp_ms, trade.trade_id, trade.mode, trade.strategy,
            trade.crypto, trade.window_epoch, trade.side, trade.size, trade.price,
            trade.fee, trade.slippage, trade.spot_price, trade.up_bid, trade.up_ask,
            trade.time_remaining_sec, trade.notes
        ];
        return pool.query(query, values);
    } else {
        const db = getDatabase();
        const stmt = db.prepare(`
            INSERT INTO trades (
                timestamp_ms, trade_id, mode, strategy,
                crypto, window_epoch, side, size, price,
                fee, slippage, spot_price, up_bid, up_ask,
                time_remaining_sec, notes
            ) VALUES (
                @timestamp_ms, @trade_id, @mode, @strategy,
                @crypto, @window_epoch, @side, @size, @price,
                @fee, @slippage, @spot_price, @up_bid, @up_ask,
                @time_remaining_sec, @notes
            )
        `);
        return stmt.run(trade);
    }
}

/**
 * Get system state value
 */
export async function getState(key) {
    if (USE_POSTGRES) {
        const pool = getDatabase();
        const result = await pool.query('SELECT value FROM system_state WHERE key = $1', [key]);
        return result.rows[0]?.value || null;
    } else {
        const db = getDatabase();
        const stmt = db.prepare('SELECT value FROM system_state WHERE key = ?');
        const row = stmt.get(key);
        return row ? row.value : null;
    }
}

/**
 * Set system state value
 */
export async function setState(key, value) {
    if (USE_POSTGRES) {
        const pool = getDatabase();
        return pool.query(`
            INSERT INTO system_state (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT(key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = NOW()
        `, [key, value]);
    } else {
        const db = getDatabase();
        const stmt = db.prepare(`
            INSERT INTO system_state (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `);
        return stmt.run(key, value);
    }
}

/**
 * Save research engine stats (strategy performance, signals, etc.)
 * Stores as JSON in system_state for simplicity
 */
export async function saveResearchStats(stats) {
    return setState('research_stats', JSON.stringify(stats));
}

/**
 * Get research engine stats
 */
export async function getResearchStats() {
    const result = await getState('research_stats');
    if (result) {
        try {
            return JSON.parse(result);
        } catch (e) {
            return null;
        }
    }
    return null;
}

/**
 * Save a completed paper trade to database for historical tracking
 */
// Sanitize numeric values to prevent database overflow errors
function sanitizeNumeric(value, defaultVal = null) {
    if (value === null || value === undefined) return defaultVal;
    if (typeof value !== 'number') value = parseFloat(value);
    if (!Number.isFinite(value)) return defaultVal;  // Handle NaN, Infinity
    return value;
}

export async function savePaperTrade(trade) {
    if (USE_POSTGRES && pgPool) {
        // Sanitize all numeric fields to prevent overflow errors
        const sanitized = {
            ...trade,
            entryPrice: sanitizeNumeric(trade.entryPrice),
            exitPrice: sanitizeNumeric(trade.exitPrice),
            entrySpotPrice: sanitizeNumeric(trade.entrySpotPrice),
            exitSpotPrice: sanitizeNumeric(trade.exitSpotPrice),
            priceToBeat: sanitizeNumeric(trade.priceToBeat),
            entryMarketProb: sanitizeNumeric(trade.entryMarketProb),
            exitMarketProb: sanitizeNumeric(trade.exitMarketProb),
            timeRemainingAtEntry: sanitizeNumeric(trade.timeRemainingAtEntry),
            pnl: sanitizeNumeric(trade.pnl),
            holdingTimeMs: sanitizeNumeric(trade.holdingTimeMs),
            entryBidSize: sanitizeNumeric(trade.entryBidSize),
            entryAskSize: sanitizeNumeric(trade.entryAskSize),
            entrySpread: sanitizeNumeric(trade.entrySpread),
            entrySpreadPct: sanitizeNumeric(trade.entrySpreadPct),
            exitBidSize: sanitizeNumeric(trade.exitBidSize),
            exitAskSize: sanitizeNumeric(trade.exitAskSize),
            exitSpread: sanitizeNumeric(trade.exitSpread),
            spotMoveDuringTrade: sanitizeNumeric(trade.spotMoveDuringTrade),
            marketMoveDuringTrade: sanitizeNumeric(trade.marketMoveDuringTrade),
            signalStrength: sanitizeNumeric(trade.signalStrength),
            entryBookImbalance: sanitizeNumeric(trade.entryBookImbalance)
        };
        
        try {
            await pgPool.query(`
                INSERT INTO paper_trades (
                    strategy_name, crypto, side,
                    entry_time, exit_time, window_epoch, holding_time_ms,
                    entry_price, exit_price, entry_spot_price, exit_spot_price, price_to_beat,
                    entry_market_prob, exit_market_prob, time_remaining_at_entry,
                    pnl, outcome, reason,
                    entry_bid_size, entry_ask_size, entry_spread, entry_spread_pct,
                    exit_bid_size, exit_ask_size, exit_spread,
                    spot_move_during_trade, market_move_during_trade,
                    signal_strength, entry_book_imbalance
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
            `, [
                sanitized.strategyName,
                sanitized.crypto,
                sanitized.side,
                new Date(sanitized.entryTime),
                new Date(sanitized.exitTime),
                sanitized.windowEpoch,
                sanitized.holdingTimeMs,
                sanitized.entryPrice,
                sanitized.exitPrice,
                sanitized.entrySpotPrice,
                sanitized.exitSpotPrice,
                sanitized.priceToBeat,
                sanitized.entryMarketProb,
                sanitized.exitMarketProb,
                sanitized.timeRemainingAtEntry,
                sanitized.pnl,
                sanitized.outcome,
                sanitized.reason,
                // New depth fields
                sanitized.entryBidSize,
                sanitized.entryAskSize,
                sanitized.entrySpread,
                sanitized.entrySpreadPct,
                sanitized.exitBidSize,
                sanitized.exitAskSize,
                sanitized.exitSpread,
                sanitized.spotMoveDuringTrade,
                sanitized.marketMoveDuringTrade,
                sanitized.signalStrength,
                sanitized.entryBookImbalance
            ]);
        } catch (error) {
            // Log more detail for numeric overflow errors
            if (error.message.includes('numeric field overflow')) {
                console.error('Failed to save paper trade (numeric overflow). Values:', JSON.stringify({
                    entrySpotPrice: trade.entrySpotPrice,
                    exitSpotPrice: trade.exitSpotPrice,
                    priceToBeat: trade.priceToBeat,
                    pnl: trade.pnl,
                    holdingTimeMs: trade.holdingTimeMs,
                    signalStrength: trade.signalStrength
                }));
            } else {
                console.error('Failed to save paper trade:', error.message);
            }
        }
    }
}

/**
 * Get paper trades with time filtering
 * @param {Object} options - Filter options
 * @param {string} options.period - 'current', 'hour', 'day', 'week', 'all'
 * @param {string} options.strategy - Strategy name filter (optional)
 * @param {string} options.crypto - Crypto filter (optional)
 */
export async function getPaperTrades(options = {}) {
    if (!USE_POSTGRES || !pgPool) {
        return { trades: [], stats: {} };
    }
    
    const { period = 'all', strategy = null, crypto = null } = options;
    
    // Calculate time filter
    let timeFilter = '';
    const now = new Date();
    
    switch (period) {
        case 'current':
            // Current 15-min window
            const currentEpoch = Math.floor(now.getTime() / 1000 / 900) * 900;
            timeFilter = `AND window_epoch = ${currentEpoch}`;
            break;
        case 'hour':
            timeFilter = `AND exit_time > NOW() - INTERVAL '1 hour'`;
            break;
        case 'day':
            timeFilter = `AND exit_time > NOW() - INTERVAL '1 day'`;
            break;
        case 'week':
            timeFilter = `AND exit_time > NOW() - INTERVAL '1 week'`;
            break;
        case 'all':
        default:
            timeFilter = '';
    }
    
    // Strategy filter
    const strategyFilter = strategy ? `AND strategy_name = '${strategy}'` : '';
    
    // Crypto filter
    const cryptoFilter = crypto ? `AND crypto = '${crypto}'` : '';
    
    try {
        // Set a query timeout to prevent hanging
        const queryTimeout = 10000; // 10 seconds
        
        // Get individual trades
        const tradesPromise = pgPool.query(`
            SELECT * FROM paper_trades 
            WHERE 1=1 ${timeFilter} ${strategyFilter} ${cryptoFilter}
            ORDER BY exit_time DESC
            LIMIT 100
        `);
        
        // Get aggregated stats by strategy
        const statsPromise = pgPool.query(`
            SELECT 
                strategy_name,
                crypto,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl
            FROM paper_trades
            WHERE 1=1 ${timeFilter} ${strategyFilter} ${cryptoFilter}
            GROUP BY strategy_name, crypto
            ORDER BY total_pnl DESC
        `);
        
        // Get overall stats
        const overallPromise = pgPool.query(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl,
                COUNT(DISTINCT strategy_name) as strategies_used,
                COUNT(DISTINCT window_epoch) as windows_traded
            FROM paper_trades
            WHERE 1=1 ${timeFilter} ${strategyFilter} ${cryptoFilter}
        `);
        
        // Run all queries in parallel with timeout
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Query timeout')), queryTimeout)
        );
        
        const [tradesResult, statsResult, overallResult] = await Promise.race([
            Promise.all([tradesPromise, statsPromise, overallPromise]),
            timeoutPromise.then(() => { throw new Error('Query timeout'); })
        ]);
        
        return {
            trades: tradesResult.rows,
            strategyStats: statsResult.rows,
            overall: overallResult.rows[0] || {}
        };
    } catch (error) {
        console.error('Failed to get paper trades:', error.message);
        return { trades: [], strategyStats: [], overall: {}, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE TRADING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get list of strategies enabled for live trading
 */
export async function getLiveEnabledStrategies() {
    if (!USE_POSTGRES || !pgPool) {
        // Return from memory/state if no database
        const state = await getState('live_strategies');
        return state ? JSON.parse(state) : [];
    }
    
    try {
        // First ensure the table exists
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS live_strategies (
                strategy_name TEXT PRIMARY KEY,
                enabled BOOLEAN DEFAULT false,
                enabled_at TIMESTAMP,
                disabled_at TIMESTAMP,
                total_trades INTEGER DEFAULT 0,
                total_pnl REAL DEFAULT 0
            )
        `);
        
        const result = await pgPool.query(`
            SELECT strategy_name FROM live_strategies WHERE enabled = true
        `);
        return result.rows.map(r => r.strategy_name);
    } catch (error) {
        console.error('Failed to get live enabled strategies:', error.message);
        return [];
    }
}

/**
 * Enable or disable a strategy for live trading
 */
export async function setLiveStrategyEnabled(strategyName, enabled) {
    if (!USE_POSTGRES || !pgPool) {
        // Store in state if no database
        const strategies = await getLiveEnabledStrategies();
        if (enabled && !strategies.includes(strategyName)) {
            strategies.push(strategyName);
        } else if (!enabled) {
            const idx = strategies.indexOf(strategyName);
            if (idx >= 0) strategies.splice(idx, 1);
        }
        await setState('live_strategies', JSON.stringify(strategies));
        return true;
    }
    
    try {
        await pgPool.query(`
            INSERT INTO live_strategies (strategy_name, enabled, enabled_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (strategy_name) 
            DO UPDATE SET 
                enabled = $2,
                enabled_at = CASE WHEN $2 THEN NOW() ELSE live_strategies.enabled_at END,
                disabled_at = CASE WHEN NOT $2 THEN NOW() ELSE live_strategies.disabled_at END
        `, [strategyName, enabled]);
        return true;
    } catch (error) {
        console.error('Failed to set strategy enabled:', error.message);
        return false;
    }
}

/**
 * Get timestamp in Eastern Time (ET) to match Polymarket display
 */
function getETTimestamp() {
    const now = new Date();
    // Format in Eastern Time
    return now.toLocaleString('en-US', { 
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),?\s*/, '$3-$1-$2 ');
}

/**
 * Backup failed trades to file (fallback if DB fails)
 */
const fs = await import('fs').then(m => m.promises).catch(() => null);
const BACKUP_FILE = './data/failed_trades.jsonl';

async function backupTradeToFile(trade) {
    if (!fs) return;
    try {
        const line = JSON.stringify({ ...trade, backup_time: new Date().toISOString() }) + '\n';
        await fs.appendFile(BACKUP_FILE, line);
        console.log('[TradeBackup] Saved to backup file');
    } catch (e) {
        console.error('[TradeBackup] File backup also failed:', e.message);
    }
}

/**
 * Save a live trade to database with retry and backup
 */
export async function saveLiveTrade(trade, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;
    
    // Add ET timestamp if not provided
    if (!trade.timestamp_et) {
        trade.timestamp_et = getETTimestamp();
    }
    
    // If no Postgres, backup to file
    if (!USE_POSTGRES || !pgPool) {
        console.log('[LiveTrade] No DB, backing up:', trade);
        await backupTradeToFile(trade);
        return;
    }
    
    try {
        // Ensure table exists with all columns
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS live_trades (
                id SERIAL PRIMARY KEY,
                type TEXT,
                strategy_name TEXT,
                crypto TEXT,
                side TEXT,
                window_epoch INTEGER,
                price REAL,
                size REAL,
                spot_price REAL,
                time_remaining REAL,
                reason TEXT,
                entry_price REAL,
                pnl REAL,
                outcome TEXT,
                tx_hash TEXT,
                condition_id TEXT,
                timestamp TIMESTAMP DEFAULT NOW(),
                timestamp_et TEXT
            )
        `);
        
        // Add new columns if they don't exist
        await pgPool.query(`ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS outcome TEXT`).catch(() => {});
        await pgPool.query(`ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS tx_hash TEXT`).catch(() => {});
        await pgPool.query(`ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS condition_id TEXT`).catch(() => {});
        await pgPool.query(`ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS timestamp_et TEXT`).catch(() => {});
        
        await pgPool.query(`
            INSERT INTO live_trades (type, strategy_name, crypto, side, window_epoch, price, size, spot_price, time_remaining, reason, entry_price, pnl, outcome, tx_hash, condition_id, timestamp, timestamp_et)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `, [
            trade.type, trade.strategy_name, trade.crypto, trade.side,
            trade.window_epoch, trade.price, trade.size, trade.spot_price,
            trade.time_remaining, trade.reason, trade.entry_price, trade.pnl,
            trade.outcome || null, trade.tx_hash || null, trade.condition_id || null,
            trade.timestamp, trade.timestamp_et
        ]);
        
        console.log(`[LiveTrade] ✅ Saved: ${trade.type} ${trade.strategy_name} ${trade.crypto} ${trade.side} @ ${trade.price}`);
        
        // Update strategy stats
        if (trade.pnl !== null && trade.pnl !== undefined) {
            await pgPool.query(`
                UPDATE live_strategies 
                SET total_trades = total_trades + 1, total_pnl = total_pnl + $2
                WHERE strategy_name = $1
            `, [trade.strategy_name, trade.pnl]);
        }
    } catch (error) {
        console.error(`[LiveTrade] ❌ Save failed (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error.message);
        
        // Retry with exponential backoff
        if (retryCount < MAX_RETRIES - 1) {
            const delay = RETRY_DELAY * Math.pow(2, retryCount);
            console.log(`[LiveTrade] Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            return saveLiveTrade(trade, retryCount + 1);
        }
        
        // All retries failed - backup to file
        console.error('[LiveTrade] All retries failed, backing up to file');
        await backupTradeToFile(trade);
    }
}

/**
 * Get live trades history
 */
export async function getLiveTrades(options = {}) {
    if (!USE_POSTGRES || !pgPool) {
        return { trades: [], stats: [] };
    }
    
    try {
        const { hours = 24, strategy = null } = options;
        
        let whereClause = `timestamp > NOW() - INTERVAL '${hours} hours'`;
        if (strategy) {
            whereClause += ` AND strategy_name = '${strategy}'`;
        }
        
        const trades = await pgPool.query(`
            SELECT * FROM live_trades 
            WHERE ${whereClause}
            ORDER BY timestamp DESC
            LIMIT 100
        `);
        
        const stats = await pgPool.query(`
            SELECT 
                strategy_name,
                COUNT(*) as trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl
            FROM live_trades 
            WHERE ${whereClause} AND type = 'exit'
            GROUP BY strategy_name
        `);
        
        return {
            trades: trades.rows,
            stats: stats.rows
        };
    } catch (error) {
        console.error('Failed to get live trades:', error.message);
        return { trades: [], stats: [], error: error.message };
    }
}

// ============================================================================
// ORACLE OVERSEER & RESOLUTION SERVICE TABLES
// ============================================================================

/**
 * Initialize OracleOverseer and Resolution tables
 */
export async function initOracleResolutionTables() {
    if (!USE_POSTGRES || !pgPool) {
        console.log('⚠️  Oracle/Resolution tables require PostgreSQL');
        return false;
    }

    try {
        // Oracle Lag Events - tracks lag detection with market price changes
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS oracle_lag_events (
                id SERIAL PRIMARY KEY,
                event_id TEXT UNIQUE,
                timestamp_ms BIGINT NOT NULL,
                crypto TEXT NOT NULL,
                window_epoch BIGINT NOT NULL,

                -- Lag Detection
                direction TEXT NOT NULL,
                lag_magnitude REAL,
                lag_magnitude_pct REAL,

                -- Spot Movement
                spot_before REAL,
                spot_after REAL,
                spot_change_pct REAL,

                -- Market Price Changes (key data)
                up_bid_before REAL,
                up_ask_before REAL,
                up_bid_after REAL,
                up_ask_after REAL,
                bid_change_cents REAL,
                ask_change_cents REAL,
                cost_to_buy_direction REAL,

                -- Down side prices
                down_bid_before REAL,
                down_ask_before REAL,
                down_bid_after REAL,
                down_ask_after REAL,

                -- Volume at time
                up_bid_size REAL,
                up_ask_size REAL,

                -- Timing
                time_remaining_sec REAL,
                tracking_duration_ms INTEGER,

                -- Trade linkage
                resulted_in_trade BOOLEAN DEFAULT FALSE,
                linked_trade_id TEXT,

                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_lag_events_crypto_epoch
            ON oracle_lag_events(crypto, window_epoch)
        `);
        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_lag_events_direction
            ON oracle_lag_events(direction, lag_magnitude_pct)
        `);

        // Execution Latency - tracks signal-to-execution timing
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS execution_latency (
                id SERIAL PRIMARY KEY,
                signal_id TEXT UNIQUE,
                timestamp_ms BIGINT NOT NULL,

                strategy_name TEXT NOT NULL,
                crypto TEXT NOT NULL,
                window_epoch BIGINT,
                side TEXT,

                -- Timestamps
                signal_generated_ms BIGINT NOT NULL,
                order_sent_ms BIGINT,
                order_filled_ms BIGINT,

                -- Derived latencies
                signal_to_order_ms INTEGER,
                order_to_fill_ms INTEGER,
                total_latency_ms INTEGER,

                -- Market movement during latency
                price_at_signal REAL,
                price_at_order REAL,
                price_at_fill REAL,
                slippage_cents REAL,

                -- Spot movement
                spot_at_signal REAL,
                spot_at_fill REAL,

                -- Execution outcome
                requested_size REAL,
                filled_size REAL,
                fill_rate REAL,
                was_retry BOOLEAN DEFAULT FALSE,
                fill_status TEXT,

                -- Linked lag event
                lag_event_id TEXT,

                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_exec_latency_strategy
            ON execution_latency(strategy_name, crypto)
        `);

        // Resolution Snapshots - final minute capture
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS resolution_snapshots (
                id SERIAL PRIMARY KEY,
                timestamp_ms BIGINT NOT NULL,
                crypto TEXT NOT NULL,
                window_epoch BIGINT NOT NULL,
                seconds_to_resolution INTEGER NOT NULL,

                -- Three price sources
                binance_price REAL NOT NULL,
                chainlink_price REAL,
                chainlink_staleness INTEGER,

                -- Market prices
                up_bid REAL,
                up_ask REAL,
                up_mid REAL,
                down_bid REAL,
                down_ask REAL,

                -- Divergence
                binance_chainlink_divergence REAL,
                binance_chainlink_divergence_pct REAL,

                -- Strike context
                price_to_beat REAL,
                binance_implies TEXT,
                chainlink_implies TEXT,
                market_implies TEXT,

                -- Opportunity flag
                is_divergence_opportunity BOOLEAN DEFAULT FALSE,

                created_at TIMESTAMPTZ DEFAULT NOW(),

                UNIQUE(crypto, window_epoch, seconds_to_resolution)
            )
        `);

        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_resolution_window
            ON resolution_snapshots(crypto, window_epoch)
        `);
        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_resolution_divergence
            ON resolution_snapshots(is_divergence_opportunity)
        `);

        // Resolution Outcomes - post-resolution analysis
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS resolution_outcomes (
                id SERIAL PRIMARY KEY,
                crypto TEXT NOT NULL,
                window_epoch BIGINT NOT NULL,

                -- Final prices
                final_binance REAL,
                final_chainlink REAL,
                final_market_up_mid REAL,
                price_to_beat REAL,

                -- Predictions
                binance_predicted TEXT,
                chainlink_predicted TEXT,
                market_predicted TEXT,

                -- Outcome
                actual_outcome TEXT,

                -- Analysis
                chainlink_was_stale BOOLEAN,
                chainlink_staleness_at_resolution INTEGER,
                had_divergence_opportunity BOOLEAN,
                divergence_magnitude REAL,

                -- Accuracy
                binance_was_correct BOOLEAN,
                chainlink_was_correct BOOLEAN,
                market_was_correct BOOLEAN,

                resolved_at TIMESTAMPTZ DEFAULT NOW(),

                UNIQUE(crypto, window_epoch)
            )
        `);

        await pgPool.query(`
            CREATE INDEX IF NOT EXISTS idx_resolution_outcomes_crypto
            ON resolution_outcomes(crypto)
        `);

        console.log('✅ Oracle/Resolution tables initialized');
        return true;
    } catch (error) {
        console.error('Failed to init Oracle/Resolution tables:', error.message);
        return false;
    }
}

/**
 * Save an oracle lag event
 */
export async function saveLagEvent(event) {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            INSERT INTO oracle_lag_events (
                event_id, timestamp_ms, crypto, window_epoch,
                direction, lag_magnitude, lag_magnitude_pct,
                spot_before, spot_after, spot_change_pct,
                up_bid_before, up_ask_before, up_bid_after, up_ask_after,
                bid_change_cents, ask_change_cents, cost_to_buy_direction,
                down_bid_before, down_ask_before, down_bid_after, down_ask_after,
                up_bid_size, up_ask_size,
                time_remaining_sec, tracking_duration_ms,
                resulted_in_trade, linked_trade_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
            ON CONFLICT (event_id) DO UPDATE SET
                up_bid_after = EXCLUDED.up_bid_after,
                up_ask_after = EXCLUDED.up_ask_after,
                down_bid_after = EXCLUDED.down_bid_after,
                down_ask_after = EXCLUDED.down_ask_after,
                bid_change_cents = EXCLUDED.bid_change_cents,
                ask_change_cents = EXCLUDED.ask_change_cents,
                tracking_duration_ms = EXCLUDED.tracking_duration_ms,
                resulted_in_trade = EXCLUDED.resulted_in_trade,
                linked_trade_id = EXCLUDED.linked_trade_id
        `, [
            event.eventId,
            event.timestampMs,
            event.crypto,
            event.windowEpoch,
            event.direction,
            event.lagMagnitude,
            event.lagMagnitudePct,
            event.spotBefore,
            event.spotAfter,
            event.spotChangePct,
            event.upBidBefore,
            event.upAskBefore,
            event.upBidAfter,
            event.upAskAfter,
            event.bidChangeCents,
            event.askChangeCents,
            event.costToBuyDirection,
            event.downBidBefore,
            event.downAskBefore,
            event.downBidAfter,
            event.downAskAfter,
            event.upBidSize,
            event.upAskSize,
            event.timeRemainingSec,
            event.trackingDurationMs,
            event.resultedInTrade || false,
            event.linkedTradeId || null
        ]);
    } catch (error) {
        console.error('Failed to save lag event:', error.message);
    }
}

/**
 * Get lag events with optional filtering
 */
export async function getLagEvents(options = {}) {
    if (!USE_POSTGRES || !pgPool) return [];

    const { hours = 24, crypto = null, minLag = 0, direction = null } = options;

    try {
        let query = `
            SELECT * FROM oracle_lag_events
            WHERE timestamp_ms > $1
        `;
        const params = [Date.now() - hours * 3600 * 1000];
        let paramIdx = 2;

        if (crypto) {
            query += ` AND crypto = $${paramIdx++}`;
            params.push(crypto);
        }
        if (minLag > 0) {
            query += ` AND ABS(lag_magnitude_pct) >= $${paramIdx++}`;
            params.push(minLag);
        }
        if (direction) {
            query += ` AND direction = $${paramIdx++}`;
            params.push(direction);
        }

        query += ' ORDER BY timestamp_ms DESC LIMIT 500';

        const result = await pgPool.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('Failed to get lag events:', error.message);
        return [];
    }
}

/**
 * Save execution latency measurement
 */
export async function saveLatencyMeasurement(measurement) {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            INSERT INTO execution_latency (
                signal_id, timestamp_ms, strategy_name, crypto, window_epoch, side,
                signal_generated_ms, order_sent_ms, order_filled_ms,
                signal_to_order_ms, order_to_fill_ms, total_latency_ms,
                price_at_signal, price_at_order, price_at_fill, slippage_cents,
                spot_at_signal, spot_at_fill,
                requested_size, filled_size, fill_rate, was_retry, fill_status,
                lag_event_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
            ON CONFLICT (signal_id) DO UPDATE SET
                order_sent_ms = COALESCE(EXCLUDED.order_sent_ms, execution_latency.order_sent_ms),
                order_filled_ms = COALESCE(EXCLUDED.order_filled_ms, execution_latency.order_filled_ms),
                signal_to_order_ms = COALESCE(EXCLUDED.signal_to_order_ms, execution_latency.signal_to_order_ms),
                order_to_fill_ms = COALESCE(EXCLUDED.order_to_fill_ms, execution_latency.order_to_fill_ms),
                total_latency_ms = COALESCE(EXCLUDED.total_latency_ms, execution_latency.total_latency_ms),
                price_at_order = COALESCE(EXCLUDED.price_at_order, execution_latency.price_at_order),
                price_at_fill = COALESCE(EXCLUDED.price_at_fill, execution_latency.price_at_fill),
                slippage_cents = COALESCE(EXCLUDED.slippage_cents, execution_latency.slippage_cents),
                spot_at_fill = COALESCE(EXCLUDED.spot_at_fill, execution_latency.spot_at_fill),
                filled_size = COALESCE(EXCLUDED.filled_size, execution_latency.filled_size),
                fill_rate = COALESCE(EXCLUDED.fill_rate, execution_latency.fill_rate),
                fill_status = COALESCE(EXCLUDED.fill_status, execution_latency.fill_status)
        `, [
            measurement.signalId,
            measurement.timestampMs || Date.now(),
            measurement.strategyName,
            measurement.crypto,
            measurement.windowEpoch,
            measurement.side,
            measurement.signalGeneratedMs,
            measurement.orderSentMs,
            measurement.orderFilledMs,
            measurement.signalToOrderMs,
            measurement.orderToFillMs,
            measurement.totalLatencyMs,
            measurement.priceAtSignal,
            measurement.priceAtOrder,
            measurement.priceAtFill,
            measurement.slippageCents,
            measurement.spotAtSignal,
            measurement.spotAtFill,
            measurement.requestedSize,
            measurement.filledSize,
            measurement.fillRate,
            measurement.wasRetry || false,
            measurement.fillStatus,
            measurement.lagEventId
        ]);
    } catch (error) {
        console.error('Failed to save latency measurement:', error.message);
    }
}

/**
 * Get latency statistics
 */
export async function getLatencyStats(options = {}) {
    if (!USE_POSTGRES || !pgPool) return {};

    const { hours = 24, strategy = null } = options;

    try {
        let whereClause = `timestamp_ms > ${Date.now() - hours * 3600 * 1000}`;
        if (strategy) {
            whereClause += ` AND strategy_name = '${strategy}'`;
        }

        const result = await pgPool.query(`
            SELECT
                strategy_name,
                COUNT(*) as count,
                AVG(total_latency_ms) as avg_latency_ms,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_latency_ms) as p50_latency_ms,
                PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_latency_ms) as p90_latency_ms,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_latency_ms) as p99_latency_ms,
                AVG(slippage_cents) as avg_slippage_cents,
                AVG(fill_rate) as avg_fill_rate,
                SUM(CASE WHEN fill_status = 'filled' THEN 1 ELSE 0 END)::FLOAT / COUNT(*) as success_rate
            FROM execution_latency
            WHERE ${whereClause} AND total_latency_ms IS NOT NULL
            GROUP BY strategy_name
            ORDER BY count DESC
        `);

        return result.rows;
    } catch (error) {
        console.error('Failed to get latency stats:', error.message);
        return [];
    }
}

/**
 * Save resolution snapshot
 */
export async function saveResolutionSnapshot(snapshot) {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            INSERT INTO resolution_snapshots (
                timestamp_ms, crypto, window_epoch, seconds_to_resolution,
                binance_price, chainlink_price, chainlink_staleness,
                up_bid, up_ask, up_mid, down_bid, down_ask,
                binance_chainlink_divergence, binance_chainlink_divergence_pct,
                price_to_beat, binance_implies, chainlink_implies, market_implies,
                is_divergence_opportunity
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (crypto, window_epoch, seconds_to_resolution) DO UPDATE SET
                binance_price = EXCLUDED.binance_price,
                chainlink_price = EXCLUDED.chainlink_price,
                chainlink_staleness = EXCLUDED.chainlink_staleness,
                up_bid = EXCLUDED.up_bid,
                up_ask = EXCLUDED.up_ask,
                up_mid = EXCLUDED.up_mid,
                is_divergence_opportunity = EXCLUDED.is_divergence_opportunity
        `, [
            snapshot.timestampMs,
            snapshot.crypto,
            snapshot.windowEpoch,
            snapshot.secondsToResolution,
            snapshot.binancePrice,
            snapshot.chainlinkPrice,
            snapshot.chainlinkStaleness,
            snapshot.upBid,
            snapshot.upAsk,
            snapshot.upMid,
            snapshot.downBid,
            snapshot.downAsk,
            snapshot.binanceChainlinkDivergence,
            snapshot.binanceChainlinkDivergencePct,
            snapshot.priceToBeat,
            snapshot.binanceImplies,
            snapshot.chainlinkImplies,
            snapshot.marketImplies,
            snapshot.isDivergenceOpportunity || false
        ]);
    } catch (error) {
        // Ignore duplicate key errors (expected on upsert)
        if (!error.message.includes('duplicate key')) {
            console.error('Failed to save resolution snapshot:', error.message);
        }
    }
}

/**
 * Save resolution outcome
 */
export async function saveResolutionOutcome(outcome) {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            INSERT INTO resolution_outcomes (
                crypto, window_epoch,
                final_binance, final_chainlink, final_market_up_mid, price_to_beat,
                binance_predicted, chainlink_predicted, market_predicted,
                actual_outcome,
                chainlink_was_stale, chainlink_staleness_at_resolution,
                had_divergence_opportunity, divergence_magnitude,
                binance_was_correct, chainlink_was_correct, market_was_correct
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (crypto, window_epoch) DO UPDATE SET
                actual_outcome = EXCLUDED.actual_outcome,
                binance_was_correct = EXCLUDED.binance_was_correct,
                chainlink_was_correct = EXCLUDED.chainlink_was_correct,
                market_was_correct = EXCLUDED.market_was_correct
        `, [
            outcome.crypto,
            outcome.windowEpoch,
            outcome.finalBinance,
            outcome.finalChainlink,
            outcome.finalMarketUpMid,
            outcome.priceToBeat,
            outcome.binancePredicted,
            outcome.chainlinkPredicted,
            outcome.marketPredicted,
            outcome.actualOutcome,
            outcome.chainlinkWasStale || false,
            outcome.chainlinkStalenessAtResolution,
            outcome.hadDivergenceOpportunity || false,
            outcome.divergenceMagnitude,
            outcome.binanceWasCorrect,
            outcome.chainlinkWasCorrect,
            outcome.marketWasCorrect
        ]);
    } catch (error) {
        console.error('Failed to save resolution outcome:', error.message);
    }
}

/**
 * Get resolution snapshots for a window
 */
export async function getResolutionSnapshots(crypto, windowEpoch) {
    if (!USE_POSTGRES || !pgPool) return [];

    try {
        const result = await pgPool.query(`
            SELECT * FROM resolution_snapshots
            WHERE crypto = $1 AND window_epoch = $2
            ORDER BY seconds_to_resolution DESC
        `, [crypto, windowEpoch]);
        return result.rows;
    } catch (error) {
        console.error('Failed to get resolution snapshots:', error.message);
        return [];
    }
}

/**
 * Get divergence opportunities
 */
export async function getDivergenceOpportunities(options = {}) {
    if (!USE_POSTGRES || !pgPool) return [];

    const { hours = 24 } = options;

    try {
        const result = await pgPool.query(`
            SELECT
                ro.*,
                (SELECT COUNT(*) FROM resolution_snapshots rs
                 WHERE rs.crypto = ro.crypto AND rs.window_epoch = ro.window_epoch
                 AND rs.is_divergence_opportunity = true) as divergence_ticks
            FROM resolution_outcomes ro
            WHERE ro.resolved_at > NOW() - INTERVAL '${hours} hours'
            AND ro.had_divergence_opportunity = true
            ORDER BY ro.divergence_magnitude DESC
            LIMIT 100
        `);
        return result.rows;
    } catch (error) {
        console.error('Failed to get divergence opportunities:', error.message);
        return [];
    }
}

/**
 * Get resolution accuracy stats
 */
export async function getResolutionAccuracyStats(options = {}) {
    if (!USE_POSTGRES || !pgPool) return {};

    const { hours = 168 } = options; // Default 1 week

    try {
        const result = await pgPool.query(`
            SELECT
                crypto,
                COUNT(*) as total_windows,
                SUM(CASE WHEN binance_was_correct THEN 1 ELSE 0 END) as binance_correct,
                SUM(CASE WHEN chainlink_was_correct THEN 1 ELSE 0 END) as chainlink_correct,
                SUM(CASE WHEN market_was_correct THEN 1 ELSE 0 END) as market_correct,
                SUM(CASE WHEN had_divergence_opportunity THEN 1 ELSE 0 END) as divergence_windows,
                AVG(CASE WHEN had_divergence_opportunity THEN divergence_magnitude ELSE NULL END) as avg_divergence,
                SUM(CASE WHEN chainlink_was_stale THEN 1 ELSE 0 END) as stale_chainlink_windows,
                AVG(chainlink_staleness_at_resolution) as avg_staleness
            FROM resolution_outcomes
            WHERE resolved_at > NOW() - INTERVAL '${hours} hours'
            GROUP BY crypto
            ORDER BY crypto
        `);
        return result.rows;
    } catch (error) {
        console.error('Failed to get resolution accuracy stats:', error.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION PATH TRACKER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize position path tracking table
 */
export async function initPositionPathTable() {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS position_path_summaries (
                id SERIAL PRIMARY KEY,
                position_id TEXT UNIQUE NOT NULL,
                strategy_name TEXT NOT NULL,
                crypto TEXT NOT NULL,
                window_epoch BIGINT NOT NULL,
                side TEXT NOT NULL,

                -- Entry
                entry_price REAL NOT NULL,
                entry_timestamp_ms BIGINT,
                entry_time_remaining_sec REAL,

                -- Path stats
                tick_count INTEGER,
                path_point_count INTEGER,

                -- Peak/trough
                peak_price REAL,
                peak_pnl_pct REAL,
                trough_price REAL,
                max_drawdown_pct REAL,

                -- Milestones
                hit_95 BOOLEAN DEFAULT FALSE,
                hit_99 BOOLEAN DEFAULT FALSE,
                hit_95_time_remaining REAL,
                hit_99_time_remaining REAL,

                -- Optimal exit analysis
                optimal_exit_time_remaining REAL,
                optimal_exit_pnl REAL,

                -- Exit scenarios
                pnl_hold_to_expiry REAL,
                pnl_exit_at_95 REAL,
                pnl_exit_at_99 REAL,
                pnl_exit_at_peak REAL,

                -- Resolution
                outcome TEXT,
                final_pnl_pct REAL,

                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_path_summaries_strategy ON position_path_summaries(strategy_name);
            CREATE INDEX IF NOT EXISTS idx_path_summaries_crypto ON position_path_summaries(crypto);
            CREATE INDEX IF NOT EXISTS idx_path_summaries_created ON position_path_summaries(created_at);
        `);
        console.log('[DB] Position path summaries table ready');
    } catch (error) {
        console.error('Failed to create position path table:', error.message);
    }
}

/**
 * Save position path summary
 */
export async function savePositionPathSummary(summary) {
    if (!USE_POSTGRES || !pgPool) return;

    try {
        await pgPool.query(`
            INSERT INTO position_path_summaries (
                position_id, strategy_name, crypto, window_epoch, side,
                entry_price, entry_timestamp_ms, entry_time_remaining_sec,
                tick_count, path_point_count,
                peak_price, peak_pnl_pct, trough_price, max_drawdown_pct,
                hit_95, hit_99, hit_95_time_remaining, hit_99_time_remaining,
                optimal_exit_time_remaining, optimal_exit_pnl,
                pnl_hold_to_expiry, pnl_exit_at_95, pnl_exit_at_99, pnl_exit_at_peak,
                outcome, final_pnl_pct
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
            ON CONFLICT (position_id) DO UPDATE SET
                peak_price = EXCLUDED.peak_price,
                peak_pnl_pct = EXCLUDED.peak_pnl_pct,
                outcome = EXCLUDED.outcome,
                final_pnl_pct = EXCLUDED.final_pnl_pct
        `, [
            summary.positionId,
            summary.strategyName,
            summary.crypto,
            summary.windowEpoch,
            summary.side,
            summary.entryPrice,
            summary.entryTimestampMs,
            summary.entryTimeRemainingSec,
            summary.tickCount,
            summary.pathPointCount,
            summary.peakPrice,
            summary.peakPnlPct,
            summary.troughPrice,
            summary.maxDrawdownPct,
            summary.hit95 || false,
            summary.hit99 || false,
            summary.hit95TimeRemaining,
            summary.hit99TimeRemaining,
            summary.optimalExitTimeRemaining,
            summary.optimalExitPnl,
            summary.pnlHoldToExpiry,
            summary.pnlExitAt95,
            summary.pnlExitAt99,
            summary.pnlExitAtPeak,
            summary.outcome,
            summary.finalPnlPct
        ]);
    } catch (error) {
        if (!error.message?.includes('duplicate')) {
            console.error('Failed to save position path summary:', error.message);
        }
    }
}

/**
 * Get position path exit analysis
 */
export async function getPositionPathAnalysis(options = {}) {
    if (!USE_POSTGRES || !pgPool) return {};

    const { hours = 24, strategy } = options;

    try {
        let query = `
            SELECT
                strategy_name,
                COUNT(*) as total_positions,
                SUM(CASE WHEN hit_95 THEN 1 ELSE 0 END) as hit_95_count,
                SUM(CASE WHEN hit_99 THEN 1 ELSE 0 END) as hit_99_count,
                AVG(peak_pnl_pct) as avg_peak_pnl,
                AVG(final_pnl_pct) as avg_final_pnl,
                AVG(max_drawdown_pct) as avg_max_drawdown,
                AVG(pnl_hold_to_expiry) as avg_pnl_hold,
                AVG(pnl_exit_at_95) as avg_pnl_95,
                AVG(pnl_exit_at_99) as avg_pnl_99,
                AVG(pnl_exit_at_peak) as avg_pnl_peak,
                AVG(optimal_exit_time_remaining) as avg_optimal_exit_time
            FROM position_path_summaries
            WHERE created_at > NOW() - INTERVAL '${hours} hours'
        `;

        const params = [];
        if (strategy) {
            params.push(strategy);
            query += ` AND strategy_name = $1`;
        }

        query += ` GROUP BY strategy_name ORDER BY total_positions DESC`;

        const result = await pgPool.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('Failed to get position path analysis:', error.message);
        return [];
    }
}

// Log which mode we're using
console.log(`🗄️  Database mode: ${USE_POSTGRES ? 'PostgreSQL' : 'SQLite'}`);

export default {
    initDatabase,
    getDatabase,
    closeDatabase,
    insertTick,
    insertTicksBatch,
    upsertWindow,
    insertTrade,
    getState,
    setState,
    saveResearchStats,
    getResearchStats,
    savePaperTrade,
    getPaperTrades,
    // Live trading
    getLiveEnabledStrategies,
    setLiveStrategyEnabled,
    saveLiveTrade,
    getLiveTrades,
    // OracleOverseer & Resolution
    initOracleResolutionTables,
    saveLagEvent,
    getLagEvents,
    saveLatencyMeasurement,
    getLatencyStats,
    saveResolutionSnapshot,
    saveResolutionOutcome,
    getResolutionSnapshots,
    getDivergenceOpportunities,
    getResolutionAccuracyStats,
    // Position Path Tracker
    initPositionPathTable,
    savePositionPathSummary,
    getPositionPathAnalysis
};
