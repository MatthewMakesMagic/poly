/**
 * Polymarket Client Wrapper
 *
 * Wraps the existing SDK client and custom client with:
 * - Standardized error handling (PolymarketError)
 * - Rate limiting with exponential backoff
 * - Response validation
 * - Credential security (never logs credentials)
 *
 * Based on existing production-tested code from:
 * - src/execution/sdk_client.js (primary)
 * - src/execution/polymarket_client.js (low-level backup)
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { PolymarketError, PolymarketErrorCodes, Side, OrderType } from './types.js';
import { buildL2Headers, validateCredentials } from './auth.js';

// API Endpoints
const ENDPOINTS = {
  REST: 'https://clob.polymarket.com',
  WS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  GAMMA: 'https://gamma-api.polymarket.com',
};

// Polygon chain ID
const CHAIN_ID = 137;

// Rate limiting constants
const MIN_REQUEST_INTERVAL_MS = 100;
const MAX_BACKOFF_MS = 10000;
const MAX_RETRIES = 3;

/**
 * Create ethers v6 compatible wallet for SDK
 * The SDK expects ethers v5's _signTypedData method
 *
 * @param {string} privateKey - Private key
 * @returns {Wallet} Compatible wallet instance
 */
function createCompatibleWallet(privateKey) {
  const wallet = new Wallet(privateKey);
  // SDK expects ethers v5's _signTypedData method
  wallet._signTypedData = async (domain, types, value) => {
    return wallet.signTypedData(domain, types, value);
  };
  return wallet;
}

/**
 * Wrapped Polymarket Client
 *
 * Provides error handling, rate limiting, and response validation
 * around the SDK client.
 */
export class WrappedPolymarketClient {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.client = null;
    this.wallet = null;
    this.funder = null;
    this.credentials = null;
    this.ready = false;

    // Rate limiting state
    this.lastRequestTime = 0;
    this.consecutiveErrors = 0;

