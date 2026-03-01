/**
 * Thesis Exit Diagnostic
 *
 * Tests: after entering a conviction-filtered trade, if the original
 * thesis (exchange VWAP predicting direction) deteriorates, should we exit?
 *
 * The thesis at entry is: "exchange price is X% away from strike in direction Y,
 * so Chainlink will resolve Y." If exchange price moves BACK toward strike
 * (or crosses it), the thesis is weakening/dead.
 *
 * L2 data is used ONLY to check: can we actually get out? At what price?
 *
 * Approach:
 *   1. Load conviction-filtered trades with their entry exchange state
 *   2. Track exchange price every second after entry
 *   3. Compute "thesis strength" = how far exchange is from strike in predicted direction
 *   4. If thesis weakens past threshold → exit using L2 fill simulation
 *   5. Compare hold-to-resolution vs thesis-exit PnL
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-thesis-exit.cjs
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
  console.log('  THESIS EXIT — When the original signal dies, can we exit and save money?');
  console.log('='.repeat(120));
  console.log();

  // ── Step 1: Load trades ──
  console.log('Step 1: Loading conviction-filtered trades with L2 overlap...');

  const l2Start = await pool.query(`SELECT MIN(timestamp) as t FROM l2_book_ticks`);
  const l2StartDate = l2Start.rows[0].t;

  const tradesResult = await pool.query(`
    SELECT t.id, t.window_id, t.symbol, t.signal_time,
           t.signal_type as strategy, t.variant_label as signal_filter,
           t.signal_offset_sec,
           t.entry_side, t.entry_token_id,
           t.sim_entry_price::float as entry_price,
           t.sim_cost::float as cost, t.sim_fee::float as fee,
           t.sim_shares::float as shares,
           t.won, t.net_pnl::float as net_pnl,
           t.resolved_direction,
           t.vwap_direction,
           t.vwap_delta::float as vwap_delta,
           t.vwap_price::float as vwap_price,
           t.clob_direction,
           t.clob_up_price::float as clob_up_price,
           t.strategy_metadata,
           w.strike_price::float as strike_price,
           w.chainlink_price_at_close::float as cl_close,
           w.binance_price_at_close::float as bnc_close
    FROM paper_trades_v2 t
    JOIN window_close_events w ON w.window_id = t.window_id
    WHERE t.resolved_direction IS NOT NULL
      AND t.signal_time >= $1
      AND t.variant_label LIKE 'f-%'
    ORDER BY t.signal_time
  `, [l2StartDate]);

  const trades = tradesResult.rows;
  console.log(`  Found ${trades.length} conviction-filtered trades`);
  console.log(`  Winners: ${trades.filter(t => t.won).length} | Losers: ${trades.filter(t => !t.won).length}`);
  console.log();

  // ── Step 2: For each trade, determine thesis and track exchange price ──
  console.log('Step 2: Tracking thesis strength after entry...');
  console.log();

  // Thesis: the entry_side tells us our prediction.
  // If entry_side = UP, we predicted UP → exchange should be ABOVE strike
  // If entry_side = DOWN, we predicted DOWN → exchange should be BELOW strike
  // Thesis strength = how far exchange is from strike in our predicted direction (% of strike)
  // Thesis dead = exchange has crossed to wrong side of strike

  const EXIT_FEE_PCT = 0.02;

  // Thesis deterioration thresholds (% from strike)
  // Positive = thesis alive (exchange on our side), negative = thesis dead (exchange crossed)
  const THESIS_THRESHOLDS = [
    { label: 'crosses strike', pct: 0.0 },
    { label: '<0.01% from strike', pct: 0.01 },
    { label: '<0.02% from strike', pct: 0.02 },
    { label: '<0.03% from strike', pct: 0.03 },
    { label: 'wrong side by 0.02%', pct: -0.02 },
    { label: 'wrong side by 0.05%', pct: -0.05 },
  ];

  // Minimum time after entry before thesis exit (avoid triggering on entry noise)
  const MIN_TIMES = [3, 5, 10, 15, 20];

  // Exchange sources to test
  const EXCHANGES = ['binance'];

  const allResults = []; // Per-trade thesis tracking

  let processed = 0;
  for (const trade of trades) {
    processed++;
    if (processed % 50 === 0) process.stdout.write(`  Processing ${processed}/${trades.length}...\r`);

    const signalMs = new Date(trade.signal_time).getTime();
    const isUp = trade.entry_side === 'UP';

    if (!trade.strike_price) continue;

    // Entry thesis strength: how far was exchange from strike at entry?
    // Use the VWAP price from the trade as entry exchange reference
    const entryExDist = trade.vwap_price && trade.strike_price
      ? ((trade.vwap_price - trade.strike_price) / trade.strike_price * 100)
      : null;
    const entryThesis = isUp ? entryExDist : (entryExDist != null ? -entryExDist : null);

    // Load exchange prices after entry (Binance, every tick)
    const exResult = await pool.query(`
      SELECT timestamp, price::float
      FROM exchange_ticks
      WHERE symbol = $1 AND exchange = 'binance'
        AND timestamp >= $2
        AND timestamp <= $3
      ORDER BY timestamp ASC
    `, [trade.symbol, trade.signal_time, new Date(signalMs + 180000)]); // up to 3 min

    const exTicks = exResult.rows.map(r => ({
      ts: new Date(r.timestamp).getTime(),
      price: r.price,
    }));

    if (exTicks.length < 5) continue;

    // Track thesis strength over time
    const thesisTrajectory = [];
    for (const ex of exTicks) {
      const elapsed = (ex.ts - signalMs) / 1000;
      const distPct = (ex.price - trade.strike_price) / trade.strike_price * 100;
      // Thesis strength: positive = exchange on our side, negative = wrong side
      const strength = isUp ? distPct : -distPct;
      thesisTrajectory.push({ elapsed, strength, price: ex.price });
    }

    // Find first time thesis crosses each threshold
    const crossings = {};
    for (const thr of THESIS_THRESHOLDS) {
      for (const point of thesisTrajectory) {
        if (point.strength <= thr.pct && !crossings[thr.label]) {
          crossings[thr.label] = { sec: point.elapsed, price: point.price, strength: point.strength };
          break;
        }
      }
    }

    // Find worst thesis strength (most against us)
    let worstStrength = Infinity;
    let worstStrengthSec = 0;
    for (const point of thesisTrajectory) {
      if (point.strength < worstStrength) {
        worstStrength = point.strength;
        worstStrengthSec = point.elapsed;
      }
    }

    // Load L2 for exit simulation at crossing points
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, best_bid::float, best_ask::float,
             spread::float, top_levels
      FROM l2_book_ticks
      WHERE window_id = $1 AND timestamp >= $2
      ORDER BY timestamp ASC
      LIMIT 3000
    `, [trade.window_id, trade.signal_time]);

    const l2Ticks = l2Result.rows;

    // For each crossing, find the nearest L2 tick and simulate exit
    const exitSims = {};
    for (const [label, crossing] of Object.entries(crossings)) {
      const targetMs = signalMs + crossing.sec * 1000;
      let bestL2 = null, bestDist = Infinity;
      for (const tick of l2Ticks) {
        const d = Math.abs(new Date(tick.timestamp).getTime() - targetMs);
        if (d < bestDist) { bestDist = d; bestL2 = tick; }
      }

      if (bestL2 && bestDist < 5000 && bestL2.top_levels) {
        let sim;
        if (isUp) {
          sim = simulateSell(bestL2.top_levels.bids, trade.shares);
        } else {
          sim = simulateSellDown(bestL2.top_levels.asks, trade.shares);
        }
        const exitProceeds = sim.fillPrice * sim.filled;
        const exitFee = exitProceeds * EXIT_FEE_PCT;
        const exitPnl = exitProceeds - trade.cost - trade.fee - exitFee;
        exitSims[label] = {
          fillPrice: sim.fillPrice,
          fillPct: (sim.filled / trade.shares) * 100,
          exitPnl,
          midAtExit: bestL2.mid_price,
        };
      } else if (bestL2) {
        // Fallback: use mid-price estimate
        const exitPrice = isUp
          ? (bestL2.best_bid || bestL2.mid_price - bestL2.spread / 2)
          : (1.0 - (bestL2.best_ask || bestL2.mid_price + bestL2.spread / 2));
        const exitProceeds = exitPrice * trade.shares;
        const exitFee = exitProceeds * EXIT_FEE_PCT;
        const exitPnl = exitProceeds - trade.cost - trade.fee - exitFee;
        exitSims[label] = {
          fillPrice: exitPrice,
          fillPct: null, // no fill simulation
          exitPnl,
          midAtExit: bestL2.mid_price,
        };
      }
    }

    allResults.push({
      trade,
      entryThesis,
      thesisTrajectory,
      crossings,
      exitSims,
      worstStrength,
      worstStrengthSec,
    });
  }

  process.stdout.write(''.padEnd(80) + '\r');
  console.log(`  Processed ${allResults.length} trades with thesis tracking`);
  console.log();

  const winners = allResults.filter(r => r.trade.won);
  const losers = allResults.filter(r => !r.trade.won);

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 1: Entry thesis strength — winners vs losers
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 1: ENTRY THESIS STRENGTH — How far was exchange from strike at entry?');
  console.log('='.repeat(120));
  console.log();
  console.log('  "Thesis strength" = exchange distance from strike in our predicted direction (%)');
  console.log('  Positive = exchange on our side. Negative = exchange already on wrong side.');
  console.log();

  const wEntry = winners.filter(r => r.entryThesis != null).map(r => r.entryThesis);
  const lEntry = losers.filter(r => r.entryThesis != null).map(r => r.entryThesis);

  console.log(`  Winners entry thesis: median ${median(wEntry).toFixed(4)}% (N=${wEntry.length})`);
  console.log(`  Losers entry thesis:  median ${median(lEntry).toFixed(4)}% (N=${lEntry.length})`);
  console.log();

  // Bucket by entry thesis
  const entryBuckets = [
    { label: 'Wrong side (<0%)', min: -100, max: 0 },
    { label: 'Barely right (0-0.03%)', min: 0, max: 0.03 },
    { label: 'Moderate (0.03-0.08%)', min: 0.03, max: 0.08 },
    { label: 'Strong (0.08-0.15%)', min: 0.08, max: 0.15 },
    { label: 'Very strong (>0.15%)', min: 0.15, max: 100 },
  ];

  const entryRows = entryBuckets.map(b => {
    const w = allResults.filter(r => r.entryThesis != null && r.entryThesis >= b.min && r.entryThesis < b.max && r.trade.won).length;
    const l = allResults.filter(r => r.entryThesis != null && r.entryThesis >= b.min && r.entryThesis < b.max && !r.trade.won).length;
    const total = w + l;
    return [b.label, total, w, pct(w, total), l];
  });

  printTable(
    ['Entry Thesis', 'N', 'Winners', 'Win%', 'Losers'],
    entryRows,
    ['L', 'R', 'R', 'R', 'R']
  );
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 2: Does the thesis deteriorate? How often does exchange cross strike?
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 2: THESIS DETERIORATION — How often does exchange cross our entry thesis?');
  console.log('='.repeat(120));
  console.log();

  const crossHeaders = ['Threshold', 'Winners Cross', 'W%', 'W Median Sec', 'Losers Cross', 'L%', 'L Median Sec', 'Separation'];
  const crossRows = [];

  for (const thr of THESIS_THRESHOLDS) {
    const wCross = winners.filter(r => r.crossings[thr.label]);
    const lCross = losers.filter(r => r.crossings[thr.label]);

    const wCrossSecs = wCross.map(r => r.crossings[thr.label].sec);
    const lCrossSecs = lCross.map(r => r.crossings[thr.label].sec);

    const wPct = pct(wCross.length, winners.length);
    const lPct = pct(lCross.length, losers.length);
    const wMed = wCrossSecs.length ? `T+${median(wCrossSecs).toFixed(0)}s` : '-';
    const lMed = lCrossSecs.length ? `T+${median(lCrossSecs).toFixed(0)}s` : '-';

    // Separation: do losers cross more often than winners?
    const wRate = wCross.length / winners.length;
    const lRate = lCross.length / losers.length;
    const sep = lRate > wRate + 0.05
      ? `YES (L ${(lRate*100).toFixed(0)}% > W ${(wRate*100).toFixed(0)}%)`
      : `NO`;

    crossRows.push([thr.label, wCross.length, wPct, wMed, lCross.length, lPct, lMed, sep]);
  }

  printTable(crossHeaders, crossRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'L']);
  console.log();

  // Worst thesis strength
  console.log('  WORST THESIS STRENGTH (most against us during trade):');
  console.log(`    Winners: median worst ${median(winners.map(r => r.worstStrength)).toFixed(4)}% at T+${median(winners.map(r => r.worstStrengthSec)).toFixed(0)}s`);
  console.log(`    Losers:  median worst ${median(losers.map(r => r.worstStrength)).toFixed(4)}% at T+${median(losers.map(r => r.worstStrengthSec)).toFixed(0)}s`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 3: THESIS EXIT SIMULATION
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 3: THESIS EXIT SIMULATION — Exit when exchange no longer supports our prediction');
  console.log('='.repeat(120));
  console.log();

  const baselinePnl = allResults.reduce((s, r) => s + r.trade.net_pnl, 0);
  const baselineWins = winners.length;
  console.log(`  BASELINE (hold to resolution): ${allResults.length} trades | Win%: ${pct(baselineWins, allResults.length)} | PnL: ${fmt$(baselinePnl)}`);
  console.log();

  const simHeaders = ['Exit Rule', 'Exits', 'On Winners', 'On Losers',
                      'Saved on L', 'Lost on W', 'Net PnL', 'vs Baseline', 'New Win%'];
  const simRows = [];

  for (const minTime of MIN_TIMES) {
    for (const thr of THESIS_THRESHOLDS) {
      let triggeredW = 0, triggeredL = 0;
      let savedOnL = 0, lostOnW = 0;
      let newPnl = 0;
      let newWins = 0;

      for (const r of allResults) {
        const crossing = r.crossings[thr.label];
        const exitSim = r.exitSims[thr.label];

        if (crossing && crossing.sec >= minTime && exitSim) {
          // Thesis exit triggered
          const exitPnl = exitSim.exitPnl;

          if (r.trade.won) {
            triggeredW++;
            lostOnW += (r.trade.net_pnl - exitPnl);
            newPnl += exitPnl;
            if (exitPnl > 0) newWins++;
          } else {
            triggeredL++;
            savedOnL += (exitPnl - r.trade.net_pnl);
            newPnl += exitPnl;
            if (exitPnl > 0) newWins++;
          }
        } else {
          // Hold to resolution
          newPnl += r.trade.net_pnl;
          if (r.trade.won) newWins++;
        }
      }

      const triggered = triggeredW + triggeredL;
      if (triggered === 0) continue;

      simRows.push([
        `${thr.label} after T+${minTime}s`,
        `${triggered} (${pct(triggered, allResults.length)})`,
        `${triggeredW} (${pct(triggeredW, winners.length)})`,
        `${triggeredL} (${pct(triggeredL, losers.length)})`,
        fmt$(savedOnL),
        fmt$(lostOnW),
        fmt$(newPnl),
        fmt$(newPnl - baselinePnl),
        pct(newWins, allResults.length),
      ]);
    }
  }

  printTable(simHeaders, simRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 4: Best thesis exit by strategy
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 4: BEST THESIS EXIT BY STRATEGY');
  console.log('='.repeat(120));
  console.log();

  const stratGroups = {};
  for (const r of allResults) {
    const key = `${r.trade.strategy}/${r.trade.signal_filter}`;
    if (!stratGroups[key]) stratGroups[key] = [];
    stratGroups[key].push(r);
  }

  const stratHeaders = ['Strategy', 'N', 'Base Win%', 'Base PnL',
                        'Best Exit', 'New Win%', 'New PnL', 'Improvement'];
  const stratRows = [];

  for (const [key, results] of Object.entries(stratGroups).sort((a, b) => b[1].length - a[1].length)) {
    if (results.length < 15) continue;

    const basePnl = results.reduce((s, r) => s + r.trade.net_pnl, 0);
    const baseW = results.filter(r => r.trade.won).length;

    let bestLabel = 'none';
    let bestPnl = basePnl;
    let bestWinPct = pct(baseW, results.length);

    for (const minTime of MIN_TIMES) {
      for (const thr of THESIS_THRESHOLDS) {
        let newPnl = 0, newWins = 0;
        for (const r of results) {
          const crossing = r.crossings[thr.label];
          const exitSim = r.exitSims[thr.label];
          if (crossing && crossing.sec >= minTime && exitSim) {
            newPnl += exitSim.exitPnl;
            if (exitSim.exitPnl > 0) newWins++;
          } else {
            newPnl += r.trade.net_pnl;
            if (r.trade.won) newWins++;
          }
        }
        if (newPnl > bestPnl) {
          bestPnl = newPnl;
          bestLabel = `${thr.label} T+${minTime}s`;
          bestWinPct = pct(newWins, results.length);
        }
      }
    }

    stratRows.push([
      key, results.length, pct(baseW, results.length), fmt$(basePnl),
      bestLabel, bestWinPct, fmt$(bestPnl), fmt$(bestPnl - basePnl),
    ]);
  }

  printTable(stratHeaders, stratRows, ['L', 'R', 'R', 'R', 'L', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 5: Best overall — show the trade-level detail
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 5: BEST OVERALL THESIS EXIT — Detailed breakdown');
  console.log('='.repeat(120));
  console.log();

  // Find best overall
  let bestOverallPnl = baselinePnl;
  let bestOverallThr = null;
  let bestOverallMinTime = null;

  for (const minTime of MIN_TIMES) {
    for (const thr of THESIS_THRESHOLDS) {
      let newPnl = 0;
      for (const r of allResults) {
        const crossing = r.crossings[thr.label];
        const exitSim = r.exitSims[thr.label];
        if (crossing && crossing.sec >= minTime && exitSim) {
          newPnl += exitSim.exitPnl;
        } else {
          newPnl += r.trade.net_pnl;
        }
      }
      if (newPnl > bestOverallPnl) {
        bestOverallPnl = newPnl;
        bestOverallThr = thr;
        bestOverallMinTime = minTime;
      }
    }
  }

  if (bestOverallThr) {
    console.log(`  Best thesis exit: "${bestOverallThr.label}" after T+${bestOverallMinTime}s`);
    console.log(`  PnL improvement: ${fmt$(bestOverallPnl - baselinePnl)}`);
    console.log();

    // Breakdown of what happened
    let savedLosers = [], killedWinners = [], untouchedW = 0, untouchedL = 0;
    for (const r of allResults) {
      const crossing = r.crossings[bestOverallThr.label];
      const exitSim = r.exitSims[bestOverallThr.label];
      if (crossing && crossing.sec >= bestOverallMinTime && exitSim) {
        if (r.trade.won) {
          killedWinners.push({
            ...r, exitPnl: exitSim.exitPnl,
            lost: r.trade.net_pnl - exitSim.exitPnl,
            exitSec: crossing.sec,
          });
        } else {
          savedLosers.push({
            ...r, exitPnl: exitSim.exitPnl,
            saved: exitSim.exitPnl - r.trade.net_pnl,
            exitSec: crossing.sec,
          });
        }
      } else {
        if (r.trade.won) untouchedW++; else untouchedL++;
      }
    }

    console.log(`  Saved ${savedLosers.length} losers (avg saved: ${fmt$(savedLosers.reduce((s, l) => s + l.saved, 0) / savedLosers.length)}/trade)`);
    console.log(`  Killed ${killedWinners.length} winners (avg lost: ${fmt$(killedWinners.reduce((s, w) => s + w.lost, 0) / killedWinners.length)}/trade)`);
    console.log(`  Untouched: ${untouchedW} winners, ${untouchedL} losers`);
    console.log();

    // Exit PnL distribution for saved losers
    console.log('  SAVED LOSERS — exit PnL distribution:');
    const savedPnls = savedLosers.map(l => l.exitPnl);
    const savedBuckets = [
      { label: 'Profit (>$0)', fn: p => p > 0 },
      { label: 'Small loss ($0 to -$30)', fn: p => p <= 0 && p > -30 },
      { label: 'Medium loss (-$30 to -$60)', fn: p => p <= -30 && p > -60 },
      { label: 'Big loss (-$60 to -$90)', fn: p => p <= -60 && p > -90 },
      { label: 'Near-total loss (< -$90)', fn: p => p <= -90 },
    ];

    for (const b of savedBuckets) {
      const count = savedPnls.filter(b.fn).length;
      console.log(`    ${b.label.padEnd(35)} ${count} (${pct(count, savedPnls.length)})`);
    }
    console.log(`    Median exit PnL: ${fmt$(median(savedPnls))}`);
    console.log(`    vs hold PnL: always -$102`);
    console.log();

    // By symbol
    console.log('  BY SYMBOL:');
    const symStats = {};
    for (const r of allResults) {
      const sym = r.trade.symbol;
      if (!symStats[sym]) symStats[sym] = { base: 0, new: 0, n: 0 };
      symStats[sym].n++;
      symStats[sym].base += r.trade.net_pnl;

      const crossing = r.crossings[bestOverallThr.label];
      const exitSim = r.exitSims[bestOverallThr.label];
      if (crossing && crossing.sec >= bestOverallMinTime && exitSim) {
        symStats[sym].new += exitSim.exitPnl;
      } else {
        symStats[sym].new += r.trade.net_pnl;
      }
    }

    const symHeaders2 = ['Symbol', 'N', 'Base PnL', 'Thesis Exit PnL', 'Improvement'];
    const symRows2 = Object.entries(symStats).sort().map(([sym, s]) => [
      sym.toUpperCase(), s.n, fmt$(s.base), fmt$(s.new), fmt$(s.new - s.base),
    ]);
    printTable(symHeaders2, symRows2, ['L', 'R', 'R', 'R', 'R']);
    console.log();
  } else {
    console.log('  No thesis exit rule improved on baseline. Holding is better.');
    console.log();

    // Still show the closest — which rules came closest?
    console.log('  CLOSEST THESIS EXIT RULES:');
    const ruleResults = [];
    for (const minTime of MIN_TIMES) {
      for (const thr of THESIS_THRESHOLDS) {
        let newPnl = 0, triggers = 0;
        for (const r of allResults) {
          const crossing = r.crossings[thr.label];
          const exitSim = r.exitSims[thr.label];
          if (crossing && crossing.sec >= minTime && exitSim) {
            newPnl += exitSim.exitPnl;
            triggers++;
          } else {
            newPnl += r.trade.net_pnl;
          }
        }
        if (triggers > 0) {
          ruleResults.push({ label: `${thr.label} T+${minTime}s`, pnl: newPnl, diff: newPnl - baselinePnl, triggers });
        }
      }
    }
    ruleResults.sort((a, b) => b.diff - a.diff);
    for (const r of ruleResults.slice(0, 10)) {
      console.log(`    ${r.label.padEnd(40)} ${r.triggers} triggers | PnL: ${fmt$(r.pnl)} | vs baseline: ${fmt$(r.diff)}`);
    }
  }

  console.log();
  console.log('='.repeat(120));
  console.log('  SYNOPSIS');
  console.log('='.repeat(120));
  console.log();

  if (bestOverallThr) {
    console.log(`  YES — thesis exit helps. Best rule: "${bestOverallThr.label}" after T+${bestOverallMinTime}s`);
    console.log(`  Improvement: ${fmt$(bestOverallPnl - baselinePnl)} on ${allResults.length} trades`);
  } else {
    console.log('  The thesis exit approach was tested across all threshold/timing combinations.');
    console.log('  Check Section 2 for whether losers show earlier thesis deterioration than winners.');
  }
  console.log();
  console.log('='.repeat(120));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
