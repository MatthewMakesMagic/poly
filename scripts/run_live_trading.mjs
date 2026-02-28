#!/usr/bin/env node
/**
 * Live Trading Entry Point
 *
 * Starts the modular orchestrator for live trading.
 * Uses the new modular system from src/modules/orchestrator/.
 *
 * Usage:
 *   npm run live           # Start live trading
 *   npm run live:paper     # Not implemented - see paper trading note
 *
 * Environment Variables:
 *   See .env.example for required variables
 *   Position sizing is configured in config/default.js
 *   PORT - HTTP server port for health endpoint (default: 3333)
 */

// IMMEDIATE DEBUG: Log env var BEFORE dotenv or any imports
console.log(`[STARTUP] LIVE_TRADING_ENABLED (before dotenv): "${process.env.LIVE_TRADING_ENABLED}"`);

import { config as loadEnv } from 'dotenv';

// Load environment variables FIRST, before any other imports
loadEnv({ path: '.env.local' });
loadEnv(); // Fallback to .env

// DEBUG: Log env var AFTER dotenv loads
console.log(`[STARTUP] LIVE_TRADING_ENABLED (after dotenv): "${process.env.LIVE_TRADING_ENABLED}"`);

// Now import the configuration and orchestrator
import { createServer } from 'http';
import config from '../config/index.js';
import * as orchestrator from '../src/modules/orchestrator/index.js';
import persistence from '../src/persistence/index.js';
import { init as initLogger, child } from '../src/modules/logger/index.js';
import { buildStatusResponse, buildHealthResponse } from './health-endpoint.mjs';

// Initialize logger BEFORE creating any child loggers
await initLogger({ level: config.logging?.level || 'info', console: true });

// Create logger for this script
const log = child({ module: 'run-live-trading' });

