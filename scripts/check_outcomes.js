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
        // Check outcome distribution
        const outcomes = await pool.query(`
            SELECT outcome, COUNT(*) as cnt
            FROM windows
            WHERE outcome IS NOT NULL
            GROUP BY outcome
        `);
        console.log('Outcome Distribution:');
        console.table(outcomes.rows);

        // Check recent windows
        const recent = await pool.query(`
            SELECT crypto, epoch, outcome, start_price, end_price
            FROM windows
            WHERE outcome IS NOT NULL
            ORDER BY epoch DESC
            LIMIT 20
        `);
        console.log('\nRecent 20 windows:');
        console.table(recent.rows);

        // Check if up_mid changes during windows
        console.log('\n=== Market Price Movement Check ===');
        const sampleWindow = await pool.query(`
            SELECT DISTINCT ON (crypto) crypto, epoch
            FROM windows
            WHERE outcome IS NOT NULL
            ORDER BY crypto, epoch DESC
        `);

        for (const w of sampleWindow.rows) {
            const ticks = await pool.query(`
                SELECT MIN(up_mid) as min_up, MAX(up_mid) as max_up,
                       AVG(up_mid) as avg_up,
                       COUNT(DISTINCT ROUND(up_mid::numeric, 2)) as distinct_prices
                FROM ticks
                WHERE crypto = $1 AND window_epoch = $2
            `, [w.crypto, w.epoch]);

            const t = ticks.rows[0];
            console.log(`${w.crypto.toUpperCase()}: up_mid range ${t.min_up?.toFixed(3)} - ${t.max_up?.toFixed(3)}, ` +
                        `${t.distinct_prices} distinct values`);
        }

        // Check a window where outcome is DOWN (if any)
        const downWindow = await pool.query(`
            SELECT crypto, epoch FROM windows WHERE outcome = 'down' LIMIT 1
        `);
        if (downWindow.rows[0]) {
            console.log('\n=== Found DOWN outcome ===');
            const dw = downWindow.rows[0];
            console.log(`${dw.crypto} epoch=${dw.epoch}`);

            const tickCheck = await pool.query(`
                SELECT time_remaining_sec, spot_price, up_mid
                FROM ticks
                WHERE crypto = $1 AND window_epoch = $2
                ORDER BY time_remaining_sec DESC
                LIMIT 5
            `, [dw.crypto, dw.epoch]);
            console.log('Sample ticks:');
            console.table(tickCheck.rows);
        } else {
            console.log('\n⚠️ No DOWN outcomes found in database!');
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
