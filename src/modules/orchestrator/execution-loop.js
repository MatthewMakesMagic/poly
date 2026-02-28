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
   * @param {Function} [params.composedStrategy] - Active composed strategy function (Story 7-12)
   * @param {string} [params.composedStrategyName] - Active composed strategy name
   */
  constructor({ config, modules, log, onError, composedStrategy, composedStrategyName }) {
    this.config = config;
    this.modules = modules;
    this.log = log;
    this.onError = onError;
    // Story 7-12: Composed strategy support
    this.composedStrategy = composedStrategy || null;
    this.composedStrategyName = composedStrategyName || null;

    // State
    this.state = LoopState.STOPPED;
    this.tickCount = 0;
    this.lastTickAt = null;
    this.tickInProgress = false;
    this.intervalId = null;
  }

  /**
   * Set the active composed strategy at runtime (Story 7-12)
   *
   * @param {Function|null} strategy - Composed strategy function or null to clear
   * @param {string|null} strategyName - Strategy name for logging
   */
  setComposedStrategy(strategy, strategyName) {
    this.composedStrategy = strategy;
    this.composedStrategyName = strategyName;
    this.log.info('composed_strategy_updated', {
      strategyName: strategyName || 'none (using default)',
      hasStrategy: !!strategy,
    });
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
      // Story 7-12: Strategy state
      activeStrategy: this.composedStrategyName,
      usingComposedStrategy: !!this.composedStrategy,
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

      // 0. Circuit breaker gate - skip entire tick if CB is open (V3 Stage 5)
      if (this.modules['circuit-breaker']) {
        try {
          const cbOpen = await this.modules['circuit-breaker'].isOpen();
          if (cbOpen) {
            this.log.warn('tick_skipped_circuit_breaker_open', {
              tickCount: this.tickCount,
              state: this.modules['circuit-breaker'].getState?.(),
            });
            return;
          }
        } catch (cbErr) {
          // Fail closed - if we can't check, assume OPEN
          this.log.warn('tick_skipped_circuit_breaker_check_failed', {
            tickCount: this.tickCount,
            error: cbErr.message,
            message: 'CB check failed - fail closed, skipping tick',
          });
          return;
        }
      }

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

      // 2. Fetch active windows first (Story 7-20: need windows to know which cryptos to fetch)
      let windows = [];
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

      // 3. Fetch current spot prices for all active cryptos (Story 7-20)
      let spotPrices = {};
      if (this.modules.spot && typeof this.modules.spot.getCurrentPrice === 'function') {
        // Get unique cryptos from windows to fetch appropriate prices
        const cryptos = [...new Set(windows.map(w => w.crypto).filter(Boolean))];

        for (const crypto of cryptos) {
          try {
            const priceData = this.modules.spot.getCurrentPrice(crypto);
            if (priceData) {
              spotPrices[crypto] = priceData;
            }
          } catch (err) {
            this.log.warn('spot_price_fetch_failed', {
              crypto,
              error: err.message,
            });
          }
        }

        if (Object.keys(spotPrices).length > 0) {
          this.log.debug('spot_prices_loaded', {
            cryptos: Object.keys(spotPrices),
            prices: Object.fromEntries(
              Object.entries(spotPrices).map(([k, v]) => [k, v?.price])
            ),
          });
        }
      }

      // Backward compatibility: spotData for existing code that expects single price
      const spotData = spotPrices.btc || Object.values(spotPrices)[0] || null;

      // 4. Evaluate strategy entry conditions (Story 3.2) - skip if auto-stopped
      // Story 7-12: Support for composed strategies via strategy composition framework
      let entrySignals = [];
      if (!entriesSkipped && (spotData || Object.keys(spotPrices).length > 0)) {
        const marketState = {
          spot_price: spotData?.price,
          spotPrices, // Story 7-20: Per-crypto prices for accurate signal calculation
          windows,
        };

        // Story 7-12: Use composed strategy if available, otherwise fall back to strategy-evaluator
        if (this.composedStrategy) {
          // Execute composed strategy
          try {
            const strategyResult = this.composedStrategy(marketState);
            entrySignals = strategyResult.signals || [];

            if (entrySignals.length > 0) {
              this.log.info('composed_strategy_signals', {
                strategy: this.composedStrategyName,
                signalCount: entrySignals.length,
                componentResults: Object.keys(strategyResult.componentResults || {}),
              });
            }
          } catch (strategyErr) {
            this.log.error('composed_strategy_error', {
              strategy: this.composedStrategyName,
              error: strategyErr.message,
            });
            // Fall back to default strategy-evaluator on error
            if (this.modules['strategy-evaluator']) {
              entrySignals = this.modules['strategy-evaluator'].evaluateEntryConditions(marketState);
            }
          }
        } else if (this.modules['strategy-evaluator']) {
          // Default: use strategy-evaluator module
          const strategyEvaluator = this.modules['strategy-evaluator'];
          if (typeof strategyEvaluator.evaluateEntryConditions === 'function') {
            entrySignals = strategyEvaluator.evaluateEntryConditions(marketState);
          }
        }

        if (entrySignals && entrySignals.length > 0) {
          this.log.info('entry_signals_generated', {
            count: entrySignals.length,
            strategy: this.composedStrategyName || 'default',
            trading_mode: this.config.tradingMode || 'PAPER',
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
                  strategyId: signal.strategy_id || this.composedStrategyName || 'default',
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

      // 4. Process entry signals through position sizing (Story 3.3)
      // Story 8-7: Reset per-tick entry counter at start of entry processing
      if (this.modules.safeguards) {
        this.modules.safeguards.resetTickEntries();
      }

      let sizingResults = [];
      let safeguardsBlocked = 0;
      if (!entriesSkipped && entrySignals.length > 0 && this.modules['position-sizer']) {
        const positionSizer = this.modules['position-sizer'];

        for (const signal of entrySignals) {
          // Story 8-9: Get strategy_id from signal for strategy-aware tracking
          const strategyId = signal.strategy_id || this.composedStrategyName || 'default';

          // Story 8-7/8-9: Check safeguards before processing entry
          if (this.modules.safeguards) {
            const openPositions = await this.modules['position-manager']?.getPositions?.() || [];
            const safeguardCheck = await this.modules.safeguards.canEnterPosition(signal, openPositions);

            if (!safeguardCheck.allowed) {
              this.log.info('entry_blocked_by_safeguards', {
                window_id: signal.window_id,
                strategy_id: strategyId,
                symbol: signal.symbol,
                reason: safeguardCheck.reason,
                details: safeguardCheck.details,
                trading_mode: this.config.tradingMode || 'PAPER',
              });
              safeguardsBlocked++;
              continue; // Skip this signal
            }
          }

          try {
            const sizingResult = await positionSizer.calculateSize(signal, {
              getOrderBook: this.modules.polymarket?.getOrderBook?.bind(this.modules.polymarket),
              getCurrentExposure: this.modules['position-manager']?.getCurrentExposure?.bind(this.modules['position-manager']),
            });

            sizingResults.push(sizingResult);

            if (sizingResult.success) {
              this.log.info('position_sized', {
                window_id: sizingResult.window_id,
                strategy_id: strategyId,
                requested_size: sizingResult.requested_size,
                actual_size: sizingResult.actual_size,
                adjustment_reason: sizingResult.adjustment_reason,
                trading_mode: this.config.tradingMode || 'PAPER',
              });

              // TRADING MODE GATE - CRITICAL SAFETY CHECK
              // Blocks order execution in PAPER mode (default)
              const tradingMode = this.config.tradingMode || 'PAPER';
              if (tradingMode !== 'LIVE') {
                // Story 8-9: PAPER mode uses reserve/confirm flow to prevent duplicate paper signals
                let reserved = false;
                if (this.modules.safeguards) {
                  reserved = await this.modules.safeguards.reserveEntry(signal.window_id, strategyId);
                  if (!reserved) {
                    this.log.info('paper_mode_reservation_blocked', {
                      window_id: signal.window_id,
                      strategy_id: strategyId,
                      trading_mode: tradingMode,
                      message: 'Another signal already reserved this entry',
                    });
                    continue;
                  }
                }

                this.log.info('paper_mode_signal', {
                  window_id: signal.window_id,
                  strategy_id: strategyId,
                  direction: signal.direction,
                  side: signal.side || 'UP',
                  confidence: signal.confidence,
                  market_price: signal.market_price,
                  edge: signal.edge,
                  size: sizingResult.actual_size,
                  would_have_traded: true,
                  trading_mode: tradingMode,
                  message: 'Order blocked - PAPER mode active',
                });

                // Create virtual position for PAPER mode tracking
                // Enables stop-loss and take-profit simulation
                if (this.modules['virtual-position-manager']) {
                  try {
                    const virtualPosition = this.modules['virtual-position-manager'].createVirtualPosition({
                      ...signal,
                      size: sizingResult.actual_size,
                      strategy_id: strategyId,
                    });
                    this.log.info('virtual_position_opened', {
                      position_id: virtualPosition.id,
                      window_id: signal.window_id,
                      strategy_id: strategyId,
                      side: signal.side || 'UP',
                      entry_price: signal.market_price,
                      size: sizingResult.actual_size,
                      trading_mode: tradingMode,
                    });
                  } catch (vpErr) {
                    this.log.warn('virtual_position_creation_failed', {
                      window_id: signal.window_id,
                      error: vpErr.message,
                    });
                  }
                }

                // Story 8-9: Confirm the entry in paper mode
                if (this.modules.safeguards && reserved) {
                  await this.modules.safeguards.confirmEntry(signal.window_id, strategyId, signal.symbol);
                }
                continue; // Skip to next signal - NO ORDER EXECUTION
              }

              // Place order via order-manager (Story 3.4+)
              if (this.modules['order-manager'] && signal.token_id) {
                // Story 8-9: Reserve entry BEFORE order placement
                let reserved = false;
                if (this.modules.safeguards) {
                  reserved = await this.modules.safeguards.reserveEntry(signal.window_id, strategyId);
                  if (!reserved) {
                    this.log.info('entry_reservation_blocked', {
                      window_id: signal.window_id,
                      strategy_id: strategyId,
                      trading_mode: tradingMode,
                      message: 'Another signal already reserved this entry',
                    });
                    continue;
                  }
                }

                try {
                  // IOC at model fair value — accept any fill up to what the model
                  // says the token is worth. For cheap entries ($0.05 market) where
                  // model says fair = $0.55, we'll pay up to $0.55 for immediate fill.
                  // Edge is preserved: paying $0.08 for a token worth $0.55 is still +EV.
                  const maxPrice = signal.confidence || signal.market_price || signal.expected_price;
                  const orderResult = await this.modules['order-manager'].placeOrder({
                    tokenId: signal.token_id,
                    side: signal.direction === 'long' ? 'buy' : 'sell',
                    size: sizingResult.actual_size,
                    price: maxPrice,
                    orderType: 'IOC',
                    windowId: signal.window_id,
                    marketId: signal.market_id,
                    // Signal context for stale order detection
                    signalContext: {
                      edge: signal.edge,
                      modelProbability: signal.confidence,
                      symbol: signal.symbol,
                      strategyId: strategyId,
                      sideToken: signal.side || 'UP',
                      originalMarketPrice: signal.market_price,
                      maxPriceUsed: maxPrice,
                    },
                  });

                  this.log.info('order_placed', {
                    window_id: signal.window_id,
                    strategy_id: strategyId,
                    order_id: orderResult.orderId,
                    status: orderResult.status,
                    latency_ms: orderResult.latencyMs,
                    trading_mode: tradingMode,
                  });

                  // Record position with position-manager
                  // V3 Stage 5: Halt-on-uncertainty - if recording fails after successful order, trip CB
                  if (this.modules['position-manager'] && orderResult.status !== 'rejected') {
                    try {
                      const position = await this.modules['position-manager'].addPosition({
                        windowId: signal.window_id,
                        marketId: signal.market_id,
                        tokenId: signal.token_id,
                        side: signal.direction,
                        size: sizingResult.actual_size,
                        entryPrice: maxPrice,
                        strategyId: strategyId,
                        orderId: orderResult.orderId,
                      });

                      this.log.info('position_opened', {
                        position_id: position.id,
                        window_id: signal.window_id,
                        strategy_id: strategyId,
                        side: signal.direction,
                        size: sizingResult.actual_size,
                        entry_price: position.entry_price,
                        trading_mode: tradingMode,
                      });

                      // Story 8-9: Confirm entry after successful order
                      if (this.modules.safeguards && reserved) {
                        await this.modules.safeguards.confirmEntry(signal.window_id, strategyId, signal.symbol);
                      }
                    } catch (trackingErr) {
                      // CRITICAL: Order succeeded but position tracking failed
                      // Trip CB - we have an untracked position on the exchange
                      this.log.error('position_tracking_failed_after_order', {
                        level: 'CRITICAL',
                        window_id: signal.window_id,
                        order_id: orderResult.orderId,
                        error: trackingErr.message,
                        message: 'Order placed but position recording failed - tripping circuit breaker',
                      });
                      if (this.modules['circuit-breaker']) {
                        await this.modules['circuit-breaker'].trip('POSITION_TRACKING_FAILED', {
                          window_id: signal.window_id,
                          order_id: orderResult.orderId,
                          error: trackingErr.message,
                        });
                      }
                      // CONFIRM (not release) — money already left the account
                      if (this.modules.safeguards && reserved) {
                        await this.modules.safeguards.confirmEntry(signal.window_id, strategyId, signal.symbol);
                        this.log.warn('entry_confirmed_despite_tracking_failure', {
                          window_id: signal.window_id,
                          strategy_id: strategyId,
                          order_id: orderResult.orderId,
                        });
                      }
                      continue; // Skip to next signal - NEVER log-and-continue
                    }
                  } else if (this.modules.safeguards && reserved) {
                    // Order rejected - release the reservation
                    await this.modules.safeguards.releaseEntry(signal.window_id, strategyId);
                    this.log.info('entry_released_order_rejected', {
                      window_id: signal.window_id,
                      strategy_id: strategyId,
                      order_status: orderResult.status,
                      trading_mode: tradingMode,
                    });
                  }

                  // Record entry event for diagnostics (Story 5.2)
                  if (this.modules['trade-event']) {
                    await this.modules['trade-event'].recordEntry({
                      windowId: signal.window_id,
                      orderId: orderResult.orderId,
                      strategyId: strategyId,
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
                  // CRITICAL: Only release if the order was NOT submitted to the exchange.
                  // If money may have left the account, CONFIRM to prevent duplicate entries.
                  const submittedToExchange = orderErr.orderSubmittedToExchange || orderErr.context?.orderSubmittedToExchange;
                  if (this.modules.safeguards && reserved) {
                    if (submittedToExchange) {
                      // Order went through on exchange but something else failed — NEVER release
                      await this.modules.safeguards.confirmEntry(signal.window_id, strategyId, signal.symbol);
                      this.log.error('entry_confirmed_despite_error', {
                        window_id: signal.window_id,
                        strategy_id: strategyId,
                        error: orderErr.message,
                        message: 'Order submitted to exchange — confirming entry to prevent duplicates',
                        trading_mode: tradingMode,
                      });
                    } else {
                      // Order never reached exchange — safe to release
                      await this.modules.safeguards.releaseEntry(signal.window_id, strategyId);
                      this.log.info('entry_released_order_failed', {
                        window_id: signal.window_id,
                        strategy_id: strategyId,
                        error: orderErr.message,
                        trading_mode: tradingMode,
                      });
                    }
                  }
                  this.log.error('order_placement_failed', {
                    window_id: signal.window_id,
                    strategy_id: strategyId,
                    error: orderErr.message,
                    code: orderErr.code,
                    submitted_to_exchange: !!submittedToExchange,
                  });
                }
              }
            } else {
              this.log.warn('position_sizing_rejected', {
                window_id: signal.window_id,
                strategy_id: strategyId,
                reason: sizingResult.adjustment_reason,
                rejection_code: sizingResult.rejection_code,
              });
            }
          } catch (sizingErr) {
            this.log.error('position_sizing_error', {
              window_id: signal.window_id,
              strategy_id: strategyId,
              error: sizingErr.message,
              code: sizingErr.code,
            });
          }
        }
      }

      // 4b. Evaluate and cancel stale orders (LIVE mode only)
      // Cancels open orders where edge has dropped below threshold or reversed
      let staleOrderResults = { cancelled: [], failed: [], summary: { evaluated: 0, stale: 0, cancelled: 0 } };
      const tradingModeForStale = this.config.tradingMode || 'PAPER';
      if (tradingModeForStale === 'LIVE' &&
          this.modules['stale-order-evaluator'] &&
          this.modules['order-manager']) {
        try {
          const staleEvaluator = this.modules['stale-order-evaluator'];
          const orderManager = this.modules['order-manager'];

          // Get all open orders
          const openOrders = orderManager.getOpenOrders();

          if (openOrders.length > 0) {
            // Get probability calculation function from window-timing-model if available
            let calculateProbability = null;
            if (this.modules['strategy-registry']) {
              try {
                const registry = this.modules['strategy-registry'];
                const windowTimingModel = registry.getComponent?.('probability', 'prob-window-timing-model-v1');
                if (windowTimingModel?.module?.calculateProbability) {
                  calculateProbability = windowTimingModel.module.calculateProbability;
                }
              } catch {
                // Fall back to no probability recalculation
              }
            }

            // Evaluate all open orders
            const evalResult = staleEvaluator.evaluateAll(
              openOrders,
              windows,
              spotPrices,
              calculateProbability
            );

            staleOrderResults.summary.evaluated = evalResult.summary.evaluated;
            staleOrderResults.summary.stale = evalResult.summary.stale;

            // Cancel stale orders
            if (evalResult.stale.length > 0) {
              const cancelResult = await staleEvaluator.cancelStaleOrders(
                evalResult.stale,
                orderManager
              );
              staleOrderResults.cancelled = cancelResult.cancelled;
              staleOrderResults.failed = cancelResult.failed;
              staleOrderResults.summary.cancelled = cancelResult.summary.cancelled;

              this.log.info('stale_orders_processed', {
                evaluated: evalResult.summary.evaluated,
                stale: evalResult.summary.stale,
                cancelled: cancelResult.summary.cancelled,
                failed: cancelResult.summary.failed,
                trading_mode: tradingModeForStale,
              });
            }
          }
        } catch (staleErr) {
          this.log.warn('stale_order_evaluation_failed', {
            error: staleErr.message,
            code: staleErr.code,
          });
        }
      }

      // 4c. Position verification before SL/TP evaluation (V3 Stage 5)
      let verificationPassed = true;
      if (this.modules['position-verifier'] && this.modules['position-manager']) {
        try {
          const openPositions = await this.modules['position-manager'].getPositions();
          if (openPositions.length > 0) {
            const verifyResult = await this.modules['position-verifier'].verify(openPositions);

            if (!verifyResult.verified && verifyResult.missing?.length > 0) {
              // Exchange has positions we don't track - blind to SL/TP
              verificationPassed = false;
              if (this.modules['circuit-breaker']) {
                await this.modules['circuit-breaker'].trip('STOP_LOSS_BLIND', {
                  missing: verifyResult.missing,
                  local_count: openPositions.length,
                });
              }
              this.log.error('position_verification_failed_tripped_cb', {
                missing: verifyResult.missing,
                local_count: openPositions.length,
              });
            }

            if (verifyResult.orphans?.length > 0) {
              // Local positions not on exchange - log but don't halt
              this.log.error('position_verification_orphans_detected', {
                orphans: verifyResult.orphans,
                message: 'Local positions not found on exchange',
              });
            }
          }
        } catch (verifyErr) {
          if (verifyErr.status === 429) {
            // Rate limited with stale cache - trip CB
            verificationPassed = false;
            if (this.modules['circuit-breaker']) {
              await this.modules['circuit-breaker'].trip('VERIFICATION_RATE_LIMITED', {
                error: verifyErr.message,
              });
            }
            this.log.error('position_verification_rate_limited_tripped_cb', {
              error: verifyErr.message,
            });
          } else {
            this.log.warn('position_verification_error', {
              error: verifyErr.message,
            });
          }
        }
      }

      // 5. Evaluate exit conditions - stop-loss (Story 3.4) - always evaluate even when auto-stopped
      // Also evaluates virtual positions for PAPER mode
      let stopLossResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
      let virtualStopLossResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };

      // 5a. Evaluate real positions (guarded by position verification - V3 Stage 5)
      if (verificationPassed && this.modules['stop-loss'] && this.modules['position-manager']) {
        const stopLossModule = this.modules['stop-loss'];
        const positionManager = this.modules['position-manager'];

        // Get all open positions
        const openPositions = await positionManager.getPositions();

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

              // Story 8-9: Remove entry from safeguards to allow future re-entry
              if (this.modules.safeguards && result.window_id) {
                const strategyId = result.strategy_id || 'default';
                await this.modules.safeguards.removeEntry(result.window_id, strategyId);
                this.log.debug('entry_removed_on_position_close', {
                  window_id: result.window_id,
                  strategy_id: strategyId,
                  close_reason: 'stop_loss',
                });
              }

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

      // 5b. Update virtual position prices before evaluation (PAPER mode)
      // Virtual positions track token prices, which move with market conditions
      if (this.modules['virtual-position-manager'] && this.modules['window-manager']) {
        const virtualPM = this.modules['virtual-position-manager'];
        const virtualPositions = virtualPM.getPositions();

        if (virtualPositions.length > 0) {
          // Get current market prices for active windows
          const activeWindows = windows || [];
          const windowPrices = {};

          for (const window of activeWindows) {
            const windowId = window.window_id || window.id;
            // Get token prices from window data
            // market_price is the UP token price; DOWN token price is 1 - market_price
            if (window.market_price != null) {
              windowPrices[windowId] = {
                up: window.market_price,
                down: 1 - window.market_price,
              };
            }
          }

          // Update each virtual position's current price
          let pricesUpdated = 0;
          let expiredPositions = 0;
          for (const pos of virtualPositions) {
            const prices = windowPrices[pos.window_id];
            if (prices) {
              // Use the appropriate price based on token side (UP or DOWN)
              const newPrice = pos.token_side === 'DOWN' ? prices.down : prices.up;
              virtualPM.updatePrice(pos.id, newPrice);
              pricesUpdated++;
            } else {
              // Position's window is no longer active (expired)
              expiredPositions++;
            }
          }

          // Log price update status
          this.log.debug('virtual_position_price_check', {
            total_positions: virtualPositions.length,
            prices_updated: pricesUpdated,
            expired_positions: expiredPositions,
            active_windows: Object.keys(windowPrices).length,
            position_windows: virtualPositions.map(p => p.window_id),
            active_window_ids: Object.keys(windowPrices),
          });
        }
      }

      // 5c. Evaluate virtual positions for stop-loss (PAPER mode)
      if (this.modules['stop-loss'] && this.modules['virtual-position-manager']) {
        const stopLossModule = this.modules['stop-loss'];
        const virtualPM = this.modules['virtual-position-manager'];
        const virtualPositions = virtualPM.getPositions();

        if (virtualPositions.length > 0) {
          // Get current price for each virtual position
          const getVirtualPrice = (position) => position.current_price;

          virtualStopLossResults = stopLossModule.evaluateAll(virtualPositions, getVirtualPrice);

          // Close triggered virtual positions
          for (const result of virtualStopLossResults.triggered) {
            try {
              virtualPM.closePosition(result.position_id, {
                closePrice: result.current_price,
                reason: 'stop_loss_triggered',
              });

              this.log.info('virtual_stop_loss_triggered', {
                position_id: result.position_id,
                window_id: result.window_id,
                entry_price: result.entry_price,
                close_price: result.current_price,
                stop_loss_threshold: result.stop_loss_threshold,
                loss_amount: result.loss_amount,
                loss_pct: (result.loss_pct * 100).toFixed(2) + '%',
                trading_mode: 'PAPER',
              });
            } catch (closeErr) {
              this.log.warn('virtual_stop_loss_close_failed', {
                position_id: result.position_id,
                error: closeErr.message,
              });
            }
          }
        }
      }

      // 6. Evaluate exit conditions - take-profit (Story 3.5) - always evaluate even when auto-stopped
      // Also evaluates virtual positions for PAPER mode
      let takeProfitResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };
      let virtualTakeProfitResults = { triggered: [], summary: { evaluated: 0, triggered: 0, safe: 0 } };

      // 6a. Evaluate real positions (guarded by position verification - V3 Stage 5)
      if (verificationPassed && this.modules['take-profit'] && this.modules['position-manager']) {
        const takeProfitModule = this.modules['take-profit'];
        const positionManager = this.modules['position-manager'];

        // Get all open positions (positions not already closed by stop-loss)
        const openPositions = await positionManager.getPositions();

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

              // Story 8-9: Remove entry from safeguards to allow future re-entry
              if (this.modules.safeguards && result.window_id) {
                const strategyId = result.strategy_id || 'default';
                await this.modules.safeguards.removeEntry(result.window_id, strategyId);
                this.log.debug('entry_removed_on_position_close', {
                  window_id: result.window_id,
                  strategy_id: strategyId,
                  close_reason: 'take_profit',
                });
              }

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

      // 6b. Evaluate virtual positions for take-profit (PAPER mode) - includes trailing stop
      if (this.modules['take-profit'] && this.modules['virtual-position-manager']) {
        const takeProfitModule = this.modules['take-profit'];
        const virtualPM = this.modules['virtual-position-manager'];
        const virtualPositions = virtualPM.getPositions();

        if (virtualPositions.length > 0) {
          // Update virtual position prices before evaluation
          // For now, current_price is maintained from entry (will be enhanced later)
          const getVirtualPrice = (position) => position.current_price;

          virtualTakeProfitResults = takeProfitModule.evaluateAll(virtualPositions, getVirtualPrice);

          // Close triggered virtual positions
          for (const result of virtualTakeProfitResults.triggered) {
            try {
              virtualPM.closePosition(result.position_id, {
                closePrice: result.current_price,
                reason: 'take_profit_triggered',
              });

              // Log trailing vs fixed take-profit
              const isTrailing = result.trailing_active || result.high_water_mark;
              this.log.info('virtual_take_profit_triggered', {
                position_id: result.position_id,
                window_id: result.window_id,
                entry_price: result.entry_price,
                close_price: result.current_price,
                high_water_mark: result.high_water_mark || null,
                trailing_stop_price: result.trailing_stop_price || null,
                profit_amount: result.profit_amount,
                profit_pct: (result.profit_pct * 100).toFixed(2) + '%',
                is_trailing: isTrailing,
                trading_mode: 'PAPER',
              });
            } catch (closeErr) {
              this.log.warn('virtual_take_profit_close_failed', {
                position_id: result.position_id,
                error: closeErr.message,
              });
            }
          }

          // Log trailing stop tracking for active virtual positions
          const activePositions = virtualPM.getPositions();
          for (const pos of activePositions) {
            if (pos.peak_pnl_pct > 0.01) {  // Log if peak profit > 1%
              this.log.debug('virtual_trailing_tracking', {
                position_id: pos.id,
                window_id: pos.window_id,
                entry_price: pos.entry_price,
                current_price: pos.current_price,
                peak_price: pos.peak_price,
                current_pnl_pct: (pos.unrealized_pnl_pct * 100).toFixed(2) + '%',
                peak_pnl_pct: (pos.peak_pnl_pct * 100).toFixed(2) + '%',
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
        const openPositions = await positionManager.getPositions();

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

      // Get virtual position stats
      const virtualPositionCount = this.modules['virtual-position-manager']
        ? this.modules['virtual-position-manager'].getPositions().length
        : 0;

      const tickDurationMs = Date.now() - tickStart;
      this.log.info('tick_complete', {
        tickCount: this.tickCount,
        durationMs: tickDurationMs,
        trading_mode: this.config.tradingMode || 'PAPER',
        spotPrice: spotData?.price || null,
        // Story 7-20: Per-crypto spot prices for multi-asset tracking
        spotPrices: Object.fromEntries(
          Object.entries(spotPrices).map(([k, v]) => [k, v?.price])
        ),
        windowsCount: windows.length,
        autoStopped: drawdownCheck.autoStopped,
        drawdownPct: drawdownCheck.current,
        entriesSkipped,
        entrySignalsCount: entrySignals.length,
        safeguardsBlocked,
        sizingResultsCount: sizingResults.length,
        sizingSuccessCount: sizingResults.filter(r => r.success).length,
        // Real position stats
        stopLossEvaluated: stopLossResults.summary.evaluated,
        stopLossTriggered: stopLossResults.summary.triggered,
        takeProfitEvaluated: takeProfitResults.summary.evaluated,
        takeProfitTriggered: takeProfitResults.summary.triggered,
        // Virtual position stats (PAPER mode)
        virtualPositions: virtualPositionCount,
        virtualStopLossEvaluated: virtualStopLossResults.summary.evaluated,
        virtualStopLossTriggered: virtualStopLossResults.summary.triggered,
        virtualTakeProfitEvaluated: virtualTakeProfitResults.summary.evaluated,
        virtualTakeProfitTriggered: virtualTakeProfitResults.summary.triggered,
        // Window expiry
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
