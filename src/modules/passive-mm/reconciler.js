/**
 * Reconciler — Desired-State Latch + Reconciliation Loop
 *
 * Replaces the FIFO signal queue. Strategy declares desired quotes via
 * getDesiredQuotes() on every tick; reconciler diffs desired vs actual
 * orderMap and executes per-order cancel/place operations.
 *
 * PAPER mode: runOnce() called every tick from tick-evaluator.
 * LIVE mode: 250ms timer reads latest latch and reconciles.
 *
 * @module modules/passive-mm/reconciler
 */

/**
 * @param {Object} opts
 * @param {Object} opts.orderTracker - OrderTracker instance
 * @param {Object} opts.config - { requoteThreshold }
 * @param {Object} opts.log - Logger
 * @returns {Object} Reconciler
 */
export function createReconciler({ orderTracker, config, log }) {
  const requoteThreshold = config.requoteThreshold ?? 0.005;

  // Latch: latest desired state (overwritten, never queued)
  let desired = { up: null, down: null };
  let timerId = null;
  let running = false; // Reentrancy guard — prevents overlapping runOnce cycles
  let stats = { reconcileCount: 0, opsExecuted: 0, lastReconcileMs: 0 };

  /**
   * Latch: overwrite desired state. Called every tick from tick-evaluator.
   */
  function setDesired(quotes) {
    desired = quotes || { up: null, down: null };
  }

  /**
   * Single reconcile cycle. Diffs desired vs orderMap, executes ops.
   * Guarded against reentrancy — if a previous cycle is still in-flight,
   * this call is a no-op (the next cycle will pick up the latest latch).
   *
   * @param {Object} state - Current MarketState (for paper fill checks)
   */
  async function runOnce(state) {
    if (running) return; // Previous cycle still in-flight — skip
    running = true;
    try {
      const start = Date.now();
      stats.reconcileCount++;

      // Fill detection FIRST — before any cancel/place ops.
      // Critical: a fill condition (bestAsk <= resting bid) often coincides with
      // a price move that triggers a requote. If we cancel before checking fills,
      // the filled order is deleted from orderMap and the fill is silently lost.
      // In PAPER mode, checkPaperFills runs synchronously inside the async wrapper,
      // so state._mm is updated before the first await suspends execution.
      await orderTracker.checkFills(state);

      const orderMap = orderTracker.getOrderMap();

      // Reconcile each side independently
      for (const side of ['up', 'down']) {
        const want = desired[side]; // { price, size, capital } | null
        const have = orderMap.get(side) || null; // { orderId, price, ... } | null

        if (!want && !have) {
          continue;
        }

        if (!want && have) {
          await orderTracker.cancelOrder(have.orderId, side);
          stats.opsExecuted++;
          continue;
        }

        if (want && !have) {
          await orderTracker.placeOrder(side, want.price, want.size, want.capital);
          stats.opsExecuted++;
          continue;
        }

        // Both exist — check if price drifted enough to requote
        if (Math.abs(want.price - have.price) >= requoteThreshold) {
          const cancelled = await orderTracker.cancelOrder(have.orderId, side);
          stats.opsExecuted++;
          // Only place replacement if cancel succeeded — if cancel failed,
          // the old order is still resting (kept in orderMap by BUG 18 fix).
          // Next cycle's checkFills will detect if it was actually filled.
          if (cancelled) {
            await orderTracker.placeOrder(side, want.price, want.size, want.capital);
            stats.opsExecuted++;
          }
        }
      }

      stats.lastReconcileMs = Date.now() - start;
    } finally {
      running = false;
    }
  }

  /**
   * Start 250ms reconcile timer (LIVE mode only).
   * @param {Function} getState - Returns current MarketState
   */
  function start(getState) {
    if (timerId) return;
    timerId = setInterval(async () => {
      try {
        await runOnce(getState());
      } catch (err) {
        log.warn('reconciler_error', { error: err.message });
      }
    }, 250);
    if (timerId.unref) timerId.unref();
  }

  /**
   * Stop timer and clear desired state.
   */
  function stop() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    desired = { up: null, down: null };
  }

  function getStats() {
    return { ...stats };
  }

  return {
    setDesired,
    runOnce,
    start,
    stop,
    getStats,
  };
}