    // Statistics
    this.stats = {
      requests: 0,
      errors: 0,
      rateLimitHits: 0,
    };
  }

  /**
   * Initialize the client with configuration
   *
   * @param {Object} config - Polymarket configuration from config module
   * @param {string} config.apiKey - API key
   * @param {string} config.apiSecret - API secret
   * @param {string} config.passphrase - API passphrase
   * @param {string} config.privateKey - Wallet private key
   * @param {string} [config.funder] - Funder address (defaults to wallet address)
   * @throws {PolymarketError} If credentials are missing or invalid
   */
  async initialize(config) {
    // Validate credentials
    const validation = validateCredentials(config);
    if (!validation.valid) {
      throw new PolymarketError(
        PolymarketErrorCodes.AUTH_FAILED,
        'Missing API credentials',
        {
          missing: validation.missing,
          hasApiKey: !!config.apiKey,
          hasSecret: !!config.apiSecret,
          hasPassphrase: !!config.passphrase,
          hasPrivateKey: !!config.privateKey,
        }
      );
    }

    this.credentials = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      passphrase: config.passphrase,
    };

    this.log('info', 'client_initializing');

    try {
      // Create v6-compatible wallet
      this.wallet = createCompatibleWallet(config.privateKey);
      this.funder = config.funder || this.wallet.address;

      this.log('info', 'wallet_created', {
        address: this.wallet.address,
        funder: this.funder,
      });

      // Derive API credentials from wallet
      const baseClient = new ClobClient(ENDPOINTS.REST, CHAIN_ID, this.wallet);
      const creds = await baseClient.deriveApiKey();

      // Create authenticated client with signature type 2 (proxy wallets)
      this.client = new ClobClient(
        ENDPOINTS.REST,
        CHAIN_ID,
        this.wallet,
        creds,
        2, // Signature type 2 for proxy wallets
        this.funder
      );

      this.ready = true;
      this.log('info', 'client_initialized', {
        address: this.wallet.address,
        funder: this.funder,
      });
    } catch (err) {
      this.stats.errors++;
      throw new PolymarketError(
        PolymarketErrorCodes.CONNECTION_FAILED,
        `Failed to initialize client: ${err.message}`,
        { originalError: err.message }
      );
    }
  }

  /**
   * Ensure client is initialized before operations
   * @throws {PolymarketError} If not initialized
   */
  ensureReady() {
    if (!this.ready) {
      throw new PolymarketError(
        PolymarketErrorCodes.NOT_INITIALIZED,
        'Client not initialized. Call initialize() first.'
      );
    }
  }

  /**
   * Log with credential redaction (logger handles redaction)
   */
  log(level, event, data = {}) {
    if (!this.logger) return;

    const logFn = this.logger[level] || this.logger.info;
    if (typeof logFn === 'function') {
      logFn.call(this.logger, event, data);
    }
  }

  /**
   * Rate-limited request wrapper with retry logic
   *
   * @param {Function} operation - Async operation to execute
   * @param {string} operationName - Name for logging
   * @returns {Promise<any>} Operation result
   * @throws {PolymarketError} On failure after retries
   */
  async withRateLimit(operation, operationName) {
    this.ensureReady();

    // Enforce minimum interval between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      await this.sleep(waitTime);
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.lastRequestTime = Date.now();
        this.stats.requests++;

        const result = await operation();

        // Validate response format
        this.validateResponse(result, operationName);

        // Reset consecutive errors on success
        this.consecutiveErrors = 0;
        return result;
      } catch (err) {
        lastError = err;
        this.stats.errors++;
        this.consecutiveErrors++;

        // Check for rate limit error
        if (this.isRateLimitError(err)) {
          this.stats.rateLimitHits++;
          this.log('warn', 'rate_limit_hit', {
            operation: operationName,
            attempt,
          });
        }

        // Log error
        this.log('error', 'request_failed', {
          operation: operationName,
          attempt,
          error: err.message,
          consecutiveErrors: this.consecutiveErrors,
        });

        // Don't retry on auth errors
        if (this.isAuthError(err)) {
          throw new PolymarketError(
            PolymarketErrorCodes.AUTH_FAILED,
            `Authentication failed: ${err.message}`,
            { operation: operationName }
          );
        }

        // Exponential backoff
        if (attempt < MAX_RETRIES) {
          const backoff = Math.min(
            100 * Math.pow(2, attempt),
            MAX_BACKOFF_MS
          );
          this.log('info', 'retry_backoff', {
            operation: operationName,
            attempt,
            backoffMs: backoff,
          });
          await this.sleep(backoff);
        }
      }
    }

    // All retries exhausted
    throw new PolymarketError(
      this.categorizeError(lastError),
      `${operationName} failed after ${MAX_RETRIES} attempts: ${lastError.message}`,
      {
        operation: operationName,
        attempts: MAX_RETRIES,
        originalError: lastError.message,
      }
    );
  }

  /**
   * Validate response format
   * @throws {PolymarketError} On unexpected response format
   */
  validateResponse(response, operationName) {
    // Check for error responses that might have slipped through
    if (response && response.error) {
      this.log('warn', 'api_response_anomaly', {
        operation: operationName,
        response: JSON.stringify(response).slice(0, 500),
      });
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_RESPONSE,
        `API returned error response: ${response.error}`,
        { operation: operationName, response }
      );
    }
  }

  /**
   * Check if error is a rate limit error
   */
  isRateLimitError(err) {
    return (
      err.status === 429 ||
      err.message?.includes('rate limit') ||
      err.message?.includes('429')
    );
  }

  /**
   * Check if error is an auth error
   */
  isAuthError(err) {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.message?.includes('unauthorized') ||
      err.message?.includes('forbidden')
    );
  }

  /**
   * Categorize error to appropriate error code
   */
  categorizeError(err) {
    if (this.isRateLimitError(err)) {
      return PolymarketErrorCodes.RATE_LIMITED;
    }
    if (this.isAuthError(err)) {
      return PolymarketErrorCodes.AUTH_FAILED;
    }
    if (err.message?.includes('insufficient') || err.message?.includes('balance')) {
      return PolymarketErrorCodes.INSUFFICIENT_BALANCE;
    }
    if (err.message?.includes('reject')) {
      return PolymarketErrorCodes.ORDER_REJECTED;
    }
    return PolymarketErrorCodes.CONNECTION_FAILED;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MARKET DATA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get order book for a token
   */
  async getOrderBook(tokenId) {
    return this.withRateLimit(
      () => this.client.getOrderBook(tokenId),
      'getOrderBook'
    );
  }

  /**
   * Get best prices (bid/ask/spread/midpoint)
   */
  async getBestPrices(tokenId) {
    const book = await this.getOrderBook(tokenId);
    const bids = book.bids || [];
    const asks = book.asks || [];

    const bestBid = bids.length > 0
      ? Math.max(...bids.map((b) => parseFloat(b.price)))
      : 0;
    const bestAsk = asks.length > 0
      ? Math.min(...asks.map((a) => parseFloat(a.price)))
      : 1;

    return {
      bid: bestBid,
      ask: bestAsk,
      spread: bestAsk - bestBid,
      midpoint: (bestBid + bestAsk) / 2,
    };
  }

  /**
   * Get market context for latency/slippage analysis (Story 5.2, AC3)
   *
   * Returns bid, ask, spread, and depth (liquidity) at best prices.
   * This is used by the trade-event module to record market conditions at signal time.
   *
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} Market context { bidAtSignal, askAtSignal, spreadAtSignal, depthAtSignal }
   */
  async getMarketContext(tokenId) {
    const book = await this.getOrderBook(tokenId);
    const bids = book.bids || [];
    const asks = book.asks || [];

    // Find best bid and ask prices
    const bestBid = bids.length > 0
      ? Math.max(...bids.map((b) => parseFloat(b.price)))
      : 0;
    const bestAsk = asks.length > 0
      ? Math.min(...asks.map((a) => parseFloat(a.price)))
      : 1;

    // Calculate depth at best prices (total size available)
    // For bid depth: sum all orders at best bid price
    // For ask depth: sum all orders at best ask price
    const bidDepth = bids
      .filter((b) => parseFloat(b.price) === bestBid)
      .reduce((sum, b) => sum + parseFloat(b.size || 0), 0);

    const askDepth = asks
      .filter((a) => parseFloat(a.price) === bestAsk)
      .reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

    // Total depth is the minimum of bid and ask (tradeable liquidity)
    // For market context, we use the side-specific depth
    // Return the average as a general depth indicator
    const depthAtSignal = (bidDepth + askDepth) / 2;

    return {
      bidAtSignal: bestBid,
      askAtSignal: bestAsk,
      spreadAtSignal: bestAsk - bestBid,
      depthAtSignal: depthAtSignal,
      // Also include side-specific depths for detailed analysis
      bidDepth,
      askDepth,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BALANCE & POSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get balance for a conditional token (in shares, not micro-units)
   */
  async getBalance(tokenId) {
    return this.withRateLimit(async () => {
      try {
        const bal = await this.client.getBalanceAllowance({
          asset_type: 'CONDITIONAL',
          token_id: tokenId,
        });
        return parseFloat(bal.balance) / 1_000_000;
      } catch (e) {
        return 0;
      }
    }, 'getBalance');
  }

  /**
   * Get USDC balance
   */
  async getUSDCBalance() {
    return this.withRateLimit(async () => {
      try {
        const bal = await this.client.getBalanceAllowance({
          asset_type: 'COLLATERAL',
        });
        return parseFloat(bal.balance) / 1_000_000;
      } catch (e) {
        return 0;
      }
    }, 'getUSDCBalance');
  }

  /**
   * Get all open orders
   */
  async getOpenOrders() {
    return this.withRateLimit(
      () => this.client.getOpenOrders(),
      'getOpenOrders'
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDER EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Place a buy order
   *
   * @param {string} tokenId - Token to buy
   * @param {number} dollars - Dollar amount to spend
   * @param {number} price - Price per share (0.01-0.99)
   * @param {string} [orderType='GTC'] - Order type
   * @returns {Object} Order result
   */
  async buy(tokenId, dollars, price, orderType = 'GTC') {
    // Validate price range for binary options
    if (price < 0.01 || price > 0.99) {
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_PRICE,
        `Invalid price: ${price}. Must be between 0.01 and 0.99`,
        { price, tokenId }
      );
    }

    const shares = Math.ceil(dollars / price);
    const actualCost = shares * price;

    if (actualCost < 1.0) {
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_SIZE,
        `Order too small: $${actualCost.toFixed(2)} < $1 minimum`,
        { dollars, price, shares }
      );
    }

    this.log('info', 'buy_order_placing', {
      tokenId: tokenId.slice(0, 16) + '...',
      shares,
      price,
      cost: actualCost,
      orderType,
    });

    return this.withRateLimit(async () => {
      const order = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: price,
          side: 'BUY',
          size: shares,
        },
        {
          tickSize: '0.01',
          negRisk: false,
        },
        orderType
      );

      return this.processOrderResult(order, price, shares);
    }, 'buy');
  }

  /**
   * Place a sell order
   *
   * @param {string} tokenId - Token to sell
   * @param {number} shares - Number of shares to sell
   * @param {number} price - Price per share
   * @param {string} [orderType='GTC'] - Order type
   * @returns {Object} Order result
   */
  async sell(tokenId, shares, price, orderType = 'GTC') {
    if (price < 0.01 || price > 0.99) {
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_PRICE,
        `Invalid price: ${price}. Must be between 0.01 and 0.99`,
        { price, tokenId }
      );
    }

    const actualShares = Math.floor(shares);
    const expectedValue = actualShares * price;

    if (actualShares < 1) {
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_SIZE,
        `Not enough shares: ${shares} < 1`,
        { shares }
      );
    }

    if (expectedValue < 1.0) {
      throw new PolymarketError(
        PolymarketErrorCodes.INVALID_SIZE,
        `Order too small: $${expectedValue.toFixed(2)} < $1 minimum`,
        { shares: actualShares, price }
      );
    }

    // Set token allowance before selling
    try {
      await this.client.updateBalanceAllowance({
        asset_type: 'CONDITIONAL',
        token_id: tokenId,
      });
    } catch (e) {
      this.log('warn', 'allowance_setup_issue', {
        error: e.message?.slice(0, 100),
      });
    }

    this.log('info', 'sell_order_placing', {
      tokenId: tokenId.slice(0, 16) + '...',
      shares: actualShares,
      price,
      value: expectedValue,
      orderType,
    });

    return this.withRateLimit(async () => {
      const order = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: price,
          side: 'SELL',
          size: actualShares,
        },
        {
          tickSize: '0.01',
          negRisk: false,
        },
        orderType
      );

      return this.processOrderResult(order, price, actualShares);
    }, 'sell');
  }

  /**
   * Process order result with multi-factor fill verification
   */
  processOrderResult(order, requestedPrice, requestedShares) {
    // MULTI-FACTOR FILL VERIFICATION
    const hasTxHash = order?.transactionsHashes?.length > 0;
    const hasSuccess = order?.success === true;
    const hasGoodStatus = order?.status === 'matched' || order?.status === 'live';
    const filled = hasTxHash && hasSuccess && hasGoodStatus;

    // Extract actual fill price with sanity check
    let actualFillPrice = requestedPrice;
    if (order && filled) {
      if (order.avgPrice) {
        const extracted = parseFloat(order.avgPrice);
        if (extracted >= 0.01 && extracted <= 0.99) {
          actualFillPrice = extracted;
        }
      } else if (order.takingAmount && order.makingAmount) {
        const taking = parseFloat(order.takingAmount) / 1_000_000;
        const making = parseFloat(order.makingAmount) / 1_000_000;
        if (making > 0) {
          const extracted = taking / making;
          if (extracted >= 0.01 && extracted <= 0.99) {
            actualFillPrice = extracted;
          }
        }
      }
    }

    const result = {
      orderId: order?.orderID || null,
      status: order?.status || 'killed',
      shares: filled ? requestedShares : 0,
      sharesRequested: requestedShares,
      price: requestedPrice,
      priceFilled: filled ? actualFillPrice : null,
      cost: filled ? actualFillPrice * requestedShares : 0,
      filled,
      tx: order?.transactionsHashes?.[0] || null,
      txHashes: order?.transactionsHashes || [],
      raw: order,
    };

    this.log('info', filled ? 'order_filled' : 'order_not_filled', {
      orderId: result.orderId,
      status: result.status,
      filled,
      shares: result.shares,
      priceFilled: result.priceFilled,
    });

    return result;
  }

  /**
   * Get order details by ID (for confirmation polling)
   *
   * @param {string} orderId - Order ID
   * @returns {Promise<Object>} Order details from Polymarket
   */
  async getOrder(orderId) {
    return this.withRateLimit(
      () => this.client.getOrder(orderId),
      'getOrder'
    );
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    this.log('info', 'cancel_order', { orderId });
    return this.withRateLimit(
      () => this.client.cancelOrder(orderId),
      'cancelOrder'
    );
  }

  /**
   * Cancel all orders
   */
  async cancelAll() {
    this.log('info', 'cancel_all_orders');
    return this.withRateLimit(
      () => this.client.cancelAll(),
      'cancelAll'
    );
  }

  /**
   * Get current state for module interface
   */
  getState() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const remainingMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);

    return {
      initialized: this.ready,
      address: this.wallet?.address || null,
      funder: this.funder || null,
      ready: this.ready,
      stats: { ...this.stats },
      rateLimit: {
        remainingMs,
        lastRequestTime: this.lastRequestTime,
        minIntervalMs: MIN_REQUEST_INTERVAL_MS,
      },
    };
  }

  /**
   * Shutdown the client
   */
  async shutdown() {
    this.log('info', 'client_shutdown', { stats: this.stats });
    this.client = null;
    this.wallet = null;
    this.funder = null;
    this.credentials = null;
    this.ready = false;
  }
}

export { ENDPOINTS, CHAIN_ID, MIN_REQUEST_INTERVAL_MS, MAX_BACKOFF_MS, MAX_RETRIES };
