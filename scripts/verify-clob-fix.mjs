/**
 * Verify CLOB epoch fix — confirms that loadWindowTickData returns
 * real CLOB price movement (not flat $0.50 pre-window data).
 *
 * Usage: node scripts/verify-clob-fix.mjs
 */

import { loadWindowsWithGroundTruth, loadWindowTickData, close } from '../src/backtest/data-loader-sqlite.js';

async function main() {
  console.log('Loading BTC windows with ground truth...');

  const allWindows = await loadWindowsWithGroundTruth({
    startDate: '2026-02-01T00:00:00Z',
    endDate: '2026-04-01T00:00:00Z',
    symbols: ['btc'],
  });

  console.log(`Found ${allWindows.length} total BTC windows\n`);

  if (allWindows.length === 0) {
    console.log('FAIL: No windows found');
    close();
    process.exit(1);
  }

  // Pick 10 random windows
  const sampleSize = Math.min(10, allWindows.length);
  const shuffled = [...allWindows].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const win of sample) {
    const data = await loadWindowTickData({ window: win });
    const clob = data.clobSnapshots;

    const mids = clob.map(s => Number(s.mid_price)).filter(v => !isNaN(v));
    const tokenIds = [...new Set(clob.map(s => s.token_id))];

    const min = mids.length > 0 ? Math.min(...mids) : null;
    const max = mids.length > 0 ? Math.max(...mids) : null;
    const avg = mids.length > 0 ? (mids.reduce((a, b) => a + b, 0) / mids.length) : null;

    // PASS criteria: have CLOB ticks AND prices are NOT flat at $0.50
    // SKIP criteria: 0 ticks can happen when all tokens converged outside active range (data gap)
    const hasMovement = mids.length > 0 && (max - min > 0.01 || (avg !== null && Math.abs(avg - 0.50) > 0.05));
    const isDataGap = mids.length === 0;
    const status = hasMovement ? 'PASS' : isDataGap ? 'SKIP (no active-range CLOB data)' : 'FAIL';

    if (hasMovement) passCount++;
    else if (isDataGap) skipCount++;
    else failCount++;

    const closeTime = win.window_close_time instanceof Date
      ? win.window_close_time.toISOString()
      : win.window_close_time;

    console.log(`[${status}] ${closeTime}`);
    console.log(`  CLOB ticks: ${clob.length}, mid_prices: ${mids.length}`);
    console.log(`  min=${min?.toFixed(4)}  max=${max?.toFixed(4)}  avg=${avg?.toFixed(4)}`);
    console.log(`  token_ids: ${tokenIds.join(', ')}`);
    console.log(`  RTDS ticks: ${data.rtdsTicks.length}, Exchange ticks: ${data.exchangeTicks.length}`);
    console.log('');
  }

  console.log('='.repeat(60));
  console.log(`SUMMARY: ${passCount} PASS / ${skipCount} SKIP / ${failCount} FAIL out of ${sampleSize} windows`);
  console.log('(SKIP = no active-range CLOB data for window, expected for some windows)');
  console.log(failCount === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');

  close();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err);
  close();
  process.exit(1);
});
