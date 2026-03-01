/**
 * L2 Depth Trajectory & Stop-Loss Diagnostic
 *
 * Analyzes continuous L2 book data after trade entry signals to evaluate
 * microstructure-based stop-loss viability. Compares depth collapse,
 * mid-price movement, and spread widening between winners and losers.
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-l2-stop-loss.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Helpers ───

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + (v || 0), 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) {
  return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A';
}

function fmt$(v) {
  if (v == null || isNaN(v)) return '$0';
  return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
}

function padR(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function printTable(headers, rows, alignments) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
  );
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const pad = (val, i) => {
    const s = String(val ?? '');
    return alignments && alignments[i] === 'R' ? padL(s, widths[i]) : padR(s, widths[i]);
  };

  console.log(headers.map((h, i) => ` ${pad(h, i)} `).join('|'));
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((v, i) => ` ${pad(v, i)} `).join('|'));
  }
}

// ─── Main ───

async function main() {
  console.log('='.repeat(110));
  console.log('  L2 DEPTH TRAJECTORY & STOP-LOSS DIAGNOSTIC');
  console.log('='.repeat(110));
  console.log();

  // ── Data availability ──
  const l2Count = await pool.query(`SELECT COUNT(*) as n FROM l2_book_ticks`);
  const l2Range = await pool.query(`
    SELECT MIN(timestamp) as min_t, MAX(timestamp) as max_t,
           COUNT(DISTINCT window_id) as windows,
           COUNT(DISTINCT symbol) as symbols
    FROM l2_book_ticks
  `);

  console.log(`L2 ticks: ${parseInt(l2Count.rows[0].n).toLocaleString()}`);
  console.log(`  Range:   ${l2Range.rows[0].min_t} -> ${l2Range.rows[0].max_t}`);
  console.log(`  Windows: ${l2Range.rows[0].windows}  |  Symbols: ${l2Range.rows[0].symbols}`);
  console.log();

  // ── Fetch resolved trades overlapping L2 period ──
  const tradesResult = await pool.query(`
    SELECT
      t.id, t.window_id, t.symbol, t.signal_time, t.signal_type,
      t.variant_label, t.signal_offset_sec,
      t.entry_side, t.entry_token_id,
      t.sim_entry_price::float, t.sim_cost::float, t.sim_fee::float,
      t.sim_shares::float,
      t.vwap_direction, t.clob_direction,
      t.vwap_delta::float, t.clob_up_price::float,
      t.won, t.net_pnl::float, t.gross_pnl::float,
      t.resolved_direction, t.position_size_dollars::float,
      t.strategy_metadata,
      t.vwap_source
    FROM paper_trades_v2 t
    WHERE t.resolved_direction IS NOT NULL
      AND t.signal_time >= (SELECT MIN(timestamp) FROM l2_book_ticks)
    ORDER BY t.signal_time
  `);

  console.log(`Resolved trades in L2 period: ${tradesResult.rows.length}`);

  if (tradesResult.rows.length === 0) {
    console.log('\nNo resolved trades overlap with L2 data. Exiting.');
    await pool.end();
    return;
  }

  // ── Group trades by window, fetch L2 once per window ──
  const windowMap = new Map();
  for (const trade of tradesResult.rows) {
    if (!windowMap.has(trade.window_id)) windowMap.set(trade.window_id, []);
    windowMap.get(trade.window_id).push(trade);
  }

  console.log(`Unique windows with trades: ${windowMap.size}`);
  console.log();

  const DEPTH_THRESHOLDS = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70];
  const MID_THRESHOLDS = [0.02, 0.03, 0.05, 0.08, 0.10];
  const SNAPSHOT_TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

  const allResults = [];
  let windowsWithL2 = 0;
  let windowsWithoutL2 = 0;
  let processed = 0;

  for (const [windowId, trades] of windowMap) {
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  Processing window ${processed}/${windowMap.size}\r`);

    // Fetch all L2 ticks for this window
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, spread::float,
             bid_depth_1pct::float, ask_depth_1pct::float,
             best_bid::float, best_ask::float
      FROM l2_book_ticks
      WHERE window_id = $1
      ORDER BY timestamp ASC
    `, [windowId]);

    if (l2Result.rows.length < 10) {
      windowsWithoutL2++;
      continue;
    }
    windowsWithL2++;

    const l2Ticks = l2Result.rows;

    for (const trade of trades) {
      const signalMs = new Date(trade.signal_time).getTime();
      const windowCloseMs = signalMs + (trade.signal_offset_sec * 1000);

      // L2 ticks from signal to window close (+ 5s buffer for settlement lag)
      const relevantTicks = l2Ticks.filter(t => {
        const tMs = new Date(t.timestamp).getTime();
        return tMs >= signalMs && tMs <= windowCloseMs + 5000;
      });

      if (relevantTicks.length < 5) continue;

      const isUp = trade.entry_side === 'up';

      // Baseline from first 3 ticks
      const base = relevantTicks.slice(0, Math.min(3, relevantTicks.length));
      const entryYourDepth = avg(base.map(t => isUp ? t.bid_depth_1pct : t.ask_depth_1pct));
      const entryAgainstDepth = avg(base.map(t => isUp ? t.ask_depth_1pct : t.bid_depth_1pct));
      const entryMid = avg(base.map(t => t.mid_price));
      const entrySpread = avg(base.map(t => t.spread));

      if (entryYourDepth <= 0) continue;

      // Track extremes
      let minDepthRatio = 1.0, minDepthSec = 0;
      let maxMidMoveAgainst = 0, maxMidMoveAgainstSec = 0;
      let maxSpreadWiden = 0, maxSpreadWidenSec = 0;

      const snapshots = {};
      const stopResults = {};

      // Initialize stop trackers (first trigger only)
      const depthTriggered = {};
      const midTriggered = {};

      for (const tick of relevantTicks) {
        const elapsedSec = (new Date(tick.timestamp).getTime() - signalMs) / 1000;
        const yourDepth = isUp ? tick.bid_depth_1pct : tick.ask_depth_1pct;
        const depthRatio = yourDepth / entryYourDepth;
        const midMove = tick.mid_price - entryMid;
        const moveAgainst = isUp ? -midMove : midMove;
        const spreadWiden = tick.spread - entrySpread;

        // Track extremes
        if (depthRatio < minDepthRatio) { minDepthRatio = depthRatio; minDepthSec = elapsedSec; }
        if (moveAgainst > maxMidMoveAgainst) { maxMidMoveAgainst = moveAgainst; maxMidMoveAgainstSec = elapsedSec; }
        if (spreadWiden > maxSpreadWiden) { maxSpreadWiden = spreadWiden; maxSpreadWidenSec = elapsedSec; }

        // Snapshots at key times
        for (const sec of SNAPSHOT_TIMES) {
          if (!snapshots[sec] && elapsedSec >= sec) {
            snapshots[sec] = { depthRatio, midMove, moveAgainst, spread: tick.spread, mid: tick.mid_price };
          }
        }

        // Depth-based stop triggers
        for (const thr of DEPTH_THRESHOLDS) {
          if (!depthTriggered[thr] && depthRatio <= thr) {
            // Exit price estimate
            let exitPrice;
            if (isUp) {
              exitPrice = tick.best_bid || (tick.mid_price - (tick.spread || entrySpread) / 2);
            } else {
              // DOWN token value ~ 1 - UP ask
              const upAsk = tick.best_ask || (tick.mid_price + (tick.spread || entrySpread) / 2);
              exitPrice = 1.0 - upAsk;
            }
            const exitPnl = (exitPrice - trade.sim_entry_price) * trade.sim_shares - trade.sim_fee;
            depthTriggered[thr] = { triggerSec: elapsedSec, exitPrice, exitPnl };
          }
        }

        // Mid-price stop triggers
        for (const cents of MID_THRESHOLDS) {
          if (!midTriggered[cents] && moveAgainst >= cents) {
            let exitPrice;
            if (isUp) {
              exitPrice = tick.best_bid || (tick.mid_price - (tick.spread || entrySpread) / 2);
            } else {
              const upAsk = tick.best_ask || (tick.mid_price + (tick.spread || entrySpread) / 2);
              exitPrice = 1.0 - upAsk;
            }
            const exitPnl = (exitPrice - trade.sim_entry_price) * trade.sim_shares - trade.sim_fee;
            midTriggered[cents] = { triggerSec: elapsedSec, exitPrice, exitPnl };
          }
        }
      }

      // Pack stop results
      for (const thr of DEPTH_THRESHOLDS) {
        stopResults[`depth_${thr}`] = depthTriggered[thr]
          ? { triggered: true, ...depthTriggered[thr] }
          : { triggered: false };
      }
      for (const cents of MID_THRESHOLDS) {
        stopResults[`mid_${cents}`] = midTriggered[cents]
          ? { triggered: true, ...midTriggered[cents] }
          : { triggered: false };
      }

      allResults.push({
        id: trade.id,
        windowId: trade.window_id,
        symbol: trade.symbol,
        signalType: trade.signal_type,
        variantLabel: trade.variant_label,
        signalOffsetSec: trade.signal_offset_sec,
        entrySide: trade.entry_side,
        entryPrice: trade.sim_entry_price,
        shares: trade.sim_shares,
        cost: trade.sim_cost,
        fee: trade.sim_fee,
        won: trade.won,
        netPnl: trade.net_pnl,
        resolvedDirection: trade.resolved_direction,
        vwapDeltaPct: trade.strategy_metadata?.vwapDeltaPct,
        clobConviction: trade.strategy_metadata?.clobConviction,
        positionSize: trade.position_size_dollars,
        // Depth analysis
        tickCount: relevantTicks.length,
        entryYourDepth,
        entryAgainstDepth,
        entryMid,
        entrySpread,
        minDepthRatio,
        minDepthSec,
        maxMidMoveAgainst,
        maxMidMoveAgainstSec,
        maxSpreadWiden,
        maxSpreadWidenSec,
        snapshots,
        stopResults,
      });
    }
  }

  process.stdout.write(''.padEnd(60) + '\r');
  console.log(`Windows with sufficient L2:    ${windowsWithL2}`);
  console.log(`Windows without sufficient L2: ${windowsWithoutL2}`);
  console.log(`Trades analyzed:               ${allResults.length}`);
  console.log();

  if (allResults.length === 0) {
    console.log('No trades with sufficient L2 data. Exiting.');
    await pool.end();
    return;
  }

  const winners = allResults.filter(r => r.won);
  const losers = allResults.filter(r => !r.won);
  const origTotalPnl = allResults.reduce((s, r) => s + r.netPnl, 0);

  console.log(`Overall: ${winners.length} wins / ${losers.length} losses = ${pct(winners.length, allResults.length)} win rate`);
  console.log(`Total PnL (no stop-loss): ${fmt$(origTotalPnl)}`);
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1: DEPTH TRAJECTORY — WINNERS VS LOSERS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 1: DEPTH TRAJECTORY — WINNERS VS LOSERS');
  console.log('='.repeat(110));
  console.log();

  // 1A: Min depth ratio distribution
  console.log('1A. Minimum Depth Ratio Distribution (worst drawdown in your-side depth)');
  console.log('    Lower ratio = more depth pulled from your side during the trade');
  console.log();

  const depthBuckets = [
    { label: '<0.20 (>80% pulled)', min: -Infinity, max: 0.20 },
    { label: '0.20-0.40 (60-80%)',  min: 0.20, max: 0.40 },
    { label: '0.40-0.60 (40-60%)',  min: 0.40, max: 0.60 },
    { label: '0.60-0.80 (20-40%)',  min: 0.60, max: 0.80 },
    { label: '0.80-1.00 (stable)',  min: 0.80, max: 1.00 },
    { label: '>1.00 (depth added)', min: 1.00, max: Infinity },
  ];

  const depthRows = depthBuckets.map(b => {
    const w = winners.filter(r => r.minDepthRatio >= b.min && r.minDepthRatio < b.max);
    const l = losers.filter(r => r.minDepthRatio >= b.min && r.minDepthRatio < b.max);
    const total = w.length + l.length;
    const allPnl = [...w, ...l].map(r => r.netPnl);
    return [
      b.label,
      w.length,
      l.length,
      total,
      pct(w.length, total),
      total > 0 ? fmt$(allPnl.reduce((s, v) => s + v, 0)) : '$0',
    ];
  });

  printTable(
    ['Depth Ratio Bucket', 'Wins', 'Losses', 'Total', 'Win%', 'Sum PnL'],
    depthRows,
    ['L', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();

  // 1B: Median summary stats
  console.log('1B. Median Depth & Price Stats: Winners vs Losers');
  console.log();

  printTable(
    ['Metric', 'Winners', 'Losers', 'Delta (W-L)'],
    [
      [
        'Min depth ratio',
        winners.length ? median(winners.map(r => r.minDepthRatio)).toFixed(3) : 'N/A',
        losers.length ? median(losers.map(r => r.minDepthRatio)).toFixed(3) : 'N/A',
        (winners.length && losers.length) ? (median(winners.map(r => r.minDepthRatio)) - median(losers.map(r => r.minDepthRatio))).toFixed(3) : '',
      ],
      [
        'Min depth timing (sec)',
        winners.length ? median(winners.map(r => r.minDepthSec)).toFixed(1) : 'N/A',
        losers.length ? median(losers.map(r => r.minDepthSec)).toFixed(1) : 'N/A',
        '',
      ],
      [
        'Max mid move against (cents)',
        winners.length ? (median(winners.map(r => r.maxMidMoveAgainst)) * 100).toFixed(2) + '¢' : 'N/A',
        losers.length ? (median(losers.map(r => r.maxMidMoveAgainst)) * 100).toFixed(2) + '¢' : 'N/A',
        (winners.length && losers.length) ? ((median(losers.map(r => r.maxMidMoveAgainst)) - median(winners.map(r => r.maxMidMoveAgainst))) * 100).toFixed(2) + '¢' : '',
      ],
      [
        'Entry your-side depth ($)',
        winners.length ? '$' + median(winners.map(r => r.entryYourDepth)).toFixed(0) : 'N/A',
        losers.length ? '$' + median(losers.map(r => r.entryYourDepth)).toFixed(0) : 'N/A',
        '',
      ],
      [
        'Entry spread (cents)',
        winners.length ? (median(winners.map(r => r.entrySpread)) * 100).toFixed(2) + '¢' : 'N/A',
        losers.length ? (median(losers.map(r => r.entrySpread)) * 100).toFixed(2) + '¢' : 'N/A',
        '',
      ],
      [
        'Max spread widen (cents)',
        winners.length ? (median(winners.map(r => r.maxSpreadWiden)) * 100).toFixed(2) + '¢' : 'N/A',
        losers.length ? (median(losers.map(r => r.maxSpreadWiden)) * 100).toFixed(2) + '¢' : 'N/A',
        (winners.length && losers.length) ? ((median(losers.map(r => r.maxSpreadWiden)) - median(winners.map(r => r.maxSpreadWiden))) * 100).toFixed(2) + '¢' : '',
      ],
    ],
    ['L', 'R', 'R', 'R']
  );
  console.log();

  // 1C: Depth ratio at time intervals
  console.log('1C. Average Depth Ratio at Key Intervals After Entry');
  console.log('    (1.0 = same depth as entry, <1.0 = depth pulled, >1.0 = depth added)');
  console.log();

  const intervalRows = SNAPSHOT_TIMES.map(sec => {
    const wSnaps = winners.filter(r => r.snapshots[sec]).map(r => r.snapshots[sec].depthRatio);
    const lSnaps = losers.filter(r => r.snapshots[sec]).map(r => r.snapshots[sec].depthRatio);
    const diff = (wSnaps.length > 0 && lSnaps.length > 0) ? (avg(wSnaps) - avg(lSnaps)).toFixed(3) : '';
    return [
      `T+${sec}s`,
      wSnaps.length > 0 ? avg(wSnaps).toFixed(3) : 'N/A',
      lSnaps.length > 0 ? avg(lSnaps).toFixed(3) : 'N/A',
      diff,
      wSnaps.length,
      lSnaps.length,
    ];
  });

  printTable(
    ['Time', 'Win Avg', 'Lose Avg', 'Diff (W-L)', 'N(Win)', 'N(Lose)'],
    intervalRows,
    ['L', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();

  // 1D: Mid-price move against at intervals
  console.log('1D. Average Mid-Price Move Against Entry (cents) at Key Intervals');
  console.log('    Higher = price moved further against your position');
  console.log();

  const midRows = SNAPSHOT_TIMES.map(sec => {
    const wSnaps = winners.filter(r => r.snapshots[sec]).map(r => r.snapshots[sec].moveAgainst);
    const lSnaps = losers.filter(r => r.snapshots[sec]).map(r => r.snapshots[sec].moveAgainst);
    return [
      `T+${sec}s`,
      wSnaps.length > 0 ? (avg(wSnaps) * 100).toFixed(2) + '¢' : 'N/A',
      lSnaps.length > 0 ? (avg(lSnaps) * 100).toFixed(2) + '¢' : 'N/A',
      (wSnaps.length > 0 && lSnaps.length > 0) ? (((avg(lSnaps) - avg(wSnaps)) * 100).toFixed(2) + '¢') : '',
    ];
  });

  printTable(
    ['Time', 'Win Avg', 'Lose Avg', 'Loser Excess'],
    midRows,
    ['L', 'R', 'R', 'R']
  );
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: STOP-LOSS SIMULATION — ALL TRADES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 2: STOP-LOSS SIMULATION — ALL TRADES');
  console.log('='.repeat(110));
  console.log();

  // Helper for stop-loss aggregation
  function computeStopStats(trades, key) {
    const w = trades.filter(r => r.won);
    const l = trades.filter(r => !r.won);
    const wt = w.filter(r => r.stopResults[key]?.triggered);
    const lt = l.filter(r => r.stopResults[key]?.triggered);

    const saved = lt.reduce((s, r) => s + ((r.stopResults[key].exitPnl || 0) - r.netPnl), 0);
    const lost = wt.reduce((s, r) => s + ((r.stopResults[key].exitPnl || 0) - r.netPnl), 0);

    return {
      losersHit: lt.length, totalLosers: l.length,
      winnersHit: wt.length, totalWinners: w.length,
      saved, lost, net: saved + lost,
      avgTriggerSecLosers: lt.length > 0 ? avg(lt.map(r => r.stopResults[key].triggerSec)) : null,
      avgTriggerSecWinners: wt.length > 0 ? avg(wt.map(r => r.stopResults[key].triggerSec)) : null,
      avgExitPnlLosers: lt.length > 0 ? avg(lt.map(r => r.stopResults[key].exitPnl)) : null,
      avgExitPnlWinners: wt.length > 0 ? avg(wt.map(r => r.stopResults[key].exitPnl)) : null,
    };
  }

  // 2A: Depth-based
  console.log('2A. Depth-Based Stop-Loss');
  console.log('    Trigger: your-side depth drops to X% of entry depth');
  console.log();

  const depthStopRows = DEPTH_THRESHOLDS.map(thr => {
    const s = computeStopStats(allResults, `depth_${thr}`);
    return [
      `<${(thr * 100).toFixed(0)}% (${((1 - thr) * 100).toFixed(0)}%+ pulled)`,
      `${s.losersHit}/${s.totalLosers}`,
      pct(s.losersHit, s.totalLosers),
      `${s.winnersHit}/${s.totalWinners}`,
      pct(s.winnersHit, s.totalWinners),
      fmt$(s.saved),
      fmt$(s.lost),
      fmt$(s.net),
      s.avgTriggerSecLosers != null ? s.avgTriggerSecLosers.toFixed(1) + 's' : '-',
    ];
  });

  printTable(
    ['Threshold', 'Losers Hit', 'L-Rate', 'Winners Hit', 'W-Rate', 'Saved', 'Lost', 'NET', 'Avg Trig(L)'],
    depthStopRows,
    ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();

  // 2B: Mid-price movement
  console.log('2B. Mid-Price Movement Stop-Loss');
  console.log('    Trigger: mid-price moves X cents against your entry side');
  console.log();

  const midStopRows = MID_THRESHOLDS.map(cents => {
    const s = computeStopStats(allResults, `mid_${cents}`);
    return [
      `${(cents * 100).toFixed(0)}¢ against`,
      `${s.losersHit}/${s.totalLosers}`,
      pct(s.losersHit, s.totalLosers),
      `${s.winnersHit}/${s.totalWinners}`,
      pct(s.winnersHit, s.totalWinners),
      fmt$(s.saved),
      fmt$(s.lost),
      fmt$(s.net),
      s.avgTriggerSecLosers != null ? s.avgTriggerSecLosers.toFixed(1) + 's' : '-',
    ];
  });

  printTable(
    ['Threshold', 'Losers Hit', 'L-Rate', 'Winners Hit', 'W-Rate', 'Saved', 'Lost', 'NET', 'Avg Trig(L)'],
    midStopRows,
    ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3: STOP-LOSS IMPACT BY STRATEGY
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 3: STOP-LOSS IMPACT BY STRATEGY');
  console.log('='.repeat(110));
  console.log();

  const strategyGroups = new Map();
  for (const r of allResults) {
    if (!strategyGroups.has(r.signalType)) strategyGroups.set(r.signalType, []);
    strategyGroups.get(r.signalType).push(r);
  }

  for (const [strategy, trades] of [...strategyGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (trades.length < 3) continue;
    const w = trades.filter(r => r.won);
    const l = trades.filter(r => !r.won);

    console.log(`─── ${strategy} (${trades.length} trades, ${w.length}W/${l.length}L = ${pct(w.length, trades.length)} win, PnL: ${fmt$(trades.reduce((s, r) => s + r.netPnl, 0))}) ───`);
    console.log();

    const rows = [];
    for (const thr of DEPTH_THRESHOLDS) {
      const s = computeStopStats(trades, `depth_${thr}`);
      rows.push([`depth <${(thr * 100).toFixed(0)}%`, `${s.losersHit}/${s.totalLosers}`, `${s.winnersHit}/${s.totalWinners}`, fmt$(s.saved), fmt$(s.lost), fmt$(s.net)]);
    }
    for (const cents of [0.03, 0.05, 0.08]) {
      const s = computeStopStats(trades, `mid_${cents}`);
      rows.push([`mid >${(cents * 100).toFixed(0)}¢`, `${s.losersHit}/${s.totalLosers}`, `${s.winnersHit}/${s.totalWinners}`, fmt$(s.saved), fmt$(s.lost), fmt$(s.net)]);
    }

    printTable(
      ['Stop Type', 'Losers Hit', 'Winners Hit', 'Saved', 'Lost', 'NET'],
      rows,
      ['L', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4: STOP-LOSS IMPACT BY SIGNAL OFFSET
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 4: STOP-LOSS IMPACT BY SIGNAL OFFSET');
  console.log('='.repeat(110));
  console.log();
  console.log('  Hypothesis: longer offsets (T-90, T-120) benefit more from stop-loss');
  console.log('  because there is more time for the book to show warning signs.');
  console.log();

  const offsetGroups = new Map();
  for (const r of allResults) {
    if (!offsetGroups.has(r.signalOffsetSec)) offsetGroups.set(r.signalOffsetSec, []);
    offsetGroups.get(r.signalOffsetSec).push(r);
  }

  for (const [offset, trades] of [...offsetGroups.entries()].sort((a, b) => a - b)) {
    if (trades.length < 3) continue;
    const w = trades.filter(r => r.won);
    const l = trades.filter(r => !r.won);

    console.log(`─── T-${offset}s (${trades.length} trades, ${pct(w.length, trades.length)} win) ───`);

    const rows = [];
    for (const thr of [0.30, 0.50, 0.70]) {
      const s = computeStopStats(trades, `depth_${thr}`);
      rows.push([
        `depth <${(thr * 100).toFixed(0)}%`,
        `${s.losersHit}/${s.totalLosers}`,
        `${s.winnersHit}/${s.totalWinners}`,
        fmt$(s.saved), fmt$(s.lost), fmt$(s.net),
        s.avgTriggerSecLosers != null ? s.avgTriggerSecLosers.toFixed(1) + 's' : '-',
      ]);
    }
    for (const cents of [0.03, 0.05]) {
      const s = computeStopStats(trades, `mid_${cents}`);
      rows.push([
        `mid >${(cents * 100).toFixed(0)}¢`,
        `${s.losersHit}/${s.totalLosers}`,
        `${s.winnersHit}/${s.totalWinners}`,
        fmt$(s.saved), fmt$(s.lost), fmt$(s.net),
        s.avgTriggerSecLosers != null ? s.avgTriggerSecLosers.toFixed(1) + 's' : '-',
      ]);
    }

    printTable(
      ['Stop Type', 'Losers Hit', 'Winners Hit', 'Saved', 'Lost', 'NET', 'Trig Time(L)'],
      rows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5: STOP-LOSS IMPACT BY SYMBOL
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 5: STOP-LOSS IMPACT BY SYMBOL');
  console.log('='.repeat(110));
  console.log();

  const symbolGroups = new Map();
  for (const r of allResults) {
    if (!symbolGroups.has(r.symbol)) symbolGroups.set(r.symbol, []);
    symbolGroups.get(r.symbol).push(r);
  }

  for (const [symbol, trades] of [...symbolGroups.entries()].sort()) {
    if (trades.length < 3) continue;
    const w = trades.filter(r => r.won);
    const l = trades.filter(r => !r.won);

    console.log(`─── ${symbol.toUpperCase()} (${trades.length} trades, ${pct(w.length, trades.length)} win, PnL: ${fmt$(trades.reduce((s, r) => s + r.netPnl, 0))}) ───`);
    console.log(`    Depth stats — Win min ratio: ${winners.length ? median(w.map(r => r.minDepthRatio)).toFixed(3) : 'N/A'} | Lose min ratio: ${losers.length ? median(l.map(r => r.minDepthRatio)).toFixed(3) : 'N/A'}`);
    console.log();

    const rows = [];
    for (const thr of DEPTH_THRESHOLDS) {
      const s = computeStopStats(trades, `depth_${thr}`);
      rows.push([`depth <${(thr * 100).toFixed(0)}%`, `${s.losersHit}/${s.totalLosers}`, `${s.winnersHit}/${s.totalWinners}`, fmt$(s.saved), fmt$(s.lost), fmt$(s.net)]);
    }

    printTable(
      ['Stop Type', 'Losers Hit', 'Winners Hit', 'Saved', 'Lost', 'NET'],
      rows,
      ['L', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6: DEPTH BEHAVIOR BY ENTRY SIDE
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 6: DEPTH BEHAVIOR BY ENTRY SIDE (UP vs DOWN)');
  console.log('='.repeat(110));
  console.log();

  for (const side of ['up', 'down']) {
    const sideTrades = allResults.filter(r => r.entrySide === side);
    if (sideTrades.length < 3) continue;
    const sw = sideTrades.filter(r => r.won);
    const sl = sideTrades.filter(r => !r.won);

    console.log(`─── ${side.toUpperCase()} entries (${sideTrades.length} trades, ${pct(sw.length, sideTrades.length)} win) ───`);
    console.log(`  Winner depth: min ratio median ${sw.length ? median(sw.map(r => r.minDepthRatio)).toFixed(3) : 'N/A'} | max mid against median ${sw.length ? (median(sw.map(r => r.maxMidMoveAgainst)) * 100).toFixed(2) : 'N/A'}¢`);
    console.log(`  Loser depth:  min ratio median ${sl.length ? median(sl.map(r => r.minDepthRatio)).toFixed(3) : 'N/A'} | max mid against median ${sl.length ? (median(sl.map(r => r.maxMidMoveAgainst)) * 100).toFixed(2) : 'N/A'}¢`);
    console.log();

    const rows = [];
    for (const thr of [0.30, 0.50, 0.70]) {
      const s = computeStopStats(sideTrades, `depth_${thr}`);
      rows.push([`depth <${(thr * 100).toFixed(0)}%`, `${s.losersHit}/${s.totalLosers}`, `${s.winnersHit}/${s.totalWinners}`, fmt$(s.saved), fmt$(s.lost), fmt$(s.net)]);
    }
    for (const cents of [0.03, 0.05]) {
      const s = computeStopStats(sideTrades, `mid_${cents}`);
      rows.push([`mid >${(cents * 100).toFixed(0)}¢`, `${s.losersHit}/${s.totalLosers}`, `${s.winnersHit}/${s.totalWinners}`, fmt$(s.saved), fmt$(s.lost), fmt$(s.net)]);
    }

    printTable(
      ['Stop Type', 'Losers Hit', 'Winners Hit', 'Saved', 'Lost', 'NET'],
      rows,
      ['L', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7: INDIVIDUAL LOSING TRADES — DEPTH DETAIL
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 7: INDIVIDUAL LOSING TRADES — L2 DEPTH DETAIL');
  console.log('='.repeat(110));
  console.log();

  const sortedLosers = [...losers].sort((a, b) => a.netPnl - b.netPnl);
  const showCount = Math.min(sortedLosers.length, 25);

  console.log(`Showing ${showCount} worst losers:\n`);

  for (const trade of sortedLosers.slice(0, showCount)) {
    const conv = trade.clobConviction != null ? trade.clobConviction.toFixed(3) : '?';
    const delta = trade.vwapDeltaPct != null ? trade.vwapDeltaPct.toFixed(3) + '%' : '?';

    console.log(`  #${trade.id} | ${trade.symbol.toUpperCase()} ${trade.signalType} ${trade.variantLabel} | T-${trade.signalOffsetSec}s | ${trade.entrySide.toUpperCase()}`);
    console.log(`    Entry $${trade.entryPrice?.toFixed(3)} | PnL: ${fmt$(trade.netPnl)} | conviction: ${conv} | delta: ${delta}`);
    console.log(`    L2: ${trade.tickCount} ticks | your-depth $${trade.entryYourDepth?.toFixed(0)} -> min ratio ${trade.minDepthRatio?.toFixed(3)} at T+${trade.minDepthSec?.toFixed(1)}s`);
    console.log(`    Mid move against: max ${(trade.maxMidMoveAgainst * 100).toFixed(2)}¢ at T+${trade.maxMidMoveAgainstSec?.toFixed(1)}s | spread widen: ${(trade.maxSpreadWiden * 100).toFixed(2)}¢`);

    const caught = [];
    for (const thr of [0.30, 0.50, 0.70]) {
      const key = `depth_${thr}`;
      if (trade.stopResults[key]?.triggered) {
        caught.push(`depth<${(thr * 100).toFixed(0)}% @ T+${trade.stopResults[key].triggerSec.toFixed(1)}s -> exit PnL ${fmt$(trade.stopResults[key].exitPnl)}`);
      }
    }
    for (const cents of [0.03, 0.05]) {
      const key = `mid_${cents}`;
      if (trade.stopResults[key]?.triggered) {
        caught.push(`mid>${(cents * 100).toFixed(0)}¢ @ T+${trade.stopResults[key].triggerSec.toFixed(1)}s -> exit PnL ${fmt$(trade.stopResults[key].exitPnl)}`);
      }
    }

    if (caught.length > 0) {
      for (const c of caught) console.log(`    + ${c}`);
    } else {
      console.log(`    x No stop-loss would have triggered (depth stayed stable)`);
    }
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8: CONVICTION-FILTERED VWAP — SPECIAL FOCUS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 8: CONVICTION-FILTERED VWAP STRATEGIES — STOP-LOSS FOCUS');
  console.log('='.repeat(110));
  console.log();
  console.log('  These are the performing strategies from the loss analysis.');
  console.log('  Showing the impact of adding L2 stop-losses to each variant.');
  console.log();

  const convFilteredVariants = ['f-d3-c20', 'f-d8-c20', 'f-d8-c25'];
  const vwapStrategies = ['vwap_edge', 'vwap_cg_edge', 'vwap20_edge', 'down_only', 'down_cg', 'down_v20'];

  const convTrades = allResults.filter(r =>
    vwapStrategies.includes(r.signalType) && convFilteredVariants.includes(r.variantLabel)
  );

  if (convTrades.length > 0) {
    const cw = convTrades.filter(r => r.won);
    const cl = convTrades.filter(r => !r.won);
    const cPnl = convTrades.reduce((s, r) => s + r.netPnl, 0);

    console.log(`  Conviction-filtered trades: ${convTrades.length} (${cw.length}W/${cl.length}L = ${pct(cw.length, convTrades.length)}, PnL: ${fmt$(cPnl)})`);
    console.log();

    // By variant
    const variantMap = new Map();
    for (const r of convTrades) {
      const key = `${r.signalType}:${r.variantLabel}`;
      if (!variantMap.has(key)) variantMap.set(key, []);
      variantMap.get(key).push(r);
    }

    const summaryRows = [];
    for (const [variant, trades] of [...variantMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (trades.length < 2) continue;
      const w = trades.filter(r => r.won);
      const l = trades.filter(r => !r.won);
      const pnl = trades.reduce((s, r) => s + r.netPnl, 0);

      // Find best stop for this variant
      let bestKey = null, bestNet = -Infinity;
      for (const thr of DEPTH_THRESHOLDS) {
        const s = computeStopStats(trades, `depth_${thr}`);
        if (s.net > bestNet) { bestNet = s.net; bestKey = `depth <${(thr * 100).toFixed(0)}%`; }
      }
      for (const cents of MID_THRESHOLDS) {
        const s = computeStopStats(trades, `mid_${cents}`);
        if (s.net > bestNet) { bestNet = s.net; bestKey = `mid >${(cents * 100).toFixed(0)}¢`; }
      }

      summaryRows.push([
        variant,
        trades.length,
        pct(w.length, trades.length),
        fmt$(pnl),
        bestKey || 'none',
        fmt$(bestNet),
        fmt$(pnl + bestNet),
      ]);
    }

    printTable(
      ['Variant', 'N', 'Win%', 'PnL', 'Best Stop', 'Stop NET', 'Adj PnL'],
      summaryRows,
      ['L', 'R', 'R', 'R', 'L', 'R', 'R']
    );
    console.log();

    // Delta-size interaction with stop-loss
    console.log('  Delta magnitude interaction with depth stop at 50%:');
    console.log();

    const deltaBuckets = [
      { label: '<0.12%', min: 0, max: 0.12 },
      { label: '0.12-0.20%', min: 0.12, max: 0.20 },
      { label: '>0.20%', min: 0.20, max: 100 },
    ];

    const deltaRows = deltaBuckets.map(b => {
      const bucket = convTrades.filter(r => {
        const d = Math.abs(r.vwapDeltaPct || 0);
        return d >= b.min && d < b.max;
      });
      if (bucket.length === 0) return [b.label, 0, '-', '-', '-', '-', '-'];
      const bw = bucket.filter(r => r.won);
      const bl = bucket.filter(r => !r.won);
      const s = computeStopStats(bucket, 'depth_0.5');
      const origPnl = bucket.reduce((sum, r) => sum + r.netPnl, 0);
      return [
        b.label,
        bucket.length,
        pct(bw.length, bucket.length),
        fmt$(origPnl),
        `${s.losersHit}/${s.totalLosers}`,
        `${s.winnersHit}/${s.totalWinners}`,
        fmt$(s.net),
      ];
    });

    printTable(
      ['Delta', 'N', 'Win%', 'PnL', 'L Hit', 'W Hit', 'Stop NET'],
      deltaRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();

    // Side interaction
    console.log('  Entry side interaction with depth stop at 50%:');
    console.log();

    const sideRows = ['up', 'down'].map(side => {
      const bucket = convTrades.filter(r => r.entrySide === side);
      if (bucket.length === 0) return [side.toUpperCase(), 0, '-', '-', '-', '-', '-'];
      const bw = bucket.filter(r => r.won);
      const s = computeStopStats(bucket, 'depth_0.5');
      const origPnl = bucket.reduce((sum, r) => sum + r.netPnl, 0);
      return [
        side.toUpperCase(),
        bucket.length,
        pct(bw.length, bucket.length),
        fmt$(origPnl),
        `${s.losersHit}/${s.totalLosers}`,
        `${s.winnersHit}/${s.totalWinners}`,
        fmt$(s.net),
      ];
    });

    printTable(
      ['Side', 'N', 'Win%', 'PnL', 'L Hit', 'W Hit', 'Stop NET'],
      sideRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  } else {
    console.log('  No conviction-filtered VWAP trades found in L2 period.');
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9: OPTIMAL STOP-LOSS RECOMMENDATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 9: OPTIMAL STOP-LOSS & SYNOPSIS');
  console.log('='.repeat(110));
  console.log();

  // Find best stop-loss overall
  let bestStop = null;
  let bestNet = -Infinity;

  for (const thr of DEPTH_THRESHOLDS) {
    const s = computeStopStats(allResults, `depth_${thr}`);
    if (s.net > bestNet) {
      bestNet = s.net;
      bestStop = { type: 'depth', value: thr, label: `depth <${(thr * 100).toFixed(0)}% remaining`, ...s };
    }
  }
  for (const cents of MID_THRESHOLDS) {
    const s = computeStopStats(allResults, `mid_${cents}`);
    if (s.net > bestNet) {
      bestNet = s.net;
      bestStop = { type: 'mid', value: cents, label: `mid >${(cents * 100).toFixed(0)}¢ against`, ...s };
    }
  }

  if (bestStop) {
    console.log(`  BEST OVERALL STOP-LOSS: ${bestStop.label}`);
    console.log();
    console.log(`    Losers caught:      ${bestStop.losersHit}/${bestStop.totalLosers} (${pct(bestStop.losersHit, bestStop.totalLosers)})`);
    console.log(`    Winners killed:     ${bestStop.winnersHit}/${bestStop.totalWinners} (${pct(bestStop.winnersHit, bestStop.totalWinners)})`);
    console.log(`    $ saved on losers:  ${fmt$(bestStop.saved)}`);
    console.log(`    $ lost on winners:  ${fmt$(bestStop.lost)}`);
    console.log(`    NET BENEFIT:        ${fmt$(bestStop.net)}`);
    console.log();

    const adjustedPnl = origTotalPnl + bestStop.net;
    const pctImprovement = origTotalPnl !== 0 ? ((bestStop.net / Math.abs(origTotalPnl)) * 100) : 0;

    console.log(`    Original total PnL: ${fmt$(origTotalPnl)}`);
    console.log(`    Adjusted total PnL: ${fmt$(adjustedPnl)}`);
    console.log(`    Improvement:        ${fmt$(bestStop.net)} (${pctImprovement.toFixed(1)}%)`);
    console.log();

    // Effective win rate with stop-loss
    // Stopped trades become small losses instead of big losses/wins
    const remainingWins = bestStop.totalWinners - bestStop.winnersHit;
    const remainingLosses = bestStop.totalLosers - bestStop.losersHit;
    const stoppedTotal = bestStop.winnersHit + bestStop.losersHit;
    console.log(`    Without stop: ${bestStop.totalWinners}W / ${bestStop.totalLosers}L = ${pct(bestStop.totalWinners, allResults.length)}`);
    console.log(`    With stop:    ${remainingWins}W / ${remainingLosses}L / ${stoppedTotal} stopped = ${pct(remainingWins, remainingWins + remainingLosses)} effective win rate`);
  }

  console.log();
  console.log('─'.repeat(110));
  console.log();
  console.log('  SYNOPSIS');
  console.log();
  console.log('  This diagnostic measures two candidate stop-loss mechanisms:');
  console.log('  1. DEPTH-BASED: Exit when your-side L2 depth drops below X% of entry depth');
  console.log('     (detects MMs pulling liquidity from your side)');
  console.log('  2. MID-PRICE: Exit when CLOB mid-price moves X cents against your entry');
  console.log('     (detects adverse repricing)');
  console.log();
  console.log('  Key question: Does the $ saved on catching losers early exceed');
  console.log('  the $ lost from accidentally exiting winners?');
  console.log();
  console.log('  Look for stop-loss thresholds where:');
  console.log('    - High loser catch rate (>50%)');
  console.log('    - Low winner kill rate (<20%)');
  console.log('    - Positive NET benefit');
  console.log('    - Trigger time gives enough reaction window (>5s)');
  console.log();
  console.log('='.repeat(110));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
