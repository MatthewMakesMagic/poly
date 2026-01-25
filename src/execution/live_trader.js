/**
 * Live Trader Module
 * 
 * Executes REAL trades for strategies that are enabled via the dashboard.
 * Paper trading continues independently for ALL strategies.
 * 
 * Key features:
 * - Strategies are toggled ON/OFF via dashboard
 * - Only executes trades for enabled strategies
 * - Uses $1 position sizes (configurable)
 * - Global kill switch stops all live trading
 * - Tracks live P&L separately from paper P&L
 */

import EventEmitter from 'events';
import { PolymarketClient, Side, OrderType, createClientFromEnv } from './polymarket_client.js';
import { RiskManager } from './risk_manager.js';
import { saveLiveTrade, getLiveEnabledStrategies, setLiveStrategyEnabled } from '../db/connection.js';

// Configuration
const CONFIG = {
    POSITION_SIZE: parseFloat(process.env.LIVE_POSITION_SIZE || '1'),
    ENABLED: process.env.LIVE_TRADING_ENABLED === 'true',
};

/**
 * Live Trader - executes real trades for enabled strategies
 */
export class LiveTrader extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            positionSize: CONFIG.POSITION_SIZE,
            enabled: CONFIG.ENABLED,
            ...options
        };
        
        this.logger = options.logger || console;
        
        // Core components
        this.client = null;
        this.riskManager = new RiskManager({
            logger: this.logger,
            maxPositionPerTrade: this.options.positionSize,
            maxTotalExposure: 20,
            maxLossPerDay: 20,
        });
        
        // State
        this.isRunning = false;
        this.killSwitchActive = false;
        
        // Enabled strategies (controlled via dashboard)
        this.enabledStrategies = new Set();
        
        // Live positions: strategyName -> crypto -> position
        this.livePositions = {};
        
        // Stats
        this.stats = {
            tradesExecuted: 0,
            ordersPlaced: 0,
            ordersFilled: 0,
            ordersRejected: 0,
            grossPnL: 0,
            fees: 0,
            netPnL: 0
        };
        
        // Wire up risk manager events
        this.riskManager.on('kill_switch', (data) => {
            this.logger.error('[LiveTrader] KILL SWITCH TRIGGERED');
            this.killSwitchActive = true;
            this.emit('kill_switch', data);
        });
    }
    
    /**
     * Initialize the live trader
     */
    async initialize() {
        if (!this.options.enabled) {
            this.logger.log('[LiveTrader] Live trading is DISABLED (set LIVE_TRADING_ENABLED=true to enable)');
            return false;
        }
        
        try {
            // Initialize Polymarket client
            this.client = createClientFromEnv();
            
            // Verify API connection by fetching open orders (simpler than /auth/api-key which doesn't exist)
            try {
                const orders = await this.client.getOpenOrders();
                this.logger.log(`[LiveTrader] API verified - ${orders?.length || 0} open orders found`);
            } catch (verifyError) {
                this.logger.warn(`[LiveTrader] API verification skipped: ${verifyError.message}`);
                // Continue anyway - we'll find out if auth fails when placing orders
            }
            
            // Load enabled strategies from database
            await this.loadEnabledStrategies();
            
            this.isRunning = true;
            this.logger.log('[LiveTrader] Initialized successfully');
            this.logger.log(`[LiveTrader] Position size: $${this.options.positionSize}`);
            this.logger.log(`[LiveTrader] Enabled strategies: ${this.enabledStrategies.size > 0 ? Array.from(this.enabledStrategies).join(', ') : 'NONE'}`);
            
            return true;
        } catch (error) {
            this.logger.error('[LiveTrader] Failed to initialize:', error.message);
            this.isRunning = false;
            return false;
        }
    }
    
    /**
     * Load enabled strategies from database
     */
    async loadEnabledStrategies() {
        try {
            const strategies = await getLiveEnabledStrategies();
            this.enabledStrategies = new Set(strategies);
            this.logger.log(`[LiveTrader] Loaded ${this.enabledStrategies.size} enabled strategies from database`);
        } catch (error) {
            this.logger.warn('[LiveTrader] Could not load enabled strategies:', error.message);
            this.enabledStrategies = new Set();
        }
    }
    
    /**
     * Enable a strategy for live trading
     */
    async enableStrategy(strategyName) {
        this.enabledStrategies.add(strategyName);
        try {
            await setLiveStrategyEnabled(strategyName, true);
            this.logger.log(`[LiveTrader] ✅ Enabled live trading for: ${strategyName}`);
            this.emit('strategy_enabled', { strategy: strategyName });
            return true;
        } catch (error) {
            this.logger.error(`[LiveTrader] Failed to enable ${strategyName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Disable a strategy from live trading
     */
    async disableStrategy(strategyName) {
        this.enabledStrategies.delete(strategyName);
        try {
            await setLiveStrategyEnabled(strategyName, false);
            this.logger.log(`[LiveTrader] ❌ Disabled live trading for: ${strategyName}`);
            this.emit('strategy_disabled', { strategy: strategyName });
            return true;
        } catch (error) {
            this.logger.error(`[LiveTrader] Failed to disable ${strategyName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Check if a strategy is enabled for live trading
     */
    isStrategyEnabled(strategyName) {
        return this.enabledStrategies.has(strategyName);
    }
    
    /**
     * Get all enabled strategies
     */
    getEnabledStrategies() {
        return Array.from(this.enabledStrategies);
    }
    
    /**
     * Process a strategy signal - execute if enabled for live
     * Called by ResearchEngine when a strategy signals
     */
    async processSignal(strategyName, signal, tick, market) {
        // Check if live trading is active
        if (!this.isRunning || this.killSwitchActive) {
            return null;
        }
        
        // Check if this strategy is enabled for live trading
        if (!this.isStrategyEnabled(strategyName)) {
            return null;
        }
        
        // Only process buy/sell signals
        if (!signal || signal.action === 'hold') {
            return null;
        }
        
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
        
        try {
            if (signal.action === 'buy') {
                // Check if we already have a position
                if (this.livePositions[positionKey]) {
                    return null; // Already in position
                }
                
                return await this.executeEntry(strategyName, signal, tick, market);
                
            } else if (signal.action === 'sell') {
                // Check if we have a position to exit
                if (!this.livePositions[positionKey]) {
                    return null; // No position to exit
                }
                
                return await this.executeExit(strategyName, signal, tick, market);
            }
        } catch (error) {
            this.logger.error(`[LiveTrader] Error processing signal for ${strategyName}:`, error.message);
            return null;
        }
    }
    
    /**
     * Calculate minimum viable position size
     * Polymarket requires minimum $1 order VALUE (shares * price >= $1)
     */
    calculateMinimumSize(price, requestedSize) {
        const MIN_ORDER_VALUE = 1.0;  // $1 minimum order value
        
        // Calculate shares for requested size
        const requestedShares = requestedSize / price;
        const requestedValue = requestedShares * price;
        
        // If requested value is already >= $1, use it
        if (requestedValue >= MIN_ORDER_VALUE) {
            return requestedSize;
        }
        
        // Otherwise, calculate minimum size to hit $1 value
        // shares * price >= $1, so shares >= 1/price
        const minShares = Math.ceil(MIN_ORDER_VALUE / price);
        const actualSize = minShares * price;
        
        this.logger.log(`[LiveTrader] Adjusted size: $${requestedSize} → $${actualSize.toFixed(2)} (min $1 value requires ${minShares} shares at $${price.toFixed(2)})`);
        
        return actualSize;
    }
    
    /**
     * Execute entry trade
     */
    async executeEntry(strategyName, signal, tick, market) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        
        // Determine token side and price first
        const tokenSide = signal.side === 'up' ? 'UP' : 'DOWN';
        const tokenId = tokenSide === 'UP' ? market.upTokenId : market.downTokenId;
        const entryPrice = tokenSide === 'UP' ? tick.up_ask : tick.down_ask;
        
        // Calculate actual position size (ensure minimum 5 shares for Polymarket)
        const actualSize = this.calculateMinimumSize(entryPrice, this.options.positionSize);
        
        // Validate with risk manager
        const validation = this.riskManager.validateTrade({
            crypto,
            windowEpoch,
            size: actualSize,
            side: signal.side
        }, {
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread,
            mid: tick.up_mid,
            bidSize: tick.up_bid_size,
            askSize: tick.up_ask_size
        });
        
        if (!validation.allowed) {
            this.logger.log(`[LiveTrader] Trade blocked for ${strategyName}: ${validation.violations.map(v => v.message).join('; ')}`);
            return null;
        }
        
        this.logger.log(`[LiveTrader] 📈 EXECUTING LIVE ENTRY: ${strategyName} | ${crypto} | ${tokenSide} | $${actualSize.toFixed(2)} @ ${entryPrice.toFixed(3)}`);
        
        try {
            this.stats.ordersPlaced++;
            
            // Place order
            const response = await this.client.placeOrder({
                tokenId,
                price: entryPrice,
                size: actualSize,
                side: Side.BUY,
                orderType: OrderType.FOK // Fill or kill
            });
            
            if (response.status === 'filled' || response.status === 'live') {
                this.stats.ordersFilled++;
                
                // Record position
                const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
                this.livePositions[positionKey] = {
                    strategyName,
                    crypto,
                    windowEpoch,
                    tokenSide,
                    tokenId,
                    entryPrice: entryPrice,
                    entryTime: Date.now(),
                    size: actualSize,
                    spotAtEntry: tick.spot_price,
                    orderId: response.orderId
                };
                
                // Update risk manager
                this.riskManager.recordTradeOpen({
                    crypto,
                    windowEpoch,
                    size: actualSize
                });
                
                this.logger.log(`[LiveTrader] ✅ ENTRY FILLED: ${strategyName} | ${crypto} ${tokenSide} @ ${entryPrice.toFixed(3)}`);
                
                this.emit('trade_entry', {
                    strategyName,
                    crypto,
                    side: signal.side,
                    price: entryPrice,
                    size: actualSize
                });
                
                // Save to database
                await this.saveTrade('entry', strategyName, signal, tick, entryPrice);
                
                return response;
            } else {
                this.stats.ordersRejected++;
                this.logger.warn(`[LiveTrader] Order not filled: ${response.status}`);
                return null;
            }
            
        } catch (error) {
            this.stats.ordersRejected++;
            this.logger.error(`[LiveTrader] Entry order failed: ${error.message}`);
            
            // RETRY ONCE at slightly worse price (+2 cents)
            const RETRY_SLIPPAGE = 0.02;
            const MAX_SLIPPAGE = 0.02;  // Don't retry if we'd exceed 2c worse
            const retryPrice = Math.min(entryPrice + RETRY_SLIPPAGE, 0.99);
            
            if (retryPrice - entryPrice <= MAX_SLIPPAGE) {
                this.logger.log(`[LiveTrader] 🔄 RETRYING at ${retryPrice.toFixed(3)} (+${((retryPrice - entryPrice) * 100).toFixed(1)}c)`);
                
                try {
                    const retryResponse = await this.client.placeOrder({
                        tokenId,
                        price: retryPrice,
                        size: actualSize,
                        side: Side.BUY,
                        orderType: OrderType.FOK
                    });
                    
                    if (retryResponse.status === 'filled' || retryResponse.status === 'live') {
                        this.stats.ordersFilled++;
                        
                        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
                        this.livePositions[positionKey] = {
                            strategyName,
                            crypto,
                            windowEpoch,
                            tokenSide,
                            tokenId,
                            entryPrice: retryPrice,
                            entryTime: Date.now(),
                            size: actualSize,
                            spotAtEntry: tick.spot_price,
                            orderId: retryResponse.orderId,
                            wasRetry: true
                        };
                        
                        this.riskManager.recordTradeOpen({ crypto, windowEpoch, size: actualSize });
                        
                        this.logger.log(`[LiveTrader] ✅ RETRY FILLED: ${strategyName} | ${crypto} ${tokenSide} @ ${retryPrice.toFixed(3)}`);
                        
                        this.emit('trade_entry', {
                            strategyName,
                            crypto,
                            side: signal.side,
                            price: retryPrice,
                            size: actualSize,
                            wasRetry: true
                        });
                        
                        await this.saveTrade('entry', strategyName, signal, tick, retryPrice);
                        return retryResponse;
                    }
                } catch (retryError) {
                    this.logger.error(`[LiveTrader] Retry also failed: ${retryError.message}`);
                }
            } else {
                this.logger.warn(`[LiveTrader] Skipping retry - would exceed 2c slippage`);
            }
            
            // Log the missed opportunity for analysis
            this.emit('trade_missed', {
                strategyName,
                crypto,
                side: signal.side,
                price: entryPrice,
                size: actualSize,
                reason: error.message,
                timestamp: Date.now()
            });
            
            return null;
        }
    }
    
    /**
     * Execute exit trade
     */
    async executeExit(strategyName, signal, tick, market) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
        
        const position = this.livePositions[positionKey];
        if (!position) {
            return null;
        }
        
        const tokenId = position.tokenId;
        const price = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
        
        this.logger.log(`[LiveTrader] 📉 EXECUTING LIVE EXIT: ${strategyName} | ${crypto} | ${position.tokenSide} | @ ${price.toFixed(3)}`);
        
        try {
            this.stats.ordersPlaced++;
            
            // Place sell order
            const response = await this.client.placeOrder({
                tokenId,
                price,
                size: position.size,
                side: Side.SELL,
                orderType: OrderType.FOK
            });
            
            if (response.status === 'filled' || response.status === 'live') {
                this.stats.ordersFilled++;
                this.stats.tradesExecuted++;
                
                // Calculate P&L
                const pnl = (price - position.entryPrice) * position.size;
                const fee = position.size * 0.001; // Estimate 0.1% fee
                const netPnl = pnl - fee;
                
                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;
                
                // Update risk manager
                this.riskManager.recordTradeClose({
                    crypto,
                    windowEpoch,
                    size: position.size
                }, netPnl);
                
                // Remove position
                delete this.livePositions[positionKey];
                
                const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
                this.logger.log(`[LiveTrader] ✅ EXIT FILLED: ${strategyName} | ${crypto} @ ${price.toFixed(3)} | P&L: ${pnlStr}`);
                
                this.emit('trade_exit', {
                    strategyName,
                    crypto,
                    side: position.tokenSide.toLowerCase(),
                    entryPrice: position.entryPrice,
                    exitPrice: price,
                    pnl: netPnl,
                    size: position.size
                });
                
                // Save to database
                await this.saveTrade('exit', strategyName, signal, tick, price, position, netPnl);
                
                return response;
            } else {
                this.stats.ordersRejected++;
                this.logger.warn(`[LiveTrader] Exit order not filled: ${response.status}`);
                return null;
            }
            
        } catch (error) {
            this.stats.ordersRejected++;
            this.logger.error(`[LiveTrader] Exit order failed: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Save live trade to database
     */
    async saveTrade(type, strategyName, signal, tick, price, position = null, pnl = null) {
        try {
            await saveLiveTrade({
                type,
                strategy_name: strategyName,
                crypto: tick.crypto,
                side: signal.side,
                window_epoch: tick.window_epoch,
                price,
                size: this.options.positionSize,
                spot_price: tick.spot_price,
                time_remaining: tick.time_remaining_sec,
                reason: signal.reason,
                entry_price: position?.entryPrice,
                pnl,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.logger.error('[LiveTrader] Failed to save trade:', error.message);
        }
    }
    
    /**
     * Handle window end - close any open positions
     */
    async onWindowEnd(windowInfo) {
        const { crypto, epoch, outcome } = windowInfo;
        
        // Find positions for this window
        for (const [key, position] of Object.entries(this.livePositions)) {
            if (position.crypto === crypto && position.windowEpoch === epoch) {
                // Position expired at window end
                const finalPrice = outcome === position.tokenSide.toLowerCase() ? 1.0 : 0.0;
                const pnl = (finalPrice - position.entryPrice) * position.size;
                const fee = position.size * 0.001;
                const netPnl = pnl - fee;
                
                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;
                this.stats.tradesExecuted++;
                
                this.riskManager.recordTradeClose({
                    crypto,
                    windowEpoch: epoch,
                    size: position.size
                }, netPnl);
                
                delete this.livePositions[key];
                
                const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
                this.logger.log(`[LiveTrader] 🏁 WINDOW END: ${position.strategyName} | ${crypto} | Outcome: ${outcome} | P&L: ${pnlStr}`);
                
                this.emit('trade_exit', {
                    strategyName: position.strategyName,
                    crypto,
                    side: position.tokenSide.toLowerCase(),
                    entryPrice: position.entryPrice,
                    exitPrice: finalPrice,
                    pnl: netPnl,
                    size: position.size,
                    reason: 'window_expiry'
                });
            }
        }
    }
    
    /**
     * Kill switch - stop all live trading immediately
     */
    activateKillSwitch(reason = 'manual') {
        this.killSwitchActive = true;
        this.logger.error(`[LiveTrader] 🛑 KILL SWITCH ACTIVATED: ${reason}`);
        this.emit('kill_switch', { reason });
    }
    
    /**
     * Reset kill switch
     */
    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.log('[LiveTrader] Kill switch reset');
    }
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            enabled: this.options.enabled,
            killSwitchActive: this.killSwitchActive,
            positionSize: this.options.positionSize,
            enabledStrategies: Array.from(this.enabledStrategies),
            livePositions: Object.values(this.livePositions),
            stats: this.stats,
            riskStatus: this.riskManager.getStatus()
        };
    }
}

// Singleton instance
let liveTraderInstance = null;

export function getLiveTrader() {
    if (!liveTraderInstance) {
        liveTraderInstance = new LiveTrader();
    }
    return liveTraderInstance;
}

export default LiveTrader;
