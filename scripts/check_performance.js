#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

async function main() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL - cannot connect to production database');
        return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        const perf = await pool.query(`
            SELECT
                strategy_name,
                COUNT(*) FILTER (WHERE type = 'entry') as entries,
                COUNT(*) FILTER (WHERE type = 'exit') as exits,
                SUM(CASE WHEN type = 'exit' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN type = 'exit' AND pnl < 0 THEN 1 ELSE 0 END) as losses,
                ROUND(SUM(CASE WHEN type = 'exit' THEN pnl ELSE 0 END)::numeric, 4) as total_pnl
            FROM live_trades
            WHERE timestamp > NOW() - INTERVAL '24 hours'
            GROUP BY strategy_name
            ORDER BY total_pnl DESC
        `);

        console.log('\n=== LAST 24 HOURS PERFORMANCE ===\n');
        console.log('Strategy                  | Entries | W/L    | PnL');
        console.log('-'.repeat(60));
        for (const row of perf.rows) {
            const name = (row.strategy_name || 'unknown').padEnd(24);
            const entries = String(row.entries).padStart(4);
            const wl = (row.wins || 0) + '/' + (row.losses || 0);
            const pnl = (row.total_pnl >= 0 ? '+' : '') + Number(row.total_pnl || 0).toFixed(2);
            console.log(name + ' | ' + entries + '   | ' + wl.padStart(6) + ' | $' + pnl);
        }

        const recent = await pool.query(`
            SELECT strategy_name, crypto, side, type, price, pnl, time_remaining, timestamp
            FROM live_trades
            WHERE timestamp > NOW() - INTERVAL '6 hours'
            ORDER BY timestamp DESC
            LIMIT 30
        `);

        console.log('\n=== RECENT TRADES (last 6 hours) ===\n');
        for (const t of recent.rows) {
            const time = new Date(t.timestamp).toLocaleTimeString();
            const pnlStr = t.pnl ? (t.pnl > 0 ? '+' : '') + (t.pnl * 100).toFixed(0) + 'c' : '';
            console.log(time + ' | ' + (t.strategy_name || '').padEnd(20) + ' | ' + t.crypto + ' ' + t.side + ' ' + t.type + ' @ ' + (t.price*100).toFixed(0) + 'c | ' + pnlStr);
        }

        const allTime = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE type = 'entry') as total_entries,
                SUM(CASE WHEN type = 'exit' AND pnl > 0 THEN 1 ELSE 0 END) as total_wins,
                SUM(CASE WHEN type = 'exit' AND pnl < 0 THEN 1 ELSE 0 END) as total_losses,
                ROUND(SUM(CASE WHEN type = 'exit' THEN pnl ELSE 0 END)::numeric, 2) as all_time_pnl
            FROM live_trades
        `);

        if (allTime.rows[0]) {
            const a = allTime.rows[0];
            console.log('\n=== ALL TIME ===\n');
            console.log('Total Entries: ' + a.total_entries);
            console.log('Win/Loss: ' + a.total_wins + '/' + a.total_losses);
            console.log('Total PnL: $' + a.all_time_pnl);
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
}

main();
