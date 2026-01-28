#!/usr/bin/env node
/**
 * Test Black-Scholes Probability Model on Recent Tick Data from Supabase
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;

// ═══════════════════════════════════════════════════════════════════════════
// BLACK-SCHOLES MODEL
// ═══════════════════════════════════════════════════════════════════════════

function normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1.0 + sign * y);
}

const CRYPTO_VOLATILITY = {
    btc: 0.50,
    eth: 0.65,
    sol: 0.85,
    xrp: 0.75,
    default: 0.70
};

function calculateExpectedProbability(spotDeltaPct, timeRemainingSec, crypto = 'btc') {
    const sigma = CRYPTO_VOLATILITY[crypto?.toLowerCase()] || CRYPTO_VOLATILITY.default;
    const spotRatio = 1 + (spotDeltaPct / 100);
    const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
    const T = Math.max(timeRemainingSec, 1) / SECONDS_PER_YEAR;
    const sqrtT = Math.sqrt(T);
    const d2 = Math.log(spotRatio) / (sigma * sqrtT);
    return normalCDF(d2);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('═'.repeat(80));
    console.log('  BLACK-SCHOLES MODEL TEST ON RECENT TICK DATA');
    console.log('═'.repeat(80));

    if (!process.env.DATABASE_URL) {
        console.log('\n❌ DATABASE_URL not set. Cannot connect to Supabase.');
        console.log('   This script needs to run with access to the production database.');
        console.log('\n   Showing model calculations instead:\n');

        // Show example calculations
        console.log('   Example: BTC spot 0.1% above strike');
        console.log('   ─'.repeat(35));
        for (const timeSec of [300, 120, 60, 30, 15]) {
            const prob = calculateExpectedProbability(0.1, timeSec, 'btc');
            console.log(`   ${timeSec}s left: P(UP wins) = ${(prob * 100).toFixed(1)}%`);
        }

        console.log('\n   Example: SOL spot 0.2% above strike (more volatile)');
        console.log('   ─'.repeat(35));
        for (const timeSec of [300, 120, 60, 30, 15]) {
            const prob = calculateExpectedProbability(0.2, timeSec, 'sol');
            console.log(`   ${timeSec}s left: P(UP wins) = ${(prob * 100).toFixed(1)}%`);
        }

        console.log('\n   Example: ETH spot 0.05% BELOW strike (betting DOWN)');
        console.log('   ─'.repeat(35));
        for (const timeSec of [300, 120, 60, 30, 15]) {
            const probUp = calculateExpectedProbability(-0.05, timeSec, 'eth');
            const probDown = 1 - probUp;
            console.log(`   ${timeSec}s left: P(DOWN wins) = ${(probDown * 100).toFixed(1)}%`);
        }

        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Get recent live trades
        const tradesResult = await pool.query(`
            SELECT * FROM live_trades
            WHERE timestamp > NOW() - INTERVAL '4 hours'
            ORDER BY timestamp DESC
            LIMIT 50
        `);

        console.log(`\nFound ${tradesResult.rows.length} recent trades\n`);

        if (tradesResult.rows.length === 0) {
            console.log('No recent trades to analyze.');
            return;
        }

        // Analyze each trade
        for (const trade of tradesResult.rows.slice(0, 20)) {
            if (trade.type !== 'entry') continue;

            const crypto = trade.crypto;
            const side = trade.side;
            const spotPrice = trade.spot_price;
            const timeRemaining = trade.time_remaining;
            const entryPrice = trade.entry_price || trade.price;

            // We need strike price - estimate from entry price
            // If buying UP at 0.60, market thinks P(UP)=60%, so we can back out
            const marketProb = side === 'up' ? entryPrice : (1 - entryPrice);

            // Without strike price, we can't calculate exact BS probability
            // But we can show what the trade parameters were
            console.log(
                `${trade.strategy_name} | ${crypto.toUpperCase()} ${side.toUpperCase()} @ ${(entryPrice * 100).toFixed(0)}¢ | ` +
                `t=${timeRemaining?.toFixed(0) || '?'}s | ` +
                `outcome=${trade.outcome || 'pending'} | pnl=${trade.pnl ? (trade.pnl > 0 ? '+' : '') + (trade.pnl * 100).toFixed(0) + '¢' : '?'}`
            );
        }

    } catch (error) {
        console.error('Database error:', error.message);
    } finally {
        await pool.end();
    }
}

main().catch(console.error);
