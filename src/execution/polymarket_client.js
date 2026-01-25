/**
 * Polymarket CLOB API Client
 * 
 * Production-grade client for executing real trades on Polymarket.
 * Handles authentication, order signing, and API communication.
 * 
 * CRITICAL: This handles real money. Every operation is logged and verified.
 */

import { ethers } from 'ethers';
import crypto from 'crypto';

// API Endpoints
const ENDPOINTS = {
    REST: 'https://clob.polymarket.com',
    WS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    GAMMA: 'https://gamma-api.polymarket.com'
};

// Polygon chain ID
const CHAIN_ID = 137;

// EIP-712 Domain for order signing
const EIP712_DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: CHAIN_ID
};

// Order types for EIP-712
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' }
    ]
};

/**
 * Side enum matching Polymarket's API
 */
export const Side = {
    BUY: 0,
    SELL: 1
};

/**
 * Order type enum
 */
export const OrderType = {
    GTC: 'GTC',     // Good till cancelled
    GTD: 'GTD',     // Good till date
    FOK: 'FOK',     // Fill or kill
    IOC: 'IOC'      // Immediate or cancel
};

/**
 * Main Polymarket Client
 */
export class PolymarketClient {
    constructor(config) {
        this.validateConfig(config);
        
        // API credentials from Polymarket UI
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.passphrase = config.passphrase;
        
        // Wallet for signing orders
        this.privateKey = config.privateKey;
        this.wallet = new ethers.Wallet(config.privateKey);
        this.address = this.wallet.address;
        
        // Funder address (your Polymarket profile address)
        this.funder = config.funder || this.address;
        
        // Signature type (0 = EOA, 1 = Poly Proxy, 2 = Gnosis Safe)
        this.signatureType = config.signatureType || 0;
        
        // Rate limiting
        this.lastRequestTime = 0;
        this.minRequestInterval = 100; // 100ms between requests
        
        // Request tracking for debugging
        this.requestId = 0;
        
        // Logging
        this.logger = config.logger || console;
        
        this.logger.log(`[PolymarketClient] Initialized for address: ${this.address}`);
        this.logger.log(`[PolymarketClient] Funder: ${this.funder}`);
    }
    
