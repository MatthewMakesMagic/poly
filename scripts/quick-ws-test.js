/**
 * Quick WebSocket test - runs for 30 seconds to verify connectivity
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const TOKEN_ID = process.argv[2] || '105267568073659068217311993901927962476298440625043565106676088842803600775810';

console.log('═'.repeat(60));
console.log('     POLYMARKET WEBSOCKET QUICK TEST');
console.log('═'.repeat(60));
console.log(`\n🔌 Connecting to: ${WS_URL}`);
console.log(`📍 Token ID: ${TOKEN_ID}\n`);

const ws = new WebSocket(WS_URL);
let messageCount = 0;
const startTime = Date.now();
let lastBook = null;

ws.on('open', () => {
  console.log('✅ Connected!\n');
  
  const msg = {
    type: 'market',
    assets_ids: [TOKEN_ID]
  };
  
  console.log('📡 Subscribing with:', JSON.stringify(msg, null, 2));
  ws.send(JSON.stringify(msg));
});

ws.on('message', (data) => {
  messageCount++;
  const parsed = JSON.parse(data.toString());
  const timestamp = new Date().toISOString();
  
  // Check if it's an array (initial book snapshot comes as array)
  if (Array.isArray(parsed)) {
    const book = parsed[0];
    if (book && book.bids && book.asks) {
      lastBook = book;
      console.log(`\n[${timestamp}] 📖 ORDER BOOK SNAPSHOT`);
      console.log(`   Market: ${book.market}`);
      console.log(`   Bids: ${book.bids.length} levels`);
      console.log(`   Asks: ${book.asks.length} levels`);
      
      // Find best bid/ask
      const bestBid = book.bids.reduce((max, b) => 
        parseFloat(b.price) > parseFloat(max.price) ? b : max
      , { price: '0' });
      const bestAsk = book.asks.reduce((min, a) => 
        parseFloat(a.price) < parseFloat(min.price) ? a : min
      , { price: '999' });
      
      const spread = (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4);
      const midpoint = ((parseFloat(bestAsk.price) + parseFloat(bestBid.price)) / 2).toFixed(4);
      
      console.log(`   ─────────────────────────────────`);
      console.log(`   Best Bid: ${bestBid.price} (${parseFloat(bestBid.size).toFixed(2)} shares)`);
      console.log(`   Best Ask: ${bestAsk.price} (${parseFloat(bestAsk.size).toFixed(2)} shares)`);
      console.log(`   Spread: ${spread} | Midpoint: ${midpoint}`);
      console.log(`   ─────────────────────────────────`);
    }
    return;
  }
  
  // Handle event-based messages
  const eventType = parsed.event_type;
  
  if (eventType === 'price_change') {
    // Price change has different structure
    const changes = parsed.changes || [];
    console.log(`\n[${timestamp}] 💹 PRICE CHANGE`);
    if (changes.length > 0) {
      for (const change of changes) {
        console.log(`   Asset: ${change.asset_id?.slice(0, 20)}...`);
        console.log(`   Price: ${change.price}`);
      }
    } else {
      console.log(`   Data:`, JSON.stringify(parsed, null, 2).slice(0, 300));
    }
  } else if (eventType === 'last_trade_price') {
    console.log(`\n[${timestamp}] 🔔 LAST TRADE`);
    console.log(`   Price: ${parsed.price}`);
  } else if (eventType === 'book') {
    console.log(`\n[${timestamp}] 📖 BOOK UPDATE`);
    console.log(`   Bids: ${parsed.bids?.length || 0}`);
    console.log(`   Asks: ${parsed.asks?.length || 0}`);
  } else {
    console.log(`\n[${timestamp}] 📨 Message #${messageCount} (${eventType || 'unknown'})`);
    const preview = JSON.stringify(parsed, null, 2);
    if (preview.length > 500) {
      console.log(`   Data (truncated):`, preview.slice(0, 500) + '...');
    } else {
      console.log(`   Data:`, preview);
    }
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket Error:', error.message);
});

ws.on('close', (code, reason) => {
  const runtime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log('     SESSION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`   Runtime: ${runtime}s`);
  console.log(`   Messages received: ${messageCount}`);
  console.log(`   Avg messages/sec: ${(messageCount / (runtime)).toFixed(2)}`);
  console.log('═'.repeat(60));
});

// Close after 30 seconds
setTimeout(() => {
  console.log('\n⏱️  Test complete (30s), closing...');
  ws.close();
  process.exit(0);
}, 30000);

process.on('SIGINT', () => {
  console.log('\n🛑 Interrupted');
  ws.close();
  process.exit(0);
});
