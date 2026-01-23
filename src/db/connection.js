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
        max: 10,
        idleTimeoutMillis: 30000
    });
    
    pgPool.on('error', (err) => {
        console.error('PostgreSQL pool error:', err);
    });
    
    console.log('✅ PostgreSQL initialized');
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
        const pool = getDatabase();
        const query = `
            INSERT INTO ticks (
                timestamp_ms, crypto, window_epoch, time_remaining_sec,
                up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                spot_price, price_to_beat, spot_delta, spot_delta_pct,
                spread, spread_pct, implied_prob_up,
                up_book_depth, down_book_depth
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
            )
        `;
        const values = [
            tick.timestamp_ms, tick.crypto, tick.window_epoch, tick.time_remaining_sec,
            tick.up_bid, tick.up_ask, tick.up_bid_size, tick.up_ask_size, tick.up_last_trade, tick.up_mid,
            tick.down_bid, tick.down_ask, tick.down_bid_size, tick.down_ask_size, tick.down_last_trade,
            tick.spot_price, tick.price_to_beat, tick.spot_delta, tick.spot_delta_pct,
            tick.spread, tick.spread_pct, tick.implied_prob_up,
            tick.up_book_depth, tick.down_book_depth
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
                up_book_depth, down_book_depth
            ) VALUES (
                @timestamp_ms, @crypto, @window_epoch, @time_remaining_sec,
                @up_bid, @up_ask, @up_bid_size, @up_ask_size, @up_last_trade, @up_mid,
                @down_bid, @down_ask, @down_bid_size, @down_ask_size, @down_last_trade,
                @spot_price, @price_to_beat, @spot_delta, @spot_delta_pct,
                @spread, @spread_pct, @implied_prob_up,
                @up_book_depth, @down_book_depth
            )
        `);
        return stmt.run(tick);
    }
}

/**
 * Batch insert ticks for better performance
 */
export async function insertTicksBatch(ticks) {
    if (USE_POSTGRES) {
        const pool = getDatabase();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const tick of ticks) {
                await insertTick(tick);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
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
                up_book_depth, down_book_depth
            ) VALUES (
                @timestamp_ms, @crypto, @window_epoch, @time_remaining_sec,
                @up_bid, @up_ask, @up_bid_size, @up_ask_size, @up_last_trade, @up_mid,
                @down_bid, @down_ask, @down_bid_size, @down_ask_size, @down_last_trade,
                @spot_price, @price_to_beat, @spot_delta, @spot_delta_pct,
                @spread, @spread_pct, @implied_prob_up,
                @up_book_depth, @down_book_depth
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
export async function savePaperTrade(trade) {
    if (USE_POSTGRES && pgPool) {
        try {
            await pgPool.query(`
                INSERT INTO paper_trades (
                    strategy_name, crypto, side,
                    entry_time, exit_time, window_epoch, holding_time_ms,
                    entry_price, exit_price, entry_spot_price, exit_spot_price, price_to_beat,
                    entry_market_prob, exit_market_prob, time_remaining_at_entry,
                    pnl, outcome, reason
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            `, [
                trade.strategyName,
                trade.crypto,
                trade.side,
                new Date(trade.entryTime),
                new Date(trade.exitTime),
                trade.windowEpoch,
                trade.holdingTimeMs,
                trade.entryPrice,
                trade.exitPrice,
                trade.entrySpotPrice,
                trade.exitSpotPrice,
                trade.priceToBeat,
                trade.entryMarketProb,
                trade.exitMarketProb,
                trade.timeRemainingAtEntry,
                trade.pnl,
                trade.outcome,
                trade.reason
            ]);
        } catch (error) {
            console.error('Failed to save paper trade:', error.message);
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
        // Get individual trades
        const { rows: trades } = await pgPool.query(`
            SELECT * FROM paper_trades 
            WHERE 1=1 ${timeFilter} ${strategyFilter} ${cryptoFilter}
            ORDER BY exit_time DESC
            LIMIT 500
        `);
        
        // Get aggregated stats by strategy
        const { rows: strategyStats } = await pgPool.query(`
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
        const { rows: overallStats } = await pgPool.query(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl,
                COUNT(DISTINCT strategy_name) as strategies_used,
                COUNT(DISTINCT window_epoch) as windows_traded
            FROM paper_trades
            WHERE 1=1 ${timeFilter} ${strategyFilter} ${cryptoFilter}
        `);
        
        return {
            trades,
            strategyStats,
            overall: overallStats[0] || {}
        };
    } catch (error) {
        console.error('Failed to get paper trades:', error.message);
        return { trades: [], strategyStats: [], overall: {} };
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
    getPaperTrades
};
