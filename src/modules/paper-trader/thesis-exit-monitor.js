/**
 * Thesis Exit Monitor
 *
 * Monitors VWAP thesis post-entry and exits trades when the thesis deteriorates.
 * For each window, checks the relevant VWAP source every 1s. When the VWAP
 * crosses back through the strike price (thesis dead), simulates a sell and
 * persists the exit to paper_trades_v2.
 *
 * VWAP source mapping:
 * - Strategies with '_cg' in name → coingecko
 * - Everything else → composite
 *
 * Exit rules (from backtest):
 * - Composite: exit when VWAP crosses strike (thresholdPct=0.0) after T+3s
 * - CoinGecko: exit when thesis < 0.03% after T+30s
 *
 * @module modules/paper-trader/thesis-exit-monitor
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as clobWs from '../../clients/clob-ws/index.js';
import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as coingeckoClient from '../../clients/coingecko/index.js';
import * as polymarketClient from '../../clients/polymarket/index.js';
import { simulateExit } from './fill-simulator.js';

let log = null;

// Map<windowId, WindowMonitor>
// WindowMonitor: { intervalId, crypto, strikes: { composite, coingecko }, trades: Map<tradeId, TradeState> }
const monitors = new Map();

// In-flight guard: prevents double-fire race condition where the 500ms interval
// re-enters executeExit() for the same trade before the async DB/order work completes
const exitingTrades = new Set();

let config = null;
let stats = { exits: 0, exitPnl: 0 };

/**
 * Initialize the thesis exit monitor
 * @param {Object} cfg - thesisExit config block from paperTrader config
 */
export function init(cfg) {
  log = child({ module: 'thesis-exit' });
  config = cfg;
  log.info('thesis_exit_init', { enabled: cfg.enabled, rules: cfg.rules });
}

/**
 * Get current stats
 */
export function getStats() {
  return { ...stats };
}

/**
 * Determine VWAP source for a strategy name
 */
function getVwapSourceForStrategy(strategyName) {
  if (strategyName.includes('_cg')) return 'coingecko';
  return 'composite';
}

/**
 * Start monitoring a trade for thesis exit
 *
 * @param {Object} windowState - Window state from paper trader
 * @param {Object} tradeInfo - Trade details
 * @param {number} tradeInfo.tradeId - DB id of the trade
 * @param {string} tradeInfo.strategyName - Strategy name (e.g., 'vwap_edge')
 * @param {string} tradeInfo.entrySide - 'up' or 'down'
 * @param {number} tradeInfo.shares - Shares held
 * @param {number} tradeInfo.cost - Entry cost
 * @param {number} tradeInfo.fee - Entry fee
 * @param {string} tradeInfo.entryTokenId - Token ID for the entry side
 * @param {number} tradeInfo.entryTime - Timestamp (ms) of entry
 */
export function startMonitoring(windowState, tradeInfo) {
  if (!config || !config.enabled) return;

  const { windowId, crypto, market } = windowState;
  const vwapSource = getVwapSourceForStrategy(tradeInfo.strategyName);
  const rule = config.rules[vwapSource];
  if (!rule) return;

  // Determine strike price for this VWAP source
  let strike;
  if (vwapSource === 'coingecko') {
    strike = windowState.cgAtOpen || windowState.referencePrice;
  } else {
    strike = windowState.vwapAtOpen || windowState.referencePrice;
  }

  if (!strike) {
    if (log) log.warn('thesis_exit_no_strike', { window_id: windowId, vwap_source: vwapSource });
    return;
  }

  // Get or create window monitor
  let monitor = monitors.get(windowId);
  if (!monitor) {
    monitor = {
      intervalId: null,
      crypto,
      market,
      trades: new Map(),
    };
    monitors.set(windowId, monitor);
  }

  // Register this trade
  monitor.trades.set(tradeInfo.tradeId, {
    ...tradeInfo,
    vwapSource,
    strike,
    rule,
  });

  // Start interval if not running
  if (!monitor.intervalId) {
    monitor.intervalId = setInterval(() => {
      checkThesis(windowId).catch(err => {
        if (log) log.warn('thesis_check_error', { window_id: windowId, error: err.message });
      });
    }, config.checkIntervalMs);
    if (monitor.intervalId.unref) monitor.intervalId.unref();

    if (log) log.info('thesis_monitor_started', { window_id: windowId, crypto });
  }

  if (log) {
    log.info('thesis_trade_registered', {
      window_id: windowId,
      trade_id: tradeInfo.tradeId,
      strategy: tradeInfo.strategyName,
      vwap_source: vwapSource,
      strike,
      entry_side: tradeInfo.entrySide,
      shares: tradeInfo.shares,
    });
  }
}

