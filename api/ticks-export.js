/**
 * API: Bulk Tick Data Export
 * 
 * GET /api/ticks-export?crypto=xrp&start=1706000000000&end=1706100000000&format=json
 * GET /api/ticks-export?crypto=xrp&hours=24&format=csv
 * GET /api/ticks-export?window_epoch=1706054400&format=json
 * 
 * Parameters:
 *   - crypto: Filter by crypto (btc, eth, sol, xrp)
 *   - start: Start timestamp in ms (optional)
 *   - end: End timestamp in ms (optional)
 *   - hours: Last N hours of data (alternative to start/end)
 *   - window_epoch: Specific 15-min window epoch
 *   - format: 'json' (default) or 'csv'
 *   - limit: Max rows (default 50000, max 500000)
 * 
 * For external verification of trading claims.
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

/**
 * Convert rows to CSV format
 */
function toCSV(rows) {
    if (rows.length === 0) return '';
    
    const headers = Object.keys(rows[0]);
    const csvRows = [headers.join(',')];
    
    for (const row of rows) {
        const values = headers.map(h => {
            const val = row[h];
            if (val === null || val === undefined) return '';
            if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        });
        csvRows.push(values.join(','));
    }
    
    return csvRows.join('\n');
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
    const { 
        crypto, 
        start, 
        end, 
        hours,
        window_epoch,
        format = 'json',
        limit = 50000 
    } = req.query;
    
    // Validate limit
    const maxLimit = Math.min(parseInt(limit) || 50000, 500000);
    
    try {
        const pool = getPool();
        
        // Build query
        let query = `
            SELECT 
                id,
                timestamp_ms,
                crypto,
                window_epoch,
                time_remaining_sec,
                up_bid,
                up_ask,
                up_bid_size,
                up_ask_size,
                up_mid,
                down_bid,
                down_ask,
                down_bid_size,
                down_ask_size,
                spot_price,
                price_to_beat,
                spot_delta,
                spot_delta_pct,
                spread,
                spread_pct,
                implied_prob_up
            FROM ticks 
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        // Crypto filter
        if (crypto) {
            paramCount++;
            query += ` AND crypto = $${paramCount}`;
            params.push(crypto.toLowerCase());
        }
        
        // Window epoch filter
        if (window_epoch) {
            paramCount++;
            query += ` AND window_epoch = $${paramCount}`;
            params.push(parseInt(window_epoch));
        }
        
        // Time range filters
        if (hours) {
            const hoursMs = parseInt(hours) * 60 * 60 * 1000;
            paramCount++;
            query += ` AND timestamp_ms > $${paramCount}`;
            params.push(Date.now() - hoursMs);
        } else {
            if (start) {
                paramCount++;
                query += ` AND timestamp_ms >= $${paramCount}`;
                params.push(parseInt(start));
            }
            if (end) {
                paramCount++;
                query += ` AND timestamp_ms <= $${paramCount}`;
                params.push(parseInt(end));
            }
        }
        
        // Order and limit
        paramCount++;
        query += ` ORDER BY timestamp_ms ASC LIMIT $${paramCount}`;
        params.push(maxLimit);
        
        const result = await pool.query(query, params);
        
        // Get summary stats
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_ticks,
                COUNT(DISTINCT crypto) as cryptos,
                COUNT(DISTINCT window_epoch) as windows,
                MIN(timestamp_ms) as first_tick,
                MAX(timestamp_ms) as last_tick
            FROM ticks
        `;
        const summaryResult = await pool.query(summaryQuery);
        const summary = summaryResult.rows[0];
        
        // Format response
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=ticks_export_${Date.now()}.csv`);
            return res.status(200).send(toCSV(result.rows));
        }
        
        // JSON response with metadata
        res.status(200).json({
            meta: {
                exported_at: new Date().toISOString(),
                query_params: { crypto, start, end, hours, window_epoch, limit: maxLimit },
                rows_returned: result.rowCount,
                database_summary: {
                    total_ticks: parseInt(summary.total_ticks),
                    cryptos_tracked: parseInt(summary.cryptos),
                    windows_covered: parseInt(summary.windows),
                    data_range: {
                        first: summary.first_tick ? new Date(parseInt(summary.first_tick)).toISOString() : null,
                        last: summary.last_tick ? new Date(parseInt(summary.last_tick)).toISOString() : null
                    }
                }
            },
            ticks: result.rows
        });
        
    } catch (error) {
        console.error('Export API error:', error);
        res.status(500).json({ error: error.message });
    }
}
