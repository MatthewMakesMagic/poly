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
import { getDatabase, getPaperTrades } from '../db/connection.js';

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

export function setStrategyRunner(runner) {
    strategyRunnerRef = runner;
}

export function setExecutionTracker(tracker) {
    executionTrackerRef = tracker;
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
    sendWindowEvent
};
