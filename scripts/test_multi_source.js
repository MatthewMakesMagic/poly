#!/usr/bin/env node

/**
 * Quick test for Multi-Source Price Collector
 * Runs for 30 seconds and displays prices from all sources
 */

import { getMultiSourcePriceCollector } from '../src/collectors/multi_source_prices.js';

async function main() {
    console.log('Testing Multi-Source Price Collector');
    console.log('====================================\n');

    const collector = await getMultiSourcePriceCollector();

    // Start polling
    collector.startPolling();

    let tickCount = 0;
    const maxTicks = 30;

    collector.on('prices', (snapshot) => {
        tickCount++;

        console.clear();
        console.log(`Tick ${tickCount}/${maxTicks}`);
        console.log('='.repeat(60));
        console.log();

        for (const [crypto, sources] of Object.entries(snapshot.cryptos)) {
            console.log(`${crypto.toUpperCase()}:`);

            const sourceNames = Object.keys(sources).sort();
            for (const name of sourceNames) {
                const data = sources[name];
                if (data?.price) {
                    const staleness = data.staleness !== undefined ? `(${data.staleness}s ago)` : '';
                    console.log(`  ${name.padEnd(12)} $${data.price.toFixed(2).padStart(12)} ${staleness}`);
                }
            }

            // Show consensus
            const consensus = collector.getConsensusPrice(crypto);
            if (consensus) {
                console.log(`  ${'CONSENSUS'.padEnd(12)} $${consensus.price.toFixed(2).padStart(12)} (${consensus.sourceCount} sources, ${consensus.spreadPct.toFixed(4)}% spread)`);
            }

            console.log();
        }

        // Show stats
        const stats = collector.getStats();
        console.log('-'.repeat(60));
        console.log('Source Status:');
        for (const [name, sourceStats] of Object.entries(stats.sources)) {
            const status = sourceStats.disabled ? '❌' : (sourceStats.connected !== false ? '✅' : '⚠️');
            console.log(`  ${status} ${name.padEnd(12)} errors: ${sourceStats.errors}`);
        }

        if (tickCount >= maxTicks) {
            console.log('\n\nTest complete!');
            collector.stop();
            process.exit(0);
        }
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        console.log('\n\nStopping...');
        collector.stop();
        process.exit(0);
    });

    console.log('Waiting for price data...\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
