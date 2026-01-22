/**
 * Notification Service
 * 
 * Sends real-time alerts via:
 * - WhatsApp (via Twilio)
 * - Telegram
 * - Webhook (for custom integrations)
 */

// Configuration - set these in environment variables
const CONFIG = {
    // WhatsApp via Twilio
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
    WHATSAPP_TO: process.env.WHATSAPP_TO, // Your WhatsApp number: whatsapp:+1234567890
    
    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    
    // Webhook (Discord, Slack, custom)
    WEBHOOK_URL: process.env.WEBHOOK_URL,
    
    // Notification preferences
    NOTIFY_ON_TRADE: true,
    NOTIFY_ON_WINDOW_START: false,
    NOTIFY_ON_SIGNIFICANT_MOVE: true,
    SIGNIFICANT_MOVE_THRESHOLD: 0.05, // 5% price move
    
    // Rate limiting
    MIN_INTERVAL_MS: 60000, // Minimum 1 minute between notifications
};

class Notifier {
    constructor() {
        this.lastNotificationTime = 0;
        this.enabled = {
            whatsapp: !!(CONFIG.TWILIO_ACCOUNT_SID && CONFIG.WHATSAPP_TO),
            telegram: !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID),
            webhook: !!CONFIG.WEBHOOK_URL
        };
        
