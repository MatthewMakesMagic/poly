import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get recent entries with edge data
const r = await pool.query(`
    SELECT id, timestamp_et, strategy_name, crypto, side, 
           oracle_price, price_to_beat, price as entry_price,
           bs_prob, market_prob, edge_at_entry, time_remaining,
           ABS(oracle_price - price_to_beat) / price_to_beat * 100 as pct_from_strike
    FROM live_trades
    WHERE type = 'entry'
    AND timestamp > NOW() - INTERVAL '24 hours'
    AND oracle_price IS NOT NULL
    AND price_to_beat IS NOT NULL
    ORDER BY timestamp DESC
`);

console.log('EDGE ANALYSIS AT ENTRY:');
console.log('='.repeat(130));
console.log('Time | Crypto | Strategy | Entry$ | BS Prob | Mkt Prob | Edge | % from Strike | Time Left | Verdict');
console.log('='.repeat(130));

let totalEdge = 0, totalPctFromStrike = 0, count = 0;
let tinyEdgeTrades = [];

for (const row of r.rows) {
    const edge = row.edge_at_entry ? (row.edge_at_entry * 100).toFixed(1) : 'N/A';
    const bsProb = row.bs_prob ? (row.bs_prob * 100).toFixed(1) : 'N/A';
    const mktProb = row.market_prob ? (row.market_prob * 100).toFixed(1) : 'N/A';
    const pctFromStrike = row.pct_from_strike?.toFixed(3) || 'N/A';
    const timeLeft = row.time_remaining?.toFixed(0) || 'N/A';
    
    // Verdict on edge quality
    let verdict = '';
    if (row.pct_from_strike < 0.05) verdict = '⚠️ TINY (<0.05%)';
    else if (row.pct_from_strike < 0.1) verdict = '🟡 Small';
    else if (row.pct_from_strike < 0.2) verdict = '🟢 OK';
    else verdict = '✅ Good';
    
    console.log(
        (row.timestamp_et?.split(' ')[1] || '').padEnd(12) + ' | ' +
        row.crypto.toUpperCase().padEnd(4) + ' | ' +
        (row.strategy_name || '').substring(0, 15).padEnd(15) + ' | ' +
        ('$' + (row.entry_price?.toFixed(2) || 'N/A')).padStart(6) + ' | ' +
        (bsProb + '%').padStart(7) + ' | ' +
        (mktProb + '%').padStart(8) + ' | ' +
        (edge + '%').padStart(6) + ' | ' +
        (pctFromStrike + '%').padStart(13) + ' | ' +
        (timeLeft + 's').padStart(9) + ' | ' +
        verdict
    );
    
    if (row.edge_at_entry) totalEdge += row.edge_at_entry * 100;
    if (row.pct_from_strike) totalPctFromStrike += row.pct_from_strike;
    count++;
    
    if (row.pct_from_strike < 0.1) {
        tinyEdgeTrades.push(row);
    }
}

console.log('='.repeat(130));
console.log('\nSUMMARY:');
console.log('  Total entries analyzed:', count);
console.log('  Average edge at entry:', (totalEdge / count).toFixed(1) + '%');
console.log('  Average % from strike:', (totalPctFromStrike / count).toFixed(3) + '%');
console.log('  Trades with < 0.1% from strike:', tinyEdgeTrades.length, '(' + ((tinyEdgeTrades.length / count) * 100).toFixed(0) + '%)');

await pool.end();
