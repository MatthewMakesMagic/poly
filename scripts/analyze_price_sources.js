#!/usr/bin/env node

/**
 * Price Source Analysis Script
 *
 * Analyzes collected price data to determine which source(s) best predict
 * Polymarket resolution outcomes.
 *
 * Usage:
 *   node scripts/analyze_price_sources.js [options]
 *
 * Options:
 *   --crypto <btc|eth|sol|xrp>  Analyze specific crypto (default: all)
 *   --hours <n>                  Analyze last N hours (default: 24)
 *   --output <json|table>        Output format (default: table)
 *   --export <filename>          Export results to JSON file
 */

import { initDatabase, getDatabase, USE_POSTGRES, ensurePool } from '../src/db/connection.js';
import fs from 'fs';

// Parse arguments
const args = process.argv.slice(2);
const CRYPTO = args.includes('--crypto') ? args[args.indexOf('--crypto') + 1] : null;
const HOURS = args.includes('--hours') ? parseInt(args[args.indexOf('--hours') + 1]) : 24;
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'table';
const EXPORT_FILE = args.includes('--export') ? args[args.indexOf('--export') + 1] : null;

const SOURCES = ['pyth', 'redstone', 'coinbase', 'kraken', 'okx', 'coincap', 'coingecko', 'binance', 'chainlink'];
const CRYPTOS = CRYPTO ? [CRYPTO] : ['btc', 'eth', 'sol', 'xrp'];

/**
 * Execute SQL query
 */
async function query(sql, params = []) {
    if (USE_POSTGRES) {
        const pool = ensurePool();
        const result = await pool.query(sql, params);
        return result.rows;
    } else {
        const db = getDatabase();
        return db.prepare(sql).all(...params);
    }
}

/**
 * Get basic stats about collected data
 */
async function getDataStats() {
    const cutoffMs = Date.now() - (HOURS * 60 * 60 * 1000);

    const results = await query(`
        SELECT
            crypto,
            COUNT(*) as snapshot_count,
            MIN(timestamp_ms) as first_snapshot,
            MAX(timestamp_ms) as last_snapshot,
            COUNT(DISTINCT window_epoch) as window_count,
            AVG(source_count) as avg_source_count,
            AVG(price_spread_pct) as avg_spread_pct
        FROM price_snapshots
        WHERE timestamp_ms > ?
        GROUP BY crypto
        ORDER BY crypto
    `, [cutoffMs]);

    return results;
}

/**
 * Get price divergence stats between sources
 */
async function getDivergenceStats() {
    const cutoffMs = Date.now() - (HOURS * 60 * 60 * 1000);

    const results = {};

    for (const crypto of CRYPTOS) {
        // Get all snapshots with multiple sources
        const snapshots = await query(`
            SELECT
                timestamp_ms,
                pyth_price, coinbase_price, kraken_price, okx_price,
                coincap_price, coingecko_price, redstone_price,
                binance_price, chainlink_price, consensus_price
            FROM price_snapshots
            WHERE crypto = ? AND timestamp_ms > ? AND source_count >= 3
            ORDER BY timestamp_ms
        `, [crypto, cutoffMs]);

        if (snapshots.length === 0) continue;

        // Calculate divergence between each source and consensus
        const divergences = {};
        for (const source of SOURCES) {
            divergences[source] = {
                samples: 0,
                totalDivergence: 0,
                maxDivergence: 0,
                divergences: []
            };
        }

        for (const snap of snapshots) {
            const consensus = snap.consensus_price;
            if (!consensus) continue;

            for (const source of SOURCES) {
                const price = snap[`${source}_price`];
                if (price && price > 0) {
                    const divergencePct = Math.abs((price - consensus) / consensus) * 100;
                    divergences[source].samples++;
                    divergences[source].totalDivergence += divergencePct;
                    divergences[source].maxDivergence = Math.max(divergences[source].maxDivergence, divergencePct);
                    divergences[source].divergences.push(divergencePct);
                }
            }
        }

        // Calculate averages and percentiles
        for (const source of SOURCES) {
            const d = divergences[source];
            if (d.samples > 0) {
                d.avgDivergence = d.totalDivergence / d.samples;
                d.divergences.sort((a, b) => a - b);
                d.p50 = d.divergences[Math.floor(d.divergences.length * 0.5)] || 0;
                d.p95 = d.divergences[Math.floor(d.divergences.length * 0.95)] || 0;
                d.p99 = d.divergences[Math.floor(d.divergences.length * 0.99)] || 0;
            }
            delete d.divergences; // Clean up
            delete d.totalDivergence;
        }

        results[crypto] = divergences;
    }

    return results;
}

