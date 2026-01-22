/**
 * WebSocket streaming for real-time order book updates
 * Connects to Polymarket CLOB WebSocket for live data
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Get token ID from command line or use a default
const TOKEN_ID = process.argv[2] || null;

class OrderBookStream {
  constructor(tokenId) {
    this.tokenId = tokenId;
    this.ws = null;
    this.orderBook = { bids: [], asks: [] };
    this.messageCount = 0;
    this.startTime = Date.now();
    this.lastTrade = null;
    this.priceHistory = [];
  }
  
  connect() {
    console.log('🔌 Connecting to Polymarket WebSocket...');
    console.log(`   URL: ${WS_URL}`);
    console.log(`   Token: ${this.tokenId}\n`);
    
    this.ws = new WebSocket(WS_URL);
    
    this.ws.on('open', () => {
      console.log('✅ WebSocket connected!\n');
      this.subscribe();
    });
    
    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });
    
    this.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
    });
    
    this.ws.on('close', (code, reason) => {
      console.log(`\n🔴 WebSocket closed: ${code} - ${reason}`);
      this.printSummary();
    });
  }
  
  subscribe() {
    const subscribeMsg = {
      type: 'market',
      assets_ids: [this.tokenId]
    };
    
    console.log('📡 Subscribing to market channel...');
    console.log(`   Payload: ${JSON.stringify(subscribeMsg)}\n`);
    
    this.ws.send(JSON.stringify(subscribeMsg));
  }
  
  handleMessage(rawData) {
    this.messageCount++;
    const data = JSON.parse(rawData.toString());
    const timestamp = new Date().toISOString();
    
    switch (data.event_type) {
      case 'book':
        this.handleBookSnapshot(data, timestamp);
        break;
        
      case 'price_change':
        this.handlePriceChange(data, timestamp);
        break;
        
      case 'last_trade_price':
        this.handleLastTrade(data, timestamp);
        break;
        
      case 'tick_size_change':
        console.log(`📏 [${timestamp}] Tick size change:`, data);
        break;
        
      default:
        console.log(`📨 [${timestamp}] Event: ${data.event_type || 'unknown'}`);
        if (Object.keys(data).length < 10) {
          console.log(`   Data:`, JSON.stringify(data, null, 2));
        }
    }
  }
  
  handleBookSnapshot(data, timestamp) {
    console.log(`\n📖 [${timestamp}] ORDER BOOK SNAPSHOT`);
    console.log('═'.repeat(60));
    
    if (data.bids) {
      this.orderBook.bids = data.bids;
      console.log(`   Bids: ${data.bids.length} levels`);
      
      // Show top 5 bids
      const topBids = data.bids.slice(0, 5);
      for (const bid of topBids) {
        console.log(`     ${parseFloat(bid.price).toFixed(4)} | ${parseFloat(bid.size).toFixed(2)}`);
      }
    }
    
    if (data.asks) {
      this.orderBook.asks = data.asks;
      console.log(`   Asks: ${data.asks.length} levels`);
      
      // Show top 5 asks
      const topAsks = data.asks.slice(0, 5);
      for (const ask of topAsks) {
        console.log(`     ${parseFloat(ask.price).toFixed(4)} | ${parseFloat(ask.size).toFixed(2)}`);
      }
    }
    
    this.calculateMetrics();
  }
  
  handlePriceChange(data, timestamp) {
    const price = data.price || data.mid;
    console.log(`💹 [${timestamp}] PRICE CHANGE: ${price}`);
    
    if (price) {
      this.priceHistory.push({
        timestamp,
        price: parseFloat(price)
      });
    }
  }
  
  handleLastTrade(data, timestamp) {
    this.lastTrade = {
      price: data.price,
      timestamp
    };
    
    console.log(`🔔 [${timestamp}] TRADE EXECUTED @ ${data.price}`);
  }
  
  calculateMetrics() {
    if (this.orderBook.bids.length > 0 && this.orderBook.asks.length > 0) {
      const bestBid = Math.max(...this.orderBook.bids.map(b => parseFloat(b.price)));
      const bestAsk = Math.min(...this.orderBook.asks.map(a => parseFloat(a.price)));
      const spread = bestAsk - bestBid;
      const midpoint = (bestAsk + bestBid) / 2;
      
      console.log('\n   📊 Current Metrics:');
      console.log(`      Best Bid: ${bestBid.toFixed(4)}`);
      console.log(`      Best Ask: ${bestAsk.toFixed(4)}`);
      console.log(`      Spread: ${spread.toFixed(4)} (${(spread * 100).toFixed(2)}%)`);
      console.log(`      Midpoint: ${midpoint.toFixed(4)}`);
      
      // Calculate depth at different price levels
      const bidDepth1pct = this.orderBook.bids
        .filter(b => parseFloat(b.price) >= bestBid * 0.99)
        .reduce((sum, b) => sum + parseFloat(b.size), 0);
      
      const askDepth1pct = this.orderBook.asks
        .filter(a => parseFloat(a.price) <= bestAsk * 1.01)
        .reduce((sum, a) => sum + parseFloat(a.size), 0);
      
      console.log(`      Bid Depth (1%): ${bidDepth1pct.toFixed(2)} shares`);
      console.log(`      Ask Depth (1%): ${askDepth1pct.toFixed(2)} shares`);
    }
    
    console.log('═'.repeat(60));
  }
  
  printSummary() {
    const runtime = (Date.now() - this.startTime) / 1000;
    
    console.log('\n═'.repeat(60));
    console.log('                    SESSION SUMMARY');
    console.log('═'.repeat(60));
    console.log(`   Runtime: ${runtime.toFixed(1)} seconds`);
    console.log(`   Messages received: ${this.messageCount}`);
    console.log(`   Message rate: ${(this.messageCount / runtime).toFixed(2)} msg/sec`);
    console.log(`   Price updates: ${this.priceHistory.length}`);
    
    if (this.priceHistory.length > 1) {
      const prices = this.priceHistory.map(p => p.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      
      console.log(`   Price Range: ${minPrice.toFixed(4)} - ${maxPrice.toFixed(4)}`);
      console.log(`   Average Price: ${avgPrice.toFixed(4)}`);
    }
    
    console.log('═'.repeat(60));
  }
  
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// First, let's try to discover a token if none provided
async function discoverToken() {
  if (TOKEN_ID) return TOKEN_ID;
  
  console.log('🔍 No token provided, discovering Bitcoin markets...\n');
  
  try {
    const response = await fetch('https://clob.polymarket.com/markets');
    const markets = await response.json();
    
    const btcMarket = markets.find(m => 
      (m.question?.toLowerCase().includes('bitcoin') || 
       m.question?.toLowerCase().includes('btc')) &&
      !m.closed
    );
    
    if (btcMarket && btcMarket.tokens && btcMarket.tokens.length > 0) {
      const token = btcMarket.tokens[0];
      console.log(`📌 Found market: ${btcMarket.question}`);
      console.log(`   Using token: ${token.token_id} (${token.outcome})\n`);
      return token.token_id;
    }
    
    // If no Bitcoin market, use any active market
    const activeMarket = markets.find(m => !m.closed && m.tokens?.length > 0);
    if (activeMarket) {
      const token = activeMarket.tokens[0];
      console.log(`📌 Using market: ${activeMarket.question}`);
      console.log(`   Token: ${token.token_id} (${token.outcome})\n`);
      return token.token_id;
    }
    
  } catch (error) {
    console.error('Error discovering token:', error.message);
  }
  
  return null;
}

// Main execution
console.log('═'.repeat(60));
console.log('     POLYMARKET WEBSOCKET STREAM');
console.log('═'.repeat(60));
console.log('');

const tokenId = await discoverToken();

if (!tokenId) {
  console.log('❌ No token ID available. Please provide one:');
  console.log('   node scripts/websocket-stream.js <TOKEN_ID>');
  process.exit(1);
}

const stream = new OrderBookStream(tokenId);
stream.connect();

// Run for 60 seconds then close
console.log('⏱️  Streaming for 60 seconds (Ctrl+C to stop early)...\n');

setTimeout(() => {
  console.log('\n⏱️  Time limit reached, closing connection...');
  stream.close();
}, 60000);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Interrupt received, closing...');
  stream.close();
  process.exit(0);
});

