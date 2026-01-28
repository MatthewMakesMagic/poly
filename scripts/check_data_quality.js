#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

async function main() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Check multiple windows for the same pattern
        console.log('=== DATA QUALITY CHECK ===\n');

        const windows = await pool.query(`
            SELECT DISTINCT w.crypto, w.epoch, w.outcome
            FROM windows w
            WHERE w.outcome IS NOT NULL
            ORDER BY w.epoch DESC
            LIMIT 8
        `);

        for (const w of windows.rows) {
            const ticks = await pool.query(`
                SELECT time_remaining_sec, spot_price, price_to_beat, up_mid, up_bid, up_ask
                FROM ticks
                WHERE crypto = $1 AND window_epoch = $2
                ORDER BY time_remaining_sec DESC
            `, [w.crypto, w.epoch]);

            const first = ticks.rows[0];
            const last = ticks.rows[ticks.rows.length - 1];

            console.log(`${w.crypto.toUpperCase()} epoch=${w.epoch} outcome=${w.outcome}`);
            console.log(`  Ticks: ${ticks.rows.length}`);
            console.log(`  First tick (t=${first?.time_remaining_sec?.toFixed(0)}s): spot=$${first?.spot_price}, strike=$${first?.price_to_beat}`);
            console.log(`  Last tick  (t=${last?.time_remaining_sec?.toFixed(0)}s):  spot=$${last?.spot_price}, strike=$${last?.price_to_beat}`);

            // Check if strike changes
            const strikes = [...new Set(ticks.rows.map(t => t.price_to_beat?.toFixed(2)))];
            console.log(`  Unique strikes: ${strikes.length} (should be 1)`);

            // Check if up_mid changes
            const upMids = [...new Set(ticks.rows.map(t => t.up_mid?.toFixed(3)))];
            console.log(`  Unique up_mid: ${upMids.length} (first=${first?.up_mid?.toFixed(3)}, last=${last?.up_mid?.toFixed(3)})`);

            // Calculate what spot delta SHOULD be using first tick's strike
            const realStrike = first?.spot_price; // First spot price as proxy for strike
            const lastSpot = last?.spot_price;
            const realDelta = realStrike > 0 ? ((lastSpot - realStrike) / realStrike) * 100 : 0;
            console.log(`  Real spot delta (first->last): ${realDelta.toFixed(4)}%`);
            console.log('');
        }

        // Check if there's a separate strike/price_to_beat in windows table
        console.log('\n=== WINDOWS TABLE STRUCTURE ===');
        const windowCols = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'windows'
            ORDER BY ordinal_position
        `);
        console.log('Windows table columns:');
        for (const col of windowCols.rows) {
            console.log(`  ${col.column_name}: ${col.data_type}`);
        }

        // Check sample window data
        const sampleWindow = await pool.query(`
            SELECT * FROM windows WHERE epoch = 1769158800 AND crypto = 'btc' LIMIT 1
        `);
        if (sampleWindow.rows[0]) {
            console.log('\nSample window data (BTC 1769158800):');
            for (const [key, val] of Object.entries(sampleWindow.rows[0])) {
                console.log(`  ${key}: ${val}`);
            }
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
