/**
 * Filter: Once Per Window
 *
 * Ensures only one trade entry per trading window.
 * Must be reset via reset() on window open.
 *
 * Covers: FR7 (filter building block library)
 */

export const name = 'once-per-window';

export const description =
  'Allows at most one entry per trading window. Resets on window open.';

export const paramSchema = {};

/**
 * @param {Object} params
 * @returns {Function & { reset: Function }} (state, config, signalResult) => boolean
 */
export function create(params = {}) {
  let hasFired = false;

  function filter() {
    if (hasFired) return false;
    hasFired = true;
    return true;
  }

  filter.reset = function () {
    hasFired = false;
  };

  return filter;
}
