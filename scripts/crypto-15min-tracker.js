/**
 * Crypto 15-Minute Market Tracker
 * 
 * Discovers and tracks 15-minute "Up or Down" markets for BTC, ETH, SOL, XRP
 * Uses epoch-based slug pattern: {crypto}-updown-15m-{epoch}
 */

import WebSocket from 'ws';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws';

// Supported crypto markets
const CRYPTO_MARKETS = {
  btc: { symbol: 'BTCUSDT', name: 'Bitcoin', binanceStream: 'btcusdt@ticker' },
  eth: { symbol: 'ETHUSDT', name: 'Ethereum', binanceStream: 'ethusdt@ticker' },
  sol: { symbol: 'SOLUSDT', name: 'Solana', binanceStream: 'solusdt@ticker' },
  xrp: { symbol: 'XRPUSDT', name: 'XRP', binanceStream: 'xrpusdt@ticker' }
};

/**
 * Calculate the current and upcoming 15-minute window epochs
 */
function get15MinWindows(count = 5) {
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / 900) * 900;
  
  const windows = [];
  for (let i = 0; i < count; i++) {
    const epoch = currentWindow + (i * 900);
    const startTime = new Date(epoch * 1000);
    const endTime = new Date((epoch + 900) * 1000);
    windows.push({
      epoch,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      startsIn: Math.max(0, epoch - now),
      endsIn: Math.max(0, (epoch + 900) - now)
    });
  }
  return windows;
}

/**
 * Fetch a specific 15-minute market by crypto and epoch
 */
async function fetchMarket(crypto, epoch) {
  const slug = `${crypto}-updown-15m-${epoch}`;
  
  try {
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = await response.json();
    
    if (markets && markets.length > 0) {
      const market = markets[0];
      const tokenIds = JSON.parse(market.clobTokenIds || '[]');
      const prices = JSON.parse(market.outcomePrices || '[]');
      
      return {
        slug,
        question: market.question,
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        upPrice: parseFloat(prices[0]),
        downPrice: parseFloat(prices[1]),
        endDate: market.endDate,
        volume: market.volumeNum,
        liquidity: market.liquidityNum,
        active: market.active,
        closed: market.closed
      };
    }
  } catch (error) {
    // Market might not exist yet
  }
  return null;
}

/**
 * Fetch order book for a token
 */
async function fetchOrderBook(tokenId) {
  try {
    const response = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
    const book = await response.json();
    
    const bids = book.bids || [];
    const asks = book.asks || [];
    
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
      totalBidLiquidity: bids.reduce((sum, b) => sum + parseFloat(b.size), 0),
      totalAskLiquidity: asks.reduce((sum, a) => sum + parseFloat(a.size), 0)
    };
  } catch (error) {
    return null;
  }
}

/**
 * Display market status
 */
async function displayMarketStatus() {
  const windows = get15MinWindows(4);
  const now = new Date();
  
  console.clear();
  console.log('═'.repeat(90));
  console.log('     POLYMARKET 15-MINUTE CRYPTO MARKETS');
  console.log(`     ${now.toISOString()}`);
  console.log('═'.repeat(90));
  
  // Current window info
  const currentWindow = windows[0];
  console.log(`\n⏱️  Current Window: Epoch ${currentWindow.epoch}`);
  console.log(`   Ends in: ${Math.floor(currentWindow.endsIn / 60)}m ${currentWindow.endsIn % 60}s`);
  
  // Fetch all crypto markets for current window
  console.log('\n' + '─'.repeat(90));
  console.log('   MARKET           │ UP PRICE │ DOWN PRICE │ SPREAD │ UP BOOK │ DOWN BOOK │ VOLUME');
  console.log('─'.repeat(90));
  
  for (const [crypto, config] of Object.entries(CRYPTO_MARKETS)) {
    const market = await fetchMarket(crypto, currentWindow.epoch);
    
    if (market && !market.closed) {
      const upBook = await fetchOrderBook(market.upTokenId);
      const downBook = await fetchOrderBook(market.downTokenId);
      
      const upStr = market.upPrice.toFixed(2).padStart(6);
      const downStr = market.downPrice.toFixed(2).padStart(6);
      const spreadStr = upBook ? (upBook.spread * 100).toFixed(1) + '%' : 'N/A';
      const upBookStr = upBook ? `${upBook.bidLevels}/${upBook.askLevels}` : 'N/A';
      const downBookStr = downBook ? `${downBook.bidLevels}/${downBook.askLevels}` : 'N/A';
      const volumeStr = market.volume ? `$${market.volume.toFixed(0)}` : 'N/A';
      
      console.log(`   ${config.name.padEnd(15)} │   ${upStr}  │    ${downStr}   │ ${spreadStr.padStart(6)} │ ${upBookStr.padStart(7)}  │ ${downBookStr.padStart(8)}  │ ${volumeStr}`);
    }
  }
  
  // Upcoming windows
  console.log('\n' + '─'.repeat(90));
  console.log('   UPCOMING WINDOWS');
  console.log('─'.repeat(90));
  
  for (let i = 1; i < windows.length; i++) {
    const w = windows[i];
    const market = await fetchMarket('btc', w.epoch);
    const status = market ? (market.active ? '✅ Active' : '⏳ Pending') : '❓ Not found';
    console.log(`   Window ${i}: Epoch ${w.epoch} │ Starts in ${Math.floor(w.startsIn / 60)}m ${w.startsIn % 60}s │ ${status}`);
  }
  
  console.log('\n═'.repeat(90));
}

