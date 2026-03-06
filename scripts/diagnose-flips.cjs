#!/usr/bin/env node
/**
 * Stage 2: Full diagnostic of all 38 onchain-verified BTC flips.
 *
 * For each flip, queries:
 *   - CLOB mid_price, spread, bid/ask size at T-60/30/10/5/1
 *   - Chainlink, Polymarket ref, Pyth oracle prices
 *   - All exchange prices (21 exchanges)
 *   - Computes exchange consensus, CL direction vs exchanges
 *
 * Creates idx_rtds_topic_sym_ts if missing for fast RTDS lookups.
 */

const Database = require('better-sqlite3');
const path = require('path');

const SQLITE_PATH = process.env.SQLITE_PATH || path.resolve(__dirname, '..', 'data', 'backtest.sqlite');
const db = new Database(SQLITE_PATH, { readonly: false });

// Pragmas for speed
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -256000');
db.pragma('mmap_size = 2147483648');

// ─── Ensure RTDS index exists ───
const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rtds_ticks'`).all();
const hasTopicSymTs = indexes.some(i => i.name === 'idx_rtds_topic_sym_ts');
if (!hasTopicSymTs) {
  console.log('Creating index idx_rtds_topic_sym_ts on rtds_ticks(topic, symbol, timestamp)...');
  db.exec('CREATE INDEX IF NOT EXISTS idx_rtds_topic_sym_ts ON rtds_ticks(topic, symbol, timestamp)');
  console.log('Done.\n');
} else {
  console.log('idx_rtds_topic_sym_ts already exists.\n');
}

// ─── Get all BTC windows with onchain resolution ───
const windows = db.prepare(`
  SELECT window_close_time, symbol, chainlink_price_at_close, oracle_price_at_open,
         onchain_resolved_direction
  FROM window_close_events
  WHERE symbol = 'btc' AND onchain_resolved_direction IS NOT NULL
  ORDER BY window_close_time ASC
`).all();

console.log(`Loaded ${windows.length} BTC windows with onchain resolution`);

// ─── Find the flips (80/20 confident at T-60s, resolved opposite) ───
const getClobUp = db.prepare(`
  SELECT mid_price FROM clob_price_snapshots
  WHERE symbol LIKE 'btc-up%' AND window_epoch = ? AND timestamp <= ?
  ORDER BY timestamp DESC LIMIT 1
`);

const flips = [];
for (const w of windows) {
  const resolved = w.onchain_resolved_direction.toUpperCase();
  const closeMs = new Date(w.window_close_time).getTime();
  const windowEpoch = Math.floor(closeMs / 1000) - 900;
  const t60 = new Date(closeMs - 60000).toISOString();
  const row = getClobUp.get(windowEpoch, t60);
  if (!row) continue;
  const up60 = Number(row.mid_price);
  if (up60 < 0.20 || up60 > 0.80) {
    const marketDir = up60 >= 0.80 ? 'UP' : 'DOWN';
    if (marketDir !== resolved) {
      flips.push({ ...w, resolved, closeMs, windowEpoch, up60, marketDir });
    }
  }
}

console.log(`Found ${flips.length} flips (80/20 confident at T-60s, resolved opposite)\n`);

// ─── Prepared statements ───
const getClobDetail = db.prepare(`
  SELECT mid_price, best_bid, best_ask, bid_size_top, ask_size_top, spread
  FROM clob_price_snapshots
  WHERE symbol LIKE 'btc-up%' AND window_epoch = ? AND timestamp <= ? AND timestamp >= ?
  ORDER BY timestamp DESC LIMIT 1
`);

const getExchangePrices = db.prepare(`
  SELECT exchange, price FROM exchange_ticks
  WHERE symbol = 'btc' AND timestamp <= ? AND timestamp >= ?
  ORDER BY timestamp DESC
`);

const getRtdsPrice = db.prepare(`
  SELECT price FROM rtds_ticks
  WHERE topic = ? AND symbol = 'btc' AND timestamp <= ?
  ORDER BY timestamp DESC LIMIT 1
`);

// ─── Process each flip ───
const offsets = [60, 30, 10, 5, 1];
const results = [];

const t0 = Date.now();

