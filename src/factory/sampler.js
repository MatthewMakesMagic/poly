/**
 * Stratified Random Sampler (Story 3.1)
 *
 * Samples windows using stratified random sampling with deterministic seeding.
 * Weekly stratification by default, proportional allocation per stratum.
 * Seeded PRNG ensures reproducibility: same seed + same data = identical samples.
 *
 * Covers: FR16 (sampling), NFR9 (deterministic reproducibility)
 */

import { createPrng } from './utils/prng.js';

/**
 * Fisher-Yates shuffle with seeded PRNG.
 * @param {any[]} arr - Array to shuffle (mutated in place)
 * @param {function} rng - PRNG function returning [0,1)
 * @returns {any[]} The shuffled array
 */
function seededShuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Get the stratum key for a window based on stratification period.
 *
 * @param {string} closeTime - ISO timestamp of window close
 * @param {'weekly'|'daily'|'monthly'} stratify - Stratification period
 * @returns {string} Stratum key (e.g., "2026-W10" or "2026-03-01" or "2026-03")
 */
function getStratumKey(closeTime, stratify) {
  const d = new Date(closeTime);
  const year = d.getUTCFullYear();

  if (stratify === 'daily') {
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (stratify === 'monthly') {
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  // weekly (default): ISO week number
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan1.getUTCDay()) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Sample windows using stratified random sampling.
 *
 * Groups windows by time stratum (weekly by default), allocates samples
 * proportionally, and selects randomly within each stratum using a seeded PRNG.
 *
 * @param {Object[]} windows - Window metadata array (must have window_close_time)
 * @param {Object} [options]
 * @param {number} [options.count=200] - Target sample size
 * @param {number} [options.seed=42] - PRNG seed for reproducibility
 * @param {'weekly'|'daily'|'monthly'} [options.stratify='weekly'] - Stratification period
 * @returns {Object[]} Sampled windows, sorted by window_close_time
 */
export function sampleWindows(windows, options = {}) {
  const {
    count = 200,
    seed = 42,
    stratify = 'weekly',
  } = options;

  if (!windows || windows.length === 0) {
    return [];
  }

  // If fewer windows than requested, return all (sorted)
  if (windows.length <= count) {
    return [...windows].sort((a, b) =>
      a.window_close_time.localeCompare(b.window_close_time)
    );
  }

  const rng = createPrng(seed);

  // Group windows by stratum
  const strata = new Map();
  for (const win of windows) {
    const key = getStratumKey(win.window_close_time, stratify);
    if (!strata.has(key)) {
      strata.set(key, []);
    }
    strata.get(key).push(win);
  }

  // Proportional allocation: each stratum gets floor(count * stratumSize / totalSize)
  // Remainder distributed by largest fractional parts
  const totalSize = windows.length;
  const stratumKeys = [...strata.keys()].sort();
  const allocations = [];
  let allocated = 0;

  for (const key of stratumKeys) {
    const stratumSize = strata.get(key).length;
    const exact = (count * stratumSize) / totalSize;
    const floor = Math.floor(exact);
    allocations.push({ key, floor, remainder: exact - floor });
    allocated += floor;
  }

  // Distribute remaining slots by largest remainder
  let remaining = count - allocated;
  allocations.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining && i < allocations.length; i++) {
    allocations[i].floor++;
  }

  // Sample from each stratum
  const sampled = [];
  for (const { key, floor: sampleSize } of allocations) {
    if (sampleSize === 0) continue;
    const stratumWindows = [...strata.get(key)];
    seededShuffle(stratumWindows, rng);
    const selected = stratumWindows.slice(0, sampleSize);
    sampled.push(...selected);
  }

  // Sort by close time for consistent ordering
  sampled.sort((a, b) =>
    a.window_close_time.localeCompare(b.window_close_time)
  );

  return sampled;
}
