/**
 * Fetch real-time order book data from Polymarket CLOB API
 * Tests the REST endpoints for order book depth, prices, and spreads
 */

const CLOB_API = 'https://clob.polymarket.com';

// You'll need to replace these with actual token IDs from discover-markets.js
// These are example placeholders
let TOKEN_ID = process.argv[2] || null;

async function getServerTime() {
  try {
    const response = await fetch(`${CLOB_API}/time`);
    const data = await response.json();
    console.log('🕐 Server Time:', new Date(data * 1000).toISOString());
    return data;
  } catch (error) {
    console.error('Error fetching server time:', error.message);
  }
}

async function getMarkets() {
  console.log('\n📊 Fetching available markets from CLOB...\n');
  
  try {
    const response = await fetch(`${CLOB_API}/markets?next_cursor=MA==`);
    
    if (!response.ok) {
      throw new Error(`CLOB markets error: ${response.status}`);
    }
    
    const result = await response.json();
    const data = result.data || [];
    
    // Look for Bitcoin markets
    const btcMarkets = data.filter(m => 
      (m.question?.toLowerCase().includes('bitcoin') ||
      m.question?.toLowerCase().includes('btc')) &&
      !m.closed
    );
    
    console.log(`Found ${btcMarkets.length} Bitcoin markets in CLOB:\n`);
    
    for (const market of btcMarkets.slice(0, 10)) {
      console.log('─'.repeat(70));
      console.log(`Question: ${market.question}`);
      console.log(`Condition ID: ${market.condition_id}`);
      console.log(`Active: ${market.active}`);
      console.log(`Closed: ${market.closed}`);
      
      if (market.tokens && market.tokens.length > 0) {
        console.log('Tokens:');
        for (const token of market.tokens) {
          console.log(`  - ${token.outcome}: ${token.token_id}`);
          // Save first token for testing
          if (!TOKEN_ID) {
            TOKEN_ID = token.token_id;
            console.log(`  ⭐ Using this token for orderbook test`);
          }
        }
      }
      console.log('');
    }
    
    return { markets: data, btcMarkets };
    
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    throw error;
  }
}

async function getOrderBook(tokenId) {
  console.log(`\n📖 Fetching order book for token: ${tokenId}\n`);
  
  try {
    const response = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Order book error: ${response.status} - ${text}`);
    }
    
    const book = await response.json();
    
    console.log('═'.repeat(70));
    console.log('                    ORDER BOOK');
    console.log('═'.repeat(70));
    
    // Display asks (sell orders) - highest to lowest
    console.log('\n📈 ASKS (Sell Orders):');
    console.log('─'.repeat(50));
    if (book.asks && book.asks.length > 0) {
      const sortedAsks = [...book.asks].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
      for (const ask of sortedAsks.slice(0, 10)) {
        const price = parseFloat(ask.price).toFixed(4);
        const size = parseFloat(ask.size).toFixed(2);
        console.log(`  ${price}  |  ${size.padStart(12)} shares`);
      }
    } else {
      console.log('  No asks available');
    }
    
    // Calculate spread
    const bestAsk = book.asks?.length > 0 ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
    const bestBid = book.bids?.length > 0 ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
    
    console.log('\n' + '─'.repeat(50));
    if (bestAsk && bestBid) {
      const spread = (bestAsk - bestBid).toFixed(4);
      const midpoint = ((bestAsk + bestBid) / 2).toFixed(4);
      console.log(`  SPREAD: ${spread} | MIDPOINT: ${midpoint}`);
      console.log(`  Best Bid: ${bestBid.toFixed(4)} | Best Ask: ${bestAsk.toFixed(4)}`);
    }
    console.log('─'.repeat(50));
    
    // Display bids (buy orders) - highest to lowest
    console.log('\n📉 BIDS (Buy Orders):');
    console.log('─'.repeat(50));
    if (book.bids && book.bids.length > 0) {
      const sortedBids = [...book.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
      for (const bid of sortedBids.slice(0, 10)) {
        const price = parseFloat(bid.price).toFixed(4);
        const size = parseFloat(bid.size).toFixed(2);
        console.log(`  ${price}  |  ${size.padStart(12)} shares`);
      }
    } else {
      console.log('  No bids available');
    }
    
    // Calculate total liquidity
    const totalBidLiquidity = book.bids?.reduce((sum, b) => sum + parseFloat(b.size), 0) || 0;
    const totalAskLiquidity = book.asks?.reduce((sum, a) => sum + parseFloat(a.size), 0) || 0;
    
    console.log('\n═'.repeat(70));
    console.log('                    LIQUIDITY SUMMARY');
    console.log('═'.repeat(70));
    console.log(`  Total Bid Liquidity: ${totalBidLiquidity.toFixed(2)} shares`);
    console.log(`  Total Ask Liquidity: ${totalAskLiquidity.toFixed(2)} shares`);
    console.log(`  Bid/Ask Ratio: ${(totalBidLiquidity / totalAskLiquidity).toFixed(2)}`);
    
    return book;
    
  } catch (error) {
    console.error('Error fetching order book:', error.message);
    throw error;
  }
}

async function getMidpoint(tokenId) {
  console.log(`\n📍 Fetching midpoint for token: ${tokenId}`);
  
  try {
    const response = await fetch(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    
    if (!response.ok) {
      throw new Error(`Midpoint error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`   Midpoint: ${data.mid}`);
    return data;
    
  } catch (error) {
    console.error('Error fetching midpoint:', error.message);
  }
}

async function getPrice(tokenId, side = 'buy') {
  console.log(`\n💰 Fetching ${side} price for token: ${tokenId}`);
  
  try {
    const response = await fetch(`${CLOB_API}/price?token_id=${tokenId}&side=${side}`);
    
    if (!response.ok) {
      throw new Error(`Price error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`   ${side.toUpperCase()} Price: ${data.price}`);
    return data;
    
  } catch (error) {
    console.error('Error fetching price:', error.message);
  }
}

async function getSpread(tokenId) {
  console.log(`\n📐 Fetching spread for token: ${tokenId}`);
  
  try {
    const response = await fetch(`${CLOB_API}/spread?token_id=${tokenId}`);
    
    if (!response.ok) {
      throw new Error(`Spread error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`   Spread: ${data.spread}`);
    return data;
    
  } catch (error) {
    console.error('Error fetching spread:', error.message);
  }
}

// Main execution
console.log('═'.repeat(70));
console.log('     POLYMARKET ORDER BOOK EXPLORER');
console.log('═'.repeat(70));

await getServerTime();

const { btcMarkets } = await getMarkets();

if (TOKEN_ID) {
  console.log(`\n🎯 Testing with token: ${TOKEN_ID}\n`);
  
  await getMidpoint(TOKEN_ID);
  await getPrice(TOKEN_ID, 'buy');
  await getPrice(TOKEN_ID, 'sell');
  await getSpread(TOKEN_ID);
  await getOrderBook(TOKEN_ID);
  
} else {
  console.log('\n⚠️  No Bitcoin token found. Please provide a token ID as argument:');
  console.log('   node scripts/fetch-orderbook.js <TOKEN_ID>');
}

console.log('\n✅ Order book exploration complete!');

