#!/usr/bin/env node
/**
 * Derive or Create API Keys from Wallet
 * 
 * If your API keys don't match your wallet, use this to create new ones.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    
    if (!privateKey) {
        console.error('❌ No POLYMARKET_PRIVATE_KEY in .env.local');
        process.exit(1);
    }
    
    console.log('═'.repeat(60));
    console.log('     DERIVE/CREATE API KEYS');
    console.log('═'.repeat(60));
    
    const wallet = new Wallet(privateKey);
    console.log(`\n📍 Wallet Address: ${wallet.address}`);
    
    // Create client without API keys first
    const client = new ClobClient(HOST, CHAIN_ID, wallet);
    
    console.log('\n🔑 Attempting to derive/create API key...');
    console.log('   (This will sign a message with your wallet)\n');
    
    try {
        // Try to derive existing API key
        const apiCreds = await client.deriveApiKey();
        
        console.log('✅ API Key derived/created successfully!\n');
        console.log('Add these to your .env.local:\n');
        console.log('─'.repeat(60));
        console.log(`POLYMARKET_API_KEY=${apiCreds.apiKey}`);
        console.log(`POLYMARKET_SECRET=${apiCreds.secret}`);
        console.log(`POLYMARKET_PASSPHRASE=${apiCreds.passphrase}`);
        console.log('─'.repeat(60));
        
    } catch (error) {
        console.log('❌ Failed to derive API key:', error.message);
        
        console.log('\n🔄 Trying to create new API key...');
        
        try {
            const newCreds = await client.createApiKey();
            
            console.log('✅ New API Key created!\n');
            console.log('Add these to your .env.local:\n');
            console.log('─'.repeat(60));
            console.log(`POLYMARKET_API_KEY=${newCreds.apiKey}`);
            console.log(`POLYMARKET_SECRET=${newCreds.secret}`);
            console.log(`POLYMARKET_PASSPHRASE=${newCreds.passphrase}`);
            console.log('─'.repeat(60));
            
        } catch (err2) {
            console.log('❌ Failed to create API key:', err2.message);
            console.log('\nYou may need to:');
            console.log('1. Go to polymarket.com');
            console.log('2. Connect THIS wallet:', wallet.address);
            console.log('3. Generate new API keys from Builder Codes');
        }
    }
}

main().catch(console.error);
