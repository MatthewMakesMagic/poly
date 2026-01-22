/**
 * API: Get overall platform statistics
 * GET /api/stats
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 5
        });
    }
    return pool;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
    try {
        const pool = getPool();
        
        // Get tick stats
        const tickStats = await pool.query(`
            SELECT 
                COUNT(*) as total_ticks,
                COUNT(DISTINCT crypto) as cryptos_tracked,
                COUNT(DISTINCT window_epoch) as windows_covered,
                MIN(timestamp_ms) as first_tick,
                MAX(timestamp_ms) as last_tick
            FROM ticks
        `);
        
        // Get window stats
        const windowStats = await pool.query(`
            SELECT 
                COUNT(*) as total_windows,
                SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved_windows,
                SUM(CASE WHEN outcome = 'up' THEN 1 ELSE 0 END) as up_outcomes,
                SUM(CASE WHEN outcome = 'down' THEN 1 ELSE 0 END) as down_outcomes
            FROM windows
        `);
        
        // Get trade stats
        const tradeStats = await pool.query(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(realized_pnl) as total_pnl,
                AVG(realized_pnl) as avg_trade_pnl
            FROM trades
            WHERE realized_pnl IS NOT NULL
        `);
        
        // Get prediction stats
        const predictionStats = await pool.query(`
            SELECT 
                COUNT(*) as total_predictions,
                SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) as correct_predictions,
                AVG(CASE WHEN was_correct IS NOT NULL THEN was_correct ELSE NULL END) as accuracy
            FROM predictions
            WHERE actual_outcome IS NOT NULL
        `);
        
        // Get annotation stats
        const annotationStats = await pool.query(`
            SELECT 
                COUNT(*) as total_annotations,
                COUNT(DISTINCT annotation_type) as annotation_types
            FROM trader_annotations
        `);
        
        // Calculate data quality
        const ticks = tickStats.rows[0];
        const dataQuality = {
            ticksPerWindow: ticks.windows_covered > 0 
                ? Math.round(ticks.total_ticks / ticks.windows_covered) 
                : 0,
            dataSpanHours: ticks.first_tick && ticks.last_tick
                ? Math.round((ticks.last_tick - ticks.first_tick) / (1000 * 60 * 60))
                : 0
        };
        
        res.status(200).json({
            ticks: tickStats.rows[0],
            windows: windowStats.rows[0],
            trades: tradeStats.rows[0],
            predictions: predictionStats.rows[0],
            annotations: annotationStats.rows[0],
            dataQuality
        });
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
}
