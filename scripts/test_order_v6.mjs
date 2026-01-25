#!/usr/bin/env node
/**
 * Test order placement with ethers v6 compatibility fix
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA_API = 'https://gamma-api.polymarket.com';

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const FUNDER = process.env.POLYMARKET_FUNDER_ADDRESS;

// Create a wrapper that makes ethers v6 Wallet compatible with ethers v5 interface
function createV5CompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    
    // Add _signTypedData method that ethers v5 had (now signTypedData in v6)
    wallet._signTypedData = async (domain, types, value) => {
        return wallet.signTypedData(domain, types, value);
    };
    
    return wallet;
}

async function getCurrentMarket(crypto = 'btc') {
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = await response.json();
    
    if (markets && markets.length > 0) {
        const market = markets[0];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        return {
            slug,
            upTokenId: tokenIds[0],
            downTokenId: tokenIds[1],
            endDate: new Date(market.endDate)
        };
    }
    throw new Error(`Market not found: ${slug}`);
}

async function main() {
    const command = process.argv[2] || 'check';
    const crypto = process.argv[3] || 'btc';
    
    console.log('═'.repeat(60));
    console.log(`     ${command.toUpperCase()} - ${crypto.toUpperCase()}`);
    console.log('═'.repeat(60));
    
    if (!PRIVATE_KEY) {
        console.error('❌ POLYMARKET_PRIVATE_KEY not set');
        process.exit(1);
    }
    
    // Create v5-compatible wallet
    const wallet = createV5CompatibleWallet(PRIVATE_KEY);
    console.log(`\nSigner: ${wallet.address}`);
    console.log(`Funder: ${FUNDER}`);
    
    // Create client and derive credentials
    console.log('\n🔐 Deriving API credentials...');
    const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
    const creds = await baseClient.deriveApiKey();
    console.log(`   API Key: ${creds.key.substring(0, 8)}...`);
    
    // Create authenticated client
    // Try signatureType 0 (EOA) - maker = signer = wallet address
    const sigType = parseInt(process.env.POLYMARKET_SIG_TYPE || '0');
    const funder = sigType === 0 ? wallet.address : FUNDER;
    console.log(`   Signature Type: ${sigType} (${sigType === 0 ? 'EOA' : 'Proxy'})`);
    console.log(`   Maker/Funder: ${funder}`);
    
    const client = new ClobClient(
        HOST,
        CHAIN_ID,
        wallet,
        creds,
        sigType,
        funder
    );
    
    if (command === 'check') {
        // Test balance
        console.log('\n💰 Checking balance...');
        try {
            const balance = await client.getBalanceAllowance();
            console.log('   Balance:', JSON.stringify(balance, null, 2));
        } catch (e) {
            console.log('   Error:', e.message);
        }
        
        // Test open orders
        console.log('\n📋 Checking open orders...');
        try {
            const orders = await client.getOpenOrders();
            console.log(`   Open orders: ${orders?.length || 0}`);
        } catch (e) {
            console.log('   Error:', e.message);
        }
    }
    
    if (command === 'book') {
        const market = await getCurrentMarket(crypto);
        console.log(`\nMarket: ${market.slug}`);
        
        const book = await client.getOrderBook(market.upTokenId);
        const bids = book.bids || [];
        const asks = book.asks || [];
        
        console.log('\n📗 BIDS:');
        bids.slice(0, 5).forEach(b => {
            console.log(`   ${parseFloat(b.price).toFixed(4)} - $${(parseFloat(b.size) * parseFloat(b.price)).toFixed(2)}`);
        });
        
        console.log('\n📕 ASKS:');
        asks.slice(0, 5).forEach(a => {
            console.log(`   ${parseFloat(a.price).toFixed(4)} - $${(parseFloat(a.size) * parseFloat(a.price)).toFixed(2)}`);
        });
        
        if (bids.length && asks.length) {
            const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
            const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
            console.log(`\nSpread: ${((bestAsk - bestBid) * 100).toFixed(2)}%`);
        }
    }
    
    if (command === 'buy') {
        const market = await getCurrentMarket(crypto);
        console.log(`\nMarket: ${market.slug}`);
        
        // Get order book for pricing
        const book = await client.getOrderBook(market.upTokenId);
        const asks = book.asks || [];
        
        if (asks.length === 0) {
            console.log('❌ No asks in order book');
            return;
        }
        
        const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
        const buyPrice = Math.min(bestAsk + 0.01, 0.99);
        const size = 1; // $1
        
        console.log(`\n📊 Order details:`);
        console.log(`   Side: BUY`);
        console.log(`   Token: UP`);
        console.log(`   Best Ask: ${bestAsk.toFixed(4)}`);
        console.log(`   Our Price: ${buyPrice.toFixed(4)}`);
        console.log(`   Size: $${size}`);
        
        console.log('\n⚠️  Placing REAL order in 3 seconds... (Ctrl+C to cancel)');
        await new Promise(r => setTimeout(r, 3000));
        
        console.log('\n📤 Placing order...');
        
        try {
            // Calculate shares to hit ~$1 minimum, round up
            const targetDollars = 1.10;  // Slightly above $1 min
            const shares = Math.ceil(targetDollars / buyPrice);
            const totalCost = shares * buyPrice;
            console.log(`   Shares: ${shares}`);
            console.log(`   Total Cost: $${totalCost.toFixed(2)}`);
            
            const order = await client.createAndPostOrder({
                tokenID: market.upTokenId,
                price: buyPrice,
                side: 'BUY',
                size: shares
            }, {
                tickSize: '0.01',
                negRisk: false
            }, 'GTC');  // GTC for better fill chances
            
            console.log('\n✅ Order response:');
            console.log(JSON.stringify(order, null, 2));
        } catch (e) {
            console.log('\n❌ Order failed:', e.message);
            if (e.response?.data) {
                console.log('   Details:', e.response.data);
            }
        }
    }
    
    if (command === 'sell') {
        const market = await getCurrentMarket(crypto);
        console.log(`\nMarket: ${market.slug}`);
        
        const book = await client.getOrderBook(market.upTokenId);
        const bids = book.bids || [];
        
        if (bids.length === 0) {
            console.log('❌ No bids in order book');
            return;
        }
        
        const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
        const sellPrice = Math.max(bestBid - 0.01, 0.01);
        const size = 1;
        
        console.log(`\n📊 Order details:`);
        console.log(`   Side: SELL`);
        console.log(`   Token: UP`);
        console.log(`   Best Bid: ${bestBid.toFixed(4)}`);
        console.log(`   Our Price: ${sellPrice.toFixed(4)}`);
        console.log(`   Size: $${size}`);
        
        console.log('\n⚠️  Placing REAL order in 3 seconds... (Ctrl+C to cancel)');
        await new Promise(r => setTimeout(r, 3000));
        
        console.log('\n📤 Placing order...');
        
        try {
            const order = await client.createAndPostOrder({
                tokenID: market.upTokenId,
                price: sellPrice,
                side: 'SELL',
                size: size / sellPrice
            }, {
                tickSize: '0.01',
                negRisk: false
            }, 'FOK');
            
            console.log('\n✅ Order response:');
            console.log(JSON.stringify(order, null, 2));
        } catch (e) {
            console.log('\n❌ Order failed:', e.message);
        }
    }
    
    console.log('\n✅ Done');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
