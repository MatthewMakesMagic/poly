#!/usr/bin/env node
/**
 * Debug backtest - investigate BS calculation issues
 */

import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

function normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1.0 + sign * y);
}

const CRYPTO_VOLATILITY = { btc: 0.50, eth: 0.65, sol: 0.85, xrp: 0.75, default: 0.70 };

function calculateExpectedProbability(spotDeltaPct, timeRemainingSec, crypto = 'btc') {
    const sigma = CRYPTO_VOLATILITY[crypto?.toLowerCase()] || CRYPTO_VOLATILITY.default;
    const spotRatio = 1 + (spotDeltaPct / 100);
    const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
    const T = Math.max(timeRemainingSec, 1) / SECONDS_PER_YEAR;
    const sqrtT = Math.sqrt(T);
    const d2 = Math.log(spotRatio) / (sigma * sqrtT);
    return normalCDF(d2);
}

async function main() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Get a sample window with ticks
        const windowRes = await pool.query(`
            SELECT w.*,
                   (SELECT COUNT(*) FROM ticks t WHERE t.crypto = w.crypto AND t.window_epoch = w.epoch) as tick_count
            FROM windows w
            WHERE w.outcome IS NOT NULL
            ORDER BY w.epoch DESC
            LIMIT 10
        `);

        console.log('Sample Windows:');
        for (const w of windowRes.rows) {
            console.log(`  ${w.crypto} epoch=${w.epoch} outcome=${w.outcome} ticks=${w.tick_count}`);
        }

        // Get ticks for first window with enough data
        const window = windowRes.rows.find(w => w.tick_count > 20);
        if (!window) {
            console.log('No window with enough ticks');
            return;
        }

        console.log(`\nAnalyzing: ${window.crypto} epoch=${window.epoch}`);

        const ticksRes = await pool.query(`
            SELECT * FROM ticks
            WHERE crypto = $1 AND window_epoch = $2
            ORDER BY timestamp_ms ASC
            LIMIT 50
        `, [window.crypto, window.epoch]);

        console.log(`\nSample Ticks (first 10):`);
        console.log('time_rem | spot_price    | price_to_beat | spot_delta% | up_mid | BS_prob');
        console.log('─'.repeat(80));

        for (const tick of ticksRes.rows.slice(0, 10)) {
            const timeRem = tick.time_remaining_sec?.toFixed(0) || '?';
            const spot = tick.spot_price?.toFixed(2) || '?';
            const strike = tick.price_to_beat?.toFixed(2) || '?';
            const upMid = tick.up_mid?.toFixed(3) || '?';

            let spotDeltaPct = 0;
            if (tick.price_to_beat && tick.price_to_beat > 0) {
                spotDeltaPct = ((tick.spot_price - tick.price_to_beat) / tick.price_to_beat) * 100;
            }

            const bsProb = calculateExpectedProbability(spotDeltaPct, tick.time_remaining_sec || 300, window.crypto);

            console.log(
                `${timeRem.padStart(7)}s | $${spot.padStart(10)} | $${strike.padStart(10)} | ${spotDeltaPct.toFixed(4).padStart(9)}% | ${upMid.padStart(5)} | ${(bsProb * 100).toFixed(1)}%`
            );
        }

        // Check if price_to_beat is populated
        const nullStrikeCount = await pool.query(`
            SELECT COUNT(*) as cnt FROM ticks
            WHERE crypto = $1 AND window_epoch = $2 AND (price_to_beat IS NULL OR price_to_beat = 0)
        `, [window.crypto, window.epoch]);

        console.log(`\nTicks with NULL/0 price_to_beat: ${nullStrikeCount.rows[0].cnt}`);

        // Check what EndGame would need
        console.log('\n--- Endgame Check ---');
        const endgameTicks = ticksRes.rows.filter(t =>
            t.time_remaining_sec <= 60 &&
            t.time_remaining_sec >= 5 &&
            t.up_mid &&
            (t.up_mid > 0.9 || t.up_mid < 0.1)
        );
        console.log(`Ticks in endgame zone (90%+ or 10%-, 5-60s left): ${endgameTicks.length}`);
        for (const t of endgameTicks.slice(0, 5)) {
            console.log(`  t=${t.time_remaining_sec?.toFixed(0)}s up_mid=${(t.up_mid * 100).toFixed(1)}%`);
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
