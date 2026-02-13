/**
 * diagnose-flip-detection.cjs
 *
 * Finds windows where the CLOB was highly confident (>85%) in one direction
 * but resolution went the OTHER way. Then checks whether our 21-exchange
 * composite could have detected the flip before the CLOB repriced.
 *
 * The money trade: buy the opposite side at $0.10-$0.15 when CLOB is wrong
 * at $0.85-$0.95, then collect $1.00 at resolution.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/diagnose-flip-detection.cjs
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
    const closeEpoch = Math.floor(new Date(r.window_close_time).getTime() / 1000);
    return {
      close_epoch: closeEpoch,
      open_epoch: closeEpoch - 900,
      strike_price: strike,
      cl_close: clClose,
      cl_move: clClose - strike,
      actual_direction: r.resolved_direction
        ? r.resolved_direction.toLowerCase()
        : (clClose >= strike ? 'up' : 'down'),
    };
  });
}

// Load second-by-second CLOB data for a window
async function loadCLOBTimeline(windowEpoch, closeEpoch, duration) {
  const startEpoch = closeEpoch - duration;
  const rows = await query(`
    SELECT
      EXTRACT(EPOCH FROM timestamp)::int as epoch,
      symbol, mid_price, best_bid, best_ask
    FROM clob_price_snapshots
    WHERE window_epoch = $1
      AND timestamp >= to_timestamp($1::numeric)
      AND timestamp BETWEEN to_timestamp($2::numeric) AND to_timestamp($3::numeric)
      AND symbol IN ('btc-up', 'btc-down')
    ORDER BY timestamp
  `, [windowEpoch, startEpoch, closeEpoch]);

  // Bucket into seconds, keyed by epoch
  const timeline = new Map(); // epoch → { up_mid, down_mid, up_bid, down_bid }
  for (const r of rows) {
    const ep = r.epoch;
    if (!timeline.has(ep)) timeline.set(ep, {});
    const entry = timeline.get(ep);
    const mid = parseFloat(r.mid_price);
    const bid = parseFloat(r.best_bid);
    const ask = parseFloat(r.best_ask);
    if (r.symbol === 'btc-up') {
      entry.up_mid = mid;
      entry.up_bid = bid;
      entry.up_ask = ask;
    } else {
      entry.down_mid = mid;
      entry.down_bid = bid;
      entry.down_ask = ask;
    }
  }
  return timeline;
}

// Load second-by-second exchange data for a window
async function loadExchangeTimeline(closeEpoch, duration) {
  const startEpoch = closeEpoch - duration;
  const rows = await query(`
    SELECT
      EXTRACT(EPOCH FROM timestamp)::int as epoch,
      exchange, price
    FROM exchange_ticks
    WHERE symbol = 'btc'
      AND timestamp BETWEEN to_timestamp($1::numeric) AND to_timestamp($2::numeric)
    ORDER BY timestamp
  `, [startEpoch, closeEpoch]);

  // Bucket into seconds: epoch → { exchange: price }
  // Use last price per second per exchange
  const timeline = new Map();
  for (const r of rows) {
    const ep = r.epoch;
    if (!timeline.has(ep)) timeline.set(ep, {});
    timeline.get(ep)[r.exchange] = parseFloat(r.price);
  }
  return timeline;
}

// Load CL prices for a window
async function loadCLTimeline(closeEpoch, duration) {
  const startEpoch = closeEpoch - duration;
  const rows = await query(`
    SELECT
      EXTRACT(EPOCH FROM timestamp)::int as epoch,
      price
    FROM rtds_ticks
    WHERE topic = 'crypto_prices_chainlink'
      AND symbol = 'btc'
      AND timestamp BETWEEN to_timestamp($1::numeric) AND to_timestamp($2::numeric)
    ORDER BY timestamp
  `, [startEpoch, closeEpoch]);

  const timeline = new Map();
  for (const r of rows) {
    timeline.set(r.epoch, parseFloat(r.price));
  }
  return timeline;
}

// ── Analysis ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║    Flip Detection — Can Exchange Data Predict CLOB Reversals?       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const windows = await loadWindows();
  console.log(`\n  ${windows.length} resolved BTC windows`);

  // ── Step 1: Find windows where CLOB was highly confident in wrong direction ──
  console.log('\n── Scanning for flip events (CLOB peak >80% wrong direction) ──');

  const SCAN_DURATION = 900; // scan full 15-min window
  const flipEvents = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (i % 20 === 0) process.stdout.write(`  Scanning window ${i + 1}/${windows.length}...\r`);

    const clobTimeline = await loadCLOBTimeline(w.open_epoch, w.close_epoch, SCAN_DURATION);

    // Find peak confidence in the WRONG direction
    const wrongSide = w.actual_direction === 'up' ? 'down_mid' : 'up_mid';
    const correctSide = w.actual_direction === 'up' ? 'up_mid' : 'down_mid';
    const wrongBid = w.actual_direction === 'up' ? 'down_bid' : 'up_bid';

    let peakWrongPrice = 0;
    let peakWrongEpoch = 0;
    let lastWrongPrice = 0;
    let lastCorrectPrice = 0;

    for (const [epoch, data] of clobTimeline) {
      const wrongPrice = data[wrongSide];
      if (wrongPrice && wrongPrice > peakWrongPrice) {
        peakWrongPrice = wrongPrice;
        peakWrongEpoch = epoch;
      }
      if (data[wrongSide]) lastWrongPrice = data[wrongSide];
      if (data[correctSide]) lastCorrectPrice = data[correctSide];
    }

    // Also track when peak occurred and what the final CLOB prices were
    if (peakWrongPrice >= 0.80) {
      // Find the buyable price (bid on correct side = ask on wrong side)
      // When wrong side is at 0.90, correct side bid might be at 0.05-0.10
      const correctBid = w.actual_direction === 'up' ? 'up_bid' : 'down_bid';

      // Get CLOB prices at various times
      const snapshots = [];
      const offsets = [300, 120, 60, 45, 30, 20, 15, 10, 5, 3, 1];
      for (const offset of offsets) {
        const targetEpoch = w.close_epoch - offset;
        // Find closest CLOB snapshot
        let best = null;
        let bestDist = Infinity;
        for (const [epoch, data] of clobTimeline) {
          const dist = Math.abs(epoch - targetEpoch);
          if (dist < bestDist && dist <= 3) {
            bestDist = dist;
            best = data;
          }
        }
        snapshots.push({
          offset,
          wrong_mid: best ? best[wrongSide] : null,
          correct_mid: best ? best[correctSide] : null,
          correct_bid: best ? best[correctBid] : null,
          wrong_bid: best ? best[wrongBid] : null,
        });
      }

      flipEvents.push({
        ...w,
        peak_wrong_price: peakWrongPrice,
        peak_wrong_epoch: peakWrongEpoch,
        peak_seconds_before_close: w.close_epoch - peakWrongEpoch,
        final_wrong_price: lastWrongPrice,
        final_correct_price: lastCorrectPrice,
        clobTimeline,
        snapshots,
      });
    }
  }

  console.log(`\n  Found ${flipEvents.length} flip events (CLOB peak >80% wrong direction)\n`);

  if (flipEvents.length === 0) {
    console.log('No flip events found. Exiting.');
    await pool.end();
    return;
  }

  // Sort by peak wrong price descending (most dramatic flips first)
  flipEvents.sort((a, b) => b.peak_wrong_price - a.peak_wrong_price);

  // ── Step 2: Overview of flip events ──
  console.log('='.repeat(70));
  console.log('FLIP EVENTS OVERVIEW');
  console.log('='.repeat(70));

  console.log(`\n  ${'Time (UTC)'.padEnd(20)}| Resolved | Peak Wrong | Peak @    | CL Move     | Final Wrong`);
  console.log(`  ${'-'.repeat(20)}+----------+------------+-----------+-------------+-----------`);

  for (const f of flipEvents) {
    const time = new Date(f.close_epoch * 1000).toISOString().slice(5, 19);
    const peakAt = `T-${f.peak_seconds_before_close}s`;
    const clMoveStr = (f.cl_move >= 0 ? '+' : '') + '$' + fmt(f.cl_move, 0);

    console.log(`  ${time.padEnd(20)}| ${f.actual_direction.padEnd(8)} | $${fmt(f.peak_wrong_price, 3).padStart(8)} | ${peakAt.padStart(9)} | ${clMoveStr.padStart(11)} | $${fmt(f.final_wrong_price, 3)}`);
  }

  // ── Step 3: For each flip, trace exchange composite vs CLOB ──
  console.log('\n' + '='.repeat(70));
  console.log('DETAILED FLIP ANALYSIS — Exchange Composite vs CLOB Timeline');
  console.log('  Can our exchanges detect the flip before CLOB reprices?');
  console.log('='.repeat(70));

  const allResults = [];

  for (const f of flipEvents) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Window: ${new Date(f.close_epoch * 1000).toISOString().slice(0, 19)} | Resolved: ${f.actual_direction.toUpperCase()} | CL move: ${f.cl_move >= 0 ? '+' : ''}$${fmt(f.cl_move, 2)}`);
    console.log(`CLOB peak wrong: $${fmt(f.peak_wrong_price, 3)} at T-${f.peak_seconds_before_close}s`);

    // Load exchange and CL timelines for final 5 minutes
    const exchangeTimeline = await loadExchangeTimeline(f.close_epoch, 300);
    const clTimeline = await loadCLTimeline(f.close_epoch, 300);

    // Build second-by-second composite from exchanges
    // Forward-fill exchange prices
    const exchanges = {};
    const exchangeComposite = new Map(); // epoch → median of all exchanges

    for (let sec = f.close_epoch - 300; sec <= f.close_epoch; sec++) {
      const tickData = exchangeTimeline.get(sec);
      if (tickData) {
        for (const [ex, price] of Object.entries(tickData)) {
          exchanges[ex] = price;
        }
      }

      const currentPrices = Object.values(exchanges);
      if (currentPrices.length >= 3) {
        exchangeComposite.set(sec, median(currentPrices));
      }
    }

    // Get CL@open (strike equivalent from rtds_ticks)
    // Use actual CL at open, not strike_price
    let clAtOpen = null;
    const clOpenRows = await query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp BETWEEN to_timestamp($1::numeric - 3) AND to_timestamp($1::numeric + 3)
      ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - $1::numeric) LIMIT 1
    `, [f.open_epoch]);
    if (clOpenRows.length > 0) clAtOpen = parseFloat(clOpenRows[0].price);

    // Compute exchange composite direction at each second
    // Direction = composite@now > composite@windowOpen (i.e., has price risen since open?)
    const compositeAtOpen = exchangeComposite.get(f.close_epoch - 300) ||
                            exchangeComposite.get(f.close_epoch - 299) ||
                            exchangeComposite.get(f.close_epoch - 298);

    // Print timeline for final 60 seconds
    console.log(`\n  T-offset | Exch Median  | CL Price     | Exch Move    | CL Move      | CLOB Wrong | CLOB Correct | Entry Bid`);
    console.log(`  ---------+--------------+--------------+--------------+--------------+------------+--------------+----------`);

    const offsets = [300, 120, 60, 45, 30, 20, 15, 10, 5, 3, 1, 0];
    let firstExchFlipOffset = null;
    let firstCLFlipOffset = null;
    let firstCLOBFlipOffset = null;

    const wrongSide = f.actual_direction === 'up' ? 'down_mid' : 'up_mid';
    const correctSide = f.actual_direction === 'up' ? 'up_mid' : 'down_mid';

    for (const offset of offsets) {
      const epoch = f.close_epoch - offset;
      const comp = exchangeComposite.get(epoch);
      const cl = clTimeline.get(epoch);

      // Exchange move from strike (Polymarket ref ≈ exchange spot at open)
      const exchMove = comp ? comp - f.strike_price : null;
      // CL move from CL@open
      const clMove = (cl && clAtOpen) ? cl - clAtOpen : null;

      // Exchange direction
      const exchDir = exchMove != null ? (exchMove >= 0 ? 'up' : 'down') : null;
      // CL direction
      const clDir = clMove != null ? (clMove >= 0 ? 'up' : 'down') : null;

      // Track first flip detection
      if (exchDir === f.actual_direction && firstExchFlipOffset === null && offset <= 120) {
        firstExchFlipOffset = offset;
      }
      if (clDir === f.actual_direction && firstCLFlipOffset === null && offset <= 120) {
        firstCLFlipOffset = offset;
      }

      // CLOB data
      const snap = f.snapshots.find(s => s.offset === offset);
      const clobWrong = snap ? snap.wrong_mid : null;
      const clobCorrect = snap ? snap.correct_mid : null;
      const clobCorrectBid = snap ? snap.correct_bid : null;

      if (clobCorrect && clobCorrect > 0.50 && firstCLOBFlipOffset === null && offset <= 120) {
        firstCLOBFlipOffset = offset;
      }

      const compStr = comp ? ('$' + fmt(comp, 0)).padStart(12) : '         N/A';
      const clStr = cl ? ('$' + fmt(cl, 0)).padStart(12) : '         N/A';
      const exchMoveStr = exchMove != null ? ((exchMove >= 0 ? '+' : '') + '$' + fmt(exchMove, 0)).padStart(12) : '         N/A';
      const clMoveStr = clMove != null ? ((clMove >= 0 ? '+' : '') + '$' + fmt(clMove, 0)).padStart(12) : '         N/A';
      const clobWrongStr = clobWrong != null ? ('$' + fmt(clobWrong, 3)).padStart(10) : '       N/A';
      const clobCorrectStr = clobCorrect != null ? ('$' + fmt(clobCorrect, 3)).padStart(12) : '         N/A';
      const bidStr = clobCorrectBid != null ? ('$' + fmt(clobCorrectBid, 3)).padStart(8) : '     N/A';

      console.log(`  T-${String(offset).padStart(4)}s |${compStr} |${clStr} |${exchMoveStr} |${clMoveStr} |${clobWrongStr} |${clobCorrectStr} | ${bidStr}`);
    }

    // Summary for this flip
    console.log(`\n  Detection timing:`);
    console.log(`    Exchange composite first shows correct direction: ${firstExchFlipOffset != null ? 'T-' + firstExchFlipOffset + 's' : 'NEVER (in final 2min)'}`);
    console.log(`    CL oracle first shows correct direction:          ${firstCLFlipOffset != null ? 'T-' + firstCLFlipOffset + 's' : 'NEVER (in final 2min)'}`);
    console.log(`    CLOB first prices correct side > $0.50:           ${firstCLOBFlipOffset != null ? 'T-' + firstCLOBFlipOffset + 's' : 'NEVER (in final 2min)'}`);

    // What would entry have looked like?
    if (firstExchFlipOffset != null) {
      const snap = f.snapshots.find(s => s.offset === firstExchFlipOffset);
      if (snap && snap.correct_bid != null) {
        const entryPrice = snap.correct_bid;
        const pnl = 1.0 - entryPrice;
        console.log(`    If bought correct side when exchanges flipped (T-${firstExchFlipOffset}s): entry $${fmt(entryPrice, 3)}, PnL: $${fmt(pnl, 3)}/contract`);
      }
    }

    allResults.push({
      close_epoch: f.close_epoch,
      actual_direction: f.actual_direction,
      cl_move: f.cl_move,
      peak_wrong: f.peak_wrong_price,
      peak_at: f.peak_seconds_before_close,
      exch_flip: firstExchFlipOffset,
      cl_flip: firstCLFlipOffset,
      clob_flip: firstCLOBFlipOffset,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Summary across all flips
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY — Detection Timing Across All Flip Events');
  console.log('='.repeat(70));

  console.log(`\n  ${'Window'.padEnd(20)}| Dir  | CL Move  | Peak Wrong | Exch Flip | CL Flip | CLOB Flip | Exch Lead`);
  console.log(`  ${'-'.repeat(20)}+------+----------+------------+-----------+---------+-----------+----------`);

  for (const r of allResults) {
    const time = new Date(r.close_epoch * 1000).toISOString().slice(5, 19);
    const clMoveStr = (r.cl_move >= 0 ? '+' : '') + '$' + fmt(r.cl_move, 0);
    const exchStr = r.exch_flip != null ? `T-${r.exch_flip}s` : 'Never';
    const clStr = r.cl_flip != null ? `T-${r.cl_flip}s` : 'Never';
    const clobStr = r.clob_flip != null ? `T-${r.clob_flip}s` : 'Never';

    // Exchange lead over CLOB
    let leadStr = 'N/A';
    if (r.exch_flip != null && r.clob_flip != null) {
      const lead = r.exch_flip - r.clob_flip;
      leadStr = lead > 0 ? `+${lead}s` : `${lead}s`;
    } else if (r.exch_flip != null && r.clob_flip === null) {
      leadStr = 'CLOB never';
    }

    console.log(`  ${time.padEnd(20)}| ${r.actual_direction.padEnd(4)} | ${clMoveStr.padStart(8)} | $${fmt(r.peak_wrong, 3).padStart(8)} | ${exchStr.padStart(9)} | ${clStr.padStart(7)} | ${clobStr.padStart(9)} | ${leadStr.padStart(8)}`);
  }

  // Stats
  const exchFlips = allResults.filter(r => r.exch_flip != null);
  const exchLeadsCLOB = allResults.filter(r =>
    r.exch_flip != null && r.clob_flip != null && r.exch_flip > r.clob_flip
  );
  const exchNeverFlips = allResults.filter(r => r.exch_flip === null);

  console.log(`\n  Exchange detects flip (in final 2min): ${exchFlips.length}/${allResults.length}`);
  console.log(`  Exchange NEVER detects flip:            ${exchNeverFlips.length}/${allResults.length}`);
  console.log(`  Exchange leads CLOB:                    ${exchLeadsCLOB.length}/${allResults.length}`);

  if (exchFlips.length > 0) {
    const avgExchFlip = exchFlips.reduce((s, r) => s + r.exch_flip, 0) / exchFlips.length;
    console.log(`  Avg exchange flip timing:               T-${fmt(avgExchFlip, 0)}s`);
  }

  console.log('\n' + '='.repeat(70));
  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
