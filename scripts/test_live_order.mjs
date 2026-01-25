#!/usr/bin/env node
/**
 * Live Order Test Harness
 * 
 * CRITICAL VALIDATION SCRIPT
 * 
 * This script tests real order execution with $1 orders.
 * Run this BEFORE enabling any automated trading.
 * 
 * Tests:
 * 1. API connection and authentication
 * 2. Market data retrieval
 * 3. Order book reading
 * 4. Placing a $1 BUY order (limit order, far from market)
 * 5. Order status checking
 * 6. Order cancellation
 * 7. Placing a $1 market BUY order (will execute)
 * 8. Placing a $1 market SELL order (close position)
 * 9. P&L verification
 * 
 * Usage:
 *   node scripts/test_live_order.mjs [test_name]
 * 
 * Examples:
 *   node scripts/test_live_order.mjs              # Run all tests
 *   node scripts/test_live_order.mjs connection   # Test connection only
 *   node scripts/test_live_order.mjs limit        # Test limit order (no execution)
 *   node scripts/test_live_order.mjs market       # Test market order (WILL EXECUTE!)
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // Also try .env as fallback

import { PolymarketClient, Side, OrderType, createClientFromEnv } from '../src/execution/polymarket_client.js';

// Test configuration
const CONFIG = {
    testSize: 1,        // $1 test orders
    crypto: 'btc',      // Test on BTC market
    
    // Limit order test settings (order won't fill)
    limitOrderPriceOffset: 0.10,  // Place 10 cents away from market
    
    // Timeouts
    orderTimeout: 30000,     // 30 seconds
    cancelTimeout: 10000     // 10 seconds
};

// Test results tracking
let results = {
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: []
};

/**
 * Log test result
 */
function logResult(testName, passed, message, data = null) {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`\n${status}: ${testName}`);
    console.log(`   ${message}`);
    if (data) {
        console.log('   Data:', JSON.stringify(data, null, 2));
    }
    
    results.tests.push({ testName, passed, message, data });
    if (passed) results.passed++;
    else results.failed++;
}

/**
 * Test 1: API Connection
 */
async function testConnection(client) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 1: API Connection');
    console.log('═'.repeat(60));
    
    try {
        // Test server time
        console.log('→ Testing server time...');
        const time = await client.getTime();
        console.log(`   Server time: ${new Date(time.timestamp * 1000).toISOString()}`);
        
        // Test API key
        console.log('→ Testing API key authentication...');
        const keyInfo = await client.getApiKeyInfo();
        console.log(`   API Key valid for: ${keyInfo.address || 'unknown'}`);
        
        // Test balances
        console.log('→ Fetching balances...');
        const balances = await client.getBalances();
        console.log(`   Balances retrieved: ${Object.keys(balances).length} assets`);
        
        logResult('API Connection', true, 'All connection tests passed');
        return true;
        
    } catch (error) {
        logResult('API Connection', false, `Connection failed: ${error.message}`);
        return false;
    }
}

/**
 * Test 2: Market Data
 */
async function testMarketData(client) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 2: Market Data');
    console.log('═'.repeat(60));
    
    try {
        // Get current market
        console.log(`→ Fetching current ${CONFIG.crypto.toUpperCase()} market...`);
        const market = await client.getCurrentCryptoMarket(CONFIG.crypto);
        console.log(`   Market: ${market.slug}`);
        console.log(`   Up Token: ${market.upTokenId}`);
        console.log(`   Down Token: ${market.downTokenId}`);
        console.log(`   End Time: ${market.endDate.toISOString()}`);
        
        // Get order book
        console.log('→ Fetching order book...');
        const book = await client.getOrderBook(market.upTokenId);
        const bids = book.bids || [];
        const asks = book.asks || [];
        
        console.log(`   Bids: ${bids.length} levels`);
        console.log(`   Asks: ${asks.length} levels`);
        
        if (bids.length > 0) {
            const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
            const bidSize = bids.filter(b => parseFloat(b.price) === bestBid)
                              .reduce((s, b) => s + parseFloat(b.size), 0);
            console.log(`   Best Bid: ${bestBid.toFixed(4)} (size: ${bidSize.toFixed(2)})`);
        }
        
        if (asks.length > 0) {
            const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
            const askSize = asks.filter(a => parseFloat(a.price) === bestAsk)
                              .reduce((s, a) => s + parseFloat(a.size), 0);
            console.log(`   Best Ask: ${bestAsk.toFixed(4)} (size: ${askSize.toFixed(2)})`);
        }
        
        // Get midpoint
        console.log('→ Fetching midpoint...');
        const midpoint = await client.getMidpoint(market.upTokenId);
        console.log(`   Midpoint: ${midpoint.mid}`);
        
        // Get spread
        console.log('→ Fetching spread...');
        const spread = await client.getSpread(market.upTokenId);
        console.log(`   Spread: ${spread.spread}`);
        
        logResult('Market Data', true, 'All market data tests passed', { market: market.slug });
        return market;
        
    } catch (error) {
        logResult('Market Data', false, `Market data test failed: ${error.message}`);
        return null;
    }
}

