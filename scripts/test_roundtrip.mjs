#!/usr/bin/env node
/**
 * Test Round-Trip Order Execution
 * 
 * This script tests the complete buy → sell cycle on Polymarket.
 * Uses all the production-tested patterns we've discovered.
 * 
 * Usage:
 *   node scripts/test_roundtrip.mjs              # Default: $1 test on BTC
 *   node scripts/test_roundtrip.mjs --crypto=xrp # Test on XRP
 *   node scripts/test_roundtrip.mjs --dollars=2  # $2 test
 *   node scripts/test_roundtrip.mjs --dry-run    # Show what would happen
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Parse command line args
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.replace('--', '').split('=');
    acc[key] = value || true;
    return acc;
}, {});

const CONFIG = {
    crypto: args.crypto || 'btc',
    dollars: parseFloat(args.dollars) || 1.0,
    dryRun: args['dry-run'] || false,
    side: args.side || 'up',  // 'up' or 'down'
    waitBetweenOrders: 5000   // ms
};

// ═══════════════════════════════════════════════════════════════════════════
// ETHERS V6 COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════

function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    // Add _signTypedData for ethers v5 compatibility (SDK expects this)
    wallet._signTypedData = async (domain, types, value) => {
        return wallet.signTypedData(domain, types, value);
    };
    return wallet;
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function getCurrentMarket(crypto) {
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = await response.json();
    
    if (!markets || markets.length === 0) {
        throw new Error(`Market not found: ${slug}`);
    }
    
    const market = markets[0];
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const endDate = new Date(market.endDate);
    const timeRemaining = Math.max(0, (endDate.getTime() - Date.now()) / 1000);
    
    return {
        slug,
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        endDate,
        timeRemaining
    };
}

async function getOrderBookSummary(client, tokenId) {
    const book = await client.getOrderBook(tokenId);
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    const bestBid = bids.length > 0 
        ? Math.max(...bids.map(b => parseFloat(b.price))) 
        : 0;
    const bestAsk = asks.length > 0 
        ? Math.min(...asks.map(a => parseFloat(a.price))) 
        : 1;
    
    const bidDepth = bids.reduce((sum, b) => 
        sum + parseFloat(b.size) * parseFloat(b.price), 0);
    const askDepth = asks.reduce((sum, a) => 
        sum + parseFloat(a.size) * parseFloat(a.price), 0);
    
    return {
        bestBid,
        bestAsk,
        spread: bestAsk - bestBid,
        spreadPct: ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 100),
        bidDepth,
        askDepth,
        midpoint: (bestBid + bestAsk) / 2
    };
}

async function getBalance(client, tokenId) {
    try {
        const bal = await client.getBalanceAllowance({ 
            asset_type: 'CONDITIONAL', 
            token_id: tokenId 
        });
        return parseFloat(bal.balance) / 1_000_000;  // Convert from micro-units
    } catch (e) {
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('     POLYMARKET ROUND-TRIP TEST');
    console.log('═'.repeat(70));
    console.log(`Crypto: ${CONFIG.crypto.toUpperCase()}`);
    console.log(`Target: $${CONFIG.dollars}`);
    console.log(`Side: ${CONFIG.side.toUpperCase()}`);
    console.log(`Mode: ${CONFIG.dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log('═'.repeat(70) + '\n');
    
    // Validate environment
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
    
    if (!privateKey) {
        console.error('❌ POLYMARKET_PRIVATE_KEY not set');
        process.exit(1);
    }
    if (!funder) {
        console.error('❌ POLYMARKET_FUNDER_ADDRESS not set');
        process.exit(1);
    }
    
    // Create wallet and client
    console.log('🔐 Setting up client...');
    const wallet = createCompatibleWallet(privateKey);
    console.log(`   Signer: ${wallet.address}`);
    console.log(`   Funder: ${funder}`);
    
    // Derive API credentials
    const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
    const creds = await baseClient.deriveApiKey();
    console.log(`   API Key: ${creds.key.substring(0, 8)}...`);
    
    // Create authenticated client with signature type 2
    const client = new ClobClient(HOST, CHAIN_ID, wallet, creds, 2, funder);
    console.log('   ✅ Client ready (signature type 2)\n');
    
    // Get current market
    console.log('📊 Fetching market...');
    const market = await getCurrentMarket(CONFIG.crypto);
    console.log(`   Market: ${market.slug}`);
    console.log(`   Time remaining: ${Math.floor(market.timeRemaining)}s`);
    
    if (market.timeRemaining < 60) {
        console.log('   ⚠️  Less than 60s remaining - waiting for next window...');
        const waitTime = (900 - (Math.floor(Date.now() / 1000) % 900) + 5) * 1000;
        console.log(`   Waiting ${Math.floor(waitTime / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        Object.assign(market, await getCurrentMarket(CONFIG.crypto));
        console.log(`   New market: ${market.slug}`);
    }
    
    // Select token based on side
    const tokenId = CONFIG.side === 'up' ? market.upTokenId : market.downTokenId;
    const tokenLabel = CONFIG.side.toUpperCase();
    console.log(`   Token (${tokenLabel}): ${tokenId.substring(0, 20)}...\n`);
    
    // Get order book
    console.log('📗 Order book summary...');
    const book = await getOrderBookSummary(client, tokenId);
    console.log(`   Best Bid: $${book.bestBid.toFixed(4)}`);
    console.log(`   Best Ask: $${book.bestAsk.toFixed(4)}`);
    console.log(`   Spread: ${(book.spread * 100).toFixed(2)}% ($${book.spread.toFixed(4)})`);
    console.log(`   Bid Depth: $${book.bidDepth.toFixed(2)}`);
    console.log(`   Ask Depth: $${book.askDepth.toFixed(2)}\n`);
    
    // Check initial balance
    const initialBalance = await getBalance(client, tokenId);
    console.log(`💰 Initial ${tokenLabel} balance: ${initialBalance.toFixed(6)} shares\n`);
    
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: BUY
    // ─────────────────────────────────────────────────────────────────────────
    
    console.log('─'.repeat(50));
    console.log('     PHASE 1: BUY');
    console.log('─'.repeat(50));
    
    const buyPrice = Math.min(book.bestAsk + 0.01, 0.99);  // Slightly above ask
    const buyShares = Math.ceil(CONFIG.dollars / buyPrice);  // Round up to meet $1 min
    const buyCost = buyShares * buyPrice;
    
    console.log(`   Price: $${buyPrice.toFixed(4)} (best ask + 1c)`);
    console.log(`   Shares: ${buyShares}`);
    console.log(`   Total Cost: $${buyCost.toFixed(2)}`);
    
    if (CONFIG.dryRun) {
        console.log('\n   🔸 DRY RUN - Skipping actual order\n');
    } else {
        console.log('\n   ⚠️  Placing REAL buy order in 3 seconds...');
        await new Promise(r => setTimeout(r, 3000));
        
        try {
            const buyOrder = await client.createAndPostOrder({
                tokenID: tokenId,
                price: buyPrice,
                side: 'BUY',
                size: buyShares
            }, {
                tickSize: '0.01',
                negRisk: false
            }, 'GTC');
            
            console.log('\n   ✅ BUY ORDER RESULT:');
            console.log(`      Order ID: ${buyOrder.orderID}`);
            console.log(`      Status: ${buyOrder.status}`);
            console.log(`      Making: ${buyOrder.makingAmount} USDC`);
            console.log(`      Taking: ${buyOrder.takingAmount} shares`);
            if (buyOrder.transactionsHashes?.length) {
                console.log(`      Tx: ${buyOrder.transactionsHashes[0]}`);
            }
        } catch (e) {
            console.log(`\n   ❌ BUY FAILED: ${e.message}`);
            process.exit(1);
        }
    }
    
    // Wait for settlement
    console.log(`\n   ⏳ Waiting ${CONFIG.waitBetweenOrders / 1000}s for settlement...\n`);
    await new Promise(r => setTimeout(r, CONFIG.waitBetweenOrders));
    
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: CHECK BALANCE
    // ─────────────────────────────────────────────────────────────────────────
    
    console.log('─'.repeat(50));
    console.log('     PHASE 2: CHECK BALANCE');
    console.log('─'.repeat(50));
    
    const postBuyBalance = await getBalance(client, tokenId);
    const sharesReceived = postBuyBalance - initialBalance;
    
    console.log(`   Initial: ${initialBalance.toFixed(6)} shares`);
    console.log(`   After Buy: ${postBuyBalance.toFixed(6)} shares`);
    console.log(`   Received: ${sharesReceived.toFixed(6)} shares`);
    console.log(`   Expected: ${buyShares} shares`);
    console.log(`   Difference: ${(sharesReceived - buyShares).toFixed(6)} (fees)\n`);
    
    if (postBuyBalance < 1) {
        console.log('   ⚠️  Balance too low to sell (< 1 share)');
        console.log('   Ending test early.\n');
        process.exit(0);
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: SELL
    // ─────────────────────────────────────────────────────────────────────────
    
    console.log('─'.repeat(50));
    console.log('     PHASE 3: SELL');
    console.log('─'.repeat(50));
    
    // Refresh order book
    const bookAfterBuy = await getOrderBookSummary(client, tokenId);
    console.log(`   Current Bid: $${bookAfterBuy.bestBid.toFixed(4)}`);
    
    const sellPrice = bookAfterBuy.bestBid;
    const sellShares = Math.floor(postBuyBalance);  // Sell whole shares only
    const sellValue = sellShares * sellPrice;
    
    console.log(`   Price: $${sellPrice.toFixed(4)} (at bid)`);
    console.log(`   Shares: ${sellShares}`);
    console.log(`   Expected Return: $${sellValue.toFixed(2)}`);
    
    if (CONFIG.dryRun) {
        console.log('\n   🔸 DRY RUN - Skipping actual order\n');
    } else {
        console.log('\n   ⚠️  Placing REAL sell order in 3 seconds...');
        await new Promise(r => setTimeout(r, 3000));
        
        try {
            const sellOrder = await client.createAndPostOrder({
                tokenID: tokenId,
                price: sellPrice,
                side: 'SELL',
                size: sellShares
            }, {
                tickSize: '0.01',
                negRisk: false
            }, 'GTC');
            
            console.log('\n   ✅ SELL ORDER RESULT:');
            console.log(`      Order ID: ${sellOrder.orderID}`);
            console.log(`      Status: ${sellOrder.status}`);
            console.log(`      Making: ${sellOrder.makingAmount} shares`);
            console.log(`      Taking: ${sellOrder.takingAmount} USDC`);
            if (sellOrder.transactionsHashes?.length) {
                console.log(`      Tx: ${sellOrder.transactionsHashes[0]}`);
            }
        } catch (e) {
            console.log(`\n   ❌ SELL FAILED: ${e.message}`);
            process.exit(1);
        }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    
    console.log('\n' + '═'.repeat(70));
    console.log('     ROUND-TRIP SUMMARY');
    console.log('═'.repeat(70));
    
    if (!CONFIG.dryRun) {
        const finalBalance = await getBalance(client, tokenId);
        const grossPnL = sellValue - buyCost;
        const fees = (buyShares - sharesReceived) * buyPrice;  // Approximate
        
        console.log(`   Entry: $${buyCost.toFixed(4)} for ${buyShares} shares @ $${buyPrice.toFixed(4)}`);
        console.log(`   Exit:  $${sellValue.toFixed(4)} for ${sellShares} shares @ $${sellPrice.toFixed(4)}`);
        console.log(`   Gross P&L: $${grossPnL.toFixed(4)}`);
        console.log(`   Est. Fees: $${fees.toFixed(4)}`);
        console.log(`   Net P&L: ~$${(grossPnL - fees).toFixed(4)}`);
        console.log(`   Final Balance: ${finalBalance.toFixed(6)} shares`);
    } else {
        const theoreticalPnL = (sellPrice - buyPrice) * sellShares;
        console.log(`   Would Buy: ${buyShares} shares @ $${buyPrice.toFixed(4)} = $${buyCost.toFixed(2)}`);
        console.log(`   Would Sell: ${sellShares} shares @ $${sellPrice.toFixed(4)} = $${sellValue.toFixed(2)}`);
        console.log(`   Theoretical P&L: $${theoreticalPnL.toFixed(4)} (before fees)`);
    }
    
    console.log('═'.repeat(70) + '\n');
    console.log('✅ Test complete!\n');
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
