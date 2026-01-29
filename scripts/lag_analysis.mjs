import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Get recent entries from the last 30 minutes
const r = await pool.query(`
    SELECT *
    FROM live_trades
    WHERE type = 'entry'
    AND timestamp > NOW() - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
`);

console.log('');
console.log('='.repeat(100));
console.log('LAG ANALYSIS: ENTRIES FROM LAST 30 MINUTES');
console.log('='.repeat(100));

for (const t of r.rows) {
    const crypto = (t.crypto || '').toUpperCase();
    const side = (t.side || '').toUpperCase();

    console.log('');
    console.log('-'.repeat(100));
    console.log('TRADE ' + t.id + ' | ' + t.timestamp_et + ' | ' + crypto + ' ' + side);
    console.log('-'.repeat(100));

    console.log('STRATEGY:', t.strategy_name);
    console.log('REASON:', t.reason);
    console.log('');

    console.log('PRICE DATA:');
    console.log('  Entry Price:     ' + (t.price ? '$' + t.price.toFixed(3) : 'N/A') + ' (what we paid per share)');
    console.log('  Price Requested: ' + (t.price_requested ? '$' + t.price_requested.toFixed(3) : 'N/A'));
    console.log('  Price Filled:    ' + (t.price_filled ? '$' + t.price_filled.toFixed(3) : 'N/A'));
    console.log('  Position Size:   $' + (t.size?.toFixed(2) || 'N/A'));
    console.log('');

    console.log('SPOT vs STRIKE:');
    console.log('  Spot Price:      $' + (t.spot_price?.toFixed(2) || 'N/A'));
    console.log('  Price to Beat:   $' + (t.price_to_beat?.toFixed(2) || 'N/A'));
    const spotDelta = t.spot_price && t.price_to_beat ? t.spot_price - t.price_to_beat : null;
    const spotDeltaPct = spotDelta && t.price_to_beat ? (spotDelta / t.price_to_beat * 100) : null;
    const deltaStr = spotDelta ? (spotDelta >= 0 ? '+' : '') + '$' + spotDelta.toFixed(2) : 'N/A';
    const deltaPctStr = spotDeltaPct ? spotDeltaPct.toFixed(3) + '%' : 'N/A';
    console.log('  Spot Delta:      ' + deltaStr + ' (' + deltaPctStr + ')');
    const spotImplies = spotDelta !== null ? (spotDelta >= 0 ? 'UP' : 'DOWN') : 'N/A';
    console.log('  Spot Implies:    ' + spotImplies + ' should win');
    console.log('');

    console.log('ORACLE DATA:');
    console.log('  Oracle Price:    $' + (t.oracle_price?.toFixed(2) || 'N/A'));
    console.log('  Oracle Source:   ' + (t.oracle_source || 'N/A'));
    console.log('  Pyth Price:      ' + (t.pyth_price ? '$' + t.pyth_price.toFixed(2) : 'N/A'));
    console.log('  Chainlink:       ' + (t.chainlink_price ? '$' + t.chainlink_price.toFixed(2) : 'N/A') + ' (staleness: ' + (t.chainlink_staleness || 'N/A') + 's)');
    console.log('');

    console.log('LAG DETECTION:');
    console.log('  Lag Ratio:       ' + (t.lag_ratio?.toFixed(3) || 'N/A') + ' (lower = more lag opportunity)');
    console.log('');

    console.log('EDGE CALCULATION:');
    console.log('  BS Fair Prob:    ' + (t.bs_prob ? (t.bs_prob * 100).toFixed(1) + '%' : 'N/A'));
    console.log('  Market Prob:     ' + (t.market_prob ? (t.market_prob * 100).toFixed(1) + '%' : 'N/A'));
    console.log('  Edge at Entry:   ' + (t.edge_at_entry ? (t.edge_at_entry * 100).toFixed(1) + '%' : 'N/A'));
    console.log('');

    console.log('TIMING:');
    console.log('  Time Remaining:  ' + (t.time_remaining?.toFixed(0) || 'N/A') + 's');
    console.log('');

    // Analysis
    const entryPrice = t.price;
    const marketProb = t.market_prob;
    const bsProb = t.bs_prob;
    const sideLC = (t.side || '').toLowerCase();

    if (entryPrice && bsProb && sideLC) {
        // CRITICAL: bs_prob from database is ALREADY the probability for the side we bet on!
        // It's stored as theoreticalSideProb, not as UP probability.
        const ourSideBSProb = bsProb;  // Already for our side - don't invert!
        const edgeVsEntry = ourSideBSProb - entryPrice;

        console.log('ANALYSIS:');
        console.log('  We bet:          ' + sideLC.toUpperCase());
        console.log('  Entry price:     ' + (entryPrice * 100).toFixed(1) + 'c (implied prob what we paid)');
        console.log('  BS Fair Value:   ' + (ourSideBSProb * 100).toFixed(1) + '% for ' + sideLC.toUpperCase());
        console.log('  Edge:            ' + ((edgeVsEntry) * 100).toFixed(1) + '%');

        if (ourSideBSProb > entryPrice) {
            console.log('  VERDICT:         ✅ GOOD - Paying ' + (entryPrice*100).toFixed(0) + 'c for ' + (ourSideBSProb*100).toFixed(0) + '% chance');
        } else {
            console.log('  VERDICT:         ❌ BAD - Paying ' + (entryPrice*100).toFixed(0) + 'c for only ' + (ourSideBSProb*100).toFixed(0) + '% chance');
        }
    }
}

// Now get recent exits to see outcomes
console.log('');
console.log('='.repeat(100));
console.log('EXITS FROM LAST 30 MINUTES');
console.log('='.repeat(100));

const exits = await pool.query(`
    SELECT *
    FROM live_trades
    WHERE type = 'exit'
    AND timestamp > NOW() - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
`);

for (const t of exits.rows) {
    const pnlStr = t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) : 'N/A';
    const crypto = (t.crypto || '').toUpperCase();
    const side = (t.side || '').toUpperCase();
    console.log(t.timestamp_et + ' | ' + crypto + ' ' + side + ' | Exit @ ' + (t.price?.toFixed(3) || 'N/A') + ' | P&L: ' + pnlStr + ' | Reason: ' + t.reason);
}

await pool.end();
