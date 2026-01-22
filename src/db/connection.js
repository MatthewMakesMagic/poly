/**
 * Database Connection Manager
 * Handles SQLite database operations with connection pooling
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;

/**
 * Initialize the database connection
 */
export function initDatabase(dbPath = null) {
    if (db) return db;
    
    const defaultPath = join(__dirname, '../../data/polymarket.db');
    const path = dbPath || defaultPath;
    
    console.log(`📂 Initializing database at: ${path}`);
    
    db = new Database(path);
    
    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    
    // Initialize schema
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
    
    console.log('✅ Database initialized');
    
    return db;
}

/**
 * Get database instance
 */
export function getDatabase() {
    if (!db) {
        return initDatabase();
    }
    return db;
}

/**
 * Close database connection
 */
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        console.log('🔴 Database closed');
    }
}

/**
 * Insert a tick record
 */
export function insertTick(tick) {
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

/**
 * Batch insert ticks for better performance
 */
export function insertTicksBatch(ticks) {
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

/**
 * Insert or update a window record
 */
export function upsertWindow(window) {
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

/**
 * Insert a trade record
 */
export function insertTrade(trade) {
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

/**
 * Get system state value
 */
export function getState(key) {
    const db = getDatabase();
    const stmt = db.prepare('SELECT value FROM system_state WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : null;
}

/**
 * Set system state value
 */
export function setState(key, value) {
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

export default {
    initDatabase,
    getDatabase,
    closeDatabase,
    insertTick,
    insertTicksBatch,
    upsertWindow,
    insertTrade,
    getState,
    setState
};

