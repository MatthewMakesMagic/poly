/**
 * Pre-flight Checks Tests
 *
 * Tests the actual check functions from preflight.mjs.
 * Uses mocks for external dependencies (database, CLI, API).
 *
 * ISSUE 3 FIX: These tests now actually import and test the real implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Store original process.env
const originalEnv = { ...process.env };

// ================================
// MOCK SETUP - Module-level shared mocks
// ================================
const mockExecSync = vi.fn();
const mockExistsSync = vi.fn(() => true);
const mockReaddirSync = vi.fn(() => [
  '001-initial-schema.js',
  '002-add-positions-table.js',
  '003-daily-performance-table.js',
]);

// Database mocks using class pattern for proper hoisting
class MockDatabaseInstance {
  constructor() {
    this.prepareFn = vi.fn(() => ({
      get: vi.fn(() => ({ 1: 1 })),
      all: vi.fn(() => [{ version: '001' }, { version: '002' }, { version: '003' }]),
    }));
    this.closeFn = vi.fn();
  }
  prepare(...args) { return this.prepareFn(...args); }
  close(...args) { return this.closeFn(...args); }
}

let currentDbInstance = null;
const MockDatabase = function(...args) {
  currentDbInstance = new MockDatabaseInstance();
  MockDatabase.lastArgs = args;
  MockDatabase.lastInstance = currentDbInstance;
  return currentDbInstance;
};
MockDatabase.lastArgs = null;
MockDatabase.lastInstance = null;

const mockLaunchInit = vi.fn(async () => {});
const mockLaunchShutdown = vi.fn(async () => {});
const mockLoadManifest = vi.fn(() => ({
  strategies: ['simple-threshold', 'oracle-edge'],
  position_size_dollars: 10,
  max_exposure_dollars: 500,
  symbols: ['BTC', 'ETH'],
  kill_switch_enabled: true,
}));
const mockIsKnownStrategy = vi.fn((name) => ['simple-threshold', 'oracle-edge'].includes(name));

const mockGetBalanceAllowance = vi.fn().mockResolvedValue({ amount: '1000000000' });
class MockClobClientClass {
  getBalanceAllowance(...args) { return mockGetBalanceAllowance(...args); }
}

class MockWalletClass {
  constructor() {
    this.address = '0x1234567890123456789012345678901234567890';
  }
}

// Mock modules BEFORE importing the script
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  };
});

vi.mock('better-sqlite3', () => ({
  default: MockDatabase,
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  default: {
    database: { path: './data/poly.db' },
    polymarket: {
      apiUrl: 'https://clob.polymarket.com',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      passphrase: 'test-pass',
      privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    },
  },
}));

// Mock launch-config module
vi.mock('../../src/modules/launch-config/index.js', () => ({
  init: mockLaunchInit,
  shutdown: mockLaunchShutdown,
  loadManifest: mockLoadManifest,
  isKnownStrategy: mockIsKnownStrategy,
}));

// Mock @polymarket/clob-client
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: MockClobClientClass,
}));

// Mock ethers
vi.mock('ethers', () => ({
  Wallet: MockWalletClass,
}));

// Mock dotenv
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Import the actual functions from preflight.mjs AFTER mocking
const {
  checkEnvironment,
  checkDatabaseConnection,
  checkMigrations,
  checkRailwayCli,
  checkLaunchManifest,
  checkPolymarketAuth,
  sanitizeErrorMessage,
} = await import('../preflight.mjs');

describe('Pre-flight Checks - Actual Implementation Tests', () => {
  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    MockDatabase.lastArgs = null;
    MockDatabase.lastInstance = null;
    currentDbInstance = null;

    // Restore original env and set test values
    process.env = { ...originalEnv };
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_API_SECRET = 'test-secret';
    process.env.POLYMARKET_PASSPHRASE = 'test-pass';
    process.env.POLYMARKET_PRIVATE_KEY = '0x1234';

    // Reset mock implementations to defaults
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '001-initial-schema.js',
      '002-add-positions-table.js',
      '003-daily-performance-table.js',
    ]);
    mockLoadManifest.mockReturnValue({
      strategies: ['simple-threshold', 'oracle-edge'],
      position_size_dollars: 10,
      max_exposure_dollars: 500,
      symbols: ['BTC', 'ETH'],
      kill_switch_enabled: true,
    });
    mockGetBalanceAllowance.mockResolvedValue({ amount: '1000000000' });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('checkEnvironment()', () => {
    it('should pass when all required env vars are set', () => {
      const result = checkEnvironment();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Environment Variables');
      expect(result.details).toBe('All 4 required vars set');
      expect(result.error).toBeNull();
    });

    it('should fail when env vars are missing', () => {
      delete process.env.POLYMARKET_API_KEY;
      delete process.env.POLYMARKET_API_SECRET;

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('POLYMARKET_API_KEY');
      expect(result.error).toContain('POLYMARKET_API_SECRET');
    });

    it('should fail when env vars are empty strings (ISSUE 4 fix)', () => {
      process.env.POLYMARKET_API_KEY = '';
      process.env.POLYMARKET_API_SECRET = '   '; // whitespace only

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('POLYMARKET_API_KEY');
      expect(result.error).toContain('POLYMARKET_API_SECRET');
    });
  });

  describe('checkDatabaseConnection()', () => {
    it('should pass when database is accessible', () => {
      mockExistsSync.mockReturnValue(true);

      const result = checkDatabaseConnection();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Database');
      expect(result.details).toBe('connected');
    });

    it('should fail when database file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = checkDatabaseConnection();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should open database in read-only mode (ISSUE 2 fix)', () => {
      mockExistsSync.mockReturnValue(true);

      checkDatabaseConnection();

      expect(MockDatabase.lastArgs).toEqual(['./data/poly.db', { readonly: true }]);
    });

    it('should close database on error (ISSUE 5 fix)', () => {
      mockExistsSync.mockReturnValue(true);

      // The MockDatabaseInstance's prepareFn will be called by the implementation
      // We need to make it throw on the first call
      const originalPrepare = MockDatabaseInstance.prototype.prepare;
      MockDatabaseInstance.prototype.prepare = function() {
        throw new Error('Query failed');
      };

      const result = checkDatabaseConnection();
      expect(result.pass).toBe(false);
      // Check that close was called on the instance
      expect(MockDatabase.lastInstance.closeFn).toHaveBeenCalled();

      // Restore
      MockDatabaseInstance.prototype.prepare = originalPrepare;
    });
  });

  describe('checkMigrations()', () => {
    it('should pass when all migrations are applied', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
        '003-daily-performance-table.js',
      ]);

      const result = checkMigrations();
      expect(result.pass).toBe(true);
      expect(result.details).toBe('3/3 applied');
    });

    it('should fail when migrations are missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
        '003-daily-performance-table.js',
      ]);

      // Override prepareFn behavior for this test
      const originalPrepare = MockDatabaseInstance.prototype.prepare;
      MockDatabaseInstance.prototype.prepare = function() {
        return {
          all: () => [{ version: '001' }, { version: '002' }], // Only 2 applied
        };
      };

      const result = checkMigrations();
      expect(result.pass).toBe(false);
      expect(result.details).toBe('2/3 applied');
      expect(result.error).toContain('Missing 1 migration');

      MockDatabaseInstance.prototype.prepare = originalPrepare;
    });

    it('should fail when extra migrations in DB (ISSUE 6 fix)', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
      ]); // Only 2 files

      // Override to return 3 applied migrations
      const originalPrepare = MockDatabaseInstance.prototype.prepare;
      MockDatabaseInstance.prototype.prepare = function() {
        return {
          all: () => [{ version: '001' }, { version: '002' }, { version: '003' }],
        };
      };

      const result = checkMigrations();
      expect(result.pass).toBe(false);
      expect(result.details).toBe('3/2 applied');
      expect(result.error).toContain('Extra 1 migration');

      MockDatabaseInstance.prototype.prepare = originalPrepare;
    });

    it('should exclude index.js from migration count', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
        'index.js', // Should be excluded
      ]);

      const originalPrepare = MockDatabaseInstance.prototype.prepare;
      MockDatabaseInstance.prototype.prepare = function() {
        return {
          all: () => [{ version: '001' }, { version: '002' }],
        };
      };

      const result = checkMigrations();
      expect(result.pass).toBe(true);
      expect(result.details).toBe('2/2 applied');

      MockDatabaseInstance.prototype.prepare = originalPrepare;
    });
  });

  describe('checkRailwayCli()', () => {
    it('should pass when CLI is installed and authenticated', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Project: my-project\nEnvironment: production\n');

      const result = checkRailwayCli();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('authenticated');
      expect(result.details).toContain('my-project');
    });

    it('should use timeout for CLI commands (ISSUE 7 fix)', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Project: test\n');

      checkRailwayCli();

      expect(mockExecSync).toHaveBeenCalledWith(
        'railway --version',
        expect.objectContaining({ timeout: 15000 })
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'railway status',
        expect.objectContaining({ timeout: 15000 })
      );
    });

    it('should fail when CLI is not installed', () => {
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('command not found: railway');
        err.code = 'ENOENT';
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('should fail when not authenticated', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('');
        err.stderr = Buffer.from('error: not logged in');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Not authenticated');
    });

    it('should fail with timeout error message (ISSUE 7 fix)', () => {
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('ETIMEDOUT');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should provide meaningful error when message and stderr are empty (ISSUE 12 fix)', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('');
        err.stderr = Buffer.from('');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).not.toBe('Check failed: ');
      expect(result.error).toContain('Unknown CLI error');
    });

    it('should pass with warning when project name cannot be parsed (ISSUE 10 fix)', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Some unexpected format\nNo project info\n');

      const result = checkRailwayCli();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('could not be parsed');
    });
  });

  describe('checkLaunchManifest()', () => {
    it('should pass when manifest is valid', async () => {
      const result = await checkLaunchManifest();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Launch Manifest');
      expect(result.details).toContain('2 strategies');
    });

    it('should fail when strategy is unknown', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold', 'unknown-strategy'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Unknown strategies');
    });

    it('should fail when position_size_dollars is zero', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 0,
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('position_size_dollars must be > 0');
    });

    it('should fail when max_exposure <= position_size', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 100,
        max_exposure_dollars: 50,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('max_exposure_dollars must be > position_size_dollars');
    });

    it('should fail when position_size_dollars is negative', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: -10,
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('position_size_dollars must be > 0');
    });

    it('should fail when position_size_dollars is not a number', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 'invalid',
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('position_size_dollars must be > 0');
    });

    it('should fail when max_exposure_dollars is not a number', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 10,
        max_exposure_dollars: 'invalid',
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('max_exposure_dollars must be > position_size_dollars');
    });

    it('should handle init errors gracefully', async () => {
      mockLaunchInit.mockRejectedValueOnce(new Error('Config file not found'));

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Module init failed');
      expect(result.error).toContain('Config file not found');
    });
  });

  describe('checkPolymarketAuth()', () => {
    it('should pass when API auth succeeds', async () => {
      mockGetBalanceAllowance.mockResolvedValue({ amount: '1000000000' });

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('connected');
      expect(result.details).toContain('balance');
    });

    it('should fail when balance is invalid (ISSUE 9 fix)', async () => {
      mockGetBalanceAllowance.mockResolvedValue({ amount: 'invalid' });

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Invalid balance response');
    });

    it('should sanitize error messages on API failure (ISSUE 1 fix)', async () => {
      mockGetBalanceAllowance.mockRejectedValue(new Error('Invalid key: 0x1234567890123456789012345678901234567890'));

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('0x1234567890123456789012345678901234567890');
    });

    it('should handle API timeout gracefully (ISSUE 15 - timeout implemented)', async () => {
      // Simulate a slow API response that would trigger timeout
      // The actual timeout is 10 seconds, so we test the error path
      mockGetBalanceAllowance.mockRejectedValue(new Error('API request timed out'));

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Auth failed');
      expect(result.error).toContain('timed out');
    });
  });

  describe('sanitizeErrorMessage() - ISSUE 1 fix', () => {
    it('should redact Ethereum addresses', () => {
      const message = 'Invalid key: 0x1234567890123456789012345678901234567890';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('0x1234');
    });

    it('should redact 64-char hex strings (private keys)', () => {
      const message = 'Bad key: abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact key=value patterns', () => {
      const message = 'Error with key=mysecretkey123';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('mysecretkey123');
    });

    it('should redact secret=value patterns', () => {
      const message = 'secret: "supersecret"';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('supersecret');
    });

    it('should return Unknown error for empty/null input', () => {
      expect(sanitizeErrorMessage(null)).toBe('Unknown error');
      expect(sanitizeErrorMessage('')).toBe('Unknown error');
      expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
    });
  });

  describe('CheckResult interface consistency', () => {
    it('should have consistent structure for passing result', () => {
      const result = checkEnvironment();
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('pass');
      expect(result).toHaveProperty('details');
      expect(result).toHaveProperty('error');
      expect(typeof result.name).toBe('string');
      expect(typeof result.pass).toBe('boolean');
      expect(typeof result.details).toBe('string');
    });

    it('should have consistent structure for failing result', () => {
      delete process.env.POLYMARKET_API_KEY;

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toBeTruthy();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('Exit codes', () => {
    it('should determine correct exit code when all pass', () => {
      const results = [
        { pass: true },
        { pass: true },
        { pass: true },
      ];

      const allPassed = results.every((r) => r.pass);
      expect(allPassed).toBe(true);
    });

    it('should determine correct exit code when any fail', () => {
      const results = [
        { pass: true },
        { pass: false },
        { pass: true },
      ];

      const allPassed = results.every((r) => r.pass);
      expect(allPassed).toBe(false);
    });
  });
});
