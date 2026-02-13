/**
 * calibrate-vwap-oracle.cjs
 *
 * Reverse-engineers Chainlink oracle parameters by calibrating VWAP against
 * ground-truth CL prices. Sweeps lag offset, EMA smoothing, and exchange
 * weighting to find the best-fit synthetic oracle.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/calibrate-vwap-oracle.cjs
 */

const { Pool } = require('pg');

// ── DB setup ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300000,
});

async function query(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

function rmse(xs, ys) {
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - ys[i];
    sum += d * d;
  }
  return Math.sqrt(sum / xs.length);
}

function applyEma(series, alpha) {
  const out = new Float64Array(series.length);
  out[0] = series[0];
  for (let i = 1; i < series.length; i++) {
    out[i] = alpha * series[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n, decimals = 2) {
  return typeof n === 'number' ? n.toFixed(decimals) : 'N/A';
}

function fmtCorr(n) {
  return typeof n === 'number' ? n.toFixed(6) : 'N/A';
}

// ── Data loading ───────────────────────────────────────────────────────────

async function loadVwapSnapshots(symbol, includeDetail = false) {
  console.log(`\nLoading vwap_snapshots for ${symbol}${includeDetail ? ' (with exchange_detail)' : ''}...`);

  if (includeDetail) {
    // JSONB is ~5s per 1K rows over Railway network. Load only latest 500
    // rows (DESC index = fast) — enough for weighting scheme comparison.
    const SAMPLE = 500;
    console.log(`  Loading latest ${SAMPLE} rows with exchange_detail (DESC index)...`);
    const t0 = Date.now();
    const raw = await query(`
      SELECT timestamp, composite_vwap, chainlink_price, exchange_detail
      FROM vwap_snapshots
      WHERE symbol = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [symbol, SAMPLE]);
    raw.reverse();
    console.log(`    got ${raw.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    return raw.map(r => ({
      epoch: Math.floor(new Date(r.timestamp).getTime() / 1000),
      composite_vwap: parseFloat(r.composite_vwap),
      chainlink_price: r.chainlink_price != null ? parseFloat(r.chainlink_price) : null,
      exchange_detail: r.exchange_detail,
    }));
  }

  // Use LIMIT 10000 with DESC index for fast transfer over Railway network.
  // 10K rows ≈ 5000 unique seconds — sufficient for Phase 1-2 calibration.
  const raw = await query(`
    SELECT timestamp, composite_vwap, chainlink_price
    FROM vwap_snapshots
    WHERE symbol = $1
    ORDER BY timestamp DESC
    LIMIT 10000
  `, [symbol]);
  raw.reverse();

  const rows = raw.map(r => ({
    epoch: Math.floor(new Date(r.timestamp).getTime() / 1000),
    composite_vwap: parseFloat(r.composite_vwap),
    chainlink_price: r.chainlink_price != null ? parseFloat(r.chainlink_price) : null,
    exchange_detail: null,
  }));

  console.log(`  Loaded ${rows.length} rows`);
  return rows;
}

async function loadWindowEvents() {
  console.log(`Loading window_close_events...`);
  // resolved_direction is often NULL — derive from oracle_price_at_close vs strike
  const raw = await query(`
    SELECT symbol, window_close_time, strike_price,
           oracle_price_at_close, resolved_direction
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND oracle_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  const rows = raw.map(r => {
    const oracleClose = parseFloat(r.oracle_price_at_close);
    const strike = parseFloat(r.strike_price);
    // Use stored resolution if available, otherwise derive: close >= open (strike) → UP
    const direction = r.resolved_direction
      ? r.resolved_direction.toLowerCase()
      : (oracleClose >= strike ? 'up' : 'down');
    return {
      symbol: r.symbol,
      close_epoch: Math.floor(new Date(r.window_close_time).getTime() / 1000),
      strike_price: strike,
      oracle_close: oracleClose,
      resolved_direction: direction,
    };
  });

  const derived = rows.length - raw.filter(r => r.resolved_direction).length;
  console.log(`  Loaded ${rows.length} windows (${derived} derived from oracle_price_at_close >= strike)`);
  return rows;
}

// ── Bucketing ──────────────────────────────────────────────────────────────

function bucketBySecond(rows, valueKey) {
  const byEpoch = new Map();
  for (const row of rows) {
    byEpoch.set(row.epoch, typeof valueKey === 'function' ? valueKey(row) : row[valueKey]);
  }

  const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
  const values = new Float64Array(epochs.length);
  for (let i = 0; i < epochs.length; i++) {
    values[i] = byEpoch.get(epochs[i]);
  }

  return { epochs, values, byEpoch };
}

function recomputeVwap(rows, scheme) {
  const result = new Float64Array(rows.length);

  for (let i = 0; i < rows.length; i++) {
    const detail = typeof rows[i].exchange_detail === 'string'
      ? JSON.parse(rows[i].exchange_detail)
      : rows[i].exchange_detail;

    if (!detail || Object.keys(detail).length === 0) {
      result[i] = rows[i].composite_vwap;
      continue;
    }

    const exchanges = Object.entries(detail);
    let weightedSum = 0;
    let totalWeight = 0;

    if (scheme === 'volume_weighted') {
      for (const [, ex] of exchanges) {
        const v = ex.volume || 0;
        if (v > 0) { weightedSum += ex.vwap * v; totalWeight += v; }
      }
    } else if (scheme === 'equal_weight') {
      for (const [, ex] of exchanges) {
        if (ex.vwap > 0) { weightedSum += ex.vwap; totalWeight += 1; }
      }
    } else if (scheme === 'top_5_by_volume' || scheme === 'top_10_by_volume' || scheme === 'top_15_by_volume') {
      const topN = scheme === 'top_5_by_volume' ? 5 : scheme === 'top_10_by_volume' ? 10 : 15;
      const sorted = exchanges.filter(([, ex]) => ex.volume > 0).sort((a, b) => b[1].volume - a[1].volume).slice(0, topN);
      for (const [, ex] of sorted) { weightedSum += ex.vwap * ex.volume; totalWeight += ex.volume; }
    } else if (scheme === 'exclude_outliers') {
      const vwaps = exchanges.filter(([, ex]) => ex.vwap > 0).map(([, ex]) => ex.vwap);
      const med = median(vwaps);
      const threshold = med * 0.001;
      for (const [, ex] of exchanges) {
        if (ex.volume > 0 && Math.abs(ex.vwap - med) <= threshold) {
          weightedSum += ex.vwap * ex.volume; totalWeight += ex.volume;
        }
      }
    } else if (scheme === 'top_5_equal' || scheme === 'top_10_equal') {
      const topN = scheme === 'top_5_equal' ? 5 : 10;
      const sorted = exchanges.filter(([, ex]) => ex.volume > 0).sort((a, b) => b[1].volume - a[1].volume).slice(0, topN);
      for (const [, ex] of sorted) { weightedSum += ex.vwap; totalWeight += 1; }
    }

    result[i] = totalWeight > 0 ? weightedSum / totalWeight : rows[i].composite_vwap;
  }

  return result;
}

// ── Phase 1: Lag sweep ─────────────────────────────────────────────────────

function runLagSweep(vwapBucket, clBucket) {
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 1: Lag Offset Sweep');
  console.log('='.repeat(70));

  const lags = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
  const results = [];

  for (const lag of lags) {
    const xs = [], ys = [];
    for (let i = 0; i < vwapBucket.epochs.length; i++) {
      const clPrice = clBucket.byEpoch.get(vwapBucket.epochs[i] + lag);
      if (clPrice !== undefined) { xs.push(vwapBucket.values[i]); ys.push(clPrice); }
    }
    if (xs.length < 100) continue;
    results.push({ lag, corr: pearson(xs, ys), rmse: rmse(xs, ys), n: xs.length });
  }

  console.log('\n  Lag(s)  |  Correlation  |   RMSE ($)   |   R²      |  N pairs');
  console.log('  -------+---------------+--------------+-----------+---------');
  for (const r of results) {
    console.log(`    ${String(r.lag).padStart(2)}    | ${fmtCorr(r.corr).padStart(12)} | ${fmt(r.rmse).padStart(11)} | ${fmt(r.corr * r.corr, 6).padStart(9)} | ${r.n}`);
  }

  results.sort((a, b) => b.corr - a.corr);
  const best = results[0];
  console.log(`\n  → Best lag: ${best.lag}s (correlation=${fmtCorr(best.corr)}, RMSE=$${fmt(best.rmse)})`);
  return best.lag;
}

// ── Phase 2: Smoothing (EMA) sweep ─────────────────────────────────────────

function runSmoothingSweep(vwapBucket, clBucket, bestLag) {
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 2: EMA Smoothing Sweep (at lag=' + bestLag + 's)');
  console.log('='.repeat(70));

  const windows = [0, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120];
  const results = [];

  for (const win of windows) {
    const series = win === 0 ? vwapBucket.values : applyEma(vwapBucket.values, 2 / (win + 1));
    const xs = [], ys = [];
    for (let i = 0; i < vwapBucket.epochs.length; i++) {
      const clPrice = clBucket.byEpoch.get(vwapBucket.epochs[i] + bestLag);
      if (clPrice !== undefined) { xs.push(series[i]); ys.push(clPrice); }
    }
    if (xs.length < 100) continue;
    results.push({ window: win, corr: pearson(xs, ys), rmse: rmse(xs, ys), n: xs.length });
  }

  console.log('\n  EMA(s)  |  Correlation  |   RMSE ($)   |   R²      |  N pairs');
  console.log('  -------+---------------+--------------+-----------+---------');
  for (const r of results) {
    const label = r.window === 0 ? 'raw' : String(r.window);
    console.log(`  ${label.padStart(5)}   | ${fmtCorr(r.corr).padStart(12)} | ${fmt(r.rmse).padStart(11)} | ${fmt(r.corr * r.corr, 6).padStart(9)} | ${r.n}`);
  }

  results.sort((a, b) => a.rmse - b.rmse);
  const best = results[0];
  console.log(`\n  → Best smoothing: EMA(${best.window === 0 ? 'raw' : best.window + 's'}) (RMSE=$${fmt(best.rmse)}, corr=${fmtCorr(best.corr)})`);
  return best.window;
}

// ── Phase 3: Exchange weighting sweep ──────────────────────────────────────

function runWeightingSweep(rows, clBucket, bestLag, bestWindow) {
  console.log('\n' + '='.repeat(70));
  console.log(`PHASE 3: Exchange Weighting Sweep (lag=${bestLag}s, EMA=${bestWindow === 0 ? 'raw' : bestWindow + 's'})`);
  console.log('='.repeat(70));

  const schemes = [
    'volume_weighted', 'equal_weight',
    'top_5_by_volume', 'top_10_by_volume', 'top_15_by_volume',
    'exclude_outliers', 'top_5_equal', 'top_10_equal',
  ];
  const results = [];

  for (const scheme of schemes) {
    const reweighted = recomputeVwap(rows, scheme);
    const byEpoch = new Map();
    for (let i = 0; i < rows.length; i++) byEpoch.set(rows[i].epoch, reweighted[i]);
    const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
    const values = new Float64Array(epochs.length);
    for (let j = 0; j < epochs.length; j++) values[j] = byEpoch.get(epochs[j]);

    const series = bestWindow === 0 ? values : applyEma(values, 2 / (bestWindow + 1));
    const xs = [], ys = [];
    for (let i = 0; i < epochs.length; i++) {
      const clPrice = clBucket.byEpoch.get(epochs[i] + bestLag);
      if (clPrice !== undefined) { xs.push(series[i]); ys.push(clPrice); }
    }
    if (xs.length < 100) continue;
    results.push({ scheme, corr: pearson(xs, ys), rmse: rmse(xs, ys), n: xs.length });
  }

  console.log('\n  Scheme                |  Correlation  |   RMSE ($)   |   R²      |  N');
  console.log('  ---------------------+---------------+--------------+-----------+------');
  for (const r of results) {
    console.log(`  ${r.scheme.padEnd(21)} | ${fmtCorr(r.corr).padStart(12)} | ${fmt(r.rmse).padStart(11)} | ${fmt(r.corr * r.corr, 6).padStart(9)} | ${r.n}`);
  }

  results.sort((a, b) => a.rmse - b.rmse);
  const best = results[0];
  console.log(`\n  → Best weighting: ${best.scheme} (RMSE=$${fmt(best.rmse)}, corr=${fmtCorr(best.corr)})`);

  // Report top exchanges by volume
  console.log('\n  Exchange volume rankings (from first 100 snapshots):');
  const volAccum = {};
  let counted = 0;
  for (const row of rows) {
    if (counted >= 100) break;
    const detail = typeof row.exchange_detail === 'string' ? JSON.parse(row.exchange_detail) : row.exchange_detail;
    if (!detail) continue;
    for (const [name, ex] of Object.entries(detail)) {
      volAccum[name] = (volAccum[name] || 0) + (ex.volume || 0);
    }
    counted++;
  }
  const ranked = Object.entries(volAccum).sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < Math.min(ranked.length, 15); i++) {
    console.log(`    ${String(i + 1).padStart(2)}. ${ranked[i][0].padEnd(20)} vol=${fmt(ranked[i][1], 4)}`);
  }

  return best.scheme;
}

// ── Phase 4: Resolution prediction — sweep all weighting schemes ───────────

/**
 * Compute a single VWAP value from exchange_detail using the given scheme.
 */
function computeVwapFromDetail(detail, scheme) {
  if (!detail || typeof detail !== 'object') return null;
  const exchanges = Object.entries(detail);
  if (exchanges.length === 0) return null;

  let weightedSum = 0, totalWeight = 0;

  if (scheme === 'volume_weighted') {
    for (const [, ex] of exchanges) {
      const v = ex.volume || 0;
      if (v > 0) { weightedSum += ex.vwap * v; totalWeight += v; }
    }
  } else if (scheme === 'equal_weight') {
    for (const [, ex] of exchanges) {
      if (ex.vwap > 0) { weightedSum += ex.vwap; totalWeight += 1; }
    }
  } else if (scheme.startsWith('top_') && scheme.endsWith('_by_volume')) {
    const topN = parseInt(scheme.split('_')[1]);
    const sorted = exchanges.filter(([, ex]) => ex.volume > 0).sort((a, b) => b[1].volume - a[1].volume).slice(0, topN);
    for (const [, ex] of sorted) { weightedSum += ex.vwap * ex.volume; totalWeight += ex.volume; }
  } else if (scheme === 'exclude_outliers') {
    const vwaps = exchanges.filter(([, ex]) => ex.vwap > 0).map(([, ex]) => ex.vwap);
    const med = median(vwaps);
    const threshold = med * 0.001;
    for (const [, ex] of exchanges) {
      if (ex.volume > 0 && Math.abs(ex.vwap - med) <= threshold) {
        weightedSum += ex.vwap * ex.volume; totalWeight += ex.volume;
      }
    }
  } else if (scheme.startsWith('top_') && scheme.endsWith('_equal')) {
    const topN = parseInt(scheme.split('_')[1]);
    const sorted = exchanges.filter(([, ex]) => ex.volume > 0).sort((a, b) => b[1].volume - a[1].volume).slice(0, topN);
    for (const [, ex] of sorted) { weightedSum += ex.vwap; totalWeight += 1; }
  } else if (scheme.startsWith('ex:')) {
    // Individual exchange: "ex:binance"
    const exName = scheme.slice(3);
    const found = exchanges.find(([name]) => name === exName);
    if (found && found[1].vwap > 0) return found[1].vwap;
    return null;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

async function runResolutionTestDB(windowEvents) {
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 4: Resolution — Sweep ALL Weighting Schemes');
  console.log('='.repeat(70));

  const WINDOW_DURATION = 900;
  const symbols = ['btc', 'eth', 'sol', 'xrp'];

  // Composite schemes
  const compositeSchemes = [
    'volume_weighted', 'equal_weight',
    'top_3_by_volume', 'top_5_by_volume', 'top_10_by_volume',
    'exclude_outliers',
    'top_3_equal', 'top_5_equal', 'top_10_equal',
  ];

  const allResults = {}; // sym → [ { scheme, correct, total, accuracy } ]

  for (const sym of symbols) {
    const symEvents = windowEvents.filter(w => w.symbol.toLowerCase() === sym);
    if (symEvents.length === 0) continue;

    // Load exchange_detail at each window open/close — only ~300 rows of JSONB
    const openEpochs = symEvents.map(e => e.close_epoch - WINDOW_DURATION);
    const closeEpochs = symEvents.map(e => e.close_epoch);
    const allEpochs = [...new Set([...openEpochs, ...closeEpochs])]; // dedupe

    const t0 = Date.now();
    const rows = await query(`
      SELECT
        target_epoch,
        v.composite_vwap,
        v.chainlink_price,
        v.exchange_detail
      FROM unnest($2::bigint[]) AS target_epoch
      CROSS JOIN LATERAL (
        SELECT composite_vwap, chainlink_price, exchange_detail
        FROM vwap_snapshots
        WHERE symbol = $1
          AND timestamp BETWEEN to_timestamp(target_epoch::numeric - 3) AND to_timestamp(target_epoch::numeric + 3)
        ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - target_epoch)
        LIMIT 1
      ) v
    `, [sym, allEpochs]);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Build lookup: epoch → { detail, cl }
    const lookup = new Map();
    const allExchangeNames = new Set();
    for (const r of rows) {
      const detail = typeof r.exchange_detail === 'string' ? JSON.parse(r.exchange_detail) : r.exchange_detail;
      if (detail) Object.keys(detail).forEach(k => allExchangeNames.add(k));
      lookup.set(parseInt(r.target_epoch), {
        detail,
        cl: r.chainlink_price ? parseFloat(r.chainlink_price) : null,
      });
    }

    console.log(`\n  ${sym.toUpperCase()}: ${rows.length} snapshots loaded for ${symEvents.length} windows [${elapsed}s]`);
    console.log(`  Exchanges present: ${allExchangeNames.size} (${[...allExchangeNames].sort().join(', ')})`);

    // Build full scheme list: composites + individual exchanges
    const schemes = [
      ...compositeSchemes,
      ...[...allExchangeNames].sort().map(name => `ex:${name}`),
    ];

    // Also test CL ground truth
    const schemeResults = [];
    let clCorrect = 0, clTotal = 0;

    for (const scheme of schemes) {
      let correct = 0, total = 0;

      for (const evt of symEvents) {
        const openEpoch = evt.close_epoch - WINDOW_DURATION;
        const closeEpoch = evt.close_epoch;
        const actual = evt.resolved_direction;

        const atOpen = lookup.get(openEpoch);
        const atClose = lookup.get(closeEpoch);
        if (!atOpen || !atClose) continue;

        const vOpen = computeVwapFromDetail(atOpen.detail, scheme);
        const vClose = computeVwapFromDetail(atClose.detail, scheme);
        if (vOpen == null || vClose == null) continue;

        const predicted = vClose >= vOpen ? 'up' : 'down';
        if (predicted === actual) correct++;
        total++;
      }

      if (total > 0) {
        schemeResults.push({ scheme, correct, total, accuracy: correct / total * 100 });
      }
    }

    // CL ground truth
    for (const evt of symEvents) {
      const openEpoch = evt.close_epoch - WINDOW_DURATION;
      const closeEpoch = evt.close_epoch;
      const atOpen = lookup.get(openEpoch);
      const atClose = lookup.get(closeEpoch);
      if (!atOpen || !atClose || !atOpen.cl || !atClose.cl) continue;
      const predicted = atClose.cl >= atOpen.cl ? 'up' : 'down';
      if (predicted === evt.resolved_direction) clCorrect++;
      clTotal++;
    }

    // Sort by accuracy descending
    schemeResults.sort((a, b) => b.accuracy - a.accuracy || b.total - a.total);

    // Print results
    console.log(`\n  Scheme                     | Correct | Total | Accuracy`);
    console.log(`  --------------------------+--------+-------+---------`);
    if (clTotal > 0) {
      console.log(`  ** CL ground truth **       | ${String(clCorrect).padStart(6)} | ${String(clTotal).padStart(5)} | ${fmt(clCorrect / clTotal * 100, 1)}%`);
    }
    for (const r of schemeResults) {
      const label = r.scheme.startsWith('ex:') ? r.scheme : r.scheme;
      console.log(`  ${label.padEnd(27)} | ${String(r.correct).padStart(6)} | ${String(r.total).padStart(5)} | ${fmt(r.accuracy, 1)}%`);
    }

    allResults[sym] = schemeResults;
  }

  return allResults;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         VWAP Oracle Calibration — Reverse-Engineer Chainlink        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // ── Load core data (no JSONB — fast) ──────────────────────────────────
  console.log('\n── DATA LOADING (Phase 1-2: core data only) ──');

  const btcRows = await loadVwapSnapshots('btc', false);
  if (btcRows.length === 0) {
    console.error('ERROR: No BTC vwap_snapshots found.');
    process.exit(1);
  }

  const withCL = btcRows.filter(r => r.chainlink_price != null);
  console.log(`  ${withCL.length}/${btcRows.length} rows have chainlink_price`);

  const windowEvents = await loadWindowEvents();

  // ── Bucket data ────────────────────────────────────────────────────────
  console.log('\n── BUCKETING DATA ──');

  const vwapBucket = bucketBySecond(btcRows, 'composite_vwap');
  console.log(`  VWAP: ${vwapBucket.epochs.length} unique seconds`);
  console.log(`    Range: ${new Date(vwapBucket.epochs[0] * 1000).toISOString()} → ${new Date(vwapBucket.epochs[vwapBucket.epochs.length - 1] * 1000).toISOString()}`);

  const clBucket = bucketBySecond(
    btcRows.filter(r => r.chainlink_price != null),
    'chainlink_price'
  );
  console.log(`  CL (from snapshots): ${clBucket.epochs.length} unique seconds`);

  let overlap = 0;
  for (const epoch of vwapBucket.epochs) {
    if (clBucket.byEpoch.has(epoch)) overlap++;
  }
  console.log(`  Overlapping seconds (VWAP ∩ CL): ${overlap}`);

  if (overlap < 1000) {
    console.error('ERROR: Insufficient overlap. Need ≥1000 paired seconds.');
    process.exit(1);
  }

  // ── Phase 1: Lag sweep ─────────────────────────────────────────────────
  const bestLag = runLagSweep(vwapBucket, clBucket);

  // ── Phase 2: Smoothing sweep ───────────────────────────────────────────
  const bestWindow = runSmoothingSweep(vwapBucket, clBucket, bestLag);

  // ── Phase 3: Exchange weighting (JSONB sample) ─────────────────────────
  console.log('\n── LOADING EXCHANGE DETAIL (Phase 3) ──');
  const btcRowsWithDetail = await loadVwapSnapshots('btc', true);
  const bestScheme = runWeightingSweep(btcRowsWithDetail, clBucket, bestLag, bestWindow);
  btcRowsWithDetail.length = 0; // free

  // ── Phase 4: Resolution prediction (DB-driven) ─────────────────────────
  const resolution = await runResolutionTestDB(windowEvents);

  // ── Summary ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(70));
  console.log('FINAL SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n  Best parameters:`);
  console.log(`    Lag offset:    ${bestLag} seconds`);
  console.log(`    EMA smoothing: ${bestWindow === 0 ? 'none (raw 10s VWAP)' : bestWindow + 's'}`);
  console.log(`    Weighting:     ${bestScheme}`);
  console.log(`\n  Best resolution predictor per symbol:`);
  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    const results = resolution[sym];
    if (results && results.length > 0) {
      const best = results[0]; // already sorted by accuracy desc
      console.log(`    ${sym.toUpperCase()}: ${best.scheme} → ${best.correct}/${best.total} (${fmt(best.accuracy, 1)}%)`);
    } else {
      console.log(`    ${sym.toUpperCase()}: no data`);
    }
  }

  console.log(`\n  Completed in ${elapsed}s`);
  console.log('═'.repeat(70));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
