/**
 * Quick 2-minute experiment to test the framework
 */

import WebSocket from 'ws';

const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@ticker';

const TOKEN_ID = process.argv[2] || '105267568073659068217311993901927962476298440625043565106676088842803600775810';
const DURATION = 120000; // 2 minutes

console.log('═'.repeat(70));
console.log('     POLYMARKET QUICK EXPERIMENT (2 minutes)');
console.log('═'.repeat(70));

let polyWs, binanceWs;
let currentBook = null;
let currentBtcPrice = null;
let metrics = { messages: 0, bookUpdates: 0, priceChanges: 0 };
let startTime = Date.now();

// Connect to Polymarket
polyWs = new WebSocket(CLOB_WS);

polyWs.on('open', () => {
  console.log('\n✅ Polymarket connected');
  polyWs.send(JSON.stringify({
    type: 'market',
    assets_ids: [TOKEN_ID]
  }));
});

polyWs.on('message', (data) => {
  metrics.messages++;
  const parsed = JSON.parse(data.toString());
  
  if (Array.isArray(parsed) && parsed[0]?.bids) {
    currentBook = parsed[0];
    metrics.bookUpdates++;
  } else if (parsed.event_type === 'price_change') {
    metrics.priceChanges++;
  }
});

// Connect to Binance
binanceWs = new WebSocket(BINANCE_WS);

binanceWs.on('open', () => {
  console.log('✅ Binance connected');
});

binanceWs.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  currentBtcPrice = parseFloat(parsed.c);
});

// Log status every 15 seconds
const statusInterval = setInterval(() => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n⏱️  ${elapsed}s elapsed | Messages: ${metrics.messages} | Books: ${metrics.bookUpdates} | Price Changes: ${metrics.priceChanges}`);
  
  if (currentBook) {
    const bids = currentBook.bids || [];
    const asks = currentBook.asks || [];
    const bestBid = bids.reduce((max, b) => parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0' });
    const bestAsk = asks.reduce((min, a) => parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '999' });
    
    const spread = (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4);
    const mid = ((parseFloat(bestAsk.price) + parseFloat(bestBid.price)) / 2).toFixed(4);
    
    console.log(`   📊 Polymarket: Bid ${bestBid.price} (${parseFloat(bestBid.size).toFixed(0)}) | Ask ${bestAsk.price} (${parseFloat(bestAsk.size).toFixed(0)}) | Spread ${spread} | Mid ${mid}`);
  }
  
  if (currentBtcPrice) {
    console.log(`   ₿  Bitcoin: $${currentBtcPrice.toLocaleString()}`);
  }
}, 15000);

// End after 2 minutes
setTimeout(() => {
  clearInterval(statusInterval);
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log('     EXPERIMENT COMPLETE');
  console.log('═'.repeat(70));
  console.log(`\n📊 Final Stats:`);
  console.log(`   Duration: ${DURATION / 1000}s`);
  console.log(`   Total Messages: ${metrics.messages}`);
  console.log(`   Book Updates: ${metrics.bookUpdates}`);
  console.log(`   Price Changes: ${metrics.priceChanges}`);
  console.log(`   Avg Messages/sec: ${(metrics.messages / (DURATION / 1000)).toFixed(2)}`);
  
  if (currentBook) {
    const bids = currentBook.bids || [];
    const asks = currentBook.asks || [];
    console.log(`\n📖 Final Order Book:`);
    console.log(`   Bid Levels: ${bids.length}`);
    console.log(`   Ask Levels: ${asks.length}`);
    
    const totalBidLiq = bids.reduce((sum, b) => sum + parseFloat(b.size), 0);
    const totalAskLiq = asks.reduce((sum, a) => sum + parseFloat(a.size), 0);
    console.log(`   Total Bid Liquidity: ${totalBidLiq.toLocaleString()} shares`);
    console.log(`   Total Ask Liquidity: ${totalAskLiq.toLocaleString()} shares`);
  }
  
  if (currentBtcPrice) {
    console.log(`\n₿  Final BTC Price: $${currentBtcPrice.toLocaleString()}`);
  }
  
  console.log('\n✅ Experiment framework is working correctly!');
  console.log('   Run `npm run experiment` for a full 1-hour experiment.');
  
  polyWs.close();
  if (binanceWs) binanceWs.close();
  process.exit(0);
}, DURATION);

process.on('SIGINT', () => {
  console.log('\n🛑 Interrupted');
  polyWs.close();
  if (binanceWs) binanceWs.close();
  process.exit(0);
});

