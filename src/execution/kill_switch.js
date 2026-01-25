/**
 * Kill Switch Module
 * 
 * Emergency stop system for the execution engine.
 * Can be activated via:
 * - File (touch KILL_SWITCH)
 * - API endpoint
 * - Programmatic call
 * 
 * For web app integration, use the HTTP API.
 */

import fs from 'fs';
import http from 'http';
import EventEmitter from 'events';

/**
 * Kill Switch API Reference
 * 
 * Base URL: http://localhost:{port}
 * Default port: 3099
 * 
 * Endpoints:
 * 
 * GET /kill-switch
 *   Response: { active: boolean, reason: string|null, activatedAt: string|null, fileExists: boolean }
 * 
 * POST /kill-switch
 *   Body: { reason: "string" }  (optional)
 *   Response: { success: true, active: true, activatedAt: "ISO string" }
 * 
 * DELETE /kill-switch
 *   Response: { success: true, active: false }
 * 
 * GET /status
 *   Response: Full engine status including kill switch state
 * 
 * Example usage in web app:
 * 
 * // Check status
 * fetch('http://localhost:3099/kill-switch')
 *   .then(r => r.json())
 *   .then(data => console.log('Kill switch active:', data.active));
 * 
 * // Activate (emergency stop)
 * fetch('http://localhost:3099/kill-switch', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ reason: 'Manual stop from dashboard' })
 * });
 * 
 * // Deactivate (resume trading)
 * fetch('http://localhost:3099/kill-switch', { method: 'DELETE' });
 */

export class KillSwitch extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.filePath = options.filePath || './KILL_SWITCH';
        this.port = options.port || 3099;
        this.checkInterval = options.checkInterval || 1000;
        
        this.active = false;
        this.reason = null;
        this.activatedAt = null;
        
        this.server = null;
        this.checkTimer = null;
        this.statusCallback = null;  // Optional callback for full status
        
        this.logger = options.logger || console;
    }
    
    /**
     * Start the kill switch monitor
     */
    start(statusCallback = null) {
        this.statusCallback = statusCallback;
        
        // Check initial state
        this._checkFile();
        
        // Start file monitor
        this.checkTimer = setInterval(() => this._checkFile(), this.checkInterval);
        
        // Start HTTP server
        this._startServer();
        
        this.logger.log(`[KillSwitch] Started - File: ${this.filePath}, Port: ${this.port}`);
        
        return this;
    }
    
    /**
     * Stop the kill switch monitor
     */
    stop() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        
        this.logger.log('[KillSwitch] Stopped');
    }
    
    /**
     * Check if kill switch is active
     */
    isActive() {
        this._checkFile();
        return this.active;
    }
    
    /**
     * Activate the kill switch
     */
    activate(reason = 'Manual activation') {
        if (this.active) return;
        
        this.active = true;
        this.reason = reason;
        this.activatedAt = new Date().toISOString();
        
        // Create file
        fs.writeFileSync(this.filePath, JSON.stringify({
            activated: this.activatedAt,
            reason: this.reason
        }, null, 2));
        
        this.logger.log(`[KillSwitch] 🛑 ACTIVATED: ${reason}`);
        this.emit('activated', { reason, activatedAt: this.activatedAt });
    }
    
    /**
     * Deactivate the kill switch
     */
    deactivate() {
        if (!this.active) return;
        
        this.active = false;
        this.reason = null;
        this.activatedAt = null;
        
        // Remove file
        if (fs.existsSync(this.filePath)) {
            fs.unlinkSync(this.filePath);
        }
        
        this.logger.log('[KillSwitch] ✅ DEACTIVATED');
        this.emit('deactivated');
    }
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            active: this.active,
            reason: this.reason,
            activatedAt: this.activatedAt,
            fileExists: fs.existsSync(this.filePath)
        };
    }
    
    /**
     * Check file for kill switch
     */
    _checkFile() {
        const fileExists = fs.existsSync(this.filePath);
        
        if (fileExists && !this.active) {
            // File appeared - activate
            let reason = 'KILL_SWITCH file detected';
            try {
                const content = fs.readFileSync(this.filePath, 'utf8');
                const data = JSON.parse(content);
                reason = data.reason || reason;
                this.activatedAt = data.activated || new Date().toISOString();
            } catch {
                this.activatedAt = new Date().toISOString();
            }
            
            this.active = true;
            this.reason = reason;
            
            this.logger.log(`[KillSwitch] 🛑 ACTIVATED (file): ${reason}`);
            this.emit('activated', { reason, activatedAt: this.activatedAt });
        } else if (!fileExists && this.active && !this.reason?.includes('API')) {
            // File removed and wasn't API triggered - deactivate
            this.active = false;
            this.reason = null;
            this.activatedAt = null;
            
            this.logger.log('[KillSwitch] ✅ DEACTIVATED (file removed)');
            this.emit('deactivated');
        }
    }
    
    /**
     * Start HTTP server
     */
    _startServer() {
        this.server = http.createServer((req, res) => {
            // CORS headers
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }
            
            const url = req.url?.split('?')[0];
            
            // GET /kill-switch
            if (req.method === 'GET' && url === '/kill-switch') {
                res.writeHead(200);
                res.end(JSON.stringify(this.getStatus()));
                return;
            }
            
            // POST /kill-switch
            if (req.method === 'POST' && url === '/kill-switch') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = body ? JSON.parse(body) : {};
                        this.activate(data.reason || 'API triggered');
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            success: true,
                            ...this.getStatus()
                        }));
                    } catch (e) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            
            // DELETE /kill-switch
            if (req.method === 'DELETE' && url === '/kill-switch') {
                this.deactivate();
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    ...this.getStatus()
                }));
                return;
            }
            
            // GET /status
            if (req.method === 'GET' && url === '/status') {
                const status = {
                    killSwitch: this.getStatus(),
                    timestamp: new Date().toISOString()
                };
                
                // Add full status if callback provided
                if (this.statusCallback) {
                    try {
                        Object.assign(status, this.statusCallback());
                    } catch (e) {
                        status.statusError = e.message;
                    }
                }
                
                res.writeHead(200);
                res.end(JSON.stringify(status));
                return;
            }
            
            // GET /health
            if (req.method === 'GET' && url === '/health') {
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'ok', killSwitch: this.active }));
                return;
            }
            
            // 404
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        });
        
        this.server.listen(this.port, () => {
            this.logger.log(`[KillSwitch] HTTP API on port ${this.port}`);
        });
        
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                this.logger.warn(`[KillSwitch] Port ${this.port} in use, trying ${this.port + 1}`);
                this.port++;
                this.server.listen(this.port);
            }
        });
    }
}

/**
 * Quick check function for use in trading loops
 */
export function isKillSwitchActive(filePath = './KILL_SWITCH') {
    return fs.existsSync(filePath);
}

/**
 * Activate kill switch (create file)
 */
export function activateKillSwitch(reason = 'Manual', filePath = './KILL_SWITCH') {
    fs.writeFileSync(filePath, JSON.stringify({
        activated: new Date().toISOString(),
        reason
    }, null, 2));
}

/**
 * Deactivate kill switch (remove file)
 */
export function deactivateKillSwitch(filePath = './KILL_SWITCH') {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

export default KillSwitch;
