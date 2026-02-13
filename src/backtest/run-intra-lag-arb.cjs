/**
 * Intra-Window Lag Arbitrage Strategy
 *
 * Exploits the structural lag between reference feeds and CLOB repricing.
 * Instead of holding to settlement (end-of-window play), this enters when
 * CLOB is stale relative to reference moves and exits via take-profit when
 * CLOB catches up.
 *
 * Entry: Reference price has moved $X since last CLOB update → CLOB is stale
 *   - If ref dropped → buy DOWN (expect DOWN ask/bid to rise)
 *   - If ref rose → buy UP (expect UP ask/bid to rise)
 *
 * Exit: First of:
 *   1. Take profit: CLOB bid > entry_price + target
 *   2. Stop loss: CLOB bid < entry_price - limit
 *   3. Timeout: Position held > max seconds → sell at current bid
 *   4. Settlement: Window resolves (fallback)
 *
 * Sweep Parameters:
 *   - Trigger source: exchange_median, polyref, chainlink
 *   - Trigger threshold: $30-$150
 *   - Take profit: $0.01-$0.10
 *   - Stop loss: $0.05-$0.20 or none
 *   - Max hold: 10s-300s
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-intra-lag-arb.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function loadClobEraWindows() {
  const res = await pool.query(`
    SELECT DISTINCT w.window_close_time, w.symbol, w.strike_price,
           COALESCE(w.resolved_direction,
             CASE WHEN w.chainlink_price_at_close > w.strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved_direction
    FROM window_close_events w
    WHERE EXISTS (
      SELECT 1 FROM clob_price_snapshots c
      WHERE c.timestamp >= w.window_close_time - interval '5 minutes'
        AND c.timestamp <= w.window_close_time
    )
    ORDER BY w.window_close_time ASC
  `);
  return res.rows;
}

async function loadWindowTimeline(closeTime) {
  const openTime = new Date(closeTime.getTime() - 5 * 60 * 1000);
  const windowEpoch = Math.floor(closeTime.getTime() / 1000) - 900;

  const [rtds, clob, exchange] = await Promise.all([
    pool.query(`
      SELECT timestamp, topic, price FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
      ORDER BY timestamp ASC
    `, [openTime, closeTime]),
    pool.query(`
      SELECT timestamp, symbol, best_bid, best_ask, mid_price, spread
      FROM clob_price_snapshots
      WHERE timestamp >= $1 AND timestamp <= $2
        AND window_epoch = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, windowEpoch]),
    pool.query(`
      SELECT timestamp, exchange, price FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
      ORDER BY timestamp ASC
    `, [openTime, closeTime]),
  ]);

  const timeline = [];

  for (const row of rtds.rows) {
    const ts = new Date(row.timestamp).getTime();
    if (row.topic === 'crypto_prices_chainlink') {
      timeline.push({ ts, source: 'chainlink', price: parseFloat(row.price) });
    } else if (row.topic === 'crypto_prices') {
      timeline.push({ ts, source: 'polyref', price: parseFloat(row.price) });
    }
  }

  for (const row of clob.rows) {
    const ts = new Date(row.timestamp).getTime();
    const isDown = row.symbol?.toLowerCase().includes('down');
    timeline.push({
      ts,
      source: isDown ? 'clobDown' : 'clobUp',
      bid: parseFloat(row.best_bid),
      ask: parseFloat(row.best_ask),
      mid: parseFloat(row.mid_price),
      spread: parseFloat(row.spread),
    });
  }

  for (const row of exchange.rows) {
    const ts = new Date(row.timestamp).getTime();
    timeline.push({ ts, source: `exchange_${row.exchange}`, price: parseFloat(row.price) });
  }

  timeline.sort((a, b) => a.ts - b.ts);
  return timeline;
}

function getExchangeMedian(exchanges) {
  const prices = Object.values(exchanges).filter(p => p != null && !isNaN(p));
  if (prices.length < 2) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const SPREAD_BUFFER = 0.005;

function simulateWindow(timeline, closeTimeMs, resolvedDirection, params) {
  const trades = [];

  // State
  const state = {
    exchanges: {},
    polyref: null,
    chainlink: null,
    clobDown: null,   // { bid, ask, mid, spread, ts }
    clobUp: null,
    refAtLastClobDown: {},
    refAtLastClobUp: {},
  };

  let openPosition = null; // { token, entryPrice, entryTs, side }

  for (const event of timeline) {
    // Update reference state
    if (event.source === 'chainlink') state.chainlink = event.price;
    else if (event.source === 'polyref') state.polyref = event.price;
    else if (event.source.startsWith('exchange_')) {
      state.exchanges[event.source.slice('exchange_'.length)] = event.price;
    }

    // Update CLOB state
    if (event.source === 'clobDown') {
      state.clobDown = { bid: event.bid, ask: event.ask, mid: event.mid, spread: event.spread, ts: event.ts };
      const exMedian = getExchangeMedian(state.exchanges);
      state.refAtLastClobDown = { exchange_median: exMedian, polyref: state.polyref, chainlink: state.chainlink };

      // Check exits for DOWN positions
      if (openPosition && openPosition.token === 'DOWN') {
        const currentBid = event.bid - SPREAD_BUFFER;
        const holdMs = event.ts - openPosition.entryTs;

        // Take profit
        if (params.takeProfit > 0 && currentBid >= openPosition.entryPrice + params.takeProfit) {
          const exitPrice = currentBid;
          trades.push({
            ...openPosition,
            exitPrice, exitTs: event.ts, holdMs,
            pnl: exitPrice - openPosition.entryPrice,
            exitReason: 'take_profit',
          });
          openPosition = null;
          continue;
        }
        // Stop loss
        if (params.stopLoss > 0 && currentBid <= openPosition.entryPrice - params.stopLoss) {
          const exitPrice = currentBid;
          trades.push({
            ...openPosition,
            exitPrice, exitTs: event.ts, holdMs,
            pnl: exitPrice - openPosition.entryPrice,
            exitReason: 'stop_loss',
          });
          openPosition = null;
          continue;
        }
        // Timeout
        if (params.maxHoldMs > 0 && holdMs >= params.maxHoldMs) {
          const exitPrice = currentBid;
          trades.push({
            ...openPosition,
            exitPrice, exitTs: event.ts, holdMs,
            pnl: exitPrice - openPosition.entryPrice,
            exitReason: 'timeout',
          });
          openPosition = null;
          continue;
        }
      }
    }

    if (event.source === 'clobUp') {
      state.clobUp = { bid: event.bid, ask: event.ask, mid: event.mid, spread: event.spread, ts: event.ts };
      const exMedian = getExchangeMedian(state.exchanges);
      state.refAtLastClobUp = { exchange_median: exMedian, polyref: state.polyref, chainlink: state.chainlink };

      // Check exits for UP positions
      if (openPosition && openPosition.token === 'UP') {
        const currentBid = event.bid - SPREAD_BUFFER;
        const holdMs = event.ts - openPosition.entryTs;

        if (params.takeProfit > 0 && currentBid >= openPosition.entryPrice + params.takeProfit) {
          trades.push({
            ...openPosition,
            exitPrice: currentBid, exitTs: event.ts, holdMs,
            pnl: currentBid - openPosition.entryPrice,
            exitReason: 'take_profit',
          });
          openPosition = null;
          continue;
        }
        if (params.stopLoss > 0 && currentBid <= openPosition.entryPrice - params.stopLoss) {
          trades.push({
            ...openPosition,
            exitPrice: currentBid, exitTs: event.ts, holdMs,
            pnl: currentBid - openPosition.entryPrice,
            exitReason: 'stop_loss',
          });
          openPosition = null;
          continue;
        }
        if (params.maxHoldMs > 0 && holdMs >= params.maxHoldMs) {
          trades.push({
            ...openPosition,
            exitPrice: currentBid, exitTs: event.ts, holdMs,
            pnl: currentBid - openPosition.entryPrice,
            exitReason: 'timeout',
          });
          openPosition = null;
          continue;
        }
      }
    }

    // Check entry signals on reference updates (if no open position)
    if (openPosition) continue;
    if (event.source !== 'chainlink' && event.source !== 'polyref' && !event.source.startsWith('exchange_')) continue;

    // Get current reference price for the configured source
    const exMedian = getExchangeMedian(state.exchanges);
    let currentRef;
    if (params.triggerSource === 'exchange_median') currentRef = exMedian;
    else if (params.triggerSource === 'polyref') currentRef = state.polyref;
    else if (params.triggerSource === 'chainlink') currentRef = state.chainlink;
    if (currentRef == null) continue;

    // Check DOWN entry: ref dropped since last CLOB DOWN update
    if (state.clobDown && state.refAtLastClobDown[params.triggerSource] != null) {
      const refMove = currentRef - state.refAtLastClobDown[params.triggerSource];

      if (refMove <= -params.triggerThreshold) {
        // Reference dropped → DOWN becomes more likely → buy DOWN at stale ask
        const entryPrice = state.clobDown.ask + SPREAD_BUFFER;
        if (entryPrice > 0 && entryPrice < 1) {
          openPosition = {
            token: 'DOWN',
            entryPrice,
            entryTs: event.ts,
            refMove,
            clobMidAtEntry: state.clobDown.mid,
            closeTimeMs,
          };
        }
        continue;
      }
    }

    // Check UP entry: ref rose since last CLOB UP update
    if (state.clobUp && state.refAtLastClobUp[params.triggerSource] != null) {
      const refMove = currentRef - state.refAtLastClobUp[params.triggerSource];

      if (refMove >= params.triggerThreshold) {
        // Reference rose → UP becomes more likely → buy UP at stale ask
        const entryPrice = state.clobUp.ask + SPREAD_BUFFER;
        if (entryPrice > 0 && entryPrice < 1) {
          openPosition = {
            token: 'UP',
            entryPrice,
            entryTs: event.ts,
            refMove,
            clobMidAtEntry: state.clobUp.mid,
            closeTimeMs,
          };
        }
        continue;
      }
    }
  }

  // Handle open position at window close — settle at resolution
  if (openPosition) {
    const won = (openPosition.token === resolvedDirection);
    const exitPrice = won ? 1.0 : 0.0;
    const holdMs = closeTimeMs - openPosition.entryTs;
    trades.push({
      ...openPosition,
      exitPrice, exitTs: closeTimeMs, holdMs,
      pnl: exitPrice - openPosition.entryPrice,
      exitReason: 'settlement',
    });
  }

  return trades;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  INTRA-WINDOW LAG ARBITRAGE STRATEGY                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadClobEraWindows();
  console.log(`  Loaded ${windows.length} CLOB-era windows\n`);

  // Pre-load all window timelines
  console.log('  Loading tick data per window...');
  const windowData = [];
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const closeTimeMs = new Date(win.window_close_time).getTime();
    const timeline = await loadWindowTimeline(win.window_close_time);
    windowData.push({ win, closeTimeMs, timeline, resolved: win.resolved_direction });
    if ((i + 1) % 20 === 0) process.stdout.write(`  Loaded ${i + 1}/${windows.length}...\r`);
  }
  console.log(`  Loaded ${windowData.length} window timelines                    \n`);

  // Parameter sweep
  const sweepGrid = {
    triggerSource: ['exchange_median', 'polyref', 'chainlink'],
    triggerThreshold: [30, 50, 80, 100, 150],
    takeProfit: [0.01, 0.02, 0.03, 0.05, 0.10],
    stopLoss: [0, 0.05, 0.10, 0.20],           // 0 = no stop loss
    maxHoldMs: [10000, 30000, 60000, 300000],   // 300s = effectively hold to settlement
  };

  const paramSets = [];
  for (const ts of sweepGrid.triggerSource) {
    for (const tt of sweepGrid.triggerThreshold) {
      for (const tp of sweepGrid.takeProfit) {
        for (const sl of sweepGrid.stopLoss) {
          for (const mh of sweepGrid.maxHoldMs) {
            paramSets.push({ triggerSource: ts, triggerThreshold: tt, takeProfit: tp, stopLoss: sl, maxHoldMs: mh });
          }
        }
      }
    }
  }

  console.log(`  Sweeping ${paramSets.length} parameter combinations...\n`);

  const allResults = [];
  const sweepT0 = Date.now();

  for (const params of paramSets) {
    let totalTrades = 0;
    let wins = 0;
    let totalPnl = 0;
    const exitReasons = { take_profit: 0, stop_loss: 0, timeout: 0, settlement: 0 };
    const holdTimes = [];
    const pnls = [];

    for (const { closeTimeMs, timeline, resolved } of windowData) {
      const trades = simulateWindow(timeline, closeTimeMs, resolved, params);
      for (const t of trades) {
        totalTrades++;
        if (t.pnl > 0) wins++;
        totalPnl += t.pnl;
        pnls.push(t.pnl);
        holdTimes.push(t.holdMs);
        exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
      }
    }

    if (totalTrades === 0) continue;

    const winRate = wins / totalTrades;
    const avgPnl = totalPnl / totalTrades;
    const medHold = median(holdTimes);
    const tpPct = exitReasons.take_profit / totalTrades;

    allResults.push({
      params, totalTrades, wins, winRate, totalPnl, avgPnl,
      medHold, exitReasons, tpPct, pnls,
    });
  }

  const sweepMs = Date.now() - sweepT0;
  console.log(`  Sweep: ${paramSets.length} configs in ${(sweepMs / 1000).toFixed(1)}s\n`);

  // Sort by total PnL
  allResults.sort((a, b) => b.totalPnl - a.totalPnl);
  const profitable = allResults.filter(r => r.totalPnl > 0);

  console.log(`  ${allResults.length}/${paramSets.length} configs produced trades`);
  console.log(`  ${profitable.length} show positive total PnL\n`);

  // ─── Top Results by Total PnL ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TOP 30 BY TOTAL PnL');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (allResults.length > 0) {
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Source     │ Thresh │ TP    │ SL    │ MaxH  │ Trades │ WinRate │ AvgPnL  │ TotalPnL │ TP%   │ Med Hold');
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 30);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${p.triggerSource.slice(0, 10).padEnd(10)} │ $${String(p.triggerThreshold).padStart(4)} │ $${p.takeProfit.toFixed(2)} │ $${p.stopLoss.toFixed(2)} │ ${String(p.maxHoldMs / 1000).padStart(4)}s │ ${String(r.totalTrades).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ $${r.avgPnl.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(8)} │ ${(r.tpPct * 100).toFixed(0).padStart(4)}% │ ${(r.medHold / 1000).toFixed(1).padStart(6)}s`
      );
    }
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');
  }

  // ─── Best Config Analysis ───
  if (allResults.length > 0) {
    const best = allResults[0];
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  BEST CONFIG DEEP DIVE');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`  Source: ${best.params.triggerSource}, Threshold: $${best.params.triggerThreshold}`);
    console.log(`  Take Profit: $${best.params.takeProfit}, Stop Loss: $${best.params.stopLoss || 'none'}, Max Hold: ${best.params.maxHoldMs / 1000}s`);
    console.log(`  Trades: ${best.totalTrades}, Wins: ${best.wins}, Win Rate: ${(best.winRate * 100).toFixed(1)}%`);
    console.log(`  Total PnL: $${best.totalPnl.toFixed(2)}, Avg PnL: $${best.avgPnl.toFixed(4)}`);
    console.log(`  Exit breakdown: TP=${best.exitReasons.take_profit}, SL=${best.exitReasons.stop_loss}, Timeout=${best.exitReasons.timeout}, Settlement=${best.exitReasons.settlement}`);
    console.log(`  Median hold time: ${(best.medHold / 1000).toFixed(1)}s\n`);
  }

  // ─── Take-Profit Only Analysis ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TAKE-PROFIT EFFECTIVENESS (configs where TP% > 50%)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const tpDominant = allResults.filter(r => r.tpPct > 0.5 && r.totalTrades >= 5);
  tpDominant.sort((a, b) => b.totalPnl - a.totalPnl);

  if (tpDominant.length > 0) {
    console.log(`  ${tpDominant.length} configs where majority of exits are take-profit\n`);
    console.log('  Top 15:');
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Source     │ Thresh │ TP    │ SL    │ Trades │ WinRate │ AvgPnL  │ PnL     │ TP%   │ Hold');
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────');

    for (let i = 0; i < Math.min(15, tpDominant.length); i++) {
      const r = tpDominant[i];
      const p = r.params;
      console.log(
        `  ${p.triggerSource.slice(0, 10).padEnd(10)} │ $${String(p.triggerThreshold).padStart(4)} │ $${p.takeProfit.toFixed(2)} │ $${p.stopLoss.toFixed(2)} │ ${String(r.totalTrades).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ $${r.avgPnl.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)} │ ${(r.tpPct * 100).toFixed(0).padStart(4)}% │ ${(r.medHold / 1000).toFixed(1).padStart(5)}s`
      );
    }
    console.log('  ───────────────────────────────────────────────────────────────────────────────────────────\n');
  } else {
    console.log('  No configs found where take-profit dominates exits. CLOB may reprice too slowly.\n');
  }

  // ─── Source Comparison ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TRIGGER SOURCE COMPARISON');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const source of ['exchange_median', 'polyref', 'chainlink']) {
    const srcResults = allResults.filter(r => r.params.triggerSource === source);
    if (srcResults.length === 0) continue;

    const profitableCount = srcResults.filter(r => r.totalPnl > 0).length;
    const medPnl = median(srcResults.map(r => r.avgPnl));
    const bestPnl = srcResults[0]?.totalPnl;
    const medTrades = median(srcResults.map(r => r.totalTrades));

    console.log(`  ${source}:`);
    console.log(`    Configs: ${srcResults.length}, Profitable: ${profitableCount} (${pct(profitableCount, srcResults.length)}%)`);
    console.log(`    Median avg PnL: $${medPnl?.toFixed(4)}, Best total PnL: $${bestPnl?.toFixed(2)}`);
    console.log(`    Median trades/config: ${medTrades}`);
    console.log();
  }

  // ─── Threshold Analysis ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TRIGGER THRESHOLD ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const threshold of [30, 50, 80, 100, 150]) {
    const thResults = allResults.filter(r => r.params.triggerThreshold === threshold);
    if (thResults.length === 0) continue;

    const profCount = thResults.filter(r => r.totalPnl > 0).length;
    const medTrades = median(thResults.map(r => r.totalTrades));
    const medAvgPnl = median(thResults.map(r => r.avgPnl));

    console.log(`  $${threshold}: ${thResults.length} configs, ${profCount} profitable, median trades=${medTrades}, median avg PnL=$${medAvgPnl?.toFixed(4)}`);
  }
  console.log();

  // ─── Verdict ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VERDICT: Is Intra-Window Lag Arb Viable?');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (profitable.length > 0) {
    const bestTP = tpDominant[0];
    if (bestTP && bestTP.totalPnl > 1) {
      console.log(`  YES — Take-profit strategy viable.`);
      console.log(`    Best TP-dominant config: ${bestTP.params.triggerSource}, $${bestTP.params.triggerThreshold} trigger`);
      console.log(`    TP=$${bestTP.params.takeProfit}, ${bestTP.totalTrades} trades, PnL=$${bestTP.totalPnl.toFixed(2)}`);
    } else if (allResults[0].totalPnl > 1) {
      console.log(`  MIXED — Profitable configs exist but primarily via settlement, not take-profit.`);
      console.log(`    This is NOT true lag arb — it's just a settlement strategy with an entry timing twist.`);
    } else {
      console.log(`  MARGINAL — Some profitable configs but PnL too small to be meaningful.`);
    }
  } else {
    console.log(`  NO — All configs show negative or zero PnL.`);
    console.log(`  CLOB reprices too quickly relative to spreads, or trigger events don't predict repricing direction.`);
  }
  console.log();

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Intra-Lag-Arb failed:', err); pool.end(); process.exit(1); });
