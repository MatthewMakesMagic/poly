#!/usr/bin/env node
/**
 * Test Black-Scholes Probability Model on Last 10 Windows
 *
 * Shows how the strategies would have traded using the new BS-based probability model
 */

import { initDatabase } from '../src/db/connection.js';
import { getResolvedWindows, getTicksForWindow } from '../src/db/queries.js';

// ═══════════════════════════════════════════════════════════════════════════
// BLACK-SCHOLES MODEL (same as in spot_lag_simple.js)
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

function calculateD2(spotDeltaPct, timeRemainingSec, sigma) {
    const spotRatio = 1 + (spotDeltaPct / 100);
    const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
    const T = Math.max(timeRemainingSec, 1) / SECONDS_PER_YEAR;
    const sqrtT = Math.sqrt(T);
    return Math.log(spotRatio) / (sigma * sqrtT);
}

function calculateExpectedProbability(spotDeltaPct, timeRemainingSec, crypto = 'btc') {
    const sigma = CRYPTO_VOLATILITY[crypto?.toLowerCase()] || CRYPTO_VOLATILITY.default;
    const d2 = calculateD2(spotDeltaPct, timeRemainingSec, sigma);
    return normalCDF(d2);
}

function calculateTheoreticalEdge(spotDeltaPct, timeRemainingSec, marketProb, crypto = 'btc') {
    const side = spotDeltaPct > 0 ? 'up' : 'down';
    const theoreticalUpProb = calculateExpectedProbability(spotDeltaPct, timeRemainingSec, crypto);
    const theoreticalSideProb = side === 'up' ? theoreticalUpProb : (1 - theoreticalUpProb);
    const marketSideProb = side === 'up' ? marketProb : (1 - marketProb);
    const edge = theoreticalSideProb - marketSideProb;
    return { theoreticalUpProb, theoreticalSideProb, marketSideProb, edge, side };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGY_CONFIG = {
    minSpotDeltaPct: 0.02,      // Minimum 0.02% spot displacement
    minEdge: 0.03,              // Minimum 3% edge
    maxEdge: 0.15,              // Maximum 15% edge (suspicious if higher)
    minSideProb: 0.15,          // Don't bet on <15% outcomes
    maxSideProb: 0.85,          // Don't bet on >85% outcomes
    minTimeRemaining: 30,       // Don't enter with <30s left
    maxTimeRemaining: 600,      // Don't enter too early
};

function simulateStrategy(ticks, crypto, outcome) {
    if (!ticks || ticks.length === 0) return null;

    let signal = null;
    let entryTick = null;
    let entryPrice = null;

    // Find first valid signal
    for (const tick of ticks) {
        if (!tick.up_mid || tick.up_mid <= 0.01 || tick.up_mid >= 0.99) continue;
        if (!tick.price_to_beat || !tick.spot_price) continue;

        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < STRATEGY_CONFIG.minTimeRemaining) continue;
        if (timeRemaining > STRATEGY_CONFIG.maxTimeRemaining) continue;

        const spotDeltaPct = ((tick.spot_price - tick.price_to_beat) / tick.price_to_beat) * 100;
        if (Math.abs(spotDeltaPct) < STRATEGY_CONFIG.minSpotDeltaPct) continue;

        const marketProb = tick.up_mid;
        const edgeCalc = calculateTheoreticalEdge(spotDeltaPct, timeRemaining, marketProb, crypto);

        // Check side probability bounds
        if (edgeCalc.marketSideProb < STRATEGY_CONFIG.minSideProb) continue;
        if (edgeCalc.marketSideProb > STRATEGY_CONFIG.maxSideProb) continue;

        // Check edge bounds
        if (edgeCalc.edge < STRATEGY_CONFIG.minEdge) continue;
        if (edgeCalc.edge > STRATEGY_CONFIG.maxEdge) continue;  // Suspicious

        // Valid signal!
        signal = edgeCalc;
        entryTick = tick;
        entryPrice = edgeCalc.side === 'up' ? tick.up_ask : tick.down_ask;
        break;
    }

    if (!signal) return { action: 'NO_TRADE', reason: 'No valid signal found' };

    // Determine outcome
    const won = signal.side === outcome;
    const pnl = won ? (1 - entryPrice) : -entryPrice;  // Binary outcome

    return {
        action: 'TRADE',
        side: signal.side,
        entryPrice,
        theoreticalProb: signal.theoreticalSideProb,
        marketProb: signal.marketSideProb,
        edge: signal.edge,
        timeRemaining: entryTick.time_remaining_sec,
        spotDelta: ((entryTick.spot_price - entryTick.price_to_beat) / entryTick.price_to_beat) * 100,
        outcome,
        won,
        pnl
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('═'.repeat(80));
    console.log('  BLACK-SCHOLES MODEL BACKTEST - LAST 10 WINDOWS PER CRYPTO');
    console.log('═'.repeat(80));
    console.log('\nVolatility: BTC=50%, ETH=65%, SOL=85%, XRP=75%');
    console.log('Strategy: minEdge=3%, maxEdge=15%, minSideProb=15%\n');

    await initDatabase();

    const cryptos = ['btc', 'eth', 'sol', 'xrp'];
    const allTrades = [];

    for (const crypto of cryptos) {
        console.log(`\n${'─'.repeat(80)}`);
        console.log(`  ${crypto.toUpperCase()} - Last 10 Resolved Windows`);
        console.log('─'.repeat(80));

        const windows = getResolvedWindows(crypto, 10);

        if (!windows || windows.length === 0) {
            console.log('  No resolved windows found');
            continue;
        }

        let wins = 0, losses = 0, noTrades = 0;
        let totalPnl = 0;

        for (const window of windows) {
            const ticks = getTicksForWindow(crypto, window.epoch);
            const result = simulateStrategy(ticks, crypto, window.outcome);

            if (result.action === 'NO_TRADE') {
                noTrades++;
                console.log(`  Window ${window.epoch}: NO TRADE - ${result.reason}`);
            } else {
                if (result.won) wins++;
                else losses++;
                totalPnl += result.pnl;
                allTrades.push({ crypto, ...result });

                const emoji = result.won ? '✅' : '❌';
                console.log(
                    `  Window ${window.epoch}: ${emoji} ${result.side.toUpperCase()} @ ${(result.entryPrice * 100).toFixed(0)}¢ | ` +
                    `BS=${(result.theoreticalProb * 100).toFixed(0)}% mkt=${(result.marketProb * 100).toFixed(0)}% ` +
                    `edge=${(result.edge * 100).toFixed(1)}% | ` +
                    `t=${result.timeRemaining.toFixed(0)}s Δ=${result.spotDelta.toFixed(3)}% | ` +
                    `outcome=${result.outcome} PnL=${result.pnl > 0 ? '+' : ''}${(result.pnl * 100).toFixed(0)}¢`
                );
            }
        }

        console.log(`\n  Summary: ${wins}W/${losses}L/${noTrades}skip | PnL: ${totalPnl > 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    }

    // Overall summary
    console.log('\n' + '═'.repeat(80));
    console.log('  OVERALL SUMMARY');
    console.log('═'.repeat(80));

    const totalWins = allTrades.filter(t => t.won).length;
    const totalLosses = allTrades.filter(t => !t.won).length;
    const totalPnL = allTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgEdge = allTrades.length > 0
        ? allTrades.reduce((sum, t) => sum + t.edge, 0) / allTrades.length
        : 0;

    console.log(`\n  Total Trades: ${allTrades.length}`);
    console.log(`  Win Rate: ${totalWins}/${totalWins + totalLosses} = ${((totalWins / (totalWins + totalLosses || 1)) * 100).toFixed(1)}%`);
    console.log(`  Average Edge: ${(avgEdge * 100).toFixed(1)}%`);
    console.log(`  Total PnL: ${totalPnL > 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);

    if (allTrades.length > 0) {
        console.log('\n  Trade Details:');
        console.log('  ─'.repeat(40));
        for (const t of allTrades) {
            const emoji = t.won ? '✅' : '❌';
            console.log(`  ${emoji} ${t.crypto.toUpperCase()} ${t.side.toUpperCase()} | edge=${(t.edge*100).toFixed(1)}% | ${t.won ? 'WON' : 'LOST'} ${(t.pnl*100).toFixed(0)}¢`);
        }
    }
}

main().catch(console.error);
