/**
 * Edge C Backtest Runner — Window-Centric
 *
 * Instead of loading millions of rows into memory, queries per-window state
 * directly. For each window: get latest chainlink, polyRef, clobDown near close,
 * evaluate Edge C conditions, simulate position.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-c.cjs
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Run: export $(grep DATABASE_URL .env.local | xargs)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 30000,
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// ─── Window-centric state queries ───

/**
 * For a given window close time, get the market state at a specific point
 * within the entry window. Returns chainlink, polyRef, clobDown.
 */
async function getMarketStateAt(timestamp, windowEpoch) {
  // Latest chainlink tick at or before timestamp
  const [chainlink, polyRef, clobDown] = await Promise.all([
    queryOne(`
      SELECT price, timestamp FROM rtds_ticks
      WHERE topic = 'crypto_prices_chainlink' AND timestamp <= $1
      ORDER BY timestamp DESC LIMIT 1
    `, [timestamp]),
    queryOne(`
      SELECT price, timestamp FROM rtds_ticks
      WHERE topic = 'crypto_prices' AND timestamp <= $1
      ORDER BY timestamp DESC LIMIT 1
    `, [timestamp]),
    queryOne(`
      SELECT best_bid, best_ask, mid_price, spread, timestamp
      FROM clob_price_snapshots
      WHERE symbol = 'btc-down' AND timestamp <= $1
        AND window_epoch = $2
        AND timestamp >= to_timestamp($2)
      ORDER BY timestamp DESC LIMIT 1
    `, [timestamp, windowEpoch]),
  ]);

  return { chainlink, polyRef, clobDown };
}

/**
 * Get multiple snapshots within the entry window for richer signal evaluation.
 * Samples at: entryWindowMs before close, 2/3, 1/3, and 10s before close.
 */
async function getEntryWindowSnapshots(closeTime, entryWindowMs) {
  const closeMs = new Date(closeTime).getTime();
  const windowEpoch = Math.floor(closeMs / 1000) - 900; // 15-min window start epoch
  const sampleOffsets = [
    entryWindowMs,            // start of entry window
    entryWindowMs * 2 / 3,    // 1/3 into entry window
    entryWindowMs * 1 / 3,    // 2/3 into entry window
    10000,                     // 10s before close
  ];

  const snapshots = [];
  for (const offset of sampleOffsets) {
    const sampleTime = new Date(closeMs - offset).toISOString();
    const state = await getMarketStateAt(sampleTime, windowEpoch);
    snapshots.push({
      timestamp: sampleTime,
      timeToCloseMs: offset,
      ...state,
    });
  }
  return snapshots;
}

// ─── Edge C Evaluation ───

function evaluateEdgeC(state, config) {
  const {
    deficitThreshold = 80,
    nearStrikeThreshold = 100,
    maxDownPrice = 0.65,
  } = config;

  const { strike, chainlinkPrice, polyRefPrice, clobDownAsk, timeToCloseMs } = state;

  if (strike == null || chainlinkPrice == null || polyRefPrice == null || clobDownAsk == null) {
    return { fire: false, reason: 'missing_data' };
  }

  const deficit = strike - chainlinkPrice;
  const refGap = Math.abs(polyRefPrice - strike);
  const refNearStrike = refGap < nearStrikeThreshold;
  const downCheap = clobDownAsk < maxDownPrice;

  if (!refNearStrike) return { fire: false, reason: `ref_far_from_strike (gap=$${refGap.toFixed(0)})` };
  if (deficit <= deficitThreshold) return { fire: false, reason: `deficit_low ($${deficit.toFixed(0)} <= $${deficitThreshold})` };
  if (!downCheap) return { fire: false, reason: `down_expensive (${clobDownAsk.toFixed(3)} >= ${maxDownPrice})` };

  return {
    fire: true,
    deficit,
    refGap,
    confidence: Math.min(deficit / 150, 1),
  };
}

// ─── Simulator ───

