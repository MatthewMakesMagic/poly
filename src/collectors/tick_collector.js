/**
 * Tick Data Collector Service
 * 
 * Runs 24/7 collecting real-time data from:
 * - Polymarket WebSocket (order book, prices)
 * - Binance WebSocket (spot prices)
 * 
 * Also runs quant research engine with 10 strategies to measure performance.
 * Stores data to PostgreSQL for analysis.
 */

import WebSocket from 'ws';
import { initDatabase, insertTick, upsertWindow, setState, getState, saveResearchStats, initOracleResolutionTables, initPositionPathTable } from '../db/connection.js';
import { getResearchEngine } from '../quant/research_engine.js';
import { startDashboard, sendTick, sendStrategyComparison, sendMetrics } from '../dashboard/server.js';
import { getChainlinkCollector } from './chainlink_prices.js';
import { getMultiSourcePriceCollector } from './multi_source_prices.js';
import { getResolutionService } from '../services/resolution_service.js';

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
        
        // Quant research engine
        this.researchEngine = null;
        
        // Stats
        this.stats = {
            ticksCollected: 0,
            messagesReceived: 0,
            errors: 0,
            reconnects: 0
        };
        
        // CoinGecko fallback
        this.useCoinGecko = false;
        this.coinGeckoInterval = null;
        
        // Chainlink oracle prices (used for actual resolution)
        this.chainlinkCollector = null;
        this.chainlinkPrices = {};  // crypto -> { price, staleness, updatedAt }

        // Multi-source price collector (Pyth, Coinbase, Kraken, OKX, CoinCap, CoinGecko, RedStone)
        this.multiSourceCollector = null;

        // Resolution service for Binance vs Chainlink vs Pyth accuracy tracking
        this.resolutionService = null;
    }
    
    /**
     * Start the collector
     */
    async start() {
        console.log('═'.repeat(70));
        console.log('     POLYMARKET TICK COLLECTOR + QUANT RESEARCH ENGINE');
        console.log('     Starting data collection & strategy analysis...');
        console.log('═'.repeat(70));
        
        // Initialize database
        this.db = initDatabase();

        // Initialize additional tables (Oracle/Resolution tracking, Position paths)
        try {
            await initOracleResolutionTables();
            console.log('✅ Oracle/Resolution tables initialized');
        } catch (error) {
            console.error('⚠️  Oracle/Resolution tables init failed:', error.message);
        }

        try {
            await initPositionPathTable();
            console.log('✅ Position path table initialized');
        } catch (error) {
            console.error('⚠️  Position path table init failed:', error.message);
        }

        // Initialize research engine
        try {
            this.researchEngine = getResearchEngine({ 
                capitalPerTrade: 100,
                enablePaperTrading: true 
            });
            console.log('✅ Research engine initialized with', this.researchEngine.strategies.length, 'strategies');
        } catch (error) {
            console.error('⚠️  Research engine init failed:', error.message);
            this.researchEngine = null;
        }
        
        this.isRunning = true;
        
        // Start dashboard server for WebSocket connections
        const dashboardPort = process.env.PORT || process.env.DASHBOARD_PORT || 3333;
        try {
            await startDashboard(dashboardPort);
            console.log(`✅ Dashboard server started on port ${dashboardPort}`);
        } catch (error) {
            console.error('⚠️  Dashboard server failed to start:', error.message);
        }
        
        // Discover current 15-minute markets
        await this.refreshMarkets();
        
        // Connect to data sources
        await this.connectBinance();
        await this.connectPolymarket();
        
        // Initialize Chainlink oracle price feeds
        // This gives us the ACTUAL resolution price (vs Binance which is display price)
        try {
            this.chainlinkCollector = await getChainlinkCollector();
            this.chainlinkCollector.startPolling(5000); // Poll every 5 seconds
            console.log('✅ Chainlink oracle feeds initialized');
        } catch (error) {
            console.error('⚠️  Chainlink initialization failed:', error.message);
            console.log('   Will continue with Binance prices only');
            this.chainlinkCollector = null;
        }

        // Initialize multi-source price collector
        // Provides Pyth, Coinbase, Kraken, OKX, CoinCap, CoinGecko, RedStone prices
        // Used for oracle comparison analysis and strategy optimization
        try {
            this.multiSourceCollector = await getMultiSourcePriceCollector();
            this.multiSourceCollector.startPolling();
            console.log('✅ Multi-source price feeds initialized');
        } catch (error) {
            console.error('⚠️  Multi-source collector initialization failed:', error.message);
            console.log('   Will continue without multi-source prices');
            this.multiSourceCollector = null;
        }

        // Initialize resolution service and link price collectors
        // Captures final-minute snapshots and compares Binance/Chainlink/Pyth accuracy
        try {
            this.resolutionService = getResolutionService();
            if (this.chainlinkCollector) {
                this.resolutionService.setChainlinkCollector(this.chainlinkCollector);
            }
            if (this.multiSourceCollector) {
                this.resolutionService.setMultiSourceCollector(this.multiSourceCollector);
            }
            console.log('✅ Resolution service initialized (Binance vs Chainlink vs Pyth tracking)');
        } catch (error) {
            console.error('⚠️  Resolution service initialization failed:', error.message);
            this.resolutionService = null;
        }

        // Set up periodic tasks
        this.setupPeriodicTasks();
        
        console.log('\n✅ Collector started successfully');
        console.log(`   Tracking: ${Object.keys(CONFIG.CRYPTOS).join(', ')}`);
        if (this.researchEngine) {
            console.log(`   Strategies: ${this.researchEngine.strategies.map(s => s.getName()).join(', ')}`);
        }
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
        if (this.coinGeckoInterval) {
            clearInterval(this.coinGeckoInterval);
        }
        if (this.multiSourceCollector) {
            this.multiSourceCollector.stop();
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
        
        // Update research engine with new markets (needed for live trading tokenIds)
        if (this.researchEngine) {
            this.researchEngine.setMarkets(this.markets);
        }
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
                
                // Price to beat is SET ONCE at window start
                // We'll set it when we get the first spot price for this window
                // Do NOT update it after that!
                
                return {
                    epoch,
                    slug,
                    upTokenId: tokenIds[0],
                    downTokenId: tokenIds[1],
                    priceToBeat: null,  // Will be set on first tick
                    priceToBeatLocked: false,  // Flag to prevent updates
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
     * Falls back to CoinGecko polling if Binance is blocked
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
            
            // Timeout for connection - if Binance doesn't work, use CoinGecko
            const connectionTimeout = setTimeout(() => {
                console.log('⚠️  Binance connection timeout, switching to CoinGecko...');
                this.useCoinGecko = true;
                this.startCoinGeckoPolling();
                resolve();
            }, 10000);
            
            this.binanceWs.on('open', () => {
                clearTimeout(connectionTimeout);
                console.log('✅ Binance connected');
                this.useCoinGecko = false;
                resolve();
            });
            
            this.binanceWs.on('message', (data) => {
                this.handleBinanceMessage(data);
            });
            
            this.binanceWs.on('error', (error) => {
                clearTimeout(connectionTimeout);
                console.error('❌ Binance error:', error.message);
                this.stats.errors++;
                
                // Switch to CoinGecko on error
                if (!this.useCoinGecko) {
                    console.log('⚠️  Switching to CoinGecko for spot prices...');
                    this.useCoinGecko = true;
                    this.startCoinGeckoPolling();
                    resolve();
                }
            });
            
            this.binanceWs.on('close', () => {
                console.log('🔴 Binance disconnected');
                if (this.isRunning && !this.useCoinGecko) {
                    this.stats.reconnects++;
                    setTimeout(() => this.connectBinance(), CONFIG.RECONNECT_DELAY_MS);
                }
            });
        });
    }
    
    /**
     * Start CoinGecko polling as fallback for spot prices
     */
    startCoinGeckoPolling() {
        if (this.coinGeckoInterval) return;
        
        console.log('📊 Starting CoinGecko price polling...');
        
        // Map our crypto names to CoinGecko IDs
        const coinGeckoIds = {
            btc: 'bitcoin',
            eth: 'ethereum', 
            sol: 'solana',
            xrp: 'ripple'
        };
        
        const fetchPrices = async () => {
            try {
                const ids = Object.values(coinGeckoIds).join(',');
                const response = await fetch(
                    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
                );
                
                if (response.ok) {
                    const data = await response.json();
                    
                    // Update spot prices
                    for (const [crypto, geckoId] of Object.entries(coinGeckoIds)) {
                        if (data[geckoId]?.usd) {
                            this.spotPrices[crypto] = data[geckoId].usd;
                        }
                    }
                    this.stats.messagesReceived++;
                }
            } catch (error) {
                console.error('❌ CoinGecko error:', error.message);
            }
        };
        
        // Fetch immediately, then every 5 seconds
        fetchPrices();
        this.coinGeckoInterval = setInterval(fetchPrices, 5000);
        console.log('✅ CoinGecko polling started');
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
            
            // Handle order book snapshot (array format) - initial data on subscribe
            if (Array.isArray(data)) {
                for (const book of data) {
                    if (book.asset_id && book.bids && book.asks) {
                        this.orderBooks[book.asset_id] = {
                            bids: book.bids,
                            asks: book.asks,
                            lastTradePrice: book.last_trade_price,
                            timestamp: Date.now()
                        };
                        
                        // Log initial snapshot
                        const bids = book.bids || [];
                        const asks = book.asks || [];
                        const bestBid = bids.length > 0 ? bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' }).price : '0';
                        const bestAsk = asks.length > 0 ? asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1' }).price : '1';
                        console.log(`📚 Book snapshot: ${book.asset_id.slice(0,8)}... bid=${bestBid} ask=${bestAsk}`);
                    }
                }
            }
            
            // Handle price change events - THIS IS THE MAIN DATA SOURCE!
            // Each price_change contains best_bid/best_ask for a token
            if (data.event_type === 'price_change' && data.price_changes) {
                for (const change of data.price_changes) {
                    const tokenId = change.asset_id;
                    if (!tokenId) continue;
                    
                    // Update the order book with new best bid/ask
                    if (!this.orderBooks[tokenId]) {
                        this.orderBooks[tokenId] = { bids: [], asks: [], timestamp: Date.now() };
                    }
                    
                    const book = this.orderBooks[tokenId];
                    
                    // Replace bids/asks with single best level from price_change
                    if (change.best_bid !== undefined) {
                        book.bids = [{ price: change.best_bid, size: change.best_bid_size || '100' }];
                    }
                    if (change.best_ask !== undefined) {
                        book.asks = [{ price: change.best_ask, size: change.best_ask_size || '100' }];
                    }
                    if (change.price) {
                        book.lastTradePrice = change.price;
                    }
                    book.timestamp = Date.now();
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
        
        // Refresh markets when window changes (catch any unhandled errors)
        setInterval(() => {
            this.checkWindowChange().catch(err => {
                console.error('❌ Unhandled error in checkWindowChange:', err.message);
                this.stats.errors++;
            });
        }, 10000);
        
        // Flush tick buffer periodically
        setInterval(() => this.flushTickBuffer(), 5000);
        
        // Log stats periodically
        setInterval(() => this.logStats(), 60000);
        
        // Send dashboard metrics periodically
        setInterval(() => this.sendDashboardMetrics(), 10000);
    }
    
    /**
     * Send metrics to dashboard
     */
    sendDashboardMetrics() {
        if (!this.researchEngine) return;
        
        try {
            const report = this.researchEngine.getStrategyPerformanceReport();
            
            // Send strategy comparison
            sendStrategyComparison(report);
            
            // Calculate aggregate metrics
            let totalTrades = 0;
            let totalPnl = 0;
            let wins = 0;
            let openCount = 0;
            
            for (const strat of report.strategies) {
                totalTrades += strat.closedTrades || 0;
                totalPnl += strat.totalPnl || 0;
                wins += strat.wins || 0;
                openCount += strat.openPositions?.length || 0;
            }
            
            const winRate = totalTrades > 0 ? wins / totalTrades : 0;
            
            sendMetrics({
                totalTrades,
                totalPnl,
                winRate,
                openPositions: openCount
            });
        } catch (error) {
            // Dashboard might not be connected
        }
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
            
            // Get Chainlink oracle price (this is what Polymarket ACTUALLY uses for resolution)
            let chainlinkPrice = null;
            let chainlinkStaleness = null;
            let chainlinkUpdatedAt = null;
            let priceDivergence = null;
            let priceDivergencePct = null;
            
            if (this.chainlinkCollector) {
                const clData = this.chainlinkCollector.getPrice(crypto);
                if (clData) {
                    chainlinkPrice = clData.price;
                    chainlinkStaleness = clData.staleness;
                    chainlinkUpdatedAt = clData.updatedAt;
                    
                    // Calculate divergence: Binance - Chainlink
                    // Positive = Binance is higher (Binance shows UP but Chainlink may not agree)
                    priceDivergence = spotPrice - chainlinkPrice;
                    priceDivergencePct = chainlinkPrice > 0 ? (priceDivergence / chainlinkPrice) * 100 : null;
                }
            }
            
            // Get multi-source prices for oracle comparison analysis
            let pythPrice = null;
            let pythStaleness = null;
            let coinbasePrice = null;
            let krakenPrice = null;
            let okxPrice = null;
            let coincapPrice = null;
            let coingeckoPrice = null;
            let redstonePrice = null;
            let consensusPrice = null;
            let sourceCount = 0;
            let priceSpreadPct = null;

            if (this.multiSourceCollector) {
                const pythData = this.multiSourceCollector.getPrice('pyth', crypto);
                if (pythData) {
                    pythPrice = pythData.price;
                    pythStaleness = pythData.staleness;
                }

                const cbData = this.multiSourceCollector.getPrice('coinbase', crypto);
                if (cbData) coinbasePrice = cbData.price;

                const krData = this.multiSourceCollector.getPrice('kraken', crypto);
                if (krData) krakenPrice = krData.price;

                const okxData = this.multiSourceCollector.getPrice('okx', crypto);
                if (okxData) okxPrice = okxData.price;

                const ccData = this.multiSourceCollector.getPrice('coincap', crypto);
                if (ccData) coincapPrice = ccData.price;

                const cgData = this.multiSourceCollector.getPrice('coingecko', crypto);
                if (cgData) coingeckoPrice = cgData.price;

                const rsData = this.multiSourceCollector.getPrice('redstone', crypto);
                if (rsData) redstonePrice = rsData.price;

                // Get consensus metrics
                const consensus = this.multiSourceCollector.getConsensusPrice(crypto);
                if (consensus) {
                    consensusPrice = consensus.price;
                    sourceCount = consensus.sourceCount;
                    priceSpreadPct = consensus.spreadPct;
                }
            }

            // LOCK IN price_to_beat on first tick of window
            // CRITICAL FIX (Jan 29 2026): Use oracle prices, not Binance!
            // Polymarket resolves based on Chainlink, so strike must match oracle at window start
            // Priority: Chainlink > Pyth > Binance (last resort)
            // Note: XRP has NO Chainlink feed on Polygon, so Pyth is primary for XRP
            if (!market.priceToBeatLocked) {
                let strikePrice = null;
                let source = 'unknown';

                // 1. Chainlink (primary for BTC/ETH/SOL - what Polymarket uses)
                if (chainlinkPrice && chainlinkPrice > 0) {
                    strikePrice = chainlinkPrice;
                    source = 'Chainlink';
                }
                // 2. Pyth (best fallback - tracks Chainlink within $1-30, primary for XRP)
                else if (pythPrice && pythPrice > 0) {
                    strikePrice = pythPrice;
                    source = 'Pyth';
                }
                // 3. Binance (last resort - can be $119+ off for BTC!)
                else if (spotPrice > 0) {
                    strikePrice = spotPrice;
                    source = 'Binance (WARNING: may differ from resolution)';
                }

                if (strikePrice > 0) {
                    market.priceToBeat = strikePrice;
                    market.priceToBeatLocked = true;
                    console.log(`📌 ${crypto} window ${market.epoch}: price_to_beat locked at $${strikePrice.toFixed(2)} [${source}]`);
                }
            }
            
            // Use locked price_to_beat (should never be null after first tick)
            const priceToBeat = market.priceToBeat || spotPrice;

            // CRITICAL (Jan 29 2026): Use Pyth as primary spot price, NOT Binance!
            // Binance can diverge $100+ from Polymarket's resolution oracle.
            // Pyth tracks Chainlink within $1-30, making it much safer for trading decisions.
            const effectiveSpotPrice = pythPrice || spotPrice;  // Pyth primary, Binance fallback
            const spotDelta = effectiveSpotPrice - priceToBeat;
            const spotDeltaPct = priceToBeat > 0 ? (spotDelta / priceToBeat) * 100 : 0;

            // ORACLE PRICE: Best available oracle for strategy decisions
            // Priority: Chainlink (if fresh <5s) > Pyth > Binance
            const CHAINLINK_STALE_THRESHOLD = 5; // seconds
            const chainlinkFresh = chainlinkPrice && chainlinkStaleness !== null && chainlinkStaleness <= CHAINLINK_STALE_THRESHOLD;
            const oraclePrice = chainlinkFresh ? chainlinkPrice : (pythPrice || spotPrice);
            const oracleSource = chainlinkFresh ? 'chainlink' : (pythPrice ? 'pyth' : 'binance');
            const oracleDelta = oraclePrice - priceToBeat;
            const oracleDeltaPct = priceToBeat > 0 ? (oracleDelta / priceToBeat) * 100 : 0;
            
            // Prepare tick data
            const tick = {
                timestamp_ms: now,
                timestamp: now,  // Alias for research engine
                crypto,
                epoch: market.epoch,  // Alias for research engine
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
                
                // CRITICAL: spot_price now uses Pyth (primary) with Binance fallback
                // This ensures strategies make decisions based on oracle-aligned prices
                spot_price: effectiveSpotPrice,
                binance_price: spotPrice,  // Keep original Binance for reference/logging
                price_to_beat: priceToBeat,
                spot_delta: spotDelta,
                spot_delta_pct: spotDeltaPct / 100,  // Convert to decimal for research engine

                // ORACLE PRICE: Best oracle for strategy decisions (Chainlink if fresh, else Pyth)
                // Strategies should use this instead of spot_price for position decisions
                oracle_price: oraclePrice,
                oracle_source: oracleSource,
                oracle_delta: oracleDelta,
                oracle_delta_pct: oracleDeltaPct / 100,  // Convert to decimal
                
                spread,
                spread_pct: spreadPct,
                implied_prob_up: upMid,
                
                up_book_depth: JSON.stringify(upBids.slice(0, CONFIG.DEPTH_LEVELS)),
                down_book_depth: JSON.stringify(downBids.slice(0, CONFIG.DEPTH_LEVELS)),
                
                // Chainlink oracle data (what Polymarket ACTUALLY uses for resolution)
                chainlink_price: chainlinkPrice,
                chainlink_staleness: chainlinkStaleness,
                chainlink_updated_at: chainlinkUpdatedAt,
                
                // Price divergence: Binance - Chainlink
                // Key insight: If divergence is positive and significant, Binance shows UP
                // but Chainlink (resolution) might not agree yet
                price_divergence: priceDivergence,
                price_divergence_pct: priceDivergencePct,

                // Multi-source price data for oracle comparison analysis
                pyth_price: pythPrice,
                pyth_staleness: pythStaleness,
                coinbase_price: coinbasePrice,
                kraken_price: krakenPrice,
                okx_price: okxPrice,
                coincap_price: coincapPrice,
                coingecko_price: coingeckoPrice,
                redstone_price: redstonePrice,

                // Multi-source consensus
                consensus_price: consensusPrice,
                source_count: sourceCount,
                price_spread_pct: priceSpreadPct
            };
            
            // Process tick through research engine
            if (this.researchEngine) {
                try {
                    this.researchEngine.processTick(tick);
                } catch (error) {
                    // Don't let research engine errors stop data collection
                    if (this.stats.errors % 100 === 0) {
                        console.error('⚠️  Research engine error:', error.message);
                    }
                }
            }
            
            // Send tick to dashboard
            try {
                sendTick(tick);
            } catch (error) {
                // Dashboard might not be connected
            }

            // Send tick to resolution service for final-minute capture
            if (this.resolutionService) {
                try {
                    this.resolutionService.processTick(tick);
                } catch (error) {
                    // Resolution service errors shouldn't crash collector
                }
            }

            this.tickBuffer.push(tick);
            this.lastTickTime[crypto] = now;
            this.stats.ticksCollected++;
        }
    }
    
    /**
     * Check if window has changed and refresh markets
     * CRITICAL: This runs every 10s and MUST NOT crash - wrap everything in try/catch
     */
    async checkWindowChange() {
        try {
            const now = Math.floor(Date.now() / 1000);
            const currentEpoch = Math.floor(now / 900) * 900;
            
            let needsRefresh = false;
            
            // Check if any market epoch is stale
            for (const [crypto, market] of Object.entries(this.markets)) {
                if (market.epoch !== currentEpoch) {
                    console.log(`🔄 Window changed for ${crypto}: ${market.epoch} -> ${currentEpoch}`);
                    needsRefresh = true;
                    
                    // Determine outcome based on spot price vs price to beat
                    const spotPrice = this.spotPrices[crypto];
                    const priceToBeat = market.priceToBeat || spotPrice;
                    const outcome = spotPrice >= priceToBeat ? 'up' : 'down';
                    
                    // Notify research engine of window end (paper trading)
                    if (this.researchEngine) {
                        try {
                            this.researchEngine.onWindowEnd({
                                crypto,
                                epoch: market.epoch,
                                outcome,
                                finalPrice: spotPrice,
                                priceToBeat
                            });
                        } catch (error) {
                            console.error('⚠️  Research engine window end error:', error.message);
                        }
                    }
                    
                    // Notify live trader of window end (CRITICAL: closes positions and resets openOrderCount)
                    try {
                        const { getLiveTrader } = await import('../execution/live_trader.js');
                        const liveTrader = getLiveTrader();
                        if (liveTrader && liveTrader.isRunning) {
                            await liveTrader.onWindowEnd({
                                crypto,
                                epoch: market.epoch,
                                outcome
                            });
                        }
                    } catch (error) {
                        console.error('⚠️  Live trader window end error:', error.message);
                    }

                    // ORPHAN CLEANUP: Auto-close any positions that failed to exit
                    // This ensures database stays accurate even if exits fail (Cloudflare, timeouts, etc.)
                    try {
                        const { closeOrphanPositions } = await import('../db/connection.js');
                        const result = await closeOrphanPositions(crypto, market.epoch, outcome);
                        if (result.closed > 0) {
                            console.log(`🧹 Cleaned ${result.closed} orphan positions for ${crypto}`);
                        }
                    } catch (error) {
                        console.error('⚠️  Orphan cleanup error:', error.message);
                    }

                    // Notify resolution service for Binance vs Chainlink vs Pyth accuracy tracking
                    if (this.resolutionService) {
                        try {
                            await this.resolutionService.onWindowEnd({
                                crypto,
                                epoch: market.epoch,
                                outcome,
                                finalPrice: spotPrice,
                                priceToBeat
                            });
                        } catch (error) {
                            console.error('⚠️  Resolution service window end error:', error.message);
                        }
                    }

                    // Save window summary for old epoch
                    try {
                        await this.saveWindowSummary(crypto, market.epoch);
                    } catch (error) {
                        console.error(`⚠️  Failed to save window summary for ${crypto}:`, error.message);
                    }
                }
            }
            
            // Refresh markets ONCE after processing all window changes (not inside loop!)
            if (needsRefresh) {
                try {
                    await this.refreshMarkets();
                    
                    // Resubscribe
                    if (this.polymarketWs && this.polymarketWs.readyState === WebSocket.OPEN) {
                        this.subscribeToMarkets();
                    }
                } catch (error) {
                    console.error('⚠️  Failed to refresh markets:', error.message);
                }
            }
        } catch (error) {
            // CRITICAL: Never let this function crash the process
            console.error('❌ checkWindowChange error (non-fatal):', error.message);
            this.stats.errors++;
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
     * Flush tick buffer to database (fire-and-forget to not block trading loop)
     */
    async flushTickBuffer() {
        if (this.tickBuffer.length === 0) return;

        // Copy and clear buffer immediately so we don't block
        const ticksToSave = [...this.tickBuffer];
        this.tickBuffer = [];

        // Fire-and-forget: don't await, let it complete in background
        import('../db/connection.js').then(({ insertTicksBatch }) => {
            insertTicksBatch(ticksToSave).catch(error => {
                // Silent fail - tick persistence is not critical for trading
                this.stats.errors++;
            });
        }).catch(() => {
            this.stats.errors++;
        });
    }
    
    /**
     * Log current stats and save health ping to database
     */
    async logStats() {
        const now = new Date().toISOString();
        console.log(`\n[${now}] 📊 Collector Stats:`);
        console.log(`   Ticks: ${this.stats.ticksCollected} | Messages: ${this.stats.messagesReceived} | Errors: ${this.stats.errors} | Reconnects: ${this.stats.reconnects}`);
        
        // Save health ping to database for monitoring
        try {
            await setState('collector_health', JSON.stringify({
                timestamp: now,
                ticks: this.stats.ticksCollected,
                messages: this.stats.messagesReceived,
                errors: this.stats.errors,
                reconnects: this.stats.reconnects,
                uptime: process.uptime(),
                memory: process.memoryUsage().heapUsed / 1024 / 1024 // MB
            }));
        } catch (e) {
            // Don't crash if health ping fails
        }
        
        for (const [crypto, price] of Object.entries(this.spotPrices)) {
            const market = this.markets[crypto];
            const upBook = market ? this.orderBooks[market.upTokenId] : null;
            
            if (upBook) {
                const bids = upBook.bids || [];
                const asks = upBook.asks || [];
                const bestBid = bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' });
                const bestAsk = asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1' });
                
                // Get Chainlink price for comparison
                let clInfo = '';
                if (this.chainlinkCollector) {
                    const clData = this.chainlinkCollector.getPrice(crypto);
                    if (clData) {
                        const divergence = price - clData.price;
                        const divergencePct = (divergence / clData.price) * 100;
                        clInfo = ` | CL $${clData.price.toLocaleString()} (${divergencePct >= 0 ? '+' : ''}${divergencePct.toFixed(3)}% div, ${clData.staleness}s stale)`;
                    }
                }
                
                // Get multi-source consensus
                let msInfo = '';
                if (this.multiSourceCollector) {
                    const consensus = this.multiSourceCollector.getConsensusPrice(crypto);
                    if (consensus && consensus.sourceCount > 0) {
                        msInfo = ` | ${consensus.sourceCount} sources, spread ${consensus.spreadPct.toFixed(3)}%`;
                    }
                }

                console.log(`   ${crypto.toUpperCase()}: Binance $${price.toLocaleString()} | Up ${bestBid.price}/${bestAsk.price}${clInfo}${msInfo}`);
            }
        }

        // Log multi-source collector stats
        if (this.multiSourceCollector) {
            const msStats = this.multiSourceCollector.getStats();
            const activeCount = Object.values(msStats.sources).filter(s => !s.disabled).length;
            const totalSources = Object.keys(msStats.sources).length;
            console.log(`\n   🌐 Multi-Source: ${activeCount}/${totalSources} active, ${msStats.tickCount} ticks emitted`);
        }
        
        // Log and save research engine stats
        if (this.researchEngine) {
            const summary = this.researchEngine.getSummary();
            console.log(`\n   📈 Research Engine:`);
            console.log(`   Ticks analyzed: ${summary.ticksProcessed} | Windows: ${summary.windowsAnalyzed}`);
            
            if (summary.spotLag.avgHalfPricingTimeMs) {
                console.log(`   Spot Lag: ${summary.spotLag.avgHalfPricingTimeMs.toFixed(0)}ms (half) / ${summary.spotLag.avgFullPricingTimeMs?.toFixed(0) || '?'}ms (full)`);
            }
            
            if (summary.efficiency) {
                console.log(`   Efficiency: ${summary.efficiency.meanAbsEdgePct?.toFixed(2) || '?'}% avg deviation from fair value`);
            }
            
            if (summary.topStrategy) {
                const ts = summary.topStrategy;
                console.log(`   Top Strategy: ${ts.name} | ${ts.trades} trades | $${ts.pnl.toFixed(2)} P&L | ${(ts.winRate * 100).toFixed(0)}% win`);
            }
            
            // Save research stats to database so dashboard can display them
            try {
                const fullReport = this.researchEngine.getStrategyPerformanceReport();
                const lagReport = this.researchEngine.getSpotLagReport();
                
                await saveResearchStats({
                    timestamp: Date.now(),
                    ticksProcessed: summary.ticksProcessed,
                    windowsAnalyzed: summary.windowsAnalyzed,
                    spotLag: summary.spotLag,
                    efficiency: summary.efficiency,
                    topStrategy: summary.topStrategy,
                    strategies: fullReport.strategies,
                    // Detailed lag analysis
                    lagAnalysis: {
                        totalLagEvents: lagReport.totalEvents,
                        completedEvents: lagReport.completedEvents,
                        avgHalfPricingTimeMs: lagReport.avgHalfPricingTimeMs,
                        avgFullPricingTimeMs: lagReport.avgFullPricingTimeMs,
                        avgMaxLagPct: lagReport.avgMaxLagPct,
                        recentEvents: lagReport.recentEvents?.slice(-5) || [],
                        alphaDecayCurve: lagReport.alphaDecayCurve
                    }
                });
                console.log(`   ✅ Saved research stats (${lagReport.totalEvents} lag events)`);
            } catch (error) {
                console.error(`   ⚠️  Failed to save research stats:`, error.message);
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

