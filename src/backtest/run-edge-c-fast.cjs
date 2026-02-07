/**
 * Edge C Backtest — Fast-Track Mode
 *
 * Reads pre-computed states from window_backtest_states table.
 * Entire backtest + sweep in ~1-2 seconds.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-c-fast.cjs
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

// ─── Edge C Evaluation ───

function evaluateEdgeC(state, config) {
  const {
    deficitThreshold = 80,
    nearStrikeThreshold = 100,
    maxDownPrice = 0.65,
  } = config;

  const { strike_price, chainlink_price, polyref_price, clob_down_ask } = state;

  if (strike_price == null || chainlink_price == null || polyref_price == null || clob_down_ask == null) {
    return { fire: false, reason: 'missing_data' };
  }

  const strike = parseFloat(strike_price);
  const cl = parseFloat(chainlink_price);
  const ref = parseFloat(polyref_price);
  const ask = parseFloat(clob_down_ask);

  if (isNaN(ask) || ask <= 0) {
    return { fire: false, reason: 'missing_data' };
  }

  const deficit = strike - cl;
  const refGap = Math.abs(ref - strike);

  if (refGap >= nearStrikeThreshold) return { fire: false, reason: `ref_far (gap=$${refGap.toFixed(0)})` };
  if (deficit <= deficitThreshold) return { fire: false, reason: `deficit_low ($${deficit.toFixed(0)})` };
  if (ask >= maxDownPrice) return { fire: false, reason: `down_expensive (${ask.toFixed(3)})` };

  return { fire: true, deficit, refGap, ask, fillPrice: ask + 0.005 };
}

// ─── Simulation ───

function simulate(trades, initialCapital = 100) {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;

  for (const t of trades) {
    capital -= t.cost;
    capital += t.payout;
    if (capital > peak) peak = capital;
    const dd = peak > 0 ? (peak - capital) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl: capital - initialCapital,
    returnPct: (capital - initialCapital) / initialCapital,
    maxDrawdown: maxDD,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    finalCapital: capital,
  };
}

// ─── Run Backtest From Fast-Track Data ───

function runFromStates(windowGroups, config, verbose = false) {
  const { entryWindowMs = 120000, positionSize = 1, spreadBuffer = 0.005 } = config;

  const trades = [];
  const decisionLog = [];
  let signalsFired = 0;
  const reasonCounts = {};

  // For each window, find the best sample within the entry window
  // The entry window = last entryWindowMs before close
  // We pick the sample closest to the midpoint of the entry window
  const targetOffset = entryWindowMs / 2;

  for (const group of windowGroups) {
    // Find sample closest to targetOffset
    const eligible = group.samples.filter(s => s.offset_ms <= entryWindowMs && s.offset_ms > 0);
    if (eligible.length === 0) continue;

    const sample = eligible.reduce((best, s) =>
      Math.abs(s.offset_ms - targetOffset) < Math.abs(best.offset_ms - targetOffset) ? s : best
    );

    const evalResult = evaluateEdgeC(sample, config);

    if (!evalResult.fire) {
      reasonCounts[evalResult.reason] = (reasonCounts[evalResult.reason] || 0) + 1;
      continue;
    }

    signalsFired++;

    const fillPrice = evalResult.ask + spreadBuffer;
    if (fillPrice <= 0 || fillPrice >= 1) continue;

    const cost = fillPrice * positionSize;
    const resolved = sample.resolved_direction;
    const won = resolved === 'DOWN';
    const payout = won ? 1.00 * positionSize : 0.00;
    const pnl = payout - cost;

    trades.push({
      windowCloseTime: group.closeTime,
      symbol: group.symbol,
      strike: parseFloat(sample.strike_price),
      chainlinkClose: parseFloat(sample.chainlink_at_close),
      deficit: evalResult.deficit,
      entryPrice: fillPrice,
      size: positionSize,
      cost,
      payout,
      pnl,
      resolved,
      won,
    });

    if (verbose) {
      const ts = new Date(group.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(3)}\x1b[0m`;
      decisionLog.push(
        `  ${et} | ${resolved.padEnd(4)} | deficit=$${evalResult.deficit.toFixed(0).padStart(4)} | ref=$${parseFloat(sample.polyref_price).toFixed(0)} | strike=$${parseFloat(sample.strike_price).toFixed(0)} | askDown=${evalResult.ask.toFixed(3)} | fill=${fillPrice.toFixed(3)} | ${pnlStr}`
      );
    }
  }

  const stats = simulate(trades);
  return { trades, stats, decisionLog, signalsFired, windowsEvaluated: windowGroups.length, reasonCounts };
}

// ─── Main ───

async function main() {
  console.log('\n=== Edge C Fast-Track Backtest ===\n');

  // Load all pre-computed states in a single query
  const t0 = Date.now();
  const rows = await query(`
    SELECT window_close_time, symbol, offset_ms, strike_price,
           chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_up_bid, clob_up_ask,
           exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
           resolved_direction, chainlink_at_close
    FROM window_backtest_states
    ORDER BY window_close_time ASC, offset_ms DESC
  `);
  const loadMs = Date.now() - t0;

  // Group by window
  const windowMap = new Map();
  for (const row of rows) {
    const key = row.window_close_time.toISOString();
    if (!windowMap.has(key)) {
      windowMap.set(key, {
        closeTime: row.window_close_time,
        symbol: row.symbol,
        samples: [],
      });
    }
    windowMap.get(key).samples.push(row);
  }

  const windowGroups = Array.from(windowMap.values());
  const upCount = windowGroups.filter(g => g.samples[0]?.resolved_direction === 'UP').length;
  const downCount = windowGroups.filter(g => g.samples[0]?.resolved_direction === 'DOWN').length;

  console.log(`  Loaded: ${rows.length} state rows, ${windowGroups.length} windows`);
  console.log(`  Resolution: UP=${upCount}, DOWN=${downCount} (${(downCount/(upCount+downCount)*100).toFixed(1)}% DOWN)`);
  console.log(`  Load time: ${loadMs}ms\n`);

  // ─── Filter to same range as window-centric test ───
  const testStart = new Date('2026-02-06T04:00:00Z');
  const testEnd = new Date('2026-02-07T05:10:00Z');
  const testGroups = windowGroups.filter(g => {
    const t = new Date(g.closeTime);
    return t >= testStart && t <= testEnd;
  });

  console.log(`  Test range: ${testStart.toISOString()} → ${testEnd.toISOString()}`);
  console.log(`  Windows in range: ${testGroups.length}\n`);

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

  const t1 = Date.now();
  const singleResult = runFromStates(testGroups, defaultConfig, true);
  const singleMs = Date.now() - t1;

  printResult(singleResult, singleMs);

  // ─── Full dataset run ───
  console.log('\n────────────────────────────────────────');
  console.log('  FULL DATASET — All 207 windows');
  console.log('────────────────────────────────────────\n');

  const t1b = Date.now();
  const fullResult = runFromStates(windowGroups, defaultConfig, true);
  const fullMs = Date.now() - t1b;

  printResult(fullResult, fullMs);

  // ─── Parameter Sweep ───
  console.log('\n════════════════════════════════════════');
  console.log('  PARAMETER SWEEP (all 207 windows)');
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
          deficitThreshold: dt, entryWindowMs: ew, maxDownPrice: mdp,
          nearStrikeThreshold: 100, positionSize: 1, spreadBuffer: 0.005,
        });
      }
    }
  }

  const t2 = Date.now();
  const sweepResults = paramSets.map(params => ({
    params,
    result: runFromStates(windowGroups, params, false),
  }));
  const sweepMs = Date.now() - t2;

  const withTrades = sweepResults
    .filter(s => s.result.stats.tradeCount > 0)
    .map(s => {
      const st = s.result.stats;
      const avgEntry = s.result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / st.tradeCount;
      const evPerTrade = (st.winRate * (1 - avgEntry)) - ((1 - st.winRate) * avgEntry);
      return { ...s, avgEntry, evPerTrade };
    })
    .sort((a, b) => b.evPerTrade - a.evPerTrade);

  console.log(`  ${paramSets.length} configs, sweep completed in ${sweepMs}ms`);
  console.log(`  ${withTrades.length}/${paramSets.length} produced trades\n`);

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

function printResult(result, ms) {
  const s = result.stats;
  console.log(`─── Results (${ms}ms) ───`);
  console.log(`  Windows evaluated:  ${result.windowsEvaluated}`);
  console.log(`  Signals fired:      ${result.signalsFired}`);
  console.log(`  Trades executed:    ${s.tradeCount}`);
  console.log(`  Wins:               ${s.winCount} (${(s.winRate*100).toFixed(1)}%)`);
  console.log(`  Losses:             ${s.lossCount}`);
  console.log(`  Total P&L:          $${s.totalPnl.toFixed(2)}`);
  console.log(`  Return:             ${(s.returnPct*100).toFixed(2)}%`);
  console.log(`  Max Drawdown:       ${(s.maxDrawdown*100).toFixed(2)}%`);
  if (s.tradeCount > 0) {
    const avgEntry = result.trades.reduce((sum, t) => sum + t.entryPrice, 0) / s.tradeCount;
    const evPerTrade = (s.winRate * (1 - avgEntry)) - ((1 - s.winRate) * avgEntry);
    console.log(`  Avg Entry Price:    ${avgEntry.toFixed(4)}`);
    console.log(`  EV/Trade:           $${evPerTrade.toFixed(4)}`);
  }

  if (result.decisionLog.length > 0) {
    console.log('\n  Trade log:');
    for (const line of result.decisionLog) console.log(line);
  }
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

main().catch(err => {
  console.error('Fast-track backtest failed:', err);
  pool.end();
  process.exit(1);
});
