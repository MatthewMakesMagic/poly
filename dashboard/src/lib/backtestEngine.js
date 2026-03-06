/**
 * Client-side backtest engine. Pure function, zero dependencies.
 *
 * Takes window_close_events dataset + filter config, returns trade-level
 * results and aggregate metrics.
 */

// Map entry offset (seconds before close) to column name prefix
const OFFSET_COLUMNS = {
  60: { up: 'clob_up_60s', down: 'clob_down_60s' },
  30: { up: 'clob_up_30s', down: 'clob_down_30s' },
  10: { up: 'clob_up_10s', down: 'clob_down_10s' },
  5:  { up: 'clob_up_5s',  down: 'clob_down_5s'  },
  1:  { up: 'clob_up_1s',  down: 'clob_down_1s'   },
};

/**
 * Run a backtest over the given windows with the specified filters.
 *
 * @param {Array} windows - Array of window_close_events rows
 * @param {Object} filters
 * @param {string[]} [filters.symbols] - Symbols to include (e.g. ['btc','eth'])
 * @param {string} [filters.dateFrom] - ISO date string lower bound
 * @param {string} [filters.dateTo] - ISO date string upper bound
 * @param {number} [filters.entryOffset=60] - Seconds before close to enter (60,30,10,5,1)
 * @param {string} [filters.strategy='consensus'] - 'consensus' | 'contrarian' | 'threshold'
 * @param {number} [filters.confidenceMin=0] - Min consensus confidence (0-1)
 * @param {number} [filters.confidenceMax=1] - Max consensus confidence (0-1)
 * @param {number} [filters.clobThreshold=0.5] - For threshold strategy: only trade when CLOB price >= this
 * @returns {Object} Backtest results
 */
export function runBacktest(windows, filters = {}) {
  const {
    symbols = [],
    dateFrom = '',
    dateTo = '',
    entryOffset = 60,
    strategy = 'consensus',
    confidenceMin = 0,
    confidenceMax = 1,
    clobThreshold = 0.5,
  } = filters;

  const offsetCols = OFFSET_COLUMNS[entryOffset] || OFFSET_COLUMNS[60];
  const trades = [];
  let cumPnl = 0;
  const equityCurve = [];
  const bySymbol = {};
  const byHour = {};

  for (const w of windows) {
    // --- Filter checks ---
    if (symbols.length > 0 && !symbols.includes(w.symbol?.toLowerCase())) continue;

    if (dateFrom && w.window_close_time < dateFrom) continue;
    if (dateTo && w.window_close_time > dateTo) continue;

    const resolved = (w.resolved_direction || '').toLowerCase();
    if (resolved !== 'up' && resolved !== 'down') continue;

    // Determine consensus direction from market
    const consensus = (w.market_consensus_direction || '').toLowerCase();
    if (!consensus || (consensus !== 'up' && consensus !== 'down')) continue;

    // Confidence filter
    const confidence = Number(w.consensus_confidence || 0);
    if (confidence < confidenceMin || confidence > confidenceMax) continue;

    // Determine which side to bet on
    let side;
    if (strategy === 'consensus') {
      side = consensus;
    } else if (strategy === 'contrarian') {
      side = consensus === 'up' ? 'down' : 'up';
    } else if (strategy === 'threshold') {
      // Bet UP if CLOB UP price >= threshold, else bet DOWN
      const clobUp = Number(w[offsetCols.up] || 0);
      if (clobUp >= clobThreshold) {
        side = 'up';
      } else {
        side = 'down';
      }
    } else {
      side = consensus;
    }

    // Get entry price
    const entryPrice = Number(w[offsetCols[side]] || 0);
    if (entryPrice <= 0 || entryPrice >= 1) continue;

    // Determine outcome: did our side win?
    const won = side === resolved;
    const settlementPrice = won ? 1.0 : 0.0;
    const pnl = settlementPrice - entryPrice;

    cumPnl += pnl;

    const trade = {
      windowId: w.window_id,
      symbol: w.symbol,
      side,
      entryPrice,
      resolved,
      won,
      pnl: Number(pnl.toFixed(4)),
      cumPnl: Number(cumPnl.toFixed(4)),
      confidence,
      closeTime: w.window_close_time,
    };
    trades.push(trade);
    equityCurve.push({ idx: trades.length, pnl: trade.cumPnl, time: w.window_close_time });

    // By symbol
    const sym = (w.symbol || 'unknown').toLowerCase();
    if (!bySymbol[sym]) bySymbol[sym] = { trades: 0, wins: 0, pnl: 0 };
    bySymbol[sym].trades++;
    if (won) bySymbol[sym].wins++;
    bySymbol[sym].pnl += pnl;

    // By hour (ET)
    const closeDate = new Date(w.window_close_time);
    const hourET = getETHour(closeDate);
    if (!byHour[hourET]) byHour[hourET] = { trades: 0, wins: 0, pnl: 0 };
    byHour[hourET].trades++;
    if (won) byHour[hourET].wins++;
    byHour[hourET].pnl += pnl;
  }

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.won).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalPnl = Number(cumPnl.toFixed(4));
  const avgEntry = totalTrades > 0 ? trades.reduce((s, t) => s + t.entryPrice, 0) / totalTrades : 0;

  // Profit factor: sum of wins / abs(sum of losses)
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy: avg pnl per trade
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;

  // Round bySymbol/byHour pnl
  for (const v of Object.values(bySymbol)) v.pnl = Number(v.pnl.toFixed(4));
  for (const v of Object.values(byHour)) v.pnl = Number(v.pnl.toFixed(4));

  return {
    trades,
    totalTrades,
    wins,
    losses,
    winRate,
    totalPnl,
    avgEntry: Number(avgEntry.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(4)),
    expectancy: Number(expectancy.toFixed(4)),
    equityCurve,
    bySymbol,
    byHour,
  };
}

/**
 * Get hour in ET (Eastern Time) from a Date object.
 * Simple approximation: UTC-5 (ignoring DST for simplicity).
 */
function getETHour(date) {
  const utcHour = date.getUTCHours();
  return (utcHour - 5 + 24) % 24;
}
