#!/usr/bin/env node
/**
 * BTC Quad Price Stream
 *
 * Streams BTC prices from 4 independent sources side-by-side:
 *   1. Binance   - spot exchange price via Polymarket RTDS WebSocket
 *   2. Chainlink  - oracle price (settlement source) via Polymarket RTDS WebSocket
 *   3. Pyth       - oracle price via Hermes SSE stream
 *   4. CLOB       - market consensus (Up token mid-price) via Polymarket CLOB WebSocket
 *
 * Usage: node scripts/btc-quad-stream.js [interval_seconds]
 *        Default interval: 5 seconds
 */

import WebSocket from 'ws';

// ─── Configuration ──────────────────────────────────────────────────────────────

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_REST_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const PYTH_BTC_FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const PYTH_SSE_URL = `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${PYTH_BTC_FEED_ID}&parsed=true`;

const DISPLAY_INTERVAL_S = parseInt(process.argv[2]) || 5;

// ─── State ──────────────────────────────────────────────────────────────────────

const prices = {
  binance:   { price: null, ts: null },
  chainlink: { price: null, ts: null },
  pyth:      { price: null, ts: null },
  clob:      { mid: null, lastTrade: null, bestBid: null, bestAsk: null, ts: null },
};

let marketInfo = { question: null, strikePrice: null, tokenId: null };
let tickCount = 0;

// CLOB order book state
const orderBook = { bids: new Map(), asks: new Map() };

// ─── 1. RTDS WebSocket (Binance + Chainlink) ───────────────────────────────────

function connectRTDS() {
  const ws = new WebSocket(RTDS_URL);

  ws.on('open', () => {
    log('RTDS', 'Connected - subscribing to Binance + Chainlink');
    ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [
        { topic: 'crypto_prices', type: '*', filters: JSON.stringify({ symbol: 'BTCUSDT' }) },
        { topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: 'BTC/USD' }) },
      ],
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.payload) return;

      const price = parseFloat(msg.payload.value ?? msg.payload.price ?? msg.payload.p);
      if (isNaN(price) || price <= 0) return;

      const now = Date.now();
      if (msg.topic === 'crypto_prices') {
        prices.binance = { price, ts: now };
      } else if (msg.topic === 'crypto_prices_chainlink') {
        prices.chainlink = { price, ts: now };
      }
    } catch { /* ignore parse errors */ }
  });

  ws.on('close', () => {
    log('RTDS', 'Disconnected - reconnecting in 3s');
    setTimeout(connectRTDS, 3000);
  });

  ws.on('error', (err) => {
    log('RTDS', `Error: ${err.message}`);
  });
}

// ─── 2. Pyth Hermes SSE Stream ─────────────────────────────────────────────────

async function connectPyth() {
  try {
    log('Pyth', 'Connecting to Hermes SSE...');
    const controller = new AbortController();
    const response = await fetch(PYTH_SSE_URL, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    log('Pyth', 'Connected');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events (data: {...}\n\n)
      const events = buffer.split('\n');
      buffer = events.pop(); // keep incomplete line in buffer

      for (const line of events) {
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.parsed && data.parsed.length > 0) {
            const p = data.parsed[0].price;
            const pythPrice = parseFloat(p.price) * Math.pow(10, p.expo);
            prices.pyth = { price: pythPrice, ts: Date.now() };
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Stream ended, reconnect
    log('Pyth', 'Stream ended - reconnecting in 3s');
    setTimeout(connectPyth, 3000);
  } catch (err) {
    if (err.name !== 'AbortError') {
      log('Pyth', `Error: ${err.message} - reconnecting in 5s`);
      setTimeout(connectPyth, 5000);
    }
  }
}

// ─── 3. CLOB WebSocket (Market consensus) ───────────────────────────────────────

function getCurrentEpoch() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / 900) * 900; // 900s = 15 minutes
}

