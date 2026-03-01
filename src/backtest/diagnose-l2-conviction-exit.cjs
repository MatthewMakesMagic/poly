/**
 * L2 Conviction Exit Diagnostic
 *
 * For conviction-filtered strategies (the ones showing edge),
 * asks: when a trade is going wrong, can L2 data detect it
 * early enough to exit and save money?
 *
 * Approach:
 *   1. Load conviction-filtered trades that overlap with L2 data period
 *   2. For each trade, track L2 state every second after entry
 *   3. Key signals: settled mid (5-tick rolling median), depth on our side,
 *      spread, exchange price vs strike
 *   4. Compare winner vs loser trajectories
 *   5. Simulate exit rules and compute saved PnL
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-l2-conviction-exit.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Helpers ──
function fmt$(v) { return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`; }
function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A'; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

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

// Simulate selling UP tokens into bids
function simulateSell(bids, shares) {
  if (!bids || !bids.length) return { fillPrice: 0, filled: 0, unfilled: shares };
  let remaining = shares;
  let proceeds = 0;
  for (const [price, size] of bids) {
    const fill = Math.min(remaining, size);
    proceeds += fill * price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  const filled = shares - remaining;
  return { fillPrice: filled > 0 ? proceeds / filled : 0, filled, unfilled: remaining, proceeds };
}

// Simulate selling DOWN tokens (walk UP asks, invert)
function simulateSellDown(asks, shares) {
  if (!asks || !asks.length) return { fillPrice: 0, filled: 0, unfilled: shares };
  let remaining = shares;
  let proceeds = 0;
  for (const [upAskPrice, size] of asks) {
    const downBidPrice = 1.0 - upAskPrice;
    if (downBidPrice <= 0) continue;
    const fill = Math.min(remaining, size);
    proceeds += fill * downBidPrice;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  const filled = shares - remaining;
  return { fillPrice: filled > 0 ? proceeds / filled : 0, filled, unfilled: remaining, proceeds };
}

async function main() {
  console.log('='.repeat(120));
  console.log('  L2 CONVICTION EXIT — Can we detect losing trades early and exit?');
  console.log('='.repeat(120));
  console.log();

  // ── Step 1: Load conviction-filtered trades with L2 overlap ──
  console.log('Step 1: Loading conviction-filtered trades with L2 data...');

  const l2Start = await pool.query(`SELECT MIN(timestamp) as t FROM l2_book_ticks`);
  const l2StartDate = l2Start.rows[0].t;
  console.log(`  L2 data starts: ${new Date(l2StartDate).toISOString()}`);

  const tradesResult = await pool.query(`
    SELECT t.id, t.window_id, t.symbol, t.signal_time, t.signal_type as strategy,
           t.variant_label as signal_filter, t.signal_offset_sec,
           t.entry_side, t.entry_token_id,
           t.sim_entry_price::float as entry_price,
           t.sim_cost::float as cost, t.sim_fee::float as fee,
           t.sim_shares::float as shares,
           t.won, t.net_pnl::float as net_pnl,
           t.resolved_direction,
           t.position_size_dollars::float as pos_size,
           w.strike_price::float as strike_price
    FROM paper_trades_v2 t
    JOIN window_close_events w ON w.window_id = t.window_id
    WHERE t.resolved_direction IS NOT NULL
      AND t.signal_time >= $1
      AND t.variant_label LIKE 'f-%'
    ORDER BY t.signal_time
  `, [l2StartDate]);

  const trades = tradesResult.rows;
  console.log(`  Found ${trades.length} conviction-filtered trades in L2 period`);

  const winners = trades.filter(t => t.won);
  const losers = trades.filter(t => !t.won);
  console.log(`  Winners: ${winners.length} (${pct(winners.length, trades.length)}) | Losers: ${losers.length} (${pct(losers.length, trades.length)})`);
  console.log();

  // ── Step 2: For each trade, build L2 trajectory ──
  console.log('Step 2: Building L2 trajectories for each trade...');

  // Time checkpoints (seconds after entry)
  const CHECKPOINTS = [3, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  const MID_THRESHOLDS = [0.02, 0.03, 0.05, 0.08, 0.10, 0.15]; // ¢ against us
  const EXIT_FEE_PCT = 0.02; // 2% exit fee

  const tradeSnapshots = []; // All processed trades with their L2 trajectories

  let processed = 0;
  for (const trade of trades) {
    processed++;
    if (processed % 50 === 0) process.stdout.write(`  Processing ${processed}/${trades.length}...\r`);

    const signalMs = new Date(trade.signal_time).getTime();
    const isUp = trade.entry_side === 'UP';

    // Load L2 ticks for this window, from signal_time onward
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, spread::float,
             best_bid::float, best_ask::float,
             bid_depth_1pct::float, ask_depth_1pct::float,
             top_levels
      FROM l2_book_ticks
      WHERE window_id = $1
        AND timestamp >= $2
      ORDER BY timestamp ASC
      LIMIT 5000
    `, [trade.window_id, trade.signal_time]);

    const ticks = l2Result.rows;
    if (ticks.length < 10) continue;

    // Load exchange price at entry for context
    const exResult = await pool.query(`
      SELECT price::float FROM exchange_ticks
      WHERE symbol = $1 AND exchange = 'binance'
        AND timestamp >= $2 AND timestamp <= $3
      ORDER BY ABS(EXTRACT(EPOCH FROM timestamp - $2::timestamp)) ASC
      LIMIT 1
    `, [trade.symbol, trade.signal_time, new Date(signalMs + 5000)]);
    const entryBinance = exResult.rows[0]?.price || null;

    // Compute "our price" at each tick
    // For UP entries: our price = best_bid (what we'd sell for)
    // For DOWN entries: our price = 1 - best_ask (DOWN value)
    const trajectory = [];
    const midWindow = []; // rolling window for settled mid

    for (const tick of ticks) {
      const tickMs = new Date(tick.timestamp).getTime();
      const elapsed = (tickMs - signalMs) / 1000;

      const ourPrice = isUp
        ? (tick.best_bid || tick.mid_price - tick.spread / 2)
        : (1.0 - (tick.best_ask || tick.mid_price + tick.spread / 2));

      // Rolling median of last 5 mid prices for "settled" mid
      midWindow.push(tick.mid_price);
      if (midWindow.length > 5) midWindow.shift();
      const settledMid = median([...midWindow]);

      // Our settled price (smoothed)
      const settledOur = isUp ? settledMid - tick.spread / 2 : 1.0 - settledMid - tick.spread / 2;

      // Depth on our exit side
      const ourDepth = isUp ? tick.bid_depth_1pct : tick.ask_depth_1pct;

      // Simulated exit if we sold right now
      let exitSim = null;
      if (tick.top_levels) {
        if (isUp) {
          exitSim = simulateSell(tick.top_levels.bids, trade.shares);
        } else {
          exitSim = simulateSellDown(tick.top_levels.asks, trade.shares);
        }
      }

      trajectory.push({
        elapsed,
        mid: tick.mid_price,
        settledMid,
        ourPrice,
        settledOur,
        spread: tick.spread,
        ourDepth: ourDepth || 0,
        exitFillPrice: exitSim?.fillPrice || ourPrice,
        exitFillPct: exitSim ? (exitSim.filled / trade.shares * 100) : null,
        topLevels: tick.top_levels,
      });
    }

    if (trajectory.length < 5) continue;

    // Extract checkpoint snapshots
    const checkpointData = {};
    for (const sec of CHECKPOINTS) {
      // Find tick closest to this checkpoint
      let best = null, bestDist = Infinity;
      for (const t of trajectory) {
        const d = Math.abs(t.elapsed - sec);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      if (best && bestDist < 3) {
        checkpointData[sec] = best;
      }
    }

    // Compute worst-against-us point
    let worstAgainst = 0; // max distance mid moved against our position
    let worstAgainstSec = 0;
    let worstSettledAgainst = 0;
    let worstSettledAgainstSec = 0;

    for (const t of trajectory) {
      const moveAgainst = isUp
        ? (trade.entry_price - t.ourPrice)  // UP: bad when price drops
        : (trade.entry_price - t.ourPrice); // DOWN: same logic with inverted price
      if (moveAgainst > worstAgainst) {
        worstAgainst = moveAgainst;
        worstAgainstSec = t.elapsed;
      }

      const settledMove = isUp
        ? (trade.entry_price - t.settledOur)
        : (trade.entry_price - t.settledOur);
      if (settledMove > worstSettledAgainst) {
        worstSettledAgainst = settledMove;
        worstSettledAgainstSec = t.elapsed;
      }
    }

    // First time mid-price crosses each threshold against us
    const thresholdCrossings = {};
    for (const thr of MID_THRESHOLDS) {
      for (const t of trajectory) {
        const moveAgainst = trade.entry_price - t.settledOur;
        if (moveAgainst >= thr && !thresholdCrossings[thr]) {
          thresholdCrossings[thr] = {
            sec: t.elapsed,
            exitPrice: t.exitFillPrice,
            fillPct: t.exitFillPct,
            mid: t.mid,
            settledMid: t.settledMid,
          };
          break;
        }
      }
    }

    tradeSnapshots.push({
      trade,
      trajectory,
      checkpointData,
      worstAgainst,
      worstAgainstSec,
      worstSettledAgainst,
      worstSettledAgainstSec,
      thresholdCrossings,
      entryBinance,
    });
  }

  process.stdout.write(''.padEnd(80) + '\r');
  console.log(`  Processed ${tradeSnapshots.length} trades with L2 trajectories`);
  console.log();

  const snapWinners = tradeSnapshots.filter(s => s.trade.won);
  const snapLosers = tradeSnapshots.filter(s => !s.trade.won);

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 1: Winner vs Loser L2 trajectory comparison
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 1: WINNER vs LOSER — L2 trajectory comparison at each checkpoint');
  console.log('='.repeat(120));
  console.log();
  console.log('  "Settled our price" = 5-tick rolling median of mid, adjusted for spread and direction');
  console.log('  "Move against" = entry_price - settled_our_price (positive = losing money)');
  console.log();

  const cpHeaders = ['Checkpoint', 'Winners N', 'W Median Move', 'W Median Depth',
                     'Losers N', 'L Median Move', 'L Median Depth', 'Separable?'];
  const cpRows = [];

  for (const sec of CHECKPOINTS) {
    const wPoints = snapWinners.filter(s => s.checkpointData[sec]).map(s => ({
      move: s.trade.entry_price - s.checkpointData[sec].settledOur,
      depth: s.checkpointData[sec].ourDepth,
    }));
    const lPoints = snapLosers.filter(s => s.checkpointData[sec]).map(s => ({
      move: s.trade.entry_price - s.checkpointData[sec].settledOur,
      depth: s.checkpointData[sec].ourDepth,
    }));

    const wMedMove = median(wPoints.map(p => p.move));
    const lMedMove = median(lPoints.map(p => p.move));
    const wMedDepth = median(wPoints.map(p => p.depth));
    const lMedDepth = median(lPoints.map(p => p.depth));

    // Are they separable? If loser median > winner median by >2¢, there's a signal
    const gap = lMedMove - wMedMove;
    const separable = gap > 0.02 ? `YES (+${(gap*100).toFixed(1)}¢)` : `NO (${(gap*100).toFixed(1)}¢)`;

    cpRows.push([
      `T+${sec}s`,
      wPoints.length, `${(wMedMove*100).toFixed(1)}¢`, `$${wMedDepth.toFixed(0)}`,
      lPoints.length, `${(lMedMove*100).toFixed(1)}¢`, `$${lMedDepth.toFixed(0)}`,
      separable,
    ]);
  }

  printTable(cpHeaders, cpRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'L']);
  console.log();

  // Worst-against-us comparison
  console.log('  WORST MOVE AGAINST US (max drawdown before resolution):');
  console.log();
  console.log(`    Winners: median worst = ${(median(snapWinners.map(s => s.worstSettledAgainst))*100).toFixed(1)}¢ at T+${median(snapWinners.map(s => s.worstSettledAgainstSec)).toFixed(0)}s`);
  console.log(`    Losers:  median worst = ${(median(snapLosers.map(s => s.worstSettledAgainst))*100).toFixed(1)}¢ at T+${median(snapLosers.map(s => s.worstSettledAgainstSec)).toFixed(0)}s`);
  console.log();

  // Distribution of worst drawdown
  const ddBuckets = [
    { label: '<2¢', min: 0, max: 0.02 },
    { label: '2-5¢', min: 0.02, max: 0.05 },
    { label: '5-10¢', min: 0.05, max: 0.10 },
    { label: '10-20¢', min: 0.10, max: 0.20 },
    { label: '20-40¢', min: 0.20, max: 0.40 },
    { label: '>40¢', min: 0.40, max: 100 },
  ];

  const ddHeaders = ['Drawdown', 'Winners', 'W%', 'Losers', 'L%', 'Kill Ratio'];
  const ddRows = ddBuckets.map(b => {
    const w = snapWinners.filter(s => s.worstSettledAgainst >= b.min && s.worstSettledAgainst < b.max).length;
    const l = snapLosers.filter(s => s.worstSettledAgainst >= b.min && s.worstSettledAgainst < b.max).length;
    // Kill ratio: what fraction of this bucket is losers?
    const total = w + l;
    return [b.label, w, pct(w, snapWinners.length), l, pct(l, snapLosers.length),
            total > 0 ? pct(l, total) : 'N/A'];
  });

  printTable(ddHeaders, ddRows, ['L', 'R', 'R', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 2: Stop-loss simulation — "exit when settled price moves X¢ against us"
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 2: STOP-LOSS SIMULATION — Exit when settled price moves against entry');
  console.log('='.repeat(120));
  console.log();
  console.log('  Entry: $100 position, 2% entry fee. If stop triggers, exit at actual L2 fill price + 2% exit fee.');
  console.log('  If no stop triggers, hold to resolution (win = $shares payout, lose = $0).');
  console.log();

  // Baseline: no stop
  const baselinePnl = tradeSnapshots.reduce((sum, s) => sum + s.trade.net_pnl, 0);
  const baselineWins = snapWinners.length;
  const baselineLosses = snapLosers.length;

  console.log(`  BASELINE (no stop): ${tradeSnapshots.length} trades | Win%: ${pct(baselineWins, tradeSnapshots.length)} | PnL: ${fmt$(baselinePnl)}`);
  console.log();

  // For each threshold + minimum time combination
  const MIN_TIMES = [0, 5, 10, 15]; // Don't trigger before this many seconds
  const stopHeaders = ['Stop Rule', 'Triggered', 'On Winners', 'On Losers',
                       'Saved on L', 'Lost on W', 'Net vs Baseline', 'New Win%'];
  const stopRows = [];

  for (const minTime of MIN_TIMES) {
    for (const thr of MID_THRESHOLDS) {
      let triggeredWinners = 0, triggeredLosers = 0;
      let savedOnLosers = 0, lostOnWinners = 0;
      let newPnl = 0;
      let newWins = 0;
      let totalTrades = 0;

      for (const snap of tradeSnapshots) {
        totalTrades++;
        const crossing = snap.thresholdCrossings[thr];

        // Did the stop trigger, and was it after minTime?
        if (crossing && crossing.sec >= minTime) {
          // Exit at the fill price at trigger time
          const exitPrice = crossing.exitPrice;
          const exitProceeds = exitPrice * snap.trade.shares;
          const exitFee = exitProceeds * EXIT_FEE_PCT;
          const exitPnl = exitProceeds - snap.trade.cost - snap.trade.fee - exitFee;

          if (snap.trade.won) {
            // We killed a winner — how much did we lose vs holding?
            triggeredWinners++;
            const holdPnl = snap.trade.net_pnl;
            lostOnWinners += (holdPnl - exitPnl); // positive = we lost this much
            newPnl += exitPnl;
            // Did we still profit on exit?
            if (exitPnl > 0) newWins++;
          } else {
            // We caught a loser — how much did we save vs full loss?
            triggeredLosers++;
            const holdPnl = snap.trade.net_pnl; // negative (typically -$102)
            savedOnLosers += (exitPnl - holdPnl); // positive = we saved this much
            newPnl += exitPnl;
            if (exitPnl > 0) newWins++;
          }
        } else {
          // Stop didn't trigger — hold to resolution
          newPnl += snap.trade.net_pnl;
          if (snap.trade.won) newWins++;
        }
      }

      const triggered = triggeredWinners + triggeredLosers;
      const netVsBaseline = newPnl - baselinePnl;

      stopRows.push([
        `${(thr*100).toFixed(0)}¢ after T+${minTime}s`,
        `${triggered} (${pct(triggered, totalTrades)})`,
        `${triggeredWinners} (${pct(triggeredWinners, snapWinners.length)})`,
        `${triggeredLosers} (${pct(triggeredLosers, snapLosers.length)})`,
        fmt$(savedOnLosers),
        fmt$(lostOnWinners),
        fmt$(netVsBaseline),
        pct(newWins, totalTrades),
      ]);
    }
  }

  printTable(stopHeaders, stopRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 3: Break down by strategy
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 3: BEST STOP BY STRATEGY — Which strategies benefit from stops?');
  console.log('='.repeat(120));
  console.log();

  // Group by strategy
  const stratGroups = {};
  for (const snap of tradeSnapshots) {
    const key = `${snap.trade.strategy}/${snap.trade.signal_filter}`;
    if (!stratGroups[key]) stratGroups[key] = [];
    stratGroups[key].push(snap);
  }

  const stratHeaders = ['Strategy', 'N', 'Base Win%', 'Base PnL',
                        'Best Stop', 'New Win%', 'New PnL', 'Improvement'];
  const stratRows = [];

  for (const [key, snaps] of Object.entries(stratGroups).sort((a, b) => b[1].length - a[1].length)) {
    if (snaps.length < 10) continue;

    const basePnl = snaps.reduce((s, snap) => s + snap.trade.net_pnl, 0);
    const baseWins = snaps.filter(s => s.trade.won).length;
    const sWinners = snaps.filter(s => s.trade.won);
    const sLosers = snaps.filter(s => !s.trade.won);

    let bestStop = 'none';
    let bestPnl = basePnl;
    let bestWinPct = pct(baseWins, snaps.length);

    for (const minTime of MIN_TIMES) {
      for (const thr of MID_THRESHOLDS) {
        let newPnl = 0;
        let newWins = 0;

        for (const snap of snaps) {
          const crossing = snap.thresholdCrossings[thr];
          if (crossing && crossing.sec >= minTime) {
            const exitPrice = crossing.exitPrice;
            const exitProceeds = exitPrice * snap.trade.shares;
            const exitFee = exitProceeds * EXIT_FEE_PCT;
            const exitPnl = exitProceeds - snap.trade.cost - snap.trade.fee - exitFee;
            newPnl += exitPnl;
            if (exitPnl > 0) newWins++;
          } else {
            newPnl += snap.trade.net_pnl;
            if (snap.trade.won) newWins++;
          }
        }

        if (newPnl > bestPnl) {
          bestPnl = newPnl;
          bestStop = `${(thr*100).toFixed(0)}¢/T+${minTime}s`;
          bestWinPct = pct(newWins, snaps.length);
        }
      }
    }

    stratRows.push([
      key, snaps.length, pct(baseWins, snaps.length), fmt$(basePnl),
      bestStop, bestWinPct, fmt$(bestPnl), fmt$(bestPnl - basePnl),
    ]);
  }

  printTable(stratHeaders, stratRows, ['L', 'R', 'R', 'R', 'L', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 4: Can we actually exit? Fill rate at stop trigger points
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 4: EXECUTION FEASIBILITY — Can we actually get out at stop trigger?');
  console.log('='.repeat(120));
  console.log();

  // For the best-performing stop rule overall, look at fill rates
  // Find the best overall stop first
  let bestOverallThr = 0.05;
  let bestOverallMinTime = 5;
  let bestOverallImprovement = -Infinity;

  for (const minTime of MIN_TIMES) {
    for (const thr of MID_THRESHOLDS) {
      let newPnl = 0;
      for (const snap of tradeSnapshots) {
        const crossing = snap.thresholdCrossings[thr];
        if (crossing && crossing.sec >= minTime) {
          const exitPrice = crossing.exitPrice;
          const exitProceeds = exitPrice * snap.trade.shares;
          const exitFee = exitProceeds * EXIT_FEE_PCT;
          newPnl += exitProceeds - snap.trade.cost - snap.trade.fee - exitFee;
        } else {
          newPnl += snap.trade.net_pnl;
        }
      }
      if (newPnl - baselinePnl > bestOverallImprovement) {
        bestOverallImprovement = newPnl - baselinePnl;
        bestOverallThr = thr;
        bestOverallMinTime = minTime;
      }
    }
  }

  console.log(`  Best overall stop: ${(bestOverallThr*100).toFixed(0)}¢ after T+${bestOverallMinTime}s (improvement: ${fmt$(bestOverallImprovement)})`);
  console.log();

  // Check fill rates at trigger points for this stop
  const triggerFills = [];
  for (const snap of tradeSnapshots) {
    const crossing = snap.thresholdCrossings[bestOverallThr];
    if (crossing && crossing.sec >= bestOverallMinTime) {
      triggerFills.push({
        fillPct: crossing.fillPct,
        exitPrice: crossing.exitPrice,
        sec: crossing.sec,
        won: snap.trade.won,
        symbol: snap.trade.symbol,
        shares: snap.trade.shares,
      });
    }
  }

  if (triggerFills.length > 0) {
    const withFillData = triggerFills.filter(f => f.fillPct != null);
    const fullFills = withFillData.filter(f => f.fillPct >= 99.9);
    const partialFills = withFillData.filter(f => f.fillPct > 0 && f.fillPct < 99.9);
    const noFills = withFillData.filter(f => f.fillPct === 0);

    console.log(`  Stop triggered on ${triggerFills.length} trades`);
    console.log(`  Trades with fill data: ${withFillData.length}`);
    console.log(`    Full fill (>99.9%): ${fullFills.length} (${pct(fullFills.length, withFillData.length)})`);
    console.log(`    Partial fill:       ${partialFills.length} (${pct(partialFills.length, withFillData.length)})`);
    console.log(`    No fill:            ${noFills.length} (${pct(noFills.length, withFillData.length)})`);
    console.log();
    console.log(`  Median fill%: ${median(withFillData.map(f => f.fillPct)).toFixed(1)}%`);
    console.log(`  Median exit price: $${median(triggerFills.map(f => f.exitPrice)).toFixed(3)}`);
    console.log(`  Median trigger time: T+${median(triggerFills.map(f => f.sec)).toFixed(1)}s`);
    console.log();

    // By symbol
    console.log('  BY SYMBOL:');
    const symFills = {};
    for (const f of triggerFills) {
      if (!symFills[f.symbol]) symFills[f.symbol] = [];
      symFills[f.symbol].push(f);
    }
    for (const [sym, fills] of Object.entries(symFills).sort()) {
      const wd = fills.filter(f => f.fillPct != null);
      const full = wd.filter(f => f.fillPct >= 99.9).length;
      console.log(`    ${sym.toUpperCase()}: ${fills.length} triggers, ${full}/${wd.length} full fills (${pct(full, wd.length)}), median exit $${median(fills.map(f => f.exitPrice)).toFixed(3)}`);
    }
    console.log();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 5: Individual trade examples — losers saved by stop
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 5: EXAMPLE TRADES — Losers that would be saved by the best stop');
  console.log('='.repeat(120));
  console.log();

  const savedLosers = tradeSnapshots.filter(snap => {
    if (snap.trade.won) return false;
    const crossing = snap.thresholdCrossings[bestOverallThr];
    return crossing && crossing.sec >= bestOverallMinTime;
  }).sort((a, b) => {
    const aX = a.thresholdCrossings[bestOverallThr];
    const bX = b.thresholdCrossings[bestOverallThr];
    const aSaved = (aX.exitPrice * a.trade.shares * (1 - EXIT_FEE_PCT) - a.trade.cost - a.trade.fee) - a.trade.net_pnl;
    const bSaved = (bX.exitPrice * b.trade.shares * (1 - EXIT_FEE_PCT) - b.trade.cost - b.trade.fee) - b.trade.net_pnl;
    return bSaved - aSaved;
  });

  const exHeaders = ['Strategy', 'Symbol', 'Entry', 'Stop @', 'Exit Price',
                     'Hold PnL', 'Exit PnL', 'Saved'];
  const exRows = savedLosers.slice(0, 15).map(snap => {
    const crossing = snap.thresholdCrossings[bestOverallThr];
    const exitProceeds = crossing.exitPrice * snap.trade.shares;
    const exitFee = exitProceeds * EXIT_FEE_PCT;
    const exitPnl = exitProceeds - snap.trade.cost - snap.trade.fee - exitFee;
    const saved = exitPnl - snap.trade.net_pnl;

    return [
      `${snap.trade.strategy}/${snap.trade.signal_filter}`,
      snap.trade.symbol.toUpperCase(),
      `$${snap.trade.entry_price.toFixed(3)} ${snap.trade.entry_side}`,
      `T+${crossing.sec.toFixed(0)}s`,
      `$${crossing.exitPrice.toFixed(3)}`,
      fmt$(snap.trade.net_pnl),
      fmt$(exitPnl),
      fmt$(saved),
    ];
  });

  printTable(exHeaders, exRows, ['L', 'L', 'L', 'R', 'R', 'R', 'R', 'R']);
  console.log();

  // Also show winners that would be killed
  const killedWinners = tradeSnapshots.filter(snap => {
    if (!snap.trade.won) return false;
    const crossing = snap.thresholdCrossings[bestOverallThr];
    return crossing && crossing.sec >= bestOverallMinTime;
  }).sort((a, b) => b.trade.net_pnl - a.trade.net_pnl);

  if (killedWinners.length > 0) {
    console.log('  WINNERS THAT WOULD BE KILLED (worst casualties):');
    console.log();

    const kwRows = killedWinners.slice(0, 10).map(snap => {
      const crossing = snap.thresholdCrossings[bestOverallThr];
      const exitProceeds = crossing.exitPrice * snap.trade.shares;
      const exitFee = exitProceeds * EXIT_FEE_PCT;
      const exitPnl = exitProceeds - snap.trade.cost - snap.trade.fee - exitFee;

      return [
        `${snap.trade.strategy}/${snap.trade.signal_filter}`,
        snap.trade.symbol.toUpperCase(),
        `$${snap.trade.entry_price.toFixed(3)} ${snap.trade.entry_side}`,
        `T+${crossing.sec.toFixed(0)}s`,
        `$${crossing.exitPrice.toFixed(3)}`,
        fmt$(snap.trade.net_pnl),
        fmt$(exitPnl),
        fmt$(snap.trade.net_pnl - exitPnl),
      ];
    });

    printTable(
      ['Strategy', 'Symbol', 'Entry', 'Stop @', 'Exit Price', 'Hold PnL', 'Exit PnL', 'Lost'],
      kwRows,
      ['L', 'L', 'L', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 6: SYNOPSIS
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SYNOPSIS');
  console.log('='.repeat(120));
  console.log();

  const bestTriggerCount = triggerFills.length;
  const bestTriggerOnLosers = triggerFills.filter(f => !f.won).length;
  const bestTriggerOnWinners = triggerFills.filter(f => f.won).length;

  console.log(`  Best stop rule: ${(bestOverallThr*100).toFixed(0)}¢ settled mid move after T+${bestOverallMinTime}s`);
  console.log(`  Improvement over hold: ${fmt$(bestOverallImprovement)}`);
  console.log(`  Triggers on: ${bestTriggerOnLosers} losers (${pct(bestTriggerOnLosers, snapLosers.length)}), ${bestTriggerOnWinners} winners (${pct(bestTriggerOnWinners, snapWinners.length)})`);
  console.log();
  console.log(`  The key question: do losers "look different" from winners in L2 data?`);
  console.log(`  If the trajectory table in Section 1 shows clear separation,`);
  console.log(`  then L2-based conviction exits are feasible.`);
  console.log(`  If not, the oscillations swamp any signal.`);
  console.log();
  console.log('='.repeat(120));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
