#!/usr/bin/env node
/**
 * Check Execution Quality
 *
 * Analyzes actual fill prices vs requested prices to measure:
 * - Price improvement (getting better fills than expected)
 * - Slippage (getting worse fills)
 * - Overall execution quality
 *
 * Usage: node scripts/check_execution_quality.js
 */

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2
});

async function checkExecutionQuality() {
    const et = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'short',
        timeStyle: 'medium'
    });

    console.log('');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('  EXECUTION QUALITY ANALYSIS');
    console.log(`  ${et} ET`);
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('');

    // Get recent trades with execution price data
    const result = await pool.query(`
        SELECT
            type,
            strategy_name,
            crypto,
            side,
            price,
            price_requested,
            price_filled,
            fill_details,
            timestamp_et,
            pnl
        FROM live_trades
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp DESC
        LIMIT 50
    `);

    if (result.rows.length === 0) {
        console.log('No trades in last 24 hours');
        await pool.end();
        return;
    }

    console.log('─────────────────────────────────────────────────────────────────');
    console.log('  RECENT TRADES WITH PRICE DATA');
    console.log('─────────────────────────────────────────────────────────────────');

    let totalImprovement = 0;
    let improvementCount = 0;
    let slippageCount = 0;
    let exactCount = 0;

    for (const trade of result.rows) {
        const type = trade.type.toUpperCase().padEnd(6);
        const strat = (trade.strategy_name || '?').slice(0, 18).padEnd(18);
        const crypto = (trade.crypto || '?').toUpperCase().padEnd(4);
        const side = (trade.side || '?').toUpperCase().padEnd(4);

        const priceRecorded = trade.price ? trade.price.toFixed(4) : 'N/A';
        const priceRequested = trade.price_requested ? trade.price_requested.toFixed(4) : 'N/A';
        const priceFilled = trade.price_filled ? trade.price_filled.toFixed(4) : 'N/A';

        let improvement = '';
        if (trade.price_requested && trade.price_filled) {
            const diff = trade.type === 'entry'
                ? (trade.price_requested - trade.price_filled) * 100 // For buys, lower fill is better
                : (trade.price_filled - trade.price_requested) * 100; // For sells, higher fill is better

            if (diff > 0.01) {
                improvement = `+${diff.toFixed(2)}¢ BETTER`;
                totalImprovement += diff;
                improvementCount++;
            } else if (diff < -0.01) {
                improvement = `${diff.toFixed(2)}¢ WORSE`;
                slippageCount++;
            } else {
                improvement = 'EXACT';
                exactCount++;
            }
        }

        const time = trade.timestamp_et || '?';
        const pnl = trade.pnl !== null ? `$${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}` : '';

        console.log(`  ${time} | ${type} | ${strat} | ${crypto} ${side}`);
        console.log(`    Requested: ${priceRequested} | Filled: ${priceFilled} | ${improvement} ${pnl}`);

        if (trade.fill_details) {
            try {
                const details = typeof trade.fill_details === 'string'
                    ? JSON.parse(trade.fill_details)
                    : trade.fill_details;
                console.log(`    Fill Source: ${details.source || 'unknown'}`);
            } catch (e) {
                // ignore
            }
        }
        console.log('');
    }

    console.log('─────────────────────────────────────────────────────────────────');
    console.log('  SUMMARY');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  Total Trades Analyzed: ${result.rows.length}`);
    console.log(`  Price Improvement: ${improvementCount} trades (avg ${improvementCount > 0 ? (totalImprovement / improvementCount).toFixed(2) : 0}¢ better)`);
    console.log(`  Exact Fill: ${exactCount} trades`);
    console.log(`  Slippage: ${slippageCount} trades`);
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('');

    await pool.end();
}

checkExecutionQuality().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
