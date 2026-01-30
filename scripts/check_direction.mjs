import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get all recent entries with their outcomes
const r = await pool.query(`
    WITH entries AS (
        SELECT id, window_epoch, crypto, side, spot_price, price_to_beat, price,
               CASE WHEN spot_price > price_to_beat THEN 'ABOVE' ELSE 'BELOW' END as spot_vs_strike,
               timestamp_et
        FROM live_trades 
        WHERE type = 'entry' 
        AND timestamp > NOW() - INTERVAL '12 hours'
    ),
    exits AS (
        SELECT window_epoch, crypto, pnl, reason
        FROM live_trades
        WHERE type IN ('exit', 'abandoned')
        AND timestamp > NOW() - INTERVAL '12 hours'
    )
    SELECT e.*, x.pnl, x.reason,
           ((e.spot_price - e.price_to_beat) / e.price_to_beat * 100) as pct_from_strike
    FROM entries e
    LEFT JOIN exits x ON e.window_epoch = x.window_epoch AND e.crypto = x.crypto
    ORDER BY e.timestamp_et DESC
`);

console.log('TRADE DIRECTION ANALYSIS (last 12 hours):');
console.log('='.repeat(120));
console.log('Time | Crypto | Side | Spot vs Strike | % from Strike | Entry$ | P&L | Win/Lose');
console.log('='.repeat(120));

let correctWins = 0, correctLosses = 0;
let wrongBets = 0;
let totalEdge = 0;

for (const row of r.rows) {
    const shouldBe = row.spot_vs_strike === 'ABOVE' ? 'up' : 'down';
    const isCorrect = row.side?.toLowerCase() === shouldBe;
    const pnl = row.pnl !== null ? (row.pnl >= 0 ? '+$' : '-$') + Math.abs(row.pnl).toFixed(2) : '';
    const won = row.pnl > 0 ? 'WIN' : row.pnl < 0 ? 'LOSE' : '';
    const verdict = isCorrect ? '✅' : '❌';
    const pctStr = (row.pct_from_strike >= 0 ? '+' : '') + row.pct_from_strike?.toFixed(3) + '%';
    
    console.log(
        row.timestamp_et?.split(' ')[1] + ' | ' +
        row.crypto.toUpperCase() + ' | ' +
        row.side?.toUpperCase()?.padEnd(4) + ' | ' +
        ('Spot ' + row.spot_vs_strike + ' (' + shouldBe.toUpperCase() + ' wins)').padEnd(25) + ' | ' +
        pctStr.padStart(8) + ' | ' +
        ('$' + row.price?.toFixed(2)).padStart(6) + ' | ' +
        pnl.padStart(8) + ' | ' +
        won.padEnd(5) + verdict
    );
    
    if (!isCorrect) wrongBets++;
    else {
        totalEdge += Math.abs(row.pct_from_strike || 0);
        if (row.pnl > 0) correctWins++;
        else if (row.pnl < 0) correctLosses++;
    }
}

console.log('='.repeat(120));
console.log('SUMMARY:');
console.log('  Wrong direction bets: ' + wrongBets);
console.log('  Correct direction wins: ' + correctWins);
console.log('  Correct direction losses: ' + correctLosses);
console.log('  Avg % from strike on correct bets: ' + (totalEdge / (correctWins + correctLosses + 1)).toFixed(3) + '%');

await pool.end();