/**
 * Test 3: Limit Order (Won't Fill)
 */
async function testLimitOrder(client, market) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 3: Limit Order (Non-Executing)');
    console.log('═'.repeat(60));
    
    if (!market) {
        logResult('Limit Order', false, 'Skipped - no market data');
        results.skipped++;
        return null;
    }
    
    try {
        // Get current best bid
        const book = await client.getOrderBook(market.upTokenId);
        const bids = book.bids || [];
        const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
        
        // Place order far below market (won't fill)
        const testPrice = Math.max(0.01, bestBid - CONFIG.limitOrderPriceOffset);
        
        console.log(`→ Current best bid: ${bestBid.toFixed(4)}`);
        console.log(`→ Placing limit order at: ${testPrice.toFixed(4)} (${CONFIG.limitOrderPriceOffset} below market)`);
        console.log(`   Size: $${CONFIG.testSize}`);
        console.log(`   This order should NOT fill.`);
        
        console.log('\n⏳ Placing order...');
        const response = await client.placeOrder({
            tokenId: market.upTokenId,
            price: testPrice,
            size: CONFIG.testSize,
            side: Side.BUY,
            orderType: OrderType.GTC
        });
        
        console.log(`   Order placed! ID: ${response.orderId}`);
        console.log(`   Status: ${response.status}`);
        
        // Wait a moment
        await sleep(2000);
        
        // Check order status
        console.log('→ Checking order status...');
        const orderStatus = await client.getOrder(response.orderId);
        console.log(`   Status: ${orderStatus.status}`);
        
        // Cancel order
        console.log('→ Cancelling order...');
        await client.cancelOrder(response.orderId);
        console.log('   Order cancelled successfully');
        
        logResult('Limit Order', true, 'Limit order placed and cancelled successfully', {
            orderId: response.orderId,
            price: testPrice,
            size: CONFIG.testSize
        });
        
        return response.orderId;
        
    } catch (error) {
        logResult('Limit Order', false, `Limit order test failed: ${error.message}`);
        return null;
    }
}

/**
 * Test 4: Market Order (WILL EXECUTE)
 */
async function testMarketOrder(client, market) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 4: Market Order (WILL EXECUTE - $1)');
    console.log('═'.repeat(60));
    
    if (!market) {
        logResult('Market Order', false, 'Skipped - no market data');
        results.skipped++;
        return null;
    }
    
    console.log('\n⚠️  WARNING: This test will execute a REAL $1 order!');
    console.log('    Press Ctrl+C within 5 seconds to abort...\n');
    
    await sleep(5000);
    
    try {
        // Get current prices
        const book = await client.getOrderBook(market.upTokenId);
        const asks = book.asks || [];
        const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
        
        console.log(`→ Current best ask: ${bestAsk.toFixed(4)}`);
        console.log(`→ Placing market BUY order for $${CONFIG.testSize}...`);
        
        // Place at best ask + small buffer
        const buyPrice = Math.min(bestAsk + 0.02, 0.99);
        
        const buyResponse = await client.placeOrder({
            tokenId: market.upTokenId,
            price: buyPrice,
            size: CONFIG.testSize,
            side: Side.BUY,
            orderType: OrderType.FOK  // Fill or Kill
        });
        
        console.log(`   Buy order response:`, buyResponse);
        
        // Check if filled
        if (buyResponse.status === 'filled' || buyResponse.status === 'matched') {
            console.log('   ✅ Buy order FILLED!');
            
            // Now close the position
            console.log('\n→ Closing position (market SELL)...');
            
            // Get current bid
            const bookAfter = await client.getOrderBook(market.upTokenId);
            const bids = bookAfter.bids || [];
            const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
            const sellPrice = Math.max(bestBid - 0.02, 0.01);
            
            const sellResponse = await client.placeOrder({
                tokenId: market.upTokenId,
                price: sellPrice,
                size: CONFIG.testSize,
                side: Side.SELL,
                orderType: OrderType.FOK
            });
            
            console.log(`   Sell order response:`, sellResponse);
            
            if (sellResponse.status === 'filled' || sellResponse.status === 'matched') {
                console.log('   ✅ Sell order FILLED!');
                
                // Calculate P&L
                const pnl = (sellPrice - buyPrice) * CONFIG.testSize;
                console.log(`\n   📊 Round-trip complete!`);
                console.log(`   Entry: ${buyPrice.toFixed(4)}`);
                console.log(`   Exit: ${sellPrice.toFixed(4)}`);
                console.log(`   P&L: $${pnl.toFixed(4)}`);
                
                logResult('Market Order', true, 'Market order round-trip successful', {
                    buyPrice,
                    sellPrice,
                    pnl
                });
            } else {
                logResult('Market Order', false, `Sell order did not fill: ${sellResponse.status}`);
            }
            
        } else {
            logResult('Market Order', false, `Buy order did not fill: ${buyResponse.status}`);
        }
        
        return buyResponse;
        
    } catch (error) {
        logResult('Market Order', false, `Market order test failed: ${error.message}`);
        return null;
    }
}

