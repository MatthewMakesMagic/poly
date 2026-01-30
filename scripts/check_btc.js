require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
    const r = await pool.query(`
        SELECT id, timestamp_et, strategy_name, type, side, price, size, shares,
               spot_price, price_to_beat, pnl, reason
        FROM live_trades
        WHERE crypto = 'btc'
        AND window_epoch = (SELECT MAX(window_epoch) FROM live_trades WHERE crypto = 'btc' AND timestamp > NOW() - INTERVAL '2 hours')
        ORDER BY timestamp
    `);

    console.log('MOST RECENT BTC WINDOW TRADES:');
    for (const row of r.rows) {
        console.log('');
        console.log(row.type.toUpperCase() + ' #' + row.id + ' | ' + row.timestamp_et);
        console.log('  Side: ' + row.side + ' | Price: ' + (row.price ? row.price.toFixed(3) : 'N/A') + ' | Size: ' + (row.size ? row.size.toFixed(2) : 'N/A') + ' | Shares: ' + (row.shares ? row.shares.toFixed(2) : 'N/A'));
        if (row.type === 'entry') {
            const sp = row.spot_price || 0;
            const st = row.price_to_beat || 0;
            console.log('  Spot: $' + sp.toFixed(2) + ' | Strike: $' + st.toFixed(2));
            const diff = sp - st;
            console.log('  Spot is ' + (diff > 0 ? 'ABOVE' : 'BELOW') + ' strike by $' + Math.abs(diff).toFixed(2));
        }
        if (row.pnl !== null) {
            console.log('  P&L: $' + row.pnl.toFixed(2) + ' | Reason: ' + row.reason);
        }
    }

    await pool.end();
}

check().catch(e => { console.error(e); pool.end(); });
