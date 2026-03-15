/**
 * Seeded PRNG (mulberry32) — fast, deterministic, good distribution.
 *
 * Shared utility used by sampler, backtest-factory, and mutation engine.
 *
 * @param {number} seed
 * @returns {function(): number} Returns values in [0, 1)
 */
export function createPrng(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
