/**
 * Window Manager Module
 *
 * TEMP SOLUTION: Discovers active 15-minute crypto windows on Polymarket.
 * Wraps logic from scripts/crypto-15min-tracker.js to feed the execution loop.
 *
 * A more robust solution should:
 * - Use WebSocket subscriptions for real-time book updates
 * - Cache market data to reduce API calls
 * - Handle rate limiting gracefully
 *
 * @module modules/window-manager
 */

import { child } from '../logger/index.js';
import {
  WindowManagerError,
  WindowManagerErrorCodes,
  SUPPORTED_CRYPTOS,
  GAMMA_API,
  CLOB_API,
  WINDOW_DURATION_SECONDS,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;

/**
 * Parse reference price from market question
 *
 * Extracts the strike/reference price from questions like:
 * - "Will BTC be above $94,500 at 12:15 UTC?"
 * - "Will ETH be above $3,250.50 at 12:30 UTC?"
 * - "Will SOL be above $185 at 12:00 UTC?"
 *
 * @param {string} question - Market question text
 * @returns {number|null} Reference price or null if parsing fails
 */
export function parseReferencePrice(question) {
  if (!question || typeof question !== 'string') {
    return null;
  }

  // Pattern: "above $X" or "above $X.XX" with optional commas
  // Handles: $94,500 | $3,250.50 | $185 | $94500
  const patterns = [
    /above\s*\$\s*([\d,]+(?:\.\d+)?)/i,   // "above $94,500" or "above $ 94,500"
    />\s*\$\s*([\d,]+(?:\.\d+)?)/i,        // "> $94,500"
    /over\s*\$\s*([\d,]+(?:\.\d+)?)/i,     // "over $94,500"
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match && match[1]) {
      // Remove commas and parse as float
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);

      if (!isNaN(price) && price > 0) {
        return price;
      }
    }
  }

  // Log warning for unparseable questions
  if (log) {
    log.warn('reference_price_parse_failed', { question });
  }

  return null;
}

// Cache to reduce API calls
let windowCache = {
  windows: [],
  fetchedAt: 0,
  cacheMs: 5000, // Cache for 5 seconds
};

/**
 * Initialize the window manager module
 *
 * @param {Object} cfg - Configuration object
 * @param {string[]} [cfg.cryptos] - Cryptos to track (default: all supported)
 * @param {number} [cfg.cacheDurationMs] - Cache duration (default: 5000)
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  log = child({ module: 'window-manager' });
  log.info('module_init_start');

  config = {
    cryptos: cfg.cryptos || SUPPORTED_CRYPTOS,
    cacheDurationMs: cfg.cacheDurationMs || 5000,
  };

  windowCache.cacheMs = config.cacheDurationMs;

  initialized = true;
  log.info('module_initialized', { cryptos: config.cryptos });
}

/**
 * Calculate current and upcoming 15-minute window epochs
 *
 * @param {number} [count=2] - Number of windows to return
 * @returns {Object[]} Array of window epoch objects
 */
export function get15MinWindows(count = 2) {
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / WINDOW_DURATION_SECONDS) * WINDOW_DURATION_SECONDS;

  const windows = [];
  for (let i = 0; i < count; i++) {
    const epoch = currentWindow + (i * WINDOW_DURATION_SECONDS);
    windows.push({
      epoch,
      startTime: new Date(epoch * 1000).toISOString(),
      endTime: new Date((epoch + WINDOW_DURATION_SECONDS) * 1000).toISOString(),
      startsIn: Math.max(0, epoch - now),
      endsIn: Math.max(0, (epoch + WINDOW_DURATION_SECONDS) - now),
    });
  }
  return windows;
}

/**
 * Fetch a specific 15-minute market by crypto and epoch
 *
 * @param {string} crypto - Crypto symbol (btc, eth, sol, xrp)
 * @param {number} epoch - Window epoch timestamp
 * @returns {Promise<Object|null>} Market data or null if not found
 */
export async function fetchMarket(crypto, epoch) {
  const slug = `${crypto}-updown-15m-${epoch}`;

  try {
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);

    if (!response.ok) {
      return null;
    }

    const markets = await response.json();

    if (markets && markets.length > 0) {
      const market = markets[0];
      const tokenIds = JSON.parse(market.clobTokenIds || '[]');
      const prices = JSON.parse(market.outcomePrices || '[]');

      // Story 7-15: Parse reference price from question (e.g., "$94,500" from "Will BTC be above $94,500?")
      const referencePrice = parseReferencePrice(market.question);

      return {
        slug,
        question: market.question,
        referencePrice,  // Strike price for probability calculation
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        upPrice: parseFloat(prices[0]) || 0.5,
        downPrice: parseFloat(prices[1]) || 0.5,
        endDate: market.endDate,
        volume: market.volumeNum,
        liquidity: market.liquidityNum,
        active: market.active,
        closed: market.closed,
      };
    }
  } catch (error) {
    if (log) {
      log.warn('fetch_market_error', { crypto, epoch, error: error.message });
    }
  }
  return null;
}

