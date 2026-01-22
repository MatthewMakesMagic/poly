/**
 * Tick Data Collector Service
 * 
 * Runs 24/7 collecting real-time data from:
 * - Polymarket WebSocket (order book, prices)
 * - Binance WebSocket (spot prices)
 * 
 * Stores data to SQLite for analysis
 */

import WebSocket from 'ws';
import { initDatabase, insertTick, upsertWindow, setState, getState } from '../db/connection.js';

// Configuration
const CONFIG = {
    // Polymarket endpoints
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CLOB_API: 'https://clob.polymarket.com',
    CLOB_WS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    
    // Binance endpoints
    BINANCE_WS: 'wss://stream.binance.com:9443/ws',
    
    // Crypto markets to track
    CRYPTOS: {
        btc: { binanceSymbol: 'btcusdt', name: 'Bitcoin' },
        eth: { binanceSymbol: 'ethusdt', name: 'Ethereum' },
        sol: { binanceSymbol: 'solusdt', name: 'Solana' },
        xrp: { binanceSymbol: 'xrpusdt', name: 'XRP' }
    },
    
    // Collection settings
    TICK_INTERVAL_MS: 1000,         // Store tick every 1 second
    DEPTH_LEVELS: 5,                // Top N order book levels to store
    RECONNECT_DELAY_MS: 5000,       // Delay before reconnecting
    MARKET_REFRESH_INTERVAL: 60000, // Refresh market IDs every minute
};

class TickCollector {
    constructor() {
        this.db = null;
        this.polymarketWs = null;
        this.binanceWs = null;
        
        // Current market data
        this.markets = {};          // crypto -> { epoch, upTokenId, downTokenId, priceTobeat }
        this.orderBooks = {};       // tokenId -> { bids, asks }
        this.spotPrices = {};       // crypto -> price
        
        // State tracking
        this.lastTickTime = {};     // crypto -> timestamp
        this.tickBuffer = [];       // Buffer ticks for batch insert
        this.isRunning = false;
        
        // Stats
        this.stats = {
            ticksCollected: 0,
            messagesReceived: 0,
            errors: 0,
            reconnects: 0
        };
    }
    
    /**
     * Start the collector
     */
    async start() {
        console.log('═'.repeat(70));
        console.log('     POLYMARKET TICK COLLECTOR');
        console.log('     Starting data collection service...');
        console.log('═'.repeat(70));
        
        // Initialize database
        this.db = initDatabase();
        
        this.isRunning = true;
        
        // Discover current 15-minute markets
        await this.refreshMarkets();
        
        // Connect to data sources
        await this.connectBinance();
        await this.connectPolymarket();
        
        // Set up periodic tasks
        this.setupPeriodicTasks();
        
        console.log('\n✅ Collector started successfully');
        console.log(`   Tracking: ${Object.keys(CONFIG.CRYPTOS).join(', ')}`);
        console.log('   Press Ctrl+C to stop\n');
    }
    
    /**
     * Stop the collector
     */
    stop() {
        console.log('\n🛑 Stopping collector...');
        this.isRunning = false;
        
        // Flush any remaining ticks
        this.flushTickBuffer();
        
        // Close connections
        if (this.polymarketWs) {
            this.polymarketWs.close();
        }
        if (this.binanceWs) {
            this.binanceWs.close();
        }
        
        // Save state
        setState('last_run', new Date().toISOString());
        setState('ticks_collected', String(this.stats.ticksCollected));
        
        console.log('📊 Final stats:');
        console.log(`   Ticks collected: ${this.stats.ticksCollected}`);
        console.log(`   Messages received: ${this.stats.messagesReceived}`);
        console.log(`   Errors: ${this.stats.errors}`);
        console.log('✅ Collector stopped');
    }
    
    /**
     * Discover current 15-minute markets for all cryptos
     */
    async refreshMarkets() {
        const now = Math.floor(Date.now() / 1000);
        const currentEpoch = Math.floor(now / 900) * 900;
        
        for (const crypto of Object.keys(CONFIG.CRYPTOS)) {
            try {
                const market = await this.fetchMarket(crypto, currentEpoch);
                if (market) {
                    this.markets[crypto] = market;
                }
            } catch (error) {
                console.error(`❌ Failed to fetch ${crypto} market:`, error.message);
            }
        }
        
        console.log(`📊 Markets refreshed for epoch ${currentEpoch}`);
    }
    
