/**
 * State Snapshot Tests
 *
 * Tests for the state snapshot module including:
 * - Writing snapshots atomically
 * - Reading snapshots
 * - Staleness detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  writeSnapshot,
  readSnapshot,
  isSnapshotStale,
  buildSnapshot,
  getSnapshotAge,
  markAsForcedKill,
  SNAPSHOT_VERSION,
} from '../state-snapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const testStateFile = path.join(fixturesDir, 'test-state.json');

describe('State Snapshot', () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
    // Clean up any existing test file
    if (fs.existsSync(testStateFile)) {
      fs.unlinkSync(testStateFile);
    }
  });

  afterEach(() => {
    // Clean up test state file
    if (fs.existsSync(testStateFile)) {
      fs.unlinkSync(testStateFile);
    }
    // Clean up temp file if exists
    const tempFile = testStateFile + '.tmp';
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  });

  describe('writeSnapshot', () => {
    it('should write valid JSON file', async () => {
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        forced_kill: false,
        stale_warning: false,
        positions: [],
        orders: [],
        summary: {
          open_positions: 0,
          open_orders: 0,
          total_exposure: 0,
        },
      };

      await writeSnapshot(snapshot, testStateFile);

      expect(fs.existsSync(testStateFile)).toBe(true);
      const content = fs.readFileSync(testStateFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(SNAPSHOT_VERSION);
      expect(parsed.pid).toBe(process.pid);
    });

    it('should create directory if not exists', async () => {
      const nestedPath = path.join(fixturesDir, 'nested', 'dir', 'state.json');
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        forced_kill: false,
        stale_warning: false,
        positions: [],
        orders: [],
        summary: { open_positions: 0, open_orders: 0, total_exposure: 0 },
      };

      await writeSnapshot(snapshot, nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      // Clean up
      fs.unlinkSync(nestedPath);
      fs.rmdirSync(path.dirname(nestedPath));
      fs.rmdirSync(path.join(fixturesDir, 'nested'));
    });

    it('should write atomically (temp file then rename)', async () => {
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        forced_kill: false,
        stale_warning: false,
        positions: [],
        orders: [],
        summary: { open_positions: 0, open_orders: 0, total_exposure: 0 },
      };

      await writeSnapshot(snapshot, testStateFile);

      // Temp file should not exist after successful write
      const tempFile = testStateFile + '.tmp';
      expect(fs.existsSync(tempFile)).toBe(false);
      // Main file should exist
      expect(fs.existsSync(testStateFile)).toBe(true);
    });

    it('should format JSON with indentation', async () => {
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        forced_kill: false,
        stale_warning: false,
        positions: [],
        orders: [],
        summary: { open_positions: 0, open_orders: 0, total_exposure: 0 },
      };

      await writeSnapshot(snapshot, testStateFile);

      const content = fs.readFileSync(testStateFile, 'utf-8');
      // Check for newlines (indicating formatted JSON)
      expect(content).toContain('\n');
      expect(content).toContain('  '); // 2-space indentation
    });
  });

  describe('readSnapshot', () => {
    it('should return null for non-existent file', () => {
      const result = readSnapshot('/nonexistent/path/state.json');
      expect(result).toBeNull();
    });

    it('should parse valid JSON file', () => {
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: '2026-01-31T10:00:00.000Z',
        pid: 12345,
        forced_kill: false,
        stale_warning: false,
        positions: [{ id: 1, size: 10 }],
        orders: [],
        summary: { open_positions: 1, open_orders: 0, total_exposure: 5 },
      };
      fs.writeFileSync(testStateFile, JSON.stringify(snapshot), 'utf-8');

      const result = readSnapshot(testStateFile);

      expect(result).toEqual(snapshot);
    });

    it('should return null for corrupted JSON', () => {
      fs.writeFileSync(testStateFile, 'not-valid-json{', 'utf-8');

      const result = readSnapshot(testStateFile);

      expect(result).toBeNull();
    });

    it('should return null for empty file', () => {
      fs.writeFileSync(testStateFile, '', 'utf-8');

      const result = readSnapshot(testStateFile);

      expect(result).toBeNull();
    });
  });

  describe('isSnapshotStale', () => {
    it('should return true for non-existent file', () => {
      const result = isSnapshotStale('/nonexistent/path/state.json', 5000);
      expect(result).toBe(true);
    });

    it('should return true for old snapshot', () => {
      // Snapshot from 10 seconds ago
      const oldTimestamp = new Date(Date.now() - 10000).toISOString();
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: oldTimestamp,
        pid: 12345,
      };
      fs.writeFileSync(testStateFile, JSON.stringify(snapshot), 'utf-8');

      // Check with 5 second threshold
      const result = isSnapshotStale(testStateFile, 5000);

      expect(result).toBe(true);
    });

    it('should return false for fresh snapshot', () => {
      // Snapshot from right now
      const freshTimestamp = new Date().toISOString();
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: freshTimestamp,
        pid: 12345,
      };
      fs.writeFileSync(testStateFile, JSON.stringify(snapshot), 'utf-8');

      // Check with 5 second threshold
      const result = isSnapshotStale(testStateFile, 5000);

      expect(result).toBe(false);
    });

    it('should use default threshold of 5000ms', () => {
      // Snapshot from 3 seconds ago (should not be stale)
      const recentTimestamp = new Date(Date.now() - 3000).toISOString();
      const snapshot = {
        version: SNAPSHOT_VERSION,
        timestamp: recentTimestamp,
        pid: 12345,
      };
      fs.writeFileSync(testStateFile, JSON.stringify(snapshot), 'utf-8');

      const result = isSnapshotStale(testStateFile);

      expect(result).toBe(false);
    });

    it('should return true for corrupted snapshot', () => {
      fs.writeFileSync(testStateFile, 'not-json', 'utf-8');

      const result = isSnapshotStale(testStateFile, 5000);

      expect(result).toBe(true);
    });
  });

  describe('buildSnapshot', () => {
    it('should create snapshot with version field', () => {
      const orchestratorState = {
        state: 'running',
        startedAt: '2026-01-31T08:00:00.000Z',
        errorCount: 0,
      };

      const snapshot = buildSnapshot(orchestratorState, [], []);

      expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    });

    it('should include timestamp in ISO format', () => {
      const orchestratorState = { state: 'running', errorCount: 0 };

      const snapshot = buildSnapshot(orchestratorState, [], []);

      expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include current process PID', () => {
      const orchestratorState = { state: 'running', errorCount: 0 };

      const snapshot = buildSnapshot(orchestratorState, [], []);

      expect(snapshot.pid).toBe(process.pid);
    });

    it('should set forced_kill to false by default', () => {
      const orchestratorState = { state: 'running', errorCount: 0 };

      const snapshot = buildSnapshot(orchestratorState, [], []);

      expect(snapshot.forced_kill).toBe(false);
      expect(snapshot.stale_warning).toBe(false);
    });

    it('should include positions array', () => {
      const positions = [
        { id: 1, market_id: 'market-1', size: 10, entry_price: 0.5 },
        { id: 2, market_id: 'market-2', size: 20, entry_price: 0.6 },
      ];

      const snapshot = buildSnapshot({ state: 'running' }, positions, []);

      expect(snapshot.positions).toEqual(positions);
    });

    it('should include orders array', () => {
      const orders = [
        { order_id: 'ord-1', size: 10, status: 'open' },
      ];

      const snapshot = buildSnapshot({ state: 'running' }, [], orders);

      expect(snapshot.orders).toEqual(orders);
    });

    it('should calculate summary statistics', () => {
      const positions = [
        { id: 1, size: 10, entry_price: 0.5 },
        { id: 2, size: 20, entry_price: 0.6 },
      ];
      const orders = [
        { order_id: 'ord-1', status: 'open' },
        { order_id: 'ord-2', status: 'open' },
      ];

      const snapshot = buildSnapshot({ state: 'running' }, positions, orders);

      expect(snapshot.summary.open_positions).toBe(2);
      expect(snapshot.summary.open_orders).toBe(2);
      expect(snapshot.summary.total_exposure).toBe(10 * 0.5 + 20 * 0.6); // 17
    });

    it('should include orchestrator state', () => {
      const orchestratorState = {
        state: 'running',
        startedAt: '2026-01-31T08:00:00.000Z',
        errorCount: 5,
        recoveryCount: 2,
      };

      const snapshot = buildSnapshot(orchestratorState, [], []);

      expect(snapshot.orchestrator).toEqual({
        state: 'running',
        started_at: '2026-01-31T08:00:00.000Z',
        error_count: 5,
      });
    });
  });

  describe('Snapshot Schema Compliance', () => {
    it('should use snake_case for all fields', async () => {
      const snapshot = buildSnapshot(
        { state: 'running', startedAt: '2026-01-31T08:00:00.000Z', errorCount: 0 },
        [{ id: 1, market_id: 'mkt', size: 10, entry_price: 0.5 }],
        [{ order_id: 'ord-1', status: 'open' }]
      );

      await writeSnapshot(snapshot, testStateFile);
      const content = fs.readFileSync(testStateFile, 'utf-8');

      // Check for snake_case keys
      expect(content).toContain('forced_kill');
      expect(content).toContain('stale_warning');
      expect(content).toContain('started_at');
      expect(content).toContain('error_count');
      expect(content).toContain('open_positions');
      expect(content).toContain('open_orders');
      expect(content).toContain('total_exposure');

      // Should not contain camelCase versions
      expect(content).not.toContain('forcedKill');
      expect(content).not.toContain('staleWarning');
      expect(content).not.toContain('startedAt');
      expect(content).not.toContain('errorCount');
    });
  });

  describe('markAsForcedKill', () => {
    it('should set forced_kill to true', () => {
      const snapshot = buildSnapshot({ state: 'running' }, [], []);
      const marked = markAsForcedKill(snapshot, false);

      expect(marked.forced_kill).toBe(true);
      expect(marked.stale_warning).toBe(false);
    });

    it('should set stale_warning when isStale is true', () => {
      const snapshot = buildSnapshot({ state: 'running' }, [], []);
      const marked = markAsForcedKill(snapshot, true);

      expect(marked.forced_kill).toBe(true);
      expect(marked.stale_warning).toBe(true);
    });

    it('should preserve other snapshot fields', () => {
      const positions = [{ id: 1, size: 10, entry_price: 0.5 }];
      const orders = [{ order_id: 'ord-1', status: 'open' }];
      const snapshot = buildSnapshot({ state: 'running', errorCount: 5 }, positions, orders);
      const marked = markAsForcedKill(snapshot, false);

      expect(marked.positions).toEqual(positions);
      expect(marked.orders).toEqual(orders);
      expect(marked.summary.open_positions).toBe(1);
      expect(marked.summary.open_orders).toBe(1);
      expect(marked.orchestrator.error_count).toBe(5);
    });
  });

  describe('getSnapshotAge', () => {
    it('should return null for non-existent file', () => {
      const result = getSnapshotAge('/nonexistent/path/state.json');
      expect(result).toBeNull();
    });

    it('should return age in milliseconds', () => {
      // Create a snapshot from 3 seconds ago
      const timestamp = new Date(Date.now() - 3000).toISOString();
      const snapshot = { version: SNAPSHOT_VERSION, timestamp };
      fs.writeFileSync(testStateFile, JSON.stringify(snapshot), 'utf-8');

      const age = getSnapshotAge(testStateFile);

      // Should be approximately 3000ms (with some tolerance)
      expect(age).toBeGreaterThan(2800);
      expect(age).toBeLessThan(4000);
    });
  });
});
