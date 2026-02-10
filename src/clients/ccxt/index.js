/**
 * CCXT Client Wrapper
 *
 * Unified multi-exchange price data client using the CCXT library.
 * Captures 21 exchanges to maximize oracle coverage.
 *
 * @module clients/ccxt
 */

import ccxt from 'ccxt';

const EXCHANGES = [
  // --- Original 5 ---
  'binance',
  'coinbaseexchange',
  'kraken',
  'bybit',
  'okx',
  // --- New: likely in Chainlink oracle feed ---
  'bitstamp',
  'gemini',
  'bitfinex',
  'htx',
  'gateio',
  'kucoin',
  'mexc',
  'cryptocom',
  'bitget',
  // --- New: additional coverage ---
  'upbit',
  'poloniex',
  'whitebit',
  'bingx',
  'lbank',
  'phemex',
  'bitmart',
];

// Exchanges that use USD pairs (rest use USDT)
const USD_EXCHANGES = new Set(['coinbaseexchange', 'bitstamp', 'gemini', 'bitfinex']);

const USDT_SYMBOLS = {
  btc: 'BTC/USDT',
  eth: 'ETH/USDT',
  sol: 'SOL/USDT',
  xrp: 'XRP/USDT',
};

const USD_SYMBOLS = {
  btc: 'BTC/USD',
  eth: 'ETH/USD',
  sol: 'SOL/USD',
  xrp: 'XRP/USD',
};

let exchanges = {};
let initialized = false;

/**
 * Initialize all exchange connections
 */
export async function init() {
  if (initialized) return;
  for (const name of EXCHANGES) {
    try {
      exchanges[name] = new ccxt[name]({ enableRateLimit: true });
    } catch (err) {
      // Exchange not available in ccxt - skip
      console.warn(`[ccxt] Failed to initialize ${name}: ${err.message}`);
    }
  }
  initialized = true;
}

/**
 * Fetch ticker for a given exchange and crypto
 *
 * @param {string} exchange - Exchange name (e.g., 'binance')
 * @param {string} crypto - Crypto symbol (e.g., 'btc')
 * @returns {Promise<Object|null>} Ticker data { last, bid, ask, quoteVolume } or null on error
 */
export async function fetchTicker(exchange, crypto) {
  if (!exchanges[exchange]) return null;

  const symbolMap = USD_EXCHANGES.has(exchange) ? USD_SYMBOLS : USDT_SYMBOLS;
  const ccxtSymbol = symbolMap[crypto];
  if (!ccxtSymbol) return null;

  try {
    const ticker = await exchanges[exchange].fetchTicker(ccxtSymbol);
    return {
      price: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      volume24h: ticker.quoteVolume,
    };
  } catch {
    return null;
  }
}

/**
 * Get list of configured exchanges
 * @returns {string[]}
 */
export function getExchanges() {
  return EXCHANGES;
}

/**
 * Get list of supported cryptos
 * @returns {string[]}
 */
export function getCryptos() {
  return Object.keys(USDT_SYMBOLS);
}

/**
 * Get state
 * @returns {Object}
 */
export function getState() {
  return {
    initialized,
    exchanges: EXCHANGES.map(name => ({
      name,
      available: !!exchanges[name],
    })),
  };
}

/**
 * Shutdown
 */
export async function shutdown() {
  exchanges = {};
  initialized = false;
}
