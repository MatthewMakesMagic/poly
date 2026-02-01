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

import { config as loadEnv } from 'dotenv';

// Load environment variables FIRST, before any other imports
loadEnv({ path: '.env.local' });
loadEnv(); // Fallback to .env

// Now import the configuration and orchestrator
import { createServer } from 'http';
import config from '../config/index.js';
import * as orchestrator from '../src/modules/orchestrator/index.js';
import { child } from '../src/modules/logger/index.js';
import { buildStatusResponse } from './health-endpoint.mjs';

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
  const server = createServer((req, res) => {
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
  console.log('═'.repeat(70));
  console.log('     POLY LIVE TRADING - MODULAR SYSTEM');
  console.log('═'.repeat(70));
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Position Size: $${config.strategy?.sizing?.baseSizeDollars || 10}`);
  console.log(`   Max Exposure: $${config.risk?.maxExposure || 500}`);
  console.log(`   Drawdown Limit: ${(config.risk?.dailyDrawdownLimit || 0.05) * 100}%`);
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