    /**
     * Fetch market details from Gamma API
     */
    async fetchMarket(crypto, epoch) {
        const slug = `${crypto}-updown-15m-${epoch}`;
        
        try {
            const response = await fetch(`${CONFIG.GAMMA_API}/markets?slug=${slug}`);
            const markets = await response.json();
            
            if (markets && markets.length > 0) {
                const market = markets[0];
                const tokenIds = JSON.parse(market.clobTokenIds || '[]');
                
                // Fetch price to beat from market description or calculate
                let priceTobeat = null;
                
                return {
                    epoch,
                    slug,
                    upTokenId: tokenIds[0],
                    downTokenId: tokenIds[1],
                    priceToBeat: priceTobeat,
                    endTime: new Date(market.endDate).getTime()
                };
            }
        } catch (error) {
            // Market might not exist yet
        }
        
        return null;
    }
    
    /**
     * Connect to Binance WebSocket for spot prices
     */
    async connectBinance() {
        return new Promise((resolve) => {
            // Build combined stream URL
            const streams = Object.values(CONFIG.CRYPTOS)
                .map(c => `${c.binanceSymbol}@ticker`)
                .join('/');
            
            const url = `${CONFIG.BINANCE_WS}/${streams}`;
            
            console.log('🔌 Connecting to Binance...');
            
            this.binanceWs = new WebSocket(url);
            
            this.binanceWs.on('open', () => {
                console.log('✅ Binance connected');
                resolve();
            });
            
            this.binanceWs.on('message', (data) => {
                this.handleBinanceMessage(data);
            });
            
            this.binanceWs.on('error', (error) => {
                console.error('❌ Binance error:', error.message);
                this.stats.errors++;
            });
            
            this.binanceWs.on('close', () => {
                console.log('🔴 Binance disconnected');
                if (this.isRunning) {
                    this.stats.reconnects++;
                    setTimeout(() => this.connectBinance(), CONFIG.RECONNECT_DELAY_MS);
                }
            });
        });
    }
    
    /**
     * Handle Binance WebSocket messages
     */
    handleBinanceMessage(rawData) {
        try {
            const data = JSON.parse(rawData.toString());
            this.stats.messagesReceived++;
            
            // Extract symbol and price
            const symbol = data.s?.toLowerCase();
            const price = parseFloat(data.c);
            
            if (symbol && price) {
                // Map symbol to crypto
                for (const [crypto, config] of Object.entries(CONFIG.CRYPTOS)) {
                    if (config.binanceSymbol === symbol) {
                        this.spotPrices[crypto] = price;
                        break;
                    }
                }
            }
        } catch (error) {
            this.stats.errors++;
        }
    }
    
    /**
     * Connect to Polymarket WebSocket
     */
    async connectPolymarket() {
        return new Promise((resolve) => {
            console.log('🔌 Connecting to Polymarket...');
            
            this.polymarketWs = new WebSocket(CONFIG.CLOB_WS);
            
            this.polymarketWs.on('open', () => {
                console.log('✅ Polymarket connected');
                this.subscribeToMarkets();
                resolve();
            });
            
            this.polymarketWs.on('message', (data) => {
                this.handlePolymarketMessage(data);
            });
            
            this.polymarketWs.on('error', (error) => {
                console.error('❌ Polymarket error:', error.message);
                this.stats.errors++;
            });
            
            this.polymarketWs.on('close', () => {
                console.log('🔴 Polymarket disconnected');
                if (this.isRunning) {
                    this.stats.reconnects++;
                    setTimeout(() => this.connectPolymarket(), CONFIG.RECONNECT_DELAY_MS);
                }
            });
        });
    }
    
    /**
     * Subscribe to all current market tokens
     */
    subscribeToMarkets() {
        const tokenIds = [];
        
        for (const market of Object.values(this.markets)) {
            if (market.upTokenId) tokenIds.push(market.upTokenId);
            if (market.downTokenId) tokenIds.push(market.downTokenId);
        }
        
        if (tokenIds.length > 0) {
            const msg = {
                type: 'market',
                assets_ids: tokenIds
            };
            this.polymarketWs.send(JSON.stringify(msg));
            console.log(`📡 Subscribed to ${tokenIds.length} tokens`);
        }
    }
    
