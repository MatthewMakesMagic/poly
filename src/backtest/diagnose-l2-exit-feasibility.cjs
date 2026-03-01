/**
 * L2 Exit Feasibility Diagnostic
 *
 * For each resolved trade, tick-by-tick:
 *   - Can I sell my shares right now? What fill price would I get?
 *   - What's my PnL if I exit here vs holding to resolution?
 *   - When a trade is going wrong, how early can I see it, and what does exiting cost?
 *
 * This answers the practical question: "With a stop-loss, can I actually get out?"
 *
 * Usage: export $(grep DATABASE_URL .env.local | xargs) && node src/backtest/diagnose-l2-exit-feasibility.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Simulate selling shares into the bid side of the book ───

/**
 * Walk the bid side and compute fill price for selling `shares` shares.
 * Returns { fillPrice, filled, unfilled, levelsConsumed }
 *
 * @param {Array} bids - [[price, size], ...] sorted descending by price
 * @param {number} shares - Number of shares to sell
 */
function simulateSell(bids, shares) {
  if (!bids || bids.length === 0 || shares <= 0) {
    return { fillPrice: 0, filled: 0, unfilled: shares, levelsConsumed: 0, totalProceeds: 0 };
  }

  let remaining = shares;
  let totalProceeds = 0;
  let levelsConsumed = 0;

  for (const [price, size] of bids) {
    if (remaining <= 0) break;
    const fillQty = Math.min(remaining, size);
    totalProceeds += fillQty * price;
    remaining -= fillQty;
    levelsConsumed++;
  }

  const filled = shares - remaining;
  const fillPrice = filled > 0 ? totalProceeds / filled : 0;

  return { fillPrice, filled, unfilled: remaining, levelsConsumed, totalProceeds };
}

/**
 * For DOWN token entries: the L2 data tracks the UP token book.
 * To sell DOWN tokens, someone needs to BUY DOWN tokens.
 * Buying DOWN = selling UP, so DOWN bids ≈ inverse of UP asks.
 * DOWN token bid at price P means UP ask at price (1-P).
 *
 * So to exit a DOWN position: walk the UP token ASK side,
 * and the DOWN exit price at each level = 1 - UP_ask_price.
 */
function simulateSellDown(asks, shares) {
  if (!asks || asks.length === 0 || shares <= 0) {
    return { fillPrice: 0, filled: 0, unfilled: shares, levelsConsumed: 0, totalProceeds: 0 };
  }

  // Convert UP asks to DOWN bids: DOWN bid price = 1 - UP ask price
  // Walk from lowest UP ask (= highest DOWN bid) upward
  let remaining = shares;
  let totalProceeds = 0;
  let levelsConsumed = 0;

  for (const [upAskPrice, size] of asks) {
    if (remaining <= 0) break;
    const downBidPrice = 1.0 - upAskPrice;
    if (downBidPrice <= 0) continue;
    const fillQty = Math.min(remaining, size);
    totalProceeds += fillQty * downBidPrice;
    remaining -= fillQty;
    levelsConsumed++;
  }

  const filled = shares - remaining;
  const fillPrice = filled > 0 ? totalProceeds / filled : 0;

  return { fillPrice, filled, unfilled: remaining, levelsConsumed, totalProceeds };
}

