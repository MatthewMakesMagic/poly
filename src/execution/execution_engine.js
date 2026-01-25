/**
 * Execution Engine
 * 
 * The heart of the trading system. Runs 24/7 and orchestrates:
 * - Market data collection
 * - Strategy signal processing
 * - Order placement and management
 * - Position tracking
 * - Risk management integration
 * - Recovery from failures
 * 
 * Design principles:
 * - Fail-safe: Default to NOT trading on any uncertainty
 * - Auditable: Every action is logged and traceable
 * - Recoverable: Can resume after crashes
 * - Observable: Full visibility into state
 */

import EventEmitter from 'events';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { PolymarketClient, Side, OrderType, createClientFromEnv } from './polymarket_client.js';
import { OrderManager, OrderState } from './order_state_machine.js';
import { RiskManager } from './risk_manager.js';

// Configuration
const CONFIG = {
    // WebSocket endpoints
    CLOB_WS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    BINANCE_WS: 'wss://stream.binance.com:9443/ws',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    
    // Reconnection settings
    WS_RECONNECT_DELAY: 5000,
    WS_MAX_RECONNECTS: 10,
    WS_PING_INTERVAL: 30000,
    
    // State persistence
    STATE_FILE: './execution_state.json',
    STATE_SAVE_INTERVAL: 10000,
    
    // Health check
    HEALTH_CHECK_INTERVAL: 60000,
    HEARTBEAT_TIMEOUT: 120000
};

/**
 * Engine states
 */
export const EngineState = {
    STOPPED: 'STOPPED',
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR',
    STOPPING: 'STOPPING'
};

/**
 * Main Execution Engine
 */
