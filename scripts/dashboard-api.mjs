/**
 * Dashboard API Module
 *
 * WebSocket + REST endpoints for the trading dashboard.
 * Attaches to the existing HTTP server created in run_live_trading.mjs.
 *
 * WebSocket: streams orchestrator events to connected clients
 * REST: GET /api/positions, /api/trades, /api/assertions, /api/controls, /api/state
 *
 * @module scripts/dashboard-api
 */

import { WebSocketServer } from 'ws';
import * as orchestrator from '../src/modules/orchestrator/index.js';
import persistence from '../src/persistence/index.js';
import * as runtimeControls from '../src/modules/runtime-controls/index.js';

let wss = null;
let log = null;
let broadcastInterval = null;

/**
 * Attach WebSocket server and REST routes to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer - The HTTP server instance
 * @param {Object} logger - Logger instance (child logger)
 * @returns {{ wss: WebSocketServer, broadcast: Function }}
 */
export function attachDashboard(httpServer, logger) {
  log = logger;

  // Create WebSocket server on the same HTTP server
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    log.info('dashboard_ws_connected', { clients: wss.clients.size });

    // Send initial state snapshot on connect
    sendInitialState(ws);

    ws.on('close', () => {
      log.info('dashboard_ws_disconnected', { clients: wss.clients.size });
    });

    ws.on('error', (err) => {
      log.warn('dashboard_ws_error', { error: err.message });
    });
  });

  // Broadcast orchestrator state every 1s
  broadcastInterval = setInterval(() => {
    if (wss.clients.size > 0) {
      broadcastState();
    }
  }, 1000);

  log.info('dashboard_api_attached', { wsPath: '/ws' });

  return { wss, broadcast: broadcastEvent };
}

/**
 * Send the full initial state snapshot to a newly connected client.
 */
async function sendInitialState(ws) {
  try {
    const state = await orchestrator.getState();
    const payload = await buildStatePayload(state);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'init', data: payload, ts: Date.now() }));
    }
  } catch (err) {
    log.warn('dashboard_init_state_failed', { error: err.message });
  }
}

/**
 * Broadcast current state to all connected clients.
 */
async function broadcastState() {
  try {
    const state = await orchestrator.getState();
    const payload = await buildStatePayload(state);
    const msg = JSON.stringify({ type: 'state', data: payload, ts: Date.now() });

    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  } catch {
    // Silently skip broadcast on error
  }
}

/**
 * Broadcast a specific event to all connected clients.
 *
 * @param {string} eventType - Event type (signal, order, fill, assertion, window)
 * @param {Object} data - Event data
 */
export function broadcastEvent(eventType, data) {
  if (!wss || wss.clients.size === 0) return;

  const msg = JSON.stringify({ type: 'event', event: eventType, data, ts: Date.now() });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

/**
 * Query open positions from DB for the state payload.
 * Cached briefly to avoid hitting DB every 1s broadcast.
 */
let _positionsCache = { rows: [], fetchedAt: 0 };
async function getOpenPositionsSafe() {
  const now = Date.now();
  if (now - _positionsCache.fetchedAt < 2000) return _positionsCache.rows;
  try {
    const rows = await persistence.all(`
      SELECT id, window_id, market_id, token_id, direction, side,
             entry_price, current_price, size_dollars, shares,
             unrealized_pnl, stop_loss_price, take_profit_price,
             strategy_id, opened_at, status, lifecycle_state, mode
      FROM positions
      WHERE status = 'open'
      ORDER BY opened_at DESC
      LIMIT 50
    `);
    _positionsCache = { rows, fetchedAt: now };
    return rows;
  } catch {
    return _positionsCache.rows;
  }
}

/**
 * Build the state payload from orchestrator state.
 */
async function buildStatePayload(state) {
  const modules = state.modules || {};

  // Extract key data points
  const positionManager = modules['position-manager'] || {};
  const orderManager = modules['order-manager'] || {};
  const safety = modules['safety'] || {};
  const circuitBreaker = modules['circuit-breaker'] || {};
  const rtds = modules['rtds-client'] || {};
  const windowManager = modules['window-manager'] || {};
  const paperTrader = modules['paper-trader'] || {};

  return {
    // System status
    systemState: state.state,
    tradingMode: modules['runtime-controls']?.controls?.trading_mode || state.manifest?.trading_mode || 'PAPER',
    startedAt: state.startedAt,
    uptime: state.startedAt
      ? Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000)
      : 0,

    // Strategies
    activeStrategy: state.activeStrategy,
    availableStrategies: state.availableStrategies || [],
    loadedStrategies: state.loadedStrategies || [],

    // Positions (position-manager getState returns { positions: { open, closed }, stats: {...} })
    openPositions: await getOpenPositionsSafe(),
    positionCount: positionManager.positions?.open ?? positionManager.positionCount ?? 0,

    // Orders
    openOrders: orderManager.openOrders || [],

    // Safety / Risk (values are inside safety.drawdown from getDrawdownStatus())
    balance: safety.drawdown?.current_balance ?? null,
    sessionPnl: safety.drawdown?.realized_pnl ?? null,
    drawdown: safety.drawdown ?? null,
    startingCapital: safety.drawdown?.starting_balance ?? safety.startingCapital ?? null,

    // Circuit breaker
    circuitBreakerState: circuitBreaker.state || 'UNKNOWN',

    // Feeds
    feedStatus: {
      rtds: rtds.connected ? 'connected' : 'disconnected',
      lastTickAt: rtds.stats?.last_tick_at || null,
      tickCount: rtds.stats?.ticks_received || 0,
    },

    // Windows (window-manager getState() returns cachedWindowCount, not activeWindows)
    activeWindows: windowManager.cachedWindowCount ?? windowManager.activeWindows ?? 0,

    // Errors
    errorCount: state.errorCount || 0,
    errorCount1m: state.errorCount1m || 0,
    lastError: state.lastError || null,

    // Alerter
    alerter: modules['alerter'] || null,

    // Feed monitor
    feedMonitor: modules['feed-monitor'] || null,

    // Loop metrics
    loop: state.loop || null,
  };
}

