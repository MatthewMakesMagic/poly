/**
 * API: Get trade history
 * GET /api/trades?mode=paper&strategy=MeanReversion&limit=100
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
    
    const { mode, strategy, crypto, limit = 100 } = req.query;
    
    try {
        const pool = getPool();
        
        let query = `
            SELECT * FROM trades 
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        if (mode) {
            paramCount++;
            query += ` AND mode = $${paramCount}`;
            params.push(mode);
        }
        
        if (strategy) {
            paramCount++;
            query += ` AND strategy = $${paramCount}`;
            params.push(strategy);
        }
        
        if (crypto) {
            paramCount++;
            query += ` AND crypto = $${paramCount}`;
            params.push(crypto.toLowerCase());
        }
        
        paramCount++;
        query += ` ORDER BY timestamp_ms DESC LIMIT $${paramCount}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        
        // Calculate P&L stats
        const trades = result.rows;
        const withPnl = trades.filter(t => t.realized_pnl !== null);
        
        const totalPnl = withPnl.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
        const wins = withPnl.filter(t => t.realized_pnl > 0).length;
        const losses = withPnl.filter(t => t.realized_pnl < 0).length;
        
        res.status(200).json({
            trades,
            stats: {
                total: trades.length,
                closedTrades: withPnl.length,
                wins,
                losses,
                winRate: withPnl.length > 0 ? wins / withPnl.length : 0,
                totalPnl,
                avgTrade: withPnl.length > 0 ? totalPnl / withPnl.length : 0
            }
        });
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
}
