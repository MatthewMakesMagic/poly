#!/usr/bin/env node

/**
 * Multi-Source Price Feed Collector
 *
 * Connects to multiple price sources (Pyth, Coinbase, Kraken, OKX, CoinCap, etc.)
 * and records prices for historical analysis and comparison.
 *
 * Usage:
 *   node scripts/start_multi_source_collector.js
 *
 * Options:
 *   --dry-run    Run without saving to database
 *   --verbose    Show all price updates
 *   --duration   Run for specified minutes (default: infinite)
 */

import { getMultiSourcePriceCollector, MULTI_SOURCE_CONFIG } from '../src/collectors/multi_source_prices.js';
import { initDatabase, getDatabase, USE_POSTGRES, ensurePool } from '../src/db/connection.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const DURATION_INDEX = args.indexOf('--duration');
const DURATION_MINUTES = DURATION_INDEX !== -1 ? parseInt(args[DURATION_INDEX + 1]) : null;

// Stats
const stats = {
    startTime: Date.now(),
    snapshotsRecorded: 0,
    snapshotsFailed: 0,
    lastSnapshot: null
};

// Buffer for batch inserts
let snapshotBuffer = [];
const BUFFER_FLUSH_INTERVAL = 5000; // 5 seconds
const BUFFER_MAX_SIZE = 100;

/**
 * Initialize database schema for price comparisons
 */
async function initSchema() {
    const schemaPath = path.join(__dirname, '../src/db/price_comparison_schema.sql');

    if (!fs.existsSync(schemaPath)) {
        console.error('Schema file not found:', schemaPath);
        return false;
    }

    const schema = fs.readFileSync(schemaPath, 'utf8');

    try {
        if (USE_POSTGRES) {
            const pool = ensurePool();
            // PostgreSQL: execute each statement
            const statements = schema
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('CREATE VIEW'));

            for (const stmt of statements) {
                try {
                    // Convert SQLite syntax to PostgreSQL
                    let pgStmt = stmt
                        .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
                        .replace(/TEXT DEFAULT CURRENT_TIMESTAMP/g, 'TIMESTAMP DEFAULT NOW()');

                    await pool.query(pgStmt);
                } catch (err) {
                    // Ignore "already exists" errors
                    if (!err.message.includes('already exists')) {
                        console.error('Schema error:', err.message);
                    }
                }
            }
        } else {
            const db = getDatabase();
            db.exec(schema);
        }

        console.log('Database schema initialized');
        return true;
    } catch (error) {
        console.error('Failed to initialize schema:', error.message);
        return false;
    }
}

/**
 * Calculate window epoch from timestamp
 */
function getWindowEpoch(timestampMs) {
    const windowDurationMs = 15 * 60 * 1000; // 15 minutes
    return Math.floor(timestampMs / windowDurationMs);
}

/**
 * Insert price snapshot into database
 */
async function insertSnapshot(snapshot) {
    const { timestamp, cryptos } = snapshot;

    for (const [crypto, sources] of Object.entries(cryptos)) {
        const record = {
            timestamp_ms: timestamp,
            crypto,
            window_epoch: getWindowEpoch(timestamp),
            pyth_price: sources.pyth?.price || null,
            pyth_staleness: sources.pyth?.staleness || null,
            redstone_price: sources.redstone?.price || null,
            redstone_staleness: sources.redstone?.staleness || null,
            coinbase_price: sources.coinbase?.price || null,
            kraken_price: sources.kraken?.price || null,
            okx_price: sources.okx?.price || null,
            coincap_price: sources.coincap?.price || null,
            coingecko_price: sources.coingecko?.price || null
        };

        // Calculate consensus (median)
        const prices = Object.values(sources)
            .map(s => s?.price)
            .filter(p => p && p > 0)
            .sort((a, b) => a - b);

        if (prices.length > 0) {
            const mid = Math.floor(prices.length / 2);
            record.consensus_price = prices.length % 2 !== 0
                ? prices[mid]
                : (prices[mid - 1] + prices[mid]) / 2;
            record.source_count = prices.length;
            record.price_spread = prices[prices.length - 1] - prices[0];
            record.price_spread_pct = (record.price_spread / record.consensus_price) * 100;
        }

        snapshotBuffer.push(record);
    }
}

/**
 * Flush snapshot buffer to database
 */
