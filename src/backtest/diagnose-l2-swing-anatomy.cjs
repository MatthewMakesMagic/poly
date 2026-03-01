/**
 * L2 Swing Anatomy Diagnostic (v2 — optimized)
 *
 * Dissects the wild CLOB mid-price swings.
 * Cross-references with exchange prices to answer:
 *   1. What CAUSES the swings? (MM requoting? exchange moves? thin books?)
 *   2. Are the swings predictable from exchange data?
 *   3. Can we buy the dip when CLOB crashes but exchanges haven't moved?
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-l2-swing-anatomy.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function fmt$(v) { return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`; }
function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A'; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function printTable(headers, rows, alignments) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
  );
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const pad = (val, i) => {
    const s = String(val ?? '');
    return alignments && alignments[i] === 'R' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  };
  console.log(headers.map((h, i) => ` ${pad(h, i)} `).join('|'));
  console.log(sep);
  for (const row of rows) console.log(row.map((v, i) => ` ${pad(v, i)} `).join('|'));
}

async function main() {
  console.log('='.repeat(120));
  console.log('  L2 SWING ANATOMY — What causes the wild CLOB oscillations?');
  console.log('='.repeat(120));
  console.log();

  // ── Step 1: Use SQL to find swing-heavy windows fast ──
  console.log('Step 1: Finding windows and computing swing stats in SQL...');

  // Get windows with L2 data, resolution, and strike
  const windowsResult = await pool.query(`
    SELECT l.window_id, l.symbol,
           w.resolved_direction, w.strike_price::float,
           w.chainlink_price_at_close::float as cl_close,
           w.binance_price_at_close::float as bnc_close,
           COUNT(*) as tick_count,
           MIN(l.timestamp) as first_tick, MAX(l.timestamp) as last_tick,
           MIN(l.mid_price::float) as min_mid, MAX(l.mid_price::float) as max_mid
    FROM l2_book_ticks l
    JOIN window_close_events w ON w.window_id = l.window_id
    WHERE w.resolved_direction IS NOT NULL
      AND l.mid_price > 0 AND l.mid_price < 1
    GROUP BY l.window_id, l.symbol,
             w.resolved_direction, w.strike_price, w.chainlink_price_at_close, w.binance_price_at_close
    HAVING COUNT(*) > 50
    ORDER BY (MAX(l.mid_price::float) - MIN(l.mid_price::float)) DESC
  `);

  console.log(`Found ${windowsResult.rows.length} windows with L2 + resolution data`);
  console.log();

  // ── Step 2: For the top 10 widest-range windows, do deep analysis ──
  // Focus on windows with range > 50 cents (went from strongly one side to the other)
  const wideWindows = windowsResult.rows.filter(w =>
    (w.max_mid - w.min_mid) > 0.50
  );

  console.log(`Windows with >50¢ range: ${wideWindows.length}`);
  console.log();

  // ── Step 3: Sample a few windows for detailed tick-level analysis ──
  console.log('='.repeat(120));
  console.log('  SECTION 1: DETAILED SWING ANATOMY — Sample windows');
  console.log('='.repeat(120));
  console.log();

  // Take up to 8 windows across different symbols
  const sampleWindows = wideWindows.slice(0, 8);

  const allSwingEvents = []; // Collect all swing events for aggregate analysis

  for (const win of sampleWindows) {
    console.log(`━━━ ${win.window_id} (${win.symbol.toUpperCase()}) — range ${(win.min_mid*100).toFixed(0)}¢-${(win.max_mid*100).toFixed(0)}¢, resolved ${win.resolved_direction.toUpperCase()} ━━━`);
    if (win.strike_price) {
      console.log(`    Strike: $${win.strike_price.toFixed(2)} | CL@close: $${(win.cl_close || 0).toFixed(2)} | Binance@close: $${(win.bnc_close || 0).toFixed(2)}`);
    }
    console.log();

    // Load L2 ticks — subsample to ~1 per second max (take every Nth tick)
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, spread::float,
             best_bid::float, best_ask::float,
             top_levels
      FROM l2_book_ticks
      WHERE window_id = $1 AND mid_price > 0 AND mid_price < 1
      ORDER BY timestamp ASC
    `, [win.window_id]);

    const ticks = l2Result.rows;
    if (ticks.length < 20) continue;

    // Load exchange ticks (binance) for same period
    const exResult = await pool.query(`
      SELECT timestamp, price::float
      FROM exchange_ticks
      WHERE symbol = $1 AND exchange = 'binance'
        AND timestamp >= $2 AND timestamp <= $3
      ORDER BY timestamp ASC
    `, [win.symbol, win.first_tick, win.last_tick]);

    const binancePrices = exResult.rows.map(t => ({
      ts: new Date(t.timestamp).getTime(), price: t.price
    }));

    // Find significant swings (>15 cent moves between consecutive ticks)
    const swings = [];
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i-1].mid_price;
      const curr = ticks[i].mid_price;
      const swing = Math.abs(curr - prev);
      if (swing < 0.15) continue;

      const ts = new Date(ticks[i].timestamp).getTime();
      const direction = curr > prev ? 'UP' : 'DOWN';

      // Find nearest Binance price
      let nearestBnc = null, minDist = Infinity;
      for (const bp of binancePrices) {
        const d = Math.abs(bp.ts - ts);
        if (d < minDist) { minDist = d; nearestBnc = bp; }
      }

      // Pre-swing and post-swing book depth
      const preTL = ticks[i-1].top_levels;
      const postTL = ticks[i].top_levels;

      const preBidDepth = preTL?.bids?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;
      const preAskDepth = preTL?.asks?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;
      const postBidDepth = postTL?.bids?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;
      const postAskDepth = postTL?.asks?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;

      // Pre-swing: count bid/ask levels
      const preBidLevels = preTL?.bids?.length || 0;
      const preAskLevels = preTL?.asks?.length || 0;

      // Classify the cause
      let cause = 'unknown';
      if (direction === 'DOWN' && preBidDepth < 5) {
        cause = 'NO_BIDS';
      } else if (direction === 'UP' && preAskDepth < 5) {
        cause = 'NO_ASKS';
      } else if (direction === 'DOWN' && preBidLevels <= 1) {
        cause = 'THIN_BIDS';
      } else if (direction === 'UP' && preAskLevels <= 1) {
        cause = 'THIN_ASKS';
      } else {
        cause = 'REPRICING';
      }

      // Does exchange agree?
      let exchangeAgrees = null;
      let exchangeDist = null;
      if (nearestBnc && win.strike_price && minDist < 5000) {
        const aboveStrike = nearestBnc.price > win.strike_price;
        exchangeAgrees = (direction === 'UP' && aboveStrike) || (direction === 'DOWN' && !aboveStrike);
        exchangeDist = ((nearestBnc.price - win.strike_price) / win.strike_price * 100);
      }

      // Look ahead: what happens in next 5, 10, 20, 30 seconds?
      const future = {};
      for (const sec of [5, 10, 20, 30]) {
        const target = ts + sec * 1000;
        let best = null, bestD = Infinity;
        for (let j = i; j < ticks.length; j++) {
          const d = Math.abs(new Date(ticks[j].timestamp).getTime() - target);
          if (d < bestD) { bestD = d; best = ticks[j]; }
          if (new Date(ticks[j].timestamp).getTime() > target + 3000) break;
        }
        future[sec] = best && bestD < 3000 ? best.mid_price : null;
      }

      const event = {
        timestamp: ticks[i].timestamp,
        direction,
        prevMid: prev,
        currMid: curr,
        swing,
        cause,
        preBidDepth,
        preAskDepth,
        postBidDepth,
        postAskDepth,
        preBidLevels,
        preAskLevels,
        spread: ticks[i].spread,
        binancePrice: nearestBnc?.price,
        exchangeAgrees,
        exchangeDist,
        future,
        windowId: win.window_id,
        symbol: win.symbol,
        resolution: win.resolved_direction,
        strikePrice: win.strike_price,
      };

      swings.push(event);
      allSwingEvents.push(event);
    }

    if (swings.length === 0) {
      console.log('  No swings >15¢ detected.');
      console.log();
      continue;
    }

    // Print swing events
    const swingRows = swings.slice(0, 15).map(e => {
      const bnc = e.binancePrice ? `$${e.binancePrice.toFixed(0)}` : '?';
      const delta = e.exchangeDist != null ? `${e.exchangeDist >= 0 ? '+' : ''}${e.exchangeDist.toFixed(3)}%` : '?';
      const agree = e.exchangeAgrees === true ? 'YES' : e.exchangeAgrees === false ? 'NO' : '?';
      const f5 = e.future[5] != null ? `${(e.future[5]*100).toFixed(0)}¢` : '?';
      const f10 = e.future[10] != null ? `${(e.future[10]*100).toFixed(0)}¢` : '?';
      const f30 = e.future[30] != null ? `${(e.future[30]*100).toFixed(0)}¢` : '?';

      return [
        new Date(e.timestamp).toISOString().substr(11, 12),
        e.cause,
        `${(e.prevMid*100).toFixed(0)}→${(e.currMid*100).toFixed(0)}¢`,
        e.direction,
        `$${e.preBidDepth.toFixed(0)}→${e.postBidDepth.toFixed(0)}`,
        `$${e.preAskDepth.toFixed(0)}→${e.postAskDepth.toFixed(0)}`,
        bnc,
        delta,
        agree,
        `${f5}/${f10}/${f30}`,
      ];
    });

    printTable(
      ['Time', 'Cause', 'Mid', 'Dir', 'Bid Depth', 'Ask Depth', 'Binance', 'vs Strike', 'ExAgree', '+5/+10/+30s'],
      swingRows,
      ['L', 'L', 'L', 'L', 'L', 'L', 'R', 'R', 'L', 'L']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: AGGREGATE — across all windows
  // ══════════════════════════════════════════════════════════════════════════
  // Now scan ALL wide windows (not just sample)
  console.log('Step 2: Scanning all wide windows for aggregate stats...');
  console.log();

  const remainingWindows = wideWindows.filter(w =>
    !sampleWindows.find(s => s.window_id === w.window_id)
  );

  for (const win of remainingWindows) {
    process.stdout.write(`  Scanning ${win.window_id}...\r`);

    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, top_levels
      FROM l2_book_ticks
      WHERE window_id = $1 AND mid_price > 0 AND mid_price < 1
      ORDER BY timestamp ASC
    `, [win.window_id]);

    const ticks = l2Result.rows;
    if (ticks.length < 20) continue;

    const exResult = await pool.query(`
      SELECT timestamp, price::float
      FROM exchange_ticks
      WHERE symbol = $1 AND exchange = 'binance'
        AND timestamp >= $2 AND timestamp <= $3
      ORDER BY timestamp ASC
    `, [win.symbol, win.first_tick, win.last_tick]);

    const binancePrices = exResult.rows.map(t => ({
      ts: new Date(t.timestamp).getTime(), price: t.price
    }));

    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i-1].mid_price;
      const curr = ticks[i].mid_price;
      const swing = Math.abs(curr - prev);
      if (swing < 0.15) continue;

      const ts = new Date(ticks[i].timestamp).getTime();
      const direction = curr > prev ? 'UP' : 'DOWN';

      let nearestBnc = null, minDist = Infinity;
      for (const bp of binancePrices) {
        const d = Math.abs(bp.ts - ts);
        if (d < minDist) { minDist = d; nearestBnc = bp; }
      }

      const preTL = ticks[i-1].top_levels;
      const preBidDepth = preTL?.bids?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;
      const preAskDepth = preTL?.asks?.reduce((s, [p, sz]) => s + p * sz, 0) || 0;
      const preBidLevels = preTL?.bids?.length || 0;
      const preAskLevels = preTL?.asks?.length || 0;

      let cause = 'unknown';
      if (direction === 'DOWN' && preBidDepth < 5) cause = 'NO_BIDS';
      else if (direction === 'UP' && preAskDepth < 5) cause = 'NO_ASKS';
      else if (direction === 'DOWN' && preBidLevels <= 1) cause = 'THIN_BIDS';
      else if (direction === 'UP' && preAskLevels <= 1) cause = 'THIN_ASKS';
      else cause = 'REPRICING';

      let exchangeAgrees = null, exchangeDist = null;
      if (nearestBnc && win.strike_price && minDist < 5000) {
        const aboveStrike = nearestBnc.price > win.strike_price;
        exchangeAgrees = (direction === 'UP' && aboveStrike) || (direction === 'DOWN' && !aboveStrike);
        exchangeDist = ((nearestBnc.price - win.strike_price) / win.strike_price * 100);
      }

      const future = {};
      for (const sec of [5, 10, 20, 30]) {
        const target = ts + sec * 1000;
        let best = null, bestD = Infinity;
        for (let j = i; j < ticks.length; j++) {
          const d = Math.abs(new Date(ticks[j].timestamp).getTime() - target);
          if (d < bestD) { bestD = d; best = ticks[j]; }
          if (new Date(ticks[j].timestamp).getTime() > target + 3000) break;
        }
        future[sec] = best && bestD < 3000 ? best.mid_price : null;
      }

      allSwingEvents.push({
        direction, prevMid: prev, currMid: curr, swing, cause,
        preBidDepth, preAskDepth, preBidLevels, preAskLevels,
        binancePrice: nearestBnc?.price, exchangeAgrees, exchangeDist,
        future, symbol: win.symbol, resolution: win.resolved_direction,
        strikePrice: win.strike_price,
      });
    }
  }

  process.stdout.write(''.padEnd(80) + '\r');

  console.log('='.repeat(120));
  console.log('  SECTION 2: AGGREGATE SWING ANALYSIS');
  console.log('='.repeat(120));
  console.log();
  console.log(`  Total significant swings (>15¢): ${allSwingEvents.length}`);
  console.log();

  // ── Cause breakdown ──
  const causes = {};
  for (const e of allSwingEvents) {
    causes[e.cause] = (causes[e.cause] || 0) + 1;
  }

  console.log('  CAUSE BREAKDOWN:');
  for (const [cause, count] of Object.entries(causes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cause.padEnd(15)} ${count} (${pct(count, allSwingEvents.length)})`);
  }
  console.log();

  // ── Exchange agreement ──
  const withExchange = allSwingEvents.filter(e => e.exchangeAgrees != null);
  const agrees = withExchange.filter(e => e.exchangeAgrees);
  const disagrees = withExchange.filter(e => !e.exchangeAgrees);

  console.log(`  EXCHANGE AGREEMENT (${withExchange.length} swings with exchange data):`);
  console.log(`    Exchange AGREES with swing:    ${agrees.length} (${pct(agrees.length, withExchange.length)})`);
  console.log(`    Exchange DISAGREES with swing: ${disagrees.length} (${pct(disagrees.length, withExchange.length)})`);
  console.log();

  // ── The big question: when exchange disagrees, can we profit? ──
  if (disagrees.length > 0) {
    console.log('='.repeat(120));
    console.log('  SECTION 3: THE MONETIZATION QUESTION');
    console.log('  "When CLOB swings one way but Binance says the other, what happens?"');
    console.log('='.repeat(120));
    console.log();

    // Does the resolution match the exchange direction?
    let resMatchesExchange = 0;
    let resMatchesCLOB = 0;

    for (const e of disagrees) {
      const exSaysUp = e.binancePrice > e.strikePrice;
      const resolvedUp = e.resolution === 'up';
      if ((exSaysUp && resolvedUp) || (!exSaysUp && !resolvedUp)) {
        resMatchesExchange++;
      } else {
        resMatchesCLOB++;
      }
    }

    console.log(`  Resolution matches EXCHANGE direction: ${resMatchesExchange}/${disagrees.length} (${pct(resMatchesExchange, disagrees.length)})`);
    console.log(`  Resolution matches CLOB swing:         ${resMatchesCLOB}/${disagrees.length} (${pct(resMatchesCLOB, disagrees.length)})`);
    console.log();

    // Does the CLOB revert?
    const reversion5 = disagrees.filter(e => {
      const f = e.future[5];
      if (f == null) return false;
      return (e.direction === 'DOWN' && f > e.currMid + 0.10) ||
             (e.direction === 'UP' && f < e.currMid - 0.10);
    });
    const reversion10 = disagrees.filter(e => {
      const f = e.future[10];
      if (f == null) return false;
      return (e.direction === 'DOWN' && f > e.currMid + 0.10) ||
             (e.direction === 'UP' && f < e.currMid - 0.10);
    });
    const reversion30 = disagrees.filter(e => {
      const f = e.future[30];
      if (f == null) return false;
      return (e.direction === 'DOWN' && f > e.currMid + 0.10) ||
             (e.direction === 'UP' && f < e.currMid - 0.10);
    });

    console.log(`  CLOB REVERSION (>10¢ back toward exchange direction):`);
    console.log(`    Within 5s:  ${reversion5.length}/${disagrees.length} (${pct(reversion5.length, disagrees.length)})`);
    console.log(`    Within 10s: ${reversion10.length}/${disagrees.length} (${pct(reversion10.length, disagrees.length)})`);
    console.log(`    Within 30s: ${reversion30.length}/${disagrees.length} (${pct(reversion30.length, disagrees.length)})`);
    console.log();

    // ── Simulate buying the exchange direction during CLOB-disagreement swings ──
    console.log('  SIMULATED STRATEGY: "Buy exchange direction when CLOB disagrees"');
    console.log('  Entry: buy the token that the EXCHANGE predicts, at the post-swing CLOB price (which is cheap)');
    console.log('  Hold to resolution. $100 per trade, 2% fee.');
    console.log();

    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    const pnls = [];

    for (const e of disagrees) {
      const exSaysUp = e.binancePrice > e.strikePrice;
      // If exchange says UP but CLOB just swung DOWN → UP token is cheap at currMid
      // If exchange says DOWN but CLOB just swung UP → DOWN token is cheap at (1-currMid)
      const entryPrice = exSaysUp ? e.currMid : (1.0 - e.currMid);
      if (entryPrice <= 0.01 || entryPrice >= 0.99) continue;

      const shares = 100 / entryPrice;
      const resolvedUp = e.resolution === 'up';
      const won = (exSaysUp && resolvedUp) || (!exSaysUp && !resolvedUp);
      const payout = won ? shares : 0;
      const pnl = payout - 100 - 2; // cost + fee
      totalPnl += pnl;
      if (won) wins++; else losses++;
      pnls.push({ pnl, entryPrice, symbol: e.symbol, exDist: e.exchangeDist, swing: e.swing, won });
    }

    console.log(`    Trades: ${wins + losses} | Wins: ${wins} | Losses: ${losses} | Win%: ${pct(wins, wins + losses)}`);
    console.log(`    Total PnL: ${fmt$(totalPnl)}`);
    console.log(`    Avg PnL/trade: ${fmt$(totalPnl / (wins + losses))}`);
    console.log(`    Median entry price: $${median(pnls.map(p => p.entryPrice)).toFixed(3)}`);
    console.log();

    // By exchange distance from strike
    console.log('  BY EXCHANGE DISTANCE FROM STRIKE:');
    console.log();

    const distBuckets = [
      { label: '<0.03% (noise)', min: 0, max: 0.03 },
      { label: '0.03-0.08%', min: 0.03, max: 0.08 },
      { label: '0.08-0.15%', min: 0.08, max: 0.15 },
      { label: '>0.15% (strong)', min: 0.15, max: 100 },
    ];

    const distRows = distBuckets.map(b => {
      const bucket = pnls.filter(p => {
        const d = Math.abs(p.exDist);
        return d >= b.min && d < b.max;
      });
      if (bucket.length === 0) return [b.label, 0, '-', '-', '-'];
      const bw = bucket.filter(p => p.won).length;
      const bPnl = bucket.reduce((s, p) => s + p.pnl, 0);
      return [b.label, bucket.length, pct(bw, bucket.length), fmt$(bPnl), fmt$(bPnl / bucket.length)];
    });

    printTable(
      ['Exchange Distance', 'N', 'Win%', 'Total PnL', 'Avg PnL'],
      distRows,
      ['L', 'R', 'R', 'R', 'R']
    );
    console.log();

    // By symbol
    console.log('  BY SYMBOL:');
    console.log();

    const symBuckets = {};
    for (const p of pnls) {
      if (!symBuckets[p.symbol]) symBuckets[p.symbol] = [];
      symBuckets[p.symbol].push(p);
    }

    const symRows = Object.entries(symBuckets).sort().map(([sym, ps]) => {
      const w = ps.filter(p => p.won).length;
      const total = ps.reduce((s, p) => s + p.pnl, 0);
      return [sym.toUpperCase(), ps.length, pct(w, ps.length), fmt$(total), fmt$(total / ps.length)];
    });

    printTable(
      ['Symbol', 'N', 'Win%', 'Total PnL', 'Avg PnL'],
      symRows,
      ['L', 'R', 'R', 'R', 'R']
    );
    console.log();

    // By CLOB swing size
    console.log('  BY SWING SIZE (how cheap did the entry get?):');
    console.log();

    const swingBuckets = [
      { label: '15-25¢', min: 0.15, max: 0.25 },
      { label: '25-40¢', min: 0.25, max: 0.40 },
      { label: '40-60¢', min: 0.40, max: 0.60 },
      { label: '>60¢', min: 0.60, max: 2.00 },
    ];

    const swingRows = swingBuckets.map(b => {
      const bucket = pnls.filter(p => p.swing >= b.min && p.swing < b.max);
      if (bucket.length === 0) return [b.label, 0, '-', '-', '-'];
      const bw = bucket.filter(p => p.won).length;
      const bPnl = bucket.reduce((s, p) => s + p.pnl, 0);
      const medEntry = median(bucket.map(p => p.entryPrice));
      return [b.label, bucket.length, pct(bw, bucket.length), fmt$(bPnl), `$${medEntry.toFixed(3)}`];
    });

    printTable(
      ['Swing Size', 'N', 'Win%', 'Total PnL', 'Med Entry'],
      swingRows,
      ['L', 'R', 'R', 'R', 'R']
    );
    console.log();

    // Show the exchange-agrees events too for comparison
    console.log('  COMPARISON — Exchange AGREES with swing (should be worse to fade):');
    const agreeTradeStats = { wins: 0, losses: 0, pnl: 0 };
    for (const e of agrees) {
      // If exchange agrees with swing, fading it means betting AGAINST exchange
      // Let's see what happens if we still bet with exchange (= with the swing)
      const exSaysUp = e.binancePrice > e.strikePrice;
      const resolvedUp = e.resolution === 'up';
      const won = (exSaysUp && resolvedUp) || (!exSaysUp && !resolvedUp);

      // Entry price: CLOB swung WITH exchange, so our token is expensive
      // If exchange says UP and CLOB swung UP → UP token at currMid (expensive)
      // This means there's NO cheap entry — the opportunity is only when they disagree
      if (won) agreeTradeStats.wins++; else agreeTradeStats.losses++;
    }
    console.log(`    Exchange direction matched resolution: ${agreeTradeStats.wins}/${agrees.length} (${pct(agreeTradeStats.wins, agrees.length)})`);
    console.log(`    (This is the "base rate" — how often exchange predicts resolution correctly)`);
  }

  console.log();
  console.log('='.repeat(120));
  console.log('  SYNOPSIS');
  console.log('='.repeat(120));
  console.log();
  console.log('  Two things cause the wild CLOB swings:');
  console.log('  1. MM LIQUIDITY VACUUM — One side of the book goes empty.');
  console.log('     With $50-70 total depth, a single MM pulling quotes');
  console.log('     moves the mid by 50+ cents instantly.');
  console.log('  2. BINARY GAMMA — Near the strike price, a $50 BTC move');
  console.log('     (0.05%) flips the probability from 80/20 to 20/80.');
  console.log();
  console.log('  The monetization angle: when CLOB swings but exchange');
  console.log('  DISAGREES, buy the cheap token. Resolution tends to');
  console.log('  follow the exchange, and you get a discounted entry.');
  console.log();
  console.log('='.repeat(120));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
