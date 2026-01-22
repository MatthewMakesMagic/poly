/**
 * Window Resolution Tracker
 * 
 * Tracks the outcome of each 15-minute window and updates the database
 * with resolution data for backtesting and analysis.
 */

import { getDatabase, upsertWindow } from '../db/connection.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CHAINLINK_API = 'https://data.chain.link/streams';

const CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];

/**
 * Fetch window resolution from Polymarket
 */
async function fetchWindowResolution(crypto, epoch) {
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    try {
        const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
        const markets = await response.json();
        
        if (markets && markets.length > 0) {
            const market = markets[0];
            
            // Check if market is resolved
            if (market.closed) {
                const outcomes = JSON.parse(market.outcomes || '[]');
                const prices = JSON.parse(market.outcomePrices || '[]');
                
                // Determine outcome based on final prices
                // If "Up" price is ~1, up won; if ~0, down won
                const upPrice = parseFloat(prices[0]);
                const outcome = upPrice > 0.9 ? 'up' : (upPrice < 0.1 ? 'down' : null);
                
                return {
                    resolved: true,
                    outcome,
                    resolvedAt: market.updatedAt
                };
            }
        }
    } catch (error) {
        console.error(`Error fetching resolution for ${slug}:`, error.message);
    }
    
    return { resolved: false };
}

/**
 * Calculate window statistics from tick data
 */
function calculateWindowStats(crypto, epoch) {
    const db = getDatabase();
    
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as tick_count,
            MIN(up_mid) as low_up_price,
            MAX(up_mid) as high_up_price,
            AVG(up_mid) as avg_up_price,
            
            -- First and last prices (approximate with MIN/MAX timestamp)
            (SELECT up_mid FROM ticks 
             WHERE crypto = ? AND window_epoch = ? 
             ORDER BY timestamp_ms ASC LIMIT 1) as opening_up_price,
            (SELECT up_mid FROM ticks 
             WHERE crypto = ? AND window_epoch = ? 
             ORDER BY timestamp_ms DESC LIMIT 1) as closing_up_price,
            
            -- Spot price stats
            (SELECT spot_price FROM ticks 
             WHERE crypto = ? AND window_epoch = ? 
             ORDER BY timestamp_ms ASC LIMIT 1) as start_price,
            (SELECT spot_price FROM ticks 
             WHERE crypto = ? AND window_epoch = ? 
             ORDER BY timestamp_ms DESC LIMIT 1) as end_price,
            
            MAX(ABS(spot_delta_pct)) as max_spot_delta_pct
        FROM ticks
        WHERE crypto = ? AND window_epoch = ?
    `).get(crypto, epoch, crypto, epoch, crypto, epoch, crypto, epoch, crypto, epoch);
    
    // Calculate volatility
    const prices = db.prepare(`
        SELECT up_mid, spot_price
        FROM ticks
        WHERE crypto = ? AND window_epoch = ?
        ORDER BY timestamp_ms ASC
    `).all(crypto, epoch);
    
    let upVolatility = 0;
    let spotVolatility = 0;
    
    if (prices.length > 1) {
        // Calculate standard deviation of returns
        const upReturns = [];
        const spotReturns = [];
        
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1].up_mid > 0) {
                upReturns.push((prices[i].up_mid - prices[i - 1].up_mid) / prices[i - 1].up_mid);
            }
            if (prices[i - 1].spot_price > 0) {
                spotReturns.push((prices[i].spot_price - prices[i - 1].spot_price) / prices[i - 1].spot_price);
            }
        }
        
        upVolatility = standardDeviation(upReturns);
        spotVolatility = standardDeviation(spotReturns);
    }
    
    return {
        ...stats,
        up_price_volatility: upVolatility,
        spot_volatility: spotVolatility
    };
}

/**
 * Calculate standard deviation
 */
function standardDeviation(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.sqrt(avgSquaredDiff);
}

/**
 * Update window record with resolution and stats
 */
async function updateWindow(crypto, epoch) {
    // Get resolution status
    const resolution = await fetchWindowResolution(crypto, epoch);
    
    // Calculate stats from tick data
    const stats = calculateWindowStats(crypto, epoch);
    
    // Prepare window record
    const windowData = {
        epoch,
        crypto,
        start_price: stats.start_price,
        end_price: stats.end_price,
        outcome: resolution.outcome || null,
        resolved_at: resolution.resolvedAt || null,
        opening_up_price: stats.opening_up_price,
        closing_up_price: stats.closing_up_price,
        high_up_price: stats.high_up_price,
        low_up_price: stats.low_up_price,
        tick_count: stats.tick_count,
        price_change_count: 0, // Would need to track this during collection
        up_price_volatility: stats.up_price_volatility,
        spot_volatility: stats.spot_volatility,
        max_spot_delta_pct: stats.max_spot_delta_pct
    };
    
    upsertWindow(windowData);
    
    return windowData;
}

/**
 * Process all unresolved windows
 */
async function processUnresolvedWindows() {
    const db = getDatabase();
    
    // Find windows without outcome
    const unresolvedWindows = db.prepare(`
        SELECT DISTINCT crypto, epoch 
        FROM windows 
        WHERE outcome IS NULL
        ORDER BY epoch DESC
        LIMIT 100
    `).all();
    
    console.log(`Processing ${unresolvedWindows.length} unresolved windows...`);
    
    for (const { crypto, epoch } of unresolvedWindows) {
        const result = await updateWindow(crypto, epoch);
        
        if (result.outcome) {
            console.log(`✅ Resolved ${crypto} ${epoch}: ${result.outcome}`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 100));
    }
}

/**
 * Get recent windows with their outcomes
 */
function getRecentWindows(crypto = null, limit = 20) {
    const db = getDatabase();
    
    if (crypto) {
        return db.prepare(`
            SELECT * FROM windows 
            WHERE crypto = ?
            ORDER BY epoch DESC
            LIMIT ?
        `).all(crypto, limit);
    } else {
        return db.prepare(`
            SELECT * FROM windows 
            ORDER BY epoch DESC
            LIMIT ?
        `).all(limit);
    }
}

/**
 * Get outcome statistics
 */
function getOutcomeStats(crypto = null) {
    const db = getDatabase();
    
    const whereClause = crypto ? 'WHERE crypto = ?' : '';
    const params = crypto ? [crypto] : [];
    
    return db.prepare(`
        SELECT 
            crypto,
            COUNT(*) as total,
            SUM(CASE WHEN outcome = 'up' THEN 1 ELSE 0 END) as up_count,
            SUM(CASE WHEN outcome = 'down' THEN 1 ELSE 0 END) as down_count,
            ROUND(100.0 * SUM(CASE WHEN outcome = 'up' THEN 1 ELSE 0 END) / COUNT(*), 2) as up_pct,
            AVG(closing_up_price - opening_up_price) as avg_price_move,
            AVG(high_up_price - low_up_price) as avg_range
        FROM windows
        ${whereClause}
        GROUP BY crypto
    `).all(...params);
}

export {
    fetchWindowResolution,
    calculateWindowStats,
    updateWindow,
    processUnresolvedWindows,
    getRecentWindows,
    getOutcomeStats
};

