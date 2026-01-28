#!/usr/bin/env node
/**
 * Backtest Black-Scholes Based Strategies on Polymarket Tick Data
 *
 * Tests all updated strategies against historical tick data from Supabase
 */

import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

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
    btc: 0.50, eth: 0.65, sol: 0.85, xrp: 0.75, default: 0.70
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

function calculateTheoreticalEdge(spotDeltaPct, timeRemainingSec, marketProb, crypto = 'btc') {
    const side = spotDeltaPct > 0 ? 'up' : 'down';
    const theoreticalUpProb = calculateExpectedProbability(spotDeltaPct, timeRemainingSec, crypto);
    const theoreticalSideProb = side === 'up' ? theoreticalUpProb : (1 - theoreticalUpProb);
    const marketSideProb = side === 'up' ? marketProb : (1 - marketProb);
    const edge = theoreticalSideProb - marketSideProb;
    return { theoreticalUpProb, theoreticalSideProb, marketSideProb, edge, side };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY SIMULATORS
// ═══════════════════════════════════════════════════════════════════════════

// SpotLag_Trail Strategy (with BS edge)
function simulateSpotLagTrail(ticks, crypto, outcome, config = {}) {
    const {
        minEdge = 0.02,
        maxEdge = 0.20,
        spotMoveThreshold = 0.0002,
        lookbackTicks = 8,
        marketLagRatio = 0.6,
        minProbability = 0.05,
        maxProbability = 0.95,
        minTimeRemaining = 30
    } = config;

    if (!ticks || ticks.length < lookbackTicks + 1) return null;

    // FIX: Use FIRST tick's spot_price as strike (window start price)
    const strike = ticks[0]?.spot_price || 0;
    if (strike <= 0) return null;

    // Build history and find first valid signal
    const spotHistory = [];
    const marketHistory = [];

    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        spotHistory.push(tick.spot_price);
        marketHistory.push(tick.up_mid);

        if (spotHistory.length < lookbackTicks) continue;

        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < minTimeRemaining) continue;

        // Validate price data
        if (!tick.up_mid || tick.up_mid <= 0.01 || tick.up_mid >= 0.99) continue;

        const oldSpot = spotHistory[spotHistory.length - lookbackTicks];
        const newSpot = spotHistory[spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;

        if (Math.abs(spotMove) < spotMoveThreshold) continue;

        const oldMarket = marketHistory[marketHistory.length - lookbackTicks];
        const newMarket = marketHistory[marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        const expectedMarketMove = spotMove * 10;
        const lagRatio = Math.abs(marketMove) / Math.abs(expectedMarketMove);

        if (lagRatio > marketLagRatio) continue;

        const side = spotMove > 0 ? 'up' : 'down';
        const marketProb = tick.up_mid;
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        if (sideProb < minProbability || sideProb > maxProbability) continue;

        // BS Edge calculation - use FIXED strike from window start
        const spotDeltaPct = ((newSpot - strike) / strike) * 100;
        const edgeCalc = calculateTheoreticalEdge(spotDeltaPct, timeRemaining, marketProb, crypto);

        if (edgeCalc.edge < minEdge || edgeCalc.edge > maxEdge) continue;

        // Valid signal found!
        const entryPrice = side === 'up' ? (tick.up_ask || marketProb + 0.01) : (tick.down_ask || (1 - marketProb) + 0.01);
        const won = side === outcome;
        const pnl = won ? (1 - entryPrice) : -entryPrice;

        return {
            action: 'TRADE',
            side,
            entryPrice,
            bsProb: edgeCalc.theoreticalSideProb,
            marketProb: edgeCalc.marketSideProb,
            edge: edgeCalc.edge,
            timeRemaining,
            spotDelta: spotDeltaPct,
            lagRatio,
            outcome,
            won,
            pnl
        };
    }

    return { action: 'NO_TRADE', reason: 'No valid signal' };
}

// SpotLag_TimeAware Strategy (with BS edge)
function simulateSpotLagTimeAware(ticks, crypto, outcome, config = {}) {
    const {
        minEdge = 0.03,
        maxEdge = 0.20,
        spotMoveThreshold = 0.0002,
        earlyWindowMinSpotDelta = 0.04,
        midWindowMinSpotDelta = 0.025,
        lateWindowMinSpotDelta = 0.015,
        earlyWindowThreshold = 300,
        lateWindowThreshold = 120,
        minTimeRemaining = 30
    } = config;

    if (!ticks || ticks.length < 8) return null;

    // FIX: Use FIRST tick's spot_price as strike (window start price)
    const strike = ticks[0]?.spot_price || 0;
    if (strike <= 0) return null;

    const spotHistory = [];
    const marketHistory = [];

    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        spotHistory.push(tick.spot_price);
        marketHistory.push(tick.up_mid);

        if (spotHistory.length < 8) continue;

        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < minTimeRemaining) continue;

        // Validate price data
        if (!tick.up_mid || tick.up_mid <= 0.01 || tick.up_mid >= 0.99) continue;

        // Use FIXED strike from window start
        const spotDeltaPct = ((tick.spot_price - strike) / strike) * 100;

        // Time-based threshold
        let requiredSpotDelta;
        if (timeRemaining > earlyWindowThreshold) {
            requiredSpotDelta = earlyWindowMinSpotDelta;
        } else if (timeRemaining > lateWindowThreshold) {
            requiredSpotDelta = midWindowMinSpotDelta;
        } else {
            requiredSpotDelta = lateWindowMinSpotDelta;
        }

        if (Math.abs(spotDeltaPct) < requiredSpotDelta) continue;

        // Spot movement check
        const oldSpot = spotHistory[spotHistory.length - 8];
        const newSpot = spotHistory[spotHistory.length - 1];
        const spotMove = (newSpot - oldSpot) / oldSpot;
        if (Math.abs(spotMove) < spotMoveThreshold) continue;

        // Market lag check
        const oldMarket = marketHistory[marketHistory.length - 8];
        const newMarket = marketHistory[marketHistory.length - 1];
        const marketMove = newMarket - oldMarket;
        const expectedMarketMove = spotMove * 10;
        const lagRatio = Math.abs(marketMove) / Math.abs(expectedMarketMove);
        if (lagRatio > 0.5) continue;

        const side = spotDeltaPct > 0 ? 'up' : 'down';
        const marketProb = tick.up_mid;

        // BS Edge calculation
        const edgeCalc = calculateTheoreticalEdge(spotDeltaPct, timeRemaining, marketProb, crypto);

        if (edgeCalc.edge < minEdge || edgeCalc.edge > maxEdge) continue;

        // Valid signal!
        const entryPrice = side === 'up' ? (tick.up_ask || marketProb + 0.01) : (tick.down_ask || (1 - marketProb) + 0.01);
        const won = side === outcome;
        const pnl = won ? (1 - entryPrice) : -entryPrice;

        return {
            action: 'TRADE',
            side,
            entryPrice,
            bsProb: edgeCalc.theoreticalSideProb,
            marketProb: edgeCalc.marketSideProb,
            edge: edgeCalc.edge,
            timeRemaining,
            spotDelta: spotDeltaPct,
            outcome,
            won,
            pnl
        };
    }

    return { action: 'NO_TRADE', reason: 'No valid signal' };
}

