/**
 * Tick Evaluator — Per-Tick Strategy Loop
 *
 * The hot path: on each CLOB WS book update, updates LiveMarketState,
 * evaluates the strategy, routes signals to the order tracker, and
 * checks for paper fills.
 *
 * @module modules/passive-mm/tick-evaluator
 */

/**
 * Create a tick evaluator for a single window.
 *
 * @param {Object} opts
 * @param {Object} opts.liveState - LiveMarketState adapter
 * @param {Object} opts.orderTracker - OrderTracker instance
 * @param {Object} opts.strategy - Strategy module (evaluate, onPassiveFill)
 * @param {Object} opts.strategyConfig - Strategy config overrides
 * @param {'PAPER'|'LIVE'} opts.mode - Trading mode
 * @param {string} opts.windowId - Window identifier
 * @param {Object} opts.log - Logger instance
 * @returns {Object} Tick evaluator with onBookUpdate method
 */
export function createTickEvaluator({ liveState, orderTracker, strategy, strategyConfig, mode, windowId, log }) {
  let tickCount = 0;
  let signalCount = 0;
  let lastLogTick = 0;

  return {
    /**
     * Handle a book update from CLOB WS.
     *
     * @param {'up'|'down'} side - Which token side updated
     * @param {Object} book - CLOB WS book snapshot
     */
    onBookUpdate(side, book) {
      // 1. Update LiveMarketState with L2 data
      liveState.processL2Update(side, book);

      // 2. Update time to close
      liveState.updateTimeToCloseMs(Date.now());

      // 3. Evaluate strategy
      const signals = strategy.evaluate(liveState.state, strategyConfig);

      // 4. Route signals to order tracker
      if (signals && signals.length > 0) {
        for (const signal of signals) {
          orderTracker.handleSignal(signal, liveState.state, windowId);
          signalCount++;
        }
      }

      // 5. Check paper fills on every tick
      if (mode === 'PAPER') {
        orderTracker.checkPaperFills(liveState.state);
      }

      tickCount++;

      // Log progress periodically (every 500 ticks)
      if (tickCount - lastLogTick >= 500) {
        const ttc = liveState.state?.window?.timeToCloseMs;
        const orders = orderTracker.getWindowOrders();
        log.info('tick_progress', {
          windowId,
          ticks: tickCount,
          signals: signalCount,
          timeToCloseMs: ttc != null ? Math.round(ttc) : null,
          resting: orders.restingOrders,
          fills: orders.fills,
          upCost: orders.upCost.toFixed(2),
          downCost: orders.downCost.toFixed(2),
        });
        lastLogTick = tickCount;
      }
    },

    /**
     * Get evaluator stats.
     */
    getStats() {
      return { tickCount, signalCount };
    },
  };
}