function runSimulation(trades, initialCapital = 100) {
  let capital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const equityCurve = [initialCapital];

  for (const trade of trades) {
    capital -= trade.cost;
    capital += trade.payout;

    if (capital > peakCapital) peakCapital = capital;
    const dd = peakCapital > 0 ? (peakCapital - capital) / peakCapital : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    equityCurve.push(capital);
    trade.capitalAfter = capital;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  return {
    initialCapital,
    finalCapital: capital,
    totalPnl: capital - initialCapital,
    returnPct: (capital - initialCapital) / initialCapital,
    maxDrawdown,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    equityCurve,
  };
}

// ─── Main ───

async function main() {
  const startDate = '2026-02-06T04:00:00Z';
  const endDate = '2026-02-07T05:10:00Z';

  console.log('\n=== Edge C Backtest (Window-Centric) ===\n');
  console.log(`Period: ${startDate} to ${endDate}`);

  // Load windows (tiny query)
  console.log('\nLoading window events...');
  const t0 = Date.now();
  const windows = await query(`
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved_direction,
           polymarket_binance_at_close,
           market_down_price_60s, market_down_price_30s, market_down_price_10s,
           market_down_price_5s, market_down_price_1s
    FROM window_close_events
    WHERE window_close_time >= $1 AND window_close_time <= $2
      AND chainlink_price_at_close IS NOT NULL
      AND strike_price IS NOT NULL
    ORDER BY window_close_time ASC
  `, [startDate, endDate]);

  const loadMs = Date.now() - t0;
  const upCount = windows.filter(w => w.resolved_direction === 'UP').length;
  const downCount = windows.filter(w => w.resolved_direction === 'DOWN').length;

  console.log(`  Windows: ${windows.length} (UP=${upCount}, DOWN=${downCount}, ${(downCount/(upCount+downCount)*100).toFixed(1)}% DOWN)`);
  console.log(`  Load time: ${loadMs}ms`);

  // ─── Pre-fetch market state for all windows ───
  // Sample at multiple offsets (5min, 3min, 2min, 1min, 30s before close)
  // so the sweep can test different entryWindowMs values without re-querying
  const sampleOffsets = [300_000, 180_000, 120_000, 60_000, 30_000];

  console.log(`\nPre-fetching market state for ${windows.length} windows at ${sampleOffsets.length} offsets...`);
  const t1 = Date.now();

  const windowStates = []; // { window, samples: { [offsetMs]: { chainlink, polyRef, clobDownAsk } } }

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const closeMs = new Date(win.window_close_time).getTime();
    const windowEpoch = Math.floor(closeMs / 1000) - 900;
    const strike = parseFloat(win.strike_price);

    const samples = {};
    for (const offset of sampleOffsets) {
      const sampleTime = new Date(closeMs - offset).toISOString();
      const state = await getMarketStateAt(sampleTime, windowEpoch);
      samples[offset] = {
        chainlinkPrice: state.chainlink ? parseFloat(state.chainlink.price) : null,
        polyRefPrice: state.polyRef ? parseFloat(state.polyRef.price) : null,
        clobDownAsk: state.clobDown ? parseFloat(state.clobDown.best_ask) : null,
      };
    }

    windowStates.push({
      window: win,
      strike,
      chainlinkClose: parseFloat(win.chainlink_price_at_close),
      resolved: win.resolved_direction,
      samples,
    });

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  ...${i + 1}/${windows.length} windows fetched\r`);
    }
  }

  const fetchMs = Date.now() - t1;
  console.log(`\n  Pre-fetch complete: ${fetchMs}ms (${(fetchMs/windows.length).toFixed(0)}ms/window)\n`);

  // ─── Single Run: Default params ───
  const defaultConfig = {
    deficitThreshold: 80,
    nearStrikeThreshold: 100,
    entryWindowMs: 120_000,
    maxDownPrice: 0.65,
    positionSize: 1,
    spreadBuffer: 0.005,
  };

  console.log('────────────────────────────────────────');
  console.log('  SINGLE RUN — Default Edge C params');
  console.log('────────────────────────────────────────');
  console.log(`\n  Config: deficit>$${defaultConfig.deficitThreshold}, ref<$${defaultConfig.nearStrikeThreshold} from strike, entry<${defaultConfig.entryWindowMs/1000}s, maxDown<${defaultConfig.maxDownPrice}\n`);

  const singleResult = runBacktestFromCache(windowStates, defaultConfig, true);
  printResult(singleResult);

  // ─── Parameter Sweep ───
  console.log('\n════════════════════════════════════════');
  console.log('  PARAMETER SWEEP');
  console.log('════════════════════════════════════════\n');

  const sweepGrid = {
    deficitThreshold: [20, 40, 60, 80, 100, 120],
    entryWindowMs: [60_000, 120_000, 180_000, 300_000],
    maxDownPrice: [0.55, 0.60, 0.65, 0.70, 0.80],
  };

  const paramSets = [];
  for (const dt of sweepGrid.deficitThreshold) {
    for (const ew of sweepGrid.entryWindowMs) {
      for (const mdp of sweepGrid.maxDownPrice) {
        paramSets.push({
          deficitThreshold: dt,
          entryWindowMs: ew,
          maxDownPrice: mdp,
          nearStrikeThreshold: 100,
          positionSize: 1,
          spreadBuffer: 0.005,
        });
      }
    }
  }

  console.log(`Running ${paramSets.length} parameter combinations (in-memory)...\n`);

  const sweepResults = [];
  const t2 = Date.now();

  for (const params of paramSets) {
    const r = runBacktestFromCache(windowStates, params, false);
    sweepResults.push({ params, result: r });
  }
  const sweepMs = Date.now() - t2;
  console.log(`Sweep completed in ${sweepMs}ms\n`);

  // Filter & rank
  const withTrades = sweepResults
    .filter(s => s.result.stats.tradeCount > 0)
    .map(s => {
      const st = s.result.stats;
      const avgEntry = s.result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / st.tradeCount;
      const evPerTrade = (st.winRate * (1 - avgEntry)) - ((1 - st.winRate) * avgEntry);
      return { ...s, avgEntry, evPerTrade };
    })
    .sort((a, b) => b.evPerTrade - a.evPerTrade);

  console.log(`  ${withTrades.length}/${paramSets.length} configs produced trades\n`);

  if (withTrades.length > 0) {
    console.log('  Top 20 by EV/trade:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Deficit │ Window │ MaxPx │ Trades │ WinRate │ AvgEntry │ EV/Trade │ TotalPnL │ MaxDD');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');
    const top = withTrades.slice(0, 20);
    for (let i = 0; i < top.length; i++) {
      const s = top[i];
      const p = s.params;
      const st = s.result.stats;
      console.log(
        `  ${String(i+1).padStart(4)} │ $${String(p.deficitThreshold).padStart(5)} │ ${String((p.entryWindowMs/1000)+'s').padStart(6)} │ ${p.maxDownPrice.toFixed(2).padStart(5)} │ ${String(st.tradeCount).padStart(6)} │ ${(st.winRate*100).toFixed(1).padStart(6)}% │ ${s.avgEntry.toFixed(4).padStart(8)} │ $${s.evPerTrade.toFixed(4).padStart(7)} │ $${st.totalPnl.toFixed(2).padStart(8)} │ ${(st.maxDrawdown*100).toFixed(1).padStart(5)}%`
      );
    }

    if (withTrades.length > 20) {
      console.log('  ...');
      const bottom = withTrades.slice(-3);
      const startRank = withTrades.length - 2;
      for (let i = 0; i < bottom.length; i++) {
        const s = bottom[i];
        const p = s.params;
        const st = s.result.stats;
        console.log(
          `  ${String(startRank+i).padStart(4)} │ $${String(p.deficitThreshold).padStart(5)} │ ${String((p.entryWindowMs/1000)+'s').padStart(6)} │ ${p.maxDownPrice.toFixed(2).padStart(5)} │ ${String(st.tradeCount).padStart(6)} │ ${(st.winRate*100).toFixed(1).padStart(6)}% │ ${s.avgEntry.toFixed(4).padStart(8)} │ $${s.evPerTrade.toFixed(4).padStart(7)} │ $${st.totalPnl.toFixed(2).padStart(8)} │ ${(st.maxDrawdown*100).toFixed(1).padStart(5)}%`
        );
      }
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');

    // Summary
    const allEVs = withTrades.map(s => s.evPerTrade);
    const allWRs = withTrades.map(s => s.result.stats.winRate);
    const allTrades = withTrades.map(s => s.result.stats.tradeCount);
    console.log(`\n  Sweep summary:`);
    console.log(`    EV/trade:  min=${Math.min(...allEVs).toFixed(4)}, max=${Math.max(...allEVs).toFixed(4)}, median=${median(allEVs).toFixed(4)}`);
    console.log(`    WinRate:   min=${(Math.min(...allWRs)*100).toFixed(1)}%, max=${(Math.max(...allWRs)*100).toFixed(1)}%, median=${(median(allWRs)*100).toFixed(1)}%`);
    console.log(`    Trades:    min=${Math.min(...allTrades)}, max=${Math.max(...allTrades)}, median=${median(allTrades).toFixed(0)}`);
  }

  console.log('\n════════════════════════════════════════\n');
  await pool.end();
}

/**
 * Run backtest purely from cached window states (no DB queries).
 * Picks the sample closest to entryWindowMs/2 for evaluation.
 */
function runBacktestFromCache(windowStates, config, verbose = false) {
  const {
    deficitThreshold, nearStrikeThreshold, entryWindowMs,
    maxDownPrice, positionSize, spreadBuffer,
  } = config;

  const trades = [];
  const decisionLog = [];
  let signalsFired = 0;
  const reasonCounts = {};

  // Find the best sample offset for this entryWindowMs
  // We want to evaluate at the midpoint of the entry window
  const targetOffset = entryWindowMs / 2;
  const availableOffsets = [300_000, 180_000, 120_000, 60_000, 30_000];
  const bestOffset = availableOffsets.reduce((best, o) =>
    Math.abs(o - targetOffset) < Math.abs(best - targetOffset) ? o : best
  );

  for (const ws of windowStates) {
    const sample = ws.samples[bestOffset];
    if (!sample) continue;

    const { chainlinkPrice, polyRefPrice, clobDownAsk } = sample;

    const evalResult = evaluateEdgeC({
      strike: ws.strike,
      chainlinkPrice,
      polyRefPrice,
      clobDownAsk,
      timeToCloseMs: bestOffset,
    }, config);

    if (!evalResult.fire) {
      reasonCounts[evalResult.reason] = (reasonCounts[evalResult.reason] || 0) + 1;
      continue;
    }

    signalsFired++;

    const fillPrice = clobDownAsk + spreadBuffer;
    if (fillPrice <= 0 || fillPrice >= 1) continue;

    const cost = fillPrice * positionSize;
    const wins = ws.resolved === 'DOWN';
    const payout = wins ? 1.00 * positionSize : 0.00;
    const pnl = payout - cost;

    const trade = {
      windowCloseTime: ws.window.window_close_time,
      symbol: ws.window.symbol,
      strike: ws.strike,
      chainlinkClose: ws.chainlinkClose,
      deficit: evalResult.deficit,
      entryPrice: fillPrice,
      size: positionSize,
      cost,
      payout,
      pnl,
      resolved: ws.resolved,
      won: wins,
      token: `${ws.window.symbol}-down`,
    };
    trades.push(trade);

    if (verbose) {
      const ts = new Date(ws.window.window_close_time);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(3)}\x1b[0m`;
      decisionLog.push(
        `  ${et} | ${ws.resolved.padEnd(4)} | deficit=$${evalResult.deficit.toFixed(0).padStart(4)} | ref=$${polyRefPrice.toFixed(0)} | strike=$${ws.strike.toFixed(0)} | askDown=${clobDownAsk.toFixed(3)} | fill=${fillPrice.toFixed(3)} | ${pnlStr}`
      );
    }
  }

  const stats = runSimulation(trades);

  return { trades, stats, decisionLog, signalsFired, windowsEvaluated: windowStates.length, reasonCounts };
}