/**
 * Handle dashboard REST API requests.
 * Returns true if the request was handled, false otherwise.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleDashboardRequest(req, res) {
  // CORS headers for dashboard dev server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const url = req.url?.split('?')[0];

  // GET /api/state - Full orchestrator state
  if (req.method === 'GET' && url === '/api/state') {
    try {
      const state = await orchestrator.getState();
      const payload = await buildStatePayload(state);
      json(res, 200, payload);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/positions - Open positions
  if (req.method === 'GET' && url === '/api/positions') {
    try {
      const rows = await persistence.all(`
        SELECT id, window_id, market_id, token_id, direction, side,
               entry_price, current_price, size_dollars, shares,
               unrealized_pnl, stop_loss_price, take_profit_price,
               strategy_id, opened_at, status
        FROM positions
        WHERE status = 'open'
        ORDER BY opened_at DESC
      `);
      json(res, 200, { positions: rows });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/trades - Trade history with filters
  if (req.method === 'GET' && url === '/api/trades') {
    try {
      const params = parseQueryParams(req.url);
      const conditions = [];
      const values = [];
      let paramIdx = 1;

      if (params.strategy) {
        conditions.push(`strategy_id = $${paramIdx++}`);
        values.push(params.strategy);
      }
      if (params.instrument) {
        // Match on token_id or window_id containing the instrument symbol
        conditions.push(`LOWER(token_id) LIKE $${paramIdx++}`);
        values.push(`%${params.instrument.toLowerCase()}%`);
      }
      if (params.from) {
        conditions.push(`COALESCE(closed_at, opened_at) >= $${paramIdx++}::timestamptz`);
        values.push(params.from);
      }
      if (params.to) {
        conditions.push(`COALESCE(closed_at, opened_at) <= $${paramIdx++}::timestamptz`);
        values.push(params.to);
      }
      if (params.outcome === 'win') {
        conditions.push(`pnl > 0`);
      } else if (params.outcome === 'loss') {
        conditions.push(`pnl < 0`);
      }
      if (params.status) {
        conditions.push(`status = $${paramIdx++}`);
        values.push(params.status);
      }
      if (params.mode) {
        conditions.push(`mode = $${paramIdx++}`);
        values.push(params.mode);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = Math.min(parseInt(params.limit) || 50, 500);
      const offset = parseInt(params.offset) || 0;

      // Get total count for pagination
      const countResult = await persistence.get(
        `SELECT COUNT(*) as total FROM positions ${where}`,
        values
      );

      const rows = await persistence.all(
        `SELECT id, window_id, market_id, token_id, side, size,
                entry_price, current_price, close_price, status,
                strategy_id, opened_at, closed_at, pnl, order_id,
                exchange_verified_at, mode
         FROM positions
         ${where}
         ORDER BY COALESCE(closed_at, opened_at) DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      );

      json(res, 200, {
        trades: rows,
        total: parseInt(countResult?.total || '0'),
        limit,
        offset,
      });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/instruments - Per-instrument data for deep dive
  if (req.method === 'GET' && url === '/api/instruments') {
    try {
      const state = await orchestrator.getState();
      const modules = state.modules || {};
      const rtds = modules['rtds-client'] || {};
      const prices = rtds.prices || {};

      const instruments = {};
      const symbols = ['btc', 'eth', 'sol', 'xrp'];

      for (const sym of symbols) {
        // Oracle prices from RTDS state
        const refPrice = prices[sym]?.crypto_prices?.price ?? null;
        const clPrice = prices[sym]?.crypto_prices_chainlink?.price ?? null;
        const refAt = prices[sym]?.crypto_prices?.timestamp ?? null;
        const clAt = prices[sym]?.crypto_prices_chainlink?.timestamp ?? null;

        instruments[sym] = {
          symbol: sym,
          oraclePrices: {
            polymarketRef: { price: refPrice, updatedAt: refAt },
            chainlink: { price: clPrice, updatedAt: clAt },
          },
          feedHealth: {},
        };
      }

      // Query latest exchange ticks per exchange per symbol
      try {
        const exchangeTicks = await persistence.all(`
          SELECT DISTINCT ON (exchange, symbol)
            exchange, symbol, price, timestamp
          FROM exchange_ticks
          WHERE timestamp > NOW() - INTERVAL '60 seconds'
          ORDER BY exchange, symbol, timestamp DESC
        `);
        for (const tick of exchangeTicks) {
          const sym = tick.symbol?.toLowerCase();
          if (instruments[sym]) {
            if (!instruments[sym].exchangePrices) {
              instruments[sym].exchangePrices = {};
            }
            instruments[sym].exchangePrices[tick.exchange] = {
              price: Number(tick.price),
              updatedAt: tick.timestamp,
            };
          }
        }
      } catch {
        // exchange_ticks table may not exist
      }

      // Query latest RTDS ticks per topic per symbol for feed health
      try {
        const rtdsTicks = await persistence.all(`
          SELECT DISTINCT ON (topic, symbol)
            topic, symbol, price, timestamp
          FROM rtds_ticks
          WHERE timestamp > NOW() - INTERVAL '60 seconds'
          ORDER BY topic, symbol, timestamp DESC
        `);
        for (const tick of rtdsTicks) {
          const sym = tick.symbol?.toLowerCase();
          if (instruments[sym]) {
            instruments[sym].feedHealth[tick.topic] = {
              price: Number(tick.price),
              lastTickAt: tick.timestamp,
            };
          }
        }
      } catch {
        // rtds_ticks table may not exist
      }

      // Attach open positions per instrument
      try {
        const openPositions = await persistence.all(`
          SELECT id, window_id, market_id, token_id, side, size,
                 entry_price, current_price, status, strategy_id, opened_at, pnl,
                 lifecycle_state, mode
          FROM positions
          WHERE status = 'open'
          ORDER BY opened_at DESC
        `);
        for (const pos of openPositions) {
          // Try to match instrument from token_id or window_id
          for (const sym of symbols) {
            if ((pos.token_id || '').toLowerCase().includes(sym) ||
                (pos.window_id || '').toLowerCase().includes(sym)) {
              if (!instruments[sym].positions) instruments[sym].positions = [];
              instruments[sym].positions.push(pos);
              break;
            }
          }
        }
      } catch {
        // positions table may not be available
      }

      // Active windows per instrument
      const windowManager = modules['window-manager'] || {};
      if (windowManager.windows) {
        for (const w of Object.values(windowManager.windows)) {
          const sym = (w.crypto || w.symbol || '').toLowerCase();
          if (instruments[sym]) {
            if (!instruments[sym].activeWindows) instruments[sym].activeWindows = [];
            instruments[sym].activeWindows.push({
              windowId: w.window_id || w.id,
              marketId: w.market_id,
              timeRemainingMs: w.time_remaining_ms || w.timeRemaining,
              referencePrice: w.reference_price,
              yesPrice: w.yes_price || w.market_price,
            });
          }
        }
      }

      json(res, 200, { instruments });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/trades/export - CSV export of trades
  if (req.method === 'GET' && url === '/api/trades/export') {
    try {
      const rows = await persistence.all(`
        SELECT id, window_id, market_id, token_id, side, size,
               entry_price, current_price, close_price, status,
               strategy_id, opened_at, closed_at, pnl, order_id, mode
        FROM positions
        ORDER BY COALESCE(closed_at, opened_at) DESC
        LIMIT 10000
      `);

      const headers = [
        'id', 'window_id', 'market_id', 'token_id', 'side', 'size',
        'entry_price', 'close_price', 'status', 'strategy_id',
        'opened_at', 'closed_at', 'pnl', 'order_id', 'mode',
      ];
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        csvLines.push(headers.map(h => {
          const val = row[h];
          if (val == null) return '';
          const str = String(val);
          return str.includes(',') ? `"${str}"` : str;
        }).join(','));
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="trades.csv"',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(csvLines.join('\n'));
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/feed-health - Per-feed health status and gap history
  if (req.method === 'GET' && url === '/api/feed-health') {
    try {
      const state = await orchestrator.getState();
      const feedMonitorState = state.modules?.['feed-monitor'] || {};
      const feeds = feedMonitorState.feeds || {};
      const activeGapCount = feedMonitorState.activeGapCount || 0;

      // Also fetch recent gaps from DB
      let recentGaps = [];
      try {
        recentGaps = await persistence.all(`
          SELECT id, feed_name, symbol, gap_start, gap_end, duration_seconds
          FROM feed_gaps
          ORDER BY gap_start DESC
          LIMIT 50
        `);
      } catch {
        // feed_gaps table may not exist yet
      }

      json(res, 200, { feeds, activeGapCount, recentGaps });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/assertions - Assertion check results
  if (req.method === 'GET' && url === '/api/assertions') {
    try {
      const state = await orchestrator.getState();
      const cb = state.modules?.['circuit-breaker'] || {};
      const assertionsState = state.modules?.['assertions'] || {};
      json(res, 200, {
        circuitBreakerState: cb.state || 'UNKNOWN',
        assertions: assertionsState.assertions || cb.lastCheckResults || [],
        lastCheckAt: assertionsState.lastCheckAt || cb.lastCheckAt || null,
        stats: assertionsState.stats || null,
      });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/controls - Runtime controls
  if (req.method === 'GET' && url === '/api/controls') {
    try {
      const rows = await persistence.all(`
        SELECT key, value, updated_at
        FROM runtime_controls
        ORDER BY key
      `);
      json(res, 200, { controls: rows });
    } catch (err) {
      // Table may not exist yet
      json(res, 200, { controls: [], error: 'runtime_controls table not available' });
    }
    return true;
  }

  // POST /api/controls - Update a runtime control { key, value }
  if (req.method === 'POST' && url === '/api/controls') {
    try {
      const body = await readBody(req);
      const { key, value } = JSON.parse(body);

      const result = await runtimeControls.updateControl(key, value);

      // Side-effect: if kill_switch changed, also pause/resume the orchestrator
      if (key === 'kill_switch') {
        if (value === 'pause' || value === 'flatten' || value === 'emergency') {
          orchestrator.pause();
        } else if (value === 'off') {
          orchestrator.resume();
        }
      }

      json(res, 200, { success: true, control: result });
    } catch (err) {
      json(res, 400, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/controls/clear-entries - Clear stale window_entries to allow retries
  if (req.method === 'POST' && url === '/api/controls/clear-entries') {
    try {
      const result = await persistence.run(`DELETE FROM window_entries`);
      json(res, 200, { success: true, deleted: result.changes });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/controls/:action - Kill switch actions (legacy)
  if (req.method === 'POST' && url === '/api/controls/pause') {
    try {
      await runtimeControls.updateControl('kill_switch', 'pause');
      orchestrator.pause();
      json(res, 200, { success: true, action: 'pause' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === 'POST' && url === '/api/controls/resume') {
    try {
      await runtimeControls.updateControl('kill_switch', 'off');
      orchestrator.resume();
      json(res, 200, { success: true, action: 'resume' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === 'POST' && url === '/api/controls/stop') {
    try {
      await runtimeControls.updateControl('kill_switch', 'emergency');
      orchestrator.stop();
      json(res, 200, { success: true, action: 'stop' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}

/**
 * Shut down the dashboard API.
 */
export function shutdownDashboard() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (wss) {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    wss = null;
  }
}

/**
 * Parse query parameters from a URL string.
 *
 * @param {string} rawUrl - Raw URL with query string
 * @returns {Object} Key-value query params
 */
function parseQueryParams(rawUrl) {
  const qIdx = rawUrl?.indexOf('?');
  if (!rawUrl || qIdx === -1) return {};
  const search = rawUrl.slice(qIdx + 1);
  const params = {};
  for (const pair of search.split('&')) {
    const [key, ...rest] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return params;
}

/**
 * Read the full request body as a string.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * JSON response helper.
 */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
