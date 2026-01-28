#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const pk = process.env.POLY_PRIVATE_KEY;
const funder = process.env.POLY_FUNDER_ADDRESS;

if (!pk) {
    console.error('No POLY_PRIVATE_KEY found');
    process.exit(1);
}

const wallet = new Wallet(pk);
console.log('Wallet:', wallet.address);
console.log('Funder:', funder);

try {
    const baseClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await baseClient.deriveApiKey();
    console.log('API Key derived');

    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, creds, 2, funder);

    // Get balance allowance
    const balance = await client.getBalanceAllowance();
    console.log('\nUSDC Balance:', JSON.stringify(balance, null, 2));

    // Get open orders
    const orders = await client.getOpenOrders();
    console.log('\nOpen Orders:', orders?.length || 0, 'orders');
    if (orders && orders.length > 0) {
        console.log(JSON.stringify(orders.slice(0, 5), null, 2));
    }
} catch (e) {
    console.error('Error:', e.message);
}
