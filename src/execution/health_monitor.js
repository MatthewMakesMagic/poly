/**
 * Health Monitor & Alerting System
 * 
 * Monitors the execution engine and sends alerts on:
 * - System health issues (WebSocket disconnects, heartbeat failures)
 * - Risk events (kill switch, circuit breaker)
 * - Performance anomalies (unusual losses, high slippage)
 * - Order issues (rejections, failures)
 * 
 * Supports multiple alerting channels:
 * - Console logging (always on)
 * - Discord webhooks
 * - File logging
 */

import fs from 'fs';
import path from 'path';

/**
 * Alert severity levels
 */
export const AlertLevel = {
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    CRITICAL: 'CRITICAL'
};

/**
 * Alert types
 */
export const AlertType = {
    // System health
    ENGINE_STARTED: 'ENGINE_STARTED',
    ENGINE_STOPPED: 'ENGINE_STOPPED',
    ENGINE_ERROR: 'ENGINE_ERROR',
    WS_DISCONNECTED: 'WS_DISCONNECTED',
    WS_RECONNECTED: 'WS_RECONNECTED',
    HEARTBEAT_TIMEOUT: 'HEARTBEAT_TIMEOUT',
    
    // Risk events
    KILL_SWITCH: 'KILL_SWITCH',
    CIRCUIT_BREAKER: 'CIRCUIT_BREAKER',
    DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
    CONSECUTIVE_LOSSES: 'CONSECUTIVE_LOSSES',
    
    // Trading events
    ORDER_FILLED: 'ORDER_FILLED',
    ORDER_REJECTED: 'ORDER_REJECTED',
    ORDER_FAILED: 'ORDER_FAILED',
    HIGH_SLIPPAGE: 'HIGH_SLIPPAGE',
    POSITION_OPENED: 'POSITION_OPENED',
    POSITION_CLOSED: 'POSITION_CLOSED',
    
    // Performance
    PROFIT_MILESTONE: 'PROFIT_MILESTONE',
    LOSS_ALERT: 'LOSS_ALERT',
    WIN_STREAK: 'WIN_STREAK',
    HOURLY_SUMMARY: 'HOURLY_SUMMARY',
    DAILY_SUMMARY: 'DAILY_SUMMARY'
};

/**
 * Main Health Monitor class
 */
