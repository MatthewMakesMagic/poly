/**
 * Common Database Queries
 * Reusable query functions for analysis and trading
 */

import { getDatabase } from './connection.js';

/**
 * Get ticks for a specific window
 */
export function getTicksForWindow(crypto, epoch) {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT * FROM ticks 
        WHERE crypto = ? AND window_epoch = ?
        ORDER BY timestamp_ms ASC
    `);
    return stmt.all(crypto, epoch);
}

/**
 * Get ticks within a time range
 */
export function getTicksInRange(crypto, startMs, endMs) {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT * FROM ticks 
        WHERE crypto = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
        ORDER BY timestamp_ms ASC
    `);
    return stmt.all(crypto, startMs, endMs);
}

/**
 * Get recent ticks (last N minutes)
 */
export function getRecentTicks(crypto, minutes = 15) {
    const db = getDatabase();
    const cutoff = Date.now() - (minutes * 60 * 1000);
    const stmt = db.prepare(`
        SELECT * FROM ticks 
        WHERE crypto = ? AND timestamp_ms >= ?
        ORDER BY timestamp_ms ASC
    `);
    return stmt.all(crypto, cutoff);
}

/**
 * Get all resolved windows
 */
export function getResolvedWindows(crypto = null, limit = 1000) {
    const db = getDatabase();
    
    if (crypto) {
        const stmt = db.prepare(`
            SELECT * FROM windows 
            WHERE crypto = ? AND outcome IS NOT NULL
            ORDER BY epoch DESC
            LIMIT ?
        `);
        return stmt.all(crypto, limit);
    } else {
        const stmt = db.prepare(`
            SELECT * FROM windows 
            WHERE outcome IS NOT NULL
            ORDER BY epoch DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }
}

/**
 * Get window statistics
 */
export function getWindowStats(crypto = null) {
    const db = getDatabase();
    
    const cryptoFilter = crypto ? 'WHERE crypto = ?' : '';
    const params = crypto ? [crypto] : [];
    
    const stmt = db.prepare(`
        SELECT 
            crypto,
            COUNT(*) as total_windows,
            SUM(CASE WHEN outcome = 'up' THEN 1 ELSE 0 END) as up_count,
            SUM(CASE WHEN outcome = 'down' THEN 1 ELSE 0 END) as down_count,
            AVG(closing_up_price - opening_up_price) as avg_price_change,
            AVG(high_up_price - low_up_price) as avg_price_range,
            AVG(up_price_volatility) as avg_volatility
        FROM windows
        ${cryptoFilter}
        GROUP BY crypto
    `);
    
    return crypto ? stmt.get(crypto) : stmt.all();
}

/**
 * Get tick statistics for analysis
 */
export function getTickStats(crypto, windowEpoch = null) {
    const db = getDatabase();
    
    let query = `
        SELECT 
            COUNT(*) as tick_count,
            AVG(spread_pct) as avg_spread_pct,
            MIN(spread_pct) as min_spread_pct,
            MAX(spread_pct) as max_spread_pct,
            AVG(up_mid) as avg_up_price,
            MIN(up_mid) as min_up_price,
            MAX(up_mid) as max_up_price,
            AVG(spot_delta_pct) as avg_spot_delta_pct,
            MIN(spot_delta_pct) as min_spot_delta_pct,
            MAX(spot_delta_pct) as max_spot_delta_pct
        FROM ticks
        WHERE crypto = ?
    `;
    
    const params = [crypto];
    
    if (windowEpoch) {
        query += ' AND window_epoch = ?';
        params.push(windowEpoch);
    }
    
    const stmt = db.prepare(query);
    return stmt.get(...params);
}

/**
 * Get price time series for a window (for charting)
 */
export function getPriceTimeSeries(crypto, epoch) {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT 
            timestamp_ms,
            time_remaining_sec,
            up_mid as up_price,
            (1 - up_mid) as down_price,
            spot_price,
            spot_delta_pct,
            spread_pct
        FROM ticks 
        WHERE crypto = ? AND window_epoch = ?
        ORDER BY timestamp_ms ASC
    `);
    return stmt.all(crypto, epoch);
}

/**
 * Get returns series for statistical analysis
 */
export function getReturnsSeries(crypto, windowEpoch = null, intervalMs = 1000) {
    const db = getDatabase();
    
    // Get ticks at regular intervals
    let query = `
        SELECT 
            (timestamp_ms / ?) * ? as interval_start,
            AVG(up_mid) as avg_price,
            AVG(spot_price) as avg_spot,
            COUNT(*) as tick_count
        FROM ticks
        WHERE crypto = ?
    `;
    
    const params = [intervalMs, intervalMs, crypto];
    
    if (windowEpoch) {
        query += ' AND window_epoch = ?';
        params.push(windowEpoch);
    }
    
    query += `
        GROUP BY interval_start
        ORDER BY interval_start ASC
    `;
    
    const stmt = db.prepare(query);
    const data = stmt.all(...params);
    
    // Calculate returns
    const returns = [];
    for (let i = 1; i < data.length; i++) {
        if (data[i - 1].avg_price > 0) {
            returns.push({
                timestamp: data[i].interval_start,
                price_return: (data[i].avg_price - data[i - 1].avg_price) / data[i - 1].avg_price,
                spot_return: data[i - 1].avg_spot > 0 
                    ? (data[i].avg_spot - data[i - 1].avg_spot) / data[i - 1].avg_spot 
                    : 0
            });
        }
    }
    
    return returns;
}

/**
 * Get trades for a strategy
 */
export function getTradesForStrategy(strategy, mode = 'paper') {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT * FROM trades 
        WHERE strategy = ? AND mode = ?
        ORDER BY timestamp_ms ASC
    `);
    return stmt.all(strategy, mode);
}

/**
 * Get open positions
 */
export function getOpenPositions(mode = 'paper') {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT * FROM positions 
        WHERE mode = ? AND is_open = 1
        ORDER BY entry_timestamp_ms ASC
    `);
    return stmt.all(mode);
}