    /**
     * Handle Polymarket WebSocket messages
     */
    handlePolymarketMessage(rawData) {
        try {
            const data = JSON.parse(rawData.toString());
            this.stats.messagesReceived++;
            
            // Handle order book snapshot (array format)
            if (Array.isArray(data)) {
                for (const book of data) {
                    if (book.asset_id && book.bids && book.asks) {
                        this.orderBooks[book.asset_id] = {
                            bids: book.bids,
                            asks: book.asks,
                            lastTradePrice: book.last_trade_price,
                            timestamp: Date.now()
                        };
                    }
                }
            }
            
            // Handle price change events
            if (data.event_type === 'price_change' && data.price_changes) {
                for (const change of data.price_changes) {
                    // Update the specific level in our order book
                    // This is a simplification - full implementation would update specific levels
                }
            }
            
        } catch (error) {
            this.stats.errors++;
        }
    }
    
    /**
     * Set up periodic tasks
     */
    setupPeriodicTasks() {
        // Record ticks at regular intervals
        setInterval(() => this.recordTicks(), CONFIG.TICK_INTERVAL_MS);
        
        // Refresh markets when window changes
        setInterval(() => this.checkWindowChange(), 10000);
        
        // Flush tick buffer periodically
        setInterval(() => this.flushTickBuffer(), 5000);
        
        // Log stats periodically
        setInterval(() => this.logStats(), 60000);
    }
    
