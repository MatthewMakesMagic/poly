/**
 * Build a model of how Polymarket prices spot movements
 * 
 * For every 15-min window, analyze:
 * 1. How did spot move during the window?
 * 2. How did market probability react?
 * 3. What was the lag at each point?
 * 4. What was the actual outcome?
 * 
 * This lets us build:
 * - Empirical reaction curves (spot move → expected market move)
 * - Time-dependent models (reaction differs at 14min vs 30sec remaining)
 * - Volatility regime models
 * - Pricing inefficiency detection
 */

import pg from 'pg';

const pool = new pg.Pool({
    connectionString: 'postgresql://postgres.wwwzarzuidxelwyppbjh:Entering5-Cofounder9-Juggle3-Erasable9-Supermom9@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

async function analyzeWindow(windowEpoch, crypto, ticks) {
    if (ticks.length < 10) return null;
    
    const firstTick = ticks[0];
    const lastTick = ticks[ticks.length - 1];
    
    // Strike (first spot price)
    const strike = parseFloat(firstTick.spot_price);
    const finalSpot = parseFloat(lastTick.spot_price);
    const outcome = finalSpot >= strike ? 'up' : 'down';
    const spotReturn = (finalSpot - strike) / strike;
    
    // Analyze each tick's relationship
    const dataPoints = [];
    
    for (let i = 1; i < ticks.length; i++) {
        const tick = ticks[i];
        const prevTick = ticks[i - 1];
        
        const spot = parseFloat(tick.spot_price);
        const prevSpot = parseFloat(prevTick.spot_price);
        const spotMove = (spot - prevSpot) / prevSpot;
        
        const marketProb = parseFloat(tick.up_mid);
        const prevMarketProb = parseFloat(prevTick.up_mid);
        const marketMove = marketProb - prevMarketProb;
        
        const timeRemaining = parseFloat(tick.time_remaining_sec);
        const spotVsStrike = (spot - strike) / strike;
        
        // Fair value approximation (simplified)
        // In reality, use Black-Scholes
        const moneyness = spotVsStrike * 100;  // % above/below strike
        
        dataPoints.push({
            timeRemaining,
            spotMove: spotMove * 10000,  // basis points
            marketMove: marketMove * 100, // percentage points
            spotVsStrike: spotVsStrike * 100,  // %
            marketProb: marketProb * 100,
            moneyness
        });
    }
    
    return {
        windowEpoch,
        crypto,
        outcome,
        spotReturn: spotReturn * 100,
        tickCount: ticks.length,
        dataPoints
    };
}

async function main() {
    console.log('=== BUILDING MARKET MICROSTRUCTURE MODEL ===\n');
    
    // Load all ticks grouped by window
    const { rows: ticks } = await pool.query(`
        SELECT window_epoch, crypto, timestamp_ms, spot_price, up_mid, 
               time_remaining_sec, price_to_beat
        FROM ticks
        ORDER BY window_epoch, crypto, timestamp_ms
    `);
    
    // Group by window
    const windows = {};
    for (const tick of ticks) {
        const key = `${tick.crypto}_${tick.window_epoch}`;
        if (!windows[key]) {
            windows[key] = { epoch: tick.window_epoch, crypto: tick.crypto, ticks: [] };
        }
        windows[key].ticks.push(tick);
    }
    
    console.log(`Analyzing ${Object.keys(windows).length} windows...\n`);
    
    // Analyze each window
    const allDataPoints = [];
    const windowSummaries = [];
    
    for (const [key, w] of Object.entries(windows)) {
        const analysis = await analyzeWindow(w.epoch, w.crypto, w.ticks);
        if (analysis) {
            windowSummaries.push(analysis);
            allDataPoints.push(...analysis.dataPoints);
        }
    }
    
    console.log(`Collected ${allDataPoints.length} data points\n`);
    
    // === MODEL 1: Spot Move → Market Move Relationship ===
    console.log('=== MODEL 1: SPOT MOVE → MARKET REACTION ===\n');
    
    // Bucket by spot move size
    const buckets = {
        'large_down': { spotMoves: [], marketMoves: [], count: 0 },  // < -5 bps
        'small_down': { spotMoves: [], marketMoves: [], count: 0 },  // -5 to 0 bps
        'small_up': { spotMoves: [], marketMoves: [], count: 0 },    // 0 to 5 bps
        'large_up': { spotMoves: [], marketMoves: [], count: 0 }     // > 5 bps
    };
    
    for (const dp of allDataPoints) {
        let bucket;
        if (dp.spotMove < -5) bucket = 'large_down';
        else if (dp.spotMove < 0) bucket = 'small_down';
        else if (dp.spotMove < 5) bucket = 'small_up';
        else bucket = 'large_up';
        
        buckets[bucket].spotMoves.push(dp.spotMove);
        buckets[bucket].marketMoves.push(dp.marketMove);
        buckets[bucket].count++;
    }
    
    console.log('Spot Move Bucket | Avg Spot Move (bps) | Avg Market Move (%) | Ratio | Count');
    console.log('-'.repeat(80));
    
    for (const [name, data] of Object.entries(buckets)) {
        if (data.count > 0) {
            const avgSpot = data.spotMoves.reduce((a, b) => a + b, 0) / data.count;
            const avgMarket = data.marketMoves.reduce((a, b) => a + b, 0) / data.count;
            const ratio = avgSpot !== 0 ? (avgMarket / (avgSpot / 100)).toFixed(2) : '-';
            console.log(`${name.padEnd(16)} | ${avgSpot.toFixed(2).padStart(10)} bps | ${avgMarket.toFixed(4).padStart(10)}% | ${ratio.padStart(5)} | ${data.count}`);
        }
    }
    
    // === MODEL 2: Time Remaining Effect ===
    console.log('\n=== MODEL 2: TIME REMAINING EFFECT ===\n');
    
    const timeWindows = {
        'early (>600s)': { moves: [], count: 0 },
        'mid (300-600s)': { moves: [], count: 0 },
        'late (60-300s)': { moves: [], count: 0 },
        'final (<60s)': { moves: [], count: 0 }
    };
    
    for (const dp of allDataPoints) {
        let tw;
        if (dp.timeRemaining > 600) tw = 'early (>600s)';
        else if (dp.timeRemaining > 300) tw = 'mid (300-600s)';
        else if (dp.timeRemaining > 60) tw = 'late (60-300s)';
        else tw = 'final (<60s)';
        
        if (Math.abs(dp.spotMove) > 1) {  // Only significant moves
            timeWindows[tw].moves.push({
                spotMove: dp.spotMove,
                marketMove: dp.marketMove,
                ratio: dp.spotMove !== 0 ? dp.marketMove / (dp.spotMove / 100) : 0
            });
            timeWindows[tw].count++;
        }
    }
    
    console.log('Time Window | Avg Market/Spot Ratio | Sample Size');
    console.log('-'.repeat(60));
    
    for (const [name, data] of Object.entries(timeWindows)) {
        if (data.count > 10) {
            const avgRatio = data.moves.reduce((a, b) => a + b.ratio, 0) / data.count;
            console.log(`${name.padEnd(20)} | ${avgRatio.toFixed(4).padStart(10)} | ${data.count}`);
        }
    }
    
    // === MODEL 3: When Does Market Lag Most? ===
    console.log('\n=== MODEL 3: MARKET LAG DETECTION ===\n');
    
    // Find instances where market moved LESS than expected
    const lagInstances = allDataPoints.filter(dp => {
        const expectedMarket = dp.spotMove / 100 * 10;  // Rough expectation
        const actualMarket = dp.marketMove;
        return Math.abs(dp.spotMove) > 2 && Math.abs(actualMarket) < Math.abs(expectedMarket) * 0.5;
    });
    
    console.log(`Found ${lagInstances.length} lag instances (market moved <50% of expected)`);
    console.log('\nSample lag instances:');
    lagInstances.slice(0, 10).forEach(dp => {
        console.log(`  Time: ${dp.timeRemaining.toFixed(0)}s, Spot: ${dp.spotMove.toFixed(1)}bps, Market: ${dp.marketMove.toFixed(3)}%`);
    });
    
    // === MODEL 4: Outcome Prediction ===
    console.log('\n=== MODEL 4: OUTCOME ANALYSIS ===\n');
    
    const outcomes = { up: 0, down: 0 };
    const bySpotReturn = { positive: [], negative: [] };
    
    for (const w of windowSummaries) {
        outcomes[w.outcome]++;
        if (w.spotReturn >= 0) {
            bySpotReturn.positive.push(w);
        } else {
            bySpotReturn.negative.push(w);
        }
    }
    
    console.log(`Outcomes: ${outcomes.up} up (${(outcomes.up / (outcomes.up + outcomes.down) * 100).toFixed(1)}%), ${outcomes.down} down`);
    console.log(`\nBy spot return:`);
    console.log(`  Positive returns: ${bySpotReturn.positive.length} windows`);
    console.log(`  Negative returns: ${bySpotReturn.negative.length} windows`);
    
    // === SAVE MODEL DATA ===
    console.log('\n=== SAVING MODEL DATA ===\n');
    
    const modelData = {
        generatedAt: new Date().toISOString(),
        windowCount: windowSummaries.length,
        dataPointCount: allDataPoints.length,
        buckets,
        outcomes,
        summary: {
            avgSpotReturn: windowSummaries.reduce((a, b) => a + b.spotReturn, 0) / windowSummaries.length,
            upRate: outcomes.up / (outcomes.up + outcomes.down)
        }
    };
    
    const fs = await import('fs');
    fs.writeFileSync('/tmp/market_model.json', JSON.stringify(modelData, null, 2));
    console.log('Saved model data to /tmp/market_model.json');
    
    await pool.end();
}

main().catch(console.error);
