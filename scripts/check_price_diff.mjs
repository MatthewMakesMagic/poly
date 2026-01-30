import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get LagProb_RightSide trades and corresponding tick data
const r = await pool.query(`
    SELECT l.id, l.timestamp_et, l.crypto, l.side, l.spot_price as logged_spot, 
           l.price_to_beat as logged_strike, l.oracle_price, l.oracle_source,
           l.window_epoch, l.time_remaining
    FROM live_trades l
    WHERE l.type = 'entry' 
    AND l.strategy_name = 'LagProb_RightSide'
    AND l.timestamp > NOW() - INTERVAL '24 hours'
    ORDER BY l.timestamp DESC
    LIMIT 20
`);

console.log('PRICE COMPARISON: Strategy oracle_price vs logged spot_price');
console.log('='.repeat(120));

for (const row of r.rows) {
    const oraclePrice = row.oracle_price;
    const spotPrice = row.logged_spot;
    const strike = row.logged_strike;
    
    // Calculate what side should be based on each price
    const shouldBeOracle = oraclePrice && strike ? (oraclePrice > strike ? 'up' : 'down') : '?';
    const shouldBeSpot = spotPrice && strike ? (spotPrice > strike ? 'up' : 'down') : '?';
    
    const diff = oraclePrice && spotPrice ? (oraclePrice - spotPrice).toFixed(4) : 'N/A';
    
    const oracleVsStrike = oraclePrice && strike ? (oraclePrice > strike ? 'ABOVE' : 'BELOW') : '?';
    const spotVsStrike = spotPrice && strike ? (spotPrice > strike ? 'ABOVE' : 'BELOW') : '?';
    
    const betCorrect = row.side?.toLowerCase() === shouldBeOracle ? '✅' : '❌';
    
    console.log('');
    console.log('Trade #' + row.id + ' | ' + row.crypto.toUpperCase() + ' | Bet: ' + row.side?.toUpperCase() + ' ' + betCorrect);
    console.log('  Oracle: $' + (oraclePrice?.toFixed(4) || 'N/A') + ' (' + oracleVsStrike + ' strike) → ' + shouldBeOracle.toUpperCase() + ' should win');
    console.log('  Spot:   $' + (spotPrice?.toFixed(4) || 'N/A') + ' (' + spotVsStrike + ' strike) → ' + shouldBeSpot.toUpperCase() + ' should win');
    console.log('  Strike: $' + (strike?.toFixed(4) || 'N/A'));
    console.log('  Diff:   $' + diff + ' | Source: ' + (row.oracle_source || 'N/A'));
    if (shouldBeOracle !== shouldBeSpot) {
        console.log('  ⚠️  MISMATCH between oracle and spot directions!');
    }
}

await pool.end();
