#!/usr/bin/env node
/**
 * Backtest MicroLag_Convergence strategies against historical tick data
 *
 * PURPOSE: Validate that the new strategies generate signals before enabling live trading
 *
 * This will tell us:
 * 1. Whether MicroLag_Convergence generates signals (unlike TimeAware with 0 signals)
 * 2. Win rate estimate with trailing stop exits
 * 3. Average P&L per trade
 * 4. Breakdown by crypto and time window (early/mid/late)
 *
 * Run with: node scripts/backtest_microlag.mjs
 */

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Import the new MicroLag strategies
import {
    createMicroLagConvergence,
    createMicroLagConvergenceAggro,
    createMicroLagConvergenceSafe,
    createSpotLagAggressive,  // For comparison (known to work)
    createSpotLagTimeAware,   // For comparison (known to have 0 signals)
} from '../src/quant/strategies/spot_lag_simple.js';

// Use DATABASE_URL from env or default
const connectionString = process.env.DATABASE_URL ||
    'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

/**
 * Load historical tick data from the last N hours
 */
async function loadHistoricalData(hoursBack = 48) {
    console.log(`Loading historical tick data (last ${hoursBack} hours)...\n`);

    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);

    // Get tick count
    const { rows: countRows } = await pool.query(
        'SELECT COUNT(*) as count FROM ticks WHERE timestamp_ms > $1',
        [cutoffTime]
    );
    console.log(`Ticks in time range: ${countRows[0].count}`);

    // Get window count with outcomes
    const { rows: windowRows } = await pool.query(`
        SELECT COUNT(*) as total,
               COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END) as resolved
        FROM windows
        WHERE epoch > $1
    `, [Math.floor(cutoffTime / 1000)]);
    console.log(`Windows: ${windowRows[0].total} total, ${windowRows[0].resolved} resolved`);

    // Load ticks grouped by window
    const { rows: ticks } = await pool.query(`
        SELECT t.*, w.outcome
        FROM ticks t
        LEFT JOIN windows w ON t.window_epoch = w.epoch AND t.crypto = w.crypto
        WHERE t.timestamp_ms > $1
        ORDER BY t.crypto, t.window_epoch, t.timestamp_ms
    `, [cutoffTime]);

    console.log(`Loaded ${ticks.length} ticks for backtesting\n`);

    // Group by window
    const windows = {};
    for (const tick of ticks) {
        const key = `${tick.crypto}_${tick.window_epoch}`;
        if (!windows[key]) {
            windows[key] = {
                crypto: tick.crypto,
                epoch: tick.window_epoch,
                outcome: tick.outcome,
                ticks: []
            };
        }
        windows[key].ticks.push(tick);
    }

    return Object.values(windows);
}

/**
 * Simulate running a strategy over historical windows
 * Handles trailing stop exits properly
 */
