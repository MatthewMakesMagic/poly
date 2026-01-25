#!/usr/bin/env node
/**
 * Compare Paper Trading vs Live Trading Results
 * Shows side-by-side what paper said vs what actually happened
 */

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

async function compare() {
    try {
        // Get most recent window epochs from live trades
        const windowResult = await pool.query(`
            SELECT DISTINCT window_epoch 
            FROM live_trades 
            WHERE timestamp > NOW() - INTERVAL '2 hours'
            ORDER BY window_epoch DESC 
            LIMIT 3
        `);
        
        if (windowResult.rows.length === 0) {
            console.log('No recent live trades found');
            return;
        }
        
        for (const windowRow of windowResult.rows) {
            const recentWindow = windowRow.window_epoch;
            console.log('\n' + '='.repeat(80));
            console.log('WINDOW:', recentWindow, '| Time:', new Date(recentWindow * 1000).toLocaleString());
            console.log('='.repeat(80));
            
            // Get LIVE trades for this window
            console.log('\n📊 LIVE TRADES (what actually happened):');
            const liveResult = await pool.query(`
                SELECT strategy_name, crypto, side, type, price, pnl, outcome, reason, timestamp
                FROM live_trades 
                WHERE window_epoch = $1
                ORDER BY strategy_name, timestamp
            `, [recentWindow]);
            
            if (liveResult.rows.length === 0) {
                console.log('  No live trades for this window');
            } else {
                for (const row of liveResult.rows) {
                    const status = row.type === 'exit' 
                        ? (row.pnl > 0 ? '✅ WIN' : '❌ LOSS') 
                        : '📥 ENTRY';
                    console.log(`  ${status} | ${row.strategy_name.padEnd(20)} | ${row.crypto.padEnd(4)} | ${(row.side || 'N/A').padEnd(5)} | ${row.type.padEnd(5)} @ ${(row.price?.toFixed(3) || 'N/A').padStart(6)} | P&L: $${(row.pnl?.toFixed(2) || 'N/A').padStart(6)} | Outcome: ${row.outcome || 'N/A'}`);
                }
            }
            
            // Get unique strategies from live trades
            const liveStrategies = [...new Set(liveResult.rows.map(r => r.strategy_name))];
            
            // Get PAPER trades for same window and strategies
            console.log('\n📄 PAPER TRADES (what simulation said):');
            const paperResult = await pool.query(`
                SELECT strategy_name, crypto, side, entry_price, exit_price, pnl, exit_reason, exit_time
                FROM paper_trades 
                WHERE window_epoch = $1
                AND strategy_name = ANY($2)
                ORDER BY strategy_name, exit_time
            `, [recentWindow, liveStrategies]);
            
            if (paperResult.rows.length === 0) {
                console.log('  No paper trades for these strategies in this window');
            } else {
                for (const row of paperResult.rows) {
                    const status = row.pnl > 0 ? '✅ WIN' : '❌ LOSS';
                    console.log(`  ${status} | ${row.strategy_name.padEnd(20)} | ${row.crypto.padEnd(4)} | ${(row.side || 'N/A').padEnd(5)} | Entry: ${row.entry_price?.toFixed(3)} → Exit: ${row.exit_price?.toFixed(3)} | P&L: $${row.pnl?.toFixed(2).padStart(6)} | Reason: ${row.exit_reason}`);
                }
            }
            
            // Summary comparison
            console.log('\n📈 SUMMARY FOR THIS WINDOW:');
            
            const liveExits = liveResult.rows.filter(r => r.type === 'exit');
            const liveWins = liveExits.filter(r => r.pnl > 0).length;
            const liveLosses = liveExits.filter(r => r.pnl <= 0).length;
            const livePnl = liveExits.reduce((sum, r) => sum + (r.pnl || 0), 0);
            
            const paperWins = paperResult.rows.filter(r => r.pnl > 0).length;
            const paperLosses = paperResult.rows.filter(r => r.pnl <= 0).length;
            const paperPnl = paperResult.rows.reduce((sum, r) => sum + (r.pnl || 0), 0);
            
            console.log(`  LIVE:  ${liveWins} wins, ${liveLosses} losses, P&L: $${livePnl.toFixed(2)}`);
            console.log(`  PAPER: ${paperWins} wins, ${paperLosses} losses, P&L: $${paperPnl.toFixed(2)}`);
            
            if (livePnl !== paperPnl) {
                console.log(`  ⚠️  DISCREPANCY: $${(livePnl - paperPnl).toFixed(2)}`);
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await pool.end();
    }
}

compare();