/**
 * Get source availability stats
 */
async function getAvailabilityStats() {
    const cutoffMs = Date.now() - (HOURS * 60 * 60 * 1000);

    const results = {};

    for (const crypto of CRYPTOS) {
        const totalSnapshots = await query(`
            SELECT COUNT(*) as count FROM price_snapshots
            WHERE crypto = ? AND timestamp_ms > ?
        `, [crypto, cutoffMs]);

        const total = totalSnapshots[0]?.count || 0;
        if (total === 0) continue;

        const availability = {};
        for (const source of SOURCES) {
            const withSource = await query(`
                SELECT COUNT(*) as count FROM price_snapshots
                WHERE crypto = ? AND timestamp_ms > ? AND ${source}_price IS NOT NULL
            `, [crypto, cutoffMs]);

            availability[source] = {
                count: withSource[0]?.count || 0,
                percentage: ((withSource[0]?.count || 0) / total * 100).toFixed(2)
            };
        }

        results[crypto] = { total, availability };
    }

    return results;
}

/**
 * Analyze latency between sources (which source updates first)
 */
async function getLatencyAnalysis() {
    const cutoffMs = Date.now() - (HOURS * 60 * 60 * 1000);

    const results = {};

    for (const crypto of CRYPTOS) {
        // Get consecutive snapshots to detect price changes
        const snapshots = await query(`
            SELECT
                timestamp_ms,
                pyth_price, pyth_staleness,
                coinbase_price, kraken_price, okx_price,
                coincap_price, redstone_price, redstone_staleness
            FROM price_snapshots
            WHERE crypto = ? AND timestamp_ms > ?
            ORDER BY timestamp_ms
            LIMIT 10000
        `, [crypto, cutoffMs]);

        if (snapshots.length < 100) continue;

        // Track staleness for each source
        const stalenessStats = {
            pyth: { total: 0, count: 0, values: [] },
            redstone: { total: 0, count: 0, values: [] }
        };

        for (const snap of snapshots) {
            if (snap.pyth_staleness !== null) {
                stalenessStats.pyth.total += snap.pyth_staleness;
                stalenessStats.pyth.count++;
                stalenessStats.pyth.values.push(snap.pyth_staleness);
            }
            if (snap.redstone_staleness !== null) {
                stalenessStats.redstone.total += snap.redstone_staleness;
                stalenessStats.redstone.count++;
                stalenessStats.redstone.values.push(snap.redstone_staleness);
            }
        }

        // Calculate stats
        for (const [source, stats] of Object.entries(stalenessStats)) {
            if (stats.count > 0) {
                stats.avg = stats.total / stats.count;
                stats.values.sort((a, b) => a - b);
                stats.p50 = stats.values[Math.floor(stats.values.length * 0.5)] || 0;
                stats.p95 = stats.values[Math.floor(stats.values.length * 0.95)] || 0;
                stats.max = stats.values[stats.values.length - 1] || 0;
            }
            delete stats.values;
            delete stats.total;
        }

        results[crypto] = stalenessStats;
    }

    return results;
}

/**
 * Get correlation between sources
 */
