/**
 * Factory API Standalone Server
 *
 * Lightweight HTTP server for the Quant Factory backtester.
 * Deploys as its own Railway service — completely separate from the trading system.
 *
 * Initializes ONLY: persistence (PG connection) + factory modules.
 * Does NOT initialize: orchestrator, trading system, paper trader, or any trading modules.
 *
 * Startup target: <5 seconds (vs 60+ for the full trading system).
 */

import { createServer } from 'http';
import persistence from '../src/persistence/index.js';
import { ensurePgTimelineTable } from '../src/factory/pg-timeline-store.js';
import { handleFactoryRequest } from './factory-api.mjs';

const PORT = parseInt(process.env.PORT || '3334', 10);

// ─── Minimal Config for Persistence ───

function buildDbConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[factory-server] ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  return {
    database: {
      url,
      pool: { min: 1, max: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000 },
      circuitBreakerPool: { min: 1, max: 2, idleTimeoutMs: 30000, connectionTimeoutMs: 3000 },
      queryTimeoutMs: 30000, // 30s for BYTEA reads
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  };
}

// ─── HTTP Server ───

function createFactoryServer() {
  const server = createServer(async (req, res) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = (req.url || '').split('?')[0];

    // Health check
    if (url === '/health' && req.method === 'GET') {
      const state = persistence.getState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'factory-api',
        uptime: process.uptime(),
        db: { connected: state.connected },
      }));
      return;
    }

    // Factory API routes — delegate to factory-api.mjs handler
    if (url.startsWith('/api/factory')) {
      try {
        const handled = await handleFactoryRequest(req, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        }
      } catch (err) {
        console.error('[factory-server] Unhandled error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      }
      return;
    }

    // Unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  return server;
}

// ─── Startup ───

async function main() {
  const startTime = Date.now();
  console.log('[factory-server] Starting Factory API server...');

  // 1. Initialize persistence (PG connection only — skip schema/migrations for speed)
  const config = buildDbConfig();
  try {
    await persistence.initConnectionOnly(config);
    console.log('[factory-server] Database connection established');
  } catch (err) {
    console.error('[factory-server] Failed to connect to database:', err.message);
    process.exit(1);
  }

  // 2. Ensure pg_timelines table exists
  try {
    await ensurePgTimelineTable();
    console.log('[factory-server] pg_timelines table ready');
  } catch (err) {
    console.warn('[factory-server] Warning: could not ensure pg_timelines table:', err.message);
    // Non-fatal — table may already exist, and endpoints handle missing tables gracefully
  }

  // 3. Start HTTP server
  const server = createFactoryServer();

  server.listen(PORT, () => {
    const elapsed = Date.now() - startTime;
    console.log(`[factory-server] Factory API server ready on port ${PORT} (${elapsed}ms startup)`);
  });

  // ─── Graceful Shutdown ───

  const shutdown = async (signal) => {
    console.log(`[factory-server] ${signal} received, shutting down...`);
    server.close();
    try {
      await persistence.shutdown();
    } catch {
      // Ignore shutdown errors
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[factory-server] Fatal startup error:', err);
  process.exit(1);
});