async function discoverBtcMarket() {
  const epoch = getCurrentEpoch();
  const slug = `btc-updown-15m-${epoch}`;

  try {
    const resp = await fetch(`${GAMMA_API_URL}/markets?slug=${slug}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const markets = await resp.json();
    if (!markets || markets.length === 0) {
      log('CLOB', `No market found for slug: ${slug}`);
      return null;
    }

    const market = markets[0];
    const tokens = JSON.parse(market.clobTokenIds || '[]');
    if (tokens.length === 0) return null;

    const outcomePrices = JSON.parse(market.outcomePrices || '[]');

    return {
      tokenId: tokens[0],
      question: market.question,
      epoch,
      upPrice: parseFloat(outcomePrices[0]) || 0.5,
      endDate: market.endDate,
    };
  } catch (err) {
    log('CLOB', `Discovery error: ${err.message}`);
  }
  return null;
}

let clobWs = null;
let clobReconnectTimer = null;

function updateClobMid() {
  const bidPrices = [...orderBook.bids.keys()].map(Number);
  const askPrices = [...orderBook.asks.keys()].map(Number);
  if (bidPrices.length > 0 && askPrices.length > 0) {
    const bestBid = Math.max(...bidPrices);
    const bestAsk = Math.min(...askPrices);
    prices.clob.bestBid = bestBid;
    prices.clob.bestAsk = bestAsk;
    prices.clob.mid = (bestBid + bestAsk) / 2;
    prices.clob.ts = Date.now();
  }
}

async function connectCLOB() {
  const discovered = await discoverBtcMarket();
  if (!discovered) {
    log('CLOB', 'No active BTC Up/Down market found - retrying in 15s');
    clobReconnectTimer = setTimeout(connectCLOB, 15000);
    return;
  }

  marketInfo = discovered;
  currentEpoch = discovered.epoch;
  log('CLOB', `Market: ${discovered.question}`);
  log('CLOB', `Token: ${discovered.tokenId.substring(0, 24)}...`);

  // Get initial midpoint via REST
  try {
    const midResp = await fetch(`${CLOB_REST_URL}/midpoint?token_id=${discovered.tokenId}`);
    const midData = await midResp.json();
    if (midData.mid) {
      prices.clob.mid = parseFloat(midData.mid);
      prices.clob.ts = Date.now();
      log('CLOB', `Initial mid: ${(parseFloat(midData.mid) * 100).toFixed(1)}c`);
    }
  } catch { /* not critical */ }

  // Connect WebSocket
  clobWs = new WebSocket(CLOB_WS_URL);

  clobWs.on('open', () => {
    log('CLOB', 'WebSocket connected');
    clobWs.send(JSON.stringify({
      type: 'market',
      assets_ids: [discovered.tokenId],
    }));
  });

  clobWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const now = Date.now();

      switch (msg.event_type) {
        case 'book': {
          // Full order book snapshot
          orderBook.bids.clear();
          orderBook.asks.clear();
          for (const b of (msg.bids || [])) {
            orderBook.bids.set(b.price, parseFloat(b.size));
          }
          for (const a of (msg.asks || [])) {
            orderBook.asks.set(a.price, parseFloat(a.size));
          }
          updateClobMid();
          break;
        }
        case 'price_change': {
          // Incremental order book update
          if (msg.changes) {
            for (const change of msg.changes) {
              const book = change.side === 'BUY' ? orderBook.bids : orderBook.asks;
              if (parseFloat(change.size) === 0) {
                book.delete(change.price);
              } else {
                book.set(change.price, parseFloat(change.size));
              }
            }
            updateClobMid();
          } else if (msg.price) {
            // Some price_change events have a direct price
            prices.clob.mid = parseFloat(msg.price);
            prices.clob.ts = now;
          }
          break;
        }
        case 'last_trade_price': {
          prices.clob.lastTrade = parseFloat(msg.price);
          prices.clob.ts = now;
          break;
        }
      }
    } catch { /* ignore */ }
  });

  clobWs.on('close', () => {
    log('CLOB', 'Disconnected - rediscovering market in 5s');
    orderBook.bids.clear();
    orderBook.asks.clear();
    clobReconnectTimer = setTimeout(connectCLOB, 5000);
  });

  clobWs.on('error', (err) => {
    log('CLOB', `Error: ${err.message}`);
  });

  // Monitor for 15-min window rotation
  scheduleMarketCheck();
}

let marketCheckTimer = null;
let currentEpoch = null;

function scheduleMarketCheck() {
  if (marketCheckTimer) clearTimeout(marketCheckTimer);
  // Check every 15s if the epoch has rotated
  marketCheckTimer = setTimeout(() => {
    const newEpoch = getCurrentEpoch();
    if (currentEpoch && newEpoch !== currentEpoch) {
      log('CLOB', `Window rotated (epoch ${currentEpoch} -> ${newEpoch}) - reconnecting`);
      if (clobWs) {
        clobWs.removeAllListeners();
        clobWs.close();
      }
      orderBook.bids.clear();
      orderBook.asks.clear();
      // Small delay to let the new market appear on Gamma API
      setTimeout(connectCLOB, 3000);
    } else {
      scheduleMarketCheck();
    }
  }, 15000);
}

// ─── Display ────────────────────────────────────────────────────────────────────

function fmt(val) {
  if (val === null) return '   waiting...  ';
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.padStart(14);
}

function staleness(ts) {
  if (!ts) return '';
  const age = (Date.now() - ts) / 1000;
  if (age > 30) return ' [STALE]';
  if (age > 10) return ` [${age.toFixed(0)}s]`;
  return '';
}

function display() {
  tickCount++;
  const t = new Date().toLocaleTimeString('en-GB');

  const bin = fmt(prices.binance.price);
  const chn = fmt(prices.chainlink.price);
  const pyt = fmt(prices.pyth.price);

  // CLOB: show as cents (probability)
  const clobMid = prices.clob.mid !== null
    ? `${(prices.clob.mid * 100).toFixed(1)}c`.padStart(7)
    : 'wait...';
  const clobLast = prices.clob.lastTrade !== null
    ? `${(prices.clob.lastTrade * 100).toFixed(1)}c`
    : '-';

  // Spreads relative to Chainlink (settlement oracle)
  let spreads = '';
  if (prices.chainlink.price) {
    if (prices.binance.price) {
      const d = prices.binance.price - prices.chainlink.price;
      spreads += `  B-C:${d >= 0 ? '+' : ''}${d.toFixed(0)}`;
    }
    if (prices.pyth.price) {
      const d = prices.pyth.price - prices.chainlink.price;
      spreads += `  P-C:${d >= 0 ? '+' : ''}${d.toFixed(0)}`;
    }
  }

  // Staleness indicators
  const binStale = staleness(prices.binance.ts);
  const chnStale = staleness(prices.chainlink.ts);
  const pytStale = staleness(prices.pyth.ts);
  const clobStale = staleness(prices.clob.ts);

  console.log(
    `[${t}]  Bin:${bin}${binStale}  CL:${chn}${chnStale}  Pyth:${pyt}${pytStale}  CLOB: ${clobMid}${clobStale}  (last:${clobLast})${spreads}`
  );
}

// ─── Utilities ──────────────────────────────────────────────────────────────────

function log(source, msg) {
  const t = new Date().toLocaleTimeString('en-GB');
  console.log(`[${t}] [${source}] ${msg}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

console.log('');
console.log('='.repeat(100));
console.log('  BTC QUAD PRICE STREAM  |  Binance  .  Chainlink  .  Pyth  .  CLOB');
console.log('='.repeat(100));
console.log(`  Display: every ${DISPLAY_INTERVAL_S}s  |  Ctrl+C to stop`);
console.log(`  CLOB shows "Up" token probability (0-100c)  |  Dollar prices from 3 oracle/exchange feeds`);
console.log('');

// Connect all sources in parallel
connectRTDS();
connectPyth();
connectCLOB();

// Wait 3s for initial data, then start display loop
setTimeout(() => {
  console.log('');
  console.log('-'.repeat(100));
  display();
  setInterval(display, DISPLAY_INTERVAL_S * 1000);
}, 3000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (clobWs) clobWs.close();
  if (clobReconnectTimer) clearTimeout(clobReconnectTimer);
  if (marketCheckTimer) clearTimeout(marketCheckTimer);
  process.exit(0);
});
