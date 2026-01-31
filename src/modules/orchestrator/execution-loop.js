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
          }
        }
      }

      // 3. Process entry signals through position sizing (Story 3.3)
      let sizingResults = [];
      if (entrySignals.length > 0 && this.modules['position-sizer']) {
        const positionSizer = this.modules['position-sizer'];

        for (const signal of entrySignals) {
          try {
            const sizingResult = await positionSizer.calculateSize(signal, {
              getOrderBook: this.modules.polymarket?.getOrderBook?.bind(this.modules.polymarket),
              getCurrentExposure: this.modules['position-manager']?.getCurrentExposure?.bind(this.modules['position-manager']),
            });

            sizingResults.push(sizingResult);

            if (sizingResult.success) {
              this.log.info('position_sized', {
                window_id: sizingResult.window_id,
                requested_size: sizingResult.requested_size,
                actual_size: sizingResult.actual_size,
                adjustment_reason: sizingResult.adjustment_reason,
              });

              // Future: Pass to order-manager for execution (Story 3.4+)
              // await this.modules['order-manager'].placeOrder({...});
            } else {
              this.log.warn('position_sizing_rejected', {
                window_id: signal.window_id,
                reason: sizingResult.adjustment_reason,
                rejection_code: sizingResult.rejection_code,
              });
            }
          } catch (sizingErr) {
            this.log.error('position_sizing_error', {
              window_id: signal.window_id,
              error: sizingErr.message,
              code: sizingErr.code,
            });
          }
        }
      }

      // 4. Evaluate exit conditions - stop-loss (Story 3.4)
      let stopLossResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
      if (this.modules['stop-loss'] && this.modules['position-manager']) {
        const stopLossModule = this.modules['stop-loss'];
        const positionManager = this.modules['position-manager'];

        // Get all open positions
        const openPositions = positionManager.getPositions();

        if (openPositions.length > 0) {
          // Get current price for each position
          const getCurrentPrice = (position) => {
            // Use position's current_price if available, otherwise fetch from spot
            if (position.current_price) {
              return position.current_price;
            }
            // Fallback to spot price
            if (spotData?.price) {
              return spotData.price;
            }
            return null;
          };

          stopLossResults = stopLossModule.evaluateAll(openPositions, getCurrentPrice);

          // Close any triggered positions
          for (const result of stopLossResults.triggered) {
            try {
              await positionManager.closePosition(result.position_id, {
                emergency: true,
                closePrice: result.current_price,
                reason: 'stop_loss_triggered',
              });

              this.log.info('stop_loss_position_closed', {
                position_id: result.position_id,
                window_id: result.window_id,
                entry_price: result.entry_price,
                close_price: result.current_price,
                stop_loss_threshold: result.stop_loss_threshold,
                loss_amount: result.loss_amount,
                loss_pct: result.loss_pct,
              });
            } catch (closeErr) {
              this.log.error('stop_loss_close_failed', {
                position_id: result.position_id,
                error: closeErr.message,
                code: closeErr.code,
              });
            }
          }
        }
      }

      // 5. Evaluate exit conditions - take-profit (Story 3.5)
      let takeProfitResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
      if (this.modules['take-profit'] && this.modules['position-manager']) {
        const takeProfitModule = this.modules['take-profit'];
        const positionManager = this.modules['position-manager'];

        // Get all open positions (positions not already closed by stop-loss)
        const openPositions = positionManager.getPositions();

        if (openPositions.length > 0) {
          // Get current price for each position
          const getCurrentPrice = (position) => {
            // Use position's current_price if available, otherwise fetch from spot
            if (position.current_price) {
              return position.current_price;
            }
            // Fallback to spot price
            if (spotData?.price) {
              return spotData.price;
            }
            return null;
          };

          takeProfitResults = takeProfitModule.evaluateAll(openPositions, getCurrentPrice);

          // Close any triggered positions (limit order, not emergency)
          for (const result of takeProfitResults.triggered) {
            try {
              await positionManager.closePosition(result.position_id, {
                // Note: NOT emergency - use limit order for better fills
                closePrice: result.current_price,
                reason: 'take_profit_triggered',
              });

              this.log.info('take_profit_position_closed', {
                position_id: result.position_id,
                window_id: result.window_id,
                entry_price: result.entry_price,
                close_price: result.current_price,
                take_profit_threshold: result.take_profit_threshold,
                profit_amount: result.profit_amount,
                profit_pct: result.profit_pct,
              });
            } catch (closeErr) {
              this.log.error('take_profit_close_failed', {
                position_id: result.position_id,
                error: closeErr.message,
                code: closeErr.code,
              });
            }
          }
        }
      }

      // 6. Future: Process any pending orders
      // 7. Future: Check window expiry (Story 3.6)

      const tickDurationMs = Date.now() - tickStart;
      this.log.info('tick_complete', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        spotPrice: spotData?.price || null,
        entrySignalsCount: entrySignals.length,
        sizingResultsCount: sizingResults.length,
        sizingSuccessCount: sizingResults.filter(r => r.success).length,
        stopLossEvaluated: stopLossResults.summary.evaluated,
        stopLossTriggered: stopLossResults.summary.triggered,
        takeProfitEvaluated: takeProfitResults.summary.evaluated,
        takeProfitTriggered: takeProfitResults.summary.triggered,
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