for (let fi = 0; fi < flips.length; fi++) {
  const f = flips[fi];
  const diag = {
    time: f.window_close_time,
    resolved: f.resolved,
    marketDirAt60: f.marketDir,
    clobUp60: f.up60,
    clOpen: Number(f.oracle_price_at_open) || null,
    clClose: Number(f.chainlink_price_at_close) || null,
    clMove: null,
    clMovePct: null,
    snapshots: [],
  };

  if (diag.clOpen && diag.clClose) {
    diag.clMove = diag.clClose - diag.clOpen;
    diag.clMovePct = (diag.clClose - diag.clOpen) / diag.clOpen * 100;
  }

  for (const off of offsets) {
    const t = new Date(f.closeMs - off * 1000).toISOString();
    const tStart = new Date(f.closeMs - off * 1000 - 2000).toISOString();

    const snap = { offset: off };

    // CLOB
    const clobRow = getClobDetail.get(f.windowEpoch, t, tStart);
    if (clobRow) {
      snap.clobUp = Number(clobRow.mid_price);
      snap.spread = Number(clobRow.spread || 0);
      snap.bidSize = Number(clobRow.bid_size_top || 0);
      snap.askSize = Number(clobRow.ask_size_top || 0);
    }

    // Oracle prices (all use the new idx_rtds_topic_sym_ts index)
    const clRow = getRtdsPrice.get('crypto_prices_chainlink', t);
    if (clRow) snap.chainlink = Number(clRow.price);

    const prRow = getRtdsPrice.get('crypto_prices', t);
    if (prRow) snap.polyRef = Number(prRow.price);

    const pyRow = getRtdsPrice.get('crypto_prices_pyth', t);
    if (pyRow) snap.pyth = Number(pyRow.price);

    // Exchange consensus
    const exRows = getExchangePrices.all(t, tStart);
    const byExchange = {};
    for (const r of exRows) {
      if (!byExchange[r.exchange]) byExchange[r.exchange] = Number(r.price);
    }
    const exchanges = Object.entries(byExchange);
    if (exchanges.length > 0) {
      const prices = exchanges.map(e => e[1]);
      let sum = 0, min = Infinity, max = -Infinity;
      for (const p of prices) { sum += p; if (p < min) min = p; if (p > max) max = p; }
      snap.exMean = sum / prices.length;
      snap.exMin = min;
      snap.exMax = max;
      snap.exSpread = max - min;
      snap.exCount = prices.length;
      snap.exchanges = byExchange;
    }

    diag.snapshots.push(snap);
  }

  results.push(diag);

  if ((fi + 1) % 10 === 0) {
    process.stdout.write(`  Processed ${fi + 1}/${flips.length} flips\r`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nProcessed ${results.length} flips in ${elapsed}s\n`);

// ─── Print detailed diagnostic ───
for (const d of results) {
  console.log('='.repeat(130));
  console.log(`FLIP: ${d.time} | Market@T-60: ${d.marketDirAt60} (CLOB_UP=${d.clobUp60.toFixed(3)}) | Resolved: ${d.resolved}`);
  if (d.clMove !== null) {
    const dir = d.clMove >= 0 ? 'UP' : 'DOWN';
    console.log(`CL Move: $${d.clMove.toFixed(2)} (${d.clMovePct.toFixed(4)}%) ${dir} | CL@open: $${d.clOpen.toFixed(2)} | CL@close: $${d.clClose.toFixed(2)}`);
  } else {
    console.log('CL Move: n/a (missing CL@open or CL@close)');
  }
  console.log();

  console.log('  T-sec  CLOB_UP  SPREAD   BID_SZ  ASK_SZ  | CHAINLINK      POLY_REF     PYTH         | EX_MEAN      EX_SPREAD  EX_CNT  CL_DIR');
  console.log('  ' + '-'.repeat(122));

  for (const s of d.snapshots) {
    const cu = s.clobUp !== undefined ? s.clobUp.toFixed(3).padEnd(7) : 'n/a    ';
    const sp = s.spread !== undefined ? s.spread.toFixed(4).padEnd(8) : 'n/a     ';
    const bs = s.bidSize !== undefined ? String(Math.round(s.bidSize)).padEnd(7) : 'n/a    ';
    const as_ = s.askSize !== undefined ? String(Math.round(s.askSize)).padEnd(7) : 'n/a    ';
    const cl = s.chainlink !== undefined ? ('$' + s.chainlink.toFixed(2)).padEnd(14) : 'n/a           ';
    const pr = s.polyRef !== undefined ? ('$' + s.polyRef.toFixed(2)).padEnd(12) : 'n/a         ';
    const py = s.pyth !== undefined ? ('$' + s.pyth.toFixed(2)).padEnd(12) : 'n/a         ';
    const em = s.exMean !== undefined ? ('$' + s.exMean.toFixed(2)).padEnd(12) : 'n/a         ';
    const es = s.exSpread !== undefined ? ('$' + s.exSpread.toFixed(2)).padEnd(10) : 'n/a       ';
    const ec = s.exCount !== undefined ? String(s.exCount).padEnd(7) : 'n/a    ';

    // CL direction vs open
    let clDir = '';
    if (d.clOpen && s.chainlink !== undefined) {
      clDir = s.chainlink >= d.clOpen ? 'UP' : 'DOWN';
    }

    console.log(`  T-${String(s.offset).padStart(3)}  ${cu} ${sp} ${bs} ${as_} | ${cl} ${pr} ${py} | ${em} ${es} ${ec} ${clDir}`);
  }

  // ─── Exchange detail at T-10 ───
  const t10 = d.snapshots.find(s => s.offset === 10);
  if (t10 && t10.exchanges) {
    const sorted = Object.entries(t10.exchanges).sort((a, b) => b[1] - a[1]);
    const exStr = sorted.map(([ex, p]) => `${ex}=$${p.toFixed(2)}`).join('  ');
    console.log(`  Exchanges@T-10: ${exStr}`);
  }

  // ─── Mechanism tags ───
  const tags = [];
  if (d.clMove !== null) {
    const abs = Math.abs(d.clMove);
    if (abs < 10) tags.push(`TINY_CL_MOVE($${abs.toFixed(2)})`);
    else if (abs < 30) tags.push(`SMALL_CL_MOVE($${abs.toFixed(2)})`);
    else if (abs < 80) tags.push(`MED_CL_MOVE($${abs.toFixed(2)})`);
    else tags.push(`LARGE_CL_MOVE($${abs.toFixed(2)})`);
  }

  // Check if CL direction at T-60 already agreed with resolution
  const t60snap = d.snapshots.find(s => s.offset === 60);
  if (t60snap && t60snap.chainlink && d.clOpen) {
    const clDirAt60 = t60snap.chainlink >= d.clOpen ? 'UP' : 'DOWN';
    if (clDirAt60 === d.resolved) {
      tags.push('CL_ALREADY_CORRECT@T-60');
    } else {
      tags.push('CL_WRONG@T-60');
    }
  }

  // Check CLOB self-correction
  const t1snap = d.snapshots.find(s => s.offset === 1);
  if (t1snap && t1snap.clobUp !== undefined) {
    if ((d.resolved === 'UP' && t1snap.clobUp > 0.50) || (d.resolved === 'DOWN' && t1snap.clobUp < 0.50)) {
      tags.push('CLOB_CORRECTED@T-1');
    } else {
      tags.push('CLOB_STILL_WRONG@T-1');
    }
  }

  // Spread quality
  if (t60snap && t60snap.spread !== undefined) {
    if (t60snap.spread >= 0.04) tags.push(`WIDE_SPREAD(${t60snap.spread.toFixed(3)})`);
  }

  // Exchange vs CL divergence at T-10
  if (t10 && t10.exMean && t10.chainlink) {
    const gap = t10.exMean - t10.chainlink;
    if (Math.abs(gap) > 50) tags.push(`EX_CL_GAP($${gap.toFixed(0)})`);
  }

  // Exchange direction consensus at T-10 vs CL direction
  if (t10 && t10.exMean && d.clOpen) {
    const exDir = t10.exMean >= d.clOpen ? 'UP' : 'DOWN';
    // The gap that matters is relative to where settlement will land
    // Exchanges moving in resolved direction while CL hasn't caught up yet
    if (exDir === d.resolved) {
      tags.push('EX_LEADING_TO_RESOLUTION@T-10');
    }
  }

  if (tags.length > 0) console.log(`  Tags: ${tags.join(', ')}`);
  console.log();
}

// ─── Summary ───
console.log('\n' + '='.repeat(130));
console.log('SUMMARY: FLIP MECHANISM CATEGORIZATION');
console.log('='.repeat(130));

let tiny = 0, small = 0, med = 0, large = 0, noData = 0;
let clCorrect60 = 0, clWrong60 = 0;
let clobCorrected = 0, clobStillWrong = 0;
let exLeading = 0;

for (const d of results) {
  if (d.clMove === null) { noData++; continue; }
  const abs = Math.abs(d.clMove);
  if (abs < 10) tiny++;
  else if (abs < 30) small++;
  else if (abs < 80) med++;
  else large++;

  const t60snap = d.snapshots.find(s => s.offset === 60);
  if (t60snap && t60snap.chainlink && d.clOpen) {
    const clDirAt60 = t60snap.chainlink >= d.clOpen ? 'UP' : 'DOWN';
    if (clDirAt60 === d.resolved) clCorrect60++;
    else clWrong60++;
  }

  const t1snap = d.snapshots.find(s => s.offset === 1);
  if (t1snap && t1snap.clobUp !== undefined) {
    if ((d.resolved === 'UP' && t1snap.clobUp > 0.50) || (d.resolved === 'DOWN' && t1snap.clobUp < 0.50)) {
      clobCorrected++;
    } else {
      clobStillWrong++;
    }
  }

  const t10 = d.snapshots.find(s => s.offset === 10);
  if (t10 && t10.exMean && d.clOpen) {
    const exDir = t10.exMean >= d.clOpen ? 'UP' : 'DOWN';
    if (exDir === d.resolved) exLeading++;
  }
}

console.log('\nCL Move Size Distribution:');
console.log(`  Tiny (<$10):   ${tiny}`);
console.log(`  Small ($10-30): ${small}`);
console.log(`  Med ($30-80):  ${med}`);
console.log(`  Large (>$80):  ${large}`);
console.log(`  No CL data:   ${noData}`);

console.log('\nCL Direction at T-60s (was CL already pointing the right way?):');
console.log(`  CL correct at T-60: ${clCorrect60} (${(clCorrect60/(clCorrect60+clWrong60)*100).toFixed(1)}%)`);
console.log(`  CL wrong at T-60:   ${clWrong60} (${(clWrong60/(clCorrect60+clWrong60)*100).toFixed(1)}%)`);

console.log('\nCLOB Self-Correction by T-1s:');
console.log(`  Corrected:    ${clobCorrected} (${(clobCorrected/(clobCorrected+clobStillWrong)*100).toFixed(1)}%)`);
console.log(`  Still wrong:  ${clobStillWrong} (${(clobStillWrong/(clobCorrected+clobStillWrong)*100).toFixed(1)}%)`);

console.log('\nExchange Direction at T-10s (leading indicator?):');
console.log(`  Exchanges agreed with resolution: ${exLeading}/${results.length} (${(exLeading/results.length*100).toFixed(1)}%)`);

// ─── Most interesting question: Where does info come from? ───
console.log('\n' + '='.repeat(130));
console.log('KEY QUESTION: Information cascade per flip');
console.log('='.repeat(130));
console.log('For each flip: who knew first? (CL direction change, exchange move, or CLOB move)\n');

for (const d of results) {
  if (d.clMove === null) continue;

  // When did CL first point the right way?
  let clFlipOffset = null;
  for (const s of d.snapshots) {
    if (s.chainlink && d.clOpen) {
      const dir = s.chainlink >= d.clOpen ? 'UP' : 'DOWN';
      if (dir === d.resolved) { clFlipOffset = s.offset; break; }
    }
  }

  // When did exchanges first point the right way?
  let exFlipOffset = null;
  for (const s of d.snapshots) {
    if (s.exMean && d.clOpen) {
      const dir = s.exMean >= d.clOpen ? 'UP' : 'DOWN';
      if (dir === d.resolved) { exFlipOffset = s.offset; break; }
    }
  }

  // When did CLOB first cross 0.50 in the right direction?
  let clobFlipOffset = null;
  for (const s of d.snapshots) {
    if (s.clobUp !== undefined) {
      if ((d.resolved === 'UP' && s.clobUp > 0.50) || (d.resolved === 'DOWN' && s.clobUp < 0.50)) {
        clobFlipOffset = s.offset;
        break;
      }
    }
  }

  const clStr = clFlipOffset !== null ? `T-${clFlipOffset}s` : 'never';
  const exStr = exFlipOffset !== null ? `T-${exFlipOffset}s` : 'never';
  const clobStr = clobFlipOffset !== null ? `T-${clobFlipOffset}s` : 'never';

  // Who was first?
  const times = [];
  if (clFlipOffset !== null) times.push({ who: 'CL', offset: clFlipOffset });
  if (exFlipOffset !== null) times.push({ who: 'EX', offset: exFlipOffset });
  if (clobFlipOffset !== null) times.push({ who: 'CLOB', offset: clobFlipOffset });
  times.sort((a, b) => b.offset - a.offset); // larger offset = earlier

  const leader = times.length > 0 ? times[0].who : 'none';
  const clMoveStr = d.clMove >= 0 ? `+$${d.clMove.toFixed(2)}` : `-$${Math.abs(d.clMove).toFixed(2)}`;

  console.log(`  ${d.time} | Resolved ${d.resolved} | CL ${clMoveStr} | Leader: ${leader.padEnd(4)} | CL: ${clStr.padEnd(7)} EX: ${exStr.padEnd(7)} CLOB: ${clobStr}`);
}

db.close();
console.log('\nDone.');
