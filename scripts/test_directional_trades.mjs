#!/usr/bin/env node
/**
 * Test Directional Trades
 * 
 * Places 10 small trades directionally across different markets.
 * If market is currently UP (spot > strike), buy UP.
 * If market is currently DOWN (spot < strike), buy DOWN.
 * 
 * Purpose: Test that the order counter cleanup works at window end.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { SDKClient } from '../src/execution/sdk_client.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const BINANCE_API = 'https://api.binance.com';

// Map crypto to Binance symbol
const BINANCE_SYMBOLS = {
    btc: 'BTCUSDT',
    eth: 'ETHUSDT',
    sol: 'SOLUSDT',
    xrp: 'XRPUSDT'
};

async function getSpotPrice(crypto) {
    const symbol = BINANCE_SYMBOLS[crypto];
    const response = await fetch(`${BINANCE_API}/api/v3/ticker/price?symbol=${symbol}`);
    const data = await response.json();
    return parseFloat(data.price);
}

// getCurrentMarket is now provided by SDKClient

async function createClient() {
    const client = new SDKClient({ logger: console });
    await client.initialize();
    return client;
}

async function placeDirectionalTrade(client, crypto, tradeNumber) {
    try {
        // Get market using SDKClient method
        const market = await client.getCurrentMarket(crypto);
        const timeRemaining = Math.floor(market.timeRemaining);
        
        if (timeRemaining < 30) {
            console.log(`   ⏰ ${crypto.toUpperCase()}: Skipping - only ${timeRemaining}s left`);
            return null;
        }
        
        // Get spot price
        const spotPrice = await getSpotPrice(crypto);
        
        // Get order book to determine mid price (proxy for market direction)
        const upPrices = await client.getBestPrices(market.upTokenId);
        
        // Determine direction: if UP is trading > 50%, market thinks UP, else DOWN
        const marketDirection = upPrices.midpoint > 0.5 ? 'up' : 'down';
        const tokenId = marketDirection === 'up' ? market.upTokenId : market.downTokenId;
        
        // Get best prices for chosen direction
        const prices = marketDirection === 'up' ? upPrices : await client.getBestPrices(market.downTokenId);
        
        const buyPrice = Math.round(Math.min(prices.ask + 0.03, 0.99) * 100) / 100; // +3 cent buffer, round to 2dp
        const size = 1; // $1
        
        console.log(`   📊 ${crypto.toUpperCase()} ${marketDirection.toUpperCase()}: spot=$${spotPrice.toFixed(2)}, mid=${upPrices.midpoint.toFixed(2)}, price=${buyPrice.toFixed(2)}, ${timeRemaining}s left`);
        
        // Place order using SDKClient buy method
        const result = await client.buy(tokenId, size, buyPrice, 'FOK');
        
        if (result && result.filled) {
            console.log(`   ✅ Trade #${tradeNumber}: ${crypto.toUpperCase()} ${marketDirection.toUpperCase()} @ ${buyPrice} FILLED (${result.shares} shares)`);
            return { crypto, direction: marketDirection, price: buyPrice, success: true };
        } else {
            console.log(`   ⚠️ Trade #${tradeNumber}: ${crypto.toUpperCase()} - ${result?.error || 'No fill'}`);
            return { crypto, direction: marketDirection, price: buyPrice, success: false, response: result };
        }
        
    } catch (error) {
        console.log(`   ❌ ${crypto.toUpperCase()}: ${error.message}`);
        return { crypto, error: error.message };
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('     DIRECTIONAL TEST TRADES');
    console.log('═'.repeat(60));
    
    const now = Math.floor(Date.now() / 1000);
    const currentEpoch = Math.floor(now / 900) * 900;
    const nextEpoch = currentEpoch + 900;
    const timeRemaining = nextEpoch - now;
    
    console.log(`\n⏰ Current window: ${new Date(currentEpoch * 1000).toISOString()}`);
    console.log(`   Time remaining: ${timeRemaining}s (${(timeRemaining/60).toFixed(1)} min)`);
    console.log(`   Next window: ${new Date(nextEpoch * 1000).toISOString()}`);
    
    if (timeRemaining < 60) {
        console.log('\n⚠️ Less than 60s remaining. Waiting for next window would be safer.');
        console.log('   Proceeding anyway for testing...');
    }
    
    console.log('\n🔐 Creating client...');
    const client = await createClient();
    
    console.log('\n📤 Placing 10 directional trades...\n');
    
    const cryptos = ['btc', 'eth', 'sol', 'xrp'];
    const results = [];
    let tradeNum = 1;
    
    // Place ~2-3 trades per crypto to get to 10 total
    for (let round = 0; round < 3; round++) {
        for (const crypto of cryptos) {
            if (tradeNum > 10) break;
            
            const result = await placeDirectionalTrade(client, crypto, tradeNum);
            if (result) {
                results.push(result);
                tradeNum++;
            }
            
            // Small delay between orders
            await new Promise(r => setTimeout(r, 500));
        }
        if (tradeNum > 10) break;
    }
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('     SUMMARY');
    console.log('═'.repeat(60));
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success && !r.error);
    const errors = results.filter(r => r.error);
    
    console.log(`\n   Total trades attempted: ${results.length}`);
    console.log(`   Successful: ${successful.length}`);
    console.log(`   Failed/No fill: ${failed.length}`);
    console.log(`   Errors: ${errors.length}`);
    
    if (successful.length > 0) {
        console.log('\n   Successful trades:');
        for (const r of successful) {
            console.log(`     - ${r.crypto.toUpperCase()} ${r.direction.toUpperCase()} @ ${r.price}`);
        }
    }
    
    console.log(`\n⏳ Window ends at: ${new Date(nextEpoch * 1000).toISOString()}`);
    console.log('   Watch Railway logs for "[RiskManager] Cleaned up X stale positions"');
    console.log('   Or check: railway logs | grep -i "clean\\|stale\\|order"');
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
