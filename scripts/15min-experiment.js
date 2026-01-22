/**
 * 15-Minute Trading Experiment Framework
 * 
 * This script:
 * 1. Connects to Polymarket WebSocket for real-time order book data
 * 2. Collects data over 15-minute windows
 * 3. Calculates metrics like spread, depth, price movement
 * 4. Optionally correlates with external price feeds (e.g., Binance BTC)
 */

import WebSocket from 'ws';

const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@ticker';

// Configuration
const CONFIG = {
  // Token ID for the market to track (default: Bitcoin $1M before GTA VI - Yes)
  tokenId: process.argv[2] || '105267568073659068217311993901927962476298440625043565106676088842803600775810',
  
  // Duration of each experiment window (ms)
  windowDuration: 15 * 60 * 1000, // 15 minutes
  
  // How often to log summary stats (ms)
  summaryInterval: 60 * 1000, // Every minute
  
  // Total experiment duration (ms)
  totalDuration: 60 * 60 * 1000, // 1 hour (4 windows)
  
  // Track external BTC price
  trackBtcPrice: true
};

class ExperimentRunner {
  constructor(config) {
    this.config = config;
    this.polymarketWs = null;
    this.binanceWs = null;
    
    // Data storage
    this.orderBookSnapshots = [];
    this.priceChanges = [];
    this.trades = [];
    this.btcPrices = [];
    
    // Current state
    this.currentBook = null;
    this.currentBtcPrice = null;
    this.windowStart = null;
    this.windowNumber = 0;
    
    // Metrics
    this.metrics = {
      messageCount: 0,
      bookUpdates: 0,
      priceChanges: 0,
      trades: 0
    };
  }
  
  async start() {
    console.log('═'.repeat(70));
    console.log('     POLYMARKET 15-MINUTE TRADING EXPERIMENT');
    console.log('═'.repeat(70));
    console.log(`\n📊 Configuration:`);
    console.log(`   Token ID: ${this.config.tokenId.slice(0, 30)}...`);
    console.log(`   Window Duration: ${this.config.windowDuration / 60000} minutes`);
    console.log(`   Total Duration: ${this.config.totalDuration / 60000} minutes`);
    console.log(`   Track BTC Price: ${this.config.trackBtcPrice}`);
    console.log('');
    
    // Connect to Polymarket
    await this.connectPolymarket();
    
    // Optionally connect to Binance for BTC price
    if (this.config.trackBtcPrice) {
      await this.connectBinance();
    }
    
    // Start window tracking
    this.startNewWindow();
    
    // Set up summary logging
    this.summaryTimer = setInterval(() => this.logSummary(), this.config.summaryInterval);
    
    // Set up window transitions
    this.windowTimer = setInterval(() => this.handleWindowEnd(), this.config.windowDuration);
    
    // Set up experiment end
    setTimeout(() => this.endExperiment(), this.config.totalDuration);
  }
  
  connectPolymarket() {
    return new Promise((resolve, reject) => {
      console.log('🔌 Connecting to Polymarket WebSocket...');
      
      this.polymarketWs = new WebSocket(CLOB_WS);
      
      this.polymarketWs.on('open', () => {
        console.log('✅ Polymarket connected');
        
        const msg = {
          type: 'market',
          assets_ids: [this.config.tokenId]
        };
        this.polymarketWs.send(JSON.stringify(msg));
        resolve();
      });
      
      this.polymarketWs.on('message', (data) => this.handlePolymarketMessage(data));
      
      this.polymarketWs.on('error', (error) => {
        console.error('❌ Polymarket WebSocket error:', error.message);
        reject(error);
      });
      
      this.polymarketWs.on('close', () => {
        console.log('🔴 Polymarket WebSocket closed');
      });
    });
  }
  
