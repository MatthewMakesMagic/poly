/**
 * Analyze whether spot lag actually predicts:
 * 1. Resolution outcomes (does spot stay on that side?)
 * 2. Short-term market repricing (can we monetize the catch-up?)
 * 
 * Run with: node scripts/analyze_lag_predictiveness.js
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || './data/polymarket.db';

async function analyzeLagPredictiveness() {
    console.log('='.repeat(80));
    console.log('SPOT LAG PREDICTIVENESS ANALYSIS');
    console.log('Testing: Does spot lag predict outcomes OR just short-term repricing?');
    console.log('='.repeat(80));
    
    const db = new Database(DB_PATH);
    
    // Get resolved windows
    const windows = db.prepare(`
        SELECT * FROM windows 
        WHERE resolved_outcome IS NOT NULL 
        ORDER BY epoch DESC 
        LIMIT 200
    `).all();
    
    if (!windows || windows.length === 0) {
        console.log('No resolved windows found in database');
        return;
    }
    
    console.log(`\nAnalyzing ${windows.length} resolved windows...\n`);
    
    const results = {
        lagDetected: [],
        lagSameAsOutcome: 0,
        lagDiffFromOutcome: 0,
        marketCatchUp: [],
    };
    
    for (const window of windows) {
        // Get all ticks for this window
        const ticks = db.prepare(`
            SELECT * FROM ticks 
            WHERE window_epoch = ? AND crypto = ?
            ORDER BY timestamp_ms ASC
        `).all(window.epoch, window.crypto);
        
        if (!ticks || ticks.length < 15) continue;
        
        // Analyze ticks for lag signals
        for (let i = 8; i < ticks.length - 5; i++) {
            const lookback = 8;
            const oldTick = ticks[i - lookback];
            const currentTick = ticks[i];
            
            if (!oldTick || !currentTick || !oldTick.spot_price || !currentTick.spot_price) continue;
            
            // Calculate spot movement
            const spotMove = (currentTick.spot_price - oldTick.spot_price) / oldTick.spot_price;
            const spotMovePct = spotMove * 100;
            
            // Calculate market movement
            const marketMove = (currentTick.up_mid || 0.5) - (oldTick.up_mid || 0.5);
            
            // Spot lag threshold (0.03% like SpotLag_Fast)
            const threshold = 0.0003;
            
            if (Math.abs(spotMove) < threshold) continue;
            
            // Check market lag ratio
            const expectedMarketMove = spotMove * 10;
            const actualVsExpected = Math.abs(marketMove) / Math.abs(expectedMarketMove);
            
            if (actualVsExpected > 0.5) continue;  // Market already caught up
            
            // LAG DETECTED
            const lagDirection = spotMove > 0 ? 'up' : 'down';
            const timeRemaining = currentTick.time_remaining_sec || 0;
            const entryPrice = lagDirection === 'up' ? 
                (currentTick.up_ask || 0.5) : (currentTick.down_ask || 0.5);
            
            // Does lag predict resolution?
            const resolvedSide = window.resolved_outcome;
            const lagMatchedOutcome = lagDirection === resolvedSide;
            
            if (lagMatchedOutcome) results.lagSameAsOutcome++;
            else results.lagDiffFromOutcome++;
            
            // Does market catch up? Look 30 ticks ahead
            let maxPriceAfter = entryPrice;
            let maxPriceTime = 0;
            
            for (let j = i + 1; j < Math.min(i + 30, ticks.length); j++) {
                const futureTick = ticks[j];
                const futurePrice = lagDirection === 'up' ? 
                    (futureTick.up_bid || 0.5) : (futureTick.down_bid || 0.5);
                if (futurePrice > maxPriceAfter) {
                    maxPriceAfter = futurePrice;
                    maxPriceTime = (futureTick.timestamp_ms - currentTick.timestamp_ms) / 1000;
                }
            }
            
            const priceImprovement = (maxPriceAfter - entryPrice) / entryPrice;
            
            results.lagDetected.push({
                crypto: window.crypto,
                timeRemaining: Math.round(timeRemaining),
                lagDirection,
                spotMovePct: spotMovePct.toFixed(4),
                entryPrice: entryPrice.toFixed(3),
                resolvedSide,
                lagMatchedOutcome,
                maxPriceAfter: maxPriceAfter.toFixed(3),
                priceImprovement: (priceImprovement * 100).toFixed(2),
                maxPriceTime: maxPriceTime.toFixed(0),
            });
            
            results.marketCatchUp.push({
                timeRemaining,
                priceImprovement,
                lagMatchedOutcome
            });
            
            // One signal per window
            break;
        }
    }
    
    db.close();
    
    // OUTPUT
    console.log('='.repeat(80));
    console.log('RESULTS: Does spot lag predict RESOLUTION?');
    console.log('='.repeat(80));
    
    const total = results.lagSameAsOutcome + results.lagDiffFromOutcome;
    const winRate = total > 0 ? (results.lagSameAsOutcome / total * 100).toFixed(1) : 'N/A';
    
    console.log(`Total lag signals: ${total}`);
    console.log(`Lag matched resolution: ${results.lagSameAsOutcome} (${winRate}%)`);
    console.log(`Lag opposite: ${results.lagDiffFromOutcome}`);
    console.log(`\nVerdict: ${winRate > 55 ? '✅ Lag has predictive power' : '❌ Lag does NOT predict resolution'}`);
    
    // Time breakdown
    console.log('\n' + '='.repeat(80));
    console.log('BY TIME REMAINING');
    console.log('='.repeat(80));
    
    const byTime = {};
    results.lagDetected.forEach(r => {
        const bucket = r.timeRemaining > 300 ? '>5min' : 
                      r.timeRemaining > 120 ? '2-5min' :
                      r.timeRemaining > 60 ? '1-2min' : '<1min';
        if (!byTime[bucket]) byTime[bucket] = { wins: 0, losses: 0 };
        if (r.lagMatchedOutcome) byTime[bucket].wins++;
        else byTime[bucket].losses++;
    });
    
    Object.entries(byTime).forEach(([bucket, data]) => {
        const t = data.wins + data.losses;
        const wr = t > 0 ? (data.wins / t * 100).toFixed(1) : 0;
        console.log(`${bucket}: ${data.wins}W / ${data.losses}L = ${wr}% WR`);
    });
    
    // Monetization
    console.log('\n' + '='.repeat(80));
    console.log('RESULTS: Can we monetize the CATCH-UP?');
    console.log('='.repeat(80));
    
    const buckets = { '<0%': 0, '0-3%': 0, '3-5%': 0, '5-10%': 0, '>10%': 0 };
    let totalImprovement = 0;
    
    results.marketCatchUp.forEach(r => {
        const pct = r.priceImprovement * 100;
        totalImprovement += pct;
        
        if (pct < 0) buckets['<0%']++;
        else if (pct < 3) buckets['0-3%']++;
        else if (pct < 5) buckets['3-5%']++;
        else if (pct < 10) buckets['5-10%']++;
        else buckets['>10%']++;
    });
    
    const avgImprovement = results.marketCatchUp.length > 0 ? 
        (totalImprovement / results.marketCatchUp.length).toFixed(2) : 0;
    
    console.log(`Average price improvement after lag: ${avgImprovement}%`);
    console.log('\nDistribution:');
    Object.entries(buckets).forEach(([b, c]) => {
        const p = results.marketCatchUp.length > 0 ? 
            (c / results.marketCatchUp.length * 100).toFixed(1) : 0;
        console.log(`  ${b}: ${c} (${p}%)`);
    });
    
    // Samples
    console.log('\n' + '='.repeat(80));
    console.log('SAMPLE SIGNALS');
    console.log('='.repeat(80));
    
    results.lagDetected.slice(0, 10).forEach(r => {
        const icon = r.lagMatchedOutcome ? '✅' : '❌';
        console.log(`${icon} ${r.crypto} | ${r.timeRemaining}s | ${r.lagDirection.toUpperCase()} @ ${r.entryPrice} | spot ${r.spotMovePct}% | max: ${r.maxPriceAfter} (+${r.priceImprovement}% in ${r.maxPriceTime}s) | resolved: ${r.resolvedSide}`);
    });
    
    // Conclusion
    console.log('\n' + '='.repeat(80));
    console.log('CONCLUSION');
    console.log('='.repeat(80));
    
    const monetizable = parseFloat(avgImprovement) >= 3;
    const predictive = parseFloat(winRate) >= 55;
    
    if (predictive && monetizable) {
        console.log('✅ Lag is BOTH predictive AND monetizable');
    } else if (predictive && !monetizable) {
        console.log('⚠️ Lag predicts resolution but catch-up too small to monetize');
        console.log('   → Must hold to resolution');
    } else if (!predictive && monetizable) {
        console.log('⚠️ Lag does NOT predict resolution, but catch-up IS monetizable');
        console.log('   → Quick TP strategies work, hold-to-resolution does not');
    } else {
        console.log('❌ Lag is NEITHER predictive NOR monetizable');
        console.log('   → SpotLag thesis may be flawed');
    }
}

analyzeLagPredictiveness().catch(console.error);
