require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function analyze() {
    const r = await pool.query(`
        SELECT id, timestamp_et, type, crypto, side, price, pnl, reason, spot_price, price_to_beat, bs_prob, edge_at_entry
        FROM live_trades
        WHERE crypto = 'btc'
        AND timestamp > NOW() - INTERVAL '3 hours'
        ORDER BY timestamp DESC
        LIMIT 30
    `);

    console.log('BTC TRADES (last 3 hours):');
    console.log('');
    let wins = 0, losses = 0, totalPnl = 0;

    for (const t of r.rows) {
        const pnlStr = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + '$' + t.pnl?.toFixed(2) : '';
        const spotVsStrike = t.spot_price && t.price_to_beat ? (t.spot_price > t.price_to_beat ? 'ABOVE' : 'BELOW') : '';

        console.log(t.timestamp_et + ' | ' + t.type?.toUpperCase() + ' | ' + t.side?.toUpperCase() + ' @ $' + (t.price?.toFixed(3) || 'N/A') + ' | ' + pnlStr + ' | ' + (t.reason || ''));

        if (t.type === 'entry') {
            console.log('   Spot: $' + (t.spot_price?.toFixed(2) || 'N/A') + ' | Strike: $' + (t.price_to_beat?.toFixed(2) || 'N/A') + ' | Spot is ' + spotVsStrike + ' strike');
            console.log('   BS Prob: ' + (t.bs_prob ? (t.bs_prob * 100).toFixed(1) + '%' : 'N/A') + ' | Edge: ' + (t.edge_at_entry ? (t.edge_at_entry * 100).toFixed(1) + '%' : 'N/A'));
        }

        if (t.pnl !== null) {
            totalPnl += t.pnl;
            if (t.pnl >= 0) wins++; else losses++;
        }
    }

    console.log('');
    console.log('SUMMARY: ' + wins + ' wins, ' + losses + ' losses, Total P&L: $' + totalPnl.toFixed(2));

    await pool.end();
}

analyze().catch(e => { console.error(e); pool.end(); });