  connectBinance() {
    return new Promise((resolve) => {
      console.log('🔌 Connecting to Binance WebSocket for BTC price...');
      
      this.binanceWs = new WebSocket(BINANCE_WS);
      
      this.binanceWs.on('open', () => {
        console.log('✅ Binance connected');
        resolve();
      });
      
      this.binanceWs.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        this.currentBtcPrice = parseFloat(parsed.c); // Current price
        this.btcPrices.push({
          timestamp: Date.now(),
          price: this.currentBtcPrice
        });
      });
      
      this.binanceWs.on('error', (error) => {
        console.error('⚠️ Binance error:', error.message);
        resolve(); // Don't fail experiment if Binance fails
      });
    });
  }
  
  handlePolymarketMessage(rawData) {
    this.metrics.messageCount++;
    const timestamp = Date.now();
    const parsed = JSON.parse(rawData.toString());
    
    // Handle array (initial book snapshot)
    if (Array.isArray(parsed)) {
      const book = parsed[0];
      if (book && book.bids && book.asks) {
        this.currentBook = book;
        this.metrics.bookUpdates++;
        this.orderBookSnapshots.push({
          timestamp,
          windowNumber: this.windowNumber,
          bids: book.bids.slice(0, 10), // Top 10 levels
          asks: book.asks.slice(0, 10),
          bestBid: this.getBestBid(book),
          bestAsk: this.getBestAsk(book),
          btcPrice: this.currentBtcPrice
        });
      }
      return;
    }
    
    // Handle event-based messages
    if (parsed.event_type === 'price_change') {
      this.metrics.priceChanges++;
      const changes = parsed.price_changes || [];
      for (const change of changes) {
        this.priceChanges.push({
          timestamp,
          windowNumber: this.windowNumber,
          price: parseFloat(change.price),
          size: parseFloat(change.size),
          side: change.side,
          btcPrice: this.currentBtcPrice
        });
      }
    } else if (parsed.event_type === 'last_trade_price') {
      this.metrics.trades++;
      this.trades.push({
        timestamp,
        windowNumber: this.windowNumber,
        price: parseFloat(parsed.price),
        btcPrice: this.currentBtcPrice
      });
    }
  }
  
  getBestBid(book) {
    if (!book.bids || book.bids.length === 0) return null;
    return book.bids.reduce((max, b) => 
      parseFloat(b.price) > parseFloat(max.price) ? b : max
    );
  }
  
  getBestAsk(book) {
    if (!book.asks || book.asks.length === 0) return null;
    return book.asks.reduce((min, a) => 
      parseFloat(a.price) < parseFloat(min.price) ? a : min
    );
  }
  
  startNewWindow() {
    this.windowNumber++;
    this.windowStart = Date.now();
    
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📊 WINDOW ${this.windowNumber} STARTED at ${new Date().toISOString()}`);
    console.log('─'.repeat(70));
    
    if (this.currentBook) {
      const bestBid = this.getBestBid(this.currentBook);
      const bestAsk = this.getBestAsk(this.currentBook);
      if (bestBid && bestAsk) {
        console.log(`   Opening Bid: ${bestBid.price} | Ask: ${bestAsk.price}`);
        console.log(`   Opening Midpoint: ${((parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2).toFixed(4)}`);
      }
    }
    
    if (this.currentBtcPrice) {
      console.log(`   BTC Price: $${this.currentBtcPrice.toLocaleString()}`);
    }
  }
  
  handleWindowEnd() {
    const windowEnd = Date.now();
    const windowDuration = windowEnd - this.windowStart;
    
    // Calculate window metrics
    const windowSnapshots = this.orderBookSnapshots.filter(s => s.windowNumber === this.windowNumber);
    const windowPriceChanges = this.priceChanges.filter(p => p.windowNumber === this.windowNumber);
    const windowTrades = this.trades.filter(t => t.windowNumber === this.windowNumber);
    
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 WINDOW ${this.windowNumber} COMPLETE`);
    console.log('═'.repeat(70));
    console.log(`   Duration: ${(windowDuration / 1000).toFixed(1)}s`);
    console.log(`   Book Snapshots: ${windowSnapshots.length}`);
    console.log(`   Price Changes: ${windowPriceChanges.length}`);
    console.log(`   Trades: ${windowTrades.length}`);
    
    if (this.currentBook) {
      const bestBid = this.getBestBid(this.currentBook);
      const bestAsk = this.getBestAsk(this.currentBook);
      if (bestBid && bestAsk) {
        console.log(`   Closing Bid: ${bestBid.price} | Ask: ${bestAsk.price}`);
        console.log(`   Closing Midpoint: ${((parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2).toFixed(4)}`);
      }
    }
    
    if (windowTrades.length > 0) {
      const prices = windowTrades.map(t => t.price);
      console.log(`   Trade Range: ${Math.min(...prices).toFixed(4)} - ${Math.max(...prices).toFixed(4)}`);
    }
    
    if (this.currentBtcPrice) {
      console.log(`   BTC Price: $${this.currentBtcPrice.toLocaleString()}`);
    }
    
    // Start new window
    this.startNewWindow();
  }
  
  logSummary() {
    const runtime = (Date.now() - this.windowStart) / 1000;
    
    console.log(`\n⏱️  [${new Date().toISOString()}] Window ${this.windowNumber} - ${runtime.toFixed(0)}s elapsed`);
    console.log(`   Messages: ${this.metrics.messageCount} | Books: ${this.metrics.bookUpdates} | Prices: ${this.metrics.priceChanges} | Trades: ${this.metrics.trades}`);
    
    if (this.currentBook) {
      const bestBid = this.getBestBid(this.currentBook);
      const bestAsk = this.getBestAsk(this.currentBook);
      if (bestBid && bestAsk) {
        const spread = (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4);
        console.log(`   Current: Bid ${bestBid.price} | Ask ${bestAsk.price} | Spread ${spread}`);
      }
    }
    
    if (this.currentBtcPrice) {
      console.log(`   BTC: $${this.currentBtcPrice.toLocaleString()}`);
    }
  }
  
  endExperiment() {
    console.log(`\n${'═'.repeat(70)}`);
    console.log('     EXPERIMENT COMPLETE');
    console.log('═'.repeat(70));
    
    console.log(`\n📊 Final Statistics:`);
    console.log(`   Total Windows: ${this.windowNumber}`);
    console.log(`   Total Messages: ${this.metrics.messageCount}`);
    console.log(`   Book Updates: ${this.metrics.bookUpdates}`);
    console.log(`   Price Changes: ${this.metrics.priceChanges}`);
    console.log(`   Trades: ${this.metrics.trades}`);
    console.log(`   Order Book Snapshots: ${this.orderBookSnapshots.length}`);
    console.log(`   BTC Price Points: ${this.btcPrices.length}`);
    
    // Calculate overall price movement
    if (this.orderBookSnapshots.length >= 2) {
      const first = this.orderBookSnapshots[0];
      const last = this.orderBookSnapshots[this.orderBookSnapshots.length - 1];
      
      if (first.bestBid && last.bestBid) {
        const startMid = (parseFloat(first.bestBid.price) + parseFloat(first.bestAsk.price)) / 2;
        const endMid = (parseFloat(last.bestBid.price) + parseFloat(last.bestAsk.price)) / 2;
        const change = ((endMid - startMid) / startMid * 100).toFixed(2);
        
        console.log(`\n📈 Price Movement:`);
        console.log(`   Start Midpoint: ${startMid.toFixed(4)}`);
        console.log(`   End Midpoint: ${endMid.toFixed(4)}`);
        console.log(`   Change: ${change}%`);
      }
    }
    
    // Clean up
    clearInterval(this.summaryTimer);
    clearInterval(this.windowTimer);
    
    if (this.polymarketWs) this.polymarketWs.close();
    if (this.binanceWs) this.binanceWs.close();
    
    // Export data
    this.exportData();
    
    process.exit(0);
  }
  
  async exportData() {
    const data = {
      config: this.config,
      metrics: this.metrics,
      orderBookSnapshots: this.orderBookSnapshots,
      priceChanges: this.priceChanges,
      trades: this.trades,
      btcPrices: this.btcPrices
    };
    
    const filename = `experiment-${Date.now()}.json`;
    try {
      const fs = await import('fs');
      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
      console.log(`\n💾 Data exported to: ${filename}`);
    } catch (e) {
      console.log(`\n⚠️  Could not export data: ${e.message}`);
    }
  }
}

// Run experiment
const experiment = new ExperimentRunner(CONFIG);
experiment.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Experiment interrupted');
  experiment.endExperiment();
});