export class HealthMonitor {
    constructor(options = {}) {
        this.options = {
            logFile: './logs/health.log',
            discordWebhook: process.env.DISCORD_WEBHOOK_URL,
            enableDiscord: !!process.env.DISCORD_WEBHOOK_URL,
            enableFileLogging: true,
            alertCooldowns: {
                [AlertType.WS_DISCONNECTED]: 60000,    // 1 min cooldown
                [AlertType.HEARTBEAT_TIMEOUT]: 120000,  // 2 min cooldown
                [AlertType.HIGH_SLIPPAGE]: 30000       // 30s cooldown
            },
            slippageAlertThreshold: 3,  // Alert on > 3% slippage
            ...options
        };
        
        this.logger = options.logger || console;
        
        // Track last alert times for cooldowns
        this.lastAlertTimes = new Map();
        
        // Stats tracking
        this.alertCounts = new Map();
        this.sessionStartTime = Date.now();
        
        // Ensure log directory exists
        if (this.options.enableFileLogging) {
            const logDir = path.dirname(this.options.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }
    }
    
    /**
     * Send an alert
     */
    async alert(type, level, message, data = {}) {
        // Check cooldown
        if (this.isOnCooldown(type)) {
            return;
        }
        
        const alert = {
            timestamp: new Date().toISOString(),
            type,
            level,
            message,
            data
        };
        
        // Update tracking
        this.lastAlertTimes.set(type, Date.now());
        this.alertCounts.set(type, (this.alertCounts.get(type) || 0) + 1);
        
        // Console logging (always)
        this.logToConsole(alert);
        
        // File logging
        if (this.options.enableFileLogging) {
            this.logToFile(alert);
        }
        
        // Discord (for WARNING and above)
        if (this.options.enableDiscord && 
            [AlertLevel.WARNING, AlertLevel.ERROR, AlertLevel.CRITICAL].includes(level)) {
            await this.sendDiscord(alert);
        }
    }
    
    /**
     * Check if alert type is on cooldown
     */
    isOnCooldown(type) {
        const cooldown = this.options.alertCooldowns[type];
        if (!cooldown) return false;
        
        const lastTime = this.lastAlertTimes.get(type);
        if (!lastTime) return false;
        
        return Date.now() - lastTime < cooldown;
    }
    
    /**
     * Log to console with formatting
     */
    logToConsole(alert) {
        const emoji = this.getEmoji(alert.level);
        const levelStr = alert.level.padEnd(8);
        
        this.logger.log(`${emoji} [${alert.timestamp}] [${levelStr}] ${alert.type}: ${alert.message}`);
        
        if (Object.keys(alert.data).length > 0) {
            this.logger.log(`   Data:`, JSON.stringify(alert.data, null, 2));
        }
    }
    
    /**
     * Log to file
     */
    logToFile(alert) {
        try {
            const line = JSON.stringify(alert) + '\n';
            fs.appendFileSync(this.options.logFile, line);
        } catch (error) {
            this.logger.error('Failed to write to log file:', error);
        }
    }
    
    /**
     * Send Discord webhook
     */
    async sendDiscord(alert) {
        if (!this.options.discordWebhook) return;
        
        const color = this.getDiscordColor(alert.level);
        const emoji = this.getEmoji(alert.level);
        
        const embed = {
            title: `${emoji} ${alert.type}`,
            description: alert.message,
            color,
            timestamp: alert.timestamp,
            fields: Object.entries(alert.data).map(([key, value]) => ({
                name: key,
                value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
                inline: true
            })).slice(0, 10)  // Discord limit
        };
        
        try {
            await fetch(this.options.discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'Poly Trading Bot',
                    embeds: [embed]
                })
            });
        } catch (error) {
            this.logger.error('Failed to send Discord alert:', error);
        }
    }
    
    /**
     * Get emoji for level
     */
    getEmoji(level) {
        switch (level) {
            case AlertLevel.INFO: return 'ℹ️';
            case AlertLevel.WARNING: return '⚠️';
            case AlertLevel.ERROR: return '🔴';
            case AlertLevel.CRITICAL: return '🚨';
            default: return '📌';
        }
    }
    
    /**
     * Get Discord embed color
     */
    getDiscordColor(level) {
        switch (level) {
            case AlertLevel.INFO: return 0x3498db;      // Blue
            case AlertLevel.WARNING: return 0xf39c12;   // Orange
            case AlertLevel.ERROR: return 0xe74c3c;     // Red
            case AlertLevel.CRITICAL: return 0x9b59b6;  // Purple
            default: return 0x95a5a6;                   // Gray
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONVENIENCE METHODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Engine started
     */
    async engineStarted(data = {}) {
        await this.alert(
            AlertType.ENGINE_STARTED,
            AlertLevel.INFO,
            'Execution engine started',
            data
        );
    }
    
    /**
     * Engine stopped
     */
    async engineStopped(reason) {
        await this.alert(
            AlertType.ENGINE_STOPPED,
            AlertLevel.WARNING,
            `Execution engine stopped: ${reason}`,
            { reason }
        );
    }
    
    /**
     * Engine error
     */
    async engineError(error) {
        await this.alert(
            AlertType.ENGINE_ERROR,
            AlertLevel.ERROR,
            `Engine error: ${error.message}`,
            { error: error.message, stack: error.stack }
        );
    }
    
    /**
     * WebSocket disconnected
     */
    async wsDisconnected(feed) {
        await this.alert(
            AlertType.WS_DISCONNECTED,
            AlertLevel.WARNING,
            `WebSocket disconnected: ${feed}`,
            { feed }
        );
    }
    
    /**
     * WebSocket reconnected
     */
    async wsReconnected(feed) {
        await this.alert(
            AlertType.WS_RECONNECTED,
            AlertLevel.INFO,
            `WebSocket reconnected: ${feed}`,
            { feed }
        );
    }
    
    /**
     * Kill switch activated
     */
    async killSwitch(reason) {
        await this.alert(
            AlertType.KILL_SWITCH,
            AlertLevel.CRITICAL,
            `KILL SWITCH ACTIVATED: ${reason}`,
            { reason }
        );
    }
    
    /**
     * Circuit breaker tripped
     */
    async circuitBreaker(lossAmount) {
        await this.alert(
            AlertType.CIRCUIT_BREAKER,
            AlertLevel.ERROR,
            `Circuit breaker tripped. Loss: $${lossAmount.toFixed(2)}`,
            { lossAmount }
        );
    }
    
    /**
     * Order filled
     */
    async orderFilled(order) {
        await this.alert(
            AlertType.ORDER_FILLED,
            AlertLevel.INFO,
            `Order filled: ${order.side} ${order.tokenSide} $${order.filledSize.toFixed(2)} @ ${order.filledPrice.toFixed(4)}`,
            {
                orderId: order.id,
                side: order.side,
                tokenSide: order.tokenSide,
                size: order.filledSize,
                price: order.filledPrice,
                slippage: order.slippage
            }
        );
        
        // Check slippage
        if (Math.abs(order.slippage) > this.options.slippageAlertThreshold / 100) {
            await this.highSlippage(order);
        }
    }
    
    /**
     * Order rejected
     */
    async orderRejected(order, reason) {
        await this.alert(
            AlertType.ORDER_REJECTED,
            AlertLevel.WARNING,
            `Order rejected: ${reason}`,
            {
                orderId: order.id,
                side: order.side,
                size: order.size,
                price: order.price,
                reason
            }
        );
    }
    
    /**
     * High slippage
     */
    async highSlippage(order) {
        await this.alert(
            AlertType.HIGH_SLIPPAGE,
            AlertLevel.WARNING,
            `High slippage detected: ${(order.slippage * 100).toFixed(2)}%`,
            {
                orderId: order.id,
                expectedPrice: order.expectedPrice,
                filledPrice: order.filledPrice,
                slippagePct: (order.slippage * 100).toFixed(2)
            }
        );
    }
    
    /**
     * Position closed
     */
    async positionClosed(position, pnl) {
        const level = pnl >= 0 ? AlertLevel.INFO : AlertLevel.WARNING;
        await this.alert(
            AlertType.POSITION_CLOSED,
            level,
            `Position closed: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`,
            {
                crypto: position.crypto,
                side: position.tokenSide,
                size: position.size,
                entryPrice: position.entryPrice,
                pnl
            }
        );
    }
    
    /**
     * Hourly summary
     */
    async hourlySummary(stats) {
        await this.alert(
            AlertType.HOURLY_SUMMARY,
            AlertLevel.INFO,
            `Hourly Summary: ${stats.trades} trades, Net P&L: $${stats.netPnL.toFixed(2)}`,
            stats
        );
    }
    
    /**
     * Daily summary
     */
    async dailySummary(stats) {
        const level = stats.netPnL >= 0 ? AlertLevel.INFO : AlertLevel.WARNING;
        await this.alert(
            AlertType.DAILY_SUMMARY,
            level,
            `Daily Summary: ${stats.trades} trades, Net P&L: $${stats.netPnL.toFixed(2)}`,
            stats
        );
    }
    
    /**
     * Get alert statistics
     */
    getStats() {
        return {
            sessionStartTime: this.sessionStartTime,
            uptimeMinutes: Math.floor((Date.now() - this.sessionStartTime) / 60000),
            alertCounts: Object.fromEntries(this.alertCounts)
        };
    }
}

/**
 * Attach monitor to execution engine
 */
export function attachMonitor(engine, options = {}) {
    const monitor = new HealthMonitor(options);
    
    // Engine lifecycle
    engine.on('started', () => monitor.engineStarted());
    engine.on('stopped', (data) => monitor.engineStopped(data.reason));
    engine.on('error', (error) => monitor.engineError(error));
    
    // WebSocket events
    engine.on('health_warning', (data) => {
        if (data.type === 'ws_disconnected') {
            monitor.wsDisconnected(data.feed);
        } else if (data.type === 'heartbeat_timeout') {
            monitor.alert(AlertType.HEARTBEAT_TIMEOUT, AlertLevel.ERROR, 'No market data received');
        }
    });
    
    // Risk events
    engine.on('kill_switch', (data) => monitor.killSwitch(data.reason));
    engine.on('circuit_breaker', (data) => monitor.circuitBreaker(data.lossAmount));
    
    // Order events
    engine.orderManager.on('order:fill', (order) => {
        if (order.isComplete()) {
            monitor.orderFilled(order);
        }
    });
    
    engine.orderManager.on('order:rejected', (order) => {
        monitor.orderRejected(order, order.error);
    });
    
    // Setup hourly summary
    setInterval(() => {
        const stats = engine.sessionStats;
        monitor.hourlySummary(stats);
    }, 60 * 60 * 1000);
    
    return monitor;
}

export default HealthMonitor;