/**
 * Check thesis for all trades in a window
 */
async function checkThesis(windowId) {
  const monitor = monitors.get(windowId);
  if (!monitor || monitor.trades.size === 0) return;

  const now = Date.now();

  // Fetch live prices (cache per check cycle — max 2 sources per window)
  let compositeVwap = null;
  let cgPrice = null;

  // Only fetch what we need
  const needsComposite = [...monitor.trades.values()].some(t => t.vwapSource === 'composite');
  const needsCg = [...monitor.trades.values()].some(t => t.vwapSource === 'coingecko');

  if (needsComposite) {
    try {
      const data = exchangeTradeCollector.getCompositeVWAP(monitor.crypto);
      if (data) compositeVwap = data.vwap;
    } catch { /* non-fatal */ }
  }

  if (needsCg) {
    try {
      const data = coingeckoClient.getCurrentPrice(monitor.crypto);
      if (data) cgPrice = data.price;
    } catch { /* non-fatal */ }
  }

  // Check each trade
  for (const [tradeId, trade] of monitor.trades) {
    const elapsed = (now - trade.entryTime) / 1000;

    // Must exceed minimum hold time
    if (elapsed < trade.rule.minTimeSec) continue;

    // Get current VWAP for this trade's source
    const currentVwap = trade.vwapSource === 'coingecko' ? cgPrice : compositeVwap;
    if (currentVwap == null) continue;

    // Compute thesis strength: how much VWAP supports entry direction
    // Positive = thesis alive, negative/zero = thesis dead
    let thesisStrength;
    if (trade.entrySide === 'up') {
      // UP thesis: VWAP > strike → positive
      thesisStrength = ((currentVwap - trade.strike) / trade.strike) * 100;
    } else {
      // DOWN thesis: VWAP < strike → positive (inverted)
      thesisStrength = ((trade.strike - currentVwap) / trade.strike) * 100;
    }

    // Check if thesis has deteriorated below threshold
    if (thesisStrength <= trade.rule.thresholdPct) {
      await executeExit(monitor, tradeId, trade, currentVwap, thesisStrength);
    }
  }
}

/**
 * Execute an early exit for a trade
 *
 * Double-fire prevention:
 * 1. exitingTrades Set guards against re-entry during async operations
 * 2. monitor.trades.delete() happens BEFORE async work to prevent interval re-trigger
 */
