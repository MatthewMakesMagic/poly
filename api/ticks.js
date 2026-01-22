/**
 * API: Get recent ticks
 * GET /api/ticks?crypto=BTC&limit=100
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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
    const { crypto, limit = 100, epoch } = req.query;
    
    try {
        const pool = getPool();
        
        let query = `
            SELECT * FROM ticks 
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        if (crypto) {
            paramCount++;
            query += ` AND crypto = $${paramCount}`;
            params.push(crypto.toLowerCase());
        }
        
        if (epoch) {
            paramCount++;
            query += ` AND window_epoch = $${paramCount}`;
            params.push(parseInt(epoch));
        }
        
        paramCount++;
        query += ` ORDER BY timestamp_ms DESC LIMIT $${paramCount}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        
        res.status(200).json({
            ticks: result.rows,
            count: result.rowCount
        });
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
}
