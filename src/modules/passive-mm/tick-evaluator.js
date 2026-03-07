/**
 * Tick Evaluator v2 — Latch + Reconcile on Every Tick
 *
 * On each CLOB WS book update:
 *   1. Update LiveMarketState with L2 data
 *   2. Call strategy.getDesiredQuotes() (pure, sync)
 *   3. Latch desired state onto reconciler
 *   4. PAPER: runOnce() (async but PAPER path is sync — errors caught)
 *   5. Handle aggressive hedge in exit window (guarded against duplicates)
 *
 * LIVE mode: reconciler.start() runs on a 250ms timer (set up by index.js).
 * Tick evaluator only latches desired state; reconciler picks it up async.
 *
 * @module modules/passive-mm/tick-evaluator
 */

/**
 * @param {Object} opts
 * @param {Object} opts.liveState - LiveMarketState adapter
 * @param {Object} opts.reconciler - Reconciler instance
 * @param {Object} opts.orderTracker - OrderTracker instance
 * @param {Object} opts.strategy - Strategy module (getDesiredQuotes)
 * @param {Object} opts.strategyConfig - Strategy config
 * @param {'PAPER'|'LIVE'} opts.mode
 * @param {string} opts.windowId
 * @param {Object} opts.log
 * @param {Function} [opts.onOrderPlaced] - Stats callback
 * @returns {Object}
 */
export function createTickEvaluator({ liveState, reconciler, orderTracker, strategy, strategyConfig, mode, windowId, log }) {
  let tickCount = 0;
  let lastLogTick = 0;
  let hedgePending = false; // Guard against duplicate aggressive hedges

  const {
    aggressiveHedgeMs = 15000,
    maxHedgePrice = 0.70,
    minPairEdge = 0.02,
    capitalPerEntry = 2,
    maxPerSide = 10,
  } = strategyConfig;

  return {
    /**
     * Handle a book update from CLOB WS.
     * The book is passed directly from the WS callback (no re-fetch).
     *
     * @param {'up'|'down'} side - Which token side updated
     * @param {Object} book - CLOB WS book snapshot
     */
    onBookUpdate(side, book) {
      // 1. Update LiveMarketState with L2 data
      liveState.processL2Update(side, book);

      // 2. Update time to close
      liveState.updateTimeToCloseMs(Date.now());

      const state = liveState.state;

      // 3. Get desired quotes from strategy (pure, sync)
      const desired = strategy.getDesiredQuotes(state, strategyConfig);

      // 4. Latch onto reconciler
      reconciler.setDesired(desired);

      // 5. PAPER mode: reconcile + fill check on every tick.
      //    runOnce is async (returns Promise) but PAPER code path is fully sync
      //    so the promise resolves in the microtask queue before next event-loop tick.
      //    We catch rejections to avoid swallowing errors.
      if (mode === 'PAPER') {
        reconciler.runOnce(state).catch(err => {
          log.error('paper_reconcile_error', { windowId, error: err.message });
        });
      }

      // 6. Aggressive hedge in exit window (one-shot, bypasses reconciler)
      handleAggressiveHedge(state);

      tickCount++;

      // Log progress periodically
      if (tickCount - lastLogTick >= 500) {
        const ttc = state?.window?.timeToCloseMs;
        const orders = orderTracker.getWindowOrders();
        const reconStats = reconciler.getStats();
        log.info('tick_progress', {
          windowId,
          ticks: tickCount,
          reconciles: reconStats.reconcileCount,
          ops: reconStats.opsExecuted,
          timeToCloseMs: ttc != null ? Math.round(ttc) : null,
          resting: orders.restingOrders,
          fills: orders.fills,
          upCost: orders.upCost.toFixed(2),
          downCost: orders.downCost.toFixed(2),
        });
        lastLogTick = tickCount;
      }
    },

    getStats() {
      const reconStats = reconciler.getStats();
      return {
        tickCount,
        signalCount: reconStats.opsExecuted, // compat with v1 dashboard
      };
    },
  };

  /**
   * Aggressive hedge: FOK buy if lopsided in exit window.
   * This is a one-shot action, bypasses the reconciler.
   *
   * hedgePending flag prevents duplicate sends — set synchronously before
   * the async call, cleared when it resolves. In PAPER mode, aggressiveBuy
   * body is fully sync (recordFill runs inline) so inventory updates before
   * the next tick and the flag is cleared immediately.
   */
  function handleAggressiveHedge(state) {
    if (hedgePending) return; // Previous hedge still in-flight

    const win = state?.window;
    if (!win || win.timeToCloseMs == null) return;
    if (win.timeToCloseMs > aggressiveHedgeMs || win.timeToCloseMs <= 5000) return;

    const mm = state._mm;
    if (!mm) return;

    const { clobUp, clobDown } = state;

    // One-sided UP → hedge with DOWN
    if (mm.upTokens > 0 && mm.downTokens === 0 && mm.downCost < maxPerSide) {
      const avgUpPrice = mm.upCost / mm.upTokens;
      const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
      const askDown = clobDown?.bestAsk;
      if (askDown > 0.01 && askDown < maxDownPrice && askDown <= maxHedgePrice) {
        hedgePending = true;
        orderTracker.aggressiveBuy('down', capitalPerEntry, state)
          .catch(err => log.warn('aggressive_hedge_error', { side: 'down', error: err.message }))
          .finally(() => { hedgePending = false; });
        return; // Only one hedge per tick
      }
    }

    // One-sided DOWN → hedge with UP
    if (mm.downTokens > 0 && mm.upTokens === 0 && mm.upCost < maxPerSide) {
      const avgDownPrice = mm.downCost / mm.downTokens;
      const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
      const askUp = clobUp?.bestAsk;
      if (askUp > 0.01 && askUp < maxUpPrice && askUp <= maxHedgePrice) {
        hedgePending = true;
        orderTracker.aggressiveBuy('up', capitalPerEntry, state)
          .catch(err => log.warn('aggressive_hedge_error', { side: 'up', error: err.message }))
          .finally(() => { hedgePending = false; });
      }
    }
  }
}
