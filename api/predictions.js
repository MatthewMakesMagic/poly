/**
 * API: Get prediction accuracy and calibration data
 * GET /api/predictions?model=ensemble_v1&crypto=BTC
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
    
    const { model, crypto, limit = 1000 } = req.query;
    
    try {
        const pool = getPool();
        
        // Get accuracy by model
        let accuracyQuery = `
            SELECT 
                model_name,
                crypto,
                COUNT(*) as total_predictions,
                SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) as correct_predictions,
                AVG(CASE WHEN was_correct IS NOT NULL THEN was_correct ELSE NULL END) as accuracy,
                AVG(confidence) as avg_confidence,
                COUNT(DISTINCT window_epoch) as windows_covered
            FROM predictions 
            WHERE actual_outcome IS NOT NULL
        `;
        const accuracyParams = [];
        let paramCount = 0;
        
        if (model) {
            paramCount++;
            accuracyQuery += ` AND model_name = $${paramCount}`;
            accuracyParams.push(model);
        }
        
        if (crypto) {
            paramCount++;
            accuracyQuery += ` AND crypto = $${paramCount}`;
            accuracyParams.push(crypto.toLowerCase());
        }
        
        accuracyQuery += ` GROUP BY model_name, crypto ORDER BY accuracy DESC`;
        
        const accuracyResult = await pool.query(accuracyQuery, accuracyParams);
        
        // Get calibration data (for reliability diagrams)
        let calibrationQuery = `
            SELECT 
                calibration_bucket,
                COUNT(*) as count,
                AVG(CASE WHEN was_correct = 1 THEN 1.0 ELSE 0.0 END) as actual_accuracy,
                AVG(predicted_prob_up) as avg_predicted_prob
            FROM predictions 
            WHERE actual_outcome IS NOT NULL
        `;
        
        if (model) {
            calibrationQuery += ` AND model_name = $1`;
        }
        
        calibrationQuery += ` GROUP BY calibration_bucket ORDER BY calibration_bucket`;
        
        const calibrationResult = model 
            ? await pool.query(calibrationQuery, [model])
            : await pool.query(calibrationQuery.replace(' AND model_name = $1', ''));
        
        // Get recent predictions
        let recentQuery = `
            SELECT * FROM predictions 
            WHERE 1=1
        `;
        const recentParams = [];
        paramCount = 0;
        
        if (model) {
            paramCount++;
            recentQuery += ` AND model_name = $${paramCount}`;
            recentParams.push(model);
        }
        
        if (crypto) {
            paramCount++;
            recentQuery += ` AND crypto = $${paramCount}`;
            recentParams.push(crypto.toLowerCase());
        }
        
        paramCount++;
        recentQuery += ` ORDER BY timestamp_ms DESC LIMIT $${paramCount}`;
        recentParams.push(parseInt(limit));
        
        const recentResult = await pool.query(recentQuery, recentParams);
        
        res.status(200).json({
            accuracy: accuracyResult.rows,
            calibration: calibrationResult.rows,
            recentPredictions: recentResult.rows
        });
        
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
}
