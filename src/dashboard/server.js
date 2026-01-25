/**
 * Dashboard Server
 * 
 * Provides:
 * - Static file serving for the dashboard
 * - WebSocket connection for real-time updates
 * - REST API for historical data
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, getPaperTrades, getLiveEnabledStrategies, setLiveStrategyEnabled, getLiveTrades } from '../db/connection.js';
import { getLiveTrader } from '../execution/live_trader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.DASHBOARD_PORT || 3333;

// MIME types
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Connected WebSocket clients
const clients = new Set();

// Create HTTP server
const server = http.createServer((req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // API routes
    if (req.url.startsWith('/api/')) {
        return handleAPI(req, res);
    }
    
    // Static file serving
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);
    
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // Serve index.html for SPA routing
                fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, content) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Server Error');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content);
                });
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

// Create WebSocket server
const wss = new WebSocketServer({ 
    server,
    path: '/ws'
});

wss.on('connection', (ws) => {
    console.log('📱 Dashboard client connected');
    clients.add(ws);
    
    // Send initial state
    sendInitialState(ws);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleClientMessage(ws, message);
        } catch (e) {
            console.error('Invalid message from client:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('📱 Dashboard client disconnected');
        clients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        clients.delete(ws);
    });
});

// Handle client messages
function handleClientMessage(ws, message) {
    switch (message.type) {
        case 'subscribe':
            // Could track subscriptions per client
            break;
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
    }
}

// Send initial state to new client
async function sendInitialState(ws) {
    try {
        const db = getDatabase();
        if (!db) return;
        
        // Get today's metrics
        const today = new Date().toISOString().split('T')[0];
        const metrics = db.prepare(`
            SELECT 
                COUNT(*) as totalTrades,
                SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl_usd) as totalPnl
            FROM trades
            WHERE date(exit_time) = ?
        `).get(today);
        
        const winRate = metrics.totalTrades > 0 ? metrics.wins / metrics.totalTrades : 0;
        
        ws.send(JSON.stringify({
            type: 'metrics',
            payload: {
                totalTrades: metrics.totalTrades || 0,
                totalPnl: metrics.totalPnl || 0,
                winRate: winRate
            }
        }));
        
    } catch (e) {
        // Database might not be initialized yet
    }
}

// Strategy runner reference (set from main)
let strategyRunnerRef = null;
let executionTrackerRef = null;

// Live trading engine reference
let liveEngineRef = null;

export function setStrategyRunner(runner) {
    strategyRunnerRef = runner;
}

export function setExecutionTracker(tracker) {
    executionTrackerRef = tracker;
}

// Set live engine reference (called from run_live_trading.mjs)
export function setLiveEngine(engine) {
    liveEngineRef = engine;
    console.log('[Dashboard] Live engine connected');
}

// Broadcast live trading status
export function broadcastLiveStatus(status) {
    broadcast({
        type: 'live_status',
        payload: {
            ...status,
            timestamp: Date.now()
        }
    });
}

// Broadcast live trade event
export function broadcastLiveTrade(tradeEvent) {
    broadcast({
        type: 'live_trade',
        payload: {
            ...tradeEvent,
            timestamp: Date.now()
        }
    });
}

// Handle API requests
async function handleAPI(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    
    try {
        switch (path) {
            case '/api/metrics':
                return apiMetrics(req, res);
            case '/api/trades':
                return apiTrades(req, res);
            case '/api/predictions':
                return apiPredictions(req, res);
            case '/api/strategies':
                return apiStrategies(req, res);
            case '/api/executions':
                return apiExecutions(req, res);
            case '/api/windows':
                return apiWindows(req, res);
            case '/api/paper-trades':
                return apiPaperTrades(req, res);
            case '/api/ticks-export':
                return apiTicksExport(req, res);
            case '/api/research-export':
                return apiResearchExport(req, res);
            
            // Live trading endpoints
            case '/api/live/status':
                return apiLiveStatus(req, res);
            case '/api/live/kill':
                return apiLiveKill(req, res);
            case '/api/live/pause':
                return apiLivePause(req, res);
            case '/api/live/resume':
                return apiLiveResume(req, res);
            case '/api/live/positions':
                return apiLivePositions(req, res);
            case '/api/live/strategies':
                return apiLiveStrategies(req, res);
            case '/api/live/strategies/toggle':
                return apiLiveStrategyToggle(req, res);
            case '/api/live/trades':
                return apiLiveTrades(req, res);
            
            default:
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

async function apiMetrics(req, res) {
    const db = getDatabase();
    
    const metrics = db ? db.prepare(`
        SELECT 
            COUNT(*) as totalTrades,
            SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
            SUM(pnl_usd) as totalPnl,
            MAX(pnl_usd) as bestTrade,
            MIN(pnl_usd) as worstTrade
        FROM trades
    `).get() : { totalTrades: 0, wins: 0, totalPnl: 0 };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
}

async function apiTrades(req, res) {
    const db = getDatabase();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    
    const trades = db ? db.prepare(`
        SELECT * FROM trades 
        ORDER BY entry_time DESC 
        LIMIT ?
    `).all(limit) : [];
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trades));
}

async function apiPredictions(req, res) {
    // Return current predictions from memory
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentPredictions));
}

// Strategy comparison endpoint
async function apiStrategies(req, res) {
    if (!strategyRunnerRef) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Strategy runner not initialized' }));
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const period = url.searchParams.get('period') || 'all';
    
    const comparison = strategyRunnerRef.getStrategyComparison(period);
    const windowAnalysis = strategyRunnerRef.getWindowAnalysis(10);
    const summary = strategyRunnerRef.getSummary();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        comparison,
        windowAnalysis,
        summary,
        timestamp: Date.now()
    }));
}

// Trade executions endpoint
async function apiExecutions(req, res) {
    if (!executionTrackerRef) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Execution tracker not initialized' }));
        return;
    }
    
    const data = executionTrackerRef.exportTrades();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...data,
        timestamp: Date.now()
    }));
}

// Window history endpoint
async function apiWindows(req, res) {
    if (!strategyRunnerRef) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ windows: [] }));
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const count = parseInt(url.searchParams.get('count') || '20');
    
    const windowAnalysis = strategyRunnerRef.getWindowAnalysis(count);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        windows: windowAnalysis,
        timestamp: Date.now()
    }));
}

// Paper trades endpoint with time filtering
async function apiPaperTrades(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const period = url.searchParams.get('period') || 'all';
    const strategy = url.searchParams.get('strategy') || null;
    const crypto = url.searchParams.get('crypto') || null;
    
    try {
        const data = await getPaperTrades({ period, strategy, crypto: crypto || null });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Tick data bulk export endpoint
// GET /api/ticks-export?crypto=xrp&hours=24&format=json
// GET /api/ticks-export?window_epoch=1706054400&format=csv
async function apiTicksExport(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const crypto = url.searchParams.get('crypto');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    const hours = url.searchParams.get('hours');
    const windowEpoch = url.searchParams.get('window_epoch');
    const format = url.searchParams.get('format') || 'json';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50000'), 500000);
    
    try {
        const db = getDatabase();
        if (!db || !db.query) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database not available' }));
            return;
        }
        
        // Build query
        let query = `
            SELECT 
                id, timestamp_ms, crypto, window_epoch, time_remaining_sec,
                up_bid, up_ask, up_bid_size, up_ask_size, up_mid,
                down_bid, down_ask, down_bid_size, down_ask_size,
                spot_price, price_to_beat, spot_delta, spot_delta_pct,
                spread, spread_pct, implied_prob_up
            FROM ticks WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        if (crypto) {
            paramCount++;
            query += ` AND crypto = $${paramCount}`;
            params.push(crypto.toLowerCase());
        }
        
        if (windowEpoch) {
            paramCount++;
            query += ` AND window_epoch = $${paramCount}`;
            params.push(parseInt(windowEpoch));
        }
        
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
        
        paramCount++;
        query += ` ORDER BY timestamp_ms ASC LIMIT $${paramCount}`;
        params.push(limit);
        
        const result = await db.query(query, params);
        
        // Get summary
        const summaryResult = await db.query(`
            SELECT COUNT(*) as total, 
                   COUNT(DISTINCT crypto) as cryptos,
                   COUNT(DISTINCT window_epoch) as windows,
                   MIN(timestamp_ms) as first_tick,
                   MAX(timestamp_ms) as last_tick
            FROM ticks
        `);
        const summary = summaryResult.rows[0];
        
        if (format === 'csv') {
            const rows = result.rows;
            if (rows.length === 0) {
                res.writeHead(200, { 'Content-Type': 'text/csv' });
                res.end('');
                return;
            }
            const headers = Object.keys(rows[0]);
            const csvRows = [headers.join(',')];
            for (const row of rows) {
                csvRows.push(headers.map(h => {
                    const v = row[h];
                    if (v === null || v === undefined) return '';
                    if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
                    return v;
                }).join(','));
            }
            res.writeHead(200, { 
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename=ticks_export_${Date.now()}.csv`
            });
            res.end(csvRows.join('\n'));
            return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            meta: {
                exported_at: new Date().toISOString(),
                query_params: { crypto, start, end, hours, window_epoch: windowEpoch, limit },
                rows_returned: result.rowCount,
                database_summary: {
                    total_ticks: parseInt(summary.total),
                    cryptos_tracked: parseInt(summary.cryptos),
                    windows_covered: parseInt(summary.windows),
                    first_tick: summary.first_tick ? new Date(parseInt(summary.first_tick)).toISOString() : null,
                    last_tick: summary.last_tick ? new Date(parseInt(summary.last_tick)).toISOString() : null
                }
            },
            ticks: result.rows
        }));
        
    } catch (error) {
        console.error('Tick export error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Research data export - comprehensive data for external analysis
// GET /api/research-export
async function apiResearchExport(req, res) {
    try {
        const db = getDatabase();
        if (!db || !db.query) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database not available' }));
            return;
        }
        
        // 1. Trade statistics by strategy and crypto
        const tradeStats = await db.query(`
            SELECT 
                strategy_name,
                crypto,
                side,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                AVG(entry_price) as avg_entry_price,
                AVG(holding_time_ms) as avg_holding_time_ms
            FROM paper_trades
            WHERE pnl IS NOT NULL
            GROUP BY strategy_name, crypto, side
            ORDER BY strategy_name, crypto, side
        `);
        
        // 2. Window outcomes by crypto
        const windowStats = await db.query(`
            SELECT 
                crypto,
                outcome,
                COUNT(*) as count
            FROM windows
            WHERE outcome IS NOT NULL
            GROUP BY crypto, outcome
            ORDER BY crypto, outcome
        `);
        
        // 3. Overall summary
        const summary = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM ticks) as total_ticks,
                (SELECT COUNT(DISTINCT window_epoch) FROM ticks) as total_windows,
                (SELECT COUNT(*) FROM paper_trades) as total_trades,
                (SELECT SUM(pnl) FROM paper_trades) as total_pnl,
                (SELECT MIN(timestamp_ms) FROM ticks) as first_tick,
                (SELECT MAX(timestamp_ms) FROM ticks) as last_tick
        `);
        
        // 4. Sample size assessment
        const sampleSizes = await db.query(`
            SELECT 
                crypto,
                side,
                COUNT(*) as n,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
            FROM paper_trades
            WHERE pnl IS NOT NULL
            GROUP BY crypto, side
        `);
        
        // Calculate confidence intervals
        const withCI = sampleSizes.rows.map(row => {
            const n = parseInt(row.n);
            const wins = parseInt(row.wins);
            const p = n > 0 ? wins / n : 0;
            const z = 1.96;
            
            // Wilson score interval
            const denom = 1 + z * z / n;
            const center = (p + z * z / (2 * n)) / denom;
            const margin = (z / denom) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
            
            return {
                ...row,
                win_rate: p,
                ci_lower: Math.max(0, center - margin),
                ci_upper: Math.min(1, center + margin),
                sufficient_for_edge: n >= 100,
                sufficient_for_anomaly: n >= 200
            };
        });
        
        const s = summary.rows[0];
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            exported_at: new Date().toISOString(),
            summary: {
                total_ticks: parseInt(s.total_ticks),
                total_windows: parseInt(s.total_windows),
                total_trades: parseInt(s.total_trades),
                total_pnl: parseFloat(s.total_pnl) || 0,
                data_range: {
                    first: s.first_tick ? new Date(parseInt(s.first_tick)).toISOString() : null,
                    last: s.last_tick ? new Date(parseInt(s.last_tick)).toISOString() : null
                }
            },
            trade_statistics: tradeStats.rows,
            window_outcomes: windowStats.rows,
            sample_sizes_with_confidence: withCI,
            api_endpoints: {
                ticks_export: '/api/ticks-export?crypto=xrp&hours=24&format=json',
                paper_trades: '/api/paper-trades?period=all',
                windows: '/api/windows?limit=100'
            }
        }));
        
    } catch (error) {
        console.error('Research export error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TRADING API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// Get live trading status
async function apiLiveStatus(req, res) {
    if (!liveEngineRef) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            connected: false, 
            message: 'Live engine not running' 
        }));
        return;
    }
    
    const status = liveEngineRef.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        connected: true,
        ...status,
        timestamp: Date.now()
    }));
}

// Kill switch - STOP ALL TRADING IMMEDIATELY
async function apiLiveKill(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    if (!liveEngineRef) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Live engine not running' }));
        return;
    }
    
    // Parse reason from body
    let reason = 'Manual kill via dashboard';
    if (req.headers['content-type']?.includes('application/json')) {
        try {
            const body = await getRequestBody(req);
            const data = JSON.parse(body);
            reason = data.reason || reason;
        } catch (e) {
            // Use default reason
        }
    }
    
    console.log('🛑 KILL SWITCH ACTIVATED via dashboard:', reason);
    
    try {
        await liveEngineRef.stop(reason);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: true, 
            message: 'Trading stopped',
            reason 
        }));
        
        // Broadcast to all clients
        broadcastLiveStatus({ 
            state: 'STOPPED', 
            killSwitch: true, 
            killReason: reason 
        });
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Pause trading (keep data feeds running)
async function apiLivePause(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    if (!liveEngineRef) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Live engine not running' }));
        return;
    }
    
    liveEngineRef.pause('Manual pause via dashboard');
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        success: true, 
        message: 'Trading paused' 
    }));
}

// Resume trading
async function apiLiveResume(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    if (!liveEngineRef) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Live engine not running' }));
        return;
    }
    
    const resumed = liveEngineRef.resume();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        success: resumed, 
        message: resumed ? 'Trading resumed' : 'Could not resume (check risk manager)' 
    }));
}

// Get current positions
async function apiLivePositions(req, res) {
    const liveTrader = getLiveTrader();
    const status = liveTrader.getStatus();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        positions: status.livePositions || [],
        timestamp: Date.now()
    }));
}

// Get all strategies with their live trading status
async function apiLiveStrategies(req, res) {
    try {
        const liveTrader = getLiveTrader();
        const enabledStrategies = await getLiveEnabledStrategies();
        const liveTraderStatus = liveTrader.getStatus();
        
        // Get all known strategies from paper trades
        const db = getDatabase();
        let allStrategies = [];
        
        if (db) {
            try {
                const result = await db.query(`
                    SELECT 
                        strategy_name,
                        COUNT(*) as total_trades,
                        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                        SUM(pnl) as total_pnl,
                        ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate
                    FROM paper_trades
                    WHERE exit_time > NOW() - INTERVAL '7 days'
                    GROUP BY strategy_name
                    ORDER BY total_pnl DESC
                `);
                allStrategies = result.rows;
            } catch (e) {
                console.error('Failed to get strategies:', e.message);
            }
        }
        
        // Mark which ones are enabled for live
        const strategies = allStrategies.map(s => ({
            ...s,
            live_enabled: enabledStrategies.includes(s.strategy_name),
            total_trades: parseInt(s.total_trades) || 0,
            wins: parseInt(s.wins) || 0,
            total_pnl: parseFloat(s.total_pnl) || 0,
            win_rate: parseFloat(s.win_rate) || 0
        }));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            strategies,
            liveEnabled: liveTraderStatus.enabled,
            killSwitchActive: liveTraderStatus.killSwitchActive,
            positionSize: liveTraderStatus.positionSize,
            stats: liveTraderStatus.stats,
            timestamp: Date.now()
        }));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Toggle a strategy's live trading status
async function apiLiveStrategyToggle(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    try {
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        const { strategy, enabled } = data;
        
        if (!strategy) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Strategy name required' }));
            return;
        }
        
        const liveTrader = getLiveTrader();
        
        if (enabled) {
            await liveTrader.enableStrategy(strategy);
        } else {
            await liveTrader.disableStrategy(strategy);
        }
        
        // Broadcast update to all clients
        broadcastLiveStatus(liveTrader.getStatus());
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            strategy,
            enabled,
            message: enabled ? `${strategy} enabled for live trading` : `${strategy} disabled for live trading`
        }));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Get live trades history
async function apiLiveTrades(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const hours = parseInt(url.searchParams.get('hours') || '24');
        const strategy = url.searchParams.get('strategy');
        
        const result = await getLiveTrades({ hours, strategy });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Helper to get request body
function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// ═══════════════════════════════════════════════════════════════════════════

// Broadcast to all connected clients
let broadcastCount = 0;
export function broadcast(message) {
    const data = JSON.stringify(message);
    let sent = 0;
    for (const client of clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(data);
            sent++;
        }
    }
    // Log first few broadcasts
    if (broadcastCount < 3 && message.type === 'tick') {
        console.log(`   📤 Broadcast tick to ${sent} clients`);
        broadcastCount++;
    }
}

// Store current predictions for API
let currentPredictions = {};

// Update prediction (called from collector)
export function updatePrediction(prediction) {
    currentPredictions[prediction.crypto] = prediction;
    broadcast({
        type: 'prediction',
        payload: prediction
    });
}

// Send tick update
export function sendTick(tick) {
    broadcast({
        type: 'tick',
        payload: tick
    });
}

// Send trade notification
export function sendTrade(trade) {
    broadcast({
        type: 'trade',
        payload: trade
    });
}

// Send metrics update
export function sendMetrics(metrics) {
    broadcast({
        type: 'metrics',
        payload: metrics
    });
}

// Send strategy comparison update
export function sendStrategyComparison(comparison) {
    broadcast({
        type: 'strategy_comparison',
        payload: comparison
    });
}

// Send trade execution update (entry/exit)
export function sendTradeExecution(execution) {
    broadcast({
        type: 'trade_execution',
        payload: {
            ...execution,
            timestamp: Date.now()
        }
    });
}

// Send window event (start/end)
export function sendWindowEvent(event) {
    broadcast({
        type: 'window_event',
        payload: event
    });
}

// Start server
export function startDashboard(port = PORT) {
    return new Promise((resolve) => {
        server.listen(port, () => {
            console.log(`\n🖥️  Dashboard running at http://localhost:${port}`);
            console.log(`   WebSocket at ws://localhost:${port}/ws\n`);
            resolve(server);
        });
    });
}

// Export for external use
export { server, wss, clients };
export default { 
    startDashboard, 
    broadcast, 
    updatePrediction, 
    sendTick, 
    sendTrade, 
    sendMetrics,
    sendStrategyComparison,
    sendTradeExecution,
    sendWindowEvent,
    // Live trading exports
    setLiveEngine,
    broadcastLiveStatus,
    broadcastLiveTrade
};
