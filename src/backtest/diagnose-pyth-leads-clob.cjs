/**
 * Pyth vs Chainlink vs CLOB Timing Analysis
 *
 * Hypothesis: MMs are watching Pyth (which tracks closer to Chainlink than Binance does)
 * and using it as a leading indicator for where Chainlink will settle.
 *
 * For each crash/flip event:
 * 1. When does Pyth first cross CL@open in the resolution direction?
 * 2. When does Chainlink first cross?
 * 3. When does CLOB first price the resolution?
 * 4. Does Pyth lead Chainlink? By how much?
 * 5. Does Pyth lead CLOB? Or does CLOB lead Pyth?
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== PYTH vs CHAINLINK vs CLOB TIMING ANALYSIS (final 60s) ===\n');

  const windows = await pool.query(`
    SELECT
      w.window_id, w.chainlink_price_at_close, w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  const events = [];

  for (const win of windows.rows) {
    const openEpoch = win.close_epoch - 900;
    const openTime = new Date(openEpoch * 1000).toISOString();
    const closeTime = win.window_close_time.toISOString();

    const clO = await pool.query(`
      SELECT price FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
      ORDER BY timestamp ASC LIMIT 1
    `, [openTime, closeTime]);
    if (!clO.rows.length) continue;
    const clOpen = parseFloat(clO.rows[0].price);
    const clClose = parseFloat(win.chainlink_price_at_close);
    const resolution = clClose >= clOpen ? 'UP' : 'DOWN';

    // Check for crash/flip (same logic as before)
    const clTicks = await pool.query(`
      SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= ($1::timestamptz - interval '60 seconds')
        AND timestamp <= $1::timestamptz
      ORDER BY timestamp ASC
    `, [closeTime]);

    let lastFlip = null, prevDir = null;
    for (const t of clTicks.rows) {
      const dir = parseFloat(t.price) >= clOpen ? 'UP' : 'DOWN';
      if (prevDir && dir !== prevDir) {
        lastFlip = { ttc: (win.close_epoch - parseFloat(t.ep)).toFixed(1), from: prevDir, to: dir };
      }
      prevDir = dir;
    }

    const clob60 = await pool.query(`
      SELECT symbol, best_ask, best_bid, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1
        AND timestamp >= to_timestamp($1)
        AND timestamp < to_timestamp($1 + 900)
        AND timestamp >= ($2::timestamptz - interval '60 seconds')
        AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [openEpoch, closeTime]);

    if (clob60.rows.length < 2) continue;

    let peakUp = 0, peakDn = 0;
    for (const snap of clob60.rows) {
      const bid = parseFloat(snap.best_bid) || 0;
      if (snap.symbol === 'btc-up' && bid > peakUp) peakUp = bid;
      if (snap.symbol === 'btc-down' && bid > peakDn) peakDn = bid;
    }
    const peakDir = peakUp > peakDn ? 'UP' : 'DOWN';
    const peakConf = Math.max(peakUp, peakDn);

    const isCrash = peakConf >= 0.80 && peakDir !== resolution;
    const hasFlip = lastFlip !== null && parseFloat(lastFlip.ttc) <= 30;

    if (!isCrash && !hasFlip) continue;

    events.push({
      window_id: win.window_id, close_epoch: win.close_epoch, open_epoch: openEpoch,
      clOpen, clClose, resolution, margin: clClose - clOpen,
      peakDir, peakConf, lastFlip, isCrash, closeTime,
    });
  }

  console.log(`Found ${events.length} crash/flip events.\n`);

  const summaryRows = [];

  for (const ev of events) {
    const tag = ev.isCrash ? '*** CRASH ***' : 'FLIP';
    console.log(`${'='.repeat(110)}`);
    console.log(`${tag} ${ev.window_id} | Resolved ${ev.resolution} (margin $${ev.margin.toFixed(2)})`);
    console.log(`CL@open=$${ev.clOpen.toFixed(2)} CL@close=$${ev.clClose.toFixed(2)}`);

    const t60Before = new Date((ev.close_epoch - 60) * 1000).toISOString();

    // Load Pyth, Chainlink, PolyRef, Binance, CLOB for final 60s
    const [pyth, chainlink, polyRef, binance, clobSnaps] = await Promise.all([
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_pyth' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks
        WHERE topic = 'crypto_prices' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM exchange_ticks
        WHERE exchange = 'binance' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT symbol, best_ask, best_bid, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM clob_price_snapshots
        WHERE symbol IN ('btc-down', 'btc-up')
          AND window_epoch = $1
          AND timestamp >= to_timestamp($1)
          AND timestamp < to_timestamp($1 + 900)
          AND timestamp >= $2::timestamptz AND timestamp <= $3::timestamptz
        ORDER BY timestamp ASC
      `, [ev.open_epoch, t60Before, ev.closeTime]),
    ]);

    console.log(`  Data: ${pyth.rows.length} pyth, ${chainlink.rows.length} chainlink, ${polyRef.rows.length} polyRef, ${binance.rows.length} binance, ${clobSnaps.rows.length} CLOB`);

    // Build second-by-second timeline
    const seconds = {};
    for (let ttc = 60; ttc >= 0; ttc--) {
      seconds[ttc] = { pyth: null, chainlink: null, polyRef: null, binance: null, dnAsk: null, upBid: null };
    }

    for (const r of pyth.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].pyth = parseFloat(r.price);
    }
    for (const r of chainlink.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].chainlink = parseFloat(r.price);
    }
    for (const r of polyRef.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].polyRef = parseFloat(r.price);
    }
    for (const r of binance.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].binance = parseFloat(r.price);
    }
    for (const r of clobSnaps.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc < 0 || ttc > 60) continue;
      if (r.symbol === 'btc-down') seconds[ttc].dnAsk = parseFloat(r.best_ask);
      if (r.symbol === 'btc-up') seconds[ttc].upBid = parseFloat(r.best_bid);
    }

    // Forward-fill
    let lP = null, lC = null, lR = null, lB = null, lDn = null, lUp = null;
    for (let ttc = 60; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      if (s.pyth !== null) lP = s.pyth; else s.pyth = lP;
      if (s.chainlink !== null) lC = s.chainlink; else s.chainlink = lC;
      if (s.polyRef !== null) lR = s.polyRef; else s.polyRef = lR;
      if (s.binance !== null) lB = s.binance; else s.binance = lB;
      if (s.dnAsk !== null) lDn = s.dnAsk; else s.dnAsk = lDn;
      if (s.upBid !== null) lUp = s.upBid; else s.upBid = lUp;
    }

    // Find first signal times
    let firstPyth = null, firstCL = null, firstPolyRef = null, firstBinance = null, firstClob = null;

    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      const pythDir = s.pyth !== null ? (s.pyth >= ev.clOpen ? 'UP' : 'DOWN') : null;
      const clDir = s.chainlink !== null ? (s.chainlink >= ev.clOpen ? 'UP' : 'DOWN') : null;
      const refDir = s.polyRef !== null ? (s.polyRef >= ev.clOpen ? 'UP' : 'DOWN') : null;
      const binDir = s.binance !== null ? (s.binance >= ev.clOpen ? 'UP' : 'DOWN') : null;
      let clobDir = null;
      if (s.dnAsk !== null) {
        clobDir = s.dnAsk > 0.55 ? 'DOWN' : s.dnAsk < 0.45 ? 'UP' : 'FLAT';
      }

      if (pythDir === ev.resolution && firstPyth === null) firstPyth = ttc;
      if (clDir === ev.resolution && firstCL === null) firstCL = ttc;
      if (refDir === ev.resolution && firstPolyRef === null) firstPolyRef = ttc;
      if (binDir === ev.resolution && firstBinance === null) firstBinance = ttc;
      if (clobDir === ev.resolution && firstClob === null) firstClob = ttc;
    }

    // Print timeline (final 30s)
    console.log('\n  TTC  | Pyth Δ      | Chainlink Δ | PolyRef Δ   | Binance Δ   | DN ask  | CLOB dir | Notes');
    console.log('  ' + '-'.repeat(105));

    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      const pd = s.pyth !== null ? s.pyth - ev.clOpen : null;
      const cd = s.chainlink !== null ? s.chainlink - ev.clOpen : null;
      const rd = s.polyRef !== null ? s.polyRef - ev.clOpen : null;
      const bd = s.binance !== null ? s.binance - ev.clOpen : null;

      const pythDir = pd !== null ? (pd >= 0 ? 'UP' : 'DN') : null;
      const clDir = cd !== null ? (cd >= 0 ? 'UP' : 'DN') : null;
      let clobDir = null;
      if (s.dnAsk !== null) {
        clobDir = s.dnAsk > 0.55 ? 'DOWN' : s.dnAsk < 0.45 ? 'UP' : 'FLAT';
      }

      const notes = [];
      if (ttc === firstPyth) notes.push('<<< PYTH');
      if (ttc === firstCL) notes.push('<<< CL');
      if (ttc === firstClob) notes.push('<<< CLOB');
      if (ttc === firstBinance) notes.push('<<< BIN');

      // Highlight when Pyth & CL disagree
      if (pythDir && clDir && pythDir !== clDir) notes.push('[PY≠CL]');
      // Highlight when Pyth agrees with CLOB but Binance doesn't
      if (pythDir && clobDir && pythDir === (clobDir === 'DOWN' ? 'DN' : clobDir === 'UP' ? 'UP' : null)) {
        const binDir2 = bd !== null ? (bd >= 0 ? 'UP' : 'DN') : null;
        if (binDir2 && binDir2 !== pythDir) notes.push('[PY=CLOB≠BIN]');
      }

      const fmtD = (d) => d !== null ? `$${d >= 0 ? '+' : ''}${d.toFixed(0)}`.padStart(11) : '          -';
      const fmtP = (p) => p !== null ? p.toFixed(3).padStart(7) : '   -   ';

      console.log(`  T-${String(ttc).padStart(2)}s | ${fmtD(pd)} | ${fmtD(cd)} | ${fmtD(rd)} | ${fmtD(bd)} | ${fmtP(s.dnAsk)} | ${(clobDir || '?').padStart(8)} | ${notes.join(' ')}`);
    }

    console.log(`\n  FIRST SIGNAL toward ${ev.resolution} (in final 30s):`);
    console.log(`    Pyth:      T-${firstPyth ?? 'never'}s`);
    console.log(`    Chainlink: T-${firstCL ?? 'never'}s`);
    console.log(`    PolyRef:   T-${firstPolyRef ?? 'never'}s`);
    console.log(`    Binance:   T-${firstBinance ?? 'never'}s`);
    console.log(`    CLOB:      T-${firstClob ?? 'never'}s`);

    // Compute leads
    const pythLeadsCL = (firstPyth !== null && firstCL !== null) ? firstPyth - firstCL : null;
    const pythLeadsClob = (firstPyth !== null && firstClob !== null) ? firstPyth - firstClob : null;
    const clobLeadsCL = (firstClob !== null && firstCL !== null) ? firstClob - firstCL : null;

    if (pythLeadsCL !== null) console.log(`    Pyth leads Chainlink by: ${pythLeadsCL}s`);
    if (pythLeadsClob !== null) console.log(`    Pyth leads CLOB by: ${pythLeadsClob}s`);
    if (clobLeadsCL !== null) console.log(`    CLOB leads Chainlink by: ${clobLeadsCL}s`);
    console.log();

    summaryRows.push({
      window: ev.window_id, type: ev.isCrash ? 'CRASH' : 'FLIP',
      resolution: ev.resolution, margin: ev.margin,
      firstPyth, firstCL, firstPolyRef, firstBinance, firstClob,
      pythLeadsCL, pythLeadsClob, clobLeadsCL,
    });

    // MS-level: Pyth vs Chainlink vs CLOB around the critical flip point
    // Use whichever came first: Pyth or CL signal
    const pivotTtc = Math.max(firstPyth || 0, firstCL || 0, firstClob || 0);
    if (pivotTtc > 0 && pivotTtc <= 30) {
      const pivotEpoch = ev.close_epoch - pivotTtc;
      const msWindow = 5;

      const [pythMs, clMs, clobMs] = await Promise.all([
        pool.query(`
          SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
          FROM rtds_ticks
          WHERE topic = 'crypto_prices_pyth' AND symbol = 'btc'
            AND timestamp >= to_timestamp($1::numeric - $2::numeric)
            AND timestamp <= to_timestamp($1::numeric + $2::numeric)
          ORDER BY timestamp ASC
        `, [pivotEpoch, msWindow]),
        pool.query(`
          SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
          FROM rtds_ticks
          WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
            AND timestamp >= to_timestamp($1::numeric - $2::numeric)
            AND timestamp <= to_timestamp($1::numeric + $2::numeric)
          ORDER BY timestamp ASC
        `, [pivotEpoch, msWindow]),
        pool.query(`
          SELECT symbol, best_ask, best_bid, EXTRACT(EPOCH FROM timestamp)::numeric as ep
          FROM clob_price_snapshots
          WHERE symbol IN ('btc-down', 'btc-up')
            AND window_epoch = $1
            AND timestamp >= to_timestamp($2::numeric - $3::numeric)
            AND timestamp <= to_timestamp($2::numeric + $3::numeric)
          ORDER BY timestamp ASC
        `, [ev.open_epoch, pivotEpoch, msWindow]),
      ]);

      console.log(`  MS-LEVEL AROUND PIVOT (T-${pivotTtc}s ± ${msWindow}s):`);
      console.log(`  ${'─'.repeat(100)}`);

      // Merge all sources
      const merged = [];
      for (const r of pythMs.rows) {
        const p = parseFloat(r.price);
        merged.push({ ep: parseFloat(r.ep), source: 'PYTH', price: p, delta: p - ev.clOpen, dir: p >= ev.clOpen ? 'UP' : 'DN' });
      }
      for (const r of clMs.rows) {
        const p = parseFloat(r.price);
        merged.push({ ep: parseFloat(r.ep), source: 'CL  ', price: p, delta: p - ev.clOpen, dir: p >= ev.clOpen ? 'UP' : 'DN' });
      }
      for (const r of clobMs.rows) {
        const side = r.symbol === 'btc-down' ? 'CLOB-DN' : 'CLOB-UP';
        merged.push({ ep: parseFloat(r.ep), source: side, ask: parseFloat(r.best_ask), bid: parseFloat(r.best_bid) });
      }
      merged.sort((a, b) => a.ep - b.ep);

      // Deduplicate consecutive same-source entries with same values
      let lastBySource = {};
      for (const m of merged.slice(0, 80)) {
        const ttcS = (ev.close_epoch - m.ep).toFixed(3);
        if (m.price !== undefined) {
          const key = `${m.source}:${m.price}`;
          if (lastBySource[m.source] === key) continue;
          lastBySource[m.source] = key;
          console.log(`    T-${ttcS.padStart(8)}s  ${m.source}  $${m.price.toFixed(2)} (Δ=${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(2)}) [${m.dir}]`);
        } else {
          const key = `${m.source}:${m.ask}:${m.bid}`;
          if (lastBySource[m.source] === key) continue;
          lastBySource[m.source] = key;
          console.log(`    T-${ttcS.padStart(8)}s  ${m.source.padEnd(4)}  ask=${m.ask.toFixed(3)} bid=${m.bid.toFixed(3)}`);
        }
      }
      console.log();
    }
  }

  // Overall summary
  console.log('\n' + '='.repeat(110));
  console.log('OVERALL TIMING SUMMARY');
  console.log('='.repeat(110));
  console.log('Window              | Type  | Res  | Margin | Pyth   | CL     | PolyRef| Binance| CLOB   | Pyth>CL | Pyth>CLOB | CLOB>CL');
  console.log('-'.repeat(110));
  for (const r of summaryRows) {
    const f = (v) => v !== null ? `T-${String(v).padStart(2)}s` : ' never';
    const g = (v) => v !== null ? `${v >= 0 ? '+' : ''}${v}s`.padStart(7) : '   n/a';
    console.log(
      `${r.window.padEnd(20)}| ${r.type.padEnd(6)}| ${r.resolution.padEnd(5)}| $${r.margin.toFixed(0).padStart(4)}  | ${f(r.firstPyth)} | ${f(r.firstCL)} | ${f(r.firstPolyRef)} | ${f(r.firstBinance)} | ${f(r.firstClob)} | ${g(r.pythLeadsCL)} | ${g(r.pythLeadsClob)}  | ${g(r.clobLeadsCL)}`
    );
  }

  // Compute averages
  const withPythCL = summaryRows.filter(r => r.pythLeadsCL !== null);
  const withPythClob = summaryRows.filter(r => r.pythLeadsClob !== null);
  const withClobCL = summaryRows.filter(r => r.clobLeadsCL !== null);

  if (withPythCL.length > 0) {
    const avg = withPythCL.reduce((s, r) => s + r.pythLeadsCL, 0) / withPythCL.length;
    console.log(`\nPyth leads Chainlink by avg: ${avg.toFixed(1)}s (${withPythCL.length} events)`);
  }
  if (withPythClob.length > 0) {
    const avg = withPythClob.reduce((s, r) => s + r.pythLeadsClob, 0) / withPythClob.length;
    console.log(`Pyth leads CLOB by avg: ${avg.toFixed(1)}s (${withPythClob.length} events)`);
  }
  if (withClobCL.length > 0) {
    const avg = withClobCL.reduce((s, r) => s + r.clobLeadsCL, 0) / withClobCL.length;
    console.log(`CLOB leads Chainlink by avg: ${avg.toFixed(1)}s (${withClobCL.length} events)`);
  }

  // Key question: does CLOB track Pyth closer than it tracks Binance?
  console.log('\n--- KEY QUESTION: Is the CLOB following Pyth? ---');
  const clobFollowsPyth = summaryRows.filter(r => r.firstPyth !== null && r.firstClob !== null);
  const clobFollowsBin = summaryRows.filter(r => r.firstBinance !== null && r.firstClob !== null);

  if (clobFollowsPyth.length > 0) {
    const avgLag = clobFollowsPyth.reduce((s, r) => s + (r.firstPyth - r.firstClob), 0) / clobFollowsPyth.length;
    console.log(`Avg gap Pyth→CLOB: ${avgLag.toFixed(1)}s (positive = Pyth leads) [${clobFollowsPyth.length} events]`);
  }
  if (clobFollowsBin.length > 0) {
    const avgLag = clobFollowsBin.reduce((s, r) => s + (r.firstBinance - r.firstClob), 0) / clobFollowsBin.length;
    console.log(`Avg gap Binance→CLOB: ${avgLag.toFixed(1)}s (positive = Binance leads) [${clobFollowsBin.length} events]`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
