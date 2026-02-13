/**
 * diagnose-prediction-error.cjs
 *
 * Measures how well different exchange composites predict actual Chainlink
 * oracle prices at window open and close, in absolute dollars.
 *
 * Key question: Are direction-prediction errors concentrated in small CL moves?
 * If CL moves <$50 account for all the errors, our predictor is at ceiling
 * for meaningful moves and the 12% error rate is just noise.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/diagnose-prediction-error.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300000,
});

async function query(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── Composite methods ─────────────────────────────────────────────────────

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(arr) {
  if (arr.length === 0) return null;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function excludeOutliersMedian(arr, threshold = 0.001) {
  if (arr.length < 3) return median(arr);
  const med = median(arr);
  const filtered = arr.filter(v => Math.abs(v - med) / med <= threshold);
  return filtered.length > 0 ? median(filtered) : med;
}

// Oracle-proximity weighting: Coinbase & Kraken track closest to CL
// from earlier diagnostics. Weight: CB=3, Kraken=3, Binance=2, Bybit=1, OKX=1
const PROXIMITY_WEIGHTS = {
  coinbaseexchange: 3,
  kraken: 3,
  binance: 2,
  bybit: 1,
  okx: 1,
};

function oracleProximityWeighted(prices) {
  // prices = { exchange: price }
  let weightedSum = 0, totalWeight = 0;
  for (const [ex, price] of Object.entries(prices)) {
    const w = PROXIMITY_WEIGHTS[ex] || 1;
    weightedSum += price * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

const EXCHANGES = ['binance', 'coinbaseexchange', 'kraken', 'bybit', 'okx'];

// ── Data loading ──────────────────────────────────────────────────────────

async function loadWindows(symbol) {
  const rows = await query(`
    SELECT symbol, window_close_time, strike_price,
           oracle_price_at_close, resolved_direction
    FROM window_close_events
    WHERE symbol = $1
      AND strike_price IS NOT NULL
      AND oracle_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `, [symbol]);

  return rows.map(r => {
    const clOpen = parseFloat(r.strike_price);
    const clClose = parseFloat(r.oracle_price_at_close);
    const direction = r.resolved_direction
      ? r.resolved_direction.toLowerCase()
      : (clClose >= clOpen ? 'up' : 'down');
    return {
      close_epoch: Math.floor(new Date(r.window_close_time).getTime() / 1000),
      open_epoch: Math.floor(new Date(r.window_close_time).getTime() / 1000) - 900,
      cl_open: clOpen,
      cl_close: clClose,
      cl_move: clClose - clOpen,
      actual_direction: direction,
    };
  });
}

async function getExchangePricesAtEpoch(symbol, epoch) {
  // Get closest price within 5s for each exchange
  const prices = {};
  const rows = await query(`
    SELECT DISTINCT ON (exchange) exchange, price
    FROM exchange_ticks
    WHERE symbol = $1
      AND exchange = ANY($2)
      AND timestamp BETWEEN to_timestamp($3::numeric - 5) AND to_timestamp($3::numeric + 5)
    ORDER BY exchange, ABS(EXTRACT(EPOCH FROM timestamp) - $3::numeric)
  `, [symbol, EXCHANGES, epoch]);

  for (const r of rows) {
    prices[r.exchange] = parseFloat(r.price);
  }
  return prices;
}

// Batch-load exchange prices for many epochs at once (much faster)
async function batchLoadExchangePrices(symbol, epochs) {
  console.log(`  Loading exchange prices for ${epochs.length} timestamps...`);
  const t0 = Date.now();

  const results = new Map(); // epoch → { exchange: price }

  // Use LATERAL join for efficient batch lookup
  const rows = await query(`
    SELECT target_epoch, e.exchange, e.price
    FROM unnest($3::bigint[]) AS target_epoch
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (exchange) exchange, price
      FROM exchange_ticks
      WHERE symbol = $1
        AND exchange = ANY($2)
        AND timestamp BETWEEN to_timestamp(target_epoch::numeric - 5) AND to_timestamp(target_epoch::numeric + 5)
      ORDER BY exchange, ABS(EXTRACT(EPOCH FROM timestamp) - target_epoch::numeric)
    ) e
  `, [symbol, EXCHANGES, epochs]);

  for (const r of rows) {
    const ep = parseInt(r.target_epoch);
    if (!results.has(ep)) results.set(ep, {});
    results.get(ep)[r.exchange] = parseFloat(r.price);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Loaded ${rows.length} price points in ${elapsed}s`);
  return results;
}

// ── Analysis ──────────────────────────────────────────────────────────────

function computeComposites(exchangePrices) {
  const prices = Object.values(exchangePrices);
  if (prices.length === 0) return null;

  return {
    median: median(prices),
    mean: mean(prices),
    exclude_outliers: excludeOutliersMedian(prices),
    oracle_proximity: oracleProximityWeighted(exchangePrices),
    n_exchanges: prices.length,
  };
}

function fmt(n, decimals = 2) {
  return n.toFixed(decimals);
}

function fmtDollar(n) {
  return '$' + Math.abs(n).toFixed(2);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const symbol = process.argv[2] || 'btc';
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║       Exchange Composite → CL Prediction Error Diagnostic          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nSymbol: ${symbol.toUpperCase()}`);

  // 1. Load windows
  console.log('\n── Loading windows ──');
  const windows = await loadWindows(symbol);
  console.log(`  ${windows.length} resolved windows`);

  if (windows.length === 0) {
    console.log('No data. Exiting.');
    await pool.end();
    return;
  }

  // 2. Batch-load exchange prices at all open and close epochs
  console.log('\n── Loading exchange prices ──');
  const allEpochs = [];
  for (const w of windows) {
    allEpochs.push(w.open_epoch, w.close_epoch);
  }
  const uniqueEpochs = [...new Set(allEpochs)];
  const priceMap = await batchLoadExchangePrices(symbol, uniqueEpochs);

  // 3. Compute composites and errors for each window
  const METHODS = ['median', 'mean', 'exclude_outliers', 'oracle_proximity'];

  const results = []; // one per window

  let skipped = 0;
  for (const w of windows) {
    const openPrices = priceMap.get(w.open_epoch);
    const closePrices = priceMap.get(w.close_epoch);

    if (!openPrices || !closePrices ||
        Object.keys(openPrices).length < 2 ||
        Object.keys(closePrices).length < 2) {
      skipped++;
      continue;
    }

    const openComps = computeComposites(openPrices);
    const closeComps = computeComposites(closePrices);

    const windowResult = {
      close_epoch: w.close_epoch,
      cl_open: w.cl_open,
      cl_close: w.cl_close,
      cl_move: w.cl_move,
      cl_move_abs: Math.abs(w.cl_move),
      actual_direction: w.actual_direction,
      n_exchanges_open: openComps.n_exchanges,
      n_exchanges_close: closeComps.n_exchanges,
      methods: {},
    };

    for (const method of METHODS) {
      const predOpen = openComps[method];
      const predClose = closeComps[method];
      const predMove = predClose - predOpen;
      const predDirection = predMove >= 0 ? 'up' : 'down';
      const directionCorrect = predDirection === w.actual_direction;

      windowResult.methods[method] = {
        pred_open: predOpen,
        pred_close: predClose,
        error_open: predOpen - w.cl_open,    // + means exchange above CL
        error_close: predClose - w.cl_close,
        pred_move: predMove,
        move_error: predMove - w.cl_move,
        pred_direction: predDirection,
        direction_correct: directionCorrect,
      };
    }

    results.push(windowResult);
  }

  console.log(`\n  Analyzed ${results.length} windows (${skipped} skipped, insufficient exchange data)`);

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 1: Overall prediction accuracy per method
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 1: Overall Direction Accuracy & Price Error');
  console.log('='.repeat(70));

  console.log(`\n  Method              | Dir Acc  | MAE Open  | MAE Close | MAE Move  | RMSE Move`);
  console.log(`  --------------------+----------+-----------+-----------+-----------+----------`);

  for (const method of METHODS) {
    let correct = 0, total = 0;
    let sumAbsErrOpen = 0, sumAbsErrClose = 0, sumAbsMoveErr = 0;
    let sumSqMoveErr = 0;

    for (const r of results) {
      const m = r.methods[method];
      total++;
      if (m.direction_correct) correct++;
      sumAbsErrOpen += Math.abs(m.error_open);
      sumAbsErrClose += Math.abs(m.error_close);
      sumAbsMoveErr += Math.abs(m.move_error);
      sumSqMoveErr += m.move_error * m.move_error;
    }

    const acc = (correct / total * 100).toFixed(1);
    const maeOpen = (sumAbsErrOpen / total).toFixed(2);
    const maeClose = (sumAbsErrClose / total).toFixed(2);
    const maeMove = (sumAbsMoveErr / total).toFixed(2);
    const rmseMove = Math.sqrt(sumSqMoveErr / total).toFixed(2);

    console.log(`  ${method.padEnd(20)}| ${acc.padStart(5)}%  | $${maeOpen.padStart(8)}| $${maeClose.padStart(8)}| $${maeMove.padStart(8)}| $${rmseMove.padStart(8)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 2: Direction accuracy by CL move magnitude bucket
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 2: Direction Accuracy by CL Move Magnitude');
  console.log('  (Are errors concentrated in small moves?)');
  console.log('='.repeat(70));

  // Determine buckets based on symbol
  let buckets;
  if (symbol === 'btc') {
    buckets = [
      { label: '< $25', min: 0, max: 25 },
      { label: '$25-$50', min: 25, max: 50 },
      { label: '$50-$100', min: 50, max: 100 },
      { label: '$100-$200', min: 100, max: 200 },
      { label: '$200-$500', min: 200, max: 500 },
      { label: '> $500', min: 500, max: Infinity },
    ];
  } else if (symbol === 'eth') {
    buckets = [
      { label: '< $1', min: 0, max: 1 },
      { label: '$1-$3', min: 1, max: 3 },
      { label: '$3-$5', min: 3, max: 5 },
      { label: '$5-$10', min: 5, max: 10 },
      { label: '$10-$20', min: 10, max: 20 },
      { label: '> $20', min: 20, max: Infinity },
    ];
  } else {
    // SOL, XRP — use relative buckets
    buckets = [
      { label: '< 0.1%', min: 0, max: 0.001 },
      { label: '0.1-0.3%', min: 0.001, max: 0.003 },
      { label: '0.3-0.5%', min: 0.003, max: 0.005 },
      { label: '0.5-1%', min: 0.005, max: 0.01 },
      { label: '> 1%', min: 0.01, max: Infinity },
    ];
  }

  for (const method of METHODS) {
    console.log(`\n  ${method}:`);
    console.log(`  ${'Bucket'.padEnd(15)}| Windows | Correct | Accuracy | Avg CL Move | Avg Move Error`);
    console.log(`  ${'-'.repeat(15)}+---------+---------+----------+-------------+--------------`);

    for (const bucket of buckets) {
      const inBucket = results.filter(r => {
        const val = (symbol === 'sol' || symbol === 'xrp')
          ? r.cl_move_abs / r.cl_open
          : r.cl_move_abs;
        return val >= bucket.min && val < bucket.max;
      });

      if (inBucket.length === 0) continue;

      let correct = 0;
      let sumMoveErr = 0;
      let sumClMove = 0;

      for (const r of inBucket) {
        const m = r.methods[method];
        if (m.direction_correct) correct++;
        sumMoveErr += Math.abs(m.move_error);
        sumClMove += r.cl_move_abs;
      }

      const acc = (correct / inBucket.length * 100).toFixed(1);
      const avgClMove = (sumClMove / inBucket.length).toFixed(2);
      const avgMoveErr = (sumMoveErr / inBucket.length).toFixed(2);

      console.log(`  ${bucket.label.padEnd(15)}| ${String(inBucket.length).padStart(7)} | ${String(correct).padStart(7)} | ${acc.padStart(6)}%  | $${avgClMove.padStart(10)}| $${avgMoveErr.padStart(12)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 3: Detailed error cases (wrong direction predictions)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 3: Direction Error Cases (using median method)');
  console.log('  Showing all windows where median predicted wrong direction');
  console.log('='.repeat(70));

  const errors = results.filter(r => !r.methods.median.direction_correct);
  errors.sort((a, b) => a.cl_move_abs - b.cl_move_abs);

  console.log(`\n  ${errors.length} errors out of ${results.length} windows (${fmt(errors.length / results.length * 100, 1)}%)\n`);

  console.log(`  ${'Time (UTC)'.padEnd(22)}| Actual | CL Move    | Pred Move  | Open Err   | Close Err  | #Ex`);
  console.log(`  ${'-'.repeat(22)}+--------+------------+------------+------------+------------+----`);

  for (const r of errors) {
    const m = r.methods.median;
    const time = new Date(r.close_epoch * 1000).toISOString().slice(0, 19);
    const clMoveStr = (r.cl_move >= 0 ? '+' : '') + fmt(r.cl_move, 2);
    const predMoveStr = (m.pred_move >= 0 ? '+' : '') + fmt(m.pred_move, 2);
    const errOpenStr = (m.error_open >= 0 ? '+' : '') + fmt(m.error_open, 2);
    const errCloseStr = (m.error_close >= 0 ? '+' : '') + fmt(m.error_close, 2);

    console.log(`  ${time.padEnd(22)}| ${r.actual_direction.padEnd(6)} | $${clMoveStr.padStart(9)}| $${predMoveStr.padStart(9)}| $${errOpenStr.padStart(9)}| $${errCloseStr.padStart(9)}| ${r.n_exchanges_close}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 4: CL move distribution
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 4: CL Move Distribution');
  console.log('='.repeat(70));

  const moves = results.map(r => r.cl_move_abs).sort((a, b) => a - b);
  const percentiles = [10, 25, 50, 75, 90, 95, 99];

  console.log(`\n  Percentile | CL Move (abs)`);
  console.log(`  -----------+---------------`);
  for (const p of percentiles) {
    const idx = Math.floor(moves.length * p / 100);
    console.log(`  ${String(p).padStart(7)}th  | $${fmt(moves[Math.min(idx, moves.length - 1)], 2)}`);
  }

  console.log(`\n  Min: $${fmt(moves[0], 2)}  Max: $${fmt(moves[moves.length - 1], 2)}  Mean: $${fmt(mean(moves), 2)}`);

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 5: Error bias analysis
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 5: Systematic Bias — Exchange Composite vs CL');
  console.log('  (Positive = exchanges above CL, Negative = below)');
  console.log('='.repeat(70));

  for (const method of METHODS) {
    let sumErrOpen = 0, sumErrClose = 0;
    for (const r of results) {
      sumErrOpen += r.methods[method].error_open;
      sumErrClose += r.methods[method].error_close;
    }
    const biasOpen = sumErrOpen / results.length;
    const biasClose = sumErrClose / results.length;

    console.log(`\n  ${method}:`);
    console.log(`    Avg bias at open:  ${biasOpen >= 0 ? '+' : ''}$${fmt(biasOpen, 2)} (exchanges ${biasOpen >= 0 ? 'above' : 'below'} CL)`);
    console.log(`    Avg bias at close: ${biasClose >= 0 ? '+' : ''}$${fmt(biasClose, 2)} (exchanges ${biasClose >= 0 ? 'above' : 'below'} CL)`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // REPORT 6: Per-exchange accuracy (individual exchange as predictor)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('REPORT 6: Individual Exchange as Direction Predictor');
  console.log('='.repeat(70));

  console.log(`\n  Exchange          | Windows | Dir Acc  | Avg Bias Open | Avg Bias Close`);
  console.log(`  ------------------+---------+----------+---------------+---------------`);

  for (const exchange of EXCHANGES) {
    let correct = 0, total = 0, sumBiasOpen = 0, sumBiasClose = 0;

    for (const r of results) {
      const openPrices = priceMap.get(r.close_epoch - 900);
      const closePrices = priceMap.get(r.close_epoch);
      if (!openPrices || !closePrices) continue;
      if (openPrices[exchange] == null || closePrices[exchange] == null) continue;

      const predMove = closePrices[exchange] - openPrices[exchange];
      const predDir = predMove >= 0 ? 'up' : 'down';
      if (predDir === r.actual_direction) correct++;
      sumBiasOpen += openPrices[exchange] - r.cl_open;
      sumBiasClose += closePrices[exchange] - r.cl_close;
      total++;
    }

    if (total === 0) continue;
    const acc = (correct / total * 100).toFixed(1);
    const biasOpen = (sumBiasOpen / total);
    const biasClose = (sumBiasClose / total);
    console.log(`  ${exchange.padEnd(18)}| ${String(total).padStart(7)} | ${acc.padStart(5)}%  | ${biasOpen >= 0 ? '+' : ''}$${fmt(biasOpen, 2).padStart(11)}| ${biasClose >= 0 ? '+' : ''}$${fmt(biasClose, 2).padStart(11)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const medianErrors = results.filter(r => !r.methods.median.direction_correct);
  const smallMoveErrors = medianErrors.filter(r => {
    if (symbol === 'btc') return r.cl_move_abs < 50;
    if (symbol === 'eth') return r.cl_move_abs < 3;
    return r.cl_move_abs / r.cl_open < 0.002; // 0.2% for SOL/XRP
  });

  console.log(`\n  Total windows:       ${results.length}`);
  console.log(`  Direction errors:    ${medianErrors.length} (${fmt(medianErrors.length / results.length * 100, 1)}%)`);
  console.log(`  Errors on small CL moves: ${smallMoveErrors.length} / ${medianErrors.length} (${fmt(smallMoveErrors.length / medianErrors.length * 100, 1)}%)`);
  console.log(`  Errors on large CL moves: ${medianErrors.length - smallMoveErrors.length} / ${medianErrors.length}`);

  if (medianErrors.length - smallMoveErrors.length === 0) {
    console.log(`\n  ** ALL errors are on small CL moves — predictor is at ceiling for meaningful moves **`);
  } else {
    console.log(`\n  Large-move errors (these are the real failures):`);
    const largeMoveErrors = medianErrors.filter(r => {
      if (symbol === 'btc') return r.cl_move_abs >= 50;
      if (symbol === 'eth') return r.cl_move_abs >= 3;
      return r.cl_move_abs / r.cl_open >= 0.002;
    });
    for (const r of largeMoveErrors) {
      const m = r.methods.median;
      const time = new Date(r.close_epoch * 1000).toISOString().slice(0, 19);
      console.log(`    ${time} | CL: ${r.cl_move >= 0 ? '+' : ''}$${fmt(r.cl_move, 2)} | Pred: ${m.pred_move >= 0 ? '+' : ''}$${fmt(m.pred_move, 2)} | Bias close: ${m.error_close >= 0 ? '+' : ''}$${fmt(m.error_close, 2)}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
