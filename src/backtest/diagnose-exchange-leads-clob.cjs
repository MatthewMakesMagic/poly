/**
 * Exchange vs CLOB Timing Analysis
 *
 * For each crash/flip window: build a ms-level timeline showing:
 * 1. When does Binance start moving?
 * 2. When does CLOB start repricing?
 * 3. What's the lag between exchange move and CLOB reprice?
 * 4. Is there a window where exchange has moved but CLOB hasn't caught up?
 *
 * Focus: final 60s only, all data sources aligned.
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== EXCHANGE vs CLOB TIMING ANALYSIS (final 60s) ===\n');

  const windows = await pool.query(`
    SELECT
      w.window_id, w.chainlink_price_at_close, w.window_close_time,
      EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC
    LIMIT 200
  `);

  console.log(`Scanning ${windows.rows.length} windows for crash/flip events...\n`);

  const events = [];

  for (const win of windows.rows) {
    const openEpoch = win.close_epoch - 900;
    const openTime = new Date(openEpoch * 1000).toISOString();
    const closeTime = win.window_close_time.toISOString();

    // CL@open
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

    // CL direction in final 60s — check for flips
    const clTicks = await pool.query(`
      SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= ($1::timestamptz - interval '60 seconds')
        AND timestamp <= $1::timestamptz
      ORDER BY timestamp ASC
    `, [closeTime]);

    let lastFlip = null;
    let prevDir = null;
    for (const t of clTicks.rows) {
      const dir = parseFloat(t.price) >= clOpen ? 'UP' : 'DOWN';
      if (prevDir && dir !== prevDir) {
        lastFlip = { ttc: (win.close_epoch - parseFloat(t.ep)).toFixed(1), from: prevDir, to: dir };
      }
      prevDir = dir;
    }

    // CLOB peak
    const clob60 = await pool.query(`
      SELECT symbol, best_ask, best_bid,
             EXTRACT(EPOCH FROM timestamp)::numeric as ep
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
      window_id: win.window_id,
      close_epoch: win.close_epoch,
      open_epoch: openEpoch,
      clOpen, clClose, resolution,
      margin: clClose - clOpen,
      peakDir, peakConf,
      lastFlip, isCrash,
      closeTime,
    });
  }

  console.log(`Found ${events.length} crash/flip events. Deep-diving each...\n`);

  // For each event, build full ms-level timeline
  for (const ev of events) {
    const tag = ev.isCrash ? '*** CRASH ***' : 'FLIP';
    console.log(`${'='.repeat(100)}`);
    console.log(`${tag} ${ev.window_id} | Resolved ${ev.resolution} (margin $${ev.margin.toFixed(2)})`);
    console.log(`CL@open=$${ev.clOpen.toFixed(2)} CL@close=$${ev.clClose.toFixed(2)} | Peak CLOB: ${ev.peakDir} @ ${ev.peakConf.toFixed(3)}`);
    if (ev.lastFlip) console.log(`Oracle flip: ${ev.lastFlip.from}→${ev.lastFlip.to} at T-${ev.lastFlip.ttc}s`);

    const t60Before = new Date((ev.close_epoch - 60) * 1000).toISOString();

    // Load ALL data sources for final 60s
    const [exchanges, polyRef, chainlink, clobSnaps] = await Promise.all([
      pool.query(`
        SELECT exchange, price, EXTRACT(EPOCH FROM timestamp)::numeric as ep,
               timestamp
        FROM exchange_ticks
        WHERE timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
          AND exchange IN ('binance', 'coinbase', 'kraken', 'bybit', 'okx')
          AND symbol = 'btc'
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
        FROM rtds_ticks
        WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT symbol, best_ask, best_bid,
               EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM clob_price_snapshots
        WHERE symbol IN ('btc-down', 'btc-up')
          AND window_epoch = $1
          AND timestamp >= to_timestamp($1)
          AND timestamp < to_timestamp($1 + 900)
          AND timestamp >= $2::timestamptz
          AND timestamp <= $3::timestamptz
        ORDER BY timestamp ASC
      `, [ev.open_epoch, t60Before, ev.closeTime]),
    ]);

    console.log(`  Data: ${exchanges.rows.length} exchange ticks, ${polyRef.rows.length} polyRef, ${chainlink.rows.length} chainlink, ${clobSnaps.rows.length} CLOB snaps`);

    // Count by exchange
    const exchCounts = {};
    for (const r of exchanges.rows) {
      exchCounts[r.exchange] = (exchCounts[r.exchange] || 0) + 1;
    }
    console.log(`  Exchanges: ${Object.entries(exchCounts).map(([k,v]) => `${k}=${v}`).join(', ')}`);

    // Build unified timeline by second
    // For each second T-60 to T-0, get: Binance price, PolyRef, Chainlink, CLOB DN ask, CLOB UP bid
    const seconds = {};
    for (let ttc = 60; ttc >= 0; ttc--) {
      seconds[ttc] = {
        binance: null, coinbase: null, polyRef: null, chainlink: null,
        dnAsk: null, dnBid: null, upAsk: null, upBid: null,
      };
    }

    // Fill exchange data (use latest price at or before each second)
    for (const r of exchanges.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc < 0 || ttc > 60) continue;
      if (r.exchange === 'binance') seconds[ttc].binance = parseFloat(r.price);
      if (r.exchange === 'coinbase') seconds[ttc].coinbase = parseFloat(r.price);
    }

    for (const r of polyRef.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].polyRef = parseFloat(r.price);
    }

    for (const r of chainlink.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 60) seconds[ttc].chainlink = parseFloat(r.price);
    }

    for (const r of clobSnaps.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc < 0 || ttc > 60) continue;
      if (r.symbol === 'btc-down') {
        seconds[ttc].dnAsk = parseFloat(r.best_ask);
        seconds[ttc].dnBid = parseFloat(r.best_bid);
      } else {
        seconds[ttc].upAsk = parseFloat(r.best_ask);
        seconds[ttc].upBid = parseFloat(r.best_bid);
      }
    }

    // Forward-fill: carry last known value
    let lastBin = null, lastCB = null, lastRef = null, lastCL = null;
    let lastDnA = null, lastDnB = null, lastUpA = null, lastUpB = null;
    for (let ttc = 60; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      if (s.binance !== null) lastBin = s.binance; else s.binance = lastBin;
      if (s.coinbase !== null) lastCB = s.coinbase; else s.coinbase = lastCB;
      if (s.polyRef !== null) lastRef = s.polyRef; else s.polyRef = lastRef;
      if (s.chainlink !== null) lastCL = s.chainlink; else s.chainlink = lastCL;
      if (s.dnAsk !== null) lastDnA = s.dnAsk; else s.dnAsk = lastDnA;
      if (s.dnBid !== null) lastDnB = s.dnBid; else s.dnBid = lastDnB;
      if (s.upAsk !== null) lastUpA = s.upAsk; else s.upAsk = lastUpA;
      if (s.upBid !== null) lastUpB = s.upBid; else s.upBid = lastUpB;
    }

    // Print timeline (final 30s only for readability)
    console.log('\n  TTC  | Binance Δ   | Coinbase Δ  | PolyRef Δ   | Chainlink Δ | DN ask  | UP bid  | CLOB dir | Notes');
    console.log('  ' + '-'.repeat(115));

    let firstMoveDetected = null; // When exchange first crosses zero opposite to peak
    let firstClobReact = null; // When CLOB first reacts

    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      const binDelta = s.binance !== null ? s.binance - ev.clOpen : null;
      const cbDelta = s.coinbase !== null ? s.coinbase - ev.clOpen : null;
      const refDelta = s.polyRef !== null ? s.polyRef - ev.clOpen : null;
      const clDelta = s.chainlink !== null ? s.chainlink - ev.clOpen : null;

      // Determine exchange direction (using Binance as primary)
      const exchDir = binDelta !== null ? (binDelta >= 0 ? 'UP' : 'DOWN') : null;
      const clDir = clDelta !== null ? (clDelta >= 0 ? 'UP' : 'DOWN') : null;

      // CLOB direction from DN ask
      let clobDir = null;
      if (s.dnAsk !== null) {
        clobDir = s.dnAsk > 0.55 ? 'DOWN' : s.dnAsk < 0.45 ? 'UP' : 'FLAT';
      }

      const notes = [];

      // Detect when exchange first signals the resolution direction
      if (exchDir === ev.resolution && firstMoveDetected === null) {
        firstMoveDetected = ttc;
        notes.push('<<< EXCHANGE SIGNALS');
      }

      // Detect when CLOB first reacts toward resolution
      if (clobDir === ev.resolution && firstClobReact === null) {
        firstClobReact = ttc;
        notes.push('<<< CLOB REACTS');
      }

      // Detect disagreement: exchange says one thing, CLOB says another
      if (exchDir && clobDir && exchDir !== clobDir && clobDir !== 'FLAT') {
        notes.push('*** DISAGREE ***');
      }

      const fmtDelta = (d) => d !== null ? `$${d >= 0 ? '+' : ''}${d.toFixed(0)}`.padStart(11) : '          -';
      const fmtPrice = (p) => p !== null ? p.toFixed(3).padStart(7) : '   -   ';

      console.log(`  T-${String(ttc).padStart(2)}s | ${fmtDelta(binDelta)} | ${fmtDelta(cbDelta)} | ${fmtDelta(refDelta)} | ${fmtDelta(clDelta)} | ${fmtPrice(s.dnAsk)} | ${fmtPrice(s.upBid)} | ${(clobDir || '?').padStart(8)} | ${notes.join(' ')}`);
    }

    // Summary for this window
    console.log(`\n  TIMING SUMMARY:`);
    console.log(`    Exchange first signals ${ev.resolution}: T-${firstMoveDetected ?? '?'}s`);
    console.log(`    CLOB first reacts toward ${ev.resolution}: T-${firstClobReact ?? '?'}s`);
    if (firstMoveDetected !== null && firstClobReact !== null) {
      const gap = firstMoveDetected - firstClobReact;
      console.log(`    GAP (exchange lead over CLOB): ${gap}s ${gap > 0 ? '<<< POTENTIAL WINDOW' : '(no gap)'}`);
    }
    console.log();

    // Millisecond-level deep dive: around the flip point
    // Find exact moment exchange crosses zero toward resolution
    if (firstMoveDetected !== null) {
      const flipEpoch = ev.close_epoch - firstMoveDetected;
      const msWindow = 5; // Look 5s around the flip

      const [exchMs, clobMs] = await Promise.all([
        pool.query(`
          SELECT exchange, price,
                 EXTRACT(EPOCH FROM timestamp)::numeric as ep
          FROM exchange_ticks
          WHERE exchange = 'binance' AND symbol = 'btc'
            AND timestamp >= to_timestamp($1::numeric - $2::numeric)
            AND timestamp <= to_timestamp($1::numeric + $2::numeric)
          ORDER BY timestamp ASC
        `, [flipEpoch, msWindow]),
        pool.query(`
          SELECT symbol, best_ask, best_bid,
                 EXTRACT(EPOCH FROM timestamp)::numeric as ep
          FROM clob_price_snapshots
          WHERE symbol IN ('btc-down', 'btc-up')
            AND window_epoch = $1
            AND timestamp >= to_timestamp($2::numeric - $3::numeric)
            AND timestamp <= to_timestamp($2::numeric + $3::numeric)
          ORDER BY timestamp ASC
        `, [ev.open_epoch, flipEpoch, msWindow]),
      ]);

      if (exchMs.rows.length > 0 && clobMs.rows.length > 0) {
        console.log(`  MS-LEVEL AROUND EXCHANGE FLIP (T-${firstMoveDetected}s ± ${msWindow}s):`);
        console.log(`  ${'─'.repeat(90)}`);

        // Merge and sort by timestamp
        const merged = [];
        for (const r of exchMs.rows) {
          merged.push({
            ep: parseFloat(r.ep),
            source: 'BINANCE',
            price: parseFloat(r.price),
            delta: parseFloat(r.price) - ev.clOpen,
          });
        }
        for (const r of clobMs.rows) {
          const side = r.symbol === 'btc-down' ? 'DN' : 'UP';
          merged.push({
            ep: parseFloat(r.ep),
            source: `CLOB-${side}`,
            ask: parseFloat(r.best_ask),
            bid: parseFloat(r.best_bid),
          });
        }
        merged.sort((a, b) => a.ep - b.ep);

        for (const m of merged.slice(0, 50)) { // Limit output
          const ttcMs = ((ev.close_epoch - m.ep) * 1000).toFixed(0);
          const ttcS = ((ev.close_epoch - m.ep)).toFixed(3);
          if (m.source === 'BINANCE') {
            const dir = m.delta >= 0 ? 'UP' : 'DN';
            console.log(`    T-${ttcS.padStart(8)}s  ${m.source.padEnd(8)} $${m.price.toFixed(2)} (Δ=${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(2)}) [${dir}]`);
          } else {
            console.log(`    T-${ttcS.padStart(8)}s  ${m.source.padEnd(8)} ask=${m.ask.toFixed(3)} bid=${m.bid.toFixed(3)}`);
          }
        }
        console.log();
      }
    }
  }

  // Overall summary
  console.log('\n' + '='.repeat(100));
  console.log('OVERALL TIMING GAPS:');
  console.log('='.repeat(100));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