async function flushBuffer() {
    if (snapshotBuffer.length === 0) return;

    const toInsert = [...snapshotBuffer];
    snapshotBuffer = [];

    if (DRY_RUN) {
        stats.snapshotsRecorded += toInsert.length;
        return;
    }

    try {
        if (USE_POSTGRES) {
            const pool = ensurePool();
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                for (const record of toInsert) {
                    await client.query(`
                        INSERT INTO price_snapshots (
                            timestamp_ms, crypto, window_epoch,
                            pyth_price, pyth_staleness,
                            redstone_price, redstone_staleness,
                            coinbase_price, kraken_price, okx_price,
                            coincap_price, coingecko_price,
                            consensus_price, source_count, price_spread, price_spread_pct
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                    `, [
                        record.timestamp_ms, record.crypto, record.window_epoch,
                        record.pyth_price, record.pyth_staleness,
                        record.redstone_price, record.redstone_staleness,
                        record.coinbase_price, record.kraken_price, record.okx_price,
                        record.coincap_price, record.coingecko_price,
                        record.consensus_price, record.source_count,
                        record.price_spread, record.price_spread_pct
                    ]);
                }

                await client.query('COMMIT');
                stats.snapshotsRecorded += toInsert.length;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } else {
            const db = getDatabase();
            const stmt = db.prepare(`
                INSERT INTO price_snapshots (
                    timestamp_ms, crypto, window_epoch,
                    pyth_price, pyth_staleness,
                    redstone_price, redstone_staleness,
                    coinbase_price, kraken_price, okx_price,
                    coincap_price, coingecko_price,
                    consensus_price, source_count, price_spread, price_spread_pct
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertMany = db.transaction((records) => {
                for (const record of records) {
                    stmt.run(
                        record.timestamp_ms, record.crypto, record.window_epoch,
                        record.pyth_price, record.pyth_staleness,
                        record.redstone_price, record.redstone_staleness,
                        record.coinbase_price, record.kraken_price, record.okx_price,
                        record.coincap_price, record.coingecko_price,
                        record.consensus_price, record.source_count,
                        record.price_spread, record.price_spread_pct
                    );
                }
            });

            insertMany(toInsert);
            stats.snapshotsRecorded += toInsert.length;
        }
    } catch (error) {
        stats.snapshotsFailed += toInsert.length;
        console.error('Failed to insert snapshots:', error.message);
    }
}

/**
 * Format price for display
 */
function formatPrice(price) {
    if (!price) return '---'.padStart(12);
    return price.toFixed(2).padStart(12);
}

/**
 * Display current prices
 */
function displayPrices(snapshot) {
    const { cryptos } = snapshot;

    console.clear();
    console.log('='.repeat(100));
    console.log('MULTI-SOURCE PRICE COLLECTOR'.padStart(55));
    console.log('='.repeat(100));
    console.log();

    // Header
    const sources = ['pyth', 'coinbase', 'kraken', 'okx', 'coincap', 'coingecko', 'redstone'];
    console.log(
        'Crypto'.padEnd(8) +
        sources.map(s => s.toUpperCase().padStart(12)).join(' ') +
        'SPREAD %'.padStart(12)
    );
    console.log('-'.repeat(100));

    // Price rows
    for (const crypto of MULTI_SOURCE_CONFIG.CRYPTOS) {
        const data = cryptos[crypto] || {};

        const prices = sources.map(s => formatPrice(data[s]?.price)).join(' ');

        // Calculate spread
        const priceValues = sources
            .map(s => data[s]?.price)
            .filter(p => p && p > 0);

        let spreadPct = '---';
        if (priceValues.length >= 2) {
            const min = Math.min(...priceValues);
            const max = Math.max(...priceValues);
            const median = priceValues.sort((a, b) => a - b)[Math.floor(priceValues.length / 2)];
            spreadPct = (((max - min) / median) * 100).toFixed(4) + '%';
        }

        console.log(
            crypto.toUpperCase().padEnd(8) +
            prices +
            spreadPct.padStart(12)
        );
    }

    console.log();
    console.log('-'.repeat(100));

    // Stats
    const uptimeMs = Date.now() - stats.startTime;
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const uptimeSec = Math.floor((uptimeMs % 60000) / 1000);

    console.log(`Uptime: ${uptimeMin}m ${uptimeSec}s | Snapshots: ${stats.snapshotsRecorded} | Failed: ${stats.snapshotsFailed} | Buffer: ${snapshotBuffer.length}`);

    if (DURATION_MINUTES) {
        const remaining = DURATION_MINUTES - uptimeMin;
        console.log(`Remaining: ${remaining} minutes`);
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN MODE - Not saving to database');
    }
}

/**
 * Main entry point
 */
async function main() {
    console.log('Multi-Source Price Feed Collector');
    console.log('=================================\n');

    if (DRY_RUN) {
        console.log('🔸 Running in DRY RUN mode (no database writes)\n');
    }

    // Initialize database
    if (!DRY_RUN) {
        try {
            initDatabase();
            await initSchema();
        } catch (error) {
            console.error('Database initialization failed:', error.message);
            console.log('Continuing in dry-run mode...\n');
        }
    }

    // Initialize collector
    const collector = await getMultiSourcePriceCollector();

    // Start polling
    collector.startPolling();

    // Handle price updates
    collector.on('prices', async (snapshot) => {
        stats.lastSnapshot = snapshot;

        // Insert into database
        await insertSnapshot(snapshot);

        // Display prices
        if (!VERBOSE) {
            displayPrices(snapshot);
        } else {
            console.log(JSON.stringify(snapshot, null, 2));
        }
    });

    // Flush buffer periodically
    const flushInterval = setInterval(flushBuffer, BUFFER_FLUSH_INTERVAL);

    // Handle duration limit
    if (DURATION_MINUTES) {
        setTimeout(async () => {
            console.log('\n\nDuration limit reached. Stopping...');
            await shutdown(collector, flushInterval);
        }, DURATION_MINUTES * 60 * 1000);
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\nReceived SIGINT. Shutting down...');
        await shutdown(collector, flushInterval);
    });

    process.on('SIGTERM', async () => {
        console.log('\n\nReceived SIGTERM. Shutting down...');
        await shutdown(collector, flushInterval);
    });

    console.log('\nCollector running. Press Ctrl+C to stop.\n');
}

async function shutdown(collector, flushInterval) {
    clearInterval(flushInterval);

    // Flush remaining buffer
    await flushBuffer();

    // Stop collector
    collector.stop();

    // Print final stats
    console.log('\n=== Final Stats ===');
    console.log(`Total snapshots recorded: ${stats.snapshotsRecorded}`);
    console.log(`Failed inserts: ${stats.snapshotsFailed}`);
    console.log(`Runtime: ${Math.floor((Date.now() - stats.startTime) / 1000)} seconds`);

    const collectorStats = collector.getStats();
    console.log('\nSource stats:');
    for (const [name, sourceStats] of Object.entries(collectorStats.sources)) {
        console.log(`  ${name}: ${sourceStats.disabled ? '❌ Disabled' : '✅ Active'} | Errors: ${sourceStats.errors}`);
    }

    process.exit(0);
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
