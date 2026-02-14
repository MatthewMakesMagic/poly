/**
 * CoinGecko Price Client
 *
 * Polls CoinGecko Pro API for aggregated prices across 1,700+ exchanges.
 * Caches prices in memory for fast reads by the snapshot cycle.
 *
 * CoinGecko Analyst tier: ~30s cache, sub-second WebSocket (future).
 * We poll every 10s; the snapshot cycle (1s) reads from cache.
 *
 * @module clients/coingecko
 */

import https from 'https';
import { child } from '../../modules/logger/index.js';

// CoinGecko coin IDs for our instruments
const COIN_IDS = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  xrp: 'ripple',
};

const REVERSE_IDS = Object.fromEntries(
  Object.entries(COIN_IDS).map(([sym, id]) => [id, sym])
);

const DEFAULT_POLL_INTERVAL_MS = 10000; // 10 seconds
const API_HOST = 'pro-api.coingecko.com';

let log = null;
let apiKey = null;
let pollIntervalId = null;
let initialized = false;

// In-memory price cache: { btc: { price, timestamp }, ... }
const prices = {};

/**
 * Fetch prices from CoinGecko /simple/price endpoint
 */
function fetchPrices() {
  return new Promise((resolve, reject) => {
    const ids = Object.values(COIN_IDS).join(',');
    const path = `/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true&precision=full`;

    const opts = {
      hostname: API_HOST,
      path,
      headers: {
        'x-cg-pro-api-key': apiKey,
        'Accept': 'application/json',
      },
    };

    https.get(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`CoinGecko API ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * Poll loop — updates in-memory cache
 */
async function poll() {
  try {
    const data = await fetchPrices();
    const now = Date.now();

    for (const [cgId, priceData] of Object.entries(data)) {
      const sym = REVERSE_IDS[cgId];
      if (!sym || !priceData.usd) continue;

      prices[sym] = {
        price: priceData.usd,
        timestamp: priceData.last_updated_at ? priceData.last_updated_at * 1000 : now,
        fetchedAt: now,
        staleness_ms: now - (priceData.last_updated_at ? priceData.last_updated_at * 1000 : now),
      };
    }
  } catch (err) {
    if (log) {
      log.warn('coingecko_poll_failed', { error: err.message });
    }
  }
}

/**
 * Initialize the CoinGecko client
 * @param {Object} cfg - Config with apiKey and optional pollIntervalMs
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'coingecko' });
  apiKey = cfg.apiKey || process.env.COINGECKO_API_KEY;

  if (!apiKey) {
    log.warn('coingecko_no_api_key', { message: 'COINGECKO_API_KEY not set, client disabled' });
    return;
  }

  const pollMs = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Initial fetch
  await poll();

  // Start polling
  pollIntervalId = setInterval(poll, pollMs);
  if (pollIntervalId.unref) pollIntervalId.unref();

  initialized = true;
  log.info('coingecko_initialized', {
    symbols: Object.keys(COIN_IDS),
    pollIntervalMs: pollMs,
    initialPrices: Object.fromEntries(
      Object.entries(prices).map(([sym, d]) => [sym, d.price])
    ),
  });
}

/**
 * Get current price for a symbol
 * @param {string} symbol - btc, eth, sol, xrp
 * @returns {{ price: number, timestamp: number, staleness_ms: number } | null}
 */
export function getCurrentPrice(symbol) {
  const data = prices[symbol.toLowerCase()];
  if (!data) return null;

  return {
    price: data.price,
    timestamp: data.timestamp,
    staleness_ms: Date.now() - data.fetchedAt,
  };
}

/**
 * Get state for health reporting
 */
export function getState() {
  return {
    initialized,
    hasApiKey: !!apiKey,
    prices: Object.fromEntries(
      Object.entries(prices).map(([sym, d]) => [sym, {
        price: d.price,
        staleness_ms: Date.now() - d.fetchedAt,
      }])
    ),
  };
}

/**
 * Shutdown the client
 */
export async function shutdown() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  initialized = false;
  if (log) {
    log.info('coingecko_shutdown');
    log = null;
  }
}