        console.log('📱 Notification channels:');
        console.log(`   WhatsApp: ${this.enabled.whatsapp ? '✅ Enabled' : '❌ Not configured'}`);
        console.log(`   Telegram: ${this.enabled.telegram ? '✅ Enabled' : '❌ Not configured'}`);
        console.log(`   Webhook: ${this.enabled.webhook ? '✅ Enabled' : '❌ Not configured'}`);
    }
    
    /**
     * Send notification to all configured channels
     */
    async notify(message, options = {}) {
        const { 
            priority = 'normal', 
            type = 'info',
            bypassRateLimit = false 
        } = options;
        
        // Rate limiting
        const now = Date.now();
        if (!bypassRateLimit && now - this.lastNotificationTime < CONFIG.MIN_INTERVAL_MS) {
            console.log('⏳ Notification rate limited');
            return;
        }
        this.lastNotificationTime = now;
        
        const timestamp = new Date().toLocaleTimeString();
        const emoji = this.getEmoji(type);
        const fullMessage = `${emoji} [${timestamp}] ${message}`;
        
        const results = await Promise.allSettled([
            this.sendWhatsApp(fullMessage),
            this.sendTelegram(fullMessage),
            this.sendWebhook({ message: fullMessage, type, priority, timestamp })
        ]);
        
        return results;
    }
    
    /**
     * Send WhatsApp message via Twilio
     */
    async sendWhatsApp(message) {
        if (!this.enabled.whatsapp) return null;
        
        try {
            const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: CONFIG.TWILIO_WHATSAPP_FROM,
                    To: CONFIG.WHATSAPP_TO,
                    Body: message
                })
            });
            
            if (!response.ok) {
                throw new Error(`Twilio error: ${response.status}`);
            }
            
            console.log('📱 WhatsApp sent');
            return await response.json();
            
        } catch (error) {
            console.error('❌ WhatsApp error:', error.message);
            return null;
        }
    }
    
    /**
     * Send Telegram message
     */
    async sendTelegram(message) {
        if (!this.enabled.telegram) return null;
        
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CONFIG.TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            
            if (!response.ok) {
                throw new Error(`Telegram error: ${response.status}`);
            }
            
            console.log('📨 Telegram sent');
            return await response.json();
            
        } catch (error) {
            console.error('❌ Telegram error:', error.message);
            return null;
        }
    }
    
    /**
     * Send webhook (Discord, Slack, custom)
     */
    async sendWebhook(payload) {
        if (!this.enabled.webhook) return null;
        
        try {
            const response = await fetch(CONFIG.WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                throw new Error(`Webhook error: ${response.status}`);
            }
            
            console.log('🔔 Webhook sent');
            return true;
            
        } catch (error) {
            console.error('❌ Webhook error:', error.message);
            return null;
        }
    }
    
    /**
     * Get emoji for message type
     */
    getEmoji(type) {
        const emojis = {
            trade_open: '📈',
            trade_close: '📉',
            profit: '💰',
            loss: '🔴',
            alert: '⚠️',
            prediction: '🔮',
            window_start: '🕐',
            window_end: '🏁',
            info: 'ℹ️',
            error: '❌'
        };
        return emojis[type] || 'ℹ️';
    }
    
    // Convenience methods
    
    async notifyTradeOpen(trade) {
        if (!CONFIG.NOTIFY_ON_TRADE) return;
        
        const message = `TRADE OPENED
${trade.side.toUpperCase()} @ ${trade.price.toFixed(4)}
Size: $${trade.size.toFixed(2)}
Strategy: ${trade.strategy}`;
        
        await this.notify(message, { type: 'trade_open', priority: 'high' });
    }
    
    async notifyTradeClose(trade) {
        if (!CONFIG.NOTIFY_ON_TRADE) return;
        
        const pnlEmoji = trade.pnl >= 0 ? '✅' : '❌';
        const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
        
        const message = `TRADE CLOSED ${pnlEmoji}
${trade.side.toUpperCase()} @ ${trade.exitPrice.toFixed(4)}
P&L: ${pnlStr} (${(trade.pnlPct * 100).toFixed(2)}%)
Reason: ${trade.reason}`;
        
        await this.notify(message, { 
            type: trade.pnl >= 0 ? 'profit' : 'loss', 
            priority: 'high' 
        });
    }
    
    async notifyWindowStart(window) {
        if (!CONFIG.NOTIFY_ON_WINDOW_START) return;
        
        const message = `NEW WINDOW STARTED
${window.crypto.toUpperCase()} 15m
Epoch: ${window.epoch}
Up: ${window.upPrice?.toFixed(2) || '0.50'} / Down: ${window.downPrice?.toFixed(2) || '0.50'}`;
        
        await this.notify(message, { type: 'window_start' });
    }
    
    async notifySignificantMove(data) {
        if (!CONFIG.NOTIFY_ON_SIGNIFICANT_MOVE) return;
        if (Math.abs(data.priceChange) < CONFIG.SIGNIFICANT_MOVE_THRESHOLD) return;
        
        const direction = data.priceChange > 0 ? '📈 UP' : '📉 DOWN';
        
        const message = `SIGNIFICANT MOVE ${direction}
${data.crypto.toUpperCase()}: ${(data.priceChange * 100).toFixed(1)}%
Up Price: ${data.upPrice.toFixed(4)}
BTC: $${data.spotPrice.toLocaleString()}`;
        
        await this.notify(message, { type: 'alert', priority: 'high', bypassRateLimit: true });
    }
    
    async notifyPrediction(prediction) {
        const confidence = (prediction.confidence * 100).toFixed(0);
        const message = `PREDICTION 🔮
${prediction.crypto.toUpperCase()} Window
Predicted: ${prediction.outcome.toUpperCase()} (${confidence}% confidence)
Current: Up ${prediction.upPrice.toFixed(2)} / Down ${prediction.downPrice.toFixed(2)}
Time Left: ${Math.floor(prediction.timeRemaining / 60)}m ${prediction.timeRemaining % 60}s`;
        
        await this.notify(message, { type: 'prediction' });
    }
    
    async notifyDailySummary(summary) {
        const pnlStr = summary.totalPnl >= 0 
            ? `+$${summary.totalPnl.toFixed(2)}` 
            : `-$${Math.abs(summary.totalPnl).toFixed(2)}`;
        
        const message = `DAILY SUMMARY 📊
Trades: ${summary.totalTrades}
Win Rate: ${(summary.winRate * 100).toFixed(1)}%
P&L: ${pnlStr}
Best: +$${summary.bestTrade.toFixed(2)}
Worst: -$${Math.abs(summary.worstTrade).toFixed(2)}`;
        
        await this.notify(message, { type: 'info', bypassRateLimit: true });
    }
}

// Singleton instance
let notifier = null;

export function getNotifier() {
    if (!notifier) {
        notifier = new Notifier();
    }
    return notifier;
}

export { Notifier, CONFIG as NotificationConfig };
export default Notifier;