async function getCorrelationAnalysis() {
    const cutoffMs = Date.now() - (HOURS * 60 * 60 * 1000);

    const results = {};

    for (const crypto of CRYPTOS) {
        const snapshots = await query(`
            SELECT
                pyth_price, coinbase_price, kraken_price, okx_price,
                coincap_price, binance_price, consensus_price
            FROM price_snapshots
            WHERE crypto = ? AND timestamp_ms > ?
                AND pyth_price IS NOT NULL
                AND coinbase_price IS NOT NULL
            LIMIT 5000
        `, [crypto, cutoffMs]);

        if (snapshots.length < 100) continue;

        // Calculate pairwise correlations
        const correlations = {};
        const sourcePairs = [
            ['pyth', 'binance'],
            ['pyth', 'coinbase'],
            ['coinbase', 'binance'],
            ['kraken', 'binance'],
            ['okx', 'binance'],
            ['coincap', 'binance']
        ];

        for (const [s1, s2] of sourcePairs) {
            const pairs = snapshots
                .filter(s => s[`${s1}_price`] && s[`${s2}_price`])
                .map(s => [s[`${s1}_price`], s[`${s2}_price`]]);

            if (pairs.length < 50) continue;

            // Calculate Pearson correlation
            const n = pairs.length;
            const sumX = pairs.reduce((a, p) => a + p[0], 0);
            const sumY = pairs.reduce((a, p) => a + p[1], 0);
            const sumXY = pairs.reduce((a, p) => a + p[0] * p[1], 0);
            const sumX2 = pairs.reduce((a, p) => a + p[0] * p[0], 0);
            const sumY2 = pairs.reduce((a, p) => a + p[1] * p[1], 0);

            const numerator = n * sumXY - sumX * sumY;
            const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

            const correlation = denominator !== 0 ? numerator / denominator : 0;
            correlations[`${s1}_vs_${s2}`] = correlation.toFixed(6);
        }

        results[crypto] = correlations;
    }

    return results;
}

/**
 * Print results as table
 */
