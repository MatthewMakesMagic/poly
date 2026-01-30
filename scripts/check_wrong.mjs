import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get all recent entries with wrong direction
const r = await pool.query(`
    SELECT strategy_name, crypto, side, spot_price, price_to_beat, price as entry_price,
           CASE WHEN spot_price > price_to_beat THEN 'ABOVE' ELSE 'BELOW' END as spot_vs_strike,
           timestamp_et, window_epoch
    FROM live_trades 
    WHERE type = 'entry' 
    AND timestamp > NOW() - INTERVAL '24 hours'
`);

console.log('WRONG DIRECTION BETS BY STRATEGY:');
console.log('='.repeat(100));

const wrongByStrategy = {};
const totalByStrategy = {};

for (const row of r.rows) {
    const shouldBe = row.spot_vs_strike === 'ABOVE' ? 'up' : 'down';
    const isWrong = row.side?.toLowerCase() !== shouldBe;
    
    const strat = row.strategy_name || 'unknown';
    if (!wrongByStrategy[strat]) wrongByStrategy[strat] = [];
    if (!totalByStrategy[strat]) totalByStrategy[strat] = 0;
    totalByStrategy[strat]++;
    
    if (isWrong) {
        wrongByStrategy[strat].push({
            crypto: row.crypto,
            side: row.side,
            shouldBe,
            spot: row.spot_price,
            strike: row.price_to_beat,
            entryPrice: row.entry_price,
            time: row.timestamp_et
        });
    }
}

for (const [strat, wrongs] of Object.entries(wrongByStrategy)) {
    if (wrongs.length > 0) {
        console.log('');
        console.log(strat + ': ' + wrongs.length + ' wrong out of ' + totalByStrategy[strat] + ' total');
        console.log('-'.repeat(80));
        for (const w of wrongs.slice(0, 5)) {  // Show first 5
            console.log('  ' + w.time + ' | ' + w.crypto.toUpperCase() + ' | Bet ' + w.side?.toUpperCase() + ' but should be ' + w.shouldBe.toUpperCase());
            console.log('    Spot: $' + (w.spot?.toFixed(2) || 'N/A') + ' | Strike: $' + (w.strike?.toFixed(2) || 'N/A') + ' | Entry: $' + (w.entryPrice?.toFixed(3) || 'N/A'));
        }
        if (wrongs.length > 5) console.log('  ... and ' + (wrongs.length - 5) + ' more');
    }
}

// Summary
console.log('');
console.log('='.repeat(100));
console.log('SUMMARY:');
let totalWrong = 0, totalTotal = 0;
for (const [strat, count] of Object.entries(totalByStrategy)) {
    const wrongCount = wrongByStrategy[strat]?.length || 0;
    totalWrong += wrongCount;
    totalTotal += count;
    if (wrongCount > 0) {
        console.log('  ' + strat + ': ' + wrongCount + '/' + count + ' wrong (' + ((wrongCount/count)*100).toFixed(0) + '%)');
    } else {
        console.log('  ' + strat + ': 0/' + count + ' wrong (100% correct)');
    }
}
console.log('TOTAL: ' + totalWrong + '/' + totalTotal + ' wrong direction bets');

await pool.end();
