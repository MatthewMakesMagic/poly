#!/usr/bin/env node
/**
 * Check Lag Analytics - View lag-based trade performance
 *
 * Usage: node scripts/check_lag_analytics.js [hours]
 *        node scripts/check_lag_analytics.js 24    # Last 24 hours (default)
 *        node scripts/check_lag_analytics.js 168   # Last week
 *
 * Shows:
 * - Overall stats for trades with lag data
 * - Win rate by lag_ratio buckets (strong lag vs weak lag)
 * - Win rate by edge buckets (2%, 3%, 5%, 10%+)
 * - Win rate by oracle source (chainlink vs pyth vs binance)
 * - Win rate by Chainlink staleness
 * - Recent trades with full lag details
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { initDatabase, getLagAnalytics } from '../src/db/connection.js';

const hours = parseInt(process.argv[2]) || 24;

console.log(`\n${'═'.repeat(60)}`);
console.log(`  LAG ANALYTICS REPORT - Last ${hours} hours`);
console.log(`${'═'.repeat(60)}\n`);

async function run() {
    await initDatabase();

    const data = await getLagAnalytics({ hours });

    if (data.error) {
        console.error('Error:', data.error);
        process.exit(1);
    }

    // 1. Overall Stats
    console.log('📊 OVERALL STATS');
    console.log('─'.repeat(40));
    const o = data.overall;
    console.log(`  Total entries:        ${o.total_entries || 0}`);
    console.log(`  With lag data:        ${o.with_lag_data || 0}`);
    console.log(`  With edge data:       ${o.with_edge_data || 0}`);
    console.log(`  Avg lag ratio:        ${o.avg_lag_ratio ? parseFloat(o.avg_lag_ratio).toFixed(2) : 'N/A'}`);
    console.log(`  Avg edge:             ${o.avg_edge ? (parseFloat(o.avg_edge) * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Avg CL staleness:     ${o.avg_chainlink_staleness ? parseFloat(o.avg_chainlink_staleness).toFixed(1) + 's' : 'N/A'}`);

    // 2. Win Rate by Lag Ratio
    if (data.byLagRatio?.length > 0) {
        console.log('\n📈 WIN RATE BY LAG RATIO');
        console.log('─'.repeat(60));
        console.log('  Lag Bucket                 | Trades | Wins | Win%  | PnL');
        console.log('  ' + '─'.repeat(56));
        for (const row of data.byLagRatio) {
            const bucket = (row.lag_bucket || 'Unknown').padEnd(25);
            const trades = String(row.trades).padStart(5);
            const wins = String(row.wins).padStart(4);
            const winRate = (row.win_rate + '%').padStart(5);
            const pnl = ('$' + row.total_pnl).padStart(7);
            console.log(`  ${bucket} | ${trades} | ${wins} | ${winRate} | ${pnl}`);
        }
    } else {
        console.log('\n📈 WIN RATE BY LAG RATIO: No data yet');
    }

    // 3. Win Rate by Edge
    if (data.byEdge?.length > 0) {
        console.log('\n💰 WIN RATE BY EDGE AT ENTRY');
        console.log('─'.repeat(60));
        console.log('  Edge Bucket     | Trades | Wins | Win%  | Avg PnL');
        console.log('  ' + '─'.repeat(52));
        for (const row of data.byEdge) {
            const bucket = (row.edge_bucket || 'Unknown').padEnd(15);
            const trades = String(row.trades).padStart(5);
            const wins = String(row.wins).padStart(4);
            const winRate = (row.win_rate + '%').padStart(5);
            const avgPnl = ('$' + row.avg_pnl).padStart(7);
            console.log(`  ${bucket} | ${trades} | ${wins} | ${winRate} | ${avgPnl}`);
        }
    } else {
        console.log('\n💰 WIN RATE BY EDGE: No data yet');
    }

    // 4. Win Rate by Oracle Source
    if (data.byOracleSource?.length > 0) {
        console.log('\n🔮 WIN RATE BY ORACLE SOURCE');
        console.log('─'.repeat(50));
        console.log('  Source    | Trades | Wins | Win%  | PnL');
        console.log('  ' + '─'.repeat(44));
        for (const row of data.byOracleSource) {
            const src = (row.oracle_source || 'unknown').padEnd(9);
            const trades = String(row.trades).padStart(5);
            const wins = String(row.wins).padStart(4);
            const winRate = (row.win_rate + '%').padStart(5);
            const pnl = ('$' + row.total_pnl).padStart(7);
            console.log(`  ${src} | ${trades} | ${wins} | ${winRate} | ${pnl}`);
        }
    } else {
        console.log('\n🔮 WIN RATE BY ORACLE SOURCE: No data yet');
    }

    // 5. Win Rate by Chainlink Staleness
    if (data.byChainlinkStaleness?.length > 0) {
        console.log('\n⏱️  WIN RATE BY CHAINLINK STALENESS');
        console.log('─'.repeat(55));
        console.log('  Staleness Bucket    | Trades | Wins | Win%  | PnL');
        console.log('  ' + '─'.repeat(49));
        for (const row of data.byChainlinkStaleness) {
            const bucket = (row.staleness_bucket || 'Unknown').padEnd(19);
            const trades = String(row.trades).padStart(5);
            const wins = String(row.wins).padStart(4);
            const winRate = (row.win_rate + '%').padStart(5);
            const pnl = ('$' + row.total_pnl).padStart(7);
            console.log(`  ${bucket} | ${trades} | ${wins} | ${winRate} | ${pnl}`);
        }
    } else {
        console.log('\n⏱️  WIN RATE BY CHAINLINK STALENESS: No data yet');
    }

    // 6. Recent Trades
    if (data.recentTrades?.length > 0) {
        console.log('\n📝 RECENT LAG-BASED TRADES');
        console.log('─'.repeat(100));
        for (const t of data.recentTrades.slice(0, 10)) {
            const outcome = t.outcome === 'WIN' ? '✅' : '❌';
            const lagStr = t.lag_ratio ? `lag=${t.lag_ratio}` : '';
            const edgeStr = t.edge_pct ? `edge=${t.edge_pct}%` : '';
            const srcStr = t.oracle_source ? `[${t.oracle_source}]` : '';
            const staleStr = t.chainlink_staleness_sec ? `stale=${t.chainlink_staleness_sec}s` : '';

            console.log(`  ${outcome} ${t.entry_time} | ${t.strategy_name.slice(0, 20).padEnd(20)} | ${t.crypto} ${t.side.toUpperCase().padEnd(4)} | Entry: ${t.entry_price} Exit: ${t.exit_price} | PnL: $${t.pnl}`);
            if (lagStr || edgeStr) {
                console.log(`     ${lagStr} ${edgeStr} ${srcStr} ${staleStr}`);
            }
        }
    } else {
        console.log('\n📝 RECENT TRADES: No data yet');
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Generated: ${data.generated_at}`);
    console.log(`${'═'.repeat(60)}\n`);

    process.exit(0);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