/**
 * Get latest tick for each crypto
 */
export function getLatestTicks() {
    const db = getDatabase();
    const stmt = db.prepare(`
        SELECT t1.* 
        FROM ticks t1
        INNER JOIN (
            SELECT crypto, MAX(timestamp_ms) as max_ts
            FROM ticks
            GROUP BY crypto
        ) t2 ON t1.crypto = t2.crypto AND t1.timestamp_ms = t2.max_ts
    `);
    return stmt.all();
}

/**
 * Get data count summary
 */
export function getDataSummary() {
    const db = getDatabase();
    
    const tickCount = db.prepare('SELECT COUNT(*) as count FROM ticks').get();
    const windowCount = db.prepare('SELECT COUNT(*) as count FROM windows').get();
    const tradeCount = db.prepare('SELECT COUNT(*) as count FROM trades').get();
    
    const ticksByCrypto = db.prepare(`
        SELECT crypto, COUNT(*) as count, 
               MIN(timestamp_ms) as first_tick,
               MAX(timestamp_ms) as last_tick
        FROM ticks GROUP BY crypto
    `).all();
    
    const windowsByCrypto = db.prepare(`
        SELECT crypto, COUNT(*) as count,
               SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved
        FROM windows GROUP BY crypto
    `).all();
    
    return {
        ticks: tickCount.count,
        windows: windowCount.count,
        trades: tradeCount.count,
        ticksByCrypto,
        windowsByCrypto
    };
}

/**
 * Get hypothesis test results
 */
export function getHypothesisResults(hypothesis = null) {
    const db = getDatabase();
    
    if (hypothesis) {
        const stmt = db.prepare(`
            SELECT * FROM hypothesis_results 
            WHERE hypothesis = ?
            ORDER BY timestamp DESC
            LIMIT 10
        `);
        return stmt.all(hypothesis);
    } else {
        const stmt = db.prepare(`
            SELECT * FROM hypothesis_results 
            ORDER BY timestamp DESC
            LIMIT 50
        `);
        return stmt.all();
    }
}

/**
 * Save hypothesis test result
 */
export function saveHypothesisResult(result) {
    const db = getDatabase();
    const stmt = db.prepare(`
        INSERT INTO hypothesis_results (
            hypothesis, crypto, test_method, sample_size,
            period_start, period_end,
            test_statistic, p_value, is_significant, effect_size,
            confidence_interval_low, confidence_interval_high,
            conclusion, parameters
        ) VALUES (
            @hypothesis, @crypto, @test_method, @sample_size,
            @period_start, @period_end,
            @test_statistic, @p_value, @is_significant, @effect_size,
            @confidence_interval_low, @confidence_interval_high,
            @conclusion, @parameters
        )
    `);
    return stmt.run(result);
}

export default {
    getTicksForWindow,
    getTicksInRange,
    getRecentTicks,
    getResolvedWindows,
    getWindowStats,
    getTickStats,
    getPriceTimeSeries,
    getReturnsSeries,
    getTradesForStrategy,
    getOpenPositions,
    getLatestTicks,
    getDataSummary,
    getHypothesisResults,
    saveHypothesisResult
};