function runBacktest(strategy, windows) {
    const results = {
        name: strategy.getName(),
        signals: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        positions: [],
        signalReasons: {},
        byCrypto: {},
        byTimeWindow: {
            early: { signals: 0, wins: 0, losses: 0, pnl: 0 },
            mid: { signals: 0, wins: 0, losses: 0, pnl: 0 },
            late: { signals: 0, wins: 0, losses: 0, pnl: 0 }
        },
        trailingExits: 0,
        expiryExits: 0,
        underdogTrades: 0
    };

    // Track positions per crypto
    const positions = {};

    for (const window of windows) {
        const crypto = window.crypto;

        if (!results.byCrypto[crypto]) {
            results.byCrypto[crypto] = { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 };
        }

        // Reset strategy state for each window (simulate real behavior)
        if (strategy.onWindowStart) {
            strategy.onWindowStart({ crypto, epoch: window.epoch });
        }

        for (const tick of window.ticks) {
            // Ensure required fields
            tick.crypto = crypto;
            tick.timestamp = tick.timestamp_ms;

            // Calculate down_bid/down_ask from up prices if not present
            if (tick.up_bid && !tick.down_ask) {
                tick.down_ask = 1 - tick.up_bid;
                tick.down_bid = 1 - tick.up_ask;
            }

            const position = positions[crypto] || null;
            const signal = strategy.onTick(tick, position, {});

            // Track signal reasons
            if (signal.reason) {
                results.signalReasons[signal.reason] = (results.signalReasons[signal.reason] || 0) + 1;
            }

            if (signal.action === 'buy' && !position) {
                results.signals++;
                results.byCrypto[crypto].signals++;

                const entryPrice = signal.side === 'up'
                    ? (tick.up_ask || tick.up_mid + 0.01)
                    : (tick.down_ask || (1 - tick.up_mid) + 0.01);

                positions[crypto] = {
                    side: signal.side,
                    entryPrice,
                    entryTime: tick.timestamp_ms,
                    size: 100,
                    reason: signal.reason,
                    timeWindow: signal.timeWindow || 'unknown',
                    isUnderdog: signal.isUnderdog || false,
                    expectedProfit: signal.expectedProfit || 'N/A'
                };

                results.trades++;
                results.byCrypto[crypto].trades++;

                // Track by time window
                if (signal.timeWindow && results.byTimeWindow[signal.timeWindow]) {
                    results.byTimeWindow[signal.timeWindow].signals++;
                }

                // Track underdog trades
                if (signal.isUnderdog) {
                    results.underdogTrades++;
                }

            } else if (signal.action === 'sell' && position) {
                // Trailing stop exit
                const exitPrice = position.side === 'up'
                    ? (tick.up_bid || tick.up_mid - 0.01)
                    : (tick.down_bid || (1 - tick.up_mid) - 0.01);
                const pnl = (exitPrice - position.entryPrice) * position.size;

                const isWin = pnl > 0;
                if (isWin) {
                    results.wins++;
                    results.byCrypto[crypto].wins++;
                    if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                        results.byTimeWindow[position.timeWindow].wins++;
                    }
                } else {
                    results.losses++;
                    results.byCrypto[crypto].losses++;
                    if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                        results.byTimeWindow[position.timeWindow].losses++;
                    }
                }
                results.totalPnl += pnl;
                results.byCrypto[crypto].pnl += pnl;
                if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                    results.byTimeWindow[position.timeWindow].pnl += pnl;
                }

                results.trailingExits++;

                results.positions.push({
                    crypto,
                    side: position.side,
                    entryPrice: position.entryPrice,
                    exitPrice,
                    pnl,
                    reason: signal.reason,
                    timeWindow: position.timeWindow,
                    isUnderdog: position.isUnderdog,
                    expectedProfit: position.expectedProfit
                });

                delete positions[crypto];
            }
        }

        // Close position at window end (binary payout)
        if (positions[crypto] && window.outcome) {
            const position = positions[crypto];
            const isCorrect = (position.side === 'up' && window.outcome === 'up') ||
                             (position.side === 'down' && window.outcome === 'down');
            const exitPrice = isCorrect ? 1.0 : 0.0;
            const pnl = (exitPrice - position.entryPrice) * position.size;

            const isWin = pnl > 0;
            if (isWin) {
                results.wins++;
                results.byCrypto[crypto].wins++;
                if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                    results.byTimeWindow[position.timeWindow].wins++;
                }
            } else {
                results.losses++;
                results.byCrypto[crypto].losses++;
                if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                    results.byTimeWindow[position.timeWindow].losses++;
                }
            }
            results.totalPnl += pnl;
            results.byCrypto[crypto].pnl += pnl;
            if (position.timeWindow && results.byTimeWindow[position.timeWindow]) {
                results.byTimeWindow[position.timeWindow].pnl += pnl;
            }

            results.expiryExits++;

            results.positions.push({
                crypto,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice,
                pnl,
                reason: 'window_expiry',
                outcome: window.outcome,
                timeWindow: position.timeWindow,
                isUnderdog: position.isUnderdog,
                expectedProfit: position.expectedProfit
            });

            delete positions[crypto];
        }
    }

    return results;
}

function printResults(results) {
    const totalTrades = results.wins + results.losses;
    const winRate = totalTrades > 0 ? (results.wins / totalTrades * 100).toFixed(1) : 0;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${results.name}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`  Signals: ${results.signals}`);
    console.log(`  Trades closed: ${totalTrades}`);
    console.log(`  W/L: ${results.wins}/${results.losses} (${winRate}% win rate)`);
    console.log(`  P&L: $${results.totalPnl.toFixed(2)}`);
    console.log(`  Avg P&L per trade: $${totalTrades > 0 ? (results.totalPnl / totalTrades).toFixed(2) : 0}`);

    // Exit type breakdown
    console.log(`\n  Exit breakdown:`);
    console.log(`    Trailing stops: ${results.trailingExits}`);
    console.log(`    Window expiry: ${results.expiryExits}`);

    // Underdog trades
    if (results.underdogTrades > 0) {
        console.log(`    Underdog trades: ${results.underdogTrades}`);
    }

    // Time window breakdown
    console.log(`\n  By time window:`);
    for (const [window, stats] of Object.entries(results.byTimeWindow)) {
        const wTotal = stats.wins + stats.losses;
        const wWinRate = wTotal > 0 ? (stats.wins / wTotal * 100).toFixed(0) : '-';
        if (stats.signals > 0) {
            console.log(`    ${window.padEnd(6)}: ${stats.signals} signals, ${stats.wins}W/${stats.losses}L (${wWinRate}%), $${stats.pnl.toFixed(2)}`);
        }
    }

    // Crypto breakdown
    console.log(`\n  By crypto:`);
    for (const [crypto, stats] of Object.entries(results.byCrypto)) {
        if (stats.signals > 0) {
            const cWinRate = stats.wins + stats.losses > 0
                ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(0)
                : '-';
            console.log(`    ${crypto.toUpperCase().padEnd(4)}: ${stats.signals} signals, ${stats.wins}W/${stats.losses}L (${cWinRate}%), $${stats.pnl.toFixed(2)}`);
        }
    }

    // Show why signals weren't generated (top 5 reasons)
    if (results.signals === 0) {
        console.log(`\n  WHY NO SIGNALS:`);
        const sortedReasons = Object.entries(results.signalReasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        for (const [reason, count] of sortedReasons) {
            console.log(`    ${reason}: ${count} ticks`);
        }
    }

    // Show sample trades
    if (results.positions.length > 0) {
        console.log(`\n  Sample trades (last 5):`);
        results.positions.slice(-5).forEach(p => {
            const outcome = p.pnl > 0 ? '✓' : '✗';
            const underdogTag = p.isUnderdog ? ' [UNDERDOG]' : '';
            console.log(`    ${outcome} ${p.crypto.toUpperCase()} ${p.side}: ${p.entryPrice.toFixed(3)} → ${p.exitPrice.toFixed(3)} = $${p.pnl.toFixed(2)} (${p.reason})${underdogTag}`);
        });
    }
}

