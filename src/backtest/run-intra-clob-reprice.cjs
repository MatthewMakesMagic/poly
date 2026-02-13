/**
 * Intra-Window CLOB Repricing Diagnostic (v2)
 *
 * Fixes from v1:
 *   - Filters for NEAR-STRIKE trigger events (where ref move actually matters)
 *   - Investigates "surprise DOWN" resolutions (UP priced high but resolves DOWN)
 *   - Uses safe max/min (no stack overflow on large arrays)
 *
 * Two key hunches being tested:
 *   1. When BTC is NEAR strike and moves $100, does CLOB reprice predictably?
 *   2. How often does the market show UP at 93%+ but resolve DOWN?
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-intra-clob-reprice.cjs
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

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function safeMax(arr) { let m = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; }
function safeMin(arr) { let m = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i]; return m; }
function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  INTRA-WINDOW REPRICING v2: Near-Strike + Surprise DOWN  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // ═══════════════════════════════════════════════════════════
  // PART 1: Surprise DOWN resolutions
  // ═══════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 1: SURPRISE DOWN RESOLUTIONS');
  console.log('  (Market shows UP high, but resolves DOWN)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Count surprise resolutions at various thresholds
  const surpriseQuery = await pool.query(`
    SELECT
      window_close_time,
      strike_price,
      chainlink_price_at_close,
      polymarket_binance_at_close,
      market_up_price_60s, market_up_price_30s, market_up_price_10s,
      market_up_price_5s, market_up_price_1s,
      market_down_price_60s, market_down_price_30s, market_down_price_10s,
      market_down_price_5s, market_down_price_1s,
      surprise_resolution,
      market_consensus_direction,
      market_consensus_confidence,
      COALESCE(resolved_direction,
        CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
      ) as resolved
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND chainlink_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  const allWindows = surpriseQuery.rows;
  console.log(`  Total windows with resolution data: ${allWindows.length}\n`);

  // Surprise DOWN at various UP price thresholds
  const thresholds = [
    { label: 'UP > $0.80 at T-60s', field: 'market_up_price_60s', min: 0.80 },
    { label: 'UP > $0.85 at T-60s', field: 'market_up_price_60s', min: 0.85 },
    { label: 'UP > $0.90 at T-60s', field: 'market_up_price_60s', min: 0.90 },
    { label: 'UP > $0.80 at T-30s', field: 'market_up_price_30s', min: 0.80 },
    { label: 'UP > $0.85 at T-30s', field: 'market_up_price_30s', min: 0.85 },
    { label: 'UP > $0.90 at T-30s', field: 'market_up_price_30s', min: 0.90 },
    { label: 'UP > $0.80 at T-10s', field: 'market_up_price_10s', min: 0.80 },
    { label: 'UP > $0.85 at T-10s', field: 'market_up_price_10s', min: 0.85 },
    { label: 'UP > $0.90 at T-10s', field: 'market_up_price_10s', min: 0.90 },
    { label: 'UP > $0.93 at T-10s', field: 'market_up_price_10s', min: 0.93 },
    { label: 'UP > $0.80 at T-5s',  field: 'market_up_price_5s',  min: 0.80 },
    { label: 'UP > $0.85 at T-5s',  field: 'market_up_price_5s',  min: 0.85 },
    { label: 'UP > $0.90 at T-5s',  field: 'market_up_price_5s',  min: 0.90 },
    { label: 'UP > $0.93 at T-5s',  field: 'market_up_price_5s',  min: 0.93 },
    { label: 'UP > $0.80 at T-1s',  field: 'market_up_price_1s',  min: 0.80 },
    { label: 'UP > $0.90 at T-1s',  field: 'market_up_price_1s',  min: 0.90 },
    { label: 'UP > $0.93 at T-1s',  field: 'market_up_price_1s',  min: 0.93 },
    { label: 'UP > $0.95 at T-1s',  field: 'market_up_price_1s',  min: 0.95 },
  ];

  console.log('  ──────────────────────────────────────────────────────────────────────────────');
  console.log('  Condition              │ Total │ DOWN │ DOWN%  │ DOWN ask │ Deficit │ Note');
  console.log('  ──────────────────────────────────────────────────────────────────────────────');

  for (const th of thresholds) {
    const matching = allWindows.filter(w => {
      const val = w[th.field] ? parseFloat(w[th.field]) : null;
      return val != null && val >= th.min;
    });
    const downCount = matching.filter(w => w.resolved === 'DOWN').length;
    const downWindows = matching.filter(w => w.resolved === 'DOWN');

    // Avg DOWN ask and deficit for surprise DOWNs
    let avgDownAsk = '-';
    let avgDeficit = '-';
    if (downWindows.length > 0) {
      const downAsks = downWindows.map(w => {
        const offset = th.field.replace('market_up_price_', 'market_down_price_');
        return w[offset] ? parseFloat(w[offset]) : null;
      }).filter(v => v != null);
      if (downAsks.length > 0) avgDownAsk = '$' + (downAsks.reduce((s,v) => s+v, 0) / downAsks.length).toFixed(3);

      const deficits = downWindows.map(w =>
        parseFloat(w.strike_price) - parseFloat(w.chainlink_price_at_close)
      );
      avgDeficit = '$' + (deficits.reduce((s,v) => s+v, 0) / deficits.length).toFixed(0);
    }

    const note = downCount > 0 && matching.length >= 10 ? 'EXPLOITABLE?' : downCount > 0 ? 'small n' : '';

    console.log(
      `  ${th.label.padEnd(22)} │ ${String(matching.length).padStart(5)} │ ${String(downCount).padStart(4)} │ ${pct(downCount, matching.length).padStart(5)}% │ ${avgDownAsk.padStart(8)} │ ${avgDeficit.padStart(7)} │ ${note}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────\n');

  // Show individual surprise DOWN events (UP > 0.85 at T-10s but resolved DOWN)
  const surpriseDowns = allWindows.filter(w => {
    const up10 = w.market_up_price_10s ? parseFloat(w.market_up_price_10s) : null;
    return up10 != null && up10 >= 0.80 && w.resolved === 'DOWN';
  });

  if (surpriseDowns.length > 0) {
    console.log(`  ── Individual Surprise DOWN Events (UP ≥ $0.80 at T-10s → DOWN) ──\n`);
    console.log('  Time (ET)          │ Strike   │ CL Close │ Deficit │ UP@10s │ UP@5s  │ UP@1s  │ DN@10s');
    console.log('  ───────────────────┼──────────┼──────────┼─────────┼────────┼────────┼────────┼───────');

    for (const w of surpriseDowns) {
      const ts = new Date(w.window_close_time);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const strike = parseFloat(w.strike_price);
      const clClose = parseFloat(w.chainlink_price_at_close);
      const deficit = strike - clClose;
      const up10 = w.market_up_price_10s ? parseFloat(w.market_up_price_10s).toFixed(3) : '  -  ';
      const up5 = w.market_up_price_5s ? parseFloat(w.market_up_price_5s).toFixed(3) : '  -  ';
      const up1 = w.market_up_price_1s ? parseFloat(w.market_up_price_1s).toFixed(3) : '  -  ';
      const dn10 = w.market_down_price_10s ? parseFloat(w.market_down_price_10s).toFixed(3) : '  -  ';

      console.log(
        `  ${et.padEnd(19)} │ $${strike.toFixed(0).padStart(7)} │ $${clClose.toFixed(0).padStart(7)} │ $${deficit.toFixed(0).padStart(6)} │ ${up10.padStart(6)} │ ${up5.padStart(6)} │ ${up1.padStart(6)} │ ${dn10.padStart(6)}`
      );
    }
    console.log();
  }

  // If UP is priced at $0.93 at T-10s, DOWN is ~$0.07. If resolved DOWN, profit = $0.93 per $0.07 bet = 13.3x
  console.log('  ── Surprise DOWN P&L Analysis ──\n');
  console.log('  If we buy DOWN whenever UP > threshold at T-10s:\n');

  for (const upThreshold of [0.80, 0.85, 0.90, 0.93, 0.95]) {
    const qualifying = allWindows.filter(w => {
      const up10 = w.market_up_price_10s ? parseFloat(w.market_up_price_10s) : null;
      const dn10 = w.market_down_price_10s ? parseFloat(w.market_down_price_10s) : null;
      return up10 != null && up10 >= upThreshold && dn10 != null && dn10 > 0;
    });

    let totalPnl = 0;
    let trades = 0;
    let wins = 0;

    for (const w of qualifying) {
      const dnAsk = parseFloat(w.market_down_price_10s) + 0.005; // spread buffer
      if (dnAsk >= 1) continue;
      trades++;
      const won = w.resolved === 'DOWN';
      if (won) { wins++; totalPnl += (1 - dnAsk); }
      else { totalPnl -= dnAsk; }
    }

    const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : '-';
    const avgEntry = qualifying.length > 0
      ? qualifying.reduce((s, w) => s + parseFloat(w.market_down_price_10s || 0), 0) / qualifying.length
      : 0;

    console.log(`  UP > $${upThreshold.toFixed(2)} at T-10s: ${trades} trades, ${wins} wins (${winRate}%), avg DOWN entry ~$${avgEntry.toFixed(3)}, total PnL: $${totalPnl.toFixed(2)}`);
  }

  // ═══════════════════════════════════════════════════════════
  // PART 2: Near-Strike CLOB Repricing
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PART 2: NEAR-STRIKE CLOB REPRICING');
  console.log('  (Does direction match improve when ref is near strike?)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Load windows with CLOB data and strike prices
  const clobWindows = await pool.query(`
    SELECT DISTINCT w.window_close_time, w.symbol, w.strike_price,
           COALESCE(w.resolved_direction,
             CASE WHEN w.chainlink_price_at_close > w.strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved_direction
    FROM window_close_events w
    WHERE w.strike_price IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM clob_price_snapshots c
        WHERE c.timestamp >= w.window_close_time - interval '5 minutes'
          AND c.timestamp <= w.window_close_time
      )
    ORDER BY w.window_close_time ASC
  `);

  console.log(`  ${clobWindows.rows.length} CLOB-era windows with strike prices\n`);
  console.log('  Processing near-strike repricing analysis...\n');

  // For each window, load tick data and measure near-strike repricing
  const repriceResults = {
    all: { events: 0, dirMatch: 0, clobMoves: [], latencies: [] },
    near100: { events: 0, dirMatch: 0, clobMoves: [], latencies: [] },
    near200: { events: 0, dirMatch: 0, clobMoves: [], latencies: [] },
    near500: { events: 0, dirMatch: 0, clobMoves: [], latencies: [] },
    far: { events: 0, dirMatch: 0, clobMoves: [], latencies: [] },
  };

  let processed = 0;
  for (const win of clobWindows.rows) {
    const closeTime = win.window_close_time;
    const strike = parseFloat(win.strike_price);
    const openTime = new Date(closeTime.getTime() - 5 * 60 * 1000);
    const windowEpoch = Math.floor(closeTime.getTime() / 1000) - 900;

    // Load timeline for this window
    const [rtds, clob, exchange] = await Promise.all([
      pool.query(`SELECT timestamp, topic, price FROM rtds_ticks WHERE timestamp >= $1 AND timestamp <= $2 AND topic IN ('crypto_prices_chainlink', 'crypto_prices') ORDER BY timestamp ASC`, [openTime, closeTime]),
      pool.query(`SELECT timestamp, symbol, best_bid, best_ask, mid_price FROM clob_price_snapshots WHERE timestamp >= $1 AND timestamp <= $2 AND window_epoch = $3 ORDER BY timestamp ASC`, [openTime, closeTime, windowEpoch]),
      pool.query(`SELECT timestamp, exchange, price FROM exchange_ticks WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp ASC`, [openTime, closeTime]),
    ]);

    // Build timeline
    const timeline = [];
    for (const row of rtds.rows) {
      const ts = new Date(row.timestamp).getTime();
      if (row.topic === 'crypto_prices') {
        timeline.push({ ts, source: 'polyref', price: parseFloat(row.price) });
      }
    }
    for (const row of clob.rows) {
      const ts = new Date(row.timestamp).getTime();
      const isDown = row.symbol?.toLowerCase().includes('down');
      if (isDown) {
        timeline.push({ ts, source: 'clobDown', bid: parseFloat(row.best_bid), ask: parseFloat(row.best_ask), mid: parseFloat(row.mid_price) });
      }
    }
    for (const row of exchange.rows) {
      const ts = new Date(row.timestamp).getTime();
      timeline.push({ ts, source: `ex_${row.exchange}`, price: parseFloat(row.price) });
    }
    timeline.sort((a, b) => a.ts - b.ts);

    // Walk timeline: track polyRef moves between CLOB updates
    let lastClobDown = null;
    let refAtLastClob = null;  // polyRef value when CLOB last updated
    let exchanges = {};

    for (const event of timeline) {
      if (event.source === 'polyref') {
        // Check if ref moved significantly since last CLOB update
        if (lastClobDown && refAtLastClob != null) {
          const refMove = event.price - refAtLastClob;
          const distToStrike = Math.abs(event.price - strike);

          if (Math.abs(refMove) >= 30) {
            // This is a significant ref move — categorize by distance to strike
            const bucket = distToStrike < 100 ? 'near100' : distToStrike < 200 ? 'near200' : distToStrike < 500 ? 'near500' : 'far';

            // Find next CLOB update
            const nextClob = timeline.find(e => e.source === 'clobDown' && e.ts > event.ts);
            if (nextClob) {
              const latency = nextClob.ts - event.ts;
              const clobMove = nextClob.mid - lastClobDown.mid;
              // ref dropped → DOWN more likely → DOWN mid should go UP
              const expectedDir = refMove < 0 ? 1 : -1;
              const actualDir = clobMove > 0 ? 1 : clobMove < 0 ? -1 : 0;
              const match = expectedDir === actualDir;

              repriceResults.all.events++;
              repriceResults.all.clobMoves.push(Math.abs(clobMove));
              repriceResults.all.latencies.push(latency);
              if (match) repriceResults.all.dirMatch++;

              repriceResults[bucket].events++;
              repriceResults[bucket].clobMoves.push(Math.abs(clobMove));
              repriceResults[bucket].latencies.push(latency);
              if (match) repriceResults[bucket].dirMatch++;
            }
          }
        }
      } else if (event.source === 'clobDown') {
        lastClobDown = { mid: event.mid, bid: event.bid, ask: event.ask, ts: event.ts };
        // Snapshot current polyRef at CLOB update time
        refAtLastClob = null;
        // Find most recent polyRef
        for (let i = timeline.indexOf(event) - 1; i >= 0; i--) {
          if (timeline[i].source === 'polyref') { refAtLastClob = timeline[i].price; break; }
        }
      } else if (event.source.startsWith('ex_')) {
        exchanges[event.source] = event.price;
      }
    }

    processed++;
    if (processed % 50 === 0) process.stdout.write(`  Processed ${processed}/${clobWindows.rows.length}...\r`);
  }
  console.log(`  Processed ${processed}/${clobWindows.rows.length} windows                    \n`);

  // Report near-strike repricing results
  console.log('  ────────────────────────────────────────────────────────────────────────────');
  console.log('  Distance to Strike │ Events │ Dir Match │ Med |CLOB Δ| │ Med Latency │ Verdict');
  console.log('  ────────────────────────────────────────────────────────────────────────────');

  const buckets = [
    { key: 'near100', label: '< $100 (NEAR)' },
    { key: 'near200', label: '$100-$200' },
    { key: 'near500', label: '$200-$500' },
    { key: 'far',     label: '> $500 (FAR)' },
    { key: 'all',     label: 'ALL' },
  ];

  for (const b of buckets) {
    const r = repriceResults[b.key];
    if (r.events === 0) { console.log(`  ${b.label.padEnd(20)} │ ${String(0).padStart(6)} │     -     │       -       │       -       │ -`); continue; }

    const dirPct = (r.dirMatch / r.events * 100).toFixed(1);
    const medMove = median(r.clobMoves)?.toFixed(4);
    const medLat = median(r.latencies)?.toFixed(0);
    const verdict = parseFloat(dirPct) > 55 ? 'SIGNAL!' : parseFloat(dirPct) > 50 ? 'weak' : 'random';

    console.log(
      `  ${b.label.padEnd(20)} │ ${String(r.events).padStart(6)} │ ${dirPct.padStart(6)}%   │ $${medMove?.padStart(10)}  │ ${medLat?.padStart(8)}ms   │ ${verdict}`
    );
  }
  console.log('  ────────────────────────────────────────────────────────────────────────────\n');

  // ═══════════════════════════════════════════════════════════
  // PART 3: Near-Strike Lag Arb Simulation
  // ═══════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 3: NEAR-STRIKE LAG ARB SIMULATION');
  console.log('  (Only trigger when ref is within $200 of strike)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Re-process windows but with near-strike filter and simulate trades
  const tradeResults = [];
  processed = 0;

  for (const win of clobWindows.rows) {
    const closeTime = win.window_close_time;
    const closeTimeMs = new Date(closeTime).getTime();
    const strike = parseFloat(win.strike_price);
    const resolved = win.resolved_direction;
    const openTime = new Date(closeTime.getTime() - 5 * 60 * 1000);
    const windowEpoch2 = Math.floor(closeTime.getTime() / 1000) - 900;

    const [rtds, clob] = await Promise.all([
      pool.query(`SELECT timestamp, topic, price FROM rtds_ticks WHERE timestamp >= $1 AND timestamp <= $2 AND topic = 'crypto_prices' ORDER BY timestamp ASC`, [openTime, closeTime]),
      pool.query(`SELECT timestamp, symbol, best_bid, best_ask, mid_price FROM clob_price_snapshots WHERE timestamp >= $1 AND timestamp <= $2 AND symbol LIKE '%down%' AND window_epoch = $3 ORDER BY timestamp ASC`, [openTime, closeTime, windowEpoch2]),
    ]);

    const timeline = [];
    for (const row of rtds.rows) timeline.push({ ts: new Date(row.timestamp).getTime(), source: 'polyref', price: parseFloat(row.price) });
    for (const row of clob.rows) timeline.push({ ts: new Date(row.timestamp).getTime(), source: 'clobDown', bid: parseFloat(row.best_bid), ask: parseFloat(row.best_ask), mid: parseFloat(row.mid_price) });
    timeline.sort((a, b) => a.ts - b.ts);

    // Simulate: enter when polyRef moves $50+ since last CLOB AND within $200 of strike
    let lastClobDown = null;
    let refAtLastClob = null;
    let openPos = null;

    for (const event of timeline) {
      if (event.source === 'polyref') {
        if (!openPos && lastClobDown && refAtLastClob != null) {
          const refMove = event.price - refAtLastClob;
          const distToStrike = Math.abs(event.price - strike);

          // NEAR-STRIKE filter: only trigger when ref is within $200 of strike
          if (distToStrike < 200 && Math.abs(refMove) >= 50) {
            // ref dropped → buy DOWN (expect DOWN mid to rise)
            if (refMove < 0) {
              const entryPrice = lastClobDown.ask + 0.005;
              if (entryPrice > 0 && entryPrice < 1) {
                openPos = { entryPrice, entryTs: event.ts, entryBid: lastClobDown.bid, refMove, distToStrike };
              }
            }
          }
        }
      } else if (event.source === 'clobDown') {
        // Check exit for open position
        if (openPos) {
          const currentBid = event.bid - 0.005;
          const holdMs = event.ts - openPos.entryTs;

          // Take profit at various levels
          for (const tp of [0.01, 0.02, 0.03, 0.05]) {
            if (currentBid >= openPos.entryPrice + tp) {
              tradeResults.push({
                closeTime, strike, resolved, distToStrike: openPos.distToStrike,
                entryPrice: openPos.entryPrice, exitPrice: currentBid,
                holdMs, pnl: currentBid - openPos.entryPrice,
                exitReason: `tp_${tp}`, refMove: openPos.refMove,
              });
              openPos = null;
              break;
            }
          }

          // Timeout at 30s
          if (openPos && holdMs >= 30000) {
            tradeResults.push({
              closeTime, strike, resolved, distToStrike: openPos.distToStrike,
              entryPrice: openPos.entryPrice, exitPrice: currentBid,
              holdMs, pnl: currentBid - openPos.entryPrice,
              exitReason: 'timeout', refMove: openPos.refMove,
            });
            openPos = null;
          }
        }

        lastClobDown = { mid: event.mid, bid: event.bid, ask: event.ask, ts: event.ts };
        // Find most recent polyRef for snapshot
        refAtLastClob = null;
        for (let i = timeline.indexOf(event) - 1; i >= 0; i--) {
          if (timeline[i].source === 'polyref') { refAtLastClob = timeline[i].price; break; }
        }
      }
    }

    // Settlement for open position
    if (openPos) {
      const won = resolved === 'DOWN';
      const exitPrice = won ? 1.0 : 0.0;
      tradeResults.push({
        closeTime, strike, resolved, distToStrike: openPos.distToStrike,
        entryPrice: openPos.entryPrice, exitPrice,
        holdMs: closeTimeMs - openPos.entryTs,
        pnl: exitPrice - openPos.entryPrice,
        exitReason: 'settlement', refMove: openPos.refMove,
      });
    }

    processed++;
    if (processed % 50 === 0) process.stdout.write(`  Processed ${processed}/${clobWindows.rows.length}...\r`);
  }
  console.log(`  Processed ${processed}/${clobWindows.rows.length} windows                    \n`);

  console.log(`  Total trades: ${tradeResults.length}\n`);

  if (tradeResults.length > 0) {
    // Summary by exit reason
    const byExit = {};
    for (const t of tradeResults) {
      if (!byExit[t.exitReason]) byExit[t.exitReason] = { count: 0, wins: 0, totalPnl: 0, holds: [] };
      byExit[t.exitReason].count++;
      if (t.pnl > 0) byExit[t.exitReason].wins++;
      byExit[t.exitReason].totalPnl += t.pnl;
      byExit[t.exitReason].holds.push(t.holdMs);
    }

    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  Exit Reason │ Trades │ Win Rate │ Total PnL │ Avg PnL │ Med Hold');
    console.log('  ──────────────────────────────────────────────────────────────────');
    for (const [reason, data] of Object.entries(byExit).sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
      console.log(
        `  ${reason.padEnd(12)} │ ${String(data.count).padStart(6)} │ ${(data.wins / data.count * 100).toFixed(1).padStart(6)}% │ $${data.totalPnl.toFixed(2).padStart(8)} │ $${(data.totalPnl / data.count).toFixed(4).padStart(7)} │ ${(median(data.holds) / 1000).toFixed(1).padStart(6)}s`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────\n');

    // Show individual trades
    if (tradeResults.length <= 50) {
      console.log('  Trade log:');
      for (const t of tradeResults) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(`    ${et} | dist=$${t.distToStrike.toFixed(0).padStart(4)} | refΔ=$${t.refMove.toFixed(0).padStart(5)} | entry=$${t.entryPrice.toFixed(3)} | ${t.exitReason.padEnd(10)} | hold=${(t.holdMs/1000).toFixed(1).padStart(5)}s | ${t.resolved.padEnd(4)} | ${pnlStr}`);
      }
    }
  }

  console.log(`\n  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('v2 failed:', err); pool.end(); process.exit(1); });
