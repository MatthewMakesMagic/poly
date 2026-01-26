#!/usr/bin/env node
/**
 * Migration: Add multi-source price columns to ticks table
 *
 * Run this script to add the new columns if you have an existing PostgreSQL database.
 * This is idempotent - safe to run multiple times.
 */

import pg from 'pg';

async function migrate() {
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
        console.log('No DATABASE_URL set - nothing to migrate (SQLite auto-creates columns)');
        return;
    }

    console.log('Connecting to PostgreSQL...');
    const pool = new pg.Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        // Add multi-source price columns
        const columns = [
            { name: 'pyth_price', type: 'REAL' },
            { name: 'pyth_staleness', type: 'INTEGER' },
            { name: 'coinbase_price', type: 'REAL' },
            { name: 'kraken_price', type: 'REAL' },
            { name: 'okx_price', type: 'REAL' },
            { name: 'coincap_price', type: 'REAL' },
            { name: 'coingecko_price', type: 'REAL' },
            { name: 'redstone_price', type: 'REAL' },
            { name: 'consensus_price', type: 'REAL' },
            { name: 'source_count', type: 'INTEGER' },
            { name: 'price_spread_pct', type: 'REAL' }
        ];

        console.log('\nAdding multi-source price columns to ticks table...\n');

        for (const col of columns) {
            try {
                await pool.query(`ALTER TABLE ticks ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
                console.log(`  ✅ ${col.name} (${col.type})`);
            } catch (error) {
                if (error.message.includes('already exists')) {
                    console.log(`  ⏭️  ${col.name} already exists`);
                } else {
                    console.error(`  ❌ ${col.name}: ${error.message}`);
                }
            }
        }

        console.log('\n✅ Migration complete!');
        console.log('\nYou can now start the tick collector to begin collecting multi-source price data.');

    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();