async function main() {
    console.log('═'.repeat(70));
    console.log('  MICROLAG CONVERGENCE BACKTEST');
    console.log('  Testing new expected profit model vs broken TimeAware strategies');
    console.log('═'.repeat(70));
    console.log();

    // Load data including resolved windows (need to go back further to get Jan 22-23 data)
    const windows = await loadHistoricalData(168);  // Last 7 days to include resolved outcomes

    if (windows.length === 0) {
        console.log('No data to backtest!');
        await pool.end();
        return;
    }

    // Show data summary
    const cryptos = [...new Set(windows.map(w => w.crypto))];
    const resolvedWindows = windows.filter(w => w.outcome);
    console.log(`Cryptos: ${cryptos.join(', ')}`);
    console.log(`Windows: ${windows.length} total, ${resolvedWindows.length} with outcomes`);
    console.log();

    // Define strategies to test
    const strategies = [
        // NEW MICROLAG CONVERGENCE (what we're testing)
        createMicroLagConvergence(100),
        createMicroLagConvergenceAggro(100),
        createMicroLagConvergenceSafe(100),

        // COMPARISON: Known working strategy
        createSpotLagAggressive(100),

        // COMPARISON: Known broken strategy (should show 0 signals)
        createSpotLagTimeAware(100),
    ];

    console.log('═'.repeat(70));
    console.log('  INDIVIDUAL RESULTS');
    console.log('═'.repeat(70));

    const allResults = [];

    for (const strategy of strategies) {
        const results = runBacktest(strategy, windows);
        allResults.push(results);
        printResults(results);
    }

    // Summary comparison table
    console.log('\n' + '═'.repeat(70));
    console.log('  SUMMARY COMPARISON');
    console.log('═'.repeat(70));
    console.log('\n| Strategy                       | Signals | W/L      | Win%  | P&L       |');
    console.log('|--------------------------------|---------|----------|-------|-----------|');

    allResults
        .sort((a, b) => b.totalPnl - a.totalPnl)
        .forEach(r => {
            const total = r.wins + r.losses;
            const winRate = total > 0 ? (r.wins / total * 100).toFixed(0) : '-';
            const pnlStr = r.totalPnl >= 0 ? `+$${r.totalPnl.toFixed(2)}` : `-$${Math.abs(r.totalPnl).toFixed(2)}`;
            console.log(`| ${r.name.padEnd(30)} | ${String(r.signals).padStart(7)} | ${r.wins}/${r.losses}`.padEnd(55) + `| ${winRate}%`.padEnd(8) + `| ${pnlStr.padStart(9)} |`);
        });

    // Validation check
    console.log('\n' + '═'.repeat(70));
    console.log('  VALIDATION');
    console.log('═'.repeat(70));

    const microLag = allResults.find(r => r.name === 'MicroLag_Convergence');
    const timeAware = allResults.find(r => r.name === 'SpotLag_TimeAware');
    const aggressive = allResults.find(r => r.name === 'SpotLag_Aggressive');

    console.log('\n');
    if (microLag && microLag.signals > 0) {
        console.log(`✅ MicroLag_Convergence generates ${microLag.signals} signals (vs TimeAware: ${timeAware?.signals || 0})`);

        if (microLag.wins + microLag.losses > 0) {
            const winRate = (microLag.wins / (microLag.wins + microLag.losses) * 100).toFixed(1);
            console.log(`✅ Win rate: ${winRate}%`);

            if (microLag.totalPnl > 0) {
                console.log(`✅ Positive P&L: $${microLag.totalPnl.toFixed(2)}`);
                console.log('\n🎉 READY FOR LIVE TRADING - backtest shows positive results');
            } else {
                console.log(`⚠️  Negative P&L: $${microLag.totalPnl.toFixed(2)} - review before enabling live`);
            }
        }
    } else {
        console.log(`❌ MicroLag_Convergence generated 0 signals - investigate thresholds`);
    }

    // Compare to aggressive
    if (aggressive && microLag) {
        const aggroSignals = aggressive.signals;
        const microSignals = microLag.signals;
        const ratio = aggroSignals > 0 ? (microSignals / aggroSignals * 100).toFixed(0) : 'N/A';
        console.log(`\n📊 Signal ratio vs SpotLag_Aggressive: ${ratio}% (${microSignals}/${aggroSignals})`);
    }

    await pool.end();
}

main().catch(console.error);
