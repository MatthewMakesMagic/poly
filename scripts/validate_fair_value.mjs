/**
 * Validate Fair Value Model Against Historical Data
 *
 * Tests the hypothesis: Does spot price position relative to strike
 * predict market probability, and does time-to-expiry matter?
 *
 * Proper binary option fair value:
 * P(spot > strike at expiry) = Φ((ln(spot/strike) + (r - σ²/2)τ) / (σ√τ))
 *
 * Simplified heuristic currently used:
 * fairProb = 0.5 + (spotDelta / priceToBeat) * scaleFactor
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('DATABASE_URL environment variable required');
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function analyzeData() {
    console.log('Connecting to database...\n');

    // 1. Check what data we have
    const countResult = await pool.query(`
        SELECT
            COUNT(*) as total_ticks,
            COUNT(DISTINCT crypto) as cryptos,
            COUNT(DISTINCT window_epoch) as windows,
            MIN(timestamp_ms) as first_tick,
            MAX(timestamp_ms) as last_tick
        FROM ticks
        WHERE spot_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND up_mid IS NOT NULL
    `);

    const summary = countResult.rows[0];
    console.log('=== DATA SUMMARY ===');
    console.log(`Total ticks with required fields: ${parseInt(summary.total_ticks).toLocaleString()}`);
    console.log(`Cryptos: ${summary.cryptos}`);
    console.log(`Windows: ${parseInt(summary.windows).toLocaleString()}`);
    console.log(`Date range: ${new Date(parseInt(summary.first_tick)).toISOString()} to ${new Date(parseInt(summary.last_tick)).toISOString()}`);
    console.log('');

    // 2. Analyze relationship: spot_delta vs market_prob by time bucket
    console.log('=== SPOT DELTA vs MARKET PROBABILITY by TIME REMAINING ===');
    console.log('Testing if market prices time correctly...\n');

    const timeBucketAnalysis = await pool.query(`
        WITH tick_analysis AS (
            SELECT
                crypto,
                time_remaining_sec,
                spot_price,
                price_to_beat,
                up_mid as market_prob,
                (spot_price - price_to_beat) / NULLIF(price_to_beat, 0) * 100 as spot_delta_pct,
                CASE
                    WHEN time_remaining_sec > 600 THEN '10+ min'
                    WHEN time_remaining_sec > 300 THEN '5-10 min'
                    WHEN time_remaining_sec > 120 THEN '2-5 min'
                    WHEN time_remaining_sec > 60 THEN '1-2 min'
                    WHEN time_remaining_sec > 30 THEN '30-60s'
                    ELSE '<30s'
                END as time_bucket,
                CASE
                    WHEN (spot_price - price_to_beat) / NULLIF(price_to_beat, 0) * 100 > 0.1 THEN 'spot_above'
                    WHEN (spot_price - price_to_beat) / NULLIF(price_to_beat, 0) * 100 < -0.1 THEN 'spot_below'
                    ELSE 'spot_at_strike'
                END as spot_position
            FROM ticks
            WHERE spot_price IS NOT NULL
              AND price_to_beat IS NOT NULL
              AND up_mid IS NOT NULL
              AND time_remaining_sec > 0
              AND timestamp_ms > $1
        )
        SELECT
            time_bucket,
            spot_position,
            COUNT(*) as n,
            ROUND(AVG(market_prob)::numeric, 4) as avg_market_prob,
            ROUND(AVG(spot_delta_pct)::numeric, 4) as avg_spot_delta_pct,
            ROUND(STDDEV(market_prob)::numeric, 4) as std_market_prob
        FROM tick_analysis
        GROUP BY time_bucket, spot_position
        ORDER BY
            CASE time_bucket
                WHEN '10+ min' THEN 1
                WHEN '5-10 min' THEN 2
                WHEN '2-5 min' THEN 3
                WHEN '1-2 min' THEN 4
                WHEN '30-60s' THEN 5
                WHEN '<30s' THEN 6
            END,
            spot_position
    `, [Date.now() - 48 * 60 * 60 * 1000]); // Last 48 hours

    console.log('Time Bucket    | Spot Position   | N        | Avg Mkt Prob | Avg Spot Δ% | Std Dev');
    console.log('---------------|-----------------|----------|--------------|-------------|--------');
    for (const row of timeBucketAnalysis.rows) {
        console.log(
            `${row.time_bucket.padEnd(14)} | ${row.spot_position.padEnd(15)} | ${row.n.toString().padStart(8)} | ${row.avg_market_prob.toString().padStart(12)} | ${row.avg_spot_delta_pct.toString().padStart(11)} | ${row.std_market_prob}`
        );
    }
    console.log('');

    // 3. Key question: Does market probability CONVERGE as time decreases?
    console.log('=== PROBABILITY CONVERGENCE by TIME ===');
    console.log('If market prices time correctly, variance should decrease as expiry approaches...\n');

    const convergenceAnalysis = await pool.query(`
        WITH tick_analysis AS (
            SELECT
                time_remaining_sec,
                up_mid as market_prob,
                (spot_price - price_to_beat) / NULLIF(price_to_beat, 0) * 100 as spot_delta_pct,
                CASE
                    WHEN time_remaining_sec > 600 THEN '10+ min'
                    WHEN time_remaining_sec > 300 THEN '5-10 min'
                    WHEN time_remaining_sec > 120 THEN '2-5 min'
                    WHEN time_remaining_sec > 60 THEN '1-2 min'
                    WHEN time_remaining_sec > 30 THEN '30-60s'
                    ELSE '<30s'
                END as time_bucket
            FROM ticks
            WHERE spot_price IS NOT NULL
              AND price_to_beat IS NOT NULL
              AND up_mid IS NOT NULL
              AND time_remaining_sec > 0
              AND timestamp_ms > $1
        )
        SELECT
            time_bucket,
            COUNT(*) as n,
            ROUND(AVG(market_prob)::numeric, 4) as avg_prob,
            ROUND(STDDEV(market_prob)::numeric, 4) as std_prob,
            ROUND(MIN(market_prob)::numeric, 4) as min_prob,
            ROUND(MAX(market_prob)::numeric, 4) as max_prob,
            ROUND(PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY market_prob)::numeric, 4) as p10,
            ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY market_prob)::numeric, 4) as p90
        FROM tick_analysis
        GROUP BY time_bucket
        ORDER BY
            CASE time_bucket
                WHEN '10+ min' THEN 1
                WHEN '5-10 min' THEN 2
                WHEN '2-5 min' THEN 3
                WHEN '1-2 min' THEN 4
                WHEN '30-60s' THEN 5
                WHEN '<30s' THEN 6
            END
    `, [Date.now() - 48 * 60 * 60 * 1000]);

    console.log('Time Bucket    | N        | Avg Prob | Std Dev | Min   | Max   | P10   | P90');
    console.log('---------------|----------|----------|---------|-------|-------|-------|------');
    for (const row of convergenceAnalysis.rows) {
        console.log(
            `${row.time_bucket.padEnd(14)} | ${row.n.toString().padStart(8)} | ${row.avg_prob.toString().padStart(8)} | ${row.std_prob.toString().padStart(7)} | ${row.min_prob} | ${row.max_prob} | ${row.p10} | ${row.p90}`
        );
    }
    console.log('');

    // 4. Resolution analysis: What actually happened?
    console.log('=== RESOLUTION ACCURACY ===');
    console.log('When spot was above/below strike in final minute, what was the outcome?\n');

    const resolutionAnalysis = await pool.query(`
        WITH final_ticks AS (
            SELECT DISTINCT ON (crypto, window_epoch)
                crypto,
                window_epoch,
                spot_price,
                price_to_beat,
                up_mid as final_market_prob,
                (spot_price - price_to_beat) / NULLIF(price_to_beat, 0) * 100 as final_spot_delta_pct,
                CASE
                    WHEN spot_price > price_to_beat THEN 'spot_above'
                    WHEN spot_price < price_to_beat THEN 'spot_below'
                    ELSE 'spot_at_strike'
                END as final_spot_position
            FROM ticks
            WHERE spot_price IS NOT NULL
              AND price_to_beat IS NOT NULL
              AND up_mid IS NOT NULL
              AND time_remaining_sec BETWEEN 1 AND 30
              AND timestamp_ms > $1
            ORDER BY crypto, window_epoch, time_remaining_sec ASC
        ),
        with_outcomes AS (
            SELECT
                ft.*,
                w.outcome
            FROM final_ticks ft
            LEFT JOIN windows w ON ft.crypto = w.crypto AND ft.window_epoch = w.epoch
            WHERE w.outcome IS NOT NULL
        )
        SELECT
            final_spot_position,
            outcome,
            COUNT(*) as n,
            ROUND(AVG(final_market_prob)::numeric, 4) as avg_final_prob,
            ROUND(AVG(ABS(final_spot_delta_pct))::numeric, 4) as avg_spot_delta_pct
        FROM with_outcomes
        GROUP BY final_spot_position, outcome
        ORDER BY final_spot_position, outcome
    `, [Date.now() - 48 * 60 * 60 * 1000]);

    console.log('Final Spot Position | Outcome | N      | Avg Final Prob | Avg |Spot Δ%|');
    console.log('--------------------|---------|--------|----------------|-------------');
    for (const row of resolutionAnalysis.rows) {
        console.log(
            `${row.final_spot_position.padEnd(19)} | ${row.outcome.padEnd(7)} | ${row.n.toString().padStart(6)} | ${row.avg_final_prob.toString().padStart(14)} | ${row.avg_spot_delta_pct}`
        );
    }
    console.log('');

    // 5. Calculate what fair value SHOULD have been vs what market showed
    console.log('=== FAIR VALUE MODEL VALIDATION ===');
    console.log('Comparing naive fair value vs market price vs actual outcome...\n');

    const fairValueValidation = await pool.query(`
        WITH final_ticks AS (
            SELECT DISTINCT ON (crypto, window_epoch)
                crypto,
                window_epoch,
                spot_price,
                price_to_beat,
                up_mid as market_prob,
                time_remaining_sec,
                -- Naive fair value: 0.5 + (spotDelta / strike) * scaleFactor
                -- Using scaleFactor = 50 (common in codebase)
                0.5 + ((spot_price - price_to_beat) / NULLIF(price_to_beat, 0)) * 50 as naive_fair_value
            FROM ticks
            WHERE spot_price IS NOT NULL
              AND price_to_beat IS NOT NULL
              AND up_mid IS NOT NULL
              AND time_remaining_sec BETWEEN 1 AND 60
              AND timestamp_ms > $1
            ORDER BY crypto, window_epoch, time_remaining_sec ASC
        ),
        with_outcomes AS (
            SELECT
                ft.*,
                w.outcome,
                CASE WHEN w.outcome = 'up' THEN 1 ELSE 0 END as actual_up
            FROM final_ticks ft
            LEFT JOIN windows w ON ft.crypto = w.crypto AND ft.window_epoch = w.epoch
            WHERE w.outcome IS NOT NULL
        )
        SELECT
            COUNT(*) as total_windows,
            -- Market prediction accuracy
            SUM(CASE WHEN (market_prob >= 0.5 AND outcome = 'up') OR (market_prob < 0.5 AND outcome = 'down') THEN 1 ELSE 0 END) as market_correct,
            -- Naive fair value prediction accuracy
            SUM(CASE WHEN (naive_fair_value >= 0.5 AND outcome = 'up') OR (naive_fair_value < 0.5 AND outcome = 'down') THEN 1 ELSE 0 END) as naive_fv_correct,
            -- Spot-based prediction accuracy (simple: spot > strike = up)
            SUM(CASE WHEN (spot_price > price_to_beat AND outcome = 'up') OR (spot_price < price_to_beat AND outcome = 'down') THEN 1 ELSE 0 END) as spot_correct,
            -- Calibration: How well does market_prob match actual_up rate?
            ROUND(AVG(market_prob)::numeric, 4) as avg_market_prob,
            ROUND(AVG(actual_up)::numeric, 4) as actual_up_rate,
            ROUND(AVG(ABS(market_prob - actual_up))::numeric, 4) as avg_calibration_error
        FROM with_outcomes
    `, [Date.now() - 48 * 60 * 60 * 1000]);

    const fv = fairValueValidation.rows[0];
    console.log(`Total resolved windows (last 48h): ${fv.total_windows}`);
    console.log(`Market prediction accuracy: ${fv.market_correct}/${fv.total_windows} (${(fv.market_correct/fv.total_windows*100).toFixed(1)}%)`);
    console.log(`Naive fair value accuracy: ${fv.naive_fv_correct}/${fv.total_windows} (${(fv.naive_fv_correct/fv.total_windows*100).toFixed(1)}%)`);
    console.log(`Spot-based (simple) accuracy: ${fv.spot_correct}/${fv.total_windows} (${(fv.spot_correct/fv.total_windows*100).toFixed(1)}%)`);
    console.log(`\nCalibration check:`);
    console.log(`  Avg market probability: ${fv.avg_market_prob}`);
    console.log(`  Actual 'up' rate: ${fv.actual_up_rate}`);
    console.log(`  Avg calibration error: ${fv.avg_calibration_error}`);
    console.log('');

    // 6. Check data per crypto
    console.log('=== DATA BY CRYPTO ===\n');

    const cryptoBreakdown = await pool.query(`
        SELECT
            crypto,
            COUNT(*) as tick_count,
            COUNT(DISTINCT window_epoch) as window_count,
            ROUND(AVG(up_mid)::numeric, 4) as avg_market_prob,
            ROUND(STDDEV(up_mid)::numeric, 4) as std_market_prob
        FROM ticks
        WHERE spot_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND up_mid IS NOT NULL
          AND timestamp_ms > $1
        GROUP BY crypto
        ORDER BY tick_count DESC
    `, [Date.now() - 48 * 60 * 60 * 1000]);

    console.log('Crypto | Ticks      | Windows | Avg Prob | Std Dev');
    console.log('-------|------------|---------|----------|--------');
    for (const row of cryptoBreakdown.rows) {
        console.log(
            `${row.crypto.padEnd(6)} | ${row.tick_count.toString().padStart(10)} | ${row.window_count.toString().padStart(7)} | ${row.avg_market_prob} | ${row.std_market_prob}`
        );
    }

    await pool.end();
    console.log('\n=== ANALYSIS COMPLETE ===');
}

analyzeData().catch(console.error);
