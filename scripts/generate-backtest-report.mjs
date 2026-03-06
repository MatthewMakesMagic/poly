#!/usr/bin/env node

/**
 * Generate comprehensive backtest report from DB results.
 * Queries backtest_trades and backtest_runs for a completed run
 * and produces a structured markdown report.
 *
 * Usage:
 *   node scripts/generate-backtest-report.mjs                    # latest completed run
 *   node scripts/generate-backtest-report.mjs --run=<run_id>     # specific run
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import persistence from '../src/persistence/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';

const RUN_ID = process.argv.find(a => a.startsWith('--run='))?.split('=')[1] || null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    try {
      const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) process.env.DATABASE_URL = match[1];
    } catch { /* ignore */ }
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  await initLogger({ logging: { level: 'error', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 1, max: 3, connectionTimeoutMs: 30000 },
      circuitBreakerPool: { min: 1, max: 1, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 120000,
      retry: { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 5000 },
    },
  });
}

function round(v, d = 2) {
  if (v == null || !Number.isFinite(+v)) return 0;
  return Math.round(+v * 10 ** d) / 10 ** d;
}

async function main() {
  await initDb();

  // Get the run
  let run;
  if (RUN_ID) {
    run = await persistence.get('SELECT * FROM backtest_runs WHERE run_id = $1', [RUN_ID]);
  } else {
    run = await persistence.get("SELECT * FROM backtest_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1");
  }

  if (!run) {
    console.error('No completed backtest run found');
    process.exit(1);
  }

  console.log(`Generating report for run ${run.run_id} (${run.status})`);

  // Get all trades
  const trades = await persistence.all(
    'SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY strategy, symbol, window_epoch',
    [run.run_id]
  );

  console.log(`Total trades: ${trades.length}`);

  // Get summary by strategy x symbol
  const summary = await persistence.all(`
    SELECT strategy, symbol,
           MAX(strategy_description) as description,
           COUNT(*) as trades,
           SUM(CASE WHEN won THEN 1 ELSE 0 END) as wins,
           ROUND(SUM(CASE WHEN won THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
           SUM(pnl)::numeric as total_pnl,
           AVG(pnl)::numeric as avg_pnl,
           AVG(entry_price)::numeric as avg_entry,
           AVG(cost)::numeric as avg_cost,
           AVG(size)::numeric as avg_tokens,
           CASE WHEN AVG(cost) > 0 THEN AVG(pnl) / AVG(cost) * 100 ELSE 0 END as roc
    FROM backtest_trades WHERE run_id = $1
    GROUP BY strategy, symbol
    ORDER BY strategy, symbol
  `, [run.run_id]);

  // Get per-strategy totals
  const strategyTotals = await persistence.all(`
    SELECT strategy,
           MAX(strategy_description) as description,
           COUNT(*) as trades,
           SUM(CASE WHEN won THEN 1 ELSE 0 END) as wins,
           ROUND(SUM(CASE WHEN won THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
           SUM(pnl)::numeric as total_pnl,
           AVG(pnl)::numeric as avg_pnl
    FROM backtest_trades WHERE run_id = $1
    GROUP BY strategy
    ORDER BY SUM(pnl) DESC
  `, [run.run_id]);

  // Get per-instrument totals
  const instrumentTotals = await persistence.all(`
    SELECT symbol,
           COUNT(*) as trades,
           SUM(CASE WHEN won THEN 1 ELSE 0 END) as wins,
           ROUND(SUM(CASE WHEN won THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
           SUM(pnl)::numeric as total_pnl,
           AVG(pnl)::numeric as avg_pnl
    FROM backtest_trades WHERE run_id = $1
    GROUP BY symbol
    ORDER BY SUM(pnl) DESC
  `, [run.run_id]);

  // Cheap entry analysis by strategy and price bucket
  const cheapBuckets = await persistence.all(`
    SELECT strategy, symbol,
           CASE
             WHEN entry_price < 0.10 THEN '<$0.10'
             WHEN entry_price < 0.20 THEN '$0.10-0.20'
             WHEN entry_price < 0.30 THEN '$0.20-0.30'
             ELSE '>$0.30'
           END as bucket,
           COUNT(*) as trades,
           SUM(CASE WHEN won THEN 1 ELSE 0 END) as wins,
           ROUND(SUM(CASE WHEN won THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
           SUM(pnl)::numeric as total_pnl,
           AVG(entry_price)::numeric as avg_entry,
           AVG(size)::numeric as avg_tokens
    FROM backtest_trades WHERE run_id = $1
    GROUP BY strategy, symbol,
             CASE
               WHEN entry_price < 0.10 THEN '<$0.10'
               WHEN entry_price < 0.20 THEN '$0.10-0.20'
               WHEN entry_price < 0.30 THEN '$0.20-0.30'
               ELSE '>$0.30'
             END
    ORDER BY strategy, symbol, bucket
  `, [run.run_id]);

  // Top 30 most profitable cheap trades
  const topCheap = await persistence.all(`
    SELECT strategy, symbol, direction, entry_price, size, cost, pnl, won, reason, confidence
    FROM backtest_trades
    WHERE run_id = $1 AND entry_price < 0.20
    ORDER BY pnl DESC
    LIMIT 30
  `, [run.run_id]);

  // Worst 10 cheap losses
  const worstCheap = await persistence.all(`
    SELECT strategy, symbol, direction, entry_price, size, cost, pnl, won, reason
    FROM backtest_trades
    WHERE run_id = $1 AND entry_price < 0.20 AND pnl < 0
    ORDER BY pnl ASC
    LIMIT 10
  `, [run.run_id]);

  // Overall stats
  const totalTrades = trades.length;
  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const totalWins = trades.filter(t => t.won).length;
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

  const config = typeof run.config === 'string' ? JSON.parse(run.config) : (run.config || {});
  const durationSec = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000)
    : null;

  // ─── BUILD REPORT ───
  const lines = [];
  const w = (s) => lines.push(s);

  w('# Backtest Results Report');
  w('');
  w(`**Run ID**: \`${run.run_id}\``);
  w(`**Date**: ${new Date(run.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  w(`**Duration**: ${durationSec ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : 'N/A'}`);
  w(`**Strategies**: ${config.totalStrategies || strategyTotals.length}`);
  w(`**Instruments**: ${config.totalSymbols || instrumentTotals.length} (${instrumentTotals.map(i => i.symbol).join(', ')})`);
  w(`**Windows**: ${config.totalWindows || run.total_windows}`);
  w(`**Capital/Trade**: $${config.capitalPerTrade || 2}`);
  w('');

  // 1. Overall Summary
  w('## 1. Overall Summary');
  w('');
  w(`| Metric | Value |`);
  w(`|--------|-------|`);
  w(`| Total Trades | ${totalTrades} |`);
  w(`| Total PnL | $${round(totalPnl)} |`);
  w(`| Win Rate | ${round(overallWR, 1)}% |`);
  w(`| Wins / Losses | ${totalWins} / ${totalTrades - totalWins} |`);
  w(`| Best Strategy | ${strategyTotals[0]?.strategy} ($${round(+strategyTotals[0]?.total_pnl)}) |`);
  w(`| Worst Strategy | ${strategyTotals[strategyTotals.length - 1]?.strategy} ($${round(+strategyTotals[strategyTotals.length - 1]?.total_pnl)}) |`);
  w('');

  // 2. Per-Instrument Breakdown
  w('## 2. Per-Instrument Breakdown');
  w('');
  w('| Instrument | Trades | Wins | WR% | Total PnL | Avg PnL |');
  w('|------------|--------|------|-----|-----------|---------|');
  for (const inst of instrumentTotals) {
    const pnl = round(+inst.total_pnl);
    w(`| ${inst.symbol} | ${inst.trades} | ${inst.wins} | ${inst.win_rate}% | $${pnl} | $${round(+inst.avg_pnl, 4)} |`);
  }
  w('');

  // 3. Per-Strategy Breakdown
  w('## 3. Per-Strategy Breakdown');
  w('');
  for (const strat of strategyTotals) {
    w(`### ${strat.strategy}`);
    w(`> ${strat.description || 'No description'}`);
    w('');
    w('| Symbol | Trades | Wins | WR% | Total PnL | Avg Entry | Avg Cost | ROC% | Avg Tokens |');
    w('|--------|--------|------|-----|-----------|-----------|----------|------|------------|');
    const rows = summary.filter(s => s.strategy === strat.strategy);
    for (const r of rows) {
      w(`| ${r.symbol} | ${r.trades} | ${r.wins} | ${r.win_rate}% | $${round(+r.total_pnl)} | $${round(+r.avg_entry, 4)} | $${round(+r.avg_cost, 4)} | ${round(+r.roc, 1)}% | ${round(+r.avg_tokens, 1)} |`);
    }
    w('');
  }

  // 4. Cheap Entry Analysis
  w('## 4. Cheap Entry Analysis');
  w('');
  w('At $0.08 entry: $2 buys 25 tokens, win pays $25 = $23 profit (1,150% ROC)');
  w('At $0.15 entry: $2 buys 13.3 tokens, win pays $13.33 = $11.33 profit (567% ROC)');
  w('');
  w('| Strategy | Symbol | Bucket | Trades | Wins | WR% | Total PnL | Avg Entry | Avg Tokens |');
  w('|----------|--------|--------|--------|------|-----|-----------|-----------|------------|');
  for (const b of cheapBuckets) {
    if (+b.trades === 0) continue;
    w(`| ${b.strategy} | ${b.symbol} | ${b.bucket} | ${b.trades} | ${b.wins} | ${b.win_rate}% | $${round(+b.total_pnl)} | $${round(+b.avg_entry, 4)} | ${round(+b.avg_tokens, 1)} |`);
  }
  w('');

  // 5. Top 30 Profitable Cheap Trades
  w('## 5. Top 30 Most Profitable Cheap Trades (entry < $0.20)');
  w('');
  w('| # | Strategy | Symbol | Dir | Entry$ | Tokens | Cost$ | PnL$ | ROC% | Won | Reason |');
  w('|---|----------|--------|-----|--------|--------|-------|------|------|-----|--------|');
  for (let i = 0; i < topCheap.length; i++) {
    const t = topCheap[i];
    const roc = +t.cost > 0 ? round(+t.pnl / +t.cost * 100, 0) : 0;
    w(`| ${i + 1} | ${t.strategy} | ${t.symbol} | ${(t.direction || '').toUpperCase()} | $${round(+t.entry_price, 4)} | ${round(+t.size, 1)} | $${round(+t.cost, 2)} | $${round(+t.pnl, 2)} | ${roc}% | ${t.won ? 'Y' : 'N'} | ${(t.reason || '').slice(0, 40)} |`);
  }
  w('');

  // 6. Worst 10 Cheap Losses
  w('## 6. Worst 10 Cheap Entry Losses (entry < $0.20)');
  w('');
  if (worstCheap.length > 0) {
    w('| # | Strategy | Symbol | Dir | Entry$ | Tokens | Cost$ | PnL$ | Reason |');
    w('|---|----------|--------|-----|--------|--------|-------|------|--------|');
    for (let i = 0; i < worstCheap.length; i++) {
      const t = worstCheap[i];
      w(`| ${i + 1} | ${t.strategy} | ${t.symbol} | ${(t.direction || '').toUpperCase()} | $${round(+t.entry_price, 4)} | ${round(+t.size, 1)} | $${round(+t.cost, 2)} | $${round(+t.pnl, 2)} | ${(t.reason || '').slice(0, 40)} |`);
    }
  } else {
    w('No cheap entry losses found.');
  }
  w('');

  // 7. AI Commentary placeholder
  w('## 7. Commentary');
  w('');
  if (run.ai_commentary) {
    w(run.ai_commentary);
  } else {
    w('*AI commentary will be generated after review.*');
  }
  w('');

  const report = lines.join('\n');
  const outPath = resolve(process.cwd(), 'docs/BACKTESTUPDATE020326-results.md');
  writeFileSync(outPath, report);
  console.log(`\nReport written to ${outPath}`);
  console.log(`${totalTrades} trades, $${round(totalPnl)} total PnL, ${round(overallWR, 1)}% WR`);

  await persistence.shutdown();
}

main().catch(err => { console.error(err.message); console.error(err.stack); process.exit(1); });