function printTable(title, data, columns) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  ${title}`);
    console.log('='.repeat(80));

    if (!data || Object.keys(data).length === 0) {
        console.log('  No data available');
        return;
    }

    // Header
    const header = columns.map(c => c.label.padStart(c.width)).join(' | ');
    console.log(header);
    console.log('-'.repeat(80));

    // Rows
    for (const [key, row] of Object.entries(data)) {
        const values = columns.map(c => {
            let val = c.key === '_key' ? key : row[c.key];
            if (typeof val === 'number') {
                val = val.toFixed(c.decimals || 2);
            }
            return String(val || '-').padStart(c.width);
        });
        console.log(values.join(' | '));
    }
}

/**
 * Main analysis function
 */
async function main() {
    console.log('Price Source Analysis');
    console.log('=====================\n');
    console.log(`Analyzing last ${HOURS} hours of data`);
    if (CRYPTO) console.log(`Crypto filter: ${CRYPTO.toUpperCase()}`);

    // Initialize database
    initDatabase();

    const results = {
        timestamp: new Date().toISOString(),
        hours: HOURS,
        cryptos: CRYPTOS
    };

    // 1. Basic data stats
    console.log('\nFetching data stats...');
    const dataStats = await getDataStats();
    results.dataStats = dataStats;

    if (OUTPUT === 'table') {
        printTable('DATA COLLECTION STATS', Object.fromEntries(dataStats.map(r => [r.crypto, r])), [
            { key: '_key', label: 'Crypto', width: 8 },
            { key: 'snapshot_count', label: 'Snapshots', width: 12 },
            { key: 'window_count', label: 'Windows', width: 10 },
            { key: 'avg_source_count', label: 'Avg Sources', width: 12, decimals: 1 },
            { key: 'avg_spread_pct', label: 'Avg Spread %', width: 12, decimals: 4 }
        ]);
    }

    // 2. Availability stats
    console.log('\nFetching availability stats...');
    const availability = await getAvailabilityStats();
    results.availability = availability;

    if (OUTPUT === 'table') {
        for (const [crypto, data] of Object.entries(availability)) {
            console.log(`\n--- ${crypto.toUpperCase()} Source Availability (${data.total} snapshots) ---`);
            for (const [source, stats] of Object.entries(data.availability)) {
                const bar = '█'.repeat(Math.floor(parseFloat(stats.percentage) / 5));
                console.log(`  ${source.padEnd(12)} ${stats.percentage.padStart(6)}% ${bar}`);
            }
        }
    }

    // 3. Divergence analysis
    console.log('\nFetching divergence stats...');
    const divergence = await getDivergenceStats();
    results.divergence = divergence;

    if (OUTPUT === 'table') {
        for (const [crypto, sources] of Object.entries(divergence)) {
            console.log(`\n--- ${crypto.toUpperCase()} Divergence from Consensus ---`);
            console.log('  Source'.padEnd(14) + 'Samples'.padStart(10) + 'Avg %'.padStart(10) + 'P50 %'.padStart(10) + 'P95 %'.padStart(10) + 'Max %'.padStart(10));
            console.log('  ' + '-'.repeat(60));

            const sorted = Object.entries(sources)
                .filter(([_, s]) => s.samples > 0)
                .sort((a, b) => (a[1].avgDivergence || 999) - (b[1].avgDivergence || 999));

            for (const [source, stats] of sorted) {
                console.log(
                    `  ${source.padEnd(12)}` +
                    `${stats.samples}`.padStart(10) +
                    `${(stats.avgDivergence || 0).toFixed(4)}`.padStart(10) +
                    `${(stats.p50 || 0).toFixed(4)}`.padStart(10) +
                    `${(stats.p95 || 0).toFixed(4)}`.padStart(10) +
                    `${(stats.maxDivergence || 0).toFixed(4)}`.padStart(10)
                );
            }
        }
    }

    // 4. Staleness/latency analysis
    console.log('\nFetching latency stats...');
    const latency = await getLatencyAnalysis();
    results.latency = latency;

    if (OUTPUT === 'table' && Object.keys(latency).length > 0) {
        console.log('\n--- Staleness Analysis (seconds since source update) ---');
        for (const [crypto, sources] of Object.entries(latency)) {
            console.log(`\n  ${crypto.toUpperCase()}:`);
            for (const [source, stats] of Object.entries(sources)) {
                if (stats.count > 0) {
                    console.log(`    ${source.padEnd(12)} Avg: ${stats.avg?.toFixed(1) || '-'}s  P50: ${stats.p50 || '-'}s  P95: ${stats.p95 || '-'}s  Max: ${stats.max || '-'}s`);
                }
            }
        }
    }

    // 5. Correlation analysis
    console.log('\nFetching correlation stats...');
    const correlation = await getCorrelationAnalysis();
    results.correlation = correlation;

    if (OUTPUT === 'table' && Object.keys(correlation).length > 0) {
        console.log('\n--- Price Correlation (Pearson r) ---');
        for (const [crypto, pairs] of Object.entries(correlation)) {
            console.log(`\n  ${crypto.toUpperCase()}:`);
            for (const [pair, r] of Object.entries(pairs)) {
                const bar = '█'.repeat(Math.floor(Math.abs(parseFloat(r)) * 20));
                console.log(`    ${pair.padEnd(20)} ${r} ${bar}`);
            }
        }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('  SUMMARY');
    console.log('='.repeat(80));

    // Find best sources by lowest divergence
    const allDivergences = [];
    for (const [crypto, sources] of Object.entries(divergence)) {
        for (const [source, stats] of Object.entries(sources)) {
            if (stats.samples >= 100) {
                allDivergences.push({
                    crypto,
                    source,
                    avgDivergence: stats.avgDivergence,
                    samples: stats.samples
                });
            }
        }
    }

    if (allDivergences.length > 0) {
        allDivergences.sort((a, b) => a.avgDivergence - b.avgDivergence);
        console.log('\n  Most accurate sources (lowest avg divergence from consensus):');
        for (const item of allDivergences.slice(0, 5)) {
            console.log(`    ${item.source.padEnd(12)} ${item.crypto.toUpperCase()} - ${item.avgDivergence.toFixed(4)}% avg divergence (${item.samples} samples)`);
        }
    }

    // Export if requested
    if (EXPORT_FILE) {
        fs.writeFileSync(EXPORT_FILE, JSON.stringify(results, null, 2));
        console.log(`\nResults exported to: ${EXPORT_FILE}`);
    }

    console.log('\n✅ Analysis complete');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
