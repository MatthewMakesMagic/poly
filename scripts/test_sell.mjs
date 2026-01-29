import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { SDKClient } from '../src/execution/sdk_client.js';

async function testSell() {
    console.log('');
    console.log('═'.repeat(70));
    console.log('  TESTING IF SELL IS POSSIBLE');
    console.log('═'.repeat(70));
    console.log('');

    const client = new SDKClient();
    await client.initialize();

    // Get current SOL market
    const market = await client.getCurrentMarket('sol');
    console.log('Current SOL market:', market.slug);
    console.log('DOWN tokenId:', market.downTokenId);

    // Check our balance for this token
    const balance = await client.getBalance(market.downTokenId);
    console.log('Our DOWN balance:', balance, 'shares');

    if (balance <= 0) {
        console.log('No shares to sell - position may have already closed or wrong token');
        return;
    }

    // Get current order book
    const book = await client.getBestPrices(market.downTokenId);
    console.log('Order book:', book);
    console.log('Best bid:', book.bid);

    // Try to sell 1 share at 1 cent (very aggressive)
    console.log('');
    console.log('ATTEMPTING TO SELL 1 SHARE AT 1 CENT...');

    try {
        const result = await client.sell(market.downTokenId, 1, 0.01, 'FOK');
        console.log('');
        console.log('SELL RESULT:', JSON.stringify(result, null, 2));

        if (result.filled) {
            console.log('✅ SELL SUCCEEDED - exits ARE possible');
        } else {
            console.log('❌ SELL FAILED - status:', result.status);
        }
    } catch (err) {
        console.log('❌ SELL ERROR:', err.message);
    }
}

testSell().catch(console.error);