// SpotLag_ProbEdge Strategy
function simulateSpotLagProbEdge(ticks, crypto, outcome, config = {}) {
    const {
        minEdge = 0.03,
        minSpotDeltaPct = 0.02,
        minTimeRemaining = 30,
        minSideProb = 0.15
    } = config;

    if (!ticks || ticks.length === 0) return null;

    // FIX: Use FIRST tick's spot_price as strike (window start price)
    const strike = ticks[0]?.spot_price || 0;
    if (strike <= 0) return null;

    for (const tick of ticks) {
        if (!tick.up_mid || tick.up_mid <= 0.01 || tick.up_mid >= 0.99) continue;

        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining < minTimeRemaining) continue;

        // Use FIXED strike from window start
        const spotDeltaPct = ((tick.spot_price - strike) / strike) * 100;

        if (Math.abs(spotDeltaPct) < minSpotDeltaPct) continue;

        const marketProb = tick.up_mid;
        const side = spotDeltaPct > 0 ? 'up' : 'down';
        const sideProb = side === 'up' ? marketProb : (1 - marketProb);

        if (sideProb < minSideProb) continue;

        const edgeCalc = calculateTheoreticalEdge(spotDeltaPct, timeRemaining, marketProb, crypto);

        // Market disagreement check
        if (Math.abs(edgeCalc.theoreticalSideProb - sideProb) > 0.25) continue;

        if (edgeCalc.edge < minEdge) continue;

        const entryPrice = side === 'up' ? (tick.up_ask || marketProb + 0.01) : (tick.down_ask || (1 - marketProb) + 0.01);
        const won = side === outcome;
        const pnl = won ? (1 - entryPrice) : -entryPrice;

        return {
            action: 'TRADE',
            side,
            entryPrice,
            bsProb: edgeCalc.theoreticalSideProb,
            marketProb: edgeCalc.marketSideProb,
            edge: edgeCalc.edge,
            timeRemaining,
            spotDelta: spotDeltaPct,
            outcome,
            won,
            pnl
        };
    }

    return { action: 'NO_TRADE', reason: 'No valid signal' };
}

