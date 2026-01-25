#!/usr/bin/env node
/**
 * Analyze whether spot lag actually predicts:
 * 1. Resolution outcomes (does spot stay on that side?)
 * 2. Short-term market repricing (can we monetize the catch-up?)
 * 
 * THESIS TO TEST:
 * - Spot lag = spot moved but market hasn't caught up
 * - Does this predict WHERE spot will be at resolution?
 * - Does this predict short-term market price increase we can sell into?
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

async function analyzeLagPredictiveness() {
    console.log('='.repeat(80));
    console.log('SPOT LAG PREDICTIVENESS ANALYSIS');
    console.log('Testing: Does spot lag predict outcomes OR just short-term repricing?');
    console.log('='.repeat(80));
    
    // Get resolved windows with tick data
    const { data: windows, error } = await supabase
        .from('windows')
        .select('*')
        .not('resolved_outcome', 'is', null)
        .order('epoch', { ascending: false })
        .limit(200);
    
    if (error) {
        console.error('Error fetching windows:', error);
        return;
    }
    
    console.log(`\nAnalyzing ${windows.length} resolved windows...\n`);
    
    const results = {
        lagDetected: [],       // All instances where lag was detected
        lagSameAsOutcome: 0,   // Lag direction matched resolution
        lagDiffFromOutcome: 0, // Lag direction opposite to resolution
        marketCatchUp: [],     // Did market price increase after lag?
    };
    
    for (const window of windows) {
        // Get all ticks for this window
        const { data: ticks, error: tickError } = await supabase
            .from('ticks')
            .select('*')
            .eq('window_epoch', window.epoch)
            .eq('crypto', window.crypto)
            .order('timestamp_ms', { ascending: true });
        
        if (tickError || !ticks || ticks.length < 10) continue;
        
        // Analyze ticks for lag signals
        for (let i = 8; i < ticks.length - 5; i++) {  // Leave room for look-ahead
            const lookback = 8;
            const oldTick = ticks[i - lookback];
            const currentTick = ticks[i];
            
            if (!oldTick || !currentTick) continue;
            
            // Calculate spot movement
            const spotMove = (currentTick.spot_price - oldTick.spot_price) / oldTick.spot_price;
            const spotMovePct = spotMove * 100;
            
            // Calculate market movement
            const marketMove = currentTick.up_mid - oldTick.up_mid;
            
            // Spot lag threshold (0.03% like SpotLag_Fast)
            const threshold = 0.0003;
            
            if (Math.abs(spotMove) < threshold) continue;
            
            // Check market lag ratio
            const expectedMarketMove = spotMove * 10;
            const actualVsExpected = Math.abs(marketMove) / Math.abs(expectedMarketMove);
            
            if (actualVsExpected > 0.5) continue;  // Market already caught up
            
            // LAG DETECTED - now analyze what happens
            const lagDirection = spotMove > 0 ? 'up' : 'down';
            const timeRemaining = currentTick.time_remaining_sec;
            const entryPrice = lagDirection === 'up' ? currentTick.up_ask : currentTick.down_ask;
            
            // QUESTION 1: Does lag predict resolution?
            const resolvedSide = window.resolved_outcome;
            const lagMatchedOutcome = lagDirection === resolvedSide;
            
            if (lagMatchedOutcome) {
                results.lagSameAsOutcome++;
            } else {
                results.lagDiffFromOutcome++;
            }
            
            // QUESTION 2: Does market catch up in next 30s/60s/120s?
            // Look for price improvement we could sell into
            let maxPriceAfter = entryPrice;
            let maxPriceTime = 0;
            
            for (let j = i + 1; j < Math.min(i + 30, ticks.length); j++) {
                const futureTick = ticks[j];
                const futurePrice = lagDirection === 'up' ? futureTick.up_bid : futureTick.down_bid;
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
                priceImprovement: (priceImprovement * 100).toFixed(2) + '%',
                maxPriceTime: maxPriceTime.toFixed(0) + 's',
                // Resolution pnl if held
                resolutionPnl: lagMatchedOutcome ? ((1 - entryPrice) / entryPrice * 100).toFixed(1) + '%' : '-100%'
            });
            
            results.marketCatchUp.push({
                timeRemaining,
                priceImprovement,
                lagMatchedOutcome
            });
            
            // Only count one signal per window to avoid correlation
            break;
        }
    }
    
    // ANALYSIS OUTPUT
    console.log('='.repeat(80));
    console.log('RESULTS: Does spot lag predict RESOLUTION?');
    console.log('='.repeat(80));
    
    const total = results.lagSameAsOutcome + results.lagDiffFromOutcome;
    const winRate = total > 0 ? (results.lagSameAsOutcome / total * 100).toFixed(1) : 'N/A';
    
    console.log(`Total lag signals analyzed: ${total}`);
    console.log(`Lag matched resolution: ${results.lagSameAsOutcome} (${winRate}%)`);
    console.log(`Lag opposite to resolution: ${results.lagDiffFromOutcome}`);
    console.log(`\nVerdict: ${winRate > 55 ? '✅ Lag has some predictive power' : '❌ Lag does NOT predict resolution'}`);
    
    // Time-based breakdown
    console.log('\n' + '='.repeat(80));
    console.log('BREAKDOWN BY TIME REMAINING');
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
        const total = data.wins + data.losses;
        const wr = total > 0 ? (data.wins / total * 100).toFixed(1) : 0;
        console.log(`${bucket}: ${data.wins}W / ${data.losses}L = ${wr}% WR`);
    });
    
    // SHORT-TERM MONETIZATION
    console.log('\n' + '='.repeat(80));
    console.log('RESULTS: Can we monetize the CATCH-UP?');
    console.log('='.repeat(80));
    
    const improvementBuckets = {
        '<0%': 0,
        '0-3%': 0,
        '3-5%': 0,
        '5-10%': 0,
        '>10%': 0
    };
    
    let totalImprovement = 0;
    results.marketCatchUp.forEach(r => {
        const pct = r.priceImprovement * 100;
        totalImprovement += pct;
        
        if (pct < 0) improvementBuckets['<0%']++;
        else if (pct < 3) improvementBuckets['0-3%']++;
        else if (pct < 5) improvementBuckets['3-5%']++;
        else if (pct < 10) improvementBuckets['5-10%']++;
        else improvementBuckets['>10%']++;
    });
    
    const avgImprovement = results.marketCatchUp.length > 0 ? 
        (totalImprovement / results.marketCatchUp.length).toFixed(2) : 0;
    
    console.log(`Average price improvement after lag detection: ${avgImprovement}%`);
    console.log('\nDistribution of max price improvement (within 30 ticks):');
    Object.entries(improvementBuckets).forEach(([bucket, count]) => {
        const pct = results.marketCatchUp.length > 0 ? 
            (count / results.marketCatchUp.length * 100).toFixed(1) : 0;
        console.log(`  ${bucket}: ${count} (${pct}%)`);
    });
    
    // Sample trades
    console.log('\n' + '='.repeat(80));
    console.log('SAMPLE LAG SIGNALS (recent)');
    console.log('='.repeat(80));
    
    results.lagDetected.slice(0, 15).forEach(r => {
        const icon = r.lagMatchedOutcome ? '✅' : '❌';
        console.log(`${icon} ${r.crypto} | ${r.timeRemaining}s left | ${r.lagDirection.toUpperCase()} @ ${r.entryPrice} | spot ${r.spotMovePct}% | max price: ${r.maxPriceAfter} (${r.priceImprovement} in ${r.maxPriceTime}) | resolved: ${r.resolvedSide}`);
    });
    
    // CONCLUSION
    console.log('\n' + '='.repeat(80));
    console.log('CONCLUSION');
    console.log('='.repeat(80));
    
    const monetizable = parseFloat(avgImprovement) >= 3;
    const predictive = parseFloat(winRate) >= 55;
    
    if (predictive && monetizable) {
        console.log('✅ Lag is BOTH predictive of resolution AND monetizable via catch-up');
        console.log('   → Current strategies are valid');
    } else if (predictive && !monetizable) {
        console.log('⚠️ Lag predicts resolution but catch-up is too small to monetize');
        console.log('   → Must hold to resolution, no early exit opportunity');
    } else if (!predictive && monetizable) {
        console.log('⚠️ Lag does NOT predict resolution, but catch-up IS monetizable');
        console.log('   → Quick TP strategies (TP3) are valid, hold-to-resolution is not');
    } else {
        console.log('❌ Lag is NEITHER predictive NOR monetizable');
        console.log('   → SpotLag thesis may be fundamentally flawed');
    }
}

analyzeLagPredictiveness().catch(console.error);