export class ExecutionEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            cryptos: ['btc', 'xrp'],  // Cryptos to trade
            mode: 'live',             // 'live' or 'paper'
            stateFile: CONFIG.STATE_FILE,
            ...options
        };
        
        this.logger = options.logger || console;
        
        // Core components
        this.client = null;          // Polymarket API client
        this.orderManager = new OrderManager({ logger: this.logger });
        this.riskManager = new RiskManager({ 
            logger: this.logger,
            ...options.riskParams
        });
        
        // Strategy
        this.strategy = options.strategy;
        
        // Engine state
        this.state = EngineState.STOPPED;
        this.startTime = null;
        this.lastHeartbeat = null;
        
        // Market state
        this.currentMarkets = new Map();   // crypto -> market info
        this.orderBooks = new Map();       // tokenId -> order book
        this.spotPrices = new Map();       // crypto -> price
        this.currentTicks = new Map();     // crypto -> tick data
        
        // WebSocket connections
        this.polyWs = null;
        this.binanceWs = null;
        this.wsReconnectCount = 0;
        
        // Positions
        this.positions = new Map();        // positionId -> position
        
        // Intervals and timeouts
        this.intervals = [];
        
        // Session stats
        this.sessionStats = {
            tradesExecuted: 0,
            ordersPlaced: 0,
            ordersFilled: 0,
            ordersRejected: 0,
            grossPnL: 0,
            fees: 0,
            netPnL: 0
        };
        
        // Wire up events
        this.setupEventHandlers();
    }
    
    /**
     * Setup internal event handlers
     */
    setupEventHandlers() {
        // Order manager events
        this.orderManager.on('order:created', (order) => {
            this.emit('order:created', order);
        });
        
        this.orderManager.on('order:fill', (order, fill) => {
            this.sessionStats.ordersFilled++;
            this.emit('order:fill', order, fill);
        });
        
        this.orderManager.on('order:complete', (order) => {
            this.handleOrderComplete(order);
        });
        
        // Risk manager events
        this.riskManager.on('kill_switch', (data) => {
            this.logger.error('[Engine] KILL SWITCH TRIGGERED');
            this.pause('Kill switch activated');
            this.emit('kill_switch', data);
        });
        
        this.riskManager.on('circuit_breaker', (data) => {
            this.logger.warn('[Engine] Circuit breaker tripped');
            this.emit('circuit_breaker', data);
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Start the execution engine
     */
    async start() {
        if (this.state !== EngineState.STOPPED) {
            throw new Error(`Cannot start: engine is ${this.state}`);
        }
        
        this.state = EngineState.STARTING;
        this.startTime = Date.now();
        this.logger.log('═'.repeat(70));
        this.logger.log('     EXECUTION ENGINE STARTING');
        this.logger.log('═'.repeat(70));
        this.logger.log(`Mode: ${this.options.mode.toUpperCase()}`);
        this.logger.log(`Cryptos: ${this.options.cryptos.join(', ')}`);
        
        try {
            // 1. Initialize API client
            this.logger.log('[Engine] Initializing Polymarket client...');
            this.client = createClientFromEnv();
            
            // 2. Verify API connection
            this.logger.log('[Engine] Verifying API connection...');
            await this.verifyApiConnection();
            
            // 3. Restore state if exists
            this.logger.log('[Engine] Checking for saved state...');
            await this.restoreState();
            
            // 4. Fetch current markets
            this.logger.log('[Engine] Fetching current markets...');
            await this.refreshAllMarkets();
            
            // 5. Connect to data feeds
            this.logger.log('[Engine] Connecting to data feeds...');
            await this.connectDataFeeds();
            
            // 6. Setup periodic tasks
            this.logger.log('[Engine] Setting up periodic tasks...');
            this.setupPeriodicTasks();
            
            // 7. Mark as running
            this.state = EngineState.RUNNING;
            this.lastHeartbeat = Date.now();
            
            this.logger.log('═'.repeat(70));
            this.logger.log('     ENGINE RUNNING');
            this.logger.log('═'.repeat(70));
            this.logger.log(`Risk Status: ${this.riskManager.isTradingAllowed() ? '✅ Trading Allowed' : '❌ Trading Blocked'}`);
            
            this.emit('started');
            
        } catch (error) {
            this.state = EngineState.ERROR;
            this.logger.error('[Engine] Failed to start:', error);
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Stop the engine gracefully
     */
    async stop(reason = 'manual_stop') {
        if (this.state === EngineState.STOPPED) {
            return;
        }
        
        this.state = EngineState.STOPPING;
        this.logger.log(`[Engine] Stopping... Reason: ${reason}`);
        
        // 1. Cancel all open orders
        try {
            await this.cancelAllOpenOrders('engine_stop');
        } catch (error) {
            this.logger.error('[Engine] Error cancelling orders:', error);
        }
        
        // 2. Save state
        try {
            await this.saveState();
        } catch (error) {
            this.logger.error('[Engine] Error saving state:', error);
        }
        
        // 3. Close WebSocket connections
        if (this.polyWs) {
            this.polyWs.close();
            this.polyWs = null;
        }
        if (this.binanceWs) {
            this.binanceWs.close();
            this.binanceWs = null;
        }
        
        // 4. Clear intervals
        for (const interval of this.intervals) {
            clearInterval(interval);
        }
        this.intervals = [];
        
        // 5. Print summary
        this.printSessionSummary();
        
        this.state = EngineState.STOPPED;
        this.logger.log('[Engine] Stopped');
        this.emit('stopped', { reason });
    }
    
    /**
     * Pause trading (keep data feeds running)
     */
    pause(reason = 'manual_pause') {
        if (this.state !== EngineState.RUNNING) {
            return;
        }
        
        this.state = EngineState.PAUSED;
        this.logger.log(`[Engine] Paused. Reason: ${reason}`);
        this.emit('paused', { reason });
    }
    
    /**
     * Resume trading
     */
    resume() {
        if (this.state !== EngineState.PAUSED) {
            return;
        }
        
        // Check if trading is allowed
        if (!this.riskManager.isTradingAllowed()) {
            this.logger.warn('[Engine] Cannot resume: risk manager blocking trading');
            return false;
        }
        
        this.state = EngineState.RUNNING;
        this.logger.log('[Engine] Resumed');
        this.emit('resumed');
        return true;
    }
    
    /**
     * Verify API connection
     */
    async verifyApiConnection() {
        try {
            // Check server time
            const timeResponse = await this.client.getTime();
            this.logger.log(`[Engine] Server time: ${new Date(timeResponse.timestamp * 1000).toISOString()}`);
            
            // Check API key info
            const keyInfo = await this.client.getApiKeyInfo();
            this.logger.log(`[Engine] API Key verified for: ${keyInfo.address || 'unknown'}`);
            
            // Check balances
            const balances = await this.client.getBalances();
            this.logger.log(`[Engine] Balances retrieved`);
            
            return true;
        } catch (error) {
            this.logger.error('[Engine] API verification failed:', error.message);
            throw error;
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MARKET DATA
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Refresh all markets for configured cryptos
     */
    async refreshAllMarkets() {
        for (const crypto of this.options.cryptos) {
            try {
                const market = await this.client.getCurrentCryptoMarket(crypto);
                this.currentMarkets.set(crypto, market);
                this.logger.log(`[Engine] Market ${crypto}: ${market.slug}`);
            } catch (error) {
                this.logger.warn(`[Engine] Could not fetch market for ${crypto}:`, error.message);
            }
        }
    }
    
    /**
     * Connect to data feeds
     */
    async connectDataFeeds() {
        await Promise.all([
            this.connectPolymarket(),
            this.connectBinance()
        ]);
    }
    
    /**
     * Connect to Polymarket WebSocket
     */
    connectPolymarket() {
        return new Promise((resolve, reject) => {
            this.polyWs = new WebSocket(CONFIG.CLOB_WS);
            
            this.polyWs.on('open', () => {
                this.logger.log('[Engine] Polymarket WebSocket connected');
                this.wsReconnectCount = 0;
                this.subscribeToMarkets();
                resolve();
            });
            
            this.polyWs.on('message', (data) => {
                this.handlePolymarketMessage(data);
            });
            
            this.polyWs.on('error', (error) => {
                this.logger.error('[Engine] Polymarket WebSocket error:', error.message);
            });
            
            this.polyWs.on('close', () => {
                this.logger.warn('[Engine] Polymarket WebSocket closed');
                if (this.state === EngineState.RUNNING || this.state === EngineState.PAUSED) {
                    this.schedulePolymarketReconnect();
                }
            });
            
            // Timeout for initial connection
            setTimeout(() => {
                if (this.polyWs.readyState !== WebSocket.OPEN) {
                    reject(new Error('Polymarket WebSocket connection timeout'));
                }
            }, 10000);
        });
    }
    
    /**
     * Schedule Polymarket reconnect
     */
    schedulePolymarketReconnect() {
        if (this.wsReconnectCount >= CONFIG.WS_MAX_RECONNECTS) {
            this.logger.error('[Engine] Max WebSocket reconnects reached');
            this.pause('WebSocket connection lost');
            return;
        }
        
        this.wsReconnectCount++;
        this.logger.log(`[Engine] Reconnecting Polymarket (attempt ${this.wsReconnectCount})...`);
        
        setTimeout(() => {
            this.connectPolymarket().catch(error => {
                this.logger.error('[Engine] Polymarket reconnect failed:', error.message);
            });
        }, CONFIG.WS_RECONNECT_DELAY);
    }
    
    /**
     * Subscribe to current markets
     */
    subscribeToMarkets() {
        const tokenIds = [];
        
        for (const market of this.currentMarkets.values()) {
            if (market.upTokenId) tokenIds.push(market.upTokenId);
            if (market.downTokenId) tokenIds.push(market.downTokenId);
        }
        
        if (tokenIds.length > 0 && this.polyWs?.readyState === WebSocket.OPEN) {
            this.polyWs.send(JSON.stringify({
                type: 'market',
                assets_ids: tokenIds
            }));
            this.logger.log(`[Engine] Subscribed to ${tokenIds.length} tokens`);
        }
    }
    
    /**
     * Handle Polymarket WebSocket message
     */
    handlePolymarketMessage(rawData) {
        try {
            const data = JSON.parse(rawData.toString());
            
            if (Array.isArray(data)) {
                for (const book of data) {
                    if (book.asset_id && (book.bids || book.asks)) {
                        this.orderBooks.set(book.asset_id, {
                            bids: book.bids || [],
                            asks: book.asks || [],
                            lastTrade: book.last_trade_price,
                            timestamp: Date.now()
                        });
                    }
                }
                
                // Update ticks and process
                this.updateTicks();
            }
        } catch (error) {
            // Ignore parse errors
        }
    }
    
    /**
     * Connect to Binance WebSocket
     */
    connectBinance() {
        return new Promise((resolve) => {
            const streams = this.options.cryptos.map(crypto => {
                const symbol = crypto === 'btc' ? 'btcusdt' :
                              crypto === 'eth' ? 'ethusdt' :
                              crypto === 'sol' ? 'solusdt' :
                              crypto === 'xrp' ? 'xrpusdt' : null;
                return symbol ? `${symbol}@ticker` : null;
            }).filter(Boolean);
            
            const url = `${CONFIG.BINANCE_WS}/${streams.join('/')}`;
            this.binanceWs = new WebSocket(url);
            
            this.binanceWs.on('open', () => {
                this.logger.log('[Engine] Binance WebSocket connected');
                resolve();
            });
            
            this.binanceWs.on('message', (data) => {
                this.handleBinanceMessage(data);
            });
            
            this.binanceWs.on('error', (error) => {
                this.logger.error('[Engine] Binance WebSocket error:', error.message);
            });
            
            this.binanceWs.on('close', () => {
                if (this.state === EngineState.RUNNING || this.state === EngineState.PAUSED) {
                    setTimeout(() => this.connectBinance(), CONFIG.WS_RECONNECT_DELAY);
                }
            });
        });
    }
    
    /**
     * Handle Binance WebSocket message
     */
    handleBinanceMessage(rawData) {
        try {
            const data = JSON.parse(rawData.toString());
            const symbol = data.s?.toLowerCase();
            
            let crypto;
            if (symbol?.includes('btc')) crypto = 'btc';
            else if (symbol?.includes('eth')) crypto = 'eth';
            else if (symbol?.includes('sol')) crypto = 'sol';
            else if (symbol?.includes('xrp')) crypto = 'xrp';
            
            if (crypto && data.c) {
                this.spotPrices.set(crypto, parseFloat(data.c));
            }
        } catch (error) {
            // Ignore parse errors
        }
    }
    
    /**
     * Update tick data for all cryptos
     */
    updateTicks() {
        for (const [crypto, market] of this.currentMarkets) {
            const upBook = this.orderBooks.get(market.upTokenId);
            const downBook = this.orderBooks.get(market.downTokenId);
            const spotPrice = this.spotPrices.get(crypto);
            
            if (!upBook || !spotPrice) continue;
            
            // Calculate best bid/ask
            const upBids = upBook.bids || [];
            const upAsks = upBook.asks || [];
            
            const upBestBid = upBids.reduce((max, b) =>
                parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0', size: '0' });
            const upBestAsk = upAsks.reduce((min, a) =>
                parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1', size: '0' });
            
            const upBid = parseFloat(upBestBid.price);
            const upAsk = parseFloat(upBestAsk.price);
            const upMid = (upBid + upAsk) / 2;
            const upBidSize = parseFloat(upBestBid.size) * upBid;  // Convert to $
            const upAskSize = parseFloat(upBestAsk.size) * upAsk;
            
            const timeRemaining = Math.max(0, (market.endDate.getTime() - Date.now()) / 1000);
            
            const tick = {
                timestamp_ms: Date.now(),
                crypto,
                window_epoch: Math.floor(market.endDate.getTime() / 1000) - 900,
                time_remaining_sec: timeRemaining,
                up_bid: upBid,
                up_ask: upAsk,
                up_bid_size: upBidSize,
                up_ask_size: upAskSize,
                up_mid: upMid,
                down_bid: 1 - upAsk,
                down_ask: 1 - upBid,
                spot_price: spotPrice,
                spread: upAsk - upBid,
                spread_pct: upMid > 0 ? ((upAsk - upBid) / upMid) * 100 : 0,
                market
            };
            
            this.currentTicks.set(crypto, tick);
            this.lastHeartbeat = Date.now();
            
            // Process tick through strategy
            if (this.state === EngineState.RUNNING) {
                this.processTick(tick);
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STRATEGY & EXECUTION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Process a tick through the strategy
     */
    async processTick(tick) {
        if (!this.strategy) return;
        
        try {
            // Get strategy signal
            const signal = this.strategy.onTick(tick, this.getPositionForWindow(tick.crypto, tick.window_epoch));
            
            if (!signal || signal.action === 'hold') return;
            
            // Execute signal
            if (signal.action === 'buy') {
                await this.executeEntry(tick, signal);
            } else if (signal.action === 'sell') {
                await this.executeExit(tick, signal);
            }
            
        } catch (error) {
            this.logger.error('[Engine] Error processing tick:', error);
        }
    }
    
    /**
     * Execute entry trade
     */
    async executeEntry(tick, signal) {
        const { crypto, window_epoch, market } = tick;
        
        // Prepare trade params for risk validation
        const tradeParams = {
            crypto,
            windowEpoch: window_epoch,
            size: signal.size || 1,
            side: signal.side
        };
        
        // Market state for risk validation
        const marketState = {
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread,
            mid: tick.up_mid,
            bidSize: tick.up_bid_size,
            askSize: tick.up_ask_size
        };
        
        // Validate with risk manager
        const validation = this.riskManager.validateTrade(tradeParams, marketState);
        
        if (!validation.allowed) {
            this.logger.log(`[Engine] Trade blocked: ${validation.violations.map(v => v.message).join('; ')}`);
            return null;
        }
        
        // Create order
        const tokenSide = signal.side === 'up' ? 'UP' : 'DOWN';
        const tokenId = tokenSide === 'UP' ? market.upTokenId : market.downTokenId;
        const price = tokenSide === 'UP' ? tick.up_ask : tick.down_ask;
        
        const order = this.orderManager.createOrder({
            tokenId,
            market: market.slug,
            crypto,
            windowEpoch: window_epoch,
            side: 'BUY',
            tokenSide,
            price,
            size: tradeParams.size,
            orderType: 'FOK',  // Fill or kill for entries
            spotPrice: tick.spot_price,
            upBid: tick.up_bid,
            upAsk: tick.up_ask,
            downBid: tick.down_bid,
            downAsk: tick.down_ask,
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread,
            strategy: this.strategy?.getName() || 'unknown',
            signal
        });
        
        // Execute order
        await this.submitOrder(order);
        
        return order;
    }
    
    /**
     * Execute exit trade
     */
    async executeExit(tick, signal) {
        const position = this.getPositionForWindow(tick.crypto, tick.window_epoch);
        if (!position) {
            this.logger.warn('[Engine] No position to exit');
            return null;
        }
        
        const { market } = tick;
        const tokenId = position.tokenSide === 'UP' ? market.upTokenId : market.downTokenId;
        const price = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
        
        const order = this.orderManager.createOrder({
            tokenId,
            market: market.slug,
            crypto: tick.crypto,
            windowEpoch: tick.window_epoch,
            side: 'SELL',
            tokenSide: position.tokenSide,
            price,
            size: position.size,
            orderType: 'FOK',
            spotPrice: tick.spot_price,
            upBid: tick.up_bid,
            upAsk: tick.up_ask,
            downBid: tick.down_bid,
            downAsk: tick.down_ask,
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread,
            strategy: this.strategy?.getName() || 'unknown',
            signal,
            parentOrderId: position.entryOrderId
        });
        
        await this.submitOrder(order);
        
        return order;
    }
    
    /**
     * Submit order to exchange
     */
    async submitOrder(order) {
        try {
            this.sessionStats.ordersPlaced++;
            
            // Determine side for API
            const apiSide = order.side === 'BUY' ? Side.BUY : Side.SELL;
            
            this.logger.log(`[Engine] Submitting order: ${order.side} ${order.tokenSide} $${order.size} @ ${order.price}`);
            
            // Place order
            const response = await this.client.placeOrder({
                tokenId: order.tokenId,
                price: order.price,
                size: order.size,
                side: apiSide,
                orderType: OrderType[order.orderType]
            });
            
            // Update order state
            this.orderManager.markSubmitted(order.id, response.orderId);
            
            // For FOK orders, check if filled immediately
            if (order.orderType === 'FOK' && response.status === 'filled') {
                this.orderManager.addFill(order.id, {
                    price: order.price,
                    size: order.size,
                    fee: order.size * 0.001  // Estimate 0.1% fee
                });
            } else if (response.status === 'live' || response.status === 'open') {
                this.orderManager.markOpen(order.id, response);
            }
            
            return response;
            
        } catch (error) {
            this.logger.error(`[Engine] Order submission failed: ${error.message}`);
            this.sessionStats.ordersRejected++;
            
            // Check if it's a rejection vs system error
            if (error.status === 400 || error.status === 422) {
                this.orderManager.markRejected(order.id, error.message);
            } else {
                this.orderManager.markFailed(order.id, error.message);
            }
            
            throw error;
        }
    }
    
    /**
     * Handle order completion
     */
    handleOrderComplete(order) {
        this.sessionStats.tradesExecuted++;
        
        // Update risk manager
        if (order.state === OrderState.FILLED) {
            if (order.side === 'BUY') {
                // Entry trade
                this.riskManager.recordTradeOpen({
                    crypto: order.crypto,
                    windowEpoch: order.windowEpoch,
                    size: order.filledSize
                });
                
                // Create position
                const positionId = `${order.crypto}_${order.windowEpoch}`;
                this.positions.set(positionId, {
                    id: positionId,
                    crypto: order.crypto,
                    windowEpoch: order.windowEpoch,
                    tokenSide: order.tokenSide,
                    size: order.filledSize,
                    entryPrice: order.filledPrice,
                    entryTime: order.filledAt,
                    entryOrderId: order.id
                });
                
            } else {
                // Exit trade
                const positionId = `${order.crypto}_${order.windowEpoch}`;
                const position = this.positions.get(positionId);
                
                if (position) {
                    // Calculate P&L
                    const pnl = (order.filledPrice - position.entryPrice) * position.size;
                    const netPnl = pnl - order.fees;
                    
                    this.riskManager.recordTradeClose({
                        crypto: order.crypto,
                        windowEpoch: order.windowEpoch,
                        size: order.filledSize
                    }, netPnl);
                    
                    this.sessionStats.grossPnL += pnl;
                    this.sessionStats.fees += order.fees;
                    this.sessionStats.netPnL += netPnl;
                    
                    this.positions.delete(positionId);
                    
                    this.logger.log(`[Engine] Position closed: PnL $${netPnl.toFixed(4)}`);
                }
            }
        }
        
        // Save state
        this.saveState().catch(err => this.logger.error('[Engine] State save error:', err));
    }
    
    /**
     * Get position for a window
     */
    getPositionForWindow(crypto, windowEpoch) {
        return this.positions.get(`${crypto}_${windowEpoch}`);
    }
    
    /**
     * Cancel all open orders
     */
    async cancelAllOpenOrders(reason) {
        const openOrders = this.orderManager.getOpenOrders();
        
        for (const order of openOrders) {
            try {
                if (order.exchangeOrderId) {
                    await this.client.cancelOrder(order.exchangeOrderId);
                }
                this.orderManager.markCancelled(order.id, reason);
            } catch (error) {
                this.logger.error(`[Engine] Failed to cancel order ${order.id}:`, error.message);
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PERIODIC TASKS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Setup periodic tasks
     */
    setupPeriodicTasks() {
        // Market refresh every minute
        this.intervals.push(setInterval(async () => {
            const now = Math.floor(Date.now() / 1000);
            const currentEpoch = Math.floor(now / 900) * 900;
            
            // Check if we need to refresh markets
            for (const [crypto, market] of this.currentMarkets) {
                const marketEpoch = Math.floor(market.endDate.getTime() / 1000) - 900;
                if (marketEpoch !== currentEpoch) {
                    this.logger.log(`[Engine] Window changed for ${crypto}, refreshing...`);
                    
                    // Close any open position at window end
                    const position = this.getPositionForWindow(crypto, marketEpoch);
                    if (position) {
                        this.logger.log(`[Engine] Position expired at window end`);
                        // Mark as expired
                    }
                    
                    try {
                        const newMarket = await this.client.getCurrentCryptoMarket(crypto);
                        this.currentMarkets.set(crypto, newMarket);
                        this.logger.log(`[Engine] New market: ${newMarket.slug}`);
                    } catch (error) {
                        this.logger.error(`[Engine] Failed to refresh ${crypto} market:`, error.message);
                    }
                }
            }
            
            // Resubscribe to markets
            this.subscribeToMarkets();
            
        }, 10000));
        
        // State persistence
        this.intervals.push(setInterval(() => {
            this.saveState().catch(err => this.logger.error('[Engine] State save error:', err));
        }, CONFIG.STATE_SAVE_INTERVAL));
        
        // Health check
        this.intervals.push(setInterval(() => {
            this.healthCheck();
        }, CONFIG.HEALTH_CHECK_INTERVAL));
        
        // Status log every 5 minutes
        this.intervals.push(setInterval(() => {
            this.logStatus();
        }, 5 * 60 * 1000));
    }
    
    /**
     * Health check
     */
    healthCheck() {
        const now = Date.now();
        
        // Check heartbeat
        if (this.lastHeartbeat && now - this.lastHeartbeat > CONFIG.HEARTBEAT_TIMEOUT) {
            this.logger.error('[Engine] Heartbeat timeout - no data received');
            this.emit('health_warning', { type: 'heartbeat_timeout' });
        }
        
        // Check WebSocket connections
        if (this.polyWs?.readyState !== WebSocket.OPEN) {
            this.logger.warn('[Engine] Polymarket WebSocket not connected');
            this.emit('health_warning', { type: 'ws_disconnected', feed: 'polymarket' });
        }
        
        if (this.binanceWs?.readyState !== WebSocket.OPEN) {
            this.logger.warn('[Engine] Binance WebSocket not connected');
            this.emit('health_warning', { type: 'ws_disconnected', feed: 'binance' });
        }
        
        // Check risk status
        const riskStatus = this.riskManager.getStatus();
        if (!riskStatus.tradingAllowed) {
            this.logger.warn('[Engine] Trading not allowed by risk manager');
        }
        
        this.emit('health_check', {
            timestamp: now,
            state: this.state,
            wsPolymarket: this.polyWs?.readyState === WebSocket.OPEN,
            wsBinance: this.binanceWs?.readyState === WebSocket.OPEN,
            lastHeartbeat: this.lastHeartbeat,
            tradingAllowed: riskStatus.tradingAllowed,
            riskStatus
        });
    }
    
    /**
     * Log current status
     */
    logStatus() {
        const riskStatus = this.riskManager.getStatus();
        const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000 / 60) : 0;
        
        this.logger.log('\n' + '─'.repeat(50));
        this.logger.log(`[Engine] Status Update - Uptime: ${uptime} minutes`);
        this.logger.log(`   State: ${this.state}`);
        this.logger.log(`   Trades: ${this.sessionStats.tradesExecuted} | Net PnL: $${this.sessionStats.netPnL.toFixed(2)}`);
        this.logger.log(`   Open Positions: ${this.positions.size}`);
        this.logger.log(`   Risk: ${riskStatus.tradingAllowed ? '✅ OK' : '❌ BLOCKED'}`);
        this.logger.log('─'.repeat(50) + '\n');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STATE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Save state to file
     */
    async saveState() {
        const state = {
            timestamp: Date.now(),
            engineState: this.state,
            sessionStats: this.sessionStats,
            orders: this.orderManager.exportOrders(),
            positions: Array.from(this.positions.values()),
            riskState: this.riskManager.getStatus()
        };
        
        try {
            fs.writeFileSync(
                this.options.stateFile,
                JSON.stringify(state, null, 2)
            );
        } catch (error) {
            this.logger.error('[Engine] Failed to save state:', error);
        }
    }
    
    /**
     * Restore state from file
     */
    async restoreState() {
        try {
            if (fs.existsSync(this.options.stateFile)) {
                const data = fs.readFileSync(this.options.stateFile, 'utf8');
                const state = JSON.parse(data);
                
                // Check if state is recent (within 1 hour)
                if (Date.now() - state.timestamp < 60 * 60 * 1000) {
                    // Restore orders
                    if (state.orders) {
                        this.orderManager.importOrders(state.orders);
                    }
                    
                    // Restore positions
                    if (state.positions) {
                        for (const pos of state.positions) {
                            this.positions.set(pos.id, pos);
                        }
                    }
                    
                    this.logger.log(`[Engine] Restored state from ${new Date(state.timestamp).toISOString()}`);
                    this.logger.log(`[Engine] Restored ${state.orders?.length || 0} orders, ${state.positions?.length || 0} positions`);
                } else {
                    this.logger.log('[Engine] Saved state too old, starting fresh');
                }
            }
        } catch (error) {
            this.logger.warn('[Engine] Could not restore state:', error.message);
        }
    }
    
    /**
     * Print session summary
     */
    printSessionSummary() {
        const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000 / 60) : 0;
        
        this.logger.log('\n' + '═'.repeat(70));
        this.logger.log('     SESSION SUMMARY');
        this.logger.log('═'.repeat(70));
        this.logger.log(`   Uptime: ${uptime} minutes`);
        this.logger.log(`   Orders Placed: ${this.sessionStats.ordersPlaced}`);
        this.logger.log(`   Orders Filled: ${this.sessionStats.ordersFilled}`);
        this.logger.log(`   Orders Rejected: ${this.sessionStats.ordersRejected}`);
        this.logger.log(`   Trades Executed: ${this.sessionStats.tradesExecuted}`);
        this.logger.log(`   Gross P&L: $${this.sessionStats.grossPnL.toFixed(4)}`);
        this.logger.log(`   Fees: $${this.sessionStats.fees.toFixed(4)}`);
        this.logger.log(`   Net P&L: $${this.sessionStats.netPnL.toFixed(4)}`);
        this.logger.log('═'.repeat(70) + '\n');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            state: this.state,
            startTime: this.startTime,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            lastHeartbeat: this.lastHeartbeat,
            sessionStats: this.sessionStats,
            markets: Object.fromEntries(this.currentMarkets),
            positions: Array.from(this.positions.values()),
            openOrders: this.orderManager.getOpenOrders(),
            riskStatus: this.riskManager.getStatus()
        };
    }
    
    /**
     * Get current tick for a crypto
     */
    getCurrentTick(crypto) {
        return this.currentTicks.get(crypto);
    }
    
    /**
     * Manual order placement (for testing)
     */
    async manualOrder(params) {
        const tick = this.currentTicks.get(params.crypto);
        if (!tick) {
            throw new Error(`No market data for ${params.crypto}`);
        }
        
        return this.executeEntry(tick, {
            side: params.side,
            size: params.size
        });
    }
}

export default ExecutionEngine;
