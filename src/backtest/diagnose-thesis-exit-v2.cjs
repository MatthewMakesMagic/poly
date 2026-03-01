/**
 * Thesis Exit Diagnostic v2 — Uses correct VWAP source per strategy
 *
 * Key fix: Uses composite_vwap for vwap_edge/down_only strategies,
 * and coingecko_price for vwap_cg_edge/down_cg strategies.
 * NOT Binance spot (which has structural $30-150 offset from CL due to VWAP gap).
 *
 * The thesis: "VWAP says direction X, CLOB disagrees, bet with VWAP."
 * Thesis dead: "VWAP no longer says direction X relative to strike."
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-thesis-exit-v2.cjs
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

// Determine which VWAP source a strategy uses
function getVwapSource(strategy) {
  if (strategy.includes('_cg') || strategy === 'clob_stale') return 'coingecko';
  if (strategy.includes('_v20') || strategy.includes('vwap20')) return 'composite'; // v20 uses different calc but same base
  return 'composite'; // vwap_edge, down_only
}

async function main() {
  console.log('='.repeat(120));
  console.log('  THESIS EXIT v2 — Using correct VWAP source (CoinGecko/Composite), NOT Binance spot');
  console.log('='.repeat(120));
  console.log();

  // ── Step 1: Load trades ──
  console.log('Step 1: Loading conviction-filtered trades...');

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
           w.strike_price::float as strike_price
    FROM paper_trades_v2 t
    JOIN window_close_events w ON w.window_id = t.window_id
    WHERE t.resolved_direction IS NOT NULL
      AND t.signal_time >= $1
      AND t.variant_label LIKE 'f-%'
    ORDER BY t.signal_time
  `, [l2StartDate]);

  const trades = tradesResult.rows;
  console.log(`  Found ${trades.length} trades`);
  console.log(`  Winners: ${trades.filter(t => t.won).length} | Losers: ${trades.filter(t => !t.won).length}`);

  // Count by VWAP source
  const bySrc = {};
  for (const t of trades) {
    const src = getVwapSource(t.strategy);
    bySrc[src] = (bySrc[src] || 0) + 1;
  }
  console.log(`  By VWAP source: ${Object.entries(bySrc).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  console.log();

  // ── Step 2: Track thesis via vwap_snapshots ──
  console.log('Step 2: Tracking thesis strength using VWAP snapshots post-entry...');

  const EXIT_FEE_PCT = 0.02;

  const THESIS_THRESHOLDS = [
    { label: 'crosses strike', pct: 0.0 },
    { label: '<0.01%', pct: 0.01 },
    { label: '<0.02%', pct: 0.02 },
    { label: '<0.03%', pct: 0.03 },
    { label: 'wrong by 0.02%', pct: -0.02 },
    { label: 'wrong by 0.05%', pct: -0.05 },
    { label: 'wrong by 0.10%', pct: -0.10 },
  ];

  const MIN_TIMES = [3, 5, 10, 15, 20, 30];

  const allResults = [];
  let processed = 0;
  let skippedNoVwap = 0;

  for (const trade of trades) {
    processed++;
    if (processed % 50 === 0) process.stdout.write(`  Processing ${processed}/${trades.length}...\r`);

    if (!trade.strike_price) continue;

    const signalMs = new Date(trade.signal_time).getTime();
    const isUp = trade.entry_side === 'UP';
    const vwapSource = getVwapSource(trade.strategy);

    // Determine which column to read from vwap_snapshots
    const priceCol = vwapSource === 'coingecko' ? 'coingecko_price' : 'composite_vwap';

    // Load VWAP snapshots after entry (up to 3 min)
    const vwapResult = await pool.query(`
      SELECT timestamp, ${priceCol}::float as vwap_price
      FROM vwap_snapshots
      WHERE symbol = $1
        AND timestamp >= $2
        AND timestamp <= $3
        AND ${priceCol} IS NOT NULL
      ORDER BY timestamp ASC
    `, [trade.symbol, trade.signal_time, new Date(signalMs + 180000)]);

    const vwapTicks = vwapResult.rows;
    if (vwapTicks.length < 3) { skippedNoVwap++; continue; }

    // Entry VWAP
    const entryVwap = vwapTicks[0].vwap_price;
    const entryDist = (entryVwap - trade.strike_price) / trade.strike_price * 100;
    const entryThesis = isUp ? entryDist : -entryDist;

    // Track thesis over time
    const thesisTrajectory = [];
    for (const v of vwapTicks) {
      const elapsed = (new Date(v.timestamp).getTime() - signalMs) / 1000;
      const dist = (v.vwap_price - trade.strike_price) / trade.strike_price * 100;
      const strength = isUp ? dist : -dist;
      thesisTrajectory.push({ elapsed, strength, vwapPrice: v.vwap_price });
    }

    // Find crossings
    const crossings = {};
    for (const thr of THESIS_THRESHOLDS) {
      for (const point of thesisTrajectory) {
        if (point.strength <= thr.pct && !crossings[thr.label]) {
          crossings[thr.label] = { sec: point.elapsed, vwapPrice: point.vwapPrice, strength: point.strength };
          break;
        }
      }
    }

    // Worst thesis
    let worstStrength = Infinity, worstSec = 0;
    for (const p of thesisTrajectory) {
      if (p.strength < worstStrength) { worstStrength = p.strength; worstSec = p.elapsed; }
    }

    // Load L2 for exit sim at crossings
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, best_bid::float, best_ask::float,
             spread::float, top_levels
      FROM l2_book_ticks
      WHERE window_id = $1 AND timestamp >= $2
      ORDER BY timestamp ASC
      LIMIT 3000
    `, [trade.window_id, trade.signal_time]);

    const l2Ticks = l2Result.rows;

    const exitSims = {};
    for (const [label, crossing] of Object.entries(crossings)) {
      const targetMs = signalMs + crossing.sec * 1000;
      let bestL2 = null, bestDist = Infinity;
      for (const tick of l2Ticks) {
        const d = Math.abs(new Date(tick.timestamp).getTime() - targetMs);
        if (d < bestDist) { bestDist = d; bestL2 = tick; }
      }

      if (bestL2 && bestDist < 5000) {
        let exitPrice;
        if (bestL2.top_levels) {
          const sim = isUp
            ? simulateSell(bestL2.top_levels.bids, trade.shares)
            : simulateSellDown(bestL2.top_levels.asks, trade.shares);
          exitPrice = sim.fillPrice;
        } else {
          exitPrice = isUp
            ? (bestL2.best_bid || bestL2.mid_price - bestL2.spread / 2)
            : (1.0 - (bestL2.best_ask || bestL2.mid_price + bestL2.spread / 2));
        }
        if (exitPrice > 0) {
          const exitProceeds = exitPrice * trade.shares;
          const exitFee = exitProceeds * EXIT_FEE_PCT;
          exitSims[label] = { exitPnl: exitProceeds - trade.cost - trade.fee - exitFee, exitPrice };
        }
      }
    }

    allResults.push({
      trade, vwapSource, entryThesis, crossings, exitSims,
      worstStrength, worstSec,
    });
  }

  process.stdout.write(''.padEnd(80) + '\r');
  console.log(`  Processed ${allResults.length} trades (skipped ${skippedNoVwap} with no VWAP data)`);
  console.log();

  const winners = allResults.filter(r => r.trade.won);
  const losers = allResults.filter(r => !r.trade.won);

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 1: Entry thesis — winners vs losers
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 1: ENTRY THESIS (using correct VWAP source per strategy)');
  console.log('='.repeat(120));
  console.log();

  const wEntry = winners.map(r => r.entryThesis);
  const lEntry = losers.map(r => r.entryThesis);
  console.log(`  Winners: median thesis ${median(wEntry).toFixed(4)}%`);
  console.log(`  Losers:  median thesis ${median(lEntry).toFixed(4)}%`);
  console.log();

  const entryBuckets = [
    { label: 'Wrong side (<0%)', min: -100, max: 0 },
    { label: 'Barely right (0-0.03%)', min: 0, max: 0.03 },
    { label: 'Moderate (0.03-0.08%)', min: 0.03, max: 0.08 },
    { label: 'Strong (0.08-0.15%)', min: 0.08, max: 0.15 },
    { label: 'Very strong (>0.15%)', min: 0.15, max: 100 },
  ];

  const entryRows = entryBuckets.map(b => {
    const w = allResults.filter(r => r.entryThesis >= b.min && r.entryThesis < b.max && r.trade.won).length;
    const l = allResults.filter(r => r.entryThesis >= b.min && r.entryThesis < b.max && !r.trade.won).length;
    return [b.label, w + l, w, pct(w, w + l), l];
  });

  printTable(['Entry Thesis', 'N', 'Winners', 'Win%', 'Losers'], entryRows, ['L', 'R', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 2: Thesis deterioration — crossing rates
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 2: THESIS DETERIORATION — Do losers\' VWAP cross strike more than winners\'?');
  console.log('='.repeat(120));
  console.log();

  const crossHeaders = ['Threshold', 'W Cross', 'W%', 'W Med Sec', 'L Cross', 'L%', 'L Med Sec', 'Separation'];
  const crossRows = [];

  for (const thr of THESIS_THRESHOLDS) {
    const wCross = winners.filter(r => r.crossings[thr.label]);
    const lCross = losers.filter(r => r.crossings[thr.label]);
    const wSecs = wCross.map(r => r.crossings[thr.label].sec);
    const lSecs = lCross.map(r => r.crossings[thr.label].sec);

    const wRate = wCross.length / winners.length;
    const lRate = lCross.length / losers.length;
    const gap = ((lRate - wRate) * 100).toFixed(1);
    const sep = lRate > wRate + 0.05
      ? `YES (L-W = ${gap}pp)`
      : `NO (${gap}pp)`;

    crossRows.push([
      thr.label,
      wCross.length, pct(wCross.length, winners.length),
      wSecs.length ? `T+${median(wSecs).toFixed(0)}s` : '-',
      lCross.length, pct(lCross.length, losers.length),
      lSecs.length ? `T+${median(lSecs).toFixed(0)}s` : '-',
      sep,
    ]);
  }

  printTable(crossHeaders, crossRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'L']);
  console.log();

  console.log('  WORST THESIS (median):');
  console.log(`    Winners: ${median(winners.map(r => r.worstStrength)).toFixed(4)}% at T+${median(winners.map(r => r.worstSec)).toFixed(0)}s`);
  console.log(`    Losers:  ${median(losers.map(r => r.worstStrength)).toFixed(4)}% at T+${median(losers.map(r => r.worstSec)).toFixed(0)}s`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 3: Thesis exit simulation
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 3: THESIS EXIT SIMULATION');
  console.log('='.repeat(120));
  console.log();

  const baselinePnl = allResults.reduce((s, r) => s + r.trade.net_pnl, 0);
  console.log(`  BASELINE: ${allResults.length} trades | Win%: ${pct(winners.length, allResults.length)} | PnL: ${fmt$(baselinePnl)}`);
  console.log();

  const simHeaders = ['Exit Rule', 'Exits', 'On W', 'On L', 'Saved L', 'Lost W', 'Net PnL', 'vs Base', 'New Win%'];
  const simRows = [];

  let bestPnl = baselinePnl, bestThr = null, bestMinTime = null;

  for (const minTime of MIN_TIMES) {
    for (const thr of THESIS_THRESHOLDS) {
      let trigW = 0, trigL = 0, savedL = 0, lostW = 0, newPnl = 0, newWins = 0;

      for (const r of allResults) {
        const crossing = r.crossings[thr.label];
        const exitSim = r.exitSims[thr.label];
        if (crossing && crossing.sec >= minTime && exitSim) {
          if (r.trade.won) {
            trigW++;
            lostW += (r.trade.net_pnl - exitSim.exitPnl);
            newPnl += exitSim.exitPnl;
            if (exitSim.exitPnl > 0) newWins++;
          } else {
            trigL++;
            savedL += (exitSim.exitPnl - r.trade.net_pnl);
            newPnl += exitSim.exitPnl;
            if (exitSim.exitPnl > 0) newWins++;
          }
        } else {
          newPnl += r.trade.net_pnl;
          if (r.trade.won) newWins++;
        }
      }

      const trig = trigW + trigL;
      if (trig === 0) continue;

      if (newPnl > bestPnl) { bestPnl = newPnl; bestThr = thr; bestMinTime = minTime; }

      simRows.push([
        `${thr.label} T+${minTime}s`,
        `${trig} (${pct(trig, allResults.length)})`,
        `${trigW} (${pct(trigW, winners.length)})`,
        `${trigL} (${pct(trigL, losers.length)})`,
        fmt$(savedL), fmt$(lostW), fmt$(newPnl),
        fmt$(newPnl - baselinePnl),
        pct(newWins, allResults.length),
      ]);
    }
  }

  printTable(simHeaders, simRows, ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 4: Best exit by strategy
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

  const stratHeaders = ['Strategy', 'Src', 'N', 'Base Win%', 'Base PnL',
                        'Best Exit', 'New Win%', 'New PnL', 'Improv'];
  const stratRows = [];

  for (const [key, results] of Object.entries(stratGroups).sort((a, b) => b[1].length - a[1].length)) {
    if (results.length < 15) continue;
    const basePnl = results.reduce((s, r) => s + r.trade.net_pnl, 0);
    const baseW = results.filter(r => r.trade.won).length;
    const src = results[0].vwapSource;

    let bLabel = 'none', bPnl = basePnl, bWin = pct(baseW, results.length);
    for (const minTime of MIN_TIMES) {
      for (const thr of THESIS_THRESHOLDS) {
        let np = 0, nw = 0;
        for (const r of results) {
          const c = r.crossings[thr.label];
          const e = r.exitSims[thr.label];
          if (c && c.sec >= minTime && e) {
            np += e.exitPnl;
            if (e.exitPnl > 0) nw++;
          } else {
            np += r.trade.net_pnl;
            if (r.trade.won) nw++;
          }
        }
        if (np > bPnl) { bPnl = np; bLabel = `${thr.label} T+${minTime}s`; bWin = pct(nw, results.length); }
      }
    }

    stratRows.push([key, src, results.length, pct(baseW, results.length), fmt$(basePnl),
                    bLabel, bWin, fmt$(bPnl), fmt$(bPnl - basePnl)]);
  }

  printTable(stratHeaders, stratRows, ['L', 'L', 'R', 'R', 'R', 'L', 'R', 'R', 'R']);
  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 5: Detail on best overall
  // ══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(120));
  console.log('  SECTION 5: BEST OVERALL');
  console.log('='.repeat(120));
  console.log();

  if (bestThr) {
    console.log(`  Best: "${bestThr.label}" after T+${bestMinTime}s`);
    console.log(`  Improvement: ${fmt$(bestPnl - baselinePnl)} (${fmt$(baselinePnl)} → ${fmt$(bestPnl)})`);
    console.log();

    let savedL = [], killedW = [];
    for (const r of allResults) {
      const c = r.crossings[bestThr.label];
      const e = r.exitSims[bestThr.label];
      if (c && c.sec >= bestMinTime && e) {
        if (r.trade.won) killedW.push({ ...r, exitPnl: e.exitPnl });
        else savedL.push({ ...r, exitPnl: e.exitPnl });
      }
    }

    console.log(`  Saved ${savedL.length} losers: median exit PnL ${fmt$(median(savedL.map(l => l.exitPnl)))} (vs always -$102)`);
    console.log(`  Killed ${killedW.length} winners: median lost ${fmt$(median(killedW.map(w => w.trade.net_pnl - w.exitPnl)))}`);
    console.log();

    // By symbol
    const symStats = {};
    for (const r of allResults) {
      const sym = r.trade.symbol;
      if (!symStats[sym]) symStats[sym] = { n: 0, base: 0, newP: 0 };
      symStats[sym].n++;
      symStats[sym].base += r.trade.net_pnl;
      const c = r.crossings[bestThr.label];
      const e = r.exitSims[bestThr.label];
      symStats[sym].newP += (c && c.sec >= bestMinTime && e) ? e.exitPnl : r.trade.net_pnl;
    }

    const symRows = Object.entries(symStats).sort().map(([s, v]) =>
      [s.toUpperCase(), v.n, fmt$(v.base), fmt$(v.newP), fmt$(v.newP - v.base)]);
    printTable(['Symbol', 'N', 'Base PnL', 'Exit PnL', 'Improvement'], symRows, ['L', 'R', 'R', 'R', 'R']);
  } else {
    console.log('  No thesis exit improved on baseline.');

    // Show top 5 closest
    const ruleResults = [];
    for (const minTime of MIN_TIMES) {
      for (const thr of THESIS_THRESHOLDS) {
        let np = 0, trigs = 0;
        for (const r of allResults) {
          const c = r.crossings[thr.label];
          const e = r.exitSims[thr.label];
          if (c && c.sec >= minTime && e) { np += e.exitPnl; trigs++; }
          else np += r.trade.net_pnl;
        }
        if (trigs > 0) ruleResults.push({ label: `${thr.label} T+${minTime}s`, pnl: np, diff: np - baselinePnl, trigs });
      }
    }
    ruleResults.sort((a, b) => b.diff - a.diff);
    console.log('  Top 5 closest rules:');
    for (const r of ruleResults.slice(0, 5)) {
      console.log(`    ${r.label.padEnd(35)} ${r.trigs} triggers | vs baseline: ${fmt$(r.diff)}`);
    }
  }

  console.log();
  console.log('='.repeat(120));
  console.log('  SYNOPSIS');
  console.log('='.repeat(120));
  console.log();
  if (bestThr) {
    console.log(`  YES — thesis exit works using proper VWAP source.`);
    console.log(`  Rule: "${bestThr.label}" after T+${bestMinTime}s → ${fmt$(bestPnl - baselinePnl)} improvement`);
  } else {
    console.log('  NO — thesis exit does not help when using the correct VWAP source.');
  }
  console.log();
  console.log('='.repeat(120));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
