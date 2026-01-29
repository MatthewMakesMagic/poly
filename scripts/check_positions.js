#!/usr/bin/env node
/**
 * Check REAL Polymarket Positions
 *
 * This checks actual on-chain token balances via the Polymarket API,
 * NOT our database records. Use this to see what positions actually exist.
 *
 * Usage: node scripts/check_positions.js
 *
 * Shows:
 * - Real token balances for all cryptos (BTC, ETH, SOL, XRP)
 * - Current market prices and values
 * - Comparison with database records (if any mismatch)
 * - USDC balance
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { SDKClient } from '../src/execution/sdk_client.js';

const CRYPTOS = ['btc', 'eth', 'sol', 'xrp'];

async function checkPositions() {
    console.log('\n' + '═'.repeat(70));
    console.log('  POLYMARKET ACTUAL POSITIONS CHECK');
    console.log('  ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET');
    console.log('═'.repeat(70) + '\n');

    const client = new SDKClient();

    try {
        await client.initialize();
        console.log('✅ SDK initialized\n');
    } catch (e) {
        console.error('❌ Failed to initialize SDK:', e.message);
        process.exit(1);
    }

    // Check USDC balance first
    try {
        const usdc = await client.getUSDCBalance();
        console.log(`💰 USDC Balance: $${usdc.toFixed(2)}\n`);
    } catch (e) {
        console.log('⚠️  Could not get USDC balance:', e.message, '\n');
    }

    console.log('─'.repeat(70));
    console.log('  CRYPTO     | SIDE | SHARES   | PRICE  | VALUE    | MARKET');
    console.log('─'.repeat(70));

    let totalValue = 0;
    let hasPositions = false;

    for (const crypto of CRYPTOS) {
        try {
            const market = await client.getCurrentMarket(crypto);

            if (!market || !market.upTokenId) {
                console.log(`  ${crypto.toUpperCase().padEnd(10)} | No active market found`);
                continue;
            }

            // Get actual balances
            const upBalance = await client.getBalance(market.upTokenId);
            const downBalance = await client.getBalance(market.downTokenId);

            // Get current prices
            let upPrice = 0.5, downPrice = 0.5;
            try {
                const upPrices = await client.getBestPrices(market.upTokenId);
                const downPrices = await client.getBestPrices(market.downTokenId);
                upPrice = upPrices.mid || upPrices.bid || 0.5;
                downPrice = downPrices.mid || downPrices.bid || 0.5;
            } catch (e) {
                // Use defaults
            }

            // Report UP position
            if (upBalance > 0.01) {
                hasPositions = true;
                const value = upBalance * upPrice;
                totalValue += value;
                console.log(`  ${crypto.toUpperCase().padEnd(10)} | UP   | ${upBalance.toFixed(2).padStart(8)} | ${(upPrice * 100).toFixed(0).padStart(4)}¢  | $${value.toFixed(2).padStart(7)} | ${market.question?.slice(0, 20) || ''}`);
            }

            // Report DOWN position
            if (downBalance > 0.01) {
                hasPositions = true;
                const value = downBalance * downPrice;
                totalValue += value;
                console.log(`  ${crypto.toUpperCase().padEnd(10)} | DOWN | ${downBalance.toFixed(2).padStart(8)} | ${(downPrice * 100).toFixed(0).padStart(4)}¢  | $${value.toFixed(2).padStart(7)} | ${market.question?.slice(0, 20) || ''}`);
            }

            // If no position, show that
            if (upBalance <= 0.01 && downBalance <= 0.01) {
                // Silent - only show positions
            }

        } catch (e) {
            console.log(`  ${crypto.toUpperCase().padEnd(10)} | Error: ${e.message}`);
        }
    }

    if (!hasPositions) {
        console.log('  (No open positions)');
    }

    console.log('─'.repeat(70));
    if (totalValue > 0) {
        console.log(`  TOTAL POSITION VALUE: $${totalValue.toFixed(2)}`);
    }
    console.log('═'.repeat(70) + '\n');

    // Compare with database records
    await compareWithDatabase();

    process.exit(0);
}

async function compareWithDatabase() {
    try {
        const pg = await import('pg');
        const pool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });

        // Get "open" positions from DB (entries without exits)
        const result = await pool.query(`
            WITH entries AS (
                SELECT DISTINCT ON (strategy_name, crypto, window_epoch)
                    strategy_name, crypto, side, window_epoch, price, timestamp
                FROM live_trades
                WHERE type = 'entry'
                AND timestamp > NOW() - INTERVAL '1 hour'
                ORDER BY strategy_name, crypto, window_epoch, timestamp DESC
            ),
            exits AS (
                SELECT strategy_name, crypto, window_epoch
                FROM live_trades
                WHERE type IN ('exit', 'abandoned')
                AND timestamp > NOW() - INTERVAL '1 hour'
            )
            SELECT e.*
            FROM entries e
            LEFT JOIN exits x ON e.strategy_name = x.strategy_name
                AND e.crypto = x.crypto
                AND e.window_epoch = x.window_epoch
            WHERE x.strategy_name IS NULL
        `);

        if (result.rows.length > 0) {
            console.log('⚠️  DATABASE RECORDS (may not match actual positions):');
            console.log('─'.repeat(50));
            for (const r of result.rows) {
                console.log(`   ${r.strategy_name?.slice(0, 20)} | ${r.crypto} ${r.side?.toUpperCase()} @ ${r.price?.toFixed(3)}`);
            }
            console.log('');
            console.log('   If database shows positions but Polymarket does not,');
            console.log('   the trade may have failed or window already expired.\n');
        }

        await pool.end();
    } catch (e) {
        // Silently skip if DB not available
    }
}

checkPositions().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