/**
 * Stream live data for a specific market
 */
async function streamMarket(crypto = 'btc', windowOffset = 0) {
  const windows = get15MinWindows(windowOffset + 1);
  const targetWindow = windows[windowOffset];
  
  console.log('═'.repeat(80));
  console.log(`     LIVE STREAMING: ${CRYPTO_MARKETS[crypto].name} Up or Down`);
  console.log(`     Window: Epoch ${targetWindow.epoch}`);
  console.log('═'.repeat(80));
  
  const market = await fetchMarket(crypto, targetWindow.epoch);
  
  if (!market) {
    console.log('❌ Market not found for this window');
    return;
  }
  
  console.log(`\n📌 Market: ${market.question}`);
  console.log(`   Up Token: ${market.upTokenId.slice(0, 30)}...`);
  console.log(`   Down Token: ${market.downTokenId.slice(0, 30)}...`);
  
  // Connect to Polymarket WebSocket
  const polyWs = new WebSocket(CLOB_WS);
  let currentBook = { up: null, down: null };
  let currentBtcPrice = null;
  let messageCount = 0;
  
  // Connect to Binance for spot price
  const binanceWs = new WebSocket(`${BINANCE_WS}/${CRYPTO_MARKETS[crypto].binanceStream}`);
  
  binanceWs.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    currentBtcPrice = parseFloat(parsed.c);
  });
  
  polyWs.on('open', () => {
    console.log('\n✅ Connected to Polymarket WebSocket');
    
    // Subscribe to both Up and Down tokens
    polyWs.send(JSON.stringify({
      type: 'market',
      assets_ids: [market.upTokenId, market.downTokenId]
    }));
  });
  
  polyWs.on('message', (rawData) => {
    messageCount++;
    const parsed = JSON.parse(rawData.toString());
    const timestamp = new Date().toISOString();
    
    // Handle order book snapshot
    if (Array.isArray(parsed)) {
      for (const book of parsed) {
        if (book.asset_id === market.upTokenId) {
          currentBook.up = book;
        } else if (book.asset_id === market.downTokenId) {
          currentBook.down = book;
        }
      }
      displayLiveStatus(currentBook, currentBtcPrice, market, messageCount);
    }
    
    // Handle price changes
    if (parsed.event_type === 'price_change') {
      displayLiveStatus(currentBook, currentBtcPrice, market, messageCount);
    }
  });
  
  // Update display every 5 seconds
  const displayInterval = setInterval(() => {
    displayLiveStatus(currentBook, currentBtcPrice, market, messageCount);
  }, 5000);
  
  // Handle window end
  setTimeout(() => {
    console.log('\n⏱️  Window ended!');
    clearInterval(displayInterval);
    polyWs.close();
    binanceWs.close();
    process.exit(0);
  }, targetWindow.endsIn * 1000 + 5000);
  
  process.on('SIGINT', () => {
    clearInterval(displayInterval);
    polyWs.close();
    binanceWs.close();
    process.exit(0);
  });
}

function displayLiveStatus(book, spotPrice, market, msgCount) {
  const now = new Date();
  const endTime = new Date(market.endDate);
  const timeLeft = Math.max(0, (endTime - now) / 1000);
  
  console.log(`\n[${now.toISOString()}] Messages: ${msgCount}`);
  console.log(`⏱️  Time Remaining: ${Math.floor(timeLeft / 60)}m ${Math.floor(timeLeft % 60)}s`);
  
  if (spotPrice) {
    console.log(`₿  ${CRYPTO_MARKETS[market.slug.split('-')[0]]?.name || 'Crypto'} Spot: $${spotPrice.toLocaleString()}`);
  }
  
  if (book.up) {
    const bids = book.up.bids || [];
    const asks = book.up.asks || [];
    const bestBid = bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' });
    const bestAsk = asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1' });
    
    console.log(`📈 UP:   Bid ${bestBid.price} (${parseFloat(bestBid.size).toFixed(0)}) │ Ask ${bestAsk.price} (${parseFloat(bestAsk.size).toFixed(0)})`);
  }
  
  if (book.down) {
    const bids = book.down.bids || [];
    const asks = book.down.asks || [];
    const bestBid = bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' });
    const bestAsk = asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1' });
    
    console.log(`📉 DOWN: Bid ${bestBid.price} (${parseFloat(bestBid.size).toFixed(0)}) │ Ask ${bestAsk.price} (${parseFloat(bestAsk.size).toFixed(0)})`);
  }
}

// Main execution
const args = process.argv.slice(2);
const command = args[0] || 'status';

if (command === 'status') {
  await displayMarketStatus();
} else if (command === 'stream') {
  const crypto = args[1] || 'btc';
  await streamMarket(crypto.toLowerCase());
} else if (command === 'watch') {
  // Continuous status updates
  const updateStatus = async () => {
    await displayMarketStatus();
    setTimeout(updateStatus, 10000);
  };
  await updateStatus();
} else {
  console.log('Usage:');
  console.log('  node crypto-15min-tracker.js status   - Show current market status');
  console.log('  node crypto-15min-tracker.js stream [btc|eth|sol|xrp] - Live stream a market');
  console.log('  node crypto-15min-tracker.js watch    - Continuous status updates');
}

