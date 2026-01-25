#!/usr/bin/env node
/**
 * Direct API Test
 * 
 * Manually test the Polymarket API with correct address handling.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import crypto from 'crypto';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Load credentials
const API_KEY = process.env.POLYMARKET_API_KEY;
const SECRET = process.env.POLYMARKET_SECRET;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const FUNDER = process.env.POLYMARKET_FUNDER_ADDRESS;

console.log('═'.repeat(60));
console.log('     DIRECT API TEST');
console.log('═'.repeat(60));

// Get wallet addresses
const wallet = PRIVATE_KEY ? new Wallet(PRIVATE_KEY) : null;
const signerAddress = wallet?.address;

console.log(`\n📋 Configuration:`);
console.log(`   API Key: ${API_KEY ? API_KEY.substring(0, 8) + '...' : 'missing'}`);
console.log(`   Secret: ${SECRET ? '***set***' : 'missing'}`);
console.log(`   Passphrase: ${PASSPHRASE ? PASSPHRASE.substring(0, 8) + '...' : 'missing'}`);
console.log(`   Signer (Coinbase): ${signerAddress || 'missing'}`);
console.log(`   Funder (Polymarket): ${FUNDER || 'missing'}`);

/**
 * Generate HMAC signature for L2 auth
 */
function generateSignature(method, path, timestamp, body = '') {
    const message = timestamp + method.toUpperCase() + path + body;
    const hmac = crypto.createHmac('sha256', Buffer.from(SECRET, 'base64'));
    hmac.update(message);
    return hmac.digest('base64');
}

/**
 * Make authenticated request using FUNDER address
 */
async function authRequest(method, path, body = null) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = generateSignature(method, path, timestamp, bodyStr);
    
    // Try SIGNER address for auth (the Coinbase wallet that created the API key)
    const authAddress = signerAddress || FUNDER;
    const headers = {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': authAddress,  // Use the wallet that created the API key
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_API_KEY': API_KEY,
        'POLY_PASSPHRASE': PASSPHRASE
    };
    
    console.log(`\n📤 ${method} ${path}`);
    console.log(`   Using address: ${authAddress}`);
    
    const response = await fetch(`${HOST}${path}`, {
        method,
        headers,
        body: body ? bodyStr : undefined
    });
    
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    
    if (!response.ok) {
        console.log(`   ❌ ${response.status}: ${JSON.stringify(data)}`);
    } else {
        console.log(`   ✅ Success`);
    }
    
    return { ok: response.ok, status: response.status, data };
}

/**
 * Test public endpoint (no auth)
 */
async function testPublic() {
    console.log('\n' + '─'.repeat(40));
    console.log('TEST 1: Public Endpoint (Server Time)');
    console.log('─'.repeat(40));
    
    const response = await fetch(`${HOST}/time`);
    const data = await response.json();
    console.log(`   Server time: ${new Date(data * 1000).toISOString()}`);
    return true;
}

/**
 * Test authenticated endpoint
 */
async function testAuth() {
    console.log('\n' + '─'.repeat(40));
    console.log('TEST 2: Authenticated Endpoint (API Keys)');
    console.log('─'.repeat(40));
    
    const result = await authRequest('GET', '/auth/api-keys');
    return result.ok;
}

/**
 * Test balance
 */
async function testBalance() {
    console.log('\n' + '─'.repeat(40));
    console.log('TEST 3: Balance Check');
    console.log('─'.repeat(40));
    
    const result = await authRequest('GET', '/balance-allowance?signature_type=1');
    if (result.ok) {
        console.log(`   Balance data:`, result.data);
    }
    return result.ok;
}

/**
 * Test open orders
 */
async function testOpenOrders() {
    console.log('\n' + '─'.repeat(40));
    console.log('TEST 4: Open Orders');
    console.log('─'.repeat(40));
    
    const result = await authRequest('GET', '/orders?open=true');
    if (result.ok) {
        console.log(`   Open orders: ${Array.isArray(result.data) ? result.data.length : 'unknown'}`);
    }
    return result.ok;
}

/**
 * Get current market
 */
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
            downTokenId: tokenIds[1]
        };
    }
    return null;
}

/**
 * Test order book (public)
 */
async function testOrderBook() {
    console.log('\n' + '─'.repeat(40));
    console.log('TEST 5: Order Book (Public)');
    console.log('─'.repeat(40));
    
    const market = await getCurrentMarket('btc');
    if (!market) {
        console.log('   ❌ Could not fetch market');
        return false;
    }
    
    console.log(`   Market: ${market.slug}`);
    
    const response = await fetch(`${HOST}/book?token_id=${market.upTokenId}`);
    const book = await response.json();
    
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    if (bids.length > 0 && asks.length > 0) {
        const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
        const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
        console.log(`   Best Bid: ${bestBid.toFixed(4)}`);
        console.log(`   Best Ask: ${bestAsk.toFixed(4)}`);
        console.log(`   Spread: ${((bestAsk - bestBid) * 100).toFixed(2)}%`);
    }
    
    return true;
}

// Run tests
async function main() {
    let passed = 0;
    let failed = 0;
    
    if (await testPublic()) passed++; else failed++;
    if (await testAuth()) passed++; else failed++;
    if (await testBalance()) passed++; else failed++;
    if (await testOpenOrders()) passed++; else failed++;
    if (await testOrderBook()) passed++; else failed++;
    
    console.log('\n' + '═'.repeat(60));
    console.log(`     RESULTS: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(60));
    
    if (failed > 0) {
        console.log('\n⚠️  Some authenticated tests failed.');
        console.log('   This might mean the API key was created for a different address.');
        console.log(`\n   Your API key should be for: ${FUNDER}`);
        console.log('   Go to polymarket.com → Settings → Builder Codes');
        console.log('   And verify the API key was created while connected with this address.\n');
    }
}

main().catch(console.error);
