/**
 * Data Collector
 * 
 * Streams real-time data from:
 * - Polymarket CLOB (order book + trades)
 * - Binance (spot prices)
 * 
 * Supports: BTC, ETH, SOL, XRP with rigorous price_to_beat tracking
 */

import WebSocket from 'ws';
import axios from 'axios';

const POLYMARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Crypto to Binance symbol mapping with price formatting
const CRYPTO_CONFIG = {
    BTC: { 
        binanceSymbol: 'btcusdt', 
        name: 'Bitcoin',
        priceDecimals: 2,      // BTC shows $104,234.56
        minMove: 0.01          // Minimum price movement
    },
    ETH: { 
        binanceSymbol: 'ethusdt', 
        name: 'Ethereum',
        priceDecimals: 2,      // ETH shows $3,212.43
        minMove: 0.01
    },
    SOL: { 
        binanceSymbol: 'solusdt', 
        name: 'Solana',
        priceDecimals: 2,      // SOL shows $234.56
        minMove: 0.01
    },
    XRP: { 
        binanceSymbol: 'xrpusdt', 
        name: 'XRP',
        priceDecimals: 4,      // XRP shows $0.5234
        minMove: 0.0001
    }
};

// Legacy mapping for backward compatibility
const BINANCE_SYMBOLS = Object.fromEntries(
    Object.entries(CRYPTO_CONFIG).map(([k, v]) => [k, v.binanceSymbol])
);

/**
 * Fetch actual resolution from Polymarket's API
 * This is the GROUND TRUTH - what Polymarket actually resolved to
 * (based on Chainlink Data Streams)
 */
async function fetchActualResolution(crypto, epoch) {
    const slug = `${crypto.toLowerCase()}-updown-15m-${epoch}`;

    try {
        const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);
        const markets = response.data;

        if (markets && markets.length > 0) {
            const market = markets[0];

            // Check if market is resolved (closed with final prices)
            if (market.closed) {
                const prices = JSON.parse(market.outcomePrices || '[]');
                const upPrice = parseFloat(prices[0]);

                // UP won if UP token = $1 (>0.9), DOWN won if UP token = $0 (<0.1)
                if (upPrice > 0.9) return 'up';
                if (upPrice < 0.1) return 'down';
            }
        }
    } catch (error) {
        console.error(`[DataCollector] Error fetching resolution for ${slug}:`, error.message);
    }

    return null; // Not yet resolved
}

export class DataCollector {
    constructor(options = {}) {
        this.cryptos = options.cryptos || ['BTC'];
        this.onTick = options.onTick || (() => {});
        this.onWindowStart = options.onWindowStart || (() => {});
        this.onWindowEnd = options.onWindowEnd || (() => {});
        
        this.polyWs = null;
        this.binanceWs = null;
        this.running = false;
        
        // Current state
        this.markets = {};        // Active markets by crypto
        this.spotPrices = {};     // Current spot prices
        this.windowStartPrices = {}; // Spot price at window start (price_to_beat)
        this.priceToBeat = {};    // Official price to beat from market data
        this.orderBooks = {};     // Current order books
        this.reconnectAttempts = 0;
        
        // Track subscribed tokens to avoid duplicate subscriptions
        this.subscribedTokens = new Set();
        this.lastEpoch = {};      // Track last epoch per crypto for window change detection
        
        // Pricing state per crypto
        this.priceState = {};     // Tracks price movements per window
        for (const crypto of this.cryptos) {
            this.priceState[crypto] = {
                windowEpoch: null,
                priceToBeat: null,
                priceAtWindowStart: null,
                currentPrice: null,
                highPrice: null,
                lowPrice: null,
                priceHistory: [],
                upPriceHistory: [],
                lastUpdate: null
            };
        }
    }
    
