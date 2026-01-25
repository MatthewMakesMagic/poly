#!/usr/bin/env node
/**
 * Simple Live Order Test
 * 
 * Uses the official @polymarket/clob-client to test orders.
 * This handles all the signing complexity for you.
 * 
 * Usage:
 *   node scripts/test_order_simple.mjs check     # Check connection & balances
 *   node scripts/test_order_simple.mjs markets   # List available markets
 *   node scripts/test_order_simple.mjs book      # Show order book
 *   node scripts/test_order_simple.mjs buy       # Buy $1 of UP tokens
 *   node scripts/test_order_simple.mjs sell      # Sell $1 of UP tokens
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// Gamma API for market discovery
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function getCredentials() {
    // Check what credentials we have
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    
    console.log('\n📋 Checking credentials...');
    console.log(`   API Key: ${apiKey ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Secret: ${secret ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Passphrase: ${passphrase ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Private Key: ${privateKey ? '✅ Set' : '❌ Missing'}`);
    
    if (!apiKey || !secret || !passphrase) {
        throw new Error('Missing API credentials. Add to .env.local');
    }
    
    return { apiKey, secret, passphrase, privateKey };
}

async function createClient() {
    const creds = await getCredentials();
    
    let client;
    const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
    
    if (creds.privateKey) {
        // Full client with signing capability
        console.log('\n🔐 Creating client with signing capability...');
        const wallet = new Wallet(creds.privateKey);
        console.log(`   Signer address: ${wallet.address}`);
        console.log(`   Funder address: ${funderAddress || 'not set'}`);
        
        // For Polymarket proxy wallets, we need signature type 1
        // and the funder address should be the Polymarket profile address
        client = new ClobClient(
            HOST,
            CHAIN_ID,
            wallet,
            {
                key: creds.apiKey,
                secret: creds.secret,
                passphrase: creds.passphrase
            },
            1,  // signatureType: 1 = Poly Proxy
            funderAddress || wallet.address
        );
    } else {
        // API-only client (read operations only)
        console.log('\n📖 Creating read-only client (no private key)...');
        client = new ClobClient(HOST, CHAIN_ID);
    }
    
    return { client, creds, funderAddress };
}

async function getCurrentMarket(crypto = 'btc') {
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    console.log(`\n🔍 Fetching market: ${slug}`);
    
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = await response.json();
    
    if (!markets || markets.length === 0) {
        throw new Error(`Market not found: ${slug}`);
    }
    
    const market = markets[0];
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    
    return {
        slug,
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        endDate: new Date(market.endDate)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

async function checkConnection() {
    console.log('═'.repeat(60));
    console.log('     CONNECTION CHECK');
    console.log('═'.repeat(60));
    
    const { client, creds } = await createClient();
    
    // Test server time
    console.log('\n⏰ Checking server time...');
    try {
        const time = await client.getServerTime();
        console.log(`   Server time: ${new Date(time * 1000).toISOString()}`);
    } catch (e) {
        console.log(`   ❌ Failed: ${e.message}`);
    }
    
    // Test API key if we have credentials
    if (creds.privateKey) {
        console.log('\n🔑 Checking API key...');
        try {
            const apiKeys = await client.getApiKeys();
            console.log(`   API Keys: ${JSON.stringify(apiKeys)}`);
        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
        
        // Check balances
        console.log('\n💰 Checking balances...');
        try {
            const balances = await client.getBalanceAllowance();
            console.log(`   Balances:`, balances);
        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
    }
    
    console.log('\n✅ Connection check complete');
}

async function showMarkets() {
    console.log('═'.repeat(60));
    console.log('     CURRENT 15-MIN MARKETS');
    console.log('═'.repeat(60));
    
    for (const crypto of ['btc', 'eth', 'sol', 'xrp']) {
        try {
            const market = await getCurrentMarket(crypto);
            const timeRemaining = Math.max(0, Math.floor((market.endDate.getTime() - Date.now()) / 1000));
            console.log(`\n${crypto.toUpperCase()}:`);
            console.log(`   Slug: ${market.slug}`);
            console.log(`   Up Token: ${market.upTokenId}`);
            console.log(`   Time Remaining: ${timeRemaining}s`);
        } catch (e) {
            console.log(`\n${crypto.toUpperCase()}: ❌ ${e.message}`);
        }
    }
}

async function showOrderBook(crypto = 'btc') {
    console.log('═'.repeat(60));
    console.log(`     ORDER BOOK: ${crypto.toUpperCase()}`);
    console.log('═'.repeat(60));
    
    const { client } = await createClient();
    const market = await getCurrentMarket(crypto);
    
    console.log(`\nFetching order book for UP token...`);
    const book = await client.getOrderBook(market.upTokenId);
    
    console.log('\n📗 BIDS (buyers):');
    const bids = (book.bids || []).slice(0, 5);
    for (const bid of bids) {
        console.log(`   ${parseFloat(bid.price).toFixed(4)} - $${(parseFloat(bid.size) * parseFloat(bid.price)).toFixed(2)}`);
    }
    
    console.log('\n📕 ASKS (sellers):');
    const asks = (book.asks || []).slice(0, 5);
    for (const ask of asks) {
        console.log(`   ${parseFloat(ask.price).toFixed(4)} - $${(parseFloat(ask.size) * parseFloat(ask.price)).toFixed(2)}`);
    }
    
    // Calculate spread
    if (bids.length > 0 && asks.length > 0) {
        const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
        const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
        const spread = bestAsk - bestBid;
        const mid = (bestBid + bestAsk) / 2;
        
        console.log('\n📊 Summary:');
        console.log(`   Best Bid: ${bestBid.toFixed(4)}`);
        console.log(`   Best Ask: ${bestAsk.toFixed(4)}`);
        console.log(`   Spread: ${spread.toFixed(4)} (${((spread/mid)*100).toFixed(2)}%)`);
        console.log(`   Midpoint: ${mid.toFixed(4)}`);
    }
}

async function placeBuyOrder(crypto = 'btc', size = 1) {
    console.log('═'.repeat(60));
    console.log(`     BUY $${size} OF ${crypto.toUpperCase()} UP`);
    console.log('═'.repeat(60));
    
    const { client, creds } = await createClient();
    
    if (!creds.privateKey) {
        console.log('\n❌ Cannot place orders without POLYMARKET_PRIVATE_KEY');
        console.log('   Add your wallet private key to .env.local');
        return;
    }
    
    const market = await getCurrentMarket(crypto);
    
    // Get current price
    const book = await client.getOrderBook(market.upTokenId);
    const asks = book.asks || [];
    
    if (asks.length === 0) {
        console.log('\n❌ No asks in order book');
        return;
    }
    
    const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
    const buyPrice = Math.min(bestAsk + 0.01, 0.99);  // Add 1 cent buffer
    
    console.log(`\n📊 Market state:`);
    console.log(`   Best Ask: ${bestAsk.toFixed(4)}`);
    console.log(`   Buy Price: ${buyPrice.toFixed(4)}`);
    console.log(`   Size: $${size}`);
    
    console.log('\n⚠️  Placing REAL order in 3 seconds... (Ctrl+C to cancel)');
    await sleep(3000);
    
    console.log('\n📤 Placing order...');
    
    try {
        const order = await client.createAndPostOrder({
            tokenID: market.upTokenId,
            price: buyPrice,
            side: 'BUY',
            size: size / buyPrice,  // Convert $ to shares
        }, {
            tickSize: '0.01',
            negRisk: false
        }, 'FOK');  // Fill or Kill
        
        console.log('\n✅ Order response:', JSON.stringify(order, null, 2));
        
    } catch (error) {
        console.log('\n❌ Order failed:', error.message);
        if (error.response) {
            console.log('   Response:', error.response.data);
        }
    }
}

async function placeSellOrder(crypto = 'btc', size = 1) {
    console.log('═'.repeat(60));
    console.log(`     SELL $${size} OF ${crypto.toUpperCase()} UP`);
    console.log('═'.repeat(60));
    
    const { client, creds } = await createClient();
    
    if (!creds.privateKey) {
        console.log('\n❌ Cannot place orders without POLYMARKET_PRIVATE_KEY');
        return;
    }
    
    const market = await getCurrentMarket(crypto);
    
    // Get current price
    const book = await client.getOrderBook(market.upTokenId);
    const bids = book.bids || [];
    
    if (bids.length === 0) {
        console.log('\n❌ No bids in order book');
        return;
    }
    
    const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
    const sellPrice = Math.max(bestBid - 0.01, 0.01);  // Subtract 1 cent buffer
    
    console.log(`\n📊 Market state:`);
    console.log(`   Best Bid: ${bestBid.toFixed(4)}`);
    console.log(`   Sell Price: ${sellPrice.toFixed(4)}`);
    console.log(`   Size: $${size}`);
    
    console.log('\n⚠️  Placing REAL order in 3 seconds... (Ctrl+C to cancel)');
    await sleep(3000);
    
    console.log('\n📤 Placing order...');
    
    try {
        const order = await client.createAndPostOrder({
            tokenID: market.upTokenId,
            price: sellPrice,
            side: 'SELL',
            size: size / sellPrice,
        }, {
            tickSize: '0.01',
            negRisk: false
        }, 'FOK');
        
        console.log('\n✅ Order response:', JSON.stringify(order, null, 2));
        
    } catch (error) {
        console.log('\n❌ Order failed:', error.message);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    const command = process.argv[2] || 'check';
    const arg = process.argv[3] || 'btc';
    
    console.log(`\n🚀 Running command: ${command}\n`);
    
    switch (command) {
        case 'check':
            await checkConnection();
            break;
        case 'markets':
            await showMarkets();
            break;
        case 'book':
            await showOrderBook(arg);
            break;
        case 'buy':
            await placeBuyOrder(arg, 1);
            break;
        case 'sell':
            await placeSellOrder(arg, 1);
            break;
        default:
            console.log('Unknown command. Use: check, markets, book, buy, sell');
    }
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
