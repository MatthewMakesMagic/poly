#!/usr/bin/env node
/**
 * Check Live Strategy Performance
 *
 * Usage: node scripts/check_performance.js [hours]
 *
 * Shows P&L, win rates, and recent trades for all live strategies.
 */

import dotenv from 'dotenv';
dotenv.config();

import { getStrategyPerformanceStats, getRunningPnL } from '../src/db/connection.js';

const hours = parseInt(process.argv[2] || '24');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`   LIVE TRADING PERFORMANCE (Last ${hours} hours)`);
console.log('═══════════════════════════════════════════════════════════════\n');

try {
    // Get running P&L (all-time)
    const pnl = await getRunningPnL();
    console.log(`📊 ALL-TIME P&L: $${pnl.total.toFixed(2)}\n`);

    // Get detailed performance stats
    const stats = await getStrategyPerformanceStats({ hours });

    if (stats.error) {
        console.error('Error:', stats.error);
        process.exit(1);
    }

    // Summary
    const summary = stats.summary;
    if (summary && summary.total_trades > 0) {
        const winRate = ((summary.total_wins / summary.total_trades) * 100).toFixed(1);
        console.log('📈 SUMMARY:');
        console.log(`   Trades: ${summary.total_trades} | Wins: ${summary.total_wins} | Losses: ${summary.total_losses}`);
        console.log(`   Win Rate: ${winRate}% | Net P&L: $${summary.total_pnl}`);
        console.log(`   Active Strategies: ${summary.active_strategies}\n`);
    } else {
        console.log('📈 SUMMARY: No completed trades in this period\n');
    }

    // Per-strategy breakdown
    if (stats.strategies && stats.strategies.length > 0) {
        console.log('🎯 BY STRATEGY:');
        console.log('─'.repeat(90));
        console.log('Strategy                    | Trades | Win% | Net P&L | Avg Win | Avg Loss | PF');
        console.log('─'.repeat(90));

        for (const s of stats.strategies) {
            const name = (s.strategy_name || 'Unknown').padEnd(27);
            const trades = String(s.total_trades || 0).padStart(6);
            const winRate = String((s.win_rate || 0) + '%').padStart(5);
            const pnl = ('$' + (s.net_pnl || 0).toFixed(2)).padStart(8);
            const avgWin = ('$' + (s.avg_win || 0).toFixed(2)).padStart(8);
            const avgLoss = ('$' + (s.avg_loss || 0).toFixed(2)).padStart(9);
            const pf = String(s.profit_factor || '-').padStart(5);

            console.log(`${name} | ${trades} | ${winRate} | ${pnl} | ${avgWin} | ${avgLoss} | ${pf}`);
        }
        console.log('─'.repeat(90));
    }

    // Recent trades
    if (stats.recent && stats.recent.length > 0) {
        console.log('\n📋 RECENT TRADES:');
        console.log('─'.repeat(80));
        for (const t of stats.recent.slice(0, 5)) {
            const time = new Date(t.timestamp).toLocaleTimeString();
            const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
            const emoji = t.pnl >= 0 ? '✅' : '❌';
            console.log(`   ${emoji} ${time} | ${t.strategy_name} | ${t.crypto} ${t.side} | ${pnlStr} (${t.reason})`);
        }
    }

    // Hourly breakdown
    if (stats.hourly && stats.hourly.length > 0) {
        console.log('\n⏰ HOURLY P&L:');
        for (const h of stats.hourly.slice(0, 6)) {
            const hour = new Date(h.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const pnlStr = h.pnl >= 0 ? `+$${h.pnl.toFixed(2)}` : `-$${Math.abs(h.pnl).toFixed(2)}`;
            console.log(`   ${hour}: ${h.trades} trades, ${h.wins} wins, ${pnlStr}`);
        }
    }

    console.log('\n');

} catch (error) {
    console.error('Failed to get performance stats:', error.message);
    process.exit(1);
}