/**
 * Test 5: Order Cancellation
 */
async function testCancelAllOrders(client) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 5: Cancel All Orders');
    console.log('═'.repeat(60));
    
    try {
        console.log('→ Fetching open orders...');
        const openOrders = await client.getOpenOrders();
        console.log(`   Found ${openOrders.length || 0} open orders`);
        
        if (openOrders.length > 0) {
            console.log('→ Cancelling all orders...');
            await client.cancelAllOrders();
            console.log('   All orders cancelled');
        }
        
        logResult('Cancel All Orders', true, 'Order cancellation working');
        return true;
        
    } catch (error) {
        logResult('Cancel All Orders', false, `Cancel test failed: ${error.message}`);
        return false;
    }
}

/**
 * Helper: Sleep
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Print final results
 */
function printResults() {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST RESULTS SUMMARY');
    console.log('═'.repeat(60));
    console.log(`   Passed: ${results.passed}`);
    console.log(`   Failed: ${results.failed}`);
    console.log(`   Skipped: ${results.skipped}`);
    console.log('═'.repeat(60));
    
    if (results.failed === 0) {
        console.log('\n✅ ALL TESTS PASSED - System ready for live trading\n');
    } else {
        console.log('\n❌ SOME TESTS FAILED - Do NOT enable live trading\n');
        console.log('Failed tests:');
        for (const test of results.tests.filter(t => !t.passed)) {
            console.log(`   - ${test.testName}: ${test.message}`);
        }
        console.log('');
    }
}

/**
 * Main test runner
 */
async function main() {
    console.log('═'.repeat(60));
    console.log('     LIVE ORDER TEST HARNESS');
    console.log('═'.repeat(60));
    console.log(`   Test Size: $${CONFIG.testSize}`);
    console.log(`   Crypto: ${CONFIG.crypto.toUpperCase()}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('═'.repeat(60));
    
    // Check environment
    const requiredEnvVars = [
        'POLYMARKET_API_KEY',
        'POLYMARKET_SECRET',
        'POLYMARKET_PASSPHRASE',
        'POLYMARKET_PRIVATE_KEY'
    ];
    
    const missing = requiredEnvVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
        console.error('\n❌ Missing required environment variables:');
        for (const v of missing) {
            console.error(`   - ${v}`);
        }
        console.error('\nPlease set these in your .env file and try again.\n');
        process.exit(1);
    }
    
    // Parse command line args
    const testFilter = process.argv[2];
    
    // Initialize client
    let client;
    try {
        client = createClientFromEnv();
    } catch (error) {
        console.error(`\n❌ Failed to initialize client: ${error.message}`);
        process.exit(1);
    }
    
    // Run tests
    let market = null;
    
    // Test 1: Connection
    if (!testFilter || testFilter === 'connection' || testFilter === 'all') {
        const connected = await testConnection(client);
        if (!connected) {
            console.error('\n❌ Connection failed. Cannot continue.');
            printResults();
            process.exit(1);
        }
    }
    
    // Test 2: Market Data
    if (!testFilter || testFilter === 'market' || testFilter === 'all') {
        market = await testMarketData(client);
    }
    
    // Test 3: Limit Order (non-executing)
    if (!testFilter || testFilter === 'limit' || testFilter === 'all') {
        await testLimitOrder(client, market);
    }
    
    // Test 4: Market Order (WILL EXECUTE)
    if (testFilter === 'market' || testFilter === 'execute' || testFilter === 'all') {
        if (!market) {
            market = await testMarketData(client);
        }
        await testMarketOrder(client, market);
    }
    
    // Test 5: Cancel All
    if (!testFilter || testFilter === 'cancel' || testFilter === 'all') {
        await testCancelAllOrders(client);
    }
    
    // Print results
    printResults();
    
    process.exit(results.failed > 0 ? 1 : 0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
    console.error('\n❌ Unhandled error:', error);
    process.exit(1);
});

// Run
main();
