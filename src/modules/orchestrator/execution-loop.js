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

      // 1. Check drawdown limit before evaluating entries (Story 4.4)
      let drawdownCheck = { breached: false, current: 0, limit: 0.05, autoStopped: false };
      let entriesSkipped = false;
      if (this.modules.safety && typeof this.modules.safety.checkDrawdownLimit === 'function') {
        drawdownCheck = this.modules.safety.checkDrawdownLimit();

        if (drawdownCheck.autoStopped) {
          entriesSkipped = true;
          this.log.info('entries_skipped_auto_stop', {
            event: 'auto_stop_active',
            drawdown_pct: (drawdownCheck.current * 100).toFixed(2),
            limit_pct: (drawdownCheck.limit * 100).toFixed(2),
          });
        }
      }

      // 2. Fetch current spot prices
      let spotData = null;
      if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
        // Get BTC price as the primary reference
        spotData = this.modules.spot.getCurrentPrice('btc');
      }

      // 3. Evaluate strategy entry conditions (Story 3.2) - skip if auto-stopped
      let entrySignals = [];
      let windows = [];
      if (!entriesSkipped && this.modules['strategy-evaluator'] && spotData) {
        const strategyEvaluator = this.modules['strategy-evaluator'];
        if (typeof strategyEvaluator.evaluateEntryConditions === 'function') {
          // TEMP SOLUTION: Fetch active windows from window-manager module
          // Production should use WebSocket subscriptions for real-time updates
          if (this.modules['window-manager'] && typeof this.modules['window-manager'].getActiveWindows === 'function') {
            try {
              windows = await this.modules['window-manager'].getActiveWindows();
              if (windows.length > 0) {
                this.log.debug('windows_loaded', {
                  count: windows.length,
                  cryptos: [...new Set(windows.map(w => w.crypto))],
                });
              }
            } catch (windowErr) {
              this.log.warn('window_manager_error', { error: windowErr.message });
              windows = [];
            }
          }

          const marketState = {
            spot_price: spotData.price,
            windows, // Now populated from window-manager module
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

            // Record signal events via trade-event module (Story 5.1, 5.2)
            if (this.modules['trade-event']) {
              for (const signal of entrySignals) {
                try {
                  // Capture market context at signal time (Story 5.2, AC3)
                  let marketContext = {
                    bidAtSignal: signal.bid,
                    askAtSignal: signal.ask,
                    spreadAtSignal: signal.spread,
                    depthAtSignal: signal.depth,
                  };

                  // If polymarket client is available, fetch real-time market context
                  if (this.modules.polymarket && typeof this.modules.polymarket.getMarketContext === 'function' && signal.token_id) {
                    try {
                      const pmContext = await this.modules.polymarket.getMarketContext(signal.token_id);
                      marketContext = {
                        bidAtSignal: pmContext.bidAtSignal,
                        askAtSignal: pmContext.askAtSignal,
                        spreadAtSignal: pmContext.spreadAtSignal,
                        depthAtSignal: pmContext.depthAtSignal,
                      };
                    } catch (ctxErr) {
                      this.log.debug('market_context_fetch_fallback', {
                        window_id: signal.window_id,
                        error: ctxErr.message,
                      });
                      // Keep signal-provided values as fallback
                    }
                  }

                  // Store market context on signal for later use in recordEntry (Story 5.2, AC7)
                  signal.marketContext = marketContext;
                  signal.signalDetectedAt = new Date().toISOString();

                  await this.modules['trade-event'].recordSignal({
                    windowId: signal.window_id,
                    strategyId: signal.strategy_id || 'default',
                    signalType: 'entry',
                    priceAtSignal: spotData?.price || signal.price,
                    expectedPrice: signal.expected_price || signal.price,
                    marketContext,
                  });
                } catch (tradeEventErr) {
                  this.log.warn('trade_event_record_signal_failed', {
                    window_id: signal.window_id,
                    error: tradeEventErr.message,
                  });
                }
              }
            }
          }
        }
      }

      // 4. Process entry signals through position sizing (Story 3.3)
      let sizingResults = [];
      if (!entriesSkipped && entrySignals.length > 0 && this.modules['position-sizer']) {
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

              // Place order via order-manager (Story 3.4+)
              if (this.modules['order-manager'] && signal.token_id) {
                try {
                  const orderResult = await this.modules['order-manager'].placeOrder({
                    tokenId: signal.token_id,
                    side: signal.direction === 'long' ? 'buy' : 'sell',
                    size: sizingResult.actual_size,
                    price: signal.market_price || signal.expected_price,
                    orderType: 'GTC',
                    windowId: signal.window_id,
                    marketId: signal.market_id,
                  });

                  this.log.info('order_placed', {
                    window_id: signal.window_id,
                    order_id: orderResult.orderId,
                    status: orderResult.status,
                    latency_ms: orderResult.latencyMs,
                  });

                  // Record position with position-manager
                  if (this.modules['position-manager'] && orderResult.status !== 'rejected') {
                    const position = this.modules['position-manager'].openPosition({
                      window_id: signal.window_id,
                      market_id: signal.market_id,
                      token_id: signal.token_id,
                      side: signal.direction,
                      size: sizingResult.actual_size,
                      entry_price: signal.market_price || signal.expected_price,
                      order_id: orderResult.orderId,
                    });

                    this.log.info('position_opened', {
                      position_id: position.id,
                      window_id: signal.window_id,
                      side: signal.direction,
                      size: sizingResult.actual_size,
                      entry_price: position.entry_price,
                    });
                  }

                  // Record entry event for diagnostics (Story 5.2)
                  if (this.modules['trade-event']) {
                    await this.modules['trade-event'].recordEntry({
                      windowId: signal.window_id,
                      orderId: orderResult.orderId,
                      strategyId: signal.strategy_id || 'execution-test',
                      timestamps: {
                        signalDetectedAt: signal.signalDetectedAt,
                        orderSubmittedAt: orderResult.timestamps?.orderSubmittedAt,
                        orderFilledAt: orderResult.timestamps?.orderFilledAt,
                      },
                      prices: {
                        priceAtSignal: signal.spot_price,
                        expectedPrice: signal.market_price,
                        priceAtFill: orderResult.fillPrice,
                      },
                      sizes: {
                        requestedSize: sizingResult.requested_size,
                        filledSize: orderResult.filledSize || sizingResult.actual_size,
                      },
                      marketContext: signal.marketContext,
                    });
                  }
                } catch (orderErr) {
                  this.log.error('order_placement_failed', {
                    window_id: signal.window_id,
                    error: orderErr.message,
                    code: orderErr.code,
                  });
                }
              }
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

      // 5. Evaluate exit conditions - stop-loss (Story 3.4) - always evaluate even when auto-stopped
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

              // Record exit event via trade-event module (Story 5.1)
              if (this.modules['trade-event']) {
                try {
                  await this.modules['trade-event'].recordExit({
                    windowId: result.window_id,
                    positionId: result.position_id,
                    orderId: result.order_id,
                    strategyId: result.strategy_id,
                    exitReason: 'stop_loss',
                    timestamps: {
                      signalDetectedAt: result.signal_detected_at,
                      orderFilledAt: new Date().toISOString(),
                    },
                    prices: {
                      priceAtSignal: result.entry_price,
                      priceAtFill: result.current_price,
                      expectedPrice: result.expected_price || result.entry_price,
                    },
                  });
                } catch (tradeEventErr) {
                  this.log.warn('trade_event_record_exit_failed', {
                    position_id: result.position_id,
                    error: tradeEventErr.message,
                  });
                }
              }
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

      // 6. Evaluate exit conditions - take-profit (Story 3.5) - always evaluate even when auto-stopped
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

              // Record exit event via trade-event module (Story 5.1)
              if (this.modules['trade-event']) {
                try {
                  await this.modules['trade-event'].recordExit({
                    windowId: result.window_id,
                    positionId: result.position_id,
                    orderId: result.order_id,
                    strategyId: result.strategy_id,
                    exitReason: 'take_profit',
                    timestamps: {
                      signalDetectedAt: result.signal_detected_at,
                      orderFilledAt: new Date().toISOString(),
                    },
                    prices: {
                      priceAtSignal: result.entry_price,
                      priceAtFill: result.current_price,
                      expectedPrice: result.expected_price || result.entry_price,
                    },
                  });
                } catch (tradeEventErr) {
                  this.log.warn('trade_event_record_exit_failed', {
                    position_id: result.position_id,
                    error: tradeEventErr.message,
                  });
                }
              }
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

      // 7. Evaluate exit conditions - window expiry (Story 3.6) - always evaluate even when auto-stopped
      let windowExpiryResults = { expiring: [], resolved: [], summary: { evaluated: 0, expiring: 0, resolved: 0, safe: 0 } };
      if (this.modules['window-expiry'] && this.modules['position-manager']) {
        const windowExpiryModule = this.modules['window-expiry'];
        const positionManager = this.modules['position-manager'];

        // Get all open positions (positions not already closed by stop-loss/take-profit)
        const openPositions = positionManager.getPositions();

        if (openPositions.length > 0) {
          // Get window data (resolution info) for each window
          const getWindowData = (windowId) => {
            // Future: Query polymarket for window resolution data
            // For now, return empty (window will be checked by timing only)
            // When resolution data is available, it should include:
            // { resolution_price: 0 or 1, resolved_at: ISO timestamp }
            return {};
          };

          windowExpiryResults = windowExpiryModule.evaluateAll(openPositions, getWindowData);

          // Handle resolved positions - close with resolution P&L
          for (const result of windowExpiryResults.resolved) {
            try {
              await positionManager.closePosition(result.position_id, {
                closePrice: result.resolution_price ?? result.current_price,
                reason: 'window_expiry',
                resolution_outcome: result.outcome,
                pnl: result.pnl,
              });

              this.log.info('window_expiry_position_closed', {
                position_id: result.position_id,
                window_id: result.window_id,
                entry_price: result.entry_price,
                resolution_price: result.resolution_price,
                outcome: result.outcome,
                pnl: result.pnl,
                pnl_pct: result.pnl_pct,
              });

              // Record exit event via trade-event module (Story 5.1)
              if (this.modules['trade-event']) {
                try {
                  await this.modules['trade-event'].recordExit({
                    windowId: result.window_id,
                    positionId: result.position_id,
                    orderId: result.order_id,
                    strategyId: result.strategy_id,
                    exitReason: 'window_expiry',
                    timestamps: {
                      signalDetectedAt: result.signal_detected_at,
                      orderFilledAt: new Date().toISOString(),
                    },
                    prices: {
                      priceAtSignal: result.entry_price,
                      priceAtFill: result.resolution_price ?? result.current_price,
                      expectedPrice: result.expected_price || result.entry_price,
                    },
                  });
                } catch (tradeEventErr) {
                  this.log.warn('trade_event_record_exit_failed', {
                    position_id: result.position_id,
                    error: tradeEventErr.message,
                  });
                }
              }
            } catch (closeErr) {
              this.log.error('window_expiry_close_failed', {
                position_id: result.position_id,
                error: closeErr.message,
                code: closeErr.code,
              });
            }
          }

          // Note: Expiring positions are logged but not closed - they will resolve naturally
          // The expiring flag can be used to block new entries in expiring windows
        }
      }

      // 8. Future: Process any pending orders

      const tickDurationMs = Date.now() - tickStart;
      this.log.info('tick_complete', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        spotPrice: spotData?.price || null,
        windowsCount: windows.length,
        autoStopped: drawdownCheck.autoStopped,
        drawdownPct: drawdownCheck.current,
        entriesSkipped,
        entrySignalsCount: entrySignals.length,
        sizingResultsCount: sizingResults.length,
        sizingSuccessCount: sizingResults.filter(r => r.success).length,
        stopLossEvaluated: stopLossResults.summary.evaluated,
        stopLossTriggered: stopLossResults.summary.triggered,
        takeProfitEvaluated: takeProfitResults.summary.evaluated,
        takeProfitTriggered: takeProfitResults.summary.triggered,
        windowExpiryEvaluated: windowExpiryResults.summary.evaluated,
        windowExpiryExpiring: windowExpiryResults.summary.expiring,
        windowExpiryResolved: windowExpiryResults.summary.resolved,
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
