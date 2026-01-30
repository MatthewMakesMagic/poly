import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get all BTC trades from today with full context
const r = await pool.query(`
    SELECT id, timestamp_et, type, crypto, side, price, pnl, reason,
           spot_price, price_to_beat, bs_prob, market_prob, edge_at_entry,
           window_epoch, oracle_price, oracle_source
    FROM live_trades
    WHERE crypto = 'btc'
    AND timestamp > NOW() - INTERVAL '6 hours'
    ORDER BY timestamp DESC
`);

console.log('DEEP BTC TRADE ANALYSIS');
console.log('========================\n');

// Group by window
const windows = {};
for (const t of r.rows) {
    if (!windows[t.window_epoch]) windows[t.window_epoch] = [];
    windows[t.window_epoch].push(t);
}

for (const [epoch, trades] of Object.entries(windows).sort((a,b) => b[0] - a[0])) {
    const entries = trades.filter(t => t.type === 'entry');
    const exits = trades.filter(t => t.type === 'exit' || t.type === 'abandoned');

    if (entries.length === 0) continue;

    const e = entries[0]; // First entry
    const windowStart = new Date(epoch * 1000);
    const windowEnd = new Date((parseInt(epoch) + 900) * 1000);

    console.log('═'.repeat(80));
    console.log('WINDOW: ' + windowStart.toLocaleString('en-US', {timeZone: 'America/New_York'}) +
                ' to ' + windowEnd.toLocaleString('en-US', {timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'}));
    console.log('═'.repeat(80));

    // Entry analysis
    const spotVsStrike = e.spot_price && e.price_to_beat
        ? (e.spot_price > e.price_to_beat ? 'ABOVE' : 'BELOW')
        : 'UNKNOWN';
    const spotDiff = e.spot_price && e.price_to_beat
        ? ((e.spot_price - e.price_to_beat) / e.price_to_beat * 100).toFixed(3)
        : 'N/A';

    console.log('\nENTRY:');
    console.log('  Side bet:      ' + e.side?.toUpperCase());
    console.log('  Entry price:   $' + e.price?.toFixed(3) + ' (' + (e.price * 100).toFixed(0) + '% implied prob)');
    console.log('  Spot price:    $' + e.spot_price?.toFixed(2));
    console.log('  Strike price:  $' + e.price_to_beat?.toFixed(2));
    console.log('  Spot vs Strike: ' + spotVsStrike + ' by ' + spotDiff + '%');
    console.log('  BS Prob:       ' + (e.bs_prob ? (e.bs_prob * 100).toFixed(1) + '%' : 'N/A'));
    console.log('  Market Prob:   ' + (e.market_prob ? (e.market_prob * 100).toFixed(1) + '%' : 'N/A'));
    console.log('  Edge:          ' + (e.edge_at_entry ? (e.edge_at_entry * 100).toFixed(1) + '%' : 'N/A'));

    // CRITICAL ANALYSIS: Is the bet CORRECT?
    console.log('\n  LOGIC CHECK:');
    if (spotVsStrike === 'ABOVE') {
        console.log('    Spot is ABOVE strike → UP should win');
        if (e.side?.toLowerCase() === 'up') {
            console.log('    We bet UP → ✅ CORRECT DIRECTION');
        } else {
            console.log('    We bet DOWN → ❌ WRONG DIRECTION!!!');
        }
    } else if (spotVsStrike === 'BELOW') {
        console.log('    Spot is BELOW strike → DOWN should win');
        if (e.side?.toLowerCase() === 'down') {
            console.log('    We bet DOWN → ✅ CORRECT DIRECTION');
        } else {
            console.log('    We bet UP → ❌ WRONG DIRECTION!!!');
        }
    }

    // Exit analysis
    if (exits.length > 0) {
        const x = exits[0];
        const totalPnl = exits.reduce((sum, ex) => sum + (ex.pnl || 0), 0);
        console.log('\nEXIT:');
        console.log('  Exit price:    $' + x.price?.toFixed(3));
        console.log('  Reason:        ' + x.reason);
        console.log('  Total P&L:     $' + totalPnl.toFixed(2) + (totalPnl >= 0 ? ' ✅' : ' ❌'));

        // Was the exit a winner or loser?
        if (totalPnl < 0) {
            console.log('\n  WHY DID WE LOSE?');
            if (x.reason === 'stop_loss') {
                console.log('    → Hit 50% stop loss BEFORE window end');
            } else if (x.reason === 'danger_zone_exit') {
                console.log('    → Position value dropped below $1.20 safety threshold');
            } else if (x.reason?.includes('floor') || x.reason?.includes('trail')) {
                console.log('    → Protective exit triggered while position was losing');
            } else if (x.reason === 'window_expiry') {
                console.log('    → Held to expiry but LOST - we bet the wrong side!');
            }
        }
    }

    console.log('');
}

// Summary
const allExits = r.rows.filter(t => t.pnl !== null);
const totalPnl = allExits.reduce((sum, t) => sum + t.pnl, 0);
const wins = allExits.filter(t => t.pnl > 0).length;
const losses = allExits.filter(t => t.pnl < 0).length;

console.log('═'.repeat(80));
console.log('OVERALL SUMMARY: ' + wins + ' wins, ' + losses + ' losses, Total: $' + totalPnl.toFixed(2));
console.log('═'.repeat(80));

await pool.end();
