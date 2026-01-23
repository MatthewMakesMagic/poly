/**
 * Backtest strategies against historical tick data
 * 
 * This will tell us:
 * 1. Why certain strategies showed 0 signals
 * 2. How they would have performed
 * 3. Whether entry conditions are too strict
 */

import pg from 'pg';

// Import strategies
import { createSpotLagSimple, createSpotLagFast, createSpotLagAggressive } from '../src/quant/strategies/spot_lag_simple.js';
import { createSpotLag1s, createSpotLag5s } from '../src/quant/strategies/spot_lag_strategy.js';
import { createContrarianBase, createContrarianSOL, createContrarianScalp } from '../src/quant/strategies/contrarian_strategy.js';
import { createEndgameBase, createEndgameConservative, createEndgameAggressive } from '../src/quant/strategies/endgame_strategy.js';
import { FairValueStrategy } from '../src/quant/strategies/fair_value_strategy.js';
import { MicrostructureStrategy } from '../src/quant/strategies/microstructure_strategy.js';

const pool = new pg.Pool({
    connectionString: 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function loadHistoricalData() {
    console.log('Loading historical tick data...\n');
    
    // Get tick count
    const { rows: countRows } = await pool.query('SELECT COUNT(*) as count FROM ticks');
    console.log(`Total ticks in database: ${countRows[0].count}`);
    
    // Get window count with outcomes
    const { rows: windowRows } = await pool.query(`
        SELECT COUNT(*) as total, 
               COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END) as resolved
        FROM windows
    `);
    console.log(`Windows: ${windowRows[0].total} total, ${windowRows[0].resolved} resolved`);
    
    // Load ticks grouped by window
    const { rows: ticks } = await pool.query(`
        SELECT t.*, w.outcome
        FROM ticks t
        LEFT JOIN windows w ON t.window_epoch = w.epoch AND t.crypto = w.crypto
        ORDER BY t.crypto, t.window_epoch, t.timestamp_ms
    `);
    
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

function runBacktest(strategy, windows) {
    const results = {
        name: strategy.getName(),
        signals: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        positions: [],
        signalReasons: {},  // Track why signals weren't generated
        byCrypto: {}
    };
    
    // Track positions per crypto
    const positions = {};
    
    for (const window of windows) {
        const crypto = window.crypto;
        
        if (!results.byCrypto[crypto]) {
            results.byCrypto[crypto] = { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 };
        }
        
        for (const tick of window.ticks) {
            // Add required fields if missing
            tick.crypto = crypto;
            tick.timestamp = tick.timestamp_ms;
            
            const position = positions[crypto] || null;
            const signal = strategy.onTick(tick, position, {});
            
            // Track signal reasons
            if (signal.reason) {
                results.signalReasons[signal.reason] = (results.signalReasons[signal.reason] || 0) + 1;
            }
            
            if (signal.action === 'buy' && !position) {
                results.signals++;
                results.byCrypto[crypto].signals++;
                
                const entryPrice = signal.side === 'up' ? (tick.up_ask || tick.up_mid + 0.01) : (1 - (tick.up_bid || tick.up_mid - 0.01));
                positions[crypto] = {
                    side: signal.side,
                    entryPrice,
                    entryTime: tick.timestamp_ms,
                    size: 100,
                    reason: signal.reason
                };
                results.trades++;
                results.byCrypto[crypto].trades++;
            } else if (signal.action === 'sell' && position) {
                // Early exit (we'll also close at window end)
                const exitPrice = position.side === 'up' ? (tick.up_bid || tick.up_mid - 0.01) : (1 - (tick.up_ask || tick.up_mid + 0.01));
                const pnl = (exitPrice - position.entryPrice) * position.size;
                
                if (pnl > 0) {
                    results.wins++;
                    results.byCrypto[crypto].wins++;
                } else {
                    results.losses++;
                    results.byCrypto[crypto].losses++;
                }
                results.totalPnl += pnl;
                results.byCrypto[crypto].pnl += pnl;
                
                results.positions.push({
                    crypto,
                    side: position.side,
                    entryPrice: position.entryPrice,
                    exitPrice,
                    pnl,
                    reason: signal.reason
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
            
            if (pnl > 0) {
                results.wins++;
                results.byCrypto[crypto].wins++;
            } else {
                results.losses++;
                results.byCrypto[crypto].losses++;
            }
            results.totalPnl += pnl;
            results.byCrypto[crypto].pnl += pnl;
            
            results.positions.push({
                crypto,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice,
                pnl,
                reason: 'window_expiry',
                outcome: window.outcome
            });
            
            delete positions[crypto];
        }
    }
    
    return results;
}

async function main() {
    console.log('='.repeat(70));
    console.log('  STRATEGY BACKTEST');
    console.log('='.repeat(70));
    console.log();
    
    const windows = await loadHistoricalData();
    
    if (windows.length === 0) {
        console.log('No data to backtest!');
        await pool.end();
        return;
    }
    
    // Show data summary
    const cryptos = [...new Set(windows.map(w => w.crypto))];
    const resolvedWindows = windows.filter(w => w.outcome);
    console.log(`Cryptos: ${cryptos.join(', ')}`);
    console.log(`Windows with outcomes: ${resolvedWindows.length}`);
    console.log();
    
    // Define strategies to test
    const strategies = [
        // OLD SpotLag (uses fair value)
        createSpotLag1s(100),
        createSpotLag5s(100),
        
        // NEW SpotLag Simple (no fair value)
        createSpotLagSimple(100),
        createSpotLagFast(100),
        createSpotLagAggressive(100),
        
        // Contrarian
        createContrarianBase(100),
        createContrarianSOL(100),
        createContrarianScalp(100),
        
        // Endgame
        createEndgameBase(100),
        createEndgameConservative(100),
        createEndgameAggressive(100),
        
        // Others
        new FairValueStrategy({ maxPosition: 100 }),
        new MicrostructureStrategy({ maxPosition: 100 })
    ];
    
    console.log('='.repeat(70));
    console.log('  RESULTS');
    console.log('='.repeat(70));
    console.log();
    
    const allResults = [];
    
    for (const strategy of strategies) {
        const results = runBacktest(strategy, windows);
        allResults.push(results);
        
        const totalTrades = results.wins + results.losses;
        const winRate = totalTrades > 0 ? (results.wins / totalTrades * 100).toFixed(1) : 0;
        
        console.log(`\n${results.name}:`);
        console.log(`  Signals: ${results.signals}, Trades closed: ${totalTrades}`);
        console.log(`  W/L: ${results.wins}/${results.losses} (${winRate}%)`);
        console.log(`  P&L: $${results.totalPnl.toFixed(2)}`);
        
        // Show crypto breakdown if any trades
        if (totalTrades > 0) {
            console.log('  By crypto:');
            for (const [crypto, stats] of Object.entries(results.byCrypto)) {
                if (stats.trades > 0) {
                    const cWinRate = stats.wins + stats.losses > 0 
                        ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(0) 
                        : 0;
                    console.log(`    ${crypto.toUpperCase()}: ${stats.signals} signals, ${stats.wins}W/${stats.losses}L (${cWinRate}%), $${stats.pnl.toFixed(2)}`);
                }
            }
        }
        
        // Show why signals weren't generated (top 3 reasons)
        if (results.signals === 0) {
            console.log('  WHY NO SIGNALS:');
            const sortedReasons = Object.entries(results.signalReasons)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);
            for (const [reason, count] of sortedReasons) {
                console.log(`    ${reason}: ${count} ticks`);
            }
        }
        
        // Show sample trades
        if (results.positions.length > 0) {
            console.log('  Sample trades:');
            results.positions.slice(-3).forEach(p => {
                const outcome = p.pnl > 0 ? '✓' : '✗';
                console.log(`    ${outcome} ${p.crypto} ${p.side}: ${p.entryPrice.toFixed(3)} → ${p.exitPrice.toFixed(3)} = $${p.pnl.toFixed(2)} (${p.reason})`);
            });
        }
    }
    
    // Summary table
    console.log('\n' + '='.repeat(70));
    console.log('  SUMMARY');
    console.log('='.repeat(70));
    console.log('\n| Strategy | Signals | W/L | Win% | P&L |');
    console.log('|----------|---------|-----|------|-----|');
    
    allResults
        .sort((a, b) => b.totalPnl - a.totalPnl)
        .forEach(r => {
            const total = r.wins + r.losses;
            const winRate = total > 0 ? (r.wins / total * 100).toFixed(0) : '-';
            console.log(`| ${r.name.padEnd(20)} | ${String(r.signals).padStart(4)} | ${r.wins}/${r.losses} | ${winRate}% | $${r.totalPnl.toFixed(2)} |`);
        });
    
    await pool.end();
}

main().catch(console.error);
