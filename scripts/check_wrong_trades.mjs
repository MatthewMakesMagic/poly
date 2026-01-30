import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get the specific wrong trades I identified earlier
const r = await pool.query(`
    SELECT id, timestamp_et, strategy_name, crypto, side, 
           spot_price, oracle_price, oracle_source, price_to_beat, price,
           bs_prob, edge_at_entry, time_remaining, window_epoch, reason
    FROM live_trades
    WHERE id IN (1523, 1522, 1515, 1514, 1502, 1483, 1482, 1478, 1477, 1425, 1424)
    ORDER BY id DESC
`);

console.log('ANALYSIS OF WRONG-DIRECTION TRADES:');
console.log('='.repeat(120));

for (const row of r.rows) {
    const spotPrice = row.spot_price;
    const oraclePrice = row.oracle_price;
    const strike = row.price_to_beat;
    
    const spotAbove = spotPrice && strike ? spotPrice > strike : null;
    const oracleAbove = oraclePrice && strike ? oraclePrice > strike : null;
    const shouldBe = spotAbove !== null ? (spotAbove ? 'up' : 'down') : 'unknown';
    const shouldBeOracle = oracleAbove !== null ? (oracleAbove ? 'up' : 'down') : 'unknown';
    
    console.log('');
    console.log('Trade #' + row.id + ' | ' + row.timestamp_et);
    console.log('  Strategy: ' + row.strategy_name);
    console.log('  Crypto: ' + row.crypto?.toUpperCase() + ' | Bet: ' + row.side?.toUpperCase());
    console.log('  Spot price:   $' + (spotPrice?.toFixed(4) || 'N/A'));
    console.log('  Oracle price: $' + (oraclePrice?.toFixed(4) || 'N/A') + ' (source: ' + (row.oracle_source || 'N/A') + ')');
    console.log('  Strike:       $' + (strike?.toFixed(4) || 'N/A'));
    console.log('  Entry price:  $' + (row.price?.toFixed(4) || 'N/A'));
    console.log('  Based on logged spot: should bet ' + shouldBe.toUpperCase() + (row.side?.toLowerCase() === shouldBe ? ' ✅' : ' ❌ WRONG'));
    console.log('  Based on oracle:      should bet ' + shouldBeOracle.toUpperCase() + (row.side?.toLowerCase() === shouldBeOracle ? ' ✅' : ' ❌ WRONG'));
    console.log('  BS prob: ' + (row.bs_prob ? (row.bs_prob * 100).toFixed(1) + '%' : 'N/A') + ' | Edge: ' + (row.edge_at_entry ? (row.edge_at_entry * 100).toFixed(1) + '%' : 'N/A'));
    console.log('  Time remaining: ' + (row.time_remaining?.toFixed(0) || 'N/A') + 's');
    
    // Flag suspicious entry prices
    if (row.price > 1.0) {
        console.log('  ⚠️ IMPOSSIBLE ENTRY PRICE > $1.00 - data recording bug!');
    }
}

await pool.end();