// ─── Helpers ───

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A'; }
function fmt$(v) {
  if (v == null || isNaN(v)) return '$0';
  return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
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
  for (const row of rows) {
    console.log(row.map((v, i) => ` ${pad(v, i)} `).join('|'));
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Main ───

async function main() {
  console.log('='.repeat(110));
  console.log('  L2 EXIT FEASIBILITY DIAGNOSTIC');
  console.log('  "When a trade goes wrong, can I actually get out? At what price?"');
  console.log('='.repeat(110));
  console.log();

  // ── Get conviction-filtered VWAP trades with L2 overlap ──
  // Focus on the strategies that were performing in the loss analysis
  const tradesResult = await pool.query(`
    SELECT
      t.id, t.window_id, t.symbol, t.signal_time, t.signal_type,
      t.variant_label, t.signal_offset_sec,
      t.entry_side, t.entry_token_id,
      t.sim_entry_price::float, t.sim_cost::float, t.sim_fee::float,
      t.sim_shares::float, t.position_size_dollars::float,
      t.won, t.net_pnl::float, t.gross_pnl::float,
      t.resolved_direction,
      t.strategy_metadata
    FROM paper_trades_v2 t
    WHERE t.resolved_direction IS NOT NULL
      AND t.signal_time >= (SELECT MIN(timestamp) FROM l2_book_ticks)
    ORDER BY t.signal_time
  `);

  if (tradesResult.rows.length === 0) {
    console.log('No trades found. Exiting.');
    await pool.end();
    return;
  }

  // ── Group by window ──
  const windowMap = new Map();
  for (const trade of tradesResult.rows) {
    if (!windowMap.has(trade.window_id)) windowMap.set(trade.window_id, []);
    windowMap.get(trade.window_id).push(trade);
  }

  console.log(`Total resolved trades in L2 period: ${tradesResult.rows.length}`);
  console.log(`Unique windows: ${windowMap.size}`);
  console.log();

  // Check time points: at 5s, 10s, 15s, 20s, 30s, 45s, 60s after entry
  const CHECK_TIMES = [5, 10, 15, 20, 30, 45, 60, 90];
  // Fee rate for exit (same as entry)
  const FEE_RATE = 0.02;

  const allResults = [];
  let processed = 0;
  let skippedNoL2 = 0;
  let skippedNoTopLevels = 0;

  for (const [windowId, trades] of windowMap) {
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  Window ${processed}/${windowMap.size}\r`);

    // Fetch L2 ticks WITH top_levels for this window
    const l2Result = await pool.query(`
      SELECT timestamp, mid_price::float, spread::float,
             best_bid::float, best_ask::float,
             top_levels
      FROM l2_book_ticks
      WHERE window_id = $1
      ORDER BY timestamp ASC
    `, [windowId]);

    if (l2Result.rows.length < 10) { skippedNoL2++; continue; }

    // Check if top_levels has data
    const hasTopLevels = l2Result.rows.some(r => r.top_levels && r.top_levels.bids && r.top_levels.bids.length > 0);
    if (!hasTopLevels) { skippedNoTopLevels++; continue; }

    const l2Ticks = l2Result.rows;

    for (const trade of trades) {
      const signalMs = new Date(trade.signal_time).getTime();
      const windowCloseMs = signalMs + (trade.signal_offset_sec * 1000);
      const isUp = trade.entry_side === 'up';

      // Get ticks from signal time to window close
      const relevant = l2Ticks.filter(t => {
        const tMs = new Date(t.timestamp).getTime();
        return tMs >= signalMs && tMs <= windowCloseMs + 2000;
      });

      if (relevant.length < 5) continue;

      // For each check time, find the nearest tick and simulate exit
      const exitSnapshots = [];

      for (const checkSec of CHECK_TIMES) {
        if (checkSec > trade.signal_offset_sec) continue; // Can't check T+90 on a T-60 trade

        const targetMs = signalMs + (checkSec * 1000);

        // Find nearest tick to this time
        let bestTick = null;
        let bestDist = Infinity;
        for (const tick of relevant) {
          const dist = Math.abs(new Date(tick.timestamp).getTime() - targetMs);
          if (dist < bestDist) { bestDist = dist; bestTick = tick; }
        }

        if (!bestTick || bestDist > 3000) continue; // Must be within 3s of target
        if (!bestTick.top_levels) continue;

        const bids = bestTick.top_levels.bids || [];
        const asks = bestTick.top_levels.asks || [];

        // Simulate selling our shares
        let exit;
        if (isUp) {
          exit = simulateSell(bids, trade.sim_shares);
        } else {
          exit = simulateSellDown(asks, trade.sim_shares);
        }

        // Calculate exit PnL
        const exitProceeds = exit.totalProceeds;
        const exitFee = exitProceeds * FEE_RATE;
        const exitPnl = exitProceeds - trade.sim_cost - trade.sim_fee - exitFee;

        // How much did we save/lose vs holding to resolution?
        const holdPnl = trade.net_pnl;
        const pnlDiff = exitPnl - holdPnl; // positive = exit was better

        // Can we even fill?
        const fillPct = trade.sim_shares > 0 ? (exit.filled / trade.sim_shares) * 100 : 0;

        // What's the mid doing at this point?
        const midMove = bestTick.mid_price - (relevant[0]?.mid_price || bestTick.mid_price);
        const moveAgainst = isUp ? -midMove : midMove;

        // Total depth available on exit side
        let totalExitDepth = 0;
        if (isUp) {
          for (const [p, s] of bids) totalExitDepth += p * s;
        } else {
          for (const [p, s] of asks) totalExitDepth += (1 - p) * s;
        }

        exitSnapshots.push({
          checkSec,
          exitFillPrice: exit.fillPrice,
          filled: exit.filled,
          unfilled: exit.unfilled,
          fillPct,
          levelsConsumed: exit.levelsConsumed,
          exitProceeds,
          exitPnl,
          holdPnl,
          pnlDiff,
          midPrice: bestTick.mid_price,
          moveAgainst,
          totalExitDepth,
          bidCount: bids.length,
          askCount: asks.length,
        });
      }

      if (exitSnapshots.length === 0) continue;

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
        holdPnl: trade.net_pnl,
        resolvedDirection: trade.resolved_direction,
        vwapDeltaPct: trade.strategy_metadata?.vwapDeltaPct,
        clobConviction: trade.strategy_metadata?.clobConviction,
        exitSnapshots,
      });
    }
  }

  process.stdout.write(''.padEnd(60) + '\r');
  console.log(`Trades analyzed: ${allResults.length}`);
  console.log(`Skipped (no L2): ${skippedNoL2} | Skipped (no top_levels): ${skippedNoTopLevels}`);
  console.log();

  if (allResults.length === 0) {
    console.log('No trades with top_levels data. Exiting.');
    await pool.end();
    return;
  }

  const winners = allResults.filter(r => r.won);
  const losers = allResults.filter(r => !r.won);

  console.log(`Winners: ${winners.length} | Losers: ${losers.length} | Win rate: ${pct(winners.length, allResults.length)}`);
  console.log(`Hold PnL: ${fmt$(allResults.reduce((s, r) => s + r.holdPnl, 0))}`);
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1: CAN WE ACTUALLY EXIT? FILL RATES AT EACH TIME
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 1: CAN WE ACTUALLY EXIT? (fill rates & depth at each check time)');
  console.log('='.repeat(110));
  console.log();
  console.log('  For each time after entry, if we tried to sell all our shares:');
  console.log('  - Fill%: what fraction of shares could we actually sell?');
  console.log('  - Exit depth: total $ available on our exit side of the book');
  console.log('  - Levels: how many price levels we need to walk through');
  console.log();

  for (const checkSec of CHECK_TIMES) {
    const snaps = allResults
      .map(r => r.exitSnapshots.find(s => s.checkSec === checkSec))
      .filter(Boolean);

    if (snaps.length === 0) continue;

    const fullFills = snaps.filter(s => s.fillPct >= 99.9);
    const partialFills = snaps.filter(s => s.fillPct > 0 && s.fillPct < 99.9);
    const noFills = snaps.filter(s => s.fillPct === 0);

    console.log(`  T+${checkSec}s (${snaps.length} trades):`);
    console.log(`    Full fill:    ${fullFills.length} (${pct(fullFills.length, snaps.length)})`);
    console.log(`    Partial fill: ${partialFills.length} (${pct(partialFills.length, snaps.length)})`);
    console.log(`    No fill:      ${noFills.length} (${pct(noFills.length, snaps.length)})`);
    console.log(`    Median exit depth:   $${median(snaps.map(s => s.totalExitDepth)).toFixed(0)}`);
    console.log(`    Median fill price:   $${median(snaps.filter(s => s.fillPct > 0).map(s => s.exitFillPrice)).toFixed(4)}`);
    console.log(`    Median levels used:  ${median(snaps.filter(s => s.fillPct > 0).map(s => s.levelsConsumed)).toFixed(0)}`);
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: WHAT WOULD WE GET? EXIT PNL AT EACH TIME
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 2: EXIT PNL AT EACH TIME — WINNERS VS LOSERS');
  console.log('='.repeat(110));
  console.log();
  console.log('  If we exited at time T, what PnL would we get vs holding to resolution?');
  console.log('  "Exit PnL" = proceeds from selling shares - entry cost - entry fee - exit fee');
  console.log('  "vs Hold" = exit PnL minus hold PnL (positive = exiting was better)');
  console.log();

  const pnlRows = [];
  for (const checkSec of CHECK_TIMES) {
    const wSnaps = winners.map(r => r.exitSnapshots.find(s => s.checkSec === checkSec)).filter(Boolean);
    const lSnaps = losers.map(r => r.exitSnapshots.find(s => s.checkSec === checkSec)).filter(Boolean);

    if (wSnaps.length === 0 && lSnaps.length === 0) continue;

    // For losers: exiting early should save money (positive pnlDiff)
    // For winners: exiting early costs money (negative pnlDiff)
    const wExitPnl = wSnaps.length > 0 ? median(wSnaps.map(s => s.exitPnl)) : null;
    const lExitPnl = lSnaps.length > 0 ? median(lSnaps.map(s => s.exitPnl)) : null;
    const wVsHold = wSnaps.length > 0 ? median(wSnaps.map(s => s.pnlDiff)) : null;
    const lVsHold = lSnaps.length > 0 ? median(lSnaps.map(s => s.pnlDiff)) : null;

    // Total PnL if we had exited ALL trades at this time
    const totalExitPnl = [...wSnaps, ...lSnaps].reduce((s, snap) => {
      return s + (snap.fillPct >= 99.9 ? snap.exitPnl : snap.exitPnl); // use whatever we got
    }, 0);
    // Add back trades that don't have this snapshot (they hold to resolution)
    const tradesWithoutSnap = allResults.filter(r => !r.exitSnapshots.find(s => s.checkSec === checkSec));
    const holdPnlForRest = tradesWithoutSnap.reduce((s, r) => s + r.holdPnl, 0);

    pnlRows.push([
      `T+${checkSec}s`,
      wSnaps.length,
      lSnaps.length,
      wExitPnl != null ? fmt$(wExitPnl) : '-',
      lExitPnl != null ? fmt$(lExitPnl) : '-',
      wVsHold != null ? fmt$(wVsHold) : '-',
      lVsHold != null ? fmt$(lVsHold) : '-',
    ]);
  }

  printTable(
    ['Time', 'N(W)', 'N(L)', 'W Exit PnL', 'L Exit PnL', 'W vs Hold', 'L vs Hold'],
    pnlRows,
    ['L', 'R', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();
  console.log('  W vs Hold: negative = exiting cost us profit (bad)');
  console.log('  L vs Hold: positive = exiting saved us from bigger loss (good)');
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3: THE STOP-LOSS QUESTION — AT EACH TIME, SHOULD WE EXIT?
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 3: STOP-LOSS SIMULATION — "EXIT IF MID MOVED AGAINST ME"');
  console.log('='.repeat(110));
  console.log();
  console.log('  Rule: At time T, if mid-price has moved X cents against my entry side, sell.');
  console.log('  Otherwise hold to resolution.');
  console.log('  Uses actual L2 book depth to compute real exit fill price.');
  console.log();

  const STOP_THRESHOLDS = [0.01, 0.02, 0.03, 0.05, 0.08];

  for (const checkSec of CHECK_TIMES) {
    const tradesWithSnap = allResults.filter(r => r.exitSnapshots.find(s => s.checkSec === checkSec));
    if (tradesWithSnap.length < 10) continue;

    console.log(`─── Check at T+${checkSec}s (${tradesWithSnap.length} trades) ───`);
    console.log();

    const stopRows = [];

    for (const threshold of STOP_THRESHOLDS) {
      // For each trade: if mid moved > threshold against, exit at this tick's fill price
      // Otherwise hold to resolution
      let totalPnl = 0;
      let exitCount = 0;
      let holdCount = 0;
      let winnersExited = 0;
      let losersExited = 0;
      let winnersSaved = 0; // Winners correctly held
      let losersCaught = 0; // Losers correctly exited
      let winnersKilled = 0; // Winners incorrectly exited
      let losersEscaped = 0; // Losers NOT caught (held to full loss)
      let pnlSavedOnLosers = 0;
      let pnlLostOnWinners = 0;

      for (const trade of tradesWithSnap) {
        const snap = trade.exitSnapshots.find(s => s.checkSec === checkSec);
        if (!snap) { totalPnl += trade.holdPnl; holdCount++; continue; }

        const shouldExit = snap.moveAgainst >= threshold;

        if (shouldExit && snap.fillPct > 0) {
          // EXIT
          totalPnl += snap.exitPnl;
          exitCount++;
          if (trade.won) {
            winnersExited++;
            winnersKilled++;
            pnlLostOnWinners += (snap.exitPnl - trade.holdPnl); // negative
          } else {
            losersExited++;
            losersCaught++;
            pnlSavedOnLosers += (snap.exitPnl - trade.holdPnl); // positive
          }
        } else {
          // HOLD
          totalPnl += trade.holdPnl;
          holdCount++;
          if (trade.won) winnersSaved++;
          else losersEscaped++;
        }
      }

      // Add trades without this snapshot (always hold)
      const tradesWithout = allResults.filter(r => !r.exitSnapshots.find(s => s.checkSec === checkSec));
      for (const t of tradesWithout) {
        totalPnl += t.holdPnl;
        holdCount++;
        if (t.won) winnersSaved++;
        else losersEscaped++;
      }

      const holdPnl = allResults.reduce((s, r) => s + r.holdPnl, 0);
      const improvement = totalPnl - holdPnl;

      stopRows.push([
        `>${(threshold * 100).toFixed(0)}¢`,
        exitCount,
        `${losersCaught}`,
        `${winnersKilled}`,
        fmt$(pnlSavedOnLosers),
        fmt$(pnlLostOnWinners),
        fmt$(improvement),
        fmt$(totalPnl),
      ]);
    }

    // Also show "exit everyone" and "hold everyone" baselines
    const holdAllPnl = allResults.reduce((s, r) => s + r.holdPnl, 0);

    // Exit everyone at this time
    let exitAllPnl = 0;
    for (const trade of tradesWithSnap) {
      const snap = trade.exitSnapshots.find(s => s.checkSec === checkSec);
      exitAllPnl += snap ? snap.exitPnl : trade.holdPnl;
    }
    for (const t of allResults.filter(r => !r.exitSnapshots.find(s => s.checkSec === checkSec))) {
      exitAllPnl += t.holdPnl;
    }

    stopRows.push([
      'EXIT ALL',
      tradesWithSnap.length,
      losers.filter(r => r.exitSnapshots.find(s => s.checkSec === checkSec)).length + '',
      winners.filter(r => r.exitSnapshots.find(s => s.checkSec === checkSec)).length + '',
      '-', '-',
      fmt$(exitAllPnl - holdAllPnl),
      fmt$(exitAllPnl),
    ]);
    stopRows.push([
      'HOLD ALL',
      0, '0', '0', '-', '-', '$0', fmt$(holdAllPnl),
    ]);

    printTable(
      ['Trigger', 'Exits', 'L Caught', 'W Killed', 'L Saved', 'W Lost', 'vs Hold', 'Total PnL'],
      stopRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4: OPTIMAL STOP — WHICH TIME + THRESHOLD COMBO IS BEST?
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 4: OPTIMAL STOP-LOSS (best time + threshold combination)');
  console.log('='.repeat(110));
  console.log();

  let bestCombo = null;
  let bestTotalPnl = -Infinity;
  const holdAllPnl = allResults.reduce((s, r) => s + r.holdPnl, 0);

  const comboRows = [];

  for (const checkSec of CHECK_TIMES) {
    for (const threshold of STOP_THRESHOLDS) {
      let totalPnl = 0;
      let exits = 0;
      let losersCaught = 0;
      let winnersKilled = 0;

      for (const trade of allResults) {
        const snap = trade.exitSnapshots.find(s => s.checkSec === checkSec);
        if (snap && snap.moveAgainst >= threshold && snap.fillPct > 0) {
          totalPnl += snap.exitPnl;
          exits++;
          if (trade.won) winnersKilled++;
          else losersCaught++;
        } else {
          totalPnl += trade.holdPnl;
        }
      }

      const improvement = totalPnl - holdAllPnl;

      comboRows.push({
        checkSec,
        threshold,
        totalPnl,
        improvement,
        exits,
        losersCaught,
        winnersKilled,
      });

      if (totalPnl > bestTotalPnl) {
        bestTotalPnl = totalPnl;
        bestCombo = { checkSec, threshold, totalPnl, improvement, exits, losersCaught, winnersKilled };
      }
    }
  }

  // Show top 10 combos
  comboRows.sort((a, b) => b.totalPnl - a.totalPnl);
  const topRows = comboRows.slice(0, 15).map(c => [
    `T+${c.checkSec}s`,
    `>${(c.threshold * 100).toFixed(0)}¢`,
    c.exits,
    c.losersCaught,
    c.winnersKilled,
    fmt$(c.improvement),
    fmt$(c.totalPnl),
  ]);

  printTable(
    ['Time', 'Trigger', 'Exits', 'L Caught', 'W Killed', 'vs Hold', 'Total PnL'],
    topRows,
    ['L', 'L', 'R', 'R', 'R', 'R', 'R']
  );
  console.log();

  if (bestCombo) {
    console.log(`  BEST: Check at T+${bestCombo.checkSec}s, exit if mid moved >${(bestCombo.threshold * 100).toFixed(0)}¢ against`);
    console.log(`    Exits: ${bestCombo.exits} | Losers caught: ${bestCombo.losersCaught} | Winners killed: ${bestCombo.winnersKilled}`);
    console.log(`    Hold-all PnL: ${fmt$(holdAllPnl)} -> Stop PnL: ${fmt$(bestCombo.totalPnl)} = ${fmt$(bestCombo.improvement)} improvement`);
  }
  console.log();


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5: BY STRATEGY — WHICH STRATEGIES BENEFIT MOST?
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 5: STOP-LOSS IMPACT BY STRATEGY');
  console.log('='.repeat(110));
  console.log();

  if (bestCombo) {
    const { checkSec, threshold } = bestCombo;
    console.log(`  Using best stop: T+${checkSec}s, >${(threshold * 100).toFixed(0)}¢ against`);
    console.log();

    const stratGroups = new Map();
    for (const r of allResults) {
      if (!stratGroups.has(r.signalType)) stratGroups.set(r.signalType, []);
      stratGroups.get(r.signalType).push(r);
    }

    const stratRows = [];
    for (const [strat, trades] of [...stratGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (trades.length < 5) continue;
      const w = trades.filter(r => r.won);
      const l = trades.filter(r => !r.won);

      let stopPnl = 0;
      let lCaught = 0, wKilled = 0;
      for (const trade of trades) {
        const snap = trade.exitSnapshots.find(s => s.checkSec === checkSec);
        if (snap && snap.moveAgainst >= threshold && snap.fillPct > 0) {
          stopPnl += snap.exitPnl;
          if (trade.won) wKilled++; else lCaught++;
        } else {
          stopPnl += trade.holdPnl;
        }
      }
      const holdPnl = trades.reduce((s, r) => s + r.holdPnl, 0);

      stratRows.push([
        strat,
        trades.length,
        pct(w.length, trades.length),
        fmt$(holdPnl),
        `${lCaught}/${l.length}`,
        `${wKilled}/${w.length}`,
        fmt$(stopPnl),
        fmt$(stopPnl - holdPnl),
      ]);
    }

    printTable(
      ['Strategy', 'N', 'Win%', 'Hold PnL', 'L Caught', 'W Killed', 'Stop PnL', 'Improve'],
      stratRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6: INDIVIDUAL EXAMPLES — LOSERS THAT WOULD BE SAVED
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SECTION 6: EXAMPLE TRADES — TICK-BY-TICK EXIT FEASIBILITY');
  console.log('='.repeat(110));
  console.log();

  // Show some losing trades with their exit snapshots
  const exampleLosers = losers
    .filter(r => r.exitSnapshots.length >= 3)
    .sort((a, b) => a.holdPnl - b.holdPnl)
    .slice(0, 10);

  console.log(`  Showing ${exampleLosers.length} worst losers with full exit timeline:`);
  console.log();

  for (const trade of exampleLosers) {
    console.log(`  #${trade.id} | ${trade.symbol.toUpperCase()} ${trade.signalType} ${trade.variantLabel} | T-${trade.signalOffsetSec}s | ${trade.entrySide.toUpperCase()}`);
    console.log(`    Bought ${trade.shares?.toFixed(0)} shares @ $${trade.entryPrice?.toFixed(3)} = $${trade.cost?.toFixed(0)} cost`);
    console.log(`    HOLD PnL: ${fmt$(trade.holdPnl)} (resolved ${trade.resolvedDirection?.toUpperCase()})`);
    console.log();

    const snapRows = trade.exitSnapshots.map(s => [
      `T+${s.checkSec}s`,
      `$${s.midPrice?.toFixed(3)}`,
      `${(s.moveAgainst * 100).toFixed(1)}¢`,
      `$${s.totalExitDepth?.toFixed(0)}`,
      `${s.fillPct?.toFixed(0)}%`,
      s.fillPct > 0 ? `$${s.exitFillPrice?.toFixed(3)}` : 'NO BID',
      `${s.levelsConsumed}`,
      fmt$(s.exitPnl),
      fmt$(s.pnlDiff),
    ]);

    printTable(
      ['Time', 'Mid', 'Against', 'Depth', 'Fill%', 'Fill Price', 'Levels', 'Exit PnL', 'vs Hold'],
      snapRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }

  // Show some winning trades
  const exampleWinners = winners
    .filter(r => r.exitSnapshots.length >= 3)
    .sort((a, b) => b.holdPnl - a.holdPnl)
    .slice(0, 5);

  console.log(`  Showing ${exampleWinners.length} best winners (to see what we'd lose with stop-loss):`);
  console.log();

  for (const trade of exampleWinners) {
    console.log(`  #${trade.id} | ${trade.symbol.toUpperCase()} ${trade.signalType} ${trade.variantLabel} | T-${trade.signalOffsetSec}s | ${trade.entrySide.toUpperCase()}`);
    console.log(`    Bought ${trade.shares?.toFixed(0)} shares @ $${trade.entryPrice?.toFixed(3)} = $${trade.cost?.toFixed(0)} cost`);
    console.log(`    HOLD PnL: ${fmt$(trade.holdPnl)} (resolved ${trade.resolvedDirection?.toUpperCase()})`);
    console.log();

    const snapRows = trade.exitSnapshots.map(s => [
      `T+${s.checkSec}s`,
      `$${s.midPrice?.toFixed(3)}`,
      `${(s.moveAgainst * 100).toFixed(1)}¢`,
      `$${s.totalExitDepth?.toFixed(0)}`,
      `${s.fillPct?.toFixed(0)}%`,
      s.fillPct > 0 ? `$${s.exitFillPrice?.toFixed(3)}` : 'NO BID',
      `${s.levelsConsumed}`,
      fmt$(s.exitPnl),
      fmt$(s.pnlDiff),
    ]);

    printTable(
      ['Time', 'Mid', 'Against', 'Depth', 'Fill%', 'Fill Price', 'Levels', 'Exit PnL', 'vs Hold'],
      snapRows,
      ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'R', 'R']
    );
    console.log();
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7: SYNOPSIS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(110));
  console.log('  SYNOPSIS');
  console.log('='.repeat(110));
  console.log();
  console.log('  This diagnostic answers three questions:');
  console.log();
  console.log('  1. CAN WE EXIT? When we need to dump ~200 shares ($100 position),');
  console.log('     is there enough depth in the book to absorb it?');
  console.log();
  console.log('  2. AT WHAT PRICE? Walk the actual bid levels tick-by-tick to get');
  console.log('     real fill prices, not theoretical mid-price estimates.');
  console.log();
  console.log('  3. IS IT WORTH IT? Compare "exit now at this fill" vs "hold and');
  console.log('     either win $50 or lose $50". The stop-loss is worth it when');
  console.log('     the savings on losers exceed the profits lost on false exits.');
  console.log();
  console.log('='.repeat(110));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