// Endgame Strategy (probability-based, no edge needed)
function simulateEndgame(ticks, crypto, outcome, config = {}) {
    const {
        minProbability = 0.90,
        maxTimeRemaining = 60,
        minTimeRemaining = 5,
        minSpotBuffer = 0.001
    } = config;

    if (!ticks || ticks.length === 0) return null;

    // FIX: Use FIRST tick's spot_price as strike (window start price)
    const strike = ticks[0]?.spot_price || 0;
    if (strike <= 0) return null;

    for (const tick of ticks) {
        if (!tick.up_mid || tick.up_mid <= 0.01 || tick.up_mid >= 0.99) continue;

        const timeRemaining = tick.time_remaining_sec || 0;
        if (timeRemaining > maxTimeRemaining || timeRemaining < minTimeRemaining) continue;

        const marketProb = tick.up_mid;
        const upIsFavorite = marketProb > 0.5;
        const favoriteProb = upIsFavorite ? marketProb : (1 - marketProb);
        const favoriteSide = upIsFavorite ? 'up' : 'down';

        if (favoriteProb < minProbability) continue;

        // Use FIXED strike from window start
        const spotDelta = (tick.spot_price - strike) / strike;
        const spotSupports = (upIsFavorite && spotDelta > minSpotBuffer) ||
                            (!upIsFavorite && spotDelta < -minSpotBuffer);

        if (!spotSupports) continue;

        const entryPrice = favoriteSide === 'up'
            ? (tick.up_ask || marketProb + 0.01)
            : (tick.down_ask || (1 - marketProb) + 0.01);
        const won = favoriteSide === outcome;
        const pnl = won ? (1 - entryPrice) : -entryPrice;

        return {
            action: 'TRADE',
            side: favoriteSide,
            entryPrice,
            favoriteProb,
            timeRemaining,
            outcome,
            won,
            pnl
        };
    }

    return { action: 'NO_TRADE', reason: 'No valid signal' };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('═'.repeat(80));
    console.log('  BACKTEST: BLACK-SCHOLES STRATEGIES ON POLYMARKET DATA');
    console.log('═'.repeat(80));

    if (!process.env.DATABASE_URL) {
        console.log('\n❌ DATABASE_URL not set. Cannot connect to Supabase.');
        console.log('   Run this script in Railway or set DATABASE_URL locally.');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Get resolved windows with tick data
        const windowsResult = await pool.query(`
            SELECT w.*,
                   (SELECT COUNT(*) FROM ticks t WHERE t.crypto = w.crypto AND t.window_epoch = w.epoch) as tick_count
            FROM windows w
            WHERE w.outcome IS NOT NULL
            ORDER BY w.epoch DESC
            LIMIT 200
        `);

        const windows = windowsResult.rows.filter(w => w.tick_count > 10);
        console.log(`\nFound ${windows.length} resolved windows with tick data\n`);

        if (windows.length === 0) {
            console.log('No windows with tick data available for backtesting.');
            return;
        }

        // Strategy configurations
        const strategies = [
            { name: 'SpotLag_Trail_V1', fn: simulateSpotLagTrail, config: { minEdge: 0.03, spotMoveThreshold: 0.0004, marketLagRatio: 0.4 } },
            { name: 'SpotLag_Trail_V2', fn: simulateSpotLagTrail, config: { minEdge: 0.025, spotMoveThreshold: 0.0003, marketLagRatio: 0.5 } },
            { name: 'SpotLag_Trail_V3', fn: simulateSpotLagTrail, config: { minEdge: 0.02 } },
            { name: 'SpotLag_Trail_V4', fn: simulateSpotLagTrail, config: { minEdge: 0.015, spotMoveThreshold: 0.00015, marketLagRatio: 0.7 } },
            { name: 'SpotLag_TimeAware', fn: simulateSpotLagTimeAware, config: {} },
            { name: 'SpotLag_ProbEdge', fn: simulateSpotLagProbEdge, config: {} },
            { name: 'Endgame', fn: simulateEndgame, config: {} },
            { name: 'Endgame_Conservative', fn: simulateEndgame, config: { minProbability: 0.95, maxTimeRemaining: 30 } },
        ];

        const results = {};
        for (const strat of strategies) {
            results[strat.name] = { wins: 0, losses: 0, noTrades: 0, totalPnl: 0, trades: [] };
        }

        // Process each window
        for (const window of windows) {
            const ticksResult = await pool.query(`
                SELECT * FROM ticks
                WHERE crypto = $1 AND window_epoch = $2
                ORDER BY timestamp_ms ASC
            `, [window.crypto, window.epoch]);

            const ticks = ticksResult.rows;
            if (ticks.length < 10) continue;

            for (const strat of strategies) {
                const result = strat.fn(ticks, window.crypto, window.outcome, strat.config);

                if (!result || result.action === 'NO_TRADE') {
                    results[strat.name].noTrades++;
                } else {
                    if (result.won) {
                        results[strat.name].wins++;
                    } else {
                        results[strat.name].losses++;
                    }
                    results[strat.name].totalPnl += result.pnl;
                    results[strat.name].trades.push({
                        crypto: window.crypto,
                        epoch: window.epoch,
                        ...result
                    });
                }
            }
        }

        // Print results
        console.log('─'.repeat(80));
        console.log('  STRATEGY PERFORMANCE SUMMARY');
        console.log('─'.repeat(80));
        console.log('\n  Strategy                | Trades |  W/L   | Win Rate |   PnL   | Avg Edge');
        console.log('  ' + '─'.repeat(76));

        for (const strat of strategies) {
            const r = results[strat.name];
            const totalTrades = r.wins + r.losses;
            const winRate = totalTrades > 0 ? (r.wins / totalTrades * 100) : 0;
            const avgEdge = totalTrades > 0
                ? r.trades.reduce((sum, t) => sum + (t.edge || 0), 0) / totalTrades * 100
                : 0;

            const name = strat.name.padEnd(23);
            const trades = String(totalTrades).padStart(4);
            const wl = `${r.wins}/${r.losses}`.padStart(6);
            const wr = winRate.toFixed(1).padStart(6) + '%';
            const pnl = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(2);
            const edge = avgEdge.toFixed(1).padStart(6) + '%';

            console.log(`  ${name} | ${trades}  | ${wl} | ${wr} | $${pnl.padStart(6)} | ${edge}`);
        }

        // Detail top performer trades
        const topStrategy = Object.entries(results)
            .filter(([_, r]) => r.wins + r.losses > 0)
            .sort((a, b) => b[1].totalPnl - a[1].totalPnl)[0];

        if (topStrategy) {
            const [name, r] = topStrategy;
            console.log(`\n${'─'.repeat(80)}`);
            console.log(`  TOP PERFORMER: ${name} - Sample Trades`);
            console.log('─'.repeat(80));

            const sampleTrades = r.trades.slice(0, 15);
            for (const t of sampleTrades) {
                const emoji = t.won ? '✅' : '❌';
                console.log(`  ${emoji} ${t.crypto.toUpperCase()} ${t.side.toUpperCase()} @ ${(t.entryPrice * 100).toFixed(0)}¢ | ` +
                    `BS=${((t.bsProb || t.favoriteProb || 0) * 100).toFixed(0)}% edge=${((t.edge || 0) * 100).toFixed(1)}% | ` +
                    `t=${t.timeRemaining?.toFixed(0) || '?'}s | outcome=${t.outcome} | PnL=${t.pnl > 0 ? '+' : ''}${(t.pnl * 100).toFixed(0)}¢`);
            }
        }

        // Summary
        console.log(`\n${'═'.repeat(80)}`);
        console.log('  OVERALL ANALYSIS');
        console.log('═'.repeat(80));

        const allTrades = Object.values(results).flatMap(r => r.trades);
        const totalWins = allTrades.filter(t => t.won).length;
        const totalLosses = allTrades.filter(t => !t.won).length;
        const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);

        console.log(`\n  Windows analyzed: ${windows.length}`);
        console.log(`  Total trades across all strategies: ${allTrades.length}`);
        console.log(`  Overall W/L: ${totalWins}/${totalLosses} (${(totalWins / (totalWins + totalLosses || 1) * 100).toFixed(1)}%)`);
        console.log(`  Combined PnL: $${totalPnl.toFixed(2)}`);

        // Edge analysis
        const edgeBuckets = { '0-2%': [], '2-5%': [], '5-10%': [], '10%+': [] };
        for (const t of allTrades) {
            const edgePct = (t.edge || 0) * 100;
            if (edgePct < 2) edgeBuckets['0-2%'].push(t);
            else if (edgePct < 5) edgeBuckets['2-5%'].push(t);
            else if (edgePct < 10) edgeBuckets['5-10%'].push(t);
            else edgeBuckets['10%+'].push(t);
        }

        console.log('\n  Win Rate by Edge Bucket:');
        for (const [bucket, trades] of Object.entries(edgeBuckets)) {
            if (trades.length > 0) {
                const wins = trades.filter(t => t.won).length;
                const wr = (wins / trades.length * 100).toFixed(1);
                console.log(`    ${bucket.padEnd(6)}: ${wins}/${trades.length} (${wr}%)`);
            }
        }

    } catch (e) {
        console.error('Error:', e.message);
        console.error(e.stack);
    } finally {
        await pool.end();
    }
}

main().catch(console.error);