    /**
     * Record current state as ticks
     */
    recordTicks() {
        const now = Date.now();
        
        for (const [crypto, market] of Object.entries(this.markets)) {
            // Skip if we've recorded recently
            if (this.lastTickTime[crypto] && now - this.lastTickTime[crypto] < CONFIG.TICK_INTERVAL_MS * 0.9) {
                continue;
            }
            
            const upBook = this.orderBooks[market.upTokenId];
            const downBook = this.orderBooks[market.downTokenId];
            const spotPrice = this.spotPrices[crypto];
            
            // Need at least spot price and one order book
            if (!spotPrice || !upBook) continue;
            
            // Calculate best bid/ask
            const upBids = upBook.bids || [];
            const upAsks = upBook.asks || [];
            const downBids = downBook?.bids || [];
            const downAsks = downBook?.asks || [];
            
            const upBestBid = upBids.reduce((max, b) => 
                parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0', size: '0' });
            const upBestAsk = upAsks.reduce((min, a) => 
                parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1', size: '0' });
            const downBestBid = downBids.reduce((max, b) => 
                parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0', size: '0' });
            const downBestAsk = downAsks.reduce((min, a) => 
                parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1', size: '0' });
            
            const upBid = parseFloat(upBestBid.price);
            const upAsk = parseFloat(upBestAsk.price);
            const upMid = (upBid + upAsk) / 2;
            const spread = upAsk - upBid;
            const spreadPct = upMid > 0 ? (spread / upMid) * 100 : 0;
            
            // Calculate time remaining
            const timeRemainingSec = Math.max(0, (market.endTime - now) / 1000);
            
            // Calculate spot delta (if we have price to beat)
            const priceToBeat = market.priceToBeat || spotPrice; // Use current price if no reference
            const spotDelta = spotPrice - priceToBeat;
            const spotDeltaPct = priceToBeat > 0 ? (spotDelta / priceToBeat) * 100 : 0;
            
            // Prepare tick data
            const tick = {
                timestamp_ms: now,
                crypto,
                window_epoch: market.epoch,
                time_remaining_sec: timeRemainingSec,
                
                up_bid: upBid,
                up_ask: upAsk,
                up_bid_size: parseFloat(upBestBid.size),
                up_ask_size: parseFloat(upBestAsk.size),
                up_last_trade: upBook.lastTradePrice ? parseFloat(upBook.lastTradePrice) : null,
                up_mid: upMid,
                
                down_bid: parseFloat(downBestBid.price),
                down_ask: parseFloat(downBestAsk.price),
                down_bid_size: parseFloat(downBestBid.size),
                down_ask_size: parseFloat(downBestAsk.size),
                down_last_trade: downBook?.lastTradePrice ? parseFloat(downBook.lastTradePrice) : null,
                
                spot_price: spotPrice,
                price_to_beat: priceToBeat,
                spot_delta: spotDelta,
                spot_delta_pct: spotDeltaPct,
                
                spread,
                spread_pct: spreadPct,
                implied_prob_up: upMid,
                
                up_book_depth: JSON.stringify(upBids.slice(0, CONFIG.DEPTH_LEVELS)),
                down_book_depth: JSON.stringify(downBids.slice(0, CONFIG.DEPTH_LEVELS))
            };
            
            this.tickBuffer.push(tick);
            this.lastTickTime[crypto] = now;
            this.stats.ticksCollected++;
        }
    }
    
    /**
     * Check if window has changed and refresh markets
     */
    async checkWindowChange() {
        const now = Math.floor(Date.now() / 1000);
        const currentEpoch = Math.floor(now / 900) * 900;
        
        // Check if any market epoch is stale
        for (const [crypto, market] of Object.entries(this.markets)) {
            if (market.epoch !== currentEpoch) {
                console.log(`🔄 Window changed for ${crypto}: ${market.epoch} -> ${currentEpoch}`);
                
                // Save window summary for old epoch
                await this.saveWindowSummary(crypto, market.epoch);
                
                // Refresh markets
                await this.refreshMarkets();
                
                // Resubscribe
                if (this.polymarketWs && this.polymarketWs.readyState === WebSocket.OPEN) {
                    this.subscribeToMarkets();
                }
                
                break;
            }
        }
    }
    
    /**
     * Save window summary when a window ends
     */
    async saveWindowSummary(crypto, epoch) {
        try {
            // Get ticks for this window from buffer or recent data
            // This is a simplified version - full implementation would query DB
            
            const windowData = {
                epoch,
                crypto,
                start_price: this.spotPrices[crypto], // Simplified
                end_price: this.spotPrices[crypto],
                outcome: null, // Will be filled when resolution is known
                resolved_at: null,
                opening_up_price: null,
                closing_up_price: null,
                high_up_price: null,
                low_up_price: null,
                tick_count: 0,
                price_change_count: 0,
                up_price_volatility: null,
                spot_volatility: null,
                max_spot_delta_pct: null
            };
            
            upsertWindow(windowData);
            
        } catch (error) {
            console.error(`❌ Failed to save window summary:`, error.message);
        }
    }
    
    /**
     * Flush tick buffer to database
     */
    flushTickBuffer() {
        if (this.tickBuffer.length === 0) return;
        
        try {
            const db = this.db;
            
            const stmt = db.prepare(`
                INSERT INTO ticks (
                    timestamp_ms, crypto, window_epoch, time_remaining_sec,
                    up_bid, up_ask, up_bid_size, up_ask_size, up_last_trade, up_mid,
                    down_bid, down_ask, down_bid_size, down_ask_size, down_last_trade,
                    spot_price, price_to_beat, spot_delta, spot_delta_pct,
                    spread, spread_pct, implied_prob_up,
                    up_book_depth, down_book_depth
                ) VALUES (
                    @timestamp_ms, @crypto, @window_epoch, @time_remaining_sec,
                    @up_bid, @up_ask, @up_bid_size, @up_ask_size, @up_last_trade, @up_mid,
                    @down_bid, @down_ask, @down_bid_size, @down_ask_size, @down_last_trade,
                    @spot_price, @price_to_beat, @spot_delta, @spot_delta_pct,
                    @spread, @spread_pct, @implied_prob_up,
                    @up_book_depth, @down_book_depth
                )
            `);
            
            const insertMany = db.transaction((ticks) => {
                for (const tick of ticks) {
                    stmt.run(tick);
                }
            });
            
            insertMany(this.tickBuffer);
            
            const count = this.tickBuffer.length;
            this.tickBuffer = [];
            
        } catch (error) {
            console.error('❌ Failed to flush ticks:', error.message);
            this.stats.errors++;
        }
    }
    
    /**
     * Log current stats
     */
    logStats() {
        const now = new Date().toISOString();
        console.log(`\n[${now}] 📊 Collector Stats:`);
        console.log(`   Ticks: ${this.stats.ticksCollected} | Messages: ${this.stats.messagesReceived} | Errors: ${this.stats.errors}`);
        
        for (const [crypto, price] of Object.entries(this.spotPrices)) {
            const market = this.markets[crypto];
            const upBook = market ? this.orderBooks[market.upTokenId] : null;
            
            if (upBook) {
                const bids = upBook.bids || [];
                const asks = upBook.asks || [];
                const bestBid = bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' });
                const bestAsk = asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1' });
                
                console.log(`   ${crypto.toUpperCase()}: Spot $${price.toLocaleString()} | Up ${bestBid.price}/${bestAsk.price}`);
            }
        }
    }
}

// Export for use as module
export { TickCollector, CONFIG };

// Run if executed directly
const isMainModule = process.argv[1]?.includes('tick_collector');
if (isMainModule) {
    const collector = new TickCollector();
    
    // Handle shutdown
    process.on('SIGINT', () => {
        collector.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        collector.stop();
        process.exit(0);
    });
    
    collector.start().catch(console.error);
}