async function executeExit(monitor, tradeId, trade, currentVwap, thesisStrength) {
  // In-flight guard: skip if already exiting this trade
  if (exitingTrades.has(tradeId)) return;
  exitingTrades.add(tradeId);

  // Remove from monitoring BEFORE async work to prevent re-trigger on next interval tick
  monitor.trades.delete(tradeId);

  // If no more trades, stop the interval
  if (monitor.trades.size === 0) {
    clearInterval(monitor.intervalId);
    monitor.intervalId = null;
  }

  try {
    // Get live book for exit simulation
    const upBook = clobWs.getBook(monitor.market.upTokenId);
    if (!upBook) {
      if (log) log.warn('thesis_exit_no_book', { trade_id: tradeId });
      return;
    }

    // Simulate exit (always — preserves comparison data)
    const exitResult = simulateExit(upBook, trade.shares, trade.entrySide, {
      feeRate: config.feeRate || 0.02,
    });

    if (!exitResult.success) {
      if (log) log.warn('thesis_exit_sim_failed', { trade_id: tradeId, filled: exitResult.filled });
      return;
    }

    // Calculate PnL: exit proceeds - entry cost - entry fee - exit fee
    const exitPnl = exitResult.netProceeds - trade.cost - trade.fee;

    // Persist simulated exit to DB
    await persistence.run(`
      UPDATE paper_trades_v2
      SET exited_early = TRUE,
          exit_time = NOW(),
          exit_price = $1,
          exit_proceeds = $2,
          exit_fee = $3,
          exit_pnl = $4,
          exit_reason = $5,
          exit_vwap_price = $6,
          exit_thesis_strength = $7
      WHERE id = $8
    `, [
      exitResult.fillPrice,       // $1
      exitResult.proceeds,        // $2
      exitResult.fee,             // $3
      exitPnl,                    // $4
      `thesis_dead_${trade.vwapSource}`, // $5
      currentVwap,                // $6
      thesisStrength,             // $7
      tradeId,                    // $8
    ]);

    stats.exits++;
    stats.exitPnl += exitPnl;

    if (log) {
      log.info('thesis_exit_executed', {
        trade_id: tradeId,
        strategy: trade.strategyName,
        entry_side: trade.entrySide,
        vwap_source: trade.vwapSource,
        thesis_strength: thesisStrength.toFixed(4),
        exit_price: exitResult.fillPrice.toFixed(4),
        exit_pnl: exitPnl.toFixed(2),
        elapsed_sec: ((Date.now() - trade.entryTime) / 1000).toFixed(0),
      });
    }

    // Live FOK sell in LIVE mode
    if (config.tradingMode === 'LIVE' && polymarketClient.getState()?.ready) {
      try {
        const entryBook = clobWs.getBook(trade.entryTokenId);
        const bestBid = entryBook?.bestBid;
        if (!bestBid) {
          if (log) log.warn('thesis_exit_live_no_bid', { trade_id: tradeId });
          return;
        }

        const tokenBalance = await polymarketClient.getBalance(trade.entryTokenId);
        if (tokenBalance < 1) {
          if (log) log.warn('thesis_exit_live_no_balance', { trade_id: tradeId, balance: tokenBalance });
          return;
        }

        const sellShares = Math.floor(tokenBalance);
        const sellResult = await polymarketClient.sell(trade.entryTokenId, sellShares, bestBid, 'FOK');

        if (sellResult.filled) {
          const liveProceeds = sellResult.cost; // cost field = price * shares for sells
          const liveFee = sellResult.priceFilled
            ? sellShares * sellResult.priceFilled * (config.feeRate || 0.02)
            : 0;

          await persistence.run(`
            UPDATE paper_trades_v2
            SET exit_order_id = $1, exit_live_fill_price = $2,
                exit_live_proceeds = $3, exit_live_fee = $4, exit_live_tx_hash = $5
            WHERE id = $6
          `, [
            sellResult.orderId,
            sellResult.priceFilled,
            liveProceeds,
            liveFee,
            sellResult.tx,
            tradeId,
          ]);

          if (log) {
            log.info('thesis_exit_live_filled', {
              trade_id: tradeId,
              order_id: sellResult.orderId,
              fill_price: sellResult.priceFilled,
              shares_sold: sellShares,
              proceeds: liveProceeds,
            });
          }
        } else {
          if (log) log.warn('thesis_exit_live_rejected', {
            trade_id: tradeId,
            status: sellResult.status,
          });
        }
      } catch (err) {
        if (log) log.error('thesis_exit_live_error', {
          trade_id: tradeId,
          error: err.message,
        });
      }
    }
  } catch (err) {
    if (log) log.error('thesis_exit_persist_failed', { trade_id: tradeId, error: err.message });
  } finally {
    exitingTrades.delete(tradeId);
  }
}

/**
 * Stop monitoring a window (called at cleanup)
 */
export function stopMonitoring(windowId) {
  const monitor = monitors.get(windowId);
  if (!monitor) return;

  if (monitor.intervalId) {
    clearInterval(monitor.intervalId);
  }

  const remaining = monitor.trades.size;
  if (remaining > 0 && log) {
    log.info('thesis_monitor_stopped_with_active', { window_id: windowId, remaining_trades: remaining });
  }

  monitors.delete(windowId);
}

/**
 * Shutdown all monitors
 */
export function shutdown() {
  for (const [windowId, monitor] of monitors) {
    if (monitor.intervalId) {
      clearInterval(monitor.intervalId);
    }
  }
  monitors.clear();
  if (log) log.info('thesis_exit_shutdown', { stats });
  log = null;
}
