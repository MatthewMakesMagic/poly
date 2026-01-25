#!/usr/bin/env node
/**
 * Create new API keys by signing with wallet
 * 
 * This is the official way to get API keys that match your wallet.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { Wallet } from 'ethers';
import crypto from 'crypto';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error('❌ POLYMARKET_PRIVATE_KEY not set');
    process.exit(1);
}

const wallet = new Wallet(PRIVATE_KEY);

console.log('═'.repeat(60));
console.log('     CREATE API KEY');
console.log('═'.repeat(60));
console.log(`\nWallet: ${wallet.address}`);

// EIP-712 domain for Polymarket
const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CHAIN_ID
};

// Types for API key creation
const types = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' }
    ]
};

async function createApiKey() {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;
    const message = 'This message attests that I control the given wallet';
    
    const value = {
        address: wallet.address,
        timestamp,
        nonce,
        message
    };
    
    console.log('\n🔐 Signing message to create API key...');
    
    // Sign the typed data
    const signature = await wallet.signTypedData(domain, types, value);
    
    console.log('   Signature created');
    
    // Send to Polymarket
    console.log('\n📤 Sending to Polymarket...');
    
    const response = await fetch(`${HOST}/auth/api-key`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            address: wallet.address,
            timestamp,
            nonce,
            message,
            signature
        })
    });
    
    const text = await response.text();
    console.log(`   Status: ${response.status}`);
    
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    
    if (response.ok && data.apiKey) {
        console.log('\n✅ API Key created successfully!\n');
        console.log('Add these to your .env.local:\n');
        console.log('─'.repeat(60));
        console.log(`POLYMARKET_API_KEY=${data.apiKey}`);
        console.log(`POLYMARKET_SECRET=${data.secret}`);
        console.log(`POLYMARKET_PASSPHRASE=${data.passphrase}`);
        console.log('─'.repeat(60));
        
        return data;
    } else {
        console.log('\n❌ Failed to create API key');
        console.log('   Response:', data);
        return null;
    }
}

async function deriveApiKey() {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;
    const message = 'This message attests that I control the given wallet';
    
    const value = {
        address: wallet.address,
        timestamp,
        nonce,
        message
    };
    
    console.log('\n🔐 Trying to derive existing API key...');
    
    const signature = await wallet.signTypedData(domain, types, value);
    
    const response = await fetch(`${HOST}/auth/derive-api-key`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'POLY_ADDRESS': wallet.address,
            'POLY_SIGNATURE': signature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_NONCE': nonce.toString()
        }
    });
    
    const text = await response.text();
    console.log(`   Status: ${response.status}`);
    
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    
    if (response.ok && data.apiKey) {
        console.log('\n✅ API Key derived!\n');
        console.log('Add these to your .env.local:\n');
        console.log('─'.repeat(60));
        console.log(`POLYMARKET_API_KEY=${data.apiKey}`);
        console.log(`POLYMARKET_SECRET=${data.secret}`);
        console.log(`POLYMARKET_PASSPHRASE=${data.passphrase}`);
        console.log('─'.repeat(60));
        
        return data;
    } else {
        console.log('   Could not derive, will create new:', data);
        return null;
    }
}

async function main() {
    // Try derive first, then create
    let result = await deriveApiKey();
    
    if (!result) {
        result = await createApiKey();
    }
    
    if (result) {
        console.log('\n📝 To update your .env.local automatically, run:');
        console.log(`   node -e "...update script..."`);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
});