// HTTP server port - validate and coerce to integer
const PORT = (() => {
  const envPort = process.env.PORT;
  if (!envPort) return 3333;
  const parsed = parseInt(envPort, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid PORT "${envPort}", using default 3333`);
    return 3333;
  }
  return parsed;
})();

// Track shutdown state
let isShuttingDown = false;
let httpServer = null;

/**
 * Create HTTP server for health endpoint
 *
 * @returns {http.Server} HTTP server instance
 */
function createHealthServer() {
  const server = createServer(async (req, res) => {
    // Log at debug level to avoid spam
    log.debug('http_request', { method: req.method, url: req.url });

    if (req.method === 'GET' && req.url === '/api/live/status') {
      try {
        const status = buildStatusResponse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } catch (err) {
        log.error('health_endpoint_error', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', error: 'internal_error' }));
      }
    } else if (req.method === 'GET' && req.url === '/api/paper-trader') {
      try {
        const state = orchestrator.getState();
        const pt = state.modules?.['paper-trader'] || { error: 'module not found in state' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pt, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'GET' && req.url === '/api/paper-trader/trades') {
      // DB query: paper trade history + summary stats
      try {
        const summary = await persistence.get(`
          SELECT
            COUNT(*) as total_trades,
            COUNT(*) FILTER (WHERE won = true) as wins,
            COUNT(*) FILTER (WHERE won = false) as losses,
            COUNT(*) FILTER (WHERE settlement_time IS NULL) as pending,
            COALESCE(SUM(net_pnl), 0) as cumulative_pnl,
            COUNT(DISTINCT window_id) as windows_evaluated,
            COUNT(DISTINCT signal_offset_sec) as distinct_timings,
            MIN(signal_time) as first_trade_at,
            MAX(signal_time) as last_trade_at
          FROM paper_trades_v2
        `);
        const byVariant = await persistence.all(`
          SELECT variant_label, signal_offset_sec,
            COUNT(*) as trades,
            COUNT(*) FILTER (WHERE won = true) as wins,
            COUNT(*) FILTER (WHERE won = false) as losses,
            ROUND(COALESCE(SUM(net_pnl), 0)::numeric, 2) as pnl,
            ROUND(AVG(sim_slippage)::numeric, 6) as avg_slippage,
            ROUND(AVG(sim_levels_consumed)::numeric, 1) as avg_levels
          FROM paper_trades_v2
          GROUP BY variant_label, signal_offset_sec
          ORDER BY signal_offset_sec, variant_label
        `);
        const recent = await persistence.all(`
          SELECT id, window_id, variant_label, signal_offset_sec,
            entry_side, vwap_delta, clob_up_price,
            sim_entry_price, sim_slippage, sim_levels_consumed,
            won, net_pnl, signal_time, settlement_time
          FROM paper_trades_v2
          ORDER BY signal_time DESC
          LIMIT 20
        `);
        const snapshots = await persistence.get(`
          SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE snapshot_type = 'periodic') as periodic,
            COUNT(*) FILTER (WHERE snapshot_type = 'signal') as signal,
            COUNT(*) FILTER (WHERE snapshot_type = 'settlement') as settlement,
            MIN(timestamp) as first_at,
            MAX(timestamp) as last_at
          FROM l2_book_snapshots
        `);
        const latency = await persistence.get(`
          SELECT COUNT(*) as total,
            ROUND(AVG(round_trip_ms)::numeric, 1) as avg_ms,
            MIN(round_trip_ms) as min_ms,
            MAX(round_trip_ms) as max_ms
          FROM latency_measurements
        `);
        const signalEvals = await persistence.all(`
          SELECT
            signal_offset_sec,
            COUNT(*) as evals,
            COUNT(*) FILTER (WHERE won IS NOT NULL) as settled,
            COUNT(*) FILTER (WHERE won = true) as wins,
            ROUND(AVG(ABS(vwap_delta))::numeric, 2) as avg_abs_delta
          FROM paper_trades_v2
          GROUP BY signal_offset_sec
          ORDER BY signal_offset_sec
        `);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary, byVariant, signalEvals, recent, snapshots, latency }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'GET' && req.url === '/health') {
      // Simple liveness check — always 200 if process is running
      // Railway uses this to route traffic; strict checks are at /health/strict
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.method === 'GET' && req.url === '/health/strict') {
      // V3 Stage 5: Strict health check - 200 only when ALL checks pass
      try {
        const health = buildHealthResponse();
        res.writeHead(health.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } catch (err) {
        log.error('health_check_error', { error: err.message });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ healthy: false, error: 'internal_error' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  return server;
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal) {
  if (isShuttingDown) {
    log.warn('shutdown_already_in_progress', { signal });
    return;
  }
  isShuttingDown = true;

  log.info('shutdown_signal_received', { signal });
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  try {
    // Close HTTP server first
    if (httpServer) {
      await new Promise((resolve) => {
        httpServer.close(() => {
          log.info('http_server_closed');
          resolve();
        });
      });
    }

    await orchestrator.shutdown();
    log.info('shutdown_complete');
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (err) {
    log.error('shutdown_failed', { error: err.message, stack: err.stack });
    console.error('Error during shutdown:', err.message);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  // CRITICAL: TRADING MODE CHECK
  const tradingMode = config.tradingMode || 'PAPER';
  const isPaperMode = tradingMode !== 'LIVE';

  console.log('═'.repeat(70));
  if (isPaperMode) {
    console.log('     POLY TRADING - ⚠️  PAPER MODE (SIGNALS ONLY)');
    console.log('     No orders will be executed. Set TRADING_MODE=LIVE to enable.');
  } else {
    console.log('     POLY TRADING - 🔴 LIVE MODE (REAL ORDERS)');
    console.log('     WARNING: Real money is at risk!');
  }
  console.log('═'.repeat(70));
  console.log(`   Trading Mode: ${tradingMode}`);
  console.log(`   Position Size: $${config.strategy?.sizing?.baseSizeDollars || 10}`);
  console.log(`   Max Exposure: $${config.risk?.maxExposure || 500}`);
  console.log(`   Drawdown Limit: ${config.risk?.dailyDrawdownLimit ? (config.risk.dailyDrawdownLimit * 100) + '%' : 'DISABLED'}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   PID: ${process.pid}`);
  console.log('═'.repeat(70));

  // Validate critical environment variables
  const required = [
    'POLYMARKET_API_KEY',
    'POLYMARKET_API_SECRET',
    'POLYMARKET_PASSPHRASE',
    'POLYMARKET_PRIVATE_KEY',
  ];

  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('\nMissing required environment variables:');
    for (const v of missing) {
      console.error(`   - ${v}`);
    }
    console.error('\nPlease set these in your .env file.\n');
    process.exit(1);
  }

  // Register signal handlers
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', async (err) => {
    log.error('uncaught_exception', { error: err.message, stack: err.stack });
    console.error('Uncaught exception:', err);
    await shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled_rejection', { reason: String(reason) });
    console.error('Unhandled rejection:', reason);
    // Don't shutdown on unhandled rejection - log and continue
  });

  try {
    // Initialize orchestrator with config
    log.info('orchestrator_init_start');
    await orchestrator.init(config);

    // Start HTTP server for health endpoint
    httpServer = createHealthServer();
    httpServer.listen(PORT, () => {
      log.info('http_server_started', { port: PORT });
      console.log(`   Health endpoint: http://localhost:${PORT}/api/live/status`);
      console.log(`   Health check:    http://localhost:${PORT}/health`);
    });

    // Start the execution loop
    log.info('orchestrator_starting');
    orchestrator.start();

    console.log('\nOrchestrator running. Press Ctrl+C to stop.\n');
    log.info('orchestrator_running');

    // Keep the process alive
    // The orchestrator's execution loop runs in intervals
    // Process stays alive until shutdown signal
  } catch (err) {
    log.error('startup_failed', { error: err.message, stack: err.stack });
    console.error('\nFailed to start:', err.message);
    if (err.context) {
      console.error('Context:', err.context);
    }
    process.exit(1);
  }
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
