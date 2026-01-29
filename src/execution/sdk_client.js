/**
 * Polymarket SDK Client Wrapper
 * 
 * Production-tested wrapper around @polymarket/clob-client.
 * Incorporates all learnings from live trading.
 * 
 * Key fixes applied:
 * - ethers v6 compatibility (_signTypedData wrapper)
 * - Signature type 2 for proxy wallets
 * - Credential derivation from wallet
 * - Proper balance handling (micro-units)
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

// Constants
const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA_API = 'https://gamma-api.polymarket.com';

/**
 * Create ethers v6 compatible wallet for SDK
 * The SDK expects ethers v5's _signTypedData method
 */
function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = async (domain, types, value) => {
        return wallet.signTypedData(domain, types, value);
    };
    return wallet;
}

/**
 * SDK Client Wrapper
 */
export class SDKClient {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.client = null;
        this.wallet = null;
        this.funder = null;
        this.ready = false;
    }
    
    /**
     * Initialize the client
     * Call this before any operations
     */
    async initialize() {
        const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
        const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
        
        if (!privateKey) {
            throw new Error('POLYMARKET_PRIVATE_KEY not set');
        }
        if (!funder) {
            throw new Error('POLYMARKET_FUNDER_ADDRESS not set');
        }
        
        this.logger.log('[SDKClient] Initializing...');
        
        // Create v6-compatible wallet
        this.wallet = createCompatibleWallet(privateKey);
        this.funder = funder;
        
        this.logger.log(`[SDKClient] Signer: ${this.wallet.address}`);
        this.logger.log(`[SDKClient] Funder: ${this.funder}`);
        
        // Derive API credentials from wallet
        this.logger.log('[SDKClient] Deriving API credentials...');
        const baseClient = new ClobClient(HOST, CHAIN_ID, this.wallet);
        const creds = await baseClient.deriveApiKey();
        
        // Create authenticated client with signature type 2
        this.client = new ClobClient(
            HOST,
            CHAIN_ID,
            this.wallet,
            creds,
            2,          // Signature type 2 for proxy wallets
            this.funder
        );

        // Note: CONDITIONAL token allowance must be set per-token before selling
        // This is handled in the sell() method for each specific token

        this.ready = true;
        this.logger.log('[SDKClient] Ready');

        return this;
    }
    
    /**
     * Ensure client is initialized
     */
    ensureReady() {
        if (!this.ready) {
            throw new Error('SDKClient not initialized. Call initialize() first.');
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MARKET DATA
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get current 15-minute market for a crypto
     */
    async getCurrentMarket(crypto = 'btc') {
        const now = Math.floor(Date.now() / 1000);
        const epoch = Math.floor(now / 900) * 900;
        const slug = `${crypto}-updown-15m-${epoch}`;
        
        const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            throw new Error(`Market not found: ${slug}`);
        }
        
        const market = markets[0];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const endDate = new Date(market.endDate);
        
        return {
            slug,
            upTokenId: tokenIds[0],
            downTokenId: tokenIds[1],
            endDate,
            timeRemaining: Math.max(0, (endDate.getTime() - Date.now()) / 1000),
            epoch
        };
    }
    
    /**
     * Get order book for a token
     */
    async getOrderBook(tokenId) {
        this.ensureReady();
        return this.client.getOrderBook(tokenId);
    }
    
    /**
     * Get best bid/ask for a token
     */
    async getBestPrices(tokenId) {
        this.ensureReady();
        const book = await this.client.getOrderBook(tokenId);
        const bids = book.bids || [];
        const asks = book.asks || [];
        
        const bestBid = bids.length > 0 
            ? Math.max(...bids.map(b => parseFloat(b.price))) 
            : 0;
        const bestAsk = asks.length > 0 
            ? Math.min(...asks.map(a => parseFloat(a.price))) 
            : 1;
        
        return {
            bid: bestBid,
            ask: bestAsk,
            spread: bestAsk - bestBid,
            midpoint: (bestBid + bestAsk) / 2
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BALANCE & POSITIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get balance for a token (in shares, not micro-units)
     */
    async getBalance(tokenId) {
        this.ensureReady();
        try {
            const bal = await this.client.getBalanceAllowance({ 
                asset_type: 'CONDITIONAL', 
                token_id: tokenId 
            });
            return parseFloat(bal.balance) / 1_000_000;
        } catch (e) {
            return 0;
        }
    }
    
    /**
     * Get USDC balance
     */
    async getUSDCBalance() {
        this.ensureReady();
        try {
            const bal = await this.client.getBalanceAllowance({ 
                asset_type: 'COLLATERAL'
            });
            return parseFloat(bal.balance) / 1_000_000;
        } catch (e) {
            return 0;
        }
    }
    
    /**
     * Get all open orders
     */
    async getOpenOrders() {
        this.ensureReady();
        return this.client.getOpenOrders();
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ORDER EXECUTION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Place a buy order
     * @param {string} tokenId - Token to buy
     * @param {number} dollars - Dollar amount to spend
     * @param {number} price - Price per share (0.01-0.99)
     * @param {string} orderType - GTC, FOK, IOC
     * @returns Order result
     */
    async buy(tokenId, dollars, price, orderType = 'GTC') {
        this.ensureReady();
        
        // Calculate shares to buy
        const shares = Math.ceil(dollars / price);
        const actualCost = shares * price;
        
        // Validate minimum order
        if (actualCost < 1.0) {
            throw new Error(`Order too small: $${actualCost.toFixed(2)} < $1 minimum`);
        }
        
        this.logger.log(`[SDKClient] BUY ${shares} shares @ $${price.toFixed(4)} = $${actualCost.toFixed(2)}`);
        
        try {
            const order = await this.client.createAndPostOrder({
                tokenID: tokenId,
                price: price,
                side: 'BUY',
                size: shares
            }, {
                tickSize: '0.01',
                negRisk: false
            }, orderType);
            
            // MULTI-FACTOR FILL VERIFICATION
            // Factor 1: Must have transaction hash (proves on-chain execution)
            const hasTxHash = order?.transactionsHashes?.length > 0;
            // Factor 2: Must have success flag
            const hasSuccess = order?.success === true;
            // Factor 3: Status should be matched or live
            const hasGoodStatus = order?.status === 'matched' || order?.status === 'live';
            
            // ALL factors must pass for a confirmed fill
            const filled = hasTxHash && hasSuccess && hasGoodStatus;
            
            this.logger.log(`[SDKClient] Order ${order?.orderID}: status=${order?.status}, hasTx=${hasTxHash}, success=${hasSuccess} → FILLED=${filled}`);
            
            if (!filled && order?.orderID) {
                this.logger.warn(`[SDKClient] ⚠️ ORDER NOT FILLED: ${order?.orderID} (status=${order?.status}, hasTx=${hasTxHash}, success=${hasSuccess})`);
            }
            
            // Extract actual fill price from order response if available
            // Polymarket FOK orders can get price improvement (fill at better than requested)
            // The API may return: takingAmount, makingAmount, or fills array
            let actualFillPrice = price; // Default to requested price
            let fillDetails = null;

            if (order) {
                // Log raw response for debugging
                this.logger.log(`[SDKClient] RAW ORDER RESPONSE: ${JSON.stringify(order)}`);

                // Try to extract actual fill price from various possible fields
                if (order.avgPrice) {
                    actualFillPrice = parseFloat(order.avgPrice);
                    fillDetails = { source: 'avgPrice' };
                } else if (order.takingAmount && order.makingAmount) {
                    // takingAmount is what we paid, makingAmount is shares we got
                    const taking = parseFloat(order.takingAmount) / 1_000_000; // USDC has 6 decimals
                    const making = parseFloat(order.makingAmount) / 1_000_000;
                    if (making > 0) {
                        actualFillPrice = taking / making;
                        fillDetails = { source: 'takingAmount/makingAmount', taking, making };
                    }
                } else if (order.fills && order.fills.length > 0) {
                    // Average across all fills
                    let totalCost = 0;
                    let totalShares = 0;
                    for (const fill of order.fills) {
                        totalCost += parseFloat(fill.price || 0) * parseFloat(fill.size || 0);
                        totalShares += parseFloat(fill.size || 0);
                    }
                    if (totalShares > 0) {
                        actualFillPrice = totalCost / totalShares;
                        fillDetails = { source: 'fills', numFills: order.fills.length };
                    }
                }

                if (fillDetails && actualFillPrice !== price) {
                    const improvement = (price - actualFillPrice) * 100; // in cents
                    this.logger.log(`[SDKClient] 💰 PRICE IMPROVEMENT: Requested ${price.toFixed(4)} → Filled ${actualFillPrice.toFixed(4)} (${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}¢)`);
                }
            }

            return {
                orderId: order?.orderID,
                status: order?.status || 'killed',
                shares: filled ? shares : 0,
                sharesRequested: shares,  // What we calculated and sent
                price: price,
                priceRequested: price,    // What price we sent to API
                priceFilled: filled ? actualFillPrice : null,  // Actual execution price
                cost: filled ? actualCost : 0,
                value: filled ? (actualFillPrice * shares) : 0,  // Use actual fill price for value
                avgPrice: filled ? actualFillPrice : price,  // Actual fill price (for compatibility)
                filled: filled,
                tx: order?.transactionsHashes?.[0] || null,
                txHashes: order?.transactionsHashes || [],
                success: order?.success,
                fillDetails,  // Debug info about how we determined fill price
                raw: order
            };
        } catch (error) {
            // FOK orders that can't fill throw an error
            this.logger.warn(`[SDKClient] BUY failed: ${error.message}`);
            return {
                orderId: null,
                status: 'killed',
                shares: 0,
                price: price,
                cost: 0,
                filled: false,
                error: error.message,
                raw: null
            };
        }
    }
    
    /**
     * Place a sell order
     * @param {string} tokenId - Token to sell
     * @param {number} shares - Number of shares to sell (will be floored)
     * @param {number} price - Price per share
     * @param {string} orderType - GTC, FOK, IOC
     * @returns Order result
     */
    async sell(tokenId, shares, price, orderType = 'GTC') {
        this.ensureReady();

        // Floor shares to avoid selling more than we have
        const actualShares = Math.floor(shares);
        const expectedValue = actualShares * price;

        if (actualShares < 1) {
            throw new Error(`Not enough shares: ${shares} < 1`);
        }

        // Validate minimum order
        if (expectedValue < 1.0) {
            throw new Error(`Order too small: $${expectedValue.toFixed(2)} < $1 minimum`);
        }

        // CRITICAL: Approve this specific token for selling BEFORE attempting sell
        // This prevents "not enough balance / allowance" errors
        try {
            this.logger.log(`[SDKClient] Setting allowance for token ${tokenId.slice(0, 10)}...`);
            await this.client.updateBalanceAllowance({
                asset_type: 'CONDITIONAL',
                token_id: tokenId
            });
            this.logger.log(`[SDKClient] ✅ Token allowance set`);
        } catch (e) {
            // Log but continue - might already be approved or might work anyway
            this.logger.warn(`[SDKClient] ⚠️ Allowance setup issue: ${e.message?.slice(0, 100)}`);
        }

        this.logger.log(`[SDKClient] SELL ${actualShares} shares @ $${price.toFixed(4)} = $${expectedValue.toFixed(2)}`);

        try {
            const order = await this.client.createAndPostOrder({
                tokenID: tokenId,
                price: price,
                side: 'SELL',
                size: actualShares
            }, {
                tickSize: '0.01',
                negRisk: false
            }, orderType);
            
            // MULTI-FACTOR FILL VERIFICATION (same as buy)
            const hasTxHash = order?.transactionsHashes?.length > 0;
            const hasSuccess = order?.success === true;
            const hasGoodStatus = order?.status === 'matched' || order?.status === 'live';
            const filled = hasTxHash && hasSuccess && hasGoodStatus;
            
            this.logger.log(`[SDKClient] Order ${order?.orderID}: status=${order?.status}, hasTx=${hasTxHash}, success=${hasSuccess} → FILLED=${filled}`);

            if (!filled && order?.orderID) {
                this.logger.warn(`[SDKClient] ⚠️ SELL NOT FILLED: ${order?.orderID} (status=${order?.status}, hasTx=${hasTxHash}, success=${hasSuccess})`);
            }

            // Extract actual fill price from order response if available
            let actualFillPrice = price;
            let fillDetails = null;

            if (order && filled) {
                this.logger.log(`[SDKClient] RAW SELL RESPONSE: ${JSON.stringify(order)}`);

                if (order.avgPrice) {
                    actualFillPrice = parseFloat(order.avgPrice);
                    fillDetails = { source: 'avgPrice' };
                } else if (order.takingAmount && order.makingAmount) {
                    const taking = parseFloat(order.takingAmount) / 1_000_000;
                    const making = parseFloat(order.makingAmount) / 1_000_000;
                    if (making > 0) {
                        actualFillPrice = taking / making;
                        fillDetails = { source: 'takingAmount/makingAmount', taking, making };
                    }
                } else if (order.fills && order.fills.length > 0) {
                    let totalValue = 0;
                    let totalShares = 0;
                    for (const fill of order.fills) {
                        totalValue += parseFloat(fill.price || 0) * parseFloat(fill.size || 0);
                        totalShares += parseFloat(fill.size || 0);
                    }
                    if (totalShares > 0) {
                        actualFillPrice = totalValue / totalShares;
                        fillDetails = { source: 'fills', numFills: order.fills.length };
                    }
                }

                if (fillDetails && actualFillPrice !== price) {
                    const improvement = (actualFillPrice - price) * 100; // For sells, higher fill is better
                    this.logger.log(`[SDKClient] 💰 SELL PRICE: Requested ${price.toFixed(4)} → Filled ${actualFillPrice.toFixed(4)} (${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}¢)`);
                }
            }

            return {
                orderId: order?.orderID,
                status: order?.status || 'killed',
                shares: filled ? actualShares : 0,
                sharesRequested: actualShares,
                price: price,
                priceRequested: price,
                priceFilled: filled ? actualFillPrice : null,
                value: filled ? (actualFillPrice * actualShares) : 0,
                avgPrice: filled ? actualFillPrice : price,
                filled: filled,
                tx: order?.transactionsHashes?.[0] || null,
                txHashes: order?.transactionsHashes || [],
                success: order?.success,
                fillDetails,
                raw: order
            };
        } catch (error) {
            this.logger.warn(`[SDKClient] SELL failed: ${error.message}`);
            return {
                orderId: null,
                status: 'killed',
                shares: 0,
                price: price,
                value: 0,
                filled: false,
                error: error.message,
                raw: null
            };
        }
    }
    
    /**
     * Sell entire position for a token
     */
    async sellAll(tokenId, price) {
        const balance = await this.getBalance(tokenId);
        
        if (balance < 1) {
            this.logger.log(`[SDKClient] No position to sell (balance: ${balance})`);
            return null;
        }
        
        return this.sell(tokenId, balance, price);
    }
    
    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        this.ensureReady();
        return this.client.cancelOrder(orderId);
    }
    
    /**
     * Cancel all orders
     */
    async cancelAll() {
        this.ensureReady();
        return this.client.cancelAll();
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONVENIENCE METHODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Buy UP token at best ask + buffer
     */
    async buyUp(crypto, dollars, buffer = 0.01) {
        const market = await this.getCurrentMarket(crypto);
        const prices = await this.getBestPrices(market.upTokenId);
        const price = Math.min(prices.ask + buffer, 0.99);
        
        return {
            order: await this.buy(market.upTokenId, dollars, price),
            market,
            prices
        };
    }
    
    /**
     * Buy DOWN token at best ask + buffer
     */
    async buyDown(crypto, dollars, buffer = 0.01) {
        const market = await this.getCurrentMarket(crypto);
        const prices = await this.getBestPrices(market.downTokenId);
        const price = Math.min(prices.ask + buffer, 0.99);
        
        return {
            order: await this.buy(market.downTokenId, dollars, price),
            market,
            prices
        };
    }
    
    /**
     * Sell UP position at best bid - buffer
     */
    async sellUp(crypto, shares = null, buffer = 0.01) {
        const market = await this.getCurrentMarket(crypto);
        const balance = shares || await this.getBalance(market.upTokenId);
        const prices = await this.getBestPrices(market.upTokenId);
        const price = Math.max(prices.bid - buffer, 0.01);
        
        if (balance < 1) {
            return { order: null, market, prices, balance };
        }
        
        return {
            order: await this.sell(market.upTokenId, balance, price),
            market,
            prices,
            balance
        };
    }
    
    /**
     * Sell DOWN position at best bid - buffer
     */
    async sellDown(crypto, shares = null, buffer = 0.01) {
        const market = await this.getCurrentMarket(crypto);
        const balance = shares || await this.getBalance(market.downTokenId);
        const prices = await this.getBestPrices(market.downTokenId);
        const price = Math.max(prices.bid - buffer, 0.01);
        
        if (balance < 1) {
            return { order: null, market, prices, balance };
        }
        
        return {
            order: await this.sell(market.downTokenId, balance, price),
            market,
            prices,
            balance
        };
    }
    
    /**
     * Get underlying client for advanced operations
     */
    getUnderlyingClient() {
        this.ensureReady();
        return this.client;
    }
}

/**
 * Create and initialize a client
 */
export async function createSDKClient(options = {}) {
    const client = new SDKClient(options);
    await client.initialize();
    return client;
}

export { HOST, CHAIN_ID, GAMMA_API };
export default SDKClient;
