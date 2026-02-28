/**
 * Health Endpoint Tests
 *
 * Tests for the /api/live/status health endpoint functionality.
 * Tests the status response building, health determination, and error counting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';

// ================================
// MOCK SETUP
// ================================

// Mock orchestrator state
const mockOrchestratorState = {
  state: 'running',
  initialized: true,
  running: true,
  paused: false,
  startedAt: '2026-02-01T10:00:00.000Z',
  errorCount: 0,
  errorCount1m: 0, // Added for health endpoint - now exposed via getState()
  loadedStrategies: ['simple-threshold', 'oracle-edge'],
  manifest: {
    strategies: ['simple-threshold', 'oracle-edge'],
    position_size_dollars: 10,
    max_exposure_dollars: 500,
  },
  modules: {
    persistence: { initialized: true },
    'rtds-client': {
      connected: true,
      stats: { last_tick_at: '2026-02-01T12:34:56.789Z' }
    },
    polymarket: { authenticated: true },
    'window-manager': { activeWindows: 4 },
  },
};

const mockGetState = vi.fn(() => ({ ...mockOrchestratorState }));

vi.mock('../../src/modules/orchestrator/index.js', () => ({
  getState: mockGetState,
}));

vi.mock('../../src/modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import functions after mocks
const {
  buildStatusResponse,
  determineHealthStatus,
  getConnectionStatus,
} = await import('../health-endpoint.mjs');

describe('Health Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ ...mockOrchestratorState });
  });

  describe('buildStatusResponse()', () => {
    it('should return complete status response with all required fields', async () => {
      const response = await buildStatusResponse();

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('uptime_seconds');
      expect(response).toHaveProperty('active_strategies');
      expect(response).toHaveProperty('connections');
      expect(response).toHaveProperty('last_tick');
      expect(response).toHaveProperty('active_windows');
      expect(response).toHaveProperty('error_count_1m');
    });

    it('should return active_strategies from orchestrator loadedStrategies', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        loadedStrategies: ['oracle-edge', 'momentum'],
      });

      const response = await buildStatusResponse();

      expect(response.active_strategies).toEqual(['oracle-edge', 'momentum']);
    });

    it('should calculate uptime_seconds from startedAt', async () => {
      const startedAt = new Date(Date.now() - 1234 * 1000).toISOString();
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        startedAt,
      });

      const response = await buildStatusResponse();

      // Allow 1 second tolerance for test execution time
      expect(response.uptime_seconds).toBeGreaterThanOrEqual(1233);
      expect(response.uptime_seconds).toBeLessThanOrEqual(1235);
    });

    it('should include connection status for all services', async () => {
      const response = await buildStatusResponse();

      expect(response.connections).toHaveProperty('database');
      expect(response.connections).toHaveProperty('rtds');
      expect(response.connections).toHaveProperty('polymarket');
    });

    it('should include last_tick from RTDS stats', async () => {
      const response = await buildStatusResponse();

      expect(response.last_tick).toBe('2026-02-01T12:34:56.789Z');
    });

    it('should include active_windows from window-manager', async () => {
      const response = await buildStatusResponse();

      expect(response.active_windows).toBe(4);
    });

    it('should include error_count_1m from orchestrator state', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        errorCount1m: 3,
      });

      const response = await buildStatusResponse();

      expect(response.error_count_1m).toBe(3);
    });

    it('should return empty array for active_strategies when loadedStrategies is undefined', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        loadedStrategies: undefined,
      });

      const response = await buildStatusResponse();

      expect(response.active_strategies).toEqual([]);
    });

    it('should return 0 uptime when startedAt is null', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        startedAt: null,
      });

      const response = await buildStatusResponse();

      expect(response.uptime_seconds).toBe(0);
    });

    it('should return null for last_tick when RTDS has no ticks', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {
          ...mockOrchestratorState.modules,
          'rtds-client': { connected: true, stats: { last_tick_at: null } },
        },
      });

      const response = await buildStatusResponse();

      expect(response.last_tick).toBeNull();
    });
  });

  describe('getConnectionStatus()', () => {
    it('should return connected for initialized database', async () => {
      const connections = await getConnectionStatus();

      expect(connections.database).toBe('connected');
    });

    it('should return disconnected for uninitialized database', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {
          ...mockOrchestratorState.modules,
          persistence: { initialized: false },
        },
      });

      const connections = await getConnectionStatus();

      expect(connections.database).toBe('disconnected');
    });

    it('should return connected for connected RTDS', async () => {
      const connections = await getConnectionStatus();

      expect(connections.rtds).toBe('connected');
    });

    it('should return disconnected for disconnected RTDS', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {
          ...mockOrchestratorState.modules,
          'rtds-client': { connected: false },
        },
      });

      const connections = await getConnectionStatus();

      expect(connections.rtds).toBe('disconnected');
    });

    it('should return authenticated for authenticated polymarket', async () => {
      const connections = await getConnectionStatus();

      expect(connections.polymarket).toBe('authenticated');
    });

    it('should return disconnected for unauthenticated polymarket', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {
          ...mockOrchestratorState.modules,
          polymarket: { authenticated: false },
        },
      });

      const connections = await getConnectionStatus();

      expect(connections.polymarket).toBe('disconnected');
    });

    it('should return unknown for missing module state', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {},
      });

      const connections = await getConnectionStatus();

      expect(connections.database).toBe('unknown');
      expect(connections.rtds).toBe('unknown');
      expect(connections.polymarket).toBe('unknown');
    });
  });

  describe('determineHealthStatus()', () => {
    it('should return healthy when all connections ok, no errors, and receiving ticks', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('healthy');
    });

    it('should return degraded when error count is moderate (1-9)', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();
      const errorCount1m = 5;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('degraded');
    });

    it('should return degraded when some connections are down', () => {
      const connections = {
        database: 'connected',
        rtds: 'disconnected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('degraded');
    });

    it('should return degraded when no recent ticks', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('degraded');
    });

    it('should return unhealthy when database is down', () => {
      const connections = {
        database: 'disconnected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('unhealthy');
    });

    it('should return unhealthy when error count is high (>=10)', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();
      const errorCount1m = 10;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('unhealthy');
    });

    it('should return unhealthy when last_tick is null', () => {
      const connections = {
        database: 'connected',
        rtds: 'disconnected',
        polymarket: 'authenticated',
      };
      const lastTick = null;
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('unhealthy');
    });

    it('should handle unknown connection status as potential issue', () => {
      const connections = {
        database: 'unknown',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      expect(status).toBe('degraded');
    });
  });
});

describe('Edge Cases and Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ ...mockOrchestratorState });
  });

  describe('buildStatusResponse() error resilience', () => {
    it('should return unhealthy status when orchestrator.getState() throws', async () => {
      mockGetState.mockImplementation(() => {
        throw new Error('Orchestrator not initialized');
      });

      const response = await buildStatusResponse();

      expect(response.status).toBe('unhealthy');
      expect(response.error).toBe('state_unavailable');
      expect(response.uptime_seconds).toBe(0);
      expect(response.active_strategies).toEqual([]);
    });

    it('should handle missing errorCount1m in state gracefully', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        errorCount1m: undefined,
      });

      const response = await buildStatusResponse();

      expect(response.error_count_1m).toBe(0);
    });

    it('should return non-negative uptime even with future startedAt (clock skew)', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString(); // 1 minute in future
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        startedAt: futureDate,
      });

      const response = await buildStatusResponse();

      expect(response.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty modules object', async () => {
      mockGetState.mockReturnValue({
        ...mockOrchestratorState,
        modules: {},
      });

      const response = await buildStatusResponse();

      expect(response.connections.database).toBe('unknown');
      expect(response.connections.rtds).toBe('unknown');
      expect(response.connections.polymarket).toBe('unknown');
      expect(response.last_tick).toBeNull();
      expect(response.active_windows).toBe(0);
    });
  });

  describe('getConnectionStatus() error resilience', () => {
    it('should return all unknown when orchestrator.getState() throws', async () => {
      mockGetState.mockImplementation(() => {
        throw new Error('Orchestrator crashed');
      });

      const connections = await getConnectionStatus();

      expect(connections.database).toBe('unknown');
      expect(connections.rtds).toBe('unknown');
      expect(connections.polymarket).toBe('unknown');
    });
  });

  describe('determineHealthStatus() edge cases', () => {
    it('should handle invalid date string in lastTick gracefully', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = 'not-a-valid-date';
      const errorCount1m = 0;

      // Should not throw - Invalid Date comparison returns false for "recent"
      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      // Not healthy because tick is not "recent" (Invalid Date fails the check)
      expect(status).toBe('degraded');
    });

    it('should return degraded when lastTick is null but RTDS is connected', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = null;
      const errorCount1m = 0;

      const status = determineHealthStatus(connections, errorCount1m, lastTick);

      // With RTDS connected but no ticks, it's degraded not unhealthy
      expect(status).toBe('degraded');
    });

    it('should handle exactly 10 errors as unhealthy threshold', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const lastTick = new Date(Date.now() - 5000).toISOString();

      expect(determineHealthStatus(connections, 9, lastTick)).toBe('degraded');
      expect(determineHealthStatus(connections, 10, lastTick)).toBe('unhealthy');
    });

    it('should handle exactly 30 second tick age as threshold', () => {
      const connections = {
        database: 'connected',
        rtds: 'connected',
        polymarket: 'authenticated',
      };
      const errorCount1m = 0;

      // Just under 30s - should be healthy
      const recentTick = new Date(Date.now() - 29999).toISOString();
      expect(determineHealthStatus(connections, errorCount1m, recentTick)).toBe('healthy');

      // Exactly 30s - should be degraded (>= 30000)
      const staleTick = new Date(Date.now() - 30000).toISOString();
      expect(determineHealthStatus(connections, errorCount1m, staleTick)).toBe('degraded');
    });
  });
});

describe('Response Serialization', () => {
  it('should produce valid JSON-serializable response', async () => {
    // Reset mock to return valid state
    mockGetState.mockReturnValue({ ...mockOrchestratorState });

    // Import the health endpoint module functions directly
    const response = await buildStatusResponse();

    // Verify JSON structure
    expect(response).toMatchObject({
      status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
      uptime_seconds: expect.any(Number),
      active_strategies: expect.any(Array),
      connections: expect.objectContaining({
        database: expect.any(String),
        rtds: expect.any(String),
        polymarket: expect.any(String),
      }),
      active_windows: expect.any(Number),
      error_count_1m: expect.any(Number),
    });

    // Verify serializable to JSON (no circular refs, functions, etc)
    const jsonString = JSON.stringify(response);
    expect(jsonString).toBeTruthy();
    const parsed = JSON.parse(jsonString);
    expect(parsed).toEqual(response);
  });

  it('should complete response building within 100ms (performance)', async () => {
    mockGetState.mockReturnValue({ ...mockOrchestratorState });

    const start = Date.now();

    // Call buildStatusResponse many times to detect any performance issues
    for (let i = 0; i < 100; i++) {
      await buildStatusResponse();
    }

    const elapsed = Date.now() - start;

    // 100 calls should complete well under 100ms (1ms per call budget)
    // This leaves plenty of margin for the <500ms requirement
    expect(elapsed).toBeLessThan(100);
  });
});

describe('HTTP Server Integration', () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ ...mockOrchestratorState });
    // Create HTTP server for testing
    port = 3334 + Math.floor(Math.random() * 1000); // Random port to avoid conflicts
    server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/live/status') {
        const status = await buildStatusResponse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    await new Promise((resolve) => server.listen(port, resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('should respond with valid JSON on actual HTTP request to /api/live/status', async () => {
    const response = await fetch(`http://localhost:${port}/api/live/status`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const data = await response.json();
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('uptime_seconds');
    expect(data).toHaveProperty('active_strategies');
    expect(data).toHaveProperty('connections');
    expect(data).toHaveProperty('last_tick');
    expect(data).toHaveProperty('active_windows');
    expect(data).toHaveProperty('error_count_1m');
  });

  it('should respond within 500ms (AC#3 performance requirement)', async () => {
    const start = Date.now();
    const response = await fetch(`http://localhost:${port}/api/live/status`);
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(500);
  });

  it('should return 404 for unknown paths', async () => {
    const response = await fetch(`http://localhost:${port}/unknown`);
    expect(response.status).toBe(404);
  });
});