function printResult(result) {
  const s = result.stats;
  console.log(`─── Results ───`);
  console.log(`  Windows evaluated:  ${result.windowsEvaluated}`);
  console.log(`  Signals fired:      ${result.signalsFired}`);
  console.log(`  Trades executed:    ${s.tradeCount}`);
  console.log(`  Wins:               ${s.winCount} (${(s.winRate*100).toFixed(1)}%)`);
  console.log(`  Losses:             ${s.lossCount}`);
  console.log(`  Total P&L:          $${s.totalPnl.toFixed(2)}`);
  console.log(`  Return:             ${(s.returnPct*100).toFixed(2)}%`);
  console.log(`  Max Drawdown:       ${(s.maxDrawdown*100).toFixed(2)}%`);
  console.log(`  Avg Win:            $${s.avgWin.toFixed(4)}`);
  console.log(`  Avg Loss:           $${s.avgLoss.toFixed(4)}`);

  if (s.tradeCount > 0) {
    const avgEntry = result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / s.tradeCount;
    const evPerTrade = (s.winRate * (1 - avgEntry)) - ((1 - s.winRate) * avgEntry);
    console.log(`  Avg Entry Price:    ${avgEntry.toFixed(4)}`);
    console.log(`  Edge Captured:      ${(s.winRate - avgEntry).toFixed(4)}`);
    console.log(`  EV/Trade:           $${evPerTrade.toFixed(4)}`);
    console.log(`  Total EV:           $${(evPerTrade * s.tradeCount).toFixed(2)}`);
  }

  // Rejection reasons
  if (Object.keys(result.reasonCounts).length > 0) {
    console.log('\n  Why signals didn\'t fire:');
    const sorted = Object.entries(result.reasonCounts).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`    ${count}x — ${reason}`);
    }
  }

  // Decision log
  if (result.decisionLog.length > 0) {
    console.log('\n  Trade log:');
    for (const line of result.decisionLog) {
      console.log(line);
    }
  }
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

main().catch(err => {
  console.error('Backtest failed:', err);
  pool.end();
  process.exit(1);
});