    /**
     * Validate required config
     */
    validateConfig(config) {
        const required = ['apiKey', 'apiSecret', 'passphrase', 'privateKey'];
        for (const field of required) {
            if (!config[field]) {
                throw new Error(`Missing required config: ${field}`);
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Generate HMAC signature for L2 (authenticated) requests
     */
    generateL2Signature(method, path, timestamp, body = '') {
        const message = timestamp + method.toUpperCase() + path + body;
        const hmac = crypto.createHmac('sha256', Buffer.from(this.apiSecret, 'base64'));
        hmac.update(message);
        return hmac.digest('base64');
    }
    
    /**
     * Get L2 headers for authenticated requests
     */
    getL2Headers(method, path, body = '') {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = this.generateL2Signature(method, path, timestamp, body);
        
        return {
            'POLY_ADDRESS': this.address,
            'POLY_SIGNATURE': signature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_API_KEY': this.apiKey,
            'POLY_PASSPHRASE': this.passphrase
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ORDER SIGNING (EIP-712)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Sign an order using EIP-712
     */
    async signOrder(order) {
        const signature = await this.wallet.signTypedData(
            EIP712_DOMAIN,
            ORDER_TYPES,
            order
        );
        return signature;
    }
    
    /**
     * Build and sign an order
     */
    async buildSignedOrder(params) {
        const {
            tokenId,
            price,
            size,
            side,
            expiration = 0, // 0 = no expiration
            feeRateBps = 0
        } = params;
        
        // Calculate amounts based on side
        // For BUY: makerAmount = price * size (USDC), takerAmount = size (shares)
        // For SELL: makerAmount = size (shares), takerAmount = price * size (USDC)
        
        const priceWei = BigInt(Math.floor(price * 1e6)); // USDC has 6 decimals
        const sizeWei = BigInt(Math.floor(size * 1e6));
        
        let makerAmount, takerAmount;
        if (side === Side.BUY) {
            // Buying shares: pay USDC, receive shares
            makerAmount = (priceWei * sizeWei) / BigInt(1e6);
            takerAmount = sizeWei;
        } else {
            // Selling shares: pay shares, receive USDC
            makerAmount = sizeWei;
            takerAmount = (priceWei * sizeWei) / BigInt(1e6);
        }
        
        // Generate unique salt
        const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
        
        // Get nonce from API
        const nonce = await this.getNonce();
        
        const order = {
            salt: salt.toString(),
            maker: this.funder,
            signer: this.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: tokenId,
            makerAmount: makerAmount.toString(),
            takerAmount: takerAmount.toString(),
            expiration: expiration.toString(),
            nonce: nonce.toString(),
            feeRateBps: feeRateBps.toString(),
            side: side,
            signatureType: this.signatureType
        };
        
        const signature = await this.signOrder(order);
        
        return {
            order,
            signature
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // API REQUESTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Rate-limited fetch with retries
     */
    async request(method, path, body = null, authenticated = true, retries = 3) {
        // Rate limiting
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
            await this.sleep(this.minRequestInterval - timeSinceLastRequest);
        }
        this.lastRequestTime = Date.now();
        
        const requestId = ++this.requestId;
        const url = `${ENDPOINTS.REST}${path}`;
        const bodyStr = body ? JSON.stringify(body) : '';
        
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        
        if (authenticated) {
            Object.assign(headers, this.getL2Headers(method, path, bodyStr));
        }
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                this.logger.log(`[Request #${requestId}] ${method} ${path} (attempt ${attempt})`);
                
                const response = await fetch(url, {
                    method,
                    headers,
                    body: body ? bodyStr : undefined
                });
                
                const responseText = await response.text();
                
                if (!response.ok) {
                    const error = new Error(`API Error ${response.status}: ${responseText}`);
                    error.status = response.status;
                    error.body = responseText;
                    throw error;
                }
                
                const data = responseText ? JSON.parse(responseText) : {};
                this.logger.log(`[Request #${requestId}] Success`);
                return data;
                
            } catch (error) {
                this.logger.error(`[Request #${requestId}] Error: ${error.message}`);
                
                if (attempt === retries) {
                    throw error;
                }
                
                // Exponential backoff
                const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
                this.logger.log(`[Request #${requestId}] Retrying in ${backoff}ms...`);
                await this.sleep(backoff);
            }
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get server time
     */
    async getTime() {
        return this.request('GET', '/time', null, false);
    }
    
    /**
     * Get order book for a token
     */
    async getOrderBook(tokenId) {
        return this.request('GET', `/book?token_id=${tokenId}`, null, false);
    }
    
    /**
     * Get midpoint price
     */
    async getMidpoint(tokenId) {
        return this.request('GET', `/midpoint?token_id=${tokenId}`, null, false);
    }
    
    /**
     * Get price for a side
     */
    async getPrice(tokenId, side) {
        const sideStr = side === Side.BUY ? 'buy' : 'sell';
        return this.request('GET', `/price?token_id=${tokenId}&side=${sideStr}`, null, false);
    }
    
    /**
     * Get spread
     */
    async getSpread(tokenId) {
        return this.request('GET', `/spread?token_id=${tokenId}`, null, false);
    }
    
    /**
     * Get tick size for a token
     */
    async getTickSize(tokenId) {
        return this.request('GET', `/tick-size?token_id=${tokenId}`, null, false);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATED ENDPOINTS (L2)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get current nonce
     */
    async getNonce() {
        const response = await this.request('GET', '/nonce');
        return BigInt(response.nonce || '0');
    }
    
    /**
     * Get API key info
     */
    async getApiKeyInfo() {
        return this.request('GET', '/auth/api-key');
    }
    
    /**
     * Get open orders
     */
    async getOpenOrders(market = null) {
        let path = '/orders?open=true';
        if (market) {
            path += `&market=${market}`;
        }
        return this.request('GET', path);
    }
    
    /**
     * Get order by ID
     */
    async getOrder(orderId) {
        return this.request('GET', `/order/${orderId}`);
    }
    
    /**
     * Get trade history
     */
    async getTrades(limit = 100) {
        return this.request('GET', `/trades?limit=${limit}`);
    }
    
    /**
     * Get positions/balances
     */
    async getBalances() {
        return this.request('GET', '/balances');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ORDER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Place a new order
     * 
     * @param {Object} params - Order parameters
     * @param {string} params.tokenId - Token ID to trade
     * @param {number} params.price - Price (0-1 for binary markets)
     * @param {number} params.size - Size in USD
     * @param {number} params.side - Side.BUY or Side.SELL
     * @param {string} params.orderType - OrderType.GTC, GTD, FOK, IOC
     * @param {Object} options - Additional options
     * @returns {Object} Order response
     */
    async placeOrder(params, options = {}) {
        const { tokenId, price, size, side, orderType = OrderType.GTC } = params;
        
        // Validate inputs
        if (price < 0.01 || price > 0.99) {
            throw new Error(`Invalid price: ${price}. Must be between 0.01 and 0.99`);
        }
        if (size < 0.1) {
            throw new Error(`Invalid size: ${size}. Minimum is $0.10`);
        }
        
        this.logger.log(`[PlaceOrder] ${side === Side.BUY ? 'BUY' : 'SELL'} ${size} @ ${price}`);
        this.logger.log(`[PlaceOrder] Token: ${tokenId}`);
        
        // Get tick size for proper price rounding
        let tickSize = options.tickSize || '0.01';
        try {
            const tickInfo = await this.getTickSize(tokenId);
            tickSize = tickInfo.minimum_tick_size || tickSize;
        } catch (e) {
            this.logger.warn(`[PlaceOrder] Could not fetch tick size, using default: ${tickSize}`);
        }
        
        // Round price to tick size
        const tickSizeNum = parseFloat(tickSize);
        const roundedPrice = Math.round(price / tickSizeNum) * tickSizeNum;
        
        // Build and sign the order
        const { order, signature } = await this.buildSignedOrder({
            tokenId,
            price: roundedPrice,
            size,
            side
        });
        
        // Prepare API request body
        const requestBody = {
            order: {
                salt: order.salt,
                maker: order.maker,
                signer: order.signer,
                taker: order.taker,
                tokenId: order.tokenId,
                makerAmount: order.makerAmount,
                takerAmount: order.takerAmount,
                expiration: order.expiration,
                nonce: order.nonce,
                feeRateBps: order.feeRateBps,
                side: order.side === Side.BUY ? 'BUY' : 'SELL',
                signatureType: order.signatureType
            },
            signature,
            owner: this.funder,
            orderType
        };
        
        const response = await this.request('POST', '/order', requestBody);
        
        this.logger.log(`[PlaceOrder] Success! Order ID: ${response.orderID || response.order_id}`);
        
        return {
            orderId: response.orderID || response.order_id,
            status: response.status,
            ...response
        };
    }
    
    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        this.logger.log(`[CancelOrder] Cancelling order: ${orderId}`);
        
        const response = await this.request('DELETE', `/order/${orderId}`);
        
        this.logger.log(`[CancelOrder] Success`);
        return response;
    }
    
    /**
     * Cancel all orders (optionally for a specific market)
     */
    async cancelAllOrders(market = null) {
        this.logger.log(`[CancelAllOrders] Cancelling all orders${market ? ` for market ${market}` : ''}`);
        
        let path = '/orders';
        if (market) {
            path += `?market=${market}`;
        }
        
        const response = await this.request('DELETE', path);
        
        this.logger.log(`[CancelAllOrders] Success`);
        return response;
    }
    
    /**
     * Create a market order (IOC at best price)
     * This is the most common order type for immediate execution
     */
    async marketOrder(tokenId, side, size) {
        // Get current price
        const book = await this.getOrderBook(tokenId);
        
        let price;
        if (side === Side.BUY) {
            // Buy at lowest ask + buffer for slippage
            const asks = book.asks || [];
            if (asks.length === 0) {
                throw new Error('No asks available in order book');
            }
            const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
            price = Math.min(bestAsk + 0.01, 0.99); // Add 1 cent buffer
        } else {
            // Sell at highest bid - buffer for slippage
            const bids = book.bids || [];
            if (bids.length === 0) {
                throw new Error('No bids available in order book');
            }
            const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
            price = Math.max(bestBid - 0.01, 0.01); // Subtract 1 cent buffer
        }
        
        this.logger.log(`[MarketOrder] Executing market ${side === Side.BUY ? 'BUY' : 'SELL'} at ${price}`);
        
        return this.placeOrder({
            tokenId,
            price,
            size,
            side,
            orderType: OrderType.FOK // Fill or Kill for market orders
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MARKET DATA HELPERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get market info from Gamma API
     */
    async getMarketBySlug(slug) {
        const response = await fetch(`${ENDPOINTS.GAMMA}/markets?slug=${slug}`);
        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            throw new Error(`Market not found: ${slug}`);
        }
        
        const market = markets[0];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        
        return {
            id: market.id,
            slug: market.slug,
            question: market.question,
            upTokenId: tokenIds[0],
            downTokenId: tokenIds[1],
            endDate: new Date(market.endDate),
            active: market.active
        };
    }
    
    /**
     * Get current 15-minute crypto market
     */
    async getCurrentCryptoMarket(crypto = 'btc') {
        const now = Math.floor(Date.now() / 1000);
        const epoch = Math.floor(now / 900) * 900;
        const slug = `${crypto}-updown-15m-${epoch}`;
        
        return this.getMarketBySlug(slug);
    }
}

/**
 * Create client from environment variables
 */
export function createClientFromEnv() {
    const required = [
        'POLYMARKET_API_KEY',
        'POLYMARKET_SECRET',
        'POLYMARKET_PASSPHRASE'
    ];
    
    for (const key of required) {
        if (!process.env[key]) {
            throw new Error(`Missing environment variable: ${key}`);
        }
    }
    
    // Private key is optional if using API-only mode
    if (!process.env.POLYMARKET_PRIVATE_KEY) {
        console.warn('[PolymarketClient] No POLYMARKET_PRIVATE_KEY - some features may not work');
    }
    
    return new PolymarketClient({
        apiKey: process.env.POLYMARKET_API_KEY,
        apiSecret: process.env.POLYMARKET_SECRET,
        passphrase: process.env.POLYMARKET_PASSPHRASE,
        privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
        funder: process.env.POLYMARKET_FUNDER_ADDRESS,
        signatureType: process.env.POLYMARKET_PRIVATE_KEY ? 0 : 1  // 0=EOA, 1=PolyProxy
    });
}

export { ENDPOINTS, CHAIN_ID };
export default PolymarketClient;