    async start() {
        console.log(`📡 Starting data collector for: ${this.cryptos.join(', ')}`);
        this.running = true;
        
        // Connect to data streams FIRST so we have Binance prices
        await this.connectBinance();
        
        // Wait a moment for initial spot prices
        await new Promise(r => setTimeout(r, 2000));
        
        // Discover current 15-minute markets
        await this.discoverMarkets();
        
        // Connect to Polymarket with discovered markets
        await this.connectPolymarket();
        
        // Refresh markets frequently to catch window changes (every 10 seconds)
        this.marketRefreshInterval = setInterval(() => {
            this.checkWindowChange();
        }, 10000);
        
        // Refresh prices from API for markets without CLOB data (every 5 seconds)
        this.priceRefreshInterval = setInterval(() => {
            this.refreshPricesFromAPI();
        }, 5000);
        
        // Generate ticks every second
        this.tickInterval = setInterval(() => {
            this.generateTicks();
        }, 1000);
    }
    
    /**
     * Refresh prices from REST API for markets without active CLOB data
     */
    async refreshPricesFromAPI() {
        for (const crypto of this.cryptos) {
            const book = this.orderBooks[crypto];
            // If no CLOB data or data is from API (needs refresh)
            if (!book?.up || book.up.source === 'api') {
                const prices = await this.fetchMarketPrices(crypto);
                if (prices && prices.upPrice > 0 && prices.upPrice < 1) {
                    if (!this.orderBooks[crypto]) {
                        this.orderBooks[crypto] = {};
                    }
                    this.orderBooks[crypto].up = {
                        bestBid: Math.max(0.01, prices.upPrice - 0.005),
                        bestAsk: Math.min(0.99, prices.upPrice + 0.005),
                        midpoint: prices.upPrice,
                        spread: 0.01,
                        source: 'api',
                        timestamp: Date.now()
                    };
                }
            }
        }
    }
    
    /**
     * Check if any windows have changed and refresh if needed
     */
    async checkWindowChange() {
        const now = Math.floor(Date.now() / 1000);
        const currentEpoch = Math.floor(now / 900) * 900;
        
        let needsRefresh = false;
        
        for (const crypto of this.cryptos) {
            const market = this.markets[crypto];
            if (!market || market.epoch !== currentEpoch) {
                if (market && market.epoch !== currentEpoch) {
                    console.log(`\n🔄 Window change detected: ${crypto} ${market?.epoch} -> ${currentEpoch}`);
                    
                    // Clear old order book data
                    delete this.orderBooks[crypto];
                    
                    // Clear subscribed tokens for this market
                    if (market?.clobTokenIds) {
                        const oldTokens = typeof market.clobTokenIds === 'string' 
                            ? JSON.parse(market.clobTokenIds) 
                            : market.clobTokenIds;
                        oldTokens.forEach(t => this.subscribedTokens.delete(t));
                    }
                }
                needsRefresh = true;
            }
        }
        
        if (needsRefresh) {
            await this.discoverMarkets();
        }
    }
    
    async stop() {
        this.running = false;
        
        if (this.marketRefreshInterval) {
            clearInterval(this.marketRefreshInterval);
        }
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
        }
        if (this.priceRefreshInterval) {
            clearInterval(this.priceRefreshInterval);
        }
        
        if (this.polyWs) {
            this.polyWs.close();
        }
        if (this.binanceWs) {
            this.binanceWs.close();
        }
        
        // Clear state
        this.subscribedTokens.clear();
        
