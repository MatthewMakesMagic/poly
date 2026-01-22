/**
 * API: Get window history and outcomes
 * GET /api/windows?crypto=BTC&limit=50
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
    
    const { crypto, limit = 50, outcome } = req.query;
    
    try {
        const pool = getPool();
        
        let query = `
            SELECT * FROM windows 
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        if (crypto) {
            paramCount++;
            query += ` AND crypto = $${paramCount}`;
            params.push(crypto.toLowerCase());
        }
        
        if (outcome) {
            paramCount++;
            query += ` AND outcome = $${paramCount}`;
            params.push(outcome);
        }
        
        paramCount++;
        query += ` ORDER BY epoch DESC LIMIT $${paramCount}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        
        // Calculate stats
        const windows = result.rows;
        const total = windows.length;
        const upCount = windows.filter(w => w.outcome === 'up').length;
        const downCount = windows.filter(w => w.outcome === 'down').length;
        const resolvedCount = upCount + downCount;
        
        res.status(200).json({
            windows,
            stats: {
                total,
                resolved: resolvedCount,
                upCount,
                downCount,
                upRate: resolvedCount > 0 ? upCount / resolvedCount : 0
            }
        });
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
}
