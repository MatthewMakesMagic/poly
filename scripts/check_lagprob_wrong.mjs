import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get LagProb_RightSide wrong-direction trades
const r = await pool.query(`
    SELECT id, strategy_name, crypto, side, spot_price, price_to_beat, price, size,
           timestamp_et, window_epoch, bs_prob, edge_at_entry, time_remaining
    FROM live_trades 
    WHERE type = 'entry' 
    AND strategy_name = 'LagProb_RightSide'
    AND timestamp > NOW() - INTERVAL '24 hours'
    AND spot_price IS NOT NULL 
    AND price_to_beat IS NOT NULL
    ORDER BY timestamp DESC
`);

console.log('LAGPROB_RIGHTSIDE TRADE ANALYSIS:');
console.log('(Only showing trades where both spot_price and strike are recorded)');
console.log('='.repeat(120));

let wrongCount = 0, correctCount = 0;

for (const row of r.rows) {
    const spotAboveStrike = row.spot_price > row.price_to_beat;
    const shouldBe = spotAboveStrike ? 'up' : 'down';
    const isWrong = row.side?.toLowerCase() !== shouldBe;
    
    if (isWrong) {
        wrongCount++;
        console.log('');
        console.log('❌ WRONG BET #' + row.id + ' @ ' + row.timestamp_et);
        console.log('   Crypto: ' + row.crypto.toUpperCase());
        console.log('   Bet: ' + row.side?.toUpperCase() + ' | Should be: ' + shouldBe.toUpperCase());
        console.log('   Spot: $' + row.spot_price?.toFixed(4) + ' | Strike: $' + row.price_to_beat?.toFixed(4));
        console.log('   Spot is ' + (spotAboveStrike ? 'ABOVE' : 'BELOW') + ' strike by $' + Math.abs(row.spot_price - row.price_to_beat).toFixed(4));
        console.log('   Entry price: $' + row.price?.toFixed(4) + ' | BS prob: ' + (row.bs_prob ? (row.bs_prob * 100).toFixed(1) + '%' : 'N/A'));
        console.log('   Time remaining: ' + row.time_remaining + 's');
    } else {
        correctCount++;
    }
}

console.log('');
console.log('='.repeat(120));
console.log('SUMMARY: ' + wrongCount + ' wrong, ' + correctCount + ' correct out of ' + r.rows.length + ' total with data');
console.log('');
console.log('NOTE: Entry prices > $1 are impossible for binary options - indicates data recording bug');

await pool.end();
