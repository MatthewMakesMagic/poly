/**
 * Execution Loop
 *
 * Main trading loop coordinator that runs at a configurable interval.
 * Fetches market data and coordinates module operations.
 *
 * States:
 * - stopped: Loop not running
 * - running: Loop actively processing ticks
 * - paused: Loop suspended (can resume without reinit)
 */

import { LoopState } from './types.js';

/**
 * ExecutionLoop class - manages the main trading loop
 */
export class ExecutionLoop {
  /**
   * @param {Object} params - Constructor parameters
   * @param {Object} params.config - Orchestrator configuration
   * @param {Object} params.modules - References to initialized modules
   * @param {Object} params.log - Logger instance
   * @param {Function} params.onError - Error handler callback
   */
  constructor({ config, modules, log, onError }) {
    this.config = config;
    this.modules = modules;
    this.log = log;
    this.onError = onError;

    // State
    this.state = LoopState.STOPPED;
    this.tickCount = 0;
    this.lastTickAt = null;
    this.tickInProgress = false;
    this.intervalId = null;
  }

  /**
   * Start the execution loop
   */
  start() {
    if (this.state === LoopState.RUNNING) {
      this.log.debug('loop_already_running');
      return;
    }

    this.state = LoopState.RUNNING;
    this.log.info('execution_loop_started', {
      tickIntervalMs: this.config.tickIntervalMs,
    });

    // Start the interval
    this.intervalId = setInterval(
      () => this._onTick(),
      this.config.tickIntervalMs
    );

    // Immediate first tick
    this._onTick();
  }

  /**
   * Stop the execution loop
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.state = LoopState.STOPPED;
    this.log.info('execution_loop_stopped', { tickCount: this.tickCount });
  }

  /**
   * Pause the execution loop (can be resumed)
   */
  pause() {
    if (this.state !== LoopState.RUNNING) {
      this.log.debug('loop_not_running_cannot_pause', { state: this.state });
      return;
    }
    this.state = LoopState.PAUSED;
    this.log.info('execution_loop_paused', { tickCount: this.tickCount });
  }

  /**
   * Resume a paused execution loop
   */
  resume() {
    if (this.state !== LoopState.PAUSED) {
      this.log.debug('loop_not_paused_cannot_resume', { state: this.state });
      return;
    }
    this.state = LoopState.RUNNING;
    this.log.info('execution_loop_resumed', { tickCount: this.tickCount });
  }

  /**
   * Get current loop state
   *
   * @returns {Object} Loop state metrics
   */
  getState() {
    return {
      state: this.state,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      tickIntervalMs: this.config.tickIntervalMs,
      tickInProgress: this.tickInProgress,
    };
  }

  /**
   * Internal: Process a single tick
   * @private
   */
  async _onTick() {
    // Don't process if not running (paused or stopped)
    if (this.state !== LoopState.RUNNING) {
      return;
    }

    // Guard against overlapping ticks (slow tick protection)
    if (this.tickInProgress) {
      this.log.warn('tick_skipped_overlap', { tickCount: this.tickCount });
      return;
    }

    this.tickInProgress = true;
    const tickStart = Date.now();

    try {
      this.tickCount++;
      this.lastTickAt = new Date().toISOString();

      this.log.debug('tick_start', { tickCount: this.tickCount });

      // 1. Fetch current spot prices
      let spotData = null;
      if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
        // Get BTC price as the primary reference
        spotData = this.modules.spot.getCurrentPrice('btc');
      }

      // 2. Evaluate strategy entry conditions (Story 3.2)
      let entrySignals = [];
      if (this.modules['strategy-evaluator'] && spotData) {
        const strategyEvaluator = this.modules['strategy-evaluator'];
        if (typeof strategyEvaluator.evaluateEntryConditions === 'function') {
          const marketState = {
            spot_price: spotData.price,
            // Future: Get active windows and their market prices from polymarket client
            windows: [], // Will be populated when window management is implemented
          };

          entrySignals = strategyEvaluator.evaluateEntryConditions(marketState);

          if (entrySignals && entrySignals.length > 0) {
            this.log.info('entry_signals_generated', {
              count: entrySignals.length,
              signals: entrySignals.map(s => ({
                window_id: s.window_id,
                direction: s.direction,
                confidence: s.confidence,
              })),
            });

            // Future: Pass signals to orchestrator for position opening (Story 3.3)
          }
        }
      }

      // 3. Future: Evaluate exit conditions - stop-loss, take-profit (Stories 3.4-3.5)
      // 4. Future: Process any pending orders
      // 5. Future: Check window expiry (Story 3.6)

      const tickDurationMs = Date.now() - tickStart;
      this.log.info('tick_complete', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        spotPrice: spotData?.price || null,
        entrySignalsCount: entrySignals.length,
      });
    } catch (err) {
      const tickDurationMs = Date.now() - tickStart;
      this.log.error('tick_error', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        error: err.message,
        code: err.code,
      });

      // Emit error for orchestrator to handle
      if (this.onError) {
        this.onError(err);
      }
    } finally {
      this.tickInProgress = false;
    }
  }
}
