#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

async function main() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL - cannot check production data');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        // Check ticks
        const tickRes = await pool.query('SELECT COUNT(*) as count FROM ticks');
        console.log('Ticks in Supabase:', tickRes.rows[0].count);

        // Check windows
        const winRes = await pool.query('SELECT COUNT(*) as count FROM windows WHERE outcome IS NOT NULL');
        console.log('Resolved windows:', winRes.rows[0].count);

        // Check live_trades
        const tradeRes = await pool.query('SELECT COUNT(*) as count FROM live_trades');
        console.log('Live trades:', tradeRes.rows[0].count);

        // Sample windows with ticks
        const sampleWin = await pool.query(`
            SELECT w.crypto, w.epoch, w.outcome,
                   w.opening_up_price, w.closing_up_price,
                   (SELECT COUNT(*) FROM ticks t WHERE t.crypto = w.crypto AND t.window_epoch = w.epoch) as tick_count
            FROM windows w
            WHERE w.outcome IS NOT NULL
            ORDER BY w.epoch DESC
            LIMIT 20
        `);
        console.log('\nRecent resolved windows with tick counts:');
        console.table(sampleWin.rows);

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