/**
 * Fetch order book for a token
 *
 * @param {string} tokenId - Token ID
 * @returns {Promise<Object|null>} Order book data or null
 */
export async function fetchOrderBook(tokenId) {
  try {
    const response = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);

    if (!response.ok) {
      return null;
    }

    const book = await response.json();

    const bids = book.bids || [];
    const asks = book.asks || [];

    if (bids.length === 0 && asks.length === 0) {
      return null;
    }

    const bestBid = bids.reduce((max, b) =>
      parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0', size: '0' });
    const bestAsk = asks.reduce((min, a) =>
      parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1', size: '0' });

    return {
      bestBid: parseFloat(bestBid.price),
      bestBidSize: parseFloat(bestBid.size),
      bestAsk: parseFloat(bestAsk.price),
      bestAskSize: parseFloat(bestAsk.size),
      spread: parseFloat(bestAsk.price) - parseFloat(bestBid.price),
      midpoint: (parseFloat(bestAsk.price) + parseFloat(bestBid.price)) / 2,
      bidLevels: bids.length,
      askLevels: asks.length,
    };
  } catch (error) {
    if (log) {
      log.warn('fetch_orderbook_error', { tokenId: tokenId.slice(0, 20), error: error.message });
    }
  }
  return null;
}

/**
 * Get active windows for strategy evaluation
 *
 * TEMP SOLUTION: Fetches markets via REST API each call (with caching).
 * Production should use WebSocket for real-time updates.
 *
 * @returns {Promise<Object[]>} Array of window objects for strategy evaluation
 */
export async function getActiveWindows() {
  ensureInitialized();

  // Check cache
  const now = Date.now();
  if (windowCache.windows.length > 0 && (now - windowCache.fetchedAt) < windowCache.cacheMs) {
    return windowCache.windows;
  }

  const windows = [];
  const epochs = get15MinWindows(2); // Current + next window
  const cryptos = config?.cryptos || SUPPORTED_CRYPTOS;

  for (const crypto of cryptos) {
    for (const epochData of epochs) {
      try {
        const market = await fetchMarket(crypto, epochData.epoch);

        if (market && market.active && !market.closed) {
          // Fetch order book for UP token to get current price
          const book = await fetchOrderBook(market.upTokenId);

          windows.push({
            window_id: `${crypto}-15m-${epochData.epoch}`,
            market_id: market.slug,
            token_id_up: market.upTokenId,
            token_id_down: market.downTokenId,
            market_price: book?.midpoint || market.upPrice,
            best_bid: book?.bestBid || null,
            best_ask: book?.bestAsk || null,
            spread: book?.spread || null,
            time_remaining_ms: epochData.endsIn * 1000,
            epoch: epochData.epoch,
            crypto,
            end_time: epochData.endTime,
            // Story 7-15: Reference price (strike) for probability calculation
            reference_price: market.referencePrice,
            question: market.question,
          });
        }
      } catch (error) {
        if (log) {
          log.warn('get_active_windows_error', {
            crypto,
            epoch: epochData.epoch,
            error: error.message,
          });
        }
      }
    }
  }

  // Update cache
  windowCache.windows = windows;
  windowCache.fetchedAt = now;

  if (log) {
    log.info('windows_fetched', {
      count: windows.length,
      cryptos: [...new Set(windows.map(w => w.crypto))],
    });
  }

  return windows;
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  return {
    initialized,
    cryptos: config?.cryptos || [],
    cacheAge: Date.now() - windowCache.fetchedAt,
    cachedWindowCount: windowCache.windows.length,
  };
}

/**
 * Shutdown the module
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  initialized = false;
  config = null;
  windowCache = { windows: [], fetchedAt: 0, cacheMs: 5000 };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Clear the window cache (force refresh on next call)
 */
export function clearCache() {
  windowCache.windows = [];
  windowCache.fetchedAt = 0;
}

/**
 * Internal: Ensure module is initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new WindowManagerError(
      WindowManagerErrorCodes.NOT_INITIALIZED,
      'Window manager not initialized. Call init() first.',
      {}
    );
  }
}

// Re-export types
export { WindowManagerError, WindowManagerErrorCodes, SUPPORTED_CRYPTOS };
