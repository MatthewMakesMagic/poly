/**
 * Research API Endpoint
 * 
 * Returns quant research data:
 * - Spot lag analysis
 * - Market efficiency metrics
 * - Strategy performance
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    
    try {
        const { type } = req.query;
        
        if (type === 'efficiency') {
            // Calculate market efficiency from recent ticks
            const result = await pool.query(`
                SELECT 
                    crypto,
                    COUNT(*) as tick_count,
                    AVG(up_mid) as avg_up_mid,
                    STDDEV(up_mid) as stddev_up_mid,
                    AVG(ABS(spot_delta_pct)) as avg_abs_spot_delta,
                    AVG(spread_pct) as avg_spread_pct
                FROM ticks 
                WHERE timestamp_ms > $1
                GROUP BY crypto
            `, [Date.now() - 3600000]); // Last hour
            
            return res.json({
                type: 'efficiency',
                timestamp: Date.now(),
                data: result.rows
            });
        }
        
        if (type === 'volatility') {
            // Calculate realized volatility
            const result = await pool.query(`
                WITH price_changes AS (
                    SELECT 
                        crypto,
                        up_mid,
                        LAG(up_mid) OVER (PARTITION BY crypto ORDER BY timestamp_ms) as prev_up_mid,
                        spot_price,
                        LAG(spot_price) OVER (PARTITION BY crypto ORDER BY timestamp_ms) as prev_spot
                    FROM ticks 
                    WHERE timestamp_ms > $1
                )
                SELECT 
                    crypto,
                    COUNT(*) as samples,
                    STDDEV(CASE WHEN prev_up_mid > 0 THEN (up_mid - prev_up_mid) / prev_up_mid END) as price_vol,
                    STDDEV(CASE WHEN prev_spot > 0 THEN (spot_price - prev_spot) / prev_spot END) as spot_vol
                FROM price_changes
                WHERE prev_up_mid IS NOT NULL
                GROUP BY crypto
            `, [Date.now() - 1800000]); // Last 30 min
            
            return res.json({
                type: 'volatility',
                timestamp: Date.now(),
                data: result.rows
            });
        }
        
        if (type === 'spotlag') {
            // Analyze spot price changes and market response
            const result = await pool.query(`
                WITH spot_changes AS (
                    SELECT 
                        crypto,
                        timestamp_ms,
                        spot_price,
                        LAG(spot_price) OVER (PARTITION BY crypto ORDER BY timestamp_ms) as prev_spot,
                        up_mid,
                        LAG(up_mid) OVER (PARTITION BY crypto ORDER BY timestamp_ms) as prev_up_mid
                    FROM ticks 
                    WHERE timestamp_ms > $1
                ),
                significant_moves AS (
                    SELECT *,
                        (spot_price - prev_spot) / prev_spot as spot_change,
                        (up_mid - prev_up_mid) as market_change
                    FROM spot_changes
                    WHERE prev_spot > 0 
                    AND ABS((spot_price - prev_spot) / prev_spot) > 0.0005
                )
                SELECT 
                    crypto,
                    COUNT(*) as move_count,
                    AVG(spot_change) as avg_spot_change,
                    AVG(market_change) as avg_market_response,
                    AVG(ABS(spot_change)) as avg_abs_spot_change,
                    AVG(ABS(market_change)) as avg_abs_market_response
                FROM significant_moves
                GROUP BY crypto
            `, [Date.now() - 3600000]);
            
            return res.json({
                type: 'spotlag',
                timestamp: Date.now(),
                data: result.rows
            });
        }
        
        // Default: return summary
        const tickCount = await pool.query('SELECT COUNT(*) as count FROM ticks WHERE timestamp_ms > $1', [Date.now() - 3600000]);
        const windowCount = await pool.query('SELECT COUNT(*) as count FROM windows');
        
        const latestTicks = await pool.query(`
            SELECT DISTINCT ON (crypto) crypto, up_mid, spot_price, spread_pct, time_remaining_sec
            FROM ticks 
            ORDER BY crypto, timestamp_ms DESC
        `);
        
        return res.json({
            type: 'summary',
            timestamp: Date.now(),
            ticksLastHour: parseInt(tickCount.rows[0].count),
            totalWindows: parseInt(windowCount.rows[0].count),
            latestByProto: latestTicks.rows,
            availableReports: ['efficiency', 'volatility', 'spotlag']
        });
        
    } catch (error) {
        console.error('Research API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
