/**
 * All Exchanges vs Oracle Timing
 *
 * Hypothesis: Oracle = composite of ~16 exchanges. MMs watch exchange prices
 * and predict where the oracle will land. If we can see the same exchange data,
 * we can make the same prediction.
 *
 * For each crash/flip window: show ALL exchanges (not just Binance) alongside
 * Pyth, Chainlink, and CLOB. Focus on DOWN resolutions where Binance stayed UP —
 * which other exchanges are dropping?
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== ALL EXCHANGES vs ORACLE COMPOSITE ANALYSIS ===\n');

  // First, understand what exchanges we have and their tick rates
  const exchInfo = await pool.query(`
    SELECT exchange, COUNT(*) as cnt,
           MIN(timestamp) as first, MAX(timestamp) as last
    FROM exchange_ticks WHERE symbol = 'btc'
    GROUP BY exchange ORDER BY cnt DESC
  `);
  console.log('Exchange coverage:');
  for (const r of exchInfo.rows) {
    console.log(`  ${r.exchange}: ${r.cnt} ticks (${r.first.toISOString().slice(0,16)} to ${r.last.toISOString().slice(0,16)})`);
  }
  console.log();

  const windows = await pool.query(`
    SELECT w.window_id, w.chainlink_price_at_close, w.window_close_time,
           EXTRACT(EPOCH FROM w.window_close_time)::bigint as close_epoch
    FROM window_close_events w
    WHERE w.symbol = 'btc' AND w.chainlink_price_at_close IS NOT NULL
    ORDER BY w.window_close_time DESC LIMIT 200
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

    const clTicks = await pool.query(`
      SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
        AND timestamp >= ($1::timestamptz - interval '60 seconds') AND timestamp <= $1::timestamptz
      ORDER BY timestamp ASC
    `, [closeTime]);

    let lastFlip = null, prevDir = null;
    for (const t of clTicks.rows) {
      const dir = parseFloat(t.price) >= clOpen ? 'UP' : 'DOWN';
      if (prevDir && dir !== prevDir) lastFlip = { ttc: (win.close_epoch - parseFloat(t.ep)).toFixed(1), from: prevDir, to: dir };
      prevDir = dir;
    }

    const clob60 = await pool.query(`
      SELECT symbol, best_bid, EXTRACT(EPOCH FROM timestamp)::numeric as ep
      FROM clob_price_snapshots
      WHERE symbol IN ('btc-down', 'btc-up')
        AND window_epoch = $1 AND timestamp >= to_timestamp($1) AND timestamp < to_timestamp($1 + 900)
        AND timestamp >= ($2::timestamptz - interval '60 seconds') AND timestamp <= $2::timestamptz
      ORDER BY timestamp ASC
    `, [openEpoch, closeTime]);

    if (clob60.rows.length < 2) continue;
    let peakUp = 0, peakDn = 0;
    for (const s of clob60.rows) {
      const bid = parseFloat(s.best_bid) || 0;
      if (s.symbol === 'btc-up' && bid > peakUp) peakUp = bid;
      if (s.symbol === 'btc-down' && bid > peakDn) peakDn = bid;
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

  for (const ev of events) {
    const tag = ev.isCrash ? 'CRASH' : 'FLIP';
    console.log('='.repeat(130));
    console.log(`${tag} ${ev.window_id} | Resolved ${ev.resolution} (margin $${ev.margin.toFixed(2)}) | CL@open=$${ev.clOpen.toFixed(2)}`);

    const t60Before = new Date((ev.close_epoch - 60) * 1000).toISOString();

    // Load ALL exchanges + oracles + CLOB
    const [allExch, pyth, chainlink, polyRef, clobSnaps] = await Promise.all([
      pool.query(`
        SELECT exchange, price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM exchange_ticks
        WHERE symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks WHERE topic = 'crypto_prices_pyth' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks WHERE topic = 'crypto_prices_chainlink' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT price, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM rtds_ticks WHERE topic = 'crypto_prices' AND symbol = 'btc'
          AND timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
        ORDER BY timestamp ASC
      `, [t60Before, ev.closeTime]),
      pool.query(`
        SELECT symbol, best_ask, EXTRACT(EPOCH FROM timestamp)::numeric as ep
        FROM clob_price_snapshots
        WHERE symbol IN ('btc-down', 'btc-up')
          AND window_epoch = $1 AND timestamp >= to_timestamp($1) AND timestamp < to_timestamp($1 + 900)
          AND timestamp >= $2::timestamptz AND timestamp <= $3::timestamptz
        ORDER BY timestamp ASC
      `, [ev.open_epoch, t60Before, ev.closeTime]),
    ]);

    // Separate exchanges
    const exchByName = {};
    for (const r of allExch.rows) {
      if (!exchByName[r.exchange]) exchByName[r.exchange] = [];
      exchByName[r.exchange].push({ price: parseFloat(r.price), ep: parseFloat(r.ep) });
    }
    const exchNames = Object.keys(exchByName).sort();
    console.log(`  Exchanges: ${exchNames.map(e => `${e}=${exchByName[e].length}`).join(', ')}`);

    // Build second-by-second timeline
    const seconds = {};
    for (let ttc = 30; ttc >= 0; ttc--) {
      seconds[ttc] = { pyth: null, chainlink: null, polyRef: null, dnAsk: null };
      for (const e of exchNames) seconds[ttc][e] = null;
    }

    // Fill data
    for (const e of exchNames) {
      for (const r of exchByName[e]) {
        const ttc = Math.round(ev.close_epoch - r.ep);
        if (ttc >= 0 && ttc <= 30 && seconds[ttc]) seconds[ttc][e] = r.price;
      }
    }
    for (const r of pyth.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 30) seconds[ttc].pyth = parseFloat(r.price);
    }
    for (const r of chainlink.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 30) seconds[ttc].chainlink = parseFloat(r.price);
    }
    for (const r of polyRef.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 30) seconds[ttc].polyRef = parseFloat(r.price);
    }
    for (const r of clobSnaps.rows) {
      const ttc = Math.round(ev.close_epoch - parseFloat(r.ep));
      if (ttc >= 0 && ttc <= 30 && r.symbol === 'btc-down') seconds[ttc].dnAsk = parseFloat(r.best_ask);
    }

    // Forward-fill
    const lastVals = {};
    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      for (const key of [...exchNames, 'pyth', 'chainlink', 'polyRef', 'dnAsk']) {
        if (s[key] !== null) lastVals[key] = s[key]; else s[key] = lastVals[key] || null;
      }
    }

    // Compute median/mean of exchanges at each second (simulating oracle composite)
    // Also compute: which exchanges are above/below CL@open?
    const fmtD = (d) => d !== null ? `${d >= 0 ? '+' : ''}${d.toFixed(0)}`.padStart(6) : '     -';

    // Header
    const exchHeaders = exchNames.map(e => e.slice(0, 7).padStart(8)).join(' |');
    console.log(`\n  TTC  |${exchHeaders} | PolyRef | Pyth    | CL      | Median  | DN ask | CLOB | Exch below open`);
    console.log('  ' + '-'.repeat(20 + exchNames.length * 11 + 65));

    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];

      // Compute delta from CL@open for each exchange
      const exchDeltas = {};
      const exchPrices = [];
      for (const e of exchNames) {
        if (s[e] !== null) {
          exchDeltas[e] = s[e] - ev.clOpen;
          exchPrices.push(s[e]);
        }
      }

      // Compute median of exchange prices
      let median = null;
      if (exchPrices.length > 0) {
        exchPrices.sort((a, b) => a - b);
        const mid = Math.floor(exchPrices.length / 2);
        median = exchPrices.length % 2 === 0 ? (exchPrices[mid - 1] + exchPrices[mid]) / 2 : exchPrices[mid];
      }
      const medianDelta = median !== null ? median - ev.clOpen : null;

      const pythDelta = s.pyth !== null ? s.pyth - ev.clOpen : null;
      const clDelta = s.chainlink !== null ? s.chainlink - ev.clOpen : null;
      const refDelta = s.polyRef !== null ? s.polyRef - ev.clOpen : null;

      let clobDir = '?';
      if (s.dnAsk !== null) {
        clobDir = s.dnAsk > 0.55 ? 'DN' : s.dnAsk < 0.45 ? 'UP' : '--';
      }

      // Count exchanges below CL@open
      const below = exchNames.filter(e => exchDeltas[e] !== undefined && exchDeltas[e] < 0);

      const exchCols = exchNames.map(e => fmtD(exchDeltas[e] !== undefined ? exchDeltas[e] : null)).join(' |');

      console.log(
        `  T-${String(ttc).padStart(2)}s |${exchCols} | ${fmtD(refDelta)}  | ${fmtD(pythDelta)}  | ${fmtD(clDelta)}  | ${fmtD(medianDelta)}  | ${s.dnAsk !== null ? s.dnAsk.toFixed(3) : '  -  '} |  ${clobDir}  | ${below.length > 0 ? below.join(', ') : 'none'}`
      );
    }

    // Analysis: when does each data source first cross CL@open toward resolution?
    console.log(`\n  FIRST CROSSING toward ${ev.resolution}:`);
    for (const source of [...exchNames, 'polyRef', 'pyth', 'chainlink']) {
      let first = null;
      for (let ttc = 30; ttc >= 0; ttc--) {
        const val = seconds[ttc][source];
        if (val === null) continue;
        const dir = val >= ev.clOpen ? 'UP' : 'DOWN';
        if (dir === ev.resolution) { first = ttc; break; }
      }
      console.log(`    ${source.padEnd(12)}: ${first !== null ? `T-${first}s` : 'never'}`);
    }

    // CLOB
    let firstClob = null;
    for (let ttc = 30; ttc >= 0; ttc--) {
      const s = seconds[ttc];
      if (s.dnAsk === null) continue;
      const dir = s.dnAsk > 0.55 ? 'DOWN' : s.dnAsk < 0.45 ? 'UP' : null;
      if (dir === ev.resolution) { firstClob = ttc; break; }
    }
    console.log(`    ${'CLOB'.padEnd(12)}: ${firstClob !== null ? `T-${firstClob}s` : 'never'}`);

    // How close is exchange median to oracle?
    console.log(`\n  MEDIAN vs ORACLE at key moments:`);
    for (const ttc of [30, 20, 10, 5, 2, 0]) {
      const s = seconds[ttc];
      const exchPrices = exchNames.map(e => s[e]).filter(v => v !== null);
      if (exchPrices.length === 0) continue;
      exchPrices.sort((a, b) => a - b);
      const mid = Math.floor(exchPrices.length / 2);
      const median = exchPrices.length % 2 === 0 ? (exchPrices[mid - 1] + exchPrices[mid]) / 2 : exchPrices[mid];
      const gap_pyth = s.pyth !== null ? (median - s.pyth).toFixed(1) : 'n/a';
      const gap_cl = s.chainlink !== null ? (median - s.chainlink).toFixed(1) : 'n/a';
      console.log(`    T-${String(ttc).padStart(2)}s: Median=$${median.toFixed(2)} | Pyth=$${(s.pyth||0).toFixed(2)} gap=$${gap_pyth} | CL=$${(s.chainlink||0).toFixed(2)} gap=$${gap_cl}`);
    }

    console.log();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
