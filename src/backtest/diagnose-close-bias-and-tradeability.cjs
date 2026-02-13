/**
 * diagnose-close-bias-and-tradeability.cjs
 *
 * Part A: Investigates the +$45 close-time bias between exchange prices and CL.
 *   - Compares exchange composites vs ACTUAL CL (from rtds_ticks) at both open and close
 *   - Tests whether CL uses a longer VWAP lookback by computing exchange averages over
 *     different periods (15min, 30min, 1hr, 2hr) and checking which matches CL best
 *   - Correlates bias with market direction
 *
 * Part B: Tradeability analysis of >$100 CL move windows (100% direction accuracy).
 *   - Looks at CLOB prices at various times before close
 *   - Computes theoretical P&L
 *   - Assesses whether there's actual money to be made
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/diagnose-close-bias-and-tradeability.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 600000,
});

async function query(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

function fmt(n, d = 2) { return n.toFixed(d); }

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function mean(arr) {
  if (arr.length === 0) return null;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(s.length * p / 100);
  return s[Math.min(idx, s.length - 1)];
}

// ── Data loading ──────────────────────────────────────────────────────────

async function loadWindows() {
  const rows = await query(`
    SELECT symbol, window_close_time, strike_price,
           oracle_price_at_close, resolved_direction
    FROM window_close_events
    WHERE symbol = 'btc'
      AND strike_price IS NOT NULL
      AND oracle_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  return rows.map(r => {
    const clClose = parseFloat(r.oracle_price_at_close);
    const strike = parseFloat(r.strike_price);
    const direction = r.resolved_direction
      ? r.resolved_direction.toLowerCase()
      : (clClose >= strike ? 'up' : 'down');
    const closeEpoch = Math.floor(new Date(r.window_close_time).getTime() / 1000);
    return {
      close_epoch: closeEpoch,
      open_epoch: closeEpoch - 900,
      strike_price: strike,
      cl_close: clClose,
      actual_direction: direction,
    };
  });
}

// Get actual CL price at a specific epoch from rtds_ticks
async function batchLoadCLPrices(epochs) {
  console.log(`  Loading CL prices for ${epochs.length} timestamps...`);
  const t0 = Date.now();
  const rows = await query(`
    SELECT target_epoch, r.price, r.timestamp
    FROM unnest($1::bigint[]) AS target_epoch
    CROSS JOIN LATERAL (
      SELECT price, timestamp
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink'
        AND symbol = 'btc'
        AND timestamp BETWEEN to_timestamp(target_epoch::numeric - 3) AND to_timestamp(target_epoch::numeric + 3)
      ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - target_epoch::numeric)
      LIMIT 1
    ) r
  `, [epochs]);

  const result = new Map();
  for (const r of rows) {
    result.set(parseInt(r.target_epoch), parseFloat(r.price));
  }
  console.log(`  Got ${result.size} CL prices in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

// Get exchange median/mean over a lookback period ending at a specific epoch
async function computeExchangeAverages(epoch, lookbackSeconds) {
  const rows = await query(`
    SELECT exchange, AVG(price) as avg_price, COUNT(*) as n_ticks
    FROM exchange_ticks
    WHERE symbol = 'btc'
      AND timestamp BETWEEN to_timestamp($1::numeric - $2::numeric) AND to_timestamp($1::numeric)
    GROUP BY exchange
  `, [epoch, lookbackSeconds]);

  const prices = rows.map(r => parseFloat(r.avg_price));
  if (prices.length === 0) return null;
  return {
    median: median(prices),
    mean: mean(prices),
    n_exchanges: prices.length,
    n_ticks: rows.reduce((s, r) => s + parseInt(r.n_ticks), 0),
  };
}

// Batch version: compute exchange composites for many epochs at different lookbacks
async function batchExchangeComposites(epochs, lookbackSeconds) {
  console.log(`  Loading exchange composites (lookback=${lookbackSeconds}s) for ${epochs.length} timestamps...`);
  const t0 = Date.now();

  const rows = await query(`
    SELECT target_epoch, exchange, AVG(price) as avg_price, COUNT(*) as n_ticks
    FROM unnest($1::bigint[]) AS target_epoch
    CROSS JOIN LATERAL (
      SELECT exchange, price
      FROM exchange_ticks
      WHERE symbol = 'btc'
        AND timestamp BETWEEN to_timestamp(target_epoch::numeric - $2::numeric)
                         AND to_timestamp(target_epoch::numeric)
    ) t
    GROUP BY target_epoch, exchange
  `, [epochs, lookbackSeconds]);

  const result = new Map();
  for (const r of rows) {
    const ep = parseInt(r.target_epoch);
    if (!result.has(ep)) result.set(ep, []);
    result.get(ep).push(parseFloat(r.avg_price));
  }

  // Convert arrays to composites
  const composites = new Map();
  for (const [ep, prices] of result) {
    composites.set(ep, {
      median: median(prices),
      mean: mean(prices),
      n_exchanges: prices.length,
    });
  }

  console.log(`  Got ${composites.size} composites in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return composites;
}

// Get spot exchange prices (most recent tick) at a specific epoch
async function batchExchangeSpot(epochs) {
  console.log(`  Loading exchange spot prices for ${epochs.length} timestamps...`);
  const t0 = Date.now();

  const rows = await query(`
    SELECT target_epoch, e.exchange, e.price
    FROM unnest($1::bigint[]) AS target_epoch
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (exchange) exchange, price
      FROM exchange_ticks
      WHERE symbol = 'btc'
        AND timestamp BETWEEN to_timestamp(target_epoch::numeric - 5) AND to_timestamp(target_epoch::numeric + 2)
      ORDER BY exchange, ABS(EXTRACT(EPOCH FROM timestamp) - target_epoch::numeric)
    ) e
  `, [epochs]);

  const result = new Map();
  for (const r of rows) {
    const ep = parseInt(r.target_epoch);
    if (!result.has(ep)) result.set(ep, []);
    result.get(ep).push(parseFloat(r.price));
  }

  const composites = new Map();
  for (const [ep, prices] of result) {
    composites.set(ep, { median: median(prices), mean: mean(prices), n: prices.length });
  }

  console.log(`  Got ${composites.size} spot composites in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return composites;
}

// Load CLOB prices at specific offsets before close
async function loadCLOBAtOffsets(windows, offsetsMs) {
  console.log(`  Loading CLOB prices at ${offsetsMs.length} offsets for ${windows.length} windows...`);
  const t0 = Date.now();

  const result = new Map(); // close_epoch → { offset → { up_mid, down_mid } }

  for (const w of windows) {
    const windowEpoch = w.open_epoch; // window_epoch = open time
    const data = {};

    for (const offsetMs of offsetsMs) {
      const targetEpoch = w.close_epoch - offsetMs / 1000;

      const rows = await query(`
        SELECT symbol, mid_price
        FROM clob_price_snapshots
        WHERE window_epoch = $1
          AND timestamp >= to_timestamp($1::numeric)
          AND timestamp <= to_timestamp($2::numeric + 2)
          AND symbol IN ('btc-up', 'btc-down')
        ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - $2::numeric)
        LIMIT 2
      `, [windowEpoch, targetEpoch]);

      const prices = {};
      for (const r of rows) {
        prices[r.symbol] = parseFloat(r.mid_price);
      }
      data[offsetMs] = prices;
    }

    result.set(w.close_epoch, data);
  }

  console.log(`  Loaded CLOB data in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║    Close-Time Bias Investigation & Tradeability Analysis            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // 1. Load windows
  console.log('\n── Loading data ──');
  const windows = await loadWindows();
  console.log(`  ${windows.length} resolved BTC windows`);

  // 2. Get actual CL prices at both open and close from rtds_ticks
  const allOpenEpochs = windows.map(w => w.open_epoch);
  const allCloseEpochs = windows.map(w => w.close_epoch);
  const allEpochs = [...new Set([...allOpenEpochs, ...allCloseEpochs])];
  const clPrices = await batchLoadCLPrices(allEpochs);

  // 3. Get exchange spot prices at open and close
  const spotPrices = await batchExchangeSpot(allEpochs);

  // ══════════════════════════════════════════════════════════════════════
  // PART A: Close-time bias investigation
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('PART A: Close-Time Bias — Exchange Spot vs Actual CL');
  console.log('  (Comparing exchange SPOT prices to CL from rtds_ticks)');
  console.log('='.repeat(70));

  let biasOpenSum = 0, biasCloseSum = 0, biasOpenN = 0, biasCloseN = 0;
  const biasOpenArr = [], biasCloseArr = [];
  const windowDetails = [];

  for (const w of windows) {
    const clOpen = clPrices.get(w.open_epoch);
    const clClose = clPrices.get(w.close_epoch);
    const spotOpen = spotPrices.get(w.open_epoch);
    const spotClose = spotPrices.get(w.close_epoch);

    if (!clOpen || !clClose || !spotOpen || !spotClose) continue;

    const biasOpen = spotOpen.median - clOpen;
    const biasClose = spotClose.median - clClose;

    biasOpenArr.push(biasOpen);
    biasCloseArr.push(biasClose);
    biasOpenSum += biasOpen;
    biasCloseSum += biasClose;
    biasOpenN++;
    biasCloseN++;

    // Also compute CL move for later analysis
    const clMove = clClose - clOpen;
    const spotMove = spotClose.median - spotOpen.median;

    windowDetails.push({
      ...w,
      cl_open_actual: clOpen,
      cl_close_actual: clClose,
      cl_move: clMove,
      cl_move_abs: Math.abs(clMove),
      spot_open: spotOpen.median,
      spot_close: spotClose.median,
      spot_move: spotMove,
      bias_open: biasOpen,
      bias_close: biasClose,
      actual_direction: clMove >= 0 ? 'up' : 'down', // re-derive from actual CL
    });
  }

  console.log(`\n  Analyzed ${biasOpenN} windows with both CL and exchange data`);
  console.log(`\n  Bias at OPEN (exchange spot - CL):`);
  console.log(`    Mean:    ${biasOpenSum / biasOpenN >= 0 ? '+' : ''}$${fmt(biasOpenSum / biasOpenN)}`);
  console.log(`    Median:  ${median(biasOpenArr) >= 0 ? '+' : ''}$${fmt(median(biasOpenArr))}`);
  console.log(`    P10-P90: $${fmt(percentile(biasOpenArr, 10))} to $${fmt(percentile(biasOpenArr, 90))}`);

  console.log(`\n  Bias at CLOSE (exchange spot - CL):`);
  console.log(`    Mean:    ${biasCloseSum / biasCloseN >= 0 ? '+' : ''}$${fmt(biasCloseSum / biasCloseN)}`);
  console.log(`    Median:  ${median(biasCloseArr) >= 0 ? '+' : ''}$${fmt(median(biasCloseArr))}`);
  console.log(`    P10-P90: $${fmt(percentile(biasCloseArr, 10))} to $${fmt(percentile(biasCloseArr, 90))}`);

  // Check: is strike_price ≈ CL@open or different?
  console.log(`\n  Strike price vs CL@open (is strike = CL or PolyRef?):`);
  let strikeDiffSum = 0, strikeDiffN = 0;
  for (const w of windowDetails) {
    const diff = w.strike_price - w.cl_open_actual;
    strikeDiffSum += diff;
    strikeDiffN++;
  }
  console.log(`    Mean diff (strike - CL@open): $${fmt(strikeDiffSum / strikeDiffN)}`);
  console.log(`    (Positive = strike above CL, meaning strike ≈ exchange spot, not CL)`);

  // ── Bias vs market direction ──
  console.log('\n── Bias correlated with market direction ──');
  const upWindows = windowDetails.filter(w => w.actual_direction === 'up');
  const downWindows = windowDetails.filter(w => w.actual_direction === 'down');

  const upBiasClose = upWindows.length > 0 ? mean(upWindows.map(w => w.bias_close)) : 0;
  const downBiasClose = downWindows.length > 0 ? mean(downWindows.map(w => w.bias_close)) : 0;

  console.log(`  UP windows (${upWindows.length}):   avg close bias = ${upBiasClose >= 0 ? '+' : ''}$${fmt(upBiasClose)}`);
  console.log(`  DOWN windows (${downWindows.length}): avg close bias = ${downBiasClose >= 0 ? '+' : ''}$${fmt(downBiasClose)}`);
  console.log(`  (If bias is higher in DOWN windows, CL's VWAP drags during declines)`);

  // ══════════════════════════════════════════════════════════════════════
  // PART A2: VWAP lookback period sweep
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('PART A2: VWAP Lookback Period Sweep');
  console.log('  Which lookback period best matches CL at close?');
  console.log('='.repeat(70));

  const lookbacks = [10, 30, 60, 300, 900, 1800, 3600, 7200];
  const lookbackLabels = ['10s', '30s', '1min', '5min', '15min', '30min', '1hr', '2hr'];

  // Only use windows where we have enough history (skip first 2hr worth)
  const firstEpoch = windows[0].open_epoch;
  const eligibleCloseEpochs = allCloseEpochs.filter(ep => ep - firstEpoch > 7200);
  console.log(`  Testing ${eligibleCloseEpochs.length} windows (excluding first 2hr for lookback coverage)`);

  console.log(`\n  Lookback | Bias (med-CL)  | MAE vs CL   | Direction Acc | Windows`);
  console.log(`  ---------+----------------+-------------+---------------+--------`);

  for (let i = 0; i < lookbacks.length; i++) {
    const lb = lookbacks[i];
    const label = lookbackLabels[i];

    const composites = await batchExchangeComposites(eligibleCloseEpochs, lb);

    let sumBias = 0, sumAbsErr = 0, correct = 0, total = 0;

    for (const w of windowDetails) {
      if (w.close_epoch - firstEpoch <= 7200) continue;

      const comp = composites.get(w.close_epoch);
      const clClose = clPrices.get(w.close_epoch);
      if (!comp || !clClose) continue;

      // Compare lookback-averaged exchange price to CL at close
      const bias = comp.median - clClose;
      sumBias += bias;
      sumAbsErr += Math.abs(bias);

      // For direction: compute exchange avg at open too
      // (For longer lookbacks, the "open" average also needs the same lookback)
      // But for now, just measure price-level accuracy at close
      total++;
    }

    if (total > 0) {
      const avgBias = sumBias / total;
      const mae = sumAbsErr / total;
      console.log(`  ${label.padEnd(8)} | ${avgBias >= 0 ? '+' : ''}$${fmt(avgBias).padStart(11)} | $${fmt(mae).padStart(9)} | ${'(see below)'.padStart(13)} | ${total}`);
    }
  }

  // ── Now test direction accuracy with matched lookback at open AND close ──
  console.log('\n── Direction accuracy with matched lookback at open AND close ──');
  console.log(`  (VWAP at open uses same lookback as VWAP at close)`);

  const testLookbacks = [10, 60, 300, 900, 1800, 3600];
  const testLabels = ['10s (spot)', '1min', '5min', '15min', '30min', '1hr'];

  // Need both open and close epochs for these
  const eligibleWindows = windowDetails.filter(w => w.open_epoch - firstEpoch > 7200);
  const eligibleOpenEpochs = eligibleWindows.map(w => w.open_epoch);
  const eligibleCloseEpochs2 = eligibleWindows.map(w => w.close_epoch);

  console.log(`\n  Lookback | Dir Acc  | Errors | Errors on <$50 | Errors on >$100`);
  console.log(`  ---------+----------+--------+----------------+----------------`);

  for (let i = 0; i < testLookbacks.length; i++) {
    const lb = testLookbacks[i];
    const label = testLabels[i];

    const openComps = await batchExchangeComposites(eligibleOpenEpochs, lb);
    const closeComps = await batchExchangeComposites(eligibleCloseEpochs2, lb);

    let correct = 0, total = 0, errorsSmall = 0, errorsLarge = 0;

    for (const w of eligibleWindows) {
      const oc = openComps.get(w.open_epoch);
      const cc = closeComps.get(w.close_epoch);
      if (!oc || !cc) continue;

      const predMove = cc.median - oc.median;
      const predDir = predMove >= 0 ? 'up' : 'down';
      const actualDir = w.actual_direction;

      if (predDir === actualDir) {
        correct++;
      } else {
        if (w.cl_move_abs < 50) errorsSmall++;
        if (w.cl_move_abs >= 100) errorsLarge++;
      }
      total++;
    }

    const errors = total - correct;
    const acc = (correct / total * 100).toFixed(1);
    console.log(`  ${label.padEnd(9)}| ${acc.padStart(5)}%  | ${String(errors).padStart(6)} | ${String(errorsSmall).padStart(14)} | ${String(errorsLarge).padStart(14)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PART B: Tradeability of >$100 CL move windows
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('PART B: Tradeability — Can We Profit on Large CL Move Windows?');
  console.log('  Windows where |CL move| > $100 (100% direction accuracy)');
  console.log('='.repeat(70));

  const largeMoveWindows = windowDetails.filter(w => w.cl_move_abs >= 100);
  console.log(`  ${largeMoveWindows.length} windows with |CL move| > $100`);

  // Load CLOB prices at various offsets before close
  const offsets = [300000, 120000, 60000, 30000, 10000, 5000, 1000]; // ms before close
  const offsetLabels = ['5min', '2min', '60s', '30s', '10s', '5s', '1s'];
  const clobData = await loadCLOBAtOffsets(largeMoveWindows, offsets);

  console.log(`\n  Analysis: What was the CLOB pricing for the CORRECT direction at various times before close?`);
  console.log(`  (We need to buy below ~$0.90 to have positive EV after fees)\n`);

  // Per-offset statistics
  console.log(`  Offset | Avg Price | Median   | P10      | P90      | Avg PnL/contract | % < $0.85`);
  console.log(`  -------+-----------+----------+----------+----------+------------------+----------`);

  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    const label = offsetLabels[i];
    const prices = [];

    for (const w of largeMoveWindows) {
      const clobAtOffset = clobData.get(w.close_epoch);
      if (!clobAtOffset || !clobAtOffset[offset]) continue;

      const correctSide = w.actual_direction === 'up' ? 'btc-up' : 'btc-down';
      const price = clobAtOffset[offset][correctSide];
      if (price != null && price > 0.01 && price < 0.99) {
        prices.push(price);
      }
    }

    if (prices.length === 0) {
      console.log(`  ${label.padEnd(6)} | no data`);
      continue;
    }

    const avgPrice = mean(prices);
    const medPrice = median(prices);
    const p10 = percentile(prices, 10);
    const p90 = percentile(prices, 90);
    const avgPnl = mean(prices.map(p => 1.0 - p)); // payout $1, cost = price
    const pctBelow85 = (prices.filter(p => p < 0.85).length / prices.length * 100);

    console.log(`  ${label.padEnd(6)} | $${fmt(avgPrice, 3).padStart(7)} | $${fmt(medPrice, 3).padStart(6)} | $${fmt(p10, 3).padStart(6)} | $${fmt(p90, 3).padStart(6)} | $${fmt(avgPnl, 3).padStart(16)} | ${fmt(pctBelow85, 1).padStart(6)}%`);
  }

  // Detailed per-window view for a subset
  console.log(`\n── Per-window detail (largest moves) ──`);
  const topWindows = [...largeMoveWindows].sort((a, b) => b.cl_move_abs - a.cl_move_abs).slice(0, 20);

  console.log(`  ${'Time (UTC)'.padEnd(20)}| Dir  | CL Move    | CLOB@5min | CLOB@60s  | CLOB@10s  | CLOB@1s   | EV@60s`);
  console.log(`  ${'-'.repeat(20)}+------+------------+-----------+-----------+-----------+-----------+-------`);

  for (const w of topWindows) {
    const clob = clobData.get(w.close_epoch);
    const correctSide = w.actual_direction === 'up' ? 'btc-up' : 'btc-down';

    const time = new Date(w.close_epoch * 1000).toISOString().slice(5, 19);
    const clMoveStr = (w.cl_move >= 0 ? '+' : '') + fmt(w.cl_move, 0);

    const getPrice = (offsetMs) => {
      if (!clob || !clob[offsetMs] || !clob[offsetMs][correctSide]) return '   N/A';
      return '$' + fmt(clob[offsetMs][correctSide], 3);
    };

    const ev60 = clob && clob[60000] && clob[60000][correctSide]
      ? fmt(1.0 - clob[60000][correctSide], 3)
      : '  N/A';

    console.log(`  ${time.padEnd(20)}| ${w.actual_direction.padEnd(4)} | $${clMoveStr.padStart(9)}| ${getPrice(300000).padStart(9)} | ${getPrice(60000).padStart(9)} | ${getPrice(10000).padStart(9)} | ${getPrice(1000).padStart(9)} | $${ev60}`);
  }

  // ── Summary statistics ──
  console.log('\n── Tradeability Summary ──');

  // Count windows where we could buy below various thresholds at T-60s
  const thresholds = [0.70, 0.75, 0.80, 0.85, 0.90];
  console.log(`\n  Buy threshold at T-60s:`);
  for (const threshold of thresholds) {
    let count = 0;
    let totalPnl = 0;

    for (const w of largeMoveWindows) {
      const clob = clobData.get(w.close_epoch);
      const correctSide = w.actual_direction === 'up' ? 'btc-up' : 'btc-down';
      if (!clob || !clob[60000] || !clob[60000][correctSide]) continue;

      const price = clob[60000][correctSide];
      if (price <= threshold) {
        count++;
        totalPnl += (1.0 - price); // gross profit per contract
      }
    }

    const avgPnl = count > 0 ? totalPnl / count : 0;
    console.log(`    Buy < $${fmt(threshold, 2)}: ${count}/${largeMoveWindows.length} windows (${fmt(count / largeMoveWindows.length * 100, 1)}%), avg gross profit: $${fmt(avgPnl, 3)}/contract`);
  }

  // Same for T-30s
  console.log(`\n  Buy threshold at T-30s:`);
  for (const threshold of thresholds) {
    let count = 0;
    let totalPnl = 0;

    for (const w of largeMoveWindows) {
      const clob = clobData.get(w.close_epoch);
      const correctSide = w.actual_direction === 'up' ? 'btc-up' : 'btc-down';
      if (!clob || !clob[30000] || !clob[30000][correctSide]) continue;

      const price = clob[30000][correctSide];
      if (price <= threshold) {
        count++;
        totalPnl += (1.0 - price);
      }
    }

    const avgPnl = count > 0 ? totalPnl / count : 0;
    console.log(`    Buy < $${fmt(threshold, 2)}: ${count}/${largeMoveWindows.length} windows (${fmt(count / largeMoveWindows.length * 100, 1)}%), avg gross profit: $${fmt(avgPnl, 3)}/contract`);
  }

  console.log('\n' + '='.repeat(70));
  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
