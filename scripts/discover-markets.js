/**
 * Discover Bitcoin-related markets on Polymarket via Gamma API
 * This helps us find the token IDs needed for order book data
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function discoverMarkets() {
  console.log('🔍 Discovering Bitcoin markets on Polymarket...\n');
  
  try {
    // Fetch markets with Bitcoin in the title
    const response = await fetch(`${GAMMA_API}/markets?closed=false&limit=100`);
    
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
    }
    
    const markets = await response.json();
    
    // Filter for Bitcoin-related markets
    const btcMarkets = markets.filter(m => 
      m.question?.toLowerCase().includes('bitcoin') ||
      m.question?.toLowerCase().includes('btc') ||
      m.slug?.toLowerCase().includes('bitcoin') ||
      m.slug?.toLowerCase().includes('btc')
    );
    
    console.log(`📊 Found ${btcMarkets.length} Bitcoin-related markets:\n`);
    
    for (const market of btcMarkets.slice(0, 15)) {
      console.log('─'.repeat(80));
      console.log(`📌 Question: ${market.question}`);
      console.log(`   Slug: ${market.slug}`);
      console.log(`   Market ID: ${market.id}`);
      console.log(`   Condition ID: ${market.conditionId}`);
      console.log(`   Active: ${market.active}`);
      console.log(`   Closed: ${market.closed}`);
      console.log(`   End Date: ${market.endDate}`);
      
      // Show outcome tokens if available
      if (market.tokens && market.tokens.length > 0) {
        console.log(`   Tokens:`);
        for (const token of market.tokens) {
          console.log(`     - ${token.outcome}: ${token.token_id}`);
        }
      }
      
      // Show current prices if available
      if (market.outcomePrices) {
        console.log(`   Prices: ${market.outcomePrices}`);
      }
      
      console.log('');
    }
    
    // Also search for 15-minute or short-duration markets
    console.log('\n🔍 Searching for short-duration/15-minute markets...\n');
    
    const shortMarkets = markets.filter(m => 
      m.question?.toLowerCase().includes('15 min') ||
      m.question?.toLowerCase().includes('minute') ||
      m.question?.toLowerCase().includes('hourly') ||
      m.slug?.includes('15-min')
    );
    
    if (shortMarkets.length > 0) {
      console.log(`📊 Found ${shortMarkets.length} short-duration markets:\n`);
      for (const market of shortMarkets.slice(0, 10)) {
        console.log('─'.repeat(80));
        console.log(`📌 Question: ${market.question}`);
        console.log(`   Slug: ${market.slug}`);
        console.log(`   Market ID: ${market.id}`);
        if (market.tokens) {
          console.log(`   Tokens:`);
          for (const token of market.tokens) {
            console.log(`     - ${token.outcome}: ${token.token_id}`);
          }
        }
        console.log('');
      }
    } else {
      console.log('   No explicit 15-minute markets found in current batch.');
    }
    
    return { btcMarkets, shortMarkets, allMarkets: markets };
    
  } catch (error) {
    console.error('❌ Error discovering markets:', error.message);
    throw error;
  }
}

// Also try the events endpoint for more structured data
async function discoverEvents() {
  console.log('\n🔍 Fetching events from Gamma API...\n');
  
  try {
    const response = await fetch(`${GAMMA_API}/events?closed=false&limit=50`);
    
    if (!response.ok) {
      throw new Error(`Events API error: ${response.status}`);
    }
    
    const events = await response.json();
    
    const btcEvents = events.filter(e => 
      e.title?.toLowerCase().includes('bitcoin') ||
      e.title?.toLowerCase().includes('btc')
    );
    
    console.log(`📊 Found ${btcEvents.length} Bitcoin-related events:\n`);
    
    for (const event of btcEvents.slice(0, 10)) {
      console.log('─'.repeat(80));
      console.log(`📌 Event: ${event.title}`);
      console.log(`   Slug: ${event.slug}`);
      console.log(`   ID: ${event.id}`);
      
      if (event.markets && event.markets.length > 0) {
        console.log(`   Markets (${event.markets.length}):`);
        for (const market of event.markets.slice(0, 5)) {
          console.log(`     - ${market.question}`);
          console.log(`       ID: ${market.id}`);
          if (market.tokens) {
            for (const token of market.tokens) {
              console.log(`       Token [${token.outcome}]: ${token.token_id}`);
            }
          }
        }
      }
      console.log('');
    }
    
    return btcEvents;
    
  } catch (error) {
    console.error('❌ Error fetching events:', error.message);
  }
}

// Main execution
console.log('═'.repeat(80));
console.log('     POLYMARKET MARKET DISCOVERY');
console.log('═'.repeat(80));
console.log('');

const results = await discoverMarkets();
await discoverEvents();

console.log('\n═'.repeat(80));
console.log('     SUMMARY');
console.log('═'.repeat(80));
console.log(`\n✅ Total markets scanned: ${results.allMarkets.length}`);
console.log(`✅ Bitcoin markets found: ${results.btcMarkets.length}`);
console.log(`✅ Short-duration markets: ${results.shortMarkets.length}`);
console.log('\n💡 Use the token IDs above with the orderbook and websocket scripts.');