        console.log('📡 Data collector stopped');
    }
    
    /**
     * Discover current 15-minute markets for each crypto
     * 
     * IMPORTANT: Each market has a "price to beat" which is the spot price
     * at the START of the 15-minute window. This is what determines Up vs Down.
     */
    async discoverMarkets() {
        const now = Math.floor(Date.now() / 1000); // Convert to seconds
        const currentEpoch = Math.floor(now / 900) * 900; // 900 seconds = 15 minutes
        
        for (const crypto of this.cryptos) {
            const slug = `${crypto.toLowerCase()}-updown-15m-${currentEpoch}`;
            
            try {
                const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);
                
                if (response.data && response.data.length > 0) {
                    const market = response.data[0];
                    const wasNew = !this.markets[crypto] || this.markets[crypto].epoch !== currentEpoch;
                    
                    // Extract price to beat from market description or title
                    // Format: "Ethereum Up or Down January 19, 12-12:15AM ET" with priceToBeat
                    let priceToBeat = this.extractPriceToBeat(market, crypto);
                    
                    if (wasNew) {
                        const config = CRYPTO_CONFIG[crypto] || { priceDecimals: 2 };
                        const priceStr = priceToBeat 
                            ? `$${priceToBeat.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals })}`
                            : 'unknown';
                        console.log(`   ✅ Found ${crypto} market (price to beat: ${priceStr})`);
                    }
                    
                    this.markets[crypto] = {
                        ...market,
                        epoch: currentEpoch,
                        windowStart: currentEpoch * 1000,
                        windowEnd: (currentEpoch + 900) * 1000,
                        priceToBeat: priceToBeat
                    };
                    
                    // Initialize price state for new window
                    if (wasNew) {
                        // Reset price state for new window
                        const currentSpot = this.spotPrices[crypto];
                        this.priceState[crypto] = {
                            windowEpoch: currentEpoch,
                            priceToBeat: priceToBeat || currentSpot,
                            priceAtWindowStart: currentSpot,
                            currentPrice: currentSpot,
                            highPrice: currentSpot,
                            lowPrice: currentSpot,
                            priceHistory: currentSpot ? [{ time: Date.now(), price: currentSpot }] : [],
                            upPriceHistory: [],
                            lastUpdate: Date.now()
                        };
                        
                        this.windowStartPrices[crypto] = priceToBeat || currentSpot;
                        this.priceToBeat[crypto] = priceToBeat;
                        
                        // Clear old order book for fresh data
                        delete this.orderBooks[crypto];
                        
                        this.onWindowStart({
                            crypto,
                            epoch: currentEpoch,
                            market,
                            priceToBeat: priceToBeat,
                            startPrice: currentSpot
                        });
                        
                        // Force subscribe to new market tokens
                        this.subscribeToMarket(market);
                    } else {
                        // Even if not new, ensure we're subscribed
                        this.subscribeToMarket(market);
                    }
                }
            } catch (e) {
                // Market might not exist yet - this is normal before window starts
            }
        }
    }
    
    /**
     * Extract price to beat from market data
     * 
     * Polymarket includes this in the market description or we calculate from outcomes
     */
    extractPriceToBeat(market, crypto) {
        // Method 1: Check market description for price reference
        const description = market.description || '';
        const question = market.question || '';
        
        // Look for price patterns like "$3,211.19" or "3211.19"
        const pricePatterns = [
            /\$([0-9,]+\.?\d*)/,           // $3,211.19
            /price.*?([0-9,]+\.?\d*)/i,    // price of 3211.19
            /beat.*?([0-9,]+\.?\d*)/i,     // beat 3211.19
            /above.*?([0-9,]+\.?\d*)/i     // above 3211.19
        ];
        
        for (const pattern of pricePatterns) {
            const match = description.match(pattern) || question.match(pattern);
            if (match) {
                const price = parseFloat(match[1].replace(/,/g, ''));
                if (price > 0) {
                    return price;
                }
            }
        }
        
        // Method 2: Try to get from market outcomes metadata
        if (market.outcomes) {
            try {
                const outcomes = typeof market.outcomes === 'string' 
                    ? JSON.parse(market.outcomes) 
                    : market.outcomes;
                // Some markets encode price in outcome metadata
            } catch (e) {}
        }
        
        // Method 3: Use current spot price as fallback (first tick will set this)
        return this.spotPrices[crypto] || null;
    }
    
    /**
     * Connect to Binance WebSocket for spot prices
     */
    async connectBinance() {
        const streams = this.cryptos
            .filter(c => BINANCE_SYMBOLS[c])
            .map(c => `${BINANCE_SYMBOLS[c]}@ticker`)
            .join('/');
        
        if (!streams) return;
        
        const url = `${BINANCE_WS}/${streams}`;
        
        this.binanceWs = new WebSocket(url);
        
        this.binanceWs.on('open', () => {
            console.log('   ✅ Connected to Binance');
        });
        
        this.binanceWs.on('message', (data) => {
            try {
                const raw = JSON.parse(data);
                // Multi-stream format wraps in {stream, data}
                const msg = raw.data || raw;
                const symbol = msg.s?.toUpperCase() || '';
                
                // Find crypto from symbol
                const crypto = Object.entries(BINANCE_SYMBOLS)
                    .find(([_, sym]) => symbol === sym.toUpperCase())?.[0];
                
                if (crypto && msg.c) {
                    this.spotPrices[crypto] = parseFloat(msg.c);
                }
            } catch (e) {
                // Ignore parse errors
            }
        });
        
        this.binanceWs.on('close', () => {
            console.log('   ⚠️ Binance connection closed');
            if (this.running) {
                setTimeout(() => this.connectBinance(), 5000);
            }
        });
        
        this.binanceWs.on('error', (err) => {
            console.error('   ❌ Binance error:', err.message);
        });
    }
    
    /**
     * Connect to Polymarket WebSocket
     */
    async connectPolymarket() {
        this.polyWs = new WebSocket(POLYMARKET_WS);
        
        this.polyWs.on('open', () => {
            console.log('   ✅ Connected to Polymarket');
            
            // Subscribe to all known markets
            for (const crypto of this.cryptos) {
                if (this.markets[crypto]) {
                    this.subscribeToMarket(this.markets[crypto]);
                }
            }
        });
        
        this.polyWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handlePolymarketMessage(msg);
            } catch (e) {
                // Ignore parse errors
            }
        });
        
        this.polyWs.on('close', () => {
            console.log('   ⚠️ Polymarket connection closed');
            if (this.running) {
                setTimeout(() => this.connectPolymarket(), 5000);
            }
        });
        
        this.polyWs.on('error', (err) => {
            console.error('   ❌ Polymarket error:', err.message);
        });
    }
    
    /**
     * Subscribe to a Polymarket market
     */
    subscribeToMarket(market) {
        if (!this.polyWs || this.polyWs.readyState !== WebSocket.OPEN) return;
        
        // Find token IDs (UP and DOWN outcomes)
        if (market.clobTokenIds) {
            const tokenIds = typeof market.clobTokenIds === 'string'
                ? JSON.parse(market.clobTokenIds)
                : market.clobTokenIds;
            
            // Filter to only new tokens we haven't subscribed to
            const newTokens = tokenIds.filter(t => !this.subscribedTokens.has(t));
            
            if (newTokens.length > 0) {
                console.log(`   📡 Subscribing to ${newTokens.length} new tokens for ${market.slug || 'market'}`);
                this.polyWs.send(JSON.stringify({
                    assets_ids: newTokens
                }));
                
                // Track subscribed tokens
                newTokens.forEach(t => this.subscribedTokens.add(t));
            }
        }
    }
    
    /**
     * Force resubscribe to all current market tokens
     */
    resubscribeAll() {
        if (!this.polyWs || this.polyWs.readyState !== WebSocket.OPEN) return;
        
        const allTokens = [];
        for (const market of Object.values(this.markets)) {
            if (market.clobTokenIds) {
                const tokenIds = typeof market.clobTokenIds === 'string'
                    ? JSON.parse(market.clobTokenIds)
                    : market.clobTokenIds;
                allTokens.push(...tokenIds);
            }
        }
        
        if (allTokens.length > 0) {
            console.log(`   📡 Resubscribing to ${allTokens.length} tokens`);
            this.subscribedTokens.clear();
            this.polyWs.send(JSON.stringify({
                assets_ids: allTokens
            }));
            allTokens.forEach(t => this.subscribedTokens.add(t));
        }
    }
    
    /**
     * Handle Polymarket WebSocket message
     */
    handlePolymarketMessage(msg) {
        // The WebSocket returns messages directly with price_changes array
        if (msg.price_changes) {
            this.handlePriceChanges(msg.price_changes);
        } else if (msg.type === 'book') {
            this.handleOrderBook(msg.payload);
        }
    }
    
    /**
     * Handle price changes (main data format from Polymarket)
     */
    handlePriceChanges(priceChanges) {
        if (!Array.isArray(priceChanges)) return;
        
        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const bestBid = parseFloat(change.best_bid) || 0;
            const bestAsk = parseFloat(change.best_ask) || 1;
            
            // Find which crypto this belongs to
            for (const [crypto, market] of Object.entries(this.markets)) {
                if (market.clobTokenIds) {
                    const tokenIds = typeof market.clobTokenIds === 'string'
                        ? JSON.parse(market.clobTokenIds)
                        : market.clobTokenIds;
                    
                    if (tokenIds.includes(tokenId)) {
                        const isUp = tokenIds.indexOf(tokenId) === 0;
                        const key = isUp ? 'up' : 'down';
                        
                        if (!this.orderBooks[crypto]) {
                            this.orderBooks[crypto] = {};
                        }
                        
                        this.orderBooks[crypto][key] = {
                            bestBid,
                            bestAsk,
                            midpoint: (bestBid + bestAsk) / 2,
                            spread: bestAsk - bestBid,
                            lastPrice: parseFloat(change.price) || 0,
                            lastSize: parseFloat(change.size) || 0,
                            timestamp: Date.now()
                        };
                        
                        // Log first update
                        if (!this._priceLogged) this._priceLogged = {};
                        if (!this._priceLogged[crypto + key]) {
                            console.log(`   💹 ${crypto} ${key.toUpperCase()}: bid=${bestBid.toFixed(2)} ask=${bestAsk.toFixed(2)}`);
                            this._priceLogged[crypto + key] = true;
                        }
                        
                        break;
                    }
                }
            }
        }
    }
    
    /**
     * Handle order book update (fallback)
     */
    handleOrderBook(payload) {
        // Fallback for book-type messages
        const tokenId = payload.market || payload.asset_id;
        
        for (const [crypto, market] of Object.entries(this.markets)) {
            if (market.clobTokenIds) {
                const tokenIds = typeof market.clobTokenIds === 'string'
                    ? JSON.parse(market.clobTokenIds)
                    : market.clobTokenIds;
                
                if (tokenIds.includes(tokenId)) {
                    const isUp = tokenIds.indexOf(tokenId) === 0;
                    const key = isUp ? 'up' : 'down';
                    
                    if (!this.orderBooks[crypto]) {
                        this.orderBooks[crypto] = {};
                    }
                    
                    const bids = payload.bids || [];
                    const asks = payload.asks || [];
                    const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
                    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
                    
                    this.orderBooks[crypto][key] = {
                        bestBid,
                        bestAsk,
                        midpoint: (bestBid + bestAsk) / 2,
                        spread: bestAsk - bestBid,
                        timestamp: Date.now()
                    };
                    
                    break;
                }
            }
        }
    }
    
    /**
     * Fetch prices from REST API as fallback for markets without CLOB data
     */
    async fetchMarketPrices(crypto) {
        const market = this.markets[crypto];
        if (!market) return null;
        
        try {
            const response = await axios.get(`${GAMMA_API}/markets?slug=${market.slug}`);
            if (response.data && response.data.length > 0) {
                const data = response.data[0];
                const prices = JSON.parse(data.outcomePrices || '["0.5", "0.5"]');
                return {
                    upPrice: parseFloat(prices[0]),
                    downPrice: parseFloat(prices[1]),
                    source: 'api'
                };
            }
        } catch (e) {
            // Ignore errors
        }
        return null;
    }
    
    /**
     * Generate tick for each crypto with rigorous price tracking
     */
    generateTicks() {
        const now = Date.now();
        
        for (const crypto of this.cryptos) {
            const market = this.markets[crypto];
            const spot = this.spotPrices[crypto];
            const book = this.orderBooks[crypto];
            const state = this.priceState[crypto];
            const config = CRYPTO_CONFIG[crypto] || { priceDecimals: 2 };
            
            // Debug: log if missing data (only once per crypto)
            if (!this._debugLogged) this._debugLogged = {};
            if (!this._debugLogged[crypto] && (!market || !spot)) {
                console.log(`   📊 ${crypto}: market=${!!market}, spot=${spot || 'none'}`);
                if (market && spot) this._debugLogged[crypto] = true;
            }
            
            if (!market || !spot) continue;
            
            // If no order book data after 5 seconds, try REST API fallback
            if (!book?.up && !this._apiFallbackAttempted?.[crypto]) {
                this._apiFallbackAttempted = this._apiFallbackAttempted || {};
                this._apiFallbackAttempted[crypto] = true;
                this.fetchMarketPrices(crypto).then(prices => {
                    if (prices && prices.upPrice > 0 && prices.upPrice < 1) {
                        if (!this.orderBooks[crypto]) {
                            this.orderBooks[crypto] = {};
                        }
                        this.orderBooks[crypto].up = {
                            bestBid: prices.upPrice - 0.005,  // Estimate spread
                            bestAsk: prices.upPrice + 0.005,
                            midpoint: prices.upPrice,
                            spread: 0.01,
                            source: 'api'
                        };
                        console.log(`   📊 ${crypto} prices from API: up=${prices.upPrice.toFixed(3)}`);
                    }
                });
            }
            
            // Calculate time remaining
            const timeRemaining = Math.max(0, Math.floor((market.windowEnd - now) / 1000));
            
            // Check for window end
            if (timeRemaining <= 0) {
                // CRITICAL FIX (Jan 29 2026): Don't calculate outcome from spot price!
                // Polymarket resolves based on Chainlink, not Binance/Pyth.
                // Use market sentiment (upMid) as preliminary - it reflects market's view
                // of resolution, which is informed by Chainlink.
                const marketPrediction = book?.up?.midpoint >= 0.5 ? 'up' : 'down';

                const windowInfo = {
                    crypto,
                    epoch: market.epoch,
                    market,
                    priceToBeat: state.priceToBeat,
                    finalPrice: spot,
                    // Use market's prediction as preliminary outcome
                    // (Market makers have Chainlink data, so this is more accurate than our spot)
                    outcome: marketPrediction,
                    // Also pass our spot-based calculation for comparison
                    spotBasedOutcome: spot >= state.priceToBeat ? 'up' : 'down',
                    finalUpMid: book?.up?.midpoint || 0.5
                };

                this.onWindowEnd(windowInfo);

                // ASYNC: Fetch actual resolution from Polymarket API (ground truth)
                // This happens after a delay since resolution takes time to propagate
                setTimeout(async () => {
                    const actualOutcome = await fetchActualResolution(crypto, market.epoch);
                    if (actualOutcome) {
                        const matched = actualOutcome === marketPrediction;
                        const spotMatched = actualOutcome === windowInfo.spotBasedOutcome;
                        if (!matched || !spotMatched) {
                            console.log(`[DataCollector] RESOLUTION TRUTH: ${crypto} epoch=${market.epoch}`);
                            console.log(`   Actual (Polymarket API): ${actualOutcome.toUpperCase()}`);
                            console.log(`   Market prediction: ${marketPrediction.toUpperCase()} ${matched ? '✓' : '✗'}`);
                            console.log(`   Spot-based (old): ${windowInfo.spotBasedOutcome.toUpperCase()} ${spotMatched ? '✓' : '✗'}`);
                        }
                    }
                }, 30000); // Check 30s after window end

                continue;
            }
            
            // Calculate prices from order book
            let upMid = 0.5;
            let spread = 0;
            let bestBid = 0;
            let bestAsk = 1;
            
            if (book?.up) {
                bestBid = book.up.bestBid || 0;
                bestAsk = book.up.bestAsk || 1;
                upMid = book.up.midpoint || (bestBid + bestAsk) / 2;
                spread = book.up.spread || (bestAsk - bestBid);
            }
            
            // RIGOROUS PRICE TRACKING
            // Use official price_to_beat from market, fall back to first spot price
            let priceToBeat = market.priceToBeat || state.priceToBeat || this.windowStartPrices[crypto];
            
            // If we still don't have a price to beat, set it now
            if (!priceToBeat) {
                priceToBeat = spot;
                this.windowStartPrices[crypto] = spot;
                state.priceToBeat = spot;
                state.priceAtWindowStart = spot;
                console.log(`   📍 ${crypto} price to beat set: $${spot.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals })}`);
            }
            
            // Update price state
            state.currentPrice = spot;
            state.highPrice = Math.max(state.highPrice || spot, spot);
            state.lowPrice = Math.min(state.lowPrice || spot, spot);
            state.lastUpdate = now;
            
            // Keep last 60 price points (1 minute at 1/sec)
            state.priceHistory.push({ time: now, price: spot });
            if (state.priceHistory.length > 60) state.priceHistory.shift();
            
            // Track up price history
            state.upPriceHistory.push({ time: now, price: upMid });
            if (state.upPriceHistory.length > 60) state.upPriceHistory.shift();
            
            // Calculate spot delta from price_to_beat
            const spotDelta = spot - priceToBeat;
            const spotDeltaPct = priceToBeat > 0 ? (spotDelta / priceToBeat) : 0;
            
            const tick = {
                crypto,
                timestamp: now,
                epoch: market.epoch,
                time_remaining_sec: timeRemaining,
                
                // Polymarket data
                up_mid: upMid,
                down_mid: 1 - upMid,
                up_bid: bestBid,
                up_ask: bestAsk,
                spread: spread,
                spread_pct: spread,
                
                // Binance spot data - RIGOROUS
                spot_price: spot,
                price_to_beat: priceToBeat,           // Official price to beat
                window_start_price: priceToBeat,      // Alias for compatibility
                spot_delta: spotDelta,                // Absolute delta
                spot_delta_pct: spotDeltaPct,         // Percentage delta
                
                // Price range in this window
                high_price: state.highPrice,
                low_price: state.lowPrice,
                
                // Implied direction from spot
                implied_direction: spot >= priceToBeat ? 'up' : 'down',
                
                // Last trade info
                last_price: book?.up?.lastPrice || 0,
                last_size: book?.up?.lastSize || 0
            };
            
            // Log first tick for each crypto with proper formatting
            if (!this._tickLogged) this._tickLogged = {};
            if (!this._tickLogged[crypto]) {
                const spotStr = spot.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals });
                const ptbStr = priceToBeat.toLocaleString(undefined, { minimumFractionDigits: config.priceDecimals });
                const deltaStr = (spotDeltaPct * 100).toFixed(4);
                console.log(`   📈 ${crypto}: spot=$${spotStr}, ptb=$${ptbStr}, Δ=${deltaStr}%, up=${upMid.toFixed(2)}`);
                this._tickLogged[crypto] = true;
            }
            
            this.onTick(tick);
        }
    }
    
    /**
     * Get current price state for a crypto
     */
    getPriceState(crypto) {
        return this.priceState[crypto] || null;
    }
    
    /**
     * Get all price states
     */
    getAllPriceStates() {
        return { ...this.priceState };
    }
}

export { CRYPTO_CONFIG };

export default DataCollector;

