import { loadWindowTickData, loadWindowsWithGroundTruth, getTickDateRange, close } from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const strat = await import('../src/backtest/strategies/mm-passive-polyref.js');
const dateRange = await getTickDateRange();
const windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
const btcWins = windows.filter(w => w.symbol?.toLowerCase() === 'btc');

const targets = [
  '2026-02-22T06:00:00.000Z',
  '2026-02-22T07:00:00.000Z',
  '2026-02-22T14:15:00.000Z',
];

function merge2(a, b) {
  const t = a.length + b.length;
  const r = new Array(t);
  let i = 0, j = 0, o = 0;
  while (i < a.length && j < b.length) {
    if (a[i]._ms <= b[j]._ms) r[o++] = a[i++];
    else r[o++] = b[j++];
  }
  while (i < a.length) r[o++] = a[i++];
  while (j < b.length) r[o++] = b[j++];
  return r;
}

const strategy = {
  name: strat.name, evaluate: strat.evaluate, onWindowOpen: strat.onWindowOpen,
  onWindowClose: strat.onWindowClose, defaults: strat.defaults,
  usesPassiveOrders: strat.usesPassiveOrders, onPassiveFill: strat.onPassiveFill,
};

for (const tt of targets) {
  const win = btcWins.find(w => new Date(w.window_close_time).toISOString() === tt);
  if (!win) { console.log('Not found:', tt); continue; }

  const data = await loadWindowTickData({ window: win, windowDurationMs: 15 * 60 * 1000 });
  for (const t of data.rtdsTicks) {
    if (t.topic === 'crypto_prices_chainlink') t.source = 'chainlink';
    else if (t.topic === 'crypto_prices') t.source = 'polyRef';
    else t.source = 'rtds_' + t.topic;
  }
  for (const s of data.clobSnapshots) s.source = s.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
  for (const t of data.exchangeTicks) t.source = 'exchange_' + t.exchange;
  for (const t of (data.l2BookTicks || [])) t.source = t.direction === 'down' ? 'l2Down' : 'l2Up';
  precomputeTimestamps(data);

  let tl = merge2(data.rtdsTicks, data.clobSnapshots);
  tl = merge2(tl, data.exchangeTicks);
  if (data.l2BookTicks.length > 0) tl = merge2(tl, data.l2BookTicks);

  const l2Up = data.l2BookTicks.filter(t => t.source === 'l2Up').length;
  const l2Dn = data.l2BookTicks.filter(t => t.source === 'l2Down').length;

  const gt = win.gamma_resolved_direction || win.onchain_resolved_direction || win.resolved_direction || '?';
  const r = evaluateWindow({
    window: win, timeline: tl, strategy, strategyConfig: strategy.defaults,
    initialCapital: 10000, spreadBuffer: 0.005, tradingFee: 0, windowDurationMs: 15 * 60 * 1000,
  });

  const hasUp = r.trades.some(t => t.token?.includes('up'));
  const hasDn = r.trades.some(t => t.token?.includes('down'));
  const passiveUp = r.trades.filter(t => t.token?.includes('up') && t.reason?.includes('passive')).length;
  const passiveDn = r.trades.filter(t => t.token?.includes('down') && t.reason?.includes('passive')).length;
  console.log(`--- ${tt.slice(0, 19)} | ${gt} | ${hasUp && hasDn ? 'PAIRED' : 'ONE-SIDED'} | PnL: $${r.pnl.toFixed(2)} | Trades: ${r.tradesInWindow} | L2: ${l2Up}up/${l2Dn}dn | Passive: ${passiveUp}up/${passiveDn}dn ---`);
  for (const t of r.trades) {
    const type = t.reason?.includes('passive') ? 'PASSIVE' : 'AGGR';
    console.log(`  [${type}] ${t.token} price=${(t.entryPrice || 0).toFixed(3)} pnl=$${(t.pnl || 0).toFixed(3)} | ${t.reason}`);
  }
}
close();
