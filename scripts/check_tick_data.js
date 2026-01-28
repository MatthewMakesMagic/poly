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
        // Get ticks at different times in the window
        const res = await pool.query(`
            SELECT time_remaining_sec, spot_price, price_to_beat, up_mid,
                   spot_price - price_to_beat as spot_diff
            FROM ticks
            WHERE crypto = 'btc' AND window_epoch = 1769158800
            ORDER BY time_remaining_sec DESC
        `);

        console.log('BTC Window Analysis (epoch=1769158800):');
        console.log('Total ticks:', res.rows.length);
        console.log('\ntime_rem | spot        | strike      | diff       | up_mid');
        console.log('-'.repeat(70));

        // Sample at different times (every ~100 ticks)
        const step = Math.floor(res.rows.length / 10);
        for (let i = 0; i < res.rows.length; i += step) {
            const t = res.rows[i];
            if (!t) continue;
            const tr = t.time_remaining_sec?.toFixed(0)?.padStart(7) || '?';
            const sp = t.spot_price?.toFixed(2)?.padStart(10) || '?';
            const st = t.price_to_beat?.toFixed(2)?.padStart(10) || '?';
            const diff = t.spot_diff?.toFixed(2)?.padStart(9) || '?';
            const um = (t.up_mid * 100)?.toFixed(1)?.padStart(5) || '?';
            console.log(tr + 's | $' + sp + ' | $' + st + ' | $' + diff + ' | ' + um + '%');
        }

        // Check distinct values
        const distinct = await pool.query(`
            SELECT COUNT(DISTINCT spot_price) as spot_cnt,
                   COUNT(DISTINCT price_to_beat) as strike_cnt,
                   MIN(spot_price) as min_spot, MAX(spot_price) as max_spot,
                   MIN(price_to_beat) as min_strike, MAX(price_to_beat) as max_strike,
                   MIN(up_mid) as min_up, MAX(up_mid) as max_up
            FROM ticks
            WHERE crypto = 'btc' AND window_epoch = 1769158800
        `);
        console.log('\nDistinct value analysis:');
        const d = distinct.rows[0];
        console.log('  Spot prices:', d.spot_cnt, 'distinct (range:', d.min_spot, '-', d.max_spot, ')');
        console.log('  Strike prices:', d.strike_cnt, 'distinct (range:', d.min_strike, '-', d.max_strike, ')');
        console.log('  Up_mid:', d.min_up?.toFixed(3), '-', d.max_up?.toFixed(3));

        // Calculate actual spot deltas
        console.log('\n--- Spot Delta Analysis ---');
        const spotDeltas = res.rows.map(t => {
            if (t.price_to_beat && t.price_to_beat > 0) {
                return ((t.spot_price - t.price_to_beat) / t.price_to_beat) * 100;
            }
            return 0;
        });
        const nonZeroDeltas = spotDeltas.filter(d => Math.abs(d) > 0.001);
        console.log('Non-zero spot deltas:', nonZeroDeltas.length, '/', spotDeltas.length);
        if (nonZeroDeltas.length > 0) {
            console.log('  Min:', Math.min(...nonZeroDeltas).toFixed(4) + '%');
            console.log('  Max:', Math.max(...nonZeroDeltas).toFixed(4) + '%');
        }

        // Check if strike is static (as it should be)
        const strikes = [...new Set(res.rows.map(t => t.price_to_beat?.toFixed(4)))];
        console.log('\nUnique strike values:', strikes.length);
        if (strikes.length <= 5) {
            console.log('  Values:', strikes.join(', '));
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
