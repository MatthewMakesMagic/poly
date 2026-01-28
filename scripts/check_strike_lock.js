#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

async function check() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Get the most recent windows
        const recentRes = await pool.query(`
            SELECT crypto, window_epoch,
                   COUNT(*) as tick_count,
                   COUNT(DISTINCT ROUND(price_to_beat::numeric, 2)) as unique_strikes,
                   MIN(price_to_beat) as min_strike,
                   MAX(price_to_beat) as max_strike
            FROM ticks
            WHERE window_epoch > (SELECT MAX(window_epoch) - 3600 FROM ticks)
            GROUP BY crypto, window_epoch
            ORDER BY window_epoch DESC, crypto
            LIMIT 12
        `);

        console.log('=== RECENT WINDOWS (Last hour) ===');
        console.log('Crypto | Epoch      | Ticks | Unique Strikes | Strike Range');
        console.log('-'.repeat(70));

        let allLocked = true;
        for (const r of recentRes.rows) {
            const strikeDiff = (r.max_strike - r.min_strike).toFixed(2);
            const isLocked = r.unique_strikes <= 2;  // Allow 2 for rounding
            const status = isLocked ? '✅' : '❌';
            if (!isLocked) allLocked = false;
            console.log(`${r.crypto.padEnd(6)} | ${r.window_epoch} | ${String(r.tick_count).padStart(5)} | ${String(r.unique_strikes).padStart(14)} | $${r.min_strike?.toFixed(2)} - $${r.max_strike?.toFixed(2)} ${status}`);
        }

        console.log('\n' + (allLocked ? '✅ All recent windows have locked strike prices!' : '❌ Some windows have changing strike prices!'));

        // Also check OLDER windows to compare
        console.log('\n=== OLDER WINDOWS (For comparison) ===');
        const oldRes = await pool.query(`
            SELECT crypto, window_epoch,
                   COUNT(*) as tick_count,
                   COUNT(DISTINCT ROUND(price_to_beat::numeric, 2)) as unique_strikes,
                   MIN(price_to_beat) as min_strike,
                   MAX(price_to_beat) as max_strike
            FROM ticks
            WHERE window_epoch < (SELECT MAX(window_epoch) - 86400 FROM ticks)
            GROUP BY crypto, window_epoch
            ORDER BY window_epoch DESC, crypto
            LIMIT 8
        `);

        console.log('Crypto | Epoch      | Ticks | Unique Strikes | Strike Range');
        console.log('-'.repeat(70));

        for (const r of oldRes.rows) {
            const isLocked = r.unique_strikes <= 2;
            const status = isLocked ? '✅' : '❌';
            console.log(`${r.crypto.padEnd(6)} | ${r.window_epoch} | ${String(r.tick_count).padStart(5)} | ${String(r.unique_strikes).padStart(14)} | $${r.min_strike?.toFixed(2)} - $${r.max_strike?.toFixed(2)} ${status}`);
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

check();
